export const DEFAULT_MONITOR_INTERVALS = Object.freeze({
  high: 3,
  normal: 10,
  low: 30,
  idle: 60,
  watch: 3,
  hot: 1,
  cooldown: 3
});

export const MONITOR_INTERVAL_MODES = Object.freeze(Object.keys(DEFAULT_MONITOR_INTERVALS));

export function normalizeMonitorIntervalMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return MONITOR_INTERVAL_MODES.includes(mode) ? mode : "";
}

function normalizeMinutes(value, fallback) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 1
    ? Math.min(1440, Math.floor(minutes))
    : fallback;
}

export function normalizeMonitorIntervalSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const schemaVersion = Number(source.schemaVersion || 1);
  const normalized = Object.fromEntries(MONITOR_INTERVAL_MODES.map((mode) => [
    mode,
    normalizeMinutes(source[mode], DEFAULT_MONITOR_INTERVALS[mode])
  ]));

  // Builds before v2.8.1 persisted HIGH=1 as the old default. Migrate that
  // legacy value once so upgraded deployments actually receive the new safe
  // three-minute default. New administrator choices are stored with schema 2.
  if (schemaVersion < 2 && Number(source.high) === 1) normalized.high = DEFAULT_MONITOR_INTERVALS.high;
  return normalized;
}

export function sharedMonitorIntervalMinutes(settings = DEFAULT_MONITOR_INTERVALS) {
  const normalized = normalizeMonitorIntervalSettings(settings);
  const values = MONITOR_INTERVAL_MODES.map((mode) => normalized[mode]);
  return values.every((minutes) => minutes === values[0]) ? values[0] : null;
}

export function uniformMonitorIntervalSettings(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 1 || value > 1440) return null;
  const normalized = Math.floor(value);
  return Object.fromEntries(MONITOR_INTERVAL_MODES.map((mode) => [mode, normalized]));
}

export function priorityScoreIntervalMinutes(score, settings = DEFAULT_MONITOR_INTERVALS) {
  const normalized = normalizeMonitorIntervalSettings(settings);
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  if (value >= 80) return normalized.high;
  if (value >= 50) return normalized.normal;
  if (value >= 20) return normalized.low;
  return normalized.idle;
}

export function releaseModeIntervalMinutes(mode, settings = DEFAULT_MONITOR_INTERVALS) {
  const normalized = normalizeMonitorIntervalSettings(settings);
  const key = normalizeMonitorIntervalMode(mode);
  if (["watch", "hot", "cooldown"].includes(key)) return normalized[key];
  return normalized.normal;
}
