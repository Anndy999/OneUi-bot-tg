import {
  normalizeMonitorIntervalSettings,
  sharedMonitorIntervalMinutes
} from "../monitor-intervals.js";
import { formatBeijingTime } from "../utils.js";

export function monitorIntervalLabel(mode, lang = "zh") {
  const labels = {
    high: ["HIGH intensity", "HIGH 高强度"],
    normal: ["NORMAL intensity", "NORMAL 普通"],
    low: ["LOW intensity", "LOW 低强度"],
    idle: ["IDLE", "IDLE 休眠"],
    watch: ["WATCH release watch", "WATCH 发布信号观察"],
    hot: ["HOT update confirmation", "HOT 更新确认窗口"],
    cooldown: ["COOLDOWN", "COOLDOWN 降频观察"]
  };
  const pair = labels[mode] || [String(mode).toUpperCase(), String(mode).toUpperCase()];
  return lang === "en" ? pair[0] : pair[1];
}

export function monitorIntervalsPanel(settings, lang = "zh") {
  const normalized = normalizeMonitorIntervalSettings(settings);
  const shared = sharedMonitorIntervalMinutes(normalized);
  const en = lang === "en";
  return {
    text: [
      en ? "⏱ Monitoring interval" : "⏱ 监控间隔",
      "",
      en
        ? `Current default: ${shared === null ? "Adaptive legacy profile" : `${shared} min`}`
        : `当前默认：${shared === null ? "旧自适应策略" : `${shared} 分钟`}`,
      "",
      en ? "Set one interval for all default monitor checks:" : "管理员可统一设置所有默认监控设备的检查间隔：",
      "/moninterval 15",
      "",
      en
        ? "Range: 1-1440 minutes. Existing per-target overrides stay unchanged."
        : "范围：1-1440 分钟。已有的单设备独立间隔不会改变。"
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: en ? "Back to monitoring" : "返回监控中心", callback_data: "admin:monitor-menu" }],
        [{ text: en ? "Home" : "返回首页", callback_data: "menu:home" }]
      ]
    }
  };
}

export function monitorIntervalPresetPanel(mode, settings, lang = "zh") {
  const normalized = normalizeMonitorIntervalSettings(settings);
  const en = lang === "en";
  return {
    text: [
      `⏱ ${monitorIntervalLabel(mode, lang)}`,
      "",
      en ? `Current: ${normalized[mode]} minutes` : `当前：${normalized[mode]} 分钟`,
      en ? "Choose a preset, or use /interval <mode> <minutes>." : "请选择预设，或使用 /interval <强度> <分钟> 自定义。"
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [1, 3, 5].map((minutes) => ({ text: `${minutes} ${en ? "min" : "分钟"}`, callback_data: `admin:interval-set:${mode}:${minutes}` })),
        [10, 15, 30].map((minutes) => ({ text: `${minutes} ${en ? "min" : "分钟"}`, callback_data: `admin:interval-set:${mode}:${minutes}` })),
        [{ text: `60 ${en ? "min" : "分钟"}`, callback_data: `admin:interval-set:${mode}:60` }],
        [{ text: en ? "Back" : "返回", callback_data: "admin:intervals" }]
      ]
    }
  };
}

function percent(value) {
  return `${(Math.max(0, Number(value || 0)) * 100).toFixed(1)}%`;
}

