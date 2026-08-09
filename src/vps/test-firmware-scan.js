import { randomUUID } from "node:crypto";
import {
  answerCallbackQuery,
  chatIdFromUpdate,
  editTelegramMessageResult,
  sendTelegramMessageResult,
  sendTelegramMessage,
  textFromUpdate
} from "../telegram.js";
import { enqueueTelegramNotification } from "../notification-queue.js";
import {
  forceMonitorDue,
  getAdminChatIds,
  getAllowedUsers,
  getFirmwareQueryCache,
  getMonitorRuntime,
  getUserDevices,
  getUserLanguage,
  getIdentity,
  upsertMonitorItem
} from "../state.js";
import { pauseAllRolloutChains } from "../rollout-chain.js";
import { validateModelCsc } from "../targets.js";
import { beijingDateKey, beijingParts, formatBeijingTime } from "../utils.js";
import { runTestFirmwareDecryptor } from "./test-firmware-decryptor.js";
import { createTestFirmwareHistoryRepository } from "./test-firmware-history.js";

const SCAN_LOCK_KEY = "test-firmware:scan";
const DEFAULT_SCAN_LOCK_MS = 2 * 60 * 60 * 1000;
const PIPELINE_STARTUP_SCAN_ID = "s948n-koo-eux-v2";
const KOO_TARGET = Object.freeze({ model: "SM-S948N", csc: "KOO" });
const EUX_TARGET = Object.freeze({ model: "SM-S948B", csc: "EUX" });

function safeText(value, fallback = "") {
  const result = String(value ?? fallback).trim();
  return result || fallback;
}

function configFor(runtime) {
  return runtime?.config || {};
}

function repositoryFor(runtime) {
  if (runtime.testFirmwareHistory) return runtime.testFirmwareHistory;
  const repository = createTestFirmwareHistoryRepository(runtime.pool);
  runtime.testFirmwareHistory = repository;
  return repository;
}

async function pipelineStateFor(runtime) {
  const repository = repositoryFor(runtime);
  return typeof repository.getPipelineState === "function"
    ? repository.getPipelineState()
    : { euxEnabled: false, startupScanId: "", kooConfirmedVersion: "" };
}

function pipelineTargets(state) {
  return state?.euxEnabled ? [KOO_TARGET, EUX_TARGET] : [KOO_TARGET];
}

function isEuxTarget(item) {
  return isTarget(item, EUX_TARGET);
}

function resolvedVersionFromRows(rows) {
  const row = rows
    .filter((entry) => entry.decryptStatus === "resolved" && entry.pda && entry.cscBuild && entry.cp)
    .sort((a, b) => (Date.parse(String(b.lastSeenAt || "")) || 0) - (Date.parse(String(a.lastSeenAt || "")) || 0))[0];
  return row ? [row.pda, row.cscBuild, row.cp].join("/") : "";
}

function scanNow(value) {
  return value instanceof Date ? value : new Date(value || Date.now());
}

function stableHashKey(hashType, hashValue) {
  return `${String(hashType || "").toLowerCase()}:${String(hashValue || "").toLowerCase()}`;
}

function hashRowsToPayload(rows) {
  return rows.map((row) => ({
    hash_type: row.hashType ?? row.hash_type,
    hash_value: row.hashValue ?? row.hash_value,
    decrypt_status: row.decryptStatus ?? row.decrypt_status
  }));
}

function targetLabel(item) {
  return `${item.model} / ${item.csc}`;
}

function isTarget(item, target) {
  return item?.model === target.model && item?.csc === target.csc;
}

function fullVersion(match) {
  return String(match.version || [match.pda, match.csc_build, match.cp].filter(Boolean).join("/") || "未知");
}

function testBuildText(item, match, at, lang = "zh") {
  if (lang === "en") {
    return [
      "🆕 New Samsung test firmware!",
      "",
      targetLabel(item),
      "",
      `Full firmware version: ${fullVersion(match)}`
    ].join("\n");
  }
  return [
    "🆕 新 Samsung 测试固件！",
    "",
    targetLabel(item),
    "",
    `完整固件版本号：${fullVersion(match)}`
  ].join("\n");
}

