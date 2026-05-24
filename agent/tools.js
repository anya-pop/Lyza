// agent/tools.js — Tool registry, authority routing, and cross-context invoke.
//
// This file is an ES module — it is imported by background/service-worker.js
// which is configured with "type": "module" in manifest.json. Do NOT add an
// IIFE; export everything.
//
// Each tool descriptor:
//   {
//     authority: "AUTO" | "NOTIFY" | "CONFIRM",
//     context:   "service_worker" | "content_script",
//     description: string,          // one-line catalog text for the planner
//     argsSchema?: object           // optional shallow shape for validation
//   }
//
// Authority semantics:
//   AUTO    — reversible, private (read, badge, scroll, highlight, draft, log)
//   NOTIFY  — acts visibly but reversible (fill, open tab, shortlist, ...)
//   CONFIRM — irreversible / outgoing (submit, send, pay, navigate-away)
//
// Dynamic upgrade rules live in effectiveAuthority() — e.g. fill_field on a
// payment-class element upgrades to CONFIRM.

export const TOOLS = {
  // ---- Perception (AUTO, read-only) ------------------------------------
  read_page: {
    authority: "AUTO",
    context: "service_worker",
    description: "Scrape + 3-layer fraud engine for the current page.",
    argsSchema: {}
  },
  read_interactive_map: {
    authority: "AUTO",
    context: "content_script",
    description: "Return [{id,role,label}] of actionable elements on the page.",
    argsSchema: {}
  },
  recall_memory: {
    authority: "AUTO",
    context: "service_worker",
    description: "Cross-reference host / seller / price band against memory.",
    argsSchema: { match: "string" }
  },
  compute_baseline: {
    authority: "AUTO",
    context: "service_worker",
    description: "User's personal fair-price range from past observations.",
    argsSchema: { category: "string", currency: "string" }
  },
  fx_convert: {
    authority: "AUTO",
    context: "service_worker",
    description: "Live FX conversion via Frankfurter, cached 1h.",
    argsSchema: { amount: "number", from: "string", to: "string" }
  },

  // ---- Memory & private side effects -----------------------------------
  remember: {
    authority: "AUTO",
    context: "service_worker",
    description: "Append a memory record.",
    argsSchema: { kind: "string", host: "string" }
  },
  shortlist_add: {
    authority: "NOTIFY",
    context: "service_worker",
    description: "Add a listing to the mission shortlist.",
    argsSchema: { missionId: "string", listing: "object" }
  },
  flag_scammer: {
    authority: "NOTIFY",
    context: "service_worker",
    description: "Log a seller/host as a scammer.",
    argsSchema: { handle: "string", host: "string", reason: "string" }
  },
  drive_save: {
    authority: "NOTIFY",
    context: "service_worker",
    description: "Save markdown via Drive template or local download.",
    argsSchema: { title: "string", description: "string" }
  },
  calendar_remind: {
    authority: "NOTIFY",
    context: "service_worker",
    description: "Create a Calendar reminder via template URL.",
    argsSchema: { title: "string", when_hint: "string", durationMinutes: "number" }
  },

  // ---- Drafting --------------------------------------------------------
  draft_email: {
    authority: "AUTO",
    context: "service_worker",
    description: "Create a Gmail draft (does NOT send).",
    argsSchema: { to: "string", subject: "string", body: "string" }
  },

  // ---- Irreversible (CONFIRM) ------------------------------------------
  send_email: {
    authority: "CONFIRM",
    context: "service_worker",
    description: "Send a drafted email (OAuth or open compose tab).",
    argsSchema: { to: "string", subject: "string", body: "string" }
  },
  submit_form: {
    authority: "CONFIRM",
    context: "content_script",
    description: "Submit a form previously filled by fill_form.",
    argsSchema: { formId: "string" }
  },
  report_platform: {
    authority: "CONFIRM",
    context: "service_worker",
    description: "Report a listing or seller to the platform.",
    argsSchema: { to: "string", subject: "string", body: "string" }
  },
  click_submit: {
    authority: "CONFIRM",
    context: "content_script",
    description: "Click a submit/pay/sign control.",
    argsSchema: { id: "string" }
  },

  // ---- v5 Annotation (AUTO, visible) -----------------------------------
  highlight: {
    authority: "AUTO",
    context: "content_script",
    description: "Outline an element with a styled box and optional tooltip.",
    argsSchema: { ids: "array|string", style: "string", reason: "string" }
  },
  annotate: {
    authority: "AUTO",
    context: "content_script",
    description: "Speech-bubble note next to an element.",
    argsSchema: { id: "string", note: "string" }
  },
  scroll_to: {
    authority: "AUTO",
    context: "content_script",
    description: "Smooth scrollIntoView the element.",
    argsSchema: { id: "string" }
  },
  inject_badge: {
    authority: "AUTO",
    context: "content_script",
    description: "Floating FX/info badge next to an element.",
    argsSchema: { id: "string", text: "string", tone: "string" }
  },

  // ---- v5 Manipulation --------------------------------------------------
  redact_warn: {
    authority: "NOTIFY",
    context: "content_script",
    description: "Blur sensitive fields + intercept events.",
    argsSchema: { ids: "array", reason: "string" }
  },
  fill_field: {
    authority: "NOTIFY",
    context: "content_script",
    description: "Visible human-paced typing into one input.",
    argsSchema: { id: "string", value: "string" }
  },
  set_select: {
    authority: "NOTIFY",
    context: "content_script",
    description: "Choose a dropdown option (native or ARIA combobox).",
    argsSchema: { id: "string", option: "string" }
  },
  fill_form: {
    authority: "NOTIFY",
    context: "content_script",
    description: "Bulk fill multiple fields; stops before submit.",
    argsSchema: { formMap: "object", leaveBlank: "array" }
  },
  simulate_typing: {
    authority: "AUTO",
    context: "content_script",
    description: "Human-paced typing helper (no focus/blur).",
    argsSchema: { id: "string", text: "string", cadenceMs: "number" }
  },
  click: {
    authority: "NOTIFY",
    context: "content_script",
    description: "Click a benign element (NEVER a submit-class control).",
    argsSchema: { id: "string" }
  },
  clear_hands: {
    authority: "AUTO",
    context: "content_script",
    description: "Remove every artifact the agent has injected.",
    argsSchema: { kinds: "array", reason: "string" }
  },

  // ---- v5 Navigation ----------------------------------------------------
  open_tab: {
    authority: "NOTIFY",
    context: "service_worker",
    description: "Open a new tab.",
    argsSchema: { url: "string", background: "boolean" }
  },
  navigate: {
    authority: "CONFIRM",
    context: "service_worker",
    description: "Replace the current tab's URL.",
    argsSchema: { url: "string" }
  },
  compare_tabs: {
    authority: "NOTIFY",
    context: "service_worker",
    description: "Diff two pages side-by-side (returns a diff table).",
    argsSchema: { urlA: "string", urlB: "string" }
  },
  collect_across_tabs: {
    authority: "NOTIFY",
    context: "service_worker",
    description: "Serial: open → read → close → return ranked rows.",
    argsSchema: { urls: "array", fields: "array" }
  },
  return_to: {
    authority: "AUTO",
    context: "service_worker",
    description: "Switch to a previously-opened tab.",
    argsSchema: { tabId: "number" }
  },

  // ---- Planner pseudo-tool ---------------------------------------------
  DECIDE: {
    authority: "AUTO",
    context: "service_worker",
    description:
      "Branch on a predicate over mission state — no DOM/external side effect.",
    argsSchema: { rule: "string", then: "string", else: "string" }
  }
};

