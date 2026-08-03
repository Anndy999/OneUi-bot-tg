import { Pool } from "pg";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { createVpsRuntimeContext } from "../runtime/context.js";
import { PostgresStorage } from "../runtime/storage.js";
import { PostgresJsonStorage, PersistentNamespace } from "../runtime/postgres.js";
import { RedisCache } from "../runtime/cache.js";
import { RedisLockService } from "../runtime/locks.js";
import { createVpsQueues } from "../runtime/queue.js";
import { MonitorScheduler } from "../monitor-scheduler.js";
import { FirmwareQueryCoordinator } from "../firmware-query-coordinator.js";
import { createVpsConfig, telegramSendAllowed } from "./config.js";

function required(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${name} is required for VPS production runtime`);
  return result;
}

function safeLogger(logger = console) {
  return {
    info: (...args) => logger.info?.(...args),
    warn: (...args) => logger.warn?.(...args),
    error: (...args) => logger.error?.(...args),
    debug: (...args) => logger.debug?.(...args)
  };
}

function redisOptions(redisUrl) {
  const url = new URL(redisUrl);
  const options = { host: url.hostname, port: Number(url.port || 6379), lazyConnect: true, maxRetriesPerRequest: 3, enableOfflineQueue: false };
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  if (url.pathname.length > 1) options.db = Number(url.pathname.slice(1)) || 0;
  if (url.protocol === "rediss:") options.tls = {};
  return options;
}

function queueOptions(data) {
  const id = String(data?.id || "").trim();
  return {
    jobId: id || undefined,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 }
  };
}

export function validateVpsProductionEnv(env = process.env) {
  const config = createVpsConfig(env);
  required(config.databaseUrl, "DATABASE_URL");
  required(config.redisUrl, "REDIS_URL");
  required(config.webhookSecret, "WEBHOOK_SECRET");
  required(config.internalApiSecret, "INTERNAL_API_SECRET");
  if (config.telegramPollingEnabled && (config.shadowMode || !config.telegramSendEnabled)) {
    throw new Error("TELEGRAM_POLLING_ENABLED requires VPS_SHADOW_MODE=false and TELEGRAM_SEND_ENABLED=true");
  }
  if ((!config.shadowMode && config.telegramSendEnabled) || config.telegramPollingEnabled) required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
  return config;
}

export function createPersistentQueueBinding(queue) {
  return {
    async send(data) {
      return queue.add("oneui", data, queueOptions(data));
    }
  };
}

export async function createVpsProductionRuntime({ env = process.env, logger = console } = {}) {
  const config = validateVpsProductionEnv(env);
  const log = safeLogger(logger);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: Math.max(2, Math.min(50, Number(env.PG_POOL_MAX || 10))),
    application_name: "oneui-firmware-worker-vps"
  });
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    retryStrategy: () => null,
    connectionName: "oneui-firmware-worker-vps"
  });
  redis.on("error", (error) => log.warn?.(`VPS Redis connection error: ${error.message}`));
  try {
    await Promise.all([pool.query("SELECT 1"), redis.connect()]);
  } catch {
    redis.disconnect();
    await pool.end().catch(() => {});
    throw new Error("VPS PostgreSQL and Redis dependencies are unavailable");
  }
  const kv = new PostgresStorage(pool);
  const queues = createVpsQueues({ Queue, connection: redisOptions(config.redisUrl), prefix: config.queuePrefix });
  for (const queue of Object.values(queues)) { queue.queue.on?.("error", (error) => log.warn?.(`VPS BullMQ queue error: ${error.message}`)); queue.queue.connection?.on?.("error", (error) => log.warn?.(`VPS BullMQ connection error: ${error.message}`)); }

  let workerEnv;
  const monitorNamespace = new PersistentNamespace({
    pool,
    namespace: "monitor-scheduler",
    logger: log,
    createInstance: (ctx) => new MonitorScheduler(ctx, workerEnv)
  });
  const coordinatorNamespace = new PersistentNamespace({
    pool,
    namespace: "firmware-query-coordinator",
    logger: log,
    createInstance: (ctx) => new FirmwareQueryCoordinator(ctx, workerEnv)
  });

  const context = createVpsRuntimeContext({
    env: {},
    config,
    storage: kv,
    cache: new RedisCache(redis),
    locks: new RedisLockService(redis),
    queues,
    logger: log
  });

  workerEnv = {
    ...env,
    VPS_SHADOW_MODE: String(config.shadowMode),
    TELEGRAM_SEND_ENABLED: String(config.telegramSendEnabled),
    MONITOR_NOTIFICATIONS_ENABLED: String(config.monitorNotificationsEnabled),
    TELEGRAM_BOT_TOKEN: telegramSendAllowed(config) ? String(env.TELEGRAM_BOT_TOKEN || "") : "",
    TELEGRAM_COMMAND_SYNC_ENABLED: "false",
    TELEGRAM_WEBHOOK_AUTOFIX_ENABLED: "false",
    FIRMWARE_KV: kv,
    MONITOR_SCHEDULER: monitorNamespace,
    FIRMWARE_QUERY_COORDINATOR: coordinatorNamespace,
    NOTIFICATION_QUEUE: createPersistentQueueBinding(queues["notification-delivery"]),
    TELEGRAM_UPDATE_QUEUE: createPersistentQueueBinding(queues["telegram-update"]),
    MONITOR_SCHEDULER_ENABLED: "true",
    QUERY_COORDINATOR_ENABLED: "true",
    NOTIFICATION_QUEUE_ENABLED: "true"
  };
  context.env = workerEnv;

  let closed = false;
  return {
    config,
    env: workerEnv,
    context,
    pool,
    redis,
    queues,
    monitorNamespace,
    coordinatorNamespace,
    async health() {
      if (closed) throw new Error("VPS runtime is closed");
      await pool.query("SELECT 1 AS ok");
      const redisStatus = await redis.ping();
      if (redisStatus !== "PONG") throw new Error("Redis ping failed");
      const counts = await queues["notification-delivery"].queue.getJobCounts("waiting", "active", "failed");
      return { ok: true, postgres: true, redis: true, notificationQueue: counts };
    },
    async runAlarms() {
      await monitorNamespace.runAlarms();
      await coordinatorNamespace.runAlarms();
    },
    async close() {
      if (closed) return;
      closed = true;
      await context.close().catch(() => {});
      await monitorNamespace.close().catch(() => {});
      await coordinatorNamespace.close().catch(() => {});
      redis.disconnect();
      await pool.end();
    }
  };
}
