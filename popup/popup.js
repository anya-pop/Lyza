// popup.js — Profile + settings UI logic.
import {
  CURRENCIES,
  LANGUAGES,
  NEWCOMER_STATUS,
  TIME_IN_COUNTRY,
  FLUENCY,
  HOUSING,
  JOB,
  IMMIGRATION_STAGE,
  DEFAULT_PROFILE,
  STORAGE_KEYS
} from "../config.js";

// ---- Populate dropdowns --------------------------------------------------

function fill(id, items, valueKey = "value", labelKey = "label") {
  const el = document.getElementById(id);
  el.innerHTML = items
    .map((it) => `<option value="${it[valueKey]}">${it[labelKey]}</option>`)
    .join("");
}

fill("status", NEWCOMER_STATUS);
fill("timeInCountry", TIME_IN_COUNTRY);
fill("localCurrency", CURRENCIES, "code", "label");
fill("homeCurrency", CURRENCIES, "code", "label");
fill("language", LANGUAGES, "code", "label");
fill("fluency", FLUENCY);
fill("housing", HOUSING);
fill("job", JOB);
fill("immigrationStage", IMMIGRATION_STAGE);

// ---- Tabs ----------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// ---- Load / save profile -------------------------------------------------

const TEXT_FIELDS = ["country", "province"];
const SELECT_FIELDS = [
  "status",
  "timeInCountry",
  "localCurrency",
  "homeCurrency",
  "language",
  "fluency",
  "housing",
  "job",
  "immigrationStage"
];

async function loadProfile() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
  const profile = { ...DEFAULT_PROFILE, ...(stored[STORAGE_KEYS.PROFILE] || {}) };
  TEXT_FIELDS.forEach((f) => (document.getElementById(f).value = profile[f] || ""));
  SELECT_FIELDS.forEach((f) => (document.getElementById(f).value = profile[f]));
  document.getElementById("simplify").checked = !!profile.simplify;
}

document.getElementById("save").addEventListener("click", async () => {
  const profile = {};
  TEXT_FIELDS.forEach((f) => (profile[f] = document.getElementById(f).value.trim()));
  SELECT_FIELDS.forEach((f) => (profile[f] = document.getElementById(f).value));
  profile.simplify = document.getElementById("simplify").checked;
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: profile, [STORAGE_KEYS.ONBOARDED]: true });
  const msg = document.getElementById("saved-msg");
  msg.textContent = "✓ Profile saved";
  setTimeout(() => (msg.textContent = ""), 2000);
});

// ---- API key -------------------------------------------------------------

async function loadKey() {
  const { lyza_api_key } = await chrome.storage.local.get("lyza_api_key");
  if (lyza_api_key) document.getElementById("apiKey").value = lyza_api_key;
}

document.getElementById("saveKey").addEventListener("click", async () => {
  const key = document.getElementById("apiKey").value.trim();
  await chrome.storage.local.set({ lyza_api_key: key });
  const msg = document.getElementById("key-msg");
  msg.textContent = key ? "✓ Key saved" : "Key cleared";
  setTimeout(() => (msg.textContent = ""), 2000);
});

loadProfile();
loadKey();
