import test from "node:test";
import assert from "node:assert/strict";
import {
  MonitorScheduler,
  appendSchedulerMonitorEvent,
  claimSchedulerDailySummary,
  completeSchedulerDailySummary,
  getSchedulerMonitorEvents
} from "../src/monitor-scheduler.js";
import { createFirmwareVersionRecord } from "../src/firmware-version.js";
import { normalizeMonitorIntervalSettings } from "../src/monitor-intervals.js";
import { shouldRunNow } from "../src/monitor.js";

function memoryDoStorage() {
  const values = new Map();
  let alarmAt = 0;
  return {
    values,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) {
      if (Array.isArray(key)) {
        for (const item of key) values.delete(item);
        return true;
      }
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
    async setAlarm(value) { alarmAt = Number(value || 0); },
    async getAlarm() { return alarmAt || null; }
  };
}

async function call(scheduler, path, body = {}) {
  const response = await scheduler.fetch(new Request(`https://scheduler${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
  return response.json();
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

test("structured firmware records keep canonical components without the legacy duplicate", () => {
  assert.deepEqual(createFirmwareVersionRecord("A/B/C/A"), {
    schemaVersion: 1,
    raw: "A/B/C/A",
    components: ["A", "B", "C"],
    pda: "A",
    cscVersion: "B",
    modem: "C",
    extras: [],
    canonical: "A/B/C",
    fingerprint: "A/B/C"
  });
  assert.deepEqual(createFirmwareVersionRecord("A/B/C/D").extras, ["D"]);
});

test("legacy one-minute HIGH defaults migrate once while explicit administrator choices remain valid", () => {
  assert.equal(normalizeMonitorIntervalSettings({ high: 1 }).high, 3);
  assert.equal(normalizeMonitorIntervalSettings({ schemaVersion: 2, high: 1 }).high, 1);
});

test("remaining frequently-mutated control state is accepted by MonitorScheduler", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  for (const [key, value] of [
    ["allowed:users", [{ chatId: "1" }]],
    ["access:requests", [{ chatId: "2" }]],
    ["access:settings", { autoApprove: true }],
    ["flagship:proposal:abcdef", { id: "abcdef" }],
    ["monitor:boost:SM-S9480:TGY", { until: "2026-07-14T00:00:00.000Z" }]
  ]) {
    assert.equal((await call(scheduler, "/control-state/put", { key, value })).ok, true);
    assert.deepEqual((await call(scheduler, "/control-state/get", { key })).value, value);
  }
  assert.equal((await call(scheduler, "/control-state/put", { key: "secret:token", value: "x" })).ok, false);
});

test("target runtime state is persisted in the scheduler rather than KV", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const now = Date.now();
  await call(scheduler, "/sync", {
    now,
    items: [{ model: "SM-S9480", csc: "TGY", priority: "high", enabled: true }]
  });
  const patched = await call(scheduler, "/target-state/patch", {
    model: "SM-S9480",
    csc: "TGY",
    patch: { lastVersion: "A/B/C", priorityScore: 90, lastSuccessAt: new Date(now).toISOString() }
  });
  assert.equal(patched.ok, true);
  const read = await call(scheduler, "/target-state/get", { model: "SM-S9480", csc: "TGY" });
  assert.equal(read.runtime.lastVersion, "A/B/C");
  assert.equal(read.runtime.priorityScore, 90);
});

test("persistent metrics produce a 24-hour performance summary", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const now = Date.now();
  await call(scheduler, "/metrics/record", { metric: { type: "query", timestamp: now, ok: true, cacheLayer: "miss", totalMs: 100, smartHistoryMs: 80 } });
  await call(scheduler, "/metrics/record", { metric: { type: "query", timestamp: now + 1, ok: true, cacheLayer: "l1", singleFlightJoined: true, totalMs: 20, smartHistoryMs: 0 } });
  await call(scheduler, "/metrics/record", { metric: { type: "monitor", timestamp: now + 2, ok: false, errorClass: "http_429" } });
  const summary = await call(scheduler, "/metrics/summary", { hours: 24 });
  assert.equal(summary.queryCount, 2);
  assert.equal(summary.cacheHits, 1);
  assert.equal(summary.singleFlightJoins, 1);
  assert.equal(summary.monitorFailures, 1);
  assert.equal(summary.totalMsP50, 20);
  assert.equal(summary.totalMsP95, 100);
});

test("global hourly budget limits monitor claims and reports capacity", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {
    MONITOR_MAX_QUERIES_PER_HOUR: "1",
    MONITOR_MAX_CONCURRENT_QUERIES: "3"
  });
  const now = Date.now();
  await call(scheduler, "/sync", {
    now,
    items: [
      { model: "SM-S9480", csc: "TGY", priority: "high", enabled: true },
      { model: "SM-S9480", csc: "CHC", priority: "high", enabled: true }
    ]
  });
  const first = await call(scheduler, "/claim", { now, limit: 6 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.budget.remaining, 0);
  const second = await call(scheduler, "/claim", { now: now + 1, limit: 6 });
  assert.equal(second.entries.length, 0);
});


test("cron slots are claimed once in MonitorScheduler without Workers KV", async () => {
  let kvWrites = 0;
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {
    FIRMWARE_KV: { async put() { kvWrites += 1; } }
  });
  const first = await call(scheduler, "/cron-slot/claim", { slot: "2026-07-14:12:30", now: 1 });
  const duplicate = await call(scheduler, "/cron-slot/claim", { slot: "2026-07-14:12:30", now: 2 });
  const next = await call(scheduler, "/cron-slot/claim", { slot: "2026-07-14:12:31", now: 3 });
  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, false);
  assert.equal(next.claimed, true);
  assert.equal(kvWrites, 0);
});

test("daily monitoring summaries are claimed once per Beijing date", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const env = { MONITOR_SCHEDULER: schedulerNamespace(scheduler) };
  const first = await claimSchedulerDailySummary(env, "2026-07-18", 100);
  const duplicate = await claimSchedulerDailySummary(env, "2026-07-18", 101);
  const completed = await completeSchedulerDailySummary(env, "2026-07-18", true, 102);
  const afterSend = await claimSchedulerDailySummary(env, "2026-07-18", 103);
  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, false);
  assert.equal(completed.sent, true);
  assert.equal(afterSend.reason, "already_sent");
});

test("monitor event stream is bounded and stored in the scheduler", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  const env = { MONITOR_SCHEDULER: schedulerNamespace(scheduler) };
  for (let index = 0; index < 52; index += 1) {
    await appendSchedulerMonitorEvent(env, {
      type: "monitor_failed",
      model: "SM-S9480",
      csc: "TGY",
      detail: `failure-${index}`
    });
  }
  const events = await getSchedulerMonitorEvents(env, 50);
  assert.equal(events.events.length, 50);
  assert.equal(events.events[0].detail, "failure-51");
  assert.equal(events.events.at(-1).detail, "failure-2");
});

test("allowed-user daily quota counts the same model across CSCs and resets by date", async () => {
  const scheduler = new MonitorScheduler({ storage: memoryDoStorage() }, {});
  for (let index = 1; index <= 10; index += 1) {
    const result = await call(scheduler, "/user-query-quota/claim", {
      chatId: "12345",
      model: "SM-S938B",
      dateKey: "2026-07-14",
      limit: 10,
      now: index
    });
    assert.equal(result.allowed, true);
    assert.equal(result.count, index);
  }
  const blocked = await call(scheduler, "/user-query-quota/claim", {
    chatId: "12345",
    model: "SM-S938B",
    dateKey: "2026-07-14",
    limit: 10,
    now: 11
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.count, 10);

  const anotherModel = await call(scheduler, "/user-query-quota/claim", {
    chatId: "12345",
    model: "SM-S9480",
    dateKey: "2026-07-14",
    limit: 10,
    now: 12
  });
  assert.equal(anotherModel.allowed, true);

  const nextDay = await call(scheduler, "/user-query-quota/claim", {
    chatId: "12345",
    model: "SM-S938B",
    dateKey: "2026-07-15",
    limit: 10,
    now: 13
  });
  assert.equal(nextDay.allowed, true);
  assert.equal(nextDay.count, 1);
});

test("post-update timed pause resumes the original plan, preserves runtime, and notifies the administrator", async () => {
  const storage = memoryDoStorage();
  const queued = [];
  const scheduler = new MonitorScheduler({ storage }, {
    TELEGRAM_CHAT_ID: "999",
    NOTIFICATION_QUEUE: { async send(message) { queued.push(message); } }
  });
  const now = Date.now();
  await call(scheduler, "/monitor-items/upsert", {
    item: { model: "SM-S938B", csc: "EUX", name: "S25 Ultra 欧版", priority: "high", enabled: true }
  });
  await call(scheduler, "/target-state/patch", {
    model: "SM-S938B",
    csc: "EUX",
    patch: {
      lastVersion: "A/B/C",
      priorityScore: 90,
      lastCheckedAt: new Date(now).toISOString(),
      monitorMode: "HOT",
      modeUntil: new Date(now + 180_000).toISOString()
    }
  });
  const paused = await call(scheduler, "/monitor-snooze/set", {
    model: "SM-S938B",
    csc: "EUX",
    resumeAt: now + 61_000,
    metadata: { requestedBy: "999", updateVersion: "A/B/C" }
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.item.enabled, false);
  assert.ok(await storage.getAlarm());

  const before = await call(scheduler, "/control-state/get", { key: "monitor:items" });
  assert.equal(before.value[0].paused, true);
  assert.ok(before.value[0].resumeAt);

  const resumedAt = now + 61_001;
  const resumed = await scheduler.processDueSnoozes(resumedAt);
  assert.equal(resumed.resumed, 1);
  const after = await call(scheduler, "/control-state/get", { key: "monitor:items" });
  assert.equal(after.value[0].enabled, true);
  assert.equal(after.value[0].paused, false);
  assert.equal(after.value[0].resumeAt, "");

  const runtime = await call(scheduler, "/target-state/get", { model: "SM-S938B", csc: "EUX" });
  assert.equal(runtime.runtime.lastVersion, "A/B/C");
  assert.equal(runtime.runtime.priorityScore, 90);
  assert.equal(runtime.runtime.monitorMode, "NORMAL");
  assert.equal(runtime.runtime.modeUntil, "");
  assert.ok(Date.parse(runtime.runtime.nextCheckAt) > resumedAt);
  assert.equal(queued.length, 1);
  assert.match(queued[0].text, /监控已自动恢复/);
  assert.match(queued[0].text, /原监控计划/);
});

test("Cron fails closed without KV writes when the Durable Object scheduler is unavailable", async () => {
  let kvReads = 0;
  let kvWrites = 0;
  const env = {
    MONITOR_SCHEDULER_ENABLED: "true",
    MONITOR_SCHEDULER: {
      idFromName() { return "global"; },
      get() {
        return { async fetch() { throw new Error("scheduler offline"); } };
      }
    },
    FIRMWARE_KV: {
      async get() { kvReads += 1; return null; },
      async put() { kvWrites += 1; }
    }
  };
  const schedule = { enabled: true, skipWeekends: false, startTime: "00:00", endTime: "23:59" };
  const result = await shouldRunNow(env, schedule, new Date("2026-07-14T12:30:00.000Z"));
  assert.equal(result.run, false);
  assert.equal(result.reason, "scheduler_unavailable");
  assert.equal(kvReads, 0);
  assert.equal(kvWrites, 0);
});

test("Cron does not use legacy KV locking unless explicitly enabled", async () => {
  let kvWrites = 0;
  const env = {
    MONITOR_ALLOW_KV_CRON_FALLBACK: "false",
    FIRMWARE_KV: {
      async get() { return null; },
      async put() { kvWrites += 1; }
    }
  };
  const schedule = { enabled: true, skipWeekends: false, startTime: "00:00", endTime: "23:59" };
  const result = await shouldRunNow(env, schedule, new Date("2026-07-14T12:30:00.000Z"));
  assert.equal(result.run, false);
  assert.equal(result.reason, "scheduler_required");
  assert.equal(kvWrites, 0);
});
