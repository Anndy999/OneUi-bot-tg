const DAY_MS = 24 * 60 * 60 * 1000;
const PIPELINE_ID = "s948n-koo-to-s948b-eux";

function targetParts(model, csc) {
  return [String(model || "").trim().toUpperCase(), String(csc || "").trim().toUpperCase()];
}

function hashParts(hashType, hashValue) {
  const type = String(hashType || "").trim().toLowerCase();
  const value = String(hashValue || "").trim().toLowerCase();
  if (!type || !value) throw new Error("Test firmware hash is required");
  return [type, value];
}

function clone(value) {
  return value && typeof value === "object" ? structuredClone(value) : value;
}

function rowKey(model, csc, hashType, hashValue) {
  const [m, c] = targetParts(model, csc);
  const [type, value] = hashParts(hashType, hashValue);
  return `${m}:${c}:${type}:${value}`;
}

function normalizeHistoryRow(row = {}) {
  const [model, csc] = targetParts(row.model, row.csc);
  const [hashType, hashValue] = hashParts(row.hash_type ?? row.hashType, row.hash_value ?? row.hashValue);
  return {
    model,
    csc,
    hashType,
    hashValue,
    pda: String(row.pda || ""),
    cscBuild: String(row.csc_build ?? row.cscBuild ?? ""),
    cp: String(row.cp || ""),
    decryptStatus: String(row.decrypt_status ?? row.decryptStatus ?? "unresolved"),
    reason: String(row.reason || ""),
    firstSeenAt: String(row.first_seen_at ?? row.firstSeenAt ?? ""),
    lastSeenAt: String(row.last_seen_at ?? row.lastSeenAt ?? ""),
    notifiedAt: String(row.notified_at ?? row.notifiedAt ?? ""),
    adminWarningAt: String(row.admin_warning_at ?? row.adminWarningAt ?? ""),
    source: String(row.source || ""),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? "")
  };
}

function normalizePipelineState(row = {}) {
  return {
    pipelineId: String(row.pipeline_id ?? row.pipelineId ?? PIPELINE_ID),
    startupScanId: String(row.startup_scan_id ?? row.startupScanId ?? ""),
    kooConfirmedVersion: String(row.koo_confirmed_version ?? row.kooConfirmedVersion ?? ""),
    kooConfirmedAt: String(row.koo_confirmed_at ?? row.kooConfirmedAt ?? ""),
    kooConfirmedBy: String(row.koo_confirmed_by ?? row.kooConfirmedBy ?? ""),
    euxEnabled: Boolean(row.eux_enabled ?? row.euxEnabled),
    euxEnabledAt: String(row.eux_enabled_at ?? row.euxEnabledAt ?? ""),
    euxEnabledBy: String(row.eux_enabled_by ?? row.euxEnabledBy ?? ""),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? "")
  };
}

