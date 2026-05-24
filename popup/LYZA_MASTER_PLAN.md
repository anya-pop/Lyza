# Lyza — Master Implementation Plan (v3 → v4 + v5 unified)

> Synthesis of `LYZA_V4_AGENT_FIRST_SPEC.md` (agent loop, authority model, missions) and
> `LYZA_V5_EMBODIED_AGENT_SPEC.md` (browser-action toolset: eyes + hands + navigation),
> grounded in the shipped v3 code. This document is the single source of truth.

The combined product: **Lyza is an autonomous, embodied financial agent.** The user delegates a
*goal* — Lyza **plans**, **operates the browser with hands** (highlights, scrolls, fills, opens
tabs), **remembers everything**, **decides what's safe to do alone**, and **only stops you before
something irreversible**.

---

## 0. The pitch in one sentence

> *"You don't operate Lyza — you delegate to it. It works on the page while you just browse,
> highlights what matters, fills your forms, runs missions across tabs, defends you from scams
> in real time, and asks you to approve only the one thing it can't take back."*

That sentence is engineered to hit all three rubric criteria simultaneously:
- **Real problem** — newcomers stalling on unfamiliar forms in a foreign language
- **Magical** — page scrolls and lights up under the agent's control, narrated in user's language
- **Agentic** — plan + act + observe + reflect, authority model, persistent missions

---

## 1. Final architecture

```
                                ┌────────────────────────────────────────────┐
                                │           POPUP / OVERLAY                  │
                                │  Mission Control · Settings · Picture      │
                                └───────────────┬────────────────────────────┘
                                                │ chrome.runtime.sendMessage
                                                ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                       SERVICE WORKER (event-driven, durable)                   │
│  ┌────────────────────────────────────────────────────────────────────────┐    │
│  │ agent/loop.js   PLAN → ACT → OBSERVE → REFLECT  (stateless re-entry)   │    │
│  └─────┬──────────────┬─────────────────┬─────────────────────────────────┘    │
│        ▼              ▼                 ▼                                      │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐                              │
│  │planner.js│  │ reflector.js │  │ escalation.js│   (3 LLM roles, Gemini)      │
│  └──────────┘  └──────────────┘  └──────────────┘                              │
│        ▼              ▼                 ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────┐        │
│  │ agent/tools.js  registry: name → {authority, context, run}         │        │
│  └────────┬─────────────────────────┬──────────────────────────────────┘        │
│           │ service_worker tools    │ content_script tools (via tabs.sendMessage)│
│           ▼                         ▼                                          │
│  fraud-engine.js · browser-tools.js · memory.js · missions.js                   │
│  (read_page, fx, RDAP, SB,           (open_tab, navigate, collect_across_tabs)  │
│   recall_memory, baseline)                                                      │
└────────────────────────────────────────────┬───────────────────────────────────┘
                                             │ chrome.tabs.sendMessage
                                             ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│      CONTENT SCRIPT (per tab — Shadow DOM isolated, Trusted-Types safe)        │
│  ┌────────────────┐  ┌────────────────┐  ┌───────────────────────────────┐     │
│  │ agent-eyes.js  │  │ agent-hands.js │  │  Overlay UI                   │     │
│  │  tag + map     │  │  HANDS dispatch│  │  Escalation card · status chip│     │
│  │  MutationObs   │  │  cursor · STOP │  │  Lyza cursor · nudge          │     │
│  └────────────────┘  └────────────────┘  └───────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Two strict isolation boundaries:**
- **Data**: the LLM only ever sees `el_N` ids — never raw CSS selectors. The content script holds
  the `id → element` map.
- **Visual**: every artifact Lyza paints lives in a single `attachShadow({mode:"closed"})` root —
  host-page CSS cannot break our overlays; our CSS cannot break the host page. Trusted-Types-safe.

---

## 2. New file layout (additive — v3 files stay)

```
lyza-extension/
├── manifest.json                       (UPDATED — perms, oauth2, key, hosts)
├── config.js                           (UPDATED — add storage keys, language labels)
├── popup/
│   ├── popup.html                      (UPDATED — Mission Control tab + ElevenLabs key field)
│   ├── popup.js                        (UPDATED — mission CRUD UI, live subscribe)
│   └── popup.css                       (UPDATED — mission cards)
├── content/
│   ├── content.js                      (UPDATED — Shadow DOM + Trusted-Types refactor)
│   ├── overlay.css                     (UPDATED — embedded into shadow root)
│   ├── agent-eyes.js                   (NEW — element tagging, read_interactive_map, MutationObs)
│   └── agent-hands.js                  (NEW — HANDS dispatch, cursor, STOP, tracker rAF loop)
└── background/
    ├── service-worker.js               (UPDATED — message router gains mission/tool routes)
    ├── fraud-engine.js                 (KEEP — adds redact() export only)
    └── agent/
        ├── missions.js                 (NEW — CRUD, persistence, alarms, subscribe)
        ├── memory.js                   (NEW — query API + buildDigest)
        ├── memory-digest.js            (NEW — deterministic compactor; called by planner)
        ├── tools.js                    (NEW — tool registry + invoke + effectiveAuthority)
        ├── browser-tools.js            (NEW — SW-side tab/navigation tools)
        ├── loop.js                     (NEW — state machine, STOP, lifecycle)
        ├── planner.js                  (NEW — Planner LLM caller + prompt)
        ├── reflector.js                (NEW — Reflector LLM caller + prompt)
        ├── escalation.js               (NEW — Escalation Explainer + prompt)
        ├── gemini-config.js            (NEW — endpoint, per-role generationConfig)
        ├── lang-guard.js               (NEW — runtime language validator)
        └── oauth.js                    (OPTIONAL — only if Gmail-send OAuth is enabled)
