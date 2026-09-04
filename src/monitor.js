import {
  l1CacheTtlSeconds,
  monitorFailureRetryBaseSeconds,
  monitorFailureRetryMaxSeconds,
  monitorPermanentErrorRetrySeconds,
  monitorProgressUpdateMs,
  monitorStateReadConcurrency,
  notifyAllowedUsersOnUpdate,
  notifyOnFirstRun,
  releaseWindowDurationMinutes,
  releaseWindowEnabled,
  telegramNotifyConcurrency
} from "./config.js";
import { markFirmwareTargetHot, setFirmwareMemoryCache, setL1Firmware } from "./cache.js";
import { buildFirmwareCacheRecord, isExactSmartHistory } from "./firmware-cache.js";
import { calculatePriorityScore } from "./monitor-intelligence.js";
import { maybeSendDailyMonitorSummary } from "./services/system-observability.js";
import {
  addFirmwareNotificationBatch,
  claimDueMonitorTargets,
  claimManualMonitorTargets,
  completeMonitorTarget,
  getMonitorIntervalSettings,
  syncMonitorScheduler,
  validateMonitorTargetClaim
} from "./monitor-scheduler.js";
import { coordinatedFirmwareQuery } from "./firmware-query-coordinator.js";
import { releaseWindowPeers, targetKey, validateModelCsc } from "./targets.js";
import { enqueueTelegramNotification } from "./notification-queue.js";
import {
  activationPromptKeyboard,
  activationPromptText,
  buildFlagshipActivationProposal,
  buildLinkedTargetReviewProposal,
  reviewPromptKeyboard,
  reviewPromptText
} from "./flagship-priority.js";
import {
  createRolloutProposalForUpdate,
  applyOneTimeEuropeanRolloutRecovery,
  applyOneTimeS25HongKongRolloutRecovery,
  getRolloutItemScheduleDecision,
  isRolloutItemWithinSchedule,
  rolloutProposalKeyboard,
  rolloutProposalText
} from "./rollout-chain.js";
import {
  beijingDateKey,
  beijingParts,
  docUrl,
  firmwareKey,
  formatBeijingTime,
  formatMonitorBaseline,
  formatMonitorNotification,
  minutesToTime,
  monitorRunKey,
  timeToMinutes,
  firmwareVersionFingerprint
} from "./utils.js";
import {
  adminIdForMessages,
  getAdminChatIds,
  claimMonitorCronSlot,
  getAllowedUsers,
  getFirmwareQueryCache,
  getFirmwareQueryDemand,
  getMonitorBoost,
  getMonitorItems,
  getMonitorLastCheck,
  getMonitorRuntime,
  getMonitorSchedule,
  getUserLanguage,
  listPendingUpdates,
  deletePendingUpdate,
  forceMonitorDue,
  putMonitorBoost,
  recordMonitorFailure,
  recordPeerFirmwareUpdate,
  recordMonitorSuccess,
  recordMonitorEvent,
  setFirmwareQueryCache,
  upsertMonitorItem
} from "./state.js";

let scheduledTasksPromise = null;
const monitorTargetFlights = new Map();

export async function runScheduledTasks(env) {
  if (scheduledTasksPromise) return scheduledTasksPromise;
  scheduledTasksPromise = (async () => {
    // Must run before the normal schedule decision. The recovery is a durable
    // one-shot, so a service restart applies it immediately even if ordinary
    // monitor hours are currently closed.
    const rolloutRecovery = await applyOneTimeEuropeanRolloutRecovery(env)
      .catch((error) => {
        console.log(`One-time EU rollout recovery deferred: ${error.message}`);
        return { ok: false, applied: false, reason: "storage_error" };
      });
    const s25HongKongRecovery = await applyOneTimeS25HongKongRolloutRecovery(env)
      .catch((error) => {
        console.log(`One-time S25 HK rollout recovery deferred: ${error.message}`);
        return { ok: false, applied: false, reason: "storage_error" };
      });
    const monitorSummary = await runScheduledMonitor(env);
    return {
      ok: true,
      monitor: monitorSummary,
      rolloutRecovery,
      s25HongKongRecovery,
      dailySummary: await maybeSendDailyMonitorSummary(env)
    };
  })().finally(() => {
    scheduledTasksPromise = null;
  });
  return scheduledTasksPromise;
}

export async function processPendingUpdateReminders(env) {
  // v2.11.3 uses a one-shot notification. Remove any legacy pending records
  // so an upgrade cannot revive historical acknowledgement reminders.
  const summary = { checked: 0, cleared: 0, queued: 0, sent: 0, failed: 0, skipped: 0 };
  const pendingItems = await listPendingUpdates(env);
  for (const entry of pendingItems) {
    summary.checked += 1;
    try {
      await deletePendingUpdate(env, entry.value.model, entry.value.csc);
      summary.cleared += 1;
    } catch (error) {
      console.log(`Legacy pending cleanup deferred for ${entry.value.model}/${entry.value.csc}: ${error.message}`);
      summary.failed += 1;
    }
  }
  return summary;
}

function allowKvCronFallback(env) {
  return String(env?.MONITOR_ALLOW_KV_CRON_FALLBACK ?? "false").toLowerCase() === "true";
}

