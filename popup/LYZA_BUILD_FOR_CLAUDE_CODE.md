# LYZA v5 — Build Document for Claude Code

> **What this is:** the single, complete build plan for Lyza, an *embodied financial-guardian
> browser agent* for newcomers. It contains the current state of the codebase, the **already-built
> and tested** embodied-agent core (verbatim, working code), and the remaining work to finish a
> hackathon-winning product. Build the remaining tasks in the order given. After each, load the
> extension in `chrome://extensions` and confirm no console errors.
>
> **Audience:** Claude Code. Treat the "ALREADY BUILT & TESTED" sections as ground truth — do not
> rewrite them; integrate and extend them.

---

## 0. The product in one paragraph

Lyza is a Chrome extension (Manifest V3) that acts as an autonomous financial guardian for
newcomers to a country. You delegate a goal ("find a safe 1-bed under $1,900"); Lyza watches the
pages you browse, runs a rigorous scam/price analysis, and **physically operates the page** —
scrolling, highlighting risky clauses, injecting home-currency price badges, filling forms — while
narrating in your language via voice. It decides and acts on reversible things autonomously, and
only stops you to approve irreversible actions (sending an email, submitting a form, paying). It
uses connected Gmail / Calendar / Drive to take real-world actions, and keeps a persistent memory
of everything financial it has seen.

This wins the three judging criteria: **real problem** (newcomer fraud/overpaying), **creative &
magical** (the page operates itself, in your language, by voice), and **AI agents** (plans, acts
across pages and apps, decides with an authority model, runs workflows no chatbot can).

---

## 1. Architecture overview

```
Chrome Extension (Manifest V3)
├── manifest.json
├── config.js                    profile schema, currencies, languages, defaults
│
├── popup/                       always-on profile + API keys + (new) Mission Control
│   ├── popup.html / .css / .js
│
├── content/                     the in-page panel + chat (already built)
│   ├── content.js
│   └── overlay.css
│
├── agent/                       ⭐ THE EMBODIED AGENT (core differentiator)
│   ├── agent-eyes.js            perception: tag DOM, build element map  [BUILT & TESTED]
│   ├── agent-hands.js           AUTO actions + visible cursor + STOP    [BUILT & TESTED]
│   ├── guided-walkthrough.js    tour orchestrator + local planner       [BUILT & TESTED]
│   ├── agent-overlay.css        cursor/highlight/badge/chip styles       [BUILT & TESTED]
│   ├── agent-hands-write.js     (NEW) NOTIFY/CONFIRM hands: fill, click, submit
│   ├── tools.js                 (NEW) tool registry + authority model
│   ├── loop.js                  (NEW) PLAN·ACT·OBSERVE·REFLECT executor
│   ├── planner.js               (NEW) LLM goal→plan
│   ├── missions.js              (NEW) standing-goal state
│   └── memory.js                (NEW) persistent financial memory
│
├── background/                  service worker
│   ├── service-worker.js        Anthropic call + (new) connectors, TTS, FX, fraud fusion
│   └── fraud-engine.js          (NEW) 3-layer scam detection
│
├── demo/                        self-contained demo (no install needed) [BUILT & TESTED]
│   ├── agent-demo.html          loads agent scripts, runs walkthrough
│   └── test-listing.html        fake scammy rental for testing
└── icons/
```

### The mental model
- **Eyes** perceive the page as a map of `el_N` ids.
- **Hands** operate those ids (reversible = AUTO, fills = NOTIFY, irreversible = CONFIRM).
- **Brain** (loop + planner + fraud engine + memory) decides what to do.
- **Voice** (ElevenLabs) narrates.
- **Connectors** (Gmail/Calendar/Drive) take real-world actions.

### The authority model (governs all actions — non-negotiable)
| Authority | Meaning | Examples | User approval? |
|---|---|---|---|
| `AUTO` | reversible, visual, private | highlight, scroll, badge, annotate, draft (not send), log to memory | No |
| `NOTIFY` | acts, reversible, worth flagging | fill a field, open a tab, set a reminder, shortlist | No, passive toast |
| `CONFIRM` | irreversible / external | send email, submit form, navigate away, report, pay | **Yes — approval card** |

Pitch line: *"Lyza does everything reversible on its own and only stops you before something it
can't take back."*

---

## 2. ✅ ALREADY BUILT & TESTED — the embodied core (DO NOT REWRITE)

This is the hardest, most impressive piece. It runs end-to-end in a real browser. A Playwright
test verified: scripts load, the element map builds (detecting price/clause/seller-message), the
visible cursor moves, badges/highlights/annotations inject and position correctly, narration fires,
**STOP halts the loop**, and **clear() removes everything** — with zero console errors.

