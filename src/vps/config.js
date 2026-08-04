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
  return {
    nodeEnv: text(env.NODE_ENV, "development"),
    host: text(env.VPS_HOST, "127.0.0.1"),
    port: Math.max(1, Math.min(65535, Number(env.VPS_PORT || 8787))),
    publicBaseUrl: text(env.VPS_PUBLIC_BASE_URL),
    version: text(env.APP_VERSION, "2.17.4"),
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
    scheduleIntervalMs: Math.max(15_000, Math.min(10 * 60_000, Number(env.VPS_SCHEDULE_INTERVAL_MS || 60_000)))
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
