import { countryForCsc } from "./csc.js";
import { validateModelCsc } from "./targets.js";

const suggestionCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

const GROUPS = {
  china: new Set(["CHC", "CHN", "CHM", "CHU", "TGY", "BRI"]),
  europe: new Set([
    "EUX", "EUY", "BTU", "DBT", "XEF", "ITV", "PHE", "PHN", "AUT", "LUX", "NEE",
    "BGL", "ROM", "SEK", "SER", "TUR", "FTM"
  ]),
  northAmerica: new Set(["XAA", "XAR", "XAC", "ATT", "TMB", "VZW", "USC", "SPR", "CCT", "CHA"]),
  korea: new Set(["KOO", "SKC", "KTC", "LUC"]),
  japan: new Set(["DCM", "KDI", "SBM", "XJP"]),
  southeastAsia: new Set(["XSP", "SIN", "MM1", "XME", "THL", "MYM", "XXV", "GLB", "INS", "BNG"]),
  middleEastAfrica: new Set(["XSG", "MID", "EGY", "ILO", "AFR", "ACR", "DKR", "XFA", "XFE"]),
  oceania: new Set(["XSA", "NZC"]),
  latinAmerica: new Set(["ZTO", "ARO", "COO", "TPA", "EON"])
};

const ZH_PRIORITY = ["CHC", "CHN", "TGY", "BRI", "CHM", "CHU", "KOO", "XSP", "EUX", "XAA"];
const EN_PRIORITY = ["EUX", "XAA", "BTU", "XAC", "XSA", "XSG", "INS", "DBT", "XEF", "TGY"];

function groupForCsc(csc) {
  const value = String(csc || "").toUpperCase();
  for (const [group, values] of Object.entries(GROUPS)) {
    if (values.has(value)) return group;
  }
  return "other";
}

function modelFamilyGroup(model) {
  const value = String(model || "").toUpperCase();
  if (/C$/.test(value) || /^SM-(?:S|A|F|M)\d+0$/.test(value)) return "china";
  if (/U1?$/.test(value)) return "northAmerica";
  if (/W$/.test(value)) return "northAmerica";
  if (/N$/.test(value)) return "korea";
  if (/(?:J|D)$/.test(value)) return "japan";
  if (/(?:B|F)$/.test(value)) return "europe";
  return "other";
}

function openDateValue(value) {
  const text = String(value || "").replace(/[^0-9]/g, "");
  return /^\d{8}$/.test(text) ? Number(text) : 0;
}

function sequenceValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : -1;
}

function normalizeOption(option) {
  const csc = String(option?.csc || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(csc)) return null;
  return {
    csc,
    country: String(option?.country || countryForCsc(csc)),
    latest: String(option?.latest || "").trim(),
    pda: String(option?.pda || "").trim(),
    android: String(option?.android || "").trim(),
    openDate: String(option?.openDate || "").trim(),
    sequence: Number.isFinite(Number(option?.sequence)) ? Number(option.sequence) : null,
    localCode: String(option?.localCode || "").trim().toUpperCase(),
    buyerCode: String(option?.buyerCode || "").trim().toUpperCase()
  };
}

export function normalizeOfficialCscOptions(options = []) {
  const byCsc = new Map();
  for (const raw of Array.isArray(options) ? options : []) {
    const option = normalizeOption(raw);
    if (!option) continue;
    const previous = byCsc.get(option.csc);
    if (!previous || openDateValue(option.openDate) > openDateValue(previous.openDate) ||
      (openDateValue(option.openDate) === openDateValue(previous.openDate) && sequenceValue(option.sequence) > sequenceValue(previous.sequence))) {
      byCsc.set(option.csc, option);
    }
  }
  return [...byCsc.values()];
}

function priorityIndex(csc, lang) {
  const values = lang === "zh" ? ZH_PRIORITY : EN_PRIORITY;
  const index = values.indexOf(csc);
  return index < 0 ? values.length + 10 : index;
}

function scoreOption(option, context = {}) {
  const requestedCsc = String(context.requestedCsc || "").toUpperCase();
  const requestedGroup = groupForCsc(requestedCsc);
  const candidateGroup = groupForCsc(option.csc);
  const familyGroup = modelFamilyGroup(context.model);
  const lang = context.lang === "en" ? "en" : "zh";
  let score = 0;

  if (candidateGroup === requestedGroup && requestedGroup !== "other") score += 420;
  if (candidateGroup === familyGroup && familyGroup !== "other") score += 320;
  if (lang === "zh" && candidateGroup === "china") score += 260;
  if (lang === "en" && ["europe", "northAmerica"].includes(candidateGroup)) score += 120;

  score += Math.max(0, 180 - priorityIndex(option.csc, lang) * 12);
  score += Math.min(90, Math.max(0, openDateValue(option.openDate) - 20200000) / 10000);
  score += Math.min(40, Math.max(0, sequenceValue(option.sequence)) / 10);

  // A one-character CSC difference is useful when the user made a typo, but it
  // is deliberately weaker than region/model evidence.
  if (requestedCsc.length === 3) {
    let same = 0;
    for (let i = 0; i < 3; i += 1) if (requestedCsc[i] === option.csc[i]) same += 1;
    score += same * 35;
  }
  return score;
}

export function rankOfficialCscOptions(options, context = {}) {
  return normalizeOfficialCscOptions(options)
    .map((option) => ({ ...option, score: scoreOption(option, context) }))
    .sort((a, b) => b.score - a.score || openDateValue(b.openDate) - openDateValue(a.openDate) || a.csc.localeCompare(b.csc));
}

function cacheKey(model, requestedCsc) {
  try {
    const target = validateModelCsc(model, requestedCsc);
    return target.key;
  } catch {
    return `${String(model || "").toUpperCase()}:${String(requestedCsc || "").toUpperCase()}`;
  }
}

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of suggestionCache) {
    if (entry.expiresAt <= now) suggestionCache.delete(key);
  }
  while (suggestionCache.size > CACHE_MAX) suggestionCache.delete(suggestionCache.keys().next().value);
}

export function cacheOfficialCscSuggestions(model, requestedCsc, options) {
  const normalized = normalizeOfficialCscOptions(options);
  if (!normalized.length) return [];
  suggestionCache.set(cacheKey(model, requestedCsc), {
    options: normalized,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  pruneCache();
  return normalized;
}

export function getCachedOfficialCscSuggestions(model, requestedCsc) {
  pruneCache();
  return suggestionCache.get(cacheKey(model, requestedCsc))?.options || [];
}

export function clearOfficialCscSuggestionCache() {
  suggestionCache.clear();
}

export function formatCscOptionLabel(option, lang = "zh") {
  const country = option.country && option.country !== "Unknown" ? option.country : "";
  if (lang === "en") return country ? `${option.csc} · ${country}` : option.csc;
  return country ? `${option.csc} · ${country}` : option.csc;
}