```

---

## 3. The Authority Model — operational decision tree

Every step the loop executes is classified by the registry:
| Authority | Meaning | What the runtime does |
|---|---|---|
| `AUTO` | Reversible, zero-cost, private (read, badge, scroll, highlight, draft, log to memory) | Execute immediately. Show in mission log only. |
| `NOTIFY` | Acts but worth surfacing (shortlist add, calendar reminder, drive save, form-fill not-submit, open tab) | Execute + emit a passive in-page toast. |
| `CONFIRM` | Sends / pays / submits / navigates-away (send_email, submit_form, navigate, report_platform) | **STOP. Queue an escalation card. Wait for Approve / Edit / Decline.** |

**Dynamic upgrade rules** (applied at execution time by `tools.effectiveAuthority`):

```
if step.tool in ["fill_field","fill_form","set_select","click"]:
  if target element is payment-class (name/autocomplete/placeholder matches
     /card|cvc|cvv|sin|ssn|password|cc-/): UPGRADE to CONFIRM
  if step.tool == "click" and target is submit-class (type=submit OR text
     matches /pay|submit|send|sign|confirm|apply|place order/): UPGRADE to CONFIRM
  if step.tool == "fill_form" and any field is payment-class: UPGRADE whole form to CONFIRM

if step.tool == "navigate" and target_origin != mission.originAtPlan:
  enforce CONFIRM + extra prompt emphasizing cross-origin

if mission has 5+ CONFIRM escalations in the last hour: force "batch approval" UI
```

**Re-escalation back-off** (prevents the planner from re-asking the same thing):

```
fingerprint = sha1(tool + stableJSON(args, fingerprintFields))
- 1st declined → planner may re-propose with DIFFERENT args; same fingerprint blocked for 5 min
- 2nd declined → tool muted for the rest of this mission
- 1st approved → identical fingerprint auto-approved for 10 min ("approve all 3 inquiries")
```

The single rule that wins the pitch: *"Lyza does everything reversible on its own; it only stops
you before it does something that can't be undone."*

---

## 4. The Tool Registry (complete, v4 + v5 combined)

Compact catalog the Planner sees in its system prompt (under 600 tokens):

```yaml
# Perception (AUTO, read-only)
read_page              [AUTO]    scrape + 3-layer fraud engine · args:()
read_interactive_map   [AUTO]    return [{id,role,label}] of actionable elements · args:()
recall_memory          [AUTO]    cross-ref host/seller/priceBand · args:(match)
compute_baseline       [AUTO]    user's personal fair-range · args:(category, currency)
fx_convert             [AUTO]    Frankfurter live FX · args:(amount, from, to)

