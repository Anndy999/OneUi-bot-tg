import { createHash, randomUUID } from "node:crypto";
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
  getAdminChatIds,
  getAllowedUsers,
  getFirmwareQueryCache,
  getMonitorItems,
  getMonitorRuntime,
  getUserLanguage,
  kvGetJson,
  kvPutJson
} from "../state.js";
import {
  activateTestFirmwareRolloutStage,
  ensureTestFirmwareRolloutStage,
  pauseAllRolloutChains
} from "../rollout-chain.js";
import { validateModelCsc } from "../targets.js";
import { parseFirmwareInput } from "../firmware-input-parser.js";
import { beijingDateKey, beijingParts, formatBeijingTime } from "../utils.js";
import { runTestFirmwareDecryptor } from "./test-firmware-decryptor.js";
import { createTestFirmwareHistoryRepository } from "./test-firmware-history.js";

const SCAN_LOCK_KEY = "test-firmware:scan";
const DEFAULT_SCAN_LOCK_MS = 2 * 60 * 60 * 1000;
const STARTUP_LOCK_RETRY_DELAY_MS = 30_000;
const STARTUP_LOCK_RETRY_LIMIT = 3;
const DEFAULT_PIPELINE_RELEASE_ID = "2.22.1";
const PIPELINE_STARTUP_SCAN_ID = `s948n-koo-eux:${DEFAULT_PIPELINE_RELEASE_ID}`;
const KOO_TARGET = Object.freeze({ model: "SM-S948N", csc: "KOO" });
const EUX_TARGET = Object.freeze({ model: "SM-S948B", csc: "EUX" });
const PUBLIC_RELEASE_STATE_KEY = "test-firmware:public-release";

function safeText(value, fallback = "") {
  const result = String(value ?? fallback).trim();
  return result || fallback;
}

function configFor(runtime) {
  return runtime?.config || {};
}

