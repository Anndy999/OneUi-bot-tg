import {
  adminChatId,
  defaultCsc,
  firmwareCacheFreshSeconds,
  firmwareCacheStaleSeconds,
  l1CacheTtlSeconds,
  negativeCacheTtlSeconds,
  queryRateLimitSeconds,
  reminderIntervalMinutes,
  queryStaleWhileRevalidateSeconds,
  telegramQueryPlaceholderEnabled,
  unauthorizedMode,
  verifySecret
} from "./config.js";
import { adminHelpParts, guideText } from "./guides.js";
import { formatSchedule, processMonitorQueueMessage, runMonitor, runScheduledTasks } from "./monitor.js";
import { coordinatedFirmwareQuery } from "./firmware-query-coordinator.js";
import { applyFlagshipProposalDecision } from "./flagship-priority.js";
import {
  addRolloutTarget,
  applyRolloutProposalDecision,
  getRolloutChains,
  restartDependentRolloutChain,
  rolloutChainPanelText,
  setRolloutChainSettings,
  setRolloutChainStage
} from "./rollout-chain.js";
import { querySmartHistory, resolveOfficialFirmwareVersion } from "./fus.js";
import {
  cancelFirmwareDownload,
  createFirmwareDownload,
  deleteFirmwareDownload,
  getFirmwareDownload,
  listFirmwareDownloads,
  pauseFirmwareDownload,
  previewFirmwareDownload,
  resumeFirmwareDownload
} from "./vps/download-client.js";
import { logQueryMetric } from "./metrics.js";
import {
  diagnosticsPanel,
  monitorIntervalPresetPanel,
  monitorIntervalsPanel,
  monitorEventsPanel,
  performancePanel
} from "./messages/admin-messages.js";
import { loadDiagnosticsReport, loadPerformanceSnapshot, maybeSendDiagnosticsAlert } from "./services/system-observability.js";
import { firmwareInputHelp, parseFirmwareInput } from "./firmware-input-parser.js";
import {
  cacheOfficialCscSuggestions,
  formatCscOptionLabel,
  getCachedOfficialCscSuggestions,
  rankOfficialCscOptions
} from "./csc-suggestions.js";
import { priorityIntervalMinutes } from "./monitor-intelligence.js";
import {
  DEFAULT_MONITOR_INTERVALS,
  normalizeMonitorIntervalMode,
  sharedMonitorIntervalMinutes,
  uniformMonitorIntervalSettings
} from "./monitor-intervals.js";
import {
  claimTelegramUpdate,
  getMonitorIntervalSettings,
  setMonitorIntervalSettings
} from "./monitor-scheduler.js";
import { processNotificationQueue } from "./notification-queue.js";
import {
  answerCallbackQuery,
  chatIdFromUpdate,
  replyTargetFromMessage,
  safeEditOrSend,
  sendTelegramMessage,
  sendTelegramMessageResult,
  textFromUpdate
} from "./telegram.js";
import {
  addAllowedUser,
  addAdditionalAdmin,
  beginDeleteAllMonitorConfirmation,
  clearDeleteAllMonitorConfirmation,
  deleteAllPendingUpdates,
  deleteFirmwareQueryCache,
  deleteGlobalQueryCache,
  deletePendingUpdate,
  deleteUserQueryCache,
  cancelMonitorItemSnooze,
  clearQueryCachePrefix,
  getAccessRequests,
  getAccessSettings,
  getAllowedUsers,
  getAdminChatIds,
  getAdditionalAdmins,
  getCacheSettings,
  getDeleteAllMonitorConfirmation,
  getFirmwareQueryCache,
  getIdentity,
  getMonitorItems,
  getMonitorEvents,
  getMonitorRuntime,
  getMonitorSchedule,
  getMonitorSummarySettings,
  getPendingUpdate,
  getUserDevices,
  getUserLanguage,
  hasCompletedOnboarding,
  identityLabel,
  isOwnerChatId,
  isAuthorizedForQuery,
  listPendingUpdates,
  removeAllowedUser,
  removeAdditionalAdmin,
  removeAccessRequest,
  removeMonitorItem,
  removeUserDevice,
  restoreMonitorOriginalPlan,
  putAckedUpdate,
  recordFirmwareQueryDemand,
  forceMonitorDue,
  setMonitorSchedule,
  setMonitorSummarySettings,
  setMonitorItems,
  setAccessAutoApprove,
  setCacheSettings,
  setFirmwareQueryCache,
  setUserLanguage,
  setUserDeviceNotification,
  snoozeMonitorItem,
  tryClaimAllowedUserDailyModelQuery,
  tryStartQueryRateLimit,
  upsertUserDevice,
  markOnboardingCompleted,
  upsertAccessRequest,
  upsertMonitorItem
} from "./state.js";
import { kvGetJson, kvPutJson } from "./state.js";
import {
  classifySamsungSourceHealth,
  formatSamsungSourceHealth,
  summarizeSamsungSourceHealth
} from "./monitor-observability.js";
import {
  clearFirmwareMemoryCaches,
  deleteFirmwareMemoryCache,
  deleteL1Firmware,
  getFirmwareMemoryCache,
  getL1Firmware,
  getNegativeFirmware,
  markFirmwareTargetHot,
  setL1Firmware,
  setFirmwareMemoryCache,
  setNegativeFirmware,
  singleFlightFirmware
} from "./cache.js";
import { buildFirmwareCacheRecord, isExactSmartHistory } from "./firmware-cache.js";
import {
  beijingDateKey,
  formatBeijingTime,
  formatFirmwareResult,
  formatQueryFailure,
  firmwareVersionFingerprint,
  jsonResponse,
  knownFirmwareCscCorrection,
  normalizeClockTime,
  normalizeFirmwareVersion,
  parseModelQuery,
  textResponse,
  timeToMinutes,
  unauthorizedQueryText
} from "./utils.js";

export { MonitorScheduler } from "./monitor-scheduler.js";
export { FirmwareQueryCoordinator } from "./firmware-query-coordinator.js";

const APP_VERSION = "2.17.5";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/") {
      return textResponse(`OneUI Firmware Worker ${APP_VERSION} OK`);
    }

    if (request.method === "GET" && path === "/health") {
      let telegramCommandsSynced = false;
      try {
        telegramCommandsSynced = env.FIRMWARE_KV
          ? Boolean(await env.FIRMWARE_KV.get(telegramCommandsSyncKey()))
          : false;
      } catch {
        telegramCommandsSynced = false;
      }
      return jsonResponse({
        ok: true,
        service: "oneui-firmware-worker",
        version: APP_VERSION,
        time: formatBeijingTime(new Date()),
        features: {
          monitorScheduler: Boolean(env.MONITOR_SCHEDULER),
          queryCoordinator: Boolean(env.FIRMWARE_QUERY_COORDINATOR),
          notificationQueue: Boolean(env.NOTIFICATION_QUEUE),
          flagshipPriorityLifecycle: String(env.FLAGSHIP_LINKAGE_ENABLED ?? "true").toLowerCase() !== "false",
          telegramCommandsSynced
        }
      });
    }

    if (request.method === "GET" && path === "/migration/export") {
      const supplied = request.headers.get("X-OneUI-Migration-Secret") || "";
      if (!verifyMigrationExportSecret(env, supplied)) return textResponse("Forbidden", 403);
      if (!env.MONITOR_SCHEDULER) return jsonResponse({ ok: false, error: "MONITOR_SCHEDULER is not configured" }, 503);
      const id = env.MONITOR_SCHEDULER.idFromName("global");
      const stub = env.MONITOR_SCHEDULER.get(id);
      return stub.fetch("https://monitor-scheduler/migration/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
    }

    if (request.method === "POST" && path === "/telegram") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!verifySecret(env, secret)) return textResponse("Forbidden", 403);
      return handleTelegramWebhook(request, env, url.origin, ctx);
    }

    // One-release compatibility path. New deployments use Telegram's secret
    // header and never place WEBHOOK_SECRET in the URL.
    const telegramMatch = path.match(/^\/telegram\/([^/]+)$/);
    if (request.method === "POST" && telegramMatch) {
      if (!verifySecret(env, telegramMatch[1])) return textResponse("Forbidden", 403);
      return handleTelegramWebhook(request, env, url.origin, ctx);
    }

    const checkMatch = path.match(/^\/check\/([^/]+)$/);
    if (request.method === "GET" && checkMatch) {
      if (!verifySecret(env, checkMatch[1])) return textResponse("Forbidden", 403);
      const summary = await runMonitor(env, { reason: "manual_http" });
      return jsonResponse(summary);
    }

    const webhookInfoMatch = path.match(/^\/webhook_info\/([^/]+)$/);
    if (request.method === "GET" && webhookInfoMatch) {
      if (!verifySecret(env, webhookInfoMatch[1])) return textResponse("Forbidden", 403);
      return jsonResponse(await getTelegramWebhookInfo(env));
    }

    const fixButtonsMatch = path.match(/^\/fix_buttons\/([^/]+)$/);
    if (request.method === "GET" && fixButtonsMatch) {
      const secret = fixButtonsMatch[1];
      if (!verifySecret(env, secret)) return textResponse("Forbidden", 403);
      return jsonResponse(await fixTelegramButtonsWebhook(env, url.origin, secret));
    }

    return textResponse("Not Found", 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      runScheduledTasks(env),
      ensureTelegramCommands(env).catch((error) => {
        console.log(`Telegram command sync failed: ${error.message}`);
      }),
      maybeSendDiagnosticsAlert(env).catch((error) => {
        console.log(`Diagnostics alert failed: ${error.message}`);
      })
    ]));
  },

  async queue(batch, env, ctx) {
    ctx.waitUntil(processWorkerQueue(batch, env));
  }
};

async function processWorkerQueue(batch, env) {
  const notifications = [];
  for (const message of batch.messages || []) {
    if (message.body?.kind !== "monitor_check") {
      notifications.push(message);
      continue;
    }
    try {
      await processMonitorQueueMessage(env, message.body);
      message.ack();
    } catch (error) {
      console.log(`Sub-minute monitor queue task failed: ${error.message}`);
      message.retry({ delaySeconds: 15 });
    }
  }
  if (notifications.length) await processNotificationQueue({ messages: notifications }, env);
}

async function telegramBotApi(env, method, payload = null) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured" };
  const init = payload
    ? {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000)
      }
    : { method: "GET", signal: AbortSignal.timeout(5000) };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, init);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && data.ok !== false, status: response.status, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const PUBLIC_TELEGRAM_COMMANDS = [
  { command: "start", description: "打开主菜单" },
  { command: "devices", description: "我的设备" },
  { command: "status", description: "服务状态" },
  { command: "language", description: "切换中英文" },
  { command: "help", description: "使用说明" },
  { command: "apply", description: "申请查询权限" },
  { command: "whoami", description: "查看我的 Chat ID" }
];

const ADMIN_TELEGRAM_COMMANDS = [
  { command: "download", description: "official firmware download" },
  ...PUBLIC_TELEGRAM_COMMANDS,
  { command: "admin", description: "管理员面板" },
  { command: "chain", description: "发布链" },
  { command: "checknow", description: "立即检查" },
  { command: "moninterval", description: "监控间隔" },
  { command: "monsnooze", description: "暂停监控" },
  { command: "adminhelp", description: "管理员命令" }
];

async function syncTelegramCommands(env) {
  // Clear inherited scopes first; Telegram otherwise may prefer an old
  // private-chat command menu over the current default menu.
  const scopes = [
    { type: "default" },
    { type: "all_private_chats" },
    { type: "all_group_chats" },
    { type: "all_chat_administrators" }
  ];
  for (const scope of scopes) {
    const cleared = await telegramBotApi(env, "deleteMyCommands", { scope });
    if (!cleared.ok) return cleared;
  }
  const publicResult = await telegramBotApi(env, "setMyCommands", { commands: PUBLIC_TELEGRAM_COMMANDS });
  if (!publicResult.ok) return publicResult;
  for (const chatId of await getAdminChatIds(env)) {
    const result = await telegramBotApi(env, "setMyCommands", {
      scope: { type: "chat", chat_id: chatId },
      commands: ADMIN_TELEGRAM_COMMANDS
    });
    if (!result.ok) return result;
  }
  return publicResult;
}

async function clearTelegramCommandsForChat(env, chatId) {
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) return;
  await telegramBotApi(env, "deleteMyCommands", {
    scope: { type: "chat", chat_id: String(chatId) }
  });
}

function telegramCommandsSyncKey() {
  return `telegram:commands:${APP_VERSION}`;
}

async function ensureTelegramCommands(env) {
  if (String(env.TELEGRAM_COMMAND_SYNC_ENABLED ?? "true").toLowerCase() === "false") return false;
  if (!env.FIRMWARE_KV || !env.TELEGRAM_BOT_TOKEN) return false;
  const key = telegramCommandsSyncKey();
  if (await env.FIRMWARE_KV.get(key)) return true;
  const result = await syncTelegramCommands(env);
  if (!result.ok) throw new Error(result.error || result.data?.description || "unknown error");
  await env.FIRMWARE_KV.put(key, new Date().toISOString());
  return true;
}

function redactWebhookUrl(value) {
  const url = String(value || "");
  return url.replace(/\/telegram\/[^/?#]+/i, "/telegram/{legacy-secret}");
}

function verifyMigrationExportSecret(env, supplied) {
  const expected = String(env.MIGRATION_EXPORT_SECRET || "");
  return Boolean(expected) && String(supplied || "") === expected;
}

async function getTelegramWebhookInfo(env) {
  const response = await telegramBotApi(env, "getWebhookInfo");
  const result = response.data?.result || {};
  return {
    ok: response.ok,
    status: response.status || null,
    url: redactWebhookUrl(result.url || ""),
    allowed_updates: result.allowed_updates || [],
    pending_update_count: result.pending_update_count || 0,
    last_error_date: result.last_error_date || null,
    last_error_message: result.last_error_message || "",
    callback_query_enabled: Array.isArray(result.allowed_updates) && result.allowed_updates.includes("callback_query"),
    note: "If callback_query_enabled is false, Telegram inline buttons will not reach the Worker."
  };
}

async function fixTelegramButtonsWebhook(env, origin, secret) {
  const webhookUrl = `${origin}/telegram`;
  const response = await telegramBotApi(env, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "edited_message", "callback_query"]
  });
  const info = await getTelegramWebhookInfo(env);
  return {
    ok: response.ok,
    status: response.status || null,
    webhook_url: redactWebhookUrl(webhookUrl),
    allowed_updates: info.allowed_updates,
    callback_query_enabled: info.callback_query_enabled,
    message: info.callback_query_enabled
      ? "Buttons have been enabled. Secret is hidden for safety."
      : "Webhook was updated, but callback_query is still not visible in getWebhookInfo."
  };
}

async function ensureButtonsWebhook(env, origin) {
  if (String(env.TELEGRAM_WEBHOOK_AUTOFIX_ENABLED ?? "true").toLowerCase() === "false") return false;
  if (!env.FIRMWARE_KV || !env.WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) return false;
  const key = "webhook:self_heal:callback_query";
  const existing = await env.FIRMWARE_KV.get(key);
  if (existing) return true;
  const response = await fixTelegramButtonsWebhook(env, origin, env.WEBHOOK_SECRET);
  await env.FIRMWARE_KV.put(key, response.callback_query_enabled ? "ok" : "failed", {
    expirationTtl: response.callback_query_enabled ? 3600 : 60
  });
  return Boolean(response.callback_query_enabled);
}

export async function handleTelegramWebhook(request, env, origin = "", ctx = null) {
  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const dedupeId = update.update_id ?? update.callback_query?.id ?? "";
  let claim = await claimTelegramUpdate(env, dedupeId);
  if (!claim && env.FIRMWARE_KV && String(dedupeId).trim()) {
    const key = `telegram:update:${dedupeId}`;
    const existing = await env.FIRMWARE_KV.get(key);
    claim = { duplicate: Boolean(existing) };
    if (!existing) await env.FIRMWARE_KV.put(key, "1", { expirationTtl: 6 * 60 * 60 });
  }
  if (claim?.duplicate) return jsonResponse({ ok: true, accepted: false, duplicate: true });

  // Telegram retries webhooks when the HTTP response is slow. Keep command and
  // callback work alive through waitUntil after a strongly serialized dedupe.
  if (env.TELEGRAM_UPDATE_QUEUE?.send) {
    await env.TELEGRAM_UPDATE_QUEUE.send({ schemaVersion: 1, kind: "telegram_update", update, createdAt: new Date().toISOString() });
    return jsonResponse({ ok: true, accepted: true, queued: true });
  }
  runBackground(ctx, processTelegramUpdate(update, env, origin, ctx));
  return jsonResponse({ ok: true, accepted: true });
}

export async function processTelegramUpdate(update, env, origin = "", ctx = null) {
  if (update.callback_query) {
    try {
      await handleCallback(update.callback_query, env, ctx);
    } catch (error) {
      await reportCallbackFailure(update.callback_query, env, error);
    }
    return jsonResponse({ ok: true });
  }

  const chatId = chatIdFromUpdate(update);
  const text = textFromUpdate(update).trim();
  if (!chatId || !text) return jsonResponse({ ok: true, ignored: true });

  const message = update.message || update.edited_message || {};
  const identity = await getIdentity(env, chatId);

  if (await handlePendingDeleteAllConfirmation(env, chatId, identity, text)) {
    return jsonResponse({ ok: true, deleted: true });
  }

  if (/^\/(?:start|help|language|lang)(?:@\w+)?(?:\s|$)/i.test(text)) {
    runBackground(ctx, Promise.all([
      ensureButtonsWebhook(env, origin).catch((error) => {
        console.log(`webhook self-heal failed: ${error.message}`);
      }),
      ensureTelegramCommands(env).catch((error) => {
        console.log(`Telegram command sync failed: ${error.message}`);
      }),
      maybeSendDiagnosticsAlert(env).catch((error) => {
        console.log(`Diagnostics alert failed: ${error.message}`);
      })
    ]));
  }

  if (text === "🇨🇳 中文使用教程" || text === "中文使用教程") {
    await setUserLanguage(env, chatId, "zh");
    await sendTelegramMessage(env, chatId, guideText(identity, "zh"), removeKeyboard());
    return jsonResponse({ ok: true });
  }

  if (text === "🇺🇸 English Guide" || text === "English Guide") {
    await setUserLanguage(env, chatId, "en");
    await sendTelegramMessage(env, chatId, guideText(identity, "en"), removeKeyboard());
    return jsonResponse({ ok: true });
  }

  if (text === "🇨🇳 中文模式" || text === "中文模式") {
    await setUserLanguage(env, chatId, "zh");
    await sendTelegramMessage(env, chatId, "✅ 已切换为中文模式。", removeKeyboard());
    return jsonResponse({ ok: true });
  }

  if (text === "🇺🇸 English Mode" || text === "English Mode") {
    await setUserLanguage(env, chatId, "en");
    await sendTelegramMessage(env, chatId, "✅ Switched to English mode.", removeKeyboard());
    return jsonResponse({ ok: true });
  }

  if (text === "📝 申请白名单权限" || text === "申请白名单权限") {
    await handleAccessApply(env, chatId, message, identity);
    return jsonResponse({ ok: true });
  }

  const accessDecision = parseAccessDecisionText(text);
  if (accessDecision && identity === "admin") {
    if (accessDecision.action === "approve") await approveRequestById(env, chatId, accessDecision.targetId);
    else await rejectRequestById(env, chatId, accessDecision.targetId);
    return jsonResponse({ ok: true });
  }

  if (identity === "admin" && await handleAdminDownloadText(env, chatId, text, ctx)) {
    return jsonResponse({ ok: true });
  }

  if (identity === "admin" && await handleAdminMenuText(env, chatId, text)) {
    return jsonResponse({ ok: true });
  }

  if (text.startsWith("/")) {
    await handleCommand(env, chatId, text, message, identity, ctx);
    return jsonResponse({ ok: true });
  }

  const input = parseFirmwareInput(text, defaultCsc(env));
  if (!input.matched) {
    const lang = await getUserLanguage(env, chatId);
    if (identity !== "admin" && identity !== "allowed") {
      if (unauthorizedMode(env) === "reply") {
        await sendTelegramMessage(env, chatId, unauthorizedQueryText(lang));
      }
    } else {
      await sendTelegramMessage(env, chatId, firmwareInputHelp(lang, input.reason, input));
    }
    return jsonResponse({ ok: true, rejected: input.reason });
  }

  if (identity !== "admin" && identity !== "allowed") {
    if (unauthorizedMode(env) === "reply") {
      await sendTelegramMessage(env, chatId, unauthorizedQueryText(await getUserLanguage(env, chatId)));
    }
    return jsonResponse({ ok: true });
  }

  const queryLang = await getUserLanguage(env, chatId);
  if (!await enforceInteractiveQueryLimits(env, chatId, identity, input.model, queryLang)) {
    return jsonResponse({ ok: true, limited: true });
  }

  runBackground(ctx, handleManualQuery(env, chatId, `${input.model} ${input.csc}`, {
    identity,
    ctx,
    query: { model: input.model, csc: input.csc }
  }));
  return jsonResponse({ ok: true, processing: true });
}

async function handlePendingDeleteAllConfirmation(env, chatId, identity, text) {
  if (identity !== "admin") return false;
  const confirmation = await getDeleteAllMonitorConfirmation(env, chatId);
  if (!confirmation) return false;

  const confirmed = text === "\u5220\u9664\u5168\u90e8" || text.toUpperCase() === "DELETE ALL";
  if (!confirmed) {
    // A model query or normal command cancels this one-shot confirmation, then
    // continues through the usual message flow instead of being blocked.
    await clearDeleteAllMonitorConfirmation(env, chatId);
    return false;
  }

  const [allItems, lang] = await Promise.all([
    getMonitorItems(env),
    getUserLanguage(env, chatId)
  ]);
  const items = standardMonitorItems(allItems);
  await setMonitorItems(env, allItems.filter(isRolloutManagedMonitor));
  await clearDeleteAllMonitorConfirmation(env, chatId);
  const panel = await formatMonitorCenterPanel(env, lang);
  const summary = lang === "en"
    ? `\u2705 Regular monitoring targets deleted\n\nDeleted: ${items.length}`
    : `\u2705 \u5df2\u5220\u9664\u6240\u6709\u666e\u901a\u76d1\u63a7\u8bbe\u5907\n\n\u5220\u9664\u6570\u91cf\uff1a${items.length}`;
  await sendTelegramMessage(env, chatId, `${summary}\n\n${panel.text}`, panel.replyMarkup);
  return true;
}