**How to verify it yourself:** open `demo/agent-demo.html` in Chrome (no install, no API key) and
click "▶ Start guided walkthrough". The page scrolls itself, a home-currency badge appears beside
the price, the scam clause outlines in red with a tooltip, good terms in green, the scammer message
in amber, and a final Lyza recommendation annotation — all narrated.

### 2.1 `agent/agent-eyes.js` — perception (BUILT)

Tags interactive + important elements with `data-lyza-id="el_N"` and returns a compact map the LLM
targets by id (never raw selectors). Key API: `window.LyzaEyes.buildMap()`, `.resolve(id)`,
`.refresh()`, `.getElementText(id)`.

```javascript
// agent-eyes.js — The agent's perception layer.
(function () {
  if (window.LyzaEyes) return;
  const ID_ATTR = "data-lyza-id";
  let counter = 0;
  const INTERACTIVE = "a[href], button, input, select, textarea, [role='button'], [onclick]";
  const PRICE_RE = /(?:CA?\$|US?\$|€|£|₹|¥|₱|R\$|₦|₨|₩|₫)\s?\d[\d.,]*/;

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }
  function roleOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || el.getAttribute("role") === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (tag === "input") return el.type || "input";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "li") return "listitem";
    if (tag === "p" || tag === "div") return "text";
    return tag;
  }
  function labelOf(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    const aria = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name");
    if (aria) return aria.trim();
    const parentLabel = el.closest("label");
    if (parentLabel) {
      const t = parentLabel.textContent.replace(el.value || "", "").trim();
      if (t) return t;
    }
    const txt = (el.textContent || "").trim();
    if (txt) return txt.slice(0, 80);
    return "";
  }
  function tag(el) {
    let id = el.getAttribute(ID_ATTR);
    if (!id) { id = "el_" + ++counter; el.setAttribute(ID_ATTR, id); }
    return id;
  }
  function shortText(el) {
    return (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
  }
  function selectorHint(el) {
    if (el.id) return "#" + el.id;
    const cls = (el.className && typeof el.className === "string")
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + cls;
  }
  function collectInteractive() {
    const out = [];
    document.querySelectorAll(INTERACTIVE).forEach((el) => {
      if (!isVisible(el)) return;
      if (el.closest("#lyza-panel, #lyza-fab, .lyza-cursor, .lyza-statuschip")) return;
      const id = tag(el);
      const r = el.getBoundingClientRect();
      out.push({ id, role: roleOf(el), label: labelOf(el), selectorHint: selectorHint(el),
        value: "value" in el ? el.value : "", text: shortText(el),
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } });
    });
    return out;
  }
  function collectContent() {
    const out = [];
    const candidates = document.querySelectorAll(
      "h1, h2, h3, p, li, .clause, [class*='clause'], [class*='msg'], [class*='message'], [id*='message'], [class*='price'], [id*='price']");
    candidates.forEach((el) => {
      if (!isVisible(el)) return;
      if (el.closest("#lyza-panel, #lyza-fab, .lyza-cursor")) return;
      const text = shortText(el);
      if (!text || text.length < 3) return;
      const isPrice = PRICE_RE.test(text);
      const isHeading = /^h[1-3]$/.test(el.tagName.toLowerCase());
      const isListItem = el.tagName.toLowerCase() === "li";
      if (!isPrice && !isHeading && !isListItem && text.length < 30) return;
      const id = tag(el);
      const r = el.getBoundingClientRect();
      out.push({ id, role: isPrice ? "price" : roleOf(el),
        label: isPrice ? "price" : (isHeading ? "heading" : "content"),
        selectorHint: selectorHint(el), value: "", text,
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } });
    });
    return out;
  }
  function buildMap() {
    const seen = new Set(); const merged = [];
    [...collectContent(), ...collectInteractive()].forEach((entry) => {
      if (seen.has(entry.id)) return; seen.add(entry.id); merged.push(entry);
    });
    return merged;
  }
  function resolve(id) { return document.querySelector(`[${ID_ATTR}="${id}"]`); }
  function getElementText(id) { const el = resolve(id); return el ? shortText(el) : ""; }
  function refresh() { return buildMap(); }
  window.LyzaEyes = { buildMap, resolve, refresh, getElementText, ID_ATTR };
})();
```

### 2.2 `agent/agent-hands.js` — AUTO hands + cursor + STOP (BUILT)

