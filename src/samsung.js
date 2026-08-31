import {
  historyRequestTimeoutMs,
  historyTotalDeadlineMs
} from "./config.js";
import { querySmartHistory, resolveOfficialFirmwareVersion } from "./fus.js";
import { parseSamsungFirmwareString } from "./firmware-version.js";
import { docUrl } from "./utils.js";
import { validateModelCsc } from "./targets.js";

const smartHistoryFlights = new Map();

function serviceClass(options = {}) {
  if (options.monitor) return "monitor";
  if (options.role === "admin") return "admin";
  return "interactive";
}

function requestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : signal;
}

function waitForShared(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function singleFlightSmartHistory(env, model, csc, options = {}) {
  const role = serviceClass(options);
  const requestedVersion = String(options.requestedVersion || "").trim().toUpperCase();
  const key = `${role}:${model}:${csc}:${requestedVersion}`;
  let shared = smartHistoryFlights.get(key);
  const joined = Boolean(shared);
  if (!shared) {
    // The upstream task owns its timeout. A caller cancelling its own wait must
    // not abort the shared Samsung request for other callers.
    const upstreamSignal = AbortSignal.timeout(historyTotalDeadlineMs(env));
    const timing = {};
    shared = Promise.resolve()
      .then(() => querySmartHistory(env, model, csc, {
        signal: upstreamSignal,
        timeoutMs: historyRequestTimeoutMs(env),
        role,
        monitor: Boolean(options.monitor),
        requestedVersion,
        timing
      }))
      .then((parsed) => ({ parsed, timing }))
      .finally(() => {
        if (smartHistoryFlights.get(key) === shared) smartHistoryFlights.delete(key);
      });
    smartHistoryFlights.set(key, shared);
  }
  const callerSignal = options.signal
    ? requestSignal(options.signal, historyTotalDeadlineMs(env))
    : null;
  return waitForShared(shared, callerSignal).then((value) => ({ ...value, joined }));
}

function wrapParsed(parsed, model, csc, rawOutput, extra = {}) {
  const value = {
    ok: true,
    model,
    csc,
    latest: parsed.latest,
    pda: parsed.pda,
    cscVersion: parsed.cscVersion,
    modem: parsed.modem || parsed.pda || "N/A",
    android: parsed.android || "未知",
    rawAndroid: parsed.rawAndroid || "",
    rawLatest: parsed.rawLatest || parsed.latest,
    versionDetails: parsed.versionDetails || parseSamsungFirmwareString(parsed.pda || parsed.latest),
    buildDate: parsed.buildDate || parsed.smartHistory?.openDate || "",
    smartHistory: parsed.smartHistory || null,
    docUrl: parsed.docUrl || docUrl(model, csc),
    rawOutput,
    source: "Samsung FUS SmartHistory",
    sourceType: "smart_history",
    selectedSource: "history",
    fallbackUsed: false,
    fallbackReason: null,
    degraded: false,
    ...extra
  };
  return {
    model,
    csc,
    rawOutput,
    parsed: value,
    ...value
  };
}

function requireExactCsc(parsed, csc) {
  const matchType = String(parsed?.smartHistory?.cscMatchType || "").toLowerCase();
  // The SmartHistory request itself is scoped by the requested CSC. Bifrost
  // trusts generic BINARY_INFO rows returned by that scoped request, so accept
  // them here as well while still rejecting explicitly foreign rows.
  if (matchType === "local" || matchType === "buyer" || matchType === "generic") return;
  const error = new Error(`SmartHistory 未返回 ${csc} 的精确 CSC 固件记录`);
  error.code = "EXACT_CSC_REQUIRED";
  throw error;
}

function canUseOfficialMetadataFallback(error, options = {}) {
  // A caller cancellation must stay cancelled; every upstream SmartHistory
  // failure is otherwise eligible for the public version.xml fallback.
  if (options.signal?.aborted || error?.name === "AbortError") return false;
  return true;
}

function officialMetadataResult(model, csc, version, historyError, queryTiming) {
  const parts = String(version || "").split("/").map((part) => part.trim()).filter(Boolean);
  const pda = parts[0] || String(version || "");
  const parsed = {
    latest: version,
    pda,
    cscVersion: parts[1] || pda,
    modem: parts[2] || pda,
    android: "未知",
    rawAndroid: "",
    rawLatest: version,
    versionDetails: parseSamsungFirmwareString(pda),
    buildDate: "",
    smartHistory: null,
    rawOutput: ""
  };
  return wrapParsed(parsed, model, csc, "", {
    source: "Samsung FOTA version.xml",
    sourceType: "version_xml",
    selectedSource: "version_xml",
    fallbackUsed: Boolean(historyError),
    fallbackReason: historyError ? String(historyError.message || historyError) : null,
    degraded: Boolean(historyError),
    queryTiming
  });
}

export async function queryFirmwareHistory(env, model, csc, options = {}) {
  const normalized = validateModelCsc(model, csc);
  const startedAt = Date.now();
  const shared = await singleFlightSmartHistory(env, normalized.model, normalized.csc, options);
  const parsed = shared.parsed;
  requireExactCsc(parsed, normalized.csc);
  const historyMs = Date.now() - startedAt;
  const result = wrapParsed(parsed, normalized.model, normalized.csc, parsed.rawOutput || "", {
    queryTiming: {
      ...shared.timing,
      historyMs,
      singleFlightJoined: shared.joined
    },
    ...(parsed.requestedVersion ? { requestedVersion: parsed.requestedVersion } : {})
  });
  result.parsed.queryTiming = result.queryTiming;
  return result;
}

export async function queryFirmwareHybrid(env, model, csc, options = {}) {
  // Bifrost-compatible source order: SmartHistory is the primary latest-version
  // source. version.xml remains a fallback for interactive/admin queries only
  // when History has no usable scoped record or the History request fails.
  // Monitoring stays History-first/History-only to avoid promoting an
  // incomplete metadata tuple to an automatic release notification.
  if (options.monitor || options.allowOfficialMetadataFallback !== true) {
    return queryFirmwareHistory(env, model, csc, options);
  }

  const normalized = validateModelCsc(model, csc);
  const startedAt = Date.now();
  try {
    return await queryFirmwareHistory(env, normalized.model, normalized.csc, options);
  } catch (historyError) {
    if (!canUseOfficialMetadataFallback(historyError, options)) throw historyError;
    const historyMs = Date.now() - startedAt;
    const metadataStartedAt = Date.now();
    try {
      const version = await resolveOfficialFirmwareVersion(
        env,
        normalized.model,
        normalized.csc,
        options.requestedVersion || "",
        options
      );
      return officialMetadataResult(normalized.model, normalized.csc, version, historyError, {
        historyMs,
        officialMetadataMs: Date.now() - metadataStartedAt,
        totalMs: Date.now() - startedAt,
        singleFlightJoined: false
      });
    } catch {
      // When both sources fail, retain SmartHistory's exact-CSC diagnostics
      // (including official alternatives) instead of replacing them with a
      // less actionable version.xml transport error.
      throw historyError;
    }
  }
}

export async function queryFirmware(model, csc, env = {}) {
  return queryFirmwareHistory(env, model, csc);
}