# Memory & private side effects
remember               [AUTO]    append memory record · args:(kind, host, ...)
shortlist_add          [NOTIFY]  add listing to mission shortlist · args:(missionId, listing)
flag_scammer           [NOTIFY]  log seller/host as scammer · args:(handle?, host?, reason, evidence?)
drive_save             [NOTIFY]  save markdown via Drive template or local download · args:(title, description, checklist?)
calendar_remind        [NOTIFY]  create reminder via Calendar template URL · args:(title, when_hint, durationMinutes?, description?)

# Drafting
draft_email            [AUTO]    create Gmail draft, do NOT send · args:(to?, subject, body)

# Irreversible (always escalates)
send_email             [CONFIRM] send a drafted email (OAuth) OR open compose tab · args:(to, subject, body)
submit_form            [CONFIRM] submit a form previously filled · args:(formId?)
report_platform        [CONFIRM] report listing/seller · args:(to?, subject, body)
click_submit           [CONFIRM] click submit/pay/sign control · args:(id)

# v5 — Annotation (AUTO, visible)
highlight              [AUTO]    outline elements · args:(ids, style, reason)
annotate               [AUTO]    speech-bubble next to element · args:(id, note)
scroll_to              [AUTO]    smooth scrollIntoView · args:(id)
inject_badge           [AUTO]    floating FX/info badge · args:(id, text)

# v5 — Manipulation
redact_warn            [NOTIFY]  blur sensitive fields + event blocker · args:(ids, reason)
fill_field             [NOTIFY]  visible typing into one input · args:(id, value)
set_select             [NOTIFY]  choose dropdown option · args:(id, option)
fill_form              [NOTIFY]  bulk fill, stop before submit · args:(formId, data, leaveBlank?)
simulate_typing        [AUTO]    human-paced typing helper · args:(id, text)
click                  [NOTIFY]  click benign element (NEVER submit-class) · args:(id)
clear_hands            [AUTO]    remove all artifacts the agent created · args:(kinds?, reason?)

# v5 — Navigation
open_tab               [NOTIFY]  new tab · args:(url, background?)
navigate               [CONFIRM] replace current tab's URL · args:(url)
compare_tabs           [NOTIFY]  diff two pages · args:(urlA, urlB)
collect_across_tabs    [NOTIFY]  serial: open → read → close → return ranked rows · args:(urls, fields?)
return_to              [AUTO]    switch to a previous tab · args:(tabId)

# Planner pseudo-tool
DECIDE                 [AUTO]    branch on predicate over mission state · args:(rule, then, else?)
```

Routing: each tool has `context: "service_worker" | "content_script"`. The loop calls
`tools.invoke(name, args, ctx)` which dispatches accordingly. DOM tools cross the boundary via
`chrome.tabs.sendMessage` with a `LYZA_TOOL_CALL` envelope and matching `LYZA_TOOL_RESULT` reply
correlated by `callId`.

---

## 5. The Agent Loop — state machine

```
IDLE ──start(missionId)──▶ LOAD ──no plan──▶ PLAN ─────┐
                            │                          │
                            ▼                          │
                          NEXT STEP ◀─────────────────┘
                            │
                            ▼
                            ACT
                            ├─ AUTO/NOTIFY → run via tools.invoke
                            └─ CONFIRM → ESCALATE → AWAITING_USER
                                                    ├─ approve → ACT
                                                    ├─ edit    → ACT (new args)
                                                    └─ decline → PLAN (replan)
                            │
                            ▼
                          OBSERVE (persist result)
                            │
                            ▼
                          REFLECT
                            ├─ continue → NEXT STEP
                            ├─ replan   → PLAN
                            ├─ escalate → ESCALATE
                            └─ done     → DONE
