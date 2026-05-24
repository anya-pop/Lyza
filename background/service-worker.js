// service-worker.js — Background orchestration layer.
// Receives scraped page content from the content script, builds a single
// structured prompt for the Gemini API, and returns parsed JSON analysis.

import { STORAGE_KEYS, DEFAULT_PROFILE, CURRENCIES, LANGUAGES } from "../config.js";

const MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
// Get a free Gemini API key at https://aistudio.google.com/app/apikey
// Either paste it here, or set it via the Lyza popup → Settings (stored in
// chrome.storage.local). The popup value takes precedence over this constant.
const DEFAULT_API_KEY = "YOUR_GEMINI_API_KEY";

// ---- Helpers -------------------------------------------------------------

async function getProfile() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
  return { ...DEFAULT_PROFILE, ...(stored[STORAGE_KEYS.PROFILE] || {}) };
}

async function getApiKey() {
  const { lyza_api_key } = await chrome.storage.local.get("lyza_api_key");
  return lyza_api_key || DEFAULT_API_KEY;
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
  return `You are Lyza, a financial acclimation assistant that helps newcomers to a country understand webpages they are browsing — marketplace listings, rental ads, banking offers, job postings, and online deals.

The user's profile:
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
- Preferred language for output: ${languageLabel(profile.language)}
- Local-language fluency: ${profile.fluency}
- Simplify explanations: ${profile.simplify ? "YES — use plain, simple words, short sentences" : "no, normal detail is fine"}
- Housing situation: ${profile.housing}
- Employment: ${profile.job}
- Immigration stage: ${profile.immigrationStage}

Your job: analyze the webpage content provided by the user and return a financial-acclimation analysis.

Rules:
- Write ALL human-readable output (summary, insights, explanations, tips) in the user's preferred language: ${languageLabel(profile.language)}.
- Be honest and cautious about scam risk. Newcomers are frequent fraud targets. Flag classic red flags: requests to wire money or pay deposits before viewing, off-platform payment, prices far below market, urgency/pressure, requests for personal documents, "I'm out of the country" stories, overpayment scams, too-good-to-be-true deals.
- For pricing, reason about typical local market norms for the user's region. You do not have live data, so be clear when an estimate is approximate. Give a realistic range, not false precision.
- Convert any prices you find from local currency to the user's home currency using a reasonable approximate exchange rate, and clearly label it as approximate.
- For rental/legal questions, give general educational info about tenant rights in the user's region, and ALWAYS note that local tenant boards / settlement agencies are the authoritative source. Do not give definitive legal advice.
- Keep it practical and reassuring without being naive.

You MUST respond with ONLY a valid JSON object (no markdown, no code fences, no prose before or after) in exactly this shape:

{
  "pageType": "marketplace | rental | banking | job | shopping | other",
  "summary": "2-4 sentence plain-language summary in the user's language of what this page is offering",
  "prices": [
    {
      "original": "CA$2,400/month",
      "converted": "≈ ₹148,000/month",
      "note": "short note in user's language"
    }
  ],
  "priceContext": {
    "verdict": "below_average | average | above_average | unknown",
    "explanation": "1-3 sentences in user's language about how this price compares to local norms, with approximate percentage if reasonable"
  },
  "scamRisk": {
    "level": "low | medium | high",
    "score": 0,
    "reasons": ["short reason 1", "short reason 2"]
  },
  "tips": ["1-3 short, actionable tips in the user's language tailored to a newcomer"],
  "disclaimer": "one short sentence in user's language reminding this is AI guidance, not financial/legal advice"
}

The scamRisk.score is an integer 0-100 where higher = riskier. Keep arrays short. If there are no prices, return an empty prices array and set priceContext.verdict to "unknown".`;
}

// ---- Gemini API helpers --------------------------------------------------

function extractGeminiText(data) {
  const cand = (data.candidates || [])[0];
  if (!cand) return "";
  const parts = cand.content?.parts || [];
  return parts.map((p) => p.text || "").join("\n").trim();
}

async function callGemini({ apiKey, system, messages, maxTokens, jsonMode }) {
  // Gemini uses "user" and "model" roles; map "assistant" -> "model".
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

// ---- API call ------------------------------------------------------------

async function analyzePage(pageData) {
  const profile = await getProfile();
  const apiKey = await getApiKey();

  if (!apiKey) {
    return {
      error: "NO_API_KEY",
      message: "No Gemini API key set. Open the Lyza popup → Settings to add one."
    };
  }

  const system = buildSystemPrompt(profile);

  const userContent = `Here is the webpage I'm looking at.

URL: ${pageData.url}
Page title: ${pageData.title}

Extracted content:
"""
${pageData.text.slice(0, 12000)}
"""

Analyze it for me as Lyza and return the JSON.`;

  try {
    const result = await callGemini({
      apiKey,
      system,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 1500,
      jsonMode: true
    });

    if (result.error) return result;

    const raw = result.text;
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();

    try {
      return { ok: true, analysis: JSON.parse(cleaned) };
    } catch (e) {
      return { error: "PARSE_ERROR", message: "Could not parse AI response.", raw: cleaned };
    }
  } catch (e) {
    return { error: "NETWORK_ERROR", message: String(e) };
  }
}

// ---- Chat follow-up (optional "if we have time" feature) -----------------

async function chatFollowUp({ pageData, history, question }) {
  const profile = await getProfile();
  const apiKey = await getApiKey();
  if (!apiKey) return { error: "NO_API_KEY", message: "No API key set." };

  const system = buildSystemPrompt(profile) +
    `\n\nThe user may now ask follow-up questions about this page. Answer conversationally in ${languageLabel(
      profile.language
    )}, staying focused on helping a newcomer make a safe, informed financial decision. Keep answers concise. You may answer in plain text now (not JSON) for chat.`;

  const messages = [
    {
      role: "user",
      content: `Context — the page I'm viewing:\nURL: ${pageData.url}\nTitle: ${pageData.title}\nContent:\n"""${pageData.text.slice(
        0,
        8000
      )}"""`
    },
    { role: "assistant", content: "Got it — I've reviewed the page. What would you like to know?" },
    ...history,
    { role: "user", content: question }
  ];

  try {
    const result = await callGemini({ apiKey, system, messages, maxTokens: 800, jsonMode: false });
    if (result.error) return result;
    return { ok: true, reply: result.text };
  } catch (e) {
    return { error: "NETWORK_ERROR", message: String(e) };
  }
}

// ---- Message router ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ANALYZE_PAGE") {
    analyzePage(msg.pageData).then(sendResponse);
    return true; // async
  }
  if (msg.type === "CHAT_FOLLOWUP") {
    chatFollowUp(msg.payload).then(sendResponse);
    return true;
  }
});