async function enforceInteractiveQueryLimits(env, chatId, identity, model, lang = "zh", messageId = null) {
  const reply = async (text) => {
    if (messageId) return safeEditOrSend(env, chatId, messageId, text);
    return sendTelegramMessage(env, chatId, text);
  };

  const allowedByRateLimit = await tryStartQueryRateLimit(env, chatId);
  if (!allowedByRateLimit) {
    const seconds = queryRateLimitSeconds(env);
    await reply(lang === "en"
      ? `Querying too frequently. Please try again after ${seconds} seconds.`
      : `查询太频繁，请 ${seconds} 秒后再试`);
    return false;
  }

  if (identity !== "allowed") return true;
  const quota = await tryClaimAllowedUserDailyModelQuery(
    env,
    chatId,
    model,
    beijingDateKey(new Date())
  );
  if (quota?.allowed !== false) return true;
  await reply(lang === "en"
    ? [
        "⚠️ Daily query limit reached",
        "",
        `Model: ${model}`,
        `Today: ${quota.count || quota.limit}/${quota.limit}`,
        "",
        "The same model shares one daily counter across all CSCs.",
        "Please try again after 00:00 Beijing time."
      ].join("\n")
    : [
        "⚠️ 今日查询次数已达上限",
        "",
        `机型：${model}`,
        `今日次数：${quota.count || quota.limit}/${quota.limit}`,
        "",
        "同一型号的不同 CSC 共用每日次数。",
        "请在北京时间次日 00:00 后再试。"
      ].join("\n"));
  return false;
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

function languageModeKeyboard(identity = "unauthorized", lang = "zh") {
  return {
    inline_keyboard: [
      [
        { text: "🇨🇳 中文模式", callback_data: "lang:zh" },
        { text: "🇺🇸 English Mode", callback_data: "lang:en" }
      ],
      [{
        text: lang === "en" ? (identity === "admin" ? "Back to admin panel" : "Back to main menu") : (identity === "admin" ? "返回管理员面板" : "返回主菜单"),
        callback_data: "menu:home"
      }]
    ]
  };
}

async function mainMenuText(env, identity, lang = "zh") {
  if (lang === "en") {
    if (identity === "admin") {
      const [items, requests, chains] = await Promise.all([getMonitorItems(env), getAccessRequests(env), getRolloutChains(env)]);
      const regular = standardMonitorItems(items);
      const paused = regular.filter((item) => item.enabled === false).length;
      const s26 = chains.chains.find((chain) => chain.id === "s26");
      const s25 = chains.chains.find((chain) => chain.id === "s25");
      return [
        "Admin",
        `Monitoring: ${regular.length} · paused ${paused}`,
        `Rollout: S26 ${rolloutMenuStatus(s26, chains.chains, lang)} · S25 ${rolloutMenuStatus(s25, chains.chains, lang)}`,
        `Pending access: ${requests.length}`
      ].join("\n");
    }
    if (identity === "allowed") return "Samsung Firmware\n\nSend Model + CSC, for example: SM-S948B EUX.";
    return "Samsung Firmware\n\nRequest access to query firmware.";
  }
  if (identity === "admin") {
    const [items, requests, chains] = await Promise.all([getMonitorItems(env), getAccessRequests(env), getRolloutChains(env)]);
    const regular = standardMonitorItems(items);
    const paused = regular.filter((item) => item.enabled === false).length;
    const s26 = chains.chains.find((chain) => chain.id === "s26");
    const s25 = chains.chains.find((chain) => chain.id === "s25");
    return [
      "管理员",
      `监控：${regular.length} 个 · 暂停 ${paused}`,
      `发布链：S26 ${rolloutMenuStatus(s26, chains.chains, lang)} · S25 ${rolloutMenuStatus(s25, chains.chains, lang)}`,
      `待审批：${requests.length}`
    ].join("\n");
  }
  if (identity === "allowed") return "Samsung \u56fa\u4ef6\u67e5\u8be2\n\n\u53d1\u9001\u201c\u578b\u53f7 CSC\u201d\u5373\u53ef\u67e5\u8be2\u3002\n\u4f8b\u5982\uff1aSM-S948B EUX";
  return "Samsung \u56fa\u4ef6\u67e5\u8be2\n\n\u7533\u8bf7\u6743\u9650\u540e\u5373\u53ef\u67e5\u8be2\u56fa\u4ef6\u3002";
}

function mainMenuKeyboard(identity, lang = "zh") {
  const en = lang === "en";
  if (identity === "admin") {
    return { inline_keyboard: [
      [{ text: en ? "Monitoring" : "\ud83d\udce1 监控", callback_data: "admin:monitor-menu" }, { text: en ? "Rollout" : "\ud83d\udce3 发布链", callback_data: "admin:rollout-menu" }],
      [{ text: en ? "Users" : "\ud83d\udc65 用户", callback_data: "admin:access-menu" }, { text: en ? "Admins" : "\ud83d\udc51 管理员", callback_data: "admin:admins" }],
      [{ text: en ? "Downloads" : "📦 下载", callback_data: "admin:download-menu" }, { text: en ? "More" : "更多", callback_data: "menu:more" }]
    ] };
  }
  if (identity === "allowed") {
    return { inline_keyboard: [
      [{ text: en ? "Query firmware" : "\ud83d\udd0d \u67e5\u8be2\u56fa\u4ef6", callback_data: "menu:query-help" }, { text: en ? "My Devices" : "\ud83d\udcf1 \u6211\u7684\u8bbe\u5907", callback_data: "device:list" }],
      [{ text: en ? "Settings" : "\u2699\ufe0f \u8bbe\u7f6e", callback_data: "menu:settings" }, { text: en ? "Help" : "\u2753 \u5e2e\u52a9", callback_data: "menu:help" }]
    ] };
  }
  return { inline_keyboard: [
    [{ text: en ? "Request access" : "\ud83d\udd10 \u7533\u8bf7\u6743\u9650", callback_data: "user:apply" }],
    [{ text: en ? "Settings" : "\u2699\ufe0f \u8bbe\u7f6e", callback_data: "menu:settings" }, { text: en ? "Help" : "\u2753 \u5e2e\u52a9", callback_data: "menu:help" }]
  ] };
}

function adminMoreKeyboard(lang = "zh") {
  const en = lang === "en";
  return { inline_keyboard: [
    [{ text: en ? "System" : "系统", callback_data: "admin:system-menu" }, { text: en ? "Help" : "帮助", callback_data: "menu:help" }],
    [{ text: en ? "Commands" : "命令", callback_data: "admin:help" }],
    [{ text: en ? "Language" : "语言", callback_data: "menu:language" }],
    [{ text: en ? "Back" : "返回", callback_data: "menu:home" }]
  ] };
}

const ADMIN_DOWNLOAD_SESSION_TTL_SECONDS = 10 * 60;

function adminDownloadSessionKey(chatId) {
  return `admin:download-session:${String(chatId || "")}`;
}

async function beginAdminDownloadInput(env, chatId) {
  await kvPutJson(env, adminDownloadSessionKey(chatId), {
    createdAt: new Date().toISOString(),
    action: "input"
  }, { expirationTtl: ADMIN_DOWNLOAD_SESSION_TTL_SECONDS });
}

async function clearAdminDownloadInput(env, chatId) {
  if (!env.FIRMWARE_KV?.delete) return;
  await env.FIRMWARE_KV.delete(adminDownloadSessionKey(chatId));
}

async function hasAdminDownloadInput(env, chatId) {
  return Boolean(await kvGetJson(env, adminDownloadSessionKey(chatId), null));
}

function legacyFormatDownloadJob(job, lang = "zh") {
  if (!job) return lang === "en" ? "No firmware download jobs." : "暂无固件下载任务。";
  const stateLabels = lang === "en"
    ? { queued: "queued", downloading: "downloading", completed: "completed", failed: "failed", cancelled: "cancelled" }
    : { queued: "排队中", downloading: "下载中", completed: "已完成", failed: "失败", cancelled: "已取消" };
  const progress = job.totalBytes
    ? `${job.percent ?? 0}% (${job.bytes || 0}/${job.totalBytes})`
    : `${job.percent ?? 0}%`;
  const lines = [
    `${job.model || "?"} ${job.csc || "?"}`,
    `版本：${job.version || "?"}`,
    `状态：${stateLabels[job.state] || job.state}`,
    job.state === "downloading" || job.state === "queued" ? `进度：${progress}` : "",
    job.state === "completed" ? `文件：${job.originalName || job.fileName || "firmware"}` : "",
    job.state === "failed" && job.error ? `原因：${job.error}` : "",
    `任务：${String(job.id || "").slice(0, 12)}`
  ].filter(Boolean);
  if (lang === "en") {
    return [
      `${job.model || "?"} ${job.csc || "?"}`,
      `Version: ${job.version || "?"}`,
      `State: ${stateLabels[job.state] || job.state}`,
      job.state === "downloading" || job.state === "queued" ? `Progress: ${progress}` : "",
      job.state === "completed" ? `File: ${job.originalName || job.fileName || "firmware"}` : "",
      job.state === "failed" && job.error ? `Error: ${job.error}` : "",
      `Job: ${String(job.id || "").slice(0, 12)}`
    ].filter(Boolean).join("\n");
  }
  return lines.join("\n");
}

function legacyDownloadMenuKeyboard(jobs = [], lang = "zh") {
  const en = lang === "en";
  const active = jobs.find((job) => ["queued", "downloading"].includes(job.state));
  const rows = [
    [{ text: en ? "New download" : "新建下载", callback_data: "admin:download-new" }, { text: en ? "Refresh" : "刷新", callback_data: "admin:download-menu" }]
  ];
  if (active) rows.push([{ text: en ? "Cancel active" : "取消当前任务", callback_data: `admin:download-cancel:${active.id}` }]);
  rows.push([{ text: en ? "Back" : "返回", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

async function legacyRenderDownloadMenu(env, chatId, messageId = null) {
  const lang = await getUserLanguage(env, chatId);
  const result = await listFirmwareDownloads(env);
  if (!result.ok) {
    const text = result.configured === false
      ? (lang === "en" ? "Download service is not configured on the bot." : "下载服务尚未配置到机器人。")
      : (lang === "en" ? `Download service unavailable: ${result.error || "check VPS service"}` : `下载服务不可用：${result.error || "请检查 VPS 服务"}`);
    return safeEditOrSend(env, chatId, messageId, text, { inline_keyboard: [[{ text: enBack(lang), callback_data: "menu:home" }]] });
  }
  const jobs = Array.isArray(result.downloads) ? result.downloads : [];
  const recent = jobs.slice(0, 5);
  const text = lang === "en"
    ? ["Firmware downloads", "", recent.length ? recent.map((job) => formatDownloadJob(job, lang)).join("\n\n") : "No jobs yet.", "", "Only administrators can start downloads. Files are saved on the VPS."].join("\n")
    : ["固件下载", "", recent.length ? recent.map((job) => formatDownloadJob(job, lang)).join("\n\n") : "暂无任务。", "", "仅管理员可发起下载，文件保存到 VPS。"].join("\n");
  return safeEditOrSend(env, chatId, messageId, text, downloadMenuKeyboard(jobs, lang));
}

function enBack(lang) { return lang === "en" ? "Back" : "返回"; }

function downloadStateLabel(state, lang = "zh") {
  const labels = lang === "en"
    ? { queued: "Queued", downloading: "Downloading", verifying: "Verifying", decrypting: "Decrypting", paused: "Paused", completed: "Completed", failed: "Failed", cancelled: "Stopped" }
    : { queued: "排队中", downloading: "下载中", verifying: "正在校验", decrypting: "正在解密", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已终止" };
  return labels[state] || state || "-";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const amount = bytes / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  if (!value) return "-";
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  return minutes < 60 ? `${minutes}m ${value % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function downloadProgressBar(percent) {
  const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent || 0))));
  const filled = Math.round(safePercent / 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${safePercent}%`;
}

function formatDownloadJob(job, lang = "zh", detailed = false) {
  if (!job) return lang === "en" ? "No download task." : "暂无下载任务。";
  const active = ["queued", "downloading", "verifying", "decrypting", "paused"].includes(job.state);
  const lines = [
    `${job.model || "?"} · ${job.csc || "?"}`,
    `${lang === "en" ? "Version" : "版本"}: ${job.version || "?"}`,
    `${lang === "en" ? "Status" : "状态"}: ${downloadStateLabel(job.state, lang)}`
  ];
  if (active) {
    lines.push(`${lang === "en" ? "Progress" : "进度"}: ${downloadProgressBar(job.percent)}`);
    if (job.totalBytes) lines.push(`${formatBytes(job.bytes)} / ${formatBytes(job.totalBytes)}`);
    if (job.speedBytesPerSecond) {
      const speedWindowSeconds = Number(job.speedWindowSeconds || 10);
      const speedLabel = lang === "en" ? `Speed (last ${speedWindowSeconds}s)` : `速度（近${speedWindowSeconds}秒）`;
      lines.push(`${speedLabel}: ${formatBytes(job.speedBytesPerSecond)}/s · ${lang === "en" ? "ETA" : "剩余"}: ${formatDuration(job.etaSeconds)}`);
    }
  }
  if (job.state === "completed") lines.push(`${lang === "en" ? "File" : "文件"}: ${job.originalName || job.fileName || "firmware"}`);
  if (job.state === "failed" && job.error) lines.push(`${lang === "en" ? "Reason" : "原因"}: ${String(job.error).slice(0, 220)}`);
  if (detailed) lines.push(`${lang === "en" ? "Task" : "任务"}: ${job.id}`);
  return lines.join("\n");
}

function downloadMenuKeyboard(jobs = [], lang = "zh") {
  const en = lang === "en";
  const rows = [[
    { text: en ? "New" : "新建下载", callback_data: "admin:dl:new" },
    { text: en ? "Refresh" : "刷新", callback_data: "admin:download-menu" }
  ]];
  for (const [index, job] of jobs.slice(0, 5).entries()) {
    rows.push([{ text: `${en ? "Task" : "任务"} ${index + 1}: ${downloadStateLabel(job.state, lang)}`, callback_data: `admin:dl:view:${job.id}` }]);
  }
  rows.push([{ text: en ? "Back" : "返回", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

function downloadTaskKeyboard(job, lang = "zh") {
  const en = lang === "en";
  const rows = [[{ text: en ? "Refresh" : "刷新", callback_data: `admin:dl:refresh:${job.id}` }]];
  if (["queued", "downloading"].includes(job.state)) rows.push([
    { text: en ? "Pause" : "暂停", callback_data: `admin:dl:pause:${job.id}` },
    { text: en ? "Terminate" : "终止下载", callback_data: `admin:dl:stop:${job.id}` }
  ]);
  else if (["verifying", "decrypting"].includes(job.state)) rows.push([{ text: en ? "Terminate" : "终止下载", callback_data: `admin:dl:stop:${job.id}` }]);
  else if (job.state === "paused") rows.push([
    { text: en ? "Resume" : "继续下载", callback_data: `admin:dl:resume:${job.id}` },
    { text: en ? "Delete" : "删除", callback_data: `admin:dl:delete:${job.id}` }
  ]);
  else rows.push([{ text: en ? "Delete" : "删除任务与文件", callback_data: `admin:dl:delete:${job.id}` }]);
  rows.push([{ text: en ? "Downloads" : "下载列表", callback_data: "admin:download-menu" }]);
  return { inline_keyboard: rows };
}

async function renderDownloadMenu(env, chatId, messageId = null) {
  const lang = await getUserLanguage(env, chatId);
  const result = await listFirmwareDownloads(env);
  if (!result.ok) {
    const error = result.configured === false
      ? (lang === "en" ? "Download service is not configured." : "下载服务尚未配置。")
      : (lang === "en" ? `Download service unavailable: ${result.error || "check VPS service"}` : `下载服务不可用：${result.error || "请检查 VPS 服务"}`);
    return safeEditOrSend(env, chatId, messageId, error, { inline_keyboard: [[{ text: enBack(lang), callback_data: "menu:home" }]] });
  }
  const jobs = Array.isArray(result.downloads) ? result.downloads : [];
  const recent = jobs.slice(0, 5);
  const text = lang === "en"
    ? ["Firmware downloads", "", recent.length ? recent.map((job) => formatDownloadJob(job, lang)).join("\n\n") : "No tasks yet.", "", "Administrators only. Files remain on the VPS."].join("\n")
    : ["固件下载", "", recent.length ? recent.map((job) => formatDownloadJob(job, lang)).join("\n\n") : "暂无任务。", "", "仅管理员可操作；文件保存在 VPS。"].join("\n");
  return safeEditOrSend(env, chatId, messageId, text, downloadMenuKeyboard(recent, lang));
}

function adminMoreText(lang = "zh") {
  return lang === "en" ? "More\n\nSystem, help, and language." : "更多\n\n系统、帮助和语言设置。";
}

async function showMainMenu(env, chatId, identity, messageId = null) {
  const lang = await getUserLanguage(env, chatId);
  const text = await mainMenuText(env, identity, lang);
  const keyboard = mainMenuKeyboard(identity, lang);
  if (messageId) return safeEditOrSend(env, chatId, messageId, text, keyboard);
  return sendTelegramMessage(env, chatId, text, keyboard);
}

function userSettingsKeyboard(identity, lang = "zh") {
  const en = lang === "en";
  return { inline_keyboard: [
    [{ text: en ? "My info" : "\u6211\u7684\u4fe1\u606f", callback_data: "user:whoami" }, { text: en ? "Status" : "\u670d\u52a1\u72b6\u6001", callback_data: "user:status" }],
    [{ text: en ? "Language" : "\u8bed\u8a00", callback_data: "menu:language" }],
    [{ text: en ? "Back" : "\u8fd4\u56de", callback_data: "menu:home" }]
  ] };
}

function userSettingsText(lang = "zh") {
  return lang === "en" ? "Settings\n\nManage language and view account or service status." : "\u8bbe\u7f6e\n\n\u8bbe\u7f6e\u8bed\u8a00\uff0c\u6216\u67e5\u770b\u8d26\u53f7\u4e0e\u670d\u52a1\u72b6\u6001\u3002";
}

function onboardingText(identity, lang = "zh") {
  if (lang === "en") {
    return [
      "Welcome to OneUI Firmware Center 👋",
      "",
      "1. Send Model + CSC, for example: SM-S948B EUX",
      "2. Use the result card to refresh, open Samsung notes, or save the device",
      "3. Open My Devices to query saved devices and manage new-version notifications",
      "",
      identity === "allowed"
        ? "You can start querying now. Notifications are sent only when a monitored target has a new version."
        : "Request access first to query firmware."
    ].join("\n");
  }
  return [
    "欢迎使用 OneUI 固件中心 👋",
    "",
    "1. 发送 Model + CSC，例如：SM-S948B EUX",
    "2. 在结果卡片中实时刷新、查看三星说明，或保存设备",
    "3. 打开“我的设备”快捷查询，并管理新版本通知",
    "",
    identity === "allowed"
      ? "你现在可以开始查询。只有监控到新版本时才会推送通知。"
      : "请先申请查询权限，授权后即可查询固件。"
  ].join("\n");
}

function userDevicesKeyboard(devices, lang = "zh") {
  const en = lang === "en";
  return { inline_keyboard: [
    ...devices.flatMap((device) => [[
      { text: en ? "Query" : "\u67e5\u8be2", callback_data: `device:query:${device.model}:${device.csc}` },
      { text: device.notifyEnabled !== false ? (en ? "Notifications on" : "\u901a\u77e5\u5f00") : (en ? "Notifications off" : "\u901a\u77e5\u5173"), callback_data: `device:toggle:${device.model}:${device.csc}` },
      { text: en ? "Remove" : "\u79fb\u9664", callback_data: `device:remove:${device.model}:${device.csc}` }
    ]]),
    [{ text: en ? "Back" : "\u8fd4\u56de", callback_data: "menu:home" }]
  ] };
  /* legacy keyboard retained below */
  const rows = [];
  for (const device of devices) {
    rows.push([
      { text: `${en ? "🔎 Query" : "🔎 查询"} ${device.name}`.slice(0, 64), callback_data: `device:query:${device.model}:${device.csc}` },
      { text: device.notifyEnabled !== false ? (en ? "🔔 ON" : "🔔 开启") : (en ? "🔕 OFF" : "🔕 关闭"), callback_data: `device:toggle:${device.model}:${device.csc}` }
    ]);
    rows.push([{ text: en ? "Remove" : "移除", callback_data: `device:remove:${device.model}:${device.csc}` }]);
  }
  rows.push([{ text: en ? "Back to home" : "返回首页", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

async function renderUserDevices(env, chatId, messageId = null) {
  {
    const lang = await getUserLanguage(env, chatId);
    const devices = await getUserDevices(env, chatId);
    const en = lang === "en";
    const text = devices.length
      ? [en ? "📱 My Devices" : "\ud83d\udcf1 \u6211\u7684\u8bbe\u5907", "", ...devices.map((device, index) => `${index + 1}. ${device.name}\n   ${device.model} · ${device.csc}\n   ${en ? "Notifications" : "\u65b0\u7248\u672c\u901a\u77e5"}：${device.notifyEnabled !== false ? (en ? "ON" : "\u5f00") : (en ? "OFF" : "\u5173")}`)].join("\n")
      : (en ? "📱 My Devices\n\nSave a device from a firmware result." : "\ud83d\udcf1 \u6211\u7684\u8bbe\u5907\n\n\u67e5\u8be2\u56fa\u4ef6\u540e\u53ef\u70b9\u201c\u4fdd\u5b58\u8bbe\u5907\u201d\u6dfb\u52a0\u3002");
    const markup = userDevicesKeyboard(devices, lang);
    if (messageId) return safeEditOrSend(env, chatId, messageId, text, markup);
    return sendTelegramMessage(env, chatId, text, markup);
  }
  /* legacy rendering retained below */
  const lang = await getUserLanguage(env, chatId);
  const devices = await getUserDevices(env, chatId);
  const text = devices.length
    ? (lang === "en"
      ? ["📱 My Devices", "", ...devices.map((device, index) => `${index + 1}. ${device.name}\n   ${device.model} / ${device.csc}\n   New-version notifications: ${device.notifyEnabled !== false ? "ON" : "OFF"}`), "", "Use the buttons below to query or manage subscriptions."].join("\n")
      : ["📱 我的设备", "", ...devices.map((device, index) => `${index + 1}. ${device.name}\n   ${device.model} / ${device.csc}\n   新版本通知：${device.notifyEnabled !== false ? "开启" : "关闭"}`), "", "可使用下方按钮查询或管理订阅。"].join("\n"))
    : (lang === "en"
      ? "📱 My Devices\n\nNo devices saved yet. Add one from a firmware result card."
      : "📱 我的设备\n\n还没有保存设备。完成一次固件查询后，可在结果卡片中添加。")
  const markup = userDevicesKeyboard(devices, lang);
  if (messageId) return safeEditOrSend(env, chatId, messageId, text, markup);
  return sendTelegramMessage(env, chatId, text, markup);
}

function queryHelpText(lang = "zh") {
  if (lang === "en") return "Firmware query\n\nSend: Model CSC\nExample: SM-S948B EUX\n\nYou can also send a model only: 9480\n\nIf the CSC is not exact, official Samsung options are shown.";
  return "\u67e5\u8be2\u56fa\u4ef6\n\n\u53d1\u9001\uff1a\u578b\u53f7 CSC\n\u4f8b\u5982\uff1aSM-S948B EUX\n\n\u4e5f\u53ef\u53ea\u53d1\u9001\u578b\u53f7\uff1a9480\n\nCSC \u4e0d\u7cbe\u786e\u65f6\uff0c\u4f1a\u663e\u793a\u4e09\u661f\u5b98\u65b9\u53ef\u7528\u9009\u9879\u3002";
  /* legacy copy retained below */
  if (lang === "en") {
    return [
      "Firmware query",
      "",
      "Send a model directly: 9480",
      "Send an exact Model / CSC: SM-S948B EUX",
      "",
      "Use Realtime refresh below a result to bypass cache.",
      "If the CSC is wrong, Samsung-confirmed alternatives will be shown."
    ].join("\n");
  }
  return [
    "固件查询说明",
    "",
    "直接发送型号：9480",
    "精确指定 Model / CSC：SM-S948B EUX",
    "",
    "查询结果下方可点击“实时刷新”跳过缓存。",
    "CSC 不匹配时会显示三星官方返回的有效候选。"
  ].join("\n");
}


function firmwareResultKeyboard(model, csc, lang = "zh", identity = "allowed") {
  const normalizedModel = String(model || "").toUpperCase();
  const normalizedCsc = String(csc || "").toUpperCase();
  {
  const en = lang === "en";
  const rows = [[
    { text: en ? "Refresh" : "\u5237\u65b0", callback_data: `query:refresh:${normalizedModel}:${normalizedCsc}` },
    { text: en ? "Samsung official" : "\u4e09\u661f\u5b98\u65b9", url: `https://doc.samsungmobile.com/${normalizedModel}/${normalizedCsc}/doc.html` }
  ]];
  if (identity === "admin" || identity === "allowed") rows.push([{ text: en ? "Save device" : "\u4fdd\u5b58\u8bbe\u5907", callback_data: `device:add:${normalizedModel}:${normalizedCsc}` }]);
  if (identity === "admin") rows.push([
    { text: en ? "Monitor" : "\u52a0\u5165\u76d1\u63a7", callback_data: `monitor-item:add:${normalizedModel}:${normalizedCsc}` },
    { text: en ? "Clear cache" : "\u6e05\u7f13\u5b58", callback_data: `admin:cache-target:${normalizedModel}:${normalizedCsc}` }
  ]);
  if (identity === "admin") rows.push([{ text: en ? "Download firmware" : "\u4e0b\u8f7d\u56fa\u4ef6", callback_data: `admin:download-start:${normalizedModel}:${normalizedCsc}` }]);
  rows.push([{ text: en ? "Home" : "\u9996\u9875", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
  }
  /* legacy keyboard retained below */
  const rows = [[
    {
      text: lang === "en" ? "🔄 Realtime refresh" : "🔄 实时刷新",
      callback_data: `query:refresh:${normalizedModel}:${normalizedCsc}`
    },
    {
      text: lang === "en" ? "📄 Official notes" : "📄 官方说明",
      url: `https://doc.samsungmobile.com/${normalizedModel}/${normalizedCsc}/doc.html`
    }
  ]];
  if (identity === "admin" || identity === "allowed") {
    rows.push([{
      text: lang === "en" ? "📱 Add to My Devices" : "📱 添加到我的设备",
      callback_data: `device:add:${normalizedModel}:${normalizedCsc}`
    }]);
  }
  if (identity === "admin") {
    rows.push([
      {
        text: lang === "en" ? "Monitor target" : "加入 / 查看监控",
        callback_data: `monitor-item:add:${normalizedModel}:${normalizedCsc}`
      },
      {
        text: lang === "en" ? "Clear cache" : "清理此缓存",
        callback_data: `admin:cache-target:${normalizedModel}:${normalizedCsc}`
      }
    ]);
  }
  rows.push([{
    text: lang === "en" ? "Back to home" : "返回首页",
    callback_data: "menu:home"
  }]);
  return {
    inline_keyboard: rows
  };
}


const CSC_SUGGESTION_PAGE_SIZE = 8;

function officialCscOptionsFromError(error) {
  return Array.isArray(error?.officialCscOptions) ? error.officialCscOptions : [];
}

function cscSuggestionText(model, requestedCsc, rankedOptions, lang = "zh", options = {}) {
  const expanded = Boolean(options.expanded);
  const page = Math.max(0, Number(options.page) || 0);
  const total = rankedOptions.length;
  const visible = expanded
    ? rankedOptions.slice(page * CSC_SUGGESTION_PAGE_SIZE, (page + 1) * CSC_SUGGESTION_PAGE_SIZE)
    : rankedOptions.slice(0, 2);
  const start = expanded ? page * CSC_SUGGESTION_PAGE_SIZE : 0;
  const lines = visible.map((item, index) => {
    const label = formatCscOptionLabel(item, lang);
    const version = item.pda || String(item.latest || "").split("/")[0] || (lang === "en" ? "version available" : "有可用版本");
    const date = item.openDate ? ` · ${item.openDate}` : "";
    return `${start + index + 1}. ${label}\n   ${version}${date}`;
  });

  if (lang === "en") {
    return [
      `No exact official firmware record was found for ${model} / ${requestedCsc}.`,
      "",
      expanded
        ? `Official CSC options that still return usable update history (${total} total):`
        : total > 1 ? "The two most likely official CSC options are:" : "A confirmed official CSC option is:",
      ...lines,
      "",
      "Only CSCs with an available official firmware record are shown. Tap one below to query it directly."
    ].join("\n");
  }
  return [
    `未找到 ${model} / ${requestedCsc} 的精确官方固件记录。`,
    "",
    expanded
      ? `三星官方仍可查询更新记录的 CSC（共 ${total} 个）：`
      : total > 1 ? "最可能的两个官方有效 CSC：" : "检测到一个已确认的官方有效 CSC：",
    ...lines,
    "",
    "这里只显示三星官方仍有可用固件记录的 CSC，可直接点击查询。"
  ].join("\n");
}

function cscSuggestionKeyboard(model, requestedCsc, rankedOptions, lang = "zh", options = {}) {
  const expanded = Boolean(options.expanded);
  const page = Math.max(0, Number(options.page) || 0);
  const totalPages = Math.max(1, Math.ceil(rankedOptions.length / CSC_SUGGESTION_PAGE_SIZE));
  const visible = expanded
    ? rankedOptions.slice(page * CSC_SUGGESTION_PAGE_SIZE, (page + 1) * CSC_SUGGESTION_PAGE_SIZE)
    : rankedOptions.slice(0, 2);
  const rows = [];

  for (let index = 0; index < visible.length; index += 2) {
    rows.push(visible.slice(index, index + 2).map((item) => ({
      text: lang === "en" ? `Query ${item.csc}` : `查询 ${item.csc}`,
      callback_data: `csc:query:${model}:${item.csc}`
    })));
  }

  if (!expanded && rankedOptions.length > 2) {
    rows.push([{
      text: lang === "en" ? `More official CSCs (${rankedOptions.length})` : `查看更多官方 CSC（${rankedOptions.length}）`,
      callback_data: `csc:more:0:${model}:${requestedCsc}`
    }]);
  }

  if (expanded && totalPages > 1) {
    const navigation = [];
    if (page > 0) navigation.push({
      text: lang === "en" ? "Previous" : "上一页",
      callback_data: `csc:more:${page - 1}:${model}:${requestedCsc}`
    });
    if (page + 1 < totalPages) navigation.push({
      text: lang === "en" ? "Next" : "下一页",
      callback_data: `csc:more:${page + 1}:${model}:${requestedCsc}`
    });
    if (navigation.length) rows.push(navigation);
  }

  rows.push([{ text: lang === "en" ? "Back to home" : "返回首页", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

async function loadOfficialCscSuggestions(env, model, requestedCsc, identity = "allowed") {
  const cached = getCachedOfficialCscSuggestions(model, requestedCsc);
  if (cached.length) return cached;
  try {
    await querySmartHistory(env, model, requestedCsc, {
      role: identity === "admin" ? "admin" : "interactive"
    });
    return [];
  } catch (error) {
    const options = officialCscOptionsFromError(error);
    return options.length ? cacheOfficialCscSuggestions(model, requestedCsc, options) : [];
  }
}

async function deliverOfficialCscSuggestions(deliver, error, query, lang) {
  let options = officialCscOptionsFromError(error);
  if (!options.length) {
    const fallback = knownFirmwareCscCorrection(query.model, query.csc);
    if (fallback?.suggestedCsc) options = [{ csc: fallback.suggestedCsc }];
  }
  if (!options.length) return false;
  const cached = cacheOfficialCscSuggestions(query.model, query.csc, options);
  const ranked = rankOfficialCscOptions(cached, {
    model: query.model,
    requestedCsc: query.csc,
    lang
  });
  if (!ranked.length) return false;
  await deliver(
    cscSuggestionText(query.model, query.csc, ranked, lang),
    cscSuggestionKeyboard(query.model, query.csc, ranked, lang)
  );
  return true;
}

function formatMonitorProgress(summary, lang = "zh") {
  if (lang === "en") {
    return [
      "⏳ Monitor check in progress",
      "",
      `Progress: ${summary.checked}/${summary.due || summary.totalItems || 0}`,
      `Updates: ${summary.updated}`,
      `Initialized: ${summary.initialized}`,
      `Failed: ${summary.failed}`
    ].join("\n");
  }
  return [
    "⏳ 正在检查监控设备",
    "",
    `进度：${summary.checked}/${summary.due || summary.totalItems || 0}`,
    `发现更新：${summary.updated}`,
    `首次初始化：${summary.initialized}`,
    `失败：${summary.failed}`
  ].join("\n");
}

function adminMenuKeyboard(lang = "zh") {
  return mainMenuKeyboard("admin", lang);
}

async function adminMenuText(env, lang = "zh") {
  return mainMenuText(env, "admin", lang);
}

function monitorMenuKeyboard(lang = "zh") {
  const en = lang === "en";
  return {
    inline_keyboard: [
      [
        { text: en ? "Add" : "添加", callback_data: "admin:monitor-add-help" },
        { text: en ? "Check now" : "立即检查", callback_data: "admin:checknow" }
      ],
      [
        { text: en ? "Health" : "健康", callback_data: "admin:monitor-health" },
        { text: en ? "Settings" : "设置", callback_data: "admin:monitor-more" }
      ],
      [{ text: en ? "Back" : "返回", callback_data: "menu:home" }]
    ]
  };
}

function monitorMoreKeyboard(lang = "zh") {
  const en = lang === "en";
  return { inline_keyboard: [
    [{ text: en ? "Health" : "健康", callback_data: "admin:monitor-health" }, { text: en ? "Events" : "事件", callback_data: "admin:monitor-events" }],
    [{ text: en ? "Intervals" : "间隔", callback_data: "admin:intervals" }, { text: en ? "Priority" : "优先级", callback_data: "admin:high" }],
    [{ text: en ? "Delete regular" : "删除普通监控", callback_data: "admin:monitor-delete-all" }],
    [{ text: en ? "Back" : "返回", callback_data: "admin:monitor-menu" }]
  ] };
}

function monitorCenterState(item, runtime = {}, pending = null) {
  const enabled = item?.enabled !== false;
  const awaitingResume = !enabled && (
    item?.pauseReason === "awaiting_admin_resume" ||
    item?.adminDecision === "awaiting_resume_confirmation"
  );
  const failureCount = Number(runtime?.failureCount || 0);
  const hasPendingUpdate = pending?.acked !== true && Boolean(
    String(pending?.newLatest || pending?.latest || "").trim()
  );
  const kind = awaitingResume
    ? "awaiting"
    : hasPendingUpdate
      ? "updated"
    : !enabled
      ? "paused"
      : failureCount > 0
        ? "failing"
        : "active";
  return { kind, failureCount };
}

function monitorCenterLabel(kind, lang = "zh") {
  const en = lang === "en";
  const labels = {
    all: en ? "All targets" : "\u5168\u90e8\u8bbe\u5907",
    active: en ? "Normal" : "\u6b63\u5e38",
    updated: en ? "Updates" : "\u66f4\u65b0",
    paused: en ? "Paused" : "\u5df2\u6682\u505c",
    awaiting: en ? "Awaiting resume" : "\u5f85\u6062\u590d\u786e\u8ba4",
    failing: en ? "Errors" : "\u5f02\u5e38"
  };
  return labels[kind] || labels.all;
}

function monitorCenterButtonText(entry, lang = "zh") {
  const { item, state } = entry;
  const prefix = {
    active: "\u2705",
    paused: "\u23f8\ufe0f",
    awaiting: "\u23f3",
    updated: "\ud83c\udd95",
    failing: "\u26a0\ufe0f"
  }[state.kind] || "\u2022";
  const detail = state.kind === "failing"
    ? ` ${lang === "en" ? `Errors ${state.failureCount}` : `\u5f02\u5e38 ${state.failureCount}`}`
    : state.kind === "updated"
      ? ` ${monitorCenterLabel("updated", lang)}`
    : ` ${monitorCenterLabel(state.kind, lang)}`;
  return `${prefix} ${item.model} / ${item.csc}${detail}`;
}

function isRolloutManagedMonitor(item) {
  return Boolean(item?.rolloutChainId && item?.rolloutStageId);
}

function standardMonitorItems(items) {
  return items.filter((item) => !isRolloutManagedMonitor(item));
}

async function formatMonitorCenterPanel(env, lang = "zh", filter = "all") {
  const en = lang === "en";
  const items = standardMonitorItems(await getMonitorItems(env));
  const [runtimes, pendingUpdates] = await Promise.all([
    Promise.all(items.map((item) => getMonitorRuntime(env, item.model, item.csc))),
    Promise.all(items.map((item) => getPendingUpdate(env, item.model, item.csc)))
  ]);
  const entries = items.map((item, index) => ({
    item,
    runtime: runtimes[index] || {},
    state: monitorCenterState(item, runtimes[index] || {}, pendingUpdates[index])
  }));
  const visibleKind = (kind) => kind === "awaiting" ? "paused" : kind;
  const kinds = ["active", "updated", "failing", "paused"];
  const counts = Object.fromEntries(kinds.map((kind) => [
    kind,
    entries.filter((entry) => visibleKind(entry.state.kind) === kind).length
  ]));
  const selected = filter === "awaiting" ? "paused" : (kinds.includes(filter) ? filter : "all");
  const rank = { updated: 0, failing: 1, active: 2, paused: 3, awaiting: 3 };
  const displayed = entries
    .filter((entry) => selected === "all" || visibleKind(entry.state.kind) === selected)
    .sort((left, right) => rank[left.state.kind] - rank[right.state.kind]
      || `${left.item.model}:${left.item.csc}`.localeCompare(`${right.item.model}:${right.item.csc}`));
  const rows = [
    [
      { text: `${monitorCenterLabel("all", lang)} ${items.length}`, callback_data: "admin:monitor-filter:all" },
      { text: `${monitorCenterLabel("active", lang)} ${counts.active}`, callback_data: "admin:monitor-filter:active" },
      { text: `${monitorCenterLabel("updated", lang)} ${counts.updated}`, callback_data: "admin:monitor-filter:updated" }
    ],
    [
      { text: `${monitorCenterLabel("failing", lang)} ${counts.failing}`, callback_data: "admin:monitor-filter:failing" },
      { text: `${monitorCenterLabel("paused", lang)} ${counts.paused}`, callback_data: "admin:monitor-filter:paused" }
    ]
  ];
  for (const entry of displayed.slice(0, 20)) {
    rows.push([{
      text: monitorCenterButtonText({
        ...entry,
        state: { ...entry.state, kind: visibleKind(entry.state.kind) }
      }, lang),
      callback_data: `monitor-item:view:${entry.item.model}:${entry.item.csc}`
    }]);
  }
  rows.push([
    { text: en ? "Add" : "添加", callback_data: "admin:monitor-add-help" },
    { text: en ? `Check errors ${counts.failing}` : `检查异常 ${counts.failing}`, callback_data: "admin:monitor-retry-failed" }
  ], [
    { text: en ? "Settings" : "设置", callback_data: "admin:monitor-more" },
    { text: en ? "Back" : "返回", callback_data: "menu:home" }
  ]);
  const lines = [
    `${en ? "\u{1F4CA} Monitoring" : "\u{1F4CA} \u76d1\u63a7"}${selected === "all" ? "" : ` · ${monitorCenterLabel(selected, lang)}`}`,
    "",
    en
      ? `Normal ${counts.active} · Updates ${counts.updated} · Errors ${counts.failing} · Paused ${counts.paused}`
      : `正常 ${counts.active} · 更新 ${counts.updated} · 异常 ${counts.failing} · 暂停 ${counts.paused}`
  ];
  if (!items.length) lines.push("", en ? "No targets." : "暂无设备");
  else if (!displayed.length) lines.push("", en ? "None." : "暂无");
  if (displayed.length > 20) lines.push("", en ? "First 20 only." : "仅显示前 20 个");
  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: rows } };
}

function formatRuntimeTime(value, lang) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp)
    ? formatBeijingTime(new Date(timestamp), lang)
    : (lang === "en" ? "Not available" : "\u6682\u65e0");
}

async function formatMonitorHealthPanel(env, lang = "zh") {
  {
    const en = lang === "en";
    const items = standardMonitorItems(await getMonitorItems(env));
    const runtimes = await Promise.all(items.map((item) => getMonitorRuntime(env, item.model, item.csc)));
    const failing = runtimes.filter((runtime) => Number(runtime.failureCount || 0) > 0).length;
    const lines = [
      en ? "Monitor health" : "\u76d1\u63a7\u5065\u5eb7",
      "",
      `${en ? "Targets" : "\u76ee\u6807"}：${items.length}`,
      `${en ? "Healthy" : "\u6b63\u5e38"}：${Math.max(0, items.filter((item) => item.enabled !== false).length - failing)}`,
      `${en ? "Failing" : "\u5931\u8d25"}：${failing}`
    ];
    for (const [index, item] of items.slice(0, 20).entries()) {
      const runtime = runtimes[index] || {};
      lines.push("", `${Number(runtime.failureCount || 0) ? "⚠️" : "✅"} ${item.model} · ${item.csc}`, `${en ? "Last success" : "\u4e0a\u6b21\u6210\u529f"}：${formatRuntimeTime(runtime.lastSuccessAt, lang)}`, `${en ? "Next check" : "\u4e0b\u6b21\u68c0\u67e5"}：${formatRuntimeTime(runtime.nextCheckAt || runtime.nextAttemptAt, lang)}`, `${en ? "Failures" : "\u8fde\u7eed\u5931\u8d25"}：${runtime.failureCount || 0}`);
    }
    return { text: lines.join("\n"), replyMarkup: { inline_keyboard: [
      [{ text: en ? "Refresh" : "\u5237\u65b0", callback_data: "admin:monitor-health" }],
      [{ text: en ? "Events" : "\u4e8b\u4ef6", callback_data: "admin:monitor-events" }, { text: en ? "Back" : "\u8fd4\u56de", callback_data: "admin:monitor-menu" }]
    ] } };
  }
  /* legacy source-score panel retained below */
  const en = lang === "en";
  const items = await getMonitorItems(env);
  const runtimes = await Promise.all(items.map((item) => getMonitorRuntime(env, item.model, item.csc)));
  const entries = items.map((item, index) => ({ item, runtime: runtimes[index] || {} }));
  const failing = entries.filter(({ runtime }) => Number(runtime.failureCount || 0) > 0);
  const healthy = entries.filter(({ item, runtime }) => item.enabled !== false && Number(runtime.failureCount || 0) === 0);
  const sourceHealth = summarizeSamsungSourceHealth(entries);
  const lines = [
    en ? "\u{1FA7A} Monitor health" : "\u{1FA7A} \u76d1\u63a7\u5065\u5eb7\u5ea6",
    "",
    `${en ? "Targets" : "\u76d1\u63a7\u76ee\u6807"}: ${items.length}`,
    `${en ? "Healthy" : "\u6b63\u5e38"}: ${healthy.length}`,
    `${en ? "Failing" : "\u8fde\u7eed\u5931\u8d25"}: ${failing.length}`,
    `${en ? "Samsung source score" : "\u4e09\u661f\u6e90\u8bc4\u5206"}: ${sourceHealth.averageScore}/100`
  ];

  for (const { item, runtime } of entries.slice(0, 20)) {
    const failures = Number(runtime.failureCount || 0);
    const source = classifySamsungSourceHealth(runtime);
    lines.push(
      "",
      `${failures > 0 ? "\u26a0\ufe0f" : "\u2705"} ${item.model} / ${item.csc}`,
      `${en ? "Last success" : "\u4e0a\u6b21\u6210\u529f"}: ${formatRuntimeTime(runtime.lastSuccessAt, lang)}`,
      `${en ? "Next check" : "\u4e0b\u6b21\u68c0\u67e5"}: ${formatRuntimeTime(runtime.nextCheckAt || runtime.nextAttemptAt, lang)}`,
      `${en ? "Failures" : "\u8fde\u7eed\u5931\u8d25"}: ${failures}`,
      `Samsung: ${formatSamsungSourceHealth(source, lang)} (${source.score}/100)`
    );
    if (failures > 0 && runtime.lastError) {
      lines.push(`${en ? "Last error" : "\u4e0a\u6b21\u9519\u8bef"}: ${String(runtime.lastError).slice(0, 120)}`);
    }
  }
  if (items.length > 20) lines.push("", en ? "Only the first 20 targets are shown." : "\u4ec5\u663e\u793a\u524d 20 \u4e2a\u8bbe\u5907\u3002");
  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: en ? "Refresh" : "\u5237\u65b0", callback_data: "admin:monitor-health" }],
        [{ text: en ? "Recent events" : "\u6700\u8fd1\u4e8b\u4ef6", callback_data: "admin:monitor-events" }],
        [{ text: en ? "Back to monitoring" : "\u8fd4\u56de\u76d1\u63a7\u4e2d\u5fc3", callback_data: "admin:monitor-menu" }],
        [{ text: en ? "Home" : "\u8fd4\u56de\u9996\u9875", callback_data: "menu:home" }]
      ]
    }
  };
}

function staleMonitorActionText(lang = "zh") {
  return lang === "en"
    ? "This action has already been handled or has expired."
    : "\u8be5\u64cd\u4f5c\u5df2\u7ecf\u5904\u7406\u6216\u5df2\u5931\u6548\u3002";
}

function accessMenuKeyboard(settings, lang = "zh") {
  const en = lang === "en";
  const enabled = settings?.autoApprove === true;
  return {
    inline_keyboard: [
      [
        { text: en ? "Pending requests" : "待审批申请", callback_data: "admin:requests" },
        { text: en ? "Allowed users" : "授权用户", callback_data: "admin:users" }
      ],
      [{
        text: enabled
          ? (en ? "Turn auto approve OFF" : "关闭自动审批")
          : (en ? "Turn auto approve ON" : "开启自动审批"),
        callback_data: "admin:autoapprove:toggle"
      }],
      [
        { text: en ? "Open 60 min" : "开放 60 分钟", callback_data: "admin:autoapprove:60" },
        { text: en ? "Open 24 hours" : "开放 24 小时", callback_data: "admin:autoapprove:1440" }
      ],
      [{ text: en ? "Add user manually" : "手动添加用户", callback_data: "admin:user-add-help" }],
      [{ text: en ? "Back" : "返回主菜单", callback_data: "menu:home" }]
    ]
  };
}

function systemMenuKeyboard(settings, lang = "zh") {
  const en = lang === "en";
  const cacheEnabled = settings?.enabled !== false;
  const realtimeEnabled = settings?.adminRealtimeEnabled === true;
  return {
    inline_keyboard: [
      [{
        text: cacheEnabled ? (en ? "Turn cache OFF" : "关闭查询缓存") : (en ? "Turn cache ON" : "开启查询缓存"),
        callback_data: "admin:cache:toggle"
      }],
      [{
        text: realtimeEnabled
          ? (en ? "Turn admin realtime OFF" : "关闭管理员实时查询")
          : (en ? "Turn admin realtime ON" : "开启管理员实时查询"),
        callback_data: "admin:realtime:toggle"
      }],
      [
        { text: en ? "System status" : "系统状态", callback_data: "admin:status" },
        { text: en ? "Clear all cache" : "清理全部缓存", callback_data: "admin:cache-clear:confirm" }
      ],
      [
        { text: en ? "Performance" : "性能中心", callback_data: "admin:performance" },
        { text: en ? "Diagnostics" : "系统诊断", callback_data: "admin:diagnostics" }
      ],
      [{ text: en ? "Back" : "返回主菜单", callback_data: "menu:home" }]
    ]
  };
}

function scheduleMenuKeyboard(schedule, lang = "zh", summarySettings = null) {
  const en = lang === "en";
  const enabled = schedule?.enabled !== false;
  const weekends = schedule?.skipWeekends !== true;
  const summaryEnabled = summarySettings?.enabled !== false;
  return {
    inline_keyboard: [
      [{
        text: enabled ? (en ? "Pause monitoring" : "暂停自动监控") : (en ? "Resume monitoring" : "恢复自动监控"),
        callback_data: "admin:schedule:toggle"
      }],
      [{
        text: weekends ? (en ? "Disable weekends" : "关闭周末监控") : (en ? "Enable weekends" : "开启周末监控"),
        callback_data: "admin:schedule:weekend"
      }],
      [{
        text: summaryEnabled ? (en ? "Disable daily summary" : "关闭每日摘要") : (en ? "Enable daily summary" : "开启每日摘要"),
        callback_data: "admin:schedule:summary-toggle"
      }],
      [
        { text: en ? "All day" : "全天 00:00-23:59", callback_data: "admin:schedule:all-day" },
        { text: en ? "Daytime" : "白天 08:00-23:59", callback_data: "admin:schedule:daytime" }
      ],
      [
        { text: en ? "Back to monitoring" : "返回监控中心", callback_data: "admin:monitor-menu" },
        { text: en ? "Home" : "返回首页", callback_data: "menu:home" }
      ]
    ]
  };
}

function accessMenuText(settings, requestCount, userCount, lang = "zh") {
  const expires = settings?.autoApprove && settings?.autoApproveExpiresAt
    ? formatBeijingTime(new Date(settings.autoApproveExpiresAt))
    : "";
  if (lang === "en") {
    return [
      "User access",
      "",
      `Pending requests: ${requestCount}`,
      `Allowed users: ${userCount}`,
      `Auto approve: ${settings?.autoApprove ? "ON" : "OFF"}`,
      expires ? `Closes at: ${expires}` : ""
    ].filter(Boolean).join("\n");
  }
  return [
    "用户权限",
    "",
    `待审批申请：${requestCount}`,
    `授权用户：${userCount}`,
    `自动审批：${settings?.autoApprove ? "开启" : "关闭"}`,
    expires ? `自动关闭时间：${expires}` : ""
  ].filter(Boolean).join("\n");
}

function systemMenuText(settings, env, lang = "zh") {
  if (lang === "en") {
    return [
      "System and cache",
      "",
      `Query cache: ${settings?.enabled !== false ? "ON" : "OFF"}`,
      `Admin realtime: ${settings?.adminRealtimeEnabled ? "ON" : "OFF"}`,
      `TTL: L1 ${l1CacheTtlSeconds(env)}s / fresh ${firmwareCacheFreshSeconds(env)}s / SWR ${queryStaleWhileRevalidateSeconds(env)}s`
    ].join("\n");
  }
  return [
    "系统与缓存",
    "",
    `查询缓存：${settings?.enabled !== false ? "开启" : "关闭"}`,
    `管理员实时查询：${settings?.adminRealtimeEnabled ? "开启" : "关闭"}`,
    `TTL：L1 ${l1CacheTtlSeconds(env)} 秒 / 新鲜 ${firmwareCacheFreshSeconds(env)} 秒 / SWR ${queryStaleWhileRevalidateSeconds(env)} 秒`
  ].join("\n");
}

function parseAccessDecisionText(text) {
  const value = String(text || "").trim();
  let match = value.match(/^(?:✅\s*)?(?:同意|批准|Approve)\s+(\d+)$/i);
  if (match) return { action: "approve", targetId: match[1] };
  match = value.match(/^(?:❌\s*)?(?:拒绝|Reject)\s+(\d+)$/i);
  if (match) return { action: "reject", targetId: match[1] };
  return null;
}

function parseAdminDownloadInput(text) {
  const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  let version = "";
  if (tokens.length >= 3 && (tokens.at(-1).includes("/") || /^[A-Z0-9]{10,}$/i.test(tokens.at(-1)))) version = tokens.pop();
  const csc = tokens.pop();
  const parsed = parseFirmwareInput(`${tokens.join(" ")} ${csc}`);
  if (!parsed.matched) return null;
  return { model: parsed.model, csc: parsed.csc, version };
}

function canFallbackToOfficialVersionMetadata(error) {
  return ["FUS_SMART_HISTORY_EMPTY", "FUS_SMART_HISTORY_STATUS"].includes(String(error?.code || ""));
}

async function resolveAdminDownloadVersion(env, request) {
  if (request.version) return request.version;
  try {
    const history = await querySmartHistory(env, request.model, request.csc, { role: "admin" });
    return history.latest;
  } catch (error) {
    if (!canFallbackToOfficialVersionMetadata(error)) throw error;
    return resolveOfficialFirmwareVersion(env, request.model, request.csc, "", { role: "admin" });
  }
}

async function legacyStartAdminFirmwareDownload(env, chatId, request, options = {}) {
  const lang = await getUserLanguage(env, chatId);
  const messageId = options.messageId || null;
  const progress = lang === "en"
    ? `Preparing official Samsung download...\n\n${request.model} ${request.csc}`
    : `正在准备三星官方下载…\n\n${request.model} ${request.csc}`;
  await (messageId
    ? safeEditOrSend(env, chatId, messageId, progress)
    : sendTelegramMessage(env, chatId, progress));
  try {
    const version = await resolveAdminDownloadVersion(env, request);
    const created = await createFirmwareDownload(env, {
      model: request.model,
      csc: request.csc,
      version
    }, chatId);
    if (!created.ok) throw new Error(created.error || "download service rejected the request");
    const job = created.download;
    const text = lang === "en"
      ? `Download queued.\n\n${formatDownloadJob(job, lang)}\n\nUse Downloads → Refresh to view progress.`
      : `下载任务已创建。\n\n${formatDownloadJob(job, lang)}\n\n可在“下载 → 刷新”查看进度。`;
    return messageId
      ? safeEditOrSend(env, chatId, messageId, text, downloadMenuKeyboard([job], lang))
      : sendTelegramMessage(env, chatId, text, downloadMenuKeyboard([job], lang));
  } catch (error) {
    const text = lang === "en"
      ? `Download was not started.\n\n${String(error?.message || error).slice(0, 240)}`
      : `下载未启动。\n\n${String(error?.message || error).slice(0, 240)}`;
    return messageId
      ? safeEditOrSend(env, chatId, messageId, text, downloadMenuKeyboard([], lang))
      : sendTelegramMessage(env, chatId, text, downloadMenuKeyboard([], lang));
  }
}

async function legacyHandleAdminDownloadText(env, chatId, text, ctx = null) {
  if (!await hasAdminDownloadInput(env, chatId)) return false;
  await clearAdminDownloadInput(env, chatId);
  const request = parseAdminDownloadInput(text);
  const lang = await getUserLanguage(env, chatId);
  if (!request) {
    await sendTelegramMessage(env, chatId, lang === "en"
      ? "Format: MODEL CSC [VERSION]\nExample: SM-S938B CHC"
      : "格式：型号 CSC [版本]\n例如：SM-S938B CHC");
    return true;
  }
  runBackground(ctx, startAdminFirmwareDownload(env, chatId, request));
  await sendTelegramMessage(env, chatId, lang === "en" ? "Request received." : "已收到下载请求。正在准备…");
  return true;
}

const downloadProgressWatches = new Map();

async function getAdminDownloadSession(env, chatId) {
  return kvGetJson(env, adminDownloadSessionKey(chatId), null);
}

async function saveAdminDownloadSession(env, chatId, session) {
  await kvPutJson(env, adminDownloadSessionKey(chatId), {
    ...session,
    createdAt: new Date().toISOString()
  }, { expirationTtl: ADMIN_DOWNLOAD_SESSION_TTL_SECONDS });
}

function previewKeyboard(lang = "zh") {
  const en = lang === "en";
  return { inline_keyboard: [[
    { text: en ? "Confirm download" : "确认下载", callback_data: "admin:dl:confirm" },
    { text: en ? "Cancel" : "取消", callback_data: "admin:dl:discard" }
  ], [{ text: en ? "Downloads" : "下载列表", callback_data: "admin:download-menu" }]] };
}

async function renderDownloadDetails(env, chatId, messageId, id) {
  const lang = await getUserLanguage(env, chatId);
  const result = await getFirmwareDownload(env, id);
  if (!result.ok || !result.download) {
    return safeEditOrSend(env, chatId, messageId, lang === "en" ? "Download task was not found." : "未找到下载任务。", downloadMenuKeyboard([], lang));
  }
  const job = result.download;
  const title = lang === "en" ? "Firmware download" : "固件下载";
  const response = await safeEditOrSend(env, chatId, messageId, `${title}\n\n${formatDownloadJob(job, lang, true)}`, downloadTaskKeyboard(job, lang));
  if (["queued", "downloading", "verifying", "decrypting"].includes(job.state) && messageId) startDownloadProgressWatch(env, chatId, messageId, job.id);
  return response;
}

function startDownloadProgressWatch(env, chatId, messageId, id) {
  if (!env.VPS_SHADOW_MODE) return;
  const key = `${chatId}:${messageId}:${id}`;
  if (downloadProgressWatches.has(key)) return;
  let polls = 0;
  const timer = setInterval(async () => {
    polls += 1;
    try {
      const result = await getFirmwareDownload(env, id);
      const job = result.download;
      if (!result.ok || !job || !["queued", "downloading", "verifying", "decrypting"].includes(job.state) || polls > 1440) {
        clearInterval(timer);
        downloadProgressWatches.delete(key);
        if (job) await renderDownloadDetails(env, chatId, messageId, id);
        return;
      }
      const lang = await getUserLanguage(env, chatId);
      await safeEditOrSend(env, chatId, messageId, `${lang === "en" ? "Firmware download" : "固件下载"}\n\n${formatDownloadJob(job, lang, true)}`, downloadTaskKeyboard(job, lang));
    } catch {
      // A later refresh or the next poll can recover from transient errors.
    }
  }, 5000);
  timer.unref?.();
  downloadProgressWatches.set(key, timer);
}

async function prepareAdminFirmwareDownload(env, chatId, request, options = {}) {
  const lang = await getUserLanguage(env, chatId);
  const messageId = options.messageId || null;
  const checking = lang === "en"
    ? `Checking Samsung official firmware…\n\n${request.model} ${request.csc}`
    : `正在验证三星官方固件…\n\n${request.model} ${request.csc}`;
  await (messageId ? safeEditOrSend(env, chatId, messageId, checking) : sendTelegramMessage(env, chatId, checking));
  try {
    const version = await resolveAdminDownloadVersion(env, request);
    const response = await previewFirmwareDownload(env, { model: request.model, csc: request.csc, version });
    if (!response.ok || !response.preview) throw new Error(response.error || "Samsung did not return a downloadable firmware");
    const preview = response.preview;
    await saveAdminDownloadSession(env, chatId, { action: "confirm", request: { model: request.model, csc: request.csc, version: preview.version || version } });
    const text = lang === "en"
      ? ["Firmware download preview", "", `${preview.model} · ${preview.csc}`, `Version: ${preview.version}`, `File: ${preview.originalName}`, `Size: ${formatBytes(preview.totalBytes)}`, "Source: Samsung official FUS", "", "Confirm to download the file to the VPS."].join("\n")
      : ["固件下载预览", "", `${preview.model} · ${preview.csc}`, `版本：${preview.version}`, `文件：${preview.originalName}`, `大小：${formatBytes(preview.totalBytes)}`, "来源：三星官方 FUS", "", "确认后才会下载到 VPS。"].join("\n");
    return messageId ? safeEditOrSend(env, chatId, messageId, text, previewKeyboard(lang)) : sendTelegramMessage(env, chatId, text, previewKeyboard(lang));
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 240);
    const text = lang === "en" ? `Firmware could not be prepared.\n\n${detail}` : `无法准备该固件。\n\n${detail}`;
    return messageId ? safeEditOrSend(env, chatId, messageId, text, downloadMenuKeyboard([], lang)) : sendTelegramMessage(env, chatId, text, downloadMenuKeyboard([], lang));
  }
}

async function startAdminFirmwareDownload(env, chatId, request, options = {}) {
  return prepareAdminFirmwareDownload(env, chatId, request, options);
}

async function confirmAdminFirmwareDownload(env, chatId, messageId = null) {
  const lang = await getUserLanguage(env, chatId);
  const session = await getAdminDownloadSession(env, chatId);
  if (!session || session.action !== "confirm" || !session.request) {
    return safeEditOrSend(env, chatId, messageId, lang === "en" ? "This preview expired. Create a new download preview." : "预览已过期，请重新创建下载预览。", downloadMenuKeyboard([], lang));
  }
  await clearAdminDownloadInput(env, chatId);
  try {
    const created = await createFirmwareDownload(env, session.request, chatId);
    if (!created.ok || !created.download) throw new Error(created.error || "download service rejected the request");
    return renderDownloadDetails(env, chatId, messageId, created.download.id);
  } catch (error) {
    return safeEditOrSend(env, chatId, messageId, lang === "en" ? `Download was not started.\n\n${String(error?.message || error).slice(0, 240)}` : `下载未启动。\n\n${String(error?.message || error).slice(0, 240)}`, downloadMenuKeyboard([], lang));
  }
}

async function handleAdminDownloadText(env, chatId, text, ctx = null) {
  const session = await getAdminDownloadSession(env, chatId);
  if (!session || !["input", "create"].includes(session.action)) return false;
  const request = parseAdminDownloadInput(text);
  const lang = await getUserLanguage(env, chatId);
  if (!request) {
    await sendTelegramMessage(env, chatId, lang === "en"
      ? "Format: MODEL CSC [VERSION]\nExample: SM-S9480 CHC"
      : "格式：型号 CSC [版本]\n例如：SM-S9480 CHC");
    return true;
  }
  await clearAdminDownloadInput(env, chatId);
  runBackground(ctx, prepareAdminFirmwareDownload(env, chatId, request));
  await sendTelegramMessage(env, chatId, lang === "en" ? "Request received. Checking Samsung…" : "已收到请求，正在验证三星官方固件…");
  return true;
}

async function handleAdminMenuText(env, chatId, text) {
  const value = String(text || "").trim();
  if (value === "📝 白名单申请") {
    await handleRequestsList(env, chatId);
    return true;
  }
  if (value === "📡 监控设备") {
    await sendTelegramMessage(env, chatId, await formatMonitorList(env), adminMenuKeyboard());
    return true;
  }
  if (value === "✅ 开放申请") {
    await setAccessAutoApprove(env, true);
    await sendTelegramMessage(env, chatId, formatAutoApproveStatus(await getAccessSettings(env)), adminMenuKeyboard());
    return true;
  }
  if (value === "🔒 关闭申请") {
    await setAccessAutoApprove(env, false);
    await sendTelegramMessage(env, chatId, formatAutoApproveStatus(await getAccessSettings(env)), adminMenuKeyboard());
    return true;
  }
  if (value === "⏰ 监控规则") {
    const [schedule, summarySettings] = await Promise.all([
      getMonitorSchedule(env),
      getMonitorSummarySettings(env)
    ]);
    await sendTelegramMessage(env, chatId, formatSchedule(schedule, "zh", summarySettings), adminMenuKeyboard());
    return true;
  }
  if (value === "📌 待确认更新") {
    await sendTelegramMessage(env, chatId, await formatPending(env), adminMenuKeyboard());
    return true;
  }
  if (value === "📊 状态") {
    await sendTelegramMessage(env, chatId, await formatStatus(env, chatId, "admin", "zh"), adminMenuKeyboard());
    return true;
  }
  return false;
}

const callbackDedup = new Map();

function beginCallback(callbackId) {
  const now = Date.now();
  for (const [key, expiresAt] of callbackDedup) {
    if (expiresAt <= now) callbackDedup.delete(key);
  }
  if (callbackDedup.has(callbackId)) return false;
  callbackDedup.set(callbackId, now + 60_000);
  return true;
}

function callbackProgressText(data) {
  if (data.startsWith("query:refresh:") || data.startsWith("csc:query:")) return "正在实时查询… / Querying…";
  if (data.startsWith("csc:more:")) return "正在读取官方 CSC… / Loading…";
  if (data.startsWith("device:query:")) return "正在查询… / Querying…";
  if (/^device:(?:add|toggle|remove):/.test(data)) return "正在保存… / Saving…";
  if (data === "admin:checknow") return "正在启动检查… / Starting…";
  if (/^(?:admin:(?:schedule:|autoapprove:|cache:|realtime:|interval)|monitor-item:|monitor-update:|flagship:|access:|ack:)/.test(data)) {
    return "正在保存… / Saving…";
  }
  return "已收到，正在处理… / Processing…";
}

async function reportCallbackFailure(callbackQuery, env, error) {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const data = String(callbackQuery.data || "");
  console.log(`Callback action failed (${data || "unknown"}): ${error.message}`);
  if (!chatId) return;
  try {
    const lang = await getUserLanguage(env, chatId);
    const text = lang === "en"
      ? "❌ Unable to confirm the operation result.\n\nReopen the panel to check the current state, then try again."
      : "❌ 未能确认操作结果\n\n请重新打开面板核对当前状态，然后再试一次。";
    const retryButton = data
      ? [{ text: lang === "en" ? "Try again" : "重试", callback_data: data }]
      : [];
    await safeEditOrSend(env, chatId, messageId, text, {
      inline_keyboard: [
        retryButton,
        [{ text: lang === "en" ? "Back to main menu" : "返回主菜单", callback_data: "menu:home" }]
      ].filter((row) => row.length)
    });
  } catch (reportError) {
    console.log(`Callback failure report failed: ${reportError.message}`);
  }
}

async function handleCallback(callbackQuery, env, ctx = null) {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data || "";
  console.log(`callback received: ${data}`);
  if (!chatId) {
    await answerCallbackQuery(env, callbackQuery.id, "无法识别会话 / Invalid chat");
    return;
  }
  if (!beginCallback(callbackQuery.id)) {
    await answerCallbackQuery(env, callbackQuery.id, "正在处理，请勿重复点击");
    return;
  }
  // The webhook has already returned 200. Finish the short Telegram callback
  // acknowledgement before any KV or FUS work so the client clears its spinner.
  await answerCallbackQuery(env, callbackQuery.id, callbackProgressText(data));

  if (data === "menu:home") {
    const identity = await getIdentity(env, chatId);
    await showMainMenu(env, chatId, identity, messageId);
    return;
  }

  if (data === "menu:language") {
    const identity = await getIdentity(env, chatId);
    const lang = await getUserLanguage(env, chatId);
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en" ? "Choose a language:" : "请选择语言：",
      languageModeKeyboard(identity, lang)
    );
    return;
  }

  if (data === "menu:more") {
    const identity = await getIdentity(env, chatId);
    const lang = await getUserLanguage(env, chatId);
    if (identity === "admin") {
      await safeEditOrSend(env, chatId, messageId, adminMoreText(lang), adminMoreKeyboard(lang));
    } else {
      await safeEditOrSend(env, chatId, messageId, userSettingsText(lang), userSettingsKeyboard(identity, lang));
    }
    return;
  }

  if (data === "menu:settings") {
    const identity = await getIdentity(env, chatId);
    const lang = await getUserLanguage(env, chatId);
    await safeEditOrSend(env, chatId, messageId, userSettingsText(lang), userSettingsKeyboard(identity, lang));
    return;
  }

  if (data === "menu:help") {
    const identity = await getIdentity(env, chatId);
    const lang = await getUserLanguage(env, chatId);
    if (identity === "admin") {
      await safeEditOrSend(env, chatId, messageId, guideText(identity, lang), adminMoreKeyboard(lang));
    } else {
      await safeEditOrSend(env, chatId, messageId, guideText(identity, lang), mainMenuKeyboard(identity, lang));
    }
    return;
  }

  if (data === "menu:query-help") {
    const identity = await getIdentity(env, chatId);
    const lang = await getUserLanguage(env, chatId);
    await safeEditOrSend(env, chatId, messageId, queryHelpText(lang), mainMenuKeyboard(identity, lang));
    return;
  }

  if (data === "user:apply") {
    const identity = await getIdentity(env, chatId);
    await handleAccessApply(env, chatId, { from: callbackQuery.from || {} }, identity);
    return;
  }

  if (data === "user:whoami" || data === "user:status") {
    const identity = await getIdentity(env, chatId);
    const lang = await getUserLanguage(env, chatId);
    const text = data === "user:whoami"
      ? formatWhoami(chatId, identity, lang)
      : await formatStatus(env, chatId, identity, lang);
    await safeEditOrSend(env, chatId, messageId, text, userSettingsKeyboard(identity, lang));
    return;
  }

  if (data === "device:list") {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin" && identity !== "allowed") {
      const lang = await getUserLanguage(env, chatId);
      await safeEditOrSend(env, chatId, messageId, lang === "en"
        ? "My Devices is available after query access is approved."
        : "获得查询权限后即可使用“我的设备”。", mainMenuKeyboard(identity, lang));
      return;
    }
    await renderUserDevices(env, chatId, messageId);
    return;
  }

  if (data.startsWith("device:add:") || data.startsWith("device:toggle:") || data.startsWith("device:remove:") || data.startsWith("device:remove-confirm:") || data.startsWith("device:query:")) {
    const identity = await getIdentity(env, chatId);
    const lang = await getUserLanguage(env, chatId);
    if (identity !== "admin" && identity !== "allowed") {
      await safeEditOrSend(env, chatId, messageId, lang === "en" ? "Query access is required." : "需要查询权限。", mainMenuKeyboard(identity, lang));
      return;
    }
    const [, action, model, csc] = data.split(":");
    if (!model || !csc) return;
    if (action === "add") {
      await upsertUserDevice(env, chatId, { model, csc, name: `${model} ${csc}`, notifyEnabled: true });
      await renderUserDevices(env, chatId, messageId);
      return;
    }
    if (action === "toggle") {
      const devices = await getUserDevices(env, chatId);
      const current = devices.find((device) => device.model === model && device.csc === csc);
      if (!current) {
        await renderUserDevices(env, chatId, messageId);
        return;
      }
      await setUserDeviceNotification(env, chatId, model, csc, current.notifyEnabled === false);
      await renderUserDevices(env, chatId, messageId);
      return;
    }
    if (action === "remove") {
      const device = (await getUserDevices(env, chatId)).find((item) => item.model === model && item.csc === csc);
      await safeEditOrSend(env, chatId, messageId,
        lang === "en"
          ? `Remove this device?\n\n${device?.name || `${model} ${csc}`}\n${model} · ${csc}`
          : `\u786e\u5b9a\u79fb\u9664\u8fd9\u4e2a\u8bbe\u5907\u5417\uff1f\n\n${device?.name || `${model} ${csc}`}\n${model} · ${csc}`,
        { inline_keyboard: [[
          { text: lang === "en" ? "Confirm remove" : "\u786e\u8ba4\u79fb\u9664", callback_data: `device:remove-confirm:${model}:${csc}` },
          { text: lang === "en" ? "Cancel" : "\u53d6\u6d88", callback_data: "device:list" }
        ]] }
      );
      return;
    }
    if (action === "remove-confirm") {
      await removeUserDevice(env, chatId, model, csc);
      await renderUserDevices(env, chatId, messageId);
      return;
    }
    if (!(await enforceInteractiveQueryLimits(env, chatId, identity, model, lang, messageId))) return;
    await safeEditOrSend(env, chatId, messageId, lang === "en"
      ? `Checking latest firmware...\nModel: ${model}\nCSC: ${csc}`
      : `正在查询最新固件...\n型号：${model}\n地区：${csc}`);
    runBackground(ctx, handleManualQuery(env, chatId, `${model} ${csc}`, {
      identity,
      ctx,
      query: { model, csc },
      targetMessageId: messageId,
      silentPlaceholder: true
    }));
    return;
  }


  if (data.startsWith("csc:query:")) {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin" && identity !== "allowed") {
      await safeEditOrSend(env, chatId, messageId, "你没有权限执行此操作。");
      return;
    }
    const [, , model, csc] = data.split(":");
    if (!model || !csc) return;
    const lang = await getUserLanguage(env, chatId);
    const allowedByRateLimit = await tryStartQueryRateLimit(env, chatId);
    if (!allowedByRateLimit) {
      await safeEditOrSend(env, chatId, messageId, lang === "en"
        ? `Querying too frequently. Please try again after ${queryRateLimitSeconds(env)} seconds.`
        : `查询太频繁，请 ${queryRateLimitSeconds(env)} 秒后再试`);
      return;
    }
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en"
        ? `⏳ Checking latest firmware…\n\nModel: ${model}\nCSC: ${csc}`
        : `⏳ 正在查询最新固件…\n\n机型：${model}\n地区：${csc}`
    );
    runBackground(ctx, handleManualQuery(env, chatId, `${model} ${csc}`, {
      identity,
      ctx,
      query: { model, csc },
      targetMessageId: messageId,
      silentPlaceholder: true
    }));
    return;
  }

  if (data.startsWith("csc:more:")) {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin" && identity !== "allowed") {
      await safeEditOrSend(env, chatId, messageId, "你没有权限执行此操作。");
      return;
    }
    const [, , pageValue, model, requestedCsc] = data.split(":");
    if (!model || !requestedCsc) return;
    const page = Math.max(0, Number(pageValue) || 0);
    const lang = await getUserLanguage(env, chatId);
    const options = await loadOfficialCscSuggestions(env, model, requestedCsc, identity);
    const ranked = rankOfficialCscOptions(options, { model, requestedCsc, lang });
    if (!ranked.length) {
      await safeEditOrSend(env, chatId, messageId, lang === "en"
        ? `No additional official CSC records are currently available for ${model}.`
        : `暂未从三星官方 SmartHistory 读取到 ${model} 的其他有效 CSC。`, {
          inline_keyboard: [[{ text: lang === "en" ? "Back to home" : "返回首页", callback_data: "menu:home" }]]
        });
      return;
    }
    const maxPage = Math.max(0, Math.ceil(ranked.length / CSC_SUGGESTION_PAGE_SIZE) - 1);
    const safePage = Math.min(page, maxPage);
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      cscSuggestionText(model, requestedCsc, ranked, lang, { expanded: true, page: safePage }),
      cscSuggestionKeyboard(model, requestedCsc, ranked, lang, { expanded: true, page: safePage })
    );
    return;
  }

  if (data.startsWith("query:refresh:")) {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin" && identity !== "allowed") {
      await safeEditOrSend(env, chatId, messageId, "你没有权限执行此操作。");
      return;
    }
    const [, , model, csc] = data.split(":");
    if (!model || !csc) return;
    const lang = await getUserLanguage(env, chatId);
    if (!await enforceInteractiveQueryLimits(env, chatId, identity, model, lang, messageId)) return;
    const progressText = lang === "en"
      ? `⏳ Checking latest firmware…\n\nModel: ${model}\nCSC: ${csc}`
      : `⏳ 正在查询最新固件…\n\n机型：${model}\n地区：${csc}`;
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      progressText,
      firmwareResultKeyboard(model, csc, lang, identity)
    );
    runBackground(ctx, handleManualQuery(env, chatId, `${model} ${csc}`, {
      identity,
      ctx,
      refresh: true,
      targetMessageId: messageId,
      silentPlaceholder: true
    }));
    return;
  }

  if (data === "guide:zh" || data === "guide:en") {
    const identity = await getIdentity(env, chatId);
    const lang = data.endsWith(":en") ? "en" : "zh";
    await setUserLanguage(env, chatId, lang);
    await safeEditOrSend(env, chatId, messageId, guideText(identity, lang), mainMenuKeyboard(identity, lang));
    return;
  }

  if (data === "lang:zh" || data === "lang:en") {
    const lang = data.endsWith(":en") ? "en" : "zh";
    await setUserLanguage(env, chatId, lang);
    const identity = await getIdentity(env, chatId);
     await safeEditOrSend(env, chatId, messageId, await mainMenuText(env, identity, lang), mainMenuKeyboard(identity, lang));
    return;
  }

  if (data.startsWith("access:approve:") || data.startsWith("access:reject:")) {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin") {
      await sendTelegramMessage(env, chatId, "你没有权限执行此操作。");
      return;
    }
    const [, action, targetId] = data.split(":");
    if (action === "approve") await approveRequestById(env, chatId, targetId, messageId);
    else await rejectRequestById(env, chatId, targetId, messageId);
  }

  if (data.startsWith("ack:")) {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin") {
      await sendTelegramMessage(env, chatId, "你没有权限执行此操作。");
      return;
    }
    const lang = await getUserLanguage(env, chatId);
    await safeEditOrSend(env, chatId, messageId, staleMonitorActionText(lang), monitorMenuKeyboard(lang));
    return;
  }

  if (data.startsWith("monitor-update:")) {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin") {
      await sendTelegramMessage(env, chatId, "你没有权限执行此操作。");
      return;
    }
    const lang = await getUserLanguage(env, chatId);
    await safeEditOrSend(env, chatId, messageId, staleMonitorActionText(lang), monitorMenuKeyboard(lang));
    return;
  }

  if (data.startsWith("flagship:") || data.startsWith("monitor-item:")) {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin") {
      await sendTelegramMessage(env, chatId, "你没有权限执行此操作。");
      return;
    }
    await handlePriorityLifecycleCallback(env, chatId, messageId, data);
    return;
  }

  if (data.startsWith("rollout:")) {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin") {
      await sendTelegramMessage(env, chatId, "\u4f60\u6ca1\u6709\u6743\u9650\u6267\u884c\u6b64\u64cd\u4f5c\u3002");
      return;
    }
    const [, decision, proposalId] = data.split(":");
    const lang = await getUserLanguage(env, chatId);
    const result = await applyRolloutProposalDecision(env, proposalId, decision, chatId);
    if (!result.ok) {
      await safeEditOrSend(env, chatId, messageId, lang === "en" ? "This rollout action has already been handled or needs configuration." : "\u8be5\u53d1\u5e03\u94fe\u64cd\u4f5c\u5df2\u5904\u7406\uff0c\u6216\u8fd8\u672a\u5b8c\u6210\u914d\u7f6e\u3002", adminMenuKeyboard(lang));
      return;
    }
    if (result.decision === "skip") {
      await safeEditOrSend(env, chatId, messageId, lang === "en" ? "Kept the current region. This update will not advance the rollout." : "\u5df2\u4fdd\u6301\u5f53\u524d\u5730\u533a\uff0c\u672c\u6b21\u66f4\u65b0\u4e0d\u63a8\u8fdb\u53d1\u5e03\u94fe\u3002", adminMenuKeyboard(lang));
      return;
    }
    const text = lang === "en"
      ? `Rollout advanced.\n\nNext: ${result.next?.name || "chain complete"}${result.starter ? `\nAlso started: ${result.starter.name}` : ""}`
      : `\u53d1\u5e03\u94fe\u5df2\u63a8\u8fdb\u3002\n\n\u4e0b\u4e00\u9636\u6bb5\uff1a${result.next?.name || "\u672c\u8f6e\u5b8c\u6210"}${result.starter ? `\n\u540c\u65f6\u542f\u52a8\uff1a${result.starter.name}` : ""}`;
    await safeEditOrSend(env, chatId, messageId, text, adminMenuKeyboard(lang));
    return;
  }

  if (data.startsWith("admin:")) {
    const identity = await getIdentity(env, chatId);
    if (identity !== "admin") {
      await sendTelegramMessage(env, chatId, "You do not have permission to perform this action.");
      return;
    }
    await handleAdminCallback(env, chatId, messageId, data, ctx);
  }
}