```

**Cheap-first REFLECT**: before calling Gemini, evaluate deterministic rules (does the success
criterion express a simple `counters.shortlist >= 3` predicate? did the step succeed without any
risk signal change?). Skip the LLM call when possible. Hits ~1 LLM REFLECT per 5 steps.

**Service-worker lifecycle** — *embrace shutdown, rehydrate from storage*:
- Every step persists `act` and `observe` log entries before/after dispatch.
- `chrome.alarms.create("lyza_mission_tick", {periodInMinutes: 1})` heartbeats resume.
- `chrome.runtime.onStartup`, `chrome.alarms.onAlarm`, and content-script `LYZA_CS_READY` ping
  all converge on `resumeAll()`.
- AUTO/NOTIFY steps are idempotent — re-run safe. **CONFIRM steps are NEVER auto-replayed** —
  on resume they're converted back to an escalation card.

**STOP** — synchronously sets a flag, then propagates abort:
1. Content's `AbortController.abort()` stops `simulate_typing` / animations between keystrokes.
2. `chrome.runtime.sendMessage({type:"MISSION_ABORT"})` → SW aborts in-flight tool calls.
3. `mission.status = "paused"` persisted; resume button appears in chip + popup.
4. STOP is reachable by keyboard (`Esc Esc`) and from the always-visible red button in shadow root.

---

## 6. LLM contracts (Gemini 2.5 Flash, JSON mode)

Three roles, three prompts, three schemas:

| Role | When | Temperature | Max tokens | Output |
|---|---|---|---|---|
| **Planner** | At mission start + on every replan trigger | 0.3 | 1600 | `{plan[], escalateWhen, recommendation, expectedOutcome, planRationale}` |
| **Reflector** | After ~every 5th step (and after every failure) | 0.2 | 500 | `{satisfied, reason, nextAction: continue\|replan\|escalate\|complete, diagnosis?, suggestedReplan?}` |
| **Escalation Explainer** | On every CONFIRM step | 0.5 | 700 | `{title, summary, evidence[], payloadPreview, decisionAsks[]}` |

**Total per-call budget**: Planner ≤ 3K tokens (system+user); Reflector ≤ 1.5K; Escalation ≤ 1.2K.

Critical prompt rules (enforced in system prompt AND validated post-parse by `lang-guard.js`):
1. All human-readable strings in `${profile.language}`. Tool names, enum values, ids stay English.
2. Plan only in `el_N` ids returned by the latest `read_interactive_map`. Raw CSS selectors are
   forbidden; planner.js validator rejects them.
3. Every step's `authority` must equal the tool's catalog authority; CONFIRM can never be downgraded.
4. If `memoryDigest.dupSellerFlag` or `repeatScammerFlag` is true, plan a *defensive* path, never
   an engagement path.
5. Output JSON only — no markdown, no fences.

**memoryDigest** is a deterministic (non-LLM) compactor that turns the unbounded memory into a
high-signal 200-500 token block. Never drops `dupSellerFlag` / `repeatScammerFlag` — those are
safety-critical.

**Robustness**:
- Invalid JSON → 1 retry with "re-emit valid JSON only" → fallback to a deterministic minimal
  plan (`[read_interactive_map, read_page, recall_memory, compute_baseline]`) + show v3 analyzer.
- Unknown tool name → skip the step; abort the plan if it happens twice; retry with explicit
  "you used X which doesn't exist; the catalog is..."
- Same failing step ≥ 3× in a row → halt + escalate "Retry / Skip / Pause".
- Language mismatch (heuristic check using Unicode block + stopwords) → 1 retry with "translate
  every human-readable field to ${language}" → if still wrong, log warning, don't block user.

---

## 7. Embodied tools — DOM contracts

### `agent-eyes.js`

- **Element tagging**: single `document_idle` walk + MutationObserver for SPA mutations
  (80ms debounce). Stamps `data-lyza-id="el_N"` on each *important* element.
- **Inclusion criteria** (importance ≥ 25): form controls (90), buttons/submitters (80),
  prices (70 — detected by Unicode currency-symbol regex on text nodes), links with text (60),
  h1-h3 (50), prominent text blocks 40-600 chars (30). Plus bonuses for in-viewport, large
  bbox, aria-label, autocomplete, label-association.
- **Memory budget**: 200 elements max per page; pruning drops lowest-importance non-form elements
  outside viewport. Form controls and CONFIRM-relevant elements never pruned.
- **Output**: `[{id, role, label, selector, value, bbox, importance, attrs, sensitive, formId, priceMatch}]`.
- **Label derivation order**: aria-labelledby → aria-label → `<label for>` → placeholder →
  visible button text → nearby preceding text → humanized `name`/`id` → role fallback.

### `agent-hands.js`

- **Shadow DOM host** appended to `<html>` (NOT `<body>`), `mode: "closed"`. All artifacts (halos,
  badges, annotations, redactors, cursor, status chip, STOP button) live inside.
- **Tracker rAF loop**: one `requestAnimationFrame` reconciles every artifact to its target's
  `getBoundingClientRect()`. Uses `transform: translate3d(...)` for GPU compositing. Auto-pauses
  when `trackers.size === 0`.
- **AUTO tools** (highlight, annotate, scroll_to, inject_badge): create artifact in shadow root,
  register tracker, cursor.moveTo first, then animate.
- **NOTIFY tools** (fill_field, set_select, click, fill_form, simulate_typing): real `input`/
  `change`/`blur` event dispatch. **Native setter trick** for React/Vue: call the property setter
  from `HTMLInputElement.prototype` to bypass framework-patched setters.
- **Typing cadence**: ~32 ms/char with ±50% jitter, seeded RNG. Honors `prefers-reduced-motion`
  (instant fill).
- **Sensitive-field detector**: refuses to type into card/cvc/cvv/sin/ssn/password/cc-* fields
  detected by `type`/`autocomplete`/`name`/`placeholder` patterns (curated multilingual stop-list).
- **`redact_warn`**: visual blur + `pointer-events:auto` event blocker overlay that intercepts
  mousedown/keydown/paste/drop and a document-level `focusin` capture listener that re-blurs.
- **`clear_hands`**: every artifact is recorded in an `artifacts` Set; clear removes all of them.

### `browser-tools.js` (SW-side)

- **`open_tab`**: `chrome.tabs.create({url, active: !background})`. Validates URL (no chrome://).
- **`navigate`**: CONFIRM-only. `chrome.tabs.update(activeTabId, {url})`.
- **`collect_across_tabs`**: serial orchestration — open tab → wait for `LYZA_CS_READY` (or
  `chrome.scripting.executeScript` to inject on demand) → `EYES.read_interactive_map` →
  `EYES.read_page` → close → next. 12s tab-load timeout, 4-8s per-message timeout.
- **`callInTab(tabId, message, {timeout, signal})`** helper: tries direct messaging first; on
  failure injects content scripts via `chrome.scripting.executeScript` and retries.
- **Race handling**: per-tab `AbortController`, `chrome.tabs.onRemoved` listener for user-closed
  anchor tabs, `chrome.webNavigation.onCommitted` for navigation-during-action.

### Visible agency

- **Lyza cursor**: 18px teal circle + 36px halo, animates `Element.animate()` on transform.
  Pre-empt rule: if user's real cursor moves toward the same target, abort and chip "you've
  got it — Lyza paused".
- **Status chip**: top-center, `role="status"`, `aria-live="polite"`, dark teal pill. Auto-fades
  1.4s after `kind:"done"`.
- **STOP button**: lower-right, always visible, keyboard reachable, `Esc Esc` shortcut. Pulses
  while a hands action is in-flight.
- **Reduced motion**: every animation collapses to instant.

---

## 8. Mission state schema (persisted in `chrome.storage.local`)

```ts
Mission = {
  id, goal, createdAt, updatedAt,
  status: "draft"|"active"|"awaiting_user"|"paused"|"completed"|"failed",
  plan: PlanStep[],
  planVersion: number,
  state: {
    cursor: number,
    lastObservation: any,
    pageContextRef: "tab:<id>@<url>" | null,
    counters: {[k]: number},
    workspace: {[k]: any}        // capped 2KB
  },
  constraints: { budget?, region?, radiusKm?, sources?, timeBudgetMs?, maxSteps?, languageOverride? },
  log: LogEntry[],               // capped 200
  escalations: Escalation[],
  stats: { stepsRun, autoCount, notifyCount, confirmAsked, confirmApproved, scamsAvoided, shortlisted }
}
```

Storage layout:
- `lyza_missions_v1` = `{ [missionId]: Mission, ... }` — per-mission O(1) writes
- `lyza_missions_index_v1` = `{ ids: [...], activeId }` — cheap list for Mission Control
- `lyza_missions_log_overflow_v1` — global ring buffer for rolled-off entries

**Capping**: 20 missions max; oldest completed/failed pruned first; never prune active/paused.

---

## 9. Security & privacy

1. **Redact before LLM**: `redact()` strips SIN, full card numbers, account numbers, phones,
   emails, password patterns from `pageData.text` before sending to Gemini. Banner in UI:
   *"Lyza never sends your card numbers, SINs, or passwords to the AI."*
2. **Sensitive-field detector** (see §7) blocks auto-typing of credentials/cards/SIN/government IDs.
3. **Submit-class detector** blocks auto-clicking pay/sign/submit controls — forces CONFIRM.
4. **Origin-change rule**: any hands action across the mission's `originAtPlan` triggers
   CONFIRM with explicit "you're moving from X to Y" copy.
5. **Trusted-Types policy**: `trustedTypes.createPolicy("lyza", {createHTML: s => s})` declared
   at content-script load; all DOM construction inside Shadow DOM via `createElement` +
   `textContent` — never `innerHTML` on host page.
6. **Skip on internal protocols**: content script no-ops on `chrome://`, `chrome-extension://`,
   `about:`, `file://`.
