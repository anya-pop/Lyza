// popup.js — Profile + settings UI logic.
import {
  CURRENCIES,
  LANGUAGES,
  NEWCOMER_STATUS,
  TIME_IN_COUNTRY,
  FLUENCY,
  HOUSING,
  JOB,
  IMMIGRATION_STAGE,
  DEFAULT_PROFILE,
  STORAGE_KEYS
} from "../config.js";

// ---- Populate dropdowns --------------------------------------------------

function fill(id, items, valueKey = "value", labelKey = "label") {
  const el = document.getElementById(id);
  el.innerHTML = items
    .map((it) => `<option value="${it[valueKey]}">${it[labelKey]}</option>`)
    .join("");
}

fill("status", NEWCOMER_STATUS);
fill("timeInCountry", TIME_IN_COUNTRY);
fill("localCurrency", CURRENCIES, "code", "label");
fill("homeCurrency", CURRENCIES, "code", "label");
fill("language", LANGUAGES, "code", "label");
fill("fluency", FLUENCY);
fill("housing", HOUSING);
fill("job", JOB);
fill("immigrationStage", IMMIGRATION_STAGE);

// ---- Tabs ----------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// ---- Load / save profile -------------------------------------------------

const TEXT_FIELDS = ["country", "province"];
const SELECT_FIELDS = [
  "status",
  "timeInCountry",
  "localCurrency",
  "homeCurrency",
  "language",
  "fluency",
  "housing",
  "job",
  "immigrationStage"
];

async function loadProfile() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
  const profile = { ...DEFAULT_PROFILE, ...(stored[STORAGE_KEYS.PROFILE] || {}) };
  TEXT_FIELDS.forEach((f) => (document.getElementById(f).value = profile[f] || ""));
  SELECT_FIELDS.forEach((f) => (document.getElementById(f).value = profile[f]));
  document.getElementById("simplify").checked = !!profile.simplify;
}

document.getElementById("save").addEventListener("click", async () => {
  const profile = {};
  TEXT_FIELDS.forEach((f) => (profile[f] = document.getElementById(f).value.trim()));
  SELECT_FIELDS.forEach((f) => (profile[f] = document.getElementById(f).value));
  profile.simplify = document.getElementById("simplify").checked;
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: profile, [STORAGE_KEYS.ONBOARDED]: true });
  const msg = document.getElementById("saved-msg");
  msg.textContent = "✓ Profile saved";
  setTimeout(() => (msg.textContent = ""), 2000);
});

// ---- API key -------------------------------------------------------------

async function loadKey() {
  const { lyza_api_key } = await chrome.storage.local.get("lyza_api_key");
  if (lyza_api_key) document.getElementById("apiKey").value = lyza_api_key;
}

document.getElementById("saveKey").addEventListener("click", async () => {
  const key = document.getElementById("apiKey").value.trim();
  await chrome.storage.local.set({ lyza_api_key: key });
  const msg = document.getElementById("key-msg");
  msg.textContent = key ? "✓ Key saved" : "Cleared — using bundled default key";
  setTimeout(() => (msg.textContent = ""), 2000);
});

// ---- Financial picture dashboard ----------------------------------------