function startupScanIdFor(runtime) {
  const requested = safeText(configFor(runtime).testFirmwareReleaseId, DEFAULT_PIPELINE_RELEASE_ID);
  const releaseId = requested
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || DEFAULT_PIPELINE_RELEASE_ID;
  return `s948n-koo-eux:${releaseId}`;
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

function ownerChatId(env) {
  return String(env?.TELEGRAM_CHAT_ID || "").trim();
}

function isTestFirmwareOwner(env, chatId) {
  const owner = ownerChatId(env);
  return Boolean(owner) && owner === String(chatId || "").trim();
}

function publicReleaseId(item, match) {
  return createHash("sha256")
    .update(`${item.model}:${item.csc}:${match.hash_type}:${match.hash_value}`)
    .digest("hex")
    .slice(0, 24);
}

async function publicReleaseStateFor(runtime) {
  return kvGetJson(runtime.env, PUBLIC_RELEASE_STATE_KEY, null);
}

async function preparePublicRelease(runtime, item, match, pipelineState, at = new Date()) {
  if (!isTarget(item, KOO_TARGET) || !pipelineState?.euxEnabled || !match) return null;
  const version = fullVersion(match);
  if (!version || version === String(pipelineState.kooConfirmedVersion || "")) return null;
  const id = publicReleaseId(item, match);
  const current = await publicReleaseStateFor(runtime);
  if (current?.id === id && ["pending", "released"].includes(current.status)) return current;
  const next = {
    id,
    status: "pending",
    model: item.model,
    csc: item.csc,
    hashType: String(match.hash_type || "").toLowerCase(),
    hashValue: String(match.hash_value || "").toLowerCase(),
    version,
    detectedAt: scanNow(at).toISOString(),
    confirmedAt: "",
    confirmedBy: "",
    recipients: 0,
    updatedAt: scanNow(at).toISOString()
  };
  await kvPutJson(runtime.env, PUBLIC_RELEASE_STATE_KEY, next);
  return next;
}

function ordinaryUserIds(users = [], adminIds = []) {
  const admins = new Set((adminIds || []).map((id) => String(id || "").trim()).filter(Boolean));
  return [...new Set((users || [])
    .map((user) => String(user?.chatId || "").trim())
    .filter((chatId) => chatId && !admins.has(chatId)))]
    .sort();
}

function isTarget(item, target) {
  return item?.model === target.model && item?.csc === target.csc;
}

function fullVersion(match) {
  return String(match.version || [match.pda, match.csc_build, match.cp].filter(Boolean).join("/") || "未知");
}

// Samsung test XML can publish several unseen hashes at once. Persist every
// verified resolution, but notify only the newest build so an administrator is
// not flooded with historical test versions after a delayed scan.
function compareTestFirmwareMatches(left, right) {
  const leftYear = Math.max(0, Number(left?.year) || 0);
  const rightYear = Math.max(0, Number(right?.year) || 0);
  if (leftYear !== rightYear) return leftYear - rightYear;
  const leftMonth = Math.max(0, Number(left?.month) || 0);
  const rightMonth = Math.max(0, Number(right?.month) || 0);
  if (leftMonth !== rightMonth) return leftMonth - rightMonth;
  return fullVersion(left).localeCompare(fullVersion(right), "en", {
    numeric: true,
    sensitivity: "base"
  });
}

function latestTestFirmwareMatch(matches = []) {
  return matches.reduce((latest, candidate) => (
    !latest || compareTestFirmwareMatches(candidate, latest) > 0 ? candidate : latest
  ), null);
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

function notificationKeyboard(item, { manager = false, pipelineState = null, releaseState = null } = {}) {
  const rows = [];
  if (manager && isTarget(item, KOO_TARGET) && !pipelineState?.euxEnabled) {
    rows.push([{ text: "✅ 确认解密结果，开启监控", callback_data: "test-fw:confirm-eux" }]);
  }
  if (manager && isTarget(item, KOO_TARGET) && (
    !pipelineState?.euxEnabled || releaseState?.status === "pending"
  )) {
    rows.push([{ text: "📣 通知普通用户", callback_data: `test-fw:release:${releaseState?.id || "pending"}` }]);
  }
  rows.push(
    [{ text: "查询详情", callback_data: `query:refresh:${item.model}:${item.csc}` }],
    [{ text: "首页", callback_data: "menu:home" }]
  );
  return {
    inline_keyboard: rows
  };
}

async function broadcastResolved(runtime, item, match, at, pipelineState) {
  const env = runtime.env;
  const chatId = ownerChatId(env);
  if (!chatId) return { attempted: 0, queued: 0 };
  let queued = 0;
  let releaseState = null;
  try {
    const lang = await getUserLanguage(env, chatId);
    try {
      releaseState = await preparePublicRelease(runtime, item, match, pipelineState, at);
    } catch (error) {
      console.log(`[test-fw] public release state deferred for ${item.model}/${item.csc}: ${String(error?.message || error).slice(0, 180)}`);
    }
    const delivery = await enqueueTelegramNotification(env, {
      id: `test-firmware:${item.model}:${item.csc}:${match.hash_type}:${match.hash_value}:${chatId}`,
      chatId,
      text: testBuildText(item, match, at, lang),
      replyMarkup: notificationKeyboard(item, { manager: true, pipelineState, releaseState }),
      monitorEvent: {
        type: "test_build_detected",
        model: item.model,
        csc: item.csc,
        audience: "owner",
        source: "Samsung version.test.xml"
      }
    });
    if (delivery?.queued || delivery?.sent) queued = 1;
  } catch (error) {
    console.log(`[test-fw] owner notification failed for ${item.model}/${item.csc}: ${String(error?.message || error).slice(0, 180)}`);
  }
  return { attempted: 1, queued };
}

async function releasePublicTestFirmware(runtime, releaseId, chatId, logger = console) {
  if (!isTestFirmwareOwner(runtime.env, chatId)) return { ok: false, reason: "forbidden" };
  const pipelineState = await pipelineStateFor(runtime);
  if (String(releaseId || "") === "pending" && !pipelineState.euxEnabled) {
    return { ok: false, reason: "confirm_first" };
  }
  const current = await publicReleaseStateFor(runtime);
  if (!current || current.id !== String(releaseId || "") || current.status !== "pending") {
    return { ok: false, reason: "stale_or_missing" };
  }
  const [admins, users] = await Promise.all([
    getAdminChatIds(runtime.env),
    getAllowedUsers(runtime.env)
  ]);
  const recipients = ordinaryUserIds(users, admins);
  const failures = [];
  let deliveries = 0;
  for (const recipient of recipients) {
    try {
      const lang = await getUserLanguage(runtime.env, recipient);
      const delivery = await enqueueTelegramNotification(runtime.env, {
        id: `test-firmware-public:${current.id}:${recipient}`,
        chatId: recipient,
        text: testBuildText({ model: current.model, csc: current.csc }, {
          version: current.version,
          pda: current.version.split("/")[0],
          csc_build: current.version.split("/")[1],
          cp: current.version.split("/")[2]
        }, new Date(current.detectedAt || Date.now()), lang),
        monitorEvent: {
          type: "test_build_public_release",
          model: current.model,
          csc: current.csc,
          audience: "allowed_user",
          source: "owner_confirmed_test_firmware"
        }
      });
      if (delivery?.queued || delivery?.sent) deliveries += 1;
      else failures.push(recipient);
    } catch (error) {
      failures.push(recipient);
      logger.warn?.(`[test-fw] public release queue failed for ${recipient}: ${String(error?.message || error).slice(0, 160)}`);
    }
  }
  if (failures.length) return { ok: false, reason: "enqueue_failed", deliveries, recipients: recipients.length, failures: failures.length };
  const released = {
    ...current,
    status: "released",
    confirmedAt: new Date().toISOString(),
    confirmedBy: String(chatId),
    recipients: recipients.length,
    deliveries,
    updatedAt: new Date().toISOString()
  };
  if (!await kvPutJson(runtime.env, PUBLIC_RELEASE_STATE_KEY, released)) {
    return { ok: false, reason: "storage_unavailable", deliveries, recipients: recipients.length };
  }
  return { ok: true, version: current.version, recipients: recipients.length, deliveries };
}

async function warnOwner(runtime, item, hash, at) {
  const env = runtime.env;
  const chatId = ownerChatId(env);
  if (!chatId) return { attempted: 0, queued: 0 };
  let queued = 0;
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
        audience: "owner",
        source: "Samsung version.test.xml"
      }
    });
    if (delivery?.queued || delivery?.sent) queued = 1;
  } catch (error) {
    console.log(`[test-fw] owner unresolved warning failed for ${item.model}/${item.csc}: ${String(error?.message || error).slice(0, 180)}`);
  }
  return { attempted: 1, queued };
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

