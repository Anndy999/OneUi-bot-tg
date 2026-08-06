import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, statfs, writeFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker as NodeWorker } from "node:worker_threads";
import * as zlib from "node:zlib";
import Fastify from "fastify";
import { Queue, Worker as BullWorker } from "bullmq";
import Redis from "ioredis";
import { constantTimeSecretEquals } from "./config.js";
import { resolveVpsOfficialFirmwareDownload } from "./fus-resolver.js";

const DEFAULT_ALLOWED_HOSTS = ["samsung.com", "samsungmobile.com", "ospserver.net", "cdngc.net"];
const MAX_REDIRECTS = 5;
const FREE_SPACE_CHECK_INTERVAL_BYTES = 64 * 1024 * 1024;
const IO_BUFFER_BYTES = 4 * 1024 * 1024;
const SPEED_WINDOW_MS = 10 * 1000;
const SPEED_SAMPLE_MS = 1000;
const MAX_PARALLEL_RANGE_COUNT = 512;
// Samsung FUS can throttle a single client when it opens a large burst of
// Range requests. Bifrost's public baseline is eight connections; this worker
// starts there and can add up to twelve only when the measured rate is below
// the configured target. This keeps the tail responsive without returning to
// the old 16/24-connection burst profile.
const MAX_PARALLEL_LANE_COUNT = 12;
const DEFAULT_PARALLEL_LANES = 8;
const DEFAULT_PARALLEL_MAX_LANES = 12;
// Bifrost keeps one native AES-ECB cipher alive and feeds it bounded blocks.
// Node's native stream performs better with a 4 MiB high-water mark on the
// VPS profile, while the cipher and output ordering remain Bifrost-compatible.
const DEFAULT_DECRYPT_MODE = "stream";
const DEFAULT_DECRYPT_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;
const JOB_STATES = new Set(["queued", "downloading", "verifying", "decrypting", "paused", "completed", "failed", "cancelled"]);

class OfficialSourceAuthorizationError extends Error {
  constructor() {
    super("Samsung official source rejected the FUS download authorization (HTTP 401)");
    this.name = "OfficialSourceAuthorizationError";
  }
}
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
// Node 22 provides native CRC32. The fallback remains for compatible older
// runtimes; /health exposes the active engine for performance diagnosis.
const CRC32_ENGINE = typeof zlib.crc32 === "function" ? "native" : "js-fallback";

function text(value, fallback = "") {
  const result = String(value ?? fallback).trim();
  return result || fallback;
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function bytes(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createDownloadConfig(env = process.env) {
  const configuredHosts = text(env.DOWNLOAD_ALLOWED_HOSTS)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const dir = resolve(text(env.DOWNLOAD_DIR, "./data/firmware"));
  const bodyIdleTimeoutMs = integer(env.DOWNLOAD_BODY_IDLE_TIMEOUT_MS || 120_000, 120_000, 5_000, 15 * 60_000);
  const parallelSegments = integer(
    env.DOWNLOAD_PARALLEL_SEGMENTS || DEFAULT_PARALLEL_LANES,
    DEFAULT_PARALLEL_LANES,
    1,
    MAX_PARALLEL_LANE_COUNT
  );
  const parallelMaxSegments = integer(
    env.DOWNLOAD_PARALLEL_MAX_SEGMENTS || DEFAULT_PARALLEL_MAX_LANES,
    DEFAULT_PARALLEL_MAX_LANES,
    parallelSegments,
    MAX_PARALLEL_LANE_COUNT
  );
  const decryptMode = ["stream", "parallel"].includes(text(env.DOWNLOAD_DECRYPT_MODE))
    ? text(env.DOWNLOAD_DECRYPT_MODE)
    : DEFAULT_DECRYPT_MODE;
  return {
    host: text(env.DOWNLOAD_HOST, "127.0.0.1"),
    port: integer(env.DOWNLOAD_PORT || 8788, 8788, 1, 65535),
    dir,
    indexDir: resolve(text(env.DOWNLOAD_INDEX_DIR, dir)),
    apiSecret: text(env.DOWNLOAD_API_SECRET),
    redisUrl: text(env.REDIS_URL),
    queuePrefix: text(env.DOWNLOAD_QUEUE_PREFIX, "oneui-download"),
    maxBytes: bytes(env.DOWNLOAD_MAX_BYTES, 20 * 1024 ** 3),
    minFreeBytes: bytes(env.DOWNLOAD_MIN_FREE_BYTES, 40 * 1024 ** 3),
    completedTtlMs: integer(env.DOWNLOAD_COMPLETED_TTL_MS || 7 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000, 0, 365 * 24 * 60 * 60 * 1000),
    partTtlMs: integer(env.DOWNLOAD_PART_TTL_MS || 6 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
    responseHeaderTimeoutMs: integer(env.DOWNLOAD_RESPONSE_HEADER_TIMEOUT_MS || env.DOWNLOAD_REQUEST_TIMEOUT_MS || 60_000, 60_000, 5_000, 10 * 60_000),
    bodyIdleTimeoutMs,
    jobStaleMs: integer(env.DOWNLOAD_JOB_STALE_MS || Math.max(5 * 60_000, bodyIdleTimeoutMs * 2), Math.max(5 * 60_000, bodyIdleTimeoutMs * 2), 60_000, 60 * 60_000),
    apiRequestTimeoutMs: integer(env.DOWNLOAD_API_REQUEST_TIMEOUT_MS || 30_000, 30_000, 5_000, 5 * 60_000),
    // Samsung's CDN can limit each TCP connection independently.  These are
    // worker lanes, not an unbounded number of requests: a lane receives the
    // next unfinished byte range only after it completes its current range.
    // Start with a conservative number of persistent Range lanes, then add
    // small groups only when Samsung's aggregate rate stays below the target.
    // This avoids turning a temporary authorization refresh into a burst of
    // new requests while still allowing a rate-limited route to scale up.
    parallelSegments,
    parallelMaxSegments,
    parallelStaggerMs: integer(env.DOWNLOAD_PARALLEL_STAGGER_MS || 100, 100, 0, 5_000),
    parallelMinBytes: bytes(env.DOWNLOAD_PARALLEL_MIN_BYTES, 64 * 1024 * 1024),
    parallelChunkBytes: Math.max(8 * 1024 * 1024, Math.min(
      1024 * 1024 * 1024,
      bytes(env.DOWNLOAD_PARALLEL_CHUNK_BYTES, 256 * 1024 * 1024)
    )),
    parallelRetries: integer(env.DOWNLOAD_PARALLEL_RETRIES || 3, 3, 0, 5),
    parallelWriteBatchBytes: Math.max(64 * 1024, Math.min(
      16 * 1024 * 1024,
      bytes(env.DOWNLOAD_PARALLEL_WRITE_BATCH_BYTES, IO_BUFFER_BYTES)
    )),
    parallelScaleTargetBytesPerSecond: Math.max(1 * 1024 * 1024, Math.min(
      1024 * 1024 * 1024,
      bytes(env.DOWNLOAD_PARALLEL_TARGET_BYTES_PER_SECOND, 150 * 1024 * 1024)
    )),
    parallelScaleIntervalMs: integer(env.DOWNLOAD_PARALLEL_SCALE_INTERVAL_MS || 8_000, 8_000, 1_000, 60_000),
    parallelScaleStep: integer(env.DOWNLOAD_PARALLEL_SCALE_STEP || 4, 4, 1, 16),
    decryptMode,
    decryptStreamChunkBytes: integer(
      env.DOWNLOAD_DECRYPT_STREAM_CHUNK_BYTES || DEFAULT_DECRYPT_STREAM_CHUNK_BYTES,
      DEFAULT_DECRYPT_STREAM_CHUNK_BYTES,
      64 * 1024,
      4 * 1024 * 1024
    ),
    // Retain the legacy values for configuration compatibility. They are
    // consulted only when an operator explicitly opts into parallel mode.
    decryptWorkerCount: integer(env.DOWNLOAD_DECRYPT_WORKERS || 1, 1, 1, 8),
    decryptWorkerMinBytes: bytes(env.DOWNLOAD_DECRYPT_WORKER_MIN_BYTES, 128 * 1024 * 1024),
    decryptChunkBytes: Math.max(16 * 1024, Math.min(
      64 * 1024 * 1024,
      bytes(env.DOWNLOAD_DECRYPT_CHUNK_BYTES, 16 * 1024 * 1024)
    )) & ~15,
    allowedHosts: [...new Set([...DEFAULT_ALLOWED_HOSTS, ...configuredHosts])]
  };
}

export function isAllowedOfficialHost(hostname, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host || isIP(host)) return false;
  return allowedHosts.some((entry) => {
    const normalized = String(entry || "").toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function assertOfficialUrl(value, allowedHosts) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("sourceUrl must be a valid official URL"); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowsSamsungFusHttp = host === "cloud-neofussvr.samsungmobile.com" || host === "cloud-neofussvr.sslcs.cdngc.net";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowsSamsungFusHttp)) {
    throw new Error("sourceUrl must use HTTPS unless it is the official Samsung FUS cloud endpoint");
  }
  if (url.username || url.password) throw new Error("sourceUrl must not include credentials");
  if (!isAllowedOfficialHost(url.hostname, allowedHosts)) throw new Error("sourceUrl host is not in the official Samsung allowlist");
  return url;
}

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) ||
      (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
      parts[0] >= 224;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized.startsWith("ff") ||
      normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:192.0.0.") || normalized.startsWith("::ffff:192.168.") ||
      normalized.startsWith("::ffff:172.");
  }
  return true;
}

