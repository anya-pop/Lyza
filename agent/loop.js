// agent/loop.js — The PLAN→ACT→OBSERVE→REFLECT executor.
//
// This is the heart of Lyza v4. The service worker imports the public API
// (start / tick / resume / resumeAll / stop / isRunning /
// handleEscalationDecision) and routes messages to it.
//
// Design rules (master plan §5):
//   • Every step writes `act` and `observe` log entries before/after the
//     dispatch. This makes the loop crash-safe: resume can detect an act
//     without a matching observe and either re-run (AUTO/NOTIFY are
//     idempotent) or convert to an escalation (CONFIRM).
//   • The loop is stateless across calls — it always re-loads the mission
//     from storage, decides the next move, persists, and exits.
//   • STOP is reachable at any moment: `stop()` aborts in-flight tool calls
//     and persists status=paused.
//   • Self-protection: loop detection (3 identical failures), replan thrash
//     cap (planVersion > 20), plan-length cap (12 steps).
//   • Re-escalation back-off: same (tool, args) fingerprint blocked for 5
//     min after a decline; auto-approved for 10 min after an approve.

import * as missions from "./missions.js";
import * as memory from "./memory.js";
import * as tools from "./tools.js";
import * as planner from "./planner.js";
import { sha1 } from "./memory.js";
import { DEFAULT_PROFILE } from "../config.js";

// ─── Module-level state (transient — re-derivable from storage) ───────────

// Per-mission AbortControllers for in-flight tool calls. Survives only the
// service-worker activation; we re-derive nothing on resume because the
// abort signal only matters while a step is mid-dispatch.
const ABORT = new Map(); // missionId → AbortController
// Per-mission re-entrancy guard so two concurrent triggers don't double-step.
const TICKING = new Set(); // missionId

// Static caps (master plan §6.4 robustness + §3 catalog).
const PLAN_THRASH_LIMIT = 20;
const MAX_PLAN_STEPS = 12;
const LOOP_DETECTION_WINDOW = 3;
const RECENT_FAILURES_CAP = 5;

const DECLINE_BACKOFF_MS = 5 * 60 * 1000;     // 5 min
const APPROVE_BLANKET_MS = 10 * 60 * 1000;    // 10 min

// ─── Public API ───────────────────────────────────────────────────────────

export async function start(missionId) {
  const mission = await missions.get(missionId);
  if (!mission) return { ok: false, reason: "mission_not_found" };

  await missions.setStatus(missionId, "active");

  // Plan if we don't have one yet.
  if (!mission.plan || mission.plan.length === 0) {
    await planFor(missionId, { replanReason: null });
  }

  return tick(missionId);
}

export async function tick(missionId) {
  if (TICKING.has(missionId)) return { ok: true, busy: true };
  TICKING.add(missionId);
  try {
    return await tickInternal(missionId);
  } finally {
    TICKING.delete(missionId);
  }
}

export async function resume(missionId) {
  const mission = await missions.get(missionId);
  if (!mission) return { ok: false, reason: "mission_not_found" };

  // Recover from a crash mid-step: find the last `act` without a matching
  // `observe`. AUTO/NOTIFY are idempotent — re-run. CONFIRM must be
  // converted back to an escalation.
  const lastAct = lastUnobservedAct(mission);
  if (lastAct) {
    const auth = lastAct.authority || tools.TOOLS?.[lastAct.tool]?.authority || "AUTO";
    if (auth === "CONFIRM") {
      await escalateStep(mission, lastAct);
      return { ok: true, resumed: "converted_to_escalation" };
    }
    // AUTO/NOTIFY are re-run by simply ticking — cursor still points at the
    // unfinished step.
  }

  if (mission.status === "active") return tick(missionId);
  return { ok: true, status: mission.status };
}

export async function resumeAll() {
  const all = await missions.list();
  const active = all.filter((m) => m.status === "active" || m.status === "awaiting_user");
  const results = [];
  for (const m of active) {
    try { results.push({ id: m.id, ...(await resume(m.id)) }); }
    catch (e) { results.push({ id: m.id, error: String(e) }); }
  }
  return { ok: true, results };
}

export async function stop(missionId, reason = "user_stop") {
  const ctrl = ABORT.get(missionId);
  if (ctrl) {
    try { ctrl.abort(reason); } catch {}
    ABORT.delete(missionId);
  }
  await missions.setStatus(missionId, "paused");
  await missions.appendLog(missionId, { ts: Date.now(), kind: "stop", reason });
  return { ok: true };
}

