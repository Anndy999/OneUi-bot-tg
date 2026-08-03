import { Worker } from "bullmq";
import Redis from "ioredis";
import { processTelegramUpdate } from "../index.js";
import { processMonitorQueueMessage, runScheduledTasks } from "../monitor.js";
import { processNotificationQueue } from "../notification-queue.js";
import { createVpsProductionRuntime } from "./production.js";
import { startTelegramPolling } from "./telegram-polling.js";

function retryableQueueMessage(data) {
  let action = "pending";
  let delaySeconds = 30;
  return {
    message: {
      body: data,
      ack() { action = "ack"; },
      retry(options = {}) {
        action = "retry";
        delaySeconds = Math.max(1, Number(options.delaySeconds || 30));
      }
    },
    get action() { return action; },
    get delaySeconds() { return delaySeconds; }
  };
}

async function processNotificationJob(job, runtime) {
  const data = job.data || {};
  if (data.kind === "monitor_check") {
    return processMonitorQueueMessage(runtime.env, data);
  }
  const state = retryableQueueMessage(data);
  await processNotificationQueue({ messages: [state.message] }, runtime.env);
  if (state.action === "retry") throw new Error(`Notification delivery requested retry after ${state.delaySeconds}s`);
  if (state.action !== "ack") throw new Error("Notification delivery did not acknowledge the job");
  return { ok: true };
}

async function processTelegramJob(job, runtime, origin) {
  const data = job.data || {};
  const update = data.update || data;
  await processTelegramUpdate(update, runtime.env, origin, runtime.context);
  await runtime.context.waitForBackground();
  return { ok: true };
}

async function processMonitorJob(job, runtime) {
  return processMonitorQueueMessage(runtime.env, job.data || {});
}

function processorFor(name, runtime, origin) {
  if (name === "telegram-update") return (job) => processTelegramJob(job, runtime, origin);
  if (name === "notification-delivery") return (job) => processNotificationJob(job, runtime);
  if (name === "monitor-check") return (job) => processMonitorJob(job, runtime);
  if (name === "firmware-query") return async () => ({ ok: true, skipped: true, reason: "query queue has no producer" });
  if (name === "maintenance") return async () => runtime.runAlarms();
  throw new Error(`Unsupported VPS worker queue: ${name}`);
}

export function startVpsWorkers({ runtime, origin = "", logger = console } = {}) {
  if (!runtime?.config?.redisUrl) throw new Error("VPS runtime with REDIS_URL is required");
  const connection = new Redis(runtime.config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    connectionName: "oneui-firmware-worker-vps-workers"
  });
  connection.on("error", (error) => logger.warn?.(`VPS worker Redis connection error: ${error.message}`));
  /* worker connection listener is installed before Worker construction. */
  const workerConnection = connection;
  const names = ["telegram-update", "notification-delivery", "monitor-check", "firmware-query", "maintenance"];
  const workers = names.map((name) => new Worker(
    name,
    processorFor(name, runtime, origin),
    {
      connection: workerConnection,
      prefix: runtime.config.queuePrefix,
      concurrency: name === "telegram-update" ? 2 : name === "notification-delivery" ? 4 : 2
    }
  ));
  for (const worker of workers) {
    worker.on("error", (error) => logger.error?.(`VPS worker error: ${error.message}`));
  }

  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runtime.runAlarms();
      await runScheduledTasks(runtime.env);
    } catch (error) {
      logger.error?.(`VPS scheduled task failed: ${error.message}`);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(tick, runtime.config.scheduleIntervalMs);
  timer.unref?.();
  void tick();
  const telegramPolling = runtime.config.telegramPollingEnabled
    ? startTelegramPolling({
      token: runtime.env.TELEGRAM_BOT_TOKEN,
      queue: runtime.env.TELEGRAM_UPDATE_QUEUE,
      storage: runtime.context.storage,
      logger,
      timeoutSeconds: runtime.config.telegramPollingTimeoutSeconds
    })
    : null;

  return {
    workers,
    async close() {
      clearInterval(timer);
      await telegramPolling?.close();
      await Promise.all(workers.map((worker) => worker.close()));
      connection.disconnect();
    }
  };
}

export async function runVpsWorkerProcess({ env = process.env, logger = console } = {}) {
  const runtime = await createVpsProductionRuntime({ env, logger });
  const workers = startVpsWorkers({
    runtime,
    origin: runtime.config.publicBaseUrl,
    logger
  });
  const shutdown = async () => {
    await workers.close().catch(() => {});
    await runtime.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { runtime, workers, shutdown };
}