function unresolvedText(item, hash, at, lang = "zh") {
  if (lang === "en") {
    return [
      "⚠️ New unresolved Samsung Test Hash",
      "",
      targetLabel(item),
      `Hash: ${String(hash.hash_value || "")}`,
      `Type: ${String(hash.hash_type || "").toUpperCase()}`,
      `Time: ${formatBeijingTime(at, "en")}`
    ].join("\n");
  }
  return [
    "⚠️ 发现暂未解密的测试 Hash",
    "",
    targetLabel(item),
    `Hash：${String(hash.hash_value || "")}`,
    `类型：${String(hash.hash_type || "").toUpperCase()}`,
    `时间：${formatBeijingTime(at, "zh")}`
  ].join("\n");
}

function notificationKeyboard(item, { manager = false, pipelineState = null } = {}) {
  const rows = [];
  if (manager && isTarget(item, KOO_TARGET) && !pipelineState?.euxEnabled) {
    rows.push([{ text: "✅ 确认并开启 EUX 解密", callback_data: "test-fw:confirm-eux" }]);
  }
  rows.push(
    [{ text: "查询详情", callback_data: `query:refresh:${item.model}:${item.csc}` }],
    [{ text: "首页", callback_data: "menu:home" }]
  );
  return {
    inline_keyboard: rows
  };
}

async function allowedRecipients(env, item) {
  const adminIds = await getAdminChatIds(env);
  const adminSet = new Set(adminIds.map((id) => String(id)));
  const users = await getAllowedUsers(env);
  const recipients = adminIds.map((chatId) => ({ chatId: String(chatId), manager: true }));
  if (String(env.NOTIFY_ALLOWED_USERS_ON_UPDATE ?? "true").toLowerCase() === "false") return recipients;
  for (const user of users) {
    const chatId = String(user.chatId || "").trim();
    if (!chatId || adminSet.has(chatId)) continue;
    const devices = await getUserDevices(env, chatId);
    if (!devices.length || devices.some((device) =>
      String(device.model || "").toUpperCase() === item.model &&
      String(device.csc || "").toUpperCase() === item.csc &&
      device.notifyEnabled !== false
    )) recipients.push({ chatId, manager: false });
  }
  return recipients;
}

async function broadcastResolved(runtime, item, match, at, pipelineState) {
  const env = runtime.env;
  const recipients = await allowedRecipients(env, item);
  let queued = 0;
  let attempted = 0;
  for (const recipient of recipients) {
    attempted += 1;
    try {
      const lang = await getUserLanguage(env, recipient.chatId);
      const delivery = await enqueueTelegramNotification(env, {
        id: `test-firmware:${item.model}:${item.csc}:${match.hash_type}:${match.hash_value}:${recipient.chatId}`,
        chatId: recipient.chatId,
        text: testBuildText(item, match, at, lang),
        replyMarkup: notificationKeyboard(item, { manager: recipient.manager, pipelineState }),
        monitorEvent: {
          type: "test_build_detected",
          model: item.model,
          csc: item.csc,
          audience: recipient.manager ? "manager" : "allowed_user",
          source: "Samsung version.test.xml"
        }
      });
      if (delivery?.queued || delivery?.sent) queued += 1;
    } catch (error) {
      console.log(`[test-fw] broadcast failed for ${item.model}/${item.csc}: ${String(error?.message || error).slice(0, 180)}`);
    }
  }
  return { attempted, queued };
}

async function warnAdmins(runtime, item, hash, at) {
  const env = runtime.env;
  const admins = await getAdminChatIds(env);
  let queued = 0;
  for (const chatId of admins) {
    try {
      const lang = await getUserLanguage(env, chatId);
      const delivery = await enqueueTelegramNotification(env, {
        id: `test-firmware-unresolved:${item.model}:${item.csc}:${hash.hash_type}:${hash.hash_value}:${chatId}`,
        chatId,
        text: unresolvedText(item, hash, at, lang),
        monitorEvent: {
          type: "test_build_unresolved",
          model: item.model,
          csc: item.csc,
          audience: "manager",
          source: "Samsung version.test.xml"
        }
      });
      if (delivery?.queued || delivery?.sent) queued += 1;
    } catch (error) {
      console.log(`[test-fw] unresolved warning failed for ${item.model}/${item.csc}: ${String(error?.message || error).slice(0, 180)}`);
    }
  }
  return { attempted: admins.length, queued };
}

