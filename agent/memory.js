// agent/memory.js — Lyza v4 Memory query API.
// Wraps fraud-engine memory primitives with the structured query surface the
// Planner / Reflector / Escalation Explainer read before every LLM call.
//
// All writes go through `write()` which (a) attaches a deterministic
// `signature` for dedupe and (b) skips when the same signature was written
// in the last 24h. The underlying `saveMemoryRecord` still owns the cap.
//
// Public API
//   recallByHost(host, opts?)
//   recallBySeller(handle, opts?)
//   recallByKind(kind, opts?)
//   computePersonalFairRange(kind, currency)
//   findDuplicateListing(handle, price, opts?)
//   buildDigest(mission, currentContext)
//   digestToText(digest)
//   write(record)
//   tag(ts, tags[])
//   sha1(str)

import { loadMemory, saveMemoryRecord } from "../background/fraud-engine.js";

// ─── Constants ─────────────────────────────────────────────────────────────

export const MEMORY_CAP_RECORDS = 400;

const DUPLICATE_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_RECALL_LIMIT = 10;
const DEFAULT_KIND_LIMIT = 20;
const DEFAULT_DUP_TOLERANCE_PCT = 10;

// ─── sha1 helper (SubtleCrypto) ────────────────────────────────────────────

export async function sha1(str) {
  const enc = new TextEncoder().encode(String(str ?? ""));
  const buf = await crypto.subtle.digest("SHA-1", enc);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function normHost(h) {
  return String(h || "").toLowerCase().replace(/^www\./, "").trim();
}

function normHandle(h) {
  return String(h || "").toLowerCase().replace(/\s+/g, "").trim();
}

function isNumber(n) {
  return typeof n === "number" && isFinite(n);
}

function byTsDesc(a, b) {
  return (b.ts || 0) - (a.ts || 0);
}

// Linear-interpolation percentile on a SORTED ascending array.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// ─── Recall API ────────────────────────────────────────────────────────────

export async function recallByHost(host, { limit = DEFAULT_RECALL_LIMIT } = {}) {
  if (!host) return [];
  const target = normHost(host);
  const memory = await loadMemory();
  return memory
    .filter((r) => normHost(r.host) === target)
    .sort(byTsDesc)
    .slice(0, limit);
}

export async function recallBySeller(handle, { limit = DEFAULT_RECALL_LIMIT } = {}) {
  if (!handle) return [];
  const target = normHandle(handle);
  const memory = await loadMemory();
  return memory
    .filter((r) => normHandle(r.sellerHandle) === target)
    .sort(byTsDesc)
    .slice(0, limit);
}

export async function recallByKind(kind, { currency, limit = DEFAULT_KIND_LIMIT } = {}) {
  if (!kind) return [];
  const memory = await loadMemory();
  return memory
    .filter((r) => r.kind === kind && (!currency || r.priceCurrency === currency))
    .sort(byTsDesc)
    .slice(0, limit);
}

// ─── Personal fair-price baseline ──────────────────────────────────────────

export async function computePersonalFairRange(kind, currency) {
  const records = await recallByKind(kind, { currency, limit: 200 });
  const prices = records
    .map((r) => r.priceAmount)
    .filter(isNumber)
    .sort((a, b) => a - b);

  const n = prices.length;
  if (n < 3) {
    return { min: null, p25: null, p50: null, p75: null, max: null, n, validity: "insufficient_data" };
  }
  return {
    min: prices[0],
    p25: percentile(prices, 0.25),
    p50: percentile(prices, 0.50),
    p75: percentile(prices, 0.75),
    max: prices[n - 1],
    n,
    validity: "valid"
  };
}

// ─── Duplicate-listing detection ───────────────────────────────────────────

export async function findDuplicateListing(handle, price, { tolerancePct = DEFAULT_DUP_TOLERANCE_PCT } = {}) {
  if (!handle || !isNumber(price)) return [];
  const target = normHandle(handle);
  const memory = await loadMemory();
  const tol = tolerancePct / 100;
  return memory.filter((r) => {
    if (normHandle(r.sellerHandle) !== target) return false;
    if (!isNumber(r.priceAmount)) return false;
    const ref = r.priceAmount;
    if (ref === 0) return false;
    const diff = Math.abs(ref - price) / Math.max(ref, 1);
    return diff > tol;
  }).sort(byTsDesc);
}

// ─── Build the deterministic digest the LLMs see ───────────────────────────

export async function buildDigest(mission, currentContext = {}) {
  const memory = await loadMemory();
  const total = memory.length;

  // ── totals ───────────────────────────────────────────────────────────────
  let scamsAvoided = 0;
  let overpriceFlagged = 0;
  for (const r of memory) {
    if (r.scamScore && r.scamScore >= 66) scamsAvoided++;
    if (r.verdict === "above_average") overpriceFlagged++;
  }

  // ── fair ranges for the kinds we've seen ────────────────────────────────
  const seenKinds = new Map(); // key = kind|currency → []
  for (const r of memory) {
    if (!r.kind || !r.priceCurrency || !isNumber(r.priceAmount)) continue;
    const k = `${r.kind}|${r.priceCurrency}`;
    if (!seenKinds.has(k)) seenKinds.set(k, []);
    seenKinds.get(k).push(r);
  }
  const fairRanges = [];
  for (const [key, records] of seenKinds) {
    const [kind, currency] = key.split("|");
    const prices = records.map((r) => r.priceAmount).sort((a, b) => a - b);
    if (prices.length < 3) continue;
    fairRanges.push({
      kind, currency, period: records[0].pricePeriod || null,
      low: Math.round(percentile(prices, 0.25)),
      median: Math.round(percentile(prices, 0.50)),
      high: Math.round(percentile(prices, 0.75)),
      n: prices.length
    });
  }

  // ── duplicate-seller flag (current handle posted similar items at very
  //    different prices) ────────────────────────────────────────────────────
  let dupSellerFlag = false;
  let dupSellerDetail;
  if (currentContext.sellerHandle && isNumber(currentContext.priceAmount)) {
    const dups = await findDuplicateListing(
      currentContext.sellerHandle,
      currentContext.priceAmount,
      { tolerancePct: DEFAULT_DUP_TOLERANCE_PCT }
    );
    if (dups.length) {
      dupSellerFlag = true;
      dupSellerDetail = {
        handle: currentContext.sellerHandle,
        priorListings: dups.slice(0, 5).map((d) => ({
          ts: d.ts,
          host: d.host,
          title: d.title,
          priceAmount: d.priceAmount,
          priceCurrency: d.priceCurrency,
          pricePeriod: d.pricePeriod || null
        }))
      };
    }
  }

  // ── repeat scammer flag — same host or handle previously logged as
  //    high-risk / explicitly tagged scammer ───────────────────────────────
  let repeatScammerFlag = false;
  let repeatScammerDetail;
  const candidates = memory.filter((r) =>
    r.scamLevel === "high" ||
    (r.tags && Array.isArray(r.tags) && r.tags.includes("scammer"))
  );
  if (candidates.length) {
    const hostHit = currentContext.host
      ? candidates.find((r) => normHost(r.host) === normHost(currentContext.host))
      : null;
    const handleHit = currentContext.sellerHandle
      ? candidates.find((r) => normHandle(r.sellerHandle) === normHandle(currentContext.sellerHandle))
      : null;
    const hit = hostHit || handleHit;
    if (hit) {
      repeatScammerFlag = true;
      repeatScammerDetail = {
        host: hit.host,
        handle: hit.sellerHandle,
        lastSeen: hit.ts,
        reason: hit.recommendation || hit.summary || "previously flagged"
      };
    }
  }

  // ── host hits (per-host counts) ─────────────────────────────────────────
  const hostMap = new Map();
  for (const r of memory) {
    if (!r.host) continue;
    const h = normHost(r.host);
    if (!hostMap.has(h)) hostMap.set(h, { host: h, count: 0, last: null });
    const slot = hostMap.get(h);
    slot.count++;
    if (!slot.last || (r.ts || 0) > (slot.last.ts || 0)) slot.last = r;
  }
  const hostHits = [...hostMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((s) => ({
      host: s.host,
      lastVerdict: s.last?.verdict || null,
      lastScamLevel: s.last?.scamLevel || null,
      count: s.count
    }));

  // ── kind hits (per-kind with nearest price to current) ──────────────────
  const kindMap = new Map();
  for (const r of memory) {
    if (!r.kind) continue;
    if (!kindMap.has(r.kind)) kindMap.set(r.kind, []);
    kindMap.get(r.kind).push(r);
  }
  const kindHits = [];
  for (const [kind, records] of kindMap) {
    let nearestPrice = null;
    if (isNumber(currentContext.priceAmount)) {
      let bestDelta = Infinity;
      for (const r of records) {
        if (!isNumber(r.priceAmount)) continue;
        const d = Math.abs(r.priceAmount - currentContext.priceAmount);
        if (d < bestDelta) { bestDelta = d; nearestPrice = r.priceAmount; }
      }
    }
    kindHits.push({ kind, nearestPrice });
  }
  kindHits.sort((a, b) => (kindMap.get(b.kind)?.length || 0) - (kindMap.get(a.kind)?.length || 0));

  return {
    totals: { records: total, scamsAvoided, overpriceFlagged },
    fairRanges,
    dupSellerFlag,
    dupSellerDetail,
    repeatScammerFlag,
    repeatScammerDetail,
    hostHits,
    kindHits: kindHits.slice(0, 8)
  };
}

// ─── Compact key/value text representation for prompts (≤ 500 tokens) ─────

export function digestToText(digest) {
  if (!digest) return "memory: empty";
  const lines = [];
  const t = digest.totals || {};
  lines.push(`memory.totals.records: ${t.records || 0}`);
  lines.push(`memory.totals.scamsAvoided: ${t.scamsAvoided || 0}`);
  if (typeof t.overpriceFlagged === "number") {
    lines.push(`memory.totals.overpriceFlagged: ${t.overpriceFlagged}`);
  }

  // Safety-critical flags — NEVER dropped.
  lines.push(`memory.dupSellerFlag: ${digest.dupSellerFlag ? "true" : "false"}`);
  if (digest.dupSellerFlag && digest.dupSellerDetail) {
    const d = digest.dupSellerDetail;
    lines.push(`memory.dupSellerDetail.handle: ${d.handle || ""}`);
    (d.priorListings || []).slice(0, 3).forEach((p, i) => {
      lines.push(`memory.dupSellerDetail.priorListings[${i}]: ${p.priceAmount ?? "?"} ${p.priceCurrency || ""} on ${p.host || "?"} — "${(p.title || "").slice(0, 60)}"`);
    });
  }

  lines.push(`memory.repeatScammerFlag: ${digest.repeatScammerFlag ? "true" : "false"}`);
  if (digest.repeatScammerFlag && digest.repeatScammerDetail) {
    const r = digest.repeatScammerDetail;
    if (r.host) lines.push(`memory.repeatScammerDetail.host: ${r.host}`);
    if (r.handle) lines.push(`memory.repeatScammerDetail.handle: ${r.handle}`);
    if (r.reason) lines.push(`memory.repeatScammerDetail.reason: ${String(r.reason).slice(0, 140)}`);
  }

  // Personal fair ranges — high signal for pricing decisions.
  (digest.fairRanges || []).slice(0, 5).forEach((fr, i) => {
    const periodSuffix = fr.period ? `/${fr.period}` : "";
    lines.push(`memory.fairRanges[${i}]: ${fr.kind} (${fr.currency}${periodSuffix}) low=${fr.low} median=${fr.median} high=${fr.high} n=${fr.n}`);
  });

  // Host hits — keep top 5 to stay under budget.
  (digest.hostHits || []).slice(0, 5).forEach((h, i) => {
    lines.push(`memory.hostHits[${i}]: ${h.host} count=${h.count} lastVerdict=${h.lastVerdict || "?"} lastScam=${h.lastScamLevel || "?"}`);
  });

  // Kind hits — useful for "do I have a baseline for this category".
  (digest.kindHits || []).slice(0, 5).forEach((k, i) => {
    lines.push(`memory.kindHits[${i}]: ${k.kind}${k.nearestPrice != null ? " nearestPrice=" + k.nearestPrice : ""}`);
  });

  return lines.join("\n");
}

// ─── Writes (dedupe-aware) ─────────────────────────────────────────────────

export async function write(record) {
  if (!record || typeof record !== "object") return null;

  const signature = await sha1(
    `${normHost(record.host)}|${normHandle(record.sellerHandle)}|${record.priceAmount ?? ""}`
  );
  const now = Date.now();

  // Skip identical signature in last 24h.
  const memory = await loadMemory();
  const recentDup = memory.find((r) =>
    r.signature === signature && (now - (r.ts || 0)) < DUPLICATE_DEDUPE_WINDOW_MS
  );
  if (recentDup) return { ok: true, deduped: true, ts: recentDup.ts };

  // Hand to fraud-engine (which owns the cap + storage write). Note: existing
  // cap in fraud-engine is 100; we accept that until/unless it's lifted — the
  // digest still surfaces high-signal flags regardless of cap.
  const written = await saveMemoryRecord({ ...record, signature });
  return { ok: true, deduped: false, ts: now, list: written };
}

export async function tag(ts, tags = []) {
  if (!ts || !Array.isArray(tags) || !tags.length) return { ok: false, reason: "bad_args" };
  const memory = await loadMemory();
  const idx = memory.findIndex((r) => r.ts === ts);
  if (idx === -1) return { ok: false, reason: "not_found" };
  const existing = Array.isArray(memory[idx].tags) ? memory[idx].tags : [];
  const merged = [...new Set([...existing, ...tags])];
  memory[idx] = { ...memory[idx], tags: merged };
  await chrome.storage.local.set({ lyza_memory: memory });
  return { ok: true, tags: merged };
}
