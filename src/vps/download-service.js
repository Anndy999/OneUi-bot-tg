import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, statfs, writeFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import Fastify from "fastify";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { constantTimeSecretEquals } from "./config.js";
import { resolveVpsOfficialFirmwareDownload } from "./fus-resolver.js";

const DEFAULT_ALLOWED_HOSTS = ["samsung.com", "samsungmobile.com", "ospserver.net", "cdngc.net"];
const MAX_REDIRECTS = 5;
const FREE_SPACE_CHECK_INTERVAL_BYTES = 64 * 1024 * 1024;
const JOB_STATES = new Set(["queued", "downloading", "decrypting", "completed", "failed", "cancelled"]);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

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
  return {
    host: text(env.DOWNLOAD_HOST, "127.0.0.1"),
    port: integer(env.DOWNLOAD_PORT || 8788, 8788, 1, 65535),
    dir: resolve(text(env.DOWNLOAD_DIR, "./data/firmware")),
    apiSecret: text(env.DOWNLOAD_API_SECRET),
    redisUrl: text(env.REDIS_URL),
    queuePrefix: text(env.DOWNLOAD_QUEUE_PREFIX, "oneui-download"),
    maxBytes: bytes(env.DOWNLOAD_MAX_BYTES, 20 * 1024 ** 3),
    minFreeBytes: bytes(env.DOWNLOAD_MIN_FREE_BYTES, 40 * 1024 ** 3),
    completedTtlMs: integer(env.DOWNLOAD_COMPLETED_TTL_MS || 7 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000, 0, 365 * 24 * 60 * 60 * 1000),
    partTtlMs: integer(env.DOWNLOAD_PART_TTL_MS || 6 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
    responseHeaderTimeoutMs: integer(env.DOWNLOAD_RESPONSE_HEADER_TIMEOUT_MS || env.DOWNLOAD_REQUEST_TIMEOUT_MS || 60_000, 60_000, 5_000, 10 * 60_000),
    parallelSegments: integer(env.DOWNLOAD_PARALLEL_SEGMENTS || 8, 8, 1, 8),
    parallelStaggerMs: integer(env.DOWNLOAD_PARALLEL_STAGGER_MS || 100, 100, 0, 5_000),
    parallelMinBytes: bytes(env.DOWNLOAD_PARALLEL_MIN_BYTES, 64 * 1024 * 1024),
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
  const { sourceUrl: _sourceUrl, sourceUrlHash: _sourceUrlHash, sourceHeaders: _sourceHeaders, decryption: _decryption, encryptedFileName: _encryptedFileName, expectedCrc32: _expectedCrc32, filePath: _filePath, ...safe } = job;
  const decrypting = safe.state === "decrypting";
  const progressBytes = decrypting ? Number(safe.decryptBytes || 0) : Number(safe.bytes || 0);
  const percent = safe.state === "completed" ? 100 : safe.totalBytes
    ? (decrypting
      ? Math.min(99, 85 + Math.floor((progressBytes / safe.totalBytes) * 15))
      : Math.min(100, Math.floor((progressBytes / safe.totalBytes) * 85)))
    : null;
  const speedBytesPerSecond = Math.max(0, Number(safe.speedBytesPerSecond || 0));
  const etaSeconds = safe.totalBytes && speedBytesPerSecond > 0
    ? Math.max(0, Math.ceil((safe.totalBytes - progressBytes) / speedBytesPerSecond))
    : null;
  return { ...safe, percent, speedBytesPerSecond, etaSeconds };
}

function decryptFileName(fileName) {
  return String(fileName || "firmware.bin").replace(/\.enc(?:2|4)$/i, "") || "firmware.bin";
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

function contentRange(value) {
  const match = String(value || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

async function fileCrc32(filePath, signal) {
  const reader = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
  let crc = 0xffffffff;
  for await (const chunk of reader) {
    if (signal.aborted) throw signal.reason || new Error("download cancelled by administrator");
    crc = updateCrc32(crc, chunk);
  }
  return (~crc) >>> 0;
}

function updateCrc32(current, chunk) {
  let crc = current >>> 0;
  for (const byte of chunk) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

function expectedCrc32(value) {
  const text = String(value || "").trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text) >>> 0;
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
    this.ready = false;
  }

  async init({ startQueue = Boolean(this.config.redisUrl) } = {}) {
    await mkdir(this.config.dir, { recursive: true, mode: 0o750 });
    await this.loadIndex();
    await this.cleanupFiles();
    if (startQueue) {
      if (!this.config.redisUrl) throw new Error("REDIS_URL is required for download queue");
      const options = connectionOptions(this.config.redisUrl);
      this.redis = new Redis(this.config.redisUrl, { ...options, lazyConnect: true });
      this.redis.on("error", (error) => this.logger.warn?.(`Download Redis error: ${error.message}`));
      await this.redis.connect();
      this.queue = new Queue("firmware-download", { connection: connectionOptions(this.config.redisUrl), prefix: this.config.queuePrefix });
      const workerConnection = new Redis(this.config.redisUrl, { ...options, lazyConnect: true });
      workerConnection.on("error", (error) => this.logger.warn?.(`Download worker Redis error: ${error.message}`));
      this.worker = new Worker("firmware-download", (job) => this.runJob(job), {
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

  get indexPath() { return join(this.config.dir, "index.json"); }

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
      if (["downloading", "decrypting"].includes(job.state)) job.state = "queued";
    }
  }

  async persist() {
    const temporary = `${this.indexPath}.tmp-${process.pid}`;
    await writeFile(temporary, jsonSafe(Object.fromEntries(this.jobs)), { mode: 0o640 });
    await rename(temporary, this.indexPath);
  }

  async cleanupFiles() {
    const entries = await readdir(this.config.dir, { withFileTypes: true });
    const partCutoff = this.now() - this.config.partTtlMs;
    const completedCutoff = this.now() - this.config.completedTtlMs;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = join(this.config.dir, entry.name);
      const info = await stat(filePath).catch(() => null);
      if (!info) continue;
      if (entry.name.endsWith(".part") && info.mtimeMs < partCutoff) {
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
    await this.persist();
  }

  async freeBytes() {
    const info = await statfs(this.config.dir);
    return Number(info.bavail) * Number(info.bsize);
  }

  async health() {
    const free = await this.freeBytes();
    return { ok: free >= this.config.minFreeBytes, freeBytes: free, minFreeBytes: this.config.minFreeBytes, jobs: this.jobs.size };
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
    return {
      model: String(resolved.model || payload.model).toUpperCase(),
      csc: String(resolved.csc || payload.csc).toUpperCase(),
      version: String(resolved.version || payload.version),
      originalName: safeName(resolved.fileName, "firmware.bin"),
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
    const active = [...this.jobs.values()].find((job) => ["queued", "downloading", "decrypting"].includes(job.state));
    if (active) throw new Error(`another download is already active: ${active.id}`);
    const id = randomUUID();
    const sourceName = sourceUrl
      ? safeName(decodeURIComponent(sourceUrl.pathname.split("/").pop() || "firmware.bin"))
      : "firmware.bin";
    const extension = extname(sourceName).slice(0, 12) || ".bin";
    const job = {
      id,
      state: "queued",
      model: safeName(payload.model, "unknown"),
      csc: safeName(payload.csc, "unknown"),
      version: safeName(payload.version, "unknown"),
      fileName: `${id}${extension}`,
      originalName: sourceName,
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
    job.state = "cancelled";
    job.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    await rm(join(this.config.dir, `${job.id}.part`), { force: true });
    await rm(join(this.config.dir, `${job.id}.decrypt.part`), { force: true });
    return true;
  }

  async remove(id) {
    const job = this.jobs.get(String(id));
    if (!job) return false;
    if (["queued", "downloading", "decrypting"].includes(job.state)) {
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
    const { createReadStream, createWriteStream } = await import("node:fs");
    const reader = createReadStream(encryptedPath, { highWaterMark: 1024 * 1024 });
    const writer = createWriteStream(outputPath, { flags: "w", mode: 0o640 });
    const decipher = createDecipheriv("aes-128-ecb", decryptionKey(job.decryption?.keySeed), null);
    decipher.setAutoPadding(false);
    let processed = 0;
    let lastPersist = 0;
    const startedAt = this.now();
    try {
      for await (const chunk of reader) {
        if (controller.signal.aborted) throw controller.signal.reason || new Error("download cancelled by administrator");
        const output = decipher.update(chunk);
        if (output.length) await writeChunk(writer, output);
        processed += chunk.length;
        job.decryptBytes = processed;
        const elapsedSeconds = Math.max(1, (this.now() - startedAt) / 1000);
        job.speedBytesPerSecond = Math.max(0, Math.floor(processed / elapsedSeconds));
        if (this.now() - lastPersist > 1000) {
          lastPersist = this.now();
          job.updatedAt = new Date(this.now()).toISOString();
          await this.persist();
        }
      }
      const final = decipher.final();
      if (final.length) await writeChunk(writer, final);
      await new Promise((resolveWrite, rejectWrite) => {
        writer.end(resolveWrite);
        writer.once("error", rejectWrite);
      });
    } catch (error) {
      reader.destroy();
      writer.destroy();
      throw error;
    }
  }

  async downloadParallel(partPath, job, controller) {
    if (this.config.parallelSegments < 2) return false;
    const probe = await this.fetchOfficial(job.sourceUrl, controller.signal, {
      ...(job.sourceHeaders || {}),
      range: "bytes=0-0",
      "accept-encoding": "identity"
    });
    const probeRange = contentRange(probe.headers.get("content-range"));
    await probe.body?.cancel?.().catch(() => {});
    if (probe.status !== 206 || !probeRange || probeRange.start !== 0 || probeRange.end !== 0) return false;
    const total = probeRange.total;
    if (!Number.isSafeInteger(total) || total < this.config.parallelMinBytes) return false;
    if (total > this.config.maxBytes) throw new Error("firmware file exceeds DOWNLOAD_MAX_BYTES");
    job.totalBytes = total;

    const segmentCount = Math.min(this.config.parallelSegments, Math.max(2, Math.ceil(total / this.config.parallelMinBytes)));
    const segmentSize = Math.ceil(total / segmentCount);
    const file = await (await import("node:fs/promises")).open(partPath, "w+", 0o640);
    await file.truncate(total);
    const segmentController = new AbortController();
    const segmentSignal = AbortSignal.any
      ? AbortSignal.any([controller.signal, segmentController.signal])
      : controller.signal;
    let received = 0;
    let lastFreeCheckBytes = 0;
    let lastPersist = 0;
    let freeCheckInFlight = null;
    const checkFreeSpace = async (force = false) => {
      if (!force && received - lastFreeCheckBytes < FREE_SPACE_CHECK_INTERVAL_BYTES) return;
      if (freeCheckInFlight) return freeCheckInFlight;
      freeCheckInFlight = (async () => {
        const remainingRaw = Math.max(0, total - received);
        const remainingOutput = isDecryptingFirmware(job) ? total : 0;
        if ((await this.freeBytes()) - remainingRaw - remainingOutput < this.config.minFreeBytes) {
          throw new Error("download stopped to preserve the configured free disk space");
        }
        lastFreeCheckBytes = received;
      })();
      try { await freeCheckInFlight; } finally { freeCheckInFlight = null; }
    };
    const persistProgress = async () => {
      job.bytes = received;
      if (this.now() - lastPersist <= 1000) return;
      lastPersist = this.now();
      const startedAt = Date.parse(job.downloadStartedAt || job.createdAt || "") || this.now();
      job.speedBytesPerSecond = Math.max(0, Math.floor(received / Math.max(1, (this.now() - startedAt) / 1000)));
      job.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
    };
    try {
      await checkFreeSpace(true);
      const segmentTasks = Array.from({ length: segmentCount }, async (_, index) => {
        await waitWithAbort(index * this.config.parallelStaggerMs, segmentSignal);
        const start = index * segmentSize;
        const end = Math.min(total - 1, start + segmentSize - 1);
        const response = await this.fetchOfficial(job.sourceUrl, segmentSignal, {
          ...(job.sourceHeaders || {}),
          range: `bytes=${start}-${end}`,
          "accept-encoding": "identity"
        });
        const range = contentRange(response.headers.get("content-range"));
        if (response.status !== 206 || !range || range.start !== start || range.end !== end || range.total !== total) {
          await response.body?.cancel?.().catch(() => {});
          throw new Error("Samsung official source rejected parallel range download");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Samsung official source returned an empty segment");
        const writer = createWriteStream(partPath, { flags: "r+", mode: 0o640, start, highWaterMark: 4 * 1024 * 1024 });
        let writerError = null;
        writer.on("error", (error) => {
          writerError = error;
        });
        let writerEnded = false;
        let position = start;
        try {
          while (true) {
            if (segmentSignal.aborted) throw segmentSignal.reason || new Error("download cancelled by administrator");
            const { done, value } = await reader.read();
            if (done) break;
            await writeChunk(writer, value);
            if (writerError) throw writerError;
            position += value.byteLength;
            received += value.byteLength;
            await checkFreeSpace();
            await persistProgress();
          }
          await finishWriteStream(writer);
          writerEnded = true;
          if (writerError) throw writerError;
        } finally {
          await reader.cancel().catch(() => {});
          if (!writerEnded) writer.destroy();
        }
        if (position !== end + 1) throw new Error("Samsung official source returned an incomplete segment");
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
      return true;
    } catch (error) {
      job.bytes = received;
      if (controller.signal.aborted) throw error;
      this.logger.warn?.(`Parallel firmware download unavailable; falling back to one connection: ${error.message}`);
      await rm(partPath, { force: true });
      return false;
    } finally {
      await file.close().catch(() => {});
    }
  }

  async runJob(queueJob) {
    const job = this.jobs.get(String(queueJob.data?.id));
    if (!job || job.state === "cancelled" || job.state === "completed") return;
    const partPath = join(this.config.dir, `${job.id}.part`);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      job.state = "downloading";
      job.downloadStartedAt = new Date(this.now()).toISOString();
      job.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
      let resolved = null;
      if (job.downloadMode === "fus" || !job.sourceUrl) {
        resolved = await this.resolveImpl(this.fusEnv, job.model, job.csc, job.version, { role: "admin", signal: controller.signal });
        job.sourceUrl = resolved.sourceUrl;
        job.sourceUrlHash = sourceUrlHash(job.sourceUrl);
        job.sourceHost = new URL(job.sourceUrl).hostname;
        job.sourceHeaders = resolved.sourceHeaders || null;
        job.encryptedFileName = safeName(resolved.fileName, "firmware.bin");
        job.decryption = resolved.decryption?.keySeed ? { mode: resolved.decryption.mode, keySeed: String(resolved.decryption.keySeed) } : null;
        job.expectedCrc32 = expectedCrc32(resolved.crc32);
        job.originalName = job.decryption ? decryptFileName(job.encryptedFileName) : job.encryptedFileName;
        job.fileName = `${job.id}${extname(job.originalName).slice(0, 12) || ".bin"}`;
        if (resolved.version) job.version = resolved.version;
        await this.persist();
      }
      const finalPath = join(this.config.dir, job.fileName);
      const parallelCompleted = await this.downloadParallel(partPath, job, controller);
      let crc32 = null;
      if (parallelCompleted) {
        crc32 = await fileCrc32(partPath, controller.signal);
      } else {
        const response = await this.fetchOfficial(job.sourceUrl, controller.signal, job.sourceHeaders || {});
        if (!response.ok) throw new Error(`official source returned HTTP ${response.status}`);
        const advertised = Number(response.headers.get("content-length") || 0);
        if (advertised > this.config.maxBytes) throw new Error("firmware file exceeds DOWNLOAD_MAX_BYTES");
        job.totalBytes = advertised;
        const writer = await import("node:fs").then(({ createWriteStream }) => createWriteStream(partPath, { flags: "w", mode: 0o640 }));
        let received = 0;
        crc32 = 0xffffffff;
        let lastFreeCheckBytes = 0;
        let lastPersist = 0;
        try {
          if (!response.body) throw new Error("official source returned an empty body");
          for await (const chunk of response.body) {
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
            const startedAt = Date.parse(job.downloadStartedAt || job.createdAt || "") || this.now();
            const elapsedSeconds = Math.max(1, (this.now() - startedAt) / 1000);
            job.speedBytesPerSecond = Math.max(0, Math.floor(received / elapsedSeconds));
            if (this.now() - lastPersist > 1000) {
              lastPersist = this.now();
              job.updatedAt = new Date(this.now()).toISOString();
              await this.persist();
            }
          }
          await new Promise((resolveWrite, rejectWrite) => {
            writer.end(() => resolveWrite());
            writer.once("error", rejectWrite);
          });
        } catch (error) {
          writer.destroy();
          throw error;
        }
        job.bytes = received;
        job.totalBytes = advertised || received;
      }
      job.speedBytesPerSecond = Math.max(0, Number(job.speedBytesPerSecond || 0));
      if (job.expectedCrc32 !== null && job.expectedCrc32 !== undefined) {
        const actualCrc32 = parallelCompleted ? crc32 : (~crc32) >>> 0;
        if (actualCrc32 !== job.expectedCrc32) throw new Error("Samsung firmware CRC verification failed");
      }
      if (controller.signal.aborted) throw controller.signal.reason || new Error("download cancelled by administrator");
      if (isDecryptingFirmware(job)) {
        if ((await this.freeBytes()) - Number(job.bytes || 0) < this.config.minFreeBytes) {
          throw new Error("download completed but decrypting it would breach the configured free disk reserve");
        }
        const decryptPartPath = join(this.config.dir, `${job.id}.decrypt.part`);
        job.state = "decrypting";
        job.decryptBytes = 0;
        job.speedBytesPerSecond = 0;
        job.updatedAt = new Date(this.now()).toISOString();
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
      job.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
    } catch (error) {
      await rm(partPath, { force: true });
      await rm(join(this.config.dir, `${job.id}.decrypt.part`), { force: true });
      if (job.state !== "cancelled") {
        job.state = "failed";
        job.error = String(error?.message || error || "download failed").slice(0, 240);
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
      if (!location) throw new Error("official source returned a redirect without Location");
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
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.worker?.close().catch(() => {});
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

export function buildDownloadApp({ app = Fastify({ logger: false }), service, version = "1.0.0" } = {}) {
  if (!service) throw new TypeError("buildDownloadApp requires a FirmwareDownloadService");
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
  const app = buildDownloadApp({ service, version: text(env.APP_VERSION, "2.17.5") });
  await app.listen({ host: config.host, port: config.port });
  logger.info?.(`OneUI download API listening on ${config.host}:${config.port}`);
  const close = async () => { await app.close().catch(() => {}); await service.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return { app, service, config, close };
}
