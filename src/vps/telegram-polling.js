const OFFSET_KEY = "vps:telegram:polling:offset";

function safeError(error) {
  const message = String(error?.message || error || "unknown error");
  return message.replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot<redacted>").slice(0, 240);
}

function updateId(update) {
  const value = Number(update?.update_id);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Telegram long polling for VPS deployments without a public HTTPS domain.
 * It never changes Telegram webhook state; an existing webhook must be
 * removed by the operator before getUpdates can be used.
 */
export function startTelegramPolling({
  token,
  queue,
  storage,
  logger = console,
  fetchImpl = fetch,
  timeoutSeconds = 30
} = {}) {
  if (!String(token || "").trim()) throw new Error("Telegram polling requires TELEGRAM_BOT_TOKEN");
  if (!queue?.send) throw new TypeError("Telegram polling requires a queue binding");
  if (!storage?.get || !storage?.put) throw new TypeError("Telegram polling requires persistent storage");

  const longPollSeconds = Math.max(1, Math.min(50, Math.floor(Number(timeoutSeconds) || 30)));
  let stopped = false;
  let controller = null;
  let offset = null;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let lastSuccessAt = 0;
  let lastFailureAt = 0;
  let lastError = "";
  let fatalFailure = false;
  let retryTimer = null;
  let retryResolve = null;
  const staleAfterMs = Math.max(90_000, (longPollSeconds + 10) * 3 * 1000);
  let offsetLoaded = false;

  const waitForRetry = (ms) => new Promise((resolve) => {
    retryResolve = resolve;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryResolve = null;
      resolve();
    }, ms);
  });

  const fetchUpdates = async () => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (longPollSeconds + 10) * 1000);
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          offset: offset ?? undefined,
          timeout: longPollSeconds,
          allowed_updates: ["message", "callback_query", "edited_message", "edited_channel_post", "channel_post"]
        }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        const code = data?.error_code || response.status || "unknown";
        throw new Error(`Telegram getUpdates rejected (${code})`);
      }
      lastSuccessAt = Date.now();
      lastActivityAt = lastSuccessAt;
      lastError = "";
      fatalFailure = false;
      return Array.isArray(data.result) ? data.result : [];
    } finally {
      clearTimeout(timeout);
      controller = null;
    }
  };

  const run = async () => {
    let retryMs = 1000;

    while (!stopped) {
      try {
        // Loading the offset is part of the retry loop. A temporary PostgreSQL
        // failure must not permanently stop polling before the first request.
        if (!offsetLoaded) {
          const savedOffset = await storage.get(OFFSET_KEY);
          const parsedOffset = Number(savedOffset);
          offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : null;
          offsetLoaded = true;
        }
        const updates = await fetchUpdates();
        retryMs = 1000;
        let nextOffset = offset;
        for (const update of updates) {
          if (stopped) return;
          const id = updateId(update);
          if (id === null) {
            logger.warn?.("Telegram polling ignored an update without a valid update_id");
            continue;
          }
          await queue.send({
            id: `telegram-update:${id}`,
            schemaVersion: 1,
            kind: "telegram_update",
            update,
            createdAt: new Date().toISOString()
          });
          nextOffset = Math.max(Number(nextOffset || 0), id + 1);
          lastActivityAt = Date.now();
        }
        // One durable offset write per Telegram batch substantially reduces
        // PostgreSQL pressure during bursts. Queue job IDs make a full-batch
        // retry safe if this final write fails.
        if (nextOffset !== offset) {
          await storage.put(OFFSET_KEY, String(nextOffset));
          offset = nextOffset;
          lastActivityAt = Date.now();
        }
      } catch (error) {
        // AbortError is normally produced by the request timeout above. It is
        // a transient network failure, not a reason to terminate the poller.
        // The explicit close() path is still handled by the stopped guard.
        if (stopped) return;
        lastFailureAt = Date.now();
        lastError = safeError(error);
        fatalFailure = /Telegram getUpdates rejected \((?:401|409)\)/.test(lastError);
        logger.error?.(`Telegram polling failed: ${lastError}`);
        await waitForRetry(retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
  };

  const running = run().catch((error) => {
    if (!stopped) logger.error?.(`Telegram polling stopped: ${safeError(error)}`);
  });

  return {
    status() {
      const now = Date.now();
      const ok = !stopped && !fatalFailure && now - lastActivityAt <= staleAfterMs;
      return {
        ok,
        state: stopped ? "stopped" : lastSuccessAt ? (lastError ? "retrying" : "healthy") : (lastError ? "retrying" : "starting"),
        startedAt,
        lastActivityAt,
        lastSuccessAt,
        lastFailureAt,
        fatalFailure,
        staleAfterMs,
        lastError: lastError || undefined
      };
    },
    async close() {
      stopped = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      retryResolve?.();
      retryResolve = null;
      await running;
    }
  };
}

export { OFFSET_KEY };
