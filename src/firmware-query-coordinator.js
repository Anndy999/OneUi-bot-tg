import {
  historyTotalDeadlineMs
} from "./config.js";
import { queryFirmwareHybrid } from "./samsung.js";
import { buildFirmwareCacheRecord } from "./firmware-cache.js";
import { getFirmwareQueryCache, setFirmwareQueryCache } from "./state.js";
import { validateModelCsc } from "./targets.js";

const POSITIVE_KEY = "positive";
const MIRROR_FINGERPRINT_KEY = "mirror:fingerprint";
const PENDING_MIRROR_KEY = "mirror:pending";

function envNumber(env, key, fallback, min, max) {
  const value = Number(env?.[key] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function cacheTtlMs(env) {
  return envNumber(env, "QUERY_COORDINATOR_CACHE_MS", 3000, 0, 30000);
}

function negativeTtlMs(env) {
  return envNumber(env, "QUERY_COORDINATOR_NEGATIVE_CACHE_SECONDS", 30, 5, 3600) * 1000;
}

function storageCacheTtlMs(env) {
  return envNumber(env, "QUERY_COORDINATOR_STORAGE_CACHE_SECONDS", 15, 1, 120) * 1000;
}

export function classifyQueryError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error || "");
  if (code === "INVALID_TARGET") return "invalid_target";
  if (code === "EXACT_CSC_REQUIRED" || /no matching CSC record/i.test(message)) return "exact_csc_missing";
  if (/no usable firmware history/i.test(message)) return "history_empty";
  if (/HTTP 403/i.test(message)) return "http_403";
  if (/HTTP 404/i.test(message)) return "http_404";
  if (/HTTP 429/i.test(message)) return "http_429";
  if (/timeout|timed out/i.test(message) || code.includes("TIMEOUT")) return "timeout";
  if (/HTTP 5\d\d/i.test(message)) return "upstream_5xx";
  if (/parse|xml/i.test(message)) return "parse_error";
  return "network_error";
}

function negativeTtlFor(errorClass, env, releaseMode = "NORMAL") {
  const hot = ["WATCH", "HOT", "COOLDOWN"].includes(String(releaseMode || "").toUpperCase());
  if (errorClass === "history_empty" || errorClass === "exact_csc_missing") return hot ? 3000 : 15000;
  if (errorClass === "http_403" || errorClass === "http_404") return negativeTtlMs(env);
  if (errorClass === "http_429") return 5000;
  if (errorClass === "invalid_target") return 10 * 60 * 1000;
  return 0;
}

function compactResult(result) {
  const parsed = { ...(result?.parsed || result || {}) };
  delete parsed.rawOutput;
  return {
    ...result,
    rawOutput: "",
    parsed: {
      ...parsed,
      rawOutput: ""
    }
  };
}

function coordinatorEnabled(env) {
  return Boolean(env?.FIRMWARE_QUERY_COORDINATOR) &&
    String(env.QUERY_COORDINATOR_ENABLED ?? "true").toLowerCase() !== "false";
}

function coordinatorStub(env, model, csc) {
  if (!coordinatorEnabled(env)) return null;
  const target = validateModelCsc(model, csc);
  const id = env.FIRMWARE_QUERY_COORDINATOR.idFromName(target.key);
  return { target, stub: env.FIRMWARE_QUERY_COORDINATOR.get(id) };
}

export async function coordinatedFirmwareQuery(env, model, csc, options = {}) {
  const binding = coordinatorStub(env, model, csc);
  if (!binding) {
    return queryFirmwareHybrid(env, model, csc, {
      ...options,
      allowOfficialMetadataFallback: !options.monitor
    });
  }

  const timeoutMs = Math.max(1000, historyTotalDeadlineMs(env) + 1500);
  const response = await binding.stub.fetch("https://firmware-query/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: binding.target.model,
      csc: binding.target.csc,
      refresh: Boolean(options.refresh),
      role: options.monitor ? "monitor" : options.role === "admin" ? "admin" : "interactive",
      releaseMode: String(options.releaseMode || "NORMAL").toUpperCase()
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || `FirmwareQueryCoordinator HTTP ${response.status}`);
    if (data.code) error.code = data.code;
    if (data.retryAfterMs) error.retryAfterMs = data.retryAfterMs;
    if (Array.isArray(data.officialCscOptions)) error.officialCscOptions = data.officialCscOptions;
    throw error;
  }
  return {
    ...data.result,
    coordinator: data.coordinator || null
  };
}

