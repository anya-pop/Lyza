# LYZA v5 — The Embodied Browser Agent

> **The v4→v5 shift in one line:** v4 was an agent that *decided and used external apps* (Gmail,
> Calendar, Drive) but barely touched the page itself. v5 gives the agent **hands inside the
> browser** — it highlights, fills, clicks, scrolls, opens tabs, and navigates **as a human would**,
> narrating each move. The page is no longer something Lyza *reads*; it's something Lyza *operates*.
>
> Still built backwards from the rubric. New ruthless test for every feature:
> **"Does the agent physically DO this in the browser, or just talk about it?" If it just talks, cut it.**

---

## 0. Why "embodiment" is the missing 10 points

v1–v4 climbed a ladder: explain → act-via-apps → decide → run-missions. But the agent still lived
*beside* the page in a panel. Judges' criterion 3 rewards *"taking action… enabling workflows that
wouldn't otherwise be possible."* The most visceral, undeniable proof of agency a judge can watch is
**the cursor moving, fields filling, and the page reacting without the user's hands.** That's the
gap v5 closes.

The mental model flips from **"assistant that advises"** to **"co-pilot that drives, with you ready
to grab the wheel."**

```
v4:  Lyza decides + uses Gmail/Calendar/Drive, talks to you in a panel.
v5:  Lyza ALSO operates the page directly — highlights the scam clause, fills the
     rental form, scrolls to the fee you missed, opens the listing in a new tab,
     compares two pages side by side — narrating and pausing for approval on risky moves.
```

---

## 1. The new core: a browser-action toolset the agent can call

This is the heart of v5. Extend the v4 Tool Registry with **DOM/browser tools** the agent invokes
through the content script. Each is a real capability, all implementable with standard extension
APIs (`scripting`, `tabs`, DOM) — no exotic dependencies.

### 1.1 Perception tools (the agent "sees" structure, not just text)

```js
// content/agent-eyes.js — builds a machine-readable map of the page for the agent to target.
read_interactive_map: {
  // Returns a list of actionable elements with stable selectors + roles, so the LLM can
  // reference them by id instead of guessing selectors.
  // [{ id:"el_3", role:"input", label:"Monthly rent", selector:"#rent", value:"" },
  //  { id:"el_7", role:"button", label:"Contact seller", selector:"..." }, ...]
}
```
The agent never guesses raw CSS. The content script assigns each interactive/important element a
short stable id (`el_N`) and hands the LLM a compact map. The LLM plans in terms of `el_N`; the
content script resolves `el_N` → element. This is robust and safe.

### 1.2 Annotation tools (the agent marks up the page)

