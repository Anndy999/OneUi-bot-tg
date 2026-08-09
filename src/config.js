import { validateModelCsc } from "./targets.js";

export function defaultCsc(env) {
  return String(env.DEFAULT_CSC || "CHC").trim().toUpperCase() || "CHC";
}

export function defaultTimezone(env) {
  return String(env.DEFAULT_TIMEZONE || "Asia/Shanghai").trim() || "Asia/Shanghai";
}

export function notifyOnFirstRun(env) {
  return String(env.NOTIFY_ON_FIRST_RUN || "false").trim().toLowerCase() === "true";
}

export function notifyAllowedUsersOnUpdate(env) {
  return String(env.NOTIFY_ALLOWED_USERS_ON_UPDATE ?? "true").trim().toLowerCase() === "true";
}

export function verifySecret(env, secret) {
  const expected = String(env.WEBHOOK_SECRET || "");
  return Boolean(expected) && secret === expected;
}

export function adminChatId(env) {
  return String(env.TELEGRAM_CHAT_ID || "").trim();
}

export function isAdminChatId(env, chatId) {
  return Boolean(adminChatId(env)) && String(chatId) === adminChatId(env);
}

export function unauthorizedMode(env) {
  const value = String(env.UNAUTHORIZED_MODE || "reply").trim().toLowerCase();
  return value === "silent" ? "silent" : "reply";
}

export function queryCacheTtlSeconds(env) {
  const ttl = Number(env.QUERY_CACHE_TTL_SECONDS || 900);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 900;
}

export function globalQueryCacheTtlSeconds(env) {
  const ttl = Number(env.GLOBAL_QUERY_CACHE_TTL_SECONDS || 300);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 300;
}


export function historyRequestTimeoutMs(env) {
  const value = Number(env.HISTORY_REQUEST_TIMEOUT_MS || 4000);
  return Number.isFinite(value) && value > 0 ? value : 4000;
}

export function historyTotalDeadlineMs(env) {
  const value = Number(env.HISTORY_TOTAL_DEADLINE_MS || 6000);
  return Number.isFinite(value) && value > 0 ? value : 6000;
}



export function l1CacheTtlSeconds(env) {
  const value = Number(env.L1_CACHE_TTL_SECONDS || 5);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

export function firmwareCacheFreshSeconds(env) {
  const value = Number(env.FIRMWARE_CACHE_FRESH_SECONDS || 8);
  return Number.isFinite(value) && value > 0 ? value : 8;
}

export function firmwareCacheStaleSeconds(env) {
  const value = Number(env.FIRMWARE_CACHE_STALE_SECONDS || 86400);
  return Number.isFinite(value) && value > 0 ? value : 86400;
}


export function negativeCacheTtlSeconds(env) {
  const value = Number(env.NEGATIVE_CACHE_TTL_SECONDS || 20);
  return Number.isFinite(value) && value > 0 ? value : 20;
}

export function envBool(env, key, fallback = true) {
  const value = env?.[key];
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

export function defaultCacheSettings(env) {
  return {
    schemaVersion: 4,
    enabled: envBool(env, "CACHE_ENABLED", true),
    adminRealtimeEnabled: envBool(env, "ADMIN_REALTIME_QUERY_ENABLED", false),
    updatedAt: new Date().toISOString(),
    updatedBy: ""
  };
}

export function queryRateLimitSeconds(env) {
  const seconds = Number(env.QUERY_RATE_LIMIT_SECONDS || 3);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3;
}

export function allowedUserDailyModelQueryLimit(env) {
  const limit = Number(env.ALLOWED_USER_DAILY_MODEL_QUERY_LIMIT || 10);
  return Number.isFinite(limit) && limit >= 1 ? Math.min(100, Math.floor(limit)) : 10;
}


export function queryStaleWhileRevalidateSeconds(env) {
  const value = Number(env.QUERY_STALE_WHILE_REVALIDATE_SECONDS || 120);
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 3600) : 120;
}

export function telegramQueryPlaceholderEnabled(env) {
  return envBool(env, "TELEGRAM_QUERY_PLACEHOLDER_ENABLED", true);
}

export function monitorStateReadConcurrency(env) {
  const value = Number(env.MONITOR_STATE_READ_CONCURRENCY || 8);
  return Number.isFinite(value) && value >= 1 ? Math.min(20, Math.floor(value)) : 8;
}

export function monitorFailureRetryBaseSeconds(env) {
  const value = Number(env.MONITOR_FAILURE_RETRY_BASE_SECONDS || 60);
  return Number.isFinite(value) && value >= 15 ? Math.min(Math.floor(value), 900) : 60;
}

export function monitorFailureRetryMaxSeconds(env) {
  const value = Number(env.MONITOR_FAILURE_RETRY_MAX_SECONDS || 300);
  return Number.isFinite(value) && value >= 30 ? Math.min(Math.floor(value), 3600) : 300;
}


export function monitorPermanentErrorRetrySeconds(env) {
  const value = Number(env.MONITOR_PERMANENT_ERROR_RETRY_SECONDS || 1800);
  return Number.isFinite(value) && value >= 300 ? Math.min(Math.floor(value), 86400) : 1800;
}

export function monitorProgressUpdateMs(env) {
  const value = Number(env.MONITOR_PROGRESS_UPDATE_MS || 1500);
  return Number.isFinite(value) && value >= 500 ? Math.min(Math.floor(value), 10000) : 1500;
}

export function telegramNotifyConcurrency(env) {
  const value = Number(env.TELEGRAM_NOTIFY_CONCURRENCY || 4);
  return Number.isFinite(value) && value >= 1 ? Math.min(8, Math.floor(value)) : 4;
}

export function dailyMonitorSummaryEnabled(env) {
  return envBool(env, "DAILY_MONITOR_SUMMARY_ENABLED", true);
}

export function dailyMonitorSummaryHour(env) {
  const hour = Number(env?.DAILY_MONITOR_SUMMARY_HOUR ?? 21);
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? Math.floor(hour) : 21;
}

export function defaultDailyMonitorSummarySettings(env) {
  return {
    schemaVersion: 1,
    enabled: dailyMonitorSummaryEnabled(env),
    hour: dailyMonitorSummaryHour(env),
    updatedAt: new Date().toISOString(),
    updatedBy: ""
  };
}

export function reminderIntervalMinutes(env) {
  const minutes = Number(env.UPDATE_REMINDER_INTERVAL_MINUTES || 5);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
}


export function releaseWindowEnabled(env) {
  return envBool(env, "RELEASE_WINDOW_ENABLED", true);
}

export function releaseWindowDurationMinutes(env) {
  const value = Number(env.RELEASE_WINDOW_DURATION_MINUTES || 120);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), 24 * 60) : 120;
}

