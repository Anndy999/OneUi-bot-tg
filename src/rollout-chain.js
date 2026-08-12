import { validateModelCsc } from "./targets.js";
import { beijingParts, normalizeClockTime, timeToMinutes } from "./utils.js";
import { randomId } from "./runtime/random-id.js";
import {
  cancelMonitorItemSnooze,
  getRolloutChainsState,
  getRolloutProposal,
  putRolloutProposal,
  recordMonitorEvent,
  setRolloutChainsState,
  snoozeMonitorItem,
  upsertMonitorItem
} from "./state.js";

const STAGES = [
  { id: "kr", name: "韩版" },
  { id: "eu", name: "欧版" },
  { id: "hk", name: "港版" },
  { id: "cn", name: "国行" }
];

// Exact retail targets verified from Samsung's public product/support pages.
// The rollout chains remain disabled until an administrator enables them.
const OFFICIAL_PRESET_VERSION = 1;
const OFFICIAL_TARGETS = {
  s26: {
    kr: [
      { model: "SM-S942N", csc: "KOO", name: "Galaxy S26" },
      { model: "SM-S947N", csc: "KOO", name: "Galaxy S26+" },
      { model: "SM-S948N", csc: "KOO", name: "Galaxy S26 Ultra" }
    ],
    eu: [
      { model: "SM-S942B", csc: "EUX", name: "Galaxy S26" },
      { model: "SM-S947B", csc: "EUX", name: "Galaxy S26+" },
      { model: "SM-S948B", csc: "EUX", name: "Galaxy S26 Ultra" }
    ],
    hk: [
      { model: "SM-S9420", csc: "TGY", name: "Galaxy S26" },
      { model: "SM-S9470", csc: "TGY", name: "Galaxy S26+" },
      { model: "SM-S9480", csc: "TGY", name: "Galaxy S26 Ultra" }
    ],
    cn: [
      { model: "SM-S9420", csc: "CHC", name: "Galaxy S26" },
      { model: "SM-S9470", csc: "CHC", name: "Galaxy S26+" },
      { model: "SM-S9480", csc: "CHC", name: "Galaxy S26 Ultra" }
    ]
  },
  s25: {
    kr: [
      { model: "SM-S931N", csc: "KOO", name: "Galaxy S25" },
      { model: "SM-S936N", csc: "KOO", name: "Galaxy S25+" },
      { model: "SM-S937N", csc: "KOO", name: "Galaxy S25 Edge" },
      { model: "SM-S938N", csc: "KOO", name: "Galaxy S25 Ultra" }
    ],
    eu: [
      { model: "SM-S931B", csc: "EUX", name: "Galaxy S25" },
      { model: "SM-S936B", csc: "EUX", name: "Galaxy S25+" },
      { model: "SM-S937B", csc: "EUX", name: "Galaxy S25 Edge" },
      { model: "SM-S938B", csc: "EUX", name: "Galaxy S25 Ultra" }
    ],
    hk: [
      { model: "SM-S9310", csc: "TGY", name: "Galaxy S25" },
      { model: "SM-S9360", csc: "TGY", name: "Galaxy S25+" },
      { model: "SM-S9370", csc: "TGY", name: "Galaxy S25 Edge" },
      { model: "SM-S9380", csc: "TGY", name: "Galaxy S25 Ultra" }
    ],
    cn: [
      { model: "SM-S9310", csc: "CHC", name: "Galaxy S25" },
      { model: "SM-S9360", csc: "CHC", name: "Galaxy S25+" },
      { model: "SM-S9370", csc: "CHC", name: "Galaxy S25 Edge" },
      { model: "SM-S9380", csc: "CHC", name: "Galaxy S25 Ultra" }
    ]
  }
};

function officialStageFallback(chainId, stage) {
  return { ...stage, targets: OFFICIAL_TARGETS[chainId]?.[stage.id] || [] };
}

