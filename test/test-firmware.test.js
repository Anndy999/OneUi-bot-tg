import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InMemoryTestFirmwareHistoryRepository } from "../src/vps/test-firmware-history.js";
import { runTestFirmwareDecryptor } from "../src/vps/test-firmware-decryptor.js";
import {
  bootstrapTestFirmwarePipeline,
  SCAN_LOCK_KEY,
  confirmKooAndEnableEux,
  executeTestFirmwareScan,
  handleTestFirmwareTelegramCommand,
  maybeScheduleTestFirmwareScan,
  processTestFirmwareMaintenanceJob,
  releasePublicTestFirmware,
  renderTestFirmwareStatusPanel,
  scanTestFirmwareTarget,
  startupScanIdFor,
  testBuildText,
  testFirmwareProgressText,
  withTestFirmwareScanLock
} from "../src/vps/test-firmware-scan.js";
import { MemoryLockService } from "../src/runtime/locks.js";
import { MemoryStorage } from "../src/runtime/storage.js";
import {
  addAdditionalAdmin,
  addAllowedUser,
  getMonitorItems,
  resetStateMemoryCache
} from "../src/state.js";
import {
  activateTestFirmwareRolloutStage,
  applyRolloutProposalDecision,
  createRolloutProposalForUpdate,
  getRolloutChains
} from "../src/rollout-chain.js";

const MODEL = "SM-S9480";
const CSC = "CHC";
const LATEST = "S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1/S9480ZCS4AZG1";
const RESOLVED_HASH = "51d21620bea9bf325b9adb2c02ed1d0e";
const TEST_XML = `<root><value>${RESOLVED_HASH}</value></root>`;
const KOO_VERSION_WITHOUT_LATEST = "S948NKSU0AVA1/S948NOKR0AVA1/S948NKSU0AVA1";
const KOO_MD5_WITHOUT_LATEST = createHash("md5").update(KOO_VERSION_WITHOUT_LATEST).digest("hex");
const KOO_HASHFIRM_RANGE_VERSION = "S948NKST0AUA0/S948NOKR0AUA0/S948NKST0AUA0";
const KOO_HASHFIRM_RANGE_MD5 = createHash("md5").update(KOO_HASHFIRM_RANGE_VERSION).digest("hex");
const KOO_HMAC_SHA256 = "6d67e7dcb90d17d83b482064e3deaeb882ae9f7341f41aada162f8cb57232c07";
const KOO_CROSS_CP_VERSION = "S948NKSU4AZH2/S948NOKR4AZH2/S948NKSS4AZG1";
const KOO_CROSS_CP_MD5 = createHash("md5").update(KOO_CROSS_CP_VERSION).digest("hex");
const CHC_CURRENT_TEST_VERSION = "S9480ZCS4AZH1/S9480CHC4AZH1/S9480ZCS4AZH1";
const CHC_CURRENT_TEST_MD5 = createHash("md5").update(CHC_CURRENT_TEST_VERSION).digest("hex");
const UNRESOLVED_SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MULTI_TEST_VERSIONS = [
  "S9480ZCU0AVA1/S9480CHC0AVA1/S9480ZCU0AVA1",
  "S9480ZCU0AVA3/S9480CHC0AVA3/S9480ZCU0AVA3",
  "S9480ZCU0AVB1/S9480CHC0AVB1/S9480ZCU0AVB1"
];
const MULTI_TEST_XML = `<root>${MULTI_TEST_VERSIONS
  .map((version) => `<value>${createHash("md5").update(version).digest("hex")}</value>`)
  .join("")}</root>`;

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