export class FirmwareQueryCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.inFlight = null;
    this.cached = null;
    this.positive = null;
    this.positiveLoaded = false;
    this.negative = null;
    this.negativeLoaded = false;
  }

  async loadPositive(now) {
    if (!this.positiveLoaded) {
      this.positive = await this.ctx.storage.get(POSITIVE_KEY) || null;
      this.positiveLoaded = true;
    }
    if (!this.positive?.result) return null;
    if (Number(this.positive.expiresAt || 0) <= now) return null;
    return this.positive;
  }

  scheduleMirrorRetry(delayMs = 60_000) {
    if (typeof this.ctx.storage.setAlarm !== "function") return;
    this.ctx.waitUntil?.(this.ctx.storage.setAlarm(Date.now() + Math.max(1000, delayMs)).catch(() => {}));
  }

  async mirrorCanonical(target, canonicalCache, options = {}) {
    if (!this.env.FIRMWARE_KV || !canonicalCache?.latest) return { ok: true, skipped: true };
    const fingerprint = String(canonicalCache.versionFingerprint || canonicalCache.latest);
    const mirrored = String(await this.ctx.storage.get(MIRROR_FINGERPRINT_KEY) || "");
    if (mirrored === fingerprint) return { ok: true, skipped: true };
    const pending = await this.ctx.storage.get(PENDING_MIRROR_KEY);
    const pendingFingerprint = String(pending?.canonicalCache?.versionFingerprint || pending?.canonicalCache?.latest || "");
    if (!options.force && pendingFingerprint === fingerprint && Number(pending?.retryAt || 0) > Date.now()) {
      return { ok: false, deferred: true, skipped: true };
    }
    try {
      await setFirmwareQueryCache(this.env, target.model, target.csc, canonicalCache);
      await this.ctx.storage.put(MIRROR_FINGERPRINT_KEY, fingerprint);
      await this.ctx.storage.delete(PENDING_MIRROR_KEY);
      return { ok: true, skipped: false };
    } catch (error) {
      await this.ctx.storage.put(PENDING_MIRROR_KEY, {
        target,
        canonicalCache,
        attempts: Number(pending?.attempts || 0) + 1,
        retryAt: Date.now() + (/limit exceeded|429|quota/i.test(String(error?.message || error)) ? 60 * 60 * 1000 : 60_000),
        lastError: String(error?.message || error).slice(0, 240),
        updatedAt: Date.now()
      });
      this.scheduleMirrorRetry(/limit exceeded|429|quota/i.test(String(error?.message || error)) ? 60 * 60 * 1000 : 60_000);
      console.log(`Canonical KV mirror deferred for ${target.key}: ${error.message}`);
      return { ok: false, deferred: true };
    }
  }

  async alarm() {
    const pending = await this.ctx.storage.get(PENDING_MIRROR_KEY);
    if (!pending?.target || !pending?.canonicalCache) return;
    const result = await this.mirrorCanonical(pending.target, pending.canonicalCache, { force: true });
    if (!result.ok) this.scheduleMirrorRetry(60 * 60 * 1000);
  }

  async loadNegative(now) {
    if (!this.negativeLoaded) {
      this.negative = await this.ctx.storage.get("negative") || null;
      this.negativeLoaded = true;
    }
    if (this.negative && Number(this.negative.expiresAt || 0) <= now) {
      this.negative = null;
      await this.ctx.storage.delete("negative");
    }
    return this.negative;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/query") {
      return new Response("Not Found", { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    let target;
    try {
      target = validateModelCsc(body.model, body.csc);
    } catch (error) {
      return Response.json({ ok: false, error: error.message, code: error.code || "INVALID_TARGET" }, { status: 400 });
    }

    const now = Date.now();
    const refresh = Boolean(body.refresh);
    if (!refresh && this.cached && this.cached.expiresAt > now) {
      return Response.json({ ok: true, result: this.cached.result, coordinator: { cacheHit: true, shared: false } });
    }
    if (!refresh) {
      const positive = await this.loadPositive(now);
      if (positive) {
        this.cached = {
          result: positive.result,
          expiresAt: Math.min(Number(positive.expiresAt || now), now + cacheTtlMs(this.env))
        };
        return Response.json({
          ok: true,
          result: positive.result,
          coordinator: { cacheHit: true, cacheLayer: "do_storage", shared: false }
        });
      }
    }
    if (!refresh) await this.loadNegative(now);
    if (!refresh && this.negative && this.negative.expiresAt > now) {
      return Response.json({
        ok: false,
        error: this.negative.error,
        code: this.negative.code,
        retryAfterMs: this.negative.expiresAt - now,
        officialCscOptions: this.negative.officialCscOptions || []
      }, { status: 409 });
    }

    const shared = Boolean(this.inFlight);
    if (!this.inFlight) {
      const role = body.role === "monitor" ? "monitor" : body.role === "admin" ? "admin" : "interactive";
      this.inFlight = Promise.resolve()
        .then(() => queryFirmwareHybrid(this.env, target.model, target.csc, {
          role,
          monitor: role === "monitor",
          allowOfficialMetadataFallback: role !== "monitor"
        }))
        .then(async (result) => {
          const isExactHistory = result.parsed?.sourceType === "smart_history";
          const previousCanonical = isExactHistory && (
            this.positive?.result?.canonicalCache ||
            (this.env.FIRMWARE_KV ? await getFirmwareQueryCache(this.env, target.model, target.csc) : null)
          );
          const canonicalCache = isExactHistory
            ? buildFirmwareCacheRecord(
              this.env,
              previousCanonical,
              target.model,
              target.csc,
              result.parsed
            )
            : null;
          const compact = compactResult({ ...result, canonicalCache });
          const now = Date.now();
          this.cached = {
            result: compact,
            expiresAt: now + cacheTtlMs(this.env)
          };
          if (!canonicalCache) return compact;
          this.positive = {
            result: compact,
            expiresAt: Math.min(
              now + storageCacheTtlMs(this.env),
              Date.parse(canonicalCache.freshUntil || "") || now + storageCacheTtlMs(this.env)
            ),
            storedAt: now
          };
          this.positiveLoaded = true;
          await this.ctx.storage.put(POSITIVE_KEY, this.positive);
          this.negative = null;
          this.negativeLoaded = true;
          await this.ctx.storage.delete("negative");
          const mirrorPromise = this.mirrorCanonical(target, canonicalCache).catch(() => {});
          if (this.ctx.waitUntil) this.ctx.waitUntil(mirrorPromise);
          else await mirrorPromise;
          return compact;
        })
        .catch(async (error) => {
          const errorClass = classifyQueryError(error);
          const ttlMs = negativeTtlFor(errorClass, this.env, body.releaseMode);
          if (ttlMs > 0) {
            this.negative = {
              error: String(error?.message || error),
              code: error?.code || "NEGATIVE_QUERY_CACHE",
              errorClass,
              officialCscOptions: Array.isArray(error?.officialCscOptions) ? error.officialCscOptions : [],
              expiresAt: Date.now() + ttlMs
            };
            this.negativeLoaded = true;
            await this.ctx.storage.put("negative", this.negative);
          }
          throw error;
        })
        .finally(() => {
          this.inFlight = null;
        });
      this.ctx.waitUntil?.(this.inFlight.catch(() => {}));
    }

    try {
      const result = await this.inFlight;
      return Response.json({ ok: true, result, coordinator: { cacheHit: false, shared } });
    } catch (error) {
      return Response.json({
        ok: false,
        error: String(error?.message || error),
        code: error?.code || "FIRMWARE_QUERY_FAILED",
        officialCscOptions: Array.isArray(error?.officialCscOptions) ? error.officialCscOptions : []
      }, { status: 502 });
    }
  }
}
