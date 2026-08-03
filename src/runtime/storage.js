const DEFAULT_PAGE_SIZE = 1000;

function assertKey(key) {
  const value = String(key ?? "");
  if (!value) throw new Error("Storage key is required");
  return value;
}

function expirationFromOptions(options = {}, now = Date.now()) {
  if (options.expiration !== undefined && options.expiration !== null) {
    const seconds = Number(options.expiration);
    if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000);
  }
  if (options.expirationTtl !== undefined && options.expirationTtl !== null) {
    const seconds = Number(options.expirationTtl);
    if (Number.isFinite(seconds) && seconds > 0) return now + Math.floor(seconds * 1000);
  }
  return null;
}

function cloneValue(value) {
  if (value === null || value === undefined || typeof value === "string") return value;
  return structuredClone(value);
}

function normalizeLimit(value) {
  const limit = Number(value || DEFAULT_PAGE_SIZE);
  return Number.isFinite(limit) ? Math.max(1, Math.min(DEFAULT_PAGE_SIZE, Math.floor(limit))) : DEFAULT_PAGE_SIZE;
}

/**
 * Cloudflare-KV-shaped storage used by offline tests and as a safe local
 * development store. Values are intentionally strings, matching KV semantics.
 */
export class MemoryStorage {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.entries = new Map();
  }

  purgeExpired() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  async get(key) {
    this.purgeExpired();
    return this.entries.get(assertKey(key))?.value ?? null;
  }

  async put(key, value, options = {}) {
    const name = assertKey(key);
    if (typeof value !== "string") throw new TypeError("MemoryStorage values must be strings");
    const now = this.now();
    const current = this.entries.get(name);
    this.entries.set(name, {
      value,
      expiresAt: expirationFromOptions(options, now),
      createdAt: current?.createdAt || now,
      updatedAt: now
    });
  }

  async delete(key) {
    this.purgeExpired();
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const item of key) if (this.entries.delete(assertKey(item))) deleted += 1;
      return deleted;
    }
    return this.entries.delete(assertKey(key));
  }

  async list({ prefix = "", cursor, limit = DEFAULT_PAGE_SIZE } = {}) {
    this.purgeExpired();
    const names = [...this.entries.keys()].filter((key) => key.startsWith(String(prefix))).sort();
    const offset = Math.max(0, Number.parseInt(String(cursor || "0"), 10) || 0);
    const pageSize = normalizeLimit(limit);
    const selected = names.slice(offset, offset + pageSize);
    const next = offset + selected.length;
    return {
      keys: selected.map((name) => {
        const entry = this.entries.get(name);
        return {
          name,
          expiration: entry?.expiresAt ? Math.floor(entry.expiresAt / 1000) : undefined
        };
      }),
      list_complete: next >= names.length,
      cursor: next >= names.length ? undefined : String(next)
    };
  }

  async withTransaction(factory) {
    return factory(this);
  }
}

/**
 * PostgreSQL adapter for the app_kv compatibility table. It deliberately
 * exposes raw string values so existing KV callers keep their JSON/string
 * distinction. Typed scheduler tables are added behind separate services.
 */
export class PostgresStorage {
  constructor(pool) {
    if (!pool?.query) throw new TypeError("PostgresStorage requires a pg Pool-like object");
    this.pool = pool;
  }

  async get(key) {
    const result = await this.pool.query(
      "SELECT value FROM app_kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())",
      [assertKey(key)]
    );
    return result.rows[0]?.value ?? null;
  }

  async put(key, value, options = {}) {
    if (typeof value !== "string") throw new TypeError("PostgresStorage values must be strings");
    const expiresAtMs = expirationFromOptions(options);
    const expiresAt = expiresAtMs === null ? null : new Date(expiresAtMs);
    await this.pool.query(
      `INSERT INTO app_kv (key, value, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
         expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [assertKey(key), value, expiresAt]
    );
  }

  async delete(key) {
    if (Array.isArray(key)) {
      if (!key.length) return 0;
      const result = await this.pool.query("DELETE FROM app_kv WHERE key = ANY($1::text[])", [key.map(assertKey)]);
      return result.rowCount || 0;
    }
    const result = await this.pool.query("DELETE FROM app_kv WHERE key = $1", [assertKey(key)]);
    return result.rowCount || 0;
  }

  async list({ prefix = "", cursor, limit = DEFAULT_PAGE_SIZE } = {}) {
    const pageSize = normalizeLimit(limit);
    const offset = Math.max(0, Number.parseInt(String(cursor || "0"), 10) || 0);
    const result = await this.pool.query(
      `SELECT key, EXTRACT(EPOCH FROM expires_at)::bigint AS expiration
         FROM app_kv
        WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > now())
        ORDER BY key
        LIMIT $2 OFFSET $3`,
      [`${String(prefix).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, pageSize + 1, offset]
    );
    const rows = result.rows.slice(0, pageSize);
    const complete = result.rows.length <= pageSize;
    return {
      keys: rows.map((row) => ({ name: row.key, expiration: row.expiration ? Number(row.expiration) : undefined })),
      list_complete: complete,
      cursor: complete ? undefined : String(offset + pageSize)
    };
  }

  async withTransaction(factory) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const transactionalStorage = new PostgresStorage(client);
      const result = await factory(transactionalStorage, client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function listAll(storage, options = {}) {
  const output = [];
  let cursor;
  do {
    const page = await storage.list({ ...options, cursor });
    output.push(...(page.keys || []));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return output;
}
