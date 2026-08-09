import { Worker } from "bullmq";
import Redis from "ioredis";
import { ensureTelegramCommands, processTelegramUpdate } from "../index.js";
import { processMonitorQueueMessage, runScheduledTasks } from "../monitor.js";
import { processNotificationQueue } from "../notification-queue.js";
import { chatIdFromUpdate } from "../telegram.js";
import { createVpsProductionRuntime } from "./production.js";
import { startTelegramPolling } from "./telegram-polling.js";
import {
  bootstrapTestFirmwarePipeline,
  handleTestFirmwareTelegramCallback,
  handleTestFirmwareTelegramCommand,
  maybeScheduleTestFirmwareScan,
  processTestFirmwareMaintenanceJob
} from "./test-firmware-scan.js";
import { broadcastTestingApologyToAllowedUsers } from "./testing-notice.js";

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

async function bootstrapTestFirmwareWithRetry(runtime, logger) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await bootstrapTestFirmwarePipeline(runtime, logger);
      if (result.queued || !["enqueue_failed"].includes(result.reason)) return result;
      if (attempt === 3) return result;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (error) {
      logger.warn?.(`VPS test firmware startup attempt ${attempt}/3 failed: ${error.message}`);
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  return { queued: false, reason: "startup_retry_exhausted" };
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

const telegramChatTails = new Map();

export async function withTelegramChatOrder(chatId, task) {
  if (typeof task !== "function") throw new TypeError("Telegram chat task is required");
  const key = String(chatId || "unknown");
  const previous = telegramChatTails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  telegramChatTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (telegramChatTails.get(key) === current) telegramChatTails.delete(key);
  }
}

async function processTelegramJob(job, runtime, origin) {
  const data = job.data || {};
  const update = data.update || data;
  const chatId = String(chatIdFromUpdate(update) || `update:${update?.update_id || job.id}`);
  return withTelegramChatOrder(chatId, async () => {
    if (await handleTestFirmwareTelegramCallback(update, runtime)) {
      return { ok: true, handled: "test-firmware-callback" };
    }
    if (await handleTestFirmwareTelegramCommand(update, runtime)) {
      return { ok: true, handled: "test-firmware-command" };
    }
    const pendingBefore = runtime.context.pendingBackground?.() || new Set();
    await processTelegramUpdate(update, runtime.env, origin, runtime.context);
    await runtime.context.waitForBackground({ exclude: pendingBefore });
    return { ok: true };
  });
}

async function processMaintenanceJob(job, runtime) {
  const testFirmwareResult = await processTestFirmwareMaintenanceJob(job, runtime);
  if (testFirmwareResult) return testFirmwareResult;
  return runtime.runAlarms();
}

async function processMonitorJob(job, runtime) {
  return processMonitorQueueMessage(runtime.env, job.data || {});
}