async function handleAdminCallback(env, chatId, messageId, data, ctx = null) {
  const lang = await getUserLanguage(env, chatId);
  if (data === "admin:dl:new") {
    await beginAdminDownloadInput(env, chatId);
    await safeEditOrSend(env, chatId, messageId, lang === "en"
      ? "Send: MODEL CSC [VERSION]\nExample: SM-S9480 CHC\n\nThe bot checks Samsung first. You confirm before downloading."
      : "发送：型号 CSC [版本]\n例如：SM-S9480 CHC\n\n机器人会先验证三星官方固件，确认后才下载。", { inline_keyboard: [[{ text: enBack(lang), callback_data: "admin:download-menu" }]] });
    return;
  }
  if (data === "admin:dl:confirm") {
    runBackground(ctx, confirmAdminFirmwareDownload(env, chatId, messageId));
    return;
  }
  if (data === "admin:dl:discard") {
    await clearAdminDownloadInput(env, chatId);
    await renderDownloadMenu(env, chatId, messageId);
    return;
  }
  if (data.startsWith("admin:dl:view:") || data.startsWith("admin:dl:refresh:")) {
    const id = data.split(":").at(-1);
    await renderDownloadDetails(env, chatId, messageId, id);
    return;
  }
  if (data.startsWith("admin:dl:pause:")) {
    const id = data.slice("admin:dl:pause:".length);
    const result = await pauseFirmwareDownload(env, id);
    if (!result.ok) await sendTelegramMessage(env, chatId, lang === "en" ? `Pause failed: ${result.error || "task is no longer active"}` : `暂停失败：${result.error || "任务已不在下载中"}`);
    await renderDownloadDetails(env, chatId, messageId, id);
    return;
  }
  if (data.startsWith("admin:dl:resume:")) {
    const id = data.slice("admin:dl:resume:".length);
    const result = await resumeFirmwareDownload(env, id);
    if (!result.ok) await sendTelegramMessage(env, chatId, lang === "en" ? `Resume failed: ${result.error || "another task is active"}` : `继续下载失败：${result.error || "已有其他任务在运行"}`);
    await renderDownloadDetails(env, chatId, messageId, id);
    return;
  }
  if (data.startsWith("admin:dl:stop:")) {
    const id = data.slice("admin:dl:stop:".length);
    const result = await cancelFirmwareDownload(env, id);
    if (!result.ok) await sendTelegramMessage(env, chatId, lang === "en" ? `Terminate failed: ${result.error || "task already finished"}` : `终止失败：${result.error || "任务可能已结束"}`);
    await renderDownloadDetails(env, chatId, messageId, id);
    return;
  }
  if (data.startsWith("admin:dl:deleteok:")) {
    const id = data.slice("admin:dl:deleteok:".length);
    const result = await deleteFirmwareDownload(env, id);
    if (!result.ok) {
      await safeEditOrSend(env, chatId, messageId, lang === "en" ? `Delete failed: ${result.error || "task is still active"}` : `删除失败：${result.error || "任务仍在运行"}`, { inline_keyboard: [[{ text: lang === "en" ? "Back" : "返回", callback_data: `admin:dl:view:${id}` }]] });
      return;
    }
    await renderDownloadMenu(env, chatId, messageId);
    return;
  }
  if (data.startsWith("admin:dl:delete:")) {
    const id = data.slice("admin:dl:delete:".length);
    await safeEditOrSend(env, chatId, messageId, lang === "en" ? "Delete this task and its stored partial or completed file? This cannot be undone." : "删除此任务及其已保存的部分或完整固件文件？此操作无法撤销。", { inline_keyboard: [[
      { text: lang === "en" ? "Delete" : "确认删除", callback_data: `admin:dl:deleteok:${id}` },
      { text: lang === "en" ? "Cancel" : "取消", callback_data: `admin:dl:view:${id}` }
    ]] });
    return;
  }
  if (data === "admin:download-menu") {
    await renderDownloadMenu(env, chatId, messageId);
    return;
  }
  if (data === "admin:download-new") {
    await beginAdminDownloadInput(env, chatId);
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en"
        ? "Send: MODEL CSC [VERSION]\nExample: SM-S938B CHC\nLeave VERSION empty to use the latest exact Samsung SmartHistory version."
        : "发送：型号 CSC [版本]\n例如：SM-S938B CHC\n不填写版本时，使用三星 SmartHistory 返回的最新精确版本。",
      { inline_keyboard: [[{ text: enBack(lang), callback_data: "admin:download-menu" }]] }
    );
    return;
  }
  if (data.startsWith("admin:download-cancel:")) {
    const id = data.slice("admin:download-cancel:".length);
    const cancelled = await cancelFirmwareDownload(env, id);
    await renderDownloadMenu(env, chatId, messageId);
    if (!cancelled.ok) {
      await sendTelegramMessage(env, chatId, lang === "en" ? `Cancel failed: ${cancelled.error || "job already finished"}` : `取消失败：${cancelled.error || "任务可能已完成"}`);
    }
    return;
  }
  if (data.startsWith("admin:download-start:")) {
    const [, , model, csc] = data.split(":");
    if (!model || !csc) return;
    runBackground(ctx, startAdminFirmwareDownload(env, chatId, { model, csc }, { messageId }));
    return;
  }
  if (data === "admin:rollout-menu") {
    await renderRolloutMenu(env, chatId, messageId);
    return;
  }
  if (data.startsWith("admin:rollout-interval:")) {
    const [, , chainId, minutes] = data.split(":");
    await setRolloutChainSettings(env, chainId, { intervalMinutes: Number(minutes) });
    await renderRolloutChain(env, chatId, messageId, chainId);
    return;
  }
  if (data.startsWith("admin:rollout-time:")) {
    const [, , chainId, startTime, endTime] = data.split(":");
    await setRolloutChainSettings(env, chainId, { startTime, endTime });
    await renderRolloutChain(env, chatId, messageId, chainId);
    return;
  }
  if (data.startsWith("admin:rollout-enable:")) {
    const [, , chainId, value] = data.split(":");
    try {
      await setRolloutChainSettings(env, chainId, { enabled: value === "on" });
      await renderRolloutChain(env, chatId, messageId, chainId);
    } catch (error) {
      await safeEditOrSend(env, chatId, messageId, String(error.message || error), { inline_keyboard: [[{ text: lang === "en" ? "Back" : "\u8fd4\u56de", callback_data: `admin:rollout:${chainId}` }]] });
    }
    return;
  }
  if (data.startsWith("admin:rollout-restart:")) {
    if (!await requireOwner(env, chatId)) return;
    const chainId = data.slice("admin:rollout-restart:".length);
    try {
      await restartDependentRolloutChain(env, chainId);
      await renderRolloutChain(env, chatId, messageId, chainId);
    } catch (error) {
      await safeEditOrSend(env, chatId, messageId, String(error.message || error), { inline_keyboard: [[{ text: lang === "en" ? "Back" : "返回", callback_data: `admin:rollout:${chainId}` }]] });
    }
    return;
  }
  if (data.startsWith("admin:rollout:")) {
    const chainId = data.slice("admin:rollout:".length);
    await renderRolloutChain(env, chatId, messageId, chainId);
    return;
  }
  if (data === "admin:admins") {
    await renderAdminsPanel(env, chatId, messageId);
    return;
  }
  if (data.startsWith("admin:admin-remove:")) {
    if (!await requireOwner(env, chatId)) return;
    const targetId = data.slice("admin:admin-remove:".length);
    const result = await removeAdditionalAdmin(env, targetId);
    const text = result.removed
      ? (lang === "en" ? "Administrator removed." : "\u5df2\u79fb\u9664\u7ba1\u7406\u5458\u3002")
      : (lang === "en" ? "This administrator cannot be removed." : "\u65e0\u6cd5\u79fb\u9664\u8be5\u7ba1\u7406\u5458\u3002");
    await safeEditOrSend(env, chatId, messageId, text, { inline_keyboard: [[{ text: lang === "en" ? "Back" : "\u8fd4\u56de", callback_data: "admin:admins" }]] });
    return;
  }
  if (data.startsWith("admin:cache-target:")) {
    const [, , model, csc] = data.split(":");
    if (!model || !csc) return;
    await Promise.all([
      deleteUserQueryCache(env, chatId, model, csc),
      deleteGlobalQueryCache(env, model, csc),
      deleteFirmwareQueryCache(env, model, csc)
    ]);
    deleteL1Firmware(model, csc);
    deleteFirmwareMemoryCache(model, csc);
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en" ? `Cache cleared for ${model} / ${csc}.` : `已清理 ${model} / ${csc} 的查询缓存。`,
      {
        inline_keyboard: [[
          { text: lang === "en" ? "Realtime query" : "重新实时查询", callback_data: `query:refresh:${model}:${csc}` },
          { text: lang === "en" ? "Back" : "返回主菜单", callback_data: "menu:home" }
        ]]
      }
    );
    return;
  }

  if (data === "admin:monitor-menu") {
    const panel = await formatMonitorCenterPanel(env, lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data === "admin:monitor-more") {
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en" ? "Monitoring settings" : "监控设置",
      monitorMoreKeyboard(lang)
    );
    return;
  }

  if (data === "admin:monitor-health") {
    const panel = await formatMonitorHealthPanel(env, lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data === "admin:monitor-events") {
    const panel = monitorEventsPanel(await getMonitorEvents(env, 20), lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data.startsWith("admin:monitor-filter:")) {
    const filter = data.slice("admin:monitor-filter:".length);
    const selected = new Set(["all", "active", "updated", "paused", "awaiting", "failing"]);
    const panel = await formatMonitorCenterPanel(env, lang, selected.has(filter) ? filter : "all");
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data === "admin:monitor-retry-failed") {
    const items = standardMonitorItems(await getMonitorItems(env));
    let queued = 0;
    for (const item of items) {
      if (item.enabled === false) continue;
      const runtime = await getMonitorRuntime(env, item.model, item.csc);
      if (Number(runtime.failureCount || 0) <= 0) continue;
      await forceMonitorDue(env, item.model, item.csc);
      queued += 1;
    }
    const panel = await formatMonitorCenterPanel(env, lang, "failing");
    const notice = lang === "en"
      ? `\u2705 ${queued} failing monitoring target${queued === 1 ? " has" : "s have"} been queued for retry. The scheduler will run them safely.`
      : `\u2705 \u5df2\u5c06 ${queued} \u4e2a\u5931\u8d25\u76d1\u63a7\u8bbe\u5907\u91cd\u65b0\u6392\u961f\u3002\u8c03\u5ea6\u5668\u4f1a\u6309\u7167\u5e76\u53d1\u9650\u5236\u5b89\u5168\u6267\u884c\u3002`;
    await safeEditOrSend(env, chatId, messageId, `${notice}\n\n${panel.text}`, panel.replyMarkup);
    return;
  }

  if (data === "admin:monitor-delete-all") {
    const items = standardMonitorItems(await getMonitorItems(env));
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en"
        ? `Delete all ${items.length} regular monitoring targets? Rollout-chain targets are protected.`
        : `\u786e\u8ba4\u5220\u9664\u5168\u90e8 ${items.length} \u4e2a\u666e\u901a\u76d1\u63a7\u8bbe\u5907\uff1f\u53d1\u5e03\u94fe\u76ee\u6807\u4e0d\u4f1a\u88ab\u5220\u9664\u3002`,
      {
        inline_keyboard: [
          [{ text: lang === "en" ? "Continue" : "\u7ee7\u7eed\u786e\u8ba4", callback_data: "admin:monitor-delete-all-confirm" }],
          [{ text: lang === "en" ? "Cancel" : "\u53d6\u6d88", callback_data: "admin:monitor-menu" }]
        ]
      }
    );
    return;
  }

  if (data === "admin:monitor-delete-all-confirm") {
    await beginDeleteAllMonitorConfirmation(env, chatId);
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en"
        ? "Final confirmation required\n\nSend exactly: DELETE ALL\n\nThe confirmation expires in 10 minutes."
        : "\u9700\u8981\u6700\u7ec8\u786e\u8ba4\n\n\u8bf7\u5728\u804a\u5929\u4e2d\u51c6\u786e\u8f93\u5165\uff1a\u5220\u9664\u5168\u90e8\n\n\u786e\u8ba4\u5c06\u5728 10 \u5206\u949f\u540e\u81ea\u52a8\u5931\u6548\u3002",
      {
        inline_keyboard: [[{ text: lang === "en" ? "Cancel deletion" : "\u53d6\u6d88\u5220\u9664", callback_data: "admin:monitor-delete-all-cancel" }]]
      }
    );
    return;
  }

  if (data === "admin:monitor-delete-all-cancel") {
    const confirmation = await getDeleteAllMonitorConfirmation(env, chatId);
    await clearDeleteAllMonitorConfirmation(env, chatId);
    const panel = await formatMonitorCenterPanel(env, lang);
    const notice = confirmation
      ? (lang === "en" ? "Deletion cancelled." : "\u5df2\u53d6\u6d88\u5220\u9664\u3002")
      : staleMonitorActionText(lang);
    await safeEditOrSend(env, chatId, messageId, `${notice}\n\n${panel.text}`, panel.replyMarkup);
    return;
  }

  if (data === "admin:intervals") {
    const panel = monitorIntervalsPanel(await getMonitorIntervalSettings(env), lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data.startsWith("admin:interval-set:")) {
    const [, , modeValue, minutesValue] = data.split(":");
    const mode = normalizeMonitorIntervalMode(modeValue);
    const minutes = Number(minutesValue);
    if (!mode || !Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      throw new Error("Invalid monitor interval preset");
    }
    const current = await getMonitorIntervalSettings(env);
    const saved = await setMonitorIntervalSettings(env, { ...current, [mode]: Math.floor(minutes) });
    if (!saved.ok) throw new Error("MonitorScheduler interval storage is unavailable");
    const panel = monitorIntervalsPanel(saved.settings, lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data === "admin:interval-reset") {
    const saved = await setMonitorIntervalSettings(env, DEFAULT_MONITOR_INTERVALS);
    if (!saved.ok) throw new Error("MonitorScheduler interval storage is unavailable");
    const panel = monitorIntervalsPanel(saved.settings, lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data.startsWith("admin:interval:")) {
    const mode = normalizeMonitorIntervalMode(data.split(":")[2]);
    if (!mode) throw new Error("Invalid monitor interval mode");
    const panel = monitorIntervalPresetPanel(mode, await getMonitorIntervalSettings(env), lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data === "admin:monitor-add-help") {
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en"
        ? "Send a Model / CSC to query firmware first, then tap Monitor target below the result.\n\nFallback command: /add 9480 CHC Name"
        : "请先发送 Model / CSC 查询固件，再点击结果下方的“加入 / 查看监控”。\n\n备用命令：/add 9480 CHC 设备名称",
      monitorMenuKeyboard(lang)
    );
    return;
  }

  if (data === "admin:access-menu") {
    const [settings, requests, users] = await Promise.all([
      getAccessSettings(env),
      getAccessRequests(env),
      getAllowedUsers(env)
    ]);
    await safeEditOrSend(env, chatId, messageId, accessMenuText(settings, requests.length, users.length, lang), accessMenuKeyboard(settings, lang));
    return;
  }

  if (data === "admin:user-add-help") {
    const settings = await getAccessSettings(env);
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en"
        ? "Reply to a user's message with /useradd, or send /useradd <Chat ID> <name>."
        : "回复用户消息发送 /useradd，或发送 /useradd <Chat ID> <备注>。",
      accessMenuKeyboard(settings, lang)
    );
    return;
  }

  if (data === "admin:performance") {
    const snapshot = await loadPerformanceSnapshot(env, 24);
    await safeEditOrSend(env, chatId, messageId, performancePanel(snapshot.summary, snapshot.budget, lang), {
      inline_keyboard: [
        [{ text: lang === "en" ? "Refresh" : "刷新", callback_data: "admin:performance" }],
        [{ text: lang === "en" ? "Back" : "返回系统设置", callback_data: "admin:system-menu" }]
      ]
    });
    return;
  }

  if (data === "admin:diagnostics") {
    const report = await loadDiagnosticsReport(env);
    await safeEditOrSend(env, chatId, messageId, diagnosticsPanel(report, lang), {
      inline_keyboard: [
        [{ text: lang === "en" ? "Run again" : "重新诊断", callback_data: "admin:diagnostics" }],
        [{ text: lang === "en" ? "Back" : "返回系统设置", callback_data: "admin:system-menu" }]
      ]
    });
    return;
  }

  if (data === "admin:system-menu") {
    const settings = await getCacheSettings(env);
    await safeEditOrSend(env, chatId, messageId, systemMenuText(settings, env, lang), systemMenuKeyboard(settings, lang));
    return;
  }

  if (data === "admin:schedule-menu") {
    const [schedule, summarySettings] = await Promise.all([
      getMonitorSchedule(env),
      getMonitorSummarySettings(env)
    ]);
    await safeEditOrSend(env, chatId, messageId, formatSchedule(schedule, lang, summarySettings), scheduleMenuKeyboard(schedule, lang, summarySettings));
    return;
  }

  if (data === "admin:requests") {
    const requests = await getAccessRequests(env);
    if (!requests.length) {
      const settings = await getAccessSettings(env);
      await safeEditOrSend(env, chatId, messageId, lang === "en" ? "No pending whitelist requests." : "当前没有待审批的白名单申请。", accessMenuKeyboard(settings, lang));
      return;
    }

    const settings = await getAccessSettings(env);
    await safeEditOrSend(env, chatId, messageId, lang === "en" ? `Pending whitelist requests: ${requests.length}` : `当前有 ${requests.length} 个待审批白名单申请。`, accessMenuKeyboard(settings, lang));
    for (const request of requests) {
      await sendTelegramMessage(env, chatId, formatAccessRequestNotification(request), accessDecisionKeyboard(request.chatId));
    }
    return;
  }

  if (data === "admin:users") {
    const panel = await formatUsersPanel(env, lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data.startsWith("admin:user-remove-confirm:")) {
    const targetId = data.slice("admin:user-remove-confirm:".length);
    await removeAllowedUser(env, targetId);
    const panel = await formatUsersPanel(env, lang);
    const resultText = lang === "en"
      ? `✅ Access removed for ${targetId}.`
      : `✅ 已移除用户 ${targetId} 的查询权限。`;
    await safeEditOrSend(env, chatId, messageId, `${resultText}\n\n${panel.text}`, panel.replyMarkup);
    return;
  }

  if (data.startsWith("admin:user-remove:")) {
    const targetId = data.slice("admin:user-remove:".length);
    const users = await getAllowedUsers(env);
    const user = users.find((item) => item.chatId === targetId);
    if (!user) {
      const panel = await formatUsersPanel(env, lang);
      await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
      return;
    }
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en" ? `Remove access for ${user.name || targetId}?` : `确认移除 ${user.name || targetId} 的查询权限？`,
      {
        inline_keyboard: [
          [
            { text: lang === "en" ? "Confirm remove" : "确认移除", callback_data: `admin:user-remove-confirm:${targetId}` },
            { text: lang === "en" ? "Cancel" : "取消", callback_data: "admin:users" }
          ],
          [{ text: lang === "en" ? "Home" : "返回首页", callback_data: "menu:home" }]
        ]
      }
    );
    return;
  }

  if (data === "admin:autoapprove:toggle" || data === "admin:autoapprove:60" || data === "admin:autoapprove:1440") {
    const current = await getAccessSettings(env);
    const minutes = data === "admin:autoapprove:60" ? 60 : data === "admin:autoapprove:1440" ? 1440 : 0;
    const enabled = minutes > 0 ? true : !current.autoApprove;
    const expiresAt = enabled && minutes ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : "";
    await setAccessAutoApprove(env, enabled, expiresAt);
    const [settings, requests, users] = await Promise.all([
      getAccessSettings(env),
      getAccessRequests(env),
      getAllowedUsers(env)
    ]);
    const resultText = lang === "en"
      ? (settings.autoApprove
          ? `✅ Saved: auto approval enabled${minutes ? ` for ${minutes === 60 ? "60 minutes" : "24 hours"}` : ""}.`
          : "✅ Saved: auto approval disabled.")
      : (settings.autoApprove
          ? `✅ 设置已保存：自动审批已开启${minutes ? `（${minutes === 60 ? "60 分钟" : "24 小时"}）` : ""}。`
          : "✅ 设置已保存：自动审批已关闭。");
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      `${resultText}\n\n${accessMenuText(settings, requests.length, users.length, lang)}`,
      accessMenuKeyboard(settings, lang)
    );
    return;
  }

  if (data === "admin:autoapprove:on") {
    await setAccessAutoApprove(env, true);
    await safeEditOrSend(env, chatId, messageId, formatAutoApproveStatus(await getAccessSettings(env)), adminMenuKeyboard(lang));
    return;
  }

  if (data === "admin:autoapprove:off") {
    await setAccessAutoApprove(env, false);
    await safeEditOrSend(env, chatId, messageId, formatAutoApproveStatus(await getAccessSettings(env)), adminMenuKeyboard(lang));
    return;
  }

  if (data === "admin:realtime:on" || data === "admin:realtime:off") {
    const enabled = data.endsWith(":on");
    const settings = await setCacheSettings(env, { adminRealtimeEnabled: enabled }, chatId);
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en"
        ? `Admin realtime query is now ${enabled ? "ON" : "OFF"}.\n\nWhen ON, admin manual queries skip user/global cache.`
        : `管理员实时查询已${enabled ? "开启" : "关闭"}。\n\n开启后，管理员手动查询会跳过全部固件查询缓存。`,
      adminMenuKeyboard(lang)
    );
    return;
  }

  if (data === "admin:realtime:toggle" || data === "admin:cache:toggle") {
    const current = await getCacheSettings(env);
    const patch = data === "admin:realtime:toggle"
      ? { adminRealtimeEnabled: !current.adminRealtimeEnabled }
      : { enabled: current.enabled === false };
    const settings = await setCacheSettings(env, patch, chatId);
    const enabled = data === "admin:realtime:toggle" ? settings.adminRealtimeEnabled : settings.enabled !== false;
    const settingName = data === "admin:realtime:toggle"
      ? (lang === "en" ? "admin realtime queries" : "管理员实时查询")
      : (lang === "en" ? "query cache" : "查询缓存");
    const resultText = lang === "en"
      ? `✅ Saved: ${settingName} ${enabled ? "enabled" : "disabled"}.`
      : `✅ 设置已保存：${settingName}已${enabled ? "开启" : "关闭"}。`;
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      `${resultText}\n\n${systemMenuText(settings, env, lang)}`,
      systemMenuKeyboard(settings, lang)
    );
    return;
  }

  if (data === "admin:cache-clear:confirm") {
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en" ? "Clear all firmware query caches? This cannot be undone." : "确认清理全部固件查询缓存？此操作无法撤销。",
      {
        inline_keyboard: [
          [
            { text: lang === "en" ? "Confirm clear" : "确认清理", callback_data: "admin:cache-clear:execute" },
            { text: lang === "en" ? "Cancel" : "取消", callback_data: "admin:system-menu" }
          ],
          [{ text: lang === "en" ? "Home" : "返回首页", callback_data: "menu:home" }]
        ]
      }
    );
    return;
  }

  if (data === "admin:cache-clear:execute") {
    const cleared = await clearAllQueryCaches(env);
    const settings = await getCacheSettings(env);
    const text = lang === "en"
      ? `Cache cleanup completed.\n\nAuthoritative: ${cleared.canonical}\nLegacy global: ${cleared.global}\nLegacy user: ${cleared.user}`
      : `缓存清理完成。\n\nHistory 统一缓存：${cleared.canonical}\n旧全局缓存：${cleared.global}\n旧用户缓存：${cleared.user}`;
    await safeEditOrSend(env, chatId, messageId, text, systemMenuKeyboard(settings, lang));
    return;
  }

  if (data === "admin:monitors") {
    const panel = await formatMonitorCenterPanel(env, lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data === "admin:high") {
    const panel = await formatHighPriorityPanel(env, lang);
    await safeEditOrSend(env, chatId, messageId, panel.text, panel.replyMarkup);
    return;
  }

  if (data === "admin:checknow") {
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en" ? "Monitor check started. Progress will update here." : "✅ 已启动监控检查，进度会在本消息中更新。",
      monitorMenuKeyboard(lang)
    );
    let lastRendered = "";
    const task = runMonitor(env, {
      reason: "admin_button_checknow",
      onProgress: async (summary) => {
        const text = formatMonitorProgress(summary, lang);
        if (text === lastRendered) return;
        lastRendered = text;
        await safeEditOrSend(env, chatId, messageId, text, monitorMenuKeyboard(lang));
      }
    }).then(async (summary) => {
      const panel = await formatMonitorCenterPanel(env, lang);
      return safeEditOrSend(
        env,
        chatId,
        messageId,
        `${formatCheckNow(summary, lang)}\n\n${panel.text}`,
        panel.replyMarkup
      );
    });
    runBackground(ctx, task);
    return;
  }

  if (data === "admin:schedule") {
    const [schedule, summarySettings] = await Promise.all([
      getMonitorSchedule(env),
      getMonitorSummarySettings(env)
    ]);
    await safeEditOrSend(env, chatId, messageId, formatSchedule(schedule, lang, summarySettings), scheduleMenuKeyboard(schedule, lang, summarySettings));
    return;
  }

  if (data === "admin:schedule:summary-toggle") {
    const current = await getMonitorSummarySettings(env);
    const updated = await setMonitorSummarySettings(env, {
      ...current,
      enabled: current.enabled === false
    }, chatId);
    const schedule = await getMonitorSchedule(env);
    const resultText = lang === "en"
      ? `✅ Saved: daily admin summary ${updated.enabled ? `enabled at ${String(updated.hour).padStart(2, "0")}:00 Beijing Time` : "disabled"}.`
      : `✅ 设置已保存：每日管理员摘要已${updated.enabled ? `开启（${String(updated.hour).padStart(2, "0")}:00 北京时间）` : "关闭"}。`;
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      `${resultText}\n\n${formatSchedule(schedule, lang, updated)}`,
      scheduleMenuKeyboard(schedule, lang, updated)
    );
    return;
  }

  if (["admin:schedule:toggle", "admin:schedule:weekend", "admin:schedule:all-day", "admin:schedule:daytime"].includes(data)) {
    const schedule = await getMonitorSchedule(env);
    if (data === "admin:schedule:toggle") schedule.enabled = schedule.enabled === false;
    if (data === "admin:schedule:weekend") schedule.skipWeekends = schedule.skipWeekends !== true;
    if (data === "admin:schedule:all-day") Object.assign(schedule, { startTime: "00:00", endTime: "23:59" });
    if (data === "admin:schedule:daytime") Object.assign(schedule, { startTime: "08:00", endTime: "23:59" });
    const [updated, summarySettings] = await Promise.all([
      setMonitorSchedule(env, schedule),
      getMonitorSummarySettings(env)
    ]);
    const resultText = {
      "admin:schedule:toggle": lang === "en"
        ? `✅ Saved: automatic monitoring ${updated.enabled === false ? "paused" : "enabled"}.`
        : `✅ 设置已保存：自动监控已${updated.enabled === false ? "暂停" : "开启"}。`,
      "admin:schedule:weekend": lang === "en"
        ? `✅ Saved: weekend monitoring ${updated.skipWeekends ? "disabled" : "enabled"}.`
        : `✅ 设置已保存：周末监控已${updated.skipWeekends ? "关闭" : "开启"}。`,
      "admin:schedule:all-day": lang === "en"
        ? "✅ Saved: monitoring window set to 00:00-23:59."
        : "✅ 设置已保存：监控时段已改为全天 00:00-23:59。",
      "admin:schedule:daytime": lang === "en"
        ? "✅ Saved: monitoring window set to 08:00-23:59."
        : "✅ 设置已保存：监控时段已改为白天 08:00-23:59。"
    }[data];
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      `${resultText}\n\n${formatSchedule(updated, lang, summarySettings)}`,
      scheduleMenuKeyboard(updated, lang, summarySettings)
    );
    return;
  }

  if (data === "admin:status") {
    await safeEditOrSend(env, chatId, messageId, await formatStatus(env, chatId, "admin", lang), adminMenuKeyboard(lang));
    return;
  }

  if (data === "admin:help") {
    const parts = adminHelpParts(lang);
    await safeEditOrSend(env, chatId, messageId, parts[0], adminMenuKeyboard(lang));
    for (const part of parts.slice(1)) await sendTelegramMessage(env, chatId, part);
    return;
  }
}