async function currentLatestVersion(env, item) {
  try {
    const cached = await getFirmwareQueryCache(env, item.model, item.csc);
    if (cached?.latest) return String(cached.latest);
  } catch (error) {
    console.log(`[test-fw] latest cache read deferred for ${targetLabel(item)}: ${String(error?.message || error).slice(0, 160)}`);
  }
  try {
    const runtime = await getMonitorRuntime(env, item.model, item.csc);
    return String(runtime?.lastVersion || "");
  } catch {
    return "";
  }
}

export async function scanTestFirmwareTarget(runtime, item, { retryUnresolved = false, now = new Date(), logger = console, testXml = null, latestVersionOverride = "", onProgress = null } = {}) {
  const target = validateModelCsc(item.model, item.csc);
  const repository = repositoryFor(runtime);
  const at = scanNow(now);
  const pipelineState = await pipelineStateFor(runtime);
  if (isEuxTarget(target) && !pipelineState.euxEnabled) {
    const failure = {
      status: "failed",
      model: target.model,
      csc: target.csc,
      error: "SM-S948B/EUX is waiting for administrator confirmation of SM-S948N/KOO",
      hashCount: 0,
      newHashCount: 0
    };
    await repository.recordTargetCheck(target.model, target.csc, failure, at.toISOString());
    return failure;
  }
  const known = await repository.listHashes(target.model, target.csc);
  const retryHashes = retryUnresolved
    ? known.filter((row) => String(row.decryptStatus || "") === "unresolved")
    : [];
  const latestVersion = String(latestVersionOverride || await currentLatestVersion(runtime.env, target) || "");
  const testXmlOverride = typeof testXml === "function" ? testXml(target) : testXml;
  logger.info?.(`[test-fw] target ${target.model}/${target.csc}`);
  let result;
  try {
    result = await runTestFirmwareDecryptor({
      model: target.model,
      csc: target.csc,
      knownHashes: hashRowsToPayload(known),
      retryUnresolved,
      retryHashes: hashRowsToPayload(retryHashes),
      latestVersion,
      timeoutSeconds: Math.max(5, Math.floor(Number(configFor(runtime).testFirmwareRequestTimeoutMs || 12) / 1000)),
      maxCandidates: Number(configFor(runtime).testFirmwareMaxCandidates || 10_000_000),
      ...(testXmlOverride !== null && testXmlOverride !== undefined
        ? { testXml: String(testXmlOverride) }
        : {})
    }, {
      env: runtime.env,
      timeoutMs: Number(configFor(runtime).testFirmwareDecryptTimeoutMs || 120_000),
      logger,
      onProgress: (progress) => onProgress?.({ ...progress, model: target.model, csc: target.csc })
    });
  } catch (error) {
    const failure = { status: "failed", error: String(error?.message || error).slice(0, 240), hashCount: 0, newHashCount: 0 };
    await repository.recordTargetCheck(target.model, target.csc, failure, at.toISOString());
    logger.warn?.(`[test-fw] target ${target.model}/${target.csc} failed: ${failure.error}`);
    return { ...failure, model: target.model, csc: target.csc };
  }
  if (!result?.ok) {
    const failure = { status: "failed", error: String(result?.error || "Samsung test firmware request failed").slice(0, 240), hashCount: 0, newHashCount: 0 };
    await repository.recordTargetCheck(target.model, target.csc, failure, at.toISOString());
    logger.warn?.(`[test-fw] target ${target.model}/${target.csc} failed: ${failure.error}`);
    return { ...failure, model: target.model, csc: target.csc };
  }

  const selectedHashes = Array.isArray(result.selectedHashes) ? result.selectedHashes : [];
  const matches = Array.isArray(result.matches) ? result.matches : [];
  const unresolved = Array.isArray(result.unresolved) ? result.unresolved : [];
  const matchedKeys = new Set(matches.map((match) => stableHashKey(match.hash_type, match.hash_value)));
  let notified = 0;
  let warnings = 0;
  for (const match of matches) {
    const row = await repository.upsertResolved({
      model: target.model,
      csc: target.csc,
      hashType: match.hash_type,
      hashValue: match.hash_value,
      pda: match.pda,
      cscBuild: match.csc_build,
      cp: match.cp,
      source: match.source || "Samsung version.test.xml + verified MD5(build)"
    });
    if (!row.notifiedAt) {
      const delivery = await broadcastResolved(runtime, target, match, at, pipelineState);
      if (delivery.queued > 0) {
        await repository.markNotified(target.model, target.csc, match.hash_type, match.hash_value, at.toISOString());
        notified += 1;
      }
    }
    // Only the confirmed EUX stage activates official monitoring. KOO is the
    // review gate and must not start the official monitor by itself.
    if (isEuxTarget(target) && pipelineState.euxEnabled) {
      try {
        await upsertMonitorItem(runtime.env, {
          model: target.model,
          csc: target.csc,
          enabled: true,
          paused: false,
          pauseReason: "",
          testFirmwareMonitorOverride: true
        });
        await forceMonitorDue(runtime.env, target.model, target.csc, at);
        logger.info?.(`[test-fw] EUX decrypt success; official monitor activated for ${target.model}/${target.csc}`);
      } catch (error) {
        logger.warn?.(`[test-fw] monitor activation deferred for ${target.model}/${target.csc}: ${String(error?.message || error).slice(0, 180)}`);
      }
    }
  }
  for (const hash of unresolved) {
    const key = stableHashKey(hash.hash_type, hash.hash_value);
    if (matchedKeys.has(key)) continue;
    const row = await repository.upsertUnresolved({
      model: target.model,
      csc: target.csc,
      hashType: hash.hash_type,
      hashValue: hash.hash_value,
      reason: hash.reason || "no_verified_candidate_match",
      source: "Samsung version.test.xml"
    });
    if (!row.adminWarningAt) {
      const warning = await warnAdmins(runtime, target, hash, at);
      if (warning.queued > 0) {
        await repository.markAdminWarning(target.model, target.csc, hash.hash_type, hash.hash_value, at.toISOString());
        warnings += 1;
      }
    }
  }

  const summary = {
    status: selectedHashes.length === 0 ? "unchanged" : matches.length ? "resolved" : "unresolved",
    model: target.model,
    csc: target.csc,
    hashCount: Array.isArray(result.hashes) ? result.hashes.length : 0,
    newHashCount: selectedHashes.length,
    resolvedCount: matches.length,
    unresolvedCount: unresolved.length,
    notified,
    warnings,
    candidateLimitReached: Boolean(result.candidateLimitReached),
    latestVersion
  };
  await repository.recordTargetCheck(target.model, target.csc, summary, at.toISOString());
  if (summary.newHashCount === 0) logger.info?.(`[test-fw] hashes known; no new hash for ${target.model}/${target.csc}`);
  else if (summary.resolvedCount) logger.info?.(`[test-fw] resolved ${summary.resolvedCount} new build(s) for ${target.model}/${target.csc}`);
  else logger.warn?.(`[test-fw] unresolved new hash for ${target.model}/${target.csc}`);
  return summary;
}

