import "./node-webcrypto.js";
import { buildVpsApp } from "./app.js";

const { app, context } = buildVpsApp({
  healthChecks: {
    storage: async () => ({ ok: true, mode: "memory" }),
    cache: async () => ({ ok: true, mode: "memory" }),
    queues: async () => ({ ok: true, mode: "memory" })
  }
});

await app.listen({ host: context.config.host, port: context.config.port });
context.logger.info?.(`OneUI VPS foundation listening on ${context.config.host}:${context.config.port}`);

const shutdown = async () => {
  await app.close();
  await context.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
