# LYZA v3 — The Agentic Redesign (Judge-Optimized Spec)

> **The shift in one line:** Lyza stops being a *panel that explains pages* and becomes a
> **financial guardian agent** that **takes action, remembers, and runs workflows** a newcomer
> couldn't do alone — across the page, Gmail, Calendar, and Drive.
>
> This document is built **backwards from the rubric**. Every feature below is here because it
> directly earns points in one of the three 10-point criteria. If a feature didn't score, it was cut.

---

## 0. Read this first — why the old plan loses, why this wins

The previous spec was *feature-rich but reactive*: scrape page → show panel → user reads. Under
**these** judges, that caps out fast, because:

- **Criterion 3 (AI agents, 10pts)** explicitly rewards *"AI that goes beyond simple chat
  interfaces by taking action, maintaining context, coordinating tasks, making decisions, or
  enabling workflows that wouldn't otherwise be possible."* A read-only panel does **none** of these.
- **Criterion 2 (creative/magical, 10pts)** rewards *"memorable interactions… surprisingly helpful,
  human, or magical."* Another summarizer isn't magical.
- **Criterion 1 (real problem, 10pts)** we already nail — newcomer finances — but we must show the
  agent *resolving* the pain, not just *describing* it.

**The redesign principle:** for every insight Lyza produces, it must offer a *consequence* — an
action it can take on the user's behalf. Insight without action is a chatbot. Insight → action →
follow-through is an agent.

---

## 1. The product, reframed

**Lyza is a financial guardian agent for newcomers.** It lives in the browser, watches the
financial decisions you're about to make (a rental, a Marketplace deal, a bank offer, a job, a
bill), and does three agentic things a newcomer can't easily do alone:

1. **DECIDES** — runs a rigorous, multi-source verdict (safe? fair? legal?) and commits to a clear
   recommendation, not a wishy-washy summary.
2. **ACTS** — takes the next real-world step for you: drafts the safe reply, files the listing to a
   "Decisions" folder, books the viewing in your calendar, sets a deposit-reminder, reports the
   scam — using your connected Gmail / Calendar / Drive.
3. **REMEMBERS** — maintains a persistent memory of every place, price, landlord, and seller you've
   encountered, so it can say *"this is the same number that posted a different price last week"* or
   *"you've now seen 6 apartments; here's what fair looks like for you."*

That triad — **Decide, Act, Remember** — is literally the rubric's language for criterion 3. Say it
in the pitch.

---

## 2. The four hero features (each maps to the rubric)

Build these four. They are disruptive, realizable in a hackathon, and each is a demo beat.

### ⭐ HERO 1 — "Handle this for me" agentic action bar  → Criterion 3 (action) + 1 (real problem)

After any analysis, Lyza shows **2–4 one-tap actions it can actually execute**, chosen by the agent
based on page type and risk. This is the single most important feature. Examples:

| Situation Lyza detected | One-tap action Lyza performs (via connectors) |
|---|---|
| Rental listing, looks fair | **"Book a viewing"** → creates a Google Calendar event with the address, listing URL, and a checklist of questions to ask; **"Draft inquiry"** → writes a safe, fluent message to the landlord in English from your profile |
| Rental, scammy | **"Report & walk away"** → drafts a report to the platform + logs the scammer's details to memory + creates a "do-not-contact" note |
| Marketplace deal, fair | **"Draft a safe offer"** → composes a negotiation message that never shares personal/banking info and insists on in-person Interac/cash |
| Bank/credit offer | **"Save & set review reminder"** → files a plain-language summary to Drive + sets a Calendar reminder before any promo rate expires |
| Bill / invoice | **"Add due date"** → creates a Calendar reminder 3 days before the due date so a newcomer never misses a payment and tanks their new credit score |
| Any high-value decision | **"Get a second opinion"** → drafts an email to a trusted contact (settlement worker / friend) with Lyza's summary attached |