// ---- Lookup -----------------------------------------------------------

export function getToolDescriptor(name) {
  return TOOLS[name] || null;
}

// ---- Authority routing -----------------------------------------------

const PAYMENT_LIKE_TARGET_TOOLS = new Set([
  "fill_field",
  "fill_form",
  "set_select",
  "click",
  "simulate_typing"
]);

/**
 * Resolve the *effective* authority for a step, applying the dynamic upgrade
 * rules from the master plan §3. Pure function — no side effects.
 *
 * Caller (planner / loop) populates `args.elementMeta` when it has it:
 *   {
 *     sensitive: true|false,   // payment / sin / password / gov_id field
 *     submitClass: true|false, // submit/pay/sign control
 *     formHasSensitive: bool   // any field in target form is sensitive
 *   }
 *
 * Returns the upgraded authority; mutates `args` to add explanatory flags
 * (crossOriginWarning, paymentClassUpgrade) so the escalation card can
 * render them.
 */
export function effectiveAuthority(name, args, ctx) {
  const desc = getToolDescriptor(name);
  if (!desc) return "CONFIRM"; // unknown tool → safest default
  let auth = desc.authority;
  const meta = (args && args.elementMeta) || {};

  // 1. Payment-class element → CONFIRM for any manipulation tool.
  if (PAYMENT_LIKE_TARGET_TOOLS.has(name) && meta.sensitive) {
    if (args) args.paymentClassUpgrade = true;
    auth = "CONFIRM";
  }

  // 2. fill_form with any sensitive field → upgrade whole form.
  if (name === "fill_form" && meta.formHasSensitive) {
    if (args) args.paymentClassUpgrade = true;
    auth = "CONFIRM";
  }

  // 3. click on a submit-class target → CONFIRM.
  if (name === "click" && meta.submitClass) {
    if (args) args.submitClassUpgrade = true;
    auth = "CONFIRM";
  }

  // 4. navigate cross-origin → already CONFIRM, but tag the warning.
  if (name === "navigate" && args && args.crossOrigin === true) {
    args.crossOriginWarning = true;
    auth = "CONFIRM";
  }

  // 5. Mission-level batch-approval gate is enforced in the loop, not here;
  // surface a hint via ctx so escalation.js can render "approve all 3".
  if (ctx && ctx.recentConfirmCount && ctx.recentConfirmCount >= 5 && auth === "CONFIRM") {
    if (args) args.batchApprovalHint = true;
  }

  return auth;
}

