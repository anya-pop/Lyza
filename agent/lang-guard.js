// agent/lang-guard.js — Cheap, runtime-only language validation.
//
// The Planner / Reflector / Escalation Explainer must emit user-facing
// strings in `profile.language`. We don't want a second LLM call to police
// this — instead we ship a heuristic that catches the common failure
// (model emits English even though the user is Hindi/Arabic/Chinese).
//
// Strategy:
//   1. For non-Latin scripts (Hindi, Arabic, Chinese, Korean, etc.):
//      check the Unicode block of the dominant characters. Cheap and
//      effective — Devanagari, Arabic, CJK and Hangul all have unique
//      block ranges.
//   2. For Latin-script languages (en, es, fr, pt, vi, tl): count
//      occurrences of a small per-language stopword set. The one with the
//      most hits wins; ties favour English.
//
// Public API
//   isProbablyLanguage(text, code)  → boolean
//   validateLangFields(obj, paths, code) → { ok, failures: string[] }

// ─── Unicode-block detectors (returns share 0..1) ──────────────────────────

const SCRIPT_RANGES = {
  // Devanagari (Hindi/Marathi/Sanskrit)
  hi: [[0x0900, 0x097F]],
  // Arabic
  ar: [[0x0600, 0x06FF], [0x0750, 0x077F], [0x08A0, 0x08FF], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF]],
  // Urdu uses Arabic script
  ur: [[0x0600, 0x06FF], [0x0750, 0x077F], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF]],
  // CJK Unified Ideographs (Chinese)
  zh: [[0x4E00, 0x9FFF], [0x3400, 0x4DBF], [0x20000, 0x2A6DF]],
  // Hangul (Korean)
  ko: [[0xAC00, 0xD7AF], [0x1100, 0x11FF], [0x3130, 0x318F]]
  // Note: Vietnamese / Spanish / Portuguese / French / Tagalog / English
  // all use the Latin script — we discriminate them via stopwords below.
};

// ─── Per-language stopword sets (small, weighted) ─────────────────────────

const STOPWORDS = {
  en: ["the","and","of","to","is","for","with","you","your","this","that","on","in","be","at","not","or","if","from"],
  es: ["el","la","los","las","de","del","y","es","para","con","tu","su","este","esta","no","o","si","por","en","que"],
  fr: ["le","la","les","de","du","et","est","pour","avec","ton","ta","ce","cette","ne","ou","si","par","en","que","vous"],
  pt: ["o","a","os","as","de","do","da","e","é","para","com","seu","sua","este","esta","não","ou","se","por","em","que"],
  vi: ["và","của","là","cho","với","bạn","này","đó","không","hoặc","nếu","từ","trong","để","có","một","tại"],
  tl: ["ang","ng","sa","mga","ay","na","at","si","ko","mo","ito","iyon","hindi","o","kung","mula","para","may"]
};

function isLatinScript(text) {
  let latin = 0, total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7F) continue;
    total++;
    if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) ||
        (cp >= 0xC0 && cp <= 0x024F) || (cp >= 0x1E00 && cp <= 0x1EFF)) {
      latin++;
    }
  }
  return total === 0 ? true : (latin / total) > 0.6;
}

function scriptShare(text, ranges) {
  let inScript = 0, totalLetters = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x20 || cp === 0x7F) continue;
    // Skip digits / common punctuation / Latin so emoji & ASCII don't drown
    // out the script signal.
    const isAlpha =
      (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) ||
      cp >= 0x00C0;
    if (!isAlpha) continue;
    totalLetters++;
    for (const [lo, hi] of ranges) {
      if (cp >= lo && cp <= hi) { inScript++; break; }
    }
  }
  return totalLetters === 0 ? 0 : inScript / totalLetters;
}

function topLatinByStopwords(text) {
  const lc = " " + text.toLowerCase().replace(/[^a-zA-Zàáâäãåąčćęèéêëėįíìîïłńñòóôöõøùúûüųūÿýżźñçčšž\s]/g, " ") + " ";
  let best = "en", bestScore = -1;
  for (const [code, words] of Object.entries(STOPWORDS)) {
    let score = 0;
    for (const w of words) {
      // Count word-bounded occurrences.
      const re = new RegExp(`\\s${w}\\s`, "g");
      const m = lc.match(re);
      if (m) score += m.length;
    }
    if (score > bestScore) { best = code; bestScore = score; }
  }
  return { code: best, score: bestScore };
}

// ─── Public ────────────────────────────────────────────────────────────────

export function isProbablyLanguage(text, code) {
  if (!text || typeof text !== "string") return true; // empty = don't penalize
  if (!code) return true;
  const t = text.trim();
  if (t.length < 8) return true; // too short to judge

  // 1. Non-Latin scripts via block share.
  if (SCRIPT_RANGES[code]) {
    const share = scriptShare(t, SCRIPT_RANGES[code]);
    return share >= 0.4; // most letters should be in the expected script
  }

  // 2. Expected language uses Latin script.
  // If the text is dominated by a non-Latin script, that's a mismatch.
  if (!isLatinScript(t)) return false;

  // For Latin languages, use stopwords.
  if (!STOPWORDS[code]) return true; // unknown code → don't block
  const { code: detected, score } = topLatinByStopwords(t);
  if (score <= 0) return true; // no signal — don't block
  if (detected === code) return true;
  // English is permissive — many short snippets read as English. Only
  // hard-fail if the detected language scored noticeably higher.
  const requested = topLatinByStopwords(t);
  // re-run for requested code's own score
  let requestedScore = 0;
  if (STOPWORDS[code]) {
    const lc = " " + t.toLowerCase() + " ";
    for (const w of STOPWORDS[code]) {
      const re = new RegExp(`\\s${w}\\s`, "g");
      const m = lc.match(re);
      if (m) requestedScore += m.length;
    }
  }
  return requestedScore >= Math.ceil(score * 0.5);
}

// Walk a dot-path with support for numeric indices and `*` wildcards on
// arrays/objects. `plan.*.successCriteria` expands to every element.
function* walkPath(obj, parts) {
  if (!parts.length) { yield obj; return; }
  const [head, ...rest] = parts;
  if (obj == null) return;
  if (head === "*") {
    if (Array.isArray(obj)) {
      for (const v of obj) yield* walkPath(v, rest);
    } else if (typeof obj === "object") {
      for (const k of Object.keys(obj)) yield* walkPath(obj[k], rest);
    }
    return;
  }
  if (Array.isArray(obj) && /^\d+$/.test(head)) {
    yield* walkPath(obj[Number(head)], rest);
    return;
  }
  if (typeof obj === "object") {
    yield* walkPath(obj[head], rest);
  }
}

export function validateLangFields(obj, paths, code) {
  const failures = [];
  if (!obj || !Array.isArray(paths) || !code) return { ok: true, failures };
  for (const path of paths) {
    const parts = path.split(".");
    for (const value of walkPath(obj, parts)) {
      if (typeof value !== "string") continue;
      if (!isProbablyLanguage(value, code)) {
        failures.push(path);
        break; // one failure per path is enough to trigger a retry
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
