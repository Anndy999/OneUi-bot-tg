import test from "node:test";
import assert from "node:assert/strict";
import { MemoryLockService } from "../src/runtime/locks.js";
import { MemoryStorage } from "../src/runtime/storage.js";
import { addAdditionalAdmin, addAllowedUser, resetStateMemoryCache } from "../src/state.js";
import {
  broadcastTestingApologyToAllowedUsers,
  TESTING_APOLOGY_NOTICE_STORAGE_KEY,
  testingApologyText
} from "../src/vps/testing-notice.js";

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

test("the one-time testing apology reaches ordinary users only and stays idempotent", async (t) => {
  resetStateMemoryCache();
  t.after(() => resetStateMemoryCache());
  const storage = new MemoryStorage();
  const deliveries = [];
  const env = {
    TELEGRAM_CHAT_ID: "100",
    FIRMWARE_KV: storage,
    NOTIFICATION_QUEUE_ENABLED: "true",
    NOTIFICATION_QUEUE: {
      async send(message) {
        deliveries.push(message);
      }
    }
  };
  await addAllowedUser(env, "100", "Owner");
  await addAllowedUser(env, "200", "Ordinary user one");
  await addAllowedUser(env, "201", "Ordinary user two");
  await addAllowedUser(env, "300", "Additional admin");
  await addAdditionalAdmin(env, "300", "Additional admin", "100");

  const runtime = {
    env,
    context: {
      storage,
      locks: new MemoryLockService()
    }
  };
  const first = await broadcastTestingApologyToAllowedUsers(runtime, quietLogger());
  assert.deepEqual(first, { queued: true, recipients: 2, deliveries: 2 });
  assert.deepEqual(deliveries.map((message) => message.chatId), ["200", "201"]);
  assert.equal(deliveries.every((message) => message.id.startsWith("service-notice:testing-apology-2026-08-v1:")), true);
  assert.equal(deliveries.every((message) => message.text === testingApologyText()), true);
  assert.match(deliveries[0].text, /因机器人正在测试/);
  assert.match(deliveries[0].text, /currently undergoing testing/);
  assert.notEqual(await storage.get(TESTING_APOLOGY_NOTICE_STORAGE_KEY), null);

  const second = await broadcastTestingApologyToAllowedUsers(runtime, quietLogger());
  assert.deepEqual(second, { queued: false, reason: "already_sent", recipients: 0 });
  assert.equal(deliveries.length, 2);
});

test("a failed notice enqueue leaves the one-time marker unset for safe retry", async (t) => {
  resetStateMemoryCache();
  t.after(() => resetStateMemoryCache());
  const storage = new MemoryStorage();
  const env = {
    TELEGRAM_CHAT_ID: "100",
    FIRMWARE_KV: storage,
    NOTIFICATION_QUEUE_ENABLED: "true",
    NOTIFICATION_QUEUE: {
      async send() {
        throw new Error("temporary queue error");
      }
    }
  };
  await addAllowedUser(env, "200", "Ordinary user");
  const result = await broadcastTestingApologyToAllowedUsers({
    env,
    context: { storage, locks: new MemoryLockService() }
  }, quietLogger());

  assert.equal(result.queued, false);
  assert.equal(result.reason, "enqueue_failed");
  assert.equal(await storage.get(TESTING_APOLOGY_NOTICE_STORAGE_KEY), null);
});
