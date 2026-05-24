// service-worker.js — v3 agentic background.
// Coordinates: 3-layer fraud engine + LLM analysis + real FX + memory +
// connector action executors (Calendar/Gmail/Drive via template URLs).

import { STORAGE_KEYS, DEFAULT_PROFILE, CURRENCIES, LANGUAGES } from "../config.js";
import {
  runUrlHeuristics,
  checkSafeBrowsing,
  checkDomainAge,
  fuseRisk,
  getFxRate,
  formatMoney,
  loadMemory,
  saveMemoryRecord,
  clearMemory,
  findMemoryHits,
  summarizeMemory
} from "./fraud-engine.js";

// ---- v4 agent layer imports ---------------------------------------------
import * as missions from "../agent/missions.js";
import * as loop from "../agent/loop.js";
import * as tools from "../agent/tools.js";

const MODEL = "gemini-3.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const DEFAULT_API_KEY = "YOUR_GEMINI_API_KEY";

// Google Safe Browsing v4 — fraud-engine Layer 2 blocklist signal.
const DEFAULT_SAFEBROWSING_KEY = "YOUR_SAFEBROWSING_API_KEY";

// ElevenLabs TTS — native-language narration for the guided walkthrough.
const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // Rachel — multilingual
const ELEVENLABS_MODEL = "eleven_multilingual_v2";
const DEFAULT_ELEVENLABS_KEY = "YOUR_ELEVENLABS_API_KEY";

// ---- Profile / key helpers ----------------------------------------------

async function getProfile() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
  return { ...DEFAULT_PROFILE, ...(stored[STORAGE_KEYS.PROFILE] || {}) };
}

async function getApiKey() {
  const { lyza_api_key } = await chrome.storage.local.get("lyza_api_key");
  return lyza_api_key || DEFAULT_API_KEY;
}

async function getSafeBrowsingKey() {
  const { lyza_safebrowsing_key } = await chrome.storage.local.get("lyza_safebrowsing_key");
  return lyza_safebrowsing_key || DEFAULT_SAFEBROWSING_KEY;
}

async function getElevenLabsKey() {
  const { lyza_elevenlabs_key } = await chrome.storage.local.get("lyza_elevenlabs_key");
  return lyza_elevenlabs_key || DEFAULT_ELEVENLABS_KEY;
}

function labelFor(list, value, key = "value", lbl = "label") {
  const found = list.find((x) => x[key] === value);
  return found ? found[lbl] : value;
}
function currencyLabel(code) {
  const c = CURRENCIES.find((x) => x.code === code);
  return c ? `${c.label} (${c.code}, ${c.symbol})` : code;
}
function languageLabel(code) {
  const l = LANGUAGES.find((x) => x.code === code);
  return l ? l.label : code;
}

// ---- Prompt construction -------------------------------------------------