7. **Mission log redaction**: every logged arg goes through `redact()`; payment-class values are
   stored as `payloadHash: sha1(value).slice(0,8)`, never raw.

---

## 10. Build order (24-hour hackathon, ruthless)

Stage 1-3 deliver "AUTO-only mission running hands-free with zero user taps" — the proof point.
Stage 4-7 add the CONFIRM path and external connectors. Stage 8+ is polish.

| # | Step | Hours | Derisks |
|---|---|---|---|
| 1 | `agent-eyes.js`: tagging + `read_interactive_map` + MutationObs. **Test on Kijiji, Marketplace, RBC, government site.** | 3-4 | The single biggest risk. If `el_N` tagging fails on a bank page, CAP 4 is dead. |
| 2 | Shadow DOM + Trusted-Types refactor of `content.js`. Re-test on bank pages. | 2 | Required for CAP 4 to render at all. |
| 3 | `agent-hands.js` AUTO tools: highlight, scroll_to, inject_badge, clear_hands. Tracker rAF loop. Lyza cursor + STOP button + status chip. **CAP 1 walkthrough demonstrable.** | 3 | Highest payoff per hour — this alone wins the demo. |
| 4 | ElevenLabs SW handler + `lyza_elevenlabs_key` settings field + `host_permissions`. Fallback to `speechSynthesis`. | 1.5 | Voice + visible hands = wow combo. |
| 5 | `memory.js` (query API + buildDigest), `missions.js` (CRUD + persistence + alarms), `tools.js` (registry + invoke). Wire AUTO-only tools. | 4 | Persistence spine before the loop. |
| 6 | `loop.js` (LOAD→PLAN→NEXT→ACT→OBSERVE→continue), stub `reflect()`/`replan()`. End-to-end smoke test: mission "annotate every price on this page in CAD" with zero taps. | 4 | The agent-loop milestone. |
| 7 | `planner.js` real call (3 few-shots, tool catalog, memoryDigest). `reflector.js`. Self-healing on `EL_NOT_FOUND`. | 3 | LLM stability. Iterate prompts until 10/10 JSON parses. |
| 8 | Escalation card in shadow DOM + `APPROVE_ESCALATION` round-trip + back-off dedupe. Wire `send_email` (OAuth or template URL). | 2 | The demo's climax beat. |
| 9 | `fill_field` / `fill_form` with simulated typing + sensitive-field detector + redact_warn. Stop-before-submit on real rental form. | 2.5 | CAP 2 — React/Vue form variance is risky. |
| 10 | `browser-tools.js`: open_tab, navigate, **collect_across_tabs** with all §7 failure modes. | 3 | CAP 3 multi-tab autonomy demo. |
| 11 | `redact_warn` + `navigate` CONFIRM card preset for "take me to the real bank". | 1.5 | CAP 4 scam interception. |
| 12 | Mission Control popup tab — live missions, log, escalations. Subscribe via `chrome.storage.onChanged`. | 2.5 | Visual proof of agency. |
| 13 | Proactive interception on mission-active pages (CAP 3 from v4). | 2 | Extends existing v3 `setupProactiveTriggers`. |
| 14 | OAuth client ID for `gmail.send` only (see §12). | 1 | Last; can be cut to template URLs. |

