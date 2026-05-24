// fraud-engine.js — 3-layer hybrid fraud detection + helpers (FX, memory, fusion).
// Layer 1: deterministic URL/host heuristics (offline, instant)
// Layer 2: live signals — Google Safe Browsing (optional) + domain age via RDAP (keyless)
// Layer 3: LLM content reasoning (handled by service-worker.js prompt)

// ---- Brand & threat lists ------------------------------------------------

const KNOWN_BRANDS = [
  "paypal","amazon","facebook","kijiji","craigslist","rbc","td","scotiabank","bmo","cibc",
  "tangerine","wise","interac","etransfer","servicecanada","ircc","canada","gov","wellsfargo",
  "chase","bankofamerica","ebay","airbnb","zelle","venmo","westernunion","moneygram",
  "rogers","bell","telus","fido","koodo","walmart","costco","apple","google","microsoft"
];

const SUSPICIOUS_TLDS = [
  "zip","mov","xyz","top","gq","ml","cf","tk","work","click","link","country","stream",
  "download","racing","review","date","loan","men","kim","party","science","gdn","icu",
  "rest","cam","cyou","sbs","quest"
];

const PHISHY_HOST_WORDS = [
  "secure","account","update","verify","login","signin","webscr","confirm","banking",
  "support","service","alert","suspended","limited","unlock","recover","wallet"
];

const HOMOGLYPHS = {
  "а":"a","е":"e","о":"o","р":"p","с":"c","х":"x","у":"y","і":"i","ѕ":"s","ո":"n",
  "ο":"o","ν":"v","α":"a","ρ":"p","τ":"t","ι":"i","κ":"k","ɡ":"g","ⅼ":"l","ѡ":"w"
};

// ---- Layer 1: URL heuristics ---------------------------------------------

function parseUrl(rawUrl) {
  try { return new URL(rawUrl); } catch { return null; }
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)
      );
  return dp[m][n];
}

function checkIpHost(url) {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
  return { triggered: isIp, weight: 25, label: "URL uses a raw IP address instead of a domain name" };
}
function checkAtSymbol(url) {
  const has = url.href.includes("@");
  return { triggered: has, weight: 20, label: "URL contains an '@' symbol (can hide the real destination)" };
}
function checkPunycode(url) {
  const has = url.hostname.includes("xn--");
  return { triggered: has, weight: 22, label: "Domain uses Punycode (possible look-alike character attack)" };
}
function checkHomoglyphs(url) {
  const found = [...url.hostname].some((ch) => HOMOGLYPHS[ch]);
  return { triggered: found, weight: 24, label: "Domain contains look-alike (non-Latin) characters" };
}
function checkSuspiciousTld(url) {
  const tld = url.hostname.split(".").pop().toLowerCase();
  const has = SUSPICIOUS_TLDS.includes(tld);
  return { triggered: has, weight: 14, label: `Domain ends in .${tld}, a TLD often used for scams` };
}
function checkExcessiveSubdomains(url) {
  const parts = url.hostname.split(".");
  const count = Math.max(0, parts.length - 2);
  return { triggered: count >= 3, weight: 12, label: "Domain has an unusual number of subdomains" };
}
function checkPhishyWords(url) {
  const host = url.hostname.toLowerCase();
  const hit = PHISHY_HOST_WORDS.find((w) => host.includes(w));
  return { triggered: !!hit, weight: 8, label: hit ? `Domain contains the word "${hit}"` : "" };
}
function checkNoHttps(url) {
  return { triggered: url.protocol !== "https:", weight: 10, label: "Page is not served over HTTPS" };
}
function checkTyposquatting(url) {
  const label = url.hostname.split(".").slice(-2, -1)[0] || url.hostname;
  let best = null;
  for (const brand of KNOWN_BRANDS) {
    const d = levenshtein(label.toLowerCase(), brand);
    if (d > 0 && d <= 2 && Math.abs(label.length - brand.length) <= 2) {
      if (!best || d < best.d) best = { brand, d };
    }
  }
  return {
    triggered: !!best,
    weight: 26,
    label: best ? `Domain looks like a misspelling of "${best.brand}"` : ""
  };
}
function checkUrlLength(url) {
  return { triggered: url.href.length > 90, weight: 6, label: "Unusually long URL" };
}

export function runUrlHeuristics(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) return { score: 0, signals: [] };
  const checks = [
    checkIpHost, checkAtSymbol, checkPunycode, checkHomoglyphs, checkSuspiciousTld,
    checkExcessiveSubdomains, checkPhishyWords, checkNoHttps, checkTyposquatting, checkUrlLength
  ];
  const signals = [];
  let score = 0;
  for (const fn of checks) {
    const r = fn(url);
    if (r.triggered && r.label) { signals.push(r.label); score += r.weight; }
  }
  return { score: Math.min(score, 100), signals };
}

// ---- Layer 2: live signals -----------------------------------------------

export async function checkSafeBrowsing(rawUrl, key) {
  if (!key) return { available: false, listed: false, weight: 0, label: "" };
  try {
    const resp = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "lyza", clientVersion: "3.0" },
          threatInfo: {
            threatTypes: ["MALWARE","SOCIAL_ENGINEERING","UNWANTED_SOFTWARE","POTENTIALLY_HARMFUL_APPLICATION"],
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: [{ url: rawUrl }]
          }
        })
      }
    );
    const data = await resp.json();
    const listed = !!(data.matches && data.matches.length);
    return {
      available: true, listed, weight: listed ? 60 : 0,
      label: listed ? "Flagged by Google Safe Browsing as dangerous" : ""
    };
  } catch { return { available: false, listed: false, weight: 0, label: "" }; }
}