function runtime({ queue = [], history = new InMemoryTestFirmwareHistoryRepository(), items = [] } = {}) {
  return {
    env: {
      TELEGRAM_CHAT_ID: "100",
      MONITOR_ITEMS_JSON: JSON.stringify(items),
      NOTIFICATION_QUEUE_ENABLED: "true",
      NOTIFICATION_QUEUE: { async send(message) { queue.push(message); } },
      TEST_FIRMWARE_PYTHON_BIN: process.platform === "win32" ? "python" : "python3"
    },
    config: {
      testFirmwareRequestTimeoutMs: 12_000,
      testFirmwareDecryptTimeoutMs: 120_000,
      testFirmwareMaxCandidates: 10_000_000,
      testFirmwareScanLockMs: 30_000,
      testFirmwareScanEnabled: true,
      testFirmwareScanTime: "18:00",
      testFirmwareReleaseId: "2.22.1"
    },
    context: { locks: new MemoryLockService() },
    queues: { maintenance: { async add(_name, data) { queue.push({ maintenance: true, data }); } } },
    testFirmwareHistory: history,
    queue,
    pool: null
  };
}

test("version.test.xml parsing and verified MD5 matching work without network access", async () => {
  const progress = [];
  const result = await runTestFirmwareDecryptor({
    model: MODEL,
    csc: CSC,
    latestVersion: LATEST,
    testXml: `<root><value>${RESOLVED_HASH}</value><value>${RESOLVED_HASH.toUpperCase()}</value></root>`
  }, {
    env: { TEST_FIRMWARE_PYTHON_BIN: process.platform === "win32" ? "python" : "python3" },
    timeoutMs: 120_000,
    logger: quietLogger(),
    onProgress: (event) => progress.push(event)
  });
  assert.equal(result.ok, true);
  assert.equal(result.hashes.length, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].pda, "S9480ZCU0AVA1");
  assert.equal(result.matches[0].csc_build, "S9480CHC0AVA1");
  assert.equal(result.matches[0].cp, "S9480ZCU0AVA1");
  assert.equal(progress.some((event) => event.phase === "decrypting"), true);
  assert.equal(progress.some((event) => event.phase === "finalizing"), true);
});

test("KOO fallback ranges resolve the regional build when version.test.xml has no latest tag", async () => {
  const result = await runTestFirmwareDecryptor({
    model: "SM-S948N",
    csc: "KOO",
    testXml: `<root><value>${KOO_MD5_WITHOUT_LATEST}</value></root>`
  }, {
    env: { TEST_FIRMWARE_PYTHON_BIN: process.platform === "win32" ? "python" : "python3" },
    timeoutMs: 120_000,
    logger: quietLogger()
  });
  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].version, KOO_VERSION_WITHOUT_LATEST);
});

test("Samsung HMAC-SHA256 test hashes resolve to the latest candidate", async () => {
  const result = await runTestFirmwareDecryptor({
    model: "SM-S948N",
    csc: "KOO",
    testXml: `<root><value>${KOO_HMAC_SHA256}</value></root>`
  }, {
    env: { TEST_FIRMWARE_PYTHON_BIN: process.platform === "win32" ? "python" : "python3" },
    timeoutMs: 120_000,
    logger: quietLogger()
  });
  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].version, KOO_VERSION_WITHOUT_LATEST);
});

test("bounded CP seed pool resolves a regional CP from the previous month", async () => {
  const result = await runTestFirmwareDecryptor({
    model: "SM-S948N",
    csc: "KOO",
    latestVersion: KOO_CROSS_CP_VERSION,
    testXml: `<root><value>${KOO_CROSS_CP_MD5}</value></root>`
  }, {
    env: { TEST_FIRMWARE_PYTHON_BIN: process.platform === "win32" ? "python" : "python3" },
    timeoutMs: 120_000,
    logger: quietLogger()
  });
  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].version, KOO_CROSS_CP_VERSION);
});

test("canonical current-month builds are resolved before the CP expansion cap", async () => {
  const result = await runTestFirmwareDecryptor({
    model: MODEL,
    csc: CSC,
    latestVersion: LATEST,
    testXml: `<root><value>${CHC_CURRENT_TEST_MD5}</value></root>`
  }, {
    env: { TEST_FIRMWARE_PYTHON_BIN: process.platform === "win32" ? "python" : "python3" },
    timeoutMs: 120_000,
    logger: quietLogger()
  });
  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].version, CHC_CURRENT_TEST_VERSION);
  assert.equal(result.candidateLimitReached, false);
});