export class InMemoryTestFirmwareHistoryRepository {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.history = new Map();
    this.targets = new Map();
    this.scanRuns = new Map();
    this.dailyCleanup = new Set();
    this.pipeline = normalizePipelineState({ pipelineId: PIPELINE_ID });
  }

  async listHashes(model, csc) {
    const [m, c] = targetParts(model, csc);
    return [...this.history.values()]
      .filter((row) => row.model === m && row.csc === c)
      .map(clone);
  }

  async upsertUnresolved(value) {
    const now = new Date(this.now()).toISOString();
    const normalized = normalizeHistoryRow({ ...value, decryptStatus: "unresolved" });
    const key = rowKey(normalized.model, normalized.csc, normalized.hashType, normalized.hashValue);
    const current = this.history.get(key);
    const row = {
      ...current,
      ...normalized,
      model: normalized.model,
      csc: normalized.csc,
      hashType: normalized.hashType,
      hashValue: normalized.hashValue,
      decryptStatus: current?.decryptStatus === "resolved" ? "resolved" : "unresolved",
      firstSeenAt: current?.firstSeenAt || now,
      lastSeenAt: now,
      createdAt: current?.createdAt || now,
      updatedAt: now,
      notifiedAt: current?.notifiedAt || "",
      adminWarningAt: current?.adminWarningAt || ""
    };
    this.history.set(key, row);
    return clone(row);
  }

  async upsertResolved(value) {
    const now = new Date(this.now()).toISOString();
    const normalized = normalizeHistoryRow({ ...value, decryptStatus: "resolved" });
    const key = rowKey(normalized.model, normalized.csc, normalized.hashType, normalized.hashValue);
    const current = this.history.get(key);
    const row = {
      ...current,
      ...normalized,
      decryptStatus: "resolved",
      firstSeenAt: current?.firstSeenAt || now,
      lastSeenAt: now,
      createdAt: current?.createdAt || now,
      updatedAt: now,
      notifiedAt: current?.notifiedAt || "",
      adminWarningAt: current?.adminWarningAt || ""
    };
    this.history.set(key, row);
    return clone(row);
  }

  async markNotified(model, csc, hashType, hashValue, at = new Date(this.now()).toISOString()) {
    const row = this.history.get(rowKey(model, csc, hashType, hashValue));
    if (!row || row.notifiedAt) return false;
    row.notifiedAt = String(at);
    row.updatedAt = String(at);
    return true;
  }

  async markAdminWarning(model, csc, hashType, hashValue, at = new Date(this.now()).toISOString()) {
    const row = this.history.get(rowKey(model, csc, hashType, hashValue));
    if (!row || row.adminWarningAt) return false;
    row.adminWarningAt = String(at);
    row.updatedAt = String(at);
    return true;
  }

  async recordTargetCheck(model, csc, result = {}, at = new Date(this.now()).toISOString()) {
    const [m, c] = targetParts(model, csc);
    this.targets.set(`${m}:${c}`, {
      model: m,
      csc: c,
      lastCheckedAt: String(at),
      lastStatus: String(result.status || "unknown"),
      lastError: String(result.error || ""),
      hashCount: Number(result.hashCount || 0),
      newHashCount: Number(result.newHashCount || 0),
      updatedAt: String(at)
    });
  }

  async claimScheduled(dateKey, at = new Date(this.now()).toISOString()) {
    const key = `scheduled:${String(dateKey)}`;
    if (this.scanRuns.has(key)) return { claimed: false, reason: "already_claimed" };
    const row = { scanType: "scheduled", dateKey: String(dateKey), status: "running", startedAt: String(at), updatedAt: String(at) };
    this.scanRuns.set(key, row);
    return { claimed: true, row: clone(row) };
  }

  async finishScheduled(dateKey, status, error = "", at = new Date(this.now()).toISOString()) {
    const key = `scheduled:${String(dateKey)}`;
    const row = this.scanRuns.get(key);
    if (!row) return false;
    row.status = String(status);
    row.error = String(error || "");
    row.completedAt = String(at);
    row.updatedAt = String(at);
    return true;
  }

  async claimDailyCleanup(dateKey) {
    const key = String(dateKey);
    if (this.dailyCleanup.has(key)) return false;
    this.dailyCleanup.add(key);
    return true;
  }

  async cleanupTransient() {
    return 0;
  }

  async getPipelineState() {
    return clone(this.pipeline);
  }

  async claimStartupScan(scanId, at = new Date(this.now()).toISOString()) {
    const id = String(scanId || "").trim();
    if (!id || this.pipeline.startupScanId === id) return false;
    this.pipeline.startupScanId = id;
    this.pipeline.updatedAt = String(at);
    return true;
  }

  async releaseStartupScan(scanId, at = new Date(this.now()).toISOString()) {
    if (this.pipeline.startupScanId !== String(scanId || "").trim()) return false;
    this.pipeline.startupScanId = "";
    this.pipeline.updatedAt = String(at);
    return true;
  }

  async confirmKooAndEnableEux(version, chatId, at = new Date(this.now()).toISOString()) {
    const timestamp = String(at);
    this.pipeline.kooConfirmedVersion = String(version || "");
    this.pipeline.kooConfirmedAt = timestamp;
    this.pipeline.kooConfirmedBy = String(chatId || "");
    this.pipeline.euxEnabled = true;
    this.pipeline.euxEnabledAt = timestamp;
    this.pipeline.euxEnabledBy = String(chatId || "");
    this.pipeline.updatedAt = timestamp;
    return clone(this.pipeline);
  }

  snapshot() {
    return {
      history: [...this.history.values()].map(clone),
      targets: [...this.targets.values()].map(clone),
      scanRuns: [...this.scanRuns.values()].map(clone)
    };
  }
}

export class PostgresTestFirmwareHistoryRepository {
  constructor(pool) {
    if (!pool?.query) throw new TypeError("Postgres test firmware history requires a pg pool");
    this.pool = pool;
  }

  async listHashes(model, csc) {
    const [m, c] = targetParts(model, csc);
    const result = await this.pool.query(
      `SELECT model, csc, hash_type, hash_value, pda, csc_build, cp,
              decrypt_status, reason, first_seen_at, last_seen_at,
              notified_at, admin_warning_at, source, created_at, updated_at
         FROM test_firmware_build_history
        WHERE model = $1 AND csc = $2
        ORDER BY first_seen_at ASC`,
      [m, c]
    );
    return result.rows.map(normalizeHistoryRow);
  }

