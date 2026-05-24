// config.js — Shared constants and the "always-on profile" schema.
// Loaded as a classic script where needed; the service worker imports it as a module.

export const CURRENCIES = [
  { code: "USD", label: "US Dollar", symbol: "$" },
  { code: "CAD", label: "Canadian Dollar", symbol: "CA$" },
  { code: "EUR", label: "Euro", symbol: "€" },
  { code: "GBP", label: "British Pound", symbol: "£" },
  { code: "INR", label: "Indian Rupee", symbol: "₹" },
  { code: "CNY", label: "Chinese Yuan", symbol: "¥" },
  { code: "PHP", label: "Philippine Peso", symbol: "₱" },
  { code: "MXN", label: "Mexican Peso", symbol: "$" },
  { code: "NGN", label: "Nigerian Naira", symbol: "₦" },
  { code: "BRL", label: "Brazilian Real", symbol: "R$" },
  { code: "PKR", label: "Pakistani Rupee", symbol: "₨" },
  { code: "ARS", label: "Argentine Peso", symbol: "$" },
  { code: "COP", label: "Colombian Peso", symbol: "$" },
  { code: "VND", label: "Vietnamese Dong", symbol: "₫" },
  { code: "KRW", label: "South Korean Won", symbol: "₩" }
];

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español (Spanish)" },
  { code: "zh", label: "中文 (Mandarin)" },
  { code: "ar", label: "العربية (Arabic)" },
  { code: "hi", label: "हिन्दी (Hindi)" },
  { code: "fr", label: "Français (French)" },
  { code: "tl", label: "Tagalog" },
  { code: "pt", label: "Português (Portuguese)" },
  { code: "ko", label: "한국어 (Korean)" },
  { code: "vi", label: "Tiếng Việt (Vietnamese)" },
  { code: "ur", label: "اردو (Urdu)" }
];

export const NEWCOMER_STATUS = [
  { value: "student", label: "International student" },
  { value: "pr", label: "Permanent resident" },
  { value: "work", label: "Work permit" },
  { value: "refugee", label: "Refugee / protected person" },
  { value: "other", label: "Other / prefer not to say" }
];

export const TIME_IN_COUNTRY = [
  { value: "0-6", label: "0–6 months" },
  { value: "6-24", label: "6–24 months" },
  { value: "2+", label: "2+ years" }
];

export const FLUENCY = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];

export const HOUSING = [
  { value: "searching", label: "Searching" },
  { value: "renting", label: "Renting" },
  { value: "stable", label: "Stable" }
];

export const JOB = [
  { value: "searching", label: "Searching" },
  { value: "employed", label: "Employed" },
  { value: "gig", label: "Gig work" }
];

export const IMMIGRATION_STAGE = [
  { value: "early", label: "Early paperwork" },
  { value: "settled", label: "Settled" },
  { value: "renewal", label: "Renewal phase" }
];

// Default profile used until the user customizes it.
export const DEFAULT_PROFILE = {
  // Identity & settlement
  country: "Canada",
  province: "Ontario",
  status: "student",
  timeInCountry: "0-6",
  // Currency
  localCurrency: "CAD",
  homeCurrency: "INR",
  // Language
  language: "en",
  fluency: "low",
  simplify: true,
  // Life stage
  housing: "searching",
  job: "searching",
  immigrationStage: "early"
};

export const STORAGE_KEYS = {
  PROFILE: "lyza_profile",
  ONBOARDED: "lyza_onboarded"
};