export async function runScheduledMonitor(env) {
  const schedule = await getMonitorSchedule(env);
  const now = new Date();
  const decision = await shouldRunNow(env, schedule, now);
  if (!decision.run) return { ok: true, skipped: true, reason: decision.reason };
  const summary = await runMonitor(env, {
    reason: "scheduled",
    slot: decision.slot,
    schedule,
    now
  });
  const durableScheduler = Boolean(env.MONITOR_SCHEDULER) &&
    String(env.MONITOR_SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false";
  if (!durableScheduler && allowKvCronFallback(env) && summary.ok && summary.failed === 0) {
    await env.FIRMWARE_KV?.put(monitorRunKey(beijingDateKey(now), decision.slot), "1", { expirationTtl: 2 * 24 * 60 * 60 });
  }
  return summary;
}

export async function shouldRunNow(env, schedule, now = new Date()) {
  if (!schedule.enabled) return { run: false, reason: "paused" };

  const parts = beijingParts(now);
  const isWeekend = parts.weekday === "Sat" || parts.weekday === "Sun";
  if (schedule.skipWeekends && isWeekend) return { run: false, reason: "weekend" };

  const current = Number(parts.hour) * 60 + Number(parts.minute);
  const start = timeToMinutes(schedule.startTime);
  const end = timeToMinutes(schedule.endTime);
  if (start === null || end === null) return { run: false, reason: "invalid_schedule" };
  const insideWindow = start <= end
    ? current >= start && current <= end
    : current >= start || current <= end;
  if (!insideWindow) return { run: false, reason: "outside_window" };

  // Cron wakes every minute. Per-target due-time checks below decide whether a
  // normal or release-window query should run; no model/CSC combinations are generated here.
  const slot = minutesToTime(current);
  const dateKey = beijingDateKey(now);
  const key = monitorRunKey(dateKey, slot);
  const durableScheduler = Boolean(env.MONITOR_SCHEDULER) &&
    String(env.MONITOR_SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false";
  const lockKey = `monitor:lock:${dateKey}:${slot}`;
  if (durableScheduler) {
    const claim = await claimMonitorCronSlot(env, `${dateKey}:${slot}`, now.getTime());
    if (claim?.ok && claim.claimed === false) return { run: false, reason: claim.reason || "already_ran", slot };
    if (claim?.ok) return { run: true, slot };
    // Fail closed instead of silently writing a new KV lock every minute. The
    // next Cron tick retries the Durable Object and diagnostics can alert the
    // administrator, while the free-tier KV quota remains protected.
    return { run: false, reason: "scheduler_unavailable", slot };
  }
  if (!allowKvCronFallback(env)) {
    return { run: false, reason: "scheduler_required", slot };
  }
  const existing = await env.FIRMWARE_KV?.get(key);
  if (existing) return { run: false, reason: "already_ran", slot };
  const locked = await env.FIRMWARE_KV?.get(lockKey);
  if (locked) return { run: false, reason: "locked", slot };

  await env.FIRMWARE_KV?.put(lockKey, "1", { expirationTtl: 3 * 60 });
  return { run: true, slot };
}

export async function selectDueMonitorItems(env, items, schedule, now = new Date()) {
  const intervalSettings = await getMonitorIntervalSettings(env);
  const concurrency = monitorStateReadConcurrency(env);

  const evaluated = await mapLimited(items, concurrency, async (item) => {
    const [runtime, boost, demand] = await Promise.all([
      getMonitorRuntime(env, item.model, item.csc),
      releaseWindowEnabled(env) ? getMonitorBoost(env, item.model, item.csc, now) : Promise.resolve(null),
      getFirmwareQueryDemand(env, item.model, item.csc, now)
    ]);
    const intelligence = calculatePriorityScore({
      item,
      runtime,
      boost,
      queryCount: demand.count
    }, now.getTime(), intervalSettings);
    const runtimeSuccessAt = Date.parse(runtime.lastSuccessAt || "");
    const lastCheckedAt = Number.isFinite(runtimeSuccessAt) && runtimeSuccessAt > 0
      ? runtimeSuccessAt
      : await getMonitorLastCheck(env, item.model, item.csc);
    const intervalMinutes = Number(item.intervalMinutes) > 0
      ? Number(item.intervalMinutes)
      : (boost ? intervalSettings.watch : intelligence.intervalMinutes);
    const nextAttemptAt = Date.parse(runtime.nextAttemptAt || "");
    const retryDue = Number.isFinite(nextAttemptAt) && nextAttemptAt > 0;
    const intervalDueAt = lastCheckedAt ? lastCheckedAt + intervalMinutes * 60 * 1000 : 0;
    const dueAt = retryDue ? nextAttemptAt : intervalDueAt;
    const due = retryDue
      ? now.getTime() >= nextAttemptAt
      : (!lastCheckedAt || now.getTime() >= intervalDueAt);
    const overdueMs = due ? Math.max(0, now.getTime() - dueAt) : 0;
    const rolloutScheduled = await isRolloutItemWithinSchedule(env, item, now);
    return {
      item,
      boost,
      runtime,
      intervalMinutes,
      due,
      dueAt,
      overdueMs,
      priorityScore: intelligence.priorityScore,
      scoreFactors: intelligence.factors,
      priorityRank: Number(item.priorityRank || (item.priority === "high" ? 3 : item.priority === "low" ? 1 : 2)),
      rolloutScheduled
    };
  });

  return evaluated
    .filter((entry) => entry.due && entry.rolloutScheduled)
    .sort((a, b) => {
      if (Boolean(a.boost) !== Boolean(b.boost)) return a.boost ? -1 : 1;
      if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
      if (a.runtime.failureCount !== b.runtime.failureCount) return a.runtime.failureCount - b.runtime.failureCount;
      return b.overdueMs - a.overdueMs;
    });
}

export async function activateReleaseWindowBoosts(env, sourceItem, monitorItems, now = new Date()) {
  if (!releaseWindowEnabled(env) || !env.FIRMWARE_KV) return [];

  const configured = new Set(monitorItems.map((item) => targetKey(item.model, item.csc)));
  validateModelCsc(sourceItem.model, sourceItem.csc, { allowedTargets: configured });
  const peers = releaseWindowPeers(env, sourceItem.model, sourceItem.csc)
    .filter((target) => configured.has(targetKey(target.model, target.csc)))
    .map((target) => ({
      ...target,
      ...validateModelCsc(target.model, target.csc, { allowedTargets: configured })
    }));
  if (!peers.length) return [];

  const until = new Date(now.getTime() + releaseWindowDurationMinutes(env) * 60 * 1000);
  return Promise.all(peers.map(async (peer) => {
    const boost = await putMonitorBoost(env, peer.model, peer.csc, {
      until,
      reason: "related_firmware_release",
      sourceModel: sourceItem.model,
      sourceCsc: sourceItem.csc,
      groupId: peer.groupId,
      groupName: peer.groupName
    });
    // These runtime mutations both use read-modify-write storage. Keep them
    // ordered so one update cannot overwrite the other inside this Worker.
    await forceMonitorDue(env, peer.model, peer.csc, now);
    await recordPeerFirmwareUpdate(env, peer.model, peer.csc, now);
    return boost;
  }));
}

async function selectScheduledTargets(env, schedule, now) {
  let claim = await claimDueMonitorTargets(env, now, monitorConcurrency(env) * 2);
  let items = null;
  if (claim?.needsSync) {
    const allItems = await getMonitorItems(env);
    items = allItems.filter((item) => item.enabled !== false);
    await syncMonitorScheduler(env, allItems, now);
    claim = await claimDueMonitorTargets(env, now, monitorConcurrency(env) * 2);
  }
  if (claim) {
    return {
      items,
      selected: (claim.entries || []).map((entry) => ({
        ...entry,
        boost: null,
        intervalMinutes: 0
      })),
      totalItems: Number(claim.totalTargets || items?.length || 0),
      scheduler: "durable_object"
    };
  }

  items = (await getMonitorItems(env)).filter((item) => item.enabled !== false);
  return {
    items,
    selected: await selectDueMonitorItems(env, items, schedule, now),
    totalItems: items.length,
    scheduler: "kv_fallback"
  };
}

async function selectManualTargets(env, now) {
  const allItems = await getMonitorItems(env);
  const items = allItems.filter((item) => item.enabled !== false);
  const synced = await syncMonitorScheduler(env, allItems, now);
  if (synced) {
    const claim = await claimManualMonitorTargets(env, items, now);
    if (claim) {
      return {
        items,
        selected: (claim.entries || []).map((entry) => ({
          ...entry,
          boost: null,
          intervalMinutes: 0
        })),
        totalItems: items.length,
        scheduler: "durable_object_manual",
        skippedInFlight: (claim.skipped || []).length
      };
    }
  }
  return {
    items,
    selected: items.map((item) => ({ item, boost: null, intervalMinutes: 0 })),
    totalItems: items.length,
    scheduler: "manual_fallback",
    skippedInFlight: 0
  };
}

export async function runMonitor(env, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const scheduled = options.reason === "scheduled";
  const schedule = options.schedule || (scheduled ? await getMonitorSchedule(env) : null);
  const selection = scheduled
    ? await selectScheduledTargets(env, schedule, now)
    : await selectManualTargets(env, now);
  const { items, selected } = selection;
  const summary = {
    ok: true,
    scheduler: selection.scheduler,
    totalItems: selection.totalItems,
    due: selected.length,
    boosted: selected.filter((entry) => entry.boost).length,
    skippedNotDue: Math.max(0, selection.totalItems - selected.length),
    boostedTargets: 0,
    started: 0,
    checked: 0,
    updated: 0,
    initialized: 0,
    failed: 0,
    retriedSoon: 0,
    deferredFailures: 0,
    sharedInFlight: 0,
    skippedInFlight: Number(selection.skippedInFlight || 0),
    schedulerConflicts: 0,
    time: formatBeijingTime(now),
    reason: options.reason || "manual"
  };

  if (!env.FIRMWARE_KV) {
    return { ...summary, ok: false, error: "FIRMWARE_KV binding is not configured" };
  }

  const adminId = adminIdForMessages(env);
  const concurrency = monitorConcurrency(env);
  const progressEveryMs = monitorProgressUpdateMs(env);
  let lastProgressAt = 0;
  const emitProgress = async (force = false) => {
    if (typeof options.onProgress !== "function") return;
    const current = Date.now();
    if (!force && current - lastProgressAt < progressEveryMs) return;
    lastProgressAt = current;
    await options.onProgress({ ...summary });
  };

  const notificationTasks = [];
  await emitProgress(true);
  await runLimited(selected, concurrency, async (entry) => {
    const item = entry.item;
    const rolloutSchedule = scheduled
      ? await getRolloutItemScheduleDecision(env, item, now)
      : { allowed: true };
    if (!rolloutSchedule.allowed) {
      summary.skippedNotDue += 1;
      if (entry.schedulerClaim) {
        const nextCheckAt = Math.max(now.getTime() + 60_000, Number(rolloutSchedule.nextCheckAt || 0));
        const completion = await completeMonitorTarget(env, item, {
          lock: entry.lock,
          nextCheckAt,
          lastVersion: entry.lastVersion || "",
          priorityScore: entry.priorityScore || 0,
          status: "skipped",
          completedAt: now.getTime()
        });
        if (completion?.ok === false) summary.schedulerConflicts += 1;
      }
      return;
    }
    summary.started += 1;
    const { outcome, shared } = await runMonitorTargetSingleFlight(item, () =>
      executeMonitorTarget(env, item, items, now, adminId, entry)
    );
    if (shared) summary.sharedInFlight += 1;
    summary.checked += 1;
    applyMonitorOutcome(summary, outcome);
    if (entry.schedulerClaim) {
      const scheduling = await nextMonitorSchedule(env, item, outcome, now, entry.runtime);
      const completion = await completeMonitorTarget(env, item, {
        lock: entry.lock,
        nextCheckAt: scheduling.nextCheckAt,
        lastVersion: outcome?.latest || entry.lastVersion || "",
        priorityScore: scheduling.priorityScore,
        releaseBoost: scheduling.releaseBoost,
        status: outcome?.status || "unknown",
        completedAt: Date.now(),
        error: outcome?.error || "",
        errorClass: outcome?.errorClass || "",
        retrySeconds: outcome?.retrySeconds || 0,
        officialUpdateAt: outcome?.officialUpdateAt || "",
        buildDate: outcome?.buildDate || "",
        sequence: outcome?.sequence,
        querySource: outcome?.querySource || "",
        queryMode: outcome?.queryMode || "",
        queryCacheHit: outcome?.queryCacheHit,
        queryShared: outcome?.queryShared
      });
      if (completion && completion.ok === false) {
        summary.schedulerConflicts += 1;
        console.log(`MonitorScheduler completion rejected for ${item.model}/${item.csc}: ${JSON.stringify(completion)}`);
      }
    }
    if (outcome?.notificationPromise) {
      notificationTasks.push(outcome.notificationPromise);
    }
    await emitProgress(false);
  });

  // Telegram delivery is allowed to overlap with subsequent FUS checks. We
  // still await it before the Worker finishes so scheduled notifications are
  // not abandoned when the event lifetime ends.
  if (notificationTasks.length) await Promise.allSettled(notificationTasks);
  await emitProgress(true);
  return summary;
}

export async function processMonitorQueueMessage(env, payload) {
  const entry = payload?.entry;
  if (!entry?.item?.model || !entry?.item?.csc || !entry?.lock) {
    throw new Error("Invalid sub-minute monitor queue message");
  }
  const claim = await validateMonitorTargetClaim(env, entry);
  if (claim?.ok && claim.valid === false) {
    return { ok: true, skipped: true, reason: "stale_claim" };
  }
  const now = new Date();
  const items = await getMonitorItems(env);
  const current = items.find((item) => item.model === entry.item.model && item.csc === entry.item.csc);
  if (!current || current.enabled === false) {
    await completeMonitorTarget(env, entry.item, {
      lock: entry.lock,
      nextCheckAt: now.getTime() + 60 * 60 * 1000,
      lastVersion: entry.lastVersion || "",
      priorityScore: 0,
      status: "skipped",
      completedAt: now.getTime()
    });
    return { ok: true, skipped: true };
  }

  const rolloutSchedule = await getRolloutItemScheduleDecision(env, current, now);
  if (!rolloutSchedule.allowed) {
    const nextCheckAt = Math.max(now.getTime() + 60_000, Number(rolloutSchedule.nextCheckAt || 0));
    const completion = await completeMonitorTarget(env, entry.item, {
      lock: entry.lock,
      nextCheckAt,
      lastVersion: entry.lastVersion || "",
      priorityScore: entry.priorityScore || 0,
      status: "skipped",
      completedAt: now.getTime()
    });
    if (!completion?.ok) throw new Error("Skipped rollout monitor completion was rejected");
    return { ok: true, skipped: true, reason: rolloutSchedule.reason };
  }

  const adminId = adminIdForMessages(env);
  const { outcome, shared } = await runMonitorTargetSingleFlight(current, () =>
    executeMonitorTarget(env, current, items, now, adminId, entry)
  );
  const scheduling = await nextMonitorSchedule(env, current, outcome, now, entry.runtime);
  const completion = await completeMonitorTarget(env, current, {
    lock: entry.lock,
    nextCheckAt: scheduling.nextCheckAt,
    lastVersion: outcome?.latest || entry.lastVersion || "",
    priorityScore: scheduling.priorityScore,
    releaseBoost: scheduling.releaseBoost,
    status: outcome?.status || "unknown",
    completedAt: Date.now(),
    error: outcome?.error || "",
    errorClass: outcome?.errorClass || "",
    retrySeconds: outcome?.retrySeconds || 0,
    officialUpdateAt: outcome?.officialUpdateAt || "",
    buildDate: outcome?.buildDate || "",
    sequence: outcome?.sequence,
    querySource: outcome?.querySource || "",
    queryMode: outcome?.queryMode || "",
    queryCacheHit: outcome?.queryCacheHit,
    queryShared: outcome?.queryShared
  });
  if (!completion?.ok) throw new Error("Sub-minute monitor completion was rejected");
  if (outcome?.notificationPromise) await outcome.notificationPromise;
  return { ok: true, shared, outcome: outcome?.status || "unknown", completion };
}

export async function nextMonitorSchedule(env, item, outcome, now, schedulerRuntime = null) {
  const [storedRuntime, boost, demand, intervalSettings] = await Promise.all([
    schedulerRuntime ? Promise.resolve(schedulerRuntime) : getMonitorRuntime(env, item.model, item.csc),
    releaseWindowEnabled(env) ? getMonitorBoost(env, item.model, item.csc, now) : Promise.resolve(null),
    getFirmwareQueryDemand(env, item.model, item.csc, now),
    getMonitorIntervalSettings(env)
  ]);
  const runtime = {
    ...storedRuntime,
    failureCount: Number.isFinite(Number(outcome?.failureCount))
      ? Number(outcome.failureCount)
      : Number(storedRuntime?.failureCount || 0)
  };
  const intelligence = calculatePriorityScore({
    item,
    runtime,
    boost,
    queryCount: demand.count
  }, now.getTime(), intervalSettings);
  const outcomeRetryAt = Number(outcome?.retrySeconds || 0) > 0
    ? now.getTime() + Number(outcome.retrySeconds) * 1000
    : 0;
  const storedRetryAt = Date.parse(runtime.nextAttemptAt || "");
  const retryAt = outcome?.status === "failed"
    ? (outcomeRetryAt || (Number.isFinite(storedRetryAt) ? storedRetryAt : 0))
    : 0;
  const intervalMinutes = Number(item.intervalMinutes) > 0
    ? Number(item.intervalMinutes)
    : (boost ? intervalSettings.watch : intelligence.intervalMinutes);
  const dynamicAt = now.getTime() + intervalMinutes * 60 * 1000;
  return {
    ...intelligence,
    intervalMinutes,
    releaseBoost: Boolean(boost),
    nextCheckAt: Number.isFinite(retryAt) && retryAt > 0 ? retryAt : dynamicAt
  };
}

async function runMonitorTargetSingleFlight(item, factory) {
  const key = targetKey(item.model, item.csc);
  const existing = monitorTargetFlights.get(key);
  if (existing) return { outcome: await existing, shared: true };
  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (monitorTargetFlights.get(key) === promise) monitorTargetFlights.delete(key);
    });
  monitorTargetFlights.set(key, promise);
  return { outcome: await promise, shared: false };
}

