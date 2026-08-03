import { buildVpsApp } from "./app.js";
import { handleTelegramWebhook } from "../index.js";
import { createVpsProductionRuntime } from "./production.js";
import { startVpsWorkers } from "./workers.js";

const logger = console;
const runtime = await createVpsProductionRuntime({ logger });
const origin = runtime.config.publicBaseUrl || `http://${runtime.config.host}:${runtime.config.port}`;
let workers;
const { app } = buildVpsApp({
  env: runtime.env,
  context: runtime.context,
  logger,
  webhookHandler: async (update, context) => {
    const request = new Request(`${origin}/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update)
    });
    const response = await handleTelegramWebhook(request, runtime.env, origin, context);
    return response.json();
  },
  healthChecks: {
    storage: () => runtime.health(),
    cache: async () => ({ ok: (await runtime.redis.ping()) === "PONG" }),
    queues: async () => ({ ok: true }),
    telegramPolling: () => workers?.pollingStatus?.() || { ok: false, state: "starting" }
  }
});
workers = startVpsWorkers({ runtime, origin, logger });

await app.listen({ host: runtime.config.host, port: runtime.config.port });
logger.info?.(`OneUI VPS production server listening on ${runtime.config.host}:${runtime.config.port}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close().catch(() => {});
  await workers.close().catch(() => {});
  await runtime.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
