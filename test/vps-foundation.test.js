import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MemoryCache } from "../src/runtime/cache.js";
import { MemoryLockService } from "../src/runtime/locks.js";
import { MemoryQueue } from "../src/runtime/queue.js";
import { createVpsRuntimeContext } from "../src/runtime/context.js";
import { MemoryStorage } from "../src/runtime/storage.js";
import { MemoryScheduler } from "../src/runtime/scheduler.js";
import { buildVpsApp } from "../src/vps/app.js";
import { createVpsConfig, monitorNotificationAllowed, telegramSendAllowed } from "../src/vps/config.js";

test("MemoryStorage preserves KV strings, TTL, and cursor pagination", async () => {
  let now = 1_000;
  const storage = new MemoryStorage({ now: () => now });
  await storage.put("a:2", "two");
  await storage.put("a:1", "one", { expirationTtl: 2 });
  await storage.put("b:1", "other");
  assert.equal(await storage.get("a:1"), "one");
  const first = await storage.list({ prefix: "a:", limit: 1 });
  assert.deepEqual(first.keys.map((key) => key.name), ["a:1"]);
  assert.equal(first.list_complete, false);
  const second = await storage.list({ prefix: "a:", cursor: first.cursor, limit: 1 });
  assert.deepEqual(second.keys.map((key) => key.name), ["a:2"]);
  now += 2_001;
  assert.equal(await storage.get("a:1"), null);
});

test("MemoryCache single-flight shares one factory and expires values", async () => {
  let now = 0;
  let calls = 0;
  const cache = new MemoryCache({ now: () => now });
  const factory = async () => { calls += 1; return { value: calls }; };
  const [first, second] = await Promise.all([
    cache.getOrSet("firmware:target", factory, { ttlMs: 100 }),
    cache.getOrSet("firmware:target", factory, { ttlMs: 100 })
  ]);
  assert.equal(calls, 1);
  assert.equal(first.value.value, 1);
  assert.equal(second.value.value, 1);
  now = 101;
  assert.equal(await cache.get("firmware:target"), null);
});

test("MemoryLockService enforces token ownership and expiry", async () => {
  let now = 0;
  const locks = new MemoryLockService({ now: () => now });
  const first = await locks.acquire("target:SM-S9380:CHC", 1000);
  assert.equal(first.acquired, true);
  assert.equal((await locks.acquire("target:SM-S9380:CHC", 100)).acquired, false);
  assert.equal(await locks.release("target:SM-S9380:CHC", "wrong"), false);
  assert.equal(await locks.release("target:SM-S9380:CHC", first.token), true);
  const second = await locks.acquire("target:SM-S9380:CHC", 1000);
  now = 1001;
  assert.equal((await locks.acquire("target:SM-S9380:CHC", 1000)).acquired, true);
  assert.equal(await locks.refresh("target:SM-S9380:CHC", second.token, 1000), false);
});

test("MemoryQueue deduplicates stable job IDs", async () => {
  const queue = new MemoryQueue("notification-delivery");
  const first = await queue.add("send", { text: "one" }, { jobId: "notification:1" });
  const second = await queue.add("send", { text: "duplicate" }, { jobId: "notification:1" });
  assert.equal(first.id, second.id);
  assert.equal(queue.size, 1);
  assert.equal((await queue.drain())[0].data.text, "one");
});

test("MemoryScheduler claims a due target once and rejects stale completion", async () => {
  let now = 1_000_000;
  const scheduler = new MemoryScheduler({ now: () => now, lockMs: 60_000 });
  await scheduler.sync([{ model: "SM-S9380", csc: "CHC", enabled: true }], now);
  const first = await scheduler.claimDue({ now, limit: 1 });
  assert.equal(first.entries.length, 1);
  const second = await scheduler.claimDue({ now, limit: 1 });
  assert.equal(second.entries.length, 0);
  const stale = await scheduler.complete({ model: "SM-S9380", csc: "CHC", lock: "stale", completedAt: now, nextCheckAt: now + 600_000 });
  assert.equal(stale.staleLock, true);
  const done = await scheduler.complete({ model: "SM-S9380", csc: "CHC", lock: first.entries[0].lock, completedAt: now, nextCheckAt: now + 600_000, lastVersion: "S9380XXU1A" });
  assert.equal(done.ok, true);
  const after = await scheduler.claimDue({ now: now + 300_000, limit: 1 });
  assert.equal(after.entries.length, 0);
  const forced = await scheduler.forceDue("SM-S9380", "CHC", now + 300_000);
  assert.equal(forced.ok, true);
  assert.equal((await scheduler.claimDue({ now: now + 300_000, limit: 1 })).entries.length, 1);
});

test("VPS gates keep shadow mode side-effect free", () => {
  const config = createVpsConfig({
    VPS_SHADOW_MODE: "true",
    TELEGRAM_SEND_ENABLED: "true",
    MONITOR_NOTIFICATIONS_ENABLED: "true"
  });
  assert.equal(telegramSendAllowed(config), false);
  assert.equal(monitorNotificationAllowed(config), false);
  const live = createVpsConfig({ VPS_SHADOW_MODE: "false", TELEGRAM_SEND_ENABLED: "true", MONITOR_NOTIFICATIONS_ENABLED: "true" });
  assert.equal(telegramSendAllowed(live), true);
  assert.equal(monitorNotificationAllowed(live), true);
});

test("VPS API protects webhook and internal routes and returns safe health", async () => {
  const context = createVpsRuntimeContext({
    env: {
      WEBHOOK_SECRET: "example-webhook-secret",
      INTERNAL_API_SECRET: "internal-secret",
      VPS_SHADOW_MODE: "true"
    }
  });
  const { app } = buildVpsApp({
    app: Fastify(),
    context,
    healthChecks: { postgres: async () => ({ ok: true }), redis: async () => ({ ok: true }) },
    webhookHandler: async (update) => ({ accepted: Boolean(update.update_id) }),
    checkHandler: async () => ({ checked: true }),
    diagnosticsHandler: async () => ({ healthy: true }),
    metricsHandler: async () => "oneui_queries_total 0\n"
  });
  await app.ready();
  const denied = await app.inject({ method: "POST", url: "/telegram", headers: { "x-telegram-bot-api-secret-token": "wrong" }, payload: {} });
  assert.equal(denied.statusCode, 403);
  const accepted = await app.inject({ method: "POST", url: "/telegram", headers: { "x-telegram-bot-api-secret-token": "example-webhook-secret" }, payload: { update_id: 1 } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().accepted, true);
  const internalDenied = await app.inject({ method: "GET", url: "/internal/diagnostics" });
  assert.equal(internalDenied.statusCode, 403);
  const internalOk = await app.inject({ method: "GET", url: "/internal/diagnostics", headers: { "x-vps-internal-secret": "internal-secret" } });
  assert.equal(internalOk.statusCode, 200);
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().features.shadowMode, true);
  assert.equal(Object.hasOwn(health.json(), "TELEGRAM_BOT_TOKEN"), false);
  const metrics = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.body, /oneui_queries_total/);
  await app.close();
  await context.close();
});