export async function scanTestFirmwareTarget(runtime, item, {
  retryUnresolved = false,
  now = new Date(),
  logger = console,
  testXml = null,
  latestVersionOverride = "",
  onProgress = null,
  notifyResults = true,
  notifyUnresolved = true
} = {}) {
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
  const resolvedRows = [];
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
    resolvedRows.push({ match, row });
  }
  const newestMatch = latestTestFirmwareMatch(matches);
  const newestRow = resolvedRows.find(({ match }) => match === newestMatch);
  if (notifyResults && newestMatch && newestRow && !newestRow.row.notifiedAt) {
    const delivery = await broadcastResolved(runtime, target, newestMatch, at, pipelineState);
    if (delivery.queued > 0) {
      await repository.markNotified(target.model, target.csc, newestMatch.hash_type, newestMatch.hash_value, at.toISOString());
      notified = 1;
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
    if (notifyUnresolved && !row.adminWarningAt) {
      const warning = await warnOwner(runtime, target, hash, at);
      if (warning.queued > 0) {
        await repository.markAdminWarning(target.model, target.csc, hash.hash_type, hash.hash_value, at.toISOString());
        warnings += 1;
      }
    }
  }

  // Only the confirmed exact EUX target may enable formal monitoring. Repeat
  // the activation check on later scans as well, so a transient state-store
  // error cannot leave an already-decrypted EUX build unmonitored forever.
  const hasResolvedEux = isEuxTarget(target) && pipelineState.euxEnabled && (
    matches.length > 0 || Boolean(resolvedVersionFromRows(known))
  );
  if (hasResolvedEux) {
    // EUX decryption may finish ahead of the release chain. It is recorded as
    // prepared, but formal monitoring must wait until the current region has
    // produced and pushed an official update.
    logger.info?.(`[test-fw] EUX decrypt success; formal monitor remains rollout-gated for ${target.model}/${target.csc}`);
  }

  const summary = {
    status: selectedHashes.length === 0 ? "unchanged" : matches.length ? "resolved" : "unresolved",
    model: target.model,
    csc: target.csc,
    hashCount: Array.isArray(result.hashes) ? result.hashes.length : 0,
    newHashCount: selectedHashes.length,
    resolvedCount: matches.length,
    unresolvedCount: unresolved.length,
    resolvedVersion: newestMatch ? fullVersion(newestMatch).slice(0, 360) : "",
    notified,
    warnings,
    candidateLimitReached: Boolean(result.candidateLimitReached),
    latestVersion,
    newestMatch: newestMatch ? { ...newestMatch } : null,
    newestNotifiedAt: newestRow?.row?.notifiedAt || ""
  };
  await repository.recordTargetCheck(target.model, target.csc, summary, at.toISOString());
  if (summary.newHashCount === 0) logger.info?.(`[test-fw] hashes known; no new hash for ${target.model}/${target.csc}`);
  else if (summary.resolvedCount) logger.info?.(`[test-fw] resolved ${summary.resolvedCount} new build(s) for ${target.model}/${target.csc}`);
  else logger.warn?.(`[test-fw] unresolved new hash for ${target.model}/${target.csc}`);
  return summary;
}