async function assertPublicHost(url, lookupImpl = lookup) {
  const addresses = await lookupImpl(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("sourceUrl resolved to a non-public address");
  }
}

function safeName(value, fallback = "firmware.bin") {
  const cleaned = basename(String(value || ""))
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 180) || fallback;
}

function jsonSafe(value) {
  return JSON.stringify(value, null, 2);
}

function publicJob(job) {
  const { sourceUrl: _sourceUrl, sourceUrlHash: _sourceUrlHash, sourceHeaders: _sourceHeaders, decryption: _decryption, encryptedFileName: _encryptedFileName, expectedCrc32: _expectedCrc32, filePath: _filePath, parallel: parallel, downloadStartBytes: _downloadStartBytes, speedSamples: _speedSamples, speedPhase: _speedPhase, downloadComplete: _downloadComplete, downloadVerified: _downloadVerified, ...safe } = job;
  const decrypting = safe.state === "decrypting";
  const verifying = safe.state === "verifying";
  const progressBytes = decrypting
    ? Number(safe.decryptBytes || 0)
    : verifying
      ? Number(safe.verifyBytes || 0)
      : Number(safe.bytes || 0);
  const percent = safe.state === "completed" ? 100 : safe.totalBytes
    ? (decrypting
      ? Math.min(99, 90 + Math.floor((progressBytes / safe.totalBytes) * 10))
      : verifying
        ? Math.min(90, 85 + Math.floor((progressBytes / safe.totalBytes) * 5))
        : Math.min(85, Math.floor((progressBytes / safe.totalBytes) * 85)))
    : null;
  const speedBytesPerSecond = Math.max(0, Number(safe.speedBytesPerSecond || 0));
  const etaSeconds = safe.totalBytes && speedBytesPerSecond > 0
    ? Math.max(0, Math.ceil((safe.totalBytes - progressBytes) / speedBytesPerSecond))
    : null;
  const transfer = parallel && typeof parallel === "object" ? {
    lanes: Math.max(0, Number(parallel.lanes || 0)),
    activeLanes: Math.max(0, Number(parallel.activeLanes || 0)),
    completedRanges: Math.max(0, Number(parallel.completedRanges || 0)),
    totalRanges: Array.isArray(parallel.segments) ? parallel.segments.length : 0
  } : null;
  return { ...safe, percent, speedBytesPerSecond, speedWindowSeconds: SPEED_WINDOW_MS / 1000, etaSeconds, transfer };
}

function resetSpeedTracking(job, phase, bytesAtStart, timestamp) {
  job.speedPhase = phase;
  job.speedSamples = [{ at: Number(timestamp), bytes: Math.max(0, Number(bytesAtStart) || 0) }];
  job.speedBytesPerSecond = 0;
}

export function updateRollingSpeed(job, phase, bytes, timestamp) {
  const now = Number(timestamp);
  const value = Math.max(0, Number(bytes) || 0);
  if (job.speedPhase !== phase || !Array.isArray(job.speedSamples) || !job.speedSamples.length) {
    resetSpeedTracking(job, phase, value, now);
    return 0;
  }
  const samples = job.speedSamples;
  const last = samples.at(-1);
  const sampleAt = Math.max(Number(last.at) || now, now);
  if (sampleAt - Number(last.at) >= SPEED_SAMPLE_MS) samples.push({ at: sampleAt, bytes: value });
  else last.bytes = value;
  const cutoff = sampleAt - SPEED_WINDOW_MS;
  while (samples.length > 2 && Number(samples[1].at) <= cutoff) samples.shift();
  const first = samples[0];
  const latest = samples.at(-1);
  const elapsedMs = Number(latest.at) - Number(first.at);
  const speed = elapsedMs > 0 ? Math.floor(Math.max(0, Number(latest.bytes) - Number(first.bytes)) / (elapsedMs / 1000)) : 0;
  job.speedBytesPerSecond = Math.max(0, speed);
  return job.speedBytesPerSecond;
}

function decryptFileName(fileName) {
  return String(fileName || "firmware.bin").replace(/\.enc(?:2|4)$/i, "") || "firmware.bin";
}

function firmwareLabel(value, fallback = "unknown") {
  const label = String(value || fallback).trim().toUpperCase().replace(/[^A-Z0-9._-]+/g, "");
  return label.slice(0, 96) || fallback;
}

function firmwareVersionLabel(value) {
  return firmwareLabel(String(value || "").split(/[\\/\s]+/, 1)[0], "unknown");
}

function firmwareOutputName(model, csc, version, sourceName) {
  const extension = extname(decryptFileName(sourceName)).slice(0, 12).toLowerCase() || ".bin";
  return safeName(
    `${firmwareLabel(model)}_${firmwareLabel(csc)}_${firmwareVersionLabel(version)}${extension}`,
    "firmware.bin"
  );
}

function isDecryptingFirmware(job) {
  return Boolean(job?.decryption?.keySeed && /\.enc(?:2|4)$/i.test(String(job.encryptedFileName || job.originalName || "")));
}

function sourceUrlHash(sourceUrl) {
  return createHash("sha256").update(String(sourceUrl)).digest("hex").slice(0, 16);
}

function decryptionKey(keySeed) {
  return createHash("md5").update(String(keySeed || ""), "utf8").digest();
}

async function writeChunk(writer, chunk) {
  if (writer.write(chunk)) return;
  await new Promise((resolveWrite, rejectWrite) => {
    const cleanup = () => {
      writer.removeListener("drain", onDrain);
      writer.removeListener("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolveWrite();
    };
    const onError = (error) => {
      cleanup();
      rejectWrite(error);
    };
    writer.once("drain", onDrain);
    writer.once("error", onError);
  });
}

async function writeChunkAt(file, chunk, position) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      position + offset
    );
    if (!bytesWritten) throw new Error("firmware part write made no progress");
    offset += bytesWritten;
  }
}

async function writeChunksAt(file, chunks, totalBytes, position) {
  if (!totalBytes) return;
  let index = 0;
  let chunkOffset = 0;
  let remaining = totalBytes;
  while (remaining > 0) {
    // writev avoids copying every network chunk through Buffer.concat before
    // it reaches disk. Cap the vector at a portable size in case a source
    // emits unusually small chunks.
    const vectors = chunks.slice(index, index + 1024);
    if (!vectors.length) throw new Error("firmware part write batch has an invalid length");
    if (chunkOffset) vectors[0] = vectors[0].subarray(chunkOffset);
    const { bytesWritten } = await file.writev(vectors, position);
    if (!bytesWritten) throw new Error("firmware part write made no progress");
    position += bytesWritten;
    remaining -= bytesWritten;
    let consumed = bytesWritten;
    while (consumed > 0 && index < chunks.length) {
      const available = chunks[index].byteLength - chunkOffset;
      if (consumed < available) {
        chunkOffset += consumed;
        consumed = 0;
      } else {
        consumed -= available;
        index += 1;
        chunkOffset = 0;
      }
    }
  }
  if (index !== chunks.length || chunkOffset) throw new Error("firmware part write batch has an invalid length");
}

async function finishWriteStream(writer) {
  await new Promise((resolveWrite, rejectWrite) => {
    const cleanup = () => {
      writer.removeListener("finish", onFinish);
      writer.removeListener("error", onError);
    };
    const onFinish = () => {
      cleanup();
      resolveWrite();
    };
    const onError = (error) => {
      cleanup();
      rejectWrite(error);
    };
    writer.once("finish", onFinish);
    writer.once("error", onError);
    writer.end();
  });
}

function responseHeaderDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("official source response headers timed out")), timeoutMs);
  timer.unref?.();
  const combined = signal
    ? (AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal)
    : controller.signal;
  return { signal: combined, clear: () => clearTimeout(timer) };
}

