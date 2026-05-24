# LYZA v2 — Master Implementation Spec (for Claude Code)

> **Goal:** Take the existing Lyza Chrome extension (Manifest V3) from a solid MVP to a
> **hackathon-winning** product. This document is the single source of truth. Implement
> every feature below, in the order given, with the code patterns provided.
>
> **Audience for this doc:** Claude Code. Execute task-by-task. After each task, verify it
> loads in `chrome://extensions` with no console errors before moving on.

---

## 0. Context: what already exists

The current extension (`lyza/`) has:

```
lyza/
├── manifest.json          # MV3, permissions: storage, activeTab, scripting
├── config.js              # profile schema, currencies, languages, defaults
├── popup/                 # popup.html / popup.css / popup.js  (profile + API key settings)
├── content/               # content.js (scrape + overlay panel + chat), overlay.css
├── background/            # service-worker.js (single Anthropic API call → JSON analysis)
└── icons/                 # icon16/48/128.png
```

Current flow: user sets profile + Anthropic key → clicks floating **L** button on any page →
`content.js` scrapes the page → `service-worker.js` sends ONE prompt to Claude → returns JSON
with `{ pageType, summary, prices[], priceContext, scamRisk, tips[], disclaimer }` → rendered
in the panel. There is a basic follow-up chat.

**Keep this architecture.** We are layering features on top, not rewriting.

---

## 1. Why these features win (map to typical hackathon judging criteria)

| Judging criterion | Feature that scores it |
|---|---|
| **Impact / problem fit** | Newcomer fraud protection is a real, high-stakes problem with a clear victim |
| **Technical depth** | Hybrid scam engine: deterministic heuristics + live blocklists + LLM reasoning |
| **Innovation / "wow"** | Voice explanations (ElevenLabs) in the user's native language; fake-site detection overlay |
| **Completeness / polish** | Onboarding, history, settings, accessibility, graceful failures |
| **Demo-ability** | One-click "Analyze", instant risk badge, audio playback, side-by-side price comparison |

The single biggest differentiator: **rigorous, explainable fraud detection** that doesn't just
ask an LLM "is this a scam?" but combines (a) deterministic URL/domain heuristics, (b) live
threat-intelligence blocklists, and (c) LLM contextual reasoning into one transparent score.
Judges reward systems that are *defensible*, not hand-wavy.

---

## 2. Full feature list

### TIER 1 — Core differentiators (build first, these win the demo)

1. **Rigorous fake-site / phishing detection engine** (deterministic + blocklist + LLM)
2. **Voice mode** — Lyza reads the analysis aloud in the user's language (ElevenLabs)
3. **Live currency conversion** with a real FX API (replace LLM-estimated rates)

### TIER 2 — Strong supporting features

4. **Onboarding wizard** (first-run, 4 steps) so the demo starts clean
5. **In-page red-flag highlighting** — underline scam phrases directly on the page
6. **Analysis history** — saved past analyses, viewable from the popup
7. **Seller/message risk analyzer** — paste a seller's chat message → scam score

### TIER 3 — Polish & "if we have time"

8. **Confidence indicator** on every verdict (low/med/high model confidence)
9. **Shareable safety report** — export the analysis as a clean card/image
10. **Accessibility pass** — keyboard nav, ARIA, high-contrast, reduced-motion

---

## 3. API keys & secrets

Add to the **Settings** popup tab three stored keys (all in `chrome.storage.local`, local-only):

| Key | Storage key | Used for |
|---|---|---|
| Anthropic API key | `lyza_api_key` | already exists |
| ElevenLabs API key | `lyza_elevenlabs_key` | voice mode |
| Google Safe Browsing key *(optional)* | `lyza_safebrowsing_key` | blocklist check |

> For the demo, the FX API and RDAP domain-age lookups are **keyless** (free public endpoints),
> so only ElevenLabs and (optionally) Safe Browsing need user-provided keys. Degrade gracefully:
> if a key is missing, that feature shows a friendly "add key in Settings" state and the rest
> still works.

---

## TASK 1 — Rigorous fake-site / phishing detection engine

This is the centerpiece. Build a **hybrid** engine with three layers that combine into one
transparent score. Create a new module `background/fraud-engine.js` (ES module, imported by the
service worker).

### 1A. Layer 1 — Deterministic URL & domain heuristics (no network, instant)