export async function executeTestFirmwareScan(runtime, { target = null, retryUnresolved = false, chatId = "", progressChatId = chatId, automatic = false, now = new Date(), logger = console, testXml = null, latestVersionOverride = "" } = {}) {
  const pipelineState = await pipelineStateFor(runtime);
  const items = target
    ? [validateModelCsc(target.model, target.csc)]
    : pipelineTargets(pipelineState).map((item) => ({ ...item }));
  const progress = progressChatId
    ? await createTestFirmwareProgress(runtime.env, progressChatId, items, { automatic, pipelineState })
    : null;
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
        notifyResults: !progress && !automatic,
        notifyUnresolved: !progress && !automatic,
        onProgress: (event) => progress?.update(event)
      }));
    } catch (error) {
      const result = { status: "failed", model: item.model, csc: item.csc, error: String(error?.message || error).slice(0, 240) };
      results.push(result);
      logger.error?.(`[test-fw] target ${targetLabel(item)} crashed: ${result.error}`);
    }
  }
  // Scheduled automatic scans can cover more than one decryption target. Pick
  // one newest build for the owner instead of sending one message per target.
  if (automatic && !progress) {
    const candidate = results
      .filter((result) => result.status === "resolved" && result.newestMatch && !result.newestNotifiedAt)
      .reduce((latest, result) => {
        if (!latest || compareTestFirmwareMatches(result.newestMatch, latest.result.newestMatch) > 0) {
          return { result, match: result.newestMatch };
        }
        return latest;
      }, null);
    if (candidate) {
      const targetItem = { model: candidate.result.model, csc: candidate.result.csc };
      const delivery = await broadcastResolved(runtime, targetItem, candidate.match, scanNow(now), pipelineState);
      if (delivery.queued > 0) {
        await repository.markNotified(
          targetItem.model,
          targetItem.csc,
          candidate.match.hash_type,
          candidate.match.hash_value,
          scanNow(now).toISOString()
        );
        candidate.result.notified = 1;
      }
    }
  }
  const failed = results.filter((result) => result.status === "failed").length;
  const resolved = results.reduce((sum, result) => sum + Number(result.resolvedCount || 0), 0);
  const unresolved = results.reduce((sum, result) => sum + Number(result.unresolvedCount || 0), 0);
  const summary = { ok: failed === 0, total: results.length, failed, resolved, unresolved, results };
  let progressReleaseState = null;
  const kooResult = results.find((result) =>
    isTarget(result, KOO_TARGET) && result.status === "resolved" && result.newestMatch
  );
  if (kooResult) {
    try {
      progressReleaseState = await preparePublicRelease(runtime, KOO_TARGET, kooResult.newestMatch, pipelineState, now);
      if (progress && !kooResult.newestNotifiedAt) {
        await repositoryFor(runtime).markNotified(
          KOO_TARGET.model,
          KOO_TARGET.csc,
          kooResult.newestMatch.hash_type,
          kooResult.newestMatch.hash_value,
          scanNow(now).toISOString()
        );
      }
    } catch (error) {
      logger.warn?.(`[test-fw] public release state update deferred: ${String(error?.message || error).slice(0, 180)}`);
    }
  }
  if (progress) await progress.finish(summary, { releaseState: progressReleaseState });
  else if (chatId) await sendTestScanSummary(runtime, chatId, summary, pipelineState, progressReleaseState);
  return summary;
}