function samsungDateIso(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return "";
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

async function executeMonitorTarget(env, item, items, now, adminId, schedulerEntry = null) {
  try {
    const key = firmwareKey(item.model, item.csc);
    const schedulerOwnsVersion = schedulerEntry?.schedulerClaim === true;
    const previousFailureCount = Math.max(0, Number(schedulerEntry?.failureCount || 0));
    if (item.priority === "high" || item.prioritySource === "flagship_linkage") {
      markFirmwareTargetHot(item.model, item.csc, 2 * 60 * 60);
    }
    const result = await coordinatedFirmwareQuery(env, item.model, item.csc, {
      monitor: true,
      role: "monitor",
      // Automatic monitoring must always verify Samsung directly. The
      // coordinator may still join an already-running live request for the
      // exact same target, but positive/negative caches are bypassed.
      refresh: true
    });
    const parsed = result.parsed;
    if (!isExactSmartHistory(parsed)) {
      const error = new Error(`SmartHistory did not return an exact CSC result for ${item.model}/${item.csc}`);
      error.code = "MONITOR_EXACT_CSC_REQUIRED";
      throw error;
    }
    const oldLatest = !schedulerOwnsVersion
      ? await env.FIRMWARE_KV.get(key)
      : String(schedulerEntry.lastVersion || "");
    const runtimeBefore = schedulerOwnsVersion
      ? (schedulerEntry.runtime || {})
      : await getMonitorRuntime(env, item.model, item.csc);
    const oldFingerprint = firmwareVersionFingerprint(oldLatest);
    const newFingerprint = firmwareVersionFingerprint(parsed.latest);
    const rawOldSequence = runtimeBefore?.lastSequence;
    const rawNewSequence = parsed.smartHistory?.sequence;
    const oldSequence = rawOldSequence !== null && rawOldSequence !== undefined && rawOldSequence !== "" && Number.isFinite(Number(rawOldSequence))
      ? Number(rawOldSequence)
      : null;
    const newSequence = rawNewSequence !== null && rawNewSequence !== undefined && rawNewSequence !== "" && Number.isFinite(Number(rawNewSequence))
      ? Number(rawNewSequence)
      : null;
    const rolloutBaselineReset = item.rolloutBaselinePending === true;
    // Existing installations may have a saved version from before sequence
    // tracking was introduced. Silently attach the current Samsung sequence
    // once instead of treating that migration as a fresh release.
    const sequenceBaselineReset = !rolloutBaselineReset && Boolean(oldLatest) && oldSequence === null && newSequence !== null;
    const baselineReset = rolloutBaselineReset || sequenceBaselineReset;
    const staleSnapshot = !baselineReset && oldSequence !== null && newSequence !== null && newSequence < oldSequence;
    const sequenceMissingSnapshot = !baselineReset && oldSequence !== null && newSequence === null;
    const sameSequence = !baselineReset && oldSequence !== null && newSequence !== null && newSequence === oldSequence;
    const versionChanged = !baselineReset && !staleSnapshot && !sequenceMissingSnapshot && Boolean(oldLatest) && oldFingerprint !== newFingerprint && (
      oldSequence !== null && newSequence !== null
        ? newSequence > oldSequence
        : true
    );
    const successMetadata = {
      versionChanged,
      officialUpdateAt: versionChanged
        ? now.toISOString()
        : samsungDateIso(parsed.buildDate || parsed.smartHistory?.openDate),
      buildDate: parsed.buildDate || parsed.smartHistory?.openDate || "",
      sequence: newSequence,
      querySource: parsed.source || "Samsung FUS SmartHistory",
      queryMode: "realtime",
      queryCacheHit: Boolean(result.coordinator?.cacheHit),
      queryShared: Boolean(result.coordinator?.shared || result.queryTiming?.singleFlightJoined)
    };

    if (staleSnapshot || sequenceMissingSnapshot) {
      // Samsung can briefly return an incomplete/older History snapshot while
      // replicas synchronize. Once a sequence baseline exists, a response
      // without a sequence is also ambiguous. Never downgrade the baseline or
      // global query cache, and never notify users about either snapshot.
      if (!schedulerOwnsVersion) {
        await recordMonitorSuccess(env, item.model, item.csc, now, {
          latest: oldLatest,
          ...successMetadata,
          versionChanged: false,
          sequence: oldSequence
        });
      }
      await recordMonitorEventSafely(env, {
        type: staleSnapshot ? "stale_snapshot_ignored" : "sequence_missing_snapshot_ignored",
        model: item.model,
        csc: item.csc,
        name: item.name,
        detail: staleSnapshot
          ? `Ignored sequence ${newSequence}; baseline sequence is ${oldSequence}`
          : `Ignored sequence-less snapshot; baseline sequence is ${oldSequence}`,
        source: parsed.source || "Samsung SmartHistory",
        at: now.toISOString()
      });
      return {
        status: "unchanged",
        staleSnapshot: true,
        boostedTargets: 0,
        latest: oldLatest,
        notificationPromise: null,
        ...successMetadata,
        versionChanged: false,
        sequence: oldSequence
      };
    }

    await writeMonitorGlobalCache(env, item, parsed, result.canonicalCache);
    if (!schedulerOwnsVersion) {
      await recordMonitorSuccess(env, item.model, item.csc, now, {
        latest: parsed.latest,
        ...successMetadata
      });
    }

    if (baselineReset) {
      // A newly activated rollout stage must begin from Samsung's current
      // latest release. Old saved versions belong to a previous monitoring
      // period and must never be replayed as fresh update notifications.
      if (!schedulerOwnsVersion) await env.FIRMWARE_KV.put(key, parsed.latest);
      if (rolloutBaselineReset) {
        await upsertMonitorItem(env, { ...item, rolloutBaselinePending: false });
      }
      await recordMonitorEventSafely(env, {
        type: rolloutBaselineReset ? "rollout_baseline_initialized" : "sequence_baseline_initialized",
        model: item.model,
        csc: item.csc,
        name: item.name,
        detail: `Baseline -> ${parsed.latest}`,
        source: parsed.source || "Samsung SmartHistory",
        at: now.toISOString()
      });
      return {
        status: "baseline",
        baselineReset: true,
        boostedTargets: 0,
        latest: parsed.latest,
        notificationPromise: null,
        ...successMetadata
      };
    }

    if (!oldLatest) {
      if (!schedulerOwnsVersion) await env.FIRMWARE_KV.put(key, parsed.latest);
      const notificationPromise = notifyOnFirstRun(env) && adminId
        ? notifyFirstRun(env, item, parsed, now, adminId)
        : null;
      return { status: "initialized", boostedTargets: 0, latest: parsed.latest, notificationPromise, ...successMetadata };
    }

    if (sameSequence || (oldFingerprint && oldFingerprint === newFingerprint)) {
      if (!schedulerOwnsVersion && oldLatest !== parsed.latest) await env.FIRMWARE_KV.put(key, parsed.latest);
      if (previousFailureCount > 0) {
        await recordMonitorEventSafely(env, {
          type: "recovered",
          model: item.model,
          csc: item.csc,
          name: item.name,
          detail: `Recovered after ${previousFailureCount} failed check${previousFailureCount === 1 ? "" : "s"}`,
          source: parsed.source || "Samsung SmartHistory",
          at: now.toISOString()
        });
      }
      return { status: "unchanged", boostedTargets: 0, latest: parsed.latest, ...successMetadata };
    }

    const configuredItems = items || await getMonitorItems(env);
    if (!schedulerOwnsVersion) await env.FIRMWARE_KV.put(key, parsed.latest);
    const boosts = await activateReleaseWindowBoosts(env, item, configuredItems, now);
    await recordMonitorEventSafely(env, {
      type: "update_detected",
      model: item.model,
      csc: item.csc,
      name: item.name,
      detail: `${oldLatest} -> ${parsed.latest}`,
      source: parsed.source || "Samsung SmartHistory",
      at: now.toISOString()
    });
    // A version change sends one notification and keeps the normal schedule.
    const rollout = await createRolloutProposalForUpdate(env, item, parsed, now);
    const updateNotice = rollout?.suppressUpdate
      ? Promise.resolve({ attempted: 0, queued: 0, sent: 0, suppressed: true })
      : notifyFirmwareUpdate(env, item, oldLatest, parsed, {
        notifyManagers: !rollout?.proposal
      });
    const rolloutNotice = rollout?.proposal
      ? notifyRolloutProposal(env, rollout.proposal)
      : null;
    const notificationPromise = rolloutNotice
      ? Promise.allSettled([updateNotice, rolloutNotice])
      : updateNotice;
    return {
      status: "updated",
      boostedTargets: boosts.length,
      latest: parsed.latest,
      notificationPromise,
      ...successMetadata
    };
  } catch (error) {
    const runtime = schedulerEntry?.schedulerClaim
      ? monitorFailureOutcome(env, error, Number(schedulerEntry.failureCount || 0))
      : await recordMonitorFailure(env, item.model, item.csc, error, now);
    await recordMonitorEventSafely(env, {
      type: "monitor_failed",
      model: item.model,
      csc: item.csc,
      name: item.name,
      error: String(error?.message || error),
      failureCount: runtime.failureCount,
      retryAt: now.getTime() + Number(runtime.retrySeconds || 0) * 1000,
      source: "Samsung SmartHistory",
      at: now.toISOString()
    });
    console.log(`Monitor failed for ${item.model}/${item.csc}; retry in ${runtime.retrySeconds}s: ${error.message}`);
    return {
      status: "failed",
      retrySeconds: runtime.retrySeconds,
      errorClass: runtime.errorClass || "transient",
      failureCount: runtime.failureCount,
      error: String(error?.message || error)
    };
  }
}

async function recordMonitorEventSafely(env, event) {
  try {
    await recordMonitorEvent(env, event);
  } catch (error) {
    console.log(`Monitor event log deferred: ${error.message}`);
  }
}

function monitorFailureOutcome(env, error, previousFailureCount = 0) {
  const failureCount = Math.max(0, Number(previousFailureCount || 0)) + 1;
  const message = String(error?.message || error || "Unknown monitor error");
  const permanent = /(?:HTTP 403|HTTP 404|no matching CSC|no usable firmware|未找到|没有公开固件)/i.test(message);
  const retrySeconds = permanent
    ? monitorPermanentErrorRetrySeconds(env)
    : Math.min(
      monitorFailureRetryMaxSeconds(env),
      monitorFailureRetryBaseSeconds(env) * (2 ** Math.min(6, failureCount - 1))
    );
  return {
    failureCount,
    retrySeconds,
    errorClass: permanent ? "permanent" : "transient",
    lastError: message
  };
}

function applyMonitorOutcome(summary, outcome) {
  summary.boostedTargets += Number(outcome?.boostedTargets || 0);
  if (["initialized", "baseline"].includes(outcome?.status)) summary.initialized += 1;
  if (outcome?.status === "updated") summary.updated += 1;
  if (outcome?.status !== "failed") return;
  summary.failed += 1;
  if (outcome.errorClass === "transient" && Number(outcome.retrySeconds || 0) <= 5 * 60) {
    summary.retriedSoon += 1;
  } else {
    summary.deferredFailures += 1;
  }
}

function monitorConcurrency(env) {
  const value = Number(env.MONITOR_CONCURRENCY || 3);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), 3);
}

