# Lyza — Financial Acclimation Assistant 🌍

> A Chrome extension that helps newcomers to a country make safe, informed financial
> decisions on any webpage — multilingual summaries, home-currency conversion,
> fair-price context, and scam-risk scoring, in real time.

Built for a hackathon. Manifest V3. Powered by the Google Gemini API.

---

## The problem

Newcomers face unfamiliar financial systems, language barriers, and unknown local
pricing norms. Simple decisions — is this rent fair? is this Marketplace deal a scam?
is this banking offer reasonable? — become risky. The result: overspending, fraud
vulnerability, and low financial confidence during an already stressful transition.

## The solution

Lyza reads the page you're on and gives you, in **your** language:

- **Plain-language summary** of what's being offered
- **Currency conversion** from the local currency to your home currency
- **Fair-price verdict** vs. local market norms (below / average / above average)
- **Scam & fraud risk score** (0–100) with specific red-flag reasons
- **Personalized tips** based on your newcomer profile
- **Follow-up chat** to ask questions about the page

Everything is tailored by an **always-on profile** you set once: country, status,
currencies, language, fluency, and life stage.

---

## How to load it (for the demo)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this `lyza/` folder
4. Click the Lyza icon in the toolbar:
   - **Settings tab** → paste your Gemini API key (`AIza...`) → Save. Get a free key at
     [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
   - **Profile tab** → set your country, currencies, language → Save
5. Visit any marketplace / rental / banking / job page
6. Click the floating **L** button (bottom-right) → **Analyze this page**

> The API key is stored locally in your browser only (`chrome.storage.local`) and is
> sent only to Google. For a hackathon demo this direct-from-browser approach keeps
> the stack to a single moving part. For production you'd proxy calls through a backend.

---

## Suggested demo script (90 seconds)

1. **Profile**: "I'm an international student in Ontario, my home currency is INR, I
   prefer Hindi, low English fluency." → Save.
2. **Marketplace listing** (e.g. an overpriced or sketchy item): open it, click Analyze.
   - Show the Hindi summary, the CA$ → ₹ conversion, the "above average" verdict.
3. **Rental ad with red flags** ("wire a deposit before viewing, I'm out of country"):
   open it, click Analyze → show the **High risk** badge and the listed reasons.
4. **Chat**: ask "Can a landlord ask for first and last month upfront in Ontario?" →
   get a plain-language, newcomer-friendly answer.

---

## Architecture

```
Chrome Extension (Manifest V3)
├── popup/            Always-on profile + API key settings
├── content/          Scrapes the current page, renders the overlay panel + chat
├── background/       Service worker — single Gemini API call does it all:
│                     summary + conversion + price context + scam scoring (JSON)
└── config.js         Profile schema, currencies, languages, defaults
```

**Key design decision:** instead of the original 6-service backend (translation API +
currency API + fraud engine + price engine + LLM + market APIs), Lyza collapses the
whole analysis into **one structured LLM call** that returns JSON. This is faster to
build, cheaper to run, and easy to extend — you can swap in a live FX API or a real
comparable-listings dataset later without changing the UI.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 config, permissions, registrations |
| `config.js` | Profile schema + currency/language lists |
| `popup/*` | Profile & settings UI |
| `content/content.js` | Page scraping, overlay UI, chat |
| `content/overlay.css` | Injected panel styling |
| `background/service-worker.js` | Gemini API orchestration |
| `icons/*` | Extension icons |

## Roadmap (post-hackathon)

- Live FX rates + real comparable-listings price data
- Backend proxy so users don't manage their own API key
- Per-site adapters (Facebook Marketplace, Kijiji, rental portals) for cleaner scraping
- Saved history of analyzed listings