const DEFAULT_CHAINS = [
  { id: "s26", name: "26 系列", startChainOnFirstStage: "s25" },
  { id: "s25", name: "25 系列", startChainOnFirstStage: "" }
];
let cachedChains = null;
let cachedChainsExpiresAt = 0;
let cachedEnv = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, max = 64) {
  return String(value || "").trim().slice(0, max);
}

function normalizeTarget(value = {}) {
  const target = validateModelCsc(value.model, value.csc);
  return {
    model: target.model,
    csc: target.csc,
    name: cleanText(value.name || `${target.model} ${target.csc}`, 64) || `${target.model} ${target.csc}`
  };
}

function normalizeStage(raw = {}, fallback) {
  const seen = new Set();
  const targets = (Array.isArray(raw.targets) ? raw.targets : [])
    .map((target) => {
      try { return normalizeTarget(target); } catch { return null; }
    })
    .filter((target) => {
      if (!target) return false;
      const key = `${target.model}:${target.csc}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    id: fallback.id,
    name: cleanText(raw.name || fallback.name, 24) || fallback.name,
    targets
  };
}

function normalizeChain(raw = {}, fallback) {
  const stagesById = new Map((Array.isArray(raw.stages) ? raw.stages : []).map((stage) => [String(stage?.id || "").trim(), stage]));
  const stages = STAGES.map((stage) => {
    const fallbackStage = officialStageFallback(fallback.id, stage);
    return normalizeStage(stagesById.get(stage.id) || fallbackStage, fallbackStage);
  });
  const activeStageId = stages.some((stage) => stage.id === raw.activeStageId)
    ? raw.activeStageId
    : stages[0].id;
  const intervalMinutes = Number(raw.intervalMinutes || 15);
  return {
    id: fallback.id,
    name: cleanText(raw.name || fallback.name, 32) || fallback.name,
    enabled: raw.enabled === true,
    status: ["active", "awaiting_confirmation", "completed", "needs_configuration"].includes(raw.status)
      ? raw.status
      : "needs_configuration",
    activeStageId,
    intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes >= 5 && intervalMinutes <= 1440
      ? Math.floor(intervalMinutes)
      : 15,
    startTime: normalizeClockTime(raw.startTime || "08:00") || "08:00",
    endTime: normalizeClockTime(raw.endTime || "23:00") || "23:00",
    // Release-chain monitoring normally continues on weekends. The owner can
    // opt in to this narrow pause without changing ordinary monitor targets.
    skipWeekends: raw.skipWeekends === true,
    startChainOnFirstStage: fallback.startChainOnFirstStage,
    pendingProposalId: cleanText(raw.pendingProposalId, 64),
    updatedAt: cleanText(raw.updatedAt, 40),
    stages
  };
}

export function defaultRolloutChains() {
  return {
    schemaVersion: 2,
    officialPresetVersion: OFFICIAL_PRESET_VERSION,
    chains: DEFAULT_CHAINS.map((chain) => normalizeChain({}, chain)),
    updatedAt: new Date().toISOString()
  };
}

export function normalizeRolloutChains(value) {
  const rawChains = Array.isArray(value?.chains) ? value.chains : [];
  const hasConfiguredTargets = rawChains.some((chain) =>
    Array.isArray(chain?.stages) && chain.stages.some((stage) => Array.isArray(stage?.targets) && stage.targets.length > 0)
  );
  // Older releases persisted four empty stages. Seed only that untouched state
  // once; an intentionally empty configuration remains untouched afterwards.
  const seedOfficialTargets = !hasConfiguredTargets && !Number(value?.officialPresetVersion);
  const byId = new Map((seedOfficialTargets ? [] : rawChains).map((chain) => [String(chain?.id || "").trim(), chain]));
  return {
    schemaVersion: 2,
    officialPresetVersion: Number(value?.officialPresetVersion) || OFFICIAL_PRESET_VERSION,
    chains: DEFAULT_CHAINS.map((fallback) => normalizeChain(byId.get(fallback.id) || {}, fallback)),
    updatedAt: cleanText(value?.updatedAt, 40) || new Date().toISOString()
  };
}

export async function getRolloutChains(env) {
  if (cachedEnv === env && cachedChains && cachedChainsExpiresAt > Date.now()) return clone(cachedChains);
  const stored = await getRolloutChainsState(env);
  const value = normalizeRolloutChains(stored || defaultRolloutChains());
  if (!stored) await setRolloutChainsState(env, value);
  cachedChains = value;
  cachedEnv = env;
  cachedChainsExpiresAt = Date.now() + 15_000;
  return clone(value);
}

async function saveChains(env, value) {
  const normalized = normalizeRolloutChains({ ...value, updatedAt: new Date().toISOString() });
  await setRolloutChainsState(env, normalized);
  cachedChains = normalized;
  cachedEnv = env;
  cachedChainsExpiresAt = Date.now() + 15_000;
  return clone(normalized);
}

function findChain(chains, chainId) {
  const id = String(chainId || "").trim().toLowerCase();
  return chains.chains.find((chain) => chain.id === id) || null;
}

function findStage(chain, stageId) {
  const id = String(stageId || "").trim().toLowerCase();
  return chain?.stages.find((stage) => stage.id === id) || null;
}

function nextStage(chain, stageId) {
  const index = chain.stages.findIndex((stage) => stage.id === stageId);
  return index >= 0 ? chain.stages[index + 1] || null : null;
}

function parentChainFor(chains, chainId) {
  return chains.chains.find((candidate) => candidate.startChainOnFirstStage === chainId) || null;
}

function isDependentChain(chains, chain) {
  return Boolean(parentChainFor(chains, chain?.id));
}

export async function addRolloutTarget(env, chainId, stageId, target) {
  const chains = await getRolloutChains(env);
  const chain = findChain(chains, chainId);
  const stage = findStage(chain, stageId);
  if (!chain || !stage) throw new Error("发布链或地区不存在");
  const normalized = normalizeTarget(target);
  const key = `${normalized.model}:${normalized.csc}`;
  const existsInAnotherStage = chain.stages.some((candidate) => candidate.id !== stage.id && candidate.targets.some((item) => `${item.model}:${item.csc}` === key));
  if (existsInAnotherStage) throw new Error("同一 Model / CSC 不能同时属于两个地区阶段");
  const existing = stage.targets.find((item) => `${item.model}:${item.csc}` === key);
  if (existing) existing.name = normalized.name || existing.name;
  else stage.targets.push(normalized);
  chain.status = chain.enabled ? "active" : "needs_configuration";
  const active = chain.activeStageId === stage.id && chain.enabled;
  await upsertMonitorItem(env, {
    ...normalized,
    enabled: active,
    paused: !active,
    pauseReason: active ? "" : "rollout_waiting",
    priority: "high",
    intervalMinutes: chain.intervalMinutes,
    rolloutChainId: chain.id,
    rolloutStageId: stage.id,
    notifyAllowedUsers: true
  });
  return saveChains(env, chains);
}

export async function setRolloutChainSettings(env, chainId, patch = {}) {
  const chains = await getRolloutChains(env);
  const chain = findChain(chains, chainId);
  if (!chain) throw new Error("发布链不存在");
  if (patch.intervalMinutes !== undefined) {
    const interval = Number(patch.intervalMinutes);
    if (!Number.isFinite(interval) || interval < 5 || interval > 1440) throw new Error("检查间隔需在 5 到 1440 分钟之间");
    chain.intervalMinutes = Math.floor(interval);
  }
  if (patch.startTime !== undefined) {
    const time = normalizeClockTime(patch.startTime);
    if (!time) throw new Error("开始时间无效");
    chain.startTime = time;
  }
  if (patch.endTime !== undefined) {
    const time = normalizeClockTime(patch.endTime);
    if (!time) throw new Error("结束时间无效");
    chain.endTime = time;
  }
  if (patch.skipWeekends !== undefined) {
    chain.skipWeekends = patch.skipWeekends === true;
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled === true && isDependentChain(chains, chain) && patch.allowDependentStart !== true) {
      const parent = parentChainFor(chains, chain.id);
      throw new Error(`${chain.name} 会在 ${parent?.name || "上级发布链"} 韩版确认后自动启动，不能手动提前启用`);
    }
    const activeStage = findStage(chain, chain.activeStageId);
    if (patch.enabled && !activeStage?.targets.length) throw new Error("请先为当前地区添加至少一个精确 Model / CSC");
    chain.enabled = patch.enabled === true;
    chain.status = chain.enabled ? "active" : "needs_configuration";
    for (const stage of chain.stages) {
      for (const target of stage.targets) {
        const active = chain.enabled && stage.id === chain.activeStageId;
        await upsertMonitorItem(env, {
          ...target,
          enabled: active,
          paused: !active,
          pauseReason: active ? "" : "rollout_waiting",
          priority: "high",
          intervalMinutes: chain.intervalMinutes,
          rolloutChainId: chain.id,
          rolloutStageId: stage.id
        });
      }
    }
  }
  for (const stage of chain.stages) {
    for (const target of stage.targets) {
      await upsertMonitorItem(env, { ...target, intervalMinutes: chain.intervalMinutes, rolloutChainId: chain.id, rolloutStageId: stage.id });
    }
  }
  return saveChains(env, chains);
}

// This is deliberately separate from the normal enable setting. The Telegram
// handler exposes it to the owner only as a recovery action; administrators
// cannot start a dependent chain ahead of its parent rollout.
export async function restartDependentRolloutChain(env, chainId) {
  const chains = await getRolloutChains(env);
  const chain = findChain(chains, chainId);
  if (!chain || !isDependentChain(chains, chain)) throw new Error("该发布链不是可重新启动的从属链");
  const firstStage = chain.stages[0];
  if (!firstStage?.targets.length) throw new Error("请先为从属链韩版添加至少一个精确 Model / CSC");
  chain.activeStageId = firstStage.id;
  chain.pendingProposalId = "";
  chain.status = "active";
  chain.enabled = true;
  await activateOnlyStage(env, chain, firstStage);
  return saveChains(env, chains);
}

export async function setRolloutChainStage(env, chainId, stageId) {
  const chains = await getRolloutChains(env);
  const chain = findChain(chains, chainId);
  const stage = findStage(chain, stageId);
  if (!chain || !stage) throw new Error("发布链或地区不存在");
  if (!stage.targets.length) throw new Error("请先为该地区添加至少一个精确 Model / CSC");
  await activateOnlyStage(env, chain, stage);
  chain.activeStageId = stage.id;
  chain.status = chain.enabled ? "active" : "needs_configuration";
  chain.pendingProposalId = "";
  return saveChains(env, chains);
}

function nextBeijingMonthStart(now = new Date()) {
  const parts = beijingParts(now);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month), 1, -8, 0, 0));
}

export async function createRolloutProposalForUpdate(env, item, parsed, now = new Date()) {
  const chainId = cleanText(item.rolloutChainId, 48);
  const stageId = cleanText(item.rolloutStageId, 48);
  if (!chainId || !stageId) return null;
  const chains = await getRolloutChains(env);
  const chain = findChain(chains, chainId);
  if (!chain || !chain.enabled || chain.status === "completed" || chain.activeStageId !== stageId) return null;
  // A second model in the same region may finish its query while the first
  // model is waiting for confirmation. Suppress its duplicate public update
  // notification and keep exactly one proposal for the region.
  if (chain.pendingProposalId || chain.status === "awaiting_confirmation") {
    return { proposal: null, suppressUpdate: true, chain, stage: findStage(chain, stageId) };
  }
  const stage = findStage(chain, stageId);
  const configured = stage?.targets.some((target) => target.model === item.model && target.csc === item.csc);
  if (!configured) return null;
  const next = nextStage(chain, stageId);
  const startChain = stageId === chain.stages[0].id ? findChain(chains, chain.startChainOnFirstStage) : null;
  // Keep the detected update actionable even when the next stage has not
  // been configured yet. The confirmation card remains valid after an
  // administrator adds the missing exact Model / CSC targets.
  const id = randomId().replace(/-/g, "").slice(0, 16);
  const proposal = {
    id,
    type: "rollout_advance",
    status: "pending",
    chainId: chain.id,
    chainName: chain.name,
    stageId: stage.id,
    stageName: stage.name,
    nextStageId: next?.id || "",
    nextStageName: next?.name || "",
    startChainId: startChain?.id || "",
    startChainName: startChain?.name || "",
    source: { model: item.model, csc: item.csc, name: item.name || `${item.model} ${item.csc}`, version: String(parsed.latest || "") },
    createdAt: now.toISOString(),
    decidedAt: "",
    decidedBy: "",
    decision: ""
  };
  chain.pendingProposalId = id;
  chain.status = "awaiting_confirmation";
  await putRolloutProposal(env, proposal);
  await saveChains(env, chains);
  // Pause the whole active region as soon as the first official update is
  // detected. This prevents another model from producing duplicate pushes
  // while the owner/admin confirmation is pending. The approve path keeps the
  // pause; the skip path explicitly reactivates the stage.
  const resumeAt = nextBeijingMonthStart(now);
  for (const target of stage.targets) {
    await snoozeMonitorItem(env, target.model, target.csc, resumeAt, {
      updateVersion: proposal.source.version,
      reason: "rollout_pending_confirmation"
    }).catch(() => {});
    await upsertMonitorItem(env, {
      ...target,
      enabled: false,
      paused: true,
      pauseReason: "rollout_pending_confirmation",
      resumeAt: resumeAt.toISOString(),
      pauseSource: "rollout_chain",
      priority: "high",
      intervalMinutes: chain.intervalMinutes,
      rolloutChainId: chain.id,
      rolloutStageId: stage.id
    }).catch(() => {});
  }
  return { proposal, chain, stage, next, startChain };
}

function beijingDateAt(parts, clockTime, dayOffset = 0) {
  const minutes = timeToMinutes(clockTime);
  if (minutes === null) return 0;
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) + dayOffset,
    Math.floor(minutes / 60) - 8,
    minutes % 60,
    0,
    0
  );
}

function nextRolloutWindowStart(chain, now, parts = beijingParts(now)) {
  const nowMs = now.getTime();
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const candidate = beijingDateAt(parts, chain.startTime, dayOffset);
    if (!candidate || candidate <= nowMs) continue;
    const weekday = beijingParts(new Date(candidate)).weekday;
    if (!chain.skipWeekends || (weekday !== "Sat" && weekday !== "Sun")) return candidate;
  }
  return nowMs + 24 * 60 * 60 * 1000;
}

export async function getRolloutItemScheduleDecision(env, item, now = new Date()) {
  const chainId = cleanText(item?.rolloutChainId, 48);
  const stageId = cleanText(item?.rolloutStageId, 48);
  if (!chainId || !stageId) return { allowed: true, reason: "not_rollout" };
  const chains = await getRolloutChains(env);
  const chain = findChain(chains, chainId);
  if (!chain || !chain.enabled) return { allowed: false, reason: "chain_inactive" };
  // A finished region may resume at the next month boundary. It then returns
  // to ordinary monitoring without moving the rollout chain backward.
  if (chain.activeStageId !== stageId || chain.status !== "active") {
    return { allowed: item.enabled !== false, reason: item.enabled !== false ? "inactive_stage" : "stage_paused" };
  }
  const parts = beijingParts(now);
  if (chain.skipWeekends && (parts.weekday === "Sat" || parts.weekday === "Sun")) {
    return { allowed: false, reason: "weekend", nextCheckAt: nextRolloutWindowStart(chain, now, parts) };
  }
  const current = Number(parts.hour) * 60 + Number(parts.minute);
  const start = timeToMinutes(chain.startTime);
  const end = timeToMinutes(chain.endTime);
  if (start === null || end === null) return { allowed: false, reason: "invalid_schedule" };
  const allowed = start <= end ? current >= start && current <= end : current >= start || current <= end;
  return allowed
    ? { allowed: true, reason: "within_window" }
    : { allowed: false, reason: "outside_window", nextCheckAt: nextRolloutWindowStart(chain, now, parts) };
}

export async function isRolloutItemWithinSchedule(env, item, now = new Date()) {
  return (await getRolloutItemScheduleDecision(env, item, now)).allowed;
}

export function rolloutProposalText(proposal, lang = "zh") {
  const next = proposal.nextStageName || (lang === "en" ? "complete this chain" : "完成本系列本轮监控");
  const extra = proposal.startChainName
    ? (lang === "en" ? `Also start: ${proposal.startChainName} Korea` : `同时启动：${proposal.startChainName} 韩版`)
    : "";
  if (lang === "en") {
    return [
      "📣 Rollout update detected",
      "",
      `${proposal.chainName} · ${proposal.stageName}`,
      `${proposal.source.model} · ${proposal.source.csc}`,
      `Version: ${proposal.source.version}`,
      "",
      `Next: ${next}`,
      extra,
      "",
      "Any configured model in this region can trigger this step.",
      "Confirm to pause this region until next month and advance the rollout."
    ].filter(Boolean).join("\n");
  }
  return [
    "📣 发布链发现新固件",
    "",
    `${proposal.chainName} · ${proposal.stageName}`,
    `${proposal.source.model} · ${proposal.source.csc}`,
    `版本：${proposal.source.version}`,
    "",
    `下一步：${next}`,
    extra,
    "",
    "本地区任意预设机型发现新版本即可触发。",
    "确认后将暂停当前地区至下月初，并推进发布链。"
  ].filter(Boolean).join("\n");
}

export function rolloutProposalKeyboard(proposal, lang = "zh") {
  return {
    inline_keyboard: [
      [
        { text: lang === "en" ? "Confirm advance" : "确认切换", callback_data: `rollout:approve:${proposal.id}` },
        { text: lang === "en" ? "Keep current region" : "不推进，保持当前地区", callback_data: `rollout:skip:${proposal.id}` }
      ],
      [{ text: lang === "en" ? "View rollout" : "查看发布链", callback_data: `admin:rollout:${proposal.chainId}` }]
    ]
  };
}

async function activateStage(env, chain, stage) {
  for (const target of stage.targets) {
    await cancelMonitorItemSnooze(env, target.model, target.csc);
    await upsertMonitorItem(env, {
      ...target,
      enabled: true,
      paused: false,
      pauseReason: "",
      priority: "high",
      intervalMinutes: chain.intervalMinutes,
      rolloutChainId: chain.id,
      rolloutStageId: stage.id
    });
  }
}

async function activateOnlyStage(env, chain, stage) {
  for (const candidate of chain.stages) {
    for (const target of candidate.targets) {
      const active = candidate.id === stage.id && chain.enabled;
      // An owner correction or dependent-chain recovery supersedes every older
      // timed pause. Otherwise an old stage could resume alongside the new one.
      await cancelMonitorItemSnooze(env, target.model, target.csc);
      await upsertMonitorItem(env, {
        ...target,
        enabled: active,
        paused: !active,
        pauseReason: active ? "" : "rollout_waiting",
        priority: "high",
        intervalMinutes: chain.intervalMinutes,
        rolloutChainId: chain.id,
        rolloutStageId: candidate.id
      });
    }
  }
}

export async function applyRolloutProposalDecision(env, proposalId, decision, decidedBy = "") {
  const proposal = await getRolloutProposal(env, proposalId);
  if (!proposal) return { ok: false, reason: "missing" };
  if (proposal.status !== "pending") return { ok: false, reason: "already_decided", proposal };
  const chains = await getRolloutChains(env);
  const chain = findChain(chains, proposal.chainId);
  const stage = findStage(chain, proposal.stageId);
  if (!chain || !stage || chain.pendingProposalId !== proposal.id) return { ok: false, reason: "stale", proposal };
  if (decision === "skip") {
    proposal.status = "decided";
    proposal.decision = "skip";
    proposal.decidedAt = new Date().toISOString();
    proposal.decidedBy = String(decidedBy || "");
    chain.pendingProposalId = "";
    chain.status = "active";
    await activateStage(env, chain, stage);
    await putRolloutProposal(env, proposal);
    await saveChains(env, chains);
    return { ok: true, decision: "skip", proposal, chain };
  }
  if (decision !== "approve") return { ok: false, reason: "invalid_decision", proposal };
  const next = proposal.nextStageId ? findStage(chain, proposal.nextStageId) : null;
  const starter = proposal.startChainId ? findChain(chains, proposal.startChainId) : null;
  if (next && !next.targets.length) return { ok: false, reason: "next_stage_unconfigured", proposal };
  if (starter && !findStage(starter, starter.activeStageId)?.targets.length) return { ok: false, reason: "starter_chain_unconfigured", proposal };
  const resumeAt = nextBeijingMonthStart(new Date());
  for (const target of stage.targets) {
    const paused = await snoozeMonitorItem(env, target.model, target.csc, resumeAt, {
      requestedBy: String(decidedBy || ""),
      updateVersion: proposal.source.version,
      reason: "rollout_release_pause"
    });
    // The local monitor item is also updated below. A missing scheduler
    // binding is therefore a safe compatibility fallback; an explicit
    // scheduler rejection still aborts the transition.
    if (paused && !paused.ok) return { ok: false, reason: "pause_failed", proposal };
  }
  if (next) {
    await activateStage(env, chain, next);
    chain.activeStageId = next.id;
    chain.status = "active";
  } else {
    chain.status = "completed";
  }
  if (starter) {
    const starterStage = starter.stages[0];
    starter.enabled = true;
    starter.status = "active";
    starter.activeStageId = starterStage.id;
    starter.pendingProposalId = "";
    await activateOnlyStage(env, starter, starterStage);
  }
  chain.pendingProposalId = "";
  proposal.status = "decided";
  proposal.decision = "approve";
  proposal.decidedAt = new Date().toISOString();
  proposal.decidedBy = String(decidedBy || "");
  await putRolloutProposal(env, proposal);
  await saveChains(env, chains);
  await recordMonitorEvent(env, {
    type: "rollout_advanced",
    model: proposal.source.model,
    csc: proposal.source.csc,
    name: proposal.chainName,
    detail: `${proposal.stageName} -> ${proposal.nextStageName || "completed"}`,
    at: proposal.decidedAt
  });
  return { ok: true, decision: "approve", proposal, chain, next, starter, resumeAt };
}

export function rolloutChainPanelText(chain, lang = "zh") {
  const current = findStage(chain, chain.activeStageId);
  const next = nextStage(chain, chain.activeStageId);
  const stageLines = chain.stages.map((stage) => {
    const marker = stage.id === chain.activeStageId ? "▶️" : "•";
    return `${marker} ${stage.name}：${stage.targets.length ? `${stage.targets.length} 台` : "未配置"}`;
  });
  if (lang === "en") {
    return [
      `📣 ${chain.name}`,
      `Status: ${chain.status}`,
      `Region: ${current?.name || "Not configured"}`,
      `Next: ${next?.name || "complete"}`,
      `Trigger: any preset model`,
      `Schedule: ${chain.startTime}–${chain.endTime} · ${chain.intervalMinutes} min`,
      `Weekend: ${chain.skipWeekends ? "off" : "on"}`,
      "",
      ...stageLines
    ].join("\n");
  }
  return [
    `📣 ${chain.name}`,
    `状态：${chain.status === "active" ? "监控中" : chain.status === "awaiting_confirmation" ? "等待确认" : chain.status === "completed" ? "本轮完成" : "待配置"}`,
    `地区：${current?.name || "未配置"}`,
    `下一步：${next?.name || "本轮完成"}`,
    "触发：任一预设机型",
    `时间：${chain.startTime}–${chain.endTime} · ${chain.intervalMinutes} 分钟`,
    `周末监控：${chain.skipWeekends ? "关闭" : "开启"}`,
    "",
    ...stageLines
  ].join("\n");
}