export async function executeTestFirmwareScan(runtime, { target = null, retryUnresolved = false, chatId = "", progressChatId = chatId, now = new Date(), logger = console, testXml = null, latestVersionOverride = "" } = {}) {
  const pipelineState = await pipelineStateFor(runtime);
  const items = target
    ? [validateModelCsc(target.model, target.csc)]
    : pipelineTargets(pipelineState).map((item) => ({ ...item }));
  const progress = progressChatId ? await createTestFirmwareProgress(runtime.env, progressChatId, items) : null;
  const results = [];
  for (const item of items) {
    progress?.setTarget(item, results.length, items.length);
    try {
      results.push(await scanTestFirmwareTarget(runtime, item, {
        retryUnresolved,
        now,
        logger,
        testXml,
        latestVersionOverride,
        onProgress: (event) => progress?.update(event)
      }));
    } catch (error) {
      const result = { status: "failed", model: item.model, csc: item.csc, error: String(error?.message || error).slice(0, 240) };
      results.push(result);
      logger.error?.(`[test-fw] target ${targetLabel(item)} crashed: ${result.error}`);
    }
  }
  const failed = results.filter((result) => result.status === "failed").length;
  const resolved = results.reduce((sum, result) => sum + Number(result.resolvedCount || 0), 0);
  const unresolved = results.reduce((sum, result) => sum + Number(result.unresolvedCount || 0), 0);
  const summary = { ok: failed === 0, total: results.length, failed, resolved, unresolved, results };
  if (progress) await progress.finish(summary);
  else if (chatId) await sendTestScanSummary(runtime.env, chatId, summary);
  return summary;
}