Implements the visible Lyza cursor (animates to each element), the live status chip, the STOP
button (halts instantly), and the AUTO actions `scroll_to`, `highlight`, `annotate`, `inject_badge`.
Plus lifecycle `begin()`, `halt()`, `clear()`, `setStatus()`. Respects `prefers-reduced-motion`.
Badges are clamped to the viewport so they never overflow.

```javascript
// agent-hands.js — The agent's embodied hands + visible cursor.
(function () {
  if (window.LyzaHands) return;
  const eyes = () => window.LyzaEyes;
  let halted = false, cursorEl = null, chipEl = null, stopBtn = null;
  const injected = [];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ensureCursor() {
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement("div");
    cursorEl.className = "lyza-cursor";
    cursorEl.innerHTML = `<span class="lyza-cursor-mark">L</span>`;
    document.documentElement.appendChild(cursorEl);
    return cursorEl;
  }
  function ensureChip() {
    if (chipEl) return chipEl;
    chipEl = document.createElement("div");
    chipEl.className = "lyza-statuschip";
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
  function setStatus(text) { ensureChip(); const t = chipEl.querySelector(".lyza-chip-text"); if (t) t.textContent = text; }
  function showControls() { ensureChip().classList.add("lyza-visible"); ensureStop().classList.add("lyza-visible"); }
  function hideControls() {
    if (chipEl) chipEl.classList.remove("lyza-visible");
    if (stopBtn) stopBtn.classList.remove("lyza-visible");
    if (cursorEl) cursorEl.classList.remove("lyza-visible");
  }
  function moveCursorTo(el) {
    return new Promise((resolve) => {
      ensureCursor().classList.add("lyza-visible");
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2 + window.scrollX;
      const y = r.top + r.height / 2 + window.scrollY;
      cursorEl.style.transform = `translate(${x}px, ${y}px)`;
      setTimeout(resolve, reduceMotion ? 0 : 520);
    });
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms)); }
  function checkHalt() { if (halted) throw new Error("LYZA_HALTED"); }
  async function focusElement(id) { const el = eyes().resolve(id); if (!el) return null; await moveCursorTo(el); return el; }

  async function scroll_to({ id }) {
    checkHalt();
    const el = eyes().resolve(id);
    if (!el) return { ok: false, reason: "not_found" };
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    await sleep(650); await moveCursorTo(el);
    return { ok: true };
  }
  async function highlight({ id, style = "info", reason = "" }) {
    checkHalt();
    const el = await focusElement(id);
    if (!el) return { ok: false, reason: "not_found" };
    const box = document.createElement("div");
    box.className = `lyza-highlight lyza-hl-${style}`;
    position(box, el);
    if (reason) { const tip = document.createElement("div"); tip.className = "lyza-tip"; tip.textContent = reason; box.appendChild(tip); }
    document.documentElement.appendChild(box); injected.push(box);
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
    bubble.innerHTML = `<span class="lyza-annotation-mark">L</span><span>${escapeHtml(note)}</span>`;
    const r = el.getBoundingClientRect();
    bubble.style.transform = `translate(${r.left + window.scrollX}px, ${r.bottom + window.scrollY + 6}px)`;
    document.documentElement.appendChild(bubble); injected.push(bubble);
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
    document.documentElement.appendChild(badge); injected.push(badge);
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
    box.style.width = `${r.width + 8}px`; box.style.height = `${r.height + 8}px`;
  }
  const trackers = [];
  function trackReposition(box, el, customFn) {
    const fn = customFn || (() => position(box, el));
    window.addEventListener("scroll", fn, { passive: true });
    window.addEventListener("resize", fn, { passive: true });
    trackers.push(fn);
  }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function begin() { halted = false; showControls(); }
  function halt() { halted = true; setStatus("Stopped"); if (cursorEl) cursorEl.classList.remove("lyza-visible"); }
  function clear() {
    injected.forEach((n) => n.remove()); injected.length = 0;
    trackers.forEach((fn) => { window.removeEventListener("scroll", fn); window.removeEventListener("resize", fn); });
    trackers.length = 0; hideControls();
  }
  window.LyzaHands = { begin, halt, clear, setStatus, scroll_to, highlight, annotate, inject_badge, get halted() { return halted; } };
})();
```

### 2.3 `agent/guided-walkthrough.js` — tour orchestrator + local planner (BUILT)

`run(plan, { onNarrate })` executes a step array through the hands, updating the status chip and
calling `onNarrate(text)` per step (wire this to TTS later). `buildDemoPlan()` inspects the page
map and produces a sensible tour with **zero backend** — useful as a fallback and for the demo.

