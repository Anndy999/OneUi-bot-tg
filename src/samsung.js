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
  if (matchType === "local" || matchType === "buyer") return;
  const error = new Error(`SmartHistory 未返回 ${csc} 的精确 CSC 固件记录`);
  error.code = "EXACT_CSC_REQUIRED";
  throw error;
}

function canUseOfficialMetadataFallback(error) {
  const code = String(error?.code || "");
  if (code === "FUS_SMART_HISTORY_EMPTY") return true;
  return code === "FUS_SMART_HISTORY_STATUS" && String(error?.status || "") === "S02";
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
  // Monitoring stays History-only so an incomplete official metadata record
  // can never trigger a false update notification. Interactive and admin
  // queries can use Samsung's official version.xml, matching Bifrost's FOTA
  // first strategy, with SmartHistory as the richer fallback.
  if (options.monitor || options.allowOfficialMetadataFallback !== true) {
    return queryFirmwareHistory(env, model, csc, options);
  }

  const normalized = validateModelCsc(model, csc);
  const startedAt = Date.now();
  if (options.preferOfficialMetadata === true) {
    const metadataStartedAt = Date.now();
    try {
      const version = await resolveOfficialFirmwareVersion(
        env,
        normalized.model,
        normalized.csc,
        options.requestedVersion || "",
        options
      );
      return officialMetadataResult(normalized.model, normalized.csc, version, null, {
        officialMetadataMs: Date.now() - metadataStartedAt,
        totalMs: Date.now() - startedAt,
        singleFlightJoined: false
      });
    } catch (metadataError) {
      try {
        return await queryFirmwareHistory(env, normalized.model, normalized.csc, options);
      } catch (historyError) {
        // Preserve the more useful official endpoint error when both Samsung
        // endpoints have no usable record for this exact model/CSC.
        if (canUseOfficialMetadataFallback(historyError)) throw metadataError;
        throw historyError;
      }
    }
  }

  try {
    return await queryFirmwareHistory(env, normalized.model, normalized.csc, options);
  } catch (historyError) {
    if (!canUseOfficialMetadataFallback(historyError)) throw historyError;
    const historyMs = Date.now() - startedAt;
    const metadataStartedAt = Date.now();
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
  }
}

export async function queryFirmware(model, csc, env = {}) {
  return queryFirmwareHistory(env, model, csc);
}