These are the industry-standard lexical/host signals used by real phishing detectors. Implement
each as a function returning `{ triggered: boolean, weight: number, label: string }`. Weights are
points added to a 0–100 risk score.

```js
// background/fraud-engine.js

// Curated list of well-known brands newcomers interact with (banks, marketplaces, govt, telecom).
// Used for typosquatting / impersonation checks.
const KNOWN_BRANDS = [
  "paypal","amazon","facebook","kijiji","craigslist","rbc","td","scotiabank","bmo","cibc",
  "tangerine","wise","interac","etransfer","servicecanada","ircc","canada","gov","wellsfargo",
  "chase","bankofamerica","ebay","airbnb","zelle","venmo","westernunion","moneygram",
  "rogers","bell","telus","fido","koodo","walmart","costco","apple","google","microsoft"
];

// TLDs disproportionately used in phishing (from CIC / threat-intel feeds). Expand as needed.
const SUSPICIOUS_TLDS = [
  "zip","mov","xyz","top","gq","ml","cf","tk","work","click","link","country","stream",
  "download","racing","review","date","loan","men","kim","party","science","gdn","icu",
  "rest","cam","cyou","sbs","quest"
];

// Words that frequently appear in phishing hostnames.
const PHISHY_HOST_WORDS = [
  "secure","account","update","verify","login","signin","webscr","confirm","banking",
  "support","service","alert","suspended","limited","unlock","recover","wallet"
];

// Homoglyph map: characters that look Latin but aren't (Cyrillic/Greek lookalikes).
const HOMOGLYPHS = {
  "а":"a","е":"e","о":"o","р":"p","с":"c","х":"x","у":"y","і":"i","ѕ":"s","ո":"n",
  "ο":"o","ν":"v","α":"a","ρ":"p","τ":"t","ι":"i","κ":"k","ɡ":"g","ⅼ":"l","ѡ":"w"
};

function parseUrl(rawUrl) {
  try { return new URL(rawUrl); } catch { return null; }
}

// Levenshtein distance for typosquatting detection.
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

// ---- Individual heuristic checks ----------------------------------------

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
  // Strip TLD, compare the registrable label to each known brand.
  const label = url.hostname.split(".").slice(-2, -1)[0] || url.hostname;
  let best = null;
  for (const brand of KNOWN_BRANDS) {
    const d = levenshtein(label.toLowerCase(), brand);
    // Close but NOT exact = impersonation. Exact match = legit, skip.
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
```

### 1B. Layer 2 — Live threat-intelligence blocklists (network, cached)

Add async checks that hit free reputation sources. Cache results in `chrome.storage.session` keyed
by hostname for 1 hour to keep the demo fast.

- **Google Safe Browsing v4** (`lookup` endpoint) — requires the optional key. Returns whether the
  URL is on Google's phishing/malware lists. This is the gold-standard signal; weight it heavily.
- **Domain age via RDAP** (keyless): `https://rdap.org/domain/{domain}`. Parse the registration
  event date. **Domains < 90 days old are a strong scam signal** (most phishing infra is fly-by-night).