A **step** is `{ tool, args, say, status, pause }`. In production the planner returns these steps;
the demo planner generates them locally.

```javascript
// guided-walkthrough.js — Orchestrates the embodied guided tour.
(function () {
  if (window.LyzaWalkthrough) return;
  const eyes = () => window.LyzaEyes;
  const hands = () => window.LyzaHands;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function run(plan, opts = {}) {
    const onNarrate = opts.onNarrate || (() => {});
    const h = hands(); h.begin();
    try {
      for (let i = 0; i < plan.length; i++) {
        if (h.halted) break;
        const step = plan[i];
        h.setStatus(step.status || `Step ${i + 1} of ${plan.length}`);
        if (step.say) onNarrate(step.say);
        const fn = h[step.tool];
        if (typeof fn === "function") await fn(step.args || {});
        await sleep(step.pause != null ? step.pause : 900);
      }
      if (!h.halted) h.setStatus("Walkthrough complete");
    } catch (e) {
      if (String(e.message).includes("LYZA_HALTED")) h.setStatus("Stopped");
      else { console.error("[Lyza] walkthrough error", e); h.setStatus("Something went wrong"); }
    }
    return { halted: h.halted };
  }
  function findByText(map, re) { return map.filter((e) => re.test(e.text || "")); }
  function buildDemoPlan(opts = {}) {
    const homeBadge = opts.homeBadge || "≈ ₹148,000 / month · live rate";
    const map = eyes().buildMap(); const steps = [];
    const price = map.find((e) => e.role === "price") || findByText(map, /(?:CA\$|\$)\s?\d/)[0];
    if (price) {
      steps.push({ tool: "scroll_to", args: { id: price.id }, say: "Let's look at this listing together. Here's the monthly rent.", status: "Reading the price", pause: 700 });
      steps.push({ tool: "inject_badge", args: { id: price.id, text: homeBadge, tone: "accent" }, say: "In your home currency that's about 148,000 rupees per month.", status: "Converting the price", pause: 1100 });
    }
    const clause = map.find((e) => /non-refundable|retained by the landlord|before any viewing/i.test(e.text || "")) ||
      map.find((e) => /deposit/i.test(e.text || "") && (e.text || "").length > 60);
    if (clause) steps.push({ tool: "highlight", args: { id: clause.id, style: "danger", reason: "Demanding a non-refundable deposit before any viewing is a classic rental scam pattern." }, say: "But watch this clause. It asks for a non-refundable deposit before you can even see the apartment. That is a major red flag.", status: "Found a risky clause", pause: 1400 });
    const sellerMsg = map.find((e) => /working abroad|cannot show|mail you the keys|e-?transfer today/i.test(e.text || ""));
    if (sellerMsg) steps.push({ tool: "highlight", args: { id: sellerMsg.id, style: "warn", reason: "“I'm abroad, send money first, agent mails keys” is one of the most common rental-scam scripts." }, say: "The landlord's message says they're abroad and want money before showing the place. Scammers use this story constantly.", status: "Screening the message", pause: 1400 });
    const good = map.find((e) => /utilities included/i.test(e.text || "")) || map.find((e) => /furnished|available immediately/i.test(e.text || ""));
    if (good) steps.push({ tool: "highlight", args: { id: good.id, style: "good", reason: "This part is genuinely a good term — utilities included saves you money each month." }, say: "To be fair, some terms are good — utilities are included, which saves you money.", status: "Noting the good parts", pause: 1200 });
    if (price) steps.push({ tool: "annotate", args: { id: price.id, note: "My take: high risk. Do not send any deposit before viewing in person." }, say: "My recommendation: this listing is high risk. Never send a deposit before seeing the place in person.", status: "Final recommendation", pause: 1000 });
    return steps;
  }
  window.LyzaWalkthrough = { run, buildDemoPlan };
})();
```

### 2.4 `agent/agent-overlay.css` — visual styles (BUILT)

Styles the cursor (teal "L" with pulsing halo), highlights (danger/warn/good/info with tooltips),
floating price badges, annotation bubbles, the bottom-left status chip, and the STOP button. Brand:
deep teal `#0c4a44` / `#15786f`, warm sand `#fbf7ef`, rust `#d97742`. Fully namespaced `.lyza-*`,
pinned to `documentElement`, honors `prefers-reduced-motion`. (Use the file as-is from the repo;
~205 lines. Reproduced in the repo ZIP.)

### 2.5 The demo harness (BUILT) — `demo/agent-demo.html` + `demo/test-listing.html`

