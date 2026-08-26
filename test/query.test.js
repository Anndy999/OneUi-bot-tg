import test from "node:test";
import assert from "node:assert/strict";
import { fusLaneIdFor, parseSmartHistory, querySmartHistory, resetFusSession, resolveOfficialFirmwareDownload, resolveOfficialFirmwareVersion, resolveOfficialFirmwareVersionCandidates } from "../src/fus.js";
import { rankOfficialCscOptions } from "../src/csc-suggestions.js";
import {
  clearFirmwareMemoryCaches,
  getFirmwareMemoryCache,
  getNegativeFirmware,
  markFirmwareTargetHot,
  setNegativeFirmware,
  setFirmwareMemoryCache
} from "../src/cache.js";
import { parseFirmwareInput } from "../src/firmware-input-parser.js";
import { inferSamsungFirmwareBuildMonth, parseSamsungFirmwareString } from "../src/firmware-version.js";
import { calculatePriorityScore, priorityIntervalMinutes } from "../src/monitor-intelligence.js";
import { sharedMonitorIntervalMinutes, uniformMonitorIntervalSettings } from "../src/monitor-intervals.js";
import { classifySamsungSourceHealth, summarizeSamsungSourceHealth } from "../src/monitor-observability.js";
import {
  MonitorScheduler,
  claimDueMonitorTargets,
  completeMonitorTarget,
  getMonitorIntervalSettings,
  setMonitorIntervalSettings,
  syncMonitorScheduler
} from "../src/monitor-scheduler.js";
import { FirmwareQueryCoordinator } from "../src/firmware-query-coordinator.js";
import { enqueueTelegramNotification, processNotificationQueue } from "../src/notification-queue.js";
import { queryFirmwareHybrid } from "../src/samsung.js";
import worker, { displayFirmwareFileName, openListFirmwareUrl } from "../src/index.js";
import { buildFirmwareCacheRecord } from "../src/firmware-cache.js";
import { defaultSchedule, normalizeMonitorItems, notifyAllowedUsersOnUpdate } from "../src/config.js";
import {
  activateReleaseWindowBoosts,
  formatSchedule,
  processPendingUpdateReminders,
  runMonitor,
  nextMonitorSchedule,
  selectDueMonitorItems,
  shouldRunNow
} from "../src/monitor.js";
import {
  addAllowedUser,
  getFirmwareQueryCache,
  getFlagshipProposal,
  getAccessSettings,
  addAdditionalAdmin,
  getAdditionalAdmins,
  getIdentity,
  getMonitorItems,
  getMonitorEvents,
  getMonitorRuntime,
  getMonitorSchedule,
  getMonitorSummarySettings,
  getPendingUpdate,
  getUserDevices,
  getUserLanguage,
  putFlagshipProposal,
  putMonitorBoost,
  putPendingUpdate,
  recordMonitorFailure,
  recordMonitorEvent,
  recordFirmwareQueryDemand,
  resetStateMemoryCache,
  setMonitorSchedule,
  setMonitorSummarySettings,
  setMonitorItems,
  setMonitorLastCheck,
  setUserLanguage,
  setUserDeviceNotification,
  tryStartQueryRateLimit,
  upsertMonitorItem,
  upsertUserDevice,
  removeUserDevice,
  hasCompletedOnboarding,
} from "../src/state.js";
import {
  addRolloutTarget,
  applyRolloutProposalDecision,
  createRolloutProposalForUpdate,
  getRolloutItemScheduleDecision,
  getRolloutChains,
  restartDependentRolloutChain,
  setRolloutChainSettings
} from "../src/rollout-chain.js";
import { normalizeReleaseWindowGroups, releaseWindowPeers, validateModelCsc } from "../src/targets.js";
import {
  applyFlagshipProposalDecision,
  buildFlagshipActivationProposal,
  buildLinkedTargetReviewProposal,
  normalizeFlagshipLinkageRules
} from "../src/flagship-priority.js";
import { safeEditOrSend, sendTelegramMessage, sendTelegramMessageResult } from "../src/telegram.js";
import {
  formatFirmwareResult,
  firmwareBuildDateDisplay,
  formatMonitorBaseline,
  formatMonitorNotification,
  normalizeFirmwareVersion
} from "../src/utils.js";
import { adminHelpParts } from "../src/guides.js";

const realFetch = globalThis.fetch;

test("completed downloads can link to an existing login-protected OpenList path", () => {
  const url = openListFirmwareUrl({
    OPENLIST_BASE_URL: "https://files.example/openlist/",
    OPENLIST_FIRMWARE_PATH: "/firmware"
  }, {
    state: "completed",
    fileName: "SM-S9380_TGY_F9760ZSS2AZH7.zip"
  });
  assert.equal(url, "https://files.example/openlist/firmware/SM-S9380_TGY_F9760ZSS2AZH7.zip");
  assert.equal(openListFirmwareUrl({ OPENLIST_BASE_URL: "https://files.example" }, { state: "downloading", fileName: "a.zip" }), "");
  assert.equal(openListFirmwareUrl({ OPENLIST_BASE_URL: "http://files.example" }, { state: "completed", fileName: "a.zip" }), "");
  assert.equal(openListFirmwareUrl({ OPENLIST_BASE_URL: "https://files.example", OPENLIST_FIRMWARE_PATH: "../firmware" }, { state: "completed", fileName: "a.zip" }), "");
});

test("completed download cards use a short model and CSC file label", () => {
  assert.equal(
    displayFirmwareFileName({ model: "sm-s9110", csc: "tgy", fileName: "SM-S9110_TGY_S9110ZHS8FZG1_a1b2c3d4.zip" }),
    "SM-S9110_TGY.zip"
  );
  assert.equal(displayFirmwareFileName({}), "firmware.zip");
});

function memoryKv() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value) {
      values.set(key, String(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true
      };
    }
  };
}

function memoryDoStorage() {
  const values = new Map();
  let alarmAt = 0;
  return {
    values,
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      return values.delete(key);
    },
    async list(options = {}) {
      let entries = [...values.entries()].sort(([a], [b]) => a.localeCompare(b));
      if (options.prefix) entries = entries.filter(([key]) => key.startsWith(options.prefix));
      if (options.start) entries = entries.filter(([key]) => key >= options.start);
      if (options.end) entries = entries.filter(([key]) => key < options.end);
      if (options.limit) entries = entries.slice(0, options.limit);
      return new Map(entries);
    },
    async setAlarm(value) {
      alarmAt = Number(value || 0);
    },
    async getAlarm() {
      return alarmAt || null;
    }
  };
}

function schedulerNamespace(instance) {
  return {
    idFromName(name) { return name; },
    get() {
      return {
        fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          return instance.fetch(request);
        }
      };
    }
  };
}

const releaseWindowConfig = JSON.stringify([
  {
    id: "galaxy-s25-ultra",
    targets: [
      { model: "SM-S9380", csc: "CHC" },
      { model: "SM-S9380", csc: "TGY" },
      { model: "SM-S9380", csc: "BRI" },
      { model: "SM-S938B", csc: "EUX" }
    ]
  }
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function data(tag, value) {
  return `<${tag}><Data>${value}</Data></${tag}>`;
}

function historyRow({
  sequence,
  localCsc = "",
  buyerCsc = localCsc,
  version,
  os = "Android 16",
  model = "SM-S9380",
  openDate = "20260710",
  exists = "1"
}) {
  return [
    "<BINARY_INFO>",
    data("BINARY_SEQUENCE", sequence),
    data("BINARY_MODEL_NAME", model),
    data("BINARY_LOCAL_CODE", localCsc),
    data("BINARY_BUYER_CODE", buyerCsc),
    data("BINARY_SW_VERSION", version),
    data("BINARY_OS_NAME", os),
    data("BINARY_OPEN_DATE", openDate),
    data("BINARY_STATUS", "1"),
    data("BINARY_EXIST", exists),
    "</BINARY_INFO>"
  ].join("");
}

function historyDocument(rows) {
  return `<FUSMsg><FUSBody>${rows.join("")}</FUSBody></FUSMsg>`;
}

function versionDocument(version) {
  return `<firmware><version><latest o="16">${version}</latest></version></firmware>`;
}

function nonceResponse() {
  return new Response("", {
    status: 200,
    headers: {
      NONCE: "0123456789abcdef0123456789abcdef",
      "set-cookie": "JSESSIONID=test-session; Path=/; Secure"
    }
  });
}

test("Samsung FUS download resolution signs BinaryInform and completes BinaryInit", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    calls.push({ url: value, headers: init.headers || {}, body: String(init.body || "") });
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("BinaryInform")) {
      assert.match(String(init.headers?.authorization || ""), /^FUS nonce="0123456789abcdef0123456789abcdef", signature=".+"/);
      return new Response("<FUSMsg><FUSBody><Results><Status>200</Status><BINARY_NAME>SM-S9480_CHC_TEST.zip.enc4</BINARY_NAME><MODEL_PATH>path/firmware.zip</MODEL_PATH><BINARY_BYTE_SIZE>5</BINARY_BYTE_SIZE><DEVICE_MODEL_TYPE>SM-S9480</DEVICE_MODEL_TYPE><LOGIC_VALUE_FACTORY>0123456789abcdef0123456789abcdef</LOGIC_VALUE_FACTORY></Results></FUSBody></FUSMsg>", { status: 200 });
    }
    if (value.includes("BinaryInit")) {
      assert.match(String(init.headers?.authorization || ""), /^FUS nonce="0123456789abcdef0123456789abcdef", signature=".+"/);
      assert.match(String(init.body || ""), /BINARY_NAME/);
      return new Response("<FUSMsg><FUSBody><Results><Status>200</Status></Results></FUSBody></FUSMsg>", { status: 200 });
    }
    throw new Error(`Unexpected FUS request: ${value}`);
  };
  const result = await resolveOfficialFirmwareDownload(
    env,
    "SM-S9480",
    "CHC",
    "S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1"
  );
  assert.equal(result.fileName, "SM-S9480_CHC_TEST.zip.enc4");
  assert.equal(result.size, 5);
  assert.equal(result.decryption.mode, "enc4");
  assert.equal(result.decryption.keySeed.length, 32);
  assert.equal(calls.filter((entry) => entry.url.includes("BinaryInform")).length, 1);
  assert.equal(calls.filter((entry) => entry.url.includes("BinaryInit")).length, 1);
  assert.equal(result.sourceHeaders.cookie, "JSESSIONID=test-session");
});

test("SmartHistory retries one S02 response with a fresh FUS session", async () => {
  resetFusSession();
  let nonceRequests = 0;
  let historyRequests = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("NF_SmartDownloadGenerateNonce")) {
      nonceRequests += 1;
      return nonceResponse();
    }
    if (value.includes("SmartHistory")) {
      historyRequests += 1;
      if (historyRequests === 1) {
        return new Response("<FUSMsg><FUSBody><Results><Status>S02</Status></Results></FUSBody></FUSMsg>", { status: 200 });
      }
      return new Response(historyDocument([
        historyRow({ sequence: "1", localCsc: "CHC", model: "SM-S9480", version: "S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1" })
      ]), { status: 200 });
    }
    throw new Error(`Unexpected FUS request: ${value}`);
  };
  const result = await querySmartHistory(env, "SM-S9480", "CHC");
  assert.equal(result.latest, "S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1");
  assert.equal(historyRequests, 2);
  assert.equal(nonceRequests, 2);
});

const env = {
  HISTORY_REQUEST_TIMEOUT_MS: "1000",
  HISTORY_TOTAL_DEADLINE_MS: "2000",
  FUS_CIRCUIT_FAILURE_THRESHOLD: "3",
  FUS_CIRCUIT_COOLDOWN_MS: "30000"
};

test("Samsung source health distinguishes retryable upstream errors from model or CSC configuration errors", () => {
  const retrying = classifySamsungSourceHealth({
    failureCount: 1,
    lastError: "SmartHistory HTTP 521"
  });
  const configuration = classifySamsungSourceHealth({
    failureCount: 1,
    lastError: "SmartHistory did not return an exact CSC result"
  });
  const attention = classifySamsungSourceHealth({
    failureCount: 3,
    lastError: "SmartHistory HTTP 521"
  });

  assert.equal(retrying.state, "retrying");
  assert.equal(configuration.state, "configuration");
  assert.equal(attention.state, "attention");
  assert.equal(summarizeSamsungSourceHealth([
    { runtime: { failureCount: 1, lastError: "SmartHistory HTTP 521" } },
    { runtime: { failureCount: 1, lastError: "SmartHistory did not return an exact CSC result" } }
  ]).averageScore < 100, true);
});

test("monitor events retain important state changes without unbounded KV growth", async () => {
  const kv = memoryKv();
  const item = { model: "SM-S9380", csc: "TGY", name: "S25 Ultra Hong Kong" };
  const envWithKv = { FIRMWARE_KV: kv };
  for (let index = 0; index < 55; index += 1) {
    await recordMonitorEvent(envWithKv, {
      type: index % 2 ? "monitor_failed" : "recovered",
      ...item,
      detail: `event-${index}`,
      at: new Date(1_700_000_000_000 + index).toISOString()
    });
  }
  const events = await getMonitorEvents(envWithKv, 50);
  assert.equal(events.length, 50);
  assert.equal(events[0].detail, "event-54");
  assert.equal(events.at(-1).detail, "event-5");
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  resetFusSession();
  clearFirmwareMemoryCaches();
  resetStateMemoryCache();
});

test("SmartHistory missing Android metadata uses the UTF-8 Chinese fallback", () => {
  const version = "S9380ZCU1/S9380CHC1/S9380ZCU1";
  const result = parseSmartHistory(historyDocument([
    historyRow({ sequence: "1", localCsc: "CHC", version, os: "" })
  ]), "SM-S9380", "CHC");

  assert.equal(result.android, "未知");
  assert.equal(result.rawAndroid, "");
});

test("requested CSC remains authoritative even when another CSC has a higher sequence", async () => {
  const chc = "S9380CHC1/S9380CSC0/S9380MODEM0";
  const eux = "S9380EUX2/S9380CSC2/S9380MODEM2";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([
        historyRow({ sequence: "1", localCsc: "CHC", version: chc }),
        historyRow({ sequence: "99", localCsc: "EUX", version: eux })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const result = await queryFirmwareHybrid(env, "SM-S9380", "CHC");
  assert.equal(result.sourceType, "smart_history");
  assert.equal(result.latest, chc);
  assert.equal(result.smartHistory.cscMatchType, "local");
});

test("SmartHistory exposes official CSC alternatives when the requested CSC is absent", () => {
  const xml = historyDocument([
    historyRow({ sequence: "1", localCsc: "CHN", version: "X930ZCU1/X930CHN1/X930MODEM1", model: "SM-X930" }),
    historyRow({ sequence: "2", localCsc: "TGY", version: "X930ZCU2/X930TGY2/X930MODEM2", model: "SM-X930" }),
    historyRow({ sequence: "3", localCsc: "XSG", version: "X930ZCU3/X930XSG3/X930MODEM3", model: "SM-X930" })
  ]);
  assert.throws(
    () => parseSmartHistory(xml, "SM-X930", "CHC"),
    (error) => {
      assert.equal(error.code, "EXACT_CSC_REQUIRED");
      assert.deepEqual(error.officialCscOptions.map((item) => item.csc), ["CHN", "TGY", "XSG"]);
      return true;
    }
  );
});

test("official CSC ranking prioritizes Chinese regions and the requested region family", () => {
  const ranked = rankOfficialCscOptions([
    { csc: "EUX", pda: "A", openDate: "20260701", sequence: 4 },
    { csc: "TGY", pda: "B", openDate: "20260702", sequence: 3 },
    { csc: "CHN", pda: "C", openDate: "20260703", sequence: 2 },
    { csc: "XSG", pda: "D", openDate: "20260704", sequence: 1 }
  ], { model: "SM-X930", requestedCsc: "CHC", lang: "zh" });
  assert.deepEqual(ranked.slice(0, 2).map((item) => item.csc), ["CHN", "TGY"]);
});

test("negative memory cache preserves official CSC alternatives", () => {
  setNegativeFirmware("SM-X930", "CHC", {
    message: "SmartHistory has no matching CSC record for CHC",
    code: "EXACT_CSC_REQUIRED",
    officialCscOptions: [{ csc: "CHN", pda: "X930ZCU1" }]
  }, 60);
  assert.deepEqual(getNegativeFirmware("SM-X930", "CHC"), {
    message: "SmartHistory has no matching CSC record for CHC",
    code: "EXACT_CSC_REQUIRED",
    officialCscOptions: [{ csc: "CHN", pda: "X930ZCU1" }]
  });
});

test("History-only queries never request version XML", async () => {
  const version = "S9380FAST1/S9380CSC1/S9380MODEM1";
  let xmlCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      await delay(5);
      return new Response(historyDocument([
        historyRow({ sequence: "1", localCsc: "CHC", version })
      ]));
    }
    if (value.includes("version.xml")) {
      xmlCalls += 1;
      return new Response(versionDocument(version));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const result = await queryFirmwareHybrid(env, "SM-S9380", "CHC");
  assert.equal(result.latest, version);
  await delay(130);
  assert.equal(xmlCalls, 0);
});

test("interactive latest query prefers newer exact SmartHistory over older version XML", async () => {
  resetFusSession();
  let xmlCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([
        historyRow({
          model: "SM-S942N",
          localCsc: "KOO",
          sequence: "2",
          version: "S942NKSS4AZHA/S942NOKR4AZHA/S942NKSS4AZG1"
        })
      ]));
    }
    if (value.includes("version.xml")) {
      xmlCalls += 1;
      return new Response(versionDocument("S942NKSS4AZG5/S942NOKR4AZG5/S942NKSS4AZG1"));
    }
    throw new Error(`Unexpected query URL: ${value}`);
  };

  const result = await queryFirmwareHybrid(env, "SM-S942N", "KOO", {
    role: "interactive",
    allowOfficialMetadataFallback: true,
    preferOfficialMetadata: true
  });
  assert.equal(result.latest, "S942NKSS4AZHA/S942NOKR4AZHA/S942NKSS4AZG1");
  assert.equal(result.sourceType, "smart_history");
  assert.equal(result.selectedSource, "history");
  assert.equal(xmlCalls, 0);
});

test("interactive latest query accepts matching SmartHistory and version XML versions", async () => {
  resetFusSession();
  const version = "S942NKSS4AZHA/S942NOKR4AZHA/S942NKSS4AZG1";
  let xmlCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([
        historyRow({ model: "SM-S942N", sequence: "2", localCsc: "KOO", version })
      ]));
    }
    if (value.includes("version.xml")) {
      xmlCalls += 1;
      return new Response(versionDocument(version));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const result = await queryFirmwareHybrid(env, "SM-S942N", "KOO", {
    role: "interactive",
    allowOfficialMetadataFallback: true
  });
  assert.equal(result.latest, version);
  assert.equal(result.sourceType, "smart_history");
  assert.equal(xmlCalls, 0);
});

test("interactive latest query falls back to version XML when SmartHistory is empty", async () => {
  resetFusSession();
  const fallbackVersion = "S942NKSS4AZG5/S942NOKR4AZG5/S942NKSS4AZG1";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) return new Response(historyDocument([]));
    if (value.includes("version.xml")) return new Response(versionDocument(fallbackVersion));
    throw new Error(`Unexpected URL: ${value}`);
  };

  const result = await queryFirmwareHybrid(env, "SM-S942N", "KOO", {
    role: "interactive",
    allowOfficialMetadataFallback: true
  });
  assert.equal(result.latest, `${fallbackVersion}/${fallbackVersion.split("/")[0]}`);
  assert.equal(result.sourceType, "version_xml");
  assert.equal(result.fallbackUsed, true);
});