const KIND_LABELS = {
  rental: "Rentals",
  marketplace: "Marketplace",
  banking: "Bank offers",
  job: "Jobs",
  bill: "Bills",
  shopping: "Shopping",
  note: "Notes",
  other: "Other"
};

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatCurrency(amount, currency) {
  if (typeof amount !== "number" || !isFinite(amount) || !currency) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency, maximumFractionDigits: 0
    }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString()} ${currency}`;
  }
}

function topKind(byKind) {
  const entries = Object.entries(byKind || {});
  if (!entries.length) return "—";
  entries.sort((a, b) => b[1] - a[1]);
  const [k, n] = entries[0];
  return `${KIND_LABELS[k] || k} (${n})`;
}

function renderRecent(records) {
  const ul = document.getElementById("recent-list");
  if (!records.length) {
    ul.innerHTML = `<li class="recent-empty">Nothing yet. Open a page and click <b>Analyze</b> to start building your picture.</li>`;
    return;
  }
  ul.innerHTML = records.map((r) => {
    const risk = r.scamLevel || "low";
    const date = new Date(r.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return `<li class="recent-item">
      <div class="recent-top">
        <span class="recent-kind">${escapeHtml(KIND_LABELS[r.kind] || r.kind || "other")}</span>
        <span class="recent-risk risk-${risk}">${risk}</span>
      </div>
      <div class="recent-title" title="${escapeHtml(r.url || "")}">${escapeHtml(r.title || r.host || "Untitled")}</div>
      <div class="recent-meta">
        ${r.priceAmount != null ? escapeHtml(formatCurrency(r.priceAmount, r.priceCurrency || "USD")) : ""}
        ${r.host ? `· ${escapeHtml(r.host)}` : ""}
        · ${escapeHtml(date)}
      </div>
    </li>`;
  }).join("");
}

function loadPicture() {
  chrome.runtime.sendMessage({ type: "GET_MEMORY" }, (res) => {
    if (!res || !res.ok) return;
    const { summary, recent } = res;
    document.getElementById("stat-total").textContent = summary.total || 0;
    document.getElementById("stat-scams").textContent = summary.scamsAvoided || 0;
    document.getElementById("stat-overprice").textContent =
      summary.overpriceFlagged ? formatCurrency(summary.overpriceFlagged, summary.overpriceCurrency || "USD") : "—";
    document.getElementById("stat-kinds").textContent = topKind(summary.byKind);
    renderRecent(recent || []);
  });
}

document.getElementById("clear-memory").addEventListener("click", () => {
  if (!confirm("Clear all of Lyza's memory? This can't be undone.")) return;
  chrome.runtime.sendMessage({ type: "CLEAR_MEMORY" }, () => loadPicture());
});

loadProfile();
loadKey();
loadPicture();

// =========================================================================
// MISSION CONTROL
// =========================================================================

const SW_RESTARTING_MSG = "Lyza service worker is restarting. Try again in a moment.";

let _missionDetailId = null;

// Populate currency dropdown in the New Mission fieldset.
function fillMissionCurrencyDropdown() {
  const el = document.getElementById("mission-currency");
  if (!el) return;
  el.innerHTML = CURRENCIES
    .map((c) => `<option value="${c.code}">${escapeHtml(c.label)} (${c.code})</option>`)
    .join("");
  // Default to the user's local currency if profile is loaded.
  chrome.storage.local.get(STORAGE_KEYS.PROFILE, (stored) => {
    const profile = { ...DEFAULT_PROFILE, ...(stored[STORAGE_KEYS.PROFILE] || {}) };
    if (profile.localCurrency) el.value = profile.localCurrency;
  });
}

// sendMessage that doesn't throw if the SW is asleep / handler isn't wired.
function swSend(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message || "no-response" });
          return;
        }
        resolve(res || { ok: false, error: "no-response" });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

function showMissionCreateMsg(text, kind) {
  const msg = document.getElementById("mission-create-msg");
  if (!msg) return;
  msg.textContent = text;
  msg.style.color = kind === "error" ? "#c0382b" : "";
  setTimeout(() => { msg.textContent = ""; msg.style.color = ""; }, 3000);
}

const STATUS_LABEL = {
  draft: "Draft",
  active: "Active",
  awaiting_user: "Needs you",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed"
};

function statusBadgeHtml(status) {
  const cls = "status-" + (status || "draft");
  return `<span class="mission-status-badge ${cls}">${escapeHtml(STATUS_LABEL[status] || status || "draft")}</span>`;
}

function relTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago";
  return Math.round(diff / 86_400_000) + "d ago";
}

function lastLogLine(mission) {
  if (!mission.log || !mission.log.length) return "Waiting to start…";
  const last = mission.log[mission.log.length - 1];
  const kind = last.kind || "system";
  const tool = last.tool ? ` · ${last.tool}` : "";
  const notes = last.notes || last.result?.summary || "";
  return `${kind}${tool}${notes ? " — " + notes : ""}`;
}

// ---- list rendering ------------------------------------------------------

async function loadMissions() {
  const res = await swSend({ type: "LIST_MISSIONS" });
  const ul = document.getElementById("mission-list");
  if (!ul) return;
  if (!res.ok) {
    ul.innerHTML = `<li class="mission-empty">${escapeHtml(SW_RESTARTING_MSG)}</li>`;
    return;
  }
  const missions = res.missions || [];
  if (!missions.length) {
    ul.innerHTML = `<li class="mission-empty">No active missions yet. Create one above.</li>`;
    return;
  }
  ul.innerHTML = missions.map((m) => {
    const constraint = [];
    if (m.constraints?.budget) constraint.push(`under ${m.constraints.budget} ${escapeHtml(m.constraints.currency || "")}`.trim());
    if (m.constraints?.region) constraint.push(escapeHtml(m.constraints.region));
    return `<li class="mission-item" data-mission-id="${escapeHtml(m.id)}">
      <div class="mission-item-top">
        ${statusBadgeHtml(m.status)}
        <span class="mission-item-time">${escapeHtml(relTime(m.updatedAt))}</span>
      </div>
      <div class="mission-item-goal">${escapeHtml(m.goal || "(no goal)")}</div>
      ${constraint.length ? `<div class="mission-item-constraints">${constraint.join(" · ")}</div>` : ""}
      <div class="mission-item-last">${escapeHtml(lastLogLine(m))}</div>
    </li>`;
  }).join("");

  ul.querySelectorAll(".mission-item").forEach((li) => {
    li.addEventListener("click", () => openMissionDetail(li.dataset.missionId));
  });
}

// ---- create -------------------------------------------------------------

async function createMissionFromUI() {
  const goal = document.getElementById("mission-goal").value.trim();
  if (!goal) {
    showMissionCreateMsg("Please enter a goal first.", "error");
    return;
  }
  const budgetRaw = document.getElementById("mission-budget").value.trim();
  const currency = document.getElementById("mission-currency").value;
  const region = document.getElementById("mission-region").value.trim();

  const constraints = {};
  if (budgetRaw) {
    const n = Number(budgetRaw);
    if (Number.isFinite(n)) constraints.budget = n;
  }
  if (currency) constraints.currency = currency;
  if (region) constraints.region = region;

  const res = await swSend({ type: "CREATE_MISSION", goal, constraints });
  if (!res.ok) {
    showMissionCreateMsg(SW_RESTARTING_MSG, "error");
    return;
  }
  showMissionCreateMsg("✓ Mission delegated");
  document.getElementById("mission-goal").value = "";
  document.getElementById("mission-budget").value = "";
  document.getElementById("mission-region").value = "";
  loadMissions();
}

// ---- detail view --------------------------------------------------------

const KIND_DOT = {
  plan: "dot-plan",
  act: "dot-act",
  observe: "dot-observe",
  reflect: "dot-reflect",
  escalate: "dot-escalate",
  resume: "dot-resume",
  stop: "dot-stop",
  system: "dot-system",
  error: "dot-error"
};

function renderPlan(plan) {
  const ol = document.getElementById("md-plan");
  if (!ol) return;
  if (!plan || !plan.length) {
    ol.innerHTML = `<li class="md-plan-empty">No plan yet — Lyza will draft one shortly.</li>`;
    return;
  }
  ol.innerHTML = plan.map((step, i) => {
    const stepNo = step.step ?? (i + 1);
    const tool = step.tool || "(tool)";
    const authority = step.authority || "AUTO";
    const status = step.status || "pending";
    return `<li class="md-plan-step plan-status-${escapeHtml(status)}">
      <span class="md-step-num">${escapeHtml(String(stepNo))}</span>
      <div class="md-step-body">
        <div class="md-step-line">
          <span class="md-step-tool">${escapeHtml(tool)}</span>
          <span class="md-step-authority auth-${escapeHtml(authority)}">${escapeHtml(authority)}</span>
          <span class="md-step-status">${escapeHtml(status)}</span>
        </div>
        ${step.successCriteria ? `<div class="md-step-criteria">${escapeHtml(step.successCriteria)}</div>` : ""}
      </div>
    </li>`;
  }).join("");
}

function renderLog(log) {
  const ul = document.getElementById("md-log");
  if (!ul) return;
  if (!log || !log.length) {
    ul.innerHTML = `<li class="md-log-empty">No activity yet.</li>`;
    return;
  }
  // Newest at the top.
  const ordered = log.slice().reverse();
  ul.innerHTML = ordered.map((e) => {
    const kind = e.kind || "system";
    const dot = KIND_DOT[kind] || "dot-system";
    const when = new Date(e.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const tool = e.tool ? ` · ${escapeHtml(e.tool)}` : "";
    const notes = e.notes || e.result?.summary || "";
    return `<li class="md-log-item kind-${escapeHtml(kind)}">
      <span class="md-log-dot ${dot}"></span>
      <div class="md-log-body">
        <div class="md-log-head">
          <span class="md-log-kind">${escapeHtml(kind)}</span>${tool}
          <span class="md-log-time">${escapeHtml(when)}</span>
        </div>
        ${notes ? `<div class="md-log-notes">${escapeHtml(notes)}</div>` : ""}
        ${e.escalated ? `<div class="md-log-tag">escalated</div>` : ""}
      </div>
    </li>`;
  }).join("");
}

function renderEscalation(mission) {
  const pane = document.getElementById("md-escalation");
  if (!pane) return;
  if (!mission || mission.status !== "awaiting_user") {
    pane.hidden = true;
    pane.innerHTML = "";
    return;
  }
  const pending = (mission.escalations || []).filter((e) => e.status === "pending");
  if (!pending.length) {
    pane.hidden = true;
    pane.innerHTML = "";
    return;
  }
  const esc = pending[pending.length - 1];
  pane.hidden = false;
  pane.innerHTML = `
    <div class="md-esc-head">
      <span class="md-esc-badge">Needs your approval</span>
      <span class="md-esc-tool">${escapeHtml(esc.tool || "")}</span>
    </div>
    <div class="md-esc-reasoning">${escapeHtml(esc.reasoning || "Lyza wants to perform this irreversible step.")}</div>
    ${esc.evidence && esc.evidence.length
      ? `<ul class="md-esc-evidence">${esc.evidence.map((v) => `<li>${escapeHtml(v)}</li>`).join("")}</ul>`
      : ""}
    <pre class="md-esc-payload" id="md-esc-payload">${escapeHtml(JSON.stringify(esc.payloadPreview || {}, null, 2))}</pre>
    <div class="md-esc-actions">
      <button class="primary" data-esc-action="approve" data-esc-id="${escapeHtml(esc.id)}">Approve</button>
      <button class="secondary" data-esc-action="edit" data-esc-id="${escapeHtml(esc.id)}">Edit</button>
      <button class="danger" data-esc-action="decline" data-esc-id="${escapeHtml(esc.id)}">Decline</button>
    </div>
  `;

  pane.querySelectorAll("button[data-esc-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleEscalationAction(mission.id, btn.dataset.escId, btn.dataset.escAction));
  });
}

async function handleEscalationAction(missionId, escalationId, action) {
  if (action === "approve") {
    const res = await swSend({ type: "APPROVE_ESCALATION", missionId, escalationId });
    if (!res.ok) showMissionCreateMsg(SW_RESTARTING_MSG, "error");
  } else if (action === "edit") {
    const preEl = document.getElementById("md-esc-payload");
    const current = preEl ? preEl.textContent : "{}";
    const edited = prompt("Edit the payload (JSON):", current);
    if (edited == null) return;
    let parsed;
    try { parsed = JSON.parse(edited); }
    catch { showMissionCreateMsg("Invalid JSON — keeping original.", "error"); return; }
    const res = await swSend({ type: "APPROVE_ESCALATION", missionId, escalationId, edits: parsed });
    if (!res.ok) showMissionCreateMsg(SW_RESTARTING_MSG, "error");
  } else if (action === "decline") {
    const reason = prompt("Reason (optional):") || "";
    const res = await swSend({ type: "DECLINE_ESCALATION", missionId, escalationId, reason });
    if (!res.ok) showMissionCreateMsg(SW_RESTARTING_MSG, "error");
  }
  // The storage subscription will refresh the open detail view.
}

function renderMissionDetail(mission) {
  if (!mission) return;
  document.getElementById("md-goal").textContent = mission.goal || "(no goal)";
  document.getElementById("md-status").className = "mission-status-badge status-" + (mission.status || "draft");
  document.getElementById("md-status").textContent = STATUS_LABEL[mission.status] || mission.status || "draft";
  const s = mission.stats || {};
  document.getElementById("md-stats").textContent =
    `${s.stepsRun || 0} steps · ${s.autoCount || 0} auto · ${s.confirmAsked || 0} asked · ${s.confirmApproved || 0} approved`;
  renderEscalation(mission);
  renderPlan(mission.plan || []);
  renderLog(mission.log || []);

  // Pause/Resume button visibility based on status.
  const pause = document.getElementById("md-pause");
  const resume = document.getElementById("md-resume");
  pause.disabled = !(mission.status === "active" || mission.status === "awaiting_user");
  resume.disabled = !(mission.status === "paused");
}

async function openMissionDetail(missionId) {
  _missionDetailId = missionId;
  const res = await swSend({ type: "GET_MISSION", missionId });
  if (!res.ok || !res.mission) {
    showMissionCreateMsg(SW_RESTARTING_MSG, "error");
    return;
  }
  // Merge SW-provided full log into the mission object if present.
  const mission = res.mission;
  if (res.log) mission.log = res.log;
  renderMissionDetail(mission);
  document.getElementById("mission-detail").hidden = false;
}

function closeMissionDetail() {
  _missionDetailId = null;
  document.getElementById("mission-detail").hidden = true;
}

async function refreshOpenDetail() {
  if (!_missionDetailId) return;
  const res = await swSend({ type: "GET_MISSION", missionId: _missionDetailId });
  if (!res.ok || !res.mission) return;
  const mission = res.mission;
  if (res.log) mission.log = res.log;
  renderMissionDetail(mission);
}

// ---- pause / resume / cancel --------------------------------------------

async function pauseCurrent() {
  if (!_missionDetailId) return;
  const res = await swSend({ type: "PAUSE_MISSION", missionId: _missionDetailId });
  if (!res.ok) showMissionCreateMsg(SW_RESTARTING_MSG, "error");
}
async function resumeCurrent() {
  if (!_missionDetailId) return;
  const res = await swSend({ type: "RESUME_MISSION", missionId: _missionDetailId });
  if (!res.ok) showMissionCreateMsg(SW_RESTARTING_MSG, "error");
}
async function cancelCurrent() {
  if (!_missionDetailId) return;
  if (!confirm("Cancel this mission? Lyza will stop working on it.")) return;
  const res = await swSend({ type: "CANCEL_MISSION", missionId: _missionDetailId });
  if (!res.ok) {
    showMissionCreateMsg(SW_RESTARTING_MSG, "error");
    return;
  }
  closeMissionDetail();
  loadMissions();
}

// ---- live subscription --------------------------------------------------

function subscribeToMissions() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.lyza_missions_v1 && !changes.lyza_missions_index_v1) return;
    loadMissions();
    refreshOpenDetail();
  });
}

// ---- wiring -------------------------------------------------------------

fillMissionCurrencyDropdown();
subscribeToMissions();

document.getElementById("create-mission").addEventListener("click", createMissionFromUI);
document.getElementById("md-close").addEventListener("click", closeMissionDetail);
document.getElementById("md-pause").addEventListener("click", pauseCurrent);
document.getElementById("md-resume").addEventListener("click", resumeCurrent);
document.getElementById("md-cancel").addEventListener("click", cancelCurrent);

// Close modal on backdrop click.
document.getElementById("mission-detail").addEventListener("click", (e) => {
  if (e.target.id === "mission-detail") closeMissionDetail();
});

// Refresh the mission list when the Missions tab is activated.
document.querySelectorAll('.tab[data-tab="missions"]').forEach((tab) => {
  tab.addEventListener("click", loadMissions);
});

// Initial load.
loadMissions();