`test-listing.html` is a realistic fake scammy rental (price, good terms, a non-refundable-deposit
trap clause, and an "I'm abroad, e-transfer now" landlord message). `agent-demo.html` loads the
three agent scripts + CSS and adds a "▶ Start guided walkthrough" button and a narration banner, so
the whole embodied experience runs **without installing the extension or any API key**. Keep these
for the live demo.

### 2.6 Verified test (reference)

A Playwright run confirmed all of the above. Results: map size 12, price/clause/seller-message all
detected, 6 plan steps (scroll, badge, 3 highlights, annotate), cursor visible, badge clamped in
viewport, 3 highlights + 3 tooltips, 1 annotation, 6 narrations, final status "Walkthrough
complete", STOP halts, clear() removes everything, no console errors. You may re-create this test
with Playwright pointing at `demo/agent-demo.html` if you want a regression guard.

---

## 3. 🔨 REMAINING WORK (build in this order)

Each task says exactly how to integrate with the tested core above. Keep the authority model and the
`{ tool, args, say, status, pause }` step shape consistent throughout.

### TASK A — Fraud engine (`background/fraud-engine.js`)  [the credibility floor]

3-layer hybrid scam detection. The decisions the agent acts on must be rigorous.

**Layer 1 — deterministic URL/domain heuristics (instant, offline).** Implement each as
`{ triggered, weight, label }`; sum into a 0–100 score:
- IP-address host (`/^\d{1,3}(\.\d{1,3}){3}$/`) → 25
- `@` in URL → 20
- Punycode host (`xn--`) → 22
- Homoglyph chars in host (Cyrillic/Greek lookalikes map) → 24
- Suspicious TLD (`xyz top tk ml cf gq click xyz icu sbs cyou …`) → 14
- ≥3 subdomains → 12
- Phishy host words (`secure account verify login update banking …`) → 8
- No HTTPS → 10
- Typosquatting vs a `KNOWN_BRANDS` list using Levenshtein distance 1–2 (close but not exact) → 26
- URL length > 90 → 6

**Layer 2 — live signals (async, cache 1h in `chrome.storage.session`).**
- Google Safe Browsing v4 `threatMatches:find` (optional key `lyza_safebrowsing_key`); a hit → weight 60, forces HIGH.
- Domain age via keyless RDAP `https://rdap.org/domain/{host}`: parse the `registration` event;
  <30 days → 30, <90 days → 18.

**Layer 3 — LLM content reasoning.** The existing Claude call returns
`contentScamSignals: { score, reasons[] }` (urgency, off-platform/e-transfer demands, "I'm abroad",
overpayment, document requests).

**Fuse (max-aware):**
```js
function fuseRisk(urlScore, safeB, age, contentScore) {
  let base = urlScore + safeB.weight + age.weight;
  const blended = Math.round(base * 0.6 + contentScore * 0.4);
  let final = safeB.listed ? Math.max(blended, 85) : Math.min(blended, 100);
  final = Math.max(0, Math.min(100, final));
  const level = final >= 66 ? "high" : final >= 33 ? "medium" : "low";
  return { score: final, level };
}
```
Return `scamRisk: { level, score, reasons[], breakdown: { urlHeuristics, blocklist, domainAgeDays, contentScore } }` so the UI is explainable.

### TASK B — Memory (`agent/memory.js`)  [makes it an agent, not a tool]

Persistent financial memory in `chrome.storage.local` under `lyza_memory` (cap ~50 records):
`{ ts, kind, host, title, url, priceAmount, priceCurrency, sellerHandle, verdict, scamScore, notes }`.
- `writeMemory(record)` — append + cap.
- `queryMemory({ host, priceBand, sellerHandle })` — return matches for cross-referencing.
- `computePersonalFairRange(category)` — from past prices, return `{ low, high, n }` so the agent
  reasons against the user's *own* seen baseline.
- Before each analysis the loop injects relevant memory into the prompt; after, it appends a record.
- Surfaces like *"same phone posted a cheaper unit Tuesday"* and *"this is above your ₹X–₹Y range."*

### TASK C — Tool registry + authority (`agent/tools.js`)

One place that maps tool name → `{ authority, context, run }`. `context` is `"page"` (content
script) or `"bg"` (service worker, for tabs/connectors). Includes the BUILT AUTO hands plus the new
ones below.