async function runLimited(items, concurrency, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 0) }, async (_, workerIndex) => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item, workerIndex);
    }
  });
  await Promise.all(workers);
}

async function mapLimited(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 0) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writeMonitorGlobalCache(env, item, parsed, coordinatedCanonical = null) {
  const existing = coordinatedCanonical ? null : await getFirmwareQueryCache(env, item.model, item.csc);
  const canonical = coordinatedCanonical || buildFirmwareCacheRecord(env, existing, item.model, item.csc, parsed);
  setL1Firmware(item.model, item.csc, canonical, l1CacheTtlSeconds(env));
  setFirmwareMemoryCache(item.model, item.csc, canonical);
  if (!coordinatedCanonical) {
    const existingFingerprint = firmwareVersionFingerprint(existing?.latest || "");
    const nextFingerprint = firmwareVersionFingerprint(canonical.latest || "");
    if (existingFingerprint !== nextFingerprint) {
      await setFirmwareQueryCache(env, item.model, item.csc, canonical);
    }
  }
  return canonical;
}

async function preparePendingUpdate(env, item, oldLatest, parsed) {
  return null;
  /* Legacy pending-reminder implementation retained below only for source
   * history. One-shot update delivery must never write a pending record.
  const now = new Date();
  const newFingerprint = firmwareVersionFingerprint(parsed.latest);
  const existingPending = await getPendingUpdate(env, item.model, item.csc);
  if (existingPending && firmwareVersionFingerprint(existingPending.newLatest) === newFingerprint) {
    return null;
  }
  const acked = await getAckedUpdate(env, item.model, item.csc);
  if (acked && acked.versionFingerprint === newFingerprint) {
    return null;
  }
  const pending = {
    model: item.model,
    csc: item.csc,
    name: item.name || `${item.model} / ${item.csc}`,
    oldLatest,
    newLatest: parsed.latest,
    pda: parsed.pda,
    cscVersion: parsed.cscVersion,
    modem: parsed.modem || "N/A",
    android: parsed.android || "未知",
    docUrl: docUrl(item.model, item.csc),
    source: "Samsung FUS SmartHistory",
    sourceType: "smart_history",
    detectedAt: now.toISOString(),
    firstNotifiedAt: "",
    firstQueuedAt: now.toISOString(),
    lastReminderAt: "",
    lastReminderQueuedAt: now.toISOString(),
    reminderCount: 0,
    acked: false
  };

  // Persist before sending. If Telegram is temporarily unavailable, the
  // reminder worker can still deliver the pending update later.
  await putPendingUpdate(env, pending);
  return pending;
  */
}

