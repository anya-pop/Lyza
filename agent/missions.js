// missions.js — Missions module for Lyza v4.
// Canonical schema lives in LYZA_MASTER_PLAN.md §8. This module owns ALL
// mission state writes; everything is persisted to chrome.storage.local
// BEFORE any exported async function resolves (no in-memory caching).
//
// Storage keys:
//   lyza_missions_v1            = { [missionId]: Mission, ... }
//   lyza_missions_index_v1      = { ids: string[], activeId: string|null }
//   lyza_missions_log_overflow_v1 = LogEntry[]  (global ring buffer, max 1000)

const KEY_MISSIONS = "lyza_missions_v1";
const KEY_INDEX = "lyza_missions_index_v1";
const KEY_LOG_OVERFLOW = "lyza_missions_log_overflow_v1";

const MISSION_LOG_CAP = 200;
const LOG_OVERFLOW_CAP = 1000;
const MISSION_TOTAL_CAP = 20;
const WORKSPACE_BYTE_CAP = 2048;
const AUTO_APPROVE_WINDOW_MS = 10 * 60 * 1000; // §6.3 — identical fingerprint auto-approved for 10min

// ---- low-level storage helpers ------------------------------------------

async function readMissions() {
  const o = await chrome.storage.local.get(KEY_MISSIONS);
  return o[KEY_MISSIONS] || {};
}

async function writeMissions(missions) {
  await chrome.storage.local.set({ [KEY_MISSIONS]: missions });
}

async function readIndex() {
  const o = await chrome.storage.local.get(KEY_INDEX);
  return o[KEY_INDEX] || { ids: [], activeId: null };
}

async function writeIndex(index) {
  await chrome.storage.local.set({ [KEY_INDEX]: index });
}

async function readLogOverflow() {
  const o = await chrome.storage.local.get(KEY_LOG_OVERFLOW);
  return o[KEY_LOG_OVERFLOW] || [];
}

async function writeLogOverflow(buf) {
  await chrome.storage.local.set({ [KEY_LOG_OVERFLOW]: buf });
}

// ---- utilities ----------------------------------------------------------

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Defensive fallback — SW environments should always have crypto.randomUUID.
  return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * Stable JSON: deterministic key ordering, optional whitelist of fields.
 * Used for escalation fingerprinting so identical (tool, args) pairs collapse
 * regardless of object key insertion order.
 */
export function stableJSON(obj, fields) {
  const seen = new WeakSet();
  function norm(v) {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out = {};
    Object.keys(v).sort().forEach((k) => {
      if (fields && !fields.includes(k)) return;
      out[k] = norm(v[k]);
    });
    return out;
  }
  // If fields was given but obj is an object, restrict at top level only.
  // (nested keys are kept verbatim under whitelisted top-level keys.)
  if (fields && obj && typeof obj === "object" && !Array.isArray(obj)) {
    const out = {};
    Object.keys(obj).sort().forEach((k) => {
      if (!fields.includes(k)) return;
      out[k] = norm(obj[k]);
    });
    return JSON.stringify(out);
  }
  return JSON.stringify(norm(obj));
}

/**
 * SHA-1 hex of a UTF-8 string. Used to fingerprint escalation payloads.
 * Falls back to a tiny djb2 hex if SubtleCrypto is unavailable.
 */
async function sha1Hex(s) {
  try {
    const enc = new TextEncoder().encode(s);
    const buf = await crypto.subtle.digest("SHA-1", enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }
}

function approxByteSize(obj) {
  try { return new Blob([JSON.stringify(obj)]).size; }
  catch { return JSON.stringify(obj || {}).length; }
}

function clampWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object") return {};
  if (approxByteSize(workspace) <= WORKSPACE_BYTE_CAP) return workspace;
  // Drop the oldest-inserted keys until we fit. Object insertion order is
  // preserved per spec, so this trims FIFO.
  const out = { ...workspace };
  const keys = Object.keys(out);
  while (keys.length && approxByteSize(out) > WORKSPACE_BYTE_CAP) {
    const k = keys.shift();
    delete out[k];
  }
  return out;
}

// ---- mission factory ----------------------------------------------------

function emptyStats() {
  return {
    stepsRun: 0,
    autoCount: 0,
    notifyCount: 0,
    confirmAsked: 0,
    confirmApproved: 0,
    scamsAvoided: 0,
    shortlisted: 0
  };
}

