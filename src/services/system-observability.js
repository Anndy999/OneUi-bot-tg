import { adminChatId } from "../config.js";
import { diagnosticsPanel } from "../messages/admin-messages.js";
import {
  getSchedulerBudgetStatus,
  getSchedulerControlState,
  getSchedulerDiagnostics,
  getSchedulerMetricsSummary,
  putSchedulerControlState,
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

function envNumber(env, key, fallback, min, max) {
  const value = Number(env?.[key] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function diagnosticsMinFailureCount(env) {
  return Math.floor(envNumber(env, "DIAGNOSTICS_ALERT_MIN_FAILURE_COUNT", 3, 1, 20));
}

function diagnosticsAdaptiveAlertFactor(env) {
  return envNumber(env, "DIAGNOSTICS_ALERT_ADAPTIVE_FACTOR", 4, 2, 16);
}

function formatAlertReason(reason) {
  if (reason.startsWith("overdue:")) return `超时未执行设备：${reason.split(":")[1]}`;
  if (reason === "repeated_failures") return "监控设备连续失败达到阈值";
  if (reason.startsWith("mirror_backlog:")) return `KV 镜像积压：${reason.split(":")[1]}`;
  if (reason.startsWith("adaptive:")) return `自适应限流升高：x${reason.split(":")[1]}`;
  if (reason === "binding_missing") return "Cloudflare 绑定缺失";
  return reason;
}

export function diagnosticsAlertReasons(report, env = {}) {
  const scheduler = report.scheduler || {};
  const bindings = report.bindings || {};
  const reasons = [];
  const minFailures = diagnosticsMinFailureCount(env);
  const adaptiveThreshold = diagnosticsAdaptiveAlertFactor(env);
  const adaptiveFactor = Number(scheduler.budget?.adaptiveFactor || 1);
  if ((scheduler.overdue || []).length) reasons.push(`overdue:${scheduler.overdue.length}`);
  if ((scheduler.failing || []).some((item) => Number(item.failureCount || 0) >= minFailures)) reasons.push("repeated_failures");
  if (Number(scheduler.mirrorBacklog || 0) > 0) reasons.push(`mirror_backlog:${scheduler.mirrorBacklog}`);
  if (adaptiveFactor >= adaptiveThreshold) reasons.push(`adaptive:${adaptiveFactor.toFixed(2)}`);
  if (!bindings.monitorScheduler || !bindings.queryCoordinator || !bindings.notificationQueue) reasons.push("binding_missing");
  return reasons;
}

export async function maybeSendDiagnosticsAlert(env, now = Date.now()) {
  const chatId = adminChatId(env);
  if (!chatId || !env.MONITOR_SCHEDULER) return { sent: false, reason: "unavailable" };
  const report = await loadDiagnosticsReport(env);
  const reasons = diagnosticsAlertReasons(report, env);
  if (!reasons.length) return { sent: false, reason: "healthy" };

  const signature = reasons.join("|");
  const previous = await getSchedulerControlState(env, "diagnostics:last-alert");
  const previousAt = Number(previous?.value?.sentAt || 0);
  if (previous?.found && previous.value?.signature === signature && now - previousAt < 60 * 60 * 1000) {
    return { sent: false, reason: "deduped" };
  }

  const sent = await sendTelegramMessage(
    env,
    chatId,
    `⚠️ 自动监控异常提醒\n\n触发原因：\n${reasons.map((reason) => `- ${formatAlertReason(reason)}`).join("\n")}\n\n${diagnosticsPanel(report, "zh")}`
  );
  if (sent) {
    await putSchedulerControlState(env, "diagnostics:last-alert", { signature, reasons, sentAt: now });
  }
  return { sent, reasons };
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