function monitorSnoozePresetKeyboard(model, csc, lang = "zh") {
  const en = lang === "en";
  const options = [
    [60, en ? "1 hour" : "1 小时"],
    [180, en ? "3 hours" : "3 小时"],
    [360, en ? "6 hours" : "6 小时"],
    [720, en ? "12 hours" : "12 小时"],
    [1440, en ? "1 day" : "1 天"],
    [4320, en ? "3 days" : "3 天"],
    [10080, en ? "7 days" : "7 天"]
  ];
  return {
    inline_keyboard: [
      options.slice(0, 2).map(([minutes, label]) => ({ text: label, callback_data: `monitor-update:snooze:${minutes}:${model}:${csc}` })),
      options.slice(2, 4).map(([minutes, label]) => ({ text: label, callback_data: `monitor-update:snooze:${minutes}:${model}:${csc}` })),
      options.slice(4, 6).map(([minutes, label]) => ({ text: label, callback_data: `monitor-update:snooze:${minutes}:${model}:${csc}` })),
      [{ text: options[6][1], callback_data: `monitor-update:snooze:${options[6][0]}:${model}:${csc}` }],
      [{ text: en ? "Custom duration" : "自定义时长", callback_data: `monitor-update:snooze-help:${model}:${csc}` }],
      [{ text: en ? "Continue as planned" : "按原计划继续", callback_data: `monitor-update:continue:${model}:${csc}` }]
    ]
  };
}

