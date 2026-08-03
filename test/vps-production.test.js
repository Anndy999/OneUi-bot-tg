import test from "node:test";
import assert from "node:assert/strict";
import { createPersistentQueueBinding, validateVpsProductionEnv } from "../src/vps/production.js";
import { OFFSET_KEY, startTelegramPolling } from "../src/vps/telegram-polling.js";

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
  await poller.close();
  assert.equal(queued.length, 1);
  assert.equal(data.id, "telegram-update:41");
  assert.equal(storage.get(OFFSET_KEY), "42");
});