function progressBar(percent, width = 12) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((value / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function progressText(target, event = {}, index = 0, total = 1, summary = null) {
  const percent = event.maxCandidates > 0
    ? Math.min(99, Math.floor((event.candidates / event.maxCandidates) * 100))
    : event.phase === "finalizing" ? 100 : 0;
  const phase = event.phase === "finalizing" ? "整理解密结果" : "计算候选版本";
  const header = summary
    ? (summary.ok ? "✅ 测试固件解密完成" : "⚠️ 测试固件解密完成，但有目标失败")
    : "🔐 正在解密测试固件";
  const lines = [
    header,
    "",
    `目标：${target?.model || ""} / ${target?.csc || ""}`,
    `阶段：${summary ? "已完成" : phase}`,
    `进度：${progressBar(summary ? 100 : percent)} ${summary ? 100 : percent}%`,
    event.maxCandidates > 0 ? `候选：${Number(event.candidates || 0).toLocaleString()} / ${Number(event.maxCandidates).toLocaleString()}` : "候选：准备中",
    `已匹配：${Number(event.matched || 0)}`,
    total > 1 ? `目标序号：${Math.min(total, index + 1)} / ${total}` : ""
  ];
  if (summary) {
    lines.push(`成功解密：${summary.resolved}`, `失败：${summary.failed}`);
  }
  return lines.filter(Boolean).join("\n");
}

async function createTestFirmwareProgress(env, chatId, items) {
  const first = items[0] || {};
  const sent = await sendTelegramMessageResult(env, chatId, progressText(first, {}, 0, items.length));
  if (!sent.ok || !sent.messageId) return null;
  const state = {
    chatId: String(chatId),
    messageId: sent.messageId,
    target: first,
    index: 0,
    total: items.length,
    lastAt: 0,
    lastText: "",
    pending: Promise.resolve(),
    setTarget(target, index, total) {
      this.target = target;
      this.index = index;
      this.total = total;
      this.update({ phase: "decrypting", candidates: 0, maxCandidates: 0, matched: 0 }, true);
    },
    update(event = {}, force = false) {
      if (!this.messageId) return;
      const now = Date.now();
      if (!force && now - this.lastAt < 2000) return;
      const text = progressText(this.target, event, this.index, this.total);
      if (text === this.lastText) return;
      this.lastAt = now;
      this.lastText = text;
      this.pending = this.pending
        .then(() => editTelegramMessageResult(env, this.chatId, this.messageId, text))
        .catch(() => {});
    },
    async finish(summary) {
      this.update({ phase: "finalizing", candidates: 0, maxCandidates: 0, matched: summary.resolved }, true);
      const text = progressText(this.target, { phase: "finalizing", candidates: 0, maxCandidates: 0, matched: summary.resolved }, this.index, this.total, summary);
      if (this.messageId && text !== this.lastText) {
        this.lastText = text;
        this.pending = this.pending
          .then(() => editTelegramMessageResult(env, this.chatId, this.messageId, text))
          .catch(() => {});
      }
      await this.pending;
    }
  };
  return state;
}

export async function confirmKooAndEnableEux(runtime, chatId, logger = console) {
  const repository = repositoryFor(runtime);
  const state = await pipelineStateFor(runtime);
  if (state.euxEnabled) {
    return { ok: true, already: true, version: state.kooConfirmedVersion };
  }
  const rows = await repository.listHashes(KOO_TARGET.model, KOO_TARGET.csc);
  const version = resolvedVersionFromRows(rows);
  if (!version) return { ok: false, reason: "koo_not_resolved" };

  const next = await repository.confirmKooAndEnableEux(version, chatId, new Date().toISOString());
  let queued = false;
  try {
    await runtime.queues.maintenance.add("oneui", {
      id: `test-firmware-eux:${randomUUID()}`,
      kind: "test-firmware-eux-scan",
      target: { ...EUX_TARGET },
      retryUnresolved: true,
      chatId: String(chatId || ""),
      createdAt: new Date().toISOString()
    }, { attempts: 1, removeOnComplete: { age: 24 * 60 * 60, count: 100 } });
    queued = true;
  } catch (error) {
    logger.error?.(`[test-fw] EUX scan enqueue failed: ${String(error?.message || error).slice(0, 180)}`);
  }
  return { ok: true, already: false, version: next.kooConfirmedVersion || version, queued };
}

export async function bootstrapTestFirmwarePipeline(runtime, logger = console) {
  const config = configFor(runtime);
  if (config.testFirmwareScanEnabled === false) return { queued: false, reason: "disabled" };
  const repository = repositoryFor(runtime);
  const claimed = await repository.claimStartupScan(PIPELINE_STARTUP_SCAN_ID, new Date().toISOString());
  if (!claimed) return { queued: false, reason: "already_claimed" };
  try {
    await pauseAllRolloutChains(runtime.env);
    await runtime.queues.maintenance.add("oneui", {
      id: `test-firmware-startup:${PIPELINE_STARTUP_SCAN_ID}`,
      kind: "test-firmware-startup-scan",
      target: { ...KOO_TARGET },
      retryUnresolved: true,
      chatId: String(runtime.env.TELEGRAM_CHAT_ID || ""),
      createdAt: new Date().toISOString()
    }, { jobId: `test-firmware-startup:${PIPELINE_STARTUP_SCAN_ID}`, attempts: 1, removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100 } });
    logger.info?.(`[test-fw] startup pipeline queued for ${targetLabel(KOO_TARGET)}`);
    return { queued: true, target: { ...KOO_TARGET } };
  } catch (error) {
    await repository.releaseStartupScan(PIPELINE_STARTUP_SCAN_ID, new Date().toISOString()).catch(() => {});
    logger.error?.(`[test-fw] startup pipeline enqueue failed: ${String(error?.message || error).slice(0, 180)}`);
    return { queued: false, reason: "enqueue_failed" };
  }
}

async function sendTestScanSummary(env, chatId, summary) {
  const lines = [
    summary.ok ? "✅ 测试固件扫描完成" : "⚠️ 测试固件扫描完成，但有目标失败",
    `目标：${summary.total}`,
    `成功解密：${summary.resolved}`,
    `未解密：${summary.unresolved}`,
    `失败：${summary.failed}`
  ];
  const failures = summary.results.filter((result) => result.status === "failed").slice(0, 8);
  for (const failure of failures) lines.push(`• ${failure.model}/${failure.csc}：${failure.error || "请求失败"}`);
  await sendTelegramMessage(env, chatId, lines.join("\n"));
}

async function withScanLock(runtime, task, logger = console) {
  const lockMs = Math.max(60_000, Number(configFor(runtime).testFirmwareScanLockMs || DEFAULT_SCAN_LOCK_MS));
  const claim = await runtime.context.locks.acquire(SCAN_LOCK_KEY, lockMs);
  if (!claim?.acquired) return { acquired: false, summary: null };
  const refreshMs = Math.max(30_000, Math.floor(lockMs / 3));
  const heartbeat = setInterval(() => {
    runtime.context.locks.refresh(SCAN_LOCK_KEY, claim.token, lockMs).catch((error) => {
      logger.warn?.(`[test-fw] scan lock refresh failed: ${String(error?.message || error).slice(0, 160)}`);
    });
  }, refreshMs);
  heartbeat.unref?.();
  try {
    return { acquired: true, summary: await task() };
  } finally {
    clearInterval(heartbeat);
    await runtime.context.locks.release(SCAN_LOCK_KEY, claim.token).catch(() => {});
  }
}

export async function runTestFirmwareScanWithLock(runtime, options = {}) {
  return withScanLock(runtime, () => executeTestFirmwareScan(runtime, options), options.logger || console);
}

export async function withTestFirmwareScanLock(runtime, task, logger = console) {
  if (typeof task !== "function") throw new TypeError("test firmware scan task is required");
  return withScanLock(runtime, task, logger);
}

export async function maybeScheduleTestFirmwareScan(runtime, now = new Date(), logger = console) {
  const config = configFor(runtime);
  if (config.testFirmwareScanEnabled === false) return { scheduled: false, reason: "disabled" };
  const parts = beijingParts(now);
  const dateKey = beijingDateKey(now);
  const repository = repositoryFor(runtime);
  // Use the first Beijing hour as the cleanup window so a delayed/restarted
  // scheduler cannot miss the exact 00:00 minute.
  if (parts.hour === "00") {
    if (await repository.claimDailyCleanup(dateKey)) {
      await repository.cleanupTransient(dateKey, config.testFirmwareCacheRetentionDays || 90);
      logger.info?.(`[test-fw] daily transient cache cleanup completed for ${dateKey}`);
    }
  }
  const scheduledTime = String(config.testFirmwareScanTime || "18:00");
  const [hour, minute] = scheduledTime.split(":").map((value) => Number(value));
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const startMinutes = Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 1080;
  if (currentMinutes < startMinutes || currentMinutes >= startMinutes + 60) return { scheduled: false, reason: "outside_window" };
  const claim = await repository.claimScheduled(dateKey, new Date(now).toISOString());
  if (!claim.claimed) return { scheduled: false, reason: "already_claimed" };
  try {
    await runtime.queues.maintenance.add("oneui", {
      id: `test-firmware-scheduled:${dateKey}`,
      kind: "test-firmware-scheduled-scan",
      dateKey,
      createdAt: new Date(now).toISOString()
    }, { jobId: `test-firmware-scheduled:${dateKey}`, attempts: 1, removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100 } });
    logger.info?.(`[test-fw] scheduled scan queued for ${dateKey}`);
    return { scheduled: true, dateKey };
  } catch (error) {
    await repository.finishScheduled(dateKey, "failed", String(error?.message || error).slice(0, 240));
    logger.error?.(`[test-fw] scheduled scan enqueue failed: ${String(error?.message || error).slice(0, 180)}`);
    return { scheduled: false, reason: "enqueue_failed" };
  }
}

