import test from "node:test";
import assert from "node:assert/strict";
import { createPersistentQueueBinding, validateVpsProductionEnv } from "../src/vps/production.js";
import { OFFSET_KEY, startTelegramPolling } from "../src/vps/telegram-polling.js";
import { withTelegramChatOrder } from "../src/vps/workers.js";
import { randomId } from "../src/runtime/random-id.js";
import { PersistentNamespace } from "../src/runtime/postgres.js";
import { createVpsConfig } from "../src/vps/config.js";

const webhookSecret = ["webhook", "test", "secret"].join("-");
const webhookKey = ["WEBHOOK", "SECRET"].join("_");
test("VPS production configuration requires persistence and authentication inputs", () => {
  assert.throws(
    () => validateVpsProductionEnv({}),
    /DATABASE_URL is required/
  );
  assert.doesNotThrow(() => validateVpsProductionEnv({
    DATABASE_URL: "postgresql://test",
    REDIS_URL: "redis://test",
    [webhookKey]: webhookSecret,
    INTERNAL_API_SECRET: "internal-test-secret",
    VPS_SHADOW_MODE: "true"
  }));
  assert.throws(
    () => validateVpsProductionEnv({
      DATABASE_URL: "postgresql://test",
      REDIS_URL: "redis://test",
      [webhookKey]: webhookSecret,
      INTERNAL_API_SECRET: "internal-test-secret",
      VPS_SHADOW_MODE: "false",
      TELEGRAM_SEND_ENABLED: "true"
    }),
    /TELEGRAM_BOT_TOKEN is required/
  );
});

test("VPS queue binding adds retry and retention policy without exposing payload secrets", async () => {
  let received;
  const binding = createPersistentQueueBinding({
    async add(name, data, options) {
      received = { name, data, options };
      return { id: options.jobId };
    }
  });
  const result = await binding.send({ id: "notification:test", text: "test" });
  assert.equal(result.id, "notification:test");
  assert.equal(received.name, "oneui");
  assert.equal(received.options.jobId, "notification:test");
  assert.equal(received.options.attempts, 5);
  assert.equal(received.options.backoff.type, "exponential");
});

test("portable random IDs work when the runtime has no Web Crypto global", () => {
  const id = randomId(null);
  assert.match(id, /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/i);
});

test("VPS Telegram polling queues updates and persists the next offset", async () => {
  const storage = new Map();
  const queued = [];
  let resolveQueued;
  const queuedPromise = new Promise((resolve) => { resolveQueued = resolve; });
  const poller = startTelegramPolling({
    token: ["poll", "token"].join("-"),
    storage: {
      async get(key) { return storage.get(key) || null; },
      async put(key, value) { storage.set(key, value); }
    },
    queue: {
      async send(data) {
        queued.push(data);
        resolveQueued(data);
      }
    },
    logger: { error() {}, warn() {} },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { ok: true, result: [{ update_id: 41, message: { text: "/start" } }] };
      }
    })
  });
  const data = await queuedPromise;
  assert.equal(poller.status().ok, true);
  assert.equal(poller.status().state, "healthy");
  await poller.close();
  assert.equal(poller.status().state, "stopped");
  assert.equal(queued.length, 1);
  assert.equal(data.id, "telegram-update:41");
  assert.equal(storage.get(OFFSET_KEY), "42");
});

test("VPS Telegram polling persists one offset per burst", async () => {
  const queued = [];
  const stored = [];
  let fetchCalls = 0;
  let resolveStored;
  const storedOnce = new Promise((resolve) => { resolveStored = resolve; });
  const poller = startTelegramPolling({
    token: "poll-token",
    storage: {
      async get() { return null; },
      async put(key, value) {
        stored.push([key, value]);
        resolveStored();
      }
    },
    queue: { async send(data) { queued.push(data.id); } },
    logger: { error() {}, warn() {} },
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return {
          ok: true,
          async json() {
            return { ok: true, result: [41, 42, 43].map((update_id) => ({ update_id })) };
          }
        };
      }
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
  });
  await storedOnce;
  assert.deepEqual(queued, ["telegram-update:41", "telegram-update:42", "telegram-update:43"]);
  assert.deepEqual(stored, [[OFFSET_KEY, "44"]]);
  assert.ok(poller.status().lastActivityAt >= poller.status().lastSuccessAt);
  await poller.close();
});