async function notifyFirstRun(env, item, parsed, now, adminId) {
  try {
    const lang = await getUserLanguage(env, adminId);
    const fingerprint = firmwareVersionFingerprint(parsed.latest);
    const delivery = await enqueueTelegramNotification(env, {
      id: `first-run:${item.model}:${item.csc}:${fingerprint}:${adminId}`,
      chatId: adminId,
      text: formatMonitorBaseline(item, parsed, now, lang)
    });
    return {
      attempted: 1,
      queued: delivery.queued ? 1 : 0,
      sent: delivery.sent ? 1 : 0
    };
  } catch (error) {
    console.log(`Notify first run failed for ${adminId}: ${error.message}`);
    return { attempted: 1, queued: 0, sent: 0 };
  }
}

function notificationSeriesForItem(item = {}) {
  const name = String(item.name || "");
  const fromName = name.match(/\bS(25|26)\b/i);
  if (fromName) return `S${fromName[1]}`;
  const model = String(item.model || "").toUpperCase();
  if (/^SM-S(?:942|947|948)[A-Z0-9]*$/.test(model)) return "S26";
  if (/^SM-S(?:931|936|937|938)[A-Z0-9]*$/.test(model)) return "S25";
  return "";
}

function notificationBatchWindowSeconds(env) {
  const value = Number(env?.FIRMWARE_NOTIFICATION_BATCH_SECONDS || 20);
  if (!Number.isFinite(value)) return 20;
  return Math.max(5, Math.min(60, Math.floor(value)));
}