**Total: ~34 hours.** For 24h, target through step 8 (~22h). Steps 9-11 stretch. Steps 12-14 polish.

**Pivotal risk gate**: if steps 1-3 don't work cleanly on Kijiji + Marketplace + a bank page by
hour 8, drop CAP 4 entirely and demo only on Kijiji/Marketplace.

---

## 11. The 3-minute demo script (combined v4 + v5)

1. **Delegate (criterion 1 + 3)**: Maria onboards and states the goal — *"Find a safe 1-bed under
   $1,900 near campus and help me apply."* Lyza: *"On it. I'll work as you browse — watch the page."*
2. **Guided walkthrough (criterion 2 — THE moment)**: On the first Kijiji listing, the page
   **scrolls itself to the price**, a **₹ badge pops in next to it**, the page scrolls to a
   deposit clause and **outlines it in red** while Lyza narrates in Hindi. Maria's hands never move.
3. **Inline currency badges everywhere (criterion 1)**: Every price on the listing now has a live
   INR badge. The page is bilingual.
4. **Memory-driven autonomous work (criterion 3)**: Maria opens 4 more listings, just scrolling.
   The Mission Control chip ticks: *screened 5 · shortlisted 3 · 1 scam auto-skipped (same phone
   number posted ₹400 cheaper Tuesday)*. The agent decided alone using memory.
