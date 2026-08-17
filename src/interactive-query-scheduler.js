const schedulers = new WeakMap();

function envNumber(env, key, fallback, min, max) {
  const value = Number(env?.[key] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function interactiveQueryConcurrency(env) {
  return envNumber(env, "INTERACTIVE_QUERY_CONCURRENCY", 4, 1, 8);
}

function interactiveQueryQueueLimit(env) {
  return envNumber(env, "INTERACTIVE_QUERY_QUEUE_LIMIT", 80, 8, 500);
}

class InteractiveQueryScheduler {
  constructor(env) {
    this.env = env;
    this.active = 0;
    this.pending = [];
    this.inFlight = new Map();
  }

  schedule(key, task) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) throw new TypeError("Interactive query key is required");
    if (typeof task !== "function") throw new TypeError("Interactive query task is required");
    const shared = this.inFlight.get(normalizedKey);
    if (shared) return shared;
    if (this.pending.length >= interactiveQueryQueueLimit(this.env)) {
      const error = new Error("Firmware queries are temporarily busy. Please try again shortly.");
      error.code = "INTERACTIVE_QUERY_BUSY";
      // Return a rejected promise so callers can use the same delivery path as
      // an upstream firmware-query failure.
      return Promise.reject(error);
    }

    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.inFlight.set(normalizedKey, promise);
    this.pending.push({ key: normalizedKey, task, resolve, reject });
    this.drain();
    return promise;
  }

  drain() {
    const limit = interactiveQueryConcurrency(this.env);
    while (this.active < limit && this.pending.length) {
      const entry = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1;
          this.inFlight.delete(entry.key);
          this.drain();
        });
    }
  }

  snapshot() {
    return { active: this.active, waiting: this.pending.length, shared: this.inFlight.size };
  }
}

function schedulerFor(env) {
  if (!env || (typeof env !== "object" && typeof env !== "function")) {
    throw new TypeError("Interactive query scheduler requires an environment object");
  }
  let scheduler = schedulers.get(env);
  if (!scheduler) {
    scheduler = new InteractiveQueryScheduler(env);
    schedulers.set(env, scheduler);
  }
  return scheduler;
}

export function scheduleInteractiveFirmwareQuery(env, key, task) {
  return schedulerFor(env).schedule(key, task);
}

export function interactiveQuerySchedulerSnapshot(env) {
  return schedulerFor(env).snapshot();
}
