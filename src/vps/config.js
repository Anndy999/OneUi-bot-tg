import { timingSafeEqual } from "node:crypto";

function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function text(value, fallback = "") {
  const result = String(value ?? fallback).trim();
  return result || fallback;
}

export function createVpsConfig(env = process.env) {
  const bounded = (value, fallback, minimum, maximum) => {
    const parsed = Number(value ?? fallback);
    return Number.isFinite(parsed)
      ? Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
      : fallback;
  };
  return {
    nodeEnv: text(env.NODE_ENV, "development"),
    host: text(env.VPS_HOST, "127.0.0.1"),
    port: Math.max(1, Math.min(65535, Number(env.VPS_PORT || 8787))),
    publicBaseUrl: text(env.VPS_PUBLIC_BASE_URL),
    version: text(env.APP_VERSION, "2.18.0"),
    databaseUrl: text(env.DATABASE_URL),
    redisUrl: text(env.REDIS_URL),
    webhookSecret: text(env.WEBHOOK_SECRET),
    internalApiSecret: text(env.INTERNAL_API_SECRET),
    shadowMode: bool(env.VPS_SHADOW_MODE, true),
    telegramSendEnabled: bool(env.TELEGRAM_SEND_ENABLED, false),
    telegramPollingEnabled: bool(env.TELEGRAM_POLLING_ENABLED, false),
    telegramPollingTimeoutSeconds: Math.max(1, Math.min(50, Number(env.TELEGRAM_POLLING_TIMEOUT_SECONDS || 30))),
    monitorNotificationsEnabled: bool(env.MONITOR_NOTIFICATIONS_ENABLED, false),
    queuePrefix: text(env.QUEUE_PREFIX, "oneui"),
    scheduleIntervalMs: bounded(env.VPS_SCHEDULE_INTERVAL_MS, 60_000, 15_000, 10 * 60_000),
    requestTimeoutMs: bounded(env.VPS_REQUEST_TIMEOUT_MS, 30_000, 5_000, 5 * 60_000),
    healthTimeoutMs: bounded(env.VPS_HEALTH_TIMEOUT_MS, 5_000, 1_000, 30_000),
    telegramWorkerConcurrency: bounded(env.TELEGRAM_WORKER_CONCURRENCY, 3, 1, 8),
    notificationWorkerConcurrency: bounded(env.NOTIFICATION_WORKER_CONCURRENCY, 4, 1, 8),
    monitorWorkerConcurrency: bounded(env.MONITOR_WORKER_CONCURRENCY, 2, 1, 4),
    scheduleStaleMs: bounded(env.VPS_SCHEDULE_STALE_MS, 5 * 60_000, 60_000, 30 * 60_000),
    coordinatorInstanceLimit: bounded(env.VPS_COORDINATOR_INSTANCE_LIMIT, 1000, 100, 10000),
    pgConnectionTimeoutMs: bounded(env.PG_CONNECTION_TIMEOUT_MS, 5_000, 1_000, 60_000),
    pgIdleTimeoutMs: bounded(env.PG_IDLE_TIMEOUT_MS, 30_000, 5_000, 10 * 60_000),
    pgQueryTimeoutMs: bounded(env.PG_QUERY_TIMEOUT_MS, 15_000, 1_000, 5 * 60_000),
    pgStatementTimeoutMs: bounded(env.PG_STATEMENT_TIMEOUT_MS, 15_000, 1_000, 5 * 60_000)
  };
}

export function constantTimeSecretEquals(expected, actual) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(actual || ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export function telegramSendAllowed(config) {
  return Boolean(config && !config.shadowMode && config.telegramSendEnabled);
}

export function monitorNotificationAllowed(config) {
  return Boolean(config && !config.shadowMode && config.telegramSendEnabled && config.monitorNotificationsEnabled);
}