function progressBar(percent, width = 12) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((value / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function scanSummaryLine(result = {}) {
  const label = `${result.model || "未知型号"} / ${result.csc || "未知 CSC"}`;
  if (result.status === "resolved") {
    const version = String(result.resolvedVersion || "").replace(/\s+/g, " ").slice(0, 180);
    return version
      ? `✅ ${label}：最新测试版本\n${version}`
      : `✅ ${label}：已解密 ${Number(result.resolvedCount || 0)} 个版本`;
  }
  if (result.status === "unchanged") return `ℹ️ ${label}：暂无新的测试固件`;
  if (result.status === "unresolved") return `⚠️ ${label}：发现 ${Number(result.unresolvedCount || 0)} 个待解密项目`;
  const error = String(result.error || "请求失败").replace(/\s+/g, " ").slice(0, 100);
  return `❌ ${label}：${error}`;
}

function progressText(target, event = {}, index = 0, total = 1, summary = null, options = {}) {
  const automatic = Boolean(options.automatic);
  const percent = event.maxCandidates > 0
    ? Math.min(99, Math.floor((event.candidates / event.maxCandidates) * 100))
    : event.phase === "finalizing" ? 100 : 0;
  const phase = event.phase === "finalizing" ? "整理解密结果" : "计算候选版本";
  const header = summary
    ? (summary.ok
      ? (automatic ? "✅ 自动测试固件解密完成" : "✅ 测试固件解密完成")
      : (automatic ? "⚠️ 自动测试固件解密完成，但有目标失败" : "⚠️ 测试固件解密完成，但有目标失败"))
    : (automatic ? "🔐 已自动开始测试固件解密" : "🔐 正在解密测试固件");
  const lines = [
    header,
    "",
    automatic ? "触发：机器人更新" : "",
    `目标：${target?.model || ""} / ${target?.csc || ""}`,
    `阶段：${summary ? "已完成" : phase}`,
    `进度：${progressBar(summary ? 100 : percent)} ${summary ? 100 : percent}%`,
    event.maxCandidates > 0 ? `候选：${Number(event.candidates || 0).toLocaleString()} / ${Number(event.maxCandidates).toLocaleString()}` : "候选：准备中",
    `已匹配：${Number(event.matched || 0)}`,
    total > 1 ? `目标序号：${Math.min(total, index + 1)} / ${total}` : ""
  ];
  if (summary) {
    lines.push(`成功解密：${summary.resolved}`, `失败：${summary.failed}`, "", ...summary.results.map(scanSummaryLine));
  }
  return lines.filter(Boolean).join("\n");
}

async function createTestFirmwareProgress(env, chatId, items, options = {}) {
  const first = items[0] || {};
  const automatic = Boolean(options.automatic);
  const pipelineState = options.pipelineState || null;
  const sent = await sendTelegramMessageResult(env, chatId, progressText(first, {}, 0, items.length, null, { automatic }));
  if (!sent.ok || !sent.messageId) return null;
  const state = {
    chatId: String(chatId),
    messageId: sent.messageId,
    target: first,
    index: 0,
    total: items.length,
    automatic,
    pipelineState,
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
      const text = progressText(this.target, event, this.index, this.total, null, { automatic: this.automatic });
      if (text === this.lastText) return;
      this.lastAt = now;
      this.lastText = text;
      this.pending = this.pending
        .then(() => editTelegramMessageResult(env, this.chatId, this.messageId, text))
        .catch(() => {});
    },
    async finish(summary, { releaseState = null } = {}) {
      this.update({ phase: "finalizing", candidates: 0, maxCandidates: 0, matched: summary.resolved }, true);
      const text = progressText(this.target, { phase: "finalizing", candidates: 0, maxCandidates: 0, matched: summary.resolved }, this.index, this.total, summary, { automatic: this.automatic });
      const kooResolved = summary.results?.some((result) =>
        isTarget(result, KOO_TARGET) && result.status === "resolved" && result.newestMatch
      );
      const replyMarkup = kooResolved
        ? notificationKeyboard(KOO_TARGET, {
          manager: true,
          pipelineState: this.pipelineState,
          releaseState
        })
        : undefined;
      if (this.messageId && text !== this.lastText) {
        this.lastText = text;
        this.pending = this.pending
          .then(() => editTelegramMessageResult(env, this.chatId, this.messageId, text, replyMarkup))
          .catch(() => {});
      }
      await this.pending;
    }
  };
  return state;
}

function testFirmwareTargetStateText(target, targetState, version, { waitingForConfirmation = false } = {}, lang = "zh") {
  if (waitingForConfirmation) return lang === "en" ? "waiting for KOO confirmation" : "等待 KOO 确认";
  if (version) return lang === "en" ? `decrypted\n${version}` : `已解密\n${version}`;
  switch (String(targetState?.lastStatus || "")) {
    case "unchanged":
      return lang === "en" ? "no new test firmware" : "暂无新的测试固件";
    case "unresolved":
      return lang === "en" ? "new item awaiting decryption" : "发现待解密项目";
    case "failed":
      return lang === "en" ? "last run failed; automatic retry remains available" : "上次失败，后续自动任务会重试";
    default:
      return lang === "en" ? "waiting for automatic task" : "等待自动任务";
  }
}

function testFirmwareStatusKeyboard(pipelineState, kooVersion, lang = "zh") {
  const en = lang === "en";
  const rows = [[{ text: en ? "Refresh" : "刷新状态", callback_data: "test-fw:refresh" }]];
  if (kooVersion && !pipelineState?.euxEnabled) {
    rows.push([{ text: en ? "Confirm KOO and start S26 Korea" : "确认 KOO，开启 S26 韩版监控", callback_data: "test-fw:confirm-eux" }]);
  }
  rows.push([{ text: en ? "Back to firmware tasks" : "返回固件任务", callback_data: "admin:firmware-menu" }]);
  return { inline_keyboard: rows };
}

export async function renderTestFirmwareStatusPanel(runtime, chatId, messageId = null) {
  const repository = repositoryFor(runtime);
  const getTargetState = typeof repository.getTargetState === "function"
    ? repository.getTargetState.bind(repository)
    : async () => null;
  const [pipelineState, kooRows, euxRows, kooTargetState, euxTargetState, monitorItems] = await Promise.all([
    pipelineStateFor(runtime),
    repository.listHashes(KOO_TARGET.model, KOO_TARGET.csc),
    repository.listHashes(EUX_TARGET.model, EUX_TARGET.csc),
    getTargetState(KOO_TARGET.model, KOO_TARGET.csc),
    getTargetState(EUX_TARGET.model, EUX_TARGET.csc),
    getMonitorItems(runtime.env).catch(() => [])
  ]);
  const lang = await getUserLanguage(runtime.env, chatId);
  const kooVersion = resolvedVersionFromRows(kooRows);
  const euxVersion = resolvedVersionFromRows(euxRows);
  const kooMonitorEnabled = monitorItems.some((item) =>
    isTarget(item, KOO_TARGET) && item.enabled !== false &&
    item.rolloutChainId === "s26" && item.rolloutStageId === "kr"
  );
  const lines = lang === "en"
    ? [
        "🧪 Test firmware",
        "",
        `KOO: ${testFirmwareTargetStateText(KOO_TARGET, kooTargetState, kooVersion, {}, lang)}`,
        `EUX: ${testFirmwareTargetStateText(EUX_TARGET, euxTargetState, euxVersion, { waitingForConfirmation: !pipelineState.euxEnabled }, lang)}`,
        `Official monitor: ${kooMonitorEnabled ? "enabled for S26 Korea" : (pipelineState.euxEnabled ? "waiting for rollout recovery" : "waiting for KOO confirmation")}`
      ]
    : [
        "🧪 测试固件",
        "",
        `KOO：${testFirmwareTargetStateText(KOO_TARGET, kooTargetState, kooVersion, {}, lang)}`,
        `EUX：${testFirmwareTargetStateText(EUX_TARGET, euxTargetState, euxVersion, { waitingForConfirmation: !pipelineState.euxEnabled }, lang)}`,
        `正式监控：${kooMonitorEnabled ? "已开启（S26 韩版）" : (pipelineState.euxEnabled ? "等待发布链恢复" : "等待 KOO 确认")}`
      ];
  const text = lines.join("\n");
  const replyMarkup = testFirmwareStatusKeyboard(pipelineState, kooVersion, lang);
  if (messageId) {
    const edited = await editTelegramMessageResult(runtime.env, chatId, messageId, text, replyMarkup);
    const detail = String(edited?.error || edited?.data?.description || "");
    if (edited.ok || /message is not modified/i.test(detail)) return { text, replyMarkup };
  }
  await sendTelegramMessage(runtime.env, chatId, text, replyMarkup);
  return { text, replyMarkup };
}

export async function confirmKooAndEnableEux(runtime, chatId, logger = console) {
  const repository = repositoryFor(runtime);
  const state = await pipelineStateFor(runtime);
  if (state.euxEnabled) {
    try {
      await ensureTestFirmwareRolloutStage(runtime.env, "s26", "kr");
    } catch (error) {
      logger.warn?.(`[test-fw] confirmed pipeline monitor recovery deferred: ${String(error?.message || error).slice(0, 180)}`);
      return { ok: false, reason: "monitor_activation_failed" };
    }
    return { ok: true, already: true, version: state.kooConfirmedVersion };
  }
  const rows = await repository.listHashes(KOO_TARGET.model, KOO_TARGET.csc);
  const version = resolvedVersionFromRows(rows);
  if (!version) return { ok: false, reason: "koo_not_resolved" };

  try {
    // Confirmation opens the S26 Korea formal monitor immediately. The EUX
    // decrypt job is queued separately and is not allowed to jump the rollout
    // chain ahead of Korea.
    await activateTestFirmwareRolloutStage(runtime.env, "s26", "kr");
  } catch (error) {
    logger.error?.(`[test-fw] KOO confirmation could not activate S26 Korea monitor: ${String(error?.message || error).slice(0, 180)}`);
    return { ok: false, reason: "monitor_activation_failed" };
  }
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
  const startupScanId = startupScanIdFor(runtime);
  const claimed = await repository.claimStartupScan(startupScanId, new Date().toISOString());
  if (!claimed) return { queued: false, reason: "already_claimed" };
  try {
    const pipelineState = await pipelineStateFor(runtime);
    if (pipelineState.euxEnabled) {
      // Keep the persisted rollout position after a restart. Only recover a
      // chain that was left in its pre-confirmation setup state; never reset a
      // later EUX/TGY/CHC stage back to Korea.
      await ensureTestFirmwareRolloutStage(runtime.env, "s26", "kr");
    } else {
      // Until the owner/admin confirms KOO, no formal region may run.
      await pauseAllRolloutChains(runtime.env);
    }
    await runtime.queues.maintenance.add("oneui", {
      id: `test-firmware-startup:${startupScanId}`,
      kind: "test-firmware-startup-scan",
      startupScanId,
      target: { ...KOO_TARGET },
      retryUnresolved: true,
      chatId: String(runtime.env.TELEGRAM_CHAT_ID || ""),
      createdAt: new Date().toISOString()
    }, { jobId: `test-firmware-startup:${startupScanId}`, attempts: 1, removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100 } });
    logger.info?.(`[test-fw] startup pipeline queued for ${targetLabel(KOO_TARGET)} (${startupScanId})`);
    return { queued: true, target: { ...KOO_TARGET }, startupScanId };
  } catch (error) {
    await repository.releaseStartupScan(startupScanId, new Date().toISOString()).catch(() => {});
    logger.error?.(`[test-fw] startup pipeline enqueue failed: ${String(error?.message || error).slice(0, 180)}`);
    return { queued: false, reason: "enqueue_failed" };
  }
}

