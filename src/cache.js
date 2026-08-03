import { validateModelCsc } from "./targets.js";

const l1Cache = new Map();
const firmwareMemoryCache = new Map();
const hotFirmwareTargets = new Map();
const inFlightQueries = new Map();
const negativeCache = new Map();

function normalizeKey(model, csc) {
  return validateModelCsc(model, csc).key;
}

function prune(map, maxEntries) {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

export function firmwareMemoryKey(model, csc) {
  return normalizeKey(model, csc);
}

export function getL1Firmware(model, csc) {
  const key = normalizeKey(model, csc);
  const entry = l1Cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    l1Cache.delete(key);
    return null;
  }
  l1Cache.delete(key);
  l1Cache.set(key, entry);
  return entry.value;
}

export function setL1Firmware(model, csc, value, ttlSeconds = 20, maxEntries = 750) {
  const key = normalizeKey(model, csc);
  l1Cache.delete(key);
  l1Cache.set(key, {
    value,
    expiresAt: Date.now() + Math.max(1, Number(ttlSeconds) || 20) * 1000
  });
  prune(l1Cache, Math.max(50, Number(maxEntries) || 750));
  return value;
}

export function deleteL1Firmware(model, csc) {
  return l1Cache.delete(normalizeKey(model, csc));
}

export function markFirmwareTargetHot(model, csc, ttlSeconds = 30 * 60) {
  const key = normalizeKey(model, csc);
  hotFirmwareTargets.set(key, Date.now() + Math.max(60, Number(ttlSeconds) || 1800) * 1000);
  prune(hotFirmwareTargets, 500);
  return key;
}

export function isHotFirmwareTarget(model, csc) {
  const key = normalizeKey(model, csc);
  const expiresAt = Number(hotFirmwareTargets.get(key) || 0);
  if (expiresAt <= Date.now()) {
    hotFirmwareTargets.delete(key);
    return false;
  }
  return true;
}

export function isHotFirmwareModel(model) {
  const prefix = `${String(model || "").trim().toUpperCase()}:`;
  return [...hotFirmwareTargets.entries()].some(([key, expiresAt]) => {
    if (Number(expiresAt || 0) <= Date.now()) {
      hotFirmwareTargets.delete(key);
      return false;
    }
    return key.startsWith(prefix);
  });
}

export function getFirmwareMemoryCache(model, csc) {
  if (!isHotFirmwareTarget(model, csc)) return null;
  const key = normalizeKey(model, csc);
  const entry = firmwareMemoryCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    firmwareMemoryCache.delete(key);
    return null;
  }
  firmwareMemoryCache.delete(key);
  firmwareMemoryCache.set(key, entry);
  return entry.value;
}

export function setFirmwareMemoryCache(model, csc, value, ttlSeconds = 60) {
  if (!isHotFirmwareTarget(model, csc) || !value?.latest || !value?.regionExact) return false;
  const key = normalizeKey(model, csc);
  firmwareMemoryCache.delete(key);
  firmwareMemoryCache.set(key, {
    value,
    expiresAt: Date.now() + Math.max(1, Number(ttlSeconds) || 60) * 1000
  });
  prune(firmwareMemoryCache, 150);
  return true;
}

export function deleteFirmwareMemoryCache(model, csc) {
  return firmwareMemoryCache.delete(normalizeKey(model, csc));
}

export function singleFlightFirmware(model, csc, factory) {
  const key = normalizeKey(model, csc);
  const existing = inFlightQueries.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (inFlightQueries.get(key) === promise) inFlightQueries.delete(key);
    });
  inFlightQueries.set(key, promise);
  return promise;
}

export function getNegativeFirmware(model, csc) {
  const key = normalizeKey(model, csc);
  const entry = negativeCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    negativeCache.delete(key);
    return null;
  }
  return entry.value;
}

export function setNegativeFirmware(model, csc, reason, ttlSeconds = 20) {
  const value = reason && typeof reason === "object"
    ? {
        message: String(reason.message || reason.error || "Firmware query failed"),
        code: String(reason.code || ""),
        officialCscOptions: Array.isArray(reason.officialCscOptions) ? reason.officialCscOptions : []
      }
    : { message: String(reason || "Firmware query failed"), code: "", officialCscOptions: [] };
  negativeCache.set(normalizeKey(model, csc), {
    value,
    expiresAt: Date.now() + Math.max(1, Number(ttlSeconds) || 20) * 1000
  });
  prune(negativeCache, 500);
}

export function clearFirmwareMemoryCaches() {
  l1Cache.clear();
  firmwareMemoryCache.clear();
  hotFirmwareTargets.clear();
  negativeCache.clear();
}