function processorFor(name, runtime, origin) {
  if (name === "telegram-update") return (job) => processTelegramJob(job, runtime, origin);
  if (name === "notification-delivery") return (job) => processNotificationJob(job, runtime);
  if (name === "monitor-check") return (job) => processMonitorJob(job, runtime);
  if (name === "firmware-query") return async () => ({ ok: true, skipped: true, reason: "query queue has no producer" });
  if (name === "maintenance") return (job) => processMaintenanceJob(job, runtime);
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
      concurrency: name === "telegram-update"
        ? runtime.config.telegramWorkerConcurrency
        : name === "notification-delivery"
          ? runtime.config.notificationWorkerConcurrency
          : name === "monitor-check"
            ? runtime.config.monitorWorkerConcurrency
            : 1
    }
  ));
  for (const worker of workers) {
    worker.on("error", (error) => logger.error?.(`VPS worker error: ${error.message}`));
  }

  let ticking = false;
  let scheduleStartedAt = 0;
  let scheduleLastSuccessAt = 0;
  let scheduleLastFailureAt = 0;
  let scheduleLastError = "";
  let tickPromise = null;
  const tick = () => {
    if (tickPromise) return tickPromise;
    ticking = true;
    scheduleStartedAt = Date.now();
    tickPromise = (async () => {
      let tickError = null;
      try {
        await runtime.runAlarms();
        await runScheduledTasks(runtime.env);
      } catch (error) {
        tickError = error;
        scheduleLastFailureAt = Date.now();
        scheduleLastError = String(error?.message || error || "scheduled task failed").slice(0, 240);
        logger.error?.(`VPS scheduled task failed: ${error.message}`);
      }
      // Keep the fixed-time test-build scan independent from the legacy alarm
      // path. A transient monitor/alarm error must not make the 18:00 claim
      // disappear for the entire day.
      try {
        await maybeScheduleTestFirmwareScan(runtime);
      } catch (error) {
        if (!tickError) {
          tickError = error;
          scheduleLastFailureAt = Date.now();
          scheduleLastError = String(error?.message || error || "test firmware schedule failed").slice(0, 240);
          logger.error?.(`VPS test firmware schedule failed: ${error.message}`);
        } else {
          logger.warn?.(`VPS test firmware schedule skipped after scheduler error: ${error.message}`);
        }
      }
      if (!tickError) {
        scheduleLastSuccessAt = Date.now();
        scheduleLastError = "";
      }
      try {
        return undefined;
      } finally {
        ticking = false;
        scheduleStartedAt = 0;
        tickPromise = null;
      }
    })();
    return tickPromise;
  };
  const timer = setInterval(tick, runtime.config.scheduleIntervalMs);
  timer.unref?.();
  void bootstrapTestFirmwareWithRetry(runtime, logger).catch((error) => {
    logger.error?.(`VPS test firmware startup pipeline failed: ${error.message}`);
  });
  void broadcastTestingApologyToAllowedUsers(runtime, logger).catch((error) => {
    logger.warn?.(`VPS testing apology notice failed: ${error.message}`);
  });
  void ensureTelegramCommands(runtime.env).catch((error) => {
    logger.warn?.(`VPS Telegram shortcut command sync failed: ${error.message}`);
  });
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

  let restartRequested = false;
  let forcedExitTimer = null;
  const requestRestart = (reason) => {
    if (restartRequested) return;
    restartRequested = true;
    logger.error?.(`${reason}; asking systemd to restart the VPS bot`);
    process.exitCode = 1;
    forcedExitTimer = setTimeout(() => process.exit(1), 15_000);
    forcedExitTimer.unref?.();
    process.kill(process.pid, "SIGTERM");
  };
  const watchdogTimer = setInterval(() => {
    const status = telegramPolling?.status?.();
    if (status && !status.ok && !status.fatalFailure) {
      const lastActivityAt = Number(status.lastActivityAt || status.startedAt || 0);
      const staleAfterMs = Math.max(90_000, Number(status.staleAfterMs || 180_000));
      if (lastActivityAt && Date.now() - lastActivityAt > staleAfterMs) {
        requestRestart("Telegram polling is stale");
        return;
      }
    }
    if (ticking && scheduleStartedAt && Date.now() - scheduleStartedAt > runtime.config.scheduleStaleMs) {
      requestRestart("VPS scheduled task loop is stale");
    }
  }, 30_000);
  watchdogTimer.unref?.();

  return {
    workers,
    pollingStatus() {
      return telegramPolling?.status?.() || { ok: true, state: "disabled" };
    },
    schedulerStatus() {
      const now = Date.now();
      const stale = Boolean(ticking && scheduleStartedAt && now - scheduleStartedAt > runtime.config.scheduleStaleMs);
      const failed = scheduleLastFailureAt > scheduleLastSuccessAt;
      return {
        ok: !stale && !failed,
        state: stale ? "stale" : ticking ? "running" : failed ? "retrying" : scheduleLastSuccessAt ? "healthy" : "starting",
        running: ticking,
        startedAt: scheduleStartedAt || undefined,
        lastSuccessAt: scheduleLastSuccessAt || undefined,
        lastFailureAt: scheduleLastFailureAt || undefined,
        lastError: scheduleLastError || undefined,
        staleAfterMs: runtime.config.scheduleStaleMs
      };
    },
    queueStatus() {
      const workerStates = workers.map((worker) => ({
        name: worker.name,
        running: typeof worker.isRunning === "function" ? worker.isRunning() : true
      }));
      const redisReady = workerConnection.status === "ready";
      return {
        ok: redisReady && workerStates.every((worker) => worker.running),
        redis: workerConnection.status,
        workers: workerStates
      };
    },
    async close() {
      clearInterval(timer);
      clearInterval(watchdogTimer);
      if (forcedExitTimer && !restartRequested) clearTimeout(forcedExitTimer);
      await tickPromise?.catch(() => {});
      const results = await Promise.allSettled([
        Promise.resolve().then(() => telegramPolling?.close()),
        ...workers.map((worker) => Promise.resolve().then(() => worker.close()))
      ]);
      connection.disconnect();
      for (const result of results) {
        if (result.status === "rejected") logger.warn?.(`VPS worker shutdown warning: ${result.reason?.message || result.reason}`);
      }
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