function buildSystemPrompt(profile) {
  const lang = languageLabel(profile.language);
  return `You are Lyza, an agentic financial guardian for newcomers. You DECIDE, ACT and REMEMBER.
For each page (marketplace listings, rentals, banking offers, jobs, bills, online deals), produce
a structured analysis AND propose concrete one-tap actions the user can take. Be decisive, not wishy-washy.

User profile:
- Living in: ${profile.province}, ${profile.country}
- Newcomer status: ${labelFor(
    [
      { value: "student", label: "International student" },
      { value: "pr", label: "Permanent resident" },
      { value: "work", label: "Work permit" },
      { value: "refugee", label: "Refugee / protected person" },
      { value: "other", label: "Other" }
    ],
    profile.status
  )}
- Time in country: ${profile.timeInCountry}
- Local currency: ${currencyLabel(profile.localCurrency)}
- Home currency: ${currencyLabel(profile.homeCurrency)}
- Preferred output language: ${lang}
- Local-language fluency: ${profile.fluency}
- Simplify explanations: ${profile.simplify ? "YES — plain, simple, short" : "no, normal detail is fine"}
- Housing situation: ${profile.housing}
- Employment: ${profile.job}
- Immigration stage: ${profile.immigrationStage}

Rules:
- Write ALL human-readable output (summary, recommendation, explanations, tips, action labels, action payload text) in ${lang}.
- Be honest about scam risk. Flag classic red flags: wire/e-transfer requests, off-platform payment, prices far below market, urgency, document requests, "I'm out of the country", overpayment, too-good-to-be-true deals.
- For pricing, reason about local market norms for the region. Be clear when an estimate is approximate; give realistic ranges.
- Return prices as STRUCTURED numbers (amount + currency + period). Do NOT pre-format converted prices — the runtime does live FX conversion.
- For rental/legal items, note local tenant boards / settlement agencies are the authoritative source. Do not give definitive legal advice.
- If memory hits are provided, REASON ACROSS THEM. Mention duplicate listings, repeat sellers, or how this price compares to past observations.
- The recommendation must be DECISIVE (one sentence: "Proceed cautiously", "Walk away", "Worth visiting in person", etc.).
- Propose 2-4 concrete actions appropriate for the page type and risk level. Actions must be REAL next steps a newcomer would actually want.

You MUST respond with ONLY a valid JSON object (no markdown, no code fences, no prose):

{
  "pageType": "marketplace | rental | banking | job | bill | shopping | other",
  "kind": "rental | marketplace | banking | job | bill | shopping | other",
  "summary": "2-4 sentence plain-language summary in ${lang} of what this page is offering",
  "confidence": "low | medium | high",
  "prices": [
    { "amount": 2400, "currency": "CAD", "period": "month | one_time | year | hour", "note": "short note in ${lang}" }
  ],
  "priceContext": {
    "verdict": "below_average | average | above_average | unknown",
    "explanation": "1-3 sentences in ${lang} comparing to local norms"
  },
  "contentScamSignals": {
    "score": 0,
    "reasons": ["specific phrases or patterns found in the page content"]
  },
  "flaggedPhrases": ["exact short substrings copied from the page that are suspicious"],
  "sellerHandle": "phone number, email, or username if the page exposes one, else empty",
  "memoryInsights": ["1-3 sentences in ${lang} referencing the memory hits, if any are relevant"],
  "recommendation": "ONE decisive sentence in ${lang} — what Lyza advises the user to do",
  "actions": [
    {
      "id": "short_snake_id",
      "label": "Button label in ${lang} (3-5 words)",
      "type": "calendar_event | gmail_draft | drive_save | memory_log | platform_report",
      "rationale": "one short ${lang} sentence on why this action helps",
      "payload": {
        "title": "for calendar_event / drive_save",
        "when_hint": "for calendar_event: a date or relative date in ISO if possible (e.g. 2025-06-12T18:00), or natural-language fallback",
        "durationMinutes": 60,
        "location": "for calendar_event",
        "description": "calendar description / drive markdown body",
        "checklist": ["bullets to include in the description"],
        "to": "for gmail_draft: recipient if known, else empty",
        "subject": "for gmail_draft",
        "body": "for gmail_draft: full email body in fluent ${profile.fluency === 'low' ? lang + ' AND English (bilingual block)' : lang}, never shares SIN/banking info",
        "note": "for memory_log / platform_report: short note in ${lang}"
      }
    }
  ],
  "tips": ["1-3 short, actionable tips in ${lang}"],
  "disclaimer": "one short sentence in ${lang} reminding this is AI guidance, not financial/legal advice"
}

Action selection rules:
- Rental, looks fair → propose "Book a viewing" (calendar_event) AND "Draft inquiry" (gmail_draft) AND "Save to decisions folder" (drive_save).
- Rental, scammy → propose "Report & walk away" (platform_report) AND "Log this scammer" (memory_log).
- Marketplace, fair → propose "Draft a safe offer" (gmail_draft) AND "Save listing" (drive_save).
- Marketplace, scammy → propose "Walk away" (memory_log) AND optionally "Report listing" (platform_report).
- Bank/credit offer → propose "Set review reminder" (calendar_event before any promo expires) AND "Save summary" (drive_save).
- Bill / invoice → propose "Add due-date reminder" (calendar_event 3 days before due).
- Job → propose "Save posting" (drive_save) AND "Draft application email" (gmail_draft).
- Always limit to 2-4 actions, ordered most valuable first.

NEVER include the user's banking info, SIN, passwords, or sensitive personal data in any draft.
NEVER auto-send anything. Drafts are previewed; the user confirms.`;
}