export async function processTestFirmwareMaintenanceJob(job, runtime, logger = console) {
  const data = job?.data || {};
  if (!["test-firmware-scheduled-scan", "test-firmware-manual-scan", "test-firmware-startup-scan", "test-firmware-eux-scan"].includes(data.kind)) return null;
  const repository = repositoryFor(runtime);
  if (data.kind === "test-firmware-scheduled-scan") {
    const locked = await runTestFirmwareScanWithLock(runtime, { logger });
    const summary = locked.acquired ? locked.summary : { ok: false, failed: 1, error: "scan already running" };
    await repository.finishScheduled(data.dateKey, summary.ok ? "completed" : "failed", summary.ok ? "" : "one or more targets failed");
    return summary;
  }
  const locked = await runTestFirmwareScanWithLock(runtime, {
    target: data.target || null,
    retryUnresolved: Boolean(data.retryUnresolved),
    chatId: data.chatId || "",
    progressChatId: data.chatId || "",
    logger
  });
  if (!locked.acquired && data.chatId) {
    await sendTelegramMessage(runtime.env, data.chatId, "⏳ Samsung 测试固件扫描正在运行，请等待当前任务完成。");
  }
  const summary = locked.acquired ? locked.summary : { ok: false, reason: "already_running" };
  if (data.kind === "test-firmware-startup-scan" && !summary.ok) {
    await repository.releaseStartupScan(PIPELINE_STARTUP_SCAN_ID, new Date().toISOString()).catch(() => {});
  }
  return summary;
}

