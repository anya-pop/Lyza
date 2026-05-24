// agent-hands.js — The agent's embodied hands + visible cursor.
// AUTO tools (reversible, visual): scroll_to, highlight, annotate, inject_badge.
// Provides the visible Lyza cursor, live status chip, STOP button.
// Respects prefers-reduced-motion. Badges are clamped to the viewport.
(function () {
  if (window.LyzaHands) return;
  const eyes = () => window.LyzaEyes;
  let halted = false;
  let cursorEl = null;
  let chipEl = null;
  let stopBtn = null;
  const injected = [];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ensureCursor() {
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement("div");
    cursorEl.className = "lyza-cursor";
    // Animated fox sprite is driven entirely by background-image in CSS.
    // No child content — the legacy "L" mark has been removed.
    document.documentElement.appendChild(cursorEl);
    return cursorEl;
  }
  function ensureChip() {
    if (chipEl) return chipEl;
    chipEl = document.createElement("div");
    chipEl.className = "lyza-statuschip";
    chipEl.setAttribute("role", "status");
    chipEl.setAttribute("aria-live", "polite");
    chipEl.innerHTML = `<span class="lyza-chip-dot"></span><span class="lyza-chip-text">Lyza is ready</span>`;
    document.documentElement.appendChild(chipEl);
    return chipEl;
  }
  function ensureStop() {
    if (stopBtn) return stopBtn;
    stopBtn = document.createElement("button");
    stopBtn.className = "lyza-stop";
    stopBtn.textContent = "■ Stop";
    stopBtn.setAttribute("aria-label", "Stop Lyza");
    stopBtn.addEventListener("click", () => halt());
    document.documentElement.appendChild(stopBtn);
    return stopBtn;
  }
  function setStatus(text) {
    ensureChip();
    const t = chipEl.querySelector(".lyza-chip-text");
    if (t) t.textContent = text;
  }
  function showControls() {
    ensureChip().classList.add("lyza-visible");
    ensureStop().classList.add("lyza-visible");
  }
  function hideControls() {
    if (chipEl) chipEl.classList.remove("lyza-visible");
    if (stopBtn) stopBtn.classList.remove("lyza-visible");
    if (cursorEl) cursorEl.classList.remove("lyza-visible");
  }
  function moveCursorTo(el) {
    return new Promise((resolve) => {
      const c = ensureCursor();
      c.classList.add("lyza-visible");
      // Swap to running sprite while traveling
      c.classList.add("lyza-cursor-running");
      c.classList.remove("lyza-cursor-celebrate");
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2 + window.scrollX;
      const y = r.top + r.height / 2 + window.scrollY;
      c.style.transform = `translate(${x}px, ${y}px)`;
      const travelMs = reduceMotion ? 0 : 520;
      setTimeout(() => {
        // Back to idle when settled
        if (cursorEl) cursorEl.classList.remove("lyza-cursor-running");
        resolve();
      }, travelMs);
    });
  }
  function celebrateCursor() {
    if (!cursorEl) ensureCursor();
    cursorEl.classList.remove("lyza-cursor-running");
    cursorEl.classList.add("lyza-cursor-celebrate");
    // Linger 2s then revert
    setTimeout(() => {
      if (cursorEl) cursorEl.classList.remove("lyza-cursor-celebrate");
    }, 2200);
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms)); }
  function checkHalt() { if (halted) throw new Error("LYZA_HALTED"); }
  async function focusElement(id) {
    const el = eyes().resolve(id);
    if (!el) return null;
    await moveCursorTo(el);
    return el;
  }

  async function scroll_to({ id }) {
    checkHalt();
    const el = eyes().resolve(id);
    if (!el) return { ok: false, reason: "not_found" };
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    await sleep(650);
    await moveCursorTo(el);
    return { ok: true };
  }

  async function highlight({ id, style = "info", reason = "" }) {
    checkHalt();
    const el = await focusElement(id);
    if (!el) return { ok: false, reason: "not_found" };
    const box = document.createElement("div");
    box.className = `lyza-highlight lyza-hl-${style}`;
    position(box, el);
    if (reason) {
      const tip = document.createElement("div");
      tip.className = "lyza-tip";
      tip.textContent = reason;
      box.appendChild(tip);
    }
    document.documentElement.appendChild(box);
    injected.push(box);
    trackReposition(box, el);
    await sleep(reduceMotion ? 0 : 300);
    return { ok: true };
  }

  async function annotate({ id, note }) {
    checkHalt();
    const el = await focusElement(id);
    if (!el) return { ok: false, reason: "not_found" };
    const bubble = document.createElement("div");
    bubble.className = "lyza-annotation";
    bubble.innerHTML = `<span class="lyza-annotation-mark">L</span><span></span>`;
    bubble.querySelector("span:last-child").textContent = note || "";
    const r = el.getBoundingClientRect();
    bubble.style.transform = `translate(${r.left + window.scrollX}px, ${r.bottom + window.scrollY + 6}px)`;
    document.documentElement.appendChild(bubble);
    injected.push(bubble);
    trackReposition(bubble, el, () => {
      const rr = el.getBoundingClientRect();
      bubble.style.transform = `translate(${rr.left + window.scrollX}px, ${rr.bottom + window.scrollY + 6}px)`;
    });
    await sleep(reduceMotion ? 0 : 200);
    return { ok: true };
  }

  async function inject_badge({ id, text, tone = "accent" }) {
    checkHalt();
    const el = await focusElement(id);
    if (!el) return { ok: false, reason: "not_found" };
    const badge = document.createElement("span");
    badge.className = `lyza-badge lyza-badge-${tone}`;
    badge.textContent = text;
    document.documentElement.appendChild(badge);
    injected.push(badge);
    const r = el.getBoundingClientRect();
    const bw = badge.offsetWidth || 160;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - bw - 12;
    let left = r.right + window.scrollX + 8;
    if (left > maxLeft) left = Math.max(window.scrollX + 12, maxLeft);
    badge.style.transform = `translate(${left}px, ${r.top + window.scrollY}px)`;
    trackReposition(badge, el, () => {
      const rr = el.getBoundingClientRect();
      const ml = window.scrollX + document.documentElement.clientWidth - badge.offsetWidth - 12;
      let l = rr.right + window.scrollX + 8;
      if (l > ml) l = Math.max(window.scrollX + 12, ml);
      badge.style.transform = `translate(${l}px, ${rr.top + window.scrollY}px)`;
    });
    await sleep(reduceMotion ? 0 : 180);
    return { ok: true };
  }

  function position(box, el) {
    const r = el.getBoundingClientRect();
    box.style.transform = `translate(${r.left + window.scrollX - 4}px, ${r.top + window.scrollY - 4}px)`;
    box.style.width = `${r.width + 8}px`;
    box.style.height = `${r.height + 8}px`;
  }
  const trackers = [];
  function trackReposition(box, el, customFn) {
    const fn = customFn || (() => position(box, el));
    window.addEventListener("scroll", fn, { passive: true });
    window.addEventListener("resize", fn, { passive: true });
    trackers.push(fn);
  }

  function begin() { halted = false; showControls(); }
  function halt() {
    halted = true;
    setStatus("Stopped");
    if (cursorEl) cursorEl.classList.remove("lyza-visible");
    // Cancel any in-flight TTS so STOP is instant.
    try { if (window.LyzaStopAudio) window.LyzaStopAudio(); } catch {}
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
  }
  function clear() {
    injected.forEach((n) => n.remove());
    injected.length = 0;
    trackers.forEach((fn) => {
      window.removeEventListener("scroll", fn);
      window.removeEventListener("resize", fn);
    });
    trackers.length = 0;
    hideControls();
  }

  window.LyzaHands = {
    begin, halt, clear, setStatus, celebrate: celebrateCursor,
    scroll_to, highlight, annotate, inject_badge,
    get halted() { return halted; }
  };
})();
