import {
  adminChatId,
  allowedUserDailyModelQueryLimit,
  defaultCacheSettings,
  defaultDailyMonitorSummarySettings,
  defaultSchedule,
  envMonitorItems,
  firmwareCacheStaleSeconds,
  globalQueryCacheTtlSeconds,
  isAdminChatId,
  monitorFailureRetryBaseSeconds,
  monitorFailureRetryMaxSeconds,
  monitorPermanentErrorRetrySeconds,
  normalizeMonitorItems,
  queryCacheTtlSeconds,
  queryRateLimitSeconds
} from "./config.js";
import { ackedUpdateKey, buildUserQueryCacheKey, firmwareVersionFingerprint, pendingUpdateKey } from "./utils.js";
import {
  claimSchedulerCronSlot,
  claimSchedulerDailyModelQuery,
  claimSchedulerQueryRateLimit,
  cancelSchedulerMonitorSnooze,
  appendSchedulerMonitorEvent,
  deleteSchedulerControlState,
  forceSchedulerTargetDue,
  getSchedulerQueryDemand,
  getSchedulerControlState,
  getSchedulerMonitorEvents,
  getSchedulerTargetState,
  patchSchedulerTargetState,
  putSchedulerControlState,
  recordSchedulerQueryDemand,
  removeSchedulerMonitorItem,
  snoozeSchedulerMonitorItem,
  syncMonitorScheduler,
  upsertSchedulerMonitorItem
} from "./monitor-scheduler.js";
import { validateModelCsc } from "./targets.js";

const ALLOWED_USERS_KEY = "allowed:users";
const ACCESS_REQUESTS_KEY = "access:requests";
const ACCESS_SETTINGS_KEY = "access:settings";
const MONITOR_ITEMS_KEY = "monitor:items";
const MONITOR_SCHEDULE_KEY = "monitor:schedule";
const MONITOR_SUMMARY_SETTINGS_KEY = "monitor:summary-settings";
const CACHE_SETTINGS_KEY = "cache:settings";
const MONITOR_EVENTS_KEY = "monitor:events";


const stateMemoryCache = new Map();
const fallbackQueryRates = new Map();
const fallbackDailyModelQuotas = new Map();
const fallbackQueryDemand = new Map();

export function resetStateMemoryCache() {
  stateMemoryCache.clear();
  fallbackQueryRates.clear();
  fallbackDailyModelQuotas.clear();
  fallbackQueryDemand.clear();
}

function memoryGet(key) {
  const entry = stateMemoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    stateMemoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function memoryPut(key, value, ttlMs = 30000) {
  stateMemoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (stateMemoryCache.size > 500) {
    const first = stateMemoryCache.keys().next().value;
    stateMemoryCache.delete(first);
  }
  return value;
}

function memoryDelete(key) {
  stateMemoryCache.delete(key);
}

function monitorLastCheckKey(model, csc) {
  return `monitor:last-check:${validateModelCsc(model, csc).key}`;
}

function monitorBoostKey(model, csc) {
  return `monitor:boost:${validateModelCsc(model, csc).key}`;
}

function monitorRuntimeKey(model, csc) {
  return `monitor:runtime:${validateModelCsc(model, csc).key}`;
}

function monitorDemandKey(model, csc) {
  return `monitor:demand:${validateModelCsc(model, csc).key}`;
}

function flagshipProposalKey(proposalId) {
  const id = String(proposalId || "").trim();
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(id)) throw new Error("Invalid flagship proposal id");
  return `flagship:proposal:${id}`;
}

function userLanguageKey(chatId) {
  return `user:lang:${String(chatId)}`;
}

export function globalQueryCacheKey(model, csc) {
  return `query:global:${validateModelCsc(model, csc).key}`;
}

export function firmwareQueryCacheKey(model, csc) {
  return `firmware:v2:${validateModelCsc(model, csc).key}`;
}

function queryRateLimitKey(chatId) {
  return `rate:query:${String(chatId)}`;
}

export async function kvGetJson(env, key, fallback = null) {
  if (!env.FIRMWARE_KV) return fallback;
  try {
    const raw = await env.FIRMWARE_KV.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.log(`KV JSON read failed for ${key}: ${error.message}`);
    return fallback;
  }
}

export async function kvPutJson(env, key, value, options = {}) {
  if (!env.FIRMWARE_KV) return false;
  await env.FIRMWARE_KV.put(key, JSON.stringify(value), options);
  return true;
}