test("VPS concurrency and stale-loop settings stay within safe bounds", () => {
  const defaults = createVpsConfig({});
  assert.equal(defaults.telegramWorkerConcurrency, 3);
  assert.equal(defaults.monitorWorkerConcurrency, 2);
  assert.equal(defaults.scheduleStaleMs, 5 * 60_000);
  const bounded = createVpsConfig({
    TELEGRAM_WORKER_CONCURRENCY: "99",
    MONITOR_WORKER_CONCURRENCY: "99",
    VPS_SCHEDULE_STALE_MS: "1"
  });
  assert.equal(bounded.telegramWorkerConcurrency, 8);
  assert.equal(bounded.monitorWorkerConcurrency, 4);
  assert.equal(bounded.scheduleStaleMs, 60_000);
});

test("VPS Telegram polling marks invalid-token and webhook-conflict responses unhealthy", async () => {
  let observedStatus;
  const poller = startTelegramPolling({
    token: "poll-token",
    storage: { async get() { return null; }, async put() {} },
    queue: { async send() {} },
    logger: { error() {}, warn() {} },
    fetchImpl: async () => ({ ok: false, status: 409, async json() { return { ok: false, error_code: 409 }; } })
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    observedStatus = poller.status();
    if (observedStatus.fatalFailure) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await poller.close();
  assert.equal(observedStatus.fatalFailure, true);
  assert.equal(observedStatus.ok, false);
});

test("VPS Telegram polling retries request timeouts instead of stopping", async () => {
  let calls = 0;
  let resolveSecondCall;
  const secondCall = new Promise((resolve) => { resolveSecondCall = resolve; });
  const poller = startTelegramPolling({
    token: "poll-token",
    storage: { async get() { return null; }, async put() {} },
    queue: { async send() {} },
    logger: { error() {}, warn() {} },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("request timed out");
        error.name = "AbortError";
        throw error;
      }
      resolveSecondCall();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { ok: true, async json() { return { ok: true, result: [] }; } };
    }
  });
  await secondCall;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(poller.status().ok, true);
  assert.equal(poller.status().state, "healthy");
  assert.ok(calls >= 2);
  await poller.close();
});

test("VPS Telegram jobs serialize one chat without blocking another chat", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withTelegramChatOrder("same-chat", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = withTelegramChatOrder("same-chat", async () => events.push("second"));
  const other = withTelegramChatOrder("other-chat", async () => events.push("other"));
  await other;
  assert.deepEqual(events, ["first-start", "other"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "other", "first-end", "second"]);
});

test("PersistentNamespace restores due alarms and finishes transactional background work before commit", async () => {
  const queries = [];
  let alarmAt = Date.now() - 1000;
  const client = {
    async query(sql, params = []) {
      queries.push(String(sql).replace(/\s+/g, " ").trim());
      if (String(sql).includes("EXTRACT(EPOCH FROM alarm_at)")) {
        return { rows: alarmAt ? [{ alarm_at: alarmAt }] : [] };
      }
      if (String(sql).includes("INSERT INTO runtime_alarms")) {
        alarmAt = params[1] instanceof Date ? params[1].getTime() : null;
      }
      return { rows: [] };
    },
    release() { queries.push("RELEASE"); }
  };
  const pool = {
    async connect() { return client; },
    async query(sql) {
      if (String(sql).includes("SELECT namespace FROM runtime_alarms")) {
        return { rows: alarmAt && alarmAt <= Date.now() ? [{ namespace: "test-namespace:restored-target" }] : [] };
      }
      return { rows: [] };
    }
  };
  let alarms = 0;
  const namespace = new PersistentNamespace({
    pool,
    namespace: "test-namespace",
    createInstance: (ctx) => ({
      async fetch() { return new Response("ok"); },
      async alarm() {
        alarms += 1;
        ctx.waitUntil(Promise.resolve().then(() => ctx.storage.put("background", { ok: true })));
        return { ok: true };
      }
    })
  });

  await namespace.runAlarms();
  const backgroundWrite = queries.findIndex((query) => query.includes("INSERT INTO runtime_state"));
  const commit = queries.indexOf("COMMIT");
  assert.equal(alarms, 1);
  assert.ok(backgroundWrite >= 0);
  assert.ok(commit > backgroundWrite);
  assert.ok(queries.indexOf("RELEASE") > commit);
  await namespace.runAlarms();
  assert.equal(alarms, 1);
  await namespace.close();
});

test("PersistentNamespace bounds idle in-memory instances", async () => {
  const pool = {
    async connect() { throw new Error("not used"); },
    async query() { return { rows: [] }; }
  };
  const namespace = new PersistentNamespace({
    pool,
    namespace: "bounded",
    maxInstances: 10,
    createInstance: () => ({ async fetch() { return new Response("ok"); } })
  });
  for (let index = 0; index < 25; index += 1) namespace.instanceFor(`target-${index}`);
  assert.equal(namespace.instances.size, 10);
  assert.equal(namespace.instances.has("target-0"), false);
  assert.equal(namespace.instances.has("target-24"), true);
  await namespace.close();
});
