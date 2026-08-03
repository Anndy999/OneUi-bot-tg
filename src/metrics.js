import { recordSchedulerMetric } from "./monitor-scheduler.js";

const recentQueries = [];
const RECENT_QUERY_LIMIT = 200;
const SUMMARY_INTERVAL = 20;

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function rollingSummary() {
  const totals = recentQueries.map((item) => item.totalMs).filter((value) => value >= 0);
  const samsung = recentQueries.map((item) => item.smartHistoryMs).filter((value) => value >= 0);
  return {
    event: "firmware_query_summary",
    timestamp: new Date().toISOString(),
    sampleSize: recentQueries.length,
    totalMsP50: percentile(totals, 0.5),
    totalMsP95: percentile(totals, 0.95),
    totalMsP99: percentile(totals, 0.99),
    smartHistoryMsP50: percentile(samsung, 0.5),
    smartHistoryMsP95: percentile(samsung, 0.95),
    cacheHitRate: recentQueries.filter((item) => item.cacheLayer !== "miss").length / recentQueries.length,
    singleFlightJoinRate: recentQueries.filter((item) => item.singleFlightJoined).length / recentQueries.length,
    successRate: recentQueries.filter((item) => item.ok).length / recentQueries.length
  };
}

export function logQueryMetric(metric, env = null, ctx = null) {
  const timingFields = [
    "webhookAckMs",
    "inputParseMs",
    "identityLoadMs",
    "cacheLookupMs",
    "coordinatorHopMs",
    "laneQueueWaitMs",
    "sessionAcquireMs",
    "nonceMs",
    "smartHistoryMs",
    "parseHistoryMs",
    "doTransactionMs",
    "queuePublishMs",
    "kvMirrorMs",
    "telegramPlaceholderMs",
    "telegramResultMs",
    "totalMs"
  ];
  const value = {
    event: "firmware_query",
    timestamp: new Date().toISOString(),
    model: String(metric?.model || ""),
    csc: String(metric?.csc || ""),
    cacheLayer: String(metric?.cacheLayer || "miss"),
    selectedSource: String(metric?.selectedSource || "unknown"),
    historyMs: Number(metric?.historyMs || 0),
    totalBeforeTelegramMs: Number(metric?.totalBeforeTelegramMs || 0),
    degraded: Boolean(metric?.degraded),
    ok: metric?.ok !== false
  };
  for (const field of timingFields) {
    const number = Number(metric?.[field]);
    if (Number.isFinite(number) && number >= 0) value[field] = number;
  }
  value.laneId = String(metric?.laneId || "");
  value.singleFlightJoined = Boolean(metric?.singleFlightJoined);
  value.coordinatorCacheLayer = String(metric?.coordinatorCacheLayer || "");
  console.log(JSON.stringify(value));
  recentQueries.push({
    totalMs: Number.isFinite(value.totalMs) ? value.totalMs : Number(value.totalBeforeTelegramMs || 0),
    smartHistoryMs: Number.isFinite(value.smartHistoryMs) ? value.smartHistoryMs : Number(value.historyMs || 0),
    cacheLayer: value.cacheLayer,
    singleFlightJoined: value.singleFlightJoined,
    ok: value.ok
  });
  if (recentQueries.length > RECENT_QUERY_LIMIT) recentQueries.shift();
  if (recentQueries.length % SUMMARY_INTERVAL === 0) console.log(JSON.stringify(rollingSummary()));
  if (env?.MONITOR_SCHEDULER) {
    const task = recordSchedulerMetric(env, {
      type: "query",
      timestamp: Date.now(),
      model: value.model,
      csc: value.csc,
      ok: value.ok,
      cacheLayer: value.cacheLayer,
      singleFlightJoined: value.singleFlightJoined,
      totalMs: Number.isFinite(value.totalMs) ? value.totalMs : Number(value.totalBeforeTelegramMs || 0),
      smartHistoryMs: Number.isFinite(value.smartHistoryMs) ? value.smartHistoryMs : Number(value.historyMs || 0),
      errorClass: String(metric?.errorClass || "")
    }).catch((error) => console.log(`Persistent metrics failed: ${error.message}`));
    if (ctx?.waitUntil) ctx.waitUntil(task);
  }
  return value;
}