async function queueFirmwareUpdateBatch(env, item, oldLatest, parsed, options = {}) {
  if (!env?.NOTIFICATION_QUEUE?.send) return null;
  const series = notificationSeriesForItem(item);
  if (!series) return null;
  const csc = String(item.csc || "").toUpperCase();
  const batchKey = `${series.toLowerCase()}:${csc.toLowerCase()}`;
  const windowSeconds = notificationBatchWindowSeconds(env);
  const batch = await addFirmwareNotificationBatch(env, batchKey, {
    model: item.model,
    csc,
    name: item.name,
    oldLatest,
    latest: parsed.latest,
    sequence: parsed.smartHistory?.sequence,
    source: parsed.source || "Samsung SmartHistory",
    series,
    notifyManagers: options.notifyManagers !== false,
    notifyAllowedUsers: item.notifyAllowedUsers !== false,
    detectedAt: new Date().toISOString()
  }, { windowSeconds });
  if (!batch?.ok || !batch.batchId) return null;

  if (batch.created) {
    await env.NOTIFICATION_QUEUE.send({
      schemaVersion: 1,
      kind: "firmware_update_batch_flush",
      id: `firmware-update-batch-flush:${batch.batchId}`,
      batchKey,
      batchId: batch.batchId,
      createdAt: new Date().toISOString()
    }, { delaySeconds: windowSeconds });
  }
  return {
    attempted: 0,
    queued: 1,
    sent: 0,
    batched: true,
    batchId: batch.batchId,
    batchCount: batch.count
  };
}