test("Samsung candidate ranges include zero builds, six year codes, and T engineering builds", async () => {
  const result = await runTestFirmwareDecryptor({
    model: "SM-S948N",
    csc: "KOO",
    testXml: `<root><value>${KOO_HASHFIRM_RANGE_MD5}</value></root>`
  }, {
    env: { TEST_FIRMWARE_PYTHON_BIN: process.platform === "win32" ? "python" : "python3" },
    timeoutMs: 120_000,
    logger: quietLogger()
  });
  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].version, KOO_HASHFIRM_RANGE_VERSION);
});

test("resolved test-build notification uses the compact full-version wording", () => {
  assert.equal(
    testBuildText({ model: "SM-S9480", csc: "CHC" }, {
      pda: "S9480ZCS4AZG1",
      csc_build: "S9480CHC4AZG1",
      cp: "S9480ZCS4AZG1"
    }, new Date(), "zh"),
    "🆕 新 Samsung 测试固件！\n\nSM-S9480 / CHC\n\n完整固件版本号：S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1"
  );
});

test("automatic KOO progress clearly reports the deployment trigger and result", () => {
  const started = testFirmwareProgressText({ model: "SM-S948N", csc: "KOO" }, {}, 0, 1, null, { automatic: true });
  const finished = testFirmwareProgressText({ model: "SM-S948N", csc: "KOO" }, {}, 0, 1, {
    ok: true,
    resolved: 1,
    failed: 0,
    results: [{
      model: "SM-S948N",
      csc: "KOO",
      status: "resolved",
      resolvedCount: 1,
      resolvedVersion: "S948NKSU0AVA1/S948NOKR0AVA1/S948NKSU0AVA1"
    }]
  }, { automatic: true });
  assert.match(started, /已自动开始测试固件解密/);
  assert.match(started, /触发：机器人更新/);
  assert.match(finished, /自动测试固件解密完成/);
  assert.match(finished, /SM-S948N \/ KOO：最新测试版本/);
  assert.match(finished, /S948NKSU0AVA1\/S948NOKR0AVA1\/S948NKSU0AVA1/);
});

test("known hash is silent and does not run candidate matching", async () => {
  const result = await runTestFirmwareDecryptor({
    model: MODEL,
    csc: CSC,
    latestVersion: LATEST,
    knownHashes: [{ hash_type: "md5", hash_value: RESOLVED_HASH, decrypt_status: "resolved" }],
    testXml: TEST_XML
  }, { env: { TEST_FIRMWARE_PYTHON_BIN: process.platform === "win32" ? "python" : "python3" }, timeoutMs: 120_000, logger: quietLogger() });
  assert.equal(result.ok, true);
  assert.equal(result.selectedHashes.length, 0);
  assert.equal(result.matches.length, 0);
  assert.equal(result.unresolved.length, 0);
});

test("successful new build is persisted, broadcast once, and repeated scans stay quiet", async () => {
  const queue = [];
  const history = new InMemoryTestFirmwareHistoryRepository();
  const app = runtime({ queue, history });
  const first = await scanTestFirmwareTarget(app, { model: MODEL, csc: CSC }, {
    testXml: TEST_XML,
    latestVersionOverride: LATEST,
    now: new Date("2026-08-09T10:00:00.000Z"),
    logger: quietLogger()
  });
  assert.equal(first.status, "resolved");
  assert.equal(first.resolvedCount, 1);
  assert.equal(queue.filter((entry) => entry.id?.startsWith("test-firmware:")).length, 1);
  assert.equal(history.snapshot().history[0].decryptStatus, "resolved");

  const second = await scanTestFirmwareTarget(app, { model: MODEL, csc: CSC }, {
    testXml: TEST_XML,
    latestVersionOverride: LATEST,
    now: new Date("2026-08-09T10:01:00.000Z"),
    logger: quietLogger()
  });
  assert.equal(second.status, "unchanged");
  assert.equal(second.newHashCount, 0);
  assert.equal(queue.filter((entry) => entry.id?.startsWith("test-firmware:")).length, 1);
});

