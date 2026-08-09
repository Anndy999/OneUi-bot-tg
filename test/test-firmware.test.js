import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryTestFirmwareHistoryRepository } from "../src/vps/test-firmware-history.js";
import { runTestFirmwareDecryptor } from "../src/vps/test-firmware-decryptor.js";
import {
  bootstrapTestFirmwarePipeline,
  confirmKooAndEnableEux,
  executeTestFirmwareScan,
  handleTestFirmwareTelegramCommand,
  maybeScheduleTestFirmwareScan,
  scanTestFirmwareTarget,
  testBuildText,
  withTestFirmwareScanLock
} from "../src/vps/test-firmware-scan.js";
import { MemoryLockService } from "../src/runtime/locks.js";
import { MemoryStorage } from "../src/runtime/storage.js";

const MODEL = "SM-S9480";
const CSC = "CHC";
const LATEST = "S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1/S9480ZCS4AZG1";
const RESOLVED_HASH = "51d21620bea9bf325b9adb2c02ed1d0e";
const TEST_XML = `<root><value>${RESOLVED_HASH}</value></root>`;
const UNRESOLVED_SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
      testFirmwareScanTime: "18:00"
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

test("unresolved SHA-256 is preserved and never sent as a public build notification", async () => {
  const queue = [];
  const history = new InMemoryTestFirmwareHistoryRepository();
  const app = runtime({ queue, history });
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

test("startup pipeline queues KOO once and retries are protected by a durable claim", async () => {
  const queue = [];
  const app = runtime({ queue });
  app.env.FIRMWARE_KV = new MemoryStorage();
  const first = await bootstrapTestFirmwarePipeline(app, quietLogger());
  const second = await bootstrapTestFirmwarePipeline(app, quietLogger());
  assert.equal(first.queued, true);
  assert.equal(first.target.model, "SM-S948N");
  assert.equal(second.reason, "already_claimed");
  assert.equal(queue.filter((entry) => entry.maintenance && entry.data.kind === "test-firmware-startup-scan").length, 1);
});