async function markMonitorUpdateDecisionHandled(env, chatId, model, csc) {
  const pending = await getPendingUpdate(env, model, csc);
  if (!pending) return null;
  try {
    await putAckedUpdate(env, pending, chatId);
  } catch (error) {
    console.log(`Unable to persist update acknowledgement for ${model}/${csc}: ${error.message}`);
  }
  try {
    await deletePendingUpdate(env, model, csc);
  } catch (error) {
    console.log(`Pending update cleanup deferred for ${model}/${csc}: ${error.message}`);
  }
  return pending;
}

function parseSnoozeDuration(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^(\d{1,4})(m|h|d)?$/);
  if (!match) throw new Error("Invalid duration");
  const amount = Number(match[1]);
  const unit = match[2] || "m";
  const minutes = unit === "d" ? amount * 1440 : unit === "h" ? amount * 60 : amount;
  if (!Number.isFinite(minutes) || minutes < 30 || minutes > 30 * 1440) {
    throw new Error("Duration must be between 30 minutes and 30 days");
  }
  return Math.floor(minutes);
}

async function handleMonitorUpdateDecisionCallback(env, chatId, messageId, data) {
  const lang = await getUserLanguage(env, chatId);
  const en = lang === "en";
  const parts = data.split(":");
  const action = parts[1];
  const minutes = action === "snooze" ? Number(parts[2]) : 0;
  const model = action === "snooze" ? parts[3] : parts[2];
  const csc = action === "snooze" ? parts[4] : parts[3];
  if (!model || !csc) {
    await safeEditOrSend(env, chatId, messageId, en ? "Invalid monitoring action." : "监控操作参数无效。");
    return;
  }

  const items = await getMonitorItems(env);
  const existing = items.find((item) => item.model === model && item.csc === csc);
  if (!existing) {
    await safeEditOrSend(env, chatId, messageId, en ? "Monitor target not found." : "未找到该监控设备。", monitorMenuKeyboard(lang));
    return;
  }

  if (action === "snooze-menu") {
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      en
        ? [`⏸ Pause monitoring after this update`, "", `${model} / ${csc}`, "", "Choose when monitoring should resume automatically."].join("\n")
        : [`⏸ 本次更新后暂停监控`, "", `${model} / ${csc}`, "", "请选择多久之后自动恢复监控。"].join("\n"),
      monitorSnoozePresetKeyboard(model, csc, lang)
    );
    return;
  }

  if (action === "snooze-help") {
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      en
        ? [`Custom duration command`, "", `/monsnooze ${model} ${csc} 90m`, `/monsnooze ${model} ${csc} 6h`, `/monsnooze ${model} ${csc} 2d`, "", "Range: 30 minutes to 30 days."].join("\n")
        : [`自定义暂停时长`, "", `/monsnooze ${model} ${csc} 90m`, `/monsnooze ${model} ${csc} 6h`, `/monsnooze ${model} ${csc} 2d`, "", "可设置范围：30 分钟至 30 天。"].join("\n"),
      monitorSnoozePresetKeyboard(model, csc, lang)
    );
    return;
  }

  if (action === "continue") {
    await cancelMonitorItemSnooze(env, model, csc);
    const item = await upsertMonitorItem(env, {
      ...existing,
      enabled: true,
      paused: false,
      pauseReason: "",
      pauseSource: "",
      pausedAt: "",
      resumeAt: "",
      adminDecision: "continue_as_planned"
    });
    const [runtime, intervalSettings] = await Promise.all([
      getMonitorRuntime(env, model, csc),
      getMonitorIntervalSettings(env)
    ]);
    const intervalMinutes = Number(item.intervalMinutes) > 0
      ? Number(item.intervalMinutes)
      : priorityIntervalMinutes(runtime.priorityScore, intervalSettings);
    await restoreMonitorOriginalPlan(env, model, csc, new Date(Date.now() + intervalMinutes * 60 * 1000));
    await markMonitorUpdateDecisionHandled(env, chatId, model, csc);
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      en
        ? [`✅ Monitoring will continue as planned`, "", `${item.model} / ${item.csc}`, `Priority: ${String(item.priority || "normal").toUpperCase()}`, "The existing interval settings remain unchanged."].join("\n")
        : [`✅ 将按原计划继续监控`, "", `${item.model} / ${item.csc}`, `优先级：${String(item.priority || "normal").toUpperCase()}`, "原有监控间隔保持不变。"].join("\n"),
      (await formatMonitorItemPanel(env, model, csc, lang))?.replyMarkup || monitorMenuKeyboard(lang)
    );
    return;
  }

  if (action === "snooze") {
    if (!Number.isFinite(minutes) || minutes < 30 || minutes > 30 * 1440) {
      await safeEditOrSend(env, chatId, messageId, en ? "Invalid pause duration." : "暂停时长无效。", monitorSnoozePresetKeyboard(model, csc, lang));
      return;
    }
    const resumeAt = new Date(Date.now() + minutes * 60 * 1000);
    const pending = await getPendingUpdate(env, model, csc);
    const result = await snoozeMonitorItem(env, model, csc, resumeAt, {
      requestedBy: chatId,
      updateVersion: pending?.newLatest || ""
    });
    if (!result?.ok) {
      await safeEditOrSend(env, chatId, messageId, en ? "Unable to pause this monitor target." : "无法暂停该监控设备。", monitorMenuKeyboard(lang));
      return;
    }
    await markMonitorUpdateDecisionHandled(env, chatId, model, csc);
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      en
        ? [`⏸ Monitoring paused temporarily`, "", `${model} / ${csc}`, `Resume at: ${formatBeijingTime(resumeAt, "en")}`, "", "The bot will notify the administrator when monitoring resumes."].join("\n")
        : [`⏸ 已临时暂停监控`, "", `${model} / ${csc}`, `自动恢复时间：${formatBeijingTime(resumeAt, "zh")}`, "", "恢复监控时机器人会通知管理员。"].join("\n"),
      {
        inline_keyboard: [
          [{ text: en ? "Resume now" : "立即恢复", callback_data: `monitor-item:resume:${model}:${csc}` }],
          [{ text: en ? "View target" : "查看设备", callback_data: `monitor-item:view:${model}:${csc}` }],
          [{ text: en ? "Home" : "返回首页", callback_data: "menu:home" }]
        ]
      }
    );
    return;
  }

  await safeEditOrSend(env, chatId, messageId, en ? "Unsupported monitoring action." : "不支持的监控操作。", monitorMenuKeyboard(lang));
}

async function handlePriorityLifecycleCallback(env, chatId, messageId, data) {
  const lang = await getUserLanguage(env, chatId);
  if (data.startsWith("flagship:")) {
    const [, decision, proposalId] = data.split(":");
    const result = await applyFlagshipProposalDecision(env, proposalId, decision);
    if (!result.ok) {
      const message = result.reason === "already_decided"
        ? (lang === "en" ? "This decision has already been processed." : "这个确认已经处理过了。")
        : (lang === "en" ? "The priority request is missing or expired." : "该优先级确认不存在或已过期。");
      await safeEditOrSend(env, chatId, messageId, message, adminMenuKeyboard(lang));
      return;
    }
    if (result.decision === "skip") {
      await safeEditOrSend(
        env,
        chatId,
        messageId,
        lang === "en" ? "No monitoring changes were made." : "已暂不处理，没有修改监控设备。",
        adminMenuKeyboard(lang)
      );
      return;
    }
    const actionLabel = {
      approve: lang === "en" ? "Promoted and added" : "已添加并提升为高优先级",
      normal: lang === "en" ? "Restored to NORMAL" : "已恢复普通优先级",
      keep: lang === "en" ? "Kept at HIGH" : "已继续保持高优先级",
      pause: lang === "en" ? "Monitoring paused (configuration kept)" : "已暂停监控（配置仍保留）"
    }[result.decision] || result.decision;
    const lines = result.items.map((item) => `${item.model} / ${item.csc} · ${item.priority} · ${item.enabled === false ? "paused" : "active"}`);
    const panel = await formatHighPriorityPanel(env, lang);
    await safeEditOrSend(env, chatId, messageId, [`✅ ${actionLabel}`, "", ...lines, "", panel.text].join("\n"), panel.replyMarkup);
    return;
  }

  const [, action, model, csc] = data.split(":");
  let items = await getMonitorItems(env);
  let existing = items.find((item) => item.model === model && item.csc === csc);
  let added = false;
  if (action === "add" && !existing) {
    try {
      existing = await upsertMonitorItem(env, {
        model,
        csc,
        name: `${model} ${csc}`,
        priority: "normal",
        enabled: true
      });
      added = true;
    } catch (error) {
      await safeEditOrSend(env, chatId, messageId, `${lang === "en" ? "Unable to add monitor target" : "添加监控设备失败"}：${error.message}`, monitorMenuKeyboard(lang));
      return;
    }
  }
  if (!existing) {
    await safeEditOrSend(env, chatId, messageId, lang === "en" ? "Monitor target not found." : "未找到该监控设备。", monitorMenuKeyboard(lang));
    return;
  }

  if (isRolloutManagedMonitor(existing) && action !== "view") {
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en" ? "This target is managed by its rollout chain." : "该设备由发布链管理，不能在普通监控中修改。",
      { inline_keyboard: [[{ text: lang === "en" ? "View rollout" : "查看发布链", callback_data: `admin:rollout:${existing.rolloutChainId}` }]] }
    );
    return;
  }

  if (action === "add" || action === "view") {
    const panel = await formatMonitorItemPanel(env, model, csc, lang);
    const text = added
      ? `${lang === "en" ? "✅ Monitor target added." : "✅ 已加入监控设备。"}\n\n${panel.text}`
      : panel.text;
    await safeEditOrSend(env, chatId, messageId, text, panel.replyMarkup);
    return;
  }

  if (action === "delete-request") {
    await safeEditOrSend(
      env,
      chatId,
      messageId,
      lang === "en"
        ? `Delete ${model} / ${csc} from monitoring? This cannot be undone.`
        : `确认删除监控设备 ${model} / ${csc}？此操作无法撤销。`,
      {
        inline_keyboard: [
          [
            { text: lang === "en" ? "Confirm delete" : "确认删除", callback_data: `monitor-item:delete-confirm:${model}:${csc}` },
            { text: lang === "en" ? "Cancel" : "取消", callback_data: `monitor-item:view:${model}:${csc}` }
          ],
          [{ text: lang === "en" ? "Home" : "返回首页", callback_data: "menu:home" }]
        ]
      }
    );
    return;
  }

  if (action === "delete-confirm") {
    await removeMonitorItem(env, model, csc);
    const panel = await formatMonitorPanel(env, lang);
    const resultText = lang === "en"
      ? `✅ Deleted ${model} / ${csc} from monitoring.`
      : `✅ 已删除监控设备 ${model} / ${csc}。`;
    await safeEditOrSend(env, chatId, messageId, `${resultText}\n\n${panel.text}`, panel.replyMarkup);
    return;
  }

  if (action === "notify-users") {
    const enabled = existing.notifyAllowedUsers === false;
    await upsertMonitorItem(env, { ...existing, notifyAllowedUsers: enabled });
    const panel = await formatMonitorItemPanel(env, model, csc, lang);
    const resultText = lang === "en"
      ? `✅ Allowed-user update notifications are now ${enabled ? "ON" : "OFF"} for ${model} / ${csc}.`
      : `✅ ${model} / ${csc} 的授权用户更新通知已${enabled ? "开启" : "关闭"}。`;
    await safeEditOrSend(env, chatId, messageId, `${resultText}\n\n${panel.text}`, panel.replyMarkup);
    return;
  }

  await cancelMonitorItemSnooze(env, model, csc);
  const patch = { ...existing };
  const clearTimedPause = { resumeAt: "", pausedAt: "", pauseSource: "" };
  if (action === "pause") {
    Object.assign(patch, clearTimedPause, { enabled: false, paused: true, pauseReason: "admin_pause", adminDecision: "paused" });
  } else if (action === "resume") {
    Object.assign(patch, clearTimedPause, { enabled: true, paused: false, priority: existing.priority || "normal", pauseReason: "" });
  } else if (action === "normal") {
    Object.assign(patch, clearTimedPause, { enabled: true, paused: false, priority: "normal", pauseReason: "", adminDecision: "normal" });
  } else if (action === "high") {
    Object.assign(patch, clearTimedPause, { enabled: true, paused: false, priority: "high", pauseReason: "", adminDecision: "keep_high" });
  } else if (action === "low") {
    Object.assign(patch, clearTimedPause, { enabled: true, paused: false, priority: "low", pauseReason: "", adminDecision: "low" });
  } else {
    await safeEditOrSend(env, chatId, messageId, lang === "en" ? "Unsupported action." : "不支持的操作。", monitorMenuKeyboard(lang));
    return;
  }
  await upsertMonitorItem(env, patch);
  const panel = await formatMonitorItemPanel(env, model, csc, lang);
  const actionLabel = {
    pause: lang === "en" ? "monitoring paused" : "监控已暂停",
    resume: lang === "en" ? "monitoring resumed" : "监控已恢复",
    normal: lang === "en" ? "priority changed to NORMAL" : "优先级已改为 NORMAL",
    high: lang === "en" ? "priority changed to HIGH" : "优先级已改为 HIGH",
    low: lang === "en" ? "priority changed to LOW" : "优先级已改为 LOW"
  }[action];
  const resultText = lang === "en"
    ? `✅ Saved: ${model} / ${csc}, ${actionLabel}.`
    : `✅ 设置已保存：${model} / ${csc}，${actionLabel}。`;
  await safeEditOrSend(env, chatId, messageId, `${resultText}\n\n${panel.text}`, panel.replyMarkup);
}

