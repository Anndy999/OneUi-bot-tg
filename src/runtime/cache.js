function clone(value) {
  return value === null || value === undefined || typeof value === "string" ? value : structuredClone(value);
}

function ttlMs(value, fallback = 30000) {
  const ttl = Number(value ?? fallback);
  return Number.isFinite(ttl) ? Math.max(1, Math.floor(ttl)) : fallback;
}

export class MemoryCache {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.entries = new Map();
    this.flights = new Map();
  }

  async get(key) {
    const entry = this.entries.get(String(key));
    if (!entry || entry.expiresAt <= this.now()) {
      this.entries.delete(String(key));
      return null;
    }
    return clone(entry.value);
  }

  async set(key, value, options = {}) {
    this.entries.set(String(key), { value: clone(value), expiresAt: this.now() + ttlMs(options.ttlMs) });
    return value;
  }

  async delete(key) {
    return this.entries.delete(String(key));
  }

  async getOrSet(key, factory, options = {}) {
    const name = String(key);
    const existing = await this.get(name);
    if (existing !== null && existing !== undefined) return { value: existing, cacheHit: true, shared: false };
    const flight = this.flights.get(name);
    if (flight) return { value: await flight, cacheHit: false, shared: true };
    const promise = Promise.resolve().then(factory).then(async (value) => {
      await this.set(name, value, options);
      return value;
    }).finally(() => {
      if (this.flights.get(name) === promise) this.flights.delete(name);
    });
    this.flights.set(name, promise);
    return { value: await promise, cacheHit: false, shared: false };
  }

  async close() {}
}

export class RedisCache {
  constructor(client) {
    if (!client?.get || !client?.set) throw new TypeError("RedisCache requires an ioredis-like client");
    this.client = client;
    this.flights = new Map();
  }

  async get(key) {
    const raw = await this.client.get(String(key));
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async set(key, value, options = {}) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const ttl = ttlMs(options.ttlMs);
    await this.client.set(String(key), raw, "PX", ttl);
    return value;
  }

  async delete(key) {
    return (await this.client.del(String(key))) > 0;
  }

  async getOrSet(key, factory, options = {}) {
    const name = String(key);
    const existing = await this.get(name);
    if (existing !== null && existing !== undefined) return { value: existing, cacheHit: true, shared: false };
    const flight = this.flights.get(name);
    if (flight) return { value: await flight, cacheHit: false, shared: true };
    const promise = Promise.resolve().then(factory).then(async (value) => {
      await this.set(name, value, options);
      return value;
    }).finally(() => {
      if (this.flights.get(name) === promise) this.flights.delete(name);
    });
    this.flights.set(name, promise);
    return { value: await promise, cacheHit: false, shared: false };
  }

  async close() {
    if (typeof this.client.quit === "function") await this.client.quit();
  }
}