test("progress mode edits one Telegram message and suppresses duplicate result notices", async () => {
  const queue = [];
  const app = runtime({ queue });
  app.env.TELEGRAM_BOT_TOKEN = "unit-test-token";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = String(url).split("/").pop();
    calls.push(method);
    return {
      ok: true,
      status: 200,
      async json() {
        return method === "sendMessage"
          ? { ok: true, result: { message_id: 701 } }
          : { ok: true, result: true };
      }
    };
  };
  try {
    const result = await executeTestFirmwareScan(app, {
      target: { model: MODEL, csc: CSC },
      progressChatId: "100",
      chatId: "100",
      testXml: TEST_XML,
      latestVersionOverride: LATEST,
      logger: quietLogger()
    });
    assert.equal(result.failed, 0);
    assert.equal(result.resolved, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.filter((method) => method === "sendMessage").length, 1);
  assert.equal(calls.filter((method) => method === "editMessageText").length > 0, true);
  assert.equal(queue.some((entry) => entry.id?.startsWith("test-firmware:")), false);
  assert.equal(queue.some((entry) => entry.id?.startsWith("test-firmware-unresolved:")), false);
});

test("KOO result exposes two confirmations and public release stays owner-gated", async () => {
  resetStateMemoryCache();
  const queue = [];
  const history = new InMemoryTestFirmwareHistoryRepository();
  const app = runtime({ queue, history });
  app.env.FIRMWARE_KV = new MemoryStorage();
  app.env.TELEGRAM_BOT_TOKEN = "unit-test-token";
  await addAllowedUser(app.env, "200", "Allowed user");
  const bodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => ({
    ok: true,
    status: 200,
    async json() {
      if (init.body) bodies.push(JSON.parse(init.body));
      return { ok: true, result: { message_id: 701 } };
    }
  });
  try {
    const first = await executeTestFirmwareScan(app, {
      target: { model: "SM-S948N", csc: "KOO" },
      progressChatId: "100",
      chatId: "100",
      testXml: `<root><value>${KOO_MD5_WITHOUT_LATEST}</value></root>`,
      latestVersionOverride: KOO_VERSION_WITHOUT_LATEST,
      logger: quietLogger()
    });
    assert.equal(first.resolved, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const finalProgress = bodies.at(-1);
  const firstCallbacks = finalProgress.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.equal(firstCallbacks.includes("test-fw:confirm-eux"), true);
  assert.equal(firstCallbacks.includes("test-fw:release:pending"), true);

  const confirmed = await confirmKooAndEnableEux(app, "100", quietLogger());
  assert.equal(confirmed.ok, true);
  const newBuild = await scanTestFirmwareTarget(app, { model: "SM-S948N", csc: "KOO" }, {
    testXml: `<root><value>${KOO_CROSS_CP_MD5}</value></root>`,
    latestVersionOverride: KOO_CROSS_CP_VERSION,
    logger: quietLogger()
  });
  assert.equal(newBuild.status, "resolved");
  const ownerNotice = queue.filter((entry) => entry.id?.startsWith("test-firmware:")).at(-1);
  const releaseButton = ownerNotice.replyMarkup.inline_keyboard.flat().find((button) => button.callback_data?.startsWith("test-fw:release:"));
  assert.ok(releaseButton);
  assert.equal(queue.some((entry) => entry.id?.startsWith("test-firmware-public:")), false);

  const released = await releasePublicTestFirmware(app, releaseButton.callback_data.slice("test-fw:release:".length), "100", quietLogger());
  assert.equal(released.ok, true);
  assert.equal(released.recipients, 1);
  assert.equal(queue.filter((entry) => entry.id?.startsWith("test-firmware-public:")).length, 1);
  const duplicate = await releasePublicTestFirmware(app, releaseButton.callback_data.slice("test-fw:release:".length), "100", quietLogger());
  assert.equal(duplicate.reason, "stale_or_missing");
  assert.equal(queue.filter((entry) => entry.id?.startsWith("test-firmware-public:")).length, 1);
});

test("a multi-version test scan stores every result but pushes only the latest one to the owner", async () => {
  resetStateMemoryCache();
  const queue = [];
  const history = new InMemoryTestFirmwareHistoryRepository();
  const app = runtime({ queue, history });
  app.env.FIRMWARE_KV = new MemoryStorage();
  await addAllowedUser(app.env, "200", "Allowed user");
  await addAdditionalAdmin(app.env, "300", "Additional admin", "100");

  const result = await scanTestFirmwareTarget(app, { model: MODEL, csc: CSC }, {
    testXml: MULTI_TEST_XML,
    latestVersionOverride: LATEST,
    logger: quietLogger()
  });
  assert.equal(result.resolvedCount, 3);
  assert.equal(result.resolvedVersion, MULTI_TEST_VERSIONS[2]);
  assert.equal(history.snapshot().history.filter((row) => row.decryptStatus === "resolved").length, 3);

  const notifications = queue.filter((entry) => entry.id?.startsWith("test-firmware:"));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].chatId, "100");
  assert.match(notifications[0].text, /S9480ZCU0AVB1/);
  assert.doesNotMatch(notifications[0].text, /S9480ZCU0AVA1/);
});

