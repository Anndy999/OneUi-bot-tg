import { MemoryCache } from "./cache.js";
import { MemoryLockService } from "./locks.js";
import { createVpsQueues } from "./queue.js";
import { MemoryStorage } from "./storage.js";
import { createVpsConfig } from "../vps/config.js";

export function createVpsRuntimeContext({
  env = process.env,
  config = createVpsConfig(env),
  storage = new MemoryStorage(),
  cache = new MemoryCache(),
  locks = new MemoryLockService(),
  queues = createVpsQueues({ inMemory: true }),
  scheduler = null,
  logger = console,
  now = () => Date.now()
} = {}) {
  const background = new Set();
  return {
    env,
    config,
    storage,
    cache,
    locks,
    queues,
    scheduler,
    logger,
    now,
    waitUntil(promise) {
      let task;
      task = Promise.resolve(promise)
        .catch((error) => {
          logger?.error?.(`VPS background task failed: ${error?.message || error}`);
        })
        .finally(() => background.delete(task));
      background.add(task);
      return task;
    },
    pendingBackground() {
      return new Set(background);
    },
    async waitForBackground({ exclude = null } = {}) {
      const pending = [...background].filter((task) => !exclude?.has(task));
      await Promise.allSettled(pending);
    },
    async close() {
      await Promise.allSettled([...background]);
      const results = await Promise.allSettled([
        ...Object.values(queues).map((queue) => Promise.resolve().then(() => queue.close?.())),
        Promise.resolve().then(() => cache.close?.())
      ]);
      for (const result of results) {
        if (result.status === "rejected") logger?.warn?.(`VPS runtime shutdown warning: ${result.reason?.message || result.reason}`);
      }
    }
  };
}
