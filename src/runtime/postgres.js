function normalizeKey(value) {
  const key = String(value ?? "");
  if (!key) throw new Error("Runtime storage key is required");
  return key;
}

function normalizeLimit(value, fallback = 1000) {
  const limit = Number(value || fallback);
  return Number.isFinite(limit) ? Math.max(1, Math.min(10000, Math.floor(limit))) : fallback;
}

function normalizeNamespace(value) {
  const namespace = String(value ?? "").trim();
  if (!namespace) throw new Error("Runtime storage namespace is required");
  return namespace;
}

/**
 * JSON document storage for the former Durable Object state. The storage
 * contract intentionally matches the Map-shaped storage used by
 * MonitorScheduler and FirmwareQueryCoordinator.
 */
export class PostgresJsonStorage {
  constructor(client, { namespace, ownsClient = false } = {}) {
    if (!client?.query) throw new TypeError("PostgresJsonStorage requires a pg client or pool");
    this.client = client;
    this.namespace = normalizeNamespace(namespace);
    this.ownsClient = ownsClient;
  }

  async get(key) {
    const result = await this.client.query(
      "SELECT value FROM runtime_state WHERE namespace = $1 AND key = $2",
      [this.namespace, normalizeKey(key)]
    );
    return result.rows[0]?.value;
  }

  async put(key, value) {
    await this.client.query(
      `INSERT INTO runtime_state (namespace, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [this.namespace, normalizeKey(key), JSON.stringify(value)]
    );
  }

  async delete(key) {
    if (Array.isArray(key)) {
      if (!key.length) return 0;
      const result = await this.client.query(
        "DELETE FROM runtime_state WHERE namespace = $1 AND key = ANY($2::text[])",
        [this.namespace, key.map(normalizeKey)]
      );
      return result.rowCount || 0;
    }
    const result = await this.client.query(
      "DELETE FROM runtime_state WHERE namespace = $1 AND key = $2",
      [this.namespace, normalizeKey(key)]
    );
    return result.rowCount || 0;
  }

  async list({ prefix = "", start, end, limit = 1000 } = {}) {
    const values = [this.namespace];
    const clauses = ["namespace = $1"];
    if (prefix) {
      values.push(`${String(prefix)}%`);
      clauses.push(`key LIKE $${values.length}`);
    }
    if (start !== undefined && start !== null) {
      values.push(String(start));
      clauses.push(`key >= $${values.length}`);
    }
    if (end !== undefined && end !== null) {
      values.push(String(end));
      clauses.push(`key < $${values.length}`);
    }
    values.push(normalizeLimit(limit));
    const result = await this.client.query(
      `SELECT key, value FROM runtime_state
       WHERE ${clauses.join(" AND ")}
       ORDER BY key
       LIMIT $${values.length}`,
      values
    );
    return new Map(result.rows.map((row) => [row.key, row.value]));
  }

  async setAlarm(value) {
    const alarmAt = value === null || value === undefined ? null : new Date(Number(value));
    await this.client.query(
      `INSERT INTO runtime_alarms (namespace, alarm_at, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (namespace) DO UPDATE SET alarm_at = EXCLUDED.alarm_at, updated_at = now()`,
      [this.namespace, alarmAt && Number.isNaN(alarmAt.getTime()) ? null : alarmAt]
    );
  }

  async getAlarm() {
    const result = await this.client.query(
      "SELECT EXTRACT(EPOCH FROM alarm_at) * 1000 AS alarm_at FROM runtime_alarms WHERE namespace = $1",
      [this.namespace]
    );
    const value = result.rows[0]?.alarm_at;
    return value === null || value === undefined ? null : Number(value);
  }

  async withTransaction(factory) {
    if (typeof this.client.connect !== "function") return factory(this);
    const client = await this.client.connect();
    try {
      await client.query("BEGIN");
      const transactional = new PostgresJsonStorage(client, { namespace: this.namespace });
      const result = await factory(transactional, client);
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

export class PersistentNamespace {
  constructor({ pool, namespace, createInstance, logger = console } = {}) {
    if (!pool?.connect) throw new TypeError("PersistentNamespace requires a pg Pool");
    if (typeof createInstance !== "function") throw new TypeError("PersistentNamespace requires createInstance");
    this.pool = pool;
    this.namespace = normalizeNamespace(namespace);
    this.createInstance = createInstance;
    this.logger = logger;
    this.instances = new Map();
  }

  idFromName(name) {
    return String(name || "");
  }

  instanceFor(id) {
    const name = String(id || "");
    let entry = this.instances.get(name);
    if (!entry) {
      const storage = new PostgresJsonStorage(this.pool, { namespace: `${this.namespace}:${name}` });
      const context = {
        storage,
        waitUntil: (promise) => Promise.resolve(promise).catch((error) => {
          this.logger.error?.(`Persistent namespace background task failed: ${error.message}`);
        })
      };
      entry = { context, instance: this.createInstance(context) };
      this.instances.set(name, entry);
    }
    return entry;
  }

  get(id) {
    const name = String(id || "");
    return {
      fetch: (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return this.invoke(name, request);
      }
    };
  }

  async invoke(id, request) {
    const entry = this.instanceFor(id);
    const baseStorage = entry.context.storage;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${this.namespace}:${id}`]);
      const transactionalStorage = new PostgresJsonStorage(client, { namespace: baseStorage.namespace });
      entry.context.storage = transactionalStorage;
      const result = new URL(request.url).pathname === "/alarm" && typeof entry.instance.alarm === "function" ? await entry.instance.alarm() : await entry.instance.fetch(request);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      entry.context.storage = baseStorage;
      client.release();
    }
  }

  async runAlarms() {
    const results = [];
    for (const [id, entry] of this.instances) {
      if (typeof entry.instance.alarm !== "function") continue;
      try {
        results.push(await this.invoke(id, new Request("https://namespace/alarm", { method: "POST" })));
      } catch (error) {
        this.logger.error?.(`Persistent namespace alarm failed for ${id}: ${error.message}`);
      }
    }
    return results;
  }

  async close() {}
}
