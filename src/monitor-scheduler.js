import { validateModelCsc } from "./targets.js";
import { normalizeMonitorItems } from "./config.js";
import { randomId } from "./runtime/random-id.js";
import {
  normalizeMonitorIntervalSettings,
  priorityScoreIntervalMinutes,
  releaseModeIntervalMinutes
} from "./monitor-intervals.js";

const INITIALIZED_KEY = "meta:initialized";
const TARGET_COUNT_KEY = "meta:target-count";
const TELEGRAM_DEDUPE_KEY = "telegram:dedupe";
const NOTIFICATION_PREFIX = "notification:";
const NOTIFICATION_CLEANUP_KEY = "meta:notification-cleanup-at";
const TARGET_PREFIX = "target:";
const DUE_PREFIX = "due:";
const CONTROL_STATE_PREFIX = "control:";
const CONTROL_MIRROR_PREFIX = "mirror:control:";
const QUERY_RATE_PREFIX = "rate:query:";
const USER_MODEL_QUOTA_PREFIX = "quota:user-model:";
const USER_MODEL_QUOTA_CLEANUP_KEY = "meta:user-model-quota-cleanup";
const CRON_SLOT_KEY = "cron:last-slot";
const SNOOZE_PREFIX = "snooze:";
const QUERY_DEMAND_PREFIX = "demand:";
const METRIC_PREFIX = "metric:hour:";
const METRIC_CLEANUP_KEY = "meta:metric-cleanup-at";
const BUDGET_PREFIX = "budget:hour:";
const BUDGET_STATE_KEY = "budget:adaptive";
const DAILY_SUMMARY_KEY = "daily-summary:delivery";
const DEFAULT_LOCK_MS = 5 * 60 * 1000;
const TELEGRAM_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_DEDUPE_MAX = 500;
const NOTIFICATION_LOCK_MS = 2 * 60 * 1000;
const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SUBMINUTE_MODES = new Set(["WATCH", "HOT", "COOLDOWN"]);

function padTime(value) {
  return String(Math.max(0, Math.floor(Number(value) || 0))).padStart(13, "0");
}

function dueKey(at, key) {
  return `${DUE_PREFIX}${padTime(at)}:${key}`;
}

function targetStorageKey(key) {
  return `${TARGET_PREFIX}${key}`;
}

function normalizeControlStateKey(key) {
  const value = String(key || "").trim();
  const exact = new Set([
    "monitor:schedule",
    "monitor:summary-settings",
    "monitor:items",
    "monitor:intervals",
    "allowed:users",
    "admin:users",
    "access:requests",
    "access:settings",
    "cache:settings",
    "diagnostics:last-alert",
    "monitor:events"
  ]);
  if (exact.has(value)) return value;
  if (/^user:lang:-?\d{1,24}$/.test(value)) return value;
  if (/^(?:flagship|rollout):proposal:[a-zA-Z0-9_-]{6,64}$/.test(value)) return value;
  if (value === "rollout:chains") return value;
  if (/^monitor:boost:SM-[A-Z0-9-]{2,20}:[A-Z0-9]{3}$/.test(value)) return value;
  if (/^acked:update:SM-[A-Z0-9-]{2,20}:[A-Z0-9]{3}$/.test(value)) return value;
  throw new Error("Unsupported control state key");
}

function controlStateStorageKey(key) {
  return `${CONTROL_STATE_PREFIX}${normalizeControlStateKey(key)}`;
}