test("unresolved SHA-256 is preserved and never sent as a public build notification", async () => {
  const queue = [];
  const history = new InMemoryTestFirmwareHistoryRepository();
  const app = runtime({ queue, history });
  app.env.FIRMWARE_KV = new MemoryStorage();
  resetStateMemoryCache();
  await addAllowedUser(app.env, "200", "Allowed user");
  await addAdditionalAdmin(app.env, "300", "Additional admin", "100");
  const result = await scanTestFirmwareTarget(app, { model: MODEL, csc: CSC }, {
    testXml: `<root><value>${UNRESOLVED_SHA256}</value></root>`,
    latestVersionOverride: LATEST,
    logger: quietLogger()
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.resolvedCount, 0);
  assert.equal(history.snapshot().history[0].decryptStatus, "unresolved");
  assert.equal(queue.some((entry) => entry.id?.startsWith("test-firmware:") && !entry.id.startsWith("test-firmware-unresolved:")), false);
  assert.equal(queue.filter((entry) => entry.id?.startsWith("test-firmware-unresolved:")).length, 1);
  assert.equal(queue.find((entry) => entry.id?.startsWith("test-firmware-unresolved:"))?.chatId, "100");
});

test("scheduled guard and midnight cleanup are persistent in the repository", async () => {
  const queue = [];
  const app = runtime({ queue, items: [{ model: MODEL, csc: CSC, enabled: false }] });
  const at = new Date("2026-08-09T10:00:00.000Z");
  const first = await maybeScheduleTestFirmwareScan(app, at, quietLogger());
  const second = await maybeScheduleTestFirmwareScan(app, at, quietLogger());
  assert.equal(first.scheduled, true);
  assert.equal(second.reason, "already_claimed");
  assert.equal(queue.filter((entry) => entry.maintenance).length, 1);
  assert.equal((await app.testFirmwareHistory.claimDailyCleanup("2026-08-10")), true);
  assert.equal((await app.testFirmwareHistory.claimDailyCleanup("2026-08-10")), false);
});

test("ordinary users cannot enqueue the admin-only test scan command", async () => {
  const queue = [];
  const app = runtime({ queue });
  const handled = await handleTestFirmwareTelegramCommand({
    message: { chat: { id: "200" }, text: "/testscan" }
  }, app, quietLogger());
  assert.equal(handled, true);
  assert.equal(queue.length, 0);
});

test("test scan uses the ordinary query parser for short and lowercase model input", async () => {
  const queue = [];
  const app = runtime({ queue });
  const handled = await handleTestFirmwareTelegramCommand({
    message: { chat: { id: "100" }, text: "/testscan 948n koo" }
  }, app, quietLogger());
  assert.equal(handled, true);
  const job = queue.find((entry) => entry.maintenance);
  assert.deepEqual(job?.data?.target, { model: "SM-S948N", csc: "KOO", key: "SM-S948N:KOO" });
});

test("additional administrators cannot run owner-only test firmware commands during testing", async () => {
  const queue = [];
  const app = runtime({ queue });
  app.env.FIRMWARE_KV = new MemoryStorage();
  resetStateMemoryCache();
  await addAdditionalAdmin(app.env, "300", "Additional admin", "100");
  const handled = await handleTestFirmwareTelegramCommand({
    message: { chat: { id: "300" }, text: "/testscan" }
  }, app, quietLogger());
  assert.equal(handled, true);
  assert.equal(queue.length, 0);
});

test("the global scan lock rejects a concurrent second run", async () => {
  const app = runtime();
  const first = withTestFirmwareScanLock(app, async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return "first";
  }, quietLogger());
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = withTestFirmwareScanLock(app, async () => "second", quietLogger());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, false);
});