export function isRunning(missionId) {
  return TICKING.has(missionId);
}

export async function handleEscalationDecision(missionId, escalationId, { decision, editedArgs, note } = {}) {
  const mission = await missions.get(missionId);
  if (!mission) return { ok: false, reason: "mission_not_found" };

  const esc = (mission.escalations || []).find((e) => e.id === escalationId);
  if (!esc) return { ok: false, reason: "escalation_not_found" };

  const step = esc.step;
  const fingerprint = esc.fingerprint;
  const now = Date.now();

  if (decision === "approve" || decision === "edit") {
    // Record approval + blanket window.
    await missions.recordEscalationDecision(missionId, escalationId, {
      decision, editedArgs, note, ts: now,
      blanketUntil: now + APPROVE_BLANKET_MS
    });

    // Execute the (possibly edited) step.
    const finalStep = editedArgs ? { ...step, args: { ...step.args, ...editedArgs } } : step;
    await missions.setStatus(missionId, "active");
    await actOnStep(mission, finalStep, { forcedAuthority: "AUTO_APPROVED" });
    return tick(missionId);
  }

  if (decision === "decline") {
    await missions.recordEscalationDecision(missionId, escalationId, {
      decision, note, ts: now,
      backoffUntil: now + DECLINE_BACKOFF_MS,
      fingerprint
    });
    // Replan from the current state.
    await planFor(missionId, { replanReason: "user_declined_escalation" });
    return tick(missionId);
  }

  return { ok: false, reason: "unknown_decision" };
}

// ─── Core tick (single iteration) ─────────────────────────────────────────

async function tickInternal(missionId) {
  const mission = await missions.get(missionId);
  if (!mission) return { ok: false, reason: "mission_not_found" };

  // Status gates.
  if (mission.status === "completed" || mission.status === "failed") {
    return { ok: true, status: mission.status };
  }
  if (mission.status === "paused") {
    return { ok: true, status: "paused" };
  }
  if (mission.status === "awaiting_user") {
    return { ok: true, status: "awaiting_user" };
  }

  // Self-protection: replan thrash.
  if ((mission.planVersion || 0) > PLAN_THRASH_LIMIT) {
    await missions.setStatus(missionId, "paused");
    await missions.appendLog(missionId, {
      ts: Date.now(), kind: "halt", reason: "PLAN_THRASH",
      planVersion: mission.planVersion
    });
    await missions.setLastError?.(missionId, { code: "PLAN_THRASH" });
    return { ok: false, reason: "PLAN_THRASH" };
  }

  // No plan? Plan first.
  if (!mission.plan || mission.plan.length === 0) {
    await planFor(missionId, { replanReason: null });
    return tick(missionId);
  }

  // Cursor at the end → REFLECT-as-completion.
  if ((mission.state?.cursor ?? 0) >= mission.plan.length) {
    await missions.setStatus(missionId, "completed");
    await missions.appendLog(missionId, { ts: Date.now(), kind: "done" });
    return { ok: true, status: "completed" };
  }

  // Loop detection on workspace.recentFailures.
  if (detectLoop(mission)) {
    await escalateLoopDetected(mission);
    return { ok: true, status: "awaiting_user", reason: "loop_detected" };
  }

  // Pick the next step.
  const cursor = mission.state?.cursor ?? 0;
  let step = mission.plan[cursor];
  if (!step) {
    await missions.setStatus(missionId, "completed");
    return { ok: true, status: "completed" };
  }

  // Determine effective authority at execution time. Dynamic upgrade rules
  // live inside tools.effectiveAuthority (catalog + sensitive-field detect
  // + cross-origin nav + submit-class).
  const ctx = await missions.buildContext(missionId);
  let effectiveAuth;
  try {
    effectiveAuth = (typeof tools.effectiveAuthority === "function")
      ? tools.effectiveAuthority(step.tool, step.args || {}, ctx)
      : (step.authority || tools.TOOLS?.[step.tool]?.authority || "AUTO");
  } catch {
    effectiveAuth = step.authority || "AUTO";
  }

  // Catalog says CONFIRM but the planner downgraded → upgrade back.
  const catalogAuth = tools.TOOLS?.[step.tool]?.authority;
  if (catalogAuth === "CONFIRM" && effectiveAuth !== "CONFIRM") {
    effectiveAuth = "CONFIRM";
  }

  // Approve-blanket short-circuit (re-escalation back-off §3).
  const fingerprint = await stepFingerprint(step);
  const blanketHit = await missions.findApproveBlanket?.(missionId, fingerprint);
  if (effectiveAuth === "CONFIRM" && blanketHit && Date.now() < blanketHit.until) {
    effectiveAuth = "AUTO_APPROVED";
  }

  // Decline back-off short-circuit.
  const declineHit = await missions.findDeclineBackoff?.(missionId, fingerprint);
  if (declineHit && Date.now() < declineHit.until) {
    // Skip this step, advance — planner will reshape next time.
    await missions.appendLog(missionId, {
      ts: Date.now(), kind: "skip", step: step.step, tool: step.tool,
      reason: "decline_backoff_active"
    });
    await missions.advanceCursor(missionId);
    return tick(missionId);
  }

  // Dispatch per authority.
  if (effectiveAuth === "CONFIRM") {
    await escalateStep(mission, { ...step, fingerprint });
    return { ok: true, status: "awaiting_user" };
  }

  // NOTIFY emits a passive status chip via tools (which knows how to send
  // an LYZA_TOOL_CALL to the page's clear_hands-style status helper).
  if (effectiveAuth === "NOTIFY") {
    try {
      if (typeof tools.invoke === "function") {
        await tools.invoke("status_chip", { text: `${step.tool}`, kind: "info" }, ctx).catch(() => {});
      }
    } catch {}
  }

  await actOnStep(mission, step, { forcedAuthority: effectiveAuth });
  return tick(missionId); // chain
}