async function notifyFirmwareUpdate(env, item, oldLatest, parsed, options = {}) {
  // Latest S-series releases often reach several models within seconds. Buffer
  // S25/S26 notices briefly and send one bilingual per-user card per region.
  // If the durable batching path is unavailable, fall back to the proven
  // one-message-per-model path instead of dropping a notification.
  try {
    const batched = await queueFirmwareUpdateBatch(env, item, oldLatest, parsed, options);
    if (batched) return batched;
  } catch (error) {
    console.log(`Firmware notification batching unavailable for ${item.model}/${item.csc}: ${error.message}`);
  }
  return notifyFirmwareUpdateImmediate(env, item, oldLatest, parsed, options);
}

async function notifyFirmwareUpdateImmediate(env, item, oldLatest, parsed, options = {}) {
  const now = new Date();
  const adminIds = await getAdminChatIds(env);
  const notificationTasks = [];
  const fingerprint = firmwareVersionFingerprint(parsed.latest);
  if (options.notifyManagers !== false) {
    for (const adminId of adminIds) notificationTasks.push((async () => {
      try {
        const adminLang = await getUserLanguage(env, adminId);
        const delivery = await enqueueTelegramNotification(env, {
        id: `firmware-update:${item.model}:${item.csc}:${fingerprint}:${adminId}`,
        chatId: adminId,
        text: formatMonitorNotification(item, oldLatest, parsed, now, adminLang, false),
        replyMarkup: updateUserKeyboard(item.model, item.csc, adminLang),
        monitorEvent: {
          model: item.model,
          csc: item.csc,
          name: item.name,
          audience: "owner",
          source: parsed.source || "Samsung SmartHistory"
        }
        });
        return {
          attempted: 1,
          queued: delivery.queued ? 1 : 0,
          sent: delivery.sent ? 1 : 0
        };
      } catch (error) {
        console.log(`Notify admin failed for ${adminId}: ${error.message}`);
        return { attempted: 1, queued: 0, sent: 0 };
      }
    })());
  }
  if (notifyAllowedUsersOnUpdate(env) && item.notifyAllowedUsers !== false) {
    notificationTasks.push(notifyAllowedUsersOfUpdate(env, item, oldLatest, parsed, now, adminIds));
  }
  if (!notificationTasks.length) return { attempted: 0, queued: 0, sent: 0 };

  const results = await Promise.allSettled(notificationTasks);
  return results.reduce((total, result) => {
    if (result.status !== "fulfilled") return total;
    return {
      attempted: total.attempted + Number(result.value?.attempted || 0),
      queued: total.queued + Number(result.value?.queued || 0),
      sent: total.sent + Number(result.value?.sent || 0)
    };
  }, { attempted: 0, queued: 0, sent: 0 });
}

