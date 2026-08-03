import { constantTimeSecretEquals } from "./config.js";

function firstHeader(request, name) {
  const value = request.headers?.[name.toLowerCase()] ?? request.headers?.[name];
  return Array.isArray(value) ? value[0] : String(value || "");
}

function safeError(error) {
  return String(error?.message || error || "request failed").slice(0, 240);
}

async function runChecks(checks = {}) {
  const result = {};
  for (const [name, check] of Object.entries(checks)) {
    try {
      const value = typeof check === "function" ? await check() : check;
      result[name] = typeof value === "object" ? value : { ok: value !== false };
    } catch (error) {
      result[name] = { ok: false, error: safeError(error) };
    }
  }
  return result;
}

function requireInternal(request, reply, secret) {
  if (!constantTimeSecretEquals(secret, firstHeader(request, "x-vps-internal-secret"))) {
    reply.code(403).send({ ok: false, error: "Forbidden" });
    return false;
  }
  return true;
}

export function registerVpsRoutes(app, {
  context,
  version = context?.config?.version || "2.13.4",
  webhookHandler,
  checkHandler,
  diagnosticsHandler,
  metricsHandler,
  healthChecks = {}
} = {}) {
  if (!app?.get || !app?.post) throw new TypeError("registerVpsRoutes requires a Fastify-like app");
  const config = context?.config || {};

  app.get("/", async () => ({ ok: true, service: "oneui-firmware-vps", version }));

  app.get("/health", async (_request, reply) => {
    const checks = await runChecks(healthChecks);
    const ok = Object.values(checks).every((check) => check?.ok !== false);
    reply.code(ok ? 200 : 503);
    return {
      ok,
      service: "oneui-firmware-vps",
      version,
      time: new Date().toISOString(),
      checks,
      features: {
        shadowMode: Boolean(config.shadowMode),
        telegramSendEnabled: Boolean(config.telegramSendEnabled && !config.shadowMode),
        monitorNotificationsEnabled: Boolean(config.monitorNotificationsEnabled && !config.shadowMode)
      }
    };
  });

  app.post("/telegram", async (request, reply) => {
    if (!constantTimeSecretEquals(config.webhookSecret, firstHeader(request, "x-telegram-bot-api-secret-token"))) {
      reply.code(403);
      return { ok: false, error: "Forbidden" };
    }
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      reply.code(400);
      return { ok: false, error: "Invalid JSON" };
    }
    try {
      const result = webhookHandler
        ? await webhookHandler(request.body, context)
        : { accepted: false, reason: "webhook_handler_unconfigured" };
      return { ok: true, accepted: result?.accepted !== false, duplicate: Boolean(result?.duplicate) };
    } catch (error) {
      context?.logger?.error?.(`VPS webhook enqueue failed: ${safeError(error)}`);
      reply.code(503);
      return { ok: false, error: "Webhook temporarily unavailable" };
    }
  });

  app.get("/metrics", async (_request, reply) => {
    try {
      const value = metricsHandler ? await metricsHandler(context) : "";
      if (typeof value === "string") {
        reply.type("text/plain; version=0.0.4; charset=utf-8");
        return value;
      }
      return value || { ok: true, metrics: {} };
    } catch (error) {
      reply.code(503);
      return { ok: false, error: "Metrics temporarily unavailable" };
    }
  });

  app.post("/internal/check", async (request, reply) => {
    if (!requireInternal(request, reply, config.internalApiSecret)) return;
    if (!checkHandler) {
      reply.code(501);
      return { ok: false, error: "Check handler is not configured" };
    }
    try { return { ok: true, result: await checkHandler(request.body || {}, context) }; }
    catch (error) { reply.code(503); return { ok: false, error: safeError(error) }; }
  });

  app.get("/internal/diagnostics", async (request, reply) => {
    if (!requireInternal(request, reply, config.internalApiSecret)) return;
    if (!diagnosticsHandler) {
      reply.code(501);
      return { ok: false, error: "Diagnostics handler is not configured" };
    }
    try { return { ok: true, result: await diagnosticsHandler(context) }; }
    catch (error) { reply.code(503); return { ok: false, error: safeError(error) }; }
  });

  return app;
}
