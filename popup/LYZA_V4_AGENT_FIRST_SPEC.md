# LYZA v4 — Agent-First (The Autonomous Redesign)

> **The v3→v4 shift in one line:** v3 was *human-initiated with nice actions bolted on the end*
> (you open a page, Lyza analyzes, you tap an action). v4 **inverts control**: you give Lyza a
> **goal**, and the agent **plans, works across pages and apps in the background, decides on its
> own, and only interrupts you for high-stakes approvals.**
>
> Built backwards from the rubric, with one ruthless test applied to every feature:
> **"Could a non-agentic chatbot+buttons do this?" If yes, it's cut.**

---

## 0. The honest critique of v3 (so v4 doesn't repeat it)

v3 added connector actions — good — but the *control loop* was still human-driven:

```
v3:  USER opens page → Lyza analyzes ONE page → USER taps an action → done.
```

That's a smart assistant, not an agent. A true agent owns a **loop** and a **goal**:

```
v4:  USER states a GOAL → Lyza PLANS steps → Lyza ACTS across many pages/apps,
     OBSERVES results, RE-PLANS, persists state, and ESCALATES to the user only
     when a decision exceeds its authority → reports back when the goal is met.
```

The four properties that make something *agentic* (and that judges' criterion 3 names directly):
**takes action · maintains context · coordinates tasks · makes decisions / runs workflows that
wouldn't otherwise be possible.** v4 is organized entirely around delivering all four as one loop.

---

## 1. The product, reframed (again, harder)

**Lyza is an autonomous financial agent you delegate goals to.** You don't operate Lyza page by
page. You tell it what you're trying to accomplish, and it runs the mission:

- *"Find me a safe 1-bedroom under $1,900 near campus."*
- *"Vet this Marketplace seller and close the deal safely if it checks out."*
- *"Watch my bills and never let me miss a payment in my first year."*

Lyza turns each goal into a **standing mission** with a plan, executes steps as you browse (and
proactively when it can), keeps a running memory, makes the small decisions itself, and **escalates
only the big ones**. That delegation — goal in, mission run, approval-gated escalations — is the
agent-first core.

---

## 2. The agent architecture (this is the project now)

Everything below is in service of one **Agent Loop** running in the service worker.

```
                ┌──────────────────────────────────────────────────┐
                │                  LYZA AGENT LOOP                   │
                │                                                    │
   GOAL ───────▶│  PLAN ──▶ ACT ──▶ OBSERVE ──▶ REFLECT ──▶ (loop)   │──▶ REPORT
   (delegated)  │    ▲                              │                │
                │    └────────── re-plan ───────────┘                │
                │                    │                               │
                │              ESCALATE? ──yes──▶ ask user (approve)  │
                └──────────────────────────────────────────────────┘
                         persistent MISSION STATE + MEMORY
```

### 2.1 Components to build

| Component | File | Role |
|---|---|---|
| **Mission Manager** | `agent/missions.js` | CRUD for standing goals; each mission has `{ id, goal, plan[], state, constraints, log[], status }`. Persisted in `chrome.storage.local`. |
| **Planner** | `agent/planner.js` | LLM call: goal + memory + current page → an ordered `plan[]` of steps, each with a `tool` and `successCriteria`. Re-invoked to re-plan when observations diverge. |
| **Tool Registry** | `agent/tools.js` | The actions the agent can take. Each tool = `{ name, authority, run(payload) }`. (See 2.3.) |
| **Executor / Loop** | `agent/loop.js` | Runs PLAN→ACT→OBSERVE→REFLECT; writes to mission log; decides escalation via the authority model. |
| **Reasoner** | reuse `background/fraud-engine.js` + Claude | The rigorous 3-layer verdict that informs decisions (from v2 spec — keep verbatim). |
| **Memory** | `agent/memory.js` | Structured long-term store the planner/reasoner read before every decision. |
| **Escalation UI** | content overlay | The ONLY time the agent demands attention: an approval card for high-authority actions. |

### 2.2 The authority model (how it "makes decisions" safely)

Every tool has an **authority level**. This is what lets the agent act autonomously *and* stay
trustworthy — it's the decision-making the rubric rewards, made legible:

| Authority | Meaning | Examples | Needs user? |
|---|---|---|---|
| `AUTO` | Reversible, zero-cost, private | log to memory, rate a listing, compute a fair-price baseline, draft (not send) text, file a note to Drive | No — just do it, show in log |
| `NOTIFY` | Acts, but worth telling you | set a calendar reminder, flag a scam in memory, add a listing to a shortlist | No, but surfaces a passive notification |
| `CONFIRM` | Sends/commits something external or irreversible | send an email, submit a form, report to a platform, anything touching money | **Yes — escalation card, explicit approval** |

The agent runs `AUTO`/`NOTIFY` steps on its own and **only stops the user for `CONFIRM`**. That single
rule is the heart of "agent-first but safe." Say it in the pitch: *"Lyza does everything reversible
on its own and only asks you before it does something it can't take back."*

### 2.3 The tool registry (concrete, all realizable with what you have)

```js
// agent/tools.js — each tool is callable by the loop with an LLM-generated payload.
export const TOOLS = {
  // --- perception ---
  read_page:        { authority: "AUTO",    run: scrapeAndAnalyzeCurrentPage },   // fraud engine + LLM
  recall_memory:    { authority: "AUTO",    run: queryMemory },                   // cross-reference history
  compute_baseline: { authority: "AUTO",    run: computePersonalFairRange },      // from memory of seen prices
  fx_convert:       { authority: "AUTO",    run: liveFxConvert },                  // Frankfurter, keyless

  // --- private side effects (no user needed) ---
  remember:         { authority: "AUTO",    run: writeMemory },
  shortlist_add:    { authority: "NOTIFY",  run: addToShortlist },
  flag_scammer:     { authority: "NOTIFY",  run: logScammerToMemory },
  drive_save:       { authority: "NOTIFY",  run: saveSummaryToDrive },            // Drive connector
  calendar_remind:  { authority: "NOTIFY",  run: createCalendarReminder },        // Calendar connector

  // --- external / irreversible (CONFIRM required) ---
  draft_email:      { authority: "AUTO",    run: createGmailDraft },              // draft only = reversible
  send_email:       { authority: "CONFIRM", run: sendGmailMessage },              // sending = irreversible
  submit_form:      { authority: "CONFIRM", run: fillAndSubmitForm },             // touches the real world
  report_platform:  { authority: "CONFIRM", run: reportListing }
};
```

> Note the deliberate split: `draft_email` is `AUTO` (a draft harms nothing), `send_email` is
> `CONFIRM`. The agent can prepare everything autonomously and only pause at the irreversible edge.

---

## 3. The four agent-first capabilities (each is the loop doing something a chatbot can't)

### ⭐ CAP 1 — Delegated Missions (goal in → autonomous execution)  → Criterion 3 (workflows) + 1

The user creates a mission in plain language. Lyza runs it **as you browse and in the background**.

**Worked example — mission: "Find a safe 1-bed under $1,900 near campus":**
1. PLAN → `[read_page, recall_memory, compute_baseline, score_listing, shortlist_add | flag_scammer, draft_inquiry?]`
2. As the user browses Kijiji/Marketplace listings, **every listing page auto-runs the loop**:
   `read_page` → fraud verdict + FX → `recall_memory` (seen before? same landlord?) →
   `compute_baseline` (is it within the user's fair range?) → decision:
   - within budget + low risk + fair → `shortlist_add` (NOTIFY) + `draft_inquiry` (AUTO draft)
   - scammy → `flag_scammer` (NOTIFY), skip
3. When the shortlist hits 3, Lyza **escalates once**: *"I've found 3 safe, fairly-priced options and
   drafted inquiries for each. Want me to send them?"* → `send_email` is `CONFIRM` → user approves all.
4. Mission log shows everything Lyza did unprompted. **That log is the proof of agency** — show it.

This is impossible with a chatbot: it's a standing goal driving autonomous, cross-page, cross-app
work with a single human checkpoint at the irreversible step.

### ⭐ CAP 2 — Persistent Memory the agent reasons from  → Criterion 3 (context) + 2 (magical)

Same as v3's memory, but now it's **an input to the loop's decisions**, not a passive log. Before
any `score_listing` decision the agent calls `recall_memory` + `compute_baseline`, so it reasons
*with* your history:

- *"This is the 8th listing this week; your personal fair range is ₹X–₹Y. This is above it → not
  shortlisting."* (the agent **decided** using memory)
- *"Same phone number as a cheaper listing on Tuesday → flagging as likely duplicate-listing scam,
  skipping automatically."* (the agent **acted** on a memory cross-reference, no user needed)

The "Mission Control" dashboard (popup) shows live missions, the running log, the learned baselines,
scams auto-avoided, and pending escalations. One screen that screams *agent*.

### ⭐ CAP 3 — Proactive Interception driven by the mission, not the page  → Criterion 2 (magical) + 3 (decisions)

The agent watches for moments relevant to its **active missions** and acts/intervenes on its own:

- Mission "never miss a bill" is standing → user opens any invoice/utility page → agent silently
  `read_page`, extracts the due date, runs `calendar_remind` (NOTIFY), and passively notifies: *"Added
  a reminder 3 days before your $84 hydro bill is due."* No tap required.
- Any mission active → user about to enter card details on an 11-day-old / flagged domain → agent
  **interrupts** (this is a `CONFIRM`-class risk to the user): *"Stop — I checked this site, it's
  11 days old and on a watchlist. I don't recommend continuing."*

The agent decides *when* to act and *whether* to interrupt based on authority + risk. That judgment
is the agentic behavior; the magic is that it happens without being summoned.

### ⭐ CAP 4 — Voice status & approvals (hands-free agent)  → Criterion 2 (human) + 1 (access)

Because the agent works in the background, **voice becomes its natural I/O**, not a gimmick:
- The user can *speak/confirm escalations* and Lyza *narrates what it did and what it needs* — in the
  user's native language via ElevenLabs `eleven_multilingual_v2`.
- *"I screened 6 listings, shortlisted 3, avoided 1 scam. I need your okay to send 3 inquiries."*
  Hands-free, in Hindi. For a low-fluency newcomer this is the difference between using it and not.

---

## 4. What changes vs v3 (delta, so you don't rebuild from zero)

You **keep** from prior specs: the 3-layer fraud engine (v2), connectors, FX, voice handler, memory
schema. You **add** the agent layer on top and **flip** the interaction model:

| | v3 | v4 |
|---|---|---|
| Trigger | User opens panel per page | User delegates a standing **mission** |
| Who decides | User taps each action | Agent decides; user approves only `CONFIRM` |
| Scope | One page at a time | Across pages, tabs, sessions, and apps |
| Proof of agency | A list of buttons | A **mission log** of autonomous steps + a planner |
| Memory | Stored | **Read into every decision** by the loop |

Net new code: `agent/` folder (missions, planner, tools, loop, memory) + Mission Control popup view
+ escalation card. Everything else is reused.

---

## 5. The Planner & loop contracts (implementable, concrete)

**Planner output** (LLM, given `{ goal, constraints, currentPage, memoryDigest }`):
```json
{
  "plan": [
    { "step": 1, "tool": "read_page",        "args": {}, "successCriteria": "page classified + risk scored" },
    { "step": 2, "tool": "recall_memory",    "args": { "match": "host,seller,priceBand" } },
    { "step": 3, "tool": "compute_baseline", "args": { "category": "rental_1bed" } },
    { "step": 4, "tool": "DECIDE",           "args": { "rule": "shortlist if risk=low AND price<=budget AND within_baseline" } },
    { "step": 5, "tool": "draft_inquiry",    "args": { "onlyIf": "shortlisted" } }
  ],
  "escalateWhen": "shortlist reaches 3 OR a CONFIRM-tool is required"
}
```

**Loop step result** (what the executor writes to the mission log each iteration):
```json
{
  "ts": 0, "step": 4, "tool": "DECIDE", "observation": "risk=low, $1,850 <= $1,900, within ₹range",
  "decision": "shortlist_add + draft_inquiry", "authority": "AUTO/NOTIFY", "escalated": false
}
```

**Escalation card** (content overlay, the only forced UI) shows: what the agent wants to do, *why*
(its reasoning + the evidence), the exact payload preview (e.g. the 3 emails), and **Approve / Edit /
Decline**. Approving a `CONFIRM` tool is the single human gate.

**Executor rules:**
- Run `AUTO` immediately; run `NOTIFY` and emit a passive toast; **queue `CONFIRM`** and raise the
  escalation card.
- After each tool, OBSERVE (capture result) → REFLECT (LLM: did this meet `successCriteria`? if not,
  re-plan from current state).
- Persist mission state after every step so it survives navigation, tab close, and browser restart —
  *the mission outlives the page*, which is the whole point.
- If a connector is unauthorized → escalate a one-tap "Connect Google," and fall back to a local
  draft so the mission never dead-ends.

---

## 6. Build order (24h, agent-first priority)

> The demo must show **delegate → autonomous multi-step work → single approval → report**.

1. **Reuse** fraud engine + connectors + memory schema (decisions must be rigorous first).
2. **Mission Manager + Memory** (`missions.js`, `memory.js`) — state that persists across pages.
3. **Loop + Tool Registry + Authority model** (`loop.js`, `tools.js`) — wire `read_page`,
   `recall_memory`, `compute_baseline`, `remember`, `shortlist_add` (the AUTO/NOTIFY core). Get the
   loop running end-to-end on a single mission with **no user taps**.
4. **Planner** (`planner.js`) — LLM turns a goal into a plan; re-plan on divergence.
5. **Escalation card** + the `CONFIRM` tools (`send_email`, `report_platform`). This is the human gate.
6. **Mission Control popup** — live missions, log, baselines, escalations. (The "proof of agency" UI.)
7. **Proactive interception** (CAP 3) + **Voice status/approval** (CAP 4).
8. Onboarding that ends by **creating the user's first mission** (not just setting a profile).

Verify each stage: the loop should complete an AUTO-only mission with zero user interaction and write
a visible log; then add the single CONFIRM gate.

---

## 7. The 3-minute demo (scripted, agent-first)

1. **Delegate (criterion 1+3):** Onboarding ends with Maria saying her goal — *"Find a safe 1-bed
   under $1,900 near campus."* Lyza: *"On it. I'll watch listings as you browse and handle the rest."*
   No per-page operation by the user from here on.
2. **Autonomous work (criterion 3 — THE moment):** Maria just *scrolls Kijiji*. The Mission Control
   badge ticks up live: *screened 6 · shortlisted 3 · 1 scam auto-skipped · 3 inquiries drafted.* She
   never clicked Lyza once. *Say: "She's just browsing. Lyza is working."*
3. **Memory-driven decision (criterion 3 — context):** Open the log: *"Skipped listing #4 — same
   phone number posted ₹X less on Tuesday (duplicate-listing scam). Skipped #6 — ₹2,300 is above your
   ₹1,650–1,900 range."* The agent **decided these alone** using memory.
4. **Single escalation (criterion 2 — magical + safe autonomy):** Lyza raises ONE card: *"3 safe,
   fairly-priced options, inquiries drafted. Approve sending?"* Maria taps Approve → 3 Gmail messages
   send + 3 calendar holds created. *Say: "Everything reversible, it did itself. It only asked me for
   the one thing it couldn't take back."*
5. **Proactive guardian (criterion 2):** Mid-demo, Maria wanders to a sketchy site asking for card
   details → Lyza interrupts unprompted: *"Stop — 11-day-old domain, on a watchlist."*
6. **Voice (criterion 2 — human):** Lyza narrates the mission status in Hindi, hands-free.
7. **Close on Mission Control (criterion 1+2+3):** *"In one browsing session: 6 screened, 3 scams
   avoided, ₹40k overpricing dodged, 3 viewings booked — Maria approved one thing. That's an agent."*

---

## 8. Pitch lines, mapped to the rubric

- **Real problem (10):** *"Newcomers face a financial system and language that isn't theirs, alone.
  Lyza is the financial agent that runs the gauntlet for them."*
- **Creative / magical (10):** *"You don't operate Lyza. You delegate to it. It works while you just
  browse — and stops you the instant before a scam."*
- **AI agents (10):** *"Give Lyza a goal. It plans, screens listings across pages, reasons from
  everything it remembers, drafts the emails, books the viewings — autonomously — and asks you for
  approval only at the one irreversible step. It decides, acts, and coordinates a workflow no chatbot
  could. That's the whole point."*

---

## 9. The one-test for scope discipline

For every feature you consider adding under time pressure, ask:
**"Does this make the agent more autonomous, more context-aware, or better at deciding — or is it
just another button?"** If it's just a button, cut it. The agent loop, the authority model, the
mission log, and the memory-driven decisions are what win criterion 3 — protect the time to make
those four flawless.

---

*End of v4. Foundation = rigorous 3-layer engine (v2). Architecture = the Agent Loop (PLAN·ACT·
OBSERVE·REFLECT) with an authority model and persistent missions. Build the AUTO/NOTIFY loop running
hands-free FIRST — a mission completing with zero user taps is the thing that proves this is an
agent, not an assistant.*
