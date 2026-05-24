// agent-hands-write.js — NOTIFY/CONFIRM-class write hands for Lyza.
// Extends the AUTO hands in agent-hands.js with: fill_field, simulate_typing,
// set_select, click, fill_form, submit_form, clear_hands (+ patches LyzaHands).
//
// Conventions (mirrors agent-hands.js):
//   - Classic-script IIFE; attaches to window.LyzaHandsWrite and patches LyzaHands.
//   - Cursor moves before each action; halt-checked between subactions.
//   - All write tools return { ok: bool, code?: string, ... }.
//   - Sensitive fields (card/sin/password/...) are NEVER auto-filled — they
//     short-circuit so the planner can escalate to CONFIRM.
//   - Submit-class controls bail out of click() — planner must use submit_form.
(function () {
  if (window.LyzaHandsWrite) return;
  const eyes = () => window.LyzaEyes;
  const hands = () => window.LyzaHands;
  const reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const sleep = (ms) =>
    new Promise((r) => setTimeout(r, reduceMotion ? 0 : Math.max(0, ms)));

  function isHalted() {
    const h = hands();
    return !!(h && h.halted);
  }

  // ---- Sensitive-field detector -----------------------------------------

  // Curated multilingual stop-list for sensitive credentials and IDs.
  const SENSITIVE_PATTERNS = {
    card: /card|creditcard|ccnum|cardnumber|cc-?number|carte\s?(de)?\s?credit|tarjeta/i,
    cvv: /cvc|cvv|cvn|security[ -_]?code|cvc2|cvv2/i,
    sin: /\bsin\b|social[ -_]?insurance|n[uú]mero[ _-]?sin|aadhaar/i,
    ssn: /\bssn\b|social[ -_]?security/i,
    gov_id: /passport|drivers?[ -_]?licen[cs]e|gov(ernment)?[ -_]?id|\bnin\b|national[ -_]?id/i,
    password:
      /password|passwd|pwd|\bpin\b|mfa|otp|2fa|one[ -_]?time|contrase[nñ]a|mot[ -_]?de[ -_]?passe/i
  };

  function isSensitiveField(el) {
    if (!el) return { sensitive: false };

    // Direct type=password.
    if (el.type === "password") return { sensitive: true, kind: "password" };

    const haystack = [
      el.name || "",
      el.id || "",
      el.placeholder || "",
      el.autocomplete || "",
      el.getAttribute && (el.getAttribute("aria-label") || ""),
      el.getAttribute && (el.getAttribute("data-testid") || ""),
      el.getAttribute && (el.getAttribute("data-cy") || "")
    ]
      .join(" ")
      .toLowerCase();

    // Autocomplete tokens are authoritative when present.
    const ac = (el.autocomplete || "").toLowerCase();
    if (ac.startsWith("cc-")) {
      if (/cc-csc|cc-cvc|cc-cvv|cc-security/.test(ac))
        return { sensitive: true, kind: "cvv" };
      return { sensitive: true, kind: "card" };
    }
    if (ac === "current-password" || ac === "new-password")
      return { sensitive: true, kind: "password" };
    if (ac === "one-time-code") return { sensitive: true, kind: "password" };

    if (SENSITIVE_PATTERNS.card.test(haystack))
      return { sensitive: true, kind: "card" };
    if (SENSITIVE_PATTERNS.cvv.test(haystack))
      return { sensitive: true, kind: "cvv" };
    if (SENSITIVE_PATTERNS.sin.test(haystack))
      return { sensitive: true, kind: "sin" };
    if (SENSITIVE_PATTERNS.ssn.test(haystack))
      return { sensitive: true, kind: "ssn" };
    if (SENSITIVE_PATTERNS.gov_id.test(haystack))
      return { sensitive: true, kind: "gov_id" };
    if (SENSITIVE_PATTERNS.password.test(haystack))
      return { sensitive: true, kind: "password" };

    // Heuristic: inputmode=numeric + tiny maxlength → likely a CVV/OTP.
    const inputmode = (
      (el.getAttribute && el.getAttribute("inputmode")) ||
      ""
    ).toLowerCase();
    const maxlen = parseInt(el.getAttribute && el.getAttribute("maxlength"), 10);
    if (
      (inputmode === "numeric" || inputmode === "decimal") &&
      Number.isFinite(maxlen) &&
      maxlen > 0 &&
      maxlen <= 4
    ) {
      return { sensitive: true, kind: "cvv" };
    }

    return { sensitive: false };
  }

  // ---- Submit-class detector --------------------------------------------

  const SUBMIT_TEXT_RE =
    /submit|pay|confirm|send|sign\b|apply|enroll|place\s?order|complete|transfer|withdraw|checkout|purchase|buy\b|finaliz/i;

  function nearbyLabelText(el) {
    const bits = [];
    if (el.value) bits.push(String(el.value));
    if (el.textContent) bits.push(el.textContent);
    const al = el.getAttribute && el.getAttribute("aria-label");
    if (al) bits.push(al);
    const t = el.getAttribute && el.getAttribute("title");
    if (t) bits.push(t);
    // Wrapping <label>
    const lab = el.closest && el.closest("label");
    if (lab && lab.textContent) bits.push(lab.textContent);
    return bits.join(" ");
  }

  function isSubmitClass(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;

    // Explicit submit button.
    if (tag === "BUTTON" && (el.type === "submit" || !el.type)) {
      const form = el.form || (el.closest && el.closest("form"));
      if (form) return true;
      if (SUBMIT_TEXT_RE.test(nearbyLabelText(el))) return true;
    }
    if (tag === "INPUT" && /submit|image/i.test(el.type || "")) return true;
    if (tag === "INPUT" && /button/i.test(el.type || "")) {
      if (SUBMIT_TEXT_RE.test(nearbyLabelText(el))) return true;
    }

    // Cross-origin form action.
    const form = el.closest && el.closest("form");
    if (form && form.action) {
      try {
        const a = new URL(form.action, location.href);
        if (a.origin !== location.origin && tag === "BUTTON") return true;
      } catch (_) {
        /* ignore */
      }
    }

    // data-cy / data-testid hint.
    const dt = (
      (el.getAttribute && el.getAttribute("data-testid")) ||
      (el.getAttribute && el.getAttribute("data-cy")) ||
      ""
    ).toLowerCase();
    if (/submit|pay\b|checkout|confirm/.test(dt)) return true;

    // Class hint: <button class="submit ...">
    const cls = (
      (typeof el.className === "string" && el.className) ||
      ""
    ).toLowerCase();
    if (
      /\bsubmit\b|\bbtn-?submit\b|\bpay-?button\b|\bcheckout\b/.test(cls) &&
      (tag === "BUTTON" || tag === "INPUT" || tag === "A")
    ) {
      return true;
    }

    return false;
  }

  // ---- Native value setter (React/Vue compatibility) --------------------

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fire(el, type, init) {
    try {
      let ev;
      if (
        type === "input" ||
        type === "beforeinput" ||
        type === "change"
      ) {
        ev = new InputEvent(type, { bubbles: true, cancelable: true, ...(init || {}) });
      } else if (type === "keydown" || type === "keyup" || type === "keypress") {
        ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...(init || {}) });
      } else if (
        type === "mousedown" ||
        type === "mouseup" ||
        type === "click" ||
        type === "dblclick"
      ) {
        ev = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          ...(init || {})
        });
      } else {
        ev = new Event(type, { bubbles: true, cancelable: true });
      }
      el.dispatchEvent(ev);
    } catch (_) {
      // Older synthetic event fallback.
      try {
        const ev = document.createEvent("Event");
        ev.initEvent(type, true, true);
        el.dispatchEvent(ev);
      } catch (__) {
        /* ignore */
      }
    }
  }

  // ---- Levenshtein for fuzzy select option matching ---------------------

  function lev(a, b) {
    a = String(a || "").toLowerCase();
    b = String(b || "").toLowerCase();
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        dp[j] =
          a[i - 1] === b[j - 1]
            ? prev
            : 1 + Math.min(prev, dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    return dp[n];
  }

  // ---- Cursor + scroll helpers (delegate to LyzaHands where possible) ---

  async function approach(el) {
    const h = hands();
    if (!el) return;
    // Use scroll_to if element is offscreen and LyzaHands has it.
    const r = el.getBoundingClientRect();
    const offscreen =
      r.bottom < 0 ||
      r.top > (window.innerHeight || document.documentElement.clientHeight);
    if (offscreen) {
      el.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center"
      });
      await sleep(420);
    }
    // Move the visible cursor. LyzaHands exposes scroll_to which moves the
    // cursor as a side effect; calling it here is the cheapest reliable path.
    if (h && typeof h.scroll_to === "function" && el.getAttribute) {
      const id = el.getAttribute("data-lyza-id");
      if (id) {
        try {
          await h.scroll_to({ id });
        } catch (_) {
          /* ignore halt etc. */
        }
      }
    }
  }

  // ---- fill_field --------------------------------------------------------

  async function fill_field({ id, value, instant }) {
    if (isHalted()) return { ok: false, code: "ABORTED" };
    const el = eyes() && eyes().resolve(id);
    if (!el) return { ok: false, code: "NOT_FOUND" };

    const sens = isSensitiveField(el);
    if (sens.sensitive)
      return { ok: false, code: "BLOCKED_SENSITIVE", kind: sens.kind };

    await approach(el);
    if (isHalted()) return { ok: false, code: "ABORTED" };

    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      try { el.focus(); } catch (__) { /* ignore */ }
    }
    fire(el, "focus");
    fire(el, "focusin");

    const text = value == null ? "" : String(value);
    const goInstant = instant === true || reduceMotion;

    if (goInstant) {
      setNativeValue(el, text);
      fire(el, "input", { data: text, inputType: "insertFromPaste" });
      fire(el, "change");
    } else {
      // Clear current value first so typing produces the intended final text.
      if (el.value) {
        setNativeValue(el, "");
        fire(el, "input", { inputType: "deleteContentBackward" });
      }
      const res = await simulate_typing({ id, text });
      if (res && res.ok === false) {
        try { el.blur(); } catch (_) { /* ignore */ }
        return res;
      }
    }

    fire(el, "change");
    fire(el, "blur");
    fire(el, "focusout");
    try { el.blur(); } catch (_) { /* ignore */ }

    return { ok: true, value: text };
  }

  // ---- simulate_typing ---------------------------------------------------

  async function simulate_typing({ id, text, cadenceMs, jitter }) {
    if (isHalted()) return { ok: false, code: "ABORTED" };
    const el = eyes() && eyes().resolve(id);
    if (!el) return { ok: false, code: "NOT_FOUND" };

    const cad = Number.isFinite(cadenceMs) ? cadenceMs : 32;
    const jit = Number.isFinite(jitter) ? jitter : 0.5;
    const str = text == null ? "" : String(text);

    // Make sure the field is focused so keyboard events have a target.
    try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ }

    let current = el.value == null ? "" : String(el.value);
    for (let i = 0; i < str.length; i++) {
      if (isHalted()) return { ok: false, code: "ABORTED", chars: i };
      const ch = str[i];
      const delay = Math.max(0, cad + (Math.random() * 2 - 1) * cad * jit);

      fire(el, "keydown", { key: ch });
      fire(el, "beforeinput", { data: ch, inputType: "insertText" });
      current += ch;
      setNativeValue(el, current);
      fire(el, "input", { data: ch, inputType: "insertText" });
      fire(el, "keyup", { key: ch });

      await sleep(delay);
    }
    return { ok: true, chars: str.length };
  }

  // ---- set_select --------------------------------------------------------

  function findSelectMatch(selectEl, target) {
    const want = String(target == null ? "" : target);
    const wantLc = want.trim().toLowerCase();
    const opts = Array.from(selectEl.options || []);
    // Exact value.
    let m = opts.find((o) => o.value === want);
    if (m) return m;
    // Exact textContent.
    m = opts.find((o) => (o.textContent || "").trim() === want);
    if (m) return m;
    // Case-insensitive trimmed.
    m = opts.find((o) => (o.textContent || "").trim().toLowerCase() === wantLc);
    if (m) return m;
    m = opts.find((o) => String(o.value).toLowerCase() === wantLc);
    if (m) return m;
    // Fuzzy: levenshtein <= 2 on either value or text.
    let best = null;
    let bestD = 3;
    for (const o of opts) {
      const dv = lev(o.value, want);
      const dt = lev((o.textContent || "").trim(), want);
      const d = Math.min(dv, dt);
      if (d < bestD) { bestD = d; best = o; }
    }
    return bestD <= 2 ? best : null;
  }

  async function set_select({ id, option }) {
    if (isHalted()) return { ok: false, code: "ABORTED" };
    const el = eyes() && eyes().resolve(id);
    if (!el) return { ok: false, code: "NOT_FOUND" };

    const sens = isSensitiveField(el);
    if (sens.sensitive)
      return { ok: false, code: "BLOCKED_SENSITIVE", kind: sens.kind };

    await approach(el);
    if (isHalted()) return { ok: false, code: "ABORTED" };

    // Native <select>.
    if (el.tagName === "SELECT") {
      const match = findSelectMatch(el, option);
      if (!match) return { ok: false, code: "NO_MATCH" };
      try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      fire(el, "focus");
      setNativeValue(el, match.value);
      fire(el, "input");
      fire(el, "change");
      fire(el, "blur");
      return { ok: true, selectedValue: match.value, selectedLabel: (match.textContent || "").trim() };
    }

    // ARIA combobox / custom dropdown.
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    if (role === "combobox" || role === "listbox" || el.getAttribute && el.getAttribute("aria-haspopup")) {
      // Open the dropdown.
      fire(el, "mousedown");
      fire(el, "mouseup");
      fire(el, "click");

      // Wait briefly for the listbox to render.
      const want = String(option == null ? "" : option).trim().toLowerCase();
      const found = await new Promise((resolve) => {
        const deadline = Date.now() + 400;
        function findOption() {
          // Look across the document for a freshly-rendered listbox option.
          const candidates = document.querySelectorAll(
            "[role='option'], li[data-value], li[role='option'], [data-option-value]"
          );
          for (const c of candidates) {
            const txt = (c.textContent || "").trim().toLowerCase();
            const al = ((c.getAttribute && c.getAttribute("aria-label")) || "").toLowerCase();
            if (txt === want || al === want) return c;
          }
          // Fuzzy second pass.
          for (const c of candidates) {
            const txt = (c.textContent || "").trim().toLowerCase();
            if (txt && (txt.includes(want) || want.includes(txt))) return c;
          }
          return null;
        }
        const tryFind = () => {
          const f = findOption();
          if (f) return resolve(f);
          if (Date.now() > deadline) return resolve(null);
          requestAnimationFrame(tryFind);
        };
        const mo = new MutationObserver(() => {
          const f = findOption();
          if (f) { mo.disconnect(); resolve(f); }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        // Also poll via rAF in case the listbox already exists.
        tryFind();
        setTimeout(() => { mo.disconnect(); }, 420);
      });

      if (!found) return { ok: false, code: "CUSTOM_SELECT_UNRESOLVABLE" };
      fire(found, "mousedown");
      fire(found, "mouseup");
      fire(found, "click");
      return { ok: true, selectedLabel: (found.textContent || "").trim() };
    }

    return { ok: false, code: "CUSTOM_SELECT_UNRESOLVABLE" };
  }

  // ---- click -------------------------------------------------------------

  async function click({ id }) {
    if (isHalted()) return { ok: false, code: "ABORTED" };
    const el = eyes() && eyes().resolve(id);
    if (!el) return { ok: false, code: "NOT_FOUND" };

    if (isSubmitClass(el))
      return { ok: false, code: "BLOCKED_SUBMIT_CLASS" };

    await approach(el);
    if (isHalted()) return { ok: false, code: "ABORTED" };

    fire(el, "mousedown");
    fire(el, "mouseup");
    fire(el, "click");
    return { ok: true };
  }

  // ---- fill_form ---------------------------------------------------------

  function detectRole(el) {
    const tag = el.tagName;
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA") return "textarea";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "input";
    }
    if (el.isContentEditable) return "contenteditable";
    return "other";
  }

  async function fill_form({ formMap, leaveBlank }) {
    if (isHalted()) return { ok: false, code: "ABORTED" };
    const skip = new Set(leaveBlank || []);
    const entries = Object.entries(formMap || {});

    // Resolve everything up front and sort by document order (top of bbox).
    const resolved = [];
    for (const [eid, value] of entries) {
      const el = eyes() && eyes().resolve(eid);
      if (!el) { resolved.push({ id: eid, el: null, value, top: Infinity }); continue; }
      const r = el.getBoundingClientRect();
      resolved.push({ id: eid, el, value, top: r.top + window.scrollY });
    }
    resolved.sort((a, b) => a.top - b.top);

    const filled = [];
    const flagged = [];
    let firstForm = null;

    for (const item of resolved) {
      if (isHalted()) return { ok: false, code: "ABORTED", filled, flagged };
      const { id: eid, el, value } = item;
      if (!el) { flagged.push({ id: eid, reason: "not_found" }); continue; }

      const sens = isSensitiveField(el);
      const planned = skip.has(eid) || sens.sensitive;

      if (!firstForm && el.form) firstForm = el.form;
      else if (!firstForm && el.closest) firstForm = el.closest("form");

      if (planned) {
        const reason = sens.sensitive
          ? `Lyza won't auto-fill this (${sens.kind}) — type it yourself.`
          : "Left blank on purpose — type it yourself.";
        flagged.push({
          id: eid,
          kind: sens.kind || "user_blank",
          reason
        });
        // Best-effort: highlight as a warn so the user sees what to fill.
        const h = hands();
        if (h && typeof h.highlight === "function") {
          try { await h.highlight({ id: eid, style: "warn", reason }); }
          catch (_) { /* ignore */ }
        }
        continue;
      }

      const role = detectRole(el);
      let result;
      try {
        if (role === "select") {
          result = await set_select({ id: eid, option: value });
        } else if (role === "checkbox" || role === "radio") {
          const want = !!value && value !== "false" && value !== "0";
          if (want && !el.checked) result = await click({ id: eid });
          else if (!want && el.checked && role === "checkbox") result = await click({ id: eid });
          else result = { ok: true, code: "ALREADY_SET" };
        } else if (role === "contenteditable") {
          await approach(el);
          el.focus();
          el.textContent = value == null ? "" : String(value);
          fire(el, "input");
          fire(el, "change");
          result = { ok: true };
        } else {
          result = await fill_field({ id: eid, value });
        }
      } catch (e) {
        result = { ok: false, code: "EXCEPTION", error: String(e && e.message || e) };
      }

      if (result && result.ok) {
        filled.push({ id: eid, role });
      } else {
        flagged.push({
          id: eid,
          reason: (result && result.code) || "unknown_failure",
          kind: (result && result.kind) || undefined
        });
      }
    }

    // Locate the submit element so the planner can issue a CONFIRM submit_form.
    let submitElementId = null;
    if (firstForm) {
      const btn =
        firstForm.querySelector('button[type="submit"]') ||
        firstForm.querySelector('input[type="submit"]') ||
        firstForm.querySelector("button.submit, .lyza-submit, [data-action='submit']") ||
        firstForm.querySelector("button");
      if (btn) {
        submitElementId =
          btn.getAttribute("data-lyza-id") || null;
      }
    }

    return { ok: true, filled, flagged, submitElementId };
  }

  // ---- submit_form -------------------------------------------------------

  async function submit_form({ formId, id }) {
    if (isHalted()) return { ok: false, code: "ABORTED" };

    // Resolve a target button:
    //   1. If id is provided, use it (CONFIRM-class control).
    //   2. Else, find the form by formId (or active form containing focus).
    //   3. Then find its submit-class child.
    let btn = null;
    if (id) {
      const el = eyes() && eyes().resolve(id);
      if (!el) return { ok: false, code: "NOT_FOUND" };
      btn = el;
    } else {
      let form = null;
      if (formId) {
        form = document.getElementById(formId) || document.querySelector(`form[name="${formId}"]`);
      }
      if (!form) {
        // Find a form that contains a field with a data-lyza-id we've touched recently.
        const focused = document.activeElement;
        if (focused && focused.closest) form = focused.closest("form");
      }
      if (!form) form = document.querySelector("form");
      if (!form) return { ok: false, code: "NO_FORM" };

      btn =
        form.querySelector('button[type="submit"]') ||
        form.querySelector('input[type="submit"]') ||
        form.querySelector("button.submit, [data-action='submit']") ||
        form.querySelector("button");

      if (!btn) {
        // Last-ditch: dispatch submit on the form itself.
        try {
          fire(form, "submit");
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
          return { ok: true, code: "FORM_SUBMITTED_DIRECT" };
        } catch (e) {
          return { ok: false, code: "SUBMIT_FAILED", error: String(e) };
        }
      }
    }

    await approach(btn);
    if (isHalted()) return { ok: false, code: "ABORTED" };
    fire(btn, "mousedown");
    fire(btn, "mouseup");
    fire(btn, "click");
    return { ok: true };
  }

  // ---- clear_hands -------------------------------------------------------

  async function clear_hands({ kinds, reason } = {}) {
    const h = hands();
    if (h && typeof h.clear === "function") {
      try {
        h.clear();
      } catch (_) {
        /* ignore */
      }
    }

    // Per-kind sweep for any escaped artifacts (defensive — main clear() covers
    // the in-memory `injected` set, but if scripts inject manually we still
    // tidy up the DOM by class name).
    const wanted = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
    const sweepMap = {
      highlight: ".lyza-highlight",
      annotation: ".lyza-annotation",
      badge: ".lyza-badge",
      tip: ".lyza-tip",
      redact: ".lyza-redact"
    };
    for (const [kind, sel] of Object.entries(sweepMap)) {
      if (wanted && !wanted.has(kind)) continue;
      document.querySelectorAll(sel).forEach((n) => n.remove());
    }

    return { ok: true, reason: reason || null };
  }

  // ---- Export + patch ----------------------------------------------------

  const exported = {
    fill_field,
    simulate_typing,
    set_select,
    click,
    fill_form,
    submit_form,
    clear_hands,
    // Helpers (useful for the planner / service worker side):
    isSensitiveField,
    isSubmitClass,
    setNativeValue
  };

  if (window.LyzaHands) {
    // Patch the public registry so guided-walkthrough.js + the loop can
    // dispatch write tools through LyzaHands[stepTool] like AUTO tools.
    Object.assign(window.LyzaHands, {
      fill_field,
      simulate_typing,
      set_select,
      click,
      fill_form,
      submit_form,
      clear_hands
    });
  }

  window.LyzaHandsWrite = exported;
})();