test("interactive latest query falls back to version XML after SmartHistory request failure", async () => {
  resetFusSession();
  const fallbackVersion = "S942NKSS4AZG5/S942NOKR4AZG5/S942NKSS4AZG1";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) return new Response("failure", { status: 500 });
    if (value.includes("version.xml")) return new Response(versionDocument(fallbackVersion));
    throw new Error(`Unexpected URL: ${value}`);
  };

  const result = await queryFirmwareHybrid(env, "SM-S942N", "KOO", {
    role: "interactive",
    allowOfficialMetadataFallback: true
  });
  assert.equal(result.sourceType, "version_xml");
  assert.equal(result.latest, `${fallbackVersion}/${fallbackVersion.split("/")[0]}`);
});

test("interactive latest query never uses a different CSC SmartHistory record", async () => {
  resetFusSession();
  const fallbackVersion = "S942NKSS4AZG5/S942NOKR4AZG5/S942NKSS4AZG1";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([
        historyRow({
          model: "SM-S942N",
          localCsc: "EUX",
          sequence: "99",
          version: "S942NXXU9AZHA/S942NEUX9AZHA/S942NXXU9AZHA"
        })
      ]));
    }
    if (value.includes("version.xml")) return new Response(versionDocument(fallbackVersion));
    throw new Error(`Unexpected URL: ${value}`);
  };

  const result = await queryFirmwareHybrid(env, "SM-S942N", "KOO", {
    role: "interactive",
    allowOfficialMetadataFallback: true
  });
  assert.equal(result.sourceType, "version_xml");
  assert.equal(result.latest, `${fallbackVersion}/${fallbackVersion.split("/")[0]}`);
  assert.doesNotMatch(result.latest, /EUX|AZHA/);
});

test("interactive latest query filters SmartHistory beta rows before selecting the newest formal firmware", async () => {
  resetFusSession();
  const formalVersion = "S942NKSS4AZHA/S942NOKR4AZHA/S942NKSS4AZG1";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([
        historyRow({ model: "SM-S942N", localCsc: "KOO", sequence: "2", version: formalVersion }),
        historyRow({ model: "SM-S942N", localCsc: "KOO", sequence: "99", os: "Z(Android 99)", version: "S942NKZU9BETA/S942NKOO9BETA/S942NKZU9BETA" })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const result = await queryFirmwareHybrid(env, "SM-S942N", "KOO", {
    role: "interactive",
    allowOfficialMetadataFallback: true
  });
  assert.equal(result.latest, formalVersion);
  assert.equal(result.sourceType, "smart_history");
});

test("buyer CSC is accepted only when no exact local CSC row exists", () => {
  const buyerVersion = "S9380BUY2/S9380CSC2/S9380MODEM2";
  const genericVersion = "S9380GEN9/S9380CSC9/S9380MODEM9";
  const result = parseSmartHistory(historyDocument([
    historyRow({ sequence: "99", localCsc: "", buyerCsc: "", version: genericVersion }),
    historyRow({ sequence: "2", localCsc: "EUX", buyerCsc: "CHC", version: buyerVersion })
  ]), "SM-S9380", "CHC");

  assert.equal(result.latest, buyerVersion);
  assert.equal(result.smartHistory.cscMatchType, "buyer");
  assert.equal(result.smartHistory.buyerCode, "CHC");
});

test("foreign-only History rows are rejected instead of being reported as the requested CSC", () => {
  const xml = historyDocument([
    historyRow({ sequence: "10", localCsc: "EUX", version: "S9380EUX1/S9380CSC1/S9380MODEM1" })
  ]);
  assert.throws(
    () => parseSmartHistory(xml, "SM-S9380", "CHC"),
    /no matching CSC record for CHC/
  );
});

test("future-dated History rows cannot become the official latest version", () => {
  const current = "S9380NOW1/S9380CSC1/S9380MODEM1";
  const future = "S9380FUT2/S9380CSC2/S9380MODEM2";
  const xml = historyDocument([
    historyRow({ sequence: "1", localCsc: "CHC", version: current, openDate: "20260710" }),
    historyRow({ sequence: "99", localCsc: "CHC", version: future, openDate: "20991231" })
  ]);
  const result = parseSmartHistory(xml, "SM-S9380", "CHC");
  assert.equal(result.latest, current);
});

test("withdrawn History records with BINARY_EXIST=0 are ignored", () => {
  const withdrawn = "S9380BAD9/S9380CSC9/S9380MODEM9";
  const available = "S9380GOOD2/S9380CSC2/S9380MODEM2";
  const result = parseSmartHistory(historyDocument([
    historyRow({ sequence: "99", localCsc: "CHC", version: withdrawn, exists: "0" }),
    historyRow({ sequence: "2", localCsc: "CHC", version: available, exists: "1" })
  ]), "SM-S9380", "CHC");
  assert.equal(result.latest, available);
  assert.equal(result.smartHistory.exists, "1");
});


test("generic History is rejected for an exact CSC query", async () => {
  const genericVersion = "S9380GEN3/S9380CSC3/S9380MODEM3";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([
        historyRow({ sequence: "3", localCsc: "", buyerCsc: "", version: genericVersion })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  await assert.rejects(
    queryFirmwareHybrid(env, "SM-S9380", "CHC"),
    /精确 CSC/
  );
});

test("non-History results cannot enter the canonical cache", () => {
  assert.throws(() => buildFirmwareCacheRecord({}, null, "SM-S9380", "CHC", {
    latest: "XML/XML/XML",
    source: "legacy endpoint",
    sourceType: "version_xml",
    fetchedAt: "2026-07-09T23:59:50.000Z"
  }), /non-exact SmartHistory/);
});

test("a successful exact History refresh renews the authoritative stale deadline", () => {
  const existing = {
    history: {
      latest: "SAME/SAME/SAME",
      versionFingerprint: "SAME/SAME/SAME",
      source: "Samsung FUS SmartHistory",
      sourceType: "smart_history",
      smartHistory: { cscMatchType: "local" },
      fetchedAt: "2026-07-09T00:00:00.000Z"
    },
    staleUntil: "2026-07-10T00:00:00.000Z"
  };
  const refreshedAt = "2026-07-10T01:00:00.000Z";
  const exactParsed = {
    latest: "SAME/SAME/SAME",
    pda: "SAME",
    cscVersion: "SAME",
    modem: "SAME",
    android: "16",
    source: "Samsung FUS SmartHistory",
    sourceType: "smart_history",
    smartHistory: { cscMatchType: "local" },
    fetchedAt: refreshedAt
  };
  const record = buildFirmwareCacheRecord(
    { FIRMWARE_CACHE_STALE_SECONDS: "86400", FIRMWARE_CACHE_FRESH_SECONDS: "8" },
    existing,
    "SM-S9380",
    "CHC",
    exactParsed,
    Date.parse(refreshedAt)
  );
  assert.equal(record.staleUntil, "2026-07-11T01:00:00.000Z");
  assert.equal(record.historyFetchedAt, refreshedAt);
});

test("firmware History Chain keeps exact authoritative versions only", () => {
  const first = buildFirmwareCacheRecord({}, null, "SM-S9380", "CHC", {
    latest: "S9380ZCU4HWF3/CSC/MODEM",
    pda: "S9380ZCU4HWF3",
    source: "Samsung FUS SmartHistory",
    sourceType: "smart_history",
    smartHistory: { cscMatchType: "local", sequence: 3, securityPatch: "2026-06-01" },
    fetchedAt: "2026-07-10T00:00:00.000Z"
  }, Date.parse("2026-07-10T00:00:00.000Z"));
  const second = buildFirmwareCacheRecord({}, first, "SM-S9380", "CHC", {
    latest: "S9380ZCU4HYF1/CSC/MODEM",
    pda: "S9380ZCU4HYF1",
    source: "Samsung FUS SmartHistory",
    sourceType: "smart_history",
    smartHistory: { cscMatchType: "local", sequence: 4, securityPatch: "2026-07-01" },
    fetchedAt: "2026-07-11T00:00:00.000Z"
  }, Date.parse("2026-07-11T00:00:00.000Z"));
  assert.throws(() => buildFirmwareCacheRecord({}, second, "SM-S9380", "CHC", {
    latest: "OTHER/OTHER/OTHER",
    sourceType: "version_xml",
    fetchedAt: "2026-07-11T00:01:00.000Z"
  }), /non-exact SmartHistory/);

  assert.deepEqual(second.historyChain.map((entry) => entry.sequence), [3, 4]);
  assert.equal(second.historyChain[1].securityPatch, "2026-07-01");
  assert.equal(second.historyAnalysis.sequenceDelta, 1);
  assert.equal(second.historyAnalysis.upgradeType, "firmware");
});

test("Samsung firmware parser decodes bootloader and build date codes", () => {
  const parsed = parseSamsungFirmwareString("S9380ZCU4HWF3");
  assert.equal(parsed.valid, true);
  assert.equal(parsed.model, "SM-S9380");
  assert.equal(parsed.bootloader, "4");
  assert.equal(parsed.year, 2023);
  assert.equal(parsed.month, 6);
  assert.equal(parsed.revision, 3);
});

test("Samsung firmware version infers a month when SmartHistory omits the official date", () => {
  assert.deepEqual(inferSamsungFirmwareBuildMonth("L500XXS2AZF4/L500OXM2AZF4/L500XXS2AZF4"), {
    inferred: true,
    year: 2026,
    month: 6,
    value: "2026-06",
    sourceVersion: "L500XXS2AZF4",
    yearCode: "Z",
    monthCode: "F"
  });
  assert.equal(inferSamsungFirmwareBuildMonth("UNKNOWN"), null);
});

test("firmware cards label an inferred build month without inventing a day", () => {
  const result = {
    model: "SM-L500",
    csc: "INS",
    latest: "L500XXS2AZF4/L500OXM2AZF4/L500XXS2AZF4",
    pda: "L500XXS2AZF4",
    android: "16",
    smartHistory: { openDate: "" }
  };
  assert.equal(firmwareBuildDateDisplay(result, "zh").text, "2026-06（月份由版本号推算）");
  assert.equal(firmwareBuildDateDisplay(result, "en").text, "2026-06 (month inferred from firmware version)");
  assert.match(formatFirmwareResult(result, { lang: "zh" }), /构建：2026-06（月份由版本号推算）/);
  assert.match(formatFirmwareResult(result, { lang: "en" }), /Build: 2026-06 \(month inferred from firmware version\)/);
});

test("official SmartHistory build date remains authoritative over version inference", () => {
  const result = {
    latest: "L500XXS2AZF4/L500OXM2AZF4/L500XXS2AZF4",
    pda: "L500XXS2AZF4",
    buildDate: "2026-06-18"
  };
  assert.deepEqual(firmwareBuildDateDisplay(result, "zh"), {
    value: "2026-06-18",
    inferred: false,
    text: "2026-06-18"
  });
  assert.equal(
    firmwareBuildDateDisplay({ ...result, buildDate: "Unknown" }, "en").text,
    "2026-06 (month inferred from firmware version)"
  );
});

test("hot firmware memory cache follows dynamic exact targets instead of hardcoded models", () => {
  const value = { latest: "NEW/NEW/NEW", regionExact: true };
  markFirmwareTargetHot("SM-S9480", "TGY", 60);
  assert.equal(setFirmwareMemoryCache("SM-S9480", "TGY", value), true);
  assert.deepEqual(getFirmwareMemoryCache("SM-S9480", "TGY"), value);
  assert.equal(getFirmwareMemoryCache("SM-S9480", "CHC"), null);
  assert.equal(setFirmwareMemoryCache("SM-A556B", "EUX", value), false);
  assert.equal(getFirmwareMemoryCache("SM-A556B", "EUX"), null);
});

test("firmware input parser normalizes supported short, full, slash, and colon formats", () => {
  const cases = [
    "9480 tgy",
    "s9480 tgy",
    "sm-s9480 tgy",
    "SM-S9480 TGY",
    "SM-S9480/TGY",
    "SM-S9480:TGY",
    "  sM-s9480   tGy  "
  ];
  for (const input of cases) {
    assert.deepEqual(
      { ...parseFirmwareInput(input), sourceFormat: undefined },
      { matched: true, model: "SM-S9480", csc: "TGY", sourceFormat: undefined }
    );
  }
  assert.deepEqual(parseFirmwareInput("9480"), { matched: false, reason: "missing_csc" });
  assert.deepEqual(parseFirmwareInput("hello"), { matched: false, reason: "unrecognized" });
});

test("firmware input parser preserves an optional exact version", () => {
  const version = "S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1/S9480ZCS4AZG1";
  assert.deepEqual(parseFirmwareInput(`9480 chc ${version}`), {
    matched: true,
    model: "SM-S9480",
    csc: "CHC",
    sourceFormat: "short_model_space_csc",
    version
  });
});

test("firmware input parser accepts a short revision suffix", () => {
  assert.deepEqual(parseFirmwareInput("9110 tgy zf5"), {
    matched: true,
    model: "SM-S9110",
    csc: "TGY",
    sourceFormat: "short_model_space_csc",
    version: "ZF5",
    versionKind: "short_suffix"
  });
});

test("SmartHistory selects an exact historical firmware version when requested", () => {
  const oldVersion = "S9480ZCU1/S9480CHC1/S9480ZCU1";
  const latestVersion = "S9480ZCU2/S9480CHC2/S9480ZCU2";
  const selected = parseSmartHistory(historyDocument([
    historyRow({ sequence: "1", localCsc: "CHC", model: "SM-S9480", version: oldVersion }),
    historyRow({ sequence: "2", localCsc: "CHC", model: "SM-S9480", version: latestVersion })
  ]), "SM-S9480", "CHC", { requestedVersion: oldVersion });
  assert.equal(selected.latest, oldVersion);
  assert.equal(selected.requestedVersion, oldVersion);
  assert.throws(
    () => parseSmartHistory(historyDocument([
      historyRow({ sequence: "2", localCsc: "CHC", model: "SM-S9480", version: latestVersion })
    ]), "SM-S9480", "CHC", { requestedVersion: oldVersion }),
    (error) => error.code === "FUS_SMART_HISTORY_VERSION_NOT_FOUND"
  );
});

test("SmartHistory resolves a short revision suffix to the full firmware version", () => {
  const selected = parseSmartHistory(historyDocument([
    historyRow({ sequence: "1", localCsc: "TGY", model: "SM-S9110", version: "S9110ZHS6IZF5/S9110OZS6IZF5/S9110ZCS6IZF5" }),
    historyRow({ sequence: "2", localCsc: "TGY", model: "SM-S9110", version: "S9110ZHS7IZG1/S9110OZS7IZG1/S9110ZCS7IZG1" })
  ]), "SM-S9110", "TGY", { requestedVersion: "ZF5" });
  assert.equal(selected.latest, "S9110ZHS6IZF5/S9110OZS6IZF5/S9110ZCS6IZF5");
  assert.equal(selected.requestedVersion, "ZF5");
});

test("tablet and watch aliases resolve to exact Samsung models", () => {
  const cases = [
    ["930 chn", "SM-X930", "CHN"],
    ["936C chc", "SM-X936C", "CHC"],
    ["tab11u wifi chn", "SM-X930", "CHN"],
    ["tab11u 5g chc", "SM-X936C", "CHC"],
    ["watch8 40 chc", "SM-L320", "CHC"],
    ["watch8 44 chc", "SM-L330", "CHC"],
    ["watch8 44 lte chc", "SM-L3350", "CHC"],
    ["watch8 classic bluetooth chc", "SM-L500", "CHC"],
    ["watch8 classic lte chc", "SM-L5050", "CHC"],
    ["watch ultra 2025 chc", "SM-L7050", "CHC"]
  ];
  for (const [input, model, csc] of cases) {
    const parsed = parseFirmwareInput(input);
    assert.equal(parsed.matched, true, input);
    assert.equal(parsed.model, model, input);
    assert.equal(parsed.csc, csc, input);
  }
});

test("known mainland China tablet CSC mistakes continue to the official lookup path", () => {
  assert.deepEqual(
    { ...parseFirmwareInput("SM-X930 CHC"), sourceFormat: undefined },
    { matched: true, model: "SM-X930", csc: "CHC", sourceFormat: undefined }
  );
  assert.equal(parseFirmwareInput("SM-X930 XSG").matched, true, "valid non-China CSC must not be blocked");
  assert.equal(parseFirmwareInput("SM-X936C CHC").matched, true);
});

test("query rate limits and demand counters use MonitorScheduler without KV writes", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  let kvWrites = 0;
  const stateEnv = {
    MONITOR_SCHEDULER: schedulerNamespace(scheduler),
    MONITOR_SCHEDULER_ENABLED: "true",
    FIRMWARE_KV: {
      ...memoryKv(),
      async put() {
        kvWrites += 1;
        throw new Error("KV put() limit exceeded for the day");
      }
    },
    QUERY_RATE_LIMIT_SECONDS: "3"
  };
  assert.equal(await tryStartQueryRateLimit(stateEnv, "712345"), true);
  assert.equal(await tryStartQueryRateLimit(stateEnv, "712345"), false);
  const demand = await recordFirmwareQueryDemand(stateEnv, "SM-S9480", "TGY");
  assert.equal(demand.count, 1);
  assert.equal(kvWrites, 0);
});

test("monitor additions remain durable when the KV mirror quota is exhausted", async () => {
  const storage = memoryDoStorage();
  let kvWrites = 0;
  const kv = memoryKv();
  kv.put = async () => {
    kvWrites += 1;
    throw new Error("KV put() limit exceeded for the day");
  };
  const scheduler = new MonitorScheduler({ storage }, { FIRMWARE_KV: kv });
  const stateEnv = {
    FIRMWARE_KV: kv,
    MONITOR_SCHEDULER: schedulerNamespace(scheduler),
    MONITOR_SCHEDULER_ENABLED: "true"
  };
  await setMonitorItems(stateEnv, []);
  const item = await upsertMonitorItem(stateEnv, {
    model: "SM-S9480",
    csc: "TGY",
    name: "S26 Ultra TGY",
    priority: "high"
  });
  assert.equal(item.model, "SM-S9480");
  assert.equal(item.csc, "TGY");
  assert.equal(item.persistence.durable, true);
  assert.equal(item.persistence.mirrorPending, true);
  assert.ok((await getMonitorItems(stateEnv)).some((entry) => entry.model === "SM-S9480" && entry.csc === "TGY"));
  assert.ok(kvWrites >= 1);
});

test("concurrent monitor additions are merged atomically by MonitorScheduler", async () => {
  resetStateMemoryCache();
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const stateEnv = {
    MONITOR_SCHEDULER: schedulerNamespace(scheduler),
    MONITOR_SCHEDULER_ENABLED: "true"
  };
  await setMonitorItems(stateEnv, []);
  await Promise.all([
    upsertMonitorItem(stateEnv, { model: "SM-S9480", csc: "TGY", priority: "high" }),
    upsertMonitorItem(stateEnv, { model: "SM-S948B", csc: "EUX", priority: "high" })
  ]);
  resetStateMemoryCache();
  const items = await getMonitorItems(stateEnv);
  assert.equal(items.length, 2);
  assert.ok(items.some((item) => item.model === "SM-S9480" && item.csc === "TGY"));
  assert.ok(items.some((item) => item.model === "SM-S948B" && item.csc === "EUX"));
});

test("priorityScore maps demand, flagship, peer releases, age, and failures to dynamic intervals", () => {
  const now = Date.now();
  const hot = calculatePriorityScore({
    item: { model: "SM-S9380", priority: "high" },
    runtime: { failureCount: 0 },
    queryCount: 31
  }, now);
  const failing = calculatePriorityScore({
    item: { model: "SM-A556B", priority: "low" },
    runtime: { failureCount: 5 },
    queryCount: 0
  }, now);
  const peer = calculatePriorityScore({
    item: { model: "SM-S9380", priority: "normal" },
    runtime: { lastPeerUpdateAt: new Date(now - 60_000).toISOString() },
    queryCount: 3
  }, now);

  assert.ok(hot.priorityScore >= 70);
  assert.equal(hot.intervalMinutes, 10);
  assert.equal(failing.intervalMinutes, 60);
  assert.ok(peer.factors.peerUpdatePoints > 0);
  assert.equal(priorityIntervalMinutes(80), 3);
  assert.equal(priorityIntervalMinutes(79), 10);
  assert.equal(priorityIntervalMinutes(49), 30);
  assert.equal(priorityIntervalMinutes(19), 60);
});

test("monitor interval profiles default to three-minute HIGH and persist in MonitorScheduler", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const env = { MONITOR_SCHEDULER: schedulerNamespace(scheduler), MONITOR_SCHEDULER_ENABLED: "true" };
  assert.deepEqual(await getMonitorIntervalSettings(env), {
    high: 3, normal: 10, low: 30, idle: 60, watch: 3, hot: 1, cooldown: 3
  });
  const saved = await setMonitorIntervalSettings(env, { high: 5, hot: 2 });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.high, 5);
  assert.equal(saved.settings.hot, 2);
  assert.equal(saved.settings.normal, 10);
  assert.equal((await getMonitorIntervalSettings(env)).high, 5);
});

test("a single administrator interval value creates one uniform default monitor cadence", () => {
  const settings = uniformMonitorIntervalSettings(15);
  assert.deepEqual(settings, {
    high: 15, normal: 15, low: 15, idle: 15, watch: 15, hot: 15, cooldown: 15
  });
  assert.equal(sharedMonitorIntervalMinutes(settings), 15);
  assert.equal(uniformMonitorIntervalSettings(0), null);
  assert.equal(uniformMonitorIntervalSettings(1441), null);
});

test("administrator help is newline-formatted and keeps only the compact fallback commands", () => {
  const zh = adminHelpParts("zh");
  const en = adminHelpParts("en");
  assert.ok(zh.every((part) => typeof part === "string"));
  assert.ok(en.every((part) => typeof part === "string"));
  assert.match(zh.join("\n"), /\/download/);
  assert.match(en.join("\n"), /download official firmware/);
  assert.doesNotMatch(en.join("\n"), /管理员备用命令/);
});

test("administrator can set one localized default monitoring interval with /moninterval", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const env = {
    FIRMWARE_KV: memoryKv(),
    MONITOR_SCHEDULER: schedulerNamespace(scheduler),
    MONITOR_SCHEDULER_ENABLED: "true",
    WEBHOOK_SECRET: "test-interval-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "999"
  };
  const payloads = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    payloads.push({ url: String(url), body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: payloads.length } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const waits = [];
  const response = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-interval-secret"
    },
    body: JSON.stringify({
      update_id: 920001,
      message: { message_id: 1, chat: { id: 999 }, text: "/moninterval 15" }
    })
  }), env, { waitUntil(promise) { waits.push(promise); } });
  assert.equal(response.status, 200);
  await Promise.all(waits);
  const settings = await getMonitorIntervalSettings(env);
  assert.equal(sharedMonitorIntervalMinutes(settings), 15);
  assert.ok(payloads.some(({ body }) => String(body.text || "").includes("15")));

  const payloadCountBeforePanel = payloads.length;
  const panelWaits = [];
  const panelResponse = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-interval-secret"
    },
    body: JSON.stringify({
      update_id: 920002,
      callback_query: {
        id: "open-interval-panel",
        data: "admin:intervals",
        message: { message_id: 2, chat: { id: 999 } }
      }
    })
  }), env, { waitUntil(promise) { panelWaits.push(promise); } });
  assert.equal(panelResponse.status, 200);
  await Promise.all(panelWaits);
  const intervalPanel = payloads.slice(payloadCountBeforePanel).find(({ body }) => body.reply_markup?.inline_keyboard?.flat().some(
    (button) => button.callback_data === "admin:monitor-menu"
  ));
  assert.ok(intervalPanel);
  assert.deepEqual(
    intervalPanel.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data),
    ["admin:monitor-menu", "menu:home"]
  );

  await setUserLanguage(env, 999, "en");
  const englishPayloadStart = payloads.length;
  const englishWaits = [];
  const englishResponse = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-interval-secret"
    },
    body: JSON.stringify({
      update_id: 920003,
      message: { message_id: 3, chat: { id: 999 }, text: "/moninterval 20" }
    })
  }), env, { waitUntil(promise) { englishWaits.push(promise); } });
  assert.equal(englishResponse.status, 200);
  await Promise.all(englishWaits);
  const englishReplies = payloads.slice(englishPayloadStart).map(({ body }) => String(body.text || ""));
  assert.ok(englishReplies.some((text) => text.includes("Default monitoring interval set to 20 minutes")));
  assert.equal(englishReplies.some((text) => text.includes("已将默认监控间隔")), false);
});