function schedulerEnabled(env) {
  if (!env?.MONITOR_SCHEDULER) return false;
  return String(env.MONITOR_SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false";
}

function schedulerStub(env) {
  if (!schedulerEnabled(env)) return null;
  const id = env.MONITOR_SCHEDULER.idFromName("global");
  return env.MONITOR_SCHEDULER.get(id);
}

async function schedulerRequest(env, path, body) {
  const stub = schedulerStub(env);
  if (!stub) return null;
  try {
    const response = await stub.fetch(`https://monitor-scheduler${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.log(`MonitorScheduler compatibility fallback for ${path}: ${error.message}`);
    return null;
  }
}

export async function syncMonitorScheduler(env, items, now = new Date()) {
  return schedulerRequest(env, "/sync", { items, now: new Date(now).getTime() });
}

export async function claimDueMonitorTargets(env, now = new Date(), limit = 6) {
  return schedulerRequest(env, "/claim", {
    now: new Date(now).getTime(),
    limit: Math.max(1, Math.min(24, Number(limit) || 6))
  });
}

export async function claimManualMonitorTargets(env, items, now = new Date()) {
  return schedulerRequest(env, "/claim-manual", {
    now: new Date(now).getTime(),
    items
  });
}

export async function completeMonitorTarget(env, item, completion) {
  return schedulerRequest(env, "/complete", {
    model: item.model,
    csc: item.csc,
    ...completion
  });
}

export async function validateMonitorTargetClaim(env, item, now = Date.now()) {
  return schedulerRequest(env, "/claim-valid", {
    model: item.model,
    csc: item.csc,
    lock: String(item.lock || ""),
    now
  });
}

export async function forceSchedulerTargetDue(env, model, csc, dueAt = new Date()) {
  return schedulerRequest(env, "/force", {
    model,
    csc,
    dueAt: new Date(dueAt).getTime()
  });
}

export async function claimTelegramUpdate(env, updateId, now = Date.now()) {
  const normalized = String(updateId ?? "").trim();
  if (!normalized) return { ok: true, duplicate: false, unavailable: true };
  return schedulerRequest(env, "/telegram-update", { updateId: normalized, now });
}

export async function claimNotificationDelivery(env, notificationId, now = Date.now()) {
  const normalized = String(notificationId ?? "").trim();
  if (!normalized) return { ok: true, duplicate: false, unavailable: true, lock: "" };
  return schedulerRequest(env, "/notification-claim", { notificationId: normalized, now });
}

export async function getSchedulerControlState(env, key) {
  return schedulerRequest(env, "/control-state/get", { key });
}

export async function putSchedulerControlState(env, key, value) {
  return schedulerRequest(env, "/control-state/put", { key, value });
}

export async function deleteSchedulerControlState(env, key) {
  return schedulerRequest(env, "/control-state/delete", { key });
}

export async function getSchedulerTargetState(env, model, csc) {
  return schedulerRequest(env, "/target-state/get", { model, csc });
}

export async function patchSchedulerTargetState(env, model, csc, patch) {
  return schedulerRequest(env, "/target-state/patch", { model, csc, patch });
}

export async function recordSchedulerMetric(env, metric) {
  return schedulerRequest(env, "/metrics/record", { metric });
}

export async function getSchedulerMetricsSummary(env, hours = 24) {
  return schedulerRequest(env, "/metrics/summary", { hours });
}

export async function getSchedulerDiagnostics(env) {
  return schedulerRequest(env, "/diagnostics", {});
}

export async function getSchedulerBudgetStatus(env) {
  return schedulerRequest(env, "/budget/status", {});
}

export async function getMonitorIntervalSettings(env) {
  const result = await getSchedulerControlState(env, "monitor:intervals");
  return normalizeMonitorIntervalSettings(result?.found ? result.value : {});
}

export async function setMonitorIntervalSettings(env, value) {
  const normalized = normalizeMonitorIntervalSettings({ schemaVersion: 2, ...(value || {}) });
  const result = await putSchedulerControlState(env, "monitor:intervals", { schemaVersion: 2, ...normalized });
  return { ...(result || { ok: false, unavailable: true }), settings: normalized };
}

export async function upsertSchedulerMonitorItem(env, item) {
  return schedulerRequest(env, "/monitor-items/upsert", { item });
}

export async function removeSchedulerMonitorItem(env, model, csc) {
  return schedulerRequest(env, "/monitor-items/remove", { model, csc });
}

export async function claimSchedulerQueryRateLimit(env, chatId, seconds, now = Date.now()) {
  return schedulerRequest(env, "/query-rate-limit", {
    chatId: String(chatId || ""),
    seconds: Math.max(1, Math.min(300, Number(seconds) || 3)),
    now
  });
}

export async function claimSchedulerCronSlot(env, slot, now = Date.now()) {
  return schedulerRequest(env, "/cron-slot/claim", { slot: String(slot || ""), now });
}

export async function claimSchedulerDailyModelQuery(env, chatId, model, dateKey, limit, now = Date.now()) {
  return schedulerRequest(env, "/user-query-quota/claim", {
    chatId: String(chatId || ""),
    model: String(model || ""),
    dateKey: String(dateKey || ""),
    limit: Math.max(1, Math.min(100, Number(limit) || 10)),
    now
  });
}

export async function snoozeSchedulerMonitorItem(env, model, csc, resumeAt, metadata = {}) {
  return schedulerRequest(env, "/monitor-snooze/set", {
    model,
    csc,
    resumeAt: new Date(resumeAt).getTime(),
    metadata
  });
}

export async function cancelSchedulerMonitorSnooze(env, model, csc) {
  return schedulerRequest(env, "/monitor-snooze/cancel", { model, csc });
}

export async function recordSchedulerQueryDemand(env, model, csc, now = Date.now()) {
  return schedulerRequest(env, "/query-demand/record", { model, csc, now });
}

export async function getSchedulerQueryDemand(env, model, csc, now = Date.now()) {
  return schedulerRequest(env, "/query-demand/get", { model, csc, now });
}

export async function completeNotificationDelivery(env, notificationId, lock, sent, now = Date.now()) {
  const normalized = String(notificationId ?? "").trim();
  if (!normalized) return { ok: false, missing: true };
  return schedulerRequest(env, "/notification-complete", {
    notificationId: normalized,
    lock: String(lock || ""),
    sent: Boolean(sent),
    now
  });
}

export async function claimSchedulerDailySummary(env, dateKey, now = Date.now()) {
  return schedulerRequest(env, "/daily-summary/claim", { dateKey, now });
}

export async function completeSchedulerDailySummary(env, dateKey, sent, now = Date.now()) {
  return schedulerRequest(env, "/daily-summary/complete", { dateKey, sent: Boolean(sent), now });
}

export async function appendSchedulerMonitorEvent(env, event) {
  return schedulerRequest(env, "/monitor-events/append", { event });
}

export async function getSchedulerMonitorEvents(env, limit = 20) {
  return schedulerRequest(env, "/monitor-events/list", {
    limit: Math.max(1, Math.min(50, Number(limit) || 20))
  });
}

export class MonitorScheduler {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.operationTail = Promise.resolve();
  }

  lockDurationMs() {
    const configured = Number(this.env?.MONITOR_SCHEDULER_LOCK_MS || DEFAULT_LOCK_MS);
    return Number.isFinite(configured) && configured >= 60_000
      ? Math.min(Math.floor(configured), 30 * 60 * 1000)
      : DEFAULT_LOCK_MS;
  }

  envSeconds(key, fallback, min = 5, max = 3600) {
    const value = Number(this.env?.[key] || fallback);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
  }

  budgetConfig() {
    const hourly = Number(this.env?.MONITOR_MAX_QUERIES_PER_HOUR || 300);
    const concurrent = Number(this.env?.MONITOR_MAX_CONCURRENT_QUERIES || this.env?.MONITOR_CONCURRENCY || 3);
    const minIntervalSeconds = Number(this.env?.MONITOR_MIN_TARGET_INTERVAL_SECONDS || 60);
    return {
      hourly: Number.isFinite(hourly) ? Math.max(1, Math.min(100000, Math.floor(hourly))) : 300,
      concurrent: Number.isFinite(concurrent) ? Math.max(1, Math.min(24, Math.floor(concurrent))) : 3,
      minIntervalSeconds: Number.isFinite(minIntervalSeconds) ? Math.max(30, Math.min(86400, Math.floor(minIntervalSeconds))) : 60
    };
  }

  hourBucket(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 13);
  }

  async budgetSnapshot(now = Date.now()) {
    const config = this.budgetConfig();
    const key = `${BUDGET_PREFIX}${this.hourBucket(now)}`;
    const used = Number(await this.ctx.storage.get(key) || 0);
    const adaptive = await this.ctx.storage.get(BUDGET_STATE_KEY) || { factor: 1, successStreak: 0 };
    const targets = await this.ctx.storage.list({ prefix: TARGET_PREFIX });
    const inFlight = [...targets.values()].filter((record) => record.inFlight && Number(record.lockUntil || 0) > now).length;
    return {
      key,
      used,
      remaining: Math.max(0, config.hourly - used),
      inFlight,
      availableConcurrency: Math.max(0, config.concurrent - inFlight),
      adaptiveFactor: Math.max(1, Number(adaptive.factor || 1)),
      adaptive,
      config
    };
  }

  async consumeBudget(key, amount = 1) {
    const used = Number(await this.ctx.storage.get(key) || 0);
    await this.ctx.storage.put(key, used + Math.max(0, Number(amount) || 0));
  }

  async updateAdaptiveBudget(status, error, now = Date.now()) {
    const current = await this.ctx.storage.get(BUDGET_STATE_KEY) || { factor: 1, successStreak: 0 };
    if (status === "skipped") return current;
    const message = String(error || "");
    const upstreamLimited = status === "failed" && /(?:HTTP\s*(?:403|429|5\d\d)|timeout|timed out|network|upstream)/i.test(message);
    let factor = Math.max(1, Number(current.factor || 1));
    let successStreak = Math.max(0, Number(current.successStreak || 0));
    if (upstreamLimited) {
      factor = Math.min(8, Math.max(2, factor * 2));
      successStreak = 0;
    } else if (status !== "failed") {
      successStreak += 1;
      if (successStreak >= 10 && factor > 1) {
        factor = Math.max(1, Math.round(factor * 0.9 * 100) / 100);
        successStreak = 0;
      }
    }
    const value = {
      factor,
      successStreak,
      lastReason: upstreamLimited ? message.slice(0, 160) : String(current.lastReason || ""),
      updatedAt: now
    };
    await this.ctx.storage.put(BUDGET_STATE_KEY, value);
    return value;
  }

  runtimeSnapshot(record) {
    if (!record) return null;
    const iso = (value) => Number(value || 0) > 0 ? new Date(Number(value)).toISOString() : "";
    return {
      lastAttemptAt: iso(record.lastAttemptAt),
      lastSuccessAt: iso(record.lastSuccessAt),
      nextAttemptAt: iso(record.nextAttemptAt),
      failureCount: Math.max(0, Number(record.failureCount || 0)),
      lastError: String(record.lastError || ""),
      errorClass: String(record.errorClass || ""),
      forcedAt: iso(record.forcedAt),
      lastVersion: String(record.lastVersion || ""),
      lastVersionChangedAt: iso(record.lastVersionChangedAt),
      lastOfficialUpdateAt: iso(record.lastOfficialUpdateAt),
      lastPeerUpdateAt: iso(record.lastPeerUpdateAt),
      lastBuildDate: String(record.lastBuildDate || ""),
      lastSequence: record.lastSequence ?? null,
      priorityScore: Math.max(0, Math.min(100, Number(record.priorityScore || 0))),
      lastCheckedAt: iso(record.lastCheckedAt),
      nextCheckAt: iso(record.nextCheckAt),
      monitorMode: String(record.monitorMode || "NORMAL"),
      modeUntil: iso(record.modeUntil),
      lastQuerySource: String(record.lastQuerySource || ""),
      lastQueryMode: String(record.lastQueryMode || ""),
      lastQueryCacheHit: record.lastQueryCacheHit === true,
      lastQueryShared: record.lastQueryShared === true
    };
  }

  async intervalSettings() {
    const storageKey = controlStateStorageKey("monitor:intervals");
    const value = await this.ctx.storage.get(storageKey);
    const normalized = normalizeMonitorIntervalSettings(value || {});
    if (Number(value?.schemaVersion || 1) < 2) {
      await this.ctx.storage.put(storageKey, { schemaVersion: 2, ...normalized });
    }
    return normalized;
  }

  async rescheduleForCurrentIntervals(now = Date.now()) {
    const intervalSettings = await this.intervalSettings();
    const targets = await this.ctx.storage.list({ prefix: TARGET_PREFIX });
    for (const [storageKey, current] of targets) {
      if (current.item?.enabled === false) {
        if (current.scheduleKey) await this.ctx.storage.delete(current.scheduleKey);
        await this.ctx.storage.put(storageKey, { ...current, nextCheckAt: 0, scheduleKey: "", inFlight: false, lockUntil: 0, lock: "" });
        continue;
      }
      if (current.inFlight && Number(current.lockUntil || 0) > now) continue;
      const itemOverride = Number(current.item?.intervalMinutes || 0);
      const mode = String(current.monitorMode || "NORMAL").toLowerCase();
      const intervalMinutes = itemOverride > 0
        ? itemOverride
        : (["watch", "hot", "cooldown"].includes(mode)
          ? releaseModeIntervalMinutes(mode, intervalSettings)
          : priorityScoreIntervalMinutes(current.priorityScore, intervalSettings));
      const lastCheckedAt = Number(current.lastCheckedAt || 0);
      const desiredAt = lastCheckedAt > 0
        ? lastCheckedAt + intervalMinutes * 60 * 1000
        : now;
      const nextCheckAt = Math.max(now, desiredAt);
      if (current.scheduleKey) await this.ctx.storage.delete(current.scheduleKey);
      const scheduleKey = dueKey(nextCheckAt, current.key);
      const record = { ...current, nextCheckAt, scheduleKey };
      await this.ctx.storage.put(storageKey, record);
      await this.ctx.storage.put(scheduleKey, { key: current.key });
    }
    await this.scheduleNextAlarm();
  }

  async scheduleNextAlarm() {
    if (typeof this.ctx.storage.setAlarm !== "function") return;
    const targets = await this.ctx.storage.list({ prefix: TARGET_PREFIX });
    let earliest = 0;
    for (const record of targets.values()) {
      if (record.item?.enabled === false) continue;
      if (!SUBMINUTE_MODES.has(String(record.monitorMode || "NORMAL"))) continue;
      const at = Number(record.nextCheckAt || 0);
      if (at > 0 && (!earliest || at < earliest)) earliest = at;
    }
    const mirrors = await this.ctx.storage.list({ prefix: CONTROL_MIRROR_PREFIX });
    for (const mirror of mirrors.values()) {
      const at = Number(mirror.retryAt || 0);
      if (at > 0 && (!earliest || at < earliest)) earliest = at;
    }
    const snoozes = await this.ctx.storage.list({ prefix: SNOOZE_PREFIX });
    for (const snooze of snoozes.values()) {
      const at = Number(snooze.resumeAt || 0);
      if (at > 0 && (!earliest || at < earliest)) earliest = at;
    }
    if (earliest) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, earliest));
  }

  async serialized(factory) {
    const previous = this.operationTail;
    let release;
    this.operationTail = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await factory();
    } finally {
      release();
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : {};
    try {
      if (url.pathname === "/sync") return Response.json(await this.serialized(() => this.sync(body)));
      if (url.pathname === "/claim") return Response.json(await this.serialized(() => this.claim(body)));
      if (url.pathname === "/claim-manual") return Response.json(await this.serialized(() => this.claimManual(body)));
      if (url.pathname === "/complete") return Response.json(await this.serialized(() => this.complete(body)));
      if (url.pathname === "/claim-valid") return Response.json(await this.serialized(() => this.claimValid(body)));
      if (url.pathname === "/force") return Response.json(await this.serialized(() => this.force(body)));
      if (url.pathname === "/telegram-update") return Response.json(await this.serialized(() => this.telegramUpdate(body)));
      if (url.pathname === "/notification-claim") return Response.json(await this.serialized(() => this.notificationClaim(body)));
      if (url.pathname === "/notification-complete") return Response.json(await this.serialized(() => this.notificationComplete(body)));
      if (url.pathname === "/daily-summary/claim") return Response.json(await this.serialized(() => this.dailySummaryClaim(body)));
      if (url.pathname === "/daily-summary/complete") return Response.json(await this.serialized(() => this.dailySummaryComplete(body)));
      if (url.pathname === "/control-state/get") return Response.json(await this.serialized(() => this.controlStateGet(body)));
      if (url.pathname === "/control-state/put") return Response.json(await this.serialized(() => this.controlStatePut(body)));
      if (url.pathname === "/control-state/delete") return Response.json(await this.serialized(() => this.controlStateDelete(body)));
      if (url.pathname === "/target-state/get") return Response.json(await this.serialized(() => this.targetStateGet(body)));
      if (url.pathname === "/target-state/patch") return Response.json(await this.serialized(() => this.targetStatePatch(body)));
      if (url.pathname === "/metrics/record") return Response.json(await this.serialized(() => this.metricRecord(body)));
      if (url.pathname === "/metrics/summary") return Response.json(await this.metricsSummary(body));
      if (url.pathname === "/diagnostics") return Response.json(await this.diagnostics());
      if (url.pathname === "/budget/status") return Response.json(await this.budgetStatus());
      if (url.pathname === "/monitor-items/upsert") return Response.json(await this.serialized(() => this.monitorItemUpsert(body)));
      if (url.pathname === "/monitor-items/remove") return Response.json(await this.serialized(() => this.monitorItemRemove(body)));
      if (url.pathname === "/monitor-events/append") return Response.json(await this.serialized(() => this.monitorEventAppend(body)));
      if (url.pathname === "/monitor-events/list") return Response.json(await this.monitorEventList(body));
      if (url.pathname === "/query-rate-limit") return Response.json(await this.serialized(() => this.queryRateLimit(body)));
      if (url.pathname === "/cron-slot/claim") return Response.json(await this.serialized(() => this.cronSlotClaim(body)));
      if (url.pathname === "/user-query-quota/claim") return Response.json(await this.serialized(() => this.userModelQuotaClaim(body)));
      if (url.pathname === "/monitor-snooze/set") return Response.json(await this.serialized(() => this.monitorSnoozeSet(body)));
      if (url.pathname === "/monitor-snooze/cancel") return Response.json(await this.serialized(() => this.monitorSnoozeCancel(body)));
      if (url.pathname === "/query-demand/record") return Response.json(await this.serialized(() => this.queryDemandRecord(body)));
      if (url.pathname === "/query-demand/get") return Response.json(await this.serialized(() => this.queryDemandGet(body)));
      if (url.pathname === "/migration/export") return Response.json(await this.serialized(() => this.migrationExport()));
      if (url.pathname === "/status") return Response.json(await this.status());
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return Response.json({ ok: false, error: error.message }, { status: 400 });
    }
  }

  async sync(body) {
    const now = Number(body.now || Date.now());
    const items = (Array.isArray(body.items) ? body.items : []).map((item) => {
      const target = validateModelCsc(item.model, item.csc);
      return { ...item, model: target.model, csc: target.csc, key: target.key };
    });
    const allowed = new Set(items.map((item) => item.key));
    const existing = await this.ctx.storage.list({ prefix: TARGET_PREFIX });

    for (const [storageKey, record] of existing) {
      if (allowed.has(record.key)) continue;
      if (record.scheduleKey) await this.ctx.storage.delete(record.scheduleKey);
      await this.ctx.storage.delete(storageKey);
      await this.ctx.storage.delete(`${SNOOZE_PREFIX}${record.key}`);
    }

    for (const item of items) {
      const storageKey = targetStorageKey(item.key);
      const current = await this.ctx.storage.get(storageKey);
      if (current) {
        if (item.enabled === false) {
          if (current.scheduleKey) await this.ctx.storage.delete(current.scheduleKey);
          await this.ctx.storage.put(storageKey, {
            ...current,
            item,
            nextCheckAt: 0,
            scheduleKey: "",
            inFlight: false,
            lockUntil: 0,
            lock: ""
          });
          continue;
        }
        if (current.scheduleKey) {
          await this.ctx.storage.put(storageKey, { ...current, item });
          continue;
        }
        const scheduleKey = dueKey(now, item.key);
        await this.ctx.storage.put(storageKey, {
          ...current,
          item,
          nextCheckAt: now,
          scheduleKey,
          inFlight: false,
          lockUntil: 0,
          lock: ""
        });
        await this.ctx.storage.put(scheduleKey, { key: item.key });
        continue;
      }
      const enabled = item.enabled !== false;
      const scheduleKey = enabled ? dueKey(now, item.key) : "";
      const record = {
        key: item.key,
        item,
        nextCheckAt: enabled ? now : 0,
        inFlight: false,
        lockUntil: 0,
        lock: "",
        lastVersion: "",
        priorityScore: 0,
        monitorMode: "NORMAL",
        modeUntil: 0,
        lastCheckedAt: 0,
        failureCount: 0,
        lastAttemptAt: 0,
        lastSuccessAt: 0,
        nextAttemptAt: 0,
        lastError: "",
        errorClass: "",
        lastVersionChangedAt: 0,
        lastOfficialUpdateAt: 0,
        lastPeerUpdateAt: 0,
        lastBuildDate: "",
        lastSequence: null,
        lastQuerySource: "",
        lastQueryMode: "",
        lastQueryCacheHit: false,
        lastQueryShared: false,
        scheduleKey
      };
      await this.ctx.storage.put(storageKey, record);
      if (scheduleKey) await this.ctx.storage.put(scheduleKey, { key: item.key });
    }
    await this.ctx.storage.put(INITIALIZED_KEY, true);
    await this.ctx.storage.put(TARGET_COUNT_KEY, items.filter((item) => item.enabled !== false).length);
    await this.scheduleNextAlarm();
    return { ok: true, initialized: true, targets: items.filter((item) => item.enabled !== false).length };
  }

  async claimRecord(record, scheduleKey, now) {
    if (record.inFlight && Number(record.lockUntil || 0) > now) return null;
    const lockUntil = now + this.lockDurationMs();
    const lock = randomId();
    const recoveryKey = dueKey(lockUntil, record.key);
    const claimed = {
      ...record,
      inFlight: true,
      lockUntil,
      lock,
      nextCheckAt: lockUntil,
      scheduleKey: recoveryKey
    };
    if (scheduleKey) await this.ctx.storage.delete(scheduleKey);
    else if (record.scheduleKey) await this.ctx.storage.delete(record.scheduleKey);
    await this.ctx.storage.put(targetStorageKey(record.key), claimed);
    await this.ctx.storage.put(recoveryKey, { key: record.key });
    return {
      item: record.item,
      priorityScore: Number(record.priorityScore || 0),
      lastVersion: record.lastVersion || "",
      monitorMode: record.monitorMode || "NORMAL",
      modeUntil: Number(record.modeUntil || 0),
      failureCount: Number(record.failureCount || 0),
      runtime: this.runtimeSnapshot(record),
      lock,
      lockUntil,
      schedulerClaim: true
    };
  }

  async claim(body) {
    const initialized = await this.ctx.storage.get(INITIALIZED_KEY);
    if (!initialized) return { ok: true, needsSync: true, totalTargets: 0, entries: [] };

    const now = Number(body.now || Date.now());
    const limit = Math.max(1, Math.min(24, Number(body.limit) || 6));
    const due = await this.ctx.storage.list({
      prefix: DUE_PREFIX,
      end: `${DUE_PREFIX}${padTime(now)}:\uffff`,
      limit: Math.min(100, Math.max(limit * 4, limit))
    });
    const candidates = [];
    for (const [scheduleKey, pointer] of due) {
      const record = await this.ctx.storage.get(targetStorageKey(pointer.key));
      if (!record) {
        await this.ctx.storage.delete(scheduleKey);
        continue;
      }
      if (record.item?.enabled === false) {
        await this.ctx.storage.delete(scheduleKey);
        continue;
      }
      if (record.inFlight && Number(record.lockUntil || 0) > now) continue;
      candidates.push({ scheduleKey, record });
    }
    candidates.sort((a, b) => {
      const priority = Number(b.record.priorityScore || 0) - Number(a.record.priorityScore || 0);
      if (priority) return priority;
      return Number(a.record.nextCheckAt || 0) - Number(b.record.nextCheckAt || 0);
    });

    const budget = await this.budgetSnapshot(now);
    const allowed = Math.min(limit, budget.remaining, budget.availableConcurrency);
    const entries = [];
    for (const candidate of candidates.slice(0, allowed)) {
      const claimed = await this.claimRecord(candidate.record, candidate.scheduleKey, now);
      if (claimed) entries.push(claimed);
    }
    if (entries.length) await this.consumeBudget(budget.key, entries.length);
    const totalTargets = Number(await this.ctx.storage.get(TARGET_COUNT_KEY) || 0);
    return {
      ok: true,
      needsSync: false,
      totalTargets,
      entries,
      budget: { ...budget, used: budget.used + entries.length, remaining: Math.max(0, budget.remaining - entries.length) }
    };
  }

  async claimManual(body) {
    const now = Number(body.now || Date.now());
    const items = Array.isArray(body.items) ? body.items : [];
    const entries = [];
    const skipped = [];
    const budget = await this.budgetSnapshot(now);
    const allowed = Math.min(items.length, budget.remaining, budget.availableConcurrency);
    for (const item of items.slice(0, allowed)) {
      const target = validateModelCsc(item.model, item.csc);
      const record = await this.ctx.storage.get(targetStorageKey(target.key));
      if (!record) {
        skipped.push({ model: target.model, csc: target.csc, reason: "missing" });
        continue;
      }
      const claimed = await this.claimRecord(record, record.scheduleKey, now);
      if (claimed) entries.push(claimed);
      else skipped.push({ model: target.model, csc: target.csc, reason: "in_flight" });
    }
    for (const item of items.slice(allowed)) {
      const target = validateModelCsc(item.model, item.csc);
      skipped.push({ model: target.model, csc: target.csc, reason: budget.remaining <= 0 ? "hourly_budget" : "concurrency_budget" });
    }
    if (entries.length) await this.consumeBudget(budget.key, entries.length);
    return { ok: true, entries, skipped, budget: { ...budget, used: budget.used + entries.length, remaining: Math.max(0, budget.remaining - entries.length) } };
  }

  async complete(body) {
    const target = validateModelCsc(body.model, body.csc);
    const storageKey = targetStorageKey(target.key);
    const current = await this.ctx.storage.get(storageKey);
    if (!current) return { ok: false, missing: true };
    if (body.lock && body.lock !== current.lock) return { ok: false, staleLock: true };

    const now = Number(body.completedAt || Date.now());
    const previousVersion = current.lastVersion || "";
    const nextVersion = body.lastVersion || previousVersion;
    const status = String(body.status || "");
    const baselineReset = status === "baseline";
    const versionChanged = !baselineReset && Boolean(previousVersion && nextVersion && previousVersion !== nextVersion);
    let monitorMode = String(current.monitorMode || "NORMAL").toUpperCase();
    let modeUntil = Number(current.modeUntil || 0);
    let nextCheckAt = Math.max(now, Number(body.nextCheckAt || now));
    const priorityScore = Math.max(0, Math.min(100, Number(body.priorityScore || 0)));
    const intervalSettings = await this.intervalSettings();
    const watchMs = releaseModeIntervalMinutes("watch", intervalSettings) * 60 * 1000;
    const hotMs = releaseModeIntervalMinutes("hot", intervalSettings) * 60 * 1000;
    const cooldownMs = releaseModeIntervalMinutes("cooldown", intervalSettings) * 60 * 1000;
    let failureCount = Number(current.failureCount || 0);

    if (status === "failed") {
      failureCount += 1;
      monitorMode = "NORMAL";
      modeUntil = 0;
    } else if (status === "skipped") {
      // A release-chain time window or weekend pause is intentional: retain
      // the existing runtime and the caller-provided next permitted time.
    } else {
      failureCount = 0;
      if (versionChanged || status === "updated") {
        monitorMode = "HOT";
        modeUntil = now + this.envSeconds("MONITOR_HOT_DURATION_SECONDS", 180, 30, 1800) * 1000;
        nextCheckAt = Math.min(nextCheckAt, now + hotMs);
      } else if (monitorMode === "HOT") {
        if (now < modeUntil) {
          nextCheckAt = Math.min(nextCheckAt, now + hotMs);
        } else {
          monitorMode = "COOLDOWN";
          modeUntil = now + this.envSeconds("MONITOR_COOLDOWN_DURATION_SECONDS", 600, 60, 3600) * 1000;
          nextCheckAt = Math.min(nextCheckAt, now + cooldownMs);
        }
      } else if (monitorMode === "COOLDOWN" && now < modeUntil) {
        nextCheckAt = Math.min(nextCheckAt, now + cooldownMs);
      } else if (monitorMode === "WATCH" && now < modeUntil) {
        nextCheckAt = Math.min(nextCheckAt, now + watchMs);
      } else if (body.releaseBoost === true) {
        monitorMode = "WATCH";
        modeUntil = now + this.envSeconds("MONITOR_WATCH_DURATION_SECONDS", 7200, 60, 24 * 3600) * 1000;
        nextCheckAt = Math.min(nextCheckAt, now + watchMs);
      } else {
        monitorMode = "NORMAL";
        modeUntil = 0;
      }
    }
    const adaptive = await this.updateAdaptiveBudget(status, body.error, now);
    const minimumDelay = this.budgetConfig().minIntervalSeconds * 1000;
    const requestedDelay = Math.max(minimumDelay, nextCheckAt - now);
    nextCheckAt = now + Math.max(minimumDelay, Math.round(requestedDelay * Math.max(1, Number(adaptive.factor || 1))));
    if (current.scheduleKey) await this.ctx.storage.delete(current.scheduleKey);
    const scheduleKey = dueKey(nextCheckAt, current.key);
    const record = {
      ...current,
      inFlight: false,
      lockUntil: 0,
      lock: "",
      nextCheckAt,
      lastVersion: nextVersion,
      priorityScore,
      monitorMode,
      modeUntil,
      lastCheckedAt: now,
      failureCount,
      lastAttemptAt: now,
      lastSuccessAt: status === "failed" || status === "skipped" ? Number(current.lastSuccessAt || 0) : now,
      nextAttemptAt: status === "failed" ? nextCheckAt : 0,
      lastError: status === "failed" ? String(body.error || "").slice(0, 500) : (status === "skipped" ? String(current.lastError || "") : ""),
      errorClass: status === "failed" ? String(body.errorClass || "transient") : (status === "skipped" ? String(current.errorClass || "") : ""),
      lastVersionChangedAt: versionChanged ? now : Number(current.lastVersionChangedAt || 0),
      lastOfficialUpdateAt: body.officialUpdateAt
        ? (Date.parse(body.officialUpdateAt) || Number(current.lastOfficialUpdateAt || 0))
        : (versionChanged ? now : Number(current.lastOfficialUpdateAt || 0)),
      lastBuildDate: String(body.buildDate || current.lastBuildDate || ""),
      lastSequence: body.sequence !== undefined && body.sequence !== null && Number.isFinite(Number(body.sequence))
        ? Number(body.sequence)
        : (current.lastSequence ?? null),
      lastQuerySource: status === "failed" || status === "skipped"
        ? String(current.lastQuerySource || "")
        : String(body.querySource || current.lastQuerySource || ""),
      lastQueryMode: status === "failed" || status === "skipped"
        ? String(current.lastQueryMode || "")
        : String(body.queryMode || current.lastQueryMode || ""),
      lastQueryCacheHit: status === "failed" || status === "skipped" || body.queryCacheHit === undefined
        ? current.lastQueryCacheHit === true
        : Boolean(body.queryCacheHit),
      lastQueryShared: status === "failed" || status === "skipped" || body.queryShared === undefined
        ? current.lastQueryShared === true
        : Boolean(body.queryShared),
      scheduleKey
    };
    await this.ctx.storage.put(storageKey, record);
    await this.ctx.storage.put(scheduleKey, { key: current.key });
    if (status !== "skipped") {
      await this.metricRecord({ metric: {
        type: "monitor",
        timestamp: now,
        ok: status !== "failed",
        updated: versionChanged || status === "updated",
        errorClass: status === "failed" ? String(body.errorClass || "transient") : "",
        model: target.model,
        csc: target.csc
      } });
    }
    await this.scheduleNextAlarm();
    return { ok: true, nextCheckAt, monitorMode, modeUntil, versionChanged, previousVersion, adaptiveFactor: adaptive.factor };
  }

  async claimValid(body) {
    const target = validateModelCsc(body.model, body.csc);
    const current = await this.ctx.storage.get(targetStorageKey(target.key));
    const now = Number(body.now || Date.now());
    const lock = String(body.lock || "");
    const valid = Boolean(
      current &&
      current.inFlight === true &&
      lock &&
      current.lock === lock &&
      Number(current.lockUntil || 0) > now
    );
    return { ok: true, valid };
  }

  async force(body) {
    const target = validateModelCsc(body.model, body.csc);
    const storageKey = targetStorageKey(target.key);
    const current = await this.ctx.storage.get(storageKey);
    if (!current) return { ok: false, missing: true };
    const nextCheckAt = Math.max(0, Number(body.dueAt || Date.now()));
    if (current.scheduleKey) await this.ctx.storage.delete(current.scheduleKey);
    const scheduleKey = dueKey(nextCheckAt, current.key);
    await this.ctx.storage.put(storageKey, {
      ...current,
      inFlight: false,
      lockUntil: 0,
      lock: "",
      nextCheckAt,
      scheduleKey
    });
    await this.ctx.storage.put(scheduleKey, { key: current.key });
    await this.scheduleNextAlarm();
    return { ok: true, nextCheckAt };
  }

  async alarm() {
    return this.serialized(async () => {
      const now = Date.now();
      await this.processDueSnoozes(now);
      const mirrors = await this.ctx.storage.list({ prefix: CONTROL_MIRROR_PREFIX });
      for (const [storageKey, mirror] of mirrors) {
        if (Number(mirror.retryAt || 0) > now) continue;
        try {
          await this.env.FIRMWARE_KV?.put(mirror.key, JSON.stringify(mirror.value));
          await this.ctx.storage.delete(storageKey);
        } catch (error) {
          await this.ctx.storage.put(storageKey, {
            ...mirror,
            attempts: Number(mirror.attempts || 0) + 1,
            retryAt: now + 60 * 60 * 1000,
            lastError: String(error?.message || error).slice(0, 240)
          });
        }
      }
      const requestedLimit = Math.max(1, Math.min(6, Number(this.env?.MONITOR_CONCURRENCY || 3)));
      const budget = await this.budgetSnapshot(now);
      const limit = Math.min(requestedLimit, budget.remaining, budget.availableConcurrency);
      const due = await this.ctx.storage.list({
        prefix: DUE_PREFIX,
        end: `${DUE_PREFIX}${padTime(now)}:\uffff`,
        limit: 50
      });
      const entries = [];
      for (const [scheduleKey, pointer] of due) {
        if (entries.length >= limit) break;
        const record = await this.ctx.storage.get(targetStorageKey(pointer.key));
        if (!record || record.item?.enabled === false || !SUBMINUTE_MODES.has(String(record.monitorMode || "NORMAL"))) continue;
        const claimed = await this.claimRecord(record, scheduleKey, now);
        if (claimed) entries.push(claimed);
      }

      if (entries.length) await this.consumeBudget(budget.key, entries.length);

      for (const entry of entries) {
        try {
          if (!this.env?.NOTIFICATION_QUEUE?.send) throw new Error("Monitor queue binding is unavailable");
          await this.env.NOTIFICATION_QUEUE.send({
            schemaVersion: 1,
            kind: "monitor_check",
            entry,
            createdAt: new Date(now).toISOString()
          });
        } catch (error) {
          await this.complete({
            model: entry.item.model,
            csc: entry.item.csc,
            lock: entry.lock,
            status: "failed",
            lastVersion: entry.lastVersion,
            priorityScore: entry.priorityScore,
            nextCheckAt: now + 60_000,
            completedAt: now
          });
          console.log(`Sub-minute monitor enqueue failed for ${entry.item.model}/${entry.item.csc}: ${error.message}`);
        }
      }
      await this.scheduleNextAlarm();
      return { ok: true, queued: entries.length };
    });
  }

  async telegramUpdate(body) {
    const updateId = String(body.updateId ?? "").trim();
    if (!updateId) return { ok: true, duplicate: false };
    const now = Number(body.now || Date.now());
    const current = await this.ctx.storage.get(TELEGRAM_DEDUPE_KEY) || {};
    const fresh = Object.entries(current)
      .filter(([, seenAt]) => now - Number(seenAt || 0) <= TELEGRAM_DEDUPE_TTL_MS)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, TELEGRAM_DEDUPE_MAX - 1);
    const duplicate = fresh.some(([key]) => key === updateId);
    if (!duplicate) fresh.unshift([updateId, now]);
    await this.ctx.storage.put(TELEGRAM_DEDUPE_KEY, Object.fromEntries(fresh));
    return { ok: true, duplicate };
  }

  async cleanupNotifications(now) {
    const lastCleanup = Number(await this.ctx.storage.get(NOTIFICATION_CLEANUP_KEY) || 0);
    if (now - lastCleanup < 24 * 60 * 60 * 1000) return;
    const records = await this.ctx.storage.list({ prefix: NOTIFICATION_PREFIX, limit: 1000 });
    const deletions = [];
    for (const [key, record] of records) {
      const reference = Number(record?.sentAt || record?.updatedAt || 0);
      if (reference > 0 && now - reference > NOTIFICATION_RETENTION_MS) deletions.push(key);
    }
    if (deletions.length) await this.ctx.storage.delete(deletions);
    await this.ctx.storage.put(NOTIFICATION_CLEANUP_KEY, now);
  }

  async notificationClaim(body) {
    const notificationId = String(body.notificationId ?? "").trim();
    if (!notificationId) return { ok: false, missing: true };
    const now = Number(body.now || Date.now());
    await this.cleanupNotifications(now);
    const key = `${NOTIFICATION_PREFIX}${notificationId}`;
    const current = await this.ctx.storage.get(key);
    if (current?.status === "sent" && now - Number(current.sentAt || 0) <= NOTIFICATION_RETENTION_MS) {
      return { ok: true, duplicate: true, busy: false, lock: "" };
    }
    if (current?.status === "sending" && Number(current.lockUntil || 0) > now) {
      return { ok: true, duplicate: false, busy: true, lock: "" };
    }
    const lock = randomId();
    await this.ctx.storage.put(key, {
      status: "sending",
      lock,
      lockUntil: now + NOTIFICATION_LOCK_MS,
      updatedAt: now,
      sentAt: Number(current?.sentAt || 0)
    });
    return { ok: true, duplicate: false, busy: false, lock };
  }

  async notificationComplete(body) {
    const notificationId = String(body.notificationId ?? "").trim();
    if (!notificationId) return { ok: false, missing: true };
    const key = `${NOTIFICATION_PREFIX}${notificationId}`;
    const current = await this.ctx.storage.get(key);
    if (!current) return { ok: false, missing: true };
    if (body.lock && current.lock && body.lock !== current.lock) return { ok: false, staleLock: true };
    const now = Number(body.now || Date.now());
    if (body.sent) {
      await this.ctx.storage.put(key, {
        status: "sent",
        lock: "",
        lockUntil: 0,
        updatedAt: now,
        sentAt: now
      });
      return { ok: true, sent: true };
    }
    await this.ctx.storage.delete(key);
    return { ok: true, sent: false };
  }

  async dailySummaryClaim(body) {
    const dateKey = String(body.dateKey || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error("Invalid daily summary date");
    const now = Number(body.now || Date.now());
    const current = await this.ctx.storage.get(DAILY_SUMMARY_KEY);
    if (current?.dateKey === dateKey && current?.status === "sent") {
      return { ok: true, claimed: false, reason: "already_sent" };
    }
    if (current?.dateKey === dateKey && current?.status === "sending" && Number(current.lockUntil || 0) > now) {
      return { ok: true, claimed: false, reason: "in_progress" };
    }
    await this.ctx.storage.put(DAILY_SUMMARY_KEY, {
      dateKey,
      status: "sending",
      lockUntil: now + 10 * 60 * 1000,
      updatedAt: now
    });
    return { ok: true, claimed: true };
  }

  async dailySummaryComplete(body) {
    const dateKey = String(body.dateKey || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error("Invalid daily summary date");
    const sent = body.sent === true;
    const current = await this.ctx.storage.get(DAILY_SUMMARY_KEY);
    if (!current || current.dateKey !== dateKey) return { ok: true, ignored: true };
    if (!sent) {
      await this.ctx.storage.delete(DAILY_SUMMARY_KEY);
      return { ok: true, sent: false };
    }
    await this.ctx.storage.put(DAILY_SUMMARY_KEY, {
      dateKey,
      status: "sent",
      sentAt: Number(body.now || Date.now())
    });
    return { ok: true, sent: true };
  }

  async controlStateGet(body) {
    const storageKey = controlStateStorageKey(body.key);
    const value = await this.ctx.storage.get(storageKey);
    return { ok: true, found: value !== undefined, value: value ?? null };
  }

  async controlStatePut(body) {
    if (!Object.prototype.hasOwnProperty.call(body, "value")) throw new Error("Missing control state value");
    const normalizedKey = normalizeControlStateKey(body.key);
    const storageKey = controlStateStorageKey(normalizedKey);
    const storedValue = normalizedKey === "monitor:intervals"
      ? { schemaVersion: 2, ...normalizeMonitorIntervalSettings({ schemaVersion: 2, ...(body.value || {}) }) }
      : body.value;
    const existing = await this.ctx.storage.get(storageKey);
    if (JSON.stringify(existing) === JSON.stringify(storedValue)) {
      const mirrorPending = normalizedKey === "monitor:items" && Boolean(
        await this.ctx.storage.get(`${CONTROL_MIRROR_PREFIX}${normalizedKey}`)
      );
      return { ok: true, changed: false, mirrorPending };
    }
    await this.ctx.storage.put(storageKey, storedValue);
    if (normalizedKey === "monitor:intervals") {
      await this.rescheduleForCurrentIntervals();
      return { ok: true, changed: true, mirrorPending: false };
    }
    if (normalizedKey !== "monitor:items" || !this.env.FIRMWARE_KV) {
      return { ok: true, changed: true, mirrorPending: false };
    }
    try {
      await this.env.FIRMWARE_KV.put(normalizedKey, JSON.stringify(body.value));
      await this.ctx.storage.delete(`${CONTROL_MIRROR_PREFIX}${normalizedKey}`);
      return { ok: true, changed: true, mirrorPending: false };
    } catch (error) {
      await this.ctx.storage.put(`${CONTROL_MIRROR_PREFIX}${normalizedKey}`, {
        key: normalizedKey,
        value: body.value,
        attempts: 1,
        retryAt: Date.now() + 60 * 60 * 1000,
        lastError: String(error?.message || error).slice(0, 240)
      });
      await this.scheduleNextAlarm();
      return { ok: true, changed: true, mirrorPending: true };
    }
  }

  async controlStateDelete(body) {
    const normalizedKey = normalizeControlStateKey(body.key);
    const storageKey = controlStateStorageKey(normalizedKey);
    const existing = await this.ctx.storage.get(storageKey);
    if (existing === undefined) return { ok: true, deleted: false };
    await this.ctx.storage.delete(storageKey);
    await this.ctx.storage.delete(`${CONTROL_MIRROR_PREFIX}${normalizedKey}`);
    return { ok: true, deleted: true };
  }

  async targetStateGet(body) {
    const target = validateModelCsc(body.model, body.csc);
    const record = await this.ctx.storage.get(targetStorageKey(target.key));
    return { ok: true, found: Boolean(record), runtime: this.runtimeSnapshot(record), item: record?.item || null };
  }

  async targetStatePatch(body) {
    const target = validateModelCsc(body.model, body.csc);
    const storageKey = targetStorageKey(target.key);
    const current = await this.ctx.storage.get(storageKey);
    if (!current) return { ok: false, missing: true };
    const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
    const next = { ...current };
    const dateFields = new Set([
      "lastAttemptAt", "lastSuccessAt", "nextAttemptAt", "forcedAt", "lastVersionChangedAt",
      "lastOfficialUpdateAt", "lastPeerUpdateAt", "lastCheckedAt", "nextCheckAt", "modeUntil"
    ]);
    const allowed = new Set([
      ...dateFields, "failureCount", "lastError", "errorClass", "lastVersion", "lastBuildDate",
      "lastSequence", "priorityScore", "monitorMode"
    ]);
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) continue;
      if (dateFields.has(key)) {
        const ms = value ? (Number(value) || Date.parse(value)) : 0;
        next[key] = Number.isFinite(ms) ? ms : 0;
      } else if (["failureCount", "priorityScore"].includes(key)) {
        next[key] = Number(value || 0);
      } else if (key === "lastSequence") {
        next[key] = value === null || value === "" ? null : Number(value);
      } else {
        next[key] = value;
      }
    }
    if (next.nextCheckAt !== current.nextCheckAt) {
      if (current.scheduleKey) await this.ctx.storage.delete(current.scheduleKey);
      next.scheduleKey = dueKey(Number(next.nextCheckAt || Date.now()), current.key);
      await this.ctx.storage.put(next.scheduleKey, { key: current.key });
    }
    await this.ctx.storage.put(storageKey, next);
    await this.scheduleNextAlarm();
    return { ok: true, runtime: this.runtimeSnapshot(next) };
  }

  percentile(values, ratio) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
  }

  async cleanupMetrics(now = Date.now()) {
    const last = Number(await this.ctx.storage.get(METRIC_CLEANUP_KEY) || 0);
    if (now - last < 6 * 60 * 60 * 1000) return;
    const records = await this.ctx.storage.list({ prefix: METRIC_PREFIX });
    const budgets = await this.ctx.storage.list({ prefix: BUDGET_PREFIX });
    const cutoff = now - 72 * 60 * 60 * 1000;
    const deletions = [];
    for (const [key, value] of records) {
      if (Number(value?.startedAt || 0) < cutoff) deletions.push(key);
    }
    for (const [key] of budgets) {
      const hour = key.slice(BUDGET_PREFIX.length);
      const startedAt = Date.parse(`${hour}:00:00.000Z`);
      if (Number.isFinite(startedAt) && startedAt < cutoff) deletions.push(key);
    }
    if (deletions.length) await this.ctx.storage.delete(deletions);
    await this.ctx.storage.put(METRIC_CLEANUP_KEY, now);
  }

  async metricRecord(body) {
    const metric = body.metric && typeof body.metric === "object" ? body.metric : {};
    const now = Number(metric.timestamp || Date.now());
    const key = `${METRIC_PREFIX}${this.hourBucket(now)}`;
    const current = await this.ctx.storage.get(key) || {
      startedAt: Date.parse(`${this.hourBucket(now)}:00:00.000Z`),
      queryCount: 0, querySuccess: 0, cacheHits: 0, singleFlightJoins: 0,
      monitorChecks: 0, monitorUpdates: 0, monitorFailures: 0,
      totalMs: [], smartHistoryMs: [], errors: {}
    };
    if (metric.type === "monitor") {
      current.monitorChecks += 1;
      if (metric.updated) current.monitorUpdates += 1;
      if (metric.ok === false) current.monitorFailures += 1;
    } else {
      current.queryCount += 1;
      if (metric.ok !== false) current.querySuccess += 1;
      if (String(metric.cacheLayer || "miss") !== "miss") current.cacheHits += 1;
      if (metric.singleFlightJoined) current.singleFlightJoins += 1;
      const totalMs = Number(metric.totalMs);
      const smartHistoryMs = Number(metric.smartHistoryMs);
      if (Number.isFinite(totalMs) && totalMs >= 0) current.totalMs.push(totalMs);
      if (Number.isFinite(smartHistoryMs) && smartHistoryMs >= 0) current.smartHistoryMs.push(smartHistoryMs);
      current.totalMs = current.totalMs.slice(-500);
      current.smartHistoryMs = current.smartHistoryMs.slice(-500);
    }
    if (metric.ok === false) {
      const errorClass = String(metric.errorClass || "unknown").slice(0, 40);
      current.errors[errorClass] = Number(current.errors[errorClass] || 0) + 1;
    }
    current.updatedAt = now;
    await this.ctx.storage.put(key, current);
    await this.cleanupMetrics(now);
    return { ok: true };
  }

  async metricsSummary(body) {
    const hours = Math.max(1, Math.min(72, Number(body.hours || 24)));
    const now = Date.now();
    const records = await this.ctx.storage.list({ prefix: METRIC_PREFIX });
    const selected = [...records.values()].filter((value) => Number(value.startedAt || 0) >= now - hours * 60 * 60 * 1000);
    const summary = {
      ok: true, hours, queryCount: 0, querySuccess: 0, cacheHits: 0, singleFlightJoins: 0,
      monitorChecks: 0, monitorUpdates: 0, monitorFailures: 0, errors: {}, totalMs: [], smartHistoryMs: []
    };
    for (const value of selected) {
      for (const key of ["queryCount", "querySuccess", "cacheHits", "singleFlightJoins", "monitorChecks", "monitorUpdates", "monitorFailures"]) {
        summary[key] += Number(value[key] || 0);
      }
      summary.totalMs.push(...(value.totalMs || []));
      summary.smartHistoryMs.push(...(value.smartHistoryMs || []));
      for (const [key, count] of Object.entries(value.errors || {})) summary.errors[key] = Number(summary.errors[key] || 0) + Number(count || 0);
    }
    summary.querySuccessRate = summary.queryCount ? summary.querySuccess / summary.queryCount : 0;
    summary.cacheHitRate = summary.queryCount ? summary.cacheHits / summary.queryCount : 0;
    summary.singleFlightJoinRate = summary.queryCount ? summary.singleFlightJoins / summary.queryCount : 0;
    summary.totalMsP50 = this.percentile(summary.totalMs, 0.5);
    summary.totalMsP95 = this.percentile(summary.totalMs, 0.95);
    summary.totalMsP99 = this.percentile(summary.totalMs, 0.99);
    summary.smartHistoryMsP50 = this.percentile(summary.smartHistoryMs, 0.5);
    summary.smartHistoryMsP95 = this.percentile(summary.smartHistoryMs, 0.95);
    delete summary.totalMs;
    delete summary.smartHistoryMs;
    return summary;
  }

  async budgetStatus() {
    const snapshot = await this.budgetSnapshot(Date.now());
    return { ok: true, ...snapshot, key: undefined };
  }

  async diagnostics() {
    const now = Date.now();
    const targets = await this.ctx.storage.list({ prefix: TARGET_PREFIX });
    const overdue = [];
    const failing = [];
    for (const record of targets.values()) {
      const expected = Math.max(60_000, Number(record.nextCheckAt || 0) - Number(record.lastCheckedAt || 0));
      if (Number(record.nextCheckAt || 0) > 0 && now - Number(record.nextCheckAt || 0) > Math.max(5 * 60_000, expected * 2)) {
        overdue.push({ model: record.item?.model, csc: record.item?.csc, overdueMs: now - Number(record.nextCheckAt || 0) });
      }
      if (Number(record.failureCount || 0) > 0) {
        failing.push({ model: record.item?.model, csc: record.item?.csc, failureCount: Number(record.failureCount || 0), lastError: String(record.lastError || "").slice(0, 120) });
      }
    }
    const mirrors = await this.ctx.storage.list({ prefix: CONTROL_MIRROR_PREFIX });
    return {
      ok: true,
      initialized: Boolean(await this.ctx.storage.get(INITIALIZED_KEY)),
      targets: targets.size,
      overdue,
      failing,
      mirrorBacklog: mirrors.size,
      budget: await this.budgetStatus(),
      metrics: await this.metricsSummary({ hours: 24 }),
      alarmSupported: typeof this.ctx.storage.setAlarm === "function"
    };
  }

  async monitorItemUpsert(body) {
    const item = body.item || {};
    const target = validateModelCsc(item.model, item.csc);
    const storageKey = controlStateStorageKey("monitor:items");
    const items = normalizeMonitorItems(await this.ctx.storage.get(storageKey) || []);
    let existing = items.find((entry) => entry.model === target.model && entry.csc === target.csc);
    if (existing) {
      existing.name = item.name || existing.name || `${target.model} ${target.csc}`;
      if (item.priority !== undefined) existing.priority = String(item.priority).toLowerCase();
      if (Number(item.intervalMinutes) > 0) existing.intervalMinutes = Number(item.intervalMinutes);
      if (item.enabled !== undefined) existing.enabled = item.enabled !== false;
      if (item.paused !== undefined) existing.paused = item.paused === true;
      if (item.notifyAllowedUsers !== undefined) {
        existing.notifyAllowedUsers = item.notifyAllowedUsers !== false;
      }
      if (item.rolloutBaselinePending !== undefined) {
        existing.rolloutBaselinePending = item.rolloutBaselinePending === true;
      }
      for (const field of [
        "pauseReason",
        "prioritySource",
        "linkedFrom",
        "linkedRuleId",
        "linkedAt",
        "adminDecision",
        "rolloutChainId",
        "rolloutStageId",
        "resumeAt",
        "pausedAt",
        "pauseSource"
      ]) {
        if (item[field] !== undefined) {
          existing[field] = String(item[field] || "");
        }
      }
    } else {
      items.push({
        model: target.model,
        csc: target.csc,
        name: item.name || `${target.model} ${target.csc}`,
        priority: item.priority || "normal",
        enabled: item.enabled !== false && item.paused !== true,
        paused: item.paused === true || item.enabled === false,
        pauseReason: String(item.pauseReason || ""),
        prioritySource: String(item.prioritySource || "manual"),
        linkedFrom: String(item.linkedFrom || ""),
        linkedRuleId: String(item.linkedRuleId || ""),
        linkedAt: String(item.linkedAt || ""),
        adminDecision: String(item.adminDecision || ""),
        rolloutChainId: String(item.rolloutChainId || "").slice(0, 48),
        rolloutStageId: String(item.rolloutStageId || "").slice(0, 48),
        rolloutBaselinePending: item.rolloutBaselinePending === true,
        resumeAt: String(item.resumeAt || ""),
        pausedAt: String(item.pausedAt || ""),
        pauseSource: String(item.pauseSource || ""),
        notifyAllowedUsers: item.notifyAllowedUsers !== false,
        intervalMinutes: Number(item.intervalMinutes || 0)
      });
    }
    const normalized = normalizeMonitorItems(items);
    const persistence = await this.controlStatePut({ key: "monitor:items", value: normalized });
    const savedItem = normalized.find((entry) => entry.model === target.model && entry.csc === target.csc);
    if (savedItem?.enabled !== false || !savedItem?.resumeAt) {
      await this.ctx.storage.delete(`${SNOOZE_PREFIX}${target.key}`);
    }
    await this.sync({ items: normalized, now: Date.now() });
    await this.rescheduleForCurrentIntervals();
    existing = normalized.find((entry) => entry.model === target.model && entry.csc === target.csc);
    return { ...persistence, items: normalized, item: existing };
  }

  async monitorItemRemove(body) {
    const target = validateModelCsc(body.model, body.csc);
    const storageKey = controlStateStorageKey("monitor:items");
    const items = normalizeMonitorItems(await this.ctx.storage.get(storageKey) || []);
    const normalized = items.filter((entry) => entry.model !== target.model || entry.csc !== target.csc);
    const changed = normalized.length !== items.length;
    const persistence = changed
      ? await this.controlStatePut({ key: "monitor:items", value: normalized })
      : { ok: true, changed: false, mirrorPending: Boolean(await this.ctx.storage.get(`${CONTROL_MIRROR_PREFIX}monitor:items`)) };
    if (changed) {
      await this.ctx.storage.delete(`${SNOOZE_PREFIX}${target.key}`);
      await this.sync({ items: normalized, now: Date.now() });
      await this.scheduleNextAlarm();
    }
    return { ...persistence, removed: changed, items: normalized };
  }

  async monitorEventAppend(body) {
    const raw = body.event && typeof body.event === "object" ? body.event : null;
    if (!raw) throw new Error("Missing monitor event");
    const model = String(raw.model || "").trim().toUpperCase();
    const csc = String(raw.csc || "").trim().toUpperCase();
    if ((model && !csc) || (!model && csc)) throw new Error("Monitor event model and CSC must be paired");
    if (model) validateModelCsc(model, csc);
    const event = {
      type: String(raw.type || "monitor").slice(0, 48),
      model,
      csc,
      name: String(raw.name || "").slice(0, 96),
      audience: String(raw.audience || "").slice(0, 24),
      source: String(raw.source || "Samsung SmartHistory").slice(0, 96),
      error: String(raw.error || "").slice(0, 240),
      detail: String(raw.detail || "").slice(0, 160),
      failureCount: Math.max(0, Math.min(99, Number(raw.failureCount || 0))),
      retryAt: Number(raw.retryAt || 0),
      at: String(raw.at || new Date().toISOString())
    };
    const storageKey = controlStateStorageKey("monitor:events");
    const existing = await this.ctx.storage.get(storageKey);
    const events = Array.isArray(existing) ? existing : [];
    const next = [event, ...events].slice(0, 50);
    await this.ctx.storage.put(storageKey, next);
    return { ok: true, event, count: next.length };
  }

  async monitorEventList(body) {
    const limit = Math.max(1, Math.min(50, Number(body.limit || 20)));
    const events = await this.ctx.storage.get(controlStateStorageKey("monitor:events"));
    return { ok: true, events: (Array.isArray(events) ? events : []).slice(0, limit) };
  }

  async cronSlotClaim(body) {
    const slot = String(body.slot || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}:\d{2}:\d{2}$/.test(slot)) throw new Error("Invalid cron slot");
    const now = Number(body.now || Date.now());
    const previous = await this.ctx.storage.get(CRON_SLOT_KEY);
    if (previous?.slot === slot) return { ok: true, claimed: false, reason: "already_ran", slot };
    await this.ctx.storage.put(CRON_SLOT_KEY, { slot, claimedAt: now });
    return { ok: true, claimed: true, slot };
  }

  async cleanupUserModelQuotas(currentDateKey, now = Date.now()) {
    const lastCleanup = Number(await this.ctx.storage.get(USER_MODEL_QUOTA_CLEANUP_KEY) || 0);
    if (now - lastCleanup < 6 * 60 * 60 * 1000) return;
    const records = await this.ctx.storage.list({ prefix: USER_MODEL_QUOTA_PREFIX, limit: 2000 });
    const deletions = [];
    for (const key of records.keys()) {
      if (!key.startsWith(`${USER_MODEL_QUOTA_PREFIX}${currentDateKey}:`)) deletions.push(key);
    }
    if (deletions.length) await this.ctx.storage.delete(deletions);
    await this.ctx.storage.put(USER_MODEL_QUOTA_CLEANUP_KEY, now);
  }

  async userModelQuotaClaim(body) {
    const chatId = String(body.chatId || "").trim();
    const model = String(body.model || "").trim().toUpperCase();
    const dateKey = String(body.dateKey || "").trim();
    const limit = Math.max(1, Math.min(100, Number(body.limit) || 10));
    const now = Number(body.now || Date.now());
    if (!/^-?\d{1,24}$/.test(chatId)) throw new Error("Invalid query quota Chat ID");
    if (!/^SM-[A-Z0-9-]{2,24}$/.test(model)) throw new Error("Invalid query quota model");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error("Invalid query quota date");
    await this.cleanupUserModelQuotas(dateKey, now);
    const key = `${USER_MODEL_QUOTA_PREFIX}${dateKey}:${chatId}:${model}`;
    const current = Number(await this.ctx.storage.get(key) || 0);
    if (current >= limit) {
      return { ok: true, allowed: false, count: current, limit, remaining: 0, dateKey };
    }
    const count = current + 1;
    await this.ctx.storage.put(key, count);
    return { ok: true, allowed: true, count, limit, remaining: Math.max(0, limit - count), dateKey };
  }

  async monitorSnoozeSet(body) {
    const target = validateModelCsc(body.model, body.csc);
    const now = Date.now();
    const resumeAt = Number(body.resumeAt || 0);
    if (!Number.isFinite(resumeAt) || resumeAt < now + 60_000 || resumeAt > now + 62 * 24 * 60 * 60 * 1000) {
      throw new Error("Resume time must be between 1 minute and 62 days");
    }
    const controlKey = controlStateStorageKey("monitor:items");
    const items = normalizeMonitorItems(await this.ctx.storage.get(controlKey) || []);
    const item = items.find((entry) => entry.model === target.model && entry.csc === target.csc);
    if (!item) return { ok: false, missing: true };
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
    Object.assign(item, {
      enabled: false,
      paused: true,
      pauseReason: "post_update_snooze",
      pauseSource: "post_update",
      pausedAt: new Date(now).toISOString(),
      resumeAt: new Date(resumeAt).toISOString(),
      adminDecision: "resume_later"
    });
    const normalized = normalizeMonitorItems(items);
    const persistence = await this.controlStatePut({ key: "monitor:items", value: normalized });
    await this.sync({ items: normalized, now });
    const snooze = {
      model: target.model,
      csc: target.csc,
      key: target.key,
      name: String(item.name || `${target.model} ${target.csc}`),
      priority: String(item.priority || "normal"),
      intervalMinutes: Number(item.intervalMinutes || 0),
      resumeAt,
      pausedAt: now,
      updateVersion: String(metadata.updateVersion || ""),
      requestedBy: String(metadata.requestedBy || ""),
      reason: String(metadata.reason || "")
    };
    await this.ctx.storage.put(`${SNOOZE_PREFIX}${target.key}`, snooze);
    await this.scheduleNextAlarm();
    return { ...persistence, ok: true, snooze, item: normalized.find((entry) => entry.model === target.model && entry.csc === target.csc) };
  }

  async monitorSnoozeCancel(body) {
    const target = validateModelCsc(body.model, body.csc);
    const key = `${SNOOZE_PREFIX}${target.key}`;
    const existing = await this.ctx.storage.get(key);
    if (existing !== undefined) await this.ctx.storage.delete(key);
    await this.scheduleNextAlarm();
    return { ok: true, cancelled: existing !== undefined };
  }

  async processDueSnoozes(now = Date.now()) {
    const records = await this.ctx.storage.list({ prefix: SNOOZE_PREFIX, limit: 500 });
    const due = [...records.entries()].filter(([, value]) => Number(value?.resumeAt || 0) <= now);
    if (!due.length) return { resumed: 0 };
    const controlKey = controlStateStorageKey("monitor:items");
    const items = normalizeMonitorItems(await this.ctx.storage.get(controlKey) || []);
    const resumed = [];
    for (const [storageKey, snooze] of due) {
      const item = items.find((entry) => entry.model === snooze.model && entry.csc === snooze.csc);
      if (item) {
        Object.assign(item, {
          enabled: true,
          paused: false,
          pauseReason: "",
          pauseSource: "",
          pausedAt: "",
          resumeAt: "",
          adminDecision: "auto_resumed"
        });
        resumed.push({ item, snooze });
      }
      await this.ctx.storage.delete(storageKey);
    }
    if (!resumed.length) return { resumed: 0 };
    const normalized = normalizeMonitorItems(items);
    await this.controlStatePut({ key: "monitor:items", value: normalized });
    await this.sync({ items: normalized, now });

    // A timed pause means “resume the original plan”, not “continue the HOT
    // confirmation window that was active when the update was found”. Keep the
    // authoritative version/score history, but clear transient release modes
    // before calculating the next normal due time.
    for (const { item } of resumed) {
      const target = validateModelCsc(item.model, item.csc);
      const storageKey = targetStorageKey(target.key);
      const current = await this.ctx.storage.get(storageKey);
      if (!current) continue;
      await this.ctx.storage.put(storageKey, {
        ...current,
        monitorMode: "NORMAL",
        modeUntil: 0,
        nextAttemptAt: 0,
        lastError: "",
        errorClass: ""
      });
    }
    await this.rescheduleForCurrentIntervals(now);
    const adminId = String(this.env?.TELEGRAM_CHAT_ID || "").trim();
    if (adminId && this.env?.NOTIFICATION_QUEUE?.send) {
      const langState = await this.ctx.storage.get(controlStateStorageKey(`user:lang:${adminId}`));
      const en = langState === "en";
      for (const { item, snooze } of resumed) {
        if (snooze.reason === "rollout_release_pause") continue;
        const pausedMinutes = Math.max(1, Math.round((now - Number(snooze.pausedAt || now)) / 60000));
        const text = en
          ? [
              "▶️ Firmware monitoring resumed automatically",
              "",
              `${item.name || `${item.model} / ${item.csc}`}`,
              `${item.model} · ${item.csc}`,
              "",
              `Paused for: ${pausedMinutes} minutes`,
              `Priority: ${String(item.priority || "normal").toUpperCase()}`,
              "Monitoring will continue using the original interval plan."
            ].join("\n")
          : [
              "▶️ 固件监控已自动恢复",
              "",
              `${item.name || `${item.model} / ${item.csc}`}`,
              `${item.model} · ${item.csc}`,
              "",
              `暂停时长：约 ${pausedMinutes} 分钟`,
              `当前优先级：${String(item.priority || "normal").toUpperCase()}`,
              "已按原监控计划继续执行。"
            ].join("\n");
        await this.env.NOTIFICATION_QUEUE.send({
          schemaVersion: 1,
          id: `monitor-auto-resume:${item.model}:${item.csc}:${snooze.resumeAt}:${adminId}`,
          chatId: adminId,
          text,
          replyMarkup: { inline_keyboard: [
            [
              { text: en ? "View monitor" : "查看监控", callback_data: `monitor-item:view:${item.model}:${item.csc}` },
              { text: en ? "Query now" : "立即查询", callback_data: `query:refresh:${item.model}:${item.csc}` }
            ],
            [{ text: en ? "Home" : "返回首页", callback_data: "menu:home" }]
          ] },
          createdAt: new Date(now).toISOString()
        });
      }
    }
    return { resumed: resumed.length };
  }

  async queryRateLimit(body) {
    const chatId = String(body.chatId || "").trim();
    if (!/^-?\d{1,24}$/.test(chatId)) throw new Error("Invalid query rate-limit Chat ID");
    const now = Number(body.now || Date.now());
    const seconds = Math.max(1, Math.min(300, Number(body.seconds) || 3));
    const key = `${QUERY_RATE_PREFIX}${chatId}`;
    const previous = Number(await this.ctx.storage.get(key) || 0);
    if (previous > 0 && now - previous < seconds * 1000) {
      return { ok: true, allowed: false, retryAfterMs: seconds * 1000 - (now - previous) };
    }
    await this.ctx.storage.put(key, now);
    return { ok: true, allowed: true, retryAfterMs: 0 };
  }

  async queryDemandRecord(body) {
    const target = validateModelCsc(body.model, body.csc);
    const now = Number(body.now || Date.now());
    const key = `${QUERY_DEMAND_PREFIX}${target.key}`;
    const current = await this.ctx.storage.get(key) || {};
    const windowStart = Number(current.windowStartedAt || 0);
    const active = windowStart > 0 && now - windowStart < 24 * 60 * 60 * 1000;
    const value = {
      count: active ? Math.max(0, Number(current.count || 0)) + 1 : 1,
      windowStartedAt: active ? windowStart : now,
      updatedAt: now
    };
    await this.ctx.storage.put(key, value);
    return { ok: true, ...value };
  }

  async queryDemandGet(body) {
    const target = validateModelCsc(body.model, body.csc);
    const now = Number(body.now || Date.now());
    const key = `${QUERY_DEMAND_PREFIX}${target.key}`;
    const value = await this.ctx.storage.get(key) || null;
    if (!value || now - Number(value.windowStartedAt || 0) >= 24 * 60 * 60 * 1000) {
      return { ok: true, count: 0, windowStartedAt: 0, updatedAt: 0 };
    }
    return { ok: true, ...value };
  }

  async status() {
    const initialized = Boolean(await this.ctx.storage.get(INITIALIZED_KEY));
    const targets = await this.ctx.storage.list({ prefix: TARGET_PREFIX });
    return { ok: true, initialized, targets: targets.size, budget: await this.budgetStatus() };
  }

  async migrationExport() {
    const entries = [...(await this.ctx.storage.list({ limit: 10000 })).entries()];
    return {
      ok: true,
      schemaVersion: 1,
      object: "MonitorScheduler:global",
      exportedAt: new Date().toISOString(),
      entries
    };
  }
}