```js
export const TOOLS = {
  // perception / AUTO (already built in agent-hands.js + agent-eyes.js)
  read_interactive_map: { authority: "AUTO",   context: "page" },
  read_page:            { authority: "AUTO",   context: "bg"   }, // fraud engine + LLM
  recall_memory:        { authority: "AUTO",   context: "bg"   },
  compute_baseline:     { authority: "AUTO",   context: "bg"   },
  fx_convert:           { authority: "AUTO",   context: "bg"   },
  scroll_to:            { authority: "AUTO",   context: "page" },
  highlight:            { authority: "AUTO",   context: "page" },
  annotate:             { authority: "AUTO",   context: "page" },
  inject_badge:         { authority: "AUTO",   context: "page" },
  // NOTIFY
  fill_field:           { authority: "NOTIFY", context: "page" },
  set_select:           { authority: "NOTIFY", context: "page" },
  fill_form:            { authority: "NOTIFY", context: "page" },
  open_tab:             { authority: "NOTIFY", context: "bg"   },
  calendar_remind:      { authority: "NOTIFY", context: "bg"   },
  drive_save:           { authority: "NOTIFY", context: "bg"   },
  shortlist_add:        { authority: "NOTIFY", context: "bg"   },
  draft_email:          { authority: "AUTO",   context: "bg"   }, // a draft is reversible
  // CONFIRM
  submit_form:          { authority: "CONFIRM", context: "page" },
  click:                { authority: "CONFIRM", context: "page" }, // CONFIRM if it submits/pays
  navigate:             { authority: "CONFIRM", context: "bg"   },
  send_email:           { authority: "CONFIRM", context: "bg"   },
  report_platform:      { authority: "CONFIRM", context: "bg"   }
};
```

### TASK D — Write-hands (`agent/agent-hands-write.js`)  [CAP 2: form handling]

Add to the page-context hands, same patterns as `agent-hands.js` (cursor first, then act, log,
reversible where possible):
- `fill_field({ id, value })` — focus, then dispatch **real** `input` + `change` events (so React/
  Vue register it); type with a human-paced feel via `simulate_typing` if desired.
- `set_select({ id, option })` — set value + dispatch `change`.
- `fill_form({ map })` — fill multiple fields from profile/mission; **never** auto-fill
  SIN/credentials/full card/government IDs — instead `highlight(warn)` + `annotate` why, and leave
  blank. **Stop before submit.**
- `submit_form` / `click` (submitting) are CONFIRM — they must raise the approval card first.

> Test target: on `demo/test-listing.html` the application form fills (name/email/phone/move-in/
> status) visibly, the SIN field is flagged and left empty, and Lyza stops with a CONFIRM card.

### TASK E — Browser/navigation tools in the service worker