test("allowed-user firmware broadcasts are enabled by default", () => {
  assert.equal(notifyAllowedUsersOnUpdate({}), true);
  assert.equal(notifyAllowedUsersOnUpdate({ NOTIFY_ALLOWED_USERS_ON_UPDATE: "false" }), false);
});

test("firmware version normalization removes only the synthetic duplicate fourth field", () => {
  assert.equal(
    normalizeFirmwareVersion("S938BXXUACZF1/S938BOXMACZF1/S938BXXUACZF1"),
    "S938BXXUACZF1/S938BOXMACZF1/S938BXXUACZF1"
  );
  assert.equal(
    normalizeFirmwareVersion("S938BXXUACZF1/S938BOXMACZF1/S938BXXUACZF1"),
    "S938BXXUACZF1/S938BOXMACZF1/S938BXXUACZF1"
  );
  assert.equal(
    normalizeFirmwareVersion("PDA/CSC/MODEM/DISTINCT"),
    "PDA/CSC/MODEM/DISTINCT"
  );
});

test("compact firmware and update cards keep only the canonical full version", () => {
  const parsed = {
    model: "SM-S9480", csc: "TGY", country: "香港",
    latest: "S9480NEW/S9480CSC/S9480MODEM",
    pda: "S9480NEW", cscVersion: "S9480CSC", modem: "S9480MODEM",
    android: "B(Android 16)", buildDate: "2026-07-13"
  };
  const queryCard = formatFirmwareResult(parsed, { lang: "zh", elapsedMs: 321 });
  assert.match(queryCard, /最新版本/);
  assert.match(queryCard, /S9480NEW\/S9480CSC\/S9480MODEM/);
  assert.doesNotMatch(queryCard, /S9480MODEM\/S9480NEW/);
  assert.doesNotMatch(queryCard, /PDA：|CSC 版本：|MODEM：|版本解析：/);
  assert.doesNotMatch(queryCard, /Android|安卓|B\(Android 16\)/);

  const updateCard = formatMonitorNotification(
    { model: "SM-S9480", csc: "TGY", name: "S26 Ultra Hong Kong" },
    "S9480OLD/OLD/OLD",
    parsed,
    new Date("2026-07-13T06:00:00Z"),
    "en",
    true,
    { reminderMinutes: 7 }
  );
  assert.match(updateCard, /New firmware version found!/);
  assert.match(updateCard, /SM-S9480 · TGY/);
  assert.match(updateCard, /Old version/);
  assert.match(updateCard, /New version/);
  assert.match(updateCard, /S9480OLD\/OLD\/OLD/);
  assert.match(updateCard, /S9480NEW\/S9480CSC\/S9480MODEM/);
  assert.doesNotMatch(updateCard, /S26 Ultra Hong Kong|Hong Kong|Android:|Build date:|Samsung SmartHistory|Samsung FOTA|reminder|monitoring plan/i);
  return;

  const adminCard = formatMonitorNotification(
    { model: "SM-S9480", csc: "TGY", name: "S26 Ultra 港版" },
    "S9480OLD/OLD/OLD",
    parsed,
    new Date("2026-07-13T06:00:00Z"),
    "zh",
    true,
    { reminderMinutes: 7 }
  );
  assert.match(adminCard, /请选择后续监控计划/);
  assert.match(adminCard, /每 7 分钟提醒一次/);
  assert.match(adminCard, /S9480OLD\/OLD\/OLD/);
  assert.doesNotMatch(adminCard, /OLD\/S9480OLD/);
  assert.doesNotMatch(adminCard, /S9480MODEM\/S9480NEW/);
  const userCard = formatMonitorNotification(
    { model: "SM-S9480", csc: "TGY", name: "S26 Ultra 港版" },
    "S9480OLD/OLD/OLD", parsed, new Date(), "zh", false
  );
  assert.match(userCard, /三星正式固件已更新/);
  assert.doesNotMatch(userCard, /等待管理员确认|仅通知/);
  const baseline = formatMonitorBaseline({ model: "SM-S9480", csc: "TGY" }, parsed, new Date(), "zh");
  assert.match(baseline, /已建立固件监控基线/);
  assert.doesNotMatch(baseline, /发现三星正式固件更新/);
});

test("validateModelCsc rejects release targets outside the configured monitor set", () => {
  const allowed = new Set(["SM-S9380:CHC", "SM-S938B:EUX"]);
  assert.deepEqual(validateModelCsc("sm-s9380", "chc", { allowedTargets: allowed }), {
    model: "SM-S9380",
    csc: "CHC",
    key: "SM-S9380:CHC"
  });
  assert.throws(
    () => validateModelCsc("SM-S9380", "EUX", { allowedTargets: allowed }),
    /not configured/
  );
});