export async function checkDomainAge(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    // Skip RDAP for IP hosts and local/private addresses.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === "localhost") {
      return { available: false, ageDays: null, weight: 0, label: "" };
    }
    const resp = await fetch(`https://rdap.org/domain/${encodeURIComponent(host)}`);
    if (!resp.ok) return { available: false, ageDays: null, weight: 0, label: "" };
    const data = await resp.json();
    const reg = (data.events || []).find((e) => e.eventAction === "registration");
    if (!reg) return { available: false, ageDays: null, weight: 0, label: "" };
    const ageDays = Math.floor((Date.now() - new Date(reg.eventDate)) / 86400000);
    let weight = 0, label = "";
    if (ageDays < 30) { weight = 30; label = `Domain registered ${ageDays} days ago (very new)`; }
    else if (ageDays < 90) { weight = 18; label = `Domain registered ${ageDays} days ago (recently)`; }
    return { available: true, ageDays, weight, label };
  } catch { return { available: false, ageDays: null, weight: 0, label: "" }; }
}

// ---- Fusion --------------------------------------------------------------

export function fuseRisk(urlH, safeB, age, contentScore) {
  let base = urlH.score + safeB.weight + age.weight;
  const blended = Math.round(base * 0.6 + (contentScore || 0) * 0.4);
  let final = safeB.listed ? Math.max(blended, 85) : blended;
  // Very new domain forces at least MEDIUM.
  if (age.ageDays !== null && age.ageDays < 30) final = Math.max(final, 55);
  final = Math.max(0, Math.min(100, final));
  const level = final >= 66 ? "high" : final >= 33 ? "medium" : "low";
  return { score: final, level };
}

// ---- Live FX rate (Frankfurter, keyless) ---------------------------------

export async function getFxRate(base, target) {
  if (!base || !target) return null;
  if (base === target) return { rate: 1, ts: Date.now() };
  const cacheKey = `fx_${base}_${target}`;
  try {
    const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
    if (cached && Date.now() - cached.t < 3600000) return { rate: cached.rate, ts: cached.t };
  } catch {}
  try {
    const resp = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${target}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const rate = data.rates?.[target];
    if (!rate) return null;
    try { await chrome.storage.session.set({ [cacheKey]: { rate, t: Date.now() } }); } catch {}
    return { rate, ts: Date.now() };
  } catch { return null; }
}

export function formatMoney(amount, currency) {
  if (typeof amount !== "number" || !isFinite(amount)) return "";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency, maximumFractionDigits: amount >= 100 ? 0 : 2
    }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
}

// ---- Memory (persistent financial picture) -------------------------------

const MEMORY_KEY = "lyza_memory";
const MEMORY_CAP = 100;

export async function loadMemory() {
  const stored = await chrome.storage.local.get(MEMORY_KEY);
  return Array.isArray(stored[MEMORY_KEY]) ? stored[MEMORY_KEY] : [];
}

export async function saveMemoryRecord(record) {
  const list = await loadMemory();
  list.unshift({ ts: Date.now(), ...record });
  const trimmed = list.slice(0, MEMORY_CAP);
  await chrome.storage.local.set({ [MEMORY_KEY]: trimmed });
  return trimmed;
}

export async function clearMemory() {
  await chrome.storage.local.set({ [MEMORY_KEY]: [] });
}

// Find prior records the agent should reason about for THIS page.
// Returns up to 6 most-relevant hits across three buckets: same host,
// matching seller handle, similar kind in the same price band.
export function findMemoryHits(memory, current) {
  if (!memory.length) return [];
  const hits = [];
  const seen = new Set();
  const push = (r, reason) => {
    if (!r || seen.has(r.ts)) return;
    seen.add(r.ts);
    hits.push({ ...r, _matchReason: reason });
  };

  for (const r of memory) {
    if (r.host && current.host && r.host === current.host && r.url !== current.url) {
      push(r, "same_host");
    }
  }
  if (current.sellerHandle) {
    for (const r of memory) {
      if (r.sellerHandle && r.sellerHandle === current.sellerHandle) {
        push(r, "same_seller");
      }
    }
  }
  if (current.kind && current.priceAmount && current.priceCurrency) {
    for (const r of memory) {
      if (
        r.kind === current.kind &&
        r.priceCurrency === current.priceCurrency &&
        typeof r.priceAmount === "number"
      ) {
        push(r, "same_kind_price_band");
      }
    }
  }
  return hits.slice(0, 6);
}

export function summarizeMemory(memory) {
  const byKind = {};
  let scamsAvoided = 0;
  let overpriceFlagged = 0;
  let overpriceCurrency = null;
  for (const r of memory) {
    byKind[r.kind || "other"] = (byKind[r.kind || "other"] || 0) + 1;
    if (r.scamScore && r.scamScore >= 66) scamsAvoided++;
    if (r.verdict === "above_average" && typeof r.priceAmount === "number") {
      // crude: assume 20% over fair → "money flagged" estimate
      overpriceFlagged += Math.round(r.priceAmount * 0.2);
      overpriceCurrency = r.priceCurrency || overpriceCurrency;
    }
  }
  return {
    total: memory.length,
    byKind,
    scamsAvoided,
    overpriceFlagged,
    overpriceCurrency
  };
}