async function formatHighPriorityPanel(env, lang = "zh") {
  const items = standardMonitorItems(await getMonitorItems(env));
  const displayed = items.filter((item) => item.priority === "high" || (item.paused && item.prioritySource === "flagship_linkage"));
  if (!displayed.length) {
    return {
      text: lang === "en" ? "No HIGH-priority monitoring targets." : "当前没有高优先级监控设备。",
      replyMarkup: monitorMenuKeyboard(lang)
    };
  }
  const lines = displayed.map((item, index) => [
    `${index + 1}. ${item.name || `${item.model} / ${item.csc}`}`,
    `   ${item.model} / ${item.csc}`,
    lang === "en"
      ? `   Status: ${item.enabled === false ? "PAUSED" : "ACTIVE"} · Priority: ${item.priority}`
      : `   状态：${item.enabled === false ? "已暂停" : "监控中"} · 优先级：${item.priority}`,
    item.linkedFrom
      ? (lang === "en" ? `   Linked from: ${item.linkedFrom}` : `   联动来源：${item.linkedFrom}`)
      : ""
  ].filter(Boolean).join("\n"));

  const rows = [];
  for (const item of displayed.slice(0, 20)) {
    if (item.enabled === false) {
      rows.push([
        { text: `▶️ ${item.csc} ${lang === "en" ? "Resume HIGH" : "恢复高优先级"}`, callback_data: `monitor-item:resume:${item.model}:${item.csc}` },
        { text: lang === "en" ? "NORMAL" : "改为普通", callback_data: `monitor-item:normal:${item.model}:${item.csc}` }
      ]);
    } else {
      rows.push([
        { text: `⏸ ${item.csc} ${lang === "en" ? "Pause" : "暂停"}`, callback_data: `monitor-item:pause:${item.model}:${item.csc}` },
        { text: lang === "en" ? "NORMAL" : "恢复普通", callback_data: `monitor-item:normal:${item.model}:${item.csc}` }
      ]);
    }
  }
  rows.push([
    { text: lang === "en" ? "Back to targets" : "返回设备列表", callback_data: "admin:monitors" },
    { text: lang === "en" ? "Home" : "返回首页", callback_data: "menu:home" }
  ]);
  return {
    text: [lang === "en" ? "🔥 HIGH-priority monitoring" : "🔥 高优先级监控设备", "", ...lines].join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

async function formatMonitorPanel(env, lang = "zh") {
  const items = standardMonitorItems(await getMonitorItems(env));
  const en = lang === "en";
  if (!items.length) {
    return {
      text: en
        ? "No monitoring targets. Query firmware first, then tap Monitor this target below the result."
        : "当前没有监控设备。请先查询固件，再点击结果下方的“加入 / 查看监控”。",
      replyMarkup: monitorMenuKeyboard(lang)
    };
  }
  const runtimes = await Promise.all(items.map((item) => getMonitorRuntime(env, item.model, item.csc)));
  const lines = items.map((item, index) => {
    const runtime = runtimes[index];
    const state = item.enabled === false ? (en ? "PAUSED" : "暂停") : (en ? "ACTIVE" : "监控中");
    return `${index + 1}. ${item.model} / ${item.csc} · ${state} · ${item.priority || "normal"}`;
  });
  const rows = items.slice(0, 20).map((item) => [{
    text: `${item.enabled === false ? "⏸" : "▶"} ${item.model} / ${item.csc}`,
    callback_data: `monitor-item:view:${item.model}:${item.csc}`
  }]);
  rows.push([
    { text: en ? "Back to monitoring" : "返回监控中心", callback_data: "admin:monitor-menu" },
    { text: en ? "Home" : "返回首页", callback_data: "menu:home" }
  ]);
  return {
    text: [en ? "Monitoring targets" : "监控设备", "", ...lines, items.length > 20 ? (en ? "Only the first 20 targets have action buttons." : "仅前 20 个设备显示操作按钮。") : ""].filter(Boolean).join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

async function formatMonitorItemPanel(env, model, csc, lang = "zh") {
  const items = await getMonitorItems(env);
  const item = items.find((entry) => entry.model === model && entry.csc === csc);
  if (!item) return null;
  if (isRolloutManagedMonitor(item)) {
    const en = lang === "en";
    return {
      text: en
        ? [`${item.name || `${model} / ${csc}`}`, `${model} · ${csc}`, "", `Managed by rollout: ${item.rolloutChainId.toUpperCase()} · ${item.rolloutStageId.toUpperCase()}`, "Use the Rollout panel to change its schedule or state."].join("\n")
        : [`${item.name || `${model} / ${csc}`}`, `${model} · ${csc}`, "", `发布链管理：${item.rolloutChainId.toUpperCase()} · ${item.rolloutStageId.toUpperCase()}`, "请在“发布链”面板调整时间或状态。"].join("\n"),
      replyMarkup: { inline_keyboard: [
        [{ text: en ? "View rollout" : "查看发布链", callback_data: `admin:rollout:${item.rolloutChainId}` }, { text: en ? "Query" : "查询", callback_data: `query:refresh:${model}:${csc}` }],
        [{ text: en ? "Back" : "返回", callback_data: "admin:monitor-menu" }]
      ] }
    };
  }
  {
    const [runtime, intervalSettings] = await Promise.all([
      getMonitorRuntime(env, model, csc),
      getMonitorIntervalSettings(env)
    ]);
    const en = lang === "en";
    const active = item.enabled !== false;
    const intervalMinutes = Number(item.intervalMinutes) > 0 ? Number(item.intervalMinutes) : priorityIntervalMinutes(runtime.priorityScore, intervalSettings);
    const text = [
      item.name || `${model} / ${csc}`,
      `${model} · ${csc}`,
      `${en ? "Status" : "\u72b6\u6001"}：${active ? (en ? "Active" : "\u76d1\u63a7\u4e2d") : (en ? "Paused" : "\u5df2\u6682\u505c")}`,
      `${en ? "Priority" : "\u4f18\u5148\u7ea7"}：${item.priority || "normal"}`,
      `${en ? "Interval" : "\u95f4\u9694"}：${active ? `${intervalMinutes} min` : (en ? "Paused" : "\u5df2\u6682\u505c")}`,
      `${en ? "Failures" : "\u8fde\u7eed\u5931\u8d25"}：${runtime.failureCount || 0}`,
      !active && item.resumeAt ? `${en ? "Resume" : "\u81ea\u52a8\u6062\u590d"}：${formatBeijingTime(new Date(item.resumeAt), lang)}` : ""
    ].filter(Boolean).join("\n");
    return {
      text,
      replyMarkup: { inline_keyboard: [
        [{ text: en ? "High" : "\u9ad8", callback_data: `monitor-item:high:${model}:${csc}` }, { text: en ? "Normal" : "\u666e\u901a", callback_data: `monitor-item:normal:${model}:${csc}` }, { text: en ? "Low" : "\u4f4e", callback_data: `monitor-item:low:${model}:${csc}` }],
        [{ text: active ? (en ? "Pause" : "\u6682\u505c") : (en ? "Resume" : "\u6062\u590d"), callback_data: `monitor-item:${active ? "pause" : "resume"}:${model}:${csc}` }, { text: en ? "Query" : "\u67e5\u8be2", callback_data: `query:refresh:${model}:${csc}` }],
        [{ text: item.notifyAllowedUsers !== false ? (en ? "Notifications on" : "\u901a\u77e5\u5f00") : (en ? "Notifications off" : "\u901a\u77e5\u5173"), callback_data: `monitor-item:notify-users:${model}:${csc}` }],
        [{ text: en ? "Interval" : "\u95f4\u9694", callback_data: "admin:intervals" }, { text: en ? "Remove" : "\u5220\u9664", callback_data: `monitor-item:delete-request:${model}:${csc}` }],
        [{ text: en ? "Back" : "\u8fd4\u56de", callback_data: "admin:monitor-menu" }]
      ] }
    };
  }
  /* legacy detailed panel retained below */
  const [runtime, intervalSettings] = await Promise.all([
    getMonitorRuntime(env, model, csc),
    getMonitorIntervalSettings(env)
  ]);
  const en = lang === "en";
  const active = item.enabled !== false;
  const allowedUserNotificationsEnabled = item.notifyAllowedUsers !== false;
  const intervalMinutes = Number(item.intervalMinutes) > 0
    ? Number(item.intervalMinutes)
    : priorityIntervalMinutes(runtime.priorityScore, intervalSettings);
  const text = [
    item.name || `${model} / ${csc}`,
    "",
    `${model} / ${csc}`,
    en ? `Status: ${active ? "ACTIVE" : "PAUSED"}` : `状态：${active ? "监控中" : "已暂停"}`,
    en ? `Priority: ${item.priority || "normal"}` : `优先级：${item.priority || "normal"}`,
    en ? `Score: ${runtime.priorityScore || 0}` : `智能评分：${runtime.priorityScore || 0}`,
    active
      ? (en ? `Dynamic interval: ${intervalMinutes} min` : `动态间隔：${intervalMinutes} 分钟`)
      : (en ? "Dynamic interval: paused" : "动态间隔：已暂停"),
    en
      ? `Notify allowed users: ${allowedUserNotificationsEnabled ? "ON" : "OFF"}`
      : `通知授权用户：${allowedUserNotificationsEnabled ? "开启" : "关闭"}`,
    !active && item.resumeAt
      ? (en ? `Automatic resume: ${formatBeijingTime(new Date(item.resumeAt), "en")}` : `自动恢复：${formatBeijingTime(new Date(item.resumeAt), "zh")}`)
      : "",
    en ? `Consecutive failures: ${runtime.failureCount || 0}` : `连续失败：${runtime.failureCount || 0}`
  ].filter(Boolean).join("\n");
  return {
    text,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "HIGH", callback_data: `monitor-item:high:${model}:${csc}` },
          { text: "NORMAL", callback_data: `monitor-item:normal:${model}:${csc}` },
          { text: "LOW", callback_data: `monitor-item:low:${model}:${csc}` }
        ],
        [
          {
            text: active ? (en ? "Pause" : "暂停") : (en ? "Resume" : "恢复"),
            callback_data: `monitor-item:${active ? "pause" : "resume"}:${model}:${csc}`
          },
          { text: en ? "Realtime query" : "实时查询", callback_data: `query:refresh:${model}:${csc}` }
        ],
        [{
          text: en
            ? (allowedUserNotificationsEnabled ? "Turn allowed-user updates OFF" : "Turn allowed-user updates ON")
            : (allowedUserNotificationsEnabled ? "关闭授权用户更新通知" : "开启授权用户更新通知"),
          callback_data: `monitor-item:notify-users:${model}:${csc}`
        }],
        [{ text: en ? "Interval settings" : "监控间隔设置", callback_data: "admin:intervals" }],
        [{ text: en ? "Delete target" : "删除设备", callback_data: `monitor-item:delete-request:${model}:${csc}` }],
        [
          { text: en ? "Back to targets" : "返回设备列表", callback_data: "admin:monitors" },
          { text: en ? "Home" : "返回首页", callback_data: "menu:home" }
        ]
      ]
    }
  };
}

async function handleCommand(env, chatId, text, message, identity, ctx = null) {
  const parts = text.trim().split(/\s+/);
  const command = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);

  if (command === "/start") {
    if (args[0] === "zh" || args[0] === "en") {
      await setUserLanguage(env, chatId, args[0]);
    }
    const firstStart = !await hasCompletedOnboarding(env, chatId);
    if (firstStart) {
      await markOnboardingCompleted(env, chatId);
      const lang = await getUserLanguage(env, chatId);
      await sendTelegramMessage(env, chatId, onboardingText(identity, lang), mainMenuKeyboard(identity, lang));
    } else {
      await showMainMenu(env, chatId, identity);
    }
    return;
  }

  if (command === "/help" || command === "/guide") {
    if (args[0] === "zh" || args[0] === "en") {
      await setUserLanguage(env, chatId, args[0]);
    }
    const lang = await getUserLanguage(env, chatId);
    if (identity === "admin") {
      const parts = adminHelpParts(lang);
      await sendTelegramMessage(env, chatId, `${guideText(identity, lang)}\n\n${parts[0]}`);
      for (const part of parts.slice(1)) await sendTelegramMessage(env, chatId, part);
    } else {
      await sendTelegramMessage(env, chatId, guideText(identity, lang));
    }
    return;
  }

  if (command === "/lang" || command === "/language") {
    const langArg = String(args[0] || "").toLowerCase();
    if (langArg === "zh" || langArg === "cn" || langArg === "chinese") {
      await setUserLanguage(env, chatId, "zh");
      await sendTelegramMessage(env, chatId, "✅ 已切换为中文模式。");
      return;
    }
    if (langArg === "en" || langArg === "english") {
      await setUserLanguage(env, chatId, "en");
      await sendTelegramMessage(env, chatId, "✅ Switched to English mode.");
      return;
    }
    const currentLang = await getUserLanguage(env, chatId);
    await sendTelegramMessage(
      env,
      chatId,
      currentLang === "en" ? "Choose a language:" : "请选择语言模式：",
      languageModeKeyboard(identity, currentLang)
    );
    return;
  }

  if (command === "/admin") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const lang = await getUserLanguage(env, chatId);
    await sendTelegramMessage(env, chatId, await adminMenuText(env, lang), adminMenuKeyboard(lang));
    return;
  }

  if (command === "/download") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    if (args.length) {
      const request = parseAdminDownloadInput(args.join(" "));
      if (!request) {
        await sendTelegramMessage(env, chatId, "用法：/download MODEL CSC [VERSION]");
        return;
      }
      runBackground(ctx, startAdminFirmwareDownload(env, chatId, request));
      await sendTelegramMessage(env, chatId, "已收到下载请求。正在准备…");
      return;
    }
    await beginAdminDownloadInput(env, chatId);
    const lang = await getUserLanguage(env, chatId);
    await sendTelegramMessage(env, chatId, lang === "en"
      ? "Send: MODEL CSC [VERSION]"
      : "发送：型号 CSC [版本]", downloadMenuKeyboard([], lang));
    return;
  }

  if (command === "/admins") {
    if (!await requireOwner(env, chatId)) return;
    await renderAdminsPanel(env, chatId);
    return;
  }

  if (command === "/adminadd") {
    if (!await requireOwner(env, chatId)) return;
    const targetId = String(args[0] || "").trim();
    if (!targetId) {
      await sendTelegramMessage(env, chatId, "\u7528\u6cd5\uff1a/adminadd <Chat ID> <\u5907\u6ce8>");
      return;
    }
    const added = await addAdditionalAdmin(env, targetId, args.slice(1).join(" "), chatId);
    await syncTelegramCommands(env).catch(() => null);
    await sendTelegramMessage(env, chatId, added.owner ? "\u8be5 Chat ID \u5df2\u662f\u6240\u6709\u8005\u3002" : (added.existing ? "\u7ba1\u7406\u5458\u4fe1\u606f\u5df2\u66f4\u65b0\u3002" : "\u7ba1\u7406\u5458\u5df2\u6dfb\u52a0\u3002"));
    return;
  }

  if (command === "/admindel") {
    if (!await requireOwner(env, chatId)) return;
    const result = await removeAdditionalAdmin(env, args[0]);
    if (result.removed) {
      await clearTelegramCommandsForChat(env, args[0]);
      await syncTelegramCommands(env).catch(() => null);
    }
    await sendTelegramMessage(env, chatId, result.removed ? "\u7ba1\u7406\u5458\u5df2\u79fb\u9664\u3002" : "\u672a\u627e\u5230\u53ef\u79fb\u9664\u7684\u7ba1\u7406\u5458\u3002");
    return;
  }

  if (command === "/chain" || command === "/rollout") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await renderRolloutMenu(env, chatId);
    return;
  }

  if (command === "/chainadd") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    if (args.length < 4) {
      await sendTelegramMessage(env, chatId, "\u7528\u6cd5\uff1a/chainadd <s26|s25> <kr|eu|hk|cn> <\u578b\u53f7> <CSC> [\u540d\u79f0]");
      return;
    }
    try {
      await addRolloutTarget(env, args[0], args[1], { model: args[2], csc: args[3], name: args.slice(4).join(" ") });
      await sendTelegramMessage(env, chatId, "\u5df2\u6dfb\u52a0\u53d1\u5e03\u94fe\u8bbe\u5907\u3002");
    } catch (error) {
      await sendTelegramMessage(env, chatId, `\u6dfb\u52a0\u5931\u8d25\uff1a${error.message}`);
    }
    return;
  }

  if (command === "/chaininterval" || command === "/chaintime" || command === "/chainenable") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    try {
      if (command === "/chaininterval") await setRolloutChainSettings(env, args[0], { intervalMinutes: Number(args[1]) });
      if (command === "/chaintime") await setRolloutChainSettings(env, args[0], { startTime: args[1], endTime: args[2] });
      if (command === "/chainenable") await setRolloutChainSettings(env, args[0], { enabled: ["on", "true", "1", "\u5f00\u542f"].includes(String(args[1] || "").toLowerCase()) });
      await sendTelegramMessage(env, chatId, "\u53d1\u5e03\u94fe\u8bbe\u7f6e\u5df2\u4fdd\u5b58\u3002");
    } catch (error) {
      await sendTelegramMessage(env, chatId, `\u8bbe\u7f6e\u5931\u8d25\uff1a${error.message}`);
    }
    return;
  }

  if (command === "/chainstage") {
    if (!await requireOwner(env, chatId)) return;
    try {
      await setRolloutChainStage(env, args[0], args[1]);
      await sendTelegramMessage(env, chatId, "\u53d1\u5e03\u94fe\u5f53\u524d\u5730\u533a\u5df2\u66f4\u65b0\u3002");
    } catch (error) {
      await sendTelegramMessage(env, chatId, `\u8bbe\u7f6e\u5931\u8d25\uff1a${error.message}`);
    }
    return;
  }

  if (command === "/chainstart") {
    if (!await requireOwner(env, chatId)) return;
    try {
      await restartDependentRolloutChain(env, args[0]);
      await sendTelegramMessage(env, chatId, "从属发布链已从韩版重新启动。");
    } catch (error) {
      await sendTelegramMessage(env, chatId, `设置失败：${error.message}`);
    }
    return;
  }

  if (command === "/synccommands") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const result = await syncTelegramCommands(env);
    await sendTelegramMessage(env, chatId, result.ok
       ? "快捷命令已同步。\n\n普通用户和管理员已分别更新。"
      : `同步失败：${result.error || result.data?.description || "unknown error"}`);
    return;
  }

  if (command === "/whoami") {
    await sendTelegramMessage(env, chatId, formatWhoami(chatId, identity, await getUserLanguage(env, chatId)));
    return;
  }

  if (command === "/apply") {
    await handleAccessApply(env, chatId, message, identity);
    return;
  }

  if (command === "/status") {
    await sendTelegramMessage(env, chatId, await formatStatus(env, chatId, identity, await getUserLanguage(env, chatId)));
    return;
  }

  if (command === "/devices" || command === "/mydevices" || command === "/subscriptions") {
    if (!(await isAuthorizedForQuery(env, chatId))) {
      const lang = await getUserLanguage(env, chatId);
      await sendTelegramMessage(env, chatId, lang === "en"
        ? "Query access is required before using My Devices."
        : "获得查询权限后才能使用“我的设备”。", mainMenuKeyboard(identity, lang));
      return;
    }
    await renderUserDevices(env, chatId);
    return;
  }

  if (command === "/adminhelp") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const lang = await getUserLanguage(env, chatId);
    for (const part of adminHelpParts(lang)) await sendTelegramMessage(env, chatId, part);
    return;
  }

  if (command === "/requests") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleRequestsList(env, chatId);
    return;
  }

  if (command === "/autoapprove" || command === "/applyauto") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleAutoApprove(env, chatId, args);
    return;
  }

  if (command === "/approve") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleApproveRequest(env, chatId, args);
    return;
  }

  if (command === "/reject") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleRejectRequest(env, chatId, args);
    return;
  }

  if (command === "/refresh") {
    if (!(await isAuthorizedForQuery(env, chatId))) {
      if (unauthorizedMode(env) === "reply") await sendTelegramMessage(env, chatId, unauthorizedQueryText(await getUserLanguage(env, chatId)));
      return;
    }
    let query;
    const lang = await getUserLanguage(env, chatId);
    try {
      query = parseModelQuery(args.join(" "), defaultCsc(env));
    } catch (error) {
      await sendTelegramMessage(env, chatId, formatQueryFailure(error.message, lang));
      return;
    }
    if (!await enforceInteractiveQueryLimits(env, chatId, identity, query.model, lang)) return;
    runBackground(ctx, handleManualQuery(env, chatId, `${query.model} ${query.csc}`, { refresh: true, identity, ctx, query }));
    return;
  }

  if (command === "/debugquery") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleDebugQuery(env, chatId, args);
    return;
  }

  if (command === "/cache") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleCacheCommand(env, chatId, args);
    return;
  }

  if (command === "/cacheclear") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleCacheClear(env, chatId, args);
    return;
  }

  if (["/useradd", "/allow"].includes(command)) {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleUserAdd(env, chatId, args, message);
    return;
  }

  if (["/userdel", "/deny"].includes(command)) {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleUserDel(env, chatId, args);
    return;
  }

  if (["/users", "/allowed"].includes(command)) {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await sendTelegramMessage(env, chatId, await formatUsers(env));
    return;
  }

  if (command === "/add") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleAddMonitor(env, chatId, args);
    return;
  }

  if (command === "/del") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleDelMonitor(env, chatId, args);
    return;
  }


  if (command === "/metrics" || command === "/performance") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const lang = await getUserLanguage(env, chatId);
    const snapshot = await loadPerformanceSnapshot(env, 24);
    await sendTelegramMessage(env, chatId, performancePanel(snapshot.summary, snapshot.budget, lang));
    return;
  }

  if (command === "/diagnostics") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const lang = await getUserLanguage(env, chatId);
    await sendTelegramMessage(env, chatId, diagnosticsPanel(await loadDiagnosticsReport(env), lang));
    return;
  }

  if (command === "/intervals") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const lang = await getUserLanguage(env, chatId);
    const panel = monitorIntervalsPanel(await getMonitorIntervalSettings(env), lang);
    await sendTelegramMessage(env, chatId, panel.text, panel.replyMarkup);
    return;
  }

  if (command === "/interval") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleMonitorIntervalCommand(env, chatId, args);
    return;
  }

  if (command === "/monpriority") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleMonitorPriority(env, chatId, args);
    return;
  }

  if (command === "/moniteminterval") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleMonitorItemInterval(env, chatId, args);
    return;
  }

  if (command === "/list") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await sendTelegramMessage(env, chatId, await formatMonitorList(env));
    return;
  }

  if (command === "/high") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const lang = await getUserLanguage(env, chatId);
    const panel = await formatHighPriorityPanel(env, lang);
    await sendTelegramMessage(env, chatId, panel.text, panel.replyMarkup);
    return;
  }

  if (command === "/monitempause" || command === "/monitemresume") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleMonitorItemEnabled(env, chatId, args, command === "/monitemresume");
    return;
  }

  if (command === "/monsnooze") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleMonitorSnoozeCommand(env, chatId, args);
    return;
  }

  if (command === "/checknow") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const lang = await getUserLanguage(env, chatId);
    const sent = await sendTelegramMessageResult(
      env,
      chatId,
      lang === "en" ? "✅ Monitor check started." : "✅ 已启动监控检查。"
    );
    let lastRendered = "";
    const task = runMonitor(env, {
      reason: "checknow",
      onProgress: async (summary) => {
        if (!sent.messageId) return;
        const progress = formatMonitorProgress(summary, lang);
        if (progress === lastRendered) return;
        lastRendered = progress;
        await safeEditOrSend(env, chatId, sent.messageId, progress);
      }
    }).then((summary) => sent.messageId
      ? safeEditOrSend(env, chatId, sent.messageId, formatCheckNow(summary, lang))
      : sendTelegramMessage(env, chatId, formatCheckNow(summary, lang)));
    runBackground(ctx, task);
    return;
  }

  if (command === "/monstart") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleMonStart(env, chatId, args, await getUserLanguage(env, chatId));
    return;
  }


  if (command === "/monend") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleMonEnd(env, chatId, args, await getUserLanguage(env, chatId));
    return;
  }

  if (command === "/moninterval") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleMonInterval(env, chatId, args);
    return;
  }

  if (command === "/monschedule") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const lang = await getUserLanguage(env, chatId);
    const [schedule, summarySettings] = await Promise.all([
      getMonitorSchedule(env),
      getMonitorSummarySettings(env)
    ]);
    await sendTelegramMessage(env, chatId, formatSchedule(schedule, lang, summarySettings), scheduleMenuKeyboard(schedule, lang, summarySettings));
    return;
  }

  if (command === "/weekend") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    await handleWeekend(env, chatId, args, await getUserLanguage(env, chatId));
    return;
  }

  if (command === "/monpause" || command === "/monresume") {
    if (!(await requireAdmin(env, chatId, identity))) return;
    const schedule = await getMonitorSchedule(env);
    schedule.enabled = command === "/monresume";
    await setMonitorSchedule(env, schedule);
    await sendTelegramMessage(env, chatId, command === "/monresume" ? "✅ 已恢复自动监控。" : "✅ 已暂停自动监控。");
  }
}