// ─── ACT + OBSERVE for one step ───────────────────────────────────────────

async function actOnStep(mission, step, { forcedAuthority }) {
  const missionId = mission.id;
  const ctrl = new AbortController();
  ABORT.set(missionId, ctrl);

  const actEntry = {
    ts: Date.now(),
    kind: "act",
    step: step.step,
    tool: step.tool,
    args: redactArgs(step.args || {}),
    authority: forcedAuthority,
    fingerprint: step.fingerprint || (await stepFingerprint(step))
  };
  await missions.appendLog(missionId, actEntry);

  let observation;
  try {
    const ctx = await missions.buildContext(missionId);
    observation = await tools.invoke(step.tool, step.args || {}, {
      ...ctx,
      signal: ctrl.signal,
      missionId
    });
    if (!observation || typeof observation !== "object") observation = { ok: true, value: observation };
  } catch (e) {
    observation = { ok: false, code: "UNCAUGHT", error: String(e) };
  } finally {
    if (ABORT.get(missionId) === ctrl) ABORT.delete(missionId);
  }

  const observeEntry = {
    ts: Date.now(),
    kind: "observe",
    step: step.step,
    tool: step.tool,
    ok: observation.ok !== false,
    observation: redactObservation(observation)
  };
  await missions.appendLog(missionId, observeEntry);

  await trackFailure(missionId, observation, step);

  // Advance cursor only on success or after an explicit decision; failures
  // get a chance in REFLECT.
  await missions.setLastObservation?.(missionId, observation);

  // REFLECT — cheap-first via planner.reflect.
  const fresh = await missions.get(missionId);
  let reflection;
  try {
    reflection = await planner.reflect({
      goal: fresh.goal,
      profile: fresh.constraints?.profile || DEFAULT_PROFILE,
      currentStep: step,
      successCriteria: step.successCriteria,
      observation,
      recentLog: (fresh.log || []).slice(-10).filter((e) => e.kind === "observe"),
      memoryDigest: await memory.buildDigest(fresh, observation?.context || {})
    });
  } catch (e) {
    reflection = { satisfied: observation.ok !== false, reason: String(e), nextAction: observation.ok !== false ? "continue" : "replan" };
  }

  await missions.appendLog(missionId, {
    ts: Date.now(), kind: "reflect", step: step.step,
    nextAction: reflection.nextAction, reason: reflection.reason
  });

  switch (reflection.nextAction) {
    case "continue":
      await missions.advanceCursor(missionId);
      break;
    case "replan":
      // Self-heal on stale element ids: re-read the map FIRST.
      if (observation?.code === "EL_NOT_FOUND" || observation?.code === "RESOLVE_FAILED") {
        try { await tools.invoke("read_interactive_map", {}, await missions.buildContext(missionId)); } catch {}
      }
      await planFor(missionId, { replanReason: reflection.diagnosis || reflection.reason || "divergence" });
      break;
    case "escalate":
      await escalateStep(fresh, { ...step, fingerprint: await stepFingerprint(step) });
      break;
    case "complete":
      await missions.setStatus(missionId, "completed");
      break;
    default:
      await missions.advanceCursor(missionId);
  }
}

// ─── PLAN / REPLAN ────────────────────────────────────────────────────────