export async function listJsonByPrefix(env, prefix) {
  if (!env.FIRMWARE_KV) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.FIRMWARE_KV.list({ prefix, cursor });
    const entries = await Promise.all((page.keys || []).map(async (key) => ({
      key: key.name,
      value: await kvGetJson(env, key.name, null)
    })));
    out.push(...entries.filter((entry) => entry.value));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function getControlStateWithLegacyMigration(env, key, fallback = null) {
  const durable = await getSchedulerControlState(env, key);
  if (durable?.ok && durable.found) return durable.value;
  const legacy = await kvGetJson(env, key, fallback);
  if (durable?.ok && !durable.found && legacy !== null && legacy !== undefined) {
    await putSchedulerControlState(env, key, legacy);
  }
  return legacy;
}

async function putControlStateOrLegacy(env, key, value) {
  const durable = await putSchedulerControlState(env, key, value);
  if (durable?.ok) return durable;
  await kvPutJson(env, key, value);
  return { ok: true, durable: false, legacyFallback: true };
}

export async function getAllowedUsers(env) {
  const cached = memoryGet(ALLOWED_USERS_KEY);
  if (cached) return cached.map((user) => ({ ...user }));
  const users = await getControlStateWithLegacyMigration(env, ALLOWED_USERS_KEY, []);
  if (!Array.isArray(users)) return [];
  const normalized = users
    .map((user) => ({
      chatId: String(user.chatId || "").trim(),
      name: String(user.name || "").trim(),
      addedAt: user.addedAt || ""
    }))
    .filter((user) => user.chatId);
  memoryPut(ALLOWED_USERS_KEY, normalized, 30000);
  return normalized.map((user) => ({ ...user }));
}

export async function setAllowedUsers(env, users) {
  await putControlStateOrLegacy(env, ALLOWED_USERS_KEY, users);
  memoryDelete(ALLOWED_USERS_KEY);
}

export async function addAllowedUser(env, chatId, name = "") {
  const id = String(chatId || "").trim();
  if (!id) throw new Error("Chat ID 不能为空");
  const users = await getAllowedUsers(env);
  const existing = users.find((user) => user.chatId === id);
  if (existing) {
    existing.name = name || existing.name || id;
  } else {
    users.push({ chatId: id, name: name || id, addedAt: new Date().toISOString() });
  }
  await setAllowedUsers(env, users);
  return users.find((user) => user.chatId === id);
}

export async function removeAllowedUser(env, chatId) {
  const id = String(chatId || "").trim();
  const users = await getAllowedUsers(env);
  const next = users.filter((user) => user.chatId !== id);
  await setAllowedUsers(env, next);
  return next.length !== users.length;
}

export async function getAccessRequests(env) {
  const requests = await getControlStateWithLegacyMigration(env, ACCESS_REQUESTS_KEY, []);
  if (!Array.isArray(requests)) return [];
  return requests
    .map((request) => ({
      chatId: String(request.chatId || "").trim(),
      username: String(request.username || "").trim(),
      firstName: String(request.firstName || "").trim(),
      lastName: String(request.lastName || "").trim(),
      name: String(request.name || "").trim(),
      requestedAt: request.requestedAt || "",
      status: request.status || "pending"
    }))
    .filter((request) => request.chatId && request.status === "pending");
}

export async function setAccessRequests(env, requests) {
  await putControlStateOrLegacy(env, ACCESS_REQUESTS_KEY, requests);
}

export async function upsertAccessRequest(env, request) {
  const chatId = String(request.chatId || "").trim();
  if (!chatId) throw new Error("Chat ID 不能为空");
  const requests = await getAccessRequests(env);
  const existing = requests.find((item) => item.chatId === chatId);
  const value = {
    chatId,
    username: String(request.username || "").trim(),
    firstName: String(request.firstName || "").trim(),
    lastName: String(request.lastName || "").trim(),
    name: String(request.name || "").trim() || chatId,
    requestedAt: existing?.requestedAt || new Date().toISOString(),
    status: "pending"
  };
  if (existing) Object.assign(existing, value);
  else requests.push(value);
  await setAccessRequests(env, requests);
  return value;
}

export async function removeAccessRequest(env, chatId) {
  const id = String(chatId || "").trim();
  const requests = await getAccessRequests(env);
  const next = requests.filter((request) => request.chatId !== id);
  await setAccessRequests(env, next);
  return next.length !== requests.length;
}

export async function getAccessSettings(env) {
  const stored = await getControlStateWithLegacyMigration(env, ACCESS_SETTINGS_KEY, {});
  const expiresAt = stored?.autoApproveExpiresAt || "";
  const expired = expiresAt && Date.now() >= Date.parse(expiresAt);
  return {
    autoApprove: Boolean(stored?.autoApprove) && !expired,
    autoApproveExpiresAt: expired ? "" : expiresAt,
    updatedAt: stored?.updatedAt || ""
  };
}

export async function setAccessAutoApprove(env, enabled, expiresAt = "") {
  const value = {
    autoApprove: Boolean(enabled),
    autoApproveExpiresAt: enabled && expiresAt ? expiresAt : "",
    updatedAt: new Date().toISOString()
  };
  await putControlStateOrLegacy(env, ACCESS_SETTINGS_KEY, value);
  return value;
}

export async function getUserLanguage(env, chatId) {
  const key = userLanguageKey(chatId);
  const durable = await getSchedulerControlState(env, key);
  if (durable?.ok && durable.found) {
    const value = durable.value === "en" ? "en" : "zh";
    return memoryPut(key, value, 60000);
  }
  const cached = memoryGet(key);
  if (cached) return cached;
  const stored = await env.FIRMWARE_KV?.get(key);
  const value = stored === "en" ? "en" : "zh";
  if (durable?.ok && !durable.found) await putSchedulerControlState(env, key, value);
  return memoryPut(key, value, 60000);
}

export async function setUserLanguage(env, chatId, lang) {
  const value = lang === "en" ? "en" : "zh";
  const key = userLanguageKey(chatId);
  const current = await getUserLanguage(env, chatId);
  if (current === value) return value;
  const durable = await putSchedulerControlState(env, key, value);
  if (!durable?.ok) await env.FIRMWARE_KV?.put(key, value);
  memoryPut(key, value, 60000);
  return value;
}

export async function getIdentity(env, chatId) {
  const id = String(chatId || "").trim();
  if (isAdminChatId(env, id)) return "admin";
  const users = await getAllowedUsers(env);
  return users.some((user) => user.chatId === id) ? "allowed" : "unauthorized";
}

export function identityLabel(identity) {
  if (identity === "admin") return "管理员";
  if (identity === "allowed") return "已授权";
  return "未授权";
}

export async function isAuthorizedForQuery(env, chatId) {
  const identity = await getIdentity(env, chatId);
  return identity === "admin" || identity === "allowed";
}

export async function getMonitorItems(env) {
  const cached = memoryGet(MONITOR_ITEMS_KEY);
  if (cached) return cached.map((item) => ({ ...item }));
  const durable = await getSchedulerControlState(env, MONITOR_ITEMS_KEY);
  const items = durable?.ok && durable.found
    ? durable.value
    : await kvGetJson(env, MONITOR_ITEMS_KEY, null);
  const normalized = Array.isArray(items) ? normalizeMonitorItems(items) : envMonitorItems(env);
  if (durable?.ok && !durable.found) {
    await putSchedulerControlState(env, MONITOR_ITEMS_KEY, normalized);
  }
  memoryPut(MONITOR_ITEMS_KEY, normalized, 15000);
  return normalized.map((item) => ({ ...item }));
}

export async function setMonitorItems(env, items) {
  const normalized = normalizeMonitorItems(items);
  const current = await getMonitorItems(env);
  const changed = JSON.stringify(current) !== JSON.stringify(normalized);
  if (!changed) return { ok: true, changed: false, durable: Boolean(env.MONITOR_SCHEDULER) };
  const durable = await putSchedulerControlState(env, MONITOR_ITEMS_KEY, normalized);
  if (!durable?.ok) await kvPutJson(env, MONITOR_ITEMS_KEY, normalized);
  memoryPut(MONITOR_ITEMS_KEY, normalized, 15000);
  await syncMonitorScheduler(env, normalized);
  return {
    ok: true,
    changed: true,
    durable: Boolean(durable?.ok),
    mirrorPending: Boolean(durable?.mirrorPending)
  };
}

export async function upsertMonitorItem(env, item) {
  const { model, csc } = validateModelCsc(item.model, item.csc);
  const durable = await upsertSchedulerMonitorItem(env, { ...item, model, csc });
  if (durable?.ok && durable.item) {
    const items = normalizeMonitorItems(durable.items || []);
    memoryPut(MONITOR_ITEMS_KEY, items, 15000);
    return {
      ...durable.item,
      persistence: {
        ok: true,
        changed: Boolean(durable.changed),
        durable: true,
        mirrorPending: Boolean(durable.mirrorPending)
      }
    };
  }
  const items = await getMonitorItems(env);
  const existing = items.find((entry) => entry.model === model && entry.csc === csc);
  const assignLifecycle = (target) => {
    if (item.enabled !== undefined) target.enabled = item.enabled !== false;
    if (item.paused !== undefined) target.paused = item.paused === true;
    if (item.pauseReason !== undefined) target.pauseReason = String(item.pauseReason || "");
    if (item.prioritySource !== undefined) target.prioritySource = String(item.prioritySource || "manual");
    if (item.linkedFrom !== undefined) target.linkedFrom = String(item.linkedFrom || "");
    if (item.linkedRuleId !== undefined) target.linkedRuleId = String(item.linkedRuleId || "");
    if (item.linkedAt !== undefined) target.linkedAt = String(item.linkedAt || "");
    if (item.adminDecision !== undefined) target.adminDecision = String(item.adminDecision || "");
    if (item.resumeAt !== undefined) target.resumeAt = String(item.resumeAt || "");
    if (item.pausedAt !== undefined) target.pausedAt = String(item.pausedAt || "");
    if (item.pauseSource !== undefined) target.pauseSource = String(item.pauseSource || "");
    if (item.notifyAllowedUsers !== undefined) target.notifyAllowedUsers = item.notifyAllowedUsers !== false;
  };
  if (existing) {
    existing.name = item.name || existing.name || `${model} ${csc}`;
    if (item.priority) existing.priority = String(item.priority).toLowerCase();
    if (Number(item.intervalMinutes) > 0) existing.intervalMinutes = Number(item.intervalMinutes);
    assignLifecycle(existing);
  } else {
    const created = {
      model,
      csc,
      name: item.name || `${model} ${csc}`,
      priority: item.priority || "normal",
      enabled: item.enabled !== false && item.paused !== true,
      paused: item.paused === true || item.enabled === false,
      pauseReason: String(item.pauseReason || ""),
      prioritySource: String(item.prioritySource || "manual"),
      linkedFrom: String(item.linkedFrom || ""),
      linkedRuleId: String(item.linkedRuleId || ""),
      linkedAt: String(item.linkedAt || ""),
      adminDecision: String(item.adminDecision || ""),
      resumeAt: String(item.resumeAt || ""),
      pausedAt: String(item.pausedAt || ""),
      pauseSource: String(item.pauseSource || ""),
      notifyAllowedUsers: item.notifyAllowedUsers !== false,
      intervalMinutes: Number(item.intervalMinutes || 0)
    };
    items.push(created);
  }
  const persistence = await setMonitorItems(env, items);
  return {
    ...items.find((entry) => entry.model === model && entry.csc === csc),
    persistence
  };
}

export async function snoozeMonitorItem(env, model, csc, resumeAt, metadata = {}) {
  const result = await snoozeSchedulerMonitorItem(env, model, csc, resumeAt, metadata);
  if (result?.ok) memoryDelete(MONITOR_ITEMS_KEY);
  return result;
}

export async function cancelMonitorItemSnooze(env, model, csc) {
  const result = await cancelSchedulerMonitorSnooze(env, model, csc);
  if (result?.ok) memoryDelete(MONITOR_ITEMS_KEY);
  return result;
}

export async function removeMonitorItem(env, model, csc) {
  const { model: normalizedModel, csc: normalizedCsc } = validateModelCsc(model, csc);
  const durable = await removeSchedulerMonitorItem(env, normalizedModel, normalizedCsc);
  if (durable?.ok) {
    memoryPut(MONITOR_ITEMS_KEY, normalizeMonitorItems(durable.items || []), 15000);
    return Boolean(durable.removed);
  }
  const items = await getMonitorItems(env);
  const next = items.filter((item) => item.model !== normalizedModel || item.csc !== normalizedCsc);
  await setMonitorItems(env, next);
  return next.length !== items.length;
}

function normalizeMonitorEvent(event = {}) {
  const model = String(event.model || "").trim().toUpperCase();
  const csc = String(event.csc || "").trim().toUpperCase();
  if ((model && !csc) || (!model && csc)) throw new Error("监控事件的机型和 CSC 必须同时存在");
  if (model) validateModelCsc(model, csc);
  return {
    type: String(event.type || "monitor").slice(0, 48),
    model,
    csc,
    name: String(event.name || "").slice(0, 96),
    audience: String(event.audience || "").slice(0, 24),
    source: String(event.source || "Samsung SmartHistory").slice(0, 96),
    error: String(event.error || "").slice(0, 240),
    detail: String(event.detail || "").slice(0, 160),
    failureCount: Math.max(0, Math.min(99, Number(event.failureCount || 0))),
    retryAt: Number(event.retryAt || 0),
    at: String(event.at || new Date().toISOString())
  };
}

export async function getMonitorEvents(env, limit = 20) {
  const count = Math.max(1, Math.min(50, Number(limit) || 20));
  const durable = await getSchedulerMonitorEvents(env, count);
  const events = durable?.ok ? durable.events : await kvGetJson(env, MONITOR_EVENTS_KEY, []);
  return (Array.isArray(events) ? events : [])
    .map((event) => {
      try {
        return normalizeMonitorEvent(event);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, count);
}

export async function recordMonitorEvent(env, event) {
  const value = normalizeMonitorEvent(event);
  const durable = await appendSchedulerMonitorEvent(env, value);
  if (durable?.ok) return durable.event;
  const existing = await getMonitorEvents(env, 49);
  const events = [value, ...existing].slice(0, 50);
  await kvPutJson(env, MONITOR_EVENTS_KEY, events);
  return value;
}

// A short-lived, server-side confirmation prevents an accidental bulk delete
// without holding unrelated Telegram messages hostage.
const ADMIN_DELETE_ALL_CONFIRM_PREFIX = "admin:delete-all-confirm:";

function adminDeleteAllConfirmKey(chatId) {
  const id = String(chatId || "").trim();
  if (!/^-?\d{1,24}$/.test(id)) throw new Error("Invalid admin Chat ID");
  return `${ADMIN_DELETE_ALL_CONFIRM_PREFIX}${id}`;
}

export async function beginDeleteAllMonitorConfirmation(env, chatId) {
  const value = { requestedAt: new Date().toISOString() };
  await kvPutJson(env, adminDeleteAllConfirmKey(chatId), value, { expirationTtl: 10 * 60 });
  return value;
}

export async function getDeleteAllMonitorConfirmation(env, chatId) {
  return kvGetJson(env, adminDeleteAllConfirmKey(chatId), null);
}

export async function clearDeleteAllMonitorConfirmation(env, chatId) {
  const key = adminDeleteAllConfirmKey(chatId);
  memoryDelete(key);
  if (!env.FIRMWARE_KV) return false;
  await env.FIRMWARE_KV.delete(key);
  return true;
}

export async function putFlagshipProposal(env, proposal) {
  const id = String(proposal?.id || "").trim();
  const value = { ...proposal, id };
  await putControlStateOrLegacy(env, flagshipProposalKey(id), value);
  return value;
}

export async function getFlagshipProposal(env, proposalId) {
  return getControlStateWithLegacyMigration(env, flagshipProposalKey(proposalId), null);
}

export async function getMonitorLastCheck(env, model, csc) {
  const durable = await getSchedulerTargetState(env, model, csc);
  const timestamp = Date.parse(durable?.runtime?.lastCheckedAt || "");
  if (durable?.ok && durable.found) return Number.isFinite(timestamp) ? timestamp : 0;
  const value = await kvGetJson(env, monitorLastCheckKey(model, csc), null);
  const legacyTimestamp = Date.parse(value?.checkedAt || "");
  return Number.isFinite(legacyTimestamp) ? legacyTimestamp : 0;
}

export async function setMonitorLastCheck(env, model, csc, checkedAt = new Date()) {
  const date = checkedAt instanceof Date ? checkedAt : new Date(checkedAt);
  const durable = await patchSchedulerTargetState(env, model, csc, { lastCheckedAt: date.toISOString() });
  if (!durable?.ok) {
    await kvPutJson(env, monitorLastCheckKey(model, csc), { checkedAt: date.toISOString() }, { expirationTtl: 30 * 24 * 60 * 60 });
  }
  return { checkedAt: date.toISOString() };
}

function normalizeRuntime(value = {}) {
  const rawSequence = value?.lastSequence;
  return {
    lastAttemptAt: value?.lastAttemptAt || "",
    lastSuccessAt: value?.lastSuccessAt || "",
    nextAttemptAt: value?.nextAttemptAt || "",
    failureCount: Math.max(0, Number(value?.failureCount || 0)),
    lastError: String(value?.lastError || ""),
    errorClass: String(value?.errorClass || ""),
    forcedAt: value?.forcedAt || "",
    lastVersion: value?.lastVersion || "",
    lastVersionChangedAt: value?.lastVersionChangedAt || "",
    lastOfficialUpdateAt: value?.lastOfficialUpdateAt || "",
    lastPeerUpdateAt: value?.lastPeerUpdateAt || "",
    lastBuildDate: value?.lastBuildDate || "",
    lastSequence: rawSequence !== null && rawSequence !== undefined && rawSequence !== "" && Number.isFinite(Number(rawSequence))
      ? Number(rawSequence)
      : null,
    priorityScore: Math.max(0, Math.min(100, Number(value?.priorityScore || 0))),
    lastCheckedAt: value?.lastCheckedAt || "",
    nextCheckAt: value?.nextCheckAt || "",
    monitorMode: String(value?.monitorMode || "NORMAL"),
    modeUntil: value?.modeUntil || ""
  };
}

export async function getMonitorRuntime(env, model, csc) {
  const durable = await getSchedulerTargetState(env, model, csc);
  if (durable?.ok && durable.found) return normalizeRuntime(durable.runtime);
  return normalizeRuntime(await kvGetJson(env, monitorRuntimeKey(model, csc), null));
}

async function patchRuntimeOrLegacy(env, model, csc, patch, ttl = 30 * 24 * 60 * 60) {
  const durable = await patchSchedulerTargetState(env, model, csc, patch);
  if (durable?.ok) return normalizeRuntime(durable.runtime);
  const current = await getMonitorRuntime(env, model, csc);
  const value = normalizeRuntime({ ...current, ...patch });
  await kvPutJson(env, monitorRuntimeKey(model, csc), value, { expirationTtl: ttl });
  return value;
}

export async function recordMonitorSuccess(env, model, csc, checkedAt = new Date(), metadata = {}) {
  const date = checkedAt instanceof Date ? checkedAt : new Date(checkedAt);
  const current = await getMonitorRuntime(env, model, csc);
  const changedAt = metadata.versionChanged ? date.toISOString() : current.lastVersionChangedAt;
  const value = {
    ...current,
    lastAttemptAt: date.toISOString(),
    lastSuccessAt: date.toISOString(),
    lastCheckedAt: date.toISOString(),
    nextAttemptAt: "",
    failureCount: 0,
    lastError: "",
    errorClass: "",
    forcedAt: "",
    lastVersion: metadata.latest || current.lastVersion,
    lastVersionChangedAt: changedAt || current.lastVersionChangedAt,
    lastOfficialUpdateAt: metadata.officialUpdateAt || changedAt || current.lastOfficialUpdateAt,
    lastBuildDate: metadata.buildDate || current.lastBuildDate,
    lastSequence: Number.isFinite(Number(metadata.sequence)) ? Number(metadata.sequence) : current.lastSequence,
    priorityScore: Number.isFinite(Number(metadata.priorityScore))
      ? Math.max(0, Math.min(100, Number(metadata.priorityScore)))
      : current.priorityScore
  };
  return patchRuntimeOrLegacy(env, model, csc, value);
}

export async function recordMonitorFailure(env, model, csc, error, failedAt = new Date()) {
  const date = failedAt instanceof Date ? failedAt : new Date(failedAt);
  const current = await getMonitorRuntime(env, model, csc);
  const failureCount = current.failureCount + 1;
  const message = String(error?.message || error || "Unknown monitor error");
  const permanent = /(?:HTTP 403|HTTP 404|no matching CSC|no usable firmware|未找到|没有公开固件)/i.test(message);
  const base = monitorFailureRetryBaseSeconds(env);
  const max = monitorFailureRetryMaxSeconds(env);
  const retrySeconds = permanent
    ? monitorPermanentErrorRetrySeconds(env)
    : Math.min(max, base * (2 ** Math.min(6, failureCount - 1)));
  const value = await patchRuntimeOrLegacy(env, model, csc, {
    ...current,
    lastAttemptAt: date.toISOString(),
    lastCheckedAt: date.toISOString(),
    nextAttemptAt: new Date(date.getTime() + retrySeconds * 1000).toISOString(),
    failureCount,
    lastError: message.slice(0, 500),
    errorClass: permanent ? "permanent" : "transient",
    forcedAt: ""
  });
  return { ...value, retrySeconds };
}

export async function restoreMonitorOriginalPlan(env, model, csc, nextCheckAt = new Date()) {
  const date = nextCheckAt instanceof Date ? nextCheckAt : new Date(nextCheckAt);
  const durable = await patchSchedulerTargetState(env, model, csc, {
    monitorMode: "NORMAL",
    modeUntil: 0,
    nextAttemptAt: 0,
    nextCheckAt: date.toISOString()
  });
  if (durable?.ok) return normalizeRuntime(durable.runtime);
  return patchRuntimeOrLegacy(env, model, csc, {
    monitorMode: "NORMAL",
    modeUntil: "",
    nextAttemptAt: "",
    nextCheckAt: date.toISOString()
  });
}

export async function forceMonitorDue(env, model, csc, dueAt = new Date()) {
  const date = dueAt instanceof Date ? dueAt : new Date(dueAt);
  const current = await getMonitorRuntime(env, model, csc);
  await forceSchedulerTargetDue(env, model, csc, date);
  return patchRuntimeOrLegacy(env, model, csc, { ...current, nextAttemptAt: date.toISOString(), nextCheckAt: date.toISOString(), forcedAt: date.toISOString() });
}

export async function recordPeerFirmwareUpdate(env, model, csc, updatedAt = new Date()) {
  const date = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  const current = await getMonitorRuntime(env, model, csc);
  return patchRuntimeOrLegacy(env, model, csc, { ...current, lastPeerUpdateAt: date.toISOString() });
}

export async function recordMonitorPriorityScore(env, model, csc, priorityScore) {
  const current = await getMonitorRuntime(env, model, csc);
  return patchRuntimeOrLegacy(env, model, csc, {
    ...current,
    priorityScore: Math.max(0, Math.min(100, Math.round(Number(priorityScore) || 0)))
  });
}

export async function recordFirmwareQueryDemand(env, model, csc, queriedAt = new Date()) {
  const target = validateModelCsc(model, csc);
  const date = queriedAt instanceof Date ? queriedAt : new Date(queriedAt);
  const durable = await recordSchedulerQueryDemand(env, target.model, target.csc, date.getTime());
  if (durable?.ok) {
    return {
      count: Math.max(0, Number(durable.count || 0)),
      windowStartedAt: new Date(Number(durable.windowStartedAt || date.getTime())).toISOString(),
      updatedAt: new Date(Number(durable.updatedAt || date.getTime())).toISOString()
    };
  }
  const key = monitorDemandKey(target.model, target.csc);
  const current = fallbackQueryDemand.get(key) || null;
  const windowStart = Number(current?.windowStartedAt || 0);
  const activeWindow = windowStart > 0 && date.getTime() - windowStart < 24 * 60 * 60 * 1000;
  const value = {
    count: activeWindow ? Math.max(0, Number(current?.count || 0)) + 1 : 1,
    windowStartedAt: activeWindow ? windowStart : date.getTime(),
    updatedAt: date.getTime()
  };
  fallbackQueryDemand.set(key, value);
  return {
    count: value.count,
    windowStartedAt: new Date(value.windowStartedAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString()
  };
}

export async function getFirmwareQueryDemand(env, model, csc, now = new Date()) {
  const target = validateModelCsc(model, csc);
  const nowMs = new Date(now).getTime();
  const durable = await getSchedulerQueryDemand(env, target.model, target.csc, nowMs);
  const value = durable?.ok ? durable : fallbackQueryDemand.get(monitorDemandKey(target.model, target.csc));
  const windowStart = Number(value?.windowStartedAt || 0);
  if (!windowStart || nowMs - windowStart >= 24 * 60 * 60 * 1000) {
    return { count: 0, windowStartedAt: "", updatedAt: "" };
  }
  return {
    count: Math.max(0, Number(value?.count || 0)),
    windowStartedAt: new Date(windowStart).toISOString(),
    updatedAt: value?.updatedAt ? new Date(Number(value.updatedAt)).toISOString() : ""
  };
}

export async function getMonitorBoost(env, model, csc, now = new Date()) {
  const key = monitorBoostKey(model, csc);
  const value = await getControlStateWithLegacyMigration(env, key, null);
  if (!value?.until) return null;
  const until = Date.parse(value.until);
  if (!Number.isFinite(until) || until <= now.getTime()) {
    const durable = await deleteSchedulerControlState(env, key);
    if (!durable?.ok) await env.FIRMWARE_KV?.delete(key);
    return null;
  }
  return value;
}

export async function putMonitorBoost(env, model, csc, boost) {
  const until = new Date(boost.until);
  if (!Number.isFinite(until.getTime())) throw new Error("Invalid monitor boost expiry");
  const value = {
    ...boost,
    model: String(model || "").toUpperCase(),
    csc: String(csc || "").toUpperCase(),
    until: until.toISOString(),
    createdAt: boost.createdAt || new Date().toISOString()
  };
  await putControlStateOrLegacy(env, monitorBoostKey(model, csc), value);
  return value;
}

export async function getMonitorSchedule(env) {
  const fallback = defaultSchedule(env);
  const durable = await getSchedulerControlState(env, MONITOR_SCHEDULE_KEY);
  if (!durable?.ok) {
    const cached = memoryGet(MONITOR_SCHEDULE_KEY);
    if (cached) return { ...cached };
  }
  const stored = durable?.ok && durable.found
    ? durable.value
    : await kvGetJson(env, MONITOR_SCHEDULE_KEY, null);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    if (durable?.ok && !durable.found) {
      await putSchedulerControlState(env, MONITOR_SCHEDULE_KEY, fallback);
    }
    memoryPut(MONITOR_SCHEDULE_KEY, fallback, 15000);
    return { ...fallback };
  }

  const legacyDefaults = Number(stored.schemaVersion || 1) < 2
    && stored.startTime === "09:00"
    && stored.endTime === "23:59"
    && stored.skipWeekends === true;
  const value = {
    ...fallback,
    ...stored,
    schemaVersion: 2,
    ...(legacyDefaults ? {
      startTime: fallback.startTime,
      endTime: fallback.endTime,
      skipWeekends: fallback.skipWeekends
    } : {})
  };
  if (durable?.ok && !durable.found) {
    await putSchedulerControlState(env, MONITOR_SCHEDULE_KEY, value);
  }
  memoryPut(MONITOR_SCHEDULE_KEY, value, 15000);
  return { ...value };
}

export async function setMonitorSchedule(env, schedule) {
  const value = { ...schedule, schemaVersion: 2, updatedAt: new Date().toISOString() };
  const durable = await putSchedulerControlState(env, MONITOR_SCHEDULE_KEY, value);
  if (!durable?.ok) await kvPutJson(env, MONITOR_SCHEDULE_KEY, value);
  memoryPut(MONITOR_SCHEDULE_KEY, value, 15000);
  return value;
}

function normalizeMonitorSummarySettings(settings, fallback) {
  const hour = Number(settings?.hour);
  return {
    ...fallback,
    ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
    schemaVersion: 1,
    enabled: settings?.enabled === undefined ? fallback.enabled : settings.enabled !== false,
    hour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? Math.floor(hour) : fallback.hour,
    updatedAt: String(settings?.updatedAt || fallback.updatedAt || new Date().toISOString()),
    updatedBy: String(settings?.updatedBy || "")
  };
}

export async function getMonitorSummarySettings(env) {
  const fallback = defaultDailyMonitorSummarySettings(env);
  const cached = memoryGet(MONITOR_SUMMARY_SETTINGS_KEY);
  if (cached) return { ...cached };
  const durable = await getSchedulerControlState(env, MONITOR_SUMMARY_SETTINGS_KEY);
  const stored = durable?.ok && durable.found
    ? durable.value
    : await kvGetJson(env, MONITOR_SUMMARY_SETTINGS_KEY, null);
  const value = normalizeMonitorSummarySettings(stored, fallback);
  if (durable?.ok && !durable.found) {
    await putSchedulerControlState(env, MONITOR_SUMMARY_SETTINGS_KEY, value);
  }
  memoryPut(MONITOR_SUMMARY_SETTINGS_KEY, value, 15000);
  return { ...value };
}

export async function setMonitorSummarySettings(env, settings, updatedBy = "") {
  const fallback = defaultDailyMonitorSummarySettings(env);
  const value = normalizeMonitorSummarySettings({
    ...settings,
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || "")
  }, fallback);
  const durable = await putSchedulerControlState(env, MONITOR_SUMMARY_SETTINGS_KEY, value);
  if (!durable?.ok) await kvPutJson(env, MONITOR_SUMMARY_SETTINGS_KEY, value);
  memoryPut(MONITOR_SUMMARY_SETTINGS_KEY, value, 15000);
  return value;
}

export async function getUserQueryCache(env, chatId, model, csc) {
  return kvGetJson(env, buildUserQueryCacheKey(chatId, model, csc), null);
}

export async function getGlobalQueryCache(env, model, csc) {
  return kvGetJson(env, globalQueryCacheKey(model, csc), null);
}

export async function getFirmwareQueryCache(env, model, csc) {
  return kvGetJson(env, firmwareQueryCacheKey(model, csc), null);
}

export async function setFirmwareQueryCache(env, model, csc, value) {
  if (!value?.latest) return false;
  return kvPutJson(env, firmwareQueryCacheKey(model, csc), value, {
    expirationTtl: firmwareCacheStaleSeconds(env)
  });
}

export async function deleteFirmwareQueryCache(env, model, csc) {
  if (!env.FIRMWARE_KV) return false;
  await env.FIRMWARE_KV.delete(firmwareQueryCacheKey(model, csc));
  return true;
}

export async function setGlobalQueryCache(env, model, csc, result, ttlOverride = null) {
  if (!result?.latest) return false;
  const ttl = ttlOverride || globalQueryCacheTtlSeconds(env);
  return kvPutJson(env, globalQueryCacheKey(model, csc), result, { expirationTtl: ttl });
}

export async function getCacheSettings(env) {
  const cached = memoryGet(CACHE_SETTINGS_KEY);
  if (cached) return { ...cached };
  const fallback = defaultCacheSettings(env);
  const stored = await getControlStateWithLegacyMigration(env, CACHE_SETTINGS_KEY, null);
  const storedSchemaVersion = Number(stored?.schemaVersion || 1);
  const needsSpeedDefaultsMigration = storedSchemaVersion < 3;
  const value = {
    ...fallback,
    ...(stored || {}),
    enabled: stored?.enabled ?? fallback.enabled,
    schemaVersion: 4,
    adminRealtimeEnabled: needsSpeedDefaultsMigration
      ? fallback.adminRealtimeEnabled
      : (stored?.adminRealtimeEnabled ?? fallback.adminRealtimeEnabled)
  };
  delete value.userEnabled;
  delete value.globalEnabled;
  delete value.staleGuardEnabled;
  delete value.userTtlSeconds;
  delete value.globalTtlSeconds;
  memoryPut(CACHE_SETTINGS_KEY, value, 30000);
  return { ...value };
}

export async function setCacheSettings(env, settings, updatedBy = "") {
  const base = await getCacheSettings(env);
  const value = {
    ...base,
    ...settings,
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || "")
  };
  await putControlStateOrLegacy(env, CACHE_SETTINGS_KEY, value);
  return value;
}

export async function setUserQueryCache(env, chatId, model, csc, result, ttlOverride = null) {
  if (!result?.latest) return false;
  const ttl = ttlOverride || queryCacheTtlSeconds(env);
  return kvPutJson(env, buildUserQueryCacheKey(chatId, model, csc), result, { expirationTtl: ttl });
}

export async function deleteUserQueryCache(env, chatId, model, csc) {
  if (!env.FIRMWARE_KV) return false;
  await env.FIRMWARE_KV.delete(buildUserQueryCacheKey(chatId, model, csc));
  return true;
}

export async function deleteGlobalQueryCache(env, model, csc) {
  if (!env.FIRMWARE_KV) return false;
  await env.FIRMWARE_KV.delete(globalQueryCacheKey(model, csc));
  return true;
}

export async function clearQueryCachePrefix(env, prefix, limit = 100) {
  if (!env.FIRMWARE_KV) return 0;
  let deleted = 0;
  let cursor;
  do {
    const page = await env.FIRMWARE_KV.list({ prefix, cursor });
    for (const key of page.keys || []) {
      if (deleted >= limit) return deleted;
      await env.FIRMWARE_KV.delete(key.name);
      deleted += 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && deleted < limit);
  return deleted;
}

export async function tryStartQueryRateLimit(env, chatId) {
  const seconds = queryRateLimitSeconds(env);
  const now = Date.now();
  const durable = await claimSchedulerQueryRateLimit(env, chatId, seconds, now);
  if (durable?.ok) return durable.allowed !== false;
  const key = queryRateLimitKey(chatId);
  const existing = Number(fallbackQueryRates.get(key) || 0);
  if (existing && now - existing < seconds * 1000) return false;
  fallbackQueryRates.set(key, now);
  return true;
}

export async function tryClaimAllowedUserDailyModelQuery(env, chatId, model, dateKey) {
  const limit = allowedUserDailyModelQueryLimit(env);
  const now = Date.now();
  const durable = await claimSchedulerDailyModelQuery(env, chatId, model, dateKey, limit, now);
  if (durable?.ok) return durable;
  const key = `${dateKey}:${String(chatId)}:${String(model).toUpperCase()}`;
  const current = Number(fallbackDailyModelQuotas.get(key) || 0);
  if (current >= limit) return { ok: true, allowed: false, count: current, limit, remaining: 0, fallback: true };
  const count = current + 1;
  fallbackDailyModelQuotas.set(key, count);
  return { ok: true, allowed: true, count, limit, remaining: Math.max(0, limit - count), fallback: true };
}

export async function claimMonitorCronSlot(env, slot, now = Date.now()) {
  return claimSchedulerCronSlot(env, slot, now);
}

export async function putPendingUpdate(env, pending) {
  const key = pendingUpdateKey(pending.model, pending.csc);
  await kvPutJson(env, key, pending, { expirationTtl: 3 * 24 * 60 * 60 });
  return key;
}

export async function listPendingUpdates(env) {
  const pending = await listJsonByPrefix(env, "pending:update:");
  return pending.filter((entry) => !entry.value.acked);
}

export async function getPendingUpdate(env, model, csc) {
  return kvGetJson(env, pendingUpdateKey(model, csc), null);
}

export async function deletePendingUpdate(env, model, csc) {
  if (!env.FIRMWARE_KV) return false;
  const key = pendingUpdateKey(model, csc);
  const existing = await env.FIRMWARE_KV.get(key);
  if (!existing) return false;
  await env.FIRMWARE_KV.delete(key);
  return true;
}

export async function deleteAllPendingUpdates(env) {
  const pending = await listPendingUpdates(env);
  await Promise.all(pending.map((entry) => env.FIRMWARE_KV.delete(entry.key)));
  return pending.length;
}

export async function putAckedUpdate(env, pending, chatId = "") {
  const model = String(pending?.model || "").toUpperCase();
  const csc = String(pending?.csc || "").toUpperCase();
  const latest = String(pending?.newLatest || pending?.latest || "").trim();
  if (!model || !csc || !latest) return false;
  const value = {
    model,
    csc,
    latest,
    versionFingerprint: firmwareVersionFingerprint(latest),
    ackedAt: new Date().toISOString(),
    ackedBy: String(chatId || "")
  };
  const result = await putControlStateOrLegacy(env, ackedUpdateKey(model, csc), value);
  return Boolean(result?.ok);
}

export async function getAckedUpdate(env, model, csc) {
  return getControlStateWithLegacyMigration(env, ackedUpdateKey(model, csc), null);
}

export function adminIdForMessages(env) {
  return adminChatId(env);
}