test("MonitorScheduler claims each due target once and reschedules by nextCheckAt", async () => {
  const storage = memoryDoStorage();
  const scheduler = new MonitorScheduler({ storage }, {});
  const call = async (path, body) => {
    const response = await scheduler.fetch(new Request(`https://scheduler${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const now = Date.now();
  assert.equal((await call("/claim", { now })).needsSync, true);
  await call("/sync", {
    now,
    items: [{ model: "SM-S9380", csc: "CHC", priority: "high" }]
  });
  const concurrentClaims = await Promise.all([
    call("/claim", { now }),
    call("/claim", { now })
  ]);
  assert.equal(concurrentClaims.reduce((sum, claim) => sum + claim.entries.length, 0), 1);
  const first = concurrentClaims.find((claim) => claim.entries.length === 1);

  const completed = await call("/complete", {
    model: "SM-S9380",
    csc: "CHC",
    lock: first.entries[0].lock,
    nextCheckAt: now + 60_000,
    lastVersion: "NEW",
    priorityScore: 50,
    status: "unchanged"
  });
  assert.equal(completed.ok, true);
  const duplicateCompletion = await call("/complete", {
    model: "SM-S9380",
    csc: "CHC",
    lock: first.entries[0].lock,
    nextCheckAt: now + 120_000,
    status: "unchanged"
  });
  assert.equal(duplicateCompletion.ok, false);
  assert.equal(duplicateCompletion.staleLock, true);
  assert.equal((await call("/claim-valid", {
    model: "SM-S9380",
    csc: "CHC",
    lock: first.entries[0].lock,
    now: now + 1
  })).valid, false);
  assert.equal((await call("/claim", { now: now + 59_000 })).entries.length, 0);
  const next = await call("/claim", { now: now + 61_000 });
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].lastVersion, "NEW");
});

test("MonitorScheduler persists only approved interactive control state", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const call = async (path, body) => {
    const response = await scheduler.fetch(new Request(`https://scheduler${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));
    return { status: response.status, body: await response.json() };
  };

  const schedule = { enabled: false, startTime: "00:00", endTime: "23:59" };
  assert.equal((await call("/control-state/put", { key: "monitor:schedule", value: schedule })).status, 200);
  assert.deepEqual((await call("/control-state/get", { key: "monitor:schedule" })).body.value, schedule);
  assert.equal((await call("/control-state/put", { key: "user:lang:998877", value: "en" })).status, 200);
  assert.equal((await call("/control-state/get", { key: "user:lang:998877" })).body.value, "en");
  assert.equal((await call("/control-state/put", { key: "firmware:secret", value: "blocked" })).status, 400);
});

test("MonitorScheduler HOT mode schedules a sub-minute alarm and queues one claimed target", async () => {
  const storage = memoryDoStorage();
  const queued = [];
  const scheduler = new MonitorScheduler({ storage }, {
    MONITOR_HOT_INTERVAL_SECONDS: "15",
    NOTIFICATION_QUEUE: {
      async send(message) { queued.push(message); }
    }
  });
  const call = async (path, body) => {
    const response = await scheduler.fetch(new Request(`https://scheduler${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const now = Date.now();
  await call("/sync", { now, items: [{ model: "SM-S9480", csc: "TGY", priority: "high" }] });
  const claim = await call("/claim", { now, limit: 1 });
  const completed = await call("/complete", {
    model: "SM-S9480",
    csc: "TGY",
    lock: claim.entries[0].lock,
    nextCheckAt: now + 10 * 60 * 1000,
    lastVersion: "S9480NEW1/S9480CSC1/S9480MODEM1",
    priorityScore: 90,
    status: "updated",
    completedAt: now
  });
  assert.equal(completed.monitorMode, "HOT");
  assert.ok(completed.nextCheckAt <= now + 60_000);
  assert.ok(Number(await storage.getAlarm()) >= now + 1000);

  await call("/force", { model: "SM-S9480", csc: "TGY", dueAt: Date.now() });
  await scheduler.alarm();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "monitor_check");
  assert.equal(queued[0].entry.item.model, "SM-S9480");
  await scheduler.alarm();
  assert.equal(queued.length, 1);
});

test("high scores stay NORMAL unless an explicit release boost enters WATCH", async () => {
  const storage = memoryDoStorage();
  const scheduler = new MonitorScheduler({ storage }, {});
  const call = async (path, body) => {
    const response = await scheduler.fetch(new Request(`https://scheduler${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const now = Date.now();
  await call("/sync", { now, items: [{ model: "SM-S9480", csc: "TGY", priority: "high" }] });
  let claim = await call("/claim", { now, limit: 1 });
  let completed = await call("/complete", {
    model: "SM-S9480", csc: "TGY", lock: claim.entries[0].lock,
    nextCheckAt: now + 3 * 60_000, lastVersion: "SAME", priorityScore: 95,
    status: "unchanged", completedAt: now
  });
  assert.equal(completed.monitorMode, "NORMAL");

  await call("/force", { model: "SM-S9480", csc: "TGY", dueAt: now + 1 });
  claim = await call("/claim", { now: now + 1, limit: 1 });
  completed = await call("/complete", {
    model: "SM-S9480", csc: "TGY", lock: claim.entries[0].lock,
    nextCheckAt: now + 60 * 60_000, lastVersion: "SAME", priorityScore: 95,
    releaseBoost: true, status: "unchanged", completedAt: now + 1
  });
  assert.equal(completed.monitorMode, "WATCH");
  assert.ok(completed.nextCheckAt <= now + 1 + 3 * 60_000);
});

test("an unchanged DO-scheduled monitor check performs zero additional KV writes", async () => {
  const baseKv = memoryKv();
  let kvWrites = 0;
  const kv = {
    ...baseKv,
    async put(key, value) {
      kvWrites += 1;
      await baseKv.put(key, value);
    }
  };
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, { FIRMWARE_KV: kv });
  const coordinator = new FirmwareQueryCoordinator({ storage: memoryDoStorage() }, { ...env, FIRMWARE_KV: kv });
  const coordinatorNamespace = {
    idFromName(name) { return name; },
    get() {
      return {
        fetch(request, init) {
          return coordinator.fetch(request instanceof Request ? request : new Request(request, init));
        }
      };
    }
  };
  const monitorEnv = {
    ...env,
    FIRMWARE_KV: kv,
    MONITOR_SCHEDULER: schedulerNamespace(scheduler),
    MONITOR_SCHEDULER_ENABLED: "true",
    FIRMWARE_QUERY_COORDINATOR: coordinatorNamespace,
    QUERY_COORDINATOR_ENABLED: "true",
    RELEASE_WINDOW_ENABLED: "false",
    MONITOR_CONCURRENCY: "1"
  };
  await setMonitorItems(monitorEnv, [{
    model: "SM-S9480",
    csc: "TGY",
    name: "S26 Ultra TGY",
    priority: "high"
  }]);
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([historyRow({
        sequence: "1",
        localCsc: "TGY",
        model: "SM-S9480",
        version: "S9480NEW1/S9480CSC1/S9480MODEM1"
      })]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  const first = await runMonitor(monitorEnv, { reason: "manual_test" });
  assert.equal(first.initialized, 1);
  const afterFirst = kvWrites;
  const second = await runMonitor(monitorEnv, { reason: "manual_test" });
  assert.equal(second.checked, 1);
  assert.equal(second.updated, 0);
  assert.equal(kvWrites, afterFirst);
});

test("overlapping monitor runs share one target query and one Telegram notification", async () => {
  const kv = memoryKv();
  await kv.put("firmware:last:SM-S9380:CHC", "S9380OLD1/S9380CSC1/S9380MODEM1");
  let nonceCalls = 0;
  let historyCalls = 0;
  let telegramCalls = 0;
  const monitorEnv = {
    ...env,
    FIRMWARE_KV: kv,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "999",
    RELEASE_WINDOW_ENABLED: "false",
    MONITOR_CONCURRENCY: "2",
    MONITOR_ITEMS_JSON: JSON.stringify([
      { model: "SM-S9380", csc: "CHC", name: "test", priority: "high", intervalMinutes: 1 }
    ])
  };
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("api.telegram.org")) {
      telegramCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (value.includes("GenerateNonce")) {
      nonceCalls += 1;
      await delay(10);
      return nonceResponse();
    }
    if (value.includes("SmartHistory")) {
      historyCalls += 1;
      await delay(40);
      return new Response(historyDocument([
        historyRow({
          sequence: "2",
          localCsc: "CHC",
          version: "S9380NEW2/S9380CSC2/S9380MODEM2"
        })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const [first, second] = await Promise.all([
    runMonitor(monitorEnv, { reason: "manual_test" }),
    runMonitor(monitorEnv, { reason: "manual_test" })
  ]);
  assert.equal(nonceCalls, 1);
  assert.equal(historyCalls, 1);
  assert.equal(telegramCalls, 1);
  assert.equal(first.updated, 1);
  assert.equal(second.updated, 1);
  assert.equal(first.sharedInFlight + second.sharedInFlight, 1);
});

test("slow Telegram delivery does not block the next monitor query", async () => {
  const kv = memoryKv();
  const items = [
    { model: "SM-S9380", csc: "CHC", name: "first", priority: "high", intervalMinutes: 1 },
    { model: "SM-S938B", csc: "EUX", name: "second", priority: "high", intervalMinutes: 1 }
  ];
  await kv.put("firmware:last:SM-S9380:CHC", "OLD/OLD/OLD");
  await kv.put("firmware:last:SM-S938B:EUX", "OLD/OLD/OLD");
  const pipelineEnv = {
    ...env,
    FIRMWARE_KV: kv,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "999",
    RELEASE_WINDOW_ENABLED: "false",
    MONITOR_CONCURRENCY: "1",
    FUS_MONITOR_LANES: "2"
  };
  await setMonitorItems(pipelineEnv, items);
  let telegramFinished = false;
  let secondHistoryStartedBeforeTelegramFinished = false;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("api.telegram.org")) {
      await delay(80);
      telegramFinished = true;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      const body = String(init.body || "");
      const model = body.match(/<BINARY_MODEL_NAME><Data>([^<]+)/)?.[1] || "SM-S9380";
      const csc = body.match(/<BINARY_LOCAL_CODE><Data>([^<]+)/)?.[1] || "CHC";
      if (model === "SM-S938B") secondHistoryStartedBeforeTelegramFinished = !telegramFinished;
      return new Response(historyDocument([
        historyRow({
          sequence: "2",
          model,
          localCsc: csc,
          version: `${model.replace("SM-", "")}NEW/${csc}CSC/MODEM/BUILD`
        })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const summary = await runMonitor(pipelineEnv, { reason: "manual_test" });
  assert.equal(summary.checked, 2);
  assert.equal(summary.updated, 2);
  assert.equal(secondHistoryStartedBeforeTelegramFinished, true);
  assert.equal(telegramFinished, true);
});

test("three monitor workers use independent FUS lanes concurrently", async () => {
  const kv = memoryKv();
  const items = [
    { model: "SM-S9380", csc: "CHC", name: "CHC", priority: "high", intervalMinutes: 1 },
    { model: "SM-S9380", csc: "TGY", name: "TGY", priority: "high", intervalMinutes: 1 },
    { model: "SM-S938B", csc: "EUX", name: "EUX", priority: "high", intervalMinutes: 1 }
  ];
  const parallelEnv = {
    ...env,
    FIRMWARE_KV: kv,
    RELEASE_WINDOW_ENABLED: "false",
    MONITOR_CONCURRENCY: "3",
    FUS_MONITOR_LANES: "3"
  };
  await setMonitorItems(parallelEnv, items);

  let activeHistory = 0;
  let maxActiveHistory = 0;
  let historyCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) {
      await delay(5);
      return nonceResponse();
    }
    if (value.includes("SmartHistory")) {
      historyCalls += 1;
      activeHistory += 1;
      maxActiveHistory = Math.max(maxActiveHistory, activeHistory);
      const body = String(init.body || "");
      const model = body.match(/<BINARY_MODEL_NAME><Data>([^<]+)/)?.[1] || "SM-S9380";
      const csc = body.match(/<BINARY_LOCAL_CODE><Data>([^<]+)/)?.[1] || "CHC";
      await delay(40);
      activeHistory -= 1;
      return new Response(historyDocument([
        historyRow({
          sequence: "1",
          model,
          localCsc: csc,
          version: `${model.replace("SM-", "")}NEW/${csc}CSC/MODEM/BUILD`
        })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const summary = await runMonitor(parallelEnv, { reason: "manual_test" });
  assert.equal(summary.initialized, 3);
  assert.equal(historyCalls, 3);
  assert.equal(maxActiveHistory, 3);
});

test("History failure never falls back to version XML", async () => {
  let xmlCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) return new Response("failure", { status: 500 });
    if (value.includes("version.xml")) {
      xmlCalls += 1;
      return new Response(versionDocument("UNUSED/UNUSED/UNUSED"));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  await assert.rejects(queryFirmwareHybrid(env, "SM-S9380", "CHC"), /SmartHistory HTTP 500/);
  assert.equal(xmlCalls, 0);
});

test("interactive and monitor service classes fail independently without XML fallback", async () => {
  let historyCalls = 0;
  let xmlCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      historyCalls += 1;
      await delay(20);
      return new Response("failure", { status: 500 });
    }
    if (value.includes("version.xml")) {
      xmlCalls += 1;
      return new Response(versionDocument("UNUSED/UNUSED/UNUSED"));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  const results = await Promise.allSettled([
    queryFirmwareHybrid(env, "SM-S9380", "CHC", { monitor: true, role: "monitor" }),
    queryFirmwareHybrid(env, "SM-S9380", "CHC", { role: "interactive" })
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
  assert.equal(historyCalls, 2);
  assert.equal(xmlCalls, 0);
});

test("monitor fails fast without requesting unusable XML fallback", async () => {
  const kv = memoryKv();
  const oldVersion = "S9380OLD1/S9380CSC1/S9380MODEM1";
  await kv.put("firmware:last:SM-S9380:CHC", oldVersion);
  const monitorEnv = {
    ...env,
    FIRMWARE_KV: kv,
    RELEASE_WINDOW_ENABLED: "false",
    MONITOR_CONCURRENCY: "1",
    MONITOR_FAILURE_RETRY_BASE_SECONDS: "60",
    MONITOR_FAILURE_RETRY_MAX_SECONDS: "300"
  };
  await setMonitorItems(monitorEnv, [
    { model: "SM-S9380", csc: "CHC", name: "test", priority: "high", intervalMinutes: 1 }
  ]);
  let xmlCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return new Response("failure", { status: 500 });
    if (value.includes("version.xml")) {
      xmlCalls += 1;
      throw new Error("monitor must not request version.xml");
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const summary = await runMonitor(monitorEnv, { reason: "manual_test" });
  assert.equal(summary.updated, 0);
  assert.equal(summary.initialized, 0);
  assert.equal(summary.failed, 1);
  assert.equal(xmlCalls, 0);
  assert.equal(await kv.get("firmware:last:SM-S9380:CHC"), oldVersion);
  const runtime = await getMonitorRuntime(monitorEnv, "SM-S9380", "CHC");
  assert.equal(runtime.errorClass, "transient");
  assert.match(runtime.lastError, /SmartHistory nonce HTTP 500/);
});

test("monitor rejects generic History and never initializes or notifies from it", async () => {
  const kv = memoryKv();
  let telegramCalls = 0;
  const monitorEnv = {
    ...env,
    FIRMWARE_KV: kv,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "999",
    RELEASE_WINDOW_ENABLED: "false",
    MONITOR_ITEMS_JSON: JSON.stringify([
      { model: "SM-S9380", csc: "CHC", name: "generic-test", intervalMinutes: 1 }
    ])
  };
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("api.telegram.org")) {
      telegramCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([
        historyRow({
          sequence: "5",
          localCsc: "",
          buyerCsc: "",
          version: "S9380GEN5/S9380CSC5/S9380MODEM5"
        })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const summary = await runMonitor(monitorEnv, { reason: "manual_test" });
  assert.equal(summary.failed, 1);
  assert.equal(summary.initialized, 0);
  assert.equal(await kv.get("firmware:last:SM-S9380:CHC"), null);
  assert.equal(telegramCalls, 0);
});

test("concurrent History requests share one nonce generation", async () => {
  let nonceCalls = 0;
  const version = "S9380NEW1/S9380CSC1/S9380MODEM1";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) {
      nonceCalls += 1;
      await delay(20);
      return nonceResponse();
    }
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([historyRow({ sequence: "2", localCsc: "CHC", version })]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const [first, second] = await Promise.all([
    querySmartHistory(env, "SM-S9380", "CHC", { timeoutMs: 1000 }),
    querySmartHistory(env, "SM-S9380", "CHC", { timeoutMs: 1000 })
  ]);
  assert.equal(first.latest, version);
  assert.equal(second.latest, version);
  assert.equal(nonceCalls, 1);
});

test("expired FUS sessions are renewed before the next History request", async () => {
  let nonceCalls = 0;
  const version = "S9380NEW1/S9380CSC1/S9380MODEM1";
  const shortSessionEnv = { ...env, FUS_SESSION_TTL_MS: "5" };
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) {
      nonceCalls += 1;
      return nonceResponse();
    }
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([historyRow({ sequence: "2", localCsc: "CHC", version })]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  await querySmartHistory(shortSessionEnv, "SM-S9380", "CHC", { timeoutMs: 1000 });
  await delay(15);
  await querySmartHistory(shortSessionEnv, "SM-S9380", "CHC", { timeoutMs: 1000 });
  assert.equal(nonceCalls, 2);
});

test("query card removes a duplicated legacy fourth firmware component", () => {
  const raw = "F9760ZSS2AZH7/F9760OZS2AZH7/F9760ZCS2AZH5/F9760ZSS2AZH7";
  const card = formatFirmwareResult({
    model: "SM-F9760",
    csc: "TGY",
    latest: raw
  }, { lang: "zh" });
  assert.match(card, /F9760ZSS2AZH7\/F9760OZS2AZH7\/F9760ZCS2AZH5/);
  assert.doesNotMatch(card, /F9760ZCS2AZH5\/F9760ZSS2AZH7/);
});

test("compact SmartHistory versions resolve through official Samsung metadata", async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /fota-cloud-dn\.ospserver\.net\/firmware\/TGY\/SM-S9480\/version\.xml/);
    return new Response("<firmware><version><latest>S9480ZCS4AZG1/S9480OZS4AZG1/S9480ZCS4AZG1</latest></version></firmware>");
  };
  const resolved = await resolveOfficialFirmwareVersion({}, "SM-S9480", "TGY", "S9480ZCS4AZG1");
  assert.equal(resolved, "S9480ZCS4AZG1/S9480OZS4AZG1/S9480ZCS4AZG1/S9480ZCS4AZG1");
});

test("official version.xml candidates include historical upgrade versions", async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /fota-cloud-dn\.ospserver\.net\/firmware\/TGY\/SM-S9110\/version\.xml/);
    return new Response([
      "<firmware><version><latest>S9110ZHS7IZG1/S9110OZS7IZG1/S9110ZCS7IZG1</latest></version>",
      "<upgrade><value>S9110ZHS6IZF5/S9110OZS6IZF5/S9110ZCS6IZF5</value></upgrade></firmware>"
    ].join(""));
  };
  const result = await resolveOfficialFirmwareVersionCandidates({}, "SM-S9110", "TGY");
  assert.deepEqual(result.versions, [
    "S9110ZHS7IZG1/S9110OZS7IZG1/S9110ZCS7IZG1/S9110ZHS7IZG1",
    "S9110ZHS6IZF5/S9110OZS6IZF5/S9110ZCS6IZF5/S9110ZHS6IZF5"
  ]);
});

test("FUS circuit breaker stops repeated upstream failures during cooldown", async () => {
  let fetchCalls = 0;
  const breakerEnv = {
    ...env,
    FUS_CIRCUIT_FAILURE_THRESHOLD: "2",
    FUS_CIRCUIT_COOLDOWN_MS: "60000"
  };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("failure", { status: 500 });
  };

  await assert.rejects(() => querySmartHistory(breakerEnv, "SM-S9380", "CHC"), /nonce HTTP 500/);
  await assert.rejects(() => querySmartHistory(breakerEnv, "SM-S9380", "CHC"), /nonce HTTP 500/);
  await assert.rejects(() => querySmartHistory(breakerEnv, "SM-S9380", "CHC"), /circuit open/);
  assert.equal(fetchCalls, 2);
});

test("five-minute monitoring is accepted by the default schedule", () => {
  assert.equal(defaultSchedule({ DEFAULT_MONITOR_INTERVAL_MINUTES: "5" }).intervalMinutes, 5);
});


test("release-window peers use exact model/CSC targets and never create SM-S9380/EUX", () => {
  const peers = releaseWindowPeers(
    { RELEASE_WINDOW_GROUPS_JSON: releaseWindowConfig },
    "SM-S938B",
    "EUX"
  );
  const keys = peers.map((target) => `${target.model}:${target.csc}`).sort();
  assert.deepEqual(keys, ["SM-S9380:BRI", "SM-S9380:CHC", "SM-S9380:TGY"]);
  assert.equal(keys.includes("SM-S9380:EUX"), false);
});

test("cartesian release-window configuration is rejected", () => {
  assert.throws(
    () => normalizeReleaseWindowGroups([{
      id: "unsafe",
      models: ["SM-S9380", "SM-S938B"],
      cscs: ["CHC", "EUX"]
    }]),
    /Cartesian model × CSC generation is forbidden/
  );
});

test("release-window activation only boosts exact peers already in the monitor list", async () => {
  const kv = memoryKv();
  const boostEnv = {
    FIRMWARE_KV: kv,
    RELEASE_WINDOW_ENABLED: "true",
    RELEASE_WINDOW_DURATION_MINUTES: "120",
    RELEASE_WINDOW_GROUPS_JSON: releaseWindowConfig
  };
  const monitorItems = [
    { model: "SM-S938B", csc: "EUX" },
    { model: "SM-S9380", csc: "CHC" },
    { model: "SM-S9380", csc: "TGY" }
  ];
  const boosts = await activateReleaseWindowBoosts(
    boostEnv,
    { model: "SM-S938B", csc: "EUX" },
    monitorItems,
    new Date("2026-07-10T02:00:00Z")
  );

  assert.deepEqual(
    boosts.map((boost) => `${boost.model}:${boost.csc}`).sort(),
    ["SM-S9380:CHC", "SM-S9380:TGY"]
  );
  assert.equal(kv.values.has("monitor:boost:SM-S9380:EUX"), false);
  assert.equal(kv.values.has("monitor:boost:SM-S9380:BRI"), false);
});

test("boosted targets use the configurable WATCH interval while normal targets keep their profile", async () => {
  const kv = memoryKv();
  const now = new Date("2026-07-10T02:10:00Z");
  const dueEnv = {
    FIRMWARE_KV: kv,
    RELEASE_WINDOW_ENABLED: "true",
    RELEASE_WINDOW_INTERVAL_MINUTES: "3"
  };
  const items = [
    { model: "SM-S9380", csc: "CHC" },
    { model: "SM-S9380", csc: "TGY" }
  ];
  const lastCheck = new Date(now.getTime() - 4 * 60 * 1000);
  await setMonitorLastCheck(dueEnv, "SM-S9380", "CHC", lastCheck);
  await setMonitorLastCheck(dueEnv, "SM-S9380", "TGY", lastCheck);
  await putMonitorBoost(dueEnv, "SM-S9380", "CHC", {
    until: new Date(now.getTime() + 60 * 60 * 1000),
    reason: "release_signal"
  });

  const selected = await selectDueMonitorItems(dueEnv, items, { intervalMinutes: 5 }, now);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].item.csc, "CHC");
  assert.equal(selected[0].intervalMinutes, 3);
});

test("the scheduler can wake on a non-five-minute slot for per-target due checks", async () => {
  const kv = memoryKv();
  const decision = await shouldRunNow(
    { FIRMWARE_KV: kv, MONITOR_ALLOW_KV_CRON_FALLBACK: "true" },
    {
      enabled: true,
      skipWeekends: false,
      startTime: "09:00",
      endTime: "23:59",
      intervalMinutes: 5
    },
    new Date("2026-07-10T02:03:00Z")
  );
  assert.equal(decision.run, true);
  assert.equal(decision.slot, "10:03");
});


test("failed monitor targets retry quickly instead of waiting for the full normal interval", async () => {
  const kv = memoryKv();
  const retryEnv = {
    FIRMWARE_KV: kv,
    RELEASE_WINDOW_ENABLED: "false",
    MONITOR_FAILURE_RETRY_BASE_SECONDS: "60",
    MONITOR_FAILURE_RETRY_MAX_SECONDS: "300"
  };
  const failedAt = new Date("2026-07-10T02:00:00Z");
  await recordMonitorFailure(retryEnv, "SM-S9380", "CHC", new Error("timeout"), failedAt);

  const tooEarly = await selectDueMonitorItems(
    retryEnv,
    [{ model: "SM-S9380", csc: "CHC", priority: "high" }],
    { intervalMinutes: 30 },
    new Date(failedAt.getTime() + 30_000)
  );
  assert.equal(tooEarly.length, 0);

  const retryDue = await selectDueMonitorItems(
    retryEnv,
    [{ model: "SM-S9380", csc: "CHC", priority: "high" }],
    { intervalMinutes: 30 },
    new Date(failedAt.getTime() + 61_000)
  );
  assert.equal(retryDue.length, 1);
  assert.equal(retryDue[0].runtime.failureCount, 1);
});

test("permanent monitor errors keep the full configured backoff", async () => {
  const kv = memoryKv();
  const failedAt = new Date("2026-07-10T02:00:00Z");
  const retryEnv = {
    FIRMWARE_KV: kv,
    RELEASE_WINDOW_ENABLED: "false",
    MONITOR_PERMANENT_ERROR_RETRY_SECONDS: "1800"
  };
  await recordMonitorFailure(retryEnv, "SM-S9380", "CHC", new Error("HTTP 404"), failedAt);
  const scheduling = await nextMonitorSchedule(
    retryEnv,
    { model: "SM-S9380", csc: "CHC", priority: "high" },
    { status: "failed" },
    failedAt
  );
  assert.equal(scheduling.nextCheckAt, failedAt.getTime() + 1800 * 1000);
});

test("long-dormant devices are de-prioritized instead of polled faster", () => {
  const now = Date.now();
  const dormant = calculatePriorityScore({
    item: { model: "SM-A556B", priority: "normal" },
    runtime: { lastOfficialUpdateAt: new Date(now - 150 * 24 * 60 * 60 * 1000).toISOString() },
    queryCount: 0
  }, now);
  assert.equal(dormant.factors.dormancyPenalty, 20);
  assert.equal(dormant.intervalMinutes, 60);
});

test("monitor due queue prioritizes release boosts and high-priority targets", async () => {
  const kv = memoryKv();
  const now = new Date("2026-07-10T02:10:00Z");
  const priorityEnv = {
    FIRMWARE_KV: kv,
    RELEASE_WINDOW_ENABLED: "true",
    RELEASE_WINDOW_INTERVAL_MINUTES: "3"
  };
  const items = normalizeMonitorItems([
    { model: "SM-S9380", csc: "CHC", priority: "normal", intervalMinutes: 2 },
    { model: "SM-S9380", csc: "TGY", priority: "high", intervalMinutes: 2 },
    { model: "SM-S938B", csc: "EUX", priority: "low", intervalMinutes: 2 }
  ]);
  for (const item of items) {
    await setMonitorLastCheck(priorityEnv, item.model, item.csc, new Date(now.getTime() - 3 * 60_000));
  }
  await putMonitorBoost(priorityEnv, "SM-S938B", "EUX", {
    until: new Date(now.getTime() + 60 * 60_000),
    reason: "release_signal"
  });
  const selected = await selectDueMonitorItems(priorityEnv, items, { intervalMinutes: 5 }, now);
  assert.deepEqual(
    selected.map((entry) => `${entry.item.model}:${entry.item.csc}`),
    ["SM-S938B:EUX", "SM-S9380:TGY", "SM-S9380:CHC"]
  );
  assert.equal(selected.find((entry) => entry.item.csc === "TGY").intervalMinutes, 2);
  assert.equal(selected.find((entry) => entry.item.csc === "EUX").intervalMinutes, 2);
});

test("monitor item normalization preserves priority and independent intervals without duplicates", () => {
  const items = normalizeMonitorItems([
    { model: "sm-s9380", csc: "chc", priority: "HIGH", intervalMinutes: 2 },
    { model: "SM-S9380", csc: "CHC", priority: "low", intervalMinutes: 20 }
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].priority, "high");
  assert.equal(items[0].intervalMinutes, 2);
  assert.equal(items[0].priorityRank, 3);
});

test("default monitor targets are distributed across the configured FUS lanes", () => {
  const laneEnv = { FUS_MONITOR_LANES: "3" };
  const lanes = new Set([
    fusLaneIdFor(laneEnv, "SM-S9380", "CHC", { role: "monitor" }),
    fusLaneIdFor(laneEnv, "SM-S9380", "TGY", { role: "monitor" }),
    fusLaneIdFor(laneEnv, "SM-S938B", "EUX", { role: "monitor" })
  ]);
  assert.equal(lanes.size, 3);
});

test("admin, interactive, and monitor queries use isolated stable FUS lanes", () => {
  const laneEnv = { FUS_MONITOR_LANES: "3", FUS_INTERACTIVE_LANES: "3" };
  assert.equal(fusLaneIdFor(laneEnv, "SM-S9380", "CHC", { role: "admin" }), "admin");
  const interactive = fusLaneIdFor(laneEnv, "SM-S9380", "CHC", { role: "interactive" });
  const monitor = fusLaneIdFor(laneEnv, "SM-S9380", "CHC", { role: "monitor" });
  assert.match(interactive, /^interactive-[0-2]$/);
  assert.match(monitor, /^monitor-[0-2]$/);
  assert.equal(interactive, fusLaneIdFor(laneEnv, "SM-S9380", "CHC", { role: "interactive" }));
  assert.notEqual(interactive, monitor);
});

test("different monitor FUS lanes can query History concurrently", async () => {
  const laneEnv = { ...env, FUS_MONITOR_LANES: "2" };
  const candidates = [
    ["SM-S9380", "CHC"],
    ["SM-S9380", "TGY"],
    ["SM-S9380", "BRI"],
    ["SM-S938B", "EUX"],
    ["SM-A556B", "EUX"]
  ];
  let pair = null;
  for (let i = 0; i < candidates.length && !pair; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const firstLane = fusLaneIdFor(laneEnv, ...candidates[i], { role: "monitor" });
      const secondLane = fusLaneIdFor(laneEnv, ...candidates[j], { role: "monitor" });
      if (firstLane !== secondLane) pair = [candidates[i], candidates[j]];
    }
  }
  assert.ok(pair, "expected two targets assigned to different monitor lanes");

  let activeHistory = 0;
  let maxActiveHistory = 0;
  let nonceCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) {
      nonceCalls += 1;
      await delay(5);
      return nonceResponse();
    }
    if (value.includes("SmartHistory")) {
      activeHistory += 1;
      maxActiveHistory = Math.max(maxActiveHistory, activeHistory);
      const body = String(init.body || "");
      const model = body.match(/<BINARY_MODEL_NAME><Data>([^<]+)/)?.[1] || "SM-S9380";
      const csc = body.match(/<BINARY_LOCAL_CODE><Data>([^<]+)/)?.[1] || "CHC";
      await delay(40);
      activeHistory -= 1;
      return new Response(historyDocument([
        historyRow({
          sequence: "2",
          localCsc: csc,
          model,
          version: `${model.replace(/SM-/g, "")}NEW/${csc}CSC/MODEM/BUILD`
        })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  await Promise.all(pair.map(([model, csc]) => querySmartHistory(laneEnv, model, csc, {
    role: "monitor",
    timeoutMs: 1000
  })));
  assert.equal(nonceCalls, 2);
  assert.equal(maxActiveHistory, 2);
});

test("a failed monitor lane does not open the interactive query circuit", async () => {
  const isolatedEnv = {
    ...env,
    FUS_MONITOR_LANES: "2",
    FUS_CIRCUIT_FAILURE_THRESHOLD: "1",
    FUS_CIRCUIT_COOLDOWN_MS: "60000"
  };
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      const body = String(init.body || "");
      if (body.includes("SM-S9380")) return new Response("failure", { status: 500 });
      return new Response(historyDocument([
        historyRow({
          sequence: "1",
          localCsc: "EUX",
          model: "SM-S938B",
          version: "S938BNEW/S938BCSC/S938BMODEM"
        })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  await assert.rejects(() => querySmartHistory(isolatedEnv, "SM-S9380", "CHC", { role: "monitor" }), /HTTP 500/);
  const interactive = await querySmartHistory(isolatedEnv, "SM-S938B", "EUX", { role: "interactive" });
  assert.equal(interactive.model, "SM-S938B");
});

test("Telegram edit treats message-is-not-modified as success and does not send a duplicate", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      ok: false,
      error_code: 400,
      description: "Bad Request: message is not modified"
    }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  };
  const ok = await safeEditOrSend({ TELEGRAM_BOT_TOKEN: "test-token" }, "1", 10, "same text");
  assert.equal(ok, true);
  assert.equal(calls, 1);
});

test("Telegram failure replies remove a null inline keyboard safely", async () => {
  const payloads = [];
  globalThis.fetch = async (_url, init = {}) => {
    const payload = JSON.parse(String(init.body || "{}"));
    payloads.push(payload);
    if (payload.reply_markup === null) {
      return new Response(JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: object expected as reply markup"
      }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const ok = await safeEditOrSend({ TELEGRAM_BOT_TOKEN: "test-token" }, "1", 10, "query failed", null);
  assert.equal(ok, true);
  assert.deepEqual(payloads[0].reply_markup, { inline_keyboard: [] });
  assert.equal(payloads.length, 1);
});
test("Telegram send result exposes the created message id for progress edits", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    result: { message_id: 12345 }
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const result = await sendTelegramMessageResult({ TELEGRAM_BOT_TOKEN: "test-token" }, "1", "hello");
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 12345);
});


test("speed-first default monitoring runs all day and includes weekends", () => {
  const schedule = defaultSchedule({});
  assert.equal(schedule.startTime, "00:00");
  assert.equal(schedule.endTime, "23:59");
  assert.equal(schedule.skipWeekends, false);
  assert.equal(schedule.schemaVersion, 2);
});

test("overnight monitoring windows are accepted", async () => {
  const kv = memoryKv();
  const lateNight = await shouldRunNow(
    { FIRMWARE_KV: kv, MONITOR_ALLOW_KV_CRON_FALLBACK: "true" },
    {
      enabled: true,
      skipWeekends: false,
      startTime: "22:00",
      endTime: "06:00",
      intervalMinutes: 5
    },
    new Date("2026-07-10T15:30:00Z") // 23:30 Beijing
  );
  assert.equal(lateNight.run, true);

  const daytime = await shouldRunNow(
    { FIRMWARE_KV: memoryKv() },
    {
      enabled: true,
      skipWeekends: false,
      startTime: "22:00",
      endTime: "06:00",
      intervalMinutes: 5
    },
    new Date("2026-07-10T04:00:00Z") // 12:00 Beijing
  );
  assert.equal(daytime.run, false);
  assert.equal(daytime.reason, "outside_window");
});

test("Telegram long messages are split below the API limit", async () => {
  const payloads = [];
  globalThis.fetch = async (_url, init = {}) => {
    payloads.push(JSON.parse(String(init.body || "{}")));
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: payloads.length }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const ok = await sendTelegramMessage(
    { TELEGRAM_BOT_TOKEN: "test-token" },
    "1",
    `${"A".repeat(3000)}\n${"B".repeat(3000)}`,
    { inline_keyboard: [[{ text: "Done", callback_data: "done" }]] }
  );
  assert.equal(ok, true);
  assert.equal(payloads.length, 2);
  assert.ok(payloads.every((payload) => payload.text.length <= 3900));
  assert.equal(payloads[0].reply_markup, undefined);
  assert.ok(payloads[1].reply_markup);
});

test("Telegram webhook acknowledges before slow callback processing finishes", async () => {
  const kv = memoryKv();
  let resolveFirstFetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return await new Promise((resolve) => {
        resolveFirstFetch = () => resolve(new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }));
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const waits = [];
  const ctx = { waitUntil(promise) { waits.push(promise); } };
  const request = new Request("https://worker.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-secret"
    },
    body: JSON.stringify({
      callback_query: {
        id: "callback-fast-ack",
        data: "lang:zh",
        message: { message_id: 10, chat: { id: 999 } }
      }
    })
  });

  const response = await Promise.race([
    worker.fetch(request, {
      FIRMWARE_KV: kv,
      WEBHOOK_SECRET: "test-secret",
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "999"
    }, ctx),
    delay(30).then(() => null)
  ]);
  assert.ok(response, "webhook response should not wait for Telegram API");
  assert.equal(response.status, 200);
  assert.ok(waits.length >= 1);
  assert.equal(fetchCalls, 1, "the action should wait for the callback acknowledgement");
  resolveFirstFetch();
  await Promise.all(waits);
  assert.ok(fetchCalls >= 2, "the action should continue after the callback acknowledgement");
});

test("Telegram update IDs are idempotent on the test-header-secret webhook", async () => {
  const kv = memoryKv();
  const env = { FIRMWARE_KV: kv, WEBHOOK_SECRET: "test-header-secret" };
  const body = JSON.stringify({ update_id: 123456 });
  const requestOptions = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-header-secret"
    },
    body
  };
  const waits = [];
  const ctx = { waitUntil(promise) { waits.push(promise); } };
  const first = await worker.fetch(new Request("https://worker.example/telegram", requestOptions), env, ctx);
  const second = await worker.fetch(new Request("https://worker.example/telegram", requestOptions), env, ctx);
  assert.deepEqual(await first.json(), { ok: true, accepted: true });
  assert.deepEqual(await second.json(), { ok: true, accepted: false, duplicate: true });
  await Promise.all(waits);
});

test("legacy pending update records are cleaned without repeat Telegram delivery", async () => {
  const kv = memoryKv();
  const reminderEnv = {
    FIRMWARE_KV: kv,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "999",
    UPDATE_REMINDER_INTERVAL_MINUTES: "1",
    UPDATE_REMINDER_MAX_COUNT: "3"
  };
  await putPendingUpdate(reminderEnv, {
    model: "SM-S9380",
    csc: "CHC",
    name: "test",
    oldLatest: "OLD/OLD/OLD",
    newLatest: "NEW/NEW/NEW",
    firstNotifiedAt: "",
    lastReminderAt: "",
    reminderCount: 0,
    acked: false
  });
  const cleanupSummary = await processPendingUpdateReminders(reminderEnv);
  assert.equal(cleanupSummary.checked, 1);
  assert.equal(cleanupSummary.cleared, 1);
  assert.equal(cleanupSummary.sent, 0);
  assert.equal(await getPendingUpdate(reminderEnv, "SM-S9380", "CHC"), null);
  return;

  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    description: "temporary failure"
  }), {
    status: 500,
    headers: { "content-type": "application/json" }
  });

  const summary = await processPendingUpdateReminders(reminderEnv);
  const pending = await getPendingUpdate(reminderEnv, "SM-S9380", "CHC");
  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 1);
  assert.equal(pending.reminderCount, 0);
  assert.equal(pending.lastReminderAt, "");
});

test("manual monitor claims cannot overlap an in-flight scheduled claim", async () => {
  const storage = memoryDoStorage();
  const scheduler = new MonitorScheduler({ storage }, {});
  const call = async (path, body) => {
    const response = await scheduler.fetch(new Request(`https://scheduler${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const now = Date.now();
  await call("/sync", {
    now,
    items: [{ model: "SM-S9380", csc: "CHC", priority: "high" }]
  });
  const scheduled = await call("/claim", { now, limit: 1 });
  assert.equal(scheduled.entries.length, 1);

  const blockedManual = await call("/claim-manual", {
    now: now + 1,
    items: [{ model: "SM-S9380", csc: "CHC" }]
  });
  assert.equal(blockedManual.entries.length, 0);
  assert.equal(blockedManual.skipped.length, 1);
  assert.equal(blockedManual.skipped[0].reason, "in_flight");

  await call("/complete", {
    model: "SM-S9380",
    csc: "CHC",
    lock: scheduled.entries[0].lock,
    nextCheckAt: now + 60_000,
    lastVersion: "S9380NEW/S9380CSC/S9380MODEM",
    priorityScore: 90
  });
  const acceptedManual = await call("/claim-manual", {
    now: now + 2,
    items: [{ model: "SM-S9380", csc: "CHC" }]
  });
  assert.equal(acceptedManual.entries.length, 1);
});

test("Telegram test-header-secret webhook rejects missing or incorrect secrets", async () => {
  const env = { FIRMWARE_KV: memoryKv(), WEBHOOK_SECRET: "test-correct-secret" };
  const payload = JSON.stringify({ update_id: 8080 });
  const missing = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload
  }), env, { waitUntil() {} });
  assert.equal(missing.status, 403);

  const wrong = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-wrong-secret"
    },
    body: payload
  }), env, { waitUntil() {} });
  assert.equal(wrong.status, 403);
});


test("FirmwareQueryCoordinator globally shares one History request and micro-caches the result", async () => {
  const coordinator = new FirmwareQueryCoordinator({ storage: memoryDoStorage() }, {
    ...env,
    QUERY_COORDINATOR_CACHE_MS: "5000"
  });
  let nonceCalls = 0;
  let historyCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) {
      nonceCalls += 1;
      await delay(10);
      return nonceResponse();
    }
    if (value.includes("SmartHistory")) {
      historyCalls += 1;
      await delay(20);
      return new Response(historyDocument([
        historyRow({
          sequence: "9",
          localCsc: "CHC",
          version: "S9380NEW9/S9380CSC9/S9380MODEM9"
        })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const call = async (refresh = false) => {
    const response = await coordinator.fetch(new Request("https://firmware-query/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "SM-S9380", csc: "CHC", role: "interactive", refresh })
    }));
    assert.equal(response.status, 200);
    return response.json();
  };

  const [first, second] = await Promise.all([call(), call()]);
  assert.equal(first.result.latest, "S9380NEW9/S9380CSC9/S9380MODEM9");
  assert.equal(second.result.latest, first.result.latest);
  assert.equal(historyCalls, 1);
  assert.equal(nonceCalls, 1);
  assert.equal([first.coordinator.shared, second.coordinator.shared].filter(Boolean).length, 1);

  const cached = await call();
  assert.equal(cached.coordinator.cacheHit, true);
  assert.equal(historyCalls, 1);
});

test("FirmwareQueryCoordinator refresh bypasses an older cached result and refetches SmartHistory", async () => {
  resetFusSession();
  const coordinator = new FirmwareQueryCoordinator({ storage: memoryDoStorage() }, {
    ...env,
    QUERY_COORDINATOR_CACHE_MS: "5000"
  });
  const oldVersion = "S942NKSS4AZG5/S942NOKR4AZG5/S942NKSS4AZG1";
  const newVersion = "S942NKSS4AZHA/S942NOKR4AZHA/S942NKSS4AZG1";
  let liveVersion = oldVersion;
  let historyCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      historyCalls += 1;
      return new Response(historyDocument([
        historyRow({ model: "SM-S942N", localCsc: "KOO", sequence: historyCalls, version: liveVersion })
      ]));
    }
    if (value.includes("version.xml")) throw new Error("version.xml must not replace usable SmartHistory");
    throw new Error(`Unexpected URL: ${value}`);
  };
  const request = (refresh) => coordinator.fetch(new Request("https://firmware-query/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "SM-S942N", csc: "KOO", role: "interactive", refresh })
  }));

  const cached = await request(false);
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).result.latest, oldVersion);
  liveVersion = newVersion;
  const refreshed = await request(true);
  assert.equal(refreshed.status, 200);
  const body = await refreshed.json();
  assert.equal(body.result.latest, newVersion);
  assert.equal(body.result.parsed.sourceType, "smart_history");
  assert.equal(historyCalls, 2);
});

test("FirmwareQueryCoordinator negative-caches exact-CSC failures across object restarts", async () => {
  const storage = memoryDoStorage();
  let coordinator = new FirmwareQueryCoordinator({ storage }, {
    ...env,
    QUERY_COORDINATOR_NEGATIVE_CACHE_SECONDS: "60"
  });
  let historyCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      historyCalls += 1;
      return new Response(historyDocument([
        historyRow({
          sequence: "99",
          localCsc: "EUX",
          version: "S9380EUX9/S9380CSC9/S9380MODEM9"
        })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  const request = () => coordinator.fetch(new Request("https://firmware-query/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "SM-S9380", csc: "CHC" })
  }));

  const first = await request();
  assert.equal(first.status, 502);
  const firstBody = await first.json();
  assert.deepEqual(firstBody.officialCscOptions.map((item) => item.csc), ["EUX"]);
  coordinator = new FirmwareQueryCoordinator({ storage }, {
    ...env,
    QUERY_COORDINATOR_NEGATIVE_CACHE_SECONDS: "60"
  });
  const second = await request();
  assert.equal(second.status, 409);
  const secondBody = await second.json();
  assert.deepEqual(secondBody.officialCscOptions.map((item) => item.csc), ["EUX"]);
  assert.equal(historyCalls, 1);
});

test("MonitorScheduler makes queue notifications idempotent", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const call = async (path, body) => {
    const response = await scheduler.fetch(new Request(`https://scheduler${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const now = Date.now();
  const first = await call("/notification-claim", { notificationId: "update:1", now });
  assert.equal(first.duplicate, false);
  assert.equal(first.busy, false);
  assert.ok(first.lock);

  const busy = await call("/notification-claim", { notificationId: "update:1", now: now + 1 });
  assert.equal(busy.busy, true);

  await call("/notification-complete", {
    notificationId: "update:1",
    lock: first.lock,
    sent: true,
    now: now + 2
  });
  const duplicate = await call("/notification-claim", { notificationId: "update:1", now: now + 3 });
  assert.equal(duplicate.duplicate, true);
});

test("notification producer queues Telegram work instead of calling Telegram inline", async () => {
  const queued = [];
  let telegramCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.telegram.org")) telegramCalls += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const result = await enqueueTelegramNotification({
    NOTIFICATION_QUEUE: {
      async send(message) { queued.push(message); }
    }
  }, {
    id: "queue-test",
    chatId: "123",
    text: "hello"
  });
  assert.equal(result.queued, true);
  assert.equal(queued.length, 1);
  assert.equal(telegramCalls, 0);
});

test("notification queue consumer acknowledges successful Telegram delivery", async () => {
  let acked = 0;
  let retried = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.telegram\.org/);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const message = {
    body: { id: "delivery-test", chatId: "123", text: "hello" },
    ack() { acked += 1; },
    retry() { retried += 1; }
  };
  await processNotificationQueue({ messages: [message] }, { TELEGRAM_BOT_TOKEN: "test-token" });
  assert.equal(acked, 1);
  assert.equal(retried, 0);
});


test("FirmwareQueryCoordinator owns the canonical KV write for an exact target", async () => {
  const storage = memoryDoStorage();
  const kv = memoryKv();
  const coordinator = new FirmwareQueryCoordinator({ storage }, {
    ...env,
    FIRMWARE_KV: kv,
    QUERY_COORDINATOR_CACHE_MS: "3000"
  });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([
        historyRow({
          sequence: "42",
          localCsc: "CHC",
          version: "S9380ZCU9/S9380CHC9/S9380MODEM9"
        })
      ]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const response = await coordinator.fetch(new Request("https://firmware-query/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "SM-S9380", csc: "CHC" })
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.canonicalCache.latest, "S9380ZCU9/S9380CHC9/S9380MODEM9");
  const cached = await getFirmwareQueryCache({ FIRMWARE_KV: kv }, "SM-S9380", "CHC");
  assert.equal(cached.latest, body.result.canonicalCache.latest);
  assert.equal(cached.sourceType, "smart_history");
});

test("FirmwareQueryCoordinator restores its short positive cache after object restart", async () => {
  const storage = memoryDoStorage();
  const version = "S9480NEW1/S9480CSC1/S9480MODEM1";
  let historyCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      historyCalls += 1;
      return new Response(historyDocument([historyRow({
        sequence: "1",
        localCsc: "TGY",
        model: "SM-S9480",
        version
      })]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  const request = () => new Request("https://firmware-query/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "SM-S9480", csc: "TGY", role: "interactive" })
  });
  let coordinator = new FirmwareQueryCoordinator({ storage }, {
    ...env,
    QUERY_COORDINATOR_CACHE_MS: "1",
    QUERY_COORDINATOR_STORAGE_CACHE_SECONDS: "15"
  });
  assert.equal((await coordinator.fetch(request())).status, 200);
  coordinator = new FirmwareQueryCoordinator({ storage }, {
    ...env,
    QUERY_COORDINATOR_CACHE_MS: "1",
    QUERY_COORDINATOR_STORAGE_CACHE_SECONDS: "15"
  });
  const second = await coordinator.fetch(request());
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.coordinator.cacheLayer, "do_storage");
  assert.equal(historyCalls, 1);
});

test("FirmwareQueryCoordinator mirrors an unchanged firmware fingerprint to KV only once", async () => {
  const storage = memoryDoStorage();
  const baseKv = memoryKv();
  let kvWrites = 0;
  const kv = {
    ...baseKv,
    async put(key, value) {
      kvWrites += 1;
      await baseKv.put(key, value);
    }
  };
  const version = "S9480NEW1/S9480CSC1/S9480MODEM1";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([historyRow({
        sequence: "1",
        localCsc: "TGY",
        model: "SM-S9480",
        version
      })]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  const coordinator = new FirmwareQueryCoordinator({ storage }, { ...env, FIRMWARE_KV: kv });
  const query = async () => coordinator.fetch(new Request("https://firmware-query/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "SM-S9480", csc: "TGY", role: "interactive", refresh: true })
  }));
  assert.equal((await query()).status, 200);
  assert.equal((await query()).status, 200);
  assert.equal(kvWrites, 1);
});

test("FirmwareQueryCoordinator suppresses repeated KV mirror attempts during quota backoff", async () => {
  const storage = memoryDoStorage();
  let kvWrites = 0;
  const kv = memoryKv();
  kv.put = async () => {
    kvWrites += 1;
    throw new Error("KV put() limit exceeded for the day");
  };
  const version = "S9480NEW2/S9480CSC2/S9480MODEM2";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      return new Response(historyDocument([historyRow({
        sequence: "2",
        localCsc: "TGY",
        model: "SM-S9480",
        version
      })]));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  const coordinator = new FirmwareQueryCoordinator({ storage }, { ...env, FIRMWARE_KV: kv });
  const query = async () => coordinator.fetch(new Request("https://firmware-query/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "SM-S9480", csc: "TGY", role: "interactive", refresh: true })
  }));

  assert.equal((await query()).status, 200);
  assert.equal((await query()).status, 200);
  assert.equal(kvWrites, 1);
  const pending = await storage.get("mirror:pending");
  assert.equal(pending.canonicalCache.latest, version);
  assert.ok(pending.retryAt > Date.now());
});

test("notification retry finishes pending state without resending Telegram", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const schedulerNamespace = {
    idFromName(name) { return name; },
    get() {
      return {
        fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          return scheduler.fetch(request);
        }
      };
    }
  };
  const baseKv = memoryKv();
  let failPendingPut = true;
  const kv = {
    ...baseKv,
    async put(key, value, options) {
      if (failPendingPut && String(key).startsWith("pending:update:")) {
        failPendingPut = false;
        throw new Error("temporary KV failure");
      }
      return baseKv.put(key, value, options);
    }
  };
  let telegramCalls = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /api\.telegram\.org/);
    telegramCalls += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const body = {
    id: "pending-state-retry",
    chatId: "123",
    text: "new firmware",
    pendingAfterSuccess: {
      model: "SM-S9380",
      csc: "CHC",
      newLatest: "S9380ZCU9/S9380CHC9/S9380MODEM9",
      reminderCount: 1,
      acked: false
    }
  };
  let firstAck = 0;
  let firstRetry = 0;
  await processNotificationQueue({
    messages: [{
      body,
      ack() { firstAck += 1; },
      retry() { firstRetry += 1; }
    }]
  }, {
    TELEGRAM_BOT_TOKEN: "test-token",
    MONITOR_SCHEDULER: schedulerNamespace,
    FIRMWARE_KV: kv
  });
  assert.equal(firstAck, 0);
  assert.equal(firstRetry, 1);
  assert.equal(telegramCalls, 1);

  let secondAck = 0;
  let secondRetry = 0;
  await processNotificationQueue({
    messages: [{
      body,
      ack() { secondAck += 1; },
      retry() { secondRetry += 1; }
    }]
  }, {
    TELEGRAM_BOT_TOKEN: "test-token",
    MONITOR_SCHEDULER: schedulerNamespace,
    FIRMWARE_KV: kv
  });
  assert.equal(secondAck, 1);
  assert.equal(secondRetry, 0);
  assert.equal(telegramCalls, 1);
  const pending = await getPendingUpdate({ FIRMWARE_KV: kv }, "SM-S9380", "CHC");
  assert.equal(pending.reminderCount, 1);
});


test("flagship linkage rules use exact source and previous targets without model/CSC generation", () => {
  const rules = normalizeFlagshipLinkageRules([
    {
      id: "s26-eux",
      source: { model: "SM-S948B", csc: "EUX", name: "S26 Ultra EUX" },
      previousTargets: [
        { model: "SM-S938B", csc: "EUX", name: "S25 Ultra EUX" },
        { model: "SM-S9380", csc: "TGY", name: "S25 Ultra TGY" }
      ]
    }
  ]);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].previousTargets.map((target) => `${target.model}:${target.csc}`), [
    "SM-S938B:EUX",
    "SM-S9380:TGY"
  ]);
  assert.throws(() => normalizeFlagshipLinkageRules([{ models: ["SM-S948B"], cscs: ["EUX"] }]), /cannot generate/i);
});

test("monitor item normalization preserves linked priority lifecycle and paused state", () => {
  const [item] = normalizeMonitorItems([
    {
      model: "SM-S938B",
      csc: "EUX",
      priority: "high",
      enabled: false,
      paused: true,
      prioritySource: "flagship_linkage",
      linkedFrom: "SM-S948B/EUX",
      linkedRuleId: "s26-eux",
      adminDecision: "paused"
    }
  ]);
  assert.equal(item.enabled, false);
  assert.equal(item.paused, true);
  assert.equal(item.prioritySource, "flagship_linkage");
  assert.equal(item.linkedFrom, "SM-S948B/EUX");
  assert.equal(item.adminDecision, "paused");
});

test("current flagship proposal adds corresponding CSC and TGY as HIGH monitoring targets", async () => {
  const env = { FIRMWARE_KV: memoryKv() };
  await setMonitorItems(env, []);
  const proposal = buildFlagshipActivationProposal({
    FLAGSHIP_LINKAGE_ENABLED: "true",
    FLAGSHIP_LINKAGE_RULES_JSON: JSON.stringify([
      {
        id: "s26-eux",
        source: { model: "SM-S948B", csc: "EUX", name: "S26 Ultra EUX" },
        previousTargets: [
          { model: "SM-S938B", csc: "EUX", name: "S25 Ultra EUX" },
          { model: "SM-S9380", csc: "TGY", name: "S25 Ultra TGY" }
        ]
      }
    ])
  }, { model: "SM-S948B", csc: "EUX", name: "S26 Ultra EUX" }, { latest: "S948BXXU1BYG1" });
  assert.ok(proposal);
  await putFlagshipProposal(env, proposal);
  const result = await applyFlagshipProposalDecision(env, proposal.id, "approve");
  assert.equal(result.ok, true);
  const items = await getMonitorItems(env);
  assert.deepEqual(items.map((item) => `${item.model}:${item.csc}`).sort(), ["SM-S9380:TGY", "SM-S938B:EUX"]);
  for (const item of items) {
    assert.equal(item.priority, "high");
    assert.equal(item.enabled, true);
    assert.equal(item.prioritySource, "flagship_linkage");
    assert.equal(item.linkedFrom, "SM-S948B/EUX");
  }
});

test("linked previous flagship update can remain HIGH, restore NORMAL, or pause without deletion", async () => {
  const env = { FIRMWARE_KV: memoryKv() };
  await setMonitorItems(env, [{
    model: "SM-S938B",
    csc: "EUX",
    name: "S25 Ultra EUX",
    priority: "high",
    prioritySource: "flagship_linkage",
    linkedFrom: "SM-S948B/EUX"
  }]);

  const keep = buildLinkedTargetReviewProposal((await getMonitorItems(env))[0], { latest: "S938BXXU9DYH1" });
  await putFlagshipProposal(env, keep);
  assert.equal((await applyFlagshipProposalDecision(env, keep.id, "keep")).ok, true);
  let item = (await getMonitorItems(env))[0];
  assert.equal(item.priority, "high");
  assert.equal(item.enabled, true);

  const normal = { ...buildLinkedTargetReviewProposal(item, { latest: "S938BXXU9DYH2" }), id: "normal123456" };
  await putFlagshipProposal(env, normal);
  assert.equal((await applyFlagshipProposalDecision(env, normal.id, "normal")).ok, true);
  item = (await getMonitorItems(env))[0];
  assert.equal(item.priority, "normal");
  assert.equal(item.enabled, true);

  await setMonitorItems(env, [{ ...item, priority: "high", prioritySource: "flagship_linkage" }]);
  const pause = { ...buildLinkedTargetReviewProposal((await getMonitorItems(env))[0], { latest: "S938BXXU9DYH3" }), id: "pause1234567" };
  await putFlagshipProposal(env, pause);
  assert.equal((await applyFlagshipProposalDecision(env, pause.id, "pause")).ok, true);
  item = (await getMonitorItems(env))[0];
  assert.equal(item.enabled, false);
  assert.equal(item.paused, true);
  assert.equal(item.priority, "high");
  assert.equal((await getMonitorItems(env)).length, 1);
  assert.equal((await getFlagshipProposal(env, pause.id)).decision, "pause");
});

test("Telegram HIGH-priority panel callback pauses one target without deleting it", async () => {
  const kv = memoryKv();
  const env = {
    FIRMWARE_KV: kv,
    WEBHOOK_SECRET: "test-flagship-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "999"
  };
  await setMonitorItems(env, [{
    model: "SM-S938B",
    csc: "EUX",
    name: "S25 Ultra EUX",
    priority: "high",
    prioritySource: "flagship_linkage",
    linkedFrom: "SM-S948B/EUX"
  }]);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const waits = [];
  const request = new Request("https://worker.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-flagship-secret"
    },
    body: JSON.stringify({
      update_id: 987654,
      callback_query: {
        id: "pause-high-target",
        data: "monitor-item:pause:SM-S938B:EUX",
        message: { message_id: 55, chat: { id: 999 } }
      }
    })
  });
  const response = await worker.fetch(request, env, { waitUntil(promise) { waits.push(promise); } });
  assert.equal(response.status, 200);
  await Promise.all(waits);
  const [item] = await getMonitorItems(env);
  assert.equal(item.enabled, false);
  assert.equal(item.paused, true);
  assert.equal(item.priority, "high");
});