test("a scan summary continues after a target-level failure", async () => {
  const app = runtime();
  const result = await executeTestFirmwareScan(app, {
    testXml: () => "<broken",
    latestVersionOverride: LATEST,
    logger: quietLogger()
  });
  assert.equal(result.total, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].model, "SM-S948N");
  assert.equal(result.results[0].status, "failed");
});

test("the staged pipeline scans KOO first and only adds EUX after confirmation", async () => {
  const queue = [];
  const history = new InMemoryTestFirmwareHistoryRepository();
  const app = runtime({ queue, history });
  const first = await executeTestFirmwareScan(app, { testXml: "<root/>", logger: quietLogger() });
  assert.deepEqual(first.results.map((result) => `${result.model}/${result.csc}`), ["SM-S948N/KOO"]);

  await history.upsertResolved({
    model: "SM-S948N",
    csc: "KOO",
    hashType: "md5",
    hashValue: "0123456789abcdef0123456789abcdef",
    pda: "S948NKSU0AVA1",
    cscBuild: "S948NOKR0AVA1",
    cp: "S948NKSU0AVA1"
  });
  const confirmed = await confirmKooAndEnableEux(app, "100", quietLogger());
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.already, false);
  assert.equal(confirmed.queued, true);
  const second = await executeTestFirmwareScan(app, { testXml: "<root/>", logger: quietLogger() });
  assert.deepEqual(second.results.map((result) => `${result.model}/${result.csc}`), ["SM-S948N/KOO", "SM-S948B/EUX"]);
  assert.equal(queue.some((entry) => entry.maintenance && entry.data.kind === "test-firmware-eux-scan"), true);
});

test("test firmware panel exposes status and an inline-only EUX confirmation gate", async () => {
  const history = new InMemoryTestFirmwareHistoryRepository();
  const app = runtime({ history });
  await history.upsertResolved({
    model: "SM-S948N",
    csc: "KOO",
    hashType: "md5",
    hashValue: "0123456789abcdef0123456789abcdef",
    pda: "S948NKSU0AVA1",
    cscBuild: "S948NOKR0AVA1",
    cp: "S948NKSU0AVA1"
  });
  const panel = await renderTestFirmwareStatusPanel(app, "100");
  assert.match(panel.text, /KOO：已解密/);
  assert.equal(panel.replyMarkup.inline_keyboard.flat().some((button) => button.callback_data === "test-fw:confirm-eux"), true);
  assert.equal(panel.replyMarkup.inline_keyboard.flat().some((button) => button.callback_data === "test-fw:manual"), false);
});