async function sendTestScanSummary(runtime, chatId, summary, pipelineState = null, releaseState = null) {
  const env = runtime.env;
  const lines = [
    summary.ok ? "✅ 测试固件扫描完成" : "⚠️ 测试固件扫描完成，但有目标失败",
    `目标：${summary.total}`,
    `成功解密：${summary.resolved}`,
    `未解密：${summary.unresolved}`,
    `失败：${summary.failed}`
  ];
  const resolved = summary.results.filter((result) => result.status === "resolved" && result.resolvedVersion);
  if (resolved.length) {
    lines.push("", "最新测试固件版本：");
    for (const result of resolved) {
      lines.push(`${result.model} / ${result.csc}`, String(result.resolvedVersion).replace(/\s+/g, " ").slice(0, 360));
    }
  }
  const failures = summary.results.filter((result) => result.status === "failed").slice(0, 8);
  for (const failure of failures) lines.push(`• ${failure.model}/${failure.csc}：${failure.error || "请求失败"}`);
  const kooResolved = summary.results.some((result) =>
    isTarget(result, KOO_TARGET) && result.status === "resolved" && result.newestMatch
  );
  const replyMarkup = kooResolved
    ? notificationKeyboard(KOO_TARGET, { manager: true, pipelineState, releaseState })
    : undefined;
  await sendTelegramMessage(env, chatId, lines.join("\n"), replyMarkup);
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

async function retryStartupScanAfterLock(runtime, data, logger = console) {
  const retries = Math.max(0, Math.floor(Number(data.startupLockRetries || 0)));
  if (retries >= STARTUP_LOCK_RETRY_LIMIT) return false;
  const startupScanId = String(data.startupScanId || startupScanIdFor(runtime));
  const nextRetry = retries + 1;
  const retryJobId = `test-firmware-startup:${startupScanId}:lock-retry:${nextRetry}:${randomUUID()}`;
  try {
    await runtime.queues.maintenance.add("oneui", {
      ...data,
      id: retryJobId,
      startupScanId,
      startupLockRetries: nextRetry,
      createdAt: new Date().toISOString()
    }, {
      jobId: retryJobId,
      delay: STARTUP_LOCK_RETRY_DELAY_MS,
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100 }
    });
    logger.warn?.(`[test-fw] startup scan lock is busy; retry ${nextRetry}/${STARTUP_LOCK_RETRY_LIMIT} queued`);
    return true;
  } catch (error) {
    logger.warn?.(`[test-fw] startup lock retry enqueue failed: ${String(error?.message || error).slice(0, 180)}`);
    return false;
  }
}