**Implementation:** the LLM, given the page analysis + user profile, returns an `actions[]` array
where each action has `{ id, label, type, payload }`. `type` ∈ `calendar_event | gmail_draft |
drive_save | memory_log | platform_report`. The service worker executes the chosen action through
the matching connector (MCP) when the user taps it. **Always preview before sending** — show the
drafted email/event and require a confirm tap. (Agentic, but human-in-the-loop = trustworthy.)

> Realizable note: you already have Gmail, Calendar, Drive connectors. Each action is one connector
> call with an LLM-generated payload. This is the highest-impact-per-line-of-code feature you can
> ship.

### ⭐ HERO 2 — Persistent "Financial Memory"  → Criterion 3 (context/memory) + 1 (real problem)

Lyza remembers everything financial it has seen and **uses it to make better decisions over time**.
This is what makes it an agent, not a tool.

- Every analysis writes a structured record to `chrome.storage.local` under `lyza_memory`:
  `{ ts, kind, host, title, url, priceAmount, priceCurrency, sellerHandle, verdict, scamScore,
  notes }`.
- On each NEW analysis, the agent **queries its own memory first** and surfaces cross-references:
  - *"⚠️ This phone number appeared on a listing last Tuesday at a different price — possible
    duplicate-listing scam."*
  - *"You've viewed 7 one-bedrooms in this area; the fair range you've seen is $1,650–$1,900.
    This one at $2,300 is high."*  ← the agent computed YOUR personal market baseline.
  - *"This landlord's email matches one you already contacted on March 3."*
- A **"My financial picture"** view in the popup: total of rents/deals considered, scams avoided,
  money saved (sum of overpricing Lyza flagged), upcoming reminders it set. This screen alone is a
  pitch-closing visual.

**Implementation:** before the LLM call, load relevant memory (same host / similar price band /
matching seller handle) and inject it into the prompt as context, so the model reasons *with
history*. After, append the new record. Pure local storage + smart prompt injection — no backend.

### ⭐ HERO 3 — Proactive "Decision Coach" that interrupts at the right moment  → Criterion 2 (magical) + 3 (decisions)

Lyza doesn't wait to be opened. A lightweight content-script watcher detects **financially risky
moments** and proactively surfaces a small, dismissible nudge — *before* the user acts:

- User is about to **type into a payment / card field on a freshly-registered or flagged domain** →
  Lyza slides in: *"Pause — this site was registered 11 days ago and asks for card details. Want me
  to check it first?"*
- User opens a **Marketplace message thread** → Lyza offers: *"Want me to screen this seller's
  messages for scam patterns as you chat?"*
- A page contains a **wire-transfer / e-transfer request + urgency language** → instant amber strip.

This "right place, right moment" proactivity is what reads as *magical* to judges — the agent
anticipates instead of waiting. Keep it rare and respectful (max one nudge per page, easily muted)
so it feels helpful, not spammy.

**Implementation:** a small set of cheap, deterministic triggers in the content script (focus on
`input[type=password|tel|number]`, presence of card-like fields, detection of payment keywords,
the domain-age signal from the fraud engine). When a trigger fires, show the nudge; only call the
LLM if the user accepts. (Cheap to run, big perceived intelligence.)

### ⭐ HERO 4 — Voice "Walk me through it" mode  → Criterion 2 (delightful/human) + 1 (low-literacy access)

For a newcomer with low reading fluency, **voice isn't a gimmick — it's accessibility**. Lyza
explains the decision and the action it's about to take, **out loud, in the user's native
language**, via ElevenLabs `eleven_multilingual_v2`.

- A single **"Walk me through it 🔊"** button narrates: what the page is → is it safe → is the price
  fair → what Lyza recommends → what action it can take. All from the already-translated analysis.
- Bonus magical beat: after narrating a high-risk verdict, Lyza *speaks the warning first, then
  highlights the exact scam phrases on the page* in sync.