test("KOO confirmation enables S26 Korea while EUX decryption stays rollout-gated", async () => {
  resetStateMemoryCache();
  const history = new InMemoryTestFirmwareHistoryRepository();
  const app = runtime({ history });
  app.env.FIRMWARE_KV = new MemoryStorage();
  await history.upsertResolved({
    model: "SM-S948N",
    csc: "KOO",
    hashType: "md5",
    hashValue: "0123456789abcdef0123456789abcdef",
    pda: "S948NKSU0AVA1",
    cscBuild: "S948NOKR0AVA1",
    cp: "S948NKSU0AVA1"
  });
  const confirmed = await confirmKooAndEnableEux(app, "100", quietLogger());
  assert.equal(confirmed.ok, true);
  const result = await scanTestFirmwareTarget(app, { model: "SM-S948B", csc: "EUX" }, {
    testXml: TEST_XML,
    latestVersionOverride: LATEST,
    logger: quietLogger()
  });
  assert.equal(result.status, "resolved");
  const items = await getMonitorItems(app.env);
  const eux = items.find((item) => item.model === "SM-S948B" && item.csc === "EUX");
  assert.equal(eux?.enabled, false);
  assert.equal(eux?.paused, true);
  const koreanS26 = items.filter((item) => item.rolloutChainId === "s26" && item.rolloutStageId === "kr");
  assert.equal(koreanS26.length, 3);
  assert.equal(koreanS26.every((item) => item.enabled === true && item.paused === false), true);
});

test("one S26 Korea update creates one proposal and pauses the whole current region", async () => {
  resetStateMemoryCache();
  const app = runtime();
  app.env.FIRMWARE_KV = new MemoryStorage();
  await activateTestFirmwareRolloutStage(app.env, "s26", "kr");
  const parsed = { latest: "S942NKSU1AZH1/S942NOKR1AZH1/S942NKSU1AZH1" };
  const first = await createRolloutProposalForUpdate(app.env, {
    model: "SM-S942N",
    csc: "KOO",
    rolloutChainId: "s26",
    rolloutStageId: "kr"
  }, parsed, new Date("2026-08-09T04:00:00.000Z"));
  assert.ok(first?.proposal?.id);
  const duplicate = await createRolloutProposalForUpdate(app.env, {
    model: "SM-S947N",
    csc: "KOO",
    rolloutChainId: "s26",
    rolloutStageId: "kr"
  }, { latest: "S947NKSU1AZH1/S947NOKR1AZH1/S947NKSU1AZH1" }, new Date("2026-08-09T04:01:00.000Z"));
  assert.equal(duplicate?.suppressUpdate, true);
  assert.equal(duplicate?.proposal, null);
  const items = await getMonitorItems(app.env);
  const currentRegion = items.filter((item) => item.rolloutChainId === "s26" && item.rolloutStageId === "kr");
  assert.equal(currentRegion.length, 3);
  assert.equal(currentRegion.every((item) => item.enabled === false && item.paused === true), true);
  const chains = await getRolloutChains(app.env);
  const chain = chains.chains.find((item) => item.id === "s26");
  assert.equal(chain.status, "awaiting_confirmation");
  assert.equal(chain.pendingProposalId, first.proposal.id);
});

test("approving a rollout proposal advances S26 and starts dependent S25 Korea", async () => {
  resetStateMemoryCache();
  const app = runtime();
  app.env.FIRMWARE_KV = new MemoryStorage();
  await activateTestFirmwareRolloutStage(app.env, "s26", "kr");
  const result = await createRolloutProposalForUpdate(app.env, {
    model: "SM-S948N",
    csc: "KOO",
    rolloutChainId: "s26",
    rolloutStageId: "kr"
  }, { latest: "S948NKSU1AZH1/S948NOKR1AZH1/S948NKSU1AZH1" });
  const decision = await applyRolloutProposalDecision(app.env, result.proposal.id, "approve", "100");
  assert.equal(decision.ok, true);
  const chains = await getRolloutChains(app.env);
  const s26 = chains.chains.find((item) => item.id === "s26");
  const s25 = chains.chains.find((item) => item.id === "s25");
  assert.equal(s26.activeStageId, "eu");
  assert.equal(s26.status, "active");
  assert.equal(s25.activeStageId, "kr");
  assert.equal(s25.status, "active");
  const items = await getMonitorItems(app.env);
  assert.equal(items.find((item) => item.model === "SM-S942B" && item.csc === "EUX")?.enabled, true);
  assert.equal(items.find((item) => item.model === "SM-S931N" && item.csc === "KOO")?.enabled, true);
  assert.equal(items.find((item) => item.model === "SM-S942N" && item.csc === "KOO")?.enabled, false);
});