export async function processTestFirmwareMaintenanceJob(job, runtime, logger = console) {
  const data = job?.data || {};
  if (!["test-firmware-scheduled-scan", "test-firmware-manual-scan", "test-firmware-startup-scan", "test-firmware-eux-scan"].includes(data.kind)) return null;
  const repository = repositoryFor(runtime);
  if (data.kind === "test-firmware-scheduled-scan") {
    const locked = await runTestFirmwareScanWithLock(runtime, { automatic: true, logger });
    const summary = locked.acquired ? locked.summary : { ok: false, failed: 1, error: "scan already running" };
    await repository.finishScheduled(data.dateKey, summary.ok ? "completed" : "failed", summary.ok ? "" : "one or more targets failed");
    return summary;
  }
  const locked = await runTestFirmwareScanWithLock(runtime, {
    target: data.target || null,
    retryUnresolved: Boolean(data.retryUnresolved),
    chatId: data.chatId || "",
    progressChatId: data.chatId || "",
    automatic: data.kind !== "test-firmware-manual-scan",
    logger
  });
  const lockRetryQueued = data.kind === "test-firmware-startup-scan" && !locked.acquired
    ? await retryStartupScanAfterLock(runtime, data, logger)
    : false;
  if (!locked.acquired && data.chatId && !lockRetryQueued) {
    await sendTelegramMessage(runtime.env, data.chatId, "⏳ Samsung 测试固件扫描正在运行，请等待当前任务完成。");
  }
  const summary = locked.acquired ? locked.summary : { ok: false, reason: "already_running" };
  if (data.kind === "test-firmware-startup-scan" && !summary.ok && !lockRetryQueued) {
    await repository.releaseStartupScan(data.startupScanId || startupScanIdFor(runtime), new Date().toISOString()).catch(() => {});
  }
  return lockRetryQueued ? { ...summary, retryQueued: true } : summary;
}

