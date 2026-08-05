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
  constructor({
    pool,
    namespace,
    createInstance,
    logger = console,
    maxInstances = 1000,
    alarmBatchSize = 500
  } = {}) {
    if (!pool?.connect) throw new TypeError("PersistentNamespace requires a pg Pool");
    if (typeof createInstance !== "function") throw new TypeError("PersistentNamespace requires createInstance");
    this.pool = pool;
    this.namespace = normalizeNamespace(namespace);
    this.createInstance = createInstance;
    this.logger = logger;
    this.maxInstances = Math.max(10, Math.min(10000, Math.floor(Number(maxInstances) || 1000)));
    this.alarmBatchSize = Math.max(1, Math.min(2000, Math.floor(Number(alarmBatchSize) || 500)));
    this.instances = new Map();
    this.closed = false;
  }

  idFromName(name) {
    return String(name || "");
  }

  instanceFor(id) {
    if (this.closed) throw new Error(`Persistent namespace ${this.namespace} is closed`);
    const name = String(id || "");
    let entry = this.instances.get(name);
    if (!entry) {
      const storage = new PostgresJsonStorage(this.pool, { namespace: `${this.namespace}:${name}` });
      entry = {
        context: null,
        instance: null,
        background: new Set(),
        active: 0,
        lastUsedAt: Date.now()
      };
      const context = {
        storage,
        waitUntil: (promise) => {
          let task;
          task = Promise.resolve(promise)
            .catch((error) => {
              this.logger.error?.(`Persistent namespace background task failed: ${error.message}`);
            })
            .finally(() => entry.background.delete(task));
          entry.background.add(task);
          return task;
        }
      };
      entry.context = context;
      entry.instance = this.createInstance(context);
      this.instances.set(name, entry);
      this.pruneInstances();
    }
    entry.lastUsedAt = Date.now();
    return entry;
  }

  pruneInstances() {
    if (this.instances.size <= this.maxInstances) return;
    const idle = [...this.instances.entries()]
      .filter(([, entry]) => entry.active === 0 && entry.background.size === 0)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    while (this.instances.size > this.maxInstances && idle.length) {
      const [id] = idle.shift();
      this.instances.delete(id);
    }
  }

  async drainBackground(entry) {
    while (entry.background.size) {
      await Promise.allSettled([...entry.background]);
    }
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
    entry.active += 1;
    entry.lastUsedAt = Date.now();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${this.namespace}:${id}`]);
      const transactionalStorage = new PostgresJsonStorage(client, { namespace: baseStorage.namespace });
      entry.context.storage = transactionalStorage;
      const isAlarm = new URL(request.url).pathname === "/alarm" && typeof entry.instance.alarm === "function";
      if (isAlarm) {
        // Alarms are one-shot. Re-check after taking the per-instance lock so
        // two service processes cannot both execute a row selected as due.
        const alarmAt = await transactionalStorage.getAlarm();
        if (!alarmAt || alarmAt > Date.now()) {
          await client.query("COMMIT");
          return { ok: true, skipped: true };
        }
        // Consume before execution in the same transaction. A thrown error
        // rolls this back; a handler may set its next alarm before COMMIT.
        await transactionalStorage.setAlarm(null);
      }
      const result = isAlarm ? await entry.instance.alarm() : await entry.instance.fetch(request);
      // waitUntil tasks are allowed to use the transactional storage. Drain
      // them before COMMIT so they can never continue on a released pg client.
      await this.drainBackground(entry);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await this.drainBackground(entry).catch(() => {});
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      entry.context.storage = baseStorage;
      entry.active = Math.max(0, entry.active - 1);
      entry.lastUsedAt = Date.now();
      client.release();
      this.pruneInstances();
    }
  }

  async runAlarms() {
    if (this.closed) return [];
    // Discover persisted alarms instead of relying on the in-memory instance
    // map. This restores due work after a process restart and avoids invoking
    // alarms before their scheduled time.
    const due = await this.pool.query(
      `SELECT namespace FROM runtime_alarms
       WHERE namespace >= $1 || ':'
         AND namespace < $1 || ';'
         AND alarm_at IS NOT NULL
         AND alarm_at <= now()
       ORDER BY alarm_at
       LIMIT $2`,
      [this.namespace, this.alarmBatchSize]
    );
    const results = [];
    for (const row of due.rows || []) {
      const fullNamespace = String(row.namespace || "");
      const id = fullNamespace.slice(this.namespace.length + 1);
      const entry = this.instanceFor(id);
      if (typeof entry.instance.alarm !== "function") continue;
      try {
        results.push(await this.invoke(id, new Request("https://namespace/alarm", { method: "POST" })));
      } catch (error) {
        this.logger.error?.(`Persistent namespace alarm failed for ${id}: ${error.message}`);
      }
    }
    return results;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.instances.values()].map((entry) => this.drainBackground(entry)));
    this.instances.clear();
  }
}
