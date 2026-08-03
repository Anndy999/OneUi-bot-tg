import { randomUUID } from "node:crypto";

function duration(value, fallback = 30000) {
  const ms = Number(value ?? fallback);
  return Number.isFinite(ms) ? Math.max(1000, Math.floor(ms)) : fallback;
}

export class MemoryLockService {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.locks = new Map();
  }

  purge() {
    const now = this.now();
    for (const [key, lock] of this.locks) if (lock.expiresAt <= now) this.locks.delete(key);
  }

  async acquire(key, ttlMs = 30000) {
    this.purge();
    const name = String(key);
    if (this.locks.has(name)) return { acquired: false, token: "", expiresAt: 0 };
    const token = randomUUID();
    const expiresAt = this.now() + duration(ttlMs);
    this.locks.set(name, { token, expiresAt });
    return { acquired: true, token, expiresAt };
  }

  async refresh(key, token, ttlMs = 30000) {
    this.purge();
    const current = this.locks.get(String(key));
    if (!current || current.token !== token) return false;
    current.expiresAt = this.now() + duration(ttlMs);
    return true;
  }

  async release(key, token) {
    const current = this.locks.get(String(key));
    if (!current || current.token !== token) return false;
    this.locks.delete(String(key));
    return true;
  }
}

const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const REFRESH_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

export class RedisLockService {
  constructor(client, { prefix = "oneui:lock:" } = {}) {
    if (!client?.set || !client?.eval) throw new TypeError("RedisLockService requires set/eval");
    this.client = client;
    this.prefix = prefix;
  }

  key(value) { return `${this.prefix}${String(value)}`; }

  async acquire(key, ttlMs = 30000) {
    const token = randomUUID();
    const ttl = duration(ttlMs);
    const result = await this.client.set(this.key(key), token, "NX", "PX", ttl);
    return { acquired: result === "OK", token: result === "OK" ? token : "", expiresAt: result === "OK" ? Date.now() + ttl : 0 };
  }

  async refresh(key, token, ttlMs = 30000) {
    return Number(await this.client.eval(REFRESH_SCRIPT, 1, this.key(key), token, duration(ttlMs))) === 1;
  }

  async release(key, token) {
    return Number(await this.client.eval(RELEASE_SCRIPT, 1, this.key(key), token)) === 1;
  }
}

export async function withLock(lockService, key, ttlMs, factory) {
  const claim = await lockService.acquire(key, ttlMs);
  if (!claim.acquired) return { acquired: false, value: null };
  try {
    return { acquired: true, value: await factory(claim) };
  } finally {
    await lockService.release(key, claim.token).catch(() => {});
  }
}