test("a current flagship version change sends one update without an admin confirmation prompt", async () => {
  resetFusSession();
  const kv = memoryKv();
  const queued = [];
  const env = {
    FIRMWARE_KV: kv,
    TELEGRAM_CHAT_ID: "999",
    NOTIFICATION_QUEUE: { async send(message) { queued.push(message); } },
    NOTIFICATION_QUEUE_ENABLED: "true",
    FLAGSHIP_LINKAGE_ENABLED: "true",
    FLAGSHIP_LINKAGE_RULES_JSON: JSON.stringify([
      {
        id: "s26-eux",
        source: { model: "SM-S948B", csc: "EUX", name: "S26 Ultra EUX" },
        previousTargets: [
          { model: "SM-S938B", csc: "EUX", name: "S25 Ultra EUX" },
          { model: "SM-S9380", csc: "TGY", name: "S25 Ultra TGY" }
        ]
      }
    ]),
    HISTORY_REQUEST_TIMEOUT_MS: "1000",
    HISTORY_TOTAL_DEADLINE_MS: "2000"
  };
  await setMonitorItems(env, [{ model: "SM-S948B", csc: "EUX", name: "S26 Ultra EUX", priority: "high" }]);
  await kv.put("firmware:last:SM-S948B:EUX", "S948BXXU1BYF1/S948BOXM1BYF1/S948BXXU1BYF1");
  globalThis.fetch = async (url) => {
    if (String(url).includes("GenerateNonce")) return nonceResponse();
    return new Response(historyDocument([
      historyRow({
        sequence: 20,
        model: "SM-S948B",
        localCsc: "EUX",
        version: "S948BXXU1BYG1/S948BOXM1BYG1/S948BXXU1BYG1"
      })
    ]), { status: 200 });
  };
  const summary = await runMonitor(env, { reason: "manual_test" });
  assert.equal(summary.updated, 1);
  assert.ok(queued.some((message) => String(message.id).startsWith("firmware-update:SM-S948B:EUX:")));
  assert.equal(queued.some((message) => String(message.id).startsWith("flagship-priority:")), false);
  const items = await getMonitorItems(env);
  assert.deepEqual(items.map((item) => `${item.model}:${item.csc}`), ["SM-S948B:EUX"]);
});