5. **Multi-tab research (criterion 3)**: Lyza `collect_across_tabs` on the 3 shortlisted listings —
   tabs open and close on their own — and renders a ranked comparison.
6. **Form handling (criterion 3 + 1)**: On the rental application, fields **fill themselves**
   from Maria's profile with visible typing, the SIN field flagged and left blank, labels
   translated. Lyza stops: *"Filled. Approve to submit?"* — one CONFIRM tap.
7. **Live scam defense (criterion 2)**: Maria drifts to a fake-bank look-alike domain. Lyza
   **blurs the card field**, red-outlines the page, narrates: *"This isn't your bank — 11-day-old
   domain, take you to the real one?"* — one CONFIRM tap → `navigate` to the verified URL.
8. **STOP (technical trust)**: Tap STOP mid-action — the hands freeze instantly. *"You can always
   grab the wheel."*
9. **Close on Mission Control (1 + 2 + 3)**: *"In one browsing session: 6 screened, 3 scams
   avoided, ₹40k overpricing dodged, 3 viewings booked. Maria browsed; Lyza drove — and asked
   her to approve exactly twice."*

---

## 12. API keys — the definitive list

```
REQUIRED for the demo
─────────────────────────────────────────────────────────────────────────────
[Gemini]               status: ✅ ALREADY HAVE  (key in service-worker.js)
                       powers: Planner, Reflector, Escalation Explainer,
                               page Reasoner, chat follow-up
                       get at: https://aistudio.google.com/app/apikey
                       cost:   free, 15 RPM / 1500 RPD on gemini-2.5-flash
                       stored: chrome.storage.local["lyza_api_key"]

[ElevenLabs]           status: 🟡 NEEDED — for native-language voice (eleven_multilingual_v2)
                       powers: CAP 1 walkthrough narration, CAP 4 voice approval,
                               status updates in user's language
                       get at: https://elevenlabs.io/app/settings/api-keys (free signup)
                       cost:   free tier ~10,000 chars/month (≈ 40 narrations)
                               → enough for ONE demo + rehearsal; have a backup
                                 account or upgrade to Starter ($5/mo, 30k chars)
                       fallback: browser speechSynthesis (already shipped in v3)
                       stored: chrome.storage.local["lyza_elevenlabs_key"]
                       manifest: add "https://api.elevenlabs.io/*" to host_permissions


OPTIONAL (improves demo, fraud engine still works without)
─────────────────────────────────────────────────────────────────────────────
[Google Safe Browsing] status: 🟢 OPTIONAL — adds the "listed on a malware blocklist" signal
                       powers: Layer 2 blocklist signal in the fraud engine
                       get at: https://console.cloud.google.com
                               → create project → enable "Safe Browsing API"
                               → Credentials → Create API key
                       cost:   free up to 10,000 queries/day
                       fallback: layer-2 already returns "blocklist:unavailable" cleanly;
                                 URL heuristics + RDAP + LLM still run
                       stored: chrome.storage.local["lyza_safebrowsing_key"]


NOT NEEDED (keyless public endpoints, already wired)
─────────────────────────────────────────────────────────────────────────────
[Frankfurter FX]       https://api.frankfurter.dev/v1/latest
                       powers: live FX, inline price badges (CAP 1)
[RDAP domain age]      https://rdap.org/domain/{host}
                       powers: the "11-day-old domain" demo beat (CAP 4)


GOOGLE OAuth (recommended: just ONE scope — gmail.send)
─────────────────────────────────────────────────────────────────────────────
[Google OAuth client]  status: 🟢 OPTIONAL — ~45 min setup, big demo payoff
                       scopes: ONLY https://www.googleapis.com/auth/gmail.send
                       why:    makes the v4 climax actually true — "Approve →
                               Lyza sent 3 emails autonomously". Without OAuth,
                               Lyza opens 3 prefilled Gmail tabs instead.
                       SKIP for Calendar and Drive: template URL and local
                            download already work and the judge can't tell.
                       setup playbook:
                         1. Google Cloud Console → new project "Lyza Demo"
                         2. Enable Gmail API
                         3. OAuth consent screen → External + Testing mode
                            → add your Gmail as test user → scope: gmail.send
                         4. Stabilize extension ID via manifest "key" field
                            (pack extension once, copy key from packed manifest)
                         5. Credentials → OAuth client ID → Chrome app →
                            paste extension ID
                         6. Add oauth2 block to manifest.json and "identity"
                            permission
                       fallback: template URL path (already shipped in v3 code)
```

