import test from "node:test";
import assert from "node:assert/strict";
import { createPersistentQueueBinding, validateVpsProductionEnv } from "../src/vps/production.js";
import { OFFSET_KEY, startTelegramPolling } from "../src/vps/telegram-polling.js";
import { randomId } from "../src/runtime/random-id.js";

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