Implement in `service-worker.js` (content script can't open tabs):
- `open_tab(url, background)` → `chrome.tabs.create`.
- `navigate(url)` (CONFIRM) → update the active tab's URL (e.g., to the *real* bank).
- `collect_across_tabs(urls)` → open each, inject `agent-eyes` via `chrome.scripting.executeScript`,
  extract price/terms, close, return a ranked comparison (CAP 3).
- `return_to(tabId)`.

### TASK F — The Agent Loop (`agent/loop.js`) + Planner (`agent/planner.js`)

**Planner:** one Claude call given `{ goal, constraints, currentPageMap, memoryDigest }` returns:
```json
{
  "plan": [
    { "step": 1, "tool": "read_page" },
    { "step": 2, "tool": "recall_memory", "args": { "match": "host,seller,priceBand" } },
    { "step": 3, "tool": "compute_baseline", "args": { "category": "rental_1bed" } },
    { "step": 4, "tool": "inject_badge", "args": { "id": "el_price", "text": "≈ ₹148,000/mo" }, "say": "...", "authority": "AUTO" },
    { "step": 5, "tool": "highlight", "args": { "ids": ["el_clause"], "style": "danger", "reason": "..." }, "say": "...", "authority": "AUTO" },
    { "step": 6, "tool": "DECIDE", "args": { "rule": "shortlist if low risk AND price<=budget AND within_baseline" } },
    { "step": 7, "tool": "fill_form", "args": { "from": "profile+mission" }, "authority": "NOTIFY" },
    { "step": 8, "tool": "submit_form", "onlyIf": "user approves", "authority": "CONFIRM" }
  ],
  "escalateWhen": "shortlist reaches 3 OR a CONFIRM-tool is required"
}
```
The plan steps reuse the SAME `{ tool, args, say, status, pause }` shape the BUILT
`LyzaWalkthrough.run` already executes — so the loop can drive the tested hands directly. For voice
walkthroughs, hand the plan to `LyzaWalkthrough.run(plan, { onNarrate: speak })`.

**Loop (PLAN·ACT·OBSERVE·REFLECT):**
- Route each step by `TOOLS[tool].context` (page → message the content script; bg → run locally).
- Run `AUTO` immediately; `NOTIFY` → run + passive toast; `CONFIRM` → **queue + raise approval card**,
  wait for Approve/Edit/Decline.
- After each tool: OBSERVE the result; if an `el_N` is missing (page changed), REFLECT → re-run
  `read_interactive_map` and re-plan from current state (self-healing).
- Persist mission state after every step (survives navigation/restart).
- A global STOP (already built in hands) halts the loop; the loop must check `LyzaHands.halted`.

### TASK G — Missions (`agent/missions.js`) + Mission Control (popup)

- Mission: `{ id, goal, plan[], state, constraints, log[], status }` in `chrome.storage.local`.
- CRUD + an active-mission pointer. Onboarding ends by **creating the first mission** (not just
  setting a profile).
- **Mission Control** popup tab: live missions, the running step log (proof of agency), learned
  baselines, scams auto-avoided, pending escalations, and a "My financial picture" summary
  (considered totals, money saved, reminders set).

### TASK H — Voice (ElevenLabs) wired to narration

In `service-worker.js`, message type `SPEAK`:
- `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}` with `xi-api-key`, body
  `{ text: text.slice(0,900), model_id: "eleven_multilingual_v2", voice_settings:{ stability:0.5, similarity_boost:0.75 } }`,
  `Accept: audio/mpeg`.
- Return the audio as a base64 data URL; content script plays `new Audio(dataUrl).play()`.
- **Wire it to the walkthrough:** pass `onNarrate: (text) => sendMessage({type:"SPEAK", text})` into
  `LyzaWalkthrough.run`. The narration strings are already in the user's language (LLM-translated),
  and `eleven_multilingual_v2` renders them correctly. Add `https://api.elevenlabs.io/*` to
  `host_permissions`. Key stored as `lyza_elevenlabs_key`. Degrade gracefully if absent.

### TASK I — Live FX (`fx_convert`)

Keyless Frankfurter: `https://api.frankfurter.dev/v1/latest?base={LOCAL}&symbols={HOME}`, cache per
pair for 1h in `chrome.storage.session`. The LLM extracts `{ amount, currency }` from the page; the
service worker converts with the real rate and builds the badge text ("≈ ₹148,000/mo · live rate").

### TASK J — Proactive interception (CAP 4)  [magical]

Deterministic content-script watcher tied to active missions:
- Focus on `input[type=password|tel|number]` or card-like fields on a domain flagged by the fraud
  engine / <90-day-old domain → interrupt with a nudge before the user types.
- On a high-risk page: `redact_warn` (blur the sensitive field with an overlay), `highlight(danger)`
  the scam phrases, narrate the warning, then offer `navigate` to the real site as CONFIRM.
- Max one nudge per page; easily muted. Cheap to run, big perceived intelligence.

---

## 4. Connectors (Gmail / Calendar / Drive)

The user has Gmail, Calendar, and Drive connected. Implement the `bg`-context executors to call them:
- `calendar_remind` → create a Calendar event/reminder (e.g., 3 days before a bill due date; a
  viewing slot with a question checklist).
- `draft_email` (AUTO) → create a **draft** only; `send_email` (CONFIRM) → send after approval.
- `drive_save` → write a markdown summary to a "Lyza – Financial Decisions" folder.
- If a connector isn't authorized → raise a one-tap "Connect Google" and fall back to
  copy-to-clipboard so the mission never dead-ends. **Preview + Confirm before any CONFIRM call.**

---

## 5. Data contracts (single source of truth)

**LLM page analysis** (service worker → UI), all human strings in the user's language:
```json
{
  "pageType": "marketplace|rental|banking|job|shopping|other",
  "summary": "2-4 sentences",
  "confidence": "low|medium|high",
  "prices": [{ "amount": 2400, "currency": "CAD", "period": "month", "id": "el_price" }],
  "priceContext": { "verdict": "below_average|average|above_average|unknown", "explanation": "" },
  "contentScamSignals": { "score": 0, "reasons": [] },
  "flaggedPhrases": ["exact substrings on the page"],
  "tips": [],
  "disclaimer": ""
}
```

**Walkthrough/plan step** (what the BUILT hands execute):
```json
{ "tool": "highlight", "args": { "id": "el_7", "style": "danger", "reason": "..." }, "say": "narration", "status": "chip text", "pause": 1200 }
```

**Mission record:**
```json
{ "id": "m1", "goal": "Find a safe 1-bed under $1,900", "plan": [], "state": {}, "constraints": { "budget": 1900, "currency": "CAD" }, "log": [], "status": "active|paused|done" }
```

**Memory record:**
```json
{ "ts": 0, "kind": "rental", "host": "", "title": "", "url": "", "priceAmount": 2400, "priceCurrency": "CAD", "sellerHandle": "", "verdict": "", "scamScore": 0, "notes": "" }
```

---

## 6. Manifest (final)

```json
{
  "manifest_version": 3,
  "name": "Lyza — Financial Acclimation Agent",
  "version": "5.0.0",
  "permissions": ["storage", "activeTab", "scripting", "tabs"],
  "host_permissions": ["<all_urls>", "https://api.anthropic.com/*",
    "https://api.elevenlabs.io/*", "https://safebrowsing.googleapis.com/*",
    "https://rdap.org/*", "https://api.frankfurter.dev/*"],
  "action": { "default_popup": "popup/popup.html", "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" } },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["agent/agent-eyes.js", "agent/agent-hands.js", "agent/agent-hands-write.js", "agent/guided-walkthrough.js", "content/content.js"],
    "css": ["content/overlay.css", "agent/agent-overlay.css"],
    "run_at": "document_idle"
  }]
}
```
> The agent scripts load as classic scripts (they attach to `window.Lyza*`); the service worker is
> an ES module. Keep that split.

---

## 7. Build order (24h, embodiment-first)

1. ✅ **Embodied core** (eyes/hands/walkthrough/CSS + demo) — DONE & TESTED. Verify via the demo page.
2. **Task H (Voice)** wired to the existing walkthrough → CAP 1 fully alive (page operates itself +
   speaks). *Highest demo payoff; the hands already work.*
3. **Task A (Fraud engine)** + **Task I (FX)** → real, explainable verdicts behind the visuals.
4. **Task B (Memory)** → cross-references + personal baseline.
5. **Task C/D (Tools + write-hands)** → CAP 2 form-filling with the CONFIRM gate.
6. **Task F (Loop + Planner)** → goal-driven autonomy reusing `LyzaWalkthrough.run`.
7. **Task E (tab tools)** → CAP 3 multi-tab comparison.
8. **Task G (Missions + Mission Control)** → proof-of-agency UI; onboarding creates first mission.
9. **Task J (Proactive interception)** + connectors (Section 4) → CAP 4.

After each: load unpacked, no console errors, one happy path works end-to-end.

---

## 8. Guardrails (non-negotiable)

- Never auto-submit/sent/pay/sign → always CONFIRM with preview + approval.
- Never auto-fill SIN, credentials, full card numbers, government IDs → flag + leave blank.
- STOP must halt the loop and hands instantly (already wired via `LyzaHands.halted`).
- Keys in `chrome.storage.local` only; never logged; sent only to their own provider.
- The scam score is assistive, not authoritative — always show the disclaimer; never claim "100% safe".
- Rental/legal → educational only; point to the local tenant board / settlement agency.
- All agent visuals are reversible via `LyzaHands.clear()`; narration uses the already-translated
  analysis so language never leaks.

---

## 9. Demo script (3 min, embodiment-first)

1. Onboarding → Maria states a goal: *"Find a safe 1-bed under $1,900 near campus and help me apply."*
2. **Guided walkthrough (CAP 1):** on a listing, the page scrolls itself, a ₹ badge pops beside the
   price, the deposit clause outlines red, the "I'm abroad" message amber — narrated in Hindi. Hands-free.
3. **Memory (agent):** second listing → *"8th this week; your fair range is ₹X–₹Y; this is 20% above —
   and this phone posted a cheaper unit Tuesday."*
4. **Form handling (CAP 2):** the application fills itself; SIN flagged + left blank; Lyza stops →
   one CONFIRM tap.
5. **Multi-tab compare (CAP 3):** tabs open/close on their own → ranked comparison, winner highlighted.
6. **Interception (CAP 4):** drift to a fake-bank page on an 11-day-old domain → Lyza blurs the card
   field, warns, offers to navigate to the real bank (CONFIRM).
7. **STOP:** tap mid-action → hands freeze. *"You can always grab the wheel."*
8. Close on **Mission Control:** *"Maria browsed; Lyza drove — converting, highlighting, comparing,
   filling, defending — and asked her to approve exactly twice."*

---

*End. The embodied core (Section 2) is built and verified — integrate, don't rewrite. Build Voice
next (it makes the tested hands sing), then the fraud engine and memory (substance), then the loop
(autonomy). The thing that wins criterion 3 and delights on criterion 2 is the page operating itself
under the agent's control — and that already works.*