  async upsertUnresolved(value) {
    const [model, csc] = targetParts(value.model, value.csc);
    const [hashType, hashValue] = hashParts(value.hashType ?? value.hash_type, value.hashValue ?? value.hash_value);
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO test_firmware_build_history
        (model, csc, hash_type, hash_value, pda, csc_build, cp,
         decrypt_status, reason, first_seen_at, last_seen_at, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '', '', '', 'unresolved', $5, $6, $6, $7, $6, $6)
       ON CONFLICT (model, csc, hash_type, hash_value) DO UPDATE SET
         last_seen_at = EXCLUDED.last_seen_at,
         reason = CASE WHEN test_firmware_build_history.decrypt_status = 'resolved'
                       THEN test_firmware_build_history.reason ELSE EXCLUDED.reason END,
         decrypt_status = CASE WHEN test_firmware_build_history.decrypt_status = 'resolved'
                               THEN 'resolved' ELSE 'unresolved' END,
         source = COALESCE(NULLIF(EXCLUDED.source, ''), test_firmware_build_history.source),
         updated_at = EXCLUDED.updated_at
       RETURNING model, csc, hash_type, hash_value, pda, csc_build, cp,
                 decrypt_status, reason, first_seen_at, last_seen_at,
                 notified_at, admin_warning_at, source, created_at, updated_at`,
      [model, csc, hashType, hashValue, String(value.reason || ""), now, String(value.source || "")]
    );
    return normalizeHistoryRow(result.rows[0]);
  }

  async upsertResolved(value) {
    const [model, csc] = targetParts(value.model, value.csc);
    const [hashType, hashValue] = hashParts(value.hashType ?? value.hash_type, value.hashValue ?? value.hash_value);
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO test_firmware_build_history
        (model, csc, hash_type, hash_value, pda, csc_build, cp,
         decrypt_status, reason, first_seen_at, last_seen_at, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'resolved', '', $8, $8, $9, $8, $8)
       ON CONFLICT (model, csc, hash_type, hash_value) DO UPDATE SET
         pda = EXCLUDED.pda,
         csc_build = EXCLUDED.csc_build,
         cp = EXCLUDED.cp,
         decrypt_status = 'resolved',
         reason = '',
         last_seen_at = EXCLUDED.last_seen_at,
         source = EXCLUDED.source,
         updated_at = EXCLUDED.updated_at
       RETURNING model, csc, hash_type, hash_value, pda, csc_build, cp,
                 decrypt_status, reason, first_seen_at, last_seen_at,
                 notified_at, admin_warning_at, source, created_at, updated_at`,
      [model, csc, hashType, hashValue, String(value.pda || ""), String(value.cscBuild ?? value.csc_build ?? ""), String(value.cp || ""), now, String(value.source || "")]
    );
    return normalizeHistoryRow(result.rows[0]);
  }

  async markNotified(model, csc, hashType, hashValue, at = new Date().toISOString()) {
    const [m, c] = targetParts(model, csc);
    const [type, value] = hashParts(hashType, hashValue);
    const result = await this.pool.query(
      `UPDATE test_firmware_build_history
          SET notified_at = COALESCE(notified_at, $5), updated_at = $5
        WHERE model = $1 AND csc = $2 AND hash_type = $3 AND hash_value = $4
          AND notified_at IS NULL`,
      [m, c, type, value, String(at)]
    );
    return (result.rowCount || 0) > 0;
  }

  async markAdminWarning(model, csc, hashType, hashValue, at = new Date().toISOString()) {
    const [m, c] = targetParts(model, csc);
    const [type, value] = hashParts(hashType, hashValue);
    const result = await this.pool.query(
      `UPDATE test_firmware_build_history
          SET admin_warning_at = COALESCE(admin_warning_at, $5), updated_at = $5
        WHERE model = $1 AND csc = $2 AND hash_type = $3 AND hash_value = $4
          AND admin_warning_at IS NULL`,
      [m, c, type, value, String(at)]
    );
    return (result.rowCount || 0) > 0;
  }

  async recordTargetCheck(model, csc, result = {}, at = new Date().toISOString()) {
    const [m, c] = targetParts(model, csc);
    await this.pool.query(
      `INSERT INTO test_firmware_target_state
        (model, csc, last_checked_at, last_status, last_error, hash_count, new_hash_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $3)
       ON CONFLICT (model, csc) DO UPDATE SET
         last_checked_at = EXCLUDED.last_checked_at,
         last_status = EXCLUDED.last_status,
         last_error = EXCLUDED.last_error,
         hash_count = EXCLUDED.hash_count,
         new_hash_count = EXCLUDED.new_hash_count,
         updated_at = EXCLUDED.updated_at`,
      [m, c, String(at), String(result.status || "unknown"), String(result.error || ""), Number(result.hashCount || 0), Number(result.newHashCount || 0)]
    );
  }

  async claimScheduled(dateKey, at = new Date().toISOString()) {
    const result = await this.pool.query(
      `INSERT INTO test_firmware_scan_runs
        (scan_type, scan_date, status, started_at, updated_at)
       VALUES ('scheduled', $1::date, 'running', $2, $2)
       ON CONFLICT (scan_type, scan_date) DO NOTHING
       RETURNING scan_type, scan_date, status, started_at, updated_at`,
      [String(dateKey), String(at)]
    );
    return result.rowCount ? { claimed: true, row: result.rows[0] } : { claimed: false, reason: "already_claimed" };
  }

  async finishScheduled(dateKey, status, error = "", at = new Date().toISOString()) {
    const result = await this.pool.query(
      `UPDATE test_firmware_scan_runs
          SET status = $2, error = $3, completed_at = $4, updated_at = $4
        WHERE scan_type = 'scheduled' AND scan_date = $1::date`,
      [String(dateKey), String(status), String(error || ""), String(at)]
    );
    return (result.rowCount || 0) > 0;
  }

  async claimDailyCleanup(dateKey) {
    const result = await this.pool.query(
      `INSERT INTO test_firmware_daily_cache (cache_date, cleanup_completed_at)
       VALUES ($1::date, now())
       ON CONFLICT (cache_date) DO NOTHING
       RETURNING cache_date`,
      [String(dateKey)]
    );
    return Boolean(result.rowCount);
  }

  async cleanupTransient(dateKey, retentionDays = 90) {
    const date = new Date(`${String(dateKey)}T00:00:00+08:00`);
    const cutoff = new Date(date.getTime() - Math.max(7, Number(retentionDays) || 90) * DAY_MS).toISOString().slice(0, 10);
    const result = await this.pool.query(
      `DELETE FROM test_firmware_daily_cache WHERE cache_date < $1::date;
       DELETE FROM test_firmware_scan_runs WHERE scan_date < $1::date`,
      [cutoff]
    );
    return result;
  }

  async getPipelineState() {
    const result = await this.pool.query(
      `SELECT pipeline_id, startup_scan_id, koo_confirmed_version,
              koo_confirmed_at, koo_confirmed_by, eux_enabled,
              eux_enabled_at, eux_enabled_by, updated_at
         FROM test_firmware_pipeline_state
        WHERE pipeline_id = $1`,
      [PIPELINE_ID]
    );
    return normalizePipelineState(result.rows[0] || { pipelineId: PIPELINE_ID });
  }

  async claimStartupScan(scanId, at = new Date().toISOString()) {
    const id = String(scanId || "").trim();
    if (!id) return false;
    await this.pool.query(
      `INSERT INTO test_firmware_pipeline_state (pipeline_id)
       VALUES ($1)
       ON CONFLICT (pipeline_id) DO NOTHING`,
      [PIPELINE_ID]
    );
    const result = await this.pool.query(
      `UPDATE test_firmware_pipeline_state
          SET startup_scan_id = $2, updated_at = $3
        WHERE pipeline_id = $1
          AND startup_scan_id IS DISTINCT FROM $2
        RETURNING pipeline_id`,
      [PIPELINE_ID, id, String(at)]
    );
    return Boolean(result.rowCount);
  }

  async releaseStartupScan(scanId, at = new Date().toISOString()) {
    const result = await this.pool.query(
      `UPDATE test_firmware_pipeline_state
          SET startup_scan_id = '', updated_at = $3
        WHERE pipeline_id = $1 AND startup_scan_id = $2`,
      [PIPELINE_ID, String(scanId || ""), String(at)]
    );
    return Boolean(result.rowCount);
  }

  async confirmKooAndEnableEux(version, chatId, at = new Date().toISOString()) {
    const result = await this.pool.query(
      `UPDATE test_firmware_pipeline_state
          SET koo_confirmed_version = $2,
              koo_confirmed_at = $3,
              koo_confirmed_by = $4,
              eux_enabled = TRUE,
              eux_enabled_at = $3,
              eux_enabled_by = $4,
              updated_at = $3
        WHERE pipeline_id = $1
        RETURNING pipeline_id, startup_scan_id, koo_confirmed_version,
                  koo_confirmed_at, koo_confirmed_by, eux_enabled,
                  eux_enabled_at, eux_enabled_by, updated_at`,
      [PIPELINE_ID, String(version || ""), String(at), String(chatId || "")]
    );
    return normalizePipelineState(result.rows[0] || { pipelineId: PIPELINE_ID });
  }
}

export function createTestFirmwareHistoryRepository(pool) {
  return pool?.query ? new PostgresTestFirmwareHistoryRepository(pool) : new InMemoryTestFirmwareHistoryRepository();
}

export { DAY_MS, PIPELINE_ID, normalizeHistoryRow, normalizePipelineState, rowKey };