async function notifyRolloutProposal(env, proposal) {
  const adminIds = await getAdminChatIds(env);
  const results = await Promise.allSettled(adminIds.map(async (chatId) => {
    const lang = await getUserLanguage(env, chatId);
    return enqueueTelegramNotification(env, {
      id: `rollout:${proposal.id}:${chatId}`,
      chatId,
      text: rolloutProposalText(proposal, lang),
      replyMarkup: rolloutProposalKeyboard(proposal, lang),
      monitorEvent: {
        model: proposal.source.model,
        csc: proposal.source.csc,
        name: proposal.chainName,
        audience: "manager",
        source: "rollout_chain"
      }
    });
  }));
  return {
    attempted: adminIds.length,
    queued: results.filter((result) => result.status === "fulfilled" && result.value?.queued).length,
    sent: results.filter((result) => result.status === "fulfilled" && result.value?.sent).length
  };
}

async function notifyFlagshipPriorityPrompts(env, item, parsed, now, adminId) {
  if (!adminId) return { queued: 0, sent: 0 };
  const proposals = [
    buildFlagshipActivationProposal(env, item, parsed, now),
    buildLinkedTargetReviewProposal(item, parsed, now)
  ].filter(Boolean);
  if (!proposals.length) return { queued: 0, sent: 0 };

  const lang = await getUserLanguage(env, adminId);
  const results = [];
  for (const proposal of proposals) {
    await putFlagshipProposal(env, proposal);
    const activation = proposal.type === "activate_previous_flagship";
    results.push(await enqueueTelegramNotification(env, {
      id: `flagship-priority:${proposal.type}:${proposal.id}:${adminId}`,
      chatId: adminId,
      text: activation ? activationPromptText(proposal, lang) : reviewPromptText(proposal, lang),
      replyMarkup: activation ? activationPromptKeyboard(proposal, lang) : reviewPromptKeyboard(proposal, lang)
    }));
  }
  return {
    queued: results.filter((result) => result?.queued).length,
    sent: results.filter((result) => result?.sent).length
  };
}

async function notifyAllowedUsersOfUpdate(env, item, oldLatest, parsed, now, adminIds = []) {
  const users = await getAllowedUsers(env);
  const managerIds = new Set((Array.isArray(adminIds) ? adminIds : [adminIds]).map((id) => String(id || "")));
  const recipients = users.filter((user) => {
    const chatId = String(user.chatId || "").trim();
    return chatId && !managerIds.has(chatId);
  });
  const fingerprint = firmwareVersionFingerprint(parsed.latest);
  const results = await mapLimited(recipients, telegramNotifyConcurrency(env), async (user) => {
    const chatId = String(user.chatId || "").trim();
    try {
      const lang = await getUserLanguage(env, chatId);
      return await enqueueTelegramNotification(env, {
        id: `firmware-update:${item.model}:${item.csc}:${fingerprint}:${chatId}`,
        chatId,
        text: formatMonitorNotification(item, oldLatest, parsed, now, lang, false),
        replyMarkup: updateUserKeyboard(item.model, item.csc, lang),
        monitorEvent: {
          model: item.model,
          csc: item.csc,
          name: item.name,
          audience: "allowed_user",
          source: parsed.source || "Samsung SmartHistory"
        }
      });
    } catch (error) {
      console.log(`Notify allowed user failed for ${chatId}: ${error.message}`);
      return { ok: false, queued: false, sent: false };
    }
  });
  return {
    attempted: recipients.length,
    queued: results.filter((result) => result?.queued).length,
    sent: results.filter((result) => result?.sent).length
  };
}

function updateUserKeyboard(_model, _csc, lang = "zh") {
  const en = lang === "en";
  return {
    inline_keyboard: [
      [{ text: en ? "Open menu" : "打开菜单", callback_data: "menu:home" }]
    ]
  };
}


export function formatSchedule(schedule, lang = "zh", summarySettings = null) {
  const summaryEnabled = summarySettings?.enabled !== false;
  const summaryHour = String(summarySettings?.hour ?? 21).padStart(2, "0");
  if (lang === "en") {
    return [
      "⏰ Automatic monitoring rules",
      "",
      `Status: ${schedule.enabled ? "enabled" : "paused"}`,
      `Time zone: ${schedule.timezone || "Asia/Shanghai"}`,
      `Start time: ${schedule.startTime} Beijing Time`,
      `End time: ${schedule.endTime} Beijing Time`,
      "Intervals: configured by priority in Monitor intervals; individual targets may override them.",
      `Weekend monitoring: ${schedule.skipWeekends ? "disabled" : "enabled"}`,
      `Daily admin summary: ${summaryEnabled ? `enabled at ${summaryHour}:00 Beijing Time` : "disabled"}`,
      "Cron wake-up frequency: 1 minute",
      "Release acceleration: enabled only by an explicit release signal or administrator action.",
      "",
      "Notes:",
      "The Worker wakes every minute, while MonitorScheduler claims only targets whose nextCheckAt is due.",
      "Release windows only boost exact Model / CSC targets already configured; no combinations are generated."
    ].join("\n");
  }

  return [
    "⏰ 自动监控规则",
    "",
    `状态：${schedule.enabled ? "开启" : "暂停"}`,
    `时区：${schedule.timezone || "Asia/Shanghai"}`,
    `开始时间：${schedule.startTime} 北京时间`,
    `结束时间：${schedule.endTime} 北京时间`,
    "监控间隔：由管理员在“监控间隔设置”中按强度配置，设备也可单独覆盖。",
    `周末监控：${schedule.skipWeekends ? "关闭" : "开启"}`,
    `每日管理员摘要：${summaryEnabled ? `开启（${summaryHour}:00 北京时间）` : "关闭"}`,
    "Cron 唤醒频率：1 分钟",
    "发布窗口加速：仅由明确发布信号或管理员操作触发，不再因高评分自动长期加速。",
    "",
    "说明：",
    "Worker 每分钟唤醒一次，MonitorScheduler 只领取 nextCheckAt 已到期的设备。",
    "发布窗口只提升配置中已有的精确 Model / CSC，不会自动拼接型号和地区。"
  ].join("\n");
}