function buildMission({ goal, constraints }) {
  const now = Date.now();
  return {
    id: "msn_" + uuid(),
    goal: String(goal || "").trim(),
    createdAt: now,
    updatedAt: now,
    status: "draft",
    plan: [],
    planVersion: 0,
    state: {
      cursor: 0,
      lastObservation: null,
      pageContextRef: null,
      counters: {},
      workspace: {}
    },
    constraints: { ...(constraints || {}) },
    log: [],
    escalations: [],
    stats: emptyStats()
  };
}

// ---- capping ------------------------------------------------------------

/**
 * Enforce the 20-mission cap. Drops oldest completed/failed first; never
 * touches active / awaiting_user / paused. Mutates `missions` + `index`
 * in place and returns whether anything was dropped.
 */
function enforceMissionCap(missions, index) {
  const ids = index.ids.slice();
  if (ids.length <= MISSION_TOTAL_CAP) return false;
  const droppable = ids
    .map((id) => missions[id])
    .filter((m) => m && (m.status === "completed" || m.status === "failed"))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  let dropped = false;
  while (ids.length > MISSION_TOTAL_CAP && droppable.length) {
    const victim = droppable.shift();
    delete missions[victim.id];
    const i = ids.indexOf(victim.id);
    if (i >= 0) ids.splice(i, 1);
    if (index.activeId === victim.id) index.activeId = null;
    dropped = true;
  }
  index.ids = ids;
  return dropped;
}

// ---- exports ------------------------------------------------------------

export async function createMission({ goal, constraints } = {}) {
  const mission = buildMission({ goal, constraints });
  const missions = await readMissions();
  const index = await readIndex();
  missions[mission.id] = mission;
  index.ids.push(mission.id);
  if (!index.activeId) index.activeId = mission.id;
  enforceMissionCap(missions, index);
  await writeMissions(missions);
  await writeIndex(index);
  return mission;
}

export async function getMission(id) {
  const missions = await readMissions();
  return missions[id] || null;
}

export async function listMissions({ status, limit } = {}) {
  const missions = await readMissions();
  const index = await readIndex();
  let arr = index.ids
    .map((id) => missions[id])
    .filter(Boolean);
  if (status) {
    const want = Array.isArray(status) ? status : [status];
    arr = arr.filter((m) => want.includes(m.status));
  }
  arr.sort((a, b) => b.updatedAt - a.updatedAt);
  if (typeof limit === "number") arr = arr.slice(0, limit);
  return arr;
}

export async function appendLog(id, entry) {
  const missions = await readMissions();
  const mission = missions[id];
  if (!mission) return;
  const stamped = {
    ts: Date.now(),
    planVersion: mission.planVersion,
    step: entry.step ?? mission.state.cursor ?? null,
    kind: entry.kind || "system",
    ...entry
  };
  // Don't let a caller-provided ts override the canonical one.
  stamped.ts = Date.now();
  mission.log.push(stamped);
  mission.updatedAt = stamped.ts;

  // Cap mission log → roll overflow to the global ring buffer.
  if (mission.log.length > MISSION_LOG_CAP) {
    const overflow = mission.log.splice(0, mission.log.length - MISSION_LOG_CAP);
    if (overflow.length) {
      const buf = await readLogOverflow();
      // Tag each overflow entry with its mission id so the ring buffer is
      // self-describing (useful for the "Picture" stats).
      overflow.forEach((e) => { e._mid = id; });
      const merged = buf.concat(overflow);
      const trimmed = merged.length > LOG_OVERFLOW_CAP
        ? merged.slice(merged.length - LOG_OVERFLOW_CAP)
        : merged;
      await writeLogOverflow(trimmed);
    }
  }

  missions[id] = mission;
  await writeMissions(missions);
}

export async function updateState(id, patch) {
  const missions = await readMissions();
  const mission = missions[id];
  if (!mission) return null;
  const next = { ...mission.state, ...(patch || {}) };
  if (patch && Object.prototype.hasOwnProperty.call(patch, "workspace")) {
    next.workspace = clampWorkspace(patch.workspace);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, "counters")) {
    next.counters = { ...(mission.state.counters || {}), ...(patch.counters || {}) };
  }
  mission.state = next;
  mission.updatedAt = Date.now();
  missions[id] = mission;
  await writeMissions(missions);
  return mission;
}

export async function setStatus(id, status, lastError) {
  const missions = await readMissions();
  const mission = missions[id];
  if (!mission) return null;
  mission.status = status;
  mission.updatedAt = Date.now();
  if (lastError) {
    mission.lastError = {
      code: lastError.code || "ERR",
      message: lastError.message || String(lastError),
      ts: Date.now()
    };
  } else if (status === "active" || status === "completed") {
    delete mission.lastError;
  }
  missions[id] = mission;
  // If the active mission terminates, clear the activeId slot.
  const index = await readIndex();
  if ((status === "completed" || status === "failed") && index.activeId === id) {
    index.activeId = null;
    enforceMissionCap(missions, index);
    await writeIndex(index);
  }
  await writeMissions(missions);
  return mission;
}