export async function handleTestFirmwareTelegramCallback(update, runtime, logger = console) {
  const callback = update?.callback_query;
  if (String(callback?.data || "") !== "test-fw:confirm-eux") return false;
  const chatId = String(chatIdFromUpdate(update) || "").trim();
  if (!chatId) return true;
  if (await getIdentity(runtime.env, chatId) !== "admin") {
    await answerCallbackQuery(runtime.env, callback.id, "无权限", { showAlert: true });
    return true;
  }
  await answerCallbackQuery(runtime.env, callback.id, "正在确认…");
  const result = await confirmKooAndEnableEux(runtime, chatId, logger);
  const text = !result.ok
    ? "⏳ 尚未发现可确认的 SM-S948N / KOO 测试固件，请先等待启动扫描完成。"
    : result.already
      ? `SM-S948B / EUX 已开启。\n确认版本：${result.version || "已记录"}`
      : `✅ 已确认 SM-S948N / KOO\n版本：${result.version}\n\n已开启 SM-S948B / EUX 自动解密。\n解密成功后将自动开始正式监控。`;
  const messageId = callback.message?.message_id;
  const edited = await editTelegramMessageResult(runtime.env, chatId, messageId, text, {
    inline_keyboard: [[{ text: "查询详情", callback_data: `query:refresh:${KOO_TARGET.model}:${KOO_TARGET.csc}` }], [{ text: "首页", callback_data: "menu:home" }]]
  });
  if (!edited.ok) await sendTelegramMessage(runtime.env, chatId, text);
  return true;
}

