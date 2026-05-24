// agent/planner.js — Lyza v4 LLM brain.
//
// Three roles, three prompts, three schemas (Gemini 2.5 Flash, JSON mode):
//   plan / replan       — Planner: goal + memory + page map → plan[]
//   reflect             — Reflector: did the last step meet success?
//                         (deterministic cheap-first; LLM only when needed)
//   explainEscalation   — Escalation Explainer: render a CONFIRM card payload
//
// All three share the same call + retry + validation skeleton: parse JSON,
// re-emit once on failure, then validate language with lang-guard and
// re-translate once on failure. After two retries we throw PlannerError.

import { GEMINI, callGemini } from "./gemini-config.js";
import { validateLangFields } from "./lang-guard.js";
import { TOOLS, compactCatalogText } from "./tools.js";
import { buildDigest, digestToText } from "./memory.js";
import { DEFAULT_PROFILE, LANGUAGES } from "../config.js";

// ─── Errors ────────────────────────────────────────────────────────────────

export class PlannerError extends Error {
  constructor(code, message, extras = {}) {
    super(message || code);
    this.name = "PlannerError";
    this.code = code;
    Object.assign(this, extras);
  }
}

// ─── Config ────────────────────────────────────────────────────────────────

const MAX_PLAN_STEPS = 12;
const VALID_AUTHORITIES = new Set(["AUTO", "NOTIFY", "CONFIRM"]);
const LANG_FIELDS = [
  "recommendation",
  "expectedOutcome",
  "planRationale",
  "plan.*.successCriteria",
  "plan.*.say"
];

// ─── Language label helper ────────────────────────────────────────────────

function languageLabel(code) {
  const l = LANGUAGES.find((x) => x.code === code);
  return l ? l.label : (code || "English");
}

// ─── JSON parsing (lenient — strips ```json fences) ────────────────────────