export function releaseWindowIntervalMinutes(env) {
  const value = Number(env.RELEASE_WINDOW_INTERVAL_MINUTES || 3);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), 60) : 3;
}

export function reminderMaxCount(env) {
  const count = Number(env.UPDATE_REMINDER_MAX_COUNT || 12);
  return Number.isFinite(count) && count > 0 ? count : 12;
}

export function defaultSchedule(env) {
  const interval = Number(env.DEFAULT_MONITOR_INTERVAL_MINUTES || 30);
  return {
    timezone: defaultTimezone(env),
    schemaVersion: 2,
    startTime: String(env.DEFAULT_MONITOR_START_TIME || "00:00").trim() || "00:00",
    endTime: String(env.DEFAULT_MONITOR_END_TIME || "23:59").trim() || "23:59",
    intervalMinutes: [5, 10, 15, 30, 60].includes(interval) ? interval : 30,
    skipWeekends: String(env.DEFAULT_SKIP_WEEKENDS || "false").trim().toLowerCase() === "true",
    enabled: true,
    updatedAt: new Date().toISOString()
  };
}

export function envMonitorItems(env) {
  const raw = env.MONITOR_ITEMS_JSON || "[]";
  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    return normalizeMonitorItems(items);
  } catch (error) {
    console.log(`Invalid MONITOR_ITEMS_JSON: ${error.message}`);
    return [];
  }
}

export function normalizeMonitorItems(items) {
  const priorityRank = { high: 3, normal: 2, low: 1 };
  const seen = new Set();
  return items
    .map((item) => {
      let target;
      try {
        target = validateModelCsc(item.model, item.csc);
      } catch {
        return null;
      }
      const priority = ["high", "normal", "low"].includes(String(item.priority || "").toLowerCase())
        ? String(item.priority).toLowerCase()
        : "normal";
      const interval = Number(item.intervalMinutes || 0);
      const enabled = item.enabled !== false && item.paused !== true;
      return {
        model: target.model,
        csc: target.csc,
        name: String(item.name || "").trim(),
        priority,
        priorityRank: priorityRank[priority],
        enabled,
        paused: !enabled,
        pauseReason: String(item.pauseReason || "").trim(),
        prioritySource: String(item.prioritySource || "manual").trim() || "manual",
        linkedFrom: String(item.linkedFrom || "").trim(),
        linkedRuleId: String(item.linkedRuleId || "").trim(),
        linkedAt: String(item.linkedAt || "").trim(),
        adminDecision: String(item.adminDecision || "").trim(),
        rolloutChainId: String(item.rolloutChainId || "").trim().slice(0, 48),
        rolloutStageId: String(item.rolloutStageId || "").trim().slice(0, 48),
        // A staged test-build confirmation may temporarily run the matching
        // official monitor while the legacy rollout chain remains paused.
        testFirmwareMonitorOverride: item.testFirmwareMonitorOverride === true,
        resumeAt: String(item.resumeAt || "").trim(),
        pausedAt: String(item.pausedAt || "").trim(),
        pauseSource: String(item.pauseSource || "").trim(),
        // Per-target user broadcasts default to enabled so existing monitor
        // entries keep their current behaviour after this schema extension.
        notifyAllowedUsers: item.notifyAllowedUsers !== false,
        intervalMinutes: Number.isFinite(interval) && interval >= 1
          ? Math.min(1440, Math.floor(interval))
          : 0
      };
    })
    .filter((item) => {
      if (!item) return false;
      const key = `${item.model}:${item.csc}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