export async function handleTestFirmwareTelegramCommand(update, runtime, logger = console) {
  const text = textFromUpdate(update).trim();
  if (!text.startsWith("/")) return false;
  const parts = text.split(/\s+/);
  const command = parts[0].split("@")[0].toLowerCase();
  if (!["/testscan", "/testconfirm"].includes(command)) return false;
  const chatId = String(chatIdFromUpdate(update) || "").trim();
  if (!chatId) return true;
  if (await getIdentity(runtime.env, chatId) !== "admin") {
    await sendTelegramMessage(runtime.env, chatId, "你没有权限执行此操作。");
    return true;
  }
  if (command === "/testconfirm") {
    const result = await confirmKooAndEnableEux(runtime, chatId, logger);
    if (!result.ok) {
      await sendTelegramMessage(runtime.env, chatId, result.reason === "koo_not_resolved"
        ? "⏳ 尚未发现可确认的 SM-S948N/KOO 测试固件，请先等待启动扫描完成。"
        : "❌ 当前测试固件流程暂时无法确认，请稍后重试。");
    } else if (result.already) {
      await sendTelegramMessage(runtime.env, chatId, `SM-S948B / EUX 已开启。\n确认版本：${result.version || "已记录"}`);
    } else {
      await sendTelegramMessage(runtime.env, chatId, `✅ 已确认 SM-S948N / KOO\n版本：${result.version}\n\n已开启 SM-S948B / EUX 自动解密。\n解密成功后将自动开始正式监控。`);
    }
    return true;
  }
  const args = parts.slice(1);
  let target = null;
  if (args.length > 0) {
    if (args.length !== 2) {
      await sendTelegramMessage(runtime.env, chatId, "用法：/testscan [MODEL CSC]");
      return true;
    }
    try {
      target = validateModelCsc(args[0], args[1]);
    } catch {
      await sendTelegramMessage(runtime.env, chatId, "型号或 CSC 格式不正确。示例：/testscan SM-S948N KOO");
      return true;
    }
  }
  try {
    await runtime.queues.maintenance.add("oneui", {
      id: `test-firmware-manual:${randomUUID()}`,
      kind: "test-firmware-manual-scan",
      target,
      retryUnresolved: true,
      chatId,
      createdAt: new Date().toISOString()
    }, { attempts: 1, removeOnComplete: { age: 24 * 60 * 60, count: 100 } });
    await sendTelegramMessage(runtime.env, chatId, target
      ? `✅ 已加入测试固件扫描：${target.model} / ${target.csc}`
      : "✅ 已加入全部测试固件扫描，按现有监控顺序执行。\n扫描完成后只向你返回结果。" );
  } catch (error) {
    logger.error?.(`[test-fw] manual scan enqueue failed: ${String(error?.message || error).slice(0, 180)}`);
    await sendTelegramMessage(runtime.env, chatId, "❌ 测试固件扫描暂时无法启动。");
  }
  return true;
}

export {
  EUX_TARGET,
  KOO_TARGET,
  PIPELINE_STARTUP_SCAN_ID,
  SCAN_LOCK_KEY,
  pipelineTargets,
  resolvedVersionFromRows,
  testBuildText
};
