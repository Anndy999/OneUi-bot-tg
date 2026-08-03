import {
  historyRequestTimeoutMs,
  historyTotalDeadlineMs
} from "./config.js";
import { querySmartHistory } from "./fus.js";
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
  const key = `${role}:${model}:${csc}`;
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
    }
  });
  result.parsed.queryTiming = result.queryTiming;
  return result;
}

// Backwards-compatible public name. v2.5 is deliberately History-only:
// legacy non-authoritative endpoints are intentionally excluded because they can lag or omit
// newly published One UI branches.
export async function queryFirmwareHybrid(env, model, csc, options = {}) {
  return queryFirmwareHistory(env, model, csc, options);
}

export async function queryFirmware(model, csc, env = {}) {
  return queryFirmwareHistory(env, model, csc);
}
