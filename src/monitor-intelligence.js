import { priorityScoreIntervalMinutes } from "./monitor-intervals.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function recentScore(value, now, fullWindowMs, points) {
  const time = timestamp(value);
  if (!time) return 0;
  const age = Math.max(0, now - time);
  if (age >= fullWindowMs) return 0;
  return Math.ceil(points * (1 - age / fullWindowMs));
}

export function isFlagshipModel(model) {
  return /^SM-(?:S9\d{2}|F9\d{2})[A-Z0-9]*$/i.test(String(model || ""));
}

export function priorityIntervalMinutes(score, settings) {
  return priorityScoreIntervalMinutes(score, settings);
}

function releaseCyclePoints(runtime, now) {
  const officialAt = timestamp(runtime.lastOfficialUpdateAt || runtime.lastVersionChangedAt);
  if (!officialAt) return { points: 0, dormancyPenalty: 0 };
  const age = Math.max(0, now - officialAt);
  if (age <= 2 * DAY_MS) return { points: 15, dormancyPenalty: 0 };
  if (age <= 14 * DAY_MS) return { points: 5, dormancyPenalty: 0 };
  if (age >= 120 * DAY_MS) return { points: 0, dormancyPenalty: 20 };
  if (age >= 60 * DAY_MS) return { points: 0, dormancyPenalty: 10 };
  return { points: 0, dormancyPenalty: 0 };
}

export function calculatePriorityScore(input, now = Date.now(), intervalSettings) {
  const item = input?.item || {};
  const runtime = input?.runtime || {};
  const priorityBase = { high: 40, normal: 20, low: 5 }[item.priority] ?? 20;
  const queryCount = Math.max(0, Number(input?.queryCount || 0));
  const queryPoints = Math.min(20, Math.round(Math.log2(queryCount + 1) * 4));
  const flagshipPoints = isFlagshipModel(item.model) ? 15 : 0;
  const peerUpdatePoints = recentScore(runtime.lastPeerUpdateAt, now, 6 * HOUR_MS, 25);
  const releaseCycle = releaseCyclePoints(runtime, now);
  const failurePenalty = Math.min(30, Math.max(0, Number(runtime.failureCount || 0)) * 6);

  let score = priorityBase + queryPoints + flagshipPoints + peerUpdatePoints +
    releaseCycle.points - releaseCycle.dormancyPenalty - failurePenalty;
  if (input?.boost) score = Math.max(score, 80);
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    priorityScore: score,
    intervalMinutes: priorityIntervalMinutes(score, intervalSettings),
    factors: {
      priorityBase,
      userQueries: queryCount,
      queryPoints,
      flagshipPoints,
      peerUpdatePoints,
      releaseCyclePoints: releaseCycle.points,
      dormancyPenalty: releaseCycle.dormancyPenalty,
      failurePenalty,
      releaseBoost: Boolean(input?.boost)
    }
  };
}