function waitWithAbort(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("download cancelled by administrator"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason || new Error("download cancelled by administrator"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withBodyIdleDeadline(promise, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("download cancelled by administrator"));
  const delay = Math.max(1, Number(timeoutMs) || 120_000);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason || new Error("download cancelled by administrator"));
    const timer = setTimeout(() => finish(reject, new Error(`official source body stalled for ${delay} ms`)), delay);
    // Keep this deadline referenced. If an upstream body promise is the last
    // pending work, unref() lets Node exit before the timeout can reject it.
    // That cancels downloads/tests instead of reporting a controlled failure.
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

async function* responseBodyChunks(body, timeoutMs, signal) {
  if (!body) throw new Error("official source returned an empty body");
  const reader = typeof body.getReader === "function" ? body.getReader() : null;
  const iterator = !reader && typeof body[Symbol.asyncIterator] === "function"
    ? body[Symbol.asyncIterator]()
    : null;
  if (!reader && !iterator) throw new Error("official source returned an unreadable body");
  let completed = false;
  try {
    while (true) {
      const result = await withBodyIdleDeadline(reader ? reader.read() : iterator.next(), timeoutMs, signal);
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!completed) {
      await cancelBodyReader(reader, iterator);
    }
  }
}

async function cancelBodyReader(reader, iterator = null) {
  try {
    const cancellation = reader?.cancel?.() ?? iterator?.return?.();
    if (cancellation) await withBodyIdleDeadline(cancellation, 5_000);
  } catch {
    // Body cancellation is best effort. Never let a broken upstream stream
    // keep shutdown, retry or redirect handling stuck indefinitely.
  }
}

async function cancelResponseBody(body) {
  if (!body) return;
  const reader = typeof body.getReader === "function" ? body.getReader() : null;
  if (reader) return cancelBodyReader(reader);
  try {
    const cancellation = body.cancel?.();
    if (cancellation) await withBodyIdleDeadline(cancellation, 5_000);
  } catch {}
}

function contentRange(value) {
  const match = String(value || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

async function fileCrc32(filePath, signal, onProgress = null) {
  const reader = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
  let crc = 0;
  let processed = 0;
  for await (const chunk of reader) {
    if (signal.aborted) throw signal.reason || new Error("download cancelled by administrator");
    crc = updateCrc32(crc, chunk);
    processed += chunk.length;
    // Keep the file reader moving. Callers that persist a progress snapshot
    // must queue that work separately instead of pausing every CRC chunk.
    if (onProgress) onProgress(processed);
  }
  return crc >>> 0;
}

function updateCrc32(current, chunk) {
  // Node 22 exposes a native CRC32 implementation. It avoids a per-byte
  // JavaScript loop across a 10-20 GiB firmware during verification. Keep a
  // standards-compatible fallback for an older local Node runtime.
  if (CRC32_ENGINE === "native") return zlib.crc32(chunk, current) >>> 0;
  let crc = (Number(current) ^ 0xffffffff) >>> 0;
  for (const byte of chunk) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function expectedCrc32(value) {
  const text = String(value || "").trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text) >>> 0;
}

// AES-128-ECB blocks are independent when padding is disabled.  Large
// Samsung packages can therefore use a small bounded worker pool without
// changing the cipher, output bytes, or integrity checks.  Small files keep
// the original stream path to avoid worker startup overhead.
class AesDecryptWorkerPool {
  constructor(key, count) {
    this.closed = false;
    this.nextWorker = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.failedWorkers = new Set();
    const workerOptions = {
      type: "module",
      workerData: { keyHex: key.toString("hex") }
    };
    // Node rejects --input-type inside a Worker. Normal systemd launches do
    // not set it; only override execArgv for stdin/eval diagnostics.
    if (process.execArgv.some((argument) => argument.startsWith("--input-type"))) {
      workerOptions.execArgv = process.execArgv.filter((argument) => !argument.startsWith("--input-type"));
    }
    this.workers = Array.from({ length: count }, () => new NodeWorker(
      new URL("./decrypt-worker.js", import.meta.url),
      workerOptions
    ));
    for (const worker of this.workers) {
      worker.on("message", (message) => this.resolveMessage(worker, message));
      worker.on("error", (error) => this.failWorker(worker, error));
      worker.on("exit", (code) => {
        if (!this.closed && code !== 0) this.failWorker(worker, new Error(`decrypt worker exited with code ${code}`));
      });
    }
  }

  resolveMessage(worker, message) {
    const pending = this.pending.get(message?.id);
    if (!pending || pending.worker !== worker) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(String(message.error)));
    else pending.resolve(Buffer.from(message.data));
  }

  failWorker(worker, error) {
    this.failedWorkers.add(worker);
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  run(chunk) {
    if (this.closed) return Promise.reject(new Error("decrypt worker pool is closed"));
    if (!chunk?.length || chunk.byteLength % 16 !== 0) {
      return Promise.reject(new Error("encrypted firmware size is not AES block aligned"));
    }
    const source = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
      ? chunk.buffer
      : Uint8Array.from(chunk).buffer;
    const id = ++this.nextId;
    let worker = null;
    for (let offset = 0; offset < this.workers.length; offset += 1) {
      const candidate = this.workers[(this.nextWorker + offset) % this.workers.length];
      if (this.failedWorkers.has(candidate)) continue;
      worker = candidate;
      this.nextWorker = (this.workers.indexOf(candidate) + 1) % this.workers.length;
      break;
    }
    if (!worker) return Promise.reject(new Error("all decrypt workers have failed"));
    return new Promise((resolveResult, rejectResult) => {
      this.pending.set(id, { worker, resolve: resolveResult, reject: rejectResult });
      try {
        worker.postMessage({ id, data: source }, [source]);
      } catch (error) {
        this.pending.delete(id);
        rejectResult(error);
      }
    });
  }

  abort(reason = new Error("download cancelled by administrator")) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    for (const worker of this.workers) worker.terminate().catch(() => {});
  }

  async close() {
    if (!this.closed) this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("decrypt worker pool is closing"));
    this.pending.clear();
    await Promise.allSettled(this.workers.map((worker) => worker.terminate()));
    this.workers = [];
  }
}

function connectionOptions(redisUrl) {
  const url = new URL(redisUrl);
  const options = {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
    connectionName: "oneui-firmware-download"
  };
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  if (url.pathname.length > 1) options.db = Number(url.pathname.slice(1)) || 0;
  if (url.protocol === "rediss:") options.tls = {};
  return options;
}

export class FirmwareDownloadService {
  constructor({ config = createDownloadConfig(), logger = console, fetchImpl = fetch, lookupImpl = lookup, resolveImpl = resolveVpsOfficialFirmwareDownload, now = () => Date.now(), fusEnv = process.env } = {}) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.lookupImpl = lookupImpl;
    this.resolveImpl = resolveImpl;
    this.fusEnv = fusEnv;
    this.now = now;
    this.jobs = new Map();
    this.controllers = new Map();
    this.queue = null;
    this.worker = null;
    this.redis = null;
    this.cleanupTimer = null;
    this.createInFlight = false;
    this.persistPromise = Promise.resolve();
    this.ready = false;
    this.closing = false;
  }

  async init({ startQueue = Boolean(this.config.redisUrl) } = {}) {
    await mkdir(this.config.dir, { recursive: true, mode: 0o750 });
    await mkdir(this.config.indexDir, { recursive: true, mode: 0o750 });
    await this.loadIndex();
    await this.cleanupFiles();
    if (CRC32_ENGINE !== "native") {
      this.logger.warn?.("Native Node CRC32 is unavailable; firmware verification is using the compatible JavaScript fallback.");
    }
    if (startQueue) {
      if (!this.config.redisUrl) throw new Error("REDIS_URL is required for download queue");
      const options = connectionOptions(this.config.redisUrl);
      this.redis = new Redis(this.config.redisUrl, { ...options, lazyConnect: true });
      this.redis.on("error", (error) => this.logger.warn?.(`Download Redis error: ${error.message}`));
      await this.redis.connect();
      this.queue = new Queue("firmware-download", { connection: connectionOptions(this.config.redisUrl), prefix: this.config.queuePrefix });
      const workerConnection = new Redis(this.config.redisUrl, { ...options, lazyConnect: true });
      workerConnection.on("error", (error) => this.logger.warn?.(`Download worker Redis error: ${error.message}`));
      this.worker = new BullWorker("firmware-download", (job) => this.runJob(job), {
        connection: workerConnection,
        prefix: this.config.queuePrefix,
        concurrency: 1
      });
      this.worker.on("error", (error) => this.logger.error?.(`Download worker error: ${error.message}`));
      for (const job of this.jobs.values()) {
        if (job.state === "queued") await this.enqueue(job.id);
      }
    }
    this.cleanupTimer = setInterval(() => {
      this.cleanupFiles().catch((error) => this.logger.warn?.(`Download cleanup failed: ${error.message}`));
    }, 6 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
    this.ready = true;
    return this;
  }

  get indexPath() { return join(this.config.indexDir, "index.json"); }

  async loadIndex() {
    try {
      const value = JSON.parse(await readFile(this.indexPath, "utf8"));
      if (value && typeof value === "object") {
        for (const [id, job] of Object.entries(value)) {
          if (job && JOB_STATES.has(job.state)) this.jobs.set(id, job);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`download index is unreadable: ${error.message}`);
    }
    for (const job of this.jobs.values()) {
      // A process restart is equivalent to a safe pause.  Keeping the range
      // map lets the next worker continue from the bytes already persisted.
      if (["downloading", "verifying", "decrypting"].includes(job.state)) job.state = "queued";
    }
  }

  async persist() {
    // Several parallel range workers can report progress together. Serialize
    // snapshots so they never race over one temporary index file.
    const snapshot = jsonSafe(Object.fromEntries(this.jobs));
    const writeSnapshot = async () => {
      const temporary = `${this.indexPath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporary, snapshot, { mode: 0o640 });
      await rename(temporary, this.indexPath);
    };
    this.persistPromise = this.persistPromise.catch(() => {}).then(writeSnapshot);
    return this.persistPromise;
  }

  async cleanupFiles() {
    const entries = await readdir(this.config.dir, { withFileTypes: true });
    const partCutoff = this.now() - this.config.partTtlMs;
    const completedCutoff = this.now() - this.config.completedTtlMs;
    const terminalCutoff = this.now() - (this.config.completedTtlMs || 7 * 24 * 60 * 60 * 1000);
    for (const job of [...this.jobs.values()]) {
      const updatedAt = Date.parse(job.updatedAt || job.createdAt || "");
      if (["failed", "cancelled"].includes(job.state) && Number.isFinite(updatedAt) && updatedAt < terminalCutoff) {
        this.jobs.delete(job.id);
        continue;
      }
      if (job.state === "completed") {
        const exists = await stat(join(this.config.dir, job.fileName)).catch(() => null);
        if (!exists) this.jobs.delete(job.id);
      }
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = join(this.config.dir, entry.name);
      const info = await stat(filePath).catch(() => null);
      if (!info) continue;
      const pausedJob = [...this.jobs.values()].find((item) => item.state === "paused" && entry.name.startsWith(`${item.id}.`));
      if (entry.name.endsWith(".part") && !pausedJob && info.mtimeMs < partCutoff) {
        await rm(filePath, { force: true });
        continue;
      }
      if (!this.config.completedTtlMs || info.mtimeMs >= completedCutoff) continue;
      const job = [...this.jobs.values()].find((item) => item.fileName === entry.name && item.state === "completed");
      if (job) {
        await rm(filePath, { force: true });
        this.jobs.delete(job.id);
      }
    }
    const indexEntries = await readdir(this.config.indexDir, { withFileTypes: true }).catch(() => []);
    for (const entry of indexEntries) {
      if (!entry.isFile() || !entry.name.startsWith("index.json.tmp-")) continue;
      const temporaryPath = join(this.config.indexDir, entry.name);
      const info = await stat(temporaryPath).catch(() => null);
      if (info?.mtimeMs < partCutoff) await rm(temporaryPath, { force: true });
    }
    await this.persist();
  }

  async freeBytes() {
    const info = await statfs(this.config.dir);
    return Number(info.bavail) * Number(info.bsize);
  }

  async health() {
    const free = await this.freeBytes();
    const active = [...this.jobs.values()].find((job) => ["downloading", "verifying", "decrypting"].includes(job.state));
    const queued = [...this.jobs.values()].filter((job) => job.state === "queued").length;
    const activeUpdatedAt = active ? Date.parse(active.updatedAt || active.createdAt || "") : 0;
    const stalled = Boolean(active && (!Number.isFinite(activeUpdatedAt) || this.now() - activeUpdatedAt > this.config.jobStaleMs));
    const redisReady = !this.redis || this.redis.status === "ready";
    const workerRunning = !this.worker || typeof this.worker.isRunning !== "function" || this.worker.isRunning();
    return {
      ok: this.ready && free >= this.config.minFreeBytes && redisReady && workerRunning && !stalled,
      ready: this.ready,
      freeBytes: free,
      minFreeBytes: this.config.minFreeBytes,
      jobs: this.jobs.size,
      queued,
      redis: this.redis?.status || "disabled",
      crc32Engine: CRC32_ENGINE,
      workerRunning,
      active: active ? { id: active.id, state: active.state, updatedAt: active.updatedAt, stalled } : null
    };
  }

  async create(payload = {}, requestedBy = "admin") {
    if (this.createInFlight) throw new Error("another download request is being prepared");
    this.createInFlight = true;
    try {
      return await this.createDownload(payload, requestedBy);
    } finally {
      this.createInFlight = false;
    }
  }

  async preview(payload = {}) {
    if (!this.ready) throw new Error("download service is not ready");
    if (!(payload.model && payload.csc && payload.version)) {
      throw new Error("model, csc, and version are required for a Samsung download preview");
    }
    const free = await this.freeBytes();
    if (free < this.config.minFreeBytes) throw new Error("insufficient free disk space for a new download");
    const resolved = await this.resolveImpl(this.fusEnv, payload.model, payload.csc, payload.version, { role: "admin" });
    const size = Math.max(0, Number(resolved.size || 0));
    if (size > this.config.maxBytes) throw new Error("firmware file exceeds DOWNLOAD_MAX_BYTES");
    const requiredBytes = isDecryptingFirmware({ ...resolved, originalName: resolved.fileName }) ? size * 2 : size;
    if (requiredBytes && free - requiredBytes < this.config.minFreeBytes) {
      throw new Error("download would breach the configured free disk reserve");
    }
    const model = String(resolved.model || payload.model).toUpperCase();
    const csc = String(resolved.csc || payload.csc).toUpperCase();
    const version = String(resolved.version || payload.version);
    return {
      model,
      csc,
      version,
      originalName: firmwareOutputName(model, csc, version, resolved.fileName),
      totalBytes: size,
      source: String(resolved.source || "Samsung FUS"),
      freeBytes: free
    };
  }

  async createDownload(payload = {}, requestedBy = "admin") {
    if (!this.ready) throw new Error("download service is not ready");
    const hasSourceUrl = Boolean(String(payload.sourceUrl || "").trim());
    if (!hasSourceUrl && !(payload.model && payload.csc && payload.version)) {
      throw new Error("model, csc, and version are required when sourceUrl is omitted");
    }
    const sourceUrl = hasSourceUrl ? assertOfficialUrl(payload.sourceUrl, this.config.allowedHosts) : null;
    if (sourceUrl) await assertPublicHost(sourceUrl, this.lookupImpl);
    const free = await this.freeBytes();
    if (free < this.config.minFreeBytes) throw new Error("insufficient free disk space for a new download");
    const active = [...this.jobs.values()].find((job) => ["queued", "downloading", "verifying", "decrypting"].includes(job.state));
    if (active) throw new Error(`another download is already active: ${active.id}`);
    const id = randomUUID();
    const sourceName = sourceUrl
      ? safeName(decodeURIComponent(sourceUrl.pathname.split("/").pop() || "firmware.bin"))
      : "firmware.bin";
    const model = firmwareLabel(payload.model);
    const csc = firmwareLabel(payload.csc);
    const version = String(payload.version || "unknown");
    const outputName = await this.reserveOutputName(id, firmwareOutputName(model, csc, version, sourceName));
    const job = {
      id,
      state: "queued",
      model,
      csc,
      version,
      fileName: outputName,
      originalName: outputName,
      sourceHost: sourceUrl?.hostname || "",
      sourceUrl: sourceUrl?.toString() || "",
      sourceUrlHash: sourceUrl ? sourceUrlHash(sourceUrl) : "",
      sourceHeaders: null,
      downloadMode: sourceUrl ? "url" : "fus",
      requestedBy: String(requestedBy || "admin").slice(0, 80),
      bytes: 0,
      totalBytes: 0,
      speedBytesPerSecond: 0,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString()
    };
    this.jobs.set(id, job);
    await this.persist();
    try {
      if (this.queue) await this.enqueue(id);
    } catch (error) {
      this.jobs.delete(id);
      await this.persist();
      throw error;
    }
    return publicJob(job);
  }

  async reserveOutputName(id, requestedName) {
    const cleanName = safeName(requestedName, "firmware.bin");
    const extension = extname(cleanName);
    const stem = cleanName.slice(0, Math.max(0, cleanName.length - extension.length)) || "firmware";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt ? `_${String(id).slice(0, 8)}${attempt > 1 ? `_${attempt}` : ""}` : "";
      const candidate = safeName(`${stem}${suffix}${extension}`, "firmware.bin");
      const reservedByAnotherJob = [...this.jobs.values()].some((job) => job.id !== id && job.fileName === candidate);
      if (reservedByAnotherJob) continue;
      const exists = await stat(join(this.config.dir, candidate)).then(() => true).catch(() => false);
      if (!exists) return candidate;
    }
    throw new Error("could not reserve a unique firmware output name");
  }

  async enqueue(id) {
    if (!this.queue) return;
    const existing = await this.queue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (!["failed", "completed", "cancelled"].includes(state)) return;
      await existing.remove().catch(() => {});
    }
    await this.queue.add("download", { id }, {
      jobId: id,
      attempts: 2,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 100 }
    });
  }

  list() { return [...this.jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(publicJob); }

  get(id) {
    const job = this.jobs.get(String(id));
    return job ? publicJob(job) : null;
  }

  async cancel(id) {
    const job = this.jobs.get(String(id));
    if (!job) return false;
    if (["completed", "cancelled"].includes(job.state)) return false;
    this.controllers.get(job.id)?.abort(new Error("download cancelled by administrator"));
    if (this.queue) {
      const queued = await this.queue.getJob(job.id);
      await queued?.remove().catch(() => {});
    }
    delete job.parallel;
    job.state = "cancelled";
    job.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    await rm(join(this.config.dir, `${job.id}.part`), { force: true });
    await rm(join(this.config.dir, `${job.id}.decrypt.part`), { force: true });
    return true;
  }

  async pause(id) {
    const job = this.jobs.get(String(id));
    if (!job || !["queued", "downloading"].includes(job.state)) return false;
    // Mark first so runJob can distinguish an intentional pause from a
    // failure while its streams are unwinding.
    job.state = "paused";
    job.error = "";
    job.speedBytesPerSecond = 0;
    job.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    this.controllers.get(job.id)?.abort(new Error("download paused by administrator"));
    if (this.queue) {
      const queued = await this.queue.getJob(job.id);
      await queued?.remove().catch(() => {});
    }
    return true;
  }

  async resume(id) {
    const job = this.jobs.get(String(id));
    if (!job || job.state !== "paused") return false;
    if (this.controllers.has(job.id)) throw new Error("pause is still being applied; try again shortly");
    const active = [...this.jobs.values()].find((item) => item.id !== job.id && ["queued", "downloading", "verifying", "decrypting"].includes(item.state));
    if (active) throw new Error(`another download is already active: ${active.id}`);
    job.state = "queued";
    job.error = "";
    job.speedBytesPerSecond = 0;
    job.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    await this.enqueue(job.id);
    return true;
  }

  async remove(id) {
    const job = this.jobs.get(String(id));
    if (!job) return false;
    if (["queued", "downloading", "verifying", "decrypting"].includes(job.state)) {
      throw new Error("terminate the active download before deleting it");
    }
    if (this.queue) {
      const queued = await this.queue.getJob(job.id);
      await queued?.remove().catch(() => {});
    }
    await rm(join(this.config.dir, `${job.id}.part`), { force: true });
    await rm(join(this.config.dir, `${job.id}.decrypt.part`), { force: true });
    if (job.fileName) await rm(join(this.config.dir, safeName(job.fileName)), { force: true });
    this.jobs.delete(job.id);
    await this.persist();
    return true;
  }

  async decryptFirmwarePart(job, encryptedPath, outputPath, controller) {
    const encrypted = await stat(encryptedPath).catch(() => null);
    const useWorkers = this.config.decryptMode === "parallel" &&
      this.config.decryptWorkerCount > 1 &&
      encrypted?.size >= this.config.decryptWorkerMinBytes &&
      encrypted.size % 16 === 0;
    if (useWorkers) return this.decryptFirmwarePartParallel(job, encryptedPath, outputPath, controller);
    return this.decryptFirmwarePartStream(job, encryptedPath, outputPath, controller);
  }

  async decryptFirmwarePartParallel(job, encryptedPath, outputPath, controller) {
    const reader = createReadStream(encryptedPath, { highWaterMark: this.config.decryptChunkBytes });
    const writer = createWriteStream(outputPath, { flags: "w", mode: 0o640, highWaterMark: IO_BUFFER_BYTES });
    const pool = new AesDecryptWorkerPool(decryptionKey(job.decryption?.keySeed), this.config.decryptWorkerCount);
    const pending = [];
    const maxPending = Math.max(1, this.config.decryptWorkerCount * 2);
    let processed = 0;
    let lastPersist = 0;
    let persistFailure = null;
    let persistPending = Promise.resolve();
    let writerFailure = null;
    const onWriterError = (error) => { writerFailure ||= error; };
    writer.on("error", onWriterError);
    const onAbort = () => pool.abort(controller.signal.reason || new Error("download cancelled by administrator"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const consume = async (chunk) => {
      if (controller.signal.aborted) throw controller.signal.reason || new Error("download cancelled by administrator");
      if (writerFailure) throw writerFailure;
      await writeChunk(writer, chunk);
      if (writerFailure) throw writerFailure;
      processed += chunk.length;
      job.decryptBytes = processed;
      const now = this.now();
      updateRollingSpeed(job, "decrypt", processed, now);
      // Do not pause the worker pipeline on an index snapshot. The final
      // await still turns a persistence failure into a safe failed task.
      if (now - lastPersist > 1000) {
        lastPersist = now;
        job.updatedAt = new Date(now).toISOString();
        persistPending = persistPending.then(() => this.persist()).catch((error) => {
          persistFailure ||= error;
        });
      }
    };
    try {
      for await (const chunk of reader) {
        if (controller.signal.aborted) throw controller.signal.reason || new Error("download cancelled by administrator");
        if (chunk.length % 16 !== 0) throw new Error("encrypted firmware size is not AES block aligned");
        pending.push(pool.run(chunk));
        if (pending.length >= maxPending) await consume(await pending.shift());
      }
      while (pending.length) await consume(await pending.shift());
      if (writerFailure) throw writerFailure;
      await finishWriteStream(writer);
      await persistPending;
      if (persistFailure) throw persistFailure;
    } catch (error) {
      reader.destroy();
      writer.destroy();
      pool.abort(error);
      throw error;
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      writer.removeListener("error", onWriterError);
      await pool.close();
    }
  }

  async decryptFirmwarePartStream(job, encryptedPath, outputPath, controller) {
    // Keep one native AES-ECB stream alive for the whole file, matching
    // Bifrost's decryptProgress implementation. Each block is independent,
    // but a single stream avoids worker message copies and random disk I/O.
    const reader = createReadStream(encryptedPath, { highWaterMark: this.config.decryptStreamChunkBytes });
    const writer = createWriteStream(outputPath, {
      flags: "w",
      mode: 0o640,
      highWaterMark: this.config.decryptStreamChunkBytes
    });
    const decipher = createDecipheriv("aes-128-ecb", decryptionKey(job.decryption?.keySeed), null);
    decipher.setAutoPadding(false);
    let processed = 0;
    let lastPersist = 0;
    let persistFailure = null;
    let persistPending = Promise.resolve();
    const progress = new Transform({
      transform: (chunk, _encoding, callback) => {
        if (controller.signal.aborted) {
          callback(controller.signal.reason || new Error("download cancelled by administrator"));
          return;
        }
        processed += chunk.length;
        job.decryptBytes = processed;
        const now = this.now();
        updateRollingSpeed(job, "decrypt", processed, now);
        // Progress snapshots should never put the disk+AES pipeline on hold.
        // The final await below still surfaces a persistence failure safely.
        if (now - lastPersist > 1000) {
          lastPersist = now;
          job.updatedAt = new Date(now).toISOString();
          persistPending = persistPending.then(() => this.persist()).catch((error) => {
            persistFailure ||= error;
          });
        }
        callback(null, chunk);
      }
    });
    try {
      await pipeline(reader, decipher, progress, writer, { signal: controller.signal });
      await persistPending;
      if (persistFailure) throw persistFailure;
    } catch (error) {
      reader.destroy();
      writer.destroy();
      throw error;
    }
  }

  async downloadParallel(partPath, job, controller, { refreshAuthorization = null } = {}) {
    if (this.config.parallelSegments < 2) return false;
    const fetchRange = async (range, signal) => {
      while (true) {
        const response = await this.fetchOfficial(job.sourceUrl, signal, {
          ...(job.sourceHeaders || {}),
          range,
          "accept-encoding": "identity"
        });
        if (response.status !== 401) return response;
        await cancelResponseBody(response.body);
        if (!refreshAuthorization) throw new OfficialSourceAuthorizationError();
        // Refresh one shared FUS session without aborting healthy lanes. Active
        // responses have already been authorized and can continue transferring.
        await refreshAuthorization();
      }
    };
    const probe = await fetchRange("bytes=0-0", controller.signal);
    const probeRange = contentRange(probe.headers.get("content-range"));
    await cancelResponseBody(probe.body);
    if (probe.status !== 206 || !probeRange || probeRange.start !== 0 || probeRange.end !== 0) return false;
    const total = probeRange.total;
    if (!Number.isSafeInteger(total) || total < this.config.parallelMinBytes) return false;
    if (total > this.config.maxBytes) throw new Error("firmware file exceeds DOWNLOAD_MAX_BYTES");
    job.totalBytes = total;
    // Match Bifrost's layout: one long-lived Range request per lane for the
    // whole transfer. Samsung FUS can sharply throttle a client that keeps
    // opening fresh 256 MiB requests. Equal, persistent ranges avoid that
    // mid-download collapse while the bounded lane scaler can grow the
    // conservative eight-lane baseline to the configured twelve-lane ceiling.
    const requestedSegmentCount = Math.min(
      MAX_PARALLEL_RANGE_COUNT,
      total,
      Math.max(2, this.config.parallelMaxSegments)
    );
    const savedSegments = Array.isArray(job.parallel?.segments) ? job.parallel.segments : null;
    const savedFile = await stat(partPath).catch(() => null);
    const canResume = Boolean(
      job.parallel?.total === total &&
      savedFile?.size === total &&
      savedSegments?.length >= 2 &&
      savedSegments.every((segment, index) => {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        const downloaded = Number(segment?.bytes);
        return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isFinite(downloaded) &&
          start >= 0 && end >= start && end < total && downloaded >= 0 && downloaded <= end - start + 1 &&
          (index === 0 ? start === 0 : start === Number(savedSegments[index - 1]?.end) + 1);
      }) && Number(savedSegments.at(-1)?.end) === total - 1
    );
    if (!canResume) {
      const segmentSize = Math.ceil(total / requestedSegmentCount);
      const file = await open(partPath, "w+", 0o640);
      try {
        await file.truncate(total);
      } finally {
        await file.close();
      }
      job.parallel = {
        total,
        segments: Array.from({ length: requestedSegmentCount }, (_, index) => {
          const start = index * segmentSize;
          return { start, end: Math.min(total - 1, start + segmentSize - 1), bytes: 0 };
        })
      };
      job.bytes = 0;
      await this.persist();
    }
    const segments = job.parallel.segments;
    const maxLaneCount = Math.min(this.config.parallelMaxSegments, segments.length);
    let enabledLanes = Math.min(this.config.parallelSegments, maxLaneCount);
    job.parallel.lanes = enabledLanes;
    job.parallel.maxLanes = maxLaneCount;
    job.parallel.activeLanes = 0;
    let completedRanges = segments.filter((segment) => Number(segment.bytes || 0) >= segment.end - segment.start + 1).length;
    job.parallel.completedRanges = completedRanges;
    const segmentController = new AbortController();
    const segmentSignal = AbortSignal.any
      ? AbortSignal.any([controller.signal, segmentController.signal])
      : controller.signal;
    let receivedBytes = segments.reduce((sum, segment) => sum + Number(segment.bytes || 0), 0);
    const received = () => receivedBytes;
    let lastFreeCheckBytes = 0;
    let lastPersist = 0;
    let freeCheckInFlight = null;
    let activeLanes = 0;
    const checkFreeSpace = async (force = false) => {
      const downloaded = received();
      if (!force && downloaded - lastFreeCheckBytes < FREE_SPACE_CHECK_INTERVAL_BYTES) return;
      if (freeCheckInFlight) return freeCheckInFlight;
      freeCheckInFlight = (async () => {
        const remainingRaw = Math.max(0, total - downloaded);
        const remainingOutput = isDecryptingFirmware(job) ? total : 0;
        if ((await this.freeBytes()) - remainingRaw - remainingOutput < this.config.minFreeBytes) {
          throw new Error("download stopped to preserve the configured free disk space");
        }
        lastFreeCheckBytes = downloaded;
      })();
      try { await freeCheckInFlight; } finally { freeCheckInFlight = null; }
    };
    const persistProgress = async (force = false) => {
      job.bytes = received();
      if (job.parallel) {
        job.parallel.activeLanes = activeLanes;
        job.parallel.completedRanges = completedRanges;
        job.parallel.lanes = enabledLanes;
      }
      const startedBytes = Number(job.downloadStartBytes || 0);
      const now = this.now();
      updateRollingSpeed(job, "download", Math.max(0, job.bytes - startedBytes), now);
      if (!force && now - lastPersist <= 1000) return;
      lastPersist = now;
      job.updatedAt = new Date(now).toISOString();
      await this.persist();
    };
    let scaleTimer = null;
    try {
      await checkFreeSpace(true);
      let nextSegmentIndex = 0;
      const claimedSegments = new Set();
      let noMoreSegmentsToClaim = false;
      const claimNextSegment = () => {
        for (let offset = 0; offset < segments.length; offset += 1) {
          const index = (nextSegmentIndex + offset) % segments.length;
          const segment = segments[index];
          if (claimedSegments.has(index) || Number(segment.bytes || 0) >= segment.end - segment.start + 1) continue;
          claimedSegments.add(index);
          nextSegmentIndex = (index + 1) % segments.length;
          return { segment, index };
        }
        noMoreSegmentsToClaim = true;
        return null;
      };
      const waitForLaneActivation = async (lane) => {
        while (lane >= enabledLanes) {
          if (noMoreSegmentsToClaim) return false;
          await waitWithAbort(250, segmentSignal);
        }
        return true;
      };
      if (enabledLanes < maxLaneCount) {
        scaleTimer = setInterval(() => {
          if (noMoreSegmentsToClaim || enabledLanes >= maxLaneCount) return;
          const currentSpeed = Math.max(0, Number(job.speedBytesPerSecond || 0));
          if (!currentSpeed || currentSpeed >= this.config.parallelScaleTargetBytesPerSecond) return;
          const previous = enabledLanes;
          enabledLanes = Math.min(maxLaneCount, enabledLanes + this.config.parallelScaleStep);
          if (enabledLanes !== previous) {
            job.parallel.lanes = enabledLanes;
            this.logger.info?.(
              `Samsung firmware throughput ${Math.round(currentSpeed / 1024 / 1024)} MiB/s is below target; increasing Range lanes from ${previous} to ${enabledLanes}.`
            );
          }
        }, this.config.parallelScaleIntervalMs);
        scaleTimer.unref?.();
      }
      const downloadSegment = async (segment) => {
        let attempts = 0;
        const file = await open(partPath, "r+");
        try {
          while (segment.bytes < segment.end - segment.start + 1) {
            if (segmentSignal.aborted) throw segmentSignal.reason || new Error("download cancelled by administrator");
            const start = segment.start + segment.bytes;
            let reader;
            let requestBytes = 0;
            let flushPendingOnAbort = null;
            try {
              const response = await fetchRange(`bytes=${start}-${segment.end}`, segmentSignal);
              const range = contentRange(response.headers.get("content-range"));
              if (response.status !== 206 || !range || range.start !== start || range.end !== segment.end || range.total !== total) {
                await cancelResponseBody(response.body);
                throw new Error("Samsung official source rejected parallel range download");
              }
              reader = response.body?.getReader();
              if (!reader) throw new Error("Samsung official source returned an empty segment");
              let position = start;
              let pendingChunks = [];
              let pendingBytes = 0;
              const flushPending = async () => {
                if (!pendingBytes) return;
                const committedBytes = pendingBytes;
                const rangeLength = segment.end - segment.start + 1;
                const wasComplete = segment.bytes >= rangeLength;
                await writeChunksAt(file, pendingChunks, committedBytes, position);
                position += committedBytes;
                requestBytes += committedBytes;
                segment.bytes += committedBytes;
                receivedBytes += committedBytes;
                if (!wasComplete && segment.bytes >= rangeLength) completedRanges += 1;
                pendingChunks = [];
                pendingBytes = 0;
                await checkFreeSpace();
                await persistProgress();
              };
              flushPendingOnAbort = flushPending;
              while (true) {
                if (segmentSignal.aborted) throw segmentSignal.reason || new Error("download cancelled by administrator");
                const { done, value } = await withBodyIdleDeadline(
                  reader.read(),
                  this.config.bodyIdleTimeoutMs,
                  segmentSignal
                );
                if (done) break;
                const remaining = segment.end + 1 - position - pendingBytes;
                if (value.byteLength > remaining) throw new Error("Samsung official source returned an oversized segment");
                // Commit only full positional write batches. If a request is
                // interrupted, bytes still in memory are deliberately retried
                // rather than being marked complete before they reach disk.
                pendingChunks.push(value);
                pendingBytes += value.byteLength;
                if (pendingBytes >= this.config.parallelWriteBatchBytes) await flushPending();
              }
              await flushPending();
              if (position !== segment.end + 1) throw new Error("Samsung official source returned an incomplete segment");
              attempts = 0;
            } catch (error) {
              if (segmentSignal.aborted) {
                // A pause/cancel may arrive while a sub-batch is only in RAM.
                // Finish its positional write when possible so resume starts at
                // the durable boundary; if the write itself fails, progress is
                // intentionally left unchanged and the bytes are retried.
                await flushPendingOnAbort?.().catch(() => {});
                throw error;
              }
              // A connection that transferred useful bytes can resume exactly
              // at the committed offset and should not consume the no-progress
              // retry budget for a multi-gigabyte firmware.
              attempts = requestBytes > 0 ? 0 : attempts + 1;
              if (attempts > this.config.parallelRetries) throw error;
              await waitWithAbort(250 * Math.max(1, attempts), segmentSignal);
              continue;
            } finally {
              await cancelBodyReader(reader);
            }
          }
        } finally {
          await file.close();
        }
      };
      const segmentTasks = Array.from({ length: maxLaneCount }, async (_, lane) => {
        await waitWithAbort(Math.min(lane, Math.max(0, enabledLanes - 1)) * this.config.parallelStaggerMs, segmentSignal);
        if (!await waitForLaneActivation(lane)) return;
        while (true) {
          const claimed = claimNextSegment();
          if (!claimed) return;
          activeLanes += 1;
          try {
            await downloadSegment(claimed.segment);
          } finally {
            activeLanes -= 1;
            claimedSegments.delete(claimed.index);
          }
        }
      });
      try {
        await Promise.all(segmentTasks);
      } catch (error) {
        if (!controller.signal.aborted) segmentController.abort(error);
        await Promise.allSettled(segmentTasks);
        throw error;
      }
      await checkFreeSpace(true);
      job.bytes = total;
      job.totalBytes = total;
      job.speedBytesPerSecond = Math.max(0, Number(job.speedBytesPerSecond || 0));
      await persistProgress(true);
      return true;
    } catch (error) {
      job.bytes = received();
      await persistProgress(true);
      if (controller.signal.aborted) throw error;
      if (error instanceof OfficialSourceAuthorizationError) {
        // A FUS session can expire while other lanes are still transferring a
        // large firmware. Keep the preallocated part and each lane's durable
        // byte count so the next authenticated session resumes only what is
        // missing instead of redownloading the whole file.
        throw error;
      }
      this.logger.warn?.(`Parallel firmware download unavailable; falling back to one connection: ${error.message}`);
      await rm(partPath, { force: true });
      delete job.parallel;
      return false;
    } finally {
      if (scaleTimer) clearInterval(scaleTimer);
    }
  }

  async runJob(queueJob) {
    const job = this.jobs.get(String(queueJob.data?.id));
    if (!job || ["paused", "cancelled", "completed"].includes(job.state)) return;
    const partPath = join(this.config.dir, `${job.id}.part`);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const downloadStartedAt = this.now();
      const existingPart = await stat(partPath).catch(() => null);
      let transferComplete = Boolean(
        job.downloadComplete === true &&
        Number(job.totalBytes || 0) > 0 &&
        existingPart?.size === Number(job.totalBytes) &&
        job.fileName
      );
      if (job.downloadComplete && !transferComplete) {
        delete job.downloadComplete;
        delete job.downloadVerified;
        delete job.parallel;
        job.bytes = 0;
      }

      job.state = transferComplete && !job.downloadVerified ? "verifying" : "downloading";
      job.downloadStartedAt = new Date(downloadStartedAt).toISOString();
      job.downloadStartBytes = Number(job.bytes || 0);
      resetSpeedTracking(job, "download", job.downloadStartBytes, downloadStartedAt);
      job.updatedAt = new Date(downloadStartedAt).toISOString();
      await this.persist();
      let actualCrc32 = null;
      const resolveFusJob = async ({ refresh = false } = {}) => {
        const resolved = await this.resolveImpl(this.fusEnv, job.model, job.csc, job.version, { role: "admin", signal: controller.signal });
        const nextSourceUrl = String(resolved.sourceUrl || "");
        const nextEncryptedFileName = safeName(resolved.fileName, "firmware.bin");
        const nextExpectedCrc32 = expectedCrc32(resolved.crc32);
        const nextSize = Math.max(0, Number(resolved.size || 0));
        const nextDecryption = resolved.decryption?.keySeed
          ? { mode: resolved.decryption.mode, keySeed: String(resolved.decryption.keySeed) }
          : null;
        if (refresh) {
          if (job.encryptedFileName && nextEncryptedFileName !== job.encryptedFileName) {
            throw new Error("Samsung FUS authorization refresh returned a different firmware file");
          }
          if (Number(job.totalBytes || 0) > 0 && nextSize > 0 && nextSize !== Number(job.totalBytes)) {
            throw new Error("Samsung FUS authorization refresh returned a different firmware size");
          }
          if (job.expectedCrc32 !== null && job.expectedCrc32 !== undefined &&
              nextExpectedCrc32 !== null && nextExpectedCrc32 !== job.expectedCrc32) {
            throw new Error("Samsung FUS authorization refresh returned a different firmware checksum");
          }
          if (job.decryption?.keySeed &&
              (!nextDecryption?.keySeed || nextDecryption.mode !== job.decryption.mode || nextDecryption.keySeed !== job.decryption.keySeed)) {
            throw new Error("Samsung FUS authorization refresh returned different firmware decryption metadata");
          }
        }
        job.sourceUrl = nextSourceUrl;
        job.sourceUrlHash = sourceUrlHash(job.sourceUrl);
        job.sourceHost = new URL(job.sourceUrl).hostname;
        job.sourceHeaders = resolved.sourceHeaders || null;
        job.encryptedFileName = nextEncryptedFileName;
        job.decryption = nextDecryption;
        if (nextExpectedCrc32 !== null || !refresh) job.expectedCrc32 = nextExpectedCrc32;
        if (resolved.version) job.version = resolved.version;
        const outputName = firmwareOutputName(job.model, job.csc, job.version, nextEncryptedFileName);
        if (!refresh) job.fileName = await this.reserveOutputName(job.id, outputName);
        job.originalName = job.fileName;
        await this.persist();
      };
      if (!transferComplete) {
        if (job.downloadMode === "fus" || !job.sourceUrl) await resolveFusJob();
        let parallelCompleted = false;
        let authorizationRefreshesWithoutProgress = 0;
        let authorizationRefreshBytes = Number(job.bytes || 0);
        let authorizationRefreshPromise = null;
        const refreshFusAuthorization = () => {
          if (authorizationRefreshPromise) return authorizationRefreshPromise;
          authorizationRefreshPromise = (async () => {
            const currentBytes = Number(job.bytes || 0);
            if (currentBytes > authorizationRefreshBytes) {
              authorizationRefreshBytes = currentBytes;
              authorizationRefreshesWithoutProgress = 0;
            } else {
              authorizationRefreshesWithoutProgress += 1;
            }
            if (authorizationRefreshesWithoutProgress >= 2) {
              throw new Error("Samsung official source repeatedly rejected a refreshed FUS authorization before download progress could continue");
            }
            this.logger.warn?.("Samsung FUS download authorization expired; refreshing one shared official session without stopping active lanes.");
            await resolveFusJob({ refresh: true });
          })().finally(() => {
            authorizationRefreshPromise = null;
          });
          return authorizationRefreshPromise;
        };
        while (true) {
          try {
            parallelCompleted = await this.downloadParallel(partPath, job, controller, {
              refreshAuthorization: job.downloadMode === "fus" ? refreshFusAuthorization : null
            });
            break;
          } catch (error) {
            if (!(error instanceof OfficialSourceAuthorizationError) || job.downloadMode !== "fus") throw error;
            await refreshFusAuthorization();
          }
        }
        if (!parallelCompleted) {
          let response;
          while (true) {
            response = await this.fetchOfficial(job.sourceUrl, controller.signal, job.sourceHeaders || {});
            if (response.status !== 401 || job.downloadMode !== "fus") break;
            await cancelResponseBody(response.body);
            await refreshFusAuthorization();
          }
          if (!response.ok) {
            await cancelResponseBody(response.body);
            throw new Error(`official source returned HTTP ${response.status}`);
          }
          const advertised = Number(response.headers.get("content-length") || 0);
          if (advertised > this.config.maxBytes) throw new Error("firmware file exceeds DOWNLOAD_MAX_BYTES");
          job.totalBytes = advertised;
          const writer = createWriteStream(partPath, { flags: "w", mode: 0o640, highWaterMark: IO_BUFFER_BYTES });
          let received = 0;
          let crc32 = 0;
          let lastFreeCheckBytes = 0;
          let lastPersist = 0;
          try {
            for await (const chunk of responseBodyChunks(response.body, this.config.bodyIdleTimeoutMs, controller.signal)) {
              received += chunk.length;
              if (received > this.config.maxBytes) throw new Error("firmware file exceeds DOWNLOAD_MAX_BYTES");
              const knownTotal = advertised || received;
              if (received - lastFreeCheckBytes >= FREE_SPACE_CHECK_INTERVAL_BYTES || lastFreeCheckBytes === 0) {
                const remainingOutput = isDecryptingFirmware(job) ? knownTotal : 0;
                if ((await this.freeBytes()) - Math.max(0, knownTotal - received) - remainingOutput < this.config.minFreeBytes) {
                  throw new Error("download stopped to preserve the configured free disk space");
                }
                lastFreeCheckBytes = received;
              }
              await writeChunk(writer, chunk);
              crc32 = updateCrc32(crc32, chunk);
              job.bytes = received;
              const now = this.now();
              updateRollingSpeed(job, "download", received, now);
              if (now - lastPersist > 1000) {
                lastPersist = now;
                job.updatedAt = new Date(now).toISOString();
                await this.persist();
              }
            }
            await finishWriteStream(writer);
          } catch (error) {
            writer.destroy();
            throw error;
          }
          job.bytes = received;
          job.totalBytes = advertised || received;
          actualCrc32 = crc32 >>> 0;
        }
        transferComplete = true;
        job.downloadComplete = true;
        job.speedBytesPerSecond = Math.max(0, Number(job.speedBytesPerSecond || 0));
        job.updatedAt = new Date(this.now()).toISOString();
        await this.persist();
      }

      if (!job.downloadVerified) {
        job.state = "verifying";
        job.verifyBytes = 0;
        const verifyStartedAt = this.now();
        resetSpeedTracking(job, "verify", 0, verifyStartedAt);
        job.updatedAt = new Date(verifyStartedAt).toISOString();
        await this.persist();
        if (job.expectedCrc32 !== null && job.expectedCrc32 !== undefined) {
          let lastVerifyPersist = 0;
          let verifyPersistFailure = null;
          let verifyPersistPending = Promise.resolve();
          if (actualCrc32 === null) {
            actualCrc32 = await fileCrc32(partPath, controller.signal, (processed) => {
              job.verifyBytes = processed;
              const now = this.now();
              updateRollingSpeed(job, "verify", processed, now);
              if (now - lastVerifyPersist > 1000) {
                lastVerifyPersist = now;
                job.updatedAt = new Date(now).toISOString();
                verifyPersistPending = verifyPersistPending.then(() => this.persist()).catch((error) => {
                  verifyPersistFailure ||= error;
                });
              }
            });
            await verifyPersistPending;
            if (verifyPersistFailure) throw verifyPersistFailure;
          }
          if (actualCrc32 !== job.expectedCrc32) throw new Error("Samsung firmware CRC verification failed");
        }
        job.downloadVerified = true;
        delete job.parallel;
        delete job.verifyBytes;
        job.updatedAt = new Date(this.now()).toISOString();
        await this.persist();
      }

      if (controller.signal.aborted) throw controller.signal.reason || new Error("download cancelled by administrator");
      const finalPath = join(this.config.dir, job.fileName);
      if (isDecryptingFirmware(job)) {
        if ((await this.freeBytes()) - Number(job.bytes || 0) < this.config.minFreeBytes) {
          throw new Error("download completed but decrypting it would breach the configured free disk reserve");
        }
        const decryptPartPath = join(this.config.dir, `${job.id}.decrypt.part`);
        job.state = "decrypting";
        job.decryptBytes = 0;
        const decryptStartedAt = this.now();
        resetSpeedTracking(job, "decrypt", 0, decryptStartedAt);
        job.updatedAt = new Date(decryptStartedAt).toISOString();
        await this.persist();
        await this.decryptFirmwarePart(job, partPath, decryptPartPath, controller);
        if (controller.signal.aborted) throw controller.signal.reason || new Error("download cancelled by administrator");
        await rename(decryptPartPath, finalPath);
        await rm(partPath, { force: true });
      } else {
        await rename(partPath, finalPath);
      }
      if (controller.signal.aborted) {
        await rm(finalPath, { force: true });
        throw controller.signal.reason || new Error("download cancelled by administrator");
      }
      job.state = "completed";
      delete job.downloadComplete;
      delete job.downloadVerified;
      delete job.parallel;
      delete job.verifyBytes;
      job.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
    } catch (error) {
      if (this.closing) {
        job.state = "queued";
        job.speedBytesPerSecond = 0;
        job.updatedAt = new Date(this.now()).toISOString();
        await this.persist();
        return;
      }
      if (job.state === "paused") {
        job.speedBytesPerSecond = 0;
        job.updatedAt = new Date(this.now()).toISOString();
        await this.persist();
        return;
      }
      await rm(partPath, { force: true });
      await rm(join(this.config.dir, `${job.id}.decrypt.part`), { force: true });
      delete job.parallel;
      delete job.downloadComplete;
      delete job.downloadVerified;
      delete job.verifyBytes;
      if (job.state !== "cancelled") {
        const configuredAttempts = Math.max(1, Number(queueJob?.opts?.attempts || 1));
        const attemptsMade = Math.max(0, Number(queueJob?.attemptsMade || 0));
        const retryScheduled = attemptsMade + 1 < configuredAttempts;
        job.state = retryScheduled ? "queued" : "failed";
        const message = String(error?.message || error || "download failed");
        job.error = retryScheduled
          ? `${message}; a clean automatic retry is scheduled`.slice(0, 240)
          : message.slice(0, 240);
        job.updatedAt = new Date(this.now()).toISOString();
        await this.persist();
      }
      throw error;
    } finally {
      this.controllers.delete(job.id);
    }
  }

  async fetchOfficial(sourceUrl, signal, requestHeaders = {}) {
    let current = assertOfficialUrl(sourceUrl, this.config.allowedHosts);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await assertPublicHost(current, this.lookupImpl);
      const deadline = responseHeaderDeadline(signal, this.config.responseHeaderTimeoutMs);
      let response;
      try {
        response = await this.fetchImpl(current, {
          redirect: "manual",
          signal: deadline.signal,
          headers: { "user-agent": "OneUI-Firmware-Downloader/1.0", ...requestHeaders }
        });
      } finally {
        // The timer protects only connection/response-header latency. The
        // caller's signal remains attached to the response body for cancel.
        deadline.clear();
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) {
        await cancelResponseBody(response.body);
        throw new Error("official source returned a redirect without Location");
      }
      await cancelResponseBody(response.body);
      current = assertOfficialUrl(new URL(location, current), this.config.allowedHosts);
    }
    throw new Error("too many redirects from official source");
  }

  async file(id) {
    const job = this.jobs.get(String(id));
    if (!job || job.state !== "completed") return null;
    const filePath = join(this.config.dir, job.fileName);
    const pathFromRoot = relative(this.config.dir, filePath);
    if (!pathFromRoot || pathFromRoot.split(/[\\/]/).includes("..")) throw new Error("invalid download path");
    await access(filePath);
    return { stream: createReadStream(filePath), fileName: job.originalName, size: job.bytes };
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.ready = false;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const [id, controller] of this.controllers) {
      const job = this.jobs.get(id);
      if (job && ["downloading", "verifying", "decrypting"].includes(job.state)) {
        job.state = "queued";
        job.speedBytesPerSecond = 0;
        job.updatedAt = new Date(this.now()).toISOString();
      }
      controller.abort(new Error("download service is shutting down"));
    }
    await this.persist().catch(() => {});
    // BullMQ's default close waits for the active processor to finish. A FUS
    // request can still be waiting on the upstream source at this point, which
    // previously let systemd hit TimeoutStopSec and SIGKILL the process. The
    // job state has already been persisted as queued and its AbortController
    // has been signalled above, so force-close is the safe shutdown behavior.
    await this.worker?.close(true).catch(() => {});
    await this.queue?.close().catch(() => {});
    this.redis?.disconnect();
  }
}

function firstHeader(request, name) {
  const value = request.headers?.[name.toLowerCase()] ?? request.headers?.[name];
  return Array.isArray(value) ? value[0] : String(value || "");
}

function requireDownloadKey(request, reply, secret) {
  if (!constantTimeSecretEquals(secret, firstHeader(request, "x-download-api-key"))) {
    reply.code(403).send({ ok: false, error: "Forbidden" });
    return false;
  }
  return true;
}

export function buildDownloadApp({ app = null, service, version = "1.0.0" } = {}) {
  if (!service) throw new TypeError("buildDownloadApp requires a FirmwareDownloadService");
  app ||= Fastify({
    logger: false,
    requestTimeout: service.config.apiRequestTimeoutMs,
    bodyLimit: 64 * 1024
  });
  app.get("/", async () => ({ ok: true, service: "oneui-firmware-download", version }));
  app.get("/health", async (_request, reply) => {
    try {
      const health = await service.health();
      reply.code(health.ok ? 200 : 503);
      return { ...health, service: "oneui-firmware-download", version, time: new Date().toISOString() };
    } catch {
      reply.code(503);
      return { ok: false, service: "oneui-firmware-download", version };
    }
  });
  app.get("/api/v1/downloads", async (request, reply) => {
    if (!requireDownloadKey(request, reply, service.config.apiSecret)) return;
    return { ok: true, downloads: service.list() };
  });
  app.post("/api/v1/downloads/preview", async (request, reply) => {
    if (!requireDownloadKey(request, reply, service.config.apiSecret)) return;
    try {
      return { ok: true, preview: await service.preview(request.body || {}) };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: String(error?.message || error).slice(0, 240) };
    }
  });
  app.post("/api/v1/downloads", async (request, reply) => {
    if (!requireDownloadKey(request, reply, service.config.apiSecret)) return;
    try {
      const job = await service.create(request.body || {}, firstHeader(request, "x-admin-id") || "admin");
      reply.code(202);
      return { ok: true, download: job };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: String(error?.message || error).slice(0, 240) };
    }
  });
  app.get("/api/v1/downloads/:id", async (request, reply) => {
    if (!requireDownloadKey(request, reply, service.config.apiSecret)) return;
    const job = service.get(request.params.id);
    if (!job) { reply.code(404); return { ok: false, error: "Download not found" }; }
    return { ok: true, download: job };
  });
  app.delete("/api/v1/downloads/:id", async (request, reply) => {
    if (!requireDownloadKey(request, reply, service.config.apiSecret)) return;
    const cancelled = await service.cancel(request.params.id);
    if (!cancelled) { reply.code(404); return { ok: false, error: "Download not found or already finished" }; }
    return { ok: true, cancelled: true };
  });
  app.post("/api/v1/downloads/:id/pause", async (request, reply) => {
    if (!requireDownloadKey(request, reply, service.config.apiSecret)) return;
    const paused = await service.pause(request.params.id);
    if (!paused) { reply.code(400); return { ok: false, error: "Download is not queued or downloading" }; }
    return { ok: true, paused: true };
  });
  app.post("/api/v1/downloads/:id/resume", async (request, reply) => {
    if (!requireDownloadKey(request, reply, service.config.apiSecret)) return;
    try {
      const resumed = await service.resume(request.params.id);
      if (!resumed) { reply.code(400); return { ok: false, error: "Download is not paused" }; }
      return { ok: true, resumed: true };
    } catch (error) {
      reply.code(409);
      return { ok: false, error: String(error?.message || error).slice(0, 240) };
    }
  });
  app.post("/api/v1/downloads/:id/delete", async (request, reply) => {
    if (!requireDownloadKey(request, reply, service.config.apiSecret)) return;
    try {
      const deleted = await service.remove(request.params.id);
      if (!deleted) { reply.code(404); return { ok: false, error: "Download not found" }; }
      return { ok: true, deleted: true };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: String(error?.message || error).slice(0, 240) };
    }
  });
  app.get("/files/:id", async (request, reply) => {
    if (!requireDownloadKey(request, reply, service.config.apiSecret)) return;
    try {
      const file = await service.file(request.params.id);
      if (!file) { reply.code(404); return { ok: false, error: "Completed file not found" }; }
      reply.header("content-type", "application/octet-stream");
      reply.header("content-length", String(file.size));
      reply.header("content-disposition", `attachment; filename="${safeName(file.fileName)}"`);
      return reply.send(file.stream);
    } catch {
      reply.code(404);
      return { ok: false, error: "Completed file not found" };
    }
  });
  return app;
}

export async function startDownloadServer({ env = process.env, logger = console } = {}) {
  const config = createDownloadConfig(env);
  if (!config.apiSecret) throw new Error("DOWNLOAD_API_SECRET is required");
  if (!config.redisUrl) throw new Error("REDIS_URL is required for the download service");
  const service = await new FirmwareDownloadService({ config, logger, fusEnv: env }).init({ startQueue: true });
  const app = buildDownloadApp({ service, version: text(env.APP_VERSION, "2.21.0") });
  await app.listen({ host: config.host, port: config.port });
  logger.info?.(`OneUI download API listening on ${config.host}:${config.port}`);
  let closePromise = null;
  const close = () => {
    if (!closePromise) {
      closePromise = (async () => {
        await app.close().catch(() => {});
        await service.close();
      })();
    }
    return closePromise;
  };
  const stop = (signal) => {
    // Keep shutdown bounded below systemd's 30-second TimeoutStopSec. The
    // persisted task state lets the next service instance resume safely if an
    // upstream socket ignores abort during process shutdown.
    const hardExit = setTimeout(() => {
      logger.error?.(`Download service shutdown exceeded 20 seconds after ${signal}; exiting for systemd recovery.`);
      process.exit(1);
    }, 20_000);
    close().catch((error) => {
      logger.error?.(`Download service shutdown failed: ${error?.message || error}`);
    }).finally(() => clearTimeout(hardExit));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  return { app, service, config, close };
}