```js
// --- Google Safe Browsing (optional key) ---
export async function checkSafeBrowsing(rawUrl, key) {
  if (!key) return { available: false, listed: false, weight: 0, label: "" };
  try {
    const resp = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "lyza", clientVersion: "2.0" },
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
    return { available: true, listed, weight: listed ? 60 : 0,
             label: listed ? "Flagged by Google Safe Browsing as dangerous" : "" };
  } catch { return { available: false, listed: false, weight: 0, label: "" }; }
}

// --- Domain age via RDAP (keyless) ---
export async function checkDomainAge(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    const resp = await fetch(`https://rdap.org/domain/${host}`);
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
```

### 1C. Layer 3 — LLM contextual reasoning (already partly exists)

The existing Claude call analyzes page CONTENT for scam language (urgency, off-platform payment,
wire-transfer requests, "I'm out of the country", overpayment, requests for documents). Keep it,
but now it returns a **content-based** sub-score that the engine combines with layers 1 & 2.

Update the system prompt so Claude returns an additional field:

```json
"contentScamSignals": {
  "score": 0,            // 0-100 from page/message text only
  "reasons": ["..."]     // specific phrases or patterns found
}
```

### 1D. Combine into one transparent verdict

In `service-worker.js`, after getting all three layers, fuse them. **Do not just average** — use a
"max-aware" blend so a single strong signal (e.g. Safe Browsing hit) dominates, which is how real
engines behave:

```js
function fuseRisk(urlH, safeB, age, contentScore) {
  // Heuristic base from URL signals
  let base = urlH.score;
  // Add network signals
  base += safeB.weight + age.weight;
  // Blend in LLM content score (weighted, capped)
  const blended = Math.round(base * 0.6 + contentScore * 0.4);
  // A Safe Browsing hit forces HIGH regardless.
  let final = safeB.listed ? Math.max(blended, 85) : Math.min(blended, 100);
  final = Math.max(0, Math.min(100, final));
  const level = final >= 66 ? "high" : final >= 33 ? "medium" : "low";
  return { score: final, level };
}
```

The final `scamRisk` object returned to the UI must include **all contributing signals** so the
panel can show them transparently:

```json
"scamRisk": {
  "level": "high",
  "score": 88,
  "reasons": [ /* merged: url heuristics + blocklist + domain age + content reasons */ ],
  "breakdown": {
    "urlHeuristics": 42,
    "blocklist": "listed | clean | unavailable",
    "domainAgeDays": 12,
    "contentScore": 70
  }
}
```

### 1E. UI — Fake-site banner

When `level === "high"`, the content script should inject a **full-width warning banner** at the
top of the panel (and optionally a dismissible strip across the top of the page itself) reading,
in the user's language: *"⚠️ This site shows strong signs of being fake or a scam. Do not enter
personal info, passwords, or payment details."* Make the risk breakdown expandable ("Why?").

> **Demo note:** prepare two test URLs — one clean (a real listing) and one with obvious signals
> (e.g. an IP-host URL, a typosquatted domain, or a known PhishTank sample). The deterministic
> layer fires instantly even without any API keys, which makes the demo bulletproof offline.

---

## TASK 2 — Voice mode (ElevenLabs)

Let Lyza **read the analysis aloud** in the user's preferred language. This is the "wow" moment.

### 2A. Service worker: add a TTS handler

```js
// In service-worker.js — new message type "SPEAK"
const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // a clear multilingual voice; let user override later