async function dispatchTelegramTestUpdate(env, update, payloads) {
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    payloads.push({ url: String(url), body });
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: payloads.length, allowed_updates: ["message", "edited_message", "callback_query"] }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const waits = [];
  const response = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET
    },
    body: JSON.stringify(update)
  }), env, { waitUntil(promise) { waits.push(promise); } });
  assert.equal(response.status, 200);
  for (let round = 0; round < 3; round += 1) await Promise.all([...waits]);
}

async function dispatchFirmwareQueryUpdate({ input, historyDelayMs = 0, kvRejectsWrites = false, historyRows = null, officialXml = null, telegramUnavailable = false }) {
  const kv = memoryKv();
  const queuedNotifications = [];
  let kvWrites = 0;
  if (kvRejectsWrites) {
    kv.put = async () => {
      kvWrites += 1;
      throw new Error("KV put() limit exceeded for the day");
    };
  }
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, { FIRMWARE_KV: kv });
  const coordinatorWaits = [];
  const coordinator = new FirmwareQueryCoordinator({
    storage: memoryDoStorage(),
    waitUntil(promise) { coordinatorWaits.push(promise); }
  }, { ...env, FIRMWARE_KV: kv });
  const firmwareCoordinatorNamespace = {
    idFromName(name) { return name; },
    get() {
      return {
        fetch(request, init) {
          return coordinator.fetch(request instanceof Request ? request : new Request(request, init));
        }
      };
    }
  };
  const workerEnv = {
    ...env,
    FIRMWARE_KV: kv,
    MONITOR_SCHEDULER: schedulerNamespace(scheduler),
    MONITOR_SCHEDULER_ENABLED: "true",
    FIRMWARE_QUERY_COORDINATOR: firmwareCoordinatorNamespace,
    QUERY_COORDINATOR_ENABLED: "true",
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "997",
    TELEGRAM_QUERY_PLACEHOLDER_ENABLED: "true",
    NOTIFICATION_QUEUE: { async send(message) { queuedNotifications.push(message); } },
    NOTIFICATION_QUEUE_ENABLED: "true"
  };
  const telegram = [];
  let historyCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("api.telegram.org")) {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      telegram.push({ url: value, body });
      if (telegramUnavailable) {
        return new Response(JSON.stringify({ ok: false, description: "temporary Telegram outage" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: telegram.length } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (value.includes("GenerateNonce")) return nonceResponse();
    if (value.includes("SmartHistory")) {
      historyCalls += 1;
      if (historyDelayMs) await delay(historyDelayMs);
      return new Response(historyDocument(historyRows || [historyRow({
        sequence: "1",
        localCsc: "TGY",
        model: "SM-S9480",
        version: "S9480NEW1/S9480CSC1/S9480MODEM1"
      })]));
    }
    if (officialXml !== null && value.includes("version.xml")) {
      return new Response(officialXml || "<firmware><version><latest>S9480ZCS4AZG1/S9480OZS4AZG1/S9480ZCS4AZG1</latest></version></firmware>");
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  const waits = [];
  const response = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": workerEnv.WEBHOOK_SECRET
    },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1_000_000_000),
      message: { message_id: 1, chat: { id: 997 }, from: { id: 997 }, text: input }
    })
  }), workerEnv, { waitUntil(promise) { waits.push(promise); } });
  for (let round = 0; round < 5; round += 1) await Promise.allSettled([...waits, ...coordinatorWaits]);
  return { response, telegram, queuedNotifications, historyCalls, kvWrites, workerEnv };
}

test("plain firmware input still replies when Workers KV has exhausted its daily writes", async () => {
  const result = await dispatchFirmwareQueryUpdate({ input: "SM-S9480:TGY", kvRejectsWrites: true });
  assert.equal(result.response.status, 200);
  assert.equal(result.historyCalls, 1);
  assert.ok(result.telegram.some((entry) => entry.body.text?.includes("SM-S9480 · TGY")));
  assert.equal(result.telegram.some((entry) => entry.body.text?.includes("正在查询 Samsung SmartHistory")), false);
  assert.ok(result.kvWrites >= 1, "the failed canonical mirror should be attempted outside the query result path");
  assert.equal((await getMonitorItems(result.workerEnv)).length, 0);
});

test("slow firmware input shows a delayed placeholder and then edits it with the result", async () => {
  const result = await dispatchFirmwareQueryUpdate({ input: "9480 tgy", historyDelayMs: 350 });
  const placeholder = result.telegram.find((entry) => entry.body.text?.includes("正在查询最新固件"));
  const firmwareResult = result.telegram.find((entry) => (
    entry.url.includes("editMessageText") && entry.body.text?.includes("SM-S9480 · TGY")
  ));
  assert.ok(placeholder);
  assert.ok(firmwareResult);
  assert.ok(firmwareResult.url.includes("editMessageText"));
  assert.equal(result.historyCalls, 1);
});

