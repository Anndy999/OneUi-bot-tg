import { adminChatId } from "../config.js";
import {
  getSchedulerBudgetStatus,
  getSchedulerDiagnostics,
  getSchedulerMetricsSummary,
  claimSchedulerDailySummary,
  completeSchedulerDailySummary
} from "../monitor-scheduler.js";
import { getMonitorItems, getMonitorSummarySettings, getUserLanguage } from "../state.js";
import { sendTelegramMessage } from "../telegram.js";
import { beijingDateKey, beijingParts, formatBeijingTime } from "../utils.js";
import { summarizeSamsungSourceHealth } from "../monitor-observability.js";

export async function loadPerformanceSnapshot(env, hours = 24) {
  const [summary, budget] = await Promise.all([
    getSchedulerMetricsSummary(env, hours),
    getSchedulerBudgetStatus(env)
  ]);
  return {
    summary: summary?.ok ? summary : { ok: false, hours, errors: { unavailable: 1 } },
    budget: budget?.ok ? budget : { ok: false, config: {} }
  };
}

export async function loadDiagnosticsReport(env) {
  const scheduler = await getSchedulerDiagnostics(env);
  return {
    scheduler: scheduler?.ok ? scheduler : {
      initialized: false,
      targets: 0,
      overdue: [],
      failing: [],
      mirrorBacklog: 0,
      alarmSupported: false,
      error: scheduler?.error || "MonitorScheduler unavailable"
    },
    bindings: {
      monitorScheduler: Boolean(env.MONITOR_SCHEDULER),
      queryCoordinator: Boolean(env.FIRMWARE_QUERY_COORDINATOR),
      notificationQueue: Boolean(env.NOTIFICATION_QUEUE),
      kv: Boolean(env.FIRMWARE_KV)
    }
  };
}

export async function maybeSendDailyMonitorSummary(env, now = new Date()) {
  const adminId = adminChatId(env);
  if (!adminId) return { sent: false, reason: "unavailable" };
  const summarySettings = await getMonitorSummarySettings(env);
  if (!summarySettings.enabled) return { sent: false, reason: "disabled" };
  const date = now instanceof Date ? now : new Date(now);
  const parts = beijingParts(date);
  if (Number(parts.hour) !== summarySettings.hour || Number(parts.minute) !== 0) {
    return { sent: false, reason: "outside_summary_window" };
  }
  const dateKey = beijingDateKey(date);
  const claim = await claimSchedulerDailySummary(env, dateKey, date.getTime());
  if (!claim?.ok || !claim.claimed) return { sent: false, reason: claim?.reason || "unavailable" };

  let sent = false;
  try {
    const [snapshot, report, items, lang] = await Promise.all([
      loadPerformanceSnapshot(env, 24),
      loadDiagnosticsReport(env),
      getMonitorItems(env),
      getUserLanguage(env, adminId)
    ]);
    const runtimeByKey = new Map((report.scheduler?.failing || []).map((entry) => [`${entry.model}:${entry.csc}`, entry]));
    const sourceHealth = summarizeSamsungSourceHealth(items.map((item) => ({
      runtime: runtimeByKey.get(`${item.model}:${item.csc}`) || {}
    })), date.getTime());
    const summary = snapshot.summary || {};
    const en = lang === "en";
    const text = en ? [
      "📬 Daily monitor summary",
      "",
      `Time: ${formatBeijingTime(date, "en")}`,
      `Targets: ${items.length}`,
      `Checks / updates / failures: ${summary.monitorChecks || 0} / ${summary.monitorUpdates || 0} / ${summary.monitorFailures || 0}`,
      `Query success rate: ${(Number(summary.querySuccessRate || 0) * 100).toFixed(1)}%`,
      `Samsung source: ${sourceHealth.healthy} healthy, ${sourceHealth.retrying} retrying, ${sourceHealth.attention + sourceHealth.configuration} need attention`,
      `Current failing targets: ${(report.scheduler?.failing || []).length}`
    ] : [
      "📬 每日监控摘要",
      "",
      `时间：${formatBeijingTime(date, "zh")}`,
      `监控目标：${items.length}`,
      `检查 / 更新 / 失败：${summary.monitorChecks || 0} / ${summary.monitorUpdates || 0} / ${summary.monitorFailures || 0}`,
      `查询成功率：${(Number(summary.querySuccessRate || 0) * 100).toFixed(1)}%`,
      `三星源状态：正常 ${sourceHealth.healthy}，重试中 ${sourceHealth.retrying}，需关注 ${sourceHealth.attention + sourceHealth.configuration}`,
      `当前失败目标：${(report.scheduler?.failing || []).length}`
    ].join("\n");
    sent = Boolean(await sendTelegramMessage(env, adminId, text));
    return { sent, dateKey };
  } catch (error) {
    console.log(`Daily monitor summary failed: ${error.message}`);
    return { sent: false, reason: "send_failed" };
  } finally {
    await completeSchedulerDailySummary(env, dateKey, sent, Date.now()).catch((error) => {
      console.log(`Daily monitor summary state update failed: ${error.message}`);
    });
  }
}
