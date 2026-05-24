// content.js — Runs on every page. Scrapes content, shows a floating Lyza
// button, and renders the analysis overlay panel with results.

(function () {
  if (window.__lyzaInjected) return;
  window.__lyzaInjected = true;

  let lastPageData = null;
  let chatHistory = [];

  // ---- Scraping ----------------------------------------------------------

  function scrapePage() {
    // Grab visible, meaningful text. Strip scripts/styles/nav noise.
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, svg, iframe").forEach((el) => el.remove());

    // Prefer main content regions when present.
    const main =
      clone.querySelector("main") ||
      clone.querySelector("[role='main']") ||
      clone.querySelector("article") ||
      clone;

    const text = (main.innerText || clone.innerText || "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    return {
      url: location.href,
      title: document.title,
      text
    };
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
            <div class="lyza-tag">Financial acclimation assistant</div>
          </div>
        </div>
        <button class="lyza-close" aria-label="Close">&times;</button>
      </div>
      <div class="lyza-body" id="lyza-body">
        <div class="lyza-empty">
          <p class="lyza-empty-title">Read this page for me</p>
          <p class="lyza-empty-sub">Lyza will summarize the page in your language, convert prices to your home currency, judge whether the price is fair, and check for scam risk.</p>
          <button class="lyza-analyze-btn" id="lyza-analyze">Analyze this page</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector(".lyza-close").addEventListener("click", () => panel.classList.remove("lyza-open"));
    panel.querySelector("#lyza-analyze").addEventListener("click", runAnalysis);
    return panel;
  }

  function togglePanel() {
    const panel = document.getElementById("lyza-panel") || makePanel();
    panel.classList.toggle("lyza-open");
  }

  // ---- Rendering ---------------------------------------------------------

  function setBody(html) {
    const body = document.getElementById("lyza-body");
    if (body) body.innerHTML = html;
  }

  function loadingState() {
    setBody(`
      <div class="lyza-loading">
        <div class="lyza-spinner"></div>
        <p>Reading the page and checking prices &amp; scam risk…</p>
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

  function renderAnalysis(a) {
    const prices = (a.prices || [])
      .map(
        (p) => `
        <div class="lyza-price-row">
          <div class="lyza-price-orig">${escapeHtml(p.original)}</div>
          <div class="lyza-price-conv">${escapeHtml(p.converted)}</div>
          ${p.note ? `<div class="lyza-price-note">${escapeHtml(p.note)}</div>` : ""}
        </div>`
      )
      .join("");

    const reasons = (a.scamRisk?.reasons || [])
      .map((r) => `<li>${escapeHtml(r)}</li>`)
      .join("");

    const tips = (a.tips || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("");

    setBody(`
      <div class="lyza-results">
        <div class="lyza-card lyza-card-summary">
          <div class="lyza-card-label">${escapeHtml((a.pageType || "page").toUpperCase())}</div>
          <p class="lyza-summary">${escapeHtml(a.summary)}</p>
        </div>

        ${
          prices
            ? `<div class="lyza-card">
                <div class="lyza-card-head">
                  <span class="lyza-card-title">Prices in your currency</span>
                </div>
                ${prices}
              </div>`
            : ""
        }

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
        </div>

        ${
          tips
            ? `<div class="lyza-card">
                <div class="lyza-card-head"><span class="lyza-card-title">Tips for you</span></div>
                <ul class="lyza-list">${tips}</ul>
              </div>`
            : ""
        }

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
  }

  function renderError(res) {
    const help =
      res.error === "NO_API_KEY"
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
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
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

    chrome.runtime.sendMessage(
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

  // ---- Run ---------------------------------------------------------------

  function runAnalysis() {
    loadingState();
    lastPageData = scrapePage();
    chatHistory = [];
    chrome.runtime.sendMessage({ type: "ANALYZE_PAGE", pageData: lastPageData }, (res) => {
      if (res && res.ok) renderAnalysis(res.analysis);
      else renderError(res || { message: "No response from background." });
    });
  }

  // ---- Init --------------------------------------------------------------

  makeButton();
})();