// ---- Gemini API ----------------------------------------------------------

// Defensive JSON parsing: handles code fences, prose around the object,
// trailing commas, and partial truncation by finding the largest balanced
// {...} block.
function parseGeminiJson(raw) {
  if (!raw) return null;
  let cleaned = String(raw)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  // Strip leading prose (e.g. "Here is the JSON:") before the first {.
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  cleaned = cleaned.slice(first, last + 1);
  // Try direct parse.
  try { return JSON.parse(cleaned); } catch {}
  // Try removing trailing commas before } or ].
  try { return JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1")); } catch {}
  // Last resort: walk back from the end stripping characters until parse succeeds.
  for (let cut = cleaned.length - 1; cut > first + 1; cut--) {
    if (cleaned[cut] !== "}" && cleaned[cut] !== "]") continue;
    try { return JSON.parse(cleaned.slice(0, cut + 1)); } catch {}
  }
  return null;
}

function extractGeminiText(data) {
  const cand = (data.candidates || [])[0];
  if (!cand) return "";
  const parts = cand.content?.parts || [];
  return parts.map((p) => p.text || "").join("\n").trim();
}

async function callGemini({ apiKey, system, messages, maxTokens, jsonMode }) {
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : m.role,
    parts: [{ text: m.content }]
  }));
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(jsonMode ? { responseMimeType: "application/json" } : {})
    }
  };
  const resp = await fetch(`${GEMINI_API_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    return { error: "API_ERROR", message: `API request failed (${resp.status}). ${errText.slice(0, 200)}` };
  }
  const data = await resp.json();
  return { ok: true, text: extractGeminiText(data) };
}

// ---- Main analyze flow ---------------------------------------------------

async function analyzePage(pageData) {
  const profile = await getProfile();
  const apiKey = await getApiKey();
  if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY") {
    return { error: "NO_API_KEY", message: "No Gemini API key set. Open the Lyza popup → Settings to add one." };
  }

  // Layer 1+2 fire in parallel with the LLM call so total latency ≈ slowest of the three.
  const sbKey = await getSafeBrowsingKey();
  const memory = await loadMemory();
  const tentativeCurrent = {
    host: hostnameOf(pageData.url),
    url: pageData.url
  };
  const memoryHits = findMemoryHits(memory, tentativeCurrent);

  const urlHeuristicsP = Promise.resolve(runUrlHeuristics(pageData.url));
  const safeBrowsingP = checkSafeBrowsing(pageData.url, sbKey);
  const domainAgeP = checkDomainAge(pageData.url);

  const system = buildSystemPrompt(profile);
  const userContent = buildUserPrompt(pageData, memoryHits);

  const llmP = callGemini({
    apiKey, system,
    messages: [{ role: "user", content: userContent }],
    maxTokens: 8000,
    jsonMode: true
  });

  const [urlH, safeB, age, llmRes] = await Promise.all([urlHeuristicsP, safeBrowsingP, domainAgeP, llmP]);

  if (llmRes.error) return llmRes;

  let llm = parseGeminiJson(llmRes.text);
  if (!llm) {
    console.warn("[Lyza] Primary parse failed. Raw response (first 800 chars):", llmRes.text.slice(0, 800));
    // Retry once with a simpler "JSON only" reminder. Most failures are
    // truncated JSON or LLM prose around the object.
    const retry = await callGemini({
      apiKey, system,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: llmRes.text },
        { role: "user", content: "Your previous response was not valid JSON or was truncated. Re-emit ONLY a complete valid JSON object that matches the schema. No markdown, no code fences, no prose." }
      ],
      maxTokens: 8000,
      jsonMode: true
    });
    if (!retry.error) llm = parseGeminiJson(retry.text);
    if (!llm) {
      console.warn("[Lyza] Retry also failed. Raw retry (first 800 chars):", retry.text?.slice(0, 800));
      return {
        error: "PARSE_ERROR",
        message: "Lyza couldn't read this page (the AI returned malformed data). Try a more specific page like a single listing.",
        raw: (llmRes.text || "").slice(0, 400)
      };
    }
  }

  // Fuse risk: deterministic + live signals + LLM content score
  const contentScore = Number(llm.contentScamSignals?.score) || 0;
  const fused = fuseRisk(urlH, safeB, age, contentScore);

  // Merge reasons (deterministic first, then content-based)
  const reasons = [
    ...(urlH.signals || []),
    ...(safeB.label ? [safeB.label] : []),
    ...(age.label ? [age.label] : []),
    ...((llm.contentScamSignals?.reasons || []).slice(0, 6))
  ];

  // Real FX conversion on each structured price
  const prices = await Promise.all((llm.prices || []).map(async (p) => {
    const out = { ...p };
    const fx = await getFxRate(p.currency, profile.homeCurrency);
    if (fx && typeof p.amount === "number") {
      out.convertedAmount = Math.round(p.amount * fx.rate * 100) / 100;
      out.convertedCurrency = profile.homeCurrency;
      out.rate = fx.rate;
      out.rateTs = fx.ts;
      out.original = formatPrice(p);
      out.converted = `≈ ${formatMoney(out.convertedAmount, profile.homeCurrency)}` + (p.period ? `/${shortPeriod(p.period)}` : "");
    } else {
      out.original = formatPrice(p);
      out.converted = "";
    }
    return out;
  }));

  const analysis = {
    pageType: llm.pageType || "other",
    kind: llm.kind || llm.pageType || "other",
    summary: llm.summary || "",
    confidence: llm.confidence || "medium",
    prices,
    priceContext: llm.priceContext || { verdict: "unknown", explanation: "" },
    scamRisk: {
      level: fused.level,
      score: fused.score,
      reasons: dedupe(reasons).slice(0, 8),
      breakdown: {
        urlHeuristics: urlH.score,
        blocklist: safeB.available ? (safeB.listed ? "listed" : "clean") : "unavailable",
        domainAgeDays: age.ageDays,
        contentScore
      }
    },
    flaggedPhrases: llm.flaggedPhrases || [],
    sellerHandle: llm.sellerHandle || "",
    memoryHits,
    memoryInsights: llm.memoryInsights || [],
    recommendation: llm.recommendation || "",
    actions: (llm.actions || []).slice(0, 4),
    tips: llm.tips || [],
    disclaimer: llm.disclaimer || ""
  };

  // Write to memory
  const firstPrice = prices[0];
  await saveMemoryRecord({
    kind: analysis.kind,
    host: tentativeCurrent.host,
    title: pageData.title,
    url: pageData.url,
    priceAmount: firstPrice?.amount ?? null,
    priceCurrency: firstPrice?.currency ?? null,
    pricePeriod: firstPrice?.period ?? null,
    sellerHandle: analysis.sellerHandle || null,
    verdict: analysis.priceContext?.verdict ?? null,
    scamLevel: analysis.scamRisk.level,
    scamScore: analysis.scamRisk.score,
    summary: analysis.summary,
    recommendation: analysis.recommendation
  });

  return { ok: true, analysis };
}

function buildUserPrompt(pageData, memoryHits) {
  const memBlock = memoryHits.length
    ? `\n\nRelevant memory hits (the user has seen these before — REASON ACROSS THEM in memoryInsights):\n` +
      memoryHits.map((h, i) =>
        `${i + 1}. [${h._matchReason}] ${h.kind} on ${h.host} — ${h.title} — ${h.priceAmount ?? "?"} ${h.priceCurrency ?? ""}${h.pricePeriod ? "/" + h.pricePeriod : ""} · scam:${h.scamLevel} · verdict:${h.verdict ?? "?"}${h.sellerHandle ? " · seller:" + h.sellerHandle : ""}`
      ).join("\n")
    : "\n\nNo prior memory for this user.";

  return `Here is the webpage I'm looking at.

URL: ${pageData.url}
Page title: ${pageData.title}

Extracted content:
"""
${pageData.text.slice(0, 8000)}
"""${memBlock}

Analyze it as Lyza and return the JSON.`;
}

function hostnameOf(rawUrl) {
  try { return new URL(rawUrl).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}
function shortPeriod(p) {
  return ({ month: "mo", year: "yr", hour: "hr", one_time: "" })[p] || p;
}
function formatPrice(p) {
  if (typeof p.amount !== "number") return "";
  const base = formatMoney(p.amount, p.currency);
  if (p.period && p.period !== "one_time") return `${base}/${shortPeriod(p.period)}`;
  return base;
}

// ---- Chat follow-up ------------------------------------------------------

async function chatFollowUp({ pageData, history, question }) {
  const profile = await getProfile();
  const apiKey = await getApiKey();
  if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY") return { error: "NO_API_KEY", message: "No API key set." };

  const system = buildSystemPrompt(profile) +
    `\n\nFOLLOW-UP MODE: The user is now asking conversational follow-up questions about this page. Reply in ${languageLabel(profile.language)} in plain text (NOT JSON). Stay focused on helping a newcomer make a safe, informed financial decision. Keep replies concise.`;

  const messages = [
    {
      role: "user",
      content: `Context — the page I'm viewing:\nURL: ${pageData.url}\nTitle: ${pageData.title}\nContent:\n"""${pageData.text.slice(0, 8000)}"""`
    },
    { role: "assistant", content: "Got it — I've reviewed the page. What would you like to know?" },
    ...history,
    { role: "user", content: question }
  ];

  try {
    const result = await callGemini({ apiKey, system, messages, maxTokens: 2000, jsonMode: false });
    if (result.error) return result;
    return { ok: true, reply: result.text };
  } catch (e) {
    return { error: "NETWORK_ERROR", message: String(e) };
  }
}

