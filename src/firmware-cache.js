import {
  firmwareCacheFreshSeconds,
  firmwareCacheStaleSeconds
} from "./config.js";
import { firmwareCacheValue, firmwareVersionFingerprint } from "./utils.js";
import { analyzeFirmwareHistory } from "./firmware-version.js";

function parsedTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) && time > 0 ? time : 0;
}

function isoAt(time) {
  return new Date(time).toISOString();
}

function deadlineFromFetchedAt(fetchedAt, ttlSeconds, fallbackNow) {
  const base = parsedTime(fetchedAt) || fallbackNow;
  return base + Math.max(1, Number(ttlSeconds || 1)) * 1000;
}

export function isExactSmartHistory(value) {
  if (value?.sourceType !== "smart_history") return false;
  const matchType = String(value?.smartHistory?.cscMatchType || "").toLowerCase();
  // "generic" still comes from a SmartHistory request scoped with the exact
  // requested BINARY_LOCAL_CODE. Bifrost does not require Samsung to echo the
  // CSC fields inside every BINARY_INFO row, especially for newly staged builds.
  return matchType === "local" || matchType === "buyer" || matchType === "generic";
}

export function resultSnapshot(value) {
  if (!value?.latest) return null;
  const fetchedAt = value.fetchedAt || value.historyFetchedAt || new Date().toISOString();
  const rawSequence = value.sequence ?? value.smartHistory?.sequence;
  return {
    latest: value.latest,
    rawLatest: value.rawLatest || value.latest,
    versionDetails: value.versionDetails || null,
    versionFingerprint: firmwareVersionFingerprint(value.latest),
    pda: value.pda,
    cscVersion: value.cscVersion,
    modem: value.modem,
    android: value.android,
    buildDate: value.buildDate || value.smartHistory?.openDate || "",
    securityPatch: value.securityPatch || value.smartHistory?.securityPatch || "",
    sequence: rawSequence !== null && rawSequence !== undefined && rawSequence !== "" && Number.isFinite(Number(rawSequence))
      ? Number(rawSequence)
      : null,
    country: value.country,
    docUrl: value.docUrl,
    source: "Samsung FUS SmartHistory",
    sourceType: "smart_history",
    smartHistory: value.smartHistory || null,
    fetchedAt
  };
}

function mergeHistoryChain(existing, incomingSnapshot) {
  const entries = Array.isArray(existing?.historyChain) ? [...existing.historyChain] : [];
  if (!entries.length && isExactSmartHistory(existing?.history)) {
    entries.push({
      version: existing.history.latest,
      buildDate: existing.history.buildDate || "",
      securityPatch: existing.history.securityPatch || "",
      sequence: existing.history.sequence ?? existing.history.smartHistory?.sequence ?? null,
      observedAt: existing.history.fetchedAt || ""
    });
  }
  if (incomingSnapshot?.latest) {
    const fingerprint = firmwareVersionFingerprint(incomingSnapshot.latest);
    const entry = {
      version: incomingSnapshot.latest,
      buildDate: incomingSnapshot.buildDate || "",
      securityPatch: incomingSnapshot.securityPatch || "",
      sequence: incomingSnapshot.sequence ?? incomingSnapshot.smartHistory?.sequence ?? null,
      observedAt: incomingSnapshot.fetchedAt || new Date().toISOString()
    };
    const existingIndex = entries.findIndex((value) => firmwareVersionFingerprint(value.version) === fingerprint);
    if (existingIndex >= 0) entries.splice(existingIndex, 1);
    entries.push(entry);
  }
  return entries.slice(-20);
}

/**
 * Build the canonical cache from a request-scoped SmartHistory result only.
 * Explicitly foreign CSC rows are rejected before this point. Legacy
 * non-authoritative fields are intentionally not copied forward.
 */
export function buildFirmwareCacheRecord(env, existing, model, csc, parsed, now = Date.now()) {
  const incoming = firmwareCacheValue("global", model, csc, parsed);
  if (!isExactSmartHistory(incoming)) {
    const error = new Error(`Refusing to cache non-scoped SmartHistory for ${model}/${csc}`);
    error.code = "EXACT_HISTORY_CACHE_REQUIRED";
    throw error;
  }

  const history = resultSnapshot(incoming);
  const historyChain = mergeHistoryChain(existing, history);
  const historyAnalysis = analyzeFirmwareHistory(historyChain);
  const staleDeadline = deadlineFromFetchedAt(history.fetchedAt, firmwareCacheStaleSeconds(env), now);
  const freshDeadline = Math.min(
    now + firmwareCacheFreshSeconds(env) * 1000,
    staleDeadline
  );

  return {
    ...incoming,
    ...history,
    chatId: "global",
    model,
    csc,
    history,
    historyChain,
    historyAnalysis,
    selectedSource: "history",
    source: "Samsung FUS SmartHistory",
    sourceType: "smart_history",
    degraded: false,
    fallbackUsed: false,
    fallbackReason: "",
    regionExact: true,
    regionMatchType: history.smartHistory?.cscMatchType || "",
    historyFetchedAt: history.fetchedAt,
    servedAt: isoAt(now),
    cachedAt: history.fetchedAt,
    freshUntil: isoAt(freshDeadline),
    staleUntil: isoAt(staleDeadline)
  };
}