async function synthesizeSpeech(text) {
  const { lyza_elevenlabs_key } = await chrome.storage.local.get("lyza_elevenlabs_key");
  if (!lyza_elevenlabs_key) return { error: "NO_TTS_KEY" };
  try {
    const resp = await fetch(`${ELEVENLABS_URL}/${DEFAULT_VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": lyza_elevenlabs_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text: text.slice(0, 900),                 // keep under ~1000 chars for latency
        model_id: "eleven_multilingual_v2",        // handles 29+ languages
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
    if (!resp.ok) return { error: "TTS_API_ERROR", message: `(${resp.status})` };
    const buf = await resp.arrayBuffer();
    // Convert to base64 data URL so it can cross the message boundary to the content script.
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return { ok: true, audio: `data:audio/mpeg;base64,${b64}` };
  } catch (e) { return { error: "TTS_NETWORK_ERROR", message: String(e) }; }
}
```

Add `https://api.elevenlabs.io/*` to `host_permissions` in the manifest.

### 2B. Content script: play button

- Add a **🔊 Listen** button to the summary card and to the scam-risk card.
- On click, build a short spoken script from the analysis (summary + verdict + top risk reason +
  top tip), send `{ type: "SPEAK", text }`, receive the base64 audio, and play it via
  `new Audio(dataUrl).play()`.
- Show a small equalizer/loading animation while synthesizing. Allow pause/stop.
- Construct the spoken text from the **already-translated** analysis fields, so it's automatically
  in the user's language and ElevenLabs' multilingual model renders it correctly.

```js
function speak(text, btn) {
  btn.classList.add("lyza-speaking");
  chrome.runtime.sendMessage({ type: "SPEAK", text }, (res) => {
    btn.classList.remove("lyza-speaking");
    if (res && res.ok) { const a = new Audio(res.audio); a.play(); }
    else { /* show friendly 'add ElevenLabs key in Settings' tooltip */ }
  });
}
```

### 2C. Settings: ElevenLabs key field + optional voice picker

Add a password field for `lyza_elevenlabs_key`. Optional stretch: `GET /v1/voices` to populate a
voice dropdown, store chosen `voice_id` in `lyza_voice_id`.

---

## TASK 3 — Live currency conversion (real FX rates)

Replace the LLM's guessed exchange rate with a real one for credibility.

- Use the **keyless** Frankfurter API: `https://api.frankfurter.dev/v1/latest?base=CAD&symbols=INR`
  (or `exchangerate.host`). Cache the rate per currency pair for the session (rates barely move
  intraday).
- The LLM still **extracts** the price numbers and currency from the page; the service worker then
  does the actual conversion with the real rate and passes accurate converted values into the
  analysis before rendering.
- Show the rate + timestamp in the price card: *"1 CAD = 60.4 INR · live rate"*.

```js
async function getFxRate(base, target) {
  if (base === target) return 1;
  const cacheKey = `fx_${base}_${target}`;
  const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
  if (cached && Date.now() - cached.t < 3600000) return cached.rate;
  const resp = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${target}`);
  const data = await resp.json();
  const rate = data.rates?.[target];
  if (rate) await chrome.storage.session.set({ [cacheKey]: { rate, t: Date.now() } });
  return rate || null;
}
```

---

## TASK 4 — Onboarding wizard (first run)

On install (`chrome.runtime.onInstalled`) open a one-time onboarding page (`onboarding/onboarding.html`)
with 4 steps: (1) Welcome + what Lyza does, (2) pick country/currencies/language, (3) paste API keys
with links to where to get them, (4) "try it on a sample page" CTA. Persist `lyza_onboarded=true`.
Keep the same teal/sand visual identity. This makes the demo open cleanly and shows product maturity.

---

## TASK 5 — In-page red-flag highlighting

After analysis, the content script highlights scam-indicator phrases **directly on the page**:

- The LLM returns a `flaggedPhrases: string[]` array (exact substrings it found suspicious, e.g.
  "wire the deposit", "I'm currently abroad", "pay outside the platform").
- Walk the page's text nodes (`TreeWalker`, `NodeFilter.SHOW_TEXT`), wrap matches in
  `<mark class="lyza-flag">` with a tooltip explaining why it's risky.
- Only highlight on user opt-in (a toggle in the panel) to avoid mangling the page unexpectedly.
- Provide a "clear highlights" action that removes all injected marks.

---

## TASK 6 — Analysis history

- After each analysis, push a compact record to `chrome.storage.local` under `lyza_history`
  (cap at last 25): `{ url, title, ts, pageType, scamLevel, scamScore, summary }`.
- Add a **History** tab to the popup listing past analyses (most recent first) with the risk badge.
  Clicking an item shows the saved summary. Add a "Clear history" button.

---

## TASK 7 — Seller / message risk analyzer

A dedicated input (in the panel, below chat) where the user pastes a **seller's message** from
Marketplace/Kijiji/email. Send it through the same fraud engine's content layer (LLM) with a prompt
specialized for conversational scam patterns (advance-fee, overpayment, off-platform, urgency,
shipping-agent scams, fake escrow). Return a focused risk score + the exact red-flag phrases. This
directly serves the two use cases in the original brief (Marketplace + rental seller messages).

---

## TASK 8 — Confidence indicator

Have the LLM include `"confidence": "low|medium|high"` reflecting how much page content it had to
work with (e.g. low if the page was mostly images/JS with little text). Show it subtly next to each
verdict so the tool is honest about uncertainty — judges value calibrated systems.

---

## TASK 9 — Shareable safety report

A "Save report" button renders the analysis into a clean, self-contained card (HTML → canvas via a
tiny lib, or just a styled printable view) the user can screenshot/share — useful for asking a
trusted friend or settlement worker "is this legit?". Keep it on-brand.

---

## TASK 10 — Accessibility & polish pass

- All interactive elements keyboard-reachable; visible focus rings.
- ARIA roles/labels on the panel, buttons, and live regions (announce analysis completion).
- Respect `prefers-reduced-motion` (disable spinner/slide animations).
- Ensure color contrast on all badges meets WCAG AA.
- Handle every failure path with a calm, plain-language message (never a raw stack trace).

---

## 4. Updated manifest permissions

```json
{
  "permissions": ["storage", "activeTab", "scripting"],
  "host_permissions": [
    "<all_urls>",
    "https://api.anthropic.com/*",
    "https://api.elevenlabs.io/*",
    "https://safebrowsing.googleapis.com/*",
    "https://rdap.org/*",
    "https://api.frankfurter.dev/*"
  ]
}
```

(Note: `<all_urls>` already covers the API hosts for fetch from the service worker, but listing them
explicitly documents intent and is good practice.)

---

## 5. Updated LLM output contract (single source of truth)

The service worker's Claude call must now return this exact JSON shape. Update the system prompt
accordingly and keep all human-readable strings in the user's preferred language:

```json
{
  "pageType": "marketplace | rental | banking | job | shopping | other",
  "summary": "2-4 sentences, user's language",
  "confidence": "low | medium | high",
  "prices": [{ "amount": 2400, "currency": "CAD", "period": "month", "note": "" }],
  "priceContext": { "verdict": "below_average|average|above_average|unknown", "explanation": "" },
  "contentScamSignals": { "score": 0, "reasons": [] },
  "flaggedPhrases": ["exact substrings found on the page"],
  "tips": [],
  "disclaimer": ""
}
```

> Note: `prices` now returns **structured numbers** (`amount` + `currency`), NOT a pre-formatted
> string, so the service worker can do real FX conversion. The final converted strings are assembled
> in code after `getFxRate`.

The service worker assembles the FINAL object sent to the content script by merging the LLM output
with the computed `scamRisk` (from `fuseRisk`) and the FX-converted prices.

---

## 6. Build order & verification checklist

Implement in this order. After each, reload the extension and confirm no errors:

- [ ] **Task 1A** URL heuristics module (testable in isolation — write a quick console test with
      sample URLs: an IP host, a punycode domain, `paypa1.com`, a clean domain).
- [ ] **Task 1B** blocklist + domain-age async checks (verify RDAP returns age for a known domain).
- [ ] **Task 1C/1D** new LLM contract + fuseRisk; wire full scamRisk with breakdown.
- [ ] **Task 1E** high-risk banner UI.
- [ ] **Task 3** real FX conversion (verify a CAD→INR number against a quick manual check).
- [ ] **Task 2** ElevenLabs voice (test with the user's language; confirm audio plays).
- [ ] **Task 4** onboarding.
- [ ] **Task 5** highlighting (toggle on/off cleanly).
- [ ] **Task 6** history.
- [ ] **Task 7** seller-message analyzer.
- [ ] **Tasks 8–10** confidence, report, accessibility.

### Quick test URLs for the fraud engine (deterministic layer, works offline)
- Clean: `https://www.kijiji.ca/...` (real listing)
- IP host: `http://192.168.x.x/login` → fires IP + no-HTTPS
- Typosquat: `paypa1-secure-login.xyz` → fires typosquat + phishy word + suspicious TLD
- Punycode: any `xn--`-prefixed host

---

## 7. Guardrails (do not skip)

- **Never auto-submit forms or enter credentials** on any page. Lyza only reads and advises.
- Keep all keys in `chrome.storage.local`; never log them; never send them anywhere except their
  own provider.
- The scam score is **assistive, not authoritative** — always show the disclaimer. Avoid telling a
  user a site is "100% safe"; cap displayed safe-confidence and use language like "no red flags
  detected".
- For rental/legal questions, keep the existing "consult the local tenant board / settlement agency"
  framing; never give definitive legal advice.
- Voice text and highlights must use the already-translated analysis so nothing leaks the wrong
  language.

---

## 8. Demo script (2–3 min, for the pitch)

1. **Open** a fresh profile via onboarding (international student, INR home currency, Hindi). 
2. **Clean listing** → Analyze → show Hindi summary, **live** CAD→INR conversion with real rate,
   "about average" price verdict, **Low risk**. Hit **🔊 Listen** — Lyza speaks Hindi.
3. **Scammy rental** (typosquatted URL + "wire deposit, I'm abroad" text) → Analyze → instant
   **HIGH RISK** banner, expandable breakdown (URL heuristics + new domain + content signals),
   in-page red-flag highlights on the scam phrases.
4. **Paste a seller message** into the analyzer → focused scam score.
5. **Open History** in the popup → show the saved analyses.
6. Close on the impact line: *newcomers lose money to these scams every day; Lyza gives them a
   second set of eyes, in their own language, on every page.*

---

*End of spec. Build Tier 1 first — it alone is demo-winning. Tiers 2–3 add polish and completeness.*