// ---- Cross-context invoke -------------------------------------------

const DOM_TOOL_TIMEOUT_MS = 8000;
const SW_TOOL_TIMEOUT_MS = 15000;

// Per-tab pending calls (only used in the service-worker side).
// Map<tabId, Map<callId, {resolve, reject, timer}>>
const pendingCalls = new Map();
let callCounter = 0;

function nextCallId() {
  callCounter = (callCounter + 1) % 1e9;
  return `lyza_call_${Date.now().toString(36)}_${callCounter}`;
}

/**
 * Invoke a tool. Routes by descriptor.context.
 *
 *   - service_worker tools  → call ctx.localHandlers[name](args, ctx)
 *   - content_script tools  → chrome.tabs.sendMessage(ctx.tabId, ...)
 *
 * `ctx` must include:
 *   - `tabId`: number (for content-script tools)
 *   - `localHandlers`: object mapping tool name → async (args, ctx) => result
 *     (provided by service-worker.js so we don't import its private fns here)
 *
 * Returns whatever the handler / content script returns (typically
 *   { ok: true, ... } or { ok: false, code: "..." }).
 */
export async function invoke(name, args, ctx) {
  const desc = getToolDescriptor(name);
  if (!desc) return { ok: false, code: "UNKNOWN_TOOL", tool: name };
  ctx = ctx || {};
  args = args || {};

  if (desc.context === "service_worker") {
    const handlers = ctx.localHandlers || {};
    const fn = handlers[name];
    if (typeof fn !== "function") {
      return { ok: false, code: "NO_HANDLER", tool: name };
    }
    try {
      const p = Promise.resolve(fn(args, ctx));
      return await withTimeout(p, SW_TOOL_TIMEOUT_MS, name);
    } catch (e) {
      return { ok: false, code: "EXCEPTION", tool: name, error: String(e && e.message || e) };
    }
  }

  // content_script tools — send over chrome.tabs.sendMessage.
  if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.sendMessage) {
    return { ok: false, code: "NO_TABS_API", tool: name };
  }
  const tabId = ctx.tabId;
  if (typeof tabId !== "number") {
    return { ok: false, code: "NO_TAB_ID", tool: name };
  }

  const callId = nextCallId();
  if (!pendingCalls.has(tabId)) pendingCalls.set(tabId, new Map());
  const tabPending = pendingCalls.get(tabId);

  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      tabPending.delete(callId);
      resolve({ ok: false, code: "TIMEOUT", tool: name, callId });
    }, DOM_TOOL_TIMEOUT_MS);

    tabPending.set(callId, { resolve, timer });

    try {
      chrome.tabs.sendMessage(
        tabId,
        { type: "LYZA_TOOL_CALL", callId, tool: name, args },
        (response) => {
          // Synchronous-style response from the content script (if it uses
          // sendResponse instead of the routed LYZA_TOOL_RESULT). Accept both.
          const lastErr = chrome.runtime && chrome.runtime.lastError;
          const entry = tabPending.get(callId);
          if (!entry) return; // already resolved by LYZA_TOOL_RESULT
          if (lastErr) {
            clearTimeout(entry.timer);
            tabPending.delete(callId);
            return resolve({
              ok: false,
              code: "CHANNEL_ERROR",
              tool: name,
              error: String(lastErr.message || lastErr)
            });
          }
          if (response !== undefined) {
            clearTimeout(entry.timer);
            tabPending.delete(callId);
            return resolve(response);
          }
        }
      );
    } catch (e) {
      const entry = tabPending.get(callId);
      if (entry) {
        clearTimeout(entry.timer);
        tabPending.delete(callId);
      }
      resolve({ ok: false, code: "SEND_FAILED", tool: name, error: String(e) });
    }
  });
}