// ---- Action executor (template-URL connectors) ---------------------------

function toIsoNoMs(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function calendarDateRange(when_hint, durationMinutes) {
  // Parse ISO if possible; else default to tomorrow 18:00 local
  let start = null;
  if (typeof when_hint === "string") {
    const parsed = Date.parse(when_hint);
    if (!isNaN(parsed)) start = new Date(parsed);
  }
  if (!start) {
    start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(18, 0, 0, 0);
  }
  const end = new Date(start.getTime() + (durationMinutes || 60) * 60000);
  const fmt = (d) => toIsoNoMs(d).replace(/[-:]/g, "");
  return `${fmt(start)}/${fmt(end)}`;
}

function buildExecution(action) {
  const p = action.payload || {};
  switch (action.type) {
    case "calendar_event": {
      const dates = calendarDateRange(p.when_hint, p.durationMinutes);
      const description = [
        p.description || "",
        Array.isArray(p.checklist) && p.checklist.length
          ? "\n\nChecklist:\n- " + p.checklist.join("\n- ")
          : ""
      ].filter(Boolean).join("");
      const params = new URLSearchParams({
        action: "TEMPLATE",
        text: p.title || action.label || "Lyza event",
        dates,
        details: description,
        location: p.location || ""
      });
      return {
        kind: "open_url",
        url: `https://calendar.google.com/calendar/render?${params.toString()}`,
        preview: {
          title: p.title,
          when: dates,
          location: p.location,
          description,
          checklist: p.checklist
        }
      };
    }
    case "gmail_draft": {
      const params = new URLSearchParams({
        view: "cm",
        fs: "1",
        to: p.to || "",
        su: p.subject || "",
        body: p.body || ""
      });
      return {
        kind: "open_url",
        url: `https://mail.google.com/mail/?${params.toString()}`,
        preview: { to: p.to, subject: p.subject, body: p.body }
      };
    }
    case "drive_save": {
      const title = p.title || action.label || "Lyza note";
      const md = [
        `# ${title}`,
        "",
        p.description || "",
        Array.isArray(p.checklist) && p.checklist.length
          ? "\n## Checklist\n- " + p.checklist.join("\n- ")
          : ""
      ].join("\n");
      return {
        kind: "download_markdown",
        content: md,
        filename: `${title.replace(/[^\w\- ]/g, "").slice(0, 60) || "lyza-note"}.md`,
        preview: { title, body: md }
      };
    }
    case "memory_log": {
      return { kind: "memory_log", note: p.note || action.label, preview: { note: p.note } };
    }
    case "platform_report": {
      const body = p.body || `Hello, I'd like to report a potentially fraudulent listing: ${p.note || ""}`;
      const params = new URLSearchParams({
        view: "cm", fs: "1",
        to: p.to || "",
        su: p.subject || "Reporting a suspicious listing",
        body
      });
      return {
        kind: "open_url",
        url: `https://mail.google.com/mail/?${params.toString()}`,
        preview: { to: p.to, subject: p.subject || "Reporting a suspicious listing", body }
      };
    }
    default:
      return { kind: "noop", preview: action.payload || {} };
  }
}

async function executeAction({ action, pageData }) {
  const plan = buildExecution(action);

  if (plan.kind === "open_url") {
    await chrome.tabs.create({ url: plan.url });
    return { ok: true, kind: plan.kind };
  }
  if (plan.kind === "download_markdown") {
    // Content script handles the actual download via Blob URL (works in MV3 page contexts).
    return { ok: true, kind: "download_markdown", filename: plan.filename, content: plan.content };
  }
  if (plan.kind === "memory_log") {
    await saveMemoryRecord({
      kind: "note",
      host: hostnameOf(pageData?.url || ""),
      title: action.label || "Note",
      url: pageData?.url,
      notes: plan.note,
      scamLevel: "high",
      scamScore: 90
    });
    return { ok: true, kind: "memory_log" };
  }
  return { ok: true, kind: "noop" };
}

function previewAction(action) {
  return buildExecution(action);
}

// ---- Memory queries (for popup dashboard) --------------------------------

async function getMemorySummary() {
  const memory = await loadMemory();
  return { ok: true, summary: summarizeMemory(memory), recent: memory.slice(0, 10) };
}

// ---- ElevenLabs TTS ------------------------------------------------------

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function synthesizeSpeech({ text, voiceId, language }) {
  const key = await getElevenLabsKey();
  if (!key || key === "YOUR_ELEVENLABS_KEY") {
    return { error: "NO_TTS_KEY", message: "No ElevenLabs key. Falling back to browser voice." };
  }
  const trimmed = String(text || "").slice(0, 900);
  if (!trimmed.trim()) return { error: "EMPTY_TEXT" };

  try {
    const resp = await fetch(`${ELEVENLABS_URL}/${voiceId || ELEVENLABS_VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text: trimmed,
        model_id: ELEVENLABS_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
      })
    });
    if (!resp.ok) {
      const errTxt = (await resp.text()).slice(0, 200);
      return { error: "TTS_API_ERROR", status: resp.status, message: errTxt };
    }
    const buf = await resp.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    return { ok: true, audio: `data:audio/mpeg;base64,${b64}`, lang: language || null };
  } catch (e) {
    return { error: "TTS_NETWORK_ERROR", message: String(e) };
  }
}

// ---- Message router ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ANALYZE_PAGE") {
    analyzePage(msg.pageData).then(sendResponse).catch((e) =>
      sendResponse({ error: "UNCAUGHT", message: String(e) })
    );
    return true;
  }
  if (msg.type === "CHAT_FOLLOWUP") {
    chatFollowUp(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.type === "PREVIEW_ACTION") {
    sendResponse({ ok: true, plan: previewAction(msg.action) });
    return false;
  }
  if (msg.type === "EXECUTE_ACTION") {
    executeAction(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.type === "GET_MEMORY") {
    getMemorySummary().then(sendResponse);
    return true;
  }
  if (msg.type === "CLEAR_MEMORY") {
    clearMemory().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "SPEAK") {
    synthesizeSpeech(msg.payload || {}).then(sendResponse).catch((e) =>
      sendResponse({ error: "UNCAUGHT", message: String(e) })
    );
    return true;
  }
  if (msg.type === "GET_PROFILE_LANGUAGE") {
    getProfile().then((p) => sendResponse({ ok: true, language: p.language || "en" }));
    return true;
  }
  if (msg.type === "SET_PROFILE_LANGUAGE" && typeof msg.language === "string") {
    (async () => {
      const profile = await getProfile();
      profile.language = msg.language;
      await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: profile });
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ---- v4 mission control ------------------------------------------------
  if (msg.type === "CREATE_MISSION") {
    (async () => {
      try {
        const m = await missions.createMission(msg.payload || {});
        await missions.setActive(m.id);
        // Fire-and-forget: kick the loop. If planner errors, mission stays in 'draft'.
        loop.start(m.id).catch((e) => console.warn("[Lyza] mission start failed", e));
        sendResponse({ ok: true, missionId: m.id, mission: m });
      } catch (e) {
        sendResponse({ error: "CREATE_FAILED", message: String(e) });
      }
    })();
    return true;
  }
  if (msg.type === "LIST_MISSIONS") {
    missions.listMissions(msg.payload || {})
      .then((list) => sendResponse({ ok: true, missions: list }))
      .catch((e) => sendResponse({ error: "LIST_FAILED", message: String(e) }));
    return true;
  }
  if (msg.type === "GET_MISSION") {
    missions.getMission(msg.missionId)
      .then((m) => sendResponse({ ok: !!m, mission: m, log: m?.log || [] }))
      .catch((e) => sendResponse({ error: "GET_FAILED", message: String(e) }));
    return true;
  }
  if (msg.type === "PAUSE_MISSION") {
    (async () => {
      try { await loop.stop(msg.missionId, "user_pause"); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ error: "PAUSE_FAILED", message: String(e) }); }
    })();
    return true;
  }
  if (msg.type === "RESUME_MISSION") {
    (async () => {
      try { await loop.resume(msg.missionId); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ error: "RESUME_FAILED", message: String(e) }); }
    })();
    return true;
  }
  if (msg.type === "CANCEL_MISSION") {
    (async () => {
      try {
        await loop.stop(msg.missionId, "user_cancel").catch(() => {});
        await missions.setStatus(msg.missionId, "failed", { code: "USER_CANCELLED", message: "Cancelled by user" });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ error: "CANCEL_FAILED", message: String(e) }); }
    })();
    return true;
  }
  if (msg.type === "APPROVE_ESCALATION") {
    (async () => {
      try {
        await loop.handleEscalationDecision(msg.missionId, msg.escalationId, {
          decision: "approved",
          editedArgs: msg.edits || null
        });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ error: "APPROVE_FAILED", message: String(e) }); }
    })();
    return true;
  }
  if (msg.type === "DECLINE_ESCALATION") {
    (async () => {
      try {
        await loop.handleEscalationDecision(msg.missionId, msg.escalationId, {
          decision: "declined",
          note: msg.reason || null
        });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ error: "DECLINE_FAILED", message: String(e) }); }
    })();
    return true;
  }

  // Content-script ping → wake loop on active mission for this tab.
  if (msg.type === "LYZA_CS_READY") {
    loop.resumeAll().catch((e) => console.warn("[Lyza] resumeAll on CS ready failed", e));
    sendResponse({ ok: true });
    return false;
  }

  // Tool-call results routed back from content scripts to pending invokes.
  if (msg.type === "LYZA_TOOL_RESULT") {
    if (typeof tools.resolvePending === "function") {
      tools.resolvePending(msg.callId, msg.result);
    }
    sendResponse({ ok: true });
    return false;
  }
});

// ---- v4 lifecycle: alarms heartbeat + onStartup resume -------------------

const MISSION_ALARM = "lyza_mission_tick";

function ensureMissionAlarm() {
  try {
    chrome.alarms.get(MISSION_ALARM, (existing) => {
      if (!existing) {
        chrome.alarms.create(MISSION_ALARM, { periodInMinutes: 1 });
      }
    });
  } catch (e) {
    console.warn("[Lyza] could not register alarm:", e);
  }
}

chrome.runtime.onStartup.addListener(() => {
  ensureMissionAlarm();
  loop.resumeAll().catch((e) => console.warn("[Lyza] resumeAll on startup failed", e));
});

chrome.runtime.onInstalled.addListener(() => {
  ensureMissionAlarm();
});

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MISSION_ALARM) {
      loop.resumeAll().catch((e) => console.warn("[Lyza] resumeAll on alarm failed", e));
    }
  });
}

// Initial registration in case onInstalled doesn't fire (e.g. SW restart mid-session).
ensureMissionAlarm();
