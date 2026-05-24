// agent/gemini-config.js — One place that owns the Gemini 2.5 Flash endpoint
// + per-role generation settings + the call helper. Planner / Reflector /
// Escalation Explainer all use the same shape so the loop can swap them out
// in tests without touching prompts.

const MODEL = "gemini-3.5-flash";

export const GEMINI = {
  endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
  planner: {
    responseMimeType: "application/json",
    temperature: 0.3,
    topP: 0.9,
    topK: 40,
    maxOutputTokens: 3200,
    candidateCount: 1
  },
  reflector: {
    responseMimeType: "application/json",
    temperature: 0.2,
    topP: 0.9,
    topK: 32,
    maxOutputTokens: 1200,
    candidateCount: 1
  },
  escalation: {
    responseMimeType: "application/json",
    temperature: 0.5,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 1500,
    candidateCount: 1
  }
};

const DEFAULT_API_KEY = "YOUR_GEMINI_API_KEY";

export async function getGeminiKey() {
  try {
    const { lyza_api_key } = await chrome.storage.local.get("lyza_api_key");
    return lyza_api_key || DEFAULT_API_KEY;
  } catch {
    return DEFAULT_API_KEY;
  }
}

function extractGeminiText(data) {
  const cand = (data?.candidates || [])[0];
  if (!cand) return "";
  const parts = cand.content?.parts || [];
  return parts.map((p) => p.text || "").join("\n").trim();
}

// callGemini — same wire format as background/service-worker.js, but takes a
// pre-built generationConfig so each role can dial temperature / max tokens
// independently. Returns `{ ok, text }` on success or `{ error, message }`.
export async function callGemini({ system, messages, generationConfig, signal }) {
  const apiKey = await getGeminiKey();
  if (!apiKey) return { error: "NO_API_KEY", message: "No Gemini API key set." };

  const contents = (messages || []).map((m) => ({
    role: m.role === "assistant" ? "model" : m.role,
    parts: [{ text: m.content }]
  }));

  const body = {
    system_instruction: { parts: [{ text: system || "" }] },
    contents,
    generationConfig: generationConfig || GEMINI.planner
  };

  let resp;
  try {
    resp = await fetch(`${GEMINI.endpoint}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e?.name === "AbortError") return { error: "ABORTED", message: "Aborted by caller." };
    return { error: "NETWORK_ERROR", message: String(e) };
  }

  if (!resp.ok) {
    let errText = "";
    try { errText = await resp.text(); } catch {}
    return { error: "API_ERROR", message: `Gemini ${resp.status}: ${errText.slice(0, 200)}` };
  }

  let data;
  try { data = await resp.json(); } catch (e) {
    return { error: "PARSE_ERROR", message: "Could not parse Gemini response." };
  }
  return { ok: true, text: extractGeminiText(data) };
}