async function planFor(missionId, { replanReason }) {
  const mission = await missions.get(missionId);
  if (!mission) return;

  const ctx = await missions.buildContext(missionId);

  // Build inputs.
  const currentContext = {
    host: ctx.currentPage?.host,
    sellerHandle: ctx.currentPage?.sellerHandle,
    priceAmount: ctx.currentPage?.priceAmount,
    priceCurrency: ctx.currentPage?.priceCurrency
  };
  const digest = await memory.buildDigest(mission, currentContext);

  const input = {
    goal: mission.goal,
    profile: mission.constraints?.profile || DEFAULT_PROFILE,
    constraints: mission.constraints || {},
    currentPage: ctx.currentPage || null,
    memoryDigest: digest,
    missionState: mission.state || {},
    lastObservation: mission.state?.lastObservation,
    availableTools: ctx.availableTools,
    replanReason
  };

  let result;
  try {
    result = replanReason ? await planner.replan(input) : await planner.plan(input);
  } catch (e) {
    // Fallback: deterministic minimal plan (master plan §6 robustness).
    const fallback = [
      { step: 1, tool: "read_interactive_map", args: {}, authority: "AUTO", successCriteria: "page elements mapped" },
      { step: 2, tool: "read_page", args: {}, authority: "AUTO", successCriteria: "page classified" },
      { step: 3, tool: "recall_memory", args: { match: "host,seller,priceBand" }, authority: "AUTO", successCriteria: "memory cross-referenced" },
      { step: 4, tool: "compute_baseline", args: {}, authority: "AUTO", successCriteria: "baseline computed" }
    ];
    await missions.setPlan(missionId, fallback, { bumpVersion: true });
    await missions.appendLog(missionId, {
      ts: Date.now(), kind: "planner_error",
      code: e?.code || "UNKNOWN", message: String(e?.message || e)
    });
    return;
  }

  // Enforce plan-length cap defensively even if planner.js missed.
  const trimmed = (result.plan || []).slice(0, MAX_PLAN_STEPS);
  await missions.setPlan(missionId, trimmed, {
    bumpVersion: true,
    escalateWhen: result.escalateWhen,
    recommendation: result.recommendation,
    expectedOutcome: result.expectedOutcome,
    planRationale: result.planRationale
  });
  await missions.appendLog(missionId, {
    ts: Date.now(), kind: "plan",
    planVersion: (mission.planVersion || 0) + 1,
    steps: trimmed.length,
    reason: replanReason || "initial"
  });
}

// ─── Escalation handling ──────────────────────────────────────────────────