export function performancePanel(summary = {}, budget = {}, lang = "zh") {
  const en = lang === "en";
  const config = budget.config || {};
  const lines = en ? [
    "📊 Performance center",
    "",
    `Window: last ${summary.hours || 24} hours`,
    `Queries: ${summary.queryCount || 0}`,
    `Success rate: ${percent(summary.querySuccessRate)}`,
    `Cache hit rate: ${percent(summary.cacheHitRate)}`,
    `Single-flight joins: ${percent(summary.singleFlightJoinRate)}`,
    "",
    `Latency P50/P95/P99: ${summary.totalMsP50 || 0} / ${summary.totalMsP95 || 0} / ${summary.totalMsP99 || 0} ms`,
    `SmartHistory P50/P95: ${summary.smartHistoryMsP50 || 0} / ${summary.smartHistoryMsP95 || 0} ms`,
    "",
    `Monitor checks/updates/failures: ${summary.monitorChecks || 0} / ${summary.monitorUpdates || 0} / ${summary.monitorFailures || 0}`,
    `Hourly budget: ${budget.used || 0}/${config.hourly || 0}`,
    `Monitor concurrency: ${budget.inFlight || 0}/${config.concurrent || 0}`,
    `Adaptive throttle: ×${Number(budget.adaptiveFactor || 1).toFixed(2)}`
  ] : [
    "📊 性能中心",
    "",
    `统计范围：最近 ${summary.hours || 24} 小时`,
    `查询次数：${summary.queryCount || 0}`,
    `成功率：${percent(summary.querySuccessRate)}`,
    `缓存命中率：${percent(summary.cacheHitRate)}`,
    `Single-flight 合并率：${percent(summary.singleFlightJoinRate)}`,
    "",
    `查询耗时 P50/P95/P99：${summary.totalMsP50 || 0} / ${summary.totalMsP95 || 0} / ${summary.totalMsP99 || 0} ms`,
    `SmartHistory P50/P95：${summary.smartHistoryMsP50 || 0} / ${summary.smartHistoryMsP95 || 0} ms`,
    "",
    `监控检查/更新/失败：${summary.monitorChecks || 0} / ${summary.monitorUpdates || 0} / ${summary.monitorFailures || 0}`,
    `本小时查询预算：${budget.used || 0}/${config.hourly || 0}`,
    `监控并发：${budget.inFlight || 0}/${config.concurrent || 0}`,
    `自适应限速：×${Number(budget.adaptiveFactor || 1).toFixed(2)}`
  ];
  const errors = Object.entries(summary.errors || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (errors.length) {
    lines.push("", en ? "Top errors:" : "主要错误：", ...errors.map(([name, count]) => `${name}: ${count}`));
  }
  return lines.join("\n");
}

export function diagnosticsPanel(report = {}, lang = "zh") {
  const en = lang === "en";
  const scheduler = report.scheduler || {};
  const bindings = report.bindings || {};
  const budget = scheduler.budget || {};
  const adaptiveFactor = Number(budget.adaptiveFactor || 1);
  const metrics = scheduler.metrics || {};
  const topErrors = Object.entries(metrics.errors || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 3);
  const lines = en ? [
    "🩺 Diagnostics",
    "",
    `Scheduler: ${scheduler.initialized ? "ready" : "not initialized"}`,
    `Targets: ${scheduler.targets || 0}`,
    `Overdue targets: ${(scheduler.overdue || []).length}`,
    `Failing targets: ${(scheduler.failing || []).length}`,
    `KV mirror backlog: ${scheduler.mirrorBacklog || 0}`,
    `Alarm support: ${scheduler.alarmSupported ? "yes" : "no"}`,
    `Adaptive limit: x${Number.isFinite(adaptiveFactor) ? adaptiveFactor.toFixed(2) : "1.00"}`,
    "",
    `Bindings: Scheduler ${bindings.monitorScheduler ? "OK" : "MISSING"}, Coordinator ${bindings.queryCoordinator ? "OK" : "MISSING"}, Queue ${bindings.notificationQueue ? "OK" : "MISSING"}, KV ${bindings.kv ? "OK" : "MISSING"}`
  ] : [
    "🩺 系统诊断",
    "",
    `调度器：${scheduler.initialized ? "已就绪" : "未初始化"}`,
    `监控目标：${scheduler.targets || 0}`, 
    `超时未执行：${(scheduler.overdue || []).length}`,
    `连续失败设备：${(scheduler.failing || []).length}`,
    `KV 镜像积压：${scheduler.mirrorBacklog || 0}`,
    `Alarm 支持：${scheduler.alarmSupported ? "正常" : "不可用"}`,
    `自适应限流：x${Number.isFinite(adaptiveFactor) ? adaptiveFactor.toFixed(2) : "1.00"}`,
    "",
    `绑定：Scheduler ${bindings.monitorScheduler ? "正常" : "缺失"}，Coordinator ${bindings.queryCoordinator ? "正常" : "缺失"}，Queue ${bindings.notificationQueue ? "正常" : "缺失"}，KV ${bindings.kv ? "正常" : "缺失"}`
  ];
  if (topErrors.length) {
    lines.push(
      "",
      en ? "Recent error classes:" : "最近错误类型：",
      ...topErrors.map(([name, count]) => `${name}: ${count}`)
    );
  }
  for (const item of (scheduler.failing || []).slice(0, 5)) {
    lines.push("", `⚠️ ${item.model}/${item.csc} · ${item.failureCount} · ${item.lastError || "unknown"}`);
  }
  for (const item of (scheduler.overdue || []).slice(0, 5)) {
    lines.push("", `⏰ ${item.model}/${item.csc} · ${Math.ceil(Number(item.overdueMs || 0) / 60000)} ${en ? "min overdue" : "分钟超时"}`);
  }
  return lines.join("\n");
}

function monitorEventTitle(event, lang) {
  const en = lang === "en";
  const titles = en ? {
    update_detected: "📦 Update detected",
    monitor_failed: "⚠️ Samsung source retry",
    recovered: "✅ Monitoring recovered",
    notification_delivered: "📨 Telegram delivered"
  } : {
    update_detected: "📦 发现新版本",
    monitor_failed: "⚠️ 三星源重试",
    recovered: "✅ 监控已恢复",
    notification_delivered: "📨 Telegram 已送达"
  };
  return titles[event?.type] || (en ? "• Monitor event" : "• 监控事件");
}

export function monitorEventsPanel(events = [], lang = "zh") {
  const en = lang === "en";
  const lines = [en ? "🗂 Recent monitoring events" : "🗂 最近监控事件"];
  if (!events.length) {
    lines.push("", en ? "No important monitoring events yet." : "暂时没有重要监控事件。");
  }
  for (const event of events.slice(0, 20)) {
    const target = event.model && event.csc
      ? `${event.name || event.model} · ${event.model}/${event.csc}`
      : (event.name || "");
    lines.push(
      "",
      monitorEventTitle(event, lang),
      target,
      formatBeijingTime(new Date(event.at), lang)
    );
    if (event.detail) lines.push(event.detail);
    if (event.error) lines.push(`${en ? "Reason" : "原因"}: ${event.error}`);
    if (Number(event.failureCount || 0) > 0) {
      lines.push(`${en ? "Consecutive failures" : "连续失败"}: ${event.failureCount}`);
    }
    if (event.retryAt) {
      lines.push(`${en ? "Retry after" : "下次重试"}: ${formatBeijingTime(new Date(event.retryAt), lang)}`);
    }
    if (event.audience) {
      lines.push(`${en ? "Recipient" : "接收对象"}: ${event.audience === "owner" ? (en ? "Owner" : "管理员") : (en ? "Allowed user" : "授权用户")}`);
    }
  }
  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: en ? "Refresh" : "刷新", callback_data: "admin:monitor-events" }],
        [{ text: en ? "Back to monitoring" : "返回监控中心", callback_data: "admin:monitor-menu" }],
        [{ text: en ? "Home" : "返回主菜单", callback_data: "menu:home" }]
      ]
    }
  };
}