async function handleManualQuery(env, chatId, text, options = {}) {
  const startedAt = Date.now();
  const [lang, cacheSettings] = await Promise.all([
    getUserLanguage(env, chatId),
    getCacheSettings(env)
  ]);
  const recordQueryMetric = (metric) => logQueryMetric(metric, env, options.ctx);
  const refreshInfo = parseRefreshQueryText(text);
  let query;
  try {
    query = options.query || parseModelQuery(refreshInfo.text, defaultCsc(env));
  } catch (error) {
    const failure = formatQueryFailure(error.message, lang);
    if (options.targetMessageId) await safeEditOrSend(env, chatId, options.targetMessageId, failure);
    else await sendTelegramMessage(env, chatId, failure);
    return;
  }

  const identity = options.identity || await getIdentity(env, chatId);
  markFirmwareTargetHot(query.model, query.csc, 30 * 60);
  runBackground(options.ctx, recordFirmwareQueryDemand(env, query.model, query.csc));
  const adminRealtime = identity === "admin" && cacheSettings.adminRealtimeEnabled === true;
  const forceRefresh = Boolean(options.refresh || refreshInfo.refresh || adminRealtime);
  const cacheDisabled = !cacheSettings.enabled;
  const keyboard = firmwareResultKeyboard(query.model, query.csc, lang, identity);
  let staleCache = null;
  let outputMessageId = options.targetMessageId || null;
  const cacheLookupStartedAt = Date.now();

  const deliver = async (body, markup = keyboard) => {
    if (outputMessageId) {
      await safeEditOrSend(env, chatId, outputMessageId, body, markup);
      return outputMessageId;
    }
    const sent = await sendTelegramMessageResult(env, chatId, body, markup);
    if (sent.messageId) outputMessageId = sent.messageId;
    return outputMessageId;
  };

  const deliverFailure = async (failure) => {
    const error = failure instanceof Error
      ? failure
      : Object.assign(new Error(String(failure?.message || failure || "Firmware query failed")), {
          code: failure?.code || "",
          officialCscOptions: Array.isArray(failure?.officialCscOptions) ? failure.officialCscOptions : []
        });
    if (await deliverOfficialCscSuggestions(deliver, error, query, lang)) return;
    await deliver(formatQueryFailure(error.message, lang), null);
  };

  const fetchLive = async () => {
    const coordinatorStartedAt = Date.now();
    const result = await singleFlightFirmware(query.model, query.csc, () => coordinatedFirmwareQuery(
      env,
      query.model,
      query.csc,
      {
        refresh: forceRefresh,
        role: identity === "admin" ? "admin" : "interactive"
      }
    ));
    const coordinatorHopMs = Date.now() - coordinatorStartedAt;
    const cacheValue = result.canonicalCache || (
      result.parsed?.sourceType === "version_xml"
        ? result.parsed
        : buildFirmwareCacheRecord(
          env,
          staleCache,
          query.model,
          query.csc,
          result.parsed
        )
    );
    if (cacheSettings.enabled && cacheValue.sourceType === "smart_history") {
      setL1Firmware(query.model, query.csc, cacheValue, l1CacheTtlSeconds(env));
      setFirmwareMemoryCache(query.model, query.csc, cacheValue);
      if (!result.canonicalCache) {
        runBackground(options.ctx, setFirmwareQueryCache(env, query.model, query.csc, cacheValue));
      }
    }
    recordQueryMetric({
      model: query.model,
      csc: query.csc,
      cacheLayer: "miss",
      selectedSource: cacheValue.selectedSource,
      historyMs: result.queryTiming?.historyMs,
      smartHistoryMs: result.queryTiming?.smartHistoryMs || result.queryTiming?.historyMs,
      laneQueueWaitMs: result.queryTiming?.laneQueueWaitMs,
      sessionAcquireMs: result.queryTiming?.sessionAcquireMs,
      nonceMs: result.queryTiming?.nonceMs,
      parseHistoryMs: result.queryTiming?.parseHistoryMs,
      laneId: result.queryTiming?.laneId,
      coordinatorHopMs,
      cacheLookupMs: coordinatorStartedAt - cacheLookupStartedAt,
      coordinatorCacheLayer: result.coordinator?.cacheLayer || (result.coordinator?.cacheHit ? "do_memory" : "miss"),
      singleFlightJoined: Boolean(result.coordinator?.shared || result.queryTiming?.singleFlightJoined),
      totalBeforeTelegramMs: Date.now() - startedAt,
      totalMs: Date.now() - startedAt,
      degraded: cacheValue.degraded,
    });
    return cacheValue;
  };

  if (!forceRefresh && cacheSettings.enabled) {
    const negative = getNegativeFirmware(query.model, query.csc);
    if (negative) {
      await deliverFailure(negative);
      return;
    }

    const memoryCached = getL1Firmware(query.model, query.csc);
    if (memoryCached?.latest && isFreshFirmwareCache(memoryCached)) {
      recordQueryMetric({
        model: query.model,
        csc: query.csc,
        cacheLayer: "l1",
        selectedSource: memoryCached.selectedSource,
        totalBeforeTelegramMs: Date.now() - startedAt,
        degraded: memoryCached.degraded,
      });
      await deliver(formatFirmwareResult(memoryCached, {
        source: "History L1 Cache",
        cachedAt: memoryCached.cachedAt,
        returnedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        lang
      }));
      return;
    }

    const hotCached = getFirmwareMemoryCache(query.model, query.csc);
    if (hotCached?.latest && isFreshFirmwareCache(hotCached)) {
      recordQueryMetric({
        model: query.model,
        csc: query.csc,
        cacheLayer: "firmware_memory",
        selectedSource: hotCached.selectedSource,
        totalBeforeTelegramMs: Date.now() - startedAt,
        degraded: false
      });
      await deliver(formatFirmwareResult(hotCached, {
        source: "History Hot Memory Cache",
        cachedAt: hotCached.cachedAt,
        returnedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        lang
      }));
      return;
    }

    // Reuse a recent in-isolate History snapshot for SWR instead of paying an
    // extra KV round trip after its short freshness window has elapsed.
    const kvCached = memoryCached?.latest && isUsableStaleFirmwareCache(memoryCached)
      ? memoryCached
      : await getFirmwareQueryCache(env, query.model, query.csc);
    if (kvCached?.latest) {
      staleCache = isUsableStaleFirmwareCache(kvCached) ? kvCached : null;
      if (isFreshFirmwareCache(kvCached)) {
        setL1Firmware(query.model, query.csc, kvCached, l1CacheTtlSeconds(env));
        setFirmwareMemoryCache(query.model, query.csc, kvCached);
        recordQueryMetric({
          model: query.model,
          csc: query.csc,
          cacheLayer: "kv",
          selectedSource: kvCached.selectedSource,
          totalBeforeTelegramMs: Date.now() - startedAt,
          degraded: kvCached.degraded,
        });
        await deliver(formatFirmwareResult(kvCached, {
          source: "History KV Cache",
          cachedAt: kvCached.cachedAt,
          returnedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          lang
        }));
        return;
      }

      const fetchedAt = Date.parse(kvCached.historyFetchedAt || kvCached.cachedAt || "");
      const swrSeconds = queryStaleWhileRevalidateSeconds(env);
      const swrEligible = staleCache && swrSeconds > 0 && Number.isFinite(fetchedAt)
        && Date.now() - fetchedAt <= swrSeconds * 1000;
      if (swrEligible) {
        const checkingText = formatFirmwareResult(kvCached, {
          source: "Stale History Cache",
          cachedAt: kvCached.cachedAt,
          returnedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          lang
        }) + (lang === "en"
          ? "\n\n⏳ Returned immediately; verifying SmartHistory in the background…"
          : "\n\n⏳ 已立即返回，正在后台核对 SmartHistory…");
        await deliver(checkingText);
        recordQueryMetric({
          model: query.model,
          csc: query.csc,
          cacheLayer: "stale_swr",
          selectedSource: kvCached.selectedSource,
          totalBeforeTelegramMs: Date.now() - startedAt,
          degraded: kvCached.degraded
        });
        runBackground(options.ctx, fetchLive().then((cacheValue) => deliver(formatFirmwareResult(cacheValue, {
          source: cacheValue.source,
          queriedAt: cacheValue.cachedAt,
          elapsedMs: Date.now() - startedAt,
          lang
        }))).catch((error) => deliver(checkingText + (lang === "en"
          ? `\n\n⚠️ Background verification failed: ${error.message}`
          : `\n\n⚠️ 后台核对失败：${error.message}`))));
        return;
      }
    }
  }

  let liveCompleted = false;
  let placeholderStarted = false;
  const livePromise = fetchLive();
  const placeholderPromise = (!options.silentPlaceholder && (options.targetMessageId || telegramQueryPlaceholderEnabled(env)))
    ? waitFor(300).then(async () => {
      if (liveCompleted) return;
      placeholderStarted = true;
      await deliver(lang === "en"
        ? `⏳ Checking latest firmware…\n\nModel: ${query.model}\nCSC: ${query.csc}`
        : `⏳ 正在查询最新固件…\n\n机型：${query.model}\n地区：${query.csc}`);
    }).catch((error) => {
      console.log(`Telegram query placeholder failed: ${error.message}`);
    })
    : Promise.resolve();
  try {
    const cacheValue = await livePromise;
    liveCompleted = true;
    if (placeholderStarted) await placeholderPromise;
    await deliver(formatFirmwareResult(cacheValue, {
      source: cacheValue.source,
      queriedAt: cacheValue.cachedAt,
      elapsedMs: Date.now() - startedAt,
      refresh: forceRefresh,
      cacheDisabled,
      lang
    }));
  } catch (error) {
    liveCompleted = true;
    if (placeholderStarted) await placeholderPromise;
    recordQueryMetric({
      model: query.model,
      csc: query.csc,
      cacheLayer: staleCache?.latest ? "stale" : "miss",
      selectedSource: staleCache?.selectedSource || "none",
      totalBeforeTelegramMs: Date.now() - startedAt,
      degraded: true,
      ok: Boolean(staleCache?.latest)
    });
    if (staleCache?.latest) {
      await deliver(formatFirmwareResult({
        ...staleCache,
        degraded: true,
        fallbackUsed: true,
        fallbackReason: `History 实时查询失败，已返回最后一次 History 记录：${error.message}`
      }, {
        source: "Stale History Cache",
        cachedAt: staleCache.cachedAt,
        returnedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        lang
      }));
      return;
    }
    if (isNegativeCacheable(error?.message)) {
      setNegativeFirmware(query.model, query.csc, error, negativeCacheTtlSeconds(env));
    }
    await deliverFailure(error);
  } finally {
    liveCompleted = true;
    runBackground(options.ctx, placeholderPromise);
  }
}

function isFreshFirmwareCache(value) {
  return isExactSmartHistory(value?.history || value) && Boolean(value?.latest) && Date.parse(value.freshUntil || 0) > Date.now();
}

function isUsableStaleFirmwareCache(value) {
  return isExactSmartHistory(value?.history || value) && Boolean(value?.latest) && Date.parse(value.staleUntil || 0) > Date.now();
}

function isNegativeCacheable(reason) {
  return /(?:HTTP 403|HTTP 404|未找到|没有公开固件|no usable firmware|no matching CSC record|latest 字段为空)/i.test(String(reason || ""));
}

function runBackground(ctx, promise) {
  const guarded = Promise.resolve(promise).catch((error) => {
    console.log(`Background query task failed: ${error.message}`);
  });
  if (ctx?.waitUntil) ctx.waitUntil(guarded);
  return guarded;
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseRefreshQueryText(text) {
  let value = String(text || "").trim();
  let refresh = false;
  if (/^\/refresh(?:@\w+)?\s+/i.test(value)) {
    value = value.replace(/^\/refresh(?:@\w+)?\s+/i, "").trim();
    refresh = true;
  }
  const parts = value.split(/\s+/).filter(Boolean);
  const last = String(parts[parts.length - 1] || "").toLowerCase();
  if (["refresh", "fresh", "no-cache", "nocache"].includes(last)) {
    parts.pop();
    value = parts.join(" ");
    refresh = true;
  }
  return { text: value, refresh };
}

async function handleDebugQuery(env, chatId, args) {
  const lang = await getUserLanguage(env, chatId);
  let query;
  try {
    query = parseModelQuery(args.join(" "), defaultCsc(env));
  } catch (error) {
    await sendTelegramMessage(env, chatId, formatQueryFailure(error.message, lang));
    return;
  }

  const startedAt = Date.now();
  const smart = await querySmartHistory(env, query.model, query.csc)
    .then((value) => ({ ok: true, value }))
    .catch((error) => ({ ok: false, error: error.message }));
  const matchType = smart.ok ? String(smart.value.smartHistory?.cscMatchType || "unknown") : "N/A";
  const exact = smart.ok && ["local", "buyer"].includes(matchType.toLowerCase());
  const lines = [
    "🔧 SmartHistory 查询诊断",
    "",
    `机型：${query.model}`,
    `地区：${query.csc}`,
    `耗时：${Date.now() - startedAt} ms`,
    "",
    `状态：${smart.ok ? "成功" : "失败"}`,
    smart.ok ? "版本：" : "原因：",
    smart.ok ? smart.value.latest : smart.error,
    "CSC 匹配：",
    matchType,
    "精确地区：",
    exact ? "是" : "否",
    "Android：",
    smart.ok ? (smart.value.rawAndroid || smart.value.android || "未知") : "N/A",
    "Sequence：",
    smart.ok ? String(smart.value.smartHistory?.sequence ?? "N/A") : "N/A",
    "OpenDate：",
    smart.ok ? (smart.value.smartHistory?.openDate || "N/A") : "N/A",
    "",
    exact
      ? "最终判定：可作为正式固件结果。"
      : "最终判定：不允许作为指定 CSC 的正式固件结果。"
  ];
  await sendTelegramMessage(env, chatId, lines.join("\n"));
}

async function handleCacheCommand(env, chatId, args) {
  const settings = await getCacheSettings(env);
  const [first, second] = args.map((arg) => String(arg || "").toLowerCase());
  let next = null;

  if (!first || first === "status") {
    await sendTelegramMessage(env, chatId, formatCacheSettings(settings, env));
    return;
  }
  if (first === "on" || first === "off") {
    next = { enabled: first === "on" };
  } else if ((first === "admin" || first === "realtime") && (second === "on" || second === "off")) {
    next = { adminRealtimeEnabled: second === "on" };
  } else if (first === "user" || first === "global" || first === "ttl") {
    await sendTelegramMessage(env, chatId, [
      "v2.3 已改为统一的 Model / CSC 权威缓存。",
      "旧的 user/global 独立开关和运行时 TTL 命令已停用，避免显示成功但实际不生效。",
      "",
      "请使用：",
      "/cache on",
      "/cache off",
      "/cache admin on",
      "/cache admin off",
      "",
      "TTL 请通过 Cloudflare 普通变量配置：",
      "L1_CACHE_TTL_SECONDS",
      "FIRMWARE_CACHE_FRESH_SECONDS",
      "FIRMWARE_CACHE_STALE_SECONDS"
    ].join("\n"));
    return;
  }

  if (!next) {
    await sendTelegramMessage(env, chatId, [
      "用法：",
      "/cache",
      "/cache on",
      "/cache off",
      "/cache admin on",
      "/cache admin off"
    ].join("\n"));
    return;
  }
  const updated = await setCacheSettings(env, next, chatId);
  await sendTelegramMessage(env, chatId, formatCacheSettings(updated, env));
}

function formatCacheSettings(settings, env) {
  return [
    "History 权威查询缓存设置",
    "",
    "总开关：" + (settings.enabled ? "开启" : "关闭"),
    "管理员实时查询：" + (settings.adminRealtimeEnabled === true ? "开启" : "关闭"),
    "当前 TTL：L1 " + l1CacheTtlSeconds(env) + " 秒 / 新鲜 " + firmwareCacheFreshSeconds(env) + " 秒 / SWR " + queryStaleWhileRevalidateSeconds(env) + " 秒",
    "",
    "说明：",
    "固件缓存按 Model / CSC 统一共享，只接受精确 CSC SmartHistory。",
    "实时查询失败时仅可返回尚未过期的最后一次精确 History 缓存。",
    "自动监控只会预热精确 CSC History；/refresh 会跳过缓存。",
    "",
    "可用命令：",
    "/cache on",
    "/cache off",
    "/cache admin on",
    "/cache admin off",
    "/cacheclear 948n koo"
  ].join("\n");
}

async function handleCacheClear(env, chatId, args) {
  const mode = String(args[0] || "").toLowerCase();
  if (mode === "all") {
    const cleared = await clearAllQueryCaches(env);
    await sendTelegramMessage(env, chatId, `已尝试清理缓存。\nHistory 统一缓存：${cleared.canonical}\n旧全局缓存：${cleared.global}\n旧用户缓存：${cleared.user}`);
    return;
  }

  let scope = "both";
  let queryArgs = args;
  if (mode === "user" || mode === "global") {
    scope = mode;
    queryArgs = args.slice(1);
  }
  let query;
  try {
    query = parseModelQuery(queryArgs.join(" "), defaultCsc(env));
  } catch (error) {
    await sendTelegramMessage(env, chatId, [
      "用法：",
      "/cacheclear 948n koo",
      "/cacheclear user 948n koo",
      "/cacheclear global 948n koo",
      "/cacheclear all"
    ].join("\n"));
    return;
  }
  if (scope === "both" || scope === "user") await deleteUserQueryCache(env, chatId, query.model, query.csc);
  if (scope === "both" || scope === "global") await deleteGlobalQueryCache(env, query.model, query.csc);
  await deleteFirmwareQueryCache(env, query.model, query.csc);
  deleteL1Firmware(query.model, query.csc);
  deleteFirmwareMemoryCache(query.model, query.csc);
  await sendTelegramMessage(env, chatId, `✅ 已清理缓存\n\n机型：${query.model}\n地区：${query.csc}\n范围：${scope}`);
}

async function clearAllQueryCaches(env) {
  const [canonical, global, user] = await Promise.all([
    clearQueryCachePrefix(env, "firmware:v2:", 100),
    clearQueryCachePrefix(env, "query:global:", 100),
    clearQueryCachePrefix(env, "query:cache:", 100)
  ]);
  clearFirmwareMemoryCaches();
  return { canonical, global, user };
}

async function requireAdmin(env, chatId, identity) {
  if (identity === "admin") return true;
  await sendTelegramMessage(env, chatId, "你没有权限执行此操作。");
  return false;
}

async function requireOwner(env, chatId) {
  if (isOwnerChatId(env, chatId)) return true;
  await sendTelegramMessage(env, chatId, "\u53ea\u6709\u6240\u6709\u8005\u53ef\u6267\u884c\u6b64\u64cd\u4f5c\u3002");
  return false;
}

async function renderAdminsPanel(env, chatId, messageId = null) {
  const lang = await getUserLanguage(env, chatId);
  if (!isOwnerChatId(env, chatId)) {
    const text = lang === "en" ? "Only the owner can manage administrators." : "\u53ea\u6709\u6240\u6709\u8005\u53ef\u7ba1\u7406\u7ba1\u7406\u5458\u3002";
    if (messageId) return safeEditOrSend(env, chatId, messageId, text, adminMenuKeyboard(lang));
    return sendTelegramMessage(env, chatId, text, adminMenuKeyboard(lang));
  }
  const admins = await getAdditionalAdmins(env);
  const text = lang === "en"
    ? ["👑 Administrators", "", "Owner: configured Telegram Chat ID", ...admins.map((admin, index) => `${index + 1}. ${admin.name || admin.chatId}\n   ${admin.chatId}`), "", "Add: /adminadd <Chat ID> <name>"].join("\n")
    : ["\ud83d\udc51 \u7ba1\u7406\u5458", "", "\u6240\u6709\u8005\uff1a\u5f53\u524d\u914d\u7f6e\u7684 Telegram Chat ID", ...admins.map((admin, index) => `${index + 1}. ${admin.name || admin.chatId}\n   ${admin.chatId}`), "", "\u6dfb\u52a0\uff1a/adminadd <Chat ID> <\u5907\u6ce8>"] .join("\n");
  const rows = admins.map((admin) => [{ text: `${lang === "en" ? "Remove" : "\u79fb\u9664"} ${(admin.name || admin.chatId).slice(0, 24)}`, callback_data: `admin:admin-remove:${admin.chatId}` }]);
  rows.push([{ text: lang === "en" ? "Back" : "\u8fd4\u56de", callback_data: "menu:home" }]);
  if (messageId) return safeEditOrSend(env, chatId, messageId, text, { inline_keyboard: rows });
  return sendTelegramMessage(env, chatId, text, { inline_keyboard: rows });
}

function rolloutMenuKeyboard(chains, lang = "zh") {
  const en = lang === "en";
  return {
    inline_keyboard: [
      chains.map((chain) => ({ text: `${chain.name} · ${chain.stages.find((stage) => stage.id === chain.activeStageId)?.name || "-"}`, callback_data: `admin:rollout:${chain.id}` })),
      [{ text: en ? "Back" : "\u8fd4\u56de", callback_data: "menu:home" }]
    ]
  };
}

function rolloutMenuStatus(chain, chains, lang = "zh") {
  const en = lang === "en";
  if (chain.id === "s25" && !chain.enabled) {
    return en ? "waiting for S26 Korea" : "等待 S26 韩版确认";
  }
  if (chain.status === "awaiting_confirmation") return en ? "awaiting decision" : "等待确认";
  if (chain.status === "completed") return en ? "round complete" : "本轮完成";
  return chain.enabled ? (en ? "monitoring" : "监控中") : (en ? "paused" : "已暂停");
}

async function renderRolloutMenu(env, chatId, messageId = null) {
  const [chains, lang] = await Promise.all([getRolloutChains(env), getUserLanguage(env, chatId)]);
  const text = lang === "en"
    ? ["📣 Release monitoring", "", ...chains.chains.map((chain) => `${chain.name} · ${rolloutMenuStatus(chain, chains.chains, lang)}`), "", "Start S26 manually. S25 starts automatically after S26 Korea is confirmed.", "Any configured model in the current region triggers the decision card."].join("\n")
    : ["\ud83d\udce3 \u53d1\u5e03\u94fe", "", ...chains.chains.map((chain) => `${chain.name} · ${rolloutMenuStatus(chain, chains.chains, lang)}`), "", "\u4ec5\u9700\u624b\u52a8\u542f\u7528 S26\uff1bS25 \u5c06\u5728 S26 \u97e9\u7248\u786e\u8ba4\u540e\u81ea\u52a8\u542f\u52a8\u3002", "\u5f53\u524d\u5730\u533a\u4efb\u610f\u4e00\u6b3e\u9884\u8bbe\u673a\u578b\u53d1\u73b0\u65b0\u7248\u672c\u5373\u8bf7\u6c42\u786e\u8ba4\u3002"].join("\n");
  const markup = rolloutMenuKeyboard(chains.chains, lang);
  if (messageId) return safeEditOrSend(env, chatId, messageId, text, markup);
  return sendTelegramMessage(env, chatId, text, markup);
}

async function renderRolloutChain(env, chatId, messageId, chainId) {
  const [chains, lang] = await Promise.all([getRolloutChains(env), getUserLanguage(env, chatId)]);
  const chain = chains.chains.find((item) => item.id === chainId);
  if (!chain) return renderRolloutMenu(env, chatId, messageId);
  const en = lang === "en";
  const dependent = chain.id === "s25";
  const owner = isOwnerChatId(env, chatId);
  const text = `${rolloutChainPanelText(chain, lang)}\n\n${dependent
    ? (en ? "S25 is started automatically after S26 Korea is confirmed." : "S25 会在 S26 韩版确认后自动启动。")
    : (en ? "Start this chain manually. S25 will remain waiting until S26 Korea is confirmed." : "手动启动 S26 后，S25 将保持等待，直至 S26 韩版确认。")}`;
  const rows = [
    [10, 15, 30, 60].map((minutes) => ({ text: `${minutes}m`, callback_data: `admin:rollout-interval:${chain.id}:${minutes}` })),
    [{ text: en ? "Daytime" : "\u767d\u5929", callback_data: `admin:rollout-time:${chain.id}:08:00:23:00` }, { text: en ? "All day" : "\u5168\u5929", callback_data: `admin:rollout-time:${chain.id}:00:00:23:59` }]
  ];
  if (!dependent) rows.push([{ text: chain.enabled ? (en ? "Pause S26" : "暂停 S26") : (en ? "Start S26" : "启动 S26"), callback_data: `admin:rollout-enable:${chain.id}:${chain.enabled ? "off" : "on"}` }]);
  if (dependent && chain.enabled) rows.push([{ text: en ? "Pause S25" : "暂停 S25", callback_data: `admin:rollout-enable:${chain.id}:off` }]);
  if (dependent && !chain.enabled && owner) rows.push([{ text: en ? "Owner: restart S25" : "所有者：重新启动 S25", callback_data: `admin:rollout-restart:${chain.id}` }]);
  rows.push([{ text: en ? "Back" : "\u8fd4\u56de", callback_data: "admin:rollout-menu" }]);
  return safeEditOrSend(env, chatId, messageId, text, { inline_keyboard: rows });
}

async function handleAutoApprove(env, chatId, args) {
  const mode = String(args[0] || "status").toLowerCase();

  if (["status", "状态"].includes(mode)) {
    await sendTelegramMessage(env, chatId, formatAutoApproveStatus(await getAccessSettings(env)), adminMenuKeyboard());
    return;
  }

  if (["on", "open", "enable", "开启", "开放"].includes(mode)) {
    const minutes = args[1] ? Number(args[1]) : 0;
    if (args[1] && (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080)) {
      await sendTelegramMessage(env, chatId, [
        "用法：",
        "/autoapprove on",
        "/autoapprove on 60",
        "",
        "限时时间单位是分钟，范围 1-10080。"
      ].join("\n"));
      return;
    }
    const expiresAt = minutes ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : "";
    await setAccessAutoApprove(env, true, expiresAt);
    await sendTelegramMessage(env, chatId, formatAutoApproveStatus(await getAccessSettings(env)), adminMenuKeyboard());
    return;
  }

  if (["off", "close", "disable", "关闭"].includes(mode)) {
    await setAccessAutoApprove(env, false);
    await sendTelegramMessage(env, chatId, formatAutoApproveStatus(await getAccessSettings(env)), adminMenuKeyboard());
    return;
  }

  await sendTelegramMessage(env, chatId, [
    "用法：",
    "/autoapprove status",
    "/autoapprove on",
    "/autoapprove on 60",
    "/autoapprove off"
  ].join("\n"));
}

function formatAutoApproveStatus(settings) {
  const lines = [
    "白名单申请自动通过",
    "",
    `状态：${settings.autoApprove ? "开启" : "关闭"}`
  ];
  if (settings.autoApprove && settings.autoApproveExpiresAt) {
    lines.push(`自动关闭时间：${formatBeijingTime(new Date(settings.autoApproveExpiresAt))}`);
  }
  lines.push(
    "",
    "命令：",
    "/autoapprove on - 开放申请自动通过",
    "/autoapprove on 60 - 开放 60 分钟",
    "/autoapprove off - 关闭自动通过",
    "/autoapprove status - 查看状态"
  );
  return lines.join("\n");
}

async function handleAccessApply(env, chatId, message, identity) {
  const lang = await getUserLanguage(env, chatId);
  if (identity === "admin") {
    await sendTelegramMessage(env, chatId, lang === "en"
      ? "You are the owner. You do not need whitelist access."
      : "你已经是管理员，不需要申请白名单权限。", mainMenuKeyboard("admin", lang));
    return;
  }
  if (identity === "allowed") {
    await sendTelegramMessage(env, chatId, lang === "en"
      ? "You are already whitelisted. You can query firmware directly."
      : "你已经在白名单内，可以直接查询固件。", mainMenuKeyboard("allowed", lang));
    return;
  }

  const applicant = buildApplicant(chatId, message);
  const accessSettings = await getAccessSettings(env);
  if (accessSettings.autoApprove) {
    const user = await addAllowedUser(env, applicant.chatId, applicant.name);
    await removeAccessRequest(env, applicant.chatId);
    await sendTelegramMessage(env, chatId, accessApprovedText(lang), mainMenuKeyboard("allowed", lang));

    const adminId = adminChatId(env);
    if (adminId) {
      await sendTelegramMessage(env, adminId, [
        "✅ 白名单申请已自动通过",
        "",
        `用户：${user.name}`,
        `Username：${applicant.username ? `@${applicant.username}` : "无"}`,
        `Chat ID：${user.chatId}`,
        `通过时间：${formatBeijingTime(new Date())}`
      ].join("\n"));
    }
    return;
  }

  const request = await upsertAccessRequest(env, applicant);
  await sendTelegramMessage(env, chatId, accessSubmittedText(request, lang), mainMenuKeyboard("unauthorized", lang));

  const adminId = adminChatId(env);
  if (adminId) {
    await sendTelegramMessage(env, adminId, formatAccessRequestNotification(request), accessDecisionKeyboard(request.chatId));
  }
}

function accessSubmittedText(request, lang = "zh") {
  if (lang === "en") {
    return [
      "✅ Whitelist request submitted",
      "",
      "After the owner approves it, you can use firmware query.",
      "",
      "Your Chat ID:",
      request.chatId
    ].join("\n");
  }
  return [
    "✅ 已提交白名单申请",
    "",
    "管理员审批后，你就可以使用固件查询功能。",
    "",
    "你的 Chat ID：",
    request.chatId
  ].join("\n");
}

function buildApplicant(chatId, message) {
  const from = message?.from || {};
  const firstName = String(from.first_name || "").trim();
  const lastName = String(from.last_name || "").trim();
  const username = String(from.username || "").trim();
  const name = [firstName, lastName].filter(Boolean).join(" ") || (username ? `@${username}` : String(chatId));
  return {
    chatId: String(chatId),
    username,
    firstName,
    lastName,
    name
  };
}

function formatAccessRequestNotification(request) {
  const username = request.username ? `@${request.username}` : "无";
  return [
    "📝 新的白名单申请",
    "",
    `用户：${request.name || request.chatId}`,
    `Username：${username}`,
    `Chat ID：${request.chatId}`,
    `申请时间：${formatBeijingTime(new Date(request.requestedAt))}`,
    "",
    "批准：",
    `/approve ${request.chatId}`,
    "",
    "拒绝：",
    `/reject ${request.chatId}`
  ].join("\n");
}

function accessDecisionKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ 同意", callback_data: `access:approve:${chatId}` },
        { text: "❌ 拒绝", callback_data: `access:reject:${chatId}` }
      ],
      [{ text: "返回首页", callback_data: "menu:home" }]
    ]
  };
}

async function formatAccessRequests(env) {
  const requests = await getAccessRequests(env);
  if (!requests.length) return "当前没有待审批的白名单申请。";
  return [
    "📝 待审批白名单申请",
    "",
    ...requests.map((request, index) => [
      `${index + 1}. ${request.name || request.chatId}`,
      `   Username：${request.username ? `@${request.username}` : "无"}`,
      `   Chat ID：${request.chatId}`,
      `   申请时间：${formatBeijingTime(new Date(request.requestedAt))}`,
      `   批准：/approve ${request.chatId}`,
      `   拒绝：/reject ${request.chatId}`
    ].join("\n"))
  ].join("\n");
}

async function handleRequestsList(env, chatId) {
  const requests = await getAccessRequests(env);
  if (!requests.length) {
    await sendTelegramMessage(env, chatId, "当前没有待审批的白名单申请。");
    return;
  }
  await sendTelegramMessage(env, chatId, `📝 当前有 ${requests.length} 个待审批白名单申请。`);
  for (const request of requests) {
    await sendTelegramMessage(env, chatId, formatAccessRequestNotification(request), accessDecisionKeyboard(request.chatId));
  }
}

async function handleApproveRequest(env, chatId, args) {
  const targetId = args[0];
  if (!targetId) {
    await sendTelegramMessage(env, chatId, "用法：/approve 123456789");
    return;
  }
  await approveRequestById(env, chatId, targetId);
}

async function approveRequestById(env, chatId, targetId, messageId = null) {
  const requests = await getAccessRequests(env);
  const request = requests.find((item) => item.chatId === String(targetId));
  const name = request?.name || String(targetId);
  const user = await addAllowedUser(env, targetId, name);
  await removeAccessRequest(env, targetId);
  if (messageId) {
    const adminLang = await getUserLanguage(env, chatId);
    await safeEditOrSend(env, chatId, messageId, [
      "✅ 已批准白名单申请",
      "",
      `用户：${user.name}`,
      `Chat ID：${user.chatId}`
    ].join("\n"), adminMenuKeyboard(adminLang));
  } else {
    await sendTelegramMessage(env, chatId, [
      "✅ 已批准白名单申请",
      "",
      `用户：${user.name}`,
      `Chat ID：${user.chatId}`
    ].join("\n"), removeKeyboard());
  }
  const lang = await getUserLanguage(env, targetId);
  await sendTelegramMessage(env, targetId, accessApprovedText(lang));
}

async function handleRejectRequest(env, chatId, args) {
  const targetId = args[0];
  if (!targetId) {
    await sendTelegramMessage(env, chatId, "用法：/reject 123456789");
    return;
  }
  await rejectRequestById(env, chatId, targetId);
}

