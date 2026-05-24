// content.js — v3 agentic UI on every page.
// Floating button → panel with: rigorous fraud verdict + action bar + memory insights +
// voice "walk me through it" + proactive nudge before high-risk inputs.

(function () {
  if (window.__lyzaInjected) return;
  window.__lyzaInjected = true;

  let lastPageData = null;
  let lastAnalysis = null;
  let chatHistory = [];
  let proactiveShown = false;
  let voiceUtterance = null;

  // ---- Safe messaging wrapper -------------------------------------------
  // Survives "Extension context invalidated" when the extension is reloaded
  // while a content script is still alive on a previously-opened page.
  function lyzaSend(message, callback) {
    if (!chrome?.runtime?.id) {
      // Extension was reloaded/uninstalled — content script is now orphaned.
      if (callback) try { callback(null); } catch {}
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          // Swallow — usually "Could not establish connection. Receiving end does not exist."
          // when the SW shut down. Caller's callback gets null and degrades gracefully.
        }
        if (callback) try { callback(res); } catch {}
      });
    } catch (e) {
      // Synchronous throw means context invalidated. Page must be reloaded.
      if (callback) try { callback(null); } catch {}
    }
  }

  // ---- Scraping ----------------------------------------------------------

  function scrapePage() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, svg, iframe").forEach((el) => el.remove());
    const main =
      clone.querySelector("main") ||
      clone.querySelector("[role='main']") ||
      clone.querySelector("article") ||
      clone;
    const text = (main.innerText || clone.innerText || "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return { url: location.href, title: document.title, text };
  }

  // ---- Floating button ---------------------------------------------------

  function makeButton() {
    const btn = document.createElement("button");
    btn.id = "lyza-fab";
    btn.setAttribute("aria-label", "Open Lyza financial assistant");
    btn.innerHTML = `<span class="lyza-fab-mark">L</span>`;
    btn.addEventListener("click", togglePanel);
    document.documentElement.appendChild(btn);
    return btn;
  }

  // ---- Panel -------------------------------------------------------------

  function makePanel() {
    const panel = document.createElement("div");
    panel.id = "lyza-panel";
    panel.innerHTML = `
      <div class="lyza-header">
        <div class="lyza-brand">
          <span class="lyza-logo">L</span>
          <div>
            <div class="lyza-name">Lyza</div>
            <div class="lyza-tag">Your financial guardian</div>
          </div>
        </div>
        <button class="lyza-close" aria-label="Close">&times;</button>
      </div>
      <div class="lyza-body" id="lyza-body">
        <div class="lyza-empty">
          <p class="lyza-empty-title">Read this page for me</p>
          <p class="lyza-empty-sub">Lyza will summarize the page in your language, convert prices live to your home currency, judge the price, check scam risk, AND propose one-tap actions you can take.</p>
          <label class="lyza-lang-picker">
            <span>Lyza speaks</span>
            <select id="lyza-lang-select" aria-label="Narration language">
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="hi">हिन्दी (Hindi)</option>
              <option value="fr">Français</option>
              <option value="pt">Português</option>
              <option value="zh">中文</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          <button class="lyza-analyze-btn" id="lyza-analyze">Analyze this page</button>
          <button class="lyza-walkthrough-btn" id="lyza-walkthrough">▶ Start guided walkthrough</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);
    panel.querySelector(".lyza-close").addEventListener("click", () => panel.classList.remove("lyza-open"));
    panel.querySelector("#lyza-analyze").addEventListener("click", runAnalysis);
    panel.querySelector("#lyza-walkthrough").addEventListener("click", runWalkthrough);
    wireLanguagePicker(panel);
    return panel;
  }

  function wireLanguagePicker(panel) {
    const sel = panel.querySelector("#lyza-lang-select");
    if (!sel) return;
    // Pre-fill with current profile language.
    lyzaSend({ type: "GET_PROFILE_LANGUAGE" }, (res) => {
      if (res && res.ok && res.language) {
        profileLanguage = res.language;
        sel.value = res.language;
      }
    });
    sel.addEventListener("change", () => {
      profileLanguage = sel.value;
      lyzaSend({ type: "SET_PROFILE_LANGUAGE", language: profileLanguage });
    });
  }

  function togglePanel() {
    const panel = document.getElementById("lyza-panel") || makePanel();
    panel.classList.toggle("lyza-open");
  }

  function openPanel() {
    const panel = document.getElementById("lyza-panel") || makePanel();
    panel.classList.add("lyza-open");
  }

  // ---- Rendering helpers -------------------------------------------------

  function setBody(html) {
    const body = document.getElementById("lyza-body");
    if (body) body.innerHTML = html;
  }

  function loadingState() {
    setBody(`
      <div class="lyza-loading">
        <div class="lyza-spinner"></div>
        <p>Analyzing page · checking domain age · live FX · scam patterns…</p>
      </div>
    `);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function riskBadge(level, score) {
    const map = { low: "lyza-risk-low", medium: "lyza-risk-med", high: "lyza-risk-high" };
    const cls = map[level] || "lyza-risk-med";
    const labels = { low: "Low risk", medium: "Medium risk", high: "High risk" };
    return `<span class="lyza-risk ${cls}">${labels[level] || "Risk"} · ${score}/100</span>`;
  }

  function verdictBadge(v) {
    const map = {
      below_average: ["Below average", "lyza-v-good"],
      average: ["About average", "lyza-v-mid"],
      above_average: ["Above average", "lyza-v-bad"],
      unknown: ["No price found", "lyza-v-unknown"]
    };
    const [txt, cls] = map[v] || map.unknown;
    return `<span class="lyza-verdict ${cls}">${txt}</span>`;
  }

  function confidenceBadge(c) {
    const map = { low: "lyza-conf-low", medium: "lyza-conf-mid", high: "lyza-conf-high" };
    return `<span class="lyza-conf ${map[c] || "lyza-conf-mid"}">confidence: ${c || "medium"}</span>`;
  }

  // ---- Main render -------------------------------------------------------

  function renderAnalysis(a) {
    lastAnalysis = a;

    const highBanner = a.scamRisk?.level === "high"
      ? `<div class="lyza-banner lyza-banner-high">
           <strong>⚠️ This page shows strong signs of being fake or a scam.</strong>
           <p>Do not enter personal info, passwords, or payment details.</p>
         </div>`
      : "";

    const prices = (a.prices || [])
      .map((p) => `
        <div class="lyza-price-row">
          <div class="lyza-price-orig">${escapeHtml(p.original || "")}</div>
          ${p.converted ? `<div class="lyza-price-conv">${escapeHtml(p.converted)}</div>` : ""}
          ${p.rate ? `<div class="lyza-price-rate">1 ${escapeHtml(p.currency)} = ${p.rate.toFixed(4)} ${escapeHtml(p.convertedCurrency || "")} · live</div>` : ""}
          ${p.note ? `<div class="lyza-price-note">${escapeHtml(p.note)}</div>` : ""}
        </div>`).join("");

    const reasons = (a.scamRisk?.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
    const br = a.scamRisk?.breakdown || {};
    const breakdown = `
      <details class="lyza-breakdown">
        <summary>Why this score?</summary>
        <ul>
          <li>URL heuristics: <b>${br.urlHeuristics ?? 0}</b></li>
          <li>Blocklist: <b>${escapeHtml(br.blocklist || "unavailable")}</b></li>
          <li>Domain age: <b>${br.domainAgeDays != null ? br.domainAgeDays + " days" : "unknown"}</b></li>
          <li>Content signals: <b>${br.contentScore ?? 0}</b></li>
        </ul>
      </details>`;

    const tips = (a.tips || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("");

    const memoryInsights = (a.memoryInsights || []).map((m) => `<li>${escapeHtml(m)}</li>`).join("");
    const memoryHits = (a.memoryHits || []).slice(0, 4).map((h) => `
      <div class="lyza-memhit">
        <div class="lyza-memhit-title">${escapeHtml(h.title || h.url || "previous record")}</div>
        <div class="lyza-memhit-meta">${escapeHtml(h._matchReason)} · ${escapeHtml(h.host || "")} · ${h.priceAmount ? escapeHtml(h.priceAmount + " " + (h.priceCurrency || "")) : ""}</div>
      </div>`).join("");

    const memoryCard = (memoryInsights || memoryHits)
      ? `<div class="lyza-card lyza-card-memory">
           <div class="lyza-card-head"><span class="lyza-card-title">Lyza remembers</span></div>
           ${memoryInsights ? `<ul class="lyza-list">${memoryInsights}</ul>` : ""}
           ${memoryHits ? `<div class="lyza-memhits">${memoryHits}</div>` : ""}
         </div>` : "";

    const actions = (a.actions || []).map((act, i) => `
      <button class="lyza-action-btn" data-action-idx="${i}" data-action-type="${escapeHtml(act.type)}">
        <span class="lyza-action-icon">${actionIcon(act.type)}</span>
        <span class="lyza-action-label">${escapeHtml(act.label || act.id)}</span>
      </button>`).join("");

    const actionBar = actions ? `
      <div class="lyza-card lyza-card-actions">
        <div class="lyza-card-head"><span class="lyza-card-title">Handle this for me</span></div>
        ${a.recommendation ? `<p class="lyza-reco">${escapeHtml(a.recommendation)}</p>` : ""}
        <div class="lyza-actions-grid">${actions}</div>
      </div>` : "";

    setBody(`
      <div class="lyza-results">
        ${highBanner}

        <div class="lyza-card lyza-card-summary">
          <div class="lyza-card-head">
            <span class="lyza-card-label">${escapeHtml((a.pageType || "page").toUpperCase())}</span>
            ${confidenceBadge(a.confidence)}
            <button class="lyza-voice-btn" id="lyza-voice" aria-label="Walk me through it" title="Walk me through it">🔊 Walk me through it</button>
          </div>
          <p class="lyza-summary">${escapeHtml(a.summary)}</p>
        </div>

        ${actionBar}

        ${prices ? `<div class="lyza-card">
          <div class="lyza-card-head">
            <span class="lyza-card-title">Prices in your currency</span>
          </div>
          ${prices}
        </div>` : ""}

        <div class="lyza-card">
          <div class="lyza-card-head">
            <span class="lyza-card-title">Is this a fair price?</span>
            ${verdictBadge(a.priceContext?.verdict)}
          </div>
          <p class="lyza-text">${escapeHtml(a.priceContext?.explanation || "—")}</p>
        </div>

        <div class="lyza-card lyza-card-risk">
          <div class="lyza-card-head">
            <span class="lyza-card-title">Scam &amp; fraud risk</span>
            ${riskBadge(a.scamRisk?.level, a.scamRisk?.score ?? 0)}
          </div>
          ${reasons ? `<ul class="lyza-list">${reasons}</ul>` : `<p class="lyza-text">No obvious red flags detected.</p>`}
          ${breakdown}
        </div>

        ${memoryCard}

        ${tips ? `<div class="lyza-card">
          <div class="lyza-card-head"><span class="lyza-card-title">Tips for you</span></div>
          <ul class="lyza-list">${tips}</ul>
        </div>` : ""}

        <p class="lyza-disclaimer">${escapeHtml(a.disclaimer || "AI guidance, not financial or legal advice.")}</p>

        <div class="lyza-chat" id="lyza-chat">
          <div class="lyza-chat-log" id="lyza-chat-log"></div>
          <div class="lyza-chat-input-row">
            <input type="text" id="lyza-chat-input" placeholder="Ask a follow-up question…" />
            <button id="lyza-chat-send">Ask</button>
          </div>
        </div>
      </div>
    `);

    wireChat();
    wireActions();
    wireVoice();
  }

  function actionIcon(type) {
    return ({
      calendar_event: "📅",
      gmail_draft: "✉️",
      drive_save: "💾",
      memory_log: "🧠",
      platform_report: "🚩"
    })[type] || "✨";
  }

  function renderError(res) {
    const help = res.error === "NO_API_KEY"
      ? `<p class="lyza-text">Click the Lyza toolbar icon → add your Gemini API key in Settings, then try again.</p>`
      : "";
    setBody(`
      <div class="lyza-card lyza-card-error">
        <div class="lyza-card-title">Couldn't analyze the page</div>
        <p class="lyza-text">${escapeHtml(res.message || "Unknown error.")}</p>
        ${help}
        <button class="lyza-analyze-btn" id="lyza-retry">Try again</button>
      </div>
    `);
    const retry = document.getElementById("lyza-retry");
    if (retry) retry.addEventListener("click", runAnalysis);
  }

  // ---- Action preview / confirm / execute --------------------------------

  function wireActions() {
    document.querySelectorAll(".lyza-action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.actionIdx);
        const action = (lastAnalysis?.actions || [])[idx];
        if (action) showActionPreview(action);
      });
    });
  }

  function showActionPreview(action) {
    lyzaSend({ type: "PREVIEW_ACTION", action }, (res) => {
      if (!res || !res.ok) return;
      const plan = res.plan;
      const overlay = document.createElement("div");
      overlay.className = "lyza-preview-overlay";
      overlay.innerHTML = `
        <div class="lyza-preview-card" role="dialog" aria-modal="true">
          <div class="lyza-preview-head">
            <span class="lyza-preview-icon">${actionIcon(action.type)}</span>
            <strong>${escapeHtml(action.label || action.id)}</strong>
            <button class="lyza-preview-x" aria-label="Cancel">&times;</button>
          </div>
          <p class="lyza-preview-rationale">${escapeHtml(action.rationale || "")}</p>
          ${renderPreviewBody(action.type, plan.preview || action.payload)}
          <div class="lyza-preview-actions">
            <button class="lyza-btn-secondary" id="lyza-preview-cancel">Cancel</button>
            <button class="lyza-btn-primary" id="lyza-preview-confirm">${confirmLabel(action.type)}</button>
          </div>
        </div>
      `;
      document.documentElement.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.querySelector(".lyza-preview-x").addEventListener("click", close);
      overlay.querySelector("#lyza-preview-cancel").addEventListener("click", close);
      overlay.querySelector("#lyza-preview-confirm").addEventListener("click", () => {
        executeAction(action);
        close();
      });
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    });
  }

  function confirmLabel(type) {
    return ({
      calendar_event: "Open in Calendar",
      gmail_draft: "Open Gmail draft",
      drive_save: "Download to Drive",
      memory_log: "Log to memory",
      platform_report: "Open report email"
    })[type] || "Confirm";
  }

  function renderPreviewBody(type, p) {
    p = p || {};
    if (type === "calendar_event") {
      return `
        <div class="lyza-preview-body">
          <div><b>Title:</b> ${escapeHtml(p.title || "")}</div>
          <div><b>Location:</b> ${escapeHtml(p.location || "—")}</div>
          ${p.description ? `<div class="lyza-preview-pre">${escapeHtml(p.description)}</div>` : ""}
          ${Array.isArray(p.checklist) && p.checklist.length
            ? `<div><b>Checklist:</b><ul>${p.checklist.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>` : ""}
        </div>`;
    }
    if (type === "gmail_draft" || type === "platform_report") {
      return `
        <div class="lyza-preview-body">
          <div><b>To:</b> ${escapeHtml(p.to || "(you fill in)")}</div>
          <div><b>Subject:</b> ${escapeHtml(p.subject || "")}</div>
          <div class="lyza-preview-pre">${escapeHtml(p.body || "")}</div>
        </div>`;
    }
    if (type === "drive_save") {
      return `
        <div class="lyza-preview-body">
          <div><b>File:</b> ${escapeHtml(p.title || "lyza-note")}.md</div>
          <div class="lyza-preview-pre">${escapeHtml(p.body || "")}</div>
        </div>`;
    }
    if (type === "memory_log") {
      return `<div class="lyza-preview-body"><div>${escapeHtml(p.note || "")}</div></div>`;
    }
    return `<div class="lyza-preview-body"><div>${escapeHtml(JSON.stringify(p, null, 2))}</div></div>`;
  }

  function executeAction(action) {
    lyzaSend(
      { type: "EXECUTE_ACTION", payload: { action, pageData: lastPageData } },
      (res) => {
        if (!res || !res.ok) {
          showToast(`Couldn't execute: ${res?.message || "error"}`, true);
          return;
        }
        if (res.kind === "download_markdown") {
          triggerDownload(res.filename, res.content);
        }
        showToast("Action executed ✓");
      }
    );
  }

  function triggerDownload(filename, content) {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  function showToast(msg, isError) {
    const t = document.createElement("div");
    t.className = "lyza-toast" + (isError ? " lyza-toast-error" : "");
    t.textContent = msg;
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  }

  // ---- Voice (browser TTS, no API key needed) ---------------------------

  function wireVoice() {
    const btn = document.getElementById("lyza-voice");
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (voiceUtterance) { window.speechSynthesis.cancel(); voiceUtterance = null; btn.classList.remove("lyza-speaking"); return; }
      const script = buildVoiceScript(lastAnalysis);
      if (!script) return;
      voiceUtterance = new SpeechSynthesisUtterance(script);
      // best-effort lang from analysis text — speechSynthesis auto-detects on most platforms
      voiceUtterance.rate = 1.0;
      voiceUtterance.pitch = 1.0;
      voiceUtterance.onend = () => { btn.classList.remove("lyza-speaking"); voiceUtterance = null; };
      btn.classList.add("lyza-speaking");
      window.speechSynthesis.speak(voiceUtterance);
    });
  }

  function buildVoiceScript(a) {
    if (!a) return "";
    const parts = [
      a.summary,
      a.priceContext?.explanation,
      a.scamRisk?.level === "high" ? "Important warning: this page shows strong signs of being a scam." : "",
      a.recommendation,
      (a.tips || [])[0] || ""
    ].filter(Boolean);
    return parts.join(". ");
  }

  // ---- Chat --------------------------------------------------------------

  function wireChat() {
    const input = document.getElementById("lyza-chat-input");
    const send = document.getElementById("lyza-chat-send");
    if (!input || !send) return;
    const submit = () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      askFollowUp(q);
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  }

  function appendChat(role, text) {
    const log = document.getElementById("lyza-chat-log");
    if (!log) return;
    const div = document.createElement("div");
    div.className = `lyza-msg lyza-msg-${role}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function askFollowUp(question) {
    appendChat("user", question);
    appendChat("assistant", "…");
    const log = document.getElementById("lyza-chat-log");
    const pending = log ? log.lastChild : null;
    lyzaSend(
      { type: "CHAT_FOLLOWUP", payload: { pageData: lastPageData, history: chatHistory, question } },
      (res) => {
        if (pending) pending.remove();
        if (res && res.ok) {
          appendChat("assistant", res.reply);
          chatHistory.push({ role: "user", content: question });
          chatHistory.push({ role: "assistant", content: res.reply });
        } else {
          appendChat("assistant", (res && res.message) || "Sorry, something went wrong.");
        }
      }
    );
  }

  // ---- Proactive coach (HERO 3) -----------------------------------------

  const PAYMENT_KEYWORDS = /(wire transfer|e-transfer|etransfer|interac|western union|moneygram|bitcoin|gift card|cashapp|venmo|zelle|urgent|act now|limited time|verify your account|suspended|click here to)/i;

  function isYoungSuspiciousHost() {
    // Cheap heuristic: TLDs we know are abused + brand-y phishing words in hostname.
    const host = location.hostname.toLowerCase();
    const tld = host.split(".").pop();
    const suspiciousTld = ["zip","mov","xyz","top","gq","ml","cf","tk","work","click","link","icu","cyou","sbs","quest"].includes(tld);
    const phishyWord = /(secure|verify|update|account|login|signin|wallet)/.test(host);
    return suspiciousTld || phishyWord;
  }

  function pageHasPaymentSignals() {
    const text = (document.body?.innerText || "").slice(0, 4000);
    return PAYMENT_KEYWORDS.test(text);
  }

  function showProactiveNudge(reason) {
    if (proactiveShown) return;
    proactiveShown = true;
    const nudge = document.createElement("div");
    nudge.className = "lyza-nudge";
    nudge.innerHTML = `
      <div class="lyza-nudge-icon">⚠️</div>
      <div class="lyza-nudge-body">
        <div class="lyza-nudge-title">Pause — Lyza spotted something</div>
        <div class="lyza-nudge-text">${escapeHtml(reason)}</div>
      </div>
      <button class="lyza-nudge-cta" id="lyza-nudge-check">Check it for me</button>
      <button class="lyza-nudge-close" aria-label="Dismiss">&times;</button>
    `;
    document.documentElement.appendChild(nudge);
    nudge.querySelector(".lyza-nudge-close").addEventListener("click", () => nudge.remove());
    nudge.querySelector("#lyza-nudge-check").addEventListener("click", () => {
      nudge.remove();
      openPanel();
      runAnalysis();
    });
    setTimeout(() => nudge.classList.add("lyza-nudge-in"), 20);
  }

  function setupProactiveTriggers() {
    // Trigger 1: payment-style field on a suspicious-looking domain.
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (!t || !(t instanceof HTMLElement)) return;
      const type = (t.getAttribute && t.getAttribute("type") || "").toLowerCase();
      const name = (t.getAttribute && (t.getAttribute("name") || t.getAttribute("autocomplete") || "")).toLowerCase();
      const isPaymentField =
        ["password","tel"].includes(type) ||
        /card|cvc|cvv|expir|account|iban|sin|ssn/.test(name);
      if (isPaymentField && isYoungSuspiciousHost()) {
        showProactiveNudge("This site asks for sensitive info and the domain looks risky. Want me to check it before you type?");
      }
    }, true);

    // Trigger 2: page text contains classic scam-language patterns.
    setTimeout(() => {
      if (pageHasPaymentSignals() && isYoungSuspiciousHost()) {
        showProactiveNudge("This page mixes urgency or off-platform payment language with a risky-looking domain.");
      }
    }, 1500);
  }

  // ---- Run ---------------------------------------------------------------

  function runAnalysis() {
    loadingState();
    lastPageData = scrapePage();
    chatHistory = [];
    lyzaSend({ type: "ANALYZE_PAGE", pageData: lastPageData }, (res) => {
      if (res && res.ok) renderAnalysis(res.analysis);
      else renderError(res || { message: "No response from background." });
    });
  }

  // ---- Guided walkthrough (CAP 1) ---------------------------------------

  let activeAudio = null;
  let profileLanguage = "en";

  function stopAudio() {
    try { if (activeAudio) { activeAudio.pause(); activeAudio.src = ""; activeAudio = null; } } catch {}
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
  }

  function speakBrowserFallback(text) {
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = 1.0;
      utt.pitch = 1.0;
      window.speechSynthesis.speak(utt);
    } catch (e) { /* no-op */ }
  }

  function speak(text) {
    if (!text) return;
    stopAudio();
    lyzaSend(
      { type: "SPEAK", payload: { text, language: profileLanguage } },
      (res) => {
        if (res && res.ok && res.audio) {
          try {
            activeAudio = new Audio(res.audio);
            activeAudio.play().catch(() => speakBrowserFallback(text));
          } catch {
            speakBrowserFallback(text);
          }
        } else {
          // No ElevenLabs key or API error → browser fallback so the demo never goes silent.
          speakBrowserFallback(text);
        }
      }
    );
  }

  async function loadProfileLanguage() {
    return new Promise((resolve) => {
      lyzaSend({ type: "GET_PROFILE_LANGUAGE" }, (res) => {
        profileLanguage = (res && res.ok && res.language) ? res.language : "en";
        resolve(profileLanguage);
      });
    });
  }

  async function runWalkthrough() {
    if (!window.LyzaWalkthrough || !window.LyzaEyes || !window.LyzaHands) {
      console.warn("[Lyza] walkthrough scripts not loaded");
      return;
    }
    await loadProfileLanguage();

    // Ensure we have an analysis from Gemini before walking. If the user
    // already clicked Analyze, reuse it. Otherwise run it now.
    let analysis = lastAnalysis;
    if (!analysis) {
      const panel = document.getElementById("lyza-panel");
      if (panel) panel.classList.add("lyza-open");
      loadingState();
      lastPageData = scrapePage();
      analysis = await new Promise((resolve) => {
        lyzaSend({ type: "ANALYZE_PAGE", pageData: lastPageData }, (res) => {
          if (res && res.ok) {
            lastAnalysis = res.analysis;
            renderAnalysis(res.analysis);
            resolve(res.analysis);
          } else {
            renderError(res || { message: "No response from background." });
            resolve(null);
          }
        });
      });
      if (!analysis) return;
      // Tiny pause so the user can see the cards rendered before we close the panel.
      await new Promise((r) => setTimeout(r, 700));
    }

    // Close the panel so the page is visible for the walkthrough.
    const panel = document.getElementById("lyza-panel");
    if (panel) panel.classList.remove("lyza-open");

    setTimeout(async () => {
      // Build the plan from the REAL Gemini analysis, anchored to elements
      // actually present on this page (via LyzaEyes.buildMap).
      const plan = window.LyzaWalkthrough.buildAnalysisPlan(analysis, { language: profileLanguage });
      if (!plan || plan.length === 0) {
        window.LyzaHands.begin();
        const t = (window.LyzaWalkthrough.L && window.LyzaWalkthrough.L(profileLanguage)) || {};
        window.LyzaHands.setStatus(t.status?.done || "Nothing visible to walk through");
        setTimeout(() => window.LyzaHands.clear(), 2200);
        return;
      }
      await window.LyzaWalkthrough.run(plan, { onNarrate: speak });
      setTimeout(() => {
        if (window.LyzaHands && !window.LyzaHands.halted) {
          const t = (window.LyzaWalkthrough.L && window.LyzaWalkthrough.L(profileLanguage)) || {};
          window.LyzaHands.setStatus(t.status?.done || "Walkthrough complete");
        }
      }, 600);
    }, 300);
  }

  // ---- v4 tool dispatcher (loop → content-script DOM tools) -------------
  // The agent loop in the service worker sends `LYZA_TOOL_CALL` with a tool
  // name + args; we route to LyzaHands (existing AUTO tools) or LyzaHandsWrite
  // (NOTIFY/CONFIRM input tools) and reply with `LYZA_TOOL_RESULT`.
  function handleToolCall(msg, sendResponse) {
    const { callId, tool, args } = msg;
    const reply = (result) => {
      sendResponse({ ok: true, callId, result });
      // Also send routed reply for the alt-handler in tools.js.
      lyzaSend({ type: "LYZA_TOOL_RESULT", callId, result });
    };
    try {
      // Eyes — perception
      if (tool === "read_interactive_map") {
        const map = window.LyzaEyes ? window.LyzaEyes.buildMap() : [];
        reply({ ok: true, map });
        return;
      }
      // Hands — AUTO + NOTIFY DOM tools
      const handsFn =
        (window.LyzaHands && window.LyzaHands[tool]) ||
        (window.LyzaHandsWrite && window.LyzaHandsWrite[tool]);
      if (typeof handsFn === "function") {
        Promise.resolve(handsFn(args || {}))
          .then((result) => reply(result || { ok: true }))
          .catch((e) => reply({ ok: false, code: "TOOL_ERROR", message: String(e) }));
        return;
      }
      // clear_hands as a special case
      if (tool === "clear_hands" && window.LyzaHands && typeof window.LyzaHands.clear === "function") {
        window.LyzaHands.clear();
        reply({ ok: true });
        return;
      }
      reply({ ok: false, code: "UNKNOWN_TOOL", message: `Tool '${tool}' not available in content script` });
    } catch (e) {
      reply({ ok: false, code: "DISPATCH_ERROR", message: String(e) });
    }
  }

  // Listen for tool calls from the agent loop.
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "LYZA_TOOL_CALL") {
        handleToolCall(msg, sendResponse);
        return true; // async response
      }
      if (msg && msg.type === "LYZA_TOOL_ABORT") {
        // STOP propagation: halt hands immediately.
        if (window.LyzaHands && typeof window.LyzaHands.halt === "function") {
          window.LyzaHands.halt();
        }
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });
  }

  // ---- Init --------------------------------------------------------------

  makeButton();
  setupProactiveTriggers();
  // Tell the SW we're live on this tab so it can resume any pending missions.
  lyzaSend({ type: "LYZA_CS_READY", url: location.href, title: document.title });
})();
