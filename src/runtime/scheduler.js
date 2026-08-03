import { randomUUID } from "node:crypto";
import { validateModelCsc } from "../targets.js";

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function targetFor(model, csc) {
  return validateModelCsc(model, csc);
}

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

/**
 * Offline scheduler with the same claim/token shape used by the future
 * PostgreSQL scheduler. It is intentionally deterministic and is not the
 * production persistence implementation.
 */
export class MemoryScheduler {
  constructor({ now = () => Date.now(), lockMs = 5 * 60 * 1000 } = {}) {
    this.now = now;
    this.lockMs = Math.max(60_000, Number(lockMs) || 5 * 60 * 1000);
    this.targets = new Map();
  }

  async sync(items, now = this.now()) {
    const normalized = Array.isArray(items) ? items : [];
    const allowed = new Set();
    for (const raw of normalized) {
      const target = targetFor(raw.model, raw.csc);
      allowed.add(target.key);
      const existing = this.targets.get(target.key);
      const item = { ...raw, model: target.model, csc: target.csc, key: target.key };
      if (existing) {
        existing.item = clone(item);
        if (item.enabled === false) {
          existing.nextCheckAt = 0;
          existing.inFlight = false;
          existing.lock = "";
          existing.lockUntil = 0;
        } else if (!existing.nextCheckAt && !existing.inFlight) {
          existing.nextCheckAt = now;
        }
        continue;
      }
      this.targets.set(target.key, {
        key: target.key,
        item: clone(item),
        nextCheckAt: item.enabled === false ? 0 : now,
        inFlight: false,
        lock: "",
        lockUntil: 0,
        lastVersion: "",
        priorityScore: 0,
        monitorMode: "NORMAL",
        modeUntil: 0,
        lastCheckedAt: 0,
        failureCount: 0,
        lastError: ""
      });
    }
    for (const key of this.targets.keys()) if (!allowed.has(key)) this.targets.delete(key);
    return { ok: true, targets: [...this.targets.values()].filter((entry) => entry.item.enabled !== false).length };
  }

  claimRecord(record, now) {
    if (record.item.enabled === false) return null;
    if (record.inFlight && record.lockUntil > now) return null;
    const lock = randomUUID();
    const lockUntil = now + this.lockMs;
    record.inFlight = true;
    record.lock = lock;
    record.lockUntil = lockUntil;
    record.nextCheckAt = lockUntil;
    return {
      item: clone(record.item),
      lastVersion: record.lastVersion,
      priorityScore: record.priorityScore,
      monitorMode: record.monitorMode,
      failureCount: record.failureCount,
      lock,
      lockUntil,
      schedulerClaim: true
    };
  }

  async claimDue({ now = this.now(), limit = 6 } = {}) {
    const candidates = [...this.targets.values()]
      .filter((record) => record.item.enabled !== false && numeric(record.nextCheckAt) <= now)
      .sort((a, b) => numeric(a.nextCheckAt) - numeric(b.nextCheckAt));
    const entries = [];
    for (const record of candidates.slice(0, Math.max(1, Number(limit) || 6))) {
      const claimed = this.claimRecord(record, now);
      if (claimed) entries.push(claimed);
    }
    return { ok: true, entries, totalTargets: [...this.targets.values()].filter((entry) => entry.item.enabled !== false).length };
  }

  async claimManual(items, now = this.now()) {
    const entries = [];
    const skipped = [];
    for (const item of Array.isArray(items) ? items : []) {
      const target = targetFor(item.model, item.csc);
      const record = this.targets.get(target.key);
      const claimed = record ? this.claimRecord(record, now) : null;
      if (claimed) entries.push(claimed);
      else skipped.push({ model: target.model, csc: target.csc, reason: record ? "in_flight" : "missing" });
    }
    return { ok: true, entries, skipped };
  }

  async validateClaim({ model, csc, lock, now = this.now() }) {
    const target = targetFor(model, csc);
    const record = this.targets.get(target.key);
    return { ok: true, valid: Boolean(record?.inFlight && record.lock === lock && record.lockUntil > now) };
  }

  async complete({ model, csc, lock = "", status = "success", nextCheckAt, lastVersion = "", priorityScore = 0, error = "", completedAt = this.now() } = {}) {
    const target = targetFor(model, csc);
    const record = this.targets.get(target.key);
    if (!record) return { ok: false, missing: true };
    if (lock && lock !== record.lock) return { ok: false, staleLock: true };
    const now = numeric(completedAt, this.now());
    const failed = status === "failed";
    record.inFlight = false;
    record.lock = "";
    record.lockUntil = 0;
    record.lastCheckedAt = now;
    record.lastVersion = String(lastVersion || record.lastVersion || "");
    record.priorityScore = Math.max(0, Math.min(100, numeric(priorityScore, record.priorityScore)));
    record.failureCount = failed ? record.failureCount + 1 : 0;
    record.lastError = failed ? String(error || "").slice(0, 500) : "";
    record.nextCheckAt = Math.max(now + 60_000, numeric(nextCheckAt, now + 60_000));
    return { ok: true, nextCheckAt: record.nextCheckAt, failureCount: record.failureCount };
  }

  async forceDue(model, csc, dueAt = this.now()) {
    const target = targetFor(model, csc);
    const record = this.targets.get(target.key);
    if (!record) return { ok: false, missing: true };
    record.inFlight = false;
    record.lock = "";
    record.lockUntil = 0;
    record.nextCheckAt = numeric(dueAt, this.now());
    return { ok: true, nextCheckAt: record.nextCheckAt };
  }

  async status() {
    return {
      ok: true,
      initialized: this.targets.size > 0,
      targets: [...this.targets.values()].filter((entry) => entry.item.enabled !== false).length
    };
  }
}