async function rejectRequestById(env, chatId, targetId, messageId = null) {
  const removed = await removeAccessRequest(env, targetId);
  if (messageId) {
    const adminLang = await getUserLanguage(env, chatId);
    await safeEditOrSend(env, chatId, messageId, removed
      ? `✅ 已拒绝白名单申请\n\nChat ID：${targetId}`
      : `未找到该白名单申请。\n\nChat ID：${targetId}`, adminMenuKeyboard(adminLang));
  } else {
    await sendTelegramMessage(env, chatId, removed
      ? `✅ 已拒绝白名单申请\n\nChat ID：${targetId}`
      : `未找到该白名单申请。\n\nChat ID：${targetId}`, removeKeyboard());
  }
  if (removed) {
    const lang = await getUserLanguage(env, targetId);
    await sendTelegramMessage(env, targetId, accessRejectedText(lang));
  }
}

function accessApprovedText(lang = "zh") {
  if (lang === "en") {
    return [
      "✅ Your whitelist request has been approved.",
      "",
      "You can now query firmware by sending a model number, for example:",
      "9380",
      "938B EUX"
    ].join("\n");
  }
  return [
    "✅ 你的白名单申请已通过",
    "",
    "现在可以直接发送型号查询固件，例如：",
    "9380",
    "938B EUX"
  ].join("\n");
}

function accessRejectedText(lang = "zh") {
  if (lang === "en") {
    return [
      "Your whitelist request was not approved.",
      "",
      "Please contact the owner if you still need access."
    ].join("\n");
  }
  return [
    "你的白名单申请未通过。",
    "",
    "如需继续使用，请联系管理员。"
  ].join("\n");
}

function isConfirmText(text) {
  return ["确认", "已确认", "收到", "确认收到"].includes(String(text || "").trim());
}

function formatWhoami(chatId, identity, lang = "zh") {
  if (lang === "en") {
    const label = identity === "admin" ? "Owner" : identity === "allowed" ? "Whitelisted" : "Not whitelisted";
    return [
      "Your Chat ID:",
      String(chatId),
      "",
      "Permission:",
      label
    ].join("\n");
  }
  return [
    "你的 Chat ID：",
    String(chatId),
    "",
    "权限状态：",
    identityLabel(identity)
  ].join("\n");
}

async function handleUserAdd(env, chatId, args, message) {
  const replied = replyTargetFromMessage(message);
  const targetId = args[0] || replied?.chatId;
  const name = args.slice(1).join(" ") || replied?.name || targetId;
  if (!targetId) {
    await sendTelegramMessage(env, chatId, "用法：/useradd 123456789 小王\n也可以回复用户消息发送 /useradd");
    return;
  }
  const user = await addAllowedUser(env, targetId, name);
  await sendTelegramMessage(env, chatId, [
    "✅ 已添加允许查询用户",
    "",
    `用户：${user.name}`,
    `Chat ID：${user.chatId}`
  ].join("\n"));
}

async function handleUserDel(env, chatId, args) {
  const targetId = args[0];
  if (!targetId) {
    await sendTelegramMessage(env, chatId, "用法：/userdel 123456789");
    return;
  }
  const removed = await removeAllowedUser(env, targetId);
  await sendTelegramMessage(env, chatId, removed
    ? `✅ 已删除允许查询用户\n\nChat ID：${targetId}`
    : `未找到该授权用户。\n\nChat ID：${targetId}`);
}

async function formatUsers(env) {
  const users = await getAllowedUsers(env);
  if (!users.length) return "当前没有允许查询用户。";
  return ["👥 允许查询用户", "", ...users.map((user, index) => `${index + 1}. ${user.name || user.chatId}\n   Chat ID：${user.chatId}`)].join("\n");
}

async function formatUsersPanel(env, lang = "zh") {
  const users = await getAllowedUsers(env);
  const en = lang === "en";
  const settings = await getAccessSettings(env);
  if (!users.length) {
    return {
      text: en ? "No allowed users." : "当前没有授权用户。",
      replyMarkup: accessMenuKeyboard(settings, lang)
    };
  }
  const rows = users.slice(0, 20).map((user) => [{
    text: `${en ? "Remove" : "移除"} ${(user.name || user.chatId).slice(0, 24)}`,
    callback_data: `admin:user-remove:${user.chatId}`
  }]);
  rows.push([
    { text: en ? "Back to access" : "返回用户权限", callback_data: "admin:access-menu" },
    { text: en ? "Home" : "返回首页", callback_data: "menu:home" }
  ]);
  return {
    text: [
      en ? "Allowed users" : "授权用户",
      "",
      ...users.map((user, index) => `${index + 1}. ${user.name || user.chatId}\n   Chat ID: ${user.chatId}`),
      users.length > 20 ? (en ? "Only the first 20 users have remove buttons." : "仅前 20 名用户显示移除按钮。") : ""
    ].filter(Boolean).join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

async function handleAddMonitor(env, chatId, args) {
  if (args.length < 2) {
    await sendTelegramMessage(env, chatId, "用法：/add 9380 CHC S25 Ultra 国行");
    return;
  }
  try {
    const parsed = parseModelQuery(`${args[0]} ${args[1]}`, defaultCsc(env));
    const name = args.slice(2).join(" ") || `${parsed.model} ${parsed.csc}`;
    const item = await upsertMonitorItem(env, { model: parsed.model, csc: parsed.csc, name });
    await sendTelegramMessage(env, chatId, [
      "✅ 已添加监控设备",
      "",
      `设备：${item.name}`,
      `机型：${item.model}`,
      `地区：${item.csc}`,
      item.persistence?.mirrorPending
        ? "\n⚠️ KV 镜像当前受配额限制；主要监控状态已保存到 Durable Object，稍后会自动同步。"
        : ""
    ].filter(Boolean).join("\n"));
  } catch (error) {
    await sendTelegramMessage(env, chatId, `添加失败：${error.message}`);
  }
}

async function handleDelMonitor(env, chatId, args) {
  if (args.length < 2) {
    await sendTelegramMessage(env, chatId, "用法：/del 9380 CHC");
    return;
  }
  try {
    const parsed = parseModelQuery(`${args[0]} ${args[1]}`, defaultCsc(env));
    const existing = (await getMonitorItems(env)).find((item) => item.model === parsed.model && item.csc === parsed.csc);
    if (isRolloutManagedMonitor(existing)) {
      await sendTelegramMessage(env, chatId, "该设备由发布链管理，请在“发布链”中调整，不能使用 /del 删除。");
      return;
    }
    const removed = await removeMonitorItem(env, parsed.model, parsed.csc);
    await sendTelegramMessage(env, chatId, removed
      ? `✅ 已删除监控设备\n\n机型：${parsed.model}\n地区：${parsed.csc}`
      : `未找到监控设备。\n\n机型：${parsed.model}\n地区：${parsed.csc}`);
  } catch (error) {
    await sendTelegramMessage(env, chatId, `删除失败：${error.message}`);
  }
}

async function handleMonitorPriority(env, chatId, args) {
  if (args.length < 3 || !["high", "normal", "low"].includes(String(args[2] || "").toLowerCase())) {
    await sendTelegramMessage(env, chatId, `用法：/monpriority 9380 CHC high
可选：high / normal / low`);
    return;
  }
  const parsed = parseModelQuery(`${args[0]} ${args[1]}`, defaultCsc(env));
  const items = await getMonitorItems(env);
  const existing = items.find((item) => item.model === parsed.model && item.csc === parsed.csc);
  if (!existing) {
    await sendTelegramMessage(env, chatId, `未找到监控设备：${parsed.model} / ${parsed.csc}`);
    return;
  }
  if (isRolloutManagedMonitor(existing)) {
    await sendTelegramMessage(env, chatId, "该设备由发布链管理，请在“发布链”中调整优先级和状态。");
    return;
  }
  const item = await upsertMonitorItem(env, {
    ...existing,
    priority: String(args[2]).toLowerCase()
  });
  await sendTelegramMessage(env, chatId, `✅ 已设置监控优先级

${item.model} / ${item.csc}
优先级：${item.priority}`);
}

async function handleMonitorItemEnabled(env, chatId, args, enabled) {
  if (args.length < 2) {
    await sendTelegramMessage(env, chatId, `用法：/${enabled ? "monitemresume" : "monitempause"} 9380 CHC`);
    return;
  }
  try {
    const parsed = parseModelQuery(`${args[0]} ${args[1]}`, defaultCsc(env));
    const items = await getMonitorItems(env);
    const existing = items.find((item) => item.model === parsed.model && item.csc === parsed.csc);
    if (!existing) {
      await sendTelegramMessage(env, chatId, `未找到监控设备：${parsed.model} / ${parsed.csc}`);
      return;
    }
    if (isRolloutManagedMonitor(existing)) {
      await sendTelegramMessage(env, chatId, "该设备由发布链管理，请在“发布链”中调整状态。");
      return;
    }
    await cancelMonitorItemSnooze(env, parsed.model, parsed.csc);
    const item = await upsertMonitorItem(env, {
      ...existing,
      enabled,
      paused: !enabled,
      pauseReason: enabled ? "" : "admin_pause",
      pauseSource: "",
      pausedAt: "",
      resumeAt: "",
      adminDecision: enabled ? (existing.priority === "high" ? "keep_high" : existing.adminDecision) : "paused"
    });
    await sendTelegramMessage(env, chatId, [
      enabled ? "✅ 已恢复单个设备监控" : "⏸ 已暂停单个设备监控（配置已保留）",
      "",
      `${item.model} / ${item.csc}`,
      `优先级：${item.priority}`
    ].join("\n"));
  } catch (error) {
    await sendTelegramMessage(env, chatId, `操作失败：${error.message}`);
  }
}

async function handleMonitorSnoozeCommand(env, chatId, args) {
  if (args.length < 3) {
    await sendTelegramMessage(env, chatId, [
      "用法：/monsnooze MODEL CSC 时长",
      "",
      "示例：",
      "/monsnooze 9380 TGY 90m",
      "/monsnooze 938B EUX 6h",
      "/monsnooze 9480 CHC 2d",
      "",
      "范围：30 分钟至 30 天。"
    ].join("\n"));
    return;
  }
  try {
    const parsed = parseModelQuery(`${args[0]} ${args[1]}`, defaultCsc(env));
    const minutes = parseSnoozeDuration(args[2]);
    const items = await getMonitorItems(env);
    const existing = items.find((item) => item.model === parsed.model && item.csc === parsed.csc);
    if (!existing) {
      await sendTelegramMessage(env, chatId, `未找到监控设备：${parsed.model} / ${parsed.csc}`);
      return;
    }
    if (isRolloutManagedMonitor(existing)) {
      await sendTelegramMessage(env, chatId, "该设备由发布链管理，不能单独暂停。请在“发布链”中处理。" );
      return;
    }
    const resumeAt = new Date(Date.now() + minutes * 60 * 1000);
    const pending = await getPendingUpdate(env, parsed.model, parsed.csc);
    const result = await snoozeMonitorItem(env, parsed.model, parsed.csc, resumeAt, {
      requestedBy: chatId,
      updateVersion: pending?.newLatest || ""
    });
    if (!result?.ok) throw new Error(result?.error || "Unable to save timed pause");
    await markMonitorUpdateDecisionHandled(env, chatId, parsed.model, parsed.csc);
    await sendTelegramMessage(env, chatId, [
      "⏸ 已设置定时暂停监控",
      "",
      `${parsed.model} / ${parsed.csc}`,
      `自动恢复时间：${formatBeijingTime(resumeAt, "zh")}`,
      "",
      "恢复时机器人会通知管理员。"
    ].join("\n"), {
      inline_keyboard: [
        [{ text: "立即恢复", callback_data: `monitor-item:resume:${parsed.model}:${parsed.csc}` }],
        [{ text: "查看设备", callback_data: `monitor-item:view:${parsed.model}:${parsed.csc}` }]
      ]
    });
  } catch (error) {
    await sendTelegramMessage(env, chatId, `设置失败：${error.message}`);
  }
}

async function handleMonitorItemInterval(env, chatId, args) {
  const lang = await getUserLanguage(env, chatId);
  if (args.length < 3) {
    await sendTelegramMessage(env, chatId, lang === "en"
      ? "Usage: /moniteminterval MODEL CSC MINUTES\nExample: /moniteminterval 9480 TGY 5"
      : "用法：/moniteminterval MODEL CSC 分钟\n示例：/moniteminterval 9480 TGY 5");
    return;
  }
  await handleMonitorIntervalCommand(env, chatId, args);
}

async function handleMonitorIntervalCommand(env, chatId, args) {
  const lang = await getUserLanguage(env, chatId);
  if (args.length === 1) {
    const settings = uniformMonitorIntervalSettings(args[0]);
    if (!settings) {
      await sendTelegramMessage(env, chatId, lang === "en"
        ? ["Usage: /moninterval MINUTES", "Example: /moninterval 15", "Range: 1-1440 minutes"].join("\n")
        : ["用法：/moninterval 分钟", "示例：/moninterval 15", "范围：1-1440 分钟"].join("\n"));
      return;
    }
    const saved = await setMonitorIntervalSettings(env, settings);
    if (!saved.ok) {
      await sendTelegramMessage(env, chatId, lang === "en"
        ? "Unable to save: MonitorScheduler is unavailable."
        : "保存失败：MonitorScheduler 不可用。");
      return;
    }
    const panel = monitorIntervalsPanel(saved.settings, lang);
    await sendTelegramMessage(env, chatId, [
      lang === "en"
        ? `✅ Default monitoring interval set to ${settings.high} minutes.`
        : `✅ 已将默认监控间隔统一设置为 ${settings.high} 分钟。`,
      "",
      panel.text
    ].join("\n"), panel.replyMarkup);
    return;
  }

  if (args.length === 2) {
    const mode = normalizeMonitorIntervalMode(args[0]);
    const minutes = Number(args[1]);
    if (!mode || !Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      await sendTelegramMessage(env, chatId, lang === "en"
        ? [
            "Usage: /interval high|normal|low|idle|watch|hot|cooldown MINUTES",
            "Example: /interval high 3",
            "Range: 1-1440 minutes"
          ].join("\n")
        : [
            "用法：/interval high|normal|low|idle|watch|hot|cooldown 分钟",
            "示例：/interval high 3",
            "范围：1-1440 分钟"
          ].join("\n"));
      return;
    }
    const current = await getMonitorIntervalSettings(env);
    const saved = await setMonitorIntervalSettings(env, { ...current, [mode]: Math.floor(minutes) });
    if (!saved.ok) {
      await sendTelegramMessage(env, chatId, lang === "en"
        ? "Unable to save: MonitorScheduler is unavailable."
        : "保存失败：MonitorScheduler 不可用。");
      return;
    }
    const panel = monitorIntervalsPanel(saved.settings, lang);
    await sendTelegramMessage(env, chatId, panel.text, panel.replyMarkup);
    return;
  }

  if (args.length >= 3) {
    try {
      const parsed = parseModelQuery(`${args[0]} ${args[1]}`, defaultCsc(env));
      const minutes = Number(args[2]);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        throw new Error(lang === "en" ? "Interval must be 1-1440 minutes" : "间隔必须是 1-1440 分钟");
      }
      const items = await getMonitorItems(env);
      const existing = items.find((item) => item.model === parsed.model && item.csc === parsed.csc);
      if (!existing) {
        throw new Error(lang === "en"
          ? `Monitoring target not found: ${parsed.model} / ${parsed.csc}`
          : `未找到监控设备：${parsed.model} / ${parsed.csc}`);
      }
      if (isRolloutManagedMonitor(existing)) {
        throw new Error(lang === "en"
          ? "This target is managed by its rollout chain; set its interval in the Rollout panel."
          : "该设备由发布链管理，请在“发布链”中设置检查间隔。");
      }
      const item = await upsertMonitorItem(env, { ...existing, intervalMinutes: Math.floor(minutes) });
      await sendTelegramMessage(env, chatId, lang === "en"
        ? [
            "✅ Per-target monitoring interval saved",
            "",
            `${item.model} / ${item.csc}`,
            `Interval: ${item.intervalMinutes} minutes`,
            "This setting overrides the global default."
          ].join("\n")
        : [
            "✅ 已设置单设备监控间隔",
            "",
            `${item.model} / ${item.csc}`,
            `间隔：${item.intervalMinutes} 分钟`,
            "该设置优先于全局默认间隔。"
          ].join("\n"));
    } catch (error) {
      await sendTelegramMessage(env, chatId, lang === "en"
        ? `Unable to save: ${error.message}`
        : `设置失败：${error.message}`);
    }
    return;
  }

  const panel = monitorIntervalsPanel(await getMonitorIntervalSettings(env), lang);
  await sendTelegramMessage(env, chatId, panel.text, panel.replyMarkup);
}

async function formatMonitorList(env) {
  const items = standardMonitorItems(await getMonitorItems(env));
  {
  if (!items.length) return "\u5f53\u524d\u6ca1\u6709\u76d1\u63a7\u8bbe\u5907\u3002";
  const runtimes = await Promise.all(items.map((item) => getMonitorRuntime(env, item.model, item.csc)));
  return ["\ud83d\udce1 \u76d1\u63a7\u5217\u8868", "", ...items.map((item, index) => {
    const runtime = runtimes[index] || {};
    const interval = Number(item.intervalMinutes) > 0 ? Number(item.intervalMinutes) : "\u9ed8\u8ba4";
    return [`${index + 1}. ${item.name || `${item.model} / ${item.csc}`}`, `   ${item.model} · ${item.csc}`, `   \u72b6\u6001\uff1a${item.enabled === false ? "\u5df2\u6682\u505c" : "\u76d1\u63a7\u4e2d"}`, `   \u4f18\u5148\u7ea7\uff1a${item.priority || "normal"}`, `   \u95f4\u9694\uff1a${interval}${typeof interval === "number" ? " \u5206\u949f" : ""}`, `   \u8fde\u7eed\u5931\u8d25\uff1a${runtime.failureCount || 0}`].join("\n");
  })].join("\n");
  }
  /* legacy scored list retained below */
  if (!items.length) return `当前没有监控设备。

可以使用：/add 9380 CHC S25 Ultra 国行`;
  const [runtimes, intervalSettings] = await Promise.all([
    Promise.all(items.map((item) => getMonitorRuntime(env, item.model, item.csc))),
    getMonitorIntervalSettings(env)
  ]);
  return [
    "📡 当前监控设备",
    "",
    ...items.map((item, index) => {
      const runtime = runtimes[index];
      const nextRetry = runtime.nextAttemptAt ? formatBeijingTime(new Date(runtime.nextAttemptAt)) : "无";
      return [
        `${index + 1}. ${item.name || `${item.model} / ${item.csc}`}`,
        `   ${item.model} / ${item.csc}`,
        `   状态：${item.enabled === false ? "已暂停" : "监控中"}`,
        `   优先级：${item.priority || "normal"}`,
        item.prioritySource === "flagship_linkage" ? `   联动来源：${item.linkedFrom || "旗舰联动"}` : "",
        `   智能评分：${runtime.priorityScore || 0}`,
        item.enabled === false
          ? "   动态间隔：已暂停，不参与调度"
          : `   动态间隔：${Number(item.intervalMinutes) > 0 ? Number(item.intervalMinutes) : priorityIntervalMinutes(runtime.priorityScore, intervalSettings)} 分钟`,
        `   连续失败：${runtime.failureCount || 0}`,
        runtime.failureCount ? `   下次重试：${nextRetry}` : ""
      ].filter(Boolean).join("\n");
    })
  ].join("\n");
}

async function handleMonStart(env, chatId, args, lang = "zh") {
  const start = normalizeClockTime(args[0]);
  if (timeToMinutes(start) === null) {
    await sendTelegramMessage(env, chatId, [
      lang === "en" ? "Usage:" : "用法：",
      "/monstart 09:00",
      "/monstart 9:00",
      "/monstart 900",
      "/monstart 0930"
    ].join("\n"));
    return;
  }
  const schedule = await getMonitorSchedule(env);
  schedule.startTime = start;
  await setMonitorSchedule(env, schedule);
  await sendTelegramMessage(env, chatId, lang === "en"
    ? `✅ Automatic monitoring start time set to ${start} Beijing Time.`
    : `✅ 已设置自动监控开始时间：${start} 北京时间`);
}

async function handleMonEnd(env, chatId, args, lang = "zh") {
  const end = normalizeClockTime(args[0]);
  if (timeToMinutes(end) === null) {
    await sendTelegramMessage(env, chatId, [
      lang === "en" ? "Usage:" : "用法：",
      "/monend 23:59",
      "/monend 6:00",
      "/monend 600"
    ].join("\n"));
    return;
  }
  const schedule = await getMonitorSchedule(env);
  schedule.endTime = end;
  await setMonitorSchedule(env, schedule);
  await sendTelegramMessage(env, chatId, lang === "en"
    ? `✅ Automatic monitoring end time set to ${end} Beijing Time.`
    : `✅ 已设置自动监控结束时间：${end} 北京时间`);
}

async function handleMonInterval(env, chatId, args) {
  await handleMonitorIntervalCommand(env, chatId, args);
}

async function handleWeekend(env, chatId, args, lang = "zh") {
  const mode = String(args[0] || "").toLowerCase();
  if (!["on", "off"].includes(mode)) {
    await sendTelegramMessage(env, chatId, lang === "en"
      ? "Usage: /weekend off or /weekend on"
      : "用法：/weekend off 或 /weekend on");
    return;
  }
  const schedule = await getMonitorSchedule(env);
  schedule.skipWeekends = mode === "off";
  await setMonitorSchedule(env, schedule);
  await sendTelegramMessage(env, chatId, lang === "en"
    ? (mode === "on" ? "✅ Weekend automatic monitoring enabled." : "✅ Weekend automatic monitoring disabled.")
    : (mode === "on" ? "✅ 已开启周末自动监控。" : "✅ 已关闭周末自动监控。"));
}

function formatCheckNow(summary, lang = "zh") {
  if (lang === "en") {
    return [
      "✅ Manual monitor check completed",
      "",
      `Checked at: ${summary.time || formatBeijingTime(new Date(), "en")}`,
      `Devices checked: ${summary.checked}`,
      `Updates found: ${summary.updated}`,
      `Baselines initialized: ${summary.initialized}`,
      `Failures: ${summary.failed}`,
      `Fast retries scheduled: ${summary.retriedSoon || 0}`,
      `Long backoffs: ${summary.deferredFailures || 0}`,
      `In-flight tasks reused: ${summary.sharedInFlight || 0}`
    ].join("\n");
  }
  return [
    "✅ 手动检查完成",
    "",
    `检查时间：${summary.time || formatBeijingTime(new Date())}`,
    `检查设备：${summary.checked}`,
    `发现更新：${summary.updated}`,
    `首次记录：${summary.initialized}`,
    `失败数量：${summary.failed}`,
    `已安排快速重试：${summary.retriedSoon || 0}`,
    `长期退避：${summary.deferredFailures || 0}`,
    `复用进行中任务：${summary.sharedInFlight || 0}`
  ].join("\n");
}

async function formatPending(env) {
  const pending = await listPendingUpdates(env);
  if (!pending.length) return "\u5f53\u524d\u6ca1\u6709\u5f85\u786e\u8ba4\u7684\u65b0\u7248\u672c\u63d0\u9192\u3002";
  return [
    "\u5f85\u786e\u8ba4\u65b0\u7248\u672c",
    "",
    ...pending.map(({ value }, index) => [
      (index + 1) + ". " + (value.name || (value.model + " / " + value.csc)),
      "   " + value.model + " / " + value.csc,
      "   Android\uff1a" + (value.android || "\u672a\u77e5"),
      "   \u65b0\u7248\u672c\uff1a",
      "   " + (normalizeFirmwareVersion(value.newLatest) || value.newLatest),
      "   \u6765\u6e90\uff1a" + (value.source || "Samsung FUS SmartHistory"),
      "   \u63d0\u9192\u6b21\u6570\uff1a" + (value.reminderCount || 1),
      "   \u4e0a\u6b21\u63d0\u9192\uff1a" + formatBeijingTime(new Date(value.lastReminderAt)),
      "",
      "----------------"
    ].join("\n")),
    "",
    "请使用下方按钮选择：按原计划继续，或暂停后自动恢复。",
    "",
    "兼容命令 /ack 仍可仅停止提醒，不改变监控计划。"
  ].join("\n");
}

async function formatPendingPanel(env, lang = "zh") {
  const pending = await listPendingUpdates(env);
  if (!pending.length) {
    return {
      text: lang === "en" ? "No pending update reminders." : "当前没有待确认的新版本提醒。",
      replyMarkup: monitorMenuKeyboard(lang)
    };
  }
  const rows = pending.slice(0, 20).flatMap((entry) => [[
    {
      text: `${lang === "en" ? "Continue" : "继续"} ${entry.value.model} / ${entry.value.csc}`,
      callback_data: `monitor-update:continue:${entry.value.model}:${entry.value.csc}`
    },
    {
      text: lang === "en" ? "Resume later" : "稍后恢复",
      callback_data: `monitor-update:snooze-menu:${entry.value.model}:${entry.value.csc}`
    }
  ]]);
  rows.push([
    { text: lang === "en" ? "Back to monitoring" : "返回监控中心", callback_data: "admin:monitor-menu" },
    { text: lang === "en" ? "Home" : "返回首页", callback_data: "menu:home" }
  ]);
  return {
    text: await formatPending(env),
    replyMarkup: { inline_keyboard: rows }
  };
}

async function formatStatus(env, chatId, identity, lang = "zh") {
  if (identity === "unauthorized") {
    if (lang === "en") {
      return [
        "You do not have query permission yet.",
        "Send /apply to request whitelist access, or send /whoami and share your Chat ID with the owner."
      ].join("\n");
    }
    return [
      "你还没有查询权限。",
      "请发送 /whoami，把 Chat ID 发给管理员开通。"
    ].join("\n");
  }

  if (identity !== "admin") {
    if (lang === "en") {
      return [
        "OneUI Firmware Worker Status",
        `Version: ${APP_VERSION}`,
        "",
        "Identity: Whitelisted user",
        `Current Time: ${formatBeijingTime(new Date(), "en")}`,
        "Query Permission: Enabled",
        `Query Cache: L1 ${l1CacheTtlSeconds(env)}s / canonical ${firmwareCacheFreshSeconds(env)}s; recent stale History is verified in the background`
      ].join("\n");
    }
    return [
      "OneUI Firmware Worker 状态",
      `版本：${APP_VERSION}`,
      "",
      "身份：已授权用户",
      `当前时间：${formatBeijingTime(new Date())}`,
      "查询权限：已开启",
      `查询缓存：L1 ${l1CacheTtlSeconds(env)} 秒 / 权威缓存 ${firmwareCacheFreshSeconds(env)} 秒；近期旧 History 会后台核对`
    ].join("\n");
  }

  const [schedule, summarySettings, items, users, accessSettings, intervalSettings] = await Promise.all([
    getMonitorSchedule(env),
    getMonitorSummarySettings(env),
    getMonitorItems(env),
    getAllowedUsers(env),
    getAccessSettings(env),
    getMonitorIntervalSettings(env)
  ]);
  const sharedInterval = sharedMonitorIntervalMinutes(intervalSettings);

  const lines = [
    "OneUI Firmware Worker 状态",
    `版本：${APP_VERSION}`,
    "",
    "身份：管理员",
    `申请自动通过：${accessSettings.autoApprove ? "开启" : "关闭"}`,
    `自动监控：${schedule.enabled ? "开启" : "暂停"}`,
    `时区：${schedule.timezone || "Asia/Shanghai"}`,
    `当前时间：${formatBeijingTime(new Date())}`,
    `开始时间：${schedule.startTime} 北京时间`,
    `结束时间：${schedule.endTime} 北京时间`,
    `监控调度：${sharedInterval === null
      ? "旧自适应策略（可用 /moninterval 分钟 统一设置）"
      : `统一间隔 ${sharedInterval} 分钟`}`,
    `周末监控：${schedule.skipWeekends ? "关闭" : "开启"}`,
    `每日管理员摘要：${summarySettings.enabled ? `开启（${String(summarySettings.hour).padStart(2, "0")}:00 北京时间）` : "关闭"}`,
    "Cron 唤醒频率：1 分钟",
    `提醒间隔：${reminderIntervalMinutes(env)} 分钟`,
    `查询缓存：L1 ${l1CacheTtlSeconds(env)} 秒 / 权威 ${firmwareCacheFreshSeconds(env)} 秒 / SWR ${queryStaleWhileRevalidateSeconds(env)} 秒`,
    `监控设备数：${items.length}`,
    `授权用户数：${users.length}`,
    "更新通知：发现后仅发送一次",
    `全局查询协调器：${env.FIRMWARE_QUERY_COORDINATOR ? "已启用" : "未绑定（本地兼容模式）"}`,
    `Telegram 通知队列：${env.NOTIFICATION_QUEUE ? "已启用" : "未绑定（直接发送模式）"}`
  ];
  if (accessSettings.autoApprove && accessSettings.autoApproveExpiresAt) {
    lines.splice(4, 0, `自动通过关闭时间：${formatBeijingTime(new Date(accessSettings.autoApproveExpiresAt))}`);
  }

  return lines.join("\n");
}