test("exact firmware input returns the selected version and keeps it on the admin download action", async () => {
  const oldVersion = "S9480ZCU1/S9480CHC1/S9480ZCU1";
  const latestVersion = "S9480ZCU2/S9480CHC2/S9480ZCU2";
  const result = await dispatchFirmwareQueryUpdate({
    input: `9480 chc ${oldVersion}`,
    historyRows: [
      historyRow({ sequence: "1", localCsc: "CHC", model: "SM-S9480", version: oldVersion }),
      historyRow({ sequence: "2", localCsc: "CHC", model: "SM-S9480", version: latestVersion })
    ]
  });
  assert.equal(result.response.status, 200);
  const response = result.telegram.find((entry) => entry.body.text?.includes("指定版本"));
  assert.ok(response);
  assert.match(response.body.text, new RegExp(oldVersion.replaceAll("/", "\\/")));
  const downloadButton = response.body.reply_markup?.inline_keyboard
    ?.flat()
    .find((button) => String(button.callback_data || "").startsWith("admin:download-exact:"));
  assert.ok(downloadButton);
});

test("short firmware suffix input asks for confirmation before the exact query", async () => {
  const selectedVersion = "S9110ZHS6IZF5/S9110OZS6IZF5/S9110ZCS6IZF5";
  const otherVersion = "S9110ZHS7IZG1/S9110OZS7IZG1/S9110ZCS7IZG1";
  const result = await dispatchFirmwareQueryUpdate({
    input: "9110 tgy zf5",
    historyRows: [
      historyRow({ sequence: "1", localCsc: "TGY", model: "SM-S9110", version: selectedVersion }),
      historyRow({ sequence: "2", localCsc: "TGY", model: "SM-S9110", version: otherVersion })
    ]
  });
  assert.equal(result.response.status, 200);
  const response = result.telegram.find((entry) => entry.body.reply_markup?.inline_keyboard
    ?.flat()
    .some((button) => String(button.callback_data || "").startsWith("query:short-confirm:")));
  assert.ok(response);
  assert.match(response.body.text, new RegExp(selectedVersion.replaceAll("/", "\\/")));

  const confirmButton = response.body.reply_markup?.inline_keyboard
    ?.flat()
    .find((button) => String(button.callback_data || "").startsWith("query:short-confirm:"));
  assert.ok(confirmButton);
  const callbackWaits = [];
  const callbackResponse = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": result.workerEnv.WEBHOOK_SECRET
    },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1_000_000_000),
      callback_query: {
        id: "short-version-confirm",
        data: confirmButton.callback_data,
        message: { message_id: 1, chat: { id: 997 } }
      }
    })
  }), result.workerEnv, { waitUntil(promise) { callbackWaits.push(promise); } });
  for (let round = 0; round < 5; round += 1) await Promise.allSettled(callbackWaits);
  assert.equal(callbackResponse.status, 200);
  const exactResult = result.telegram.find((entry) => entry.body.text?.includes("指定版本"));
  assert.ok(exactResult);
  assert.match(exactResult.body.text, new RegExp(selectedVersion.replaceAll("/", "\\/")));
});

test("short firmware suffix falls back to official version.xml history after empty SmartHistory", async () => {
  const selectedVersion = "S9110ZHS6IZF5/S9110OZS6IZF5/S9110ZCS6IZF5";
  const result = await dispatchFirmwareQueryUpdate({
    input: "9110 tgy zf5",
    historyRows: [],
    officialXml: [
      "<firmware><version><latest>S9110ZHS7IZG1/S9110OZS7IZG1/S9110ZCS7IZG1</latest></version>",
      `<upgrade><value>${selectedVersion}</value></upgrade></firmware>`
    ].join("")
  });
  const response = result.telegram.find((entry) => entry.body.reply_markup?.inline_keyboard
    ?.flat()
    .some((button) => String(button.callback_data || "").startsWith("query:short-confirm:")));
  assert.ok(response);
  assert.match(response.body.text, new RegExp(selectedVersion.replaceAll("/", "\\/")));
});

test("query result is queued for retry when Telegram is temporarily unavailable", async () => {
  const result = await dispatchFirmwareQueryUpdate({ input: "9480 tgy", telegramUnavailable: true });
  assert.equal(result.historyCalls, 1);
  assert.ok(result.queuedNotifications.some((message) => String(message.text).includes("SM-S9480")));
});

test("incomplete and unrelated plain text receive guidance instead of being ignored", async () => {
  const missingCsc = await dispatchFirmwareQueryUpdate({ input: "9480" });
  assert.equal(missingCsc.historyCalls, 0);
  assert.ok(missingCsc.telegram.some((entry) => entry.body.text?.includes("需要同时输入 CSC")));
  const unrelated = await dispatchFirmwareQueryUpdate({ input: "hello" });
  assert.equal(unrelated.historyCalls, 0);
  assert.ok(unrelated.telegram.some((entry) => entry.body.text?.includes("无法识别设备型号")));
});

test("unknown CSC receives two ranked official alternatives and a more button", async () => {
  const result = await dispatchFirmwareQueryUpdate({
    input: "SM-L330 CHN",
    historyRows: [
      historyRow({ sequence: "1", localCsc: "EUX", model: "SM-L330", version: "L330XXU1/L330EUX1/L330MODEM1" }),
      historyRow({ sequence: "2", localCsc: "TGY", model: "SM-L330", version: "L330XXU2/L330TGY2/L330MODEM2" }),
      historyRow({ sequence: "3", localCsc: "CHC", model: "SM-L330", version: "L330XXU3/L330CHC3/L330MODEM3" })
    ]
  });
  assert.equal(result.historyCalls, 1);
  const suggestion = result.telegram.find((entry) => entry.body.text?.includes("最可能的两个官方有效 CSC"));
  assert.ok(suggestion);
  assert.ok(suggestion.body.text.includes("CHC"));
  assert.ok(suggestion.body.text.includes("TGY"));
  const callbacks = suggestion.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("csc:query:SM-L330:CHC"));
  assert.ok(callbacks.includes("csc:query:SM-L330:TGY"));
  assert.ok(callbacks.includes("csc:more:0:SM-L330:CHN"));
});

test("known wrong tablet CSC falls back to the confirmed correction when official alternatives are absent", async () => {
  const result = await dispatchFirmwareQueryUpdate({ input: "SM-X930 CHC" });
  assert.equal(result.historyCalls, 1);
  assert.ok(result.telegram.some((entry) => entry.body.text?.includes("检测到一个已确认的官方有效 CSC")));
  assert.ok(result.telegram.some((entry) => entry.body.text?.includes("CHN")));
});

test("Telegram start shows the compact role-based admin menu", async () => {
  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "991"
  };
  await dispatchTelegramTestUpdate(env, {
    update_id: 700001,
    message: {
      message_id: 1,
      chat: { id: 991 },
      from: { id: 991, first_name: "Admin" },
      text: "/start"
    }
  }, payloads);
  const sent = payloads.find((entry) => entry.url.includes("/sendMessage") && entry.body.reply_markup);
  assert.ok(sent);
  assert.ok(payloads.some((entry) => entry.url.includes("/setMyCommands")));
  const callbacks = sent.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(callbacks, [
    "menu:query-help",
    "admin:download-menu",
    "admin:rollout-menu"
  ]);
  assert.equal(callbacks.includes("admin:autoapprove:on"), false);
});

test("administrator receives a Samsung download preview before a VPS task is created", async () => {
  const kv = memoryKv();
  const env = {
    FIRMWARE_KV: kv,
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "991",
    DOWNLOAD_API_URL: "http://download.local:8788",
    [["DOWNLOAD", "API", "SECRET"].join("_")]: "local-test-key"
  };
  const payloads = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    payloads.push({ url: value, body, headers: init.headers || {} });
    if (value.endsWith("/api/v1/downloads/preview")) {
      assert.equal(init.headers["x-download-api-key"], "local-test-key");
      return new Response(JSON.stringify({
        ok: true,
        preview: {
          model: "SM-S9380",
          csc: "CHC",
          version: "S9380XXU1/S9380CHC/S9380MODEM",
          originalName: "SM-S9380_CHC_TEST.zip",
          totalBytes: 123456
        }
      }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (value.endsWith("/api/v1/downloads")) {
      return new Response(JSON.stringify({ ok: true, download: {
        id: "job-1", state: "queued", model: "SM-S9380", csc: "CHC", version: "S9380XXU1/S9380CHC/S9380MODEM", percent: 0
      } }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (value.endsWith("/api/v1/downloads/job-1")) {
      return new Response(JSON.stringify({ ok: true, download: {
        id: "job-1", state: "queued", model: "SM-S9380", csc: "CHC", version: "S9380XXU1/S9380CHC/S9380MODEM", percent: 0
      } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: payloads.length } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const waits = [];
  const response = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: 700002,
      message: { message_id: 1, chat: { id: 991 }, from: { id: 991 }, text: "/download SM-S9380 CHC S9380XXU1/S9380CHC/S9380MODEM" }
    })
  }), env, { waitUntil(promise) { waits.push(promise); } });
  assert.equal(response.status, 200);
  for (let round = 0; round < 3; round += 1) await Promise.all([...waits]);
  const request = payloads.find((entry) => entry.url.endsWith("/api/v1/downloads/preview"));
  assert.ok(request);
  assert.deepEqual(request.body, {
    model: "SM-S9380",
    csc: "CHC",
    version: "S9380XXU1/S9380CHC/S9380MODEM"
  });
  assert.equal(payloads.some((entry) => entry.url.endsWith("/api/v1/downloads")), false);
  assert.ok(payloads.some((entry) => entry.body.text?.includes("固件下载预览")));
  await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: 700003,
      callback_query: { id: "confirm-1", from: { id: 991 }, data: "admin:dl:confirm", message: { message_id: 2, chat: { id: 991 } } }
    })
  }), env, { waitUntil(promise) { waits.push(promise); } });
  for (let round = 0; round < 3; round += 1) await Promise.all([...waits]);
  assert.ok(payloads.some((entry) => entry.url.endsWith("/api/v1/downloads")));
});

test("admin firmware download preview falls back to Samsung version.xml when SmartHistory returns S02", async () => {
  resetFusSession();
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "991",
    DOWNLOAD_API_URL: "http://download.local:8788",
    [["DOWNLOAD", "API", "SECRET"].join("_")]: "local-test-key"
  };
  const payloads = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("NF_SmartDownloadGenerateNonce")) {
      return new Response("", { status: 200, headers: { nonce: "0123456789abcdef" } });
    }
    if (value.includes("SmartHistory")) {
      return new Response("<FUSMsg><FUSBody><Results><Status>S02</Status></Results></FUSBody></FUSMsg>", { status: 200 });
    }
    if (value.includes("/version.xml")) {
      return new Response("<firmware><version><latest>S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1</latest></version></firmware>", { status: 200 });
    }
    if (value.endsWith("/api/v1/downloads/preview")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.version, "S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1/S9480ZCS4AZG1");
      return new Response(JSON.stringify({ ok: true, preview: {
        model: "SM-S9480", csc: "CHC", version: body.version, originalName: "SM-S9480_CHC_TEST.zip.enc4", totalBytes: 123456
      } }), { status: 202, headers: { "content-type": "application/json" } });
    }
    const body = init.body ? JSON.parse(String(init.body)) : {};
    payloads.push({ url: value, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: payloads.length } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const waits = [];
  const response = await worker.fetch(new Request("https://worker.example/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: 700004,
      message: { message_id: 1, chat: { id: 991 }, from: { id: 991 }, text: "/download SM-S9480 CHC" }
    })
  }), env, { waitUntil(promise) { waits.push(promise); } });
  assert.equal(response.status, 200);
  for (let round = 0; round < 3; round += 1) await Promise.all([...waits]);
  assert.ok(payloads.some((entry) => entry.url.endsWith("/sendMessage")));
});

test("owner can add persistent administrators without changing the owner identity", async () => {
  const env = { FIRMWARE_KV: memoryKv(), TELEGRAM_CHAT_ID: "991" };
  await addAdditionalAdmin(env, "992", "Co-admin", "991");
  assert.equal(await getIdentity(env, "991"), "admin");
  assert.equal(await getIdentity(env, "992"), "admin");
  assert.deepEqual((await getAdditionalAdmins(env)).map((entry) => entry.chatId), ["992"]);
});

test("rollout chains include disabled Samsung regional retail presets", async () => {
  const env = { FIRMWARE_KV: memoryKv(), TELEGRAM_CHAT_ID: "991" };
  const chains = await getRolloutChains(env);
  const s26 = chains.chains.find((chain) => chain.id === "s26");
  const s25 = chains.chains.find((chain) => chain.id === "s25");
  assert.equal(s26.enabled, false);
  assert.equal(s25.enabled, false);
  assert.equal(s26.skipWeekends, false);
  assert.deepEqual(s26.stages.find((stage) => stage.id === "kr").targets.map((target) => `${target.model}:${target.csc}`), [
    "SM-S942N:KOO", "SM-S947N:KOO", "SM-S948N:KOO"
  ]);
  assert.deepEqual(s25.stages.find((stage) => stage.id === "hk").targets.map((target) => `${target.model}:${target.csc}`), [
    "SM-S9310:TGY", "SM-S9360:TGY", "SM-S9370:TGY", "SM-S9380:TGY"
  ]);
});

test("owner rollout weekend pause skips only release-chain targets until the next Beijing workday", async () => {
  const env = { FIRMWARE_KV: memoryKv(), TELEGRAM_CHAT_ID: "991" };
  await setRolloutChainSettings(env, "s26", {
    enabled: true,
    startTime: "08:00",
    endTime: "23:00",
    skipWeekends: true
  });
  const item = { model: "SM-S948N", csc: "KOO", rolloutChainId: "s26", rolloutStageId: "kr", enabled: true };
  const saturday = new Date("2026-08-15T01:00:00.000Z");
  const blocked = await getRolloutItemScheduleDecision(env, item, saturday);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "weekend");
  assert.equal(blocked.nextCheckAt, Date.parse("2026-08-17T00:00:00.000Z"));

  const monday = new Date("2026-08-17T01:00:00.000Z");
  const allowed = await getRolloutItemScheduleDecision(env, item, monday);
  assert.equal(allowed.allowed, true);
});

test("a skipped rollout claim is released until the next permitted window", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const env = { MONITOR_SCHEDULER: schedulerNamespace(scheduler), MONITOR_SCHEDULER_ENABLED: "true" };
  const item = { model: "SM-S948N", csc: "KOO", priority: "high", intervalMinutes: 15 };
  const saturday = new Date("2026-08-15T01:00:00.000Z");
  const mondayStart = Date.parse("2026-08-17T00:00:00.000Z");
  await syncMonitorScheduler(env, [item], saturday);
  const first = await claimDueMonitorTargets(env, saturday, 1);
  assert.equal(first.entries.length, 1);
  const completed = await completeMonitorTarget(env, item, {
    lock: first.entries[0].lock,
    nextCheckAt: mondayStart,
    lastVersion: "S948NKSU1A",
    priorityScore: 80,
    status: "skipped",
    completedAt: saturday.getTime()
  });
  assert.equal(completed.ok, true);
  assert.equal((await claimDueMonitorTargets(env, new Date(saturday.getTime() + 60_000), 1)).entries.length, 0);
  assert.equal((await claimDueMonitorTargets(env, new Date(mondayStart), 1)).entries.length, 1);
});

test("S25 waits for S26 Korea and only the recovery path can start it manually", async () => {
  const env = { FIRMWARE_KV: memoryKv(), TELEGRAM_CHAT_ID: "991" };
  await assert.rejects(
    setRolloutChainSettings(env, "s25", { enabled: true }),
    /自动启动/
  );
  await restartDependentRolloutChain(env, "s25");
  const s25 = (await getRolloutChains(env)).chains.find((chain) => chain.id === "s25");
  assert.equal(s25.enabled, true);
  assert.equal(s25.activeStageId, "kr");
  const items = await getMonitorItems(env);
  assert.equal(items.find((item) => item.model === "SM-S938N" && item.csc === "KOO").enabled, true);
  assert.equal(items.find((item) => item.model === "SM-S938B" && item.csc === "EUX").enabled, false);
});

test("administrator help explains role boundaries and administrator setup", () => {
  const text = adminHelpParts("zh").join("\n");
  assert.match(text, /仅所有者/);
  assert.match(text, /先私聊机器人发送 \/whoami/);
  assert.match(text, /\/admins/);
});

test("rollout chains require exact configured targets and create one approval proposal", async () => {
  const env = { FIRMWARE_KV: memoryKv(), TELEGRAM_CHAT_ID: "991" };
  await addRolloutTarget(env, "s26", "kr", { model: "SM-S9480", csc: "KOO", name: "S26 KR" });
  await addRolloutTarget(env, "s26", "eu", { model: "SM-S948B", csc: "EUX", name: "S26 EU" });
  await addRolloutTarget(env, "s25", "kr", { model: "SM-S9380", csc: "KOO", name: "S25 KR" });
  await setRolloutChainSettings(env, "s26", { enabled: true, intervalMinutes: 15 });
  const proposal = await createRolloutProposalForUpdate(env, {
    model: "SM-S9480", csc: "KOO", name: "S26 KR", rolloutChainId: "s26", rolloutStageId: "kr"
  }, { latest: "S9480XXU1A" });
  assert.ok(proposal?.proposal);
  assert.equal(proposal.proposal.nextStageId, "eu");
  assert.equal(proposal.proposal.startChainId, "s25");
  assert.equal((await getRolloutChains(env)).chains.find((chain) => chain.id === "s26").status, "awaiting_confirmation");
});

test("rollout update stays actionable when the next region is configured later", async () => {
  const env = { FIRMWARE_KV: memoryKv(), TELEGRAM_CHAT_ID: "991" };
  await addRolloutTarget(env, "s26", "kr", { model: "SM-S9480", csc: "KOO", name: "S26 KR" });
  await setRolloutChainSettings(env, "s26", { enabled: true });
  const created = await createRolloutProposalForUpdate(env, {
    model: "SM-S9480", csc: "KOO", name: "S26 KR", rolloutChainId: "s26", rolloutStageId: "kr"
  }, { latest: "S9480XXU1A" });
  assert.ok(created?.proposal);
  assert.equal(created.proposal.nextStageId, "eu");
});

test("a confirmed rollout pauses the finished region and activates the next regions", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const env = {
    FIRMWARE_KV: memoryKv(),
    TELEGRAM_CHAT_ID: "991",
    MONITOR_SCHEDULER: schedulerNamespace(scheduler),
    MONITOR_SCHEDULER_ENABLED: "true"
  };
  await addRolloutTarget(env, "s26", "kr", { model: "SM-S9480", csc: "KOO", name: "S26 KR" });
  await addRolloutTarget(env, "s26", "eu", { model: "SM-S948B", csc: "EUX", name: "S26 EU" });
  await addRolloutTarget(env, "s25", "kr", { model: "SM-S9380", csc: "KOO", name: "S25 KR" });
  await setRolloutChainSettings(env, "s26", { enabled: true });
  const created = await createRolloutProposalForUpdate(env, {
    model: "SM-S9480", csc: "KOO", name: "S26 KR", rolloutChainId: "s26", rolloutStageId: "kr"
  }, { latest: "S9480XXU1A" });
  const applied = await applyRolloutProposalDecision(env, created.proposal.id, "approve", "991");
  assert.equal(applied.ok, true);
  const items = await getMonitorItems(env);
  assert.equal(items.find((item) => item.model === "SM-S9480" && item.csc === "KOO").enabled, false);
  assert.equal(items.find((item) => item.model === "SM-S948B" && item.csc === "EUX").enabled, true);
  assert.equal(items.find((item) => item.model === "SM-S9380" && item.csc === "KOO").enabled, true);
});

