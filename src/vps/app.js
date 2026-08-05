import Fastify from "fastify";
import { createVpsRuntimeContext } from "../runtime/context.js";
import { registerVpsRoutes } from "./api.js";

export function buildVpsApp(options = {}) {
  const context = options.context || createVpsRuntimeContext({ env: options.env, logger: options.logger || console });
  const app = options.app || Fastify({
    logger: options.fastifyLogger ?? false,
    requestTimeout: Number(context.config?.requestTimeoutMs || 30_000)
  });
  registerVpsRoutes(app, { ...options, context });
  return { app, context };
}