export async function handleTestFirmwareTelegramCallback(update, runtime, logger = console) {
  const callback = update?.callback_query;
  const data = String(callback?.data || "");
  const isReleaseCallback = data.startsWith("test-fw:release:");
  if (!["test-fw:menu", "test-fw:refresh", "test-fw:confirm-eux"].includes(data) && !isReleaseCallback) return false;
  const chatId = String(chatIdFromUpdate(update) || "").trim();
  if (!chatId) return true;
  if (!isTestFirmwareOwner(runtime.env, chatId)) {
    await answerCallbackQuery(runtime.env, callback.id, "测试阶段仅所有者可操作", { showAlert: true });
    return true;
  }
  if (data === "test-fw:menu" || data === "test-fw:refresh") {
    await answerCallbackQuery(runtime.env, callback.id, data === "test-fw:refresh" ? "正在刷新…" : "正在打开…");
    await renderTestFirmwareStatusPanel(runtime, chatId, callback.message?.message_id);
    return true;
  }
  if (isReleaseCallback) {
    await answerCallbackQuery(runtime.env, callback.id, "正在通知普通用户…");
    const releaseId = data.slice("test-fw:release:".length);
    const result = await releasePublicTestFirmware(runtime, releaseId, chatId, logger);
    const text = result.ok
      ? `✅ 已通知普通用户\n版本：${result.version}\n发送人数：${result.recipients}`
      : result.reason === "confirm_first"
        ? "请先点击“确认解密结果，开启监控”，确认后再通知普通用户。"
      : result.reason === "stale_or_missing"
        ? "⏳ 当前没有等待发布的测试固件，或该版本已经处理。"
        : result.reason === "enqueue_failed"
          ? `⚠️ 普通用户通知未全部发送\n已进入队列：${result.deliveries || 0}/${result.recipients || 0}\n请稍后重试。`
          : "❌ 普通用户通知暂时无法发送，请稍后重试。";
    const messageId = callback.message?.message_id;
    const edited = await editTelegramMessageResult(runtime.env, chatId, messageId, text, {
      inline_keyboard: [[{ text: "查询详情", callback_data: `query:refresh:${KOO_TARGET.model}:${KOO_TARGET.csc}` }], [{ text: "首页", callback_data: "menu:home" }]]
    });
    if (!edited.ok) await sendTelegramMessage(runtime.env, chatId, text);
    return true;
  }
  await answerCallbackQuery(runtime.env, callback.id, "正在确认…");
  const result = await confirmKooAndEnableEux(runtime, chatId, logger);
  const text = !result.ok
    ? "⏳ 尚未发现可确认的 SM-S948N / KOO 测试固件，请先等待启动扫描完成。"
    : result.already
      ? `SM-S948B / EUX 自动解密已开启。\n确认版本：${result.version || "已记录"}`
      : `✅ 已确认 SM-S948N / KOO\n版本：${result.version}\n\n已开启 S26 韩版正式监控，并继续自动解密 EUX。\nEUX 解密成功后只记录为待用，不会跳过发布链。`;
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
  if (!isTestFirmwareOwner(runtime.env, chatId)) {
    await sendTelegramMessage(runtime.env, chatId, "测试阶段仅所有者可操作。");
    return true;
  }
  if (command === "/testconfirm") {
    const result = await confirmKooAndEnableEux(runtime, chatId, logger);
    if (!result.ok) {
      await sendTelegramMessage(runtime.env, chatId, result.reason === "koo_not_resolved"
        ? "⏳ 尚未发现可确认的 SM-S948N/KOO 测试固件，请先等待启动扫描完成。"
        : "❌ 当前测试固件流程暂时无法确认，请稍后重试。");
    } else if (result.already) {
      await sendTelegramMessage(runtime.env, chatId, `SM-S948B / EUX 自动解密已开启。\n确认版本：${result.version || "已记录"}`);
    } else {
      await sendTelegramMessage(runtime.env, chatId, `✅ 已确认 SM-S948N / KOO\n版本：${result.version}\n\n已开启 S26 韩版正式监控，并继续自动解密 EUX。\nEUX 解密成功后只记录为待用，不会跳过发布链。`);
    }
    return true;
  }
  const args = parts.slice(1);
  let target = { ...KOO_TARGET };
  if (args.length > 0) {
    if (args.length < 2) {
      await sendTelegramMessage(runtime.env, chatId, "用法：/testscan <型号> <CSC>\n示例：/testscan 948N KOO\n也支持：/testscan SM-S948N KOO");
      return true;
    }
    try {
      const parsed = parseFirmwareInput(args.join(" "));
      if (!parsed.matched || !parsed.model || !parsed.csc || parsed.version) {
        throw new Error("testscan expects a model and CSC without a firmware version");
      }
      target = validateModelCsc(parsed.model, parsed.csc);
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
  latestTestFirmwareMatch,
  notificationKeyboard,
  progressText as testFirmwareProgressText,
  releasePublicTestFirmware,
  resolvedVersionFromRows,
  startupScanIdFor,
  testBuildText
};