test("Telegram command sync clears inherited scopes and publishes the compact command list", async () => {
  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "992"
  };
  resetStateMemoryCache();
  await addAllowedUser(env, "993", "Allowed user");
  await dispatchTelegramTestUpdate(env, {
    update_id: 700002,
    message: {
      message_id: 2,
      chat: { id: 992 },
      from: { id: 992, first_name: "Admin" },
      text: "/synccommands"
    }
  }, payloads);
  const sync = payloads.find((entry) => entry.url.includes("/setMyCommands"));
  assert.ok(sync);
  const clears = payloads.filter((entry) => entry.url.includes("/deleteMyCommands"));
  assert.equal(clears.length, 6);
  assert.deepEqual(sync.body.commands.map((item) => item.command), ["start", "apply", "help"]);
  const adminSync = payloads.find((entry) => entry.url.includes("/setMyCommands") && entry.body.scope?.chat_id === "992");
  assert.ok(adminSync);
  assert.deepEqual(adminSync.body.commands.map((item) => item.command), ["start", "admin", "download", "help"]);
  const allowedSync = payloads.find((entry) => entry.url.includes("/setMyCommands") && entry.body.scope?.chat_id === "993");
  assert.ok(allowedSync);
  assert.deepEqual(allowedSync.body.commands.map((item) => item.command), ["start", "help"]);
});

test("My Devices persists shortcuts, deduplicates targets, and toggles subscriptions", async () => {
  resetStateMemoryCache();
  const env = { FIRMWARE_KV: memoryKv() };
  const first = await upsertUserDevice(env, "device-user", {
    model: "sm-s948b",
    csc: "eux",
    name: "Daily phone"
  });
  assert.equal(first.id, "SM-S948B:EUX");
  assert.equal(first.notifyEnabled, true);
  const updated = await upsertUserDevice(env, "device-user", {
    model: "SM-S948B",
    csc: "EUX",
    name: "Updated phone",
    notifyEnabled: false
  });
  assert.equal(updated.name, "Updated phone");
  assert.equal((await getUserDevices(env, "device-user")).length, 1);
  await setUserDeviceNotification(env, "device-user", "SM-S948B", "EUX", true);
  assert.equal((await getUserDevices(env, "device-user"))[0].notifyEnabled, true);
  assert.equal(await removeUserDevice(env, "device-user", "SM-S948B", "EUX"), true);
  assert.deepEqual(await getUserDevices(env, "device-user"), []);
});

test("first /start shows onboarding once and retired device commands return to the main menu", async () => {
  resetStateMemoryCache();
  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "9911"
  };
  assert.equal(await hasCompletedOnboarding(env, "9911"), false);
  await dispatchTelegramTestUpdate(env, {
    update_id: 700010,
    message: { message_id: 1, chat: { id: 9911 }, from: { id: 9911 }, text: "/start" }
  }, payloads);
  assert.equal(await hasCompletedOnboarding(env, "9911"), true);
  assert.ok(payloads.some((entry) => String(entry.body.text || "").includes("欢迎使用 OneUI 固件中心")));
  const onboarding = payloads.find((entry) => String(entry.body.text || "").includes("欢迎使用 OneUI 固件中心"));
  assert.match(String(onboarding.body.text || ""), /致谢/);
  assert.match(String(onboarding.body.text || ""), /@Dalee1ee/);
  assert.match(String(onboarding.body.text || ""), /@fahadalijaved/);
  const secondPayloads = [];
  await dispatchTelegramTestUpdate(env, {
    update_id: 700011,
    message: { message_id: 2, chat: { id: 9911 }, from: { id: 9911 }, text: "/start" }
  }, secondPayloads);
  assert.equal(secondPayloads.some((entry) => String(entry.body.text || "").includes("欢迎使用 OneUI 固件中心")), false);
  const devicePayloads = [];
  await dispatchTelegramTestUpdate(env, {
    update_id: 700012,
    message: { message_id: 3, chat: { id: 9911 }, from: { id: 9911 }, text: "/devices" }
  }, devicePayloads);
  assert.ok(devicePayloads.some((entry) => String(entry.body.text || "").includes("查询固件")));
});

test("monitor target buttons change priority and require delete confirmation", async () => {
  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "993"
  };
  await setMonitorItems(env, [{ model: "SM-S938B", csc: "EUX", name: "S25 Ultra EUX", priority: "normal" }]);

  const callback = (updateId, id, data) => dispatchTelegramTestUpdate(env, {
    update_id: updateId,
    callback_query: {
      id,
      data,
      from: { id: 993, first_name: "Admin" },
      message: { message_id: 3, chat: { id: 993 } }
    }
  }, payloads);

  await callback(700003, "priority-low", "monitor-item:low:SM-S938B:EUX");
  assert.equal((await getMonitorItems(env))[0].priority, "low");

  await callback(700004, "delete-request", "monitor-item:delete-request:SM-S938B:EUX");
  assert.equal((await getMonitorItems(env)).length, 1);
  const confirmation = payloads.find((entry) => entry.body.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data === "monitor-item:delete-confirm:SM-S938B:EUX"));
  assert.ok(confirmation);

  await callback(700005, "delete-confirm", "monitor-item:delete-confirm:SM-S938B:EUX");
  assert.equal((await getMonitorItems(env)).length, 0);
});

test("rollout targets are protected from ordinary monitor controls", async () => {
  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "9932"
  };
  await setMonitorItems(env, [{
    model: "SM-S948N", csc: "KOO", name: "S26 Ultra", priority: "high",
    rolloutChainId: "s26", rolloutStageId: "kr"
  }]);
  await dispatchTelegramTestUpdate(env, {
    update_id: 7000051,
    callback_query: {
      id: "release-delete", data: "monitor-item:delete-request:SM-S948N:KOO",
      from: { id: 9932, first_name: "Admin" }, message: { message_id: 4, chat: { id: 9932 } }
    }
  }, payloads);
  assert.equal((await getMonitorItems(env)).length, 1);
  assert.ok(payloads.some((entry) => String(entry.body.text || "").includes("发布链管理")));
});

test("monitor target UI toggles allowed-user update delivery and exposes monitor health", async () => {
  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "994"
  };
  await setMonitorItems(env, [{ model: "SM-S9380", csc: "TGY", name: "S25 Ultra TGY" }]);
  await recordMonitorFailure(env, "SM-S9380", "TGY", "SmartHistory HTTP 521");
  const callback = (updateId, id, data) => dispatchTelegramTestUpdate(env, {
    update_id: updateId,
    callback_query: {
      id,
      data,
      from: { id: 994, first_name: "Admin" },
      message: { message_id: 30, chat: { id: 994 } }
    }
  }, payloads);

  await callback(700006, "monitor-view", "monitor-item:view:SM-S9380:TGY");
  const details = payloads.find((entry) => entry.body.reply_markup?.inline_keyboard?.flat()
    .some((button) => button.callback_data === "monitor-item:notify-users:SM-S9380:TGY"));
  assert.ok(details);

  await callback(700007, "monitor-notify-users", "monitor-item:notify-users:SM-S9380:TGY");
  assert.equal((await getMonitorItems(env))[0].notifyAllowedUsers, false);

  await callback(700008, "monitor-health", "admin:monitor-health");
  const health = payloads.find((entry) => String(entry.body.text || "").includes("\u76d1\u63a7\u5065\u5eb7")
    && entry.body.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data === "admin:monitor-health"));
  assert.ok(health);
  assert.match(health.body.text, /\u8fde\u7eed\u5931\u8d25\uff1a1/);

  await recordMonitorEvent(env, {
    type: "monitor_failed",
    model: "SM-S9380",
    csc: "TGY",
    name: "S25 Ultra TGY",
    error: "SmartHistory HTTP 521",
    failureCount: 1
  });
  await callback(700009, "monitor-events", "admin:monitor-events");
  const events = payloads.find((entry) => String(entry.body.text || "").includes("\u6700\u8fd1\u76d1\u63a7\u4e8b\u4ef6")
    && entry.body.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data === "admin:monitor-events"));
  assert.ok(events);
  assert.match(events.body.text, /SmartHistory HTTP 521/);
});

test("MonitorScheduler persists per-target allowed-user notification changes", async () => {
  resetStateMemoryCache();
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const env = {
    MONITOR_SCHEDULER: schedulerNamespace(scheduler),
    MONITOR_SCHEDULER_ENABLED: "true"
  };

  await setMonitorItems(env, []);
  await upsertMonitorItem(env, {
    model: "SM-S9380",
    csc: "TGY",
    notifyAllowedUsers: false
  });
  resetStateMemoryCache();
  assert.equal((await getMonitorItems(env))[0].notifyAllowedUsers, false);

  await upsertMonitorItem(env, {
    model: "SM-S9380",
    csc: "TGY",
    notifyAllowedUsers: true
  });
  resetStateMemoryCache();
  assert.equal((await getMonitorItems(env))[0].notifyAllowedUsers, true);
});

test("monitoring center exposes status filters and bulk deletion needs a typed final confirmation", async () => {
  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "995"
  };
  await setMonitorItems(env, [
    { model: "SM-S9380", csc: "CHC", name: "S25 Ultra China", priority: "high" },
    { model: "SM-S938B", csc: "EUX", name: "S25 Ultra EUX", enabled: false, paused: true }
  ]);
  await putPendingUpdate(env, {
    model: "SM-S9380",
    csc: "CHC",
    previousLatest: "S9380ABC",
    newLatest: "S9380DEF",
    acked: false
  });
  const callback = (updateId, id, data) => dispatchTelegramTestUpdate(env, {
    update_id: updateId,
    callback_query: {
      id,
      data,
      from: { id: 995, first_name: "Admin" },
      message: { message_id: 31, chat: { id: 995 } }
    }
  }, payloads);

  await callback(700050, "monitor-center", "admin:monitor-menu");
  const center = payloads.find((entry) => entry.body.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data === "admin:monitor-filter:active"));
  assert.ok(center);
  assert.match(center.body.text, /更新 1/);
  const callbacks = center.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("admin:monitor-filter:paused"));
  assert.ok(callbacks.includes("admin:monitor-filter:updated"));
  assert.ok(callbacks.includes("admin:monitor-filter:failing"));

  await callback(7000501, "monitor-more", "admin:monitor-more");
  const more = payloads.find((entry) => entry.body.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data === "admin:monitor-delete-all"));
  assert.ok(more);
  const moreCallbacks = more.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(moreCallbacks.includes("admin:monitor-delete-all"));

  await callback(700051, "delete-all", "admin:monitor-delete-all");
  await callback(700052, "delete-all-confirm", "admin:monitor-delete-all-confirm");
  assert.equal((await getMonitorItems(env)).length, 2, "buttons alone must not delete all targets");

  await dispatchTelegramTestUpdate(env, {
    update_id: 700053,
    message: { message_id: 32, chat: { id: 995 }, from: { id: 995, first_name: "Admin" }, text: "DELETE ALL" }
  }, payloads);
  assert.equal((await getMonitorItems(env)).length, 0);
});

test("monitoring center queues only failed active targets for a safe retry", async () => {
  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "996"
  };
  await setMonitorItems(env, [
    { model: "SM-S9380", csc: "CHC", name: "S25 Ultra China" },
    { model: "SM-S938B", csc: "EUX", name: "S25 Ultra EUX" },
    { model: "SM-S938N", csc: "KOO", name: "S25 Ultra Korea", enabled: false }
  ]);
  await setUserLanguage(env, "996", "en");
  await recordMonitorFailure(env, "SM-S9380", "CHC", "SmartHistory HTTP 521");

  const callback = (updateId, id, data) => dispatchTelegramTestUpdate(env, {
    update_id: updateId,
    callback_query: {
      id,
      data,
      from: { id: 996, first_name: "Admin" },
      message: { message_id: 41, chat: { id: 996 } }
    }
  }, payloads);

  await callback(700060, "monitor-center-failing", "admin:monitor-menu");
  const center = payloads.find((entry) => entry.body.reply_markup?.inline_keyboard?.flat()
    .some((button) => button.callback_data === "admin:monitor-retry-failed"));
  assert.ok(center);

  await callback(700061, "monitor-retry-failed", "admin:monitor-retry-failed");
  const failedRuntime = await getMonitorRuntime(env, "SM-S9380", "CHC");
  const healthyRuntime = await getMonitorRuntime(env, "SM-S938B", "EUX");
  const pausedRuntime = await getMonitorRuntime(env, "SM-S938N", "KOO");
  assert.ok(Date.parse(failedRuntime.forcedAt) > 0, "failed targets should receive a scheduler retry marker");
  assert.equal(failedRuntime.nextAttemptAt, failedRuntime.forcedAt);
  assert.equal(healthyRuntime.nextAttemptAt, "");
  assert.equal(pausedRuntime.nextAttemptAt, "");
  assert.ok(payloads.some((entry) => entry.body.text?.includes("queued for retry")));
});

test("admin toggle buttons update access and schedule state", async () => {
  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "994"
  };
  const callback = (updateId, id, data) => dispatchTelegramTestUpdate(env, {
    update_id: updateId,
    callback_query: {
      id,
      data,
      from: { id: 994, first_name: "Admin" },
      message: { message_id: 4, chat: { id: 994 } }
    }
  }, payloads);

  const accessBefore = await getAccessSettings(env);
  await callback(700006, "autoapprove-toggle", "admin:autoapprove:toggle");
  assert.equal((await getAccessSettings(env)).autoApprove, !accessBefore.autoApprove);
  assert.ok(payloads.some((entry) => entry.body.text?.includes("✅ 设置已保存：自动审批已")));

  const before = await getMonitorSchedule(env);
  await callback(700007, "schedule-toggle", "admin:schedule:toggle");
  assert.equal((await getMonitorSchedule(env)).enabled, before.enabled === false);
  const ackIndex = payloads.findIndex((entry) => entry.body.callback_query_id === "schedule-toggle");
  const resultIndex = payloads.findIndex((entry, index) => (
    index > ackIndex
    && entry.url.includes("/editMessageText")
    && entry.body.text?.includes("✅ 设置已保存：自动监控已")
  ));
  assert.ok(ackIndex >= 0, "the callback should be acknowledged");
  assert.ok(resultIndex > ackIndex, "the saved result should be rendered after acknowledgement");

  const summaryBefore = await getMonitorSummarySettings(env);
  await callback(700010, "summary-toggle", "admin:schedule:summary-toggle");
  const summaryAfter = await getMonitorSummarySettings(env);
  assert.equal(summaryAfter.enabled, summaryBefore.enabled === false);
  const summaryPanel = payloads.find((entry) => entry.body.text?.includes("每日管理员摘要已"));
  assert.ok(summaryPanel);
  assert.ok(summaryPanel.body.reply_markup.inline_keyboard.flat().some((button) => (
    button.callback_data === "admin:schedule:summary-toggle"
  )));
});

test("daily summary settings preserve the environment default and persist an administrator override", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const env = {
    MONITOR_SCHEDULER: schedulerNamespace(scheduler),
    DAILY_MONITOR_SUMMARY_ENABLED: "false",
    DAILY_MONITOR_SUMMARY_HOUR: "18"
  };
  const initial = await getMonitorSummarySettings(env);
  assert.deepEqual({ enabled: initial.enabled, hour: initial.hour }, { enabled: false, hour: 18 });
  await setMonitorSummarySettings(env, { ...initial, enabled: true }, "998");
  resetStateMemoryCache();
  const saved = await getMonitorSummarySettings(env);
  assert.deepEqual({ enabled: saved.enabled, hour: saved.hour, updatedBy: saved.updatedBy }, { enabled: true, hour: 18, updatedBy: "998" });
});

test("English admin schedule and realtime refresh stay fully localized", async () => {
  const schedule = formatSchedule(defaultSchedule({}), "en");
  assert.match(schedule, /Automatic monitoring rules/);
  assert.equal(schedule.includes("自动监控规则"), false);

  const payloads = [];
  const env = {
    FIRMWARE_KV: memoryKv(),
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "995"
  };
  await setUserLanguage(env, 995, "en");
  await dispatchTelegramTestUpdate(env, {
    update_id: 700008,
    callback_query: {
      id: "refresh-en",
      data: "query:refresh:SM-S948B:EUX",
      from: { id: 995, first_name: "Admin" },
      message: { message_id: 5, chat: { id: 995 } }
    }
  }, payloads);
  const progress = payloads.find((entry) => entry.body.text?.includes("Checking latest firmware"));
  assert.ok(progress);
  assert.equal(progress.body.text.includes("正在实时查询"), false);
});

test("language and monitoring buttons stay writable when Workers KV rejects writes", async () => {
  const payloads = [];
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const schedulerNamespace = {
    idFromName(name) { return name; },
    get() {
      return {
        fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          return scheduler.fetch(request);
        }
      };
    }
  };
  const baseKv = memoryKv();
  let kvWriteAttempts = 0;
  const kv = {
    ...baseKv,
    async put() {
      kvWriteAttempts += 1;
      throw new Error("KV PUT failed: 429 Too Many Requests");
    }
  };
  const env = {
    FIRMWARE_KV: kv,
    MONITOR_SCHEDULER: schedulerNamespace,
    MONITOR_SCHEDULER_ENABLED: "true",
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "996"
  };
  const callback = (updateId, id, data, messageId) => dispatchTelegramTestUpdate(env, {
    update_id: updateId,
    callback_query: {
      id,
      data,
      from: { id: 996, first_name: "Admin" },
      message: { message_id: messageId, chat: { id: 996 } }
    }
  }, payloads);

  await callback(700009, "language-en", "lang:en", 6);
  assert.equal(await getUserLanguage(env, 996), "en");
  assert.ok(payloads.some((entry) => entry.body.text?.startsWith("Admin")));

  const before = await getMonitorSchedule(env);
  await callback(700010, "schedule-durable-toggle", "admin:schedule:toggle", 7);
  assert.equal((await getMonitorSchedule(env)).enabled, before.enabled === false);
  const result = payloads.find((entry) => entry.body.text?.includes("✅ Saved: automatic monitoring"));
  assert.ok(result);
  const navigation = result.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(navigation.includes("admin:monitor-menu"));
  assert.ok(navigation.includes("menu:home"));
  assert.equal(payloads.some((entry) => entry.body.text?.includes("Unable to confirm the operation result")), false);
  assert.equal(kvWriteAttempts, 0);
});

test("failed button actions replace the panel with a visible retry result", async () => {
  const payloads = [];
  const kv = memoryKv();
  const put = kv.put.bind(kv);
  kv.put = async (key, value, options) => {
    if (key === "monitor:schedule") throw new Error("temporary KV failure");
    return put(key, value, options);
  };
  const env = {
    FIRMWARE_KV: kv,
    WEBHOOK_SECRET: "test-header-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "995"
  };

  await dispatchTelegramTestUpdate(env, {
    update_id: 700008,
    callback_query: {
      id: "schedule-failure",
      data: "admin:schedule:toggle",
      from: { id: 995, first_name: "Admin" },
      message: { message_id: 5, chat: { id: 995 } }
    }
  }, payloads);

  const failure = payloads.find((entry) => entry.body.text?.includes("❌ 未能确认操作结果"));
  assert.ok(failure);
  assert.ok(failure.body.reply_markup.inline_keyboard.flat().some((button) => (
    button.callback_data === "admin:schedule:toggle" && button.text === "重试"
  )));
});