async function escalateStep(mission, step) {
  const missionId = mission.id;
  const fingerprint = step.fingerprint || (await stepFingerprint(step));

  // Dedupe: if there's already an OPEN escalation with the same fingerprint,
  // don't raise a second one.
  const open = (mission.escalations || []).find(
    (e) => e.fingerprint === fingerprint && !e.decision
  );
  if (open) {
    await missions.setStatus(missionId, "awaiting_user");
    return;
  }

  let explainer;
  try {
    explainer = await planner.explainEscalation({
      goal: mission.goal,
      profile: mission.constraints?.profile || DEFAULT_PROFILE,
      queuedAction: step,
      evidence: collectEvidence(mission, step),
      payloadPreview: redactArgs(step.args || {})
    });
  } catch (e) {
    explainer = {
      title: "Confirmation required",
      summary: "Lyza needs you to approve this action before continuing.",
      evidence: [],
      payloadPreview: redactArgs(step.args || {}),
      decisionAsks: ["Approve", "Edit", "Decline"]
    };
  }

  const escalation = {
    id: `esc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    step,
    fingerprint,
    explainer,
    decision: null
  };

  await missions.recordEscalation(missionId, escalation);
  await missions.setStatus(missionId, "awaiting_user");
  await missions.appendLog(missionId, {
    ts: Date.now(), kind: "escalate",
    step: step.step, tool: step.tool, escalationId: escalation.id
  });
}

async function escalateLoopDetected(mission) {
  const step = mission.plan?.[mission.state?.cursor ?? 0] || { tool: "unknown" };
  const escalation = {
    id: `esc_loop_${Date.now().toString(36)}`,
    ts: Date.now(),
    step,
    fingerprint: await sha1(`loop|${step.tool}|${JSON.stringify(step.args || {})}`),
    explainer: {
      title: "Lyza needs help — repeated failures",
      summary: `The same step (${step.tool}) failed multiple times in a row. Retry, skip, or pause?`,
      evidence: ["loop detected — 3 identical failed step attempts"],
      payloadPreview: redactArgs(step.args || {}),
      decisionAsks: ["Retry", "Skip", "Pause"]
    },
    decision: null,
    reason: "loop_detected"
  };
  await missions.recordEscalation(mission.id, escalation);
  await missions.setStatus(mission.id, "awaiting_user");
}

function collectEvidence(mission, step) {
  const evidence = [];
  if (step?.tool) evidence.push(`Tool: ${step.tool} (catalog authority: ${tools.TOOLS?.[step.tool]?.authority || "?"})`);
  const obs = mission.state?.lastObservation;
  if (obs?.scamRisk) evidence.push(`Last risk score: ${obs.scamRisk.score} / ${obs.scamRisk.level}`);
  if (obs?.context?.host) evidence.push(`Host: ${obs.context.host}`);
  return evidence;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function lastUnobservedAct(mission) {
  const log = mission.log || [];
  // Walk backwards, tracking the last `observe` step number per tool/step.
  const observed = new Set();
  const pending = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.kind === "observe") observed.add(`${e.step}:${e.tool}`);
    else if (e.kind === "act" && !observed.has(`${e.step}:${e.tool}`)) {
      pending.push(e);
    }
  }
  return pending[0] || null;
}

function detectLoop(mission) {
  const failures = mission.state?.workspace?.recentFailures || [];
  if (failures.length < LOOP_DETECTION_WINDOW) return false;
  const last3 = failures.slice(-LOOP_DETECTION_WINDOW);
  return last3.every((f) =>
    f.ok === false &&
    f.tool === last3[0].tool &&
    f.argsHash === last3[0].argsHash
  );
}

async function trackFailure(missionId, observation, step) {
  if (observation?.ok !== false) {
    // Successful → clear recent failures (loop fully recovered).
    await missions.updateWorkspace?.(missionId, { recentFailures: [] });
    return;
  }
  const argsHash = (await sha1(JSON.stringify(step.args || {}))).slice(0, 12);
  const entry = { ok: false, tool: step.tool, argsHash, code: observation.code || "UNKNOWN", ts: Date.now() };
  const mission = await missions.get(missionId);
  const prev = mission?.state?.workspace?.recentFailures || [];
  const next = [...prev, entry].slice(-RECENT_FAILURES_CAP);
  await missions.updateWorkspace?.(missionId, { recentFailures: next });
}

async function stepFingerprint(step) {
  // master plan §3 fingerprint = sha1(tool + stableJSON(args, fingerprintFields))
  const fingerprintFields = step?.fingerprintFields;
  const args = step?.args || {};
  let serialized;
  if (Array.isArray(fingerprintFields) && fingerprintFields.length) {
    const slim = {};
    for (const f of fingerprintFields) slim[f] = args[f];
    serialized = JSON.stringify(slim);
  } else {
    // Stable key order.
    serialized = JSON.stringify(args, Object.keys(args).sort());
  }
  return await sha1(`${step.tool}|${serialized}`);
}

// ─── Redaction (master plan §9.7) ─────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\b(?:\d[ -]?){13,19}\b/,             // long digit runs (card-ish)
  /\b\d{3}\s?\d{3}\s?\d{3}\b/,          // SIN-ish
  /password|cvv|cvc|sin|ssn|secret/i
];

function redactValue(v) {
  if (typeof v === "string") {
    let out = v;
    for (const re of SENSITIVE_PATTERNS) {
      out = out.replace(re, "[redacted]");
    }
    return out;
  }
  return v;
}

function redactArgs(args) {
  if (!args || typeof args !== "object") return args;
  const out = Array.isArray(args) ? [] : {};
  for (const [k, v] of Object.entries(args)) {
    if (/card|cvv|cvc|sin|ssn|password|secret|pan/i.test(k)) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object") {
      out[k] = redactArgs(v);
    } else {
      out[k] = redactValue(v);
    }
  }
  return out;
}

function redactObservation(obs) {
  if (!obs || typeof obs !== "object") return obs;
  // Truncate large bodies to keep the log under cap.
  const out = { ok: obs.ok, code: obs.code, error: obs.error };
  if (obs.context) out.context = obs.context;
  if (obs.scamRisk) out.scamRisk = obs.scamRisk;
  if (typeof obs.value !== "undefined") {
    const s = JSON.stringify(obs.value);
    out.value = s && s.length > 1200 ? s.slice(0, 1200) + "…" : obs.value;
  }
  if (obs.counters) out.counters = obs.counters;
  return out;
}