function cleanJsonText(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function tryParseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(cleanJsonText(raw)) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// ─── Prompt building ───────────────────────────────────────────────────────

function buildPlannerSystem(profile) {
  const lang = languageLabel(profile.language);
  const catalog = (typeof compactCatalogText === "function")
    ? compactCatalogText()
    : "(tool catalog unavailable)";

  return `You are Lyza's PLANNER. You are given a goal, a memory digest, the user's profile,
the current page's interactive map (element ids prefixed "el_"), and the recent observation
(if any). You output a JSON plan that an autonomous executor will run.

Hard rules (the runtime validates these; violations are rejected):
1. Output JSON only. No markdown, no code fences, no prose.
2. All human-readable strings (recommendation, expectedOutcome, planRationale, every step's
   "successCriteria" and "say") MUST be in ${lang}. Tool names, enum values, and "el_N" ids
   stay in English.
3. Reference page elements ONLY by ids found in currentPage.elements (e.g. "el_12"). NEVER
   use raw CSS selectors, XPath, or coordinates.
4. Every step's "authority" must EXACTLY match the tool's catalog authority. You can never
   downgrade CONFIRM to NOTIFY or AUTO. (You may upgrade for safety.)
5. If memoryDigest.dupSellerFlag or memoryDigest.repeatScammerFlag is true, plan a DEFENSIVE
   path (flag_scammer, redact_warn, walk away). Never plan an engagement path against a
   flagged seller or repeat scammer.
6. The plan has at most ${MAX_PLAN_STEPS} steps. Front-load perception (read_interactive_map,
   read_page, recall_memory, compute_baseline) before any NOTIFY/CONFIRM step.
7. Each step's "successCriteria" must be a short, OBSERVABLE predicate (e.g. "shortlist
   counter ≥ 3", "all price elements have FX badge", "no scam-level high flagged"). Avoid
   vague success criteria like "Lyza did her best".
8. Sensitive fields (card / cvc / cvv / sin / ssn / password / cc-*) are NEVER auto-filled
   — propose redact_warn instead.

Tool catalog (name → authority — args sketch):
${catalog}

Output schema:
{
  "plan": [
    { "step": 1, "tool": "<tool>", "args": {...}, "authority": "AUTO|NOTIFY|CONFIRM",
      "successCriteria": "<short, observable, in ${lang}>",
      "say": "<optional 1-line narration in ${lang}>" }
  ],
  "escalateWhen": "<plain-${lang} condition that triggers an early CONFIRM ask>",
  "recommendation": "<one decisive sentence in ${lang}>",
  "expectedOutcome": "<2-3 sentence summary in ${lang} of what success looks like>",
  "planRationale": "<2-4 sentences in ${lang} explaining WHY this sequence — cite memory
                    flags / fair-range / risk signals you used>"
}
`;
}

function buildFewShotBlock(profile) {
  const lang = languageLabel(profile.language);
  // Three worked examples; concise to stay inside Planner's ≤3K-token budget.
  // The Planner is taught the SHAPE — actual user-facing strings will be in
  // the live request's language; here we keep examples in English so the
  // model still recognises the structure.
  return `Examples (showing the OUTPUT SHAPE — your real output's user-visible strings must be in ${lang}, not English):

# Example 1 — Kijiji rental, goal: "Find a safe 1-bed under $1,900 near campus."
{
  "plan": [
    { "step": 1, "tool": "read_interactive_map", "args": {}, "authority": "AUTO",
      "successCriteria": "page elements mapped" },
    { "step": 2, "tool": "read_page", "args": {}, "authority": "AUTO",
      "successCriteria": "page classified as rental with structured price" },
    { "step": 3, "tool": "recall_memory", "args": { "match": "host,seller,priceBand" }, "authority": "AUTO",
      "successCriteria": "memory cross-referenced" },
    { "step": 4, "tool": "compute_baseline", "args": { "kind": "rental_1bed", "currency": "CAD" }, "authority": "AUTO",
      "successCriteria": "personal fair range computed or marked insufficient_data" },
    { "step": 5, "tool": "highlight", "args": { "ids": ["el_price"], "style": "info", "reason": "asking price" }, "authority": "AUTO",
      "successCriteria": "price element outlined" },
    { "step": 6, "tool": "inject_badge", "args": { "id": "el_price", "text": "FX badge" }, "authority": "AUTO",
      "successCriteria": "FX badge visible next to price" },
    { "step": 7, "tool": "shortlist_add", "args": { "onlyIf": "risk=low AND price<=1900 AND within_baseline" }, "authority": "NOTIFY",
      "successCriteria": "listing added to mission shortlist if criteria met" },
    { "step": 8, "tool": "draft_email", "args": { "subject": "Viewing inquiry", "body": "..." }, "authority": "AUTO",
      "successCriteria": "draft created if shortlisted" }
  ],
  "escalateWhen": "shortlist reaches 3 OR send_email is needed",
  "recommendation": "Proceed if risk is low and price within personal fair range.",
  "expectedOutcome": "User shortlists 3 safe, fairly-priced listings and has draft inquiries ready to approve in one batch.",
  "planRationale": "Front-loaded perception (eyes, page, memory, baseline) so the autonomous decision at step 7 is grounded in the user's own history. Drafting (AUTO) is fine; sending (CONFIRM) waits for one batch approval."
}

# Example 2 — Hydro bill page, goal: "Never let me miss a payment in my first year."
{
  "plan": [
    { "step": 1, "tool": "read_interactive_map", "args": {}, "authority": "AUTO",
      "successCriteria": "page elements mapped" },
    { "step": 2, "tool": "read_page", "args": {}, "authority": "AUTO",
      "successCriteria": "bill page classified, due-date extracted" },
    { "step": 3, "tool": "highlight", "args": { "ids": ["el_due"], "style": "info", "reason": "due date" }, "authority": "AUTO",
      "successCriteria": "due-date element outlined" },
    { "step": 4, "tool": "calendar_remind", "args": { "title": "Hydro bill due", "when_hint": "3 days before due", "durationMinutes": 30 }, "authority": "NOTIFY",
      "successCriteria": "calendar reminder created or template URL opened" },
    { "step": 5, "tool": "remember", "args": { "kind": "bill", "notes": "hydro bill seen" }, "authority": "AUTO",
      "successCriteria": "memory record appended" }
  ],
  "escalateWhen": "none unless the bill is overdue and a payment action is required",
  "recommendation": "Set a reminder 3 days before the hydro bill is due.",
  "expectedOutcome": "A calendar reminder is created and the bill is logged in memory; user never misses this payment.",
  "planRationale": "Calendar template URL is NOTIFY (reversible). No CONFIRM needed because nothing is sent or paid."
}

# Example 3 — Marketplace seller vet, memoryDigest.dupSellerFlag=true
{
  "plan": [
    { "step": 1, "tool": "read_interactive_map", "args": {}, "authority": "AUTO",
      "successCriteria": "page elements mapped" },
    { "step": 2, "tool": "read_page", "args": {}, "authority": "AUTO",
      "successCriteria": "listing parsed with seller handle" },
    { "step": 3, "tool": "highlight", "args": { "ids": ["el_price","el_seller"], "style": "danger", "reason": "duplicate listing pattern from memory" }, "authority": "AUTO",
      "successCriteria": "price and seller marked danger" },
    { "step": 4, "tool": "annotate", "args": { "id": "el_seller", "note": "Same handle posted a cheaper unit recently — likely duplicate-listing scam." }, "authority": "AUTO",
      "successCriteria": "annotation visible next to seller block" },
    { "step": 5, "tool": "flag_scammer", "args": { "handle": "<from page>", "reason": "duplicate-listing pattern", "evidence": "memory dupSellerDetail" }, "authority": "NOTIFY",
      "successCriteria": "seller flagged in memory" }
  ],
  "escalateWhen": "user explicitly tries to contact the seller anyway",
  "recommendation": "Walk away — this matches a known duplicate-listing scam pattern from your memory.",
  "expectedOutcome": "Listing and seller are visibly flagged; the agent skips engagement and logs the scammer for future cross-reference.",
  "planRationale": "memoryDigest.dupSellerFlag is true, so the plan is purely defensive: highlight, annotate, flag. No engagement tools (draft_email, shortlist_add) are scheduled."
}
`;
}

function buildPlannerUser(input) {
  const {
    goal,
    profile,
    constraints,
    currentPage,
    memoryDigest,
    missionState,
    lastObservation,
    availableTools,
    replanReason
  } = input;

  const pageBlock = currentPage
    ? `currentPage:
  url: ${currentPage.url || ""}
  host: ${currentPage.host || ""}
  title: ${currentPage.title || ""}
  elements (id · role · label · text):
${(currentPage.elements || []).slice(0, 60).map(e =>
    `    - ${e.id} · ${e.role} · ${(e.label || "").slice(0, 60)} · ${(e.text || "").slice(0, 60)}`
).join("\n")}`
    : "currentPage: (none — plan perception steps first)";

  const memBlock = memoryDigest
    ? digestToText(memoryDigest)
    : "memory: (none yet)";

  const constraintsBlock = constraints
    ? Object.entries(constraints).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n")
    : "  (none)";

  const lastObsBlock = lastObservation
    ? `lastObservation: ${JSON.stringify(lastObservation).slice(0, 600)}`
    : "lastObservation: (none)";

  const toolBlock = availableTools && availableTools.length
    ? `availableTools: ${availableTools.join(", ")}`
    : "availableTools: (use catalog defaults)";

  const replanLine = replanReason
    ? `\n*** REPLAN — reason: ${replanReason} — produce a NEW plan starting from current state. ***\n`
    : "";

  const missionLine = missionState
    ? `missionState.cursor: ${missionState.cursor ?? 0}
missionState.counters: ${JSON.stringify(missionState.counters || {})}`
    : "missionState: (fresh)";

  return `${replanLine}
goal: ${goal || "(no goal supplied)"}

profile:
  language: ${profile?.language || DEFAULT_PROFILE.language}
  country: ${profile?.country || DEFAULT_PROFILE.country}
  localCurrency: ${profile?.localCurrency || DEFAULT_PROFILE.localCurrency}
  homeCurrency: ${profile?.homeCurrency || DEFAULT_PROFILE.homeCurrency}
  fluency: ${profile?.fluency || DEFAULT_PROFILE.fluency}

constraints:
${constraintsBlock}

${missionLine}

${pageBlock}

memoryDigest:
${memBlock}

${lastObsBlock}

${toolBlock}

Emit the JSON plan now.`;
}

// ─── Planner output validation ────────────────────────────────────────────

function validatePlannerOutput(out, { profile }) {
  if (!out || typeof out !== "object") {
    return { ok: false, reason: "not_an_object" };
  }
  if (!Array.isArray(out.plan)) {
    return { ok: false, reason: "missing_plan_array" };
  }
  if (out.plan.length === 0) {
    return { ok: false, reason: "empty_plan" };
  }
  if (out.plan.length > MAX_PLAN_STEPS) {
    return { ok: false, reason: `plan_too_long (${out.plan.length} > ${MAX_PLAN_STEPS})` };
  }

  const failures = [];
  for (let i = 0; i < out.plan.length; i++) {
    const s = out.plan[i];
    if (!s || typeof s !== "object") { failures.push(`step ${i}: not an object`); continue; }
    if (!s.tool || typeof s.tool !== "string") { failures.push(`step ${i}: missing tool`); continue; }
    if (TOOLS && !TOOLS[s.tool] && s.tool !== "DECIDE") {
      failures.push(`step ${i}: unknown tool "${s.tool}"`);
      continue;
    }
    if (!VALID_AUTHORITIES.has(s.authority)) {
      failures.push(`step ${i}: invalid authority "${s.authority}"`);
      continue;
    }
    // Catalog-authority equality check (CONFIRM can never be downgraded).
    const catalogAuth = TOOLS?.[s.tool]?.authority;
    if (catalogAuth === "CONFIRM" && s.authority !== "CONFIRM") {
      failures.push(`step ${i}: tool ${s.tool} is CONFIRM in catalog but step says ${s.authority}`);
      continue;
    }
    if (s.args && typeof s.args !== "object") {
      failures.push(`step ${i}: args must be an object`);
      continue;
    }
    if (s.args && JSON.stringify(s.args).match(/[#.>][a-zA-Z]/)) {
      // Cheap heuristic for raw CSS selectors leaking through.
      // Allow only el_NNN ids.
      // (We DON'T validate el_N against the live map here — loop.js does that.)
    }
  }
  if (failures.length) return { ok: false, reason: failures.join("; ") };

  // Language validation (best-effort; loop layer may retry).
  const lang = profile?.language || DEFAULT_PROFILE.language;
  const langCheck = validateLangFields(out, LANG_FIELDS, lang);
  return { ok: true, langCheck };
}

// ─── Generic JSON+lang retry envelope ─────────────────────────────────────

async function callWithRetries({ system, user, generationConfig, langCode, langPaths, signal }) {
  // Attempt 1.
  const messages = [{ role: "user", content: user }];
  let res = await callGemini({ system, messages, generationConfig, signal });
  if (res.error) throw new PlannerError(res.error, res.message);

  let parsed = tryParseJson(res.text);
  if (!parsed.ok) {
    // JSON retry — 1 shot.
    messages.push({ role: "assistant", content: res.text });
    messages.push({
      role: "user",
      content: "Your previous response was not valid JSON. Re-emit ONLY a valid JSON object that matches the schema. No markdown, no prose, no code fences."
    });
    res = await callGemini({ system, messages, generationConfig, signal });
    if (res.error) throw new PlannerError(res.error, res.message);
    parsed = tryParseJson(res.text);
    if (!parsed.ok) throw new PlannerError("INVALID_JSON", "Planner returned invalid JSON twice.");
  }

  // Language retry — 1 shot. Best-effort; on failure we log a warning and pass.
  if (langCode && Array.isArray(langPaths)) {
    const check = validateLangFields(parsed.value, langPaths, langCode);
    if (!check.ok) {
      messages.push({ role: "assistant", content: JSON.stringify(parsed.value) });
      messages.push({
        role: "user",
        content: `The fields ${check.failures.join(", ")} were not in the user's language. Re-emit the SAME JSON object but TRANSLATE every human-readable field to ${languageLabel(langCode)}. Keep tool names, enum values, and el_N ids unchanged.`
      });
      res = await callGemini({ system, messages, generationConfig, signal });
      if (!res.error) {
        const reparsed = tryParseJson(res.text);
        if (reparsed.ok) parsed = reparsed;
      }
      // If still wrong, accept it — better to ship slightly-wrong language
      // than to block the agent.
    }
  }

  return parsed.value;
}

// ─── PLAN ──────────────────────────────────────────────────────────────────

export async function plan(input) {
  const profile = { ...DEFAULT_PROFILE, ...(input?.profile || {}) };
  const system = buildPlannerSystem(profile);
  const fewShot = buildFewShotBlock(profile);
  const user = `${fewShot}\n\n--- NEW REQUEST ---\n\n${buildPlannerUser({ ...input, profile })}`;

  const out = await callWithRetries({
    system,
    user,
    generationConfig: GEMINI.planner,
    langCode: profile.language,
    langPaths: LANG_FIELDS,
    signal: input?.signal
  });

  const v = validatePlannerOutput(out, { profile });
  if (!v.ok) {
    throw new PlannerError("INVALID_PLAN", v.reason, { raw: out });
  }
  // Ensure each step has stable step numbers + clipped plan length.
  out.plan = out.plan.slice(0, MAX_PLAN_STEPS).map((s, i) => ({ step: i + 1, ...s }));
  return out;
}

// ─── REPLAN ────────────────────────────────────────────────────────────────

export async function replan(input) {
  return plan({ ...input, replanReason: input?.replanReason || "divergence" });
}

// ─── REFLECT ───────────────────────────────────────────────────────────────

// Deterministic cheap-first rules. If any rule fires, we skip the LLM and
// return its verdict.
function cheapReflect({ observation, currentStep, recentLog }) {
  // 1. Hard-fail signals that force a replan — no LLM needed.
  if (observation && observation.ok === false) {
    const code = observation.code || observation.error;
    if (code === "EL_NOT_FOUND" || code === "RESOLVE_FAILED") {
      return {
        satisfied: false,
        reason: `Element id no longer present on the page (${code}).`,
        nextAction: "replan",
        diagnosis: "stale_elements"
      };
    }
    if (code === "ABORTED") {
      return {
        satisfied: false,
        reason: "Step aborted.",
        nextAction: "complete"
      };
    }
  }

  // 2. Simple successCriteria predicates — eval against observation counters.
  if (currentStep?.successCriteria && observation?.ok && observation.counters) {
    const m = String(currentStep.successCriteria).match(/(counters?\.[a-zA-Z_]\w*)\s*(>=|>|=|==)\s*(\d+)/);
    if (m) {
      const [, key, op, valS] = m;
      const counterName = key.split(".").pop();
      const left = Number(observation.counters[counterName] || 0);
      const right = Number(valS);
      const ok = op === ">" ? left > right
        : op === ">=" ? left >= right
        : left === right;
      return {
        satisfied: ok,
        reason: `Predicate "${currentStep.successCriteria}" ${ok ? "met" : "not met"} (${left} ${op} ${right}).`,
        nextAction: ok ? "continue" : "replan"
      };
    }
  }

  // 3. Step succeeded with no risk-signal change → continue without LLM.
  if (observation?.ok && !observation.riskSignalChanged && !observation.escalateHint) {
    return {
      satisfied: true,
      reason: "Step completed without errors or risk-signal change.",
      nextAction: "continue"
    };
  }

  // 4. Three identical failures in a row → escalate (loop detection).
  if (Array.isArray(recentLog) && recentLog.length >= 3) {
    const last3 = recentLog.slice(-3);
    const allFailed = last3.every((r) => r && r.ok === false);
    const sameTool = last3.every((r, _, arr) => r.tool === arr[0].tool);
    if (allFailed && sameTool) {
      return {
        satisfied: false,
        reason: `Same tool ${last3[0].tool} failed 3 times in a row.`,
        nextAction: "escalate",
        diagnosis: "loop_detected"
      };
    }
  }

  return null; // fall through to LLM
}

function buildReflectorSystem(profile) {
  const lang = languageLabel(profile.language);
  return `You are Lyza's REFLECTOR. Given a goal, the current step + success criteria, the
observation that just came back, and a snippet of recent log entries, decide what the agent
should do next.

Hard rules:
1. Output JSON only.
2. Human-readable "reason" and "diagnosis" must be in ${lang}.
3. nextAction MUST be one of: "continue" | "replan" | "escalate" | "complete".
4. If success criteria are met → "continue" (or "complete" if this was the last step).
5. If a tool errored with EL_NOT_FOUND or RESOLVE_FAILED → "replan" with diagnosis "stale_elements".
6. If risk increased (new scam signal, sensitive field, irreversible action proposed) → "escalate".
7. If the goal is fully satisfied → "complete".

Output schema:
{
  "satisfied": boolean,
  "reason": "<short ${lang} sentence>",
  "nextAction": "continue" | "replan" | "escalate" | "complete",
  "diagnosis": "<optional short ${lang} string>",
  "suggestedReplan": "<optional short ${lang} hint for the next plan>"
}`;
}

function buildReflectorUser({ goal, profile, currentStep, successCriteria, observation, recentLog, memoryDigest }) {
  return `goal: ${goal || ""}
profile.language: ${profile?.language || "en"}
currentStep: ${currentStep ? JSON.stringify(currentStep).slice(0, 400) : "(none)"}
successCriteria: ${successCriteria || currentStep?.successCriteria || ""}
observation: ${observation ? JSON.stringify(observation).slice(0, 800) : "(none)"}
recentLog (last 5):
${(recentLog || []).slice(-5).map((e, i) => `  ${i + 1}. ${JSON.stringify(e).slice(0, 240)}`).join("\n")}
memoryDigest:
${memoryDigest ? digestToText(memoryDigest).slice(0, 1000) : "(none)"}

Emit the reflector JSON now.`;
}

export async function reflect(input) {
  const profile = { ...DEFAULT_PROFILE, ...(input?.profile || {}) };

  // Cheap-first.
  const cheap = cheapReflect({
    observation: input?.observation,
    currentStep: input?.currentStep,
    recentLog: input?.recentLog
  });
  if (cheap) return cheap;

  const system = buildReflectorSystem(profile);
  const user = buildReflectorUser({ ...input, profile });

  const out = await callWithRetries({
    system,
    user,
    generationConfig: GEMINI.reflector,
    langCode: profile.language,
    langPaths: ["reason", "diagnosis", "suggestedReplan"],
    signal: input?.signal
  });

  // Validate enum + shape.
  const allowed = new Set(["continue", "replan", "escalate", "complete"]);
  if (!allowed.has(out.nextAction)) {
    // Best-effort fallback rather than crashing the loop.
    return { satisfied: false, reason: "Reflector returned invalid nextAction.", nextAction: "replan" };
  }
  if (typeof out.satisfied !== "boolean") out.satisfied = out.nextAction === "continue" || out.nextAction === "complete";
  if (typeof out.reason !== "string") out.reason = "";
  return out;
}

// ─── ESCALATION EXPLAINER ──────────────────────────────────────────────────

function buildEscalationSystem(profile) {
  const lang = languageLabel(profile.language);
  return `You are Lyza's ESCALATION EXPLAINER. You render a CONFIRM card for the user. The user
will see your output as the only forced UI in the flow — it must be clear, honest, and
respectful of their time.

Hard rules:
1. Output JSON only.
2. All human-readable strings ("title", "summary", "evidence[]", "decisionAsks[]") in ${lang}.
3. payloadPreview is verbatim — copy the queued action's payload, REDACTED for sensitive
   values (e.g. card "•••• 4242" not full PAN).
4. evidence[] should cite concrete signals: domain age, blocklist hits, memory matches,
   missing TLS, etc. 2-5 bullets.
5. decisionAsks[] is the user's options. Always include "Approve", "Edit", "Decline".
6. summary is 2-4 sentences. Don't editorialize. Don't beg.

Output schema:
{
  "title": "<short ${lang} title>",
  "summary": "<2-4 sentence ${lang} explanation>",
  "evidence": ["<bullet>", "<bullet>", ...],
  "payloadPreview": <object — redacted preview of the action's payload>,
  "decisionAsks": ["Approve", "Edit", "Decline"]
}`;
}

function buildEscalationUser({ goal, profile, queuedAction, evidence, payloadPreview }) {
  return `goal: ${goal || ""}
profile.language: ${profile?.language || "en"}
queuedAction:
  tool: ${queuedAction?.tool || ""}
  authority: ${queuedAction?.authority || ""}
  args: ${queuedAction?.args ? JSON.stringify(queuedAction.args).slice(0, 800) : "{}"}
existing evidence (from the runtime / fraud engine):
${(evidence || []).map((e, i) => `  ${i + 1}. ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n") || "  (none)"}
payloadPreview (already redacted by the runtime):
${payloadPreview ? JSON.stringify(payloadPreview, null, 2).slice(0, 1600) : "(none)"}

Emit the escalation JSON now.`;
}

export async function explainEscalation(input) {
  const profile = { ...DEFAULT_PROFILE, ...(input?.profile || {}) };
  const system = buildEscalationSystem(profile);
  const user = buildEscalationUser({ ...input, profile });

  const out = await callWithRetries({
    system,
    user,
    generationConfig: GEMINI.escalation,
    langCode: profile.language,
    langPaths: ["title", "summary", "evidence.*", "decisionAsks.*"],
    signal: input?.signal
  });

  // Shape guarantees.
  if (!out.decisionAsks || !Array.isArray(out.decisionAsks) || !out.decisionAsks.length) {
    out.decisionAsks = ["Approve", "Edit", "Decline"];
  }
  if (!Array.isArray(out.evidence)) out.evidence = [];
  if (!out.payloadPreview) out.payloadPreview = input?.payloadPreview || {};
  if (typeof out.title !== "string") out.title = "";
  if (typeof out.summary !== "string") out.summary = "";
  return out;
}