| Tool | What it physically does | Authority |
|---|---|---|
| `highlight(el_ids, style, reason)` | Draws a colored outline/overlay on elements (red=danger, amber=check, green=good) with a hover tooltip explaining why | `AUTO` |
| `annotate(el_id, note)` | Pins a small Lyza speech-bubble next to an element ("this fee is hidden here") | `AUTO` |
| `scroll_to(el_id)` | Smoothly scrolls the element into view (so the user's eye follows the agent) | `AUTO` |
| `redact_warn(el_ids)` | Blurs/overlays fields that ask for sensitive data on a risky page, with an "are you sure?" gate | `NOTIFY` |
| `inject_badge(el_id, text)` | Adds a live currency-converted price badge right next to each price on the page | `AUTO` |

> **Inline currency badges are a killer visual:** instead of a panel, the converted home-currency
> price appears *floating next to every price on the actual listing.* The page becomes bilingual.

### 1.3 Manipulation tools (the agent operates controls)

| Tool | What it physically does | Authority |
|---|---|---|
| `fill_field(el_id, value)` | Types a value into an input (visibly, character-feel), e.g. fills a rental application with the user's profile data | `NOTIFY` |
| `set_select(el_id, option)` | Chooses a dropdown option | `NOTIFY` |
| `click(el_id)` | Clicks a button/link (e.g. "show more photos", "view full description") | `NOTIFY` for benign; `CONFIRM` if it submits/pays |
| `fill_form(map)` | Fills an entire form from profile + mission context, then **stops before submit** for review | `NOTIFY` to fill, `CONFIRM` to submit |
| `simulate_typing(el_id, text)` | Human-paced typing so the user can watch and trust it | `AUTO` |

### 1.4 Navigation tools (the agent moves around the browser)

| Tool | What it physically does | Authority |
|---|---|---|
| `open_tab(url, background)` | Opens a listing/comparison in a new tab | `NOTIFY` |
| `navigate(url)` | Goes to a URL in the current tab (e.g. the official bank site instead of the look-alike) | `CONFIRM` |
| `compare_tabs(urlA, urlB)` | Opens two listings side-by-side and produces a difference table | `NOTIFY` |
| `collect_across_tabs(urls)` | Visits several listing URLs, extracts price/terms from each, returns a comparison — *multi-tab autonomous research* | `NOTIFY` |
| `return_to(tabId)` | Brings the user back to where they were | `AUTO` |

> `collect_across_tabs` is the multi-page autonomy money-shot: the agent opens 5 saved listings one
> by one, reads each, closes it, and builds a ranked comparison — work no human enjoys doing.

### 1.5 Authority still governs everything (from v4)

`AUTO` = reversible & visual (highlight, scroll, badge) → just do it.
`NOTIFY` = fills/opens, reversible but worth flagging → do it + passive toast.
`CONFIRM` = submits, pays, navigates away, sends → **escalation card + explicit approval.**

The rule the pitch repeats: *"Lyza does everything reversible on its own — highlighting, filling,
scrolling, comparing — and only stops you before it clicks something that can't be undone."*

---

## 2. The five embodied capabilities (each = the agent physically doing something)

### ⭐ CAP 1 — Guided Walkthrough: the agent tours the page for you  → Criterion 2 (magical) + 1

Lyza doesn't dump a summary — it **walks you through the actual page**, in sync with voice:
1. `scroll_to` the price → `inject_badge` the home-currency value → narrates *"This is ₹148k/month."*
2. `scroll_to` + `highlight(red)` the suspicious clause → *"This line lets them keep your deposit —
   unusual."*
3. `scroll_to` + `highlight(green)` the good terms.
The user watches the page move and light up while Lyza explains in their language. **This is the
single most demo-friendly, judge-delighting moment in any version.** It's a teacher pointing at the
page, not a chatbot.

### ⭐ CAP 2 — Autonomous Form Handling  → Criterion 3 (action) + 1 (real pain)

Newcomers stall on unfamiliar forms (rental applications, bank sign-ups, government portals). Lyza:
- `read_interactive_map` → identifies the form fields.
- `fill_form` from the user's profile + mission memory (name, status, references, move-in date),
  **visibly typing** so the user sees and trusts each entry, translating field labels into their
  language as it goes.
- Flags fields it *won't* auto-fill (SIN, banking) and explains why.
- **Stops before submit** → `CONFIRM` card: *"Form's filled. Review and approve to submit?"*

A newcomer watching their first Canadian rental application fill itself, correctly, with the scary
fields flagged — that lands criterion 1 (real pain) and 3 (action) at once.

### ⭐ CAP 3 — Multi-Tab Comparison Research  → Criterion 3 (workflow no chatbot can do) + 2

From a mission ("find a safe 1-bed under $1,900"), Lyza takes its shortlist and runs
`collect_across_tabs`: opens each saved listing, extracts price/terms/risk, closes it, and renders a
**ranked comparison table** with home-currency prices, fair-price verdicts, and scam scores. It even
`highlight`s the winner and explains the trade-offs by voice. Autonomous, cross-tab, multi-step — the
literal definition the rubric uses.

### ⭐ CAP 4 — Live Scam Interception with physical defense  → Criterion 2 (magical) + 3 (decision)

When the agent detects a high-risk page (fraud engine + domain age), it doesn't just warn — it
**physically intervenes**:
- `redact_warn` blurs the card/SIN fields with an overlay so the user *can't* casually type into them.
- `highlight(red)` the exact scam phrases + `annotate` why.
- Narrates the danger first (voice), then offers `navigate` to the *real* site (the legit bank/portal)
  as a `CONFIRM` action: *"This isn't your bank. Want me to take you to the real one?"* → on approval,
  `navigate` to the verified URL.
The agent defending you by altering the page is far more visceral than a red banner.

### ⭐ CAP 5 — Embodied Missions (v4 loop, now with hands)  → Criterion 3 (autonomy)

The v4 Agent Loop (PLAN·ACT·OBSERVE·REFLECT, persistent missions, authority model) is retained — but
its tool registry now includes all the DOM/browser tools above. So a mission executes by *operating
the browser*: as the user browses, Lyza `highlight`s good/bad listings inline, `inject_badge`s
prices, auto-`shortlist_add`s, `open_tab`s comparisons, and `fill_form`s applications — escalating
only at `CONFIRM` edges. The mission log now reads like a record of physical browser actions, which
is undeniable proof of agency.

---

## 3. How the agent operates the browser safely (the technical spine)

This is the part judges' technical-minded members will probe. Make it solid.

### 3.1 The element-id indirection (no blind selector guessing)
- Content script tags interactive/important elements with `data-lyza-id="el_N"` and builds the map.
- LLM plans against `el_N` ids only. Executor resolves id → element, scrolls into view, acts.
- If an `el_N` no longer exists (page changed) → OBSERVE catches it → REFLECT re-runs
  `read_interactive_map` and re-plans. (Self-healing, like real browser agents.)

### 3.2 The action executor (content script)
```js
// content/agent-hands.js
const HANDS = {
  highlight: ({ids, style, reason}) => ids.forEach(id => outline(resolve(id), style, reason)),
  scroll_to: ({id}) => resolve(id).scrollIntoView({behavior:"smooth", block:"center"}),
  inject_badge: ({id, text}) => attachBadge(resolve(id), text),
  fill_field: ({id, value}) => typeInto(resolve(id), value),   // dispatches real input events
  click: ({id}) => resolve(id).click(),
  redact_warn: ({ids}) => ids.forEach(id => blurOverlay(resolve(id))),
  // ... set_select, simulate_typing, etc.
};
// Browser-level tools (open_tab, navigate, collect_across_tabs) run in the service worker
// via chrome.tabs / chrome.scripting because the content script can't open tabs itself.
```
- DOM tools run in the **content script**; tab/navigation tools run in the **service worker**
  (`chrome.tabs.create`, `chrome.scripting.executeScript`). The loop routes each tool to the right
  context.
- `fill_field` dispatches genuine `input`/`change` events so React/Vue sites register the value.
- **Every `CONFIRM` action shows a preview + Approve/Edit/Decline before the hands move.**

### 3.3 Visible agency (so the user always sees what the agent does)
- A soft **Lyza cursor/halo** animates to each element before acting, so actions are legible, never
  spooky. A live "Lyza is doing X…" status chip shows the current step.
- A **STOP** button is always present; one tap halts the loop and the hands immediately.
- Reduced-motion users get instant (non-animated) versions.

### 3.4 Guardrails (non-negotiable)
- Never auto-submit anything that pays, sends, or signs → always `CONFIRM`.
- Never auto-fill credentials, SIN, full card numbers, government IDs → flag and leave to the user.
- Never act on a different origin than the user's active tab without surfacing it.
- All hands actions are logged to the mission log and reversible where possible (un-highlight,
  clear fills).

---

## 4. Updated manifest

```json
{
  "permissions": ["storage", "activeTab", "scripting", "tabs"],
  "host_permissions": ["<all_urls>", "https://api.anthropic.com/*",
    "https://api.elevenlabs.io/*", "https://safebrowsing.googleapis.com/*",
    "https://rdap.org/*", "https://api.frankfurter.dev/*"]
}
```
`tabs` is the only new permission (for multi-tab tools). Everything else is reused.

---

## 5. Updated tool/loop contract

Planner now emits browser-action steps. Example (mission step on a listing page):
```json
{
  "plan": [
    { "step": 1, "tool": "read_interactive_map" },
    { "step": 2, "tool": "read_page" },
    { "step": 3, "tool": "inject_badge", "args": { "id": "el_price", "text": "≈ ₹148,000/mo · live rate" }, "authority": "AUTO" },
    { "step": 4, "tool": "highlight", "args": { "ids": ["el_clause"], "style": "danger", "reason": "Lets landlord keep deposit" }, "authority": "AUTO" },
    { "step": 5, "tool": "scroll_to", "args": { "id": "el_clause" }, "authority": "AUTO" },
    { "step": 6, "tool": "DECIDE", "args": { "rule": "shortlist if low risk & in budget" } },
    { "step": 7, "tool": "fill_form", "args": { "from": "profile+mission" }, "authority": "NOTIFY" },
    { "step": 8, "tool": "submit_form", "onlyIf": "user approves", "authority": "CONFIRM" }
  ]
}
```
Each executed step appends to the mission log with `{ tool, target, authority, escalated, result }`.

---

## 6. Build order (24h, embodiment-first)

> Demo target: the agent **physically operates a real page** — highlights, badges, fills, compares —
> hands-free except for one CONFIRM.

1. **Reuse** v4 agent loop + fraud engine + connectors + memory.
2. **`agent-eyes.js`** — element tagging + `read_interactive_map`. (Everything depends on this.)
3. **`agent-hands.js` AUTO tools first** — `highlight`, `scroll_to`, `inject_badge`, `annotate`.
   Get **CAP 1 (Guided Walkthrough)** working end-to-end with voice. *This alone wins the demo.*
4. **Inline currency badges** on every price (high visual payoff, low effort).
5. **`fill_field` / `fill_form`** + the `CONFIRM`-gated submit → **CAP 2 (Form Handling)**.
6. **Tab tools in the service worker** (`open_tab`, `collect_across_tabs`) → **CAP 3 (Comparison)**.
7. **`redact_warn` + `navigate`** → **CAP 4 (Scam Interception)**.
8. **Lyza cursor/halo + STOP button + status chip** (visible agency) — do this alongside, not last;
   it's what makes the hands feel safe and magical.
9. Wire it all into the persistent mission loop → **CAP 5**.

Verify each: an AUTO walkthrough runs hands-free and legibly; a form fills and *stops* before submit;
a multi-tab compare returns a real table; STOP halts instantly.

---

## 7. The 3-minute demo (scripted, embodiment-first)

1. **Delegate (1+3):** Maria: *"Find a safe 1-bed under $1,900 near campus and help me apply."* Lyza:
   *"I'll work as you browse — watch the page."*
2. **Guided walkthrough (2 — THE delight moment):** On a listing, the page **scrolls itself** to the
   price, a **₹ badge pops in next to it**, then it scrolls and **outlines a deposit clause in red**
   while Lyza explains in Hindi. Maria's hands never move. *Say: "It's not describing the page — it's
   showing me, on the page."*
3. **Inline badges everywhere (1):** Every price on the site now has a live home-currency badge. The
   listing is bilingual.
4. **Multi-tab research (3 — autonomy):** Lyza `collect_across_tabs` on the 3 shortlisted listings —
   tabs open and close on their own — and renders a ranked comparison, highlighting the winner.
5. **Form handling (3+1 — real pain):** On the application form, fields **fill themselves** from
   Maria's profile (visible typing), labels translated, the SIN field flagged and left blank. Lyza
   stops: *"Filled. Approve to submit?"* — one CONFIRM tap.
6. **Live interception (2):** Maria drifts to a fake-bank page; Lyza **blurs the card field**,
   red-outlines the page, and offers *"This isn't your bank — take you to the real one?"* → CONFIRM →
   it `navigate`s to the verified site.
7. **STOP + trust (technical):** Tap STOP mid-action — the hands freeze instantly. *Say: "You can
   always grab the wheel."*
8. **Close on Mission Control (1+2+3):** *"Maria browsed; Lyza drove — highlighting, converting,
   comparing, filling, defending — and asked her to approve exactly twice."*

---

## 8. Pitch lines, mapped to the rubric

- **Real problem (10):** *"Newcomers don't just need things explained — they need someone to actually
  do the unfamiliar, scary tasks with them. Lyza's hands are on the page."*
- **Creative / magical (10):** *"The page scrolls, lights up, and fills itself while Lyza talks you
  through it in your language. You watch your first rental application complete itself."*
- **AI agents (10):** *"Lyza operates the browser — it highlights the scam clause, badges every price
  in your currency, researches listings across tabs on its own, fills the form, and physically blocks
  you from typing your card into a fake bank — pausing only before the irreversible click. It doesn't
  advise the workflow. It performs it."*

---

## 9. The one-test for v5 scope discipline

For any feature under time pressure: **"Does the agent physically do this in the browser — move,
mark, fill, open, or block — or does it just talk?"** Talk is a chatbot. Hands on the page is the
agent. Protect the time for `agent-eyes` + the AUTO hands + the guided walkthrough; those are the
undeniable, watchable proof of agency that wins criterion 3 and delights on criterion 2.

---

*End of v5. Foundation = rigorous 3-layer engine (v2). Brain = the Agent Loop with authority model &
persistent missions (v4). Body = the browser-action toolset (eyes + hands + navigation) with visible,
interruptible agency. Build `agent-eyes` and the AUTO hands FIRST — a page that scrolls and lights
itself up under the agent's control, hands-free, is the thing a judge cannot look away from.*
