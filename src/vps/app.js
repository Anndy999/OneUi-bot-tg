import Fastify from "fastify";
import { createVpsRuntimeContext } from "../runtime/context.js";
import { registerVpsRoutes } from "./api.js";

export function buildVpsApp(options = {}) {
  const app = options.app || Fastify({ logger: options.fastifyLogger ?? false });
  const context = options.context || createVpsRuntimeContext({ env: options.env, logger: options.logger || console });
  registerVpsRoutes(app, { ...options, context });
  return { app, context };
}