**Implementation:** the TTS handler from the prior spec (`/v1/text-to-speech/{voice_id}`, base64
back to the content script, `new Audio().play()`). Tie the spoken script to the analysis + chosen
action so voice and action stay consistent.

---

## 3. The rigorous core that makes the actions trustworthy (keep + tighten)

The agent can only *act* safely because its *decisions* are rigorous. Keep the **3-layer hybrid
fraud engine** from the prior spec — it's the substance behind the magic:

1. **Deterministic URL/domain heuristics** (instant, offline): IP-host, `@` in URL, Punycode,
   homoglyphs, suspicious TLDs, excessive subdomains, typosquatting vs. a brand list (Levenshtein),
   no-HTTPS, phishy host words, URL length.
2. **Live signals**: Google Safe Browsing lookup (optional key) + **domain age via RDAP** (keyless;
   <90 days = strong signal).
3. **LLM content reasoning**: urgency, off-platform payment, wire/e-transfer demands, "I'm abroad",
   overpayment, document requests — returns `contentScamSignals`.

Fuse with the max-aware blend (a Safe Browsing hit or very-new domain forces HIGH). Every verdict
shows its **breakdown** so it's explainable. Real FX rate via keyless Frankfurter API for accurate
home-currency conversion. **This rigor is the credibility floor that lets judges trust the
agentic actions.** (Full code for all of this is in the prior spec, `LYZA_V2_SPEC.md` — reuse it
verbatim.)

---

## 4. What to CUT (so it's realizable in the time you have)

Disruptive ≠ bloated. Drop or defer these from the old list — they don't move the rubric enough:

- ❌ Shareable image/report export → replaced by the far stronger Drive-save action.
- ❌ Standalone seller-message analyzer tab → folded into HERO 3 (proactive message screening).
- ❌ Separate confidence indicator UI → keep `confidence` in the data, show inline, no extra UI.
- ⏸ Voice picker / cloning → ship one good multilingual voice; defer customization.
- ⏸ Accessibility deep-pass → do the essentials (focus, ARIA on the action bar, reduced-motion),
  defer the rest.

Spend the saved time making the **action bar + memory** flawless, because those two carry
criterion 3.

---

## 5. Build order (ruthless, 24h-realistic)

> Goal: a demo where Lyza **detects → decides → acts → remembers**, end to end, on two pages.

1. **Reuse** the existing extension + the 3-layer fraud engine from `LYZA_V2_SPEC.md` (decisions
   must be rigorous before actions matter).
2. **HERO 2 (Memory)** — storage schema + write-on-analysis + read-into-prompt + the
   "My financial picture" popup view. *(Do this early; other features read from it.)*
3. **HERO 1 (Action bar)** — LLM returns `actions[]`; implement the three connector executors
   (Calendar event, Gmail draft, Drive save) + the **preview-then-confirm** flow + `memory_log`.
   *(This is the win. Polish it most.)*
4. **HERO 3 (Proactive coach)** — deterministic triggers + single non-intrusive nudge.
5. **HERO 4 (Voice)** — ElevenLabs narration of decision + action.
6. Real FX conversion, onboarding, the high-risk banner — finishing touches.

Verification after each: load in `chrome://extensions`, no console errors, one happy-path action
executes end-to-end (e.g. tapping "Add due date" really creates a Calendar event you can see).

---

## 6. Connector action contract (the heart of HERO 1)

The LLM, given `{ analysis, profile, memoryHits }`, returns:

```json
{
  "recommendation": "one decisive sentence in the user's language — what Lyza advises",
  "actions": [
    {
      "id": "book_viewing",
      "label": "Book a viewing",                // shown on the button, user's language
      "type": "calendar_event",
      "payload": {
        "title": "Apartment viewing — 123 Main St",
        "when_hint": "propose 3 slots over the next 4 days, 6-8pm",
        "location": "123 Main St, Toronto",
        "description": "Listing: <url>. Questions to ask: ...",
        "checklist": ["Ask about deposit terms", "Confirm what's included", "..."]
      }
    },
    {
      "id": "draft_inquiry",
      "label": "Draft inquiry to landlord",
      "type": "gmail_draft",
      "payload": {
        "to": "",                                // leave blank if unknown; user fills
        "subject": "Inquiry about your listing",
        "body": "Polite, fluent English inquiry written from the user's profile, asks the right newcomer questions, never shares SIN/banking info"
      }
    }
  ]
}
```

**Executor rules (service worker):**
- `calendar_event` → resolve `when_hint` into concrete slots (LLM or simple date math), create event
  via the Calendar connector.
- `gmail_draft` → create a **draft** (never auto-send) via the Gmail connector; open it for review.
- `drive_save` → write a markdown summary file to a "Lyza – Financial Decisions" folder via Drive.
- `memory_log` / `platform_report` → local + drafted content.
- **Every** action shows a preview card and a **Confirm** button before the connector call fires.
  Human-in-the-loop is non-negotiable: it's both safer and more impressive (the agent proposes, the
  user approves).

> If a connector isn't authorized, show a one-tap "Connect Google" prompt and degrade to copy-to-
> clipboard so the demo never dead-ends.

---

## 7. The 3-minute demo (scripted to the rubric)

1. **Setup (criterion 1):** "Maria, international student, week 2 in Toronto, reads Hindi, home
   currency INR." (Onboarding already configured.)
2. **Rigorous decision (foundation):** Open a real rental listing → Lyza: live CAD→INR conversion,
   "fair for this area," **Low risk** with breakdown. *Say: "this isn't a guess — here's the
   evidence."*
3. **Memory magic (criterion 3 - context):** Open a second listing → Lyza: *"You've now seen 4
   places; your fair range is ₹X–₹Y. This one's 20% above — and this phone number also posted a
   cheaper unit Tuesday."* *Say: "it remembers and reasons across everything you've seen."*
4. **Agentic action (criterion 3 - action — THE moment):** Tap **"Book a viewing"** → Lyza drafts a
   Calendar event with a question checklist; tap **"Draft inquiry"** → a fluent English email
   appears in Gmail drafts. *Say: "Maria's English is shaky — Lyza didn't explain how to write the
   email, it wrote it, and put the viewing on her calendar."*
5. **Proactive guardian (criterion 2 - magical):** Navigate to a scammy page that asks for card
   details on an 11-day-old domain → Lyza interrupts **before** she types: *"Pause — this is risky."*
   Tap **"Report & walk away"** → drafts the report, logs the scammer to memory.
6. **Voice (criterion 2 - human):** Hit **"Walk me through it"** → Lyza explains the whole decision
   aloud in Hindi.
7. **Close on the dashboard (criterion 1 + 2):** Open "My financial picture": *3 scams avoided,
   ₹40,000 in overpricing flagged, 2 reminders set.* *Say: "In two weeks, Lyza has been Maria's
   financial second set of eyes — deciding, acting, and remembering, in her language, on every
   page."*

---

## 8. Pitch lines that explicitly hit each criterion

- **Real problem (10):** "Newcomers lose money to scams and overpaying every single day, in a system
  and language that isn't theirs. Lyza is the financial guardian they don't have."
- **Creative/magical (10):** "It doesn't wait to be asked. It interrupts the moment before you get
  scammed, and it talks you through the decision in your own language."
- **AI agents (10):** "Lyza decides, acts, and remembers. It books the viewing, drafts the email,
  files the offer, sets the reminder — and reasons across everything you've seen. That's not a
  chatbot. That's an agent doing the work a newcomer can't do alone."

---

*End of v3 spec. Foundation = the rigorous 3-layer engine (from v2 spec). Differentiation = Decide,
Act, Remember. Build HERO 2 then HERO 1 first — they carry the agent criterion that the old plan
completely missed.*