/**
 * Resolve a pending content-script call from a LYZA_TOOL_RESULT message.
 * The service-worker message router should call this when it receives:
 *   { type: "LYZA_TOOL_RESULT", callId, result }
 */
export function resolvePending(tabId, callId, result) {
  const tabPending = pendingCalls.get(tabId);
  if (!tabPending) return false;
  const entry = tabPending.get(callId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  tabPending.delete(callId);
  entry.resolve(result);
  return true;
}

/**
 * Cancel all pending calls for a tab (e.g. on tab close or STOP).
 */
export function cancelPending(tabId, reason) {
  const tabPending = pendingCalls.get(tabId);
  if (!tabPending) return 0;
  let n = 0;
  for (const [callId, entry] of tabPending.entries()) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, code: reason || "CANCELED", callId });
    n++;
  }
  pendingCalls.delete(tabId);
  return n;
}

function withTimeout(p, ms, name) {
  return new Promise((resolve) => {
    const t = setTimeout(
      () => resolve({ ok: false, code: "TIMEOUT", tool: name }),
      ms
    );
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); resolve({ ok: false, code: "EXCEPTION", tool: name, error: String(e && e.message || e) }); }
    );
  });
}

// ---- Compact catalog for the Planner prompt --------------------------

/**
 * Returns the YAML-like catalog block the Planner consumes in its system
 * prompt. Kept under ~600 tokens by being one line per tool.
 */
export function compactCatalogText() {
  const groups = [
    { title: "# Perception (AUTO, read-only)", names: ["read_page", "read_interactive_map", "recall_memory", "compute_baseline", "fx_convert"] },
    { title: "# Memory & private side effects", names: ["remember", "shortlist_add", "flag_scammer", "drive_save", "calendar_remind"] },
    { title: "# Drafting", names: ["draft_email"] },
    { title: "# Irreversible (always escalates)", names: ["send_email", "submit_form", "report_platform", "click_submit"] },
    { title: "# v5 — Annotation (AUTO, visible)", names: ["highlight", "annotate", "scroll_to", "inject_badge"] },
    { title: "# v5 — Manipulation", names: ["redact_warn", "fill_field", "set_select", "fill_form", "simulate_typing", "click", "clear_hands"] },
    { title: "# v5 — Navigation", names: ["open_tab", "navigate", "compare_tabs", "collect_across_tabs", "return_to"] },
    { title: "# Planner pseudo-tool", names: ["DECIDE"] }
  ];

  const lines = [];
  for (const g of groups) {
    lines.push(g.title);
    for (const name of g.names) {
      const t = TOOLS[name];
      if (!t) continue;
      const argHints = formatArgsHint(t.argsSchema);
      const left = `${name.padEnd(22, " ")} [${t.authority}]`.padEnd(36, " ");
      lines.push(`${left}${t.description}${argHints ? "  · args:" + argHints : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatArgsHint(schema) {
  if (!schema || typeof schema !== "object") return "";
  const keys = Object.keys(schema);
  if (!keys.length) return "()";
  return "(" + keys.join(", ") + ")";
}