### Your shopping list (priority-ordered)

1. **ElevenLabs free signup** (~2 min) — voice in user's language
2. **Google Safe Browsing key** in Cloud Console (~5 min) — blocklist signal
3. **Pin extension ID via `key` field** (~5 min) — required for OAuth and hygiene
4. **OAuth client ID for `gmail.send`** (~30-45 min) — IF you want the v4 climax beat

Total setup: **under an hour for everything except OAuth, which is +30-45 min**.

---

## 13. What NOT to build (kept rejected for scope discipline)

The v3 implementation already covers most v2 supporting features (onboarding, history, polish).
Explicitly cut from this plan:
- ❌ ElevenLabs voice cloning / voice picker — ship one good multilingual voice.
- ❌ Shareable safety-report image export — Drive-save action is stronger.
- ❌ Side-by-side window for `compare_tabs` — disruptive; emit a diff table instead.
- ❌ Drive OAuth — local Markdown download is more tactile and zero-setup.
- ❌ Calendar OAuth — template URL is indistinguishable to a judge.
- ❌ Onboarding wizard rewrite — current popup works.
- ❌ Standalone seller-message analyzer tab — folded into `recall_memory` + proactive nudge.
- ❌ Full accessibility deep-pass — do the essentials (focus, ARIA on action bar + STOP +
  escalation, reduced-motion, live region for chip), defer the rest.
- ❌ Stream-mode Gemini calls — JSON mode doesn't benefit; SSE not available in MV3 SW.
- ❌ Keep-alive heartbeat hacks — embrace shutdown, rehydrate from storage.

---

## 14. The one test for every feature under time pressure

> *"Does the agent physically DO this in the browser — move, mark, fill, open, or block — or
> does it just talk? Talk is a chatbot. Hands on the page is the agent."*

Protect the time to make `agent-eyes` + the AUTO hands + the guided walkthrough flawless.
Those are the watchable, undeniable proof of agency that wins criterion 3 and delights on
criterion 2.

---

*End of master plan. Foundation = the rigorous 3-layer fraud engine (v3 ships it).*
*Brain = the Agent Loop with authority model and persistent missions (v4).*
*Body = the browser-action toolset with visible, interruptible agency (v5).*
*Build `agent-eyes` + AUTO hands FIRST — a page that scrolls and lights itself up under the
agent's control, hands-free, is the thing a judge cannot look away from.*
