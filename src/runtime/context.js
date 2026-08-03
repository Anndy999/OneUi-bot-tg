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
      const task = Promise.resolve(promise).finally(() => background.delete(task));
      background.add(task);
      return task;
    },
    async waitForBackground() {
      await Promise.allSettled([...background]);
    },
    async close() {
      await Promise.all(Object.values(queues).map((queue) => queue.close?.() || undefined));
      await cache.close?.();
    }
  };
}