export async function setPlan(id, plan, { bumpVersion = true } = {}) {
  const missions = await readMissions();
  const mission = missions[id];
  if (!mission) return null;
  mission.plan = Array.isArray(plan) ? plan : [];
  if (bumpVersion) mission.planVersion = (mission.planVersion || 0) + 1;
  mission.updatedAt = Date.now();
  missions[id] = mission;
  await writeMissions(missions);
  return mission;
}

/**
 * recordEscalation — dedupe by signature.
 * If an identical signature was approved within AUTO_APPROVE_WINDOW_MS,
 * the new escalation is created with status "approved" (auto-approval
 * cache from master plan §6.3). Otherwise it's persisted as pending.
 */
export async function recordEscalation(id, escalation) {
  const missions = await readMissions();
  const mission = missions[id];
  if (!mission) return null;

  const tool = escalation.tool || "";
  const args = escalation.payloadPreview || escalation.args || {};
  const fields = escalation.fingerprintFields;
  const signature = escalation.signature ||
    await sha1Hex(tool + "|" + stableJSON(args, fields));

  const now = Date.now();
  const cached = mission.escalations.find(
    (e) => e.signature === signature && e.status === "approved" &&
      (now - (e.decision?.ts || e.ts)) <= AUTO_APPROVE_WINDOW_MS
  );

  const entry = {
    id: "esc_" + uuid(),
    ts: now,
    step: escalation.step ?? mission.state.cursor ?? null,
    tool,
    payloadPreview: args,
    reasoning: escalation.reasoning || "",
    evidence: Array.isArray(escalation.evidence) ? escalation.evidence : [],
    authority: "CONFIRM",
    status: cached ? "approved" : "pending",
    signature
  };
  if (cached) {
    entry.decision = {
      ts: now,
      note: "auto-approved (matches prior approval within 10min)"
    };
  }

  mission.escalations.push(entry);
  mission.stats.confirmAsked = (mission.stats.confirmAsked || 0) + 1;
  if (cached) {
    mission.stats.confirmApproved = (mission.stats.confirmApproved || 0) + 1;
  } else {
    // Pending → mission moves to awaiting_user.
    mission.status = "awaiting_user";
  }
  mission.updatedAt = now;
  missions[id] = mission;
  await writeMissions(missions);
  return entry;
}

export async function resolveEscalation(id, escId, decision) {
  const missions = await readMissions();
  const mission = missions[id];
  if (!mission) return null;
  const esc = mission.escalations.find((e) => e.id === escId);
  if (!esc) return null;
  const now = Date.now();
  const status = decision?.status || "approved";
  esc.status = status;
  esc.decision = {
    ts: now,
    editedArgs: decision?.editedArgs,
    note: decision?.note
  };
  if (status === "approved" || status === "edited") {
    mission.stats.confirmApproved = (mission.stats.confirmApproved || 0) + 1;
  }
  // If no other escalation is still pending, the mission can resume.
  const stillPending = mission.escalations.some((e) => e.status === "pending");
  if (!stillPending && mission.status === "awaiting_user") {
    mission.status = "active";
  }
  mission.updatedAt = now;
  missions[id] = mission;
  await writeMissions(missions);
  return esc;
}

export async function setActive(id) {
  const index = await readIndex();
  index.activeId = id;
  await writeIndex(index);
}

export async function deleteMission(id) {
  const missions = await readMissions();
  const index = await readIndex();
  delete missions[id];
  const i = index.ids.indexOf(id);
  if (i >= 0) index.ids.splice(i, 1);
  if (index.activeId === id) index.activeId = null;
  await writeMissions(missions);
  await writeIndex(index);
}

/**
 * subscribe — wraps chrome.storage.onChanged. Fires the handler whenever
 * the missions map OR the index changes (in the local area).
 * Returns an unsubscribe function.
 */
export function subscribe(handler) {
  const listener = (changes, area) => {
    if (area !== "local") return;
    const missionsChange = changes[KEY_MISSIONS];
    const indexChange = changes[KEY_INDEX];
    if (!missionsChange && !indexChange) return;
    handler({
      missions: missionsChange ? missionsChange.newValue : undefined,
      index: indexChange ? indexChange.newValue : undefined,
      change: { missions: missionsChange, index: indexChange }
    });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
