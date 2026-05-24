// agent-eyes.js — The agent's perception layer.
// Tags interactive + important elements with data-lyza-id="el_N" and exposes
// a compact map the planner targets by id (never raw selectors).
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
      if (el.closest("#lyza-panel, #lyza-fab, .lyza-cursor, .lyza-statuschip, .lyza-stop")) return;
      const id = tag(el);
      const r = el.getBoundingClientRect();
      out.push({
        id, role: roleOf(el), label: labelOf(el), selectorHint: selectorHint(el),
        value: "value" in el ? el.value : "", text: shortText(el),
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }
      });
    });
    return out;
  }
  function collectContent() {
    const out = [];
    const candidates = document.querySelectorAll(
      "h1, h2, h3, p, li, .clause, [class*='clause'], [class*='msg'], [class*='message'], [id*='message'], [class*='price'], [id*='price']"
    );
    candidates.forEach((el) => {
      if (!isVisible(el)) return;
      if (el.closest("#lyza-panel, #lyza-fab, .lyza-cursor, .lyza-statuschip, .lyza-stop")) return;
      const text = shortText(el);
      if (!text || text.length < 3) return;
      const isPrice = PRICE_RE.test(text);
      const isHeading = /^h[1-3]$/.test(el.tagName.toLowerCase());
      const isListItem = el.tagName.toLowerCase() === "li";
      if (!isPrice && !isHeading && !isListItem && text.length < 30) return;
      const id = tag(el);
      const r = el.getBoundingClientRect();
      out.push({
        id,
        role: isPrice ? "price" : roleOf(el),
        label: isPrice ? "price" : (isHeading ? "heading" : "content"),
        selectorHint: selectorHint(el), value: "", text,
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }
      });
    });
    return out;
  }
  function buildMap() {
    const seen = new Set();
    const merged = [];
    [...collectContent(), ...collectInteractive()].forEach((entry) => {
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      merged.push(entry);
    });
    return merged;
  }
  function resolve(id) { return document.querySelector(`[${ID_ATTR}="${id}"]`); }
  function getElementText(id) { const el = resolve(id); return el ? shortText(el) : ""; }
  function refresh() { return buildMap(); }

  window.LyzaEyes = { buildMap, resolve, refresh, getElementText, ID_ATTR };
})();