test("skipping a rollout proposal reactivates the current region without advancing", async () => {
  resetStateMemoryCache();
  const app = runtime();
  app.env.FIRMWARE_KV = new MemoryStorage();
  await activateTestFirmwareRolloutStage(app.env, "s26", "kr");
  const result = await createRolloutProposalForUpdate(app.env, {
    model: "SM-S942N",
    csc: "KOO",
    rolloutChainId: "s26",
    rolloutStageId: "kr"
  }, { latest: "S942NKSU1AZH1/S942NOKR1AZH1/S942NKSU1AZH1" });
  const decision = await applyRolloutProposalDecision(app.env, result.proposal.id, "skip", "100");
  assert.equal(decision.ok, true);
  const chains = await getRolloutChains(app.env);
  const s26 = chains.chains.find((item) => item.id === "s26");
  assert.equal(s26.activeStageId, "kr");
  assert.equal(s26.status, "active");
  assert.equal(s26.pendingProposalId, "");
  const items = await getMonitorItems(app.env);
  const currentRegion = items.filter((item) => item.rolloutChainId === "s26" && item.rolloutStageId === "kr");
  assert.equal(currentRegion.every((item) => item.enabled === true && item.paused === false), true);
});

test("startup pipeline queues KOO once and retries are protected by a durable claim", async () => {
  const queue = [];
  const app = runtime({ queue });
  app.env.FIRMWARE_KV = new MemoryStorage();
  const first = await bootstrapTestFirmwarePipeline(app, quietLogger());
  const second = await bootstrapTestFirmwarePipeline(app, quietLogger());
  assert.equal(first.queued, true);
  assert.equal(first.target.model, "SM-S948N");
  assert.equal(first.startupScanId, startupScanIdFor(app));
  assert.equal(second.reason, "already_claimed");
  assert.equal(queue.filter((entry) => entry.maintenance && entry.data.kind === "test-firmware-startup-scan").length, 1);
  app.config.testFirmwareReleaseId = "2.22.2";
  const nextRelease = await bootstrapTestFirmwarePipeline(app, quietLogger());
  assert.equal(nextRelease.queued, true);
  assert.equal(nextRelease.startupScanId, "s948n-koo-eux:2.22.2");
  assert.equal(queue.filter((entry) => entry.maintenance && entry.data.kind === "test-firmware-startup-scan").length, 2);
});

test("startup KOO scan retries a busy lock without losing its release claim", async () => {
  const queue = [];
  const app = runtime({ queue });
  app.env.FIRMWARE_KV = new MemoryStorage();
  const queued = await bootstrapTestFirmwarePipeline(app, quietLogger());
  const firstJob = queue.find((entry) => entry.maintenance && entry.data.kind === "test-firmware-startup-scan");
  assert.equal(queued.queued, true);
  assert.ok(firstJob);

  const held = await app.context.locks.acquire(SCAN_LOCK_KEY, 60_000);
  assert.equal(held.acquired, true);
  try {
    const result = await processTestFirmwareMaintenanceJob({ data: { ...firstJob.data, chatId: "" } }, app, quietLogger());
    assert.equal(result.reason, "already_running");
    assert.equal(result.retryQueued, true);
  } finally {
    await app.context.locks.release(SCAN_LOCK_KEY, held.token);
  }

  const retry = queue.find((entry) => entry.maintenance && entry.data.startupLockRetries === 1);
  assert.ok(retry);
  assert.equal(retry.data.startupScanId, queued.startupScanId);
  assert.equal(await app.testFirmwareHistory.claimStartupScan(queued.startupScanId), false);
});
