import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVpsOfficialFirmwareDownload } from "../src/vps/fus-resolver.js";
import {
  FirmwareDownloadService,
  buildDownloadApp,
  createDownloadConfig,
  isAllowedOfficialHost,
  startDownloadServer,
  updateRollingSpeed
} from "../src/vps/download-service.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "oneui-download-test-"));
}

function crc32Hex(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16);
}

test("download configuration defaults to an isolated local API", () => {
  const config = createDownloadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8788);
  assert.equal(config.indexDir, config.dir);
  assert.equal(config.parallelSegments, 8);
  assert.equal(config.parallelMaxSegments, 8);
  assert.equal(config.parallelChunkBytes, 256 * 1024 * 1024);
  assert.equal(config.parallelWriteBatchBytes, 4 * 1024 * 1024);
  assert.equal(config.parallelScaleTargetBytesPerSecond, 150 * 1024 * 1024);
  assert.equal(config.bodyIdleTimeoutMs, 120_000);
  assert.equal(config.jobStaleMs, 5 * 60_000);
  assert.equal(createDownloadConfig({ DOWNLOAD_PARALLEL_SEGMENTS: "100" }).parallelSegments, 8);
  const staleHighConcurrency = createDownloadConfig({
    DOWNLOAD_PARALLEL_SEGMENTS: "24",
    DOWNLOAD_PARALLEL_MAX_SEGMENTS: "24"
  });
  assert.equal(staleHighConcurrency.parallelSegments, 8);
  assert.equal(staleHighConcurrency.parallelMaxSegments, 8);
  assert.deepEqual(config.allowedHosts, ["samsung.com", "samsungmobile.com", "ospserver.net", "cdngc.net"]);
  assert.equal(isAllowedOfficialHost("fota-cloud-dn.ospserver.net"), true);
  assert.equal(isAllowedOfficialHost("example.com"), false);
});

test("download index can stay outside the public firmware directory", async () => {
  const dir = await tempDir();
  const indexDir = await tempDir();
  try {
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({
        DOWNLOAD_DIR: dir,
        DOWNLOAD_INDEX_DIR: indexDir,
        DOWNLOAD_MIN_FREE_BYTES: "0"
      })
    }).init({ startQueue: false });
    service.jobs.set("index-test", { id: "index-test", state: "queued" });
    await service.persist();
    assert.equal(JSON.parse(await readFile(join(indexDir, "index.json"), "utf8"))["index-test"].state, "queued");
    await assert.rejects(readFile(join(dir, "index.json"), "utf8"), /ENOENT/);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(indexDir, { recursive: true, force: true });
  }
});

test("download shutdown persists active work and force-closes the BullMQ worker", async () => {
  const dir = await tempDir();
  try {
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_MIN_FREE_BYTES: "0" })
    }).init({ startQueue: false });
    let aborted = false;
    let forceClose = null;
    service.jobs.set("active", {
      id: "active",
      state: "downloading",
      speedBytesPerSecond: 123,
      updatedAt: new Date().toISOString()
    });
    service.controllers.set("active", { abort() { aborted = true; } });
    service.worker = { async close(force) { forceClose = force; } };

    await service.close();

    assert.equal(aborted, true);
    assert.equal(forceClose, true);
    assert.equal(service.get("active").state, "queued");
    const saved = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    assert.equal(saved.active.state, "queued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("friendly firmware output names include model and CSC without overwriting an existing file", async () => {
  const dir = await tempDir();
  try {
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_MIN_FREE_BYTES: "0" })
    }).init({ startQueue: false });
    const requested = "SM-S9180_CHC_S9180ZCS8FZG1.zip";
    const id = "12345678-90ab-cdef-1234-567890abcdef";
    assert.equal(await service.reserveOutputName(id, requested), requested);
    await writeFile(join(dir, requested), "already here");
    assert.equal(await service.reserveOutputName(id, requested), "SM-S9180_CHC_S9180ZCS8FZG1_12345678.zip");
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download speed uses a phase-local rolling window", () => {
  const job = {};
  updateRollingSpeed(job, "download", 0, 0);
  updateRollingSpeed(job, "download", 100, 1000);
  updateRollingSpeed(job, "download", 200, 2000);
  assert.equal(job.speedBytesPerSecond, 100);
  updateRollingSpeed(job, "verify", 0, 3000);
  assert.equal(job.speedBytesPerSecond, 0);
  updateRollingSpeed(job, "verify", 100, 4000);
  updateRollingSpeed(job, "verify", 200, 5000);
  assert.equal(job.speedBytesPerSecond, 100);
  updateRollingSpeed(job, "decrypt", 0, 6000);
  assert.equal(job.speedBytesPerSecond, 0);
});

test("download response-header deadline does not abort an active body stream", async () => {
  let requestSignal;
  const config = createDownloadConfig({});
  config.responseHeaderTimeoutMs = 5;
  const service = new FirmwareDownloadService({
    config,
    lookupImpl: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Response("firmware", { status: 200 });
    }
  });
  const controller = new AbortController();
  await service.fetchOfficial("https://fota-cloud-dn.ospserver.net/firmware/test.bin", controller.signal);
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.equal(requestSignal.aborted, false);
  controller.abort();
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(requestSignal.aborted, true);
});

test("download redirects release the previous response body", async () => {
  let requests = 0;
  let cancelled = 0;
  const service = new FirmwareDownloadService({
    config: createDownloadConfig({}),
    lookupImpl: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) {
        return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
          status: 302,
          headers: { location: "https://fota-cloud-dn.ospserver.net/firmware/final.bin" }
        });
      }
      return new Response("firmware", { status: 200 });
    }
  });
  const response = await service.fetchOfficial("https://fota-cloud-dn.ospserver.net/firmware/start.bin", new AbortController().signal);
  assert.equal(response.status, 200);
  assert.equal(requests, 2);
  assert.equal(cancelled, 1);
});

test("download health ignores an ordinary queue backlog but detects a stalled active transfer", async () => {
  const dir = await tempDir();
  let now = Date.now();
  try {
    const config = createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_MIN_FREE_BYTES: "0" });
    config.jobStaleMs = 1000;
    const service = await new FirmwareDownloadService({ config, now: () => now }).init({ startQueue: false });
    service.jobs.set("queued", { id: "queued", state: "queued", updatedAt: new Date(now - 60_000).toISOString() });
    assert.equal((await service.health()).ok, true);
    assert.equal((await service.health()).queued, 1);
    assert.ok(["native", "js-fallback"].includes((await service.health()).crc32Engine));
    service.jobs.set("active", { id: "active", state: "downloading", updatedAt: new Date(now).toISOString() });
    now += 2000;
    const health = await service.health();
    assert.equal(health.ok, false);
    assert.equal(health.active.stalled, true);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download fails instead of hanging when an official body stops producing data", async () => {
  const dir = await tempDir();
  try {
    const config = createDownloadConfig({
      DOWNLOAD_DIR: dir,
      DOWNLOAD_MIN_FREE_BYTES: "0",
      DOWNLOAD_PARALLEL_SEGMENTS: "1"
    });
    config.bodyIdleTimeoutMs = 20;
    const service = await new FirmwareDownloadService({
      config,
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "5" }),
        body: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise(() => {}),
              async return() { return { done: true }; }
            };
          }
        }
      })
    }).init({ startQueue: false });
    const job = await service.create({ sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/stalled.bin" }, "owner");
    const startedAt = Date.now();
    await assert.rejects(() => service.runJob({ data: { id: job.id } }), /body stalled/);
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(service.get(job.id).state, "failed");
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download restart reuses a fully transferred and verified part", async () => {
  const dir = await tempDir();
  try {
    const config = createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_MIN_FREE_BYTES: "0" });
    const first = await new FirmwareDownloadService({
      config,
      lookupImpl: async () => [{ address: "93.184.216.34" }]
    }).init({ startQueue: false });
    const created = await first.create({ sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/resume.zip" }, "owner");
    const internal = first.jobs.get(created.id);
    internal.bytes = 5;
    internal.totalBytes = 5;
    internal.downloadComplete = true;
    internal.downloadVerified = true;
    await writeFile(join(dir, `${created.id}.part`), "hello");
    await first.persist();
    await first.close();

    let networkCalls = 0;
    const second = await new FirmwareDownloadService({
      config,
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      fetchImpl: async () => {
        networkCalls += 1;
        throw new Error("network should not be used");
      }
    }).init({ startQueue: false });
    await second.runJob({ data: { id: created.id } });
    assert.equal(networkCalls, 0);
    assert.equal(second.get(created.id).state, "completed");
    assert.equal(await readFile(join(dir, created.fileName), "utf8"), "hello");
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel Range download assembles the file and verifies the completed output", async () => {
  const dir = await tempDir();
  try {
    const fixture = Buffer.from("OneUI parallel Range download fixture 0123456789", "utf8");
    const rangeHeaders = [];
    const config = createDownloadConfig({
      DOWNLOAD_DIR: dir,
      DOWNLOAD_MIN_FREE_BYTES: "0",
      DOWNLOAD_PARALLEL_SEGMENTS: "2",
      DOWNLOAD_PARALLEL_MAX_SEGMENTS: "2",
      DOWNLOAD_PARALLEL_MIN_BYTES: "1"
    });
    const service = await new FirmwareDownloadService({
      config,
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      fetchImpl: async (_url, init = {}) => {
        const rangeValue = init.headers?.range || init.headers?.Range || "";
        rangeHeaders.push(String(rangeValue));
        const match = String(rangeValue).match(/^bytes=(\d+)-(\d+)$/);
        if (!match) return new Response(fixture, { status: 200 });
        const start = Number(match[1]);
        const end = Math.min(fixture.length - 1, Number(match[2]));
        return new Response(fixture.subarray(start, end + 1), {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end}/${fixture.length}`,
            "content-length": String(end - start + 1)
          }
        });
      }
    }).init({ startQueue: false });
    const job = await service.create({ sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/test.zip" }, "owner");
    await service.runJob({ data: { id: job.id } });
    const completed = service.get(job.id);
    assert.equal(completed.state, "completed");
    assert.equal(completed.bytes, fixture.length);
    assert.ok(rangeHeaders.includes("bytes=0-0"));
    assert.equal(rangeHeaders.filter((value) => value !== "bytes=0-0").length, 2);
    assert.deepEqual(await readFile(join(dir, completed.fileName)), fixture);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel CRC verification reads the assembled file with its own live speed phase", async () => {
  const dir = await tempDir();
  let now = Date.now();
  try {
    const fixture = Buffer.alloc(12 * 1024 * 1024, 0x5a);
    const config = createDownloadConfig({
      DOWNLOAD_DIR: dir,
      DOWNLOAD_MIN_FREE_BYTES: "0",
      DOWNLOAD_PARALLEL_SEGMENTS: "2",
      DOWNLOAD_PARALLEL_MAX_SEGMENTS: "2",
      DOWNLOAD_PARALLEL_MIN_BYTES: "1"
    });
    const service = await new FirmwareDownloadService({
      config,
      now: () => (now += 1000),
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      resolveImpl: async () => ({
        sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/verify.zip",
        fileName: "SM-S9260_CHC_VERIFY.zip",
        size: fixture.length,
        crc32: String(Number.parseInt(crc32Hex(fixture), 16))
      }),
      fetchImpl: async (_url, init = {}) => {
        const range = String(init.headers?.range || init.headers?.Range || "");
        const match = range.match(/^bytes=(\d+)-(\d+)$/);
        if (!match) return new Response(fixture, { status: 200 });
        const start = Number(match[1]);
        const end = Math.min(fixture.length - 1, Number(match[2]));
        return new Response(fixture.subarray(start, end + 1), {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end}/${fixture.length}`,
            "content-length": String(end - start + 1)
          }
        });
      }
    }).init({ startQueue: false });

    const job = await service.create({ model: "SM-S9260", csc: "CHC", version: "S9260TEST/S9260CHC/S9260MODEM" }, "owner");
    await service.runJob({ data: { id: job.id } });
    const completed = service.jobs.get(job.id);
    assert.equal(completed.state, "completed");
    assert.equal(completed.speedPhase, "verify");
    assert.ok(completed.speedBytesPerSecond > 0);
    assert.deepEqual(await readFile(join(dir, completed.fileName)), fixture);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel Range uses one long-lived fixed range per configured connection", async () => {
  const dir = await tempDir();
  try {
    const fixture = Buffer.alloc(32 * 1024 * 1024, 0x61);
    let activeRanges = 0;
    let maximumActiveRanges = 0;
    let dataRangeCalls = 0;
    const config = createDownloadConfig({
      DOWNLOAD_DIR: dir,
      DOWNLOAD_MIN_FREE_BYTES: "0",
      DOWNLOAD_PARALLEL_SEGMENTS: "3",
      DOWNLOAD_PARALLEL_MAX_SEGMENTS: "3",
      DOWNLOAD_PARALLEL_STAGGER_MS: "0",
      DOWNLOAD_PARALLEL_MIN_BYTES: "1",
      DOWNLOAD_PARALLEL_CHUNK_BYTES: String(8 * 1024 * 1024)
    });
    const service = await new FirmwareDownloadService({
      config,
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      fetchImpl: async (_url, init = {}) => {
        const rangeValue = String(init.headers?.range || init.headers?.Range || "");
        const match = rangeValue.match(/^bytes=(\d+)-(\d+)$/);
        if (!match) return new Response(fixture, { status: 200 });
        const start = Number(match[1]);
        const end = Math.min(fixture.length - 1, Number(match[2]));
        const headers = {
          "content-range": `bytes ${start}-${end}/${fixture.length}`,
          "content-length": String(end - start + 1)
        };
        if (start === 0 && end === 0) return new Response(fixture.subarray(0, 1), { status: 206, headers });
        dataRangeCalls += 1;
        activeRanges += 1;
        maximumActiveRanges = Math.max(maximumActiveRanges, activeRanges);
        const body = new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(fixture.subarray(start, end + 1));
              controller.close();
              activeRanges -= 1;
            }, 10);
          }
        });
        return new Response(body, { status: 206, headers });
      }
    }).init({ startQueue: false });
    const job = await service.create({ sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/lanes.zip" }, "owner");
    await service.runJob({ data: { id: job.id } });
    const completed = service.get(job.id);
    assert.equal(completed.state, "completed");
    assert.equal(maximumActiveRanges, 3);
    assert.equal(dataRangeCalls, 3);
    assert.deepEqual(await readFile(join(dir, completed.fileName)), fixture);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel Range download expands lanes only after sustained low aggregate throughput", async () => {
  const dir = await tempDir();
  try {
    const fixture = Buffer.alloc(32 * 1024 * 1024, 0x62);
    let activeRanges = 0;
    let maximumActiveRanges = 0;
    const initialRangeStarts = new Set([0, 8 * 1024 * 1024]);
    const releaseInitialRanges = [];
    const releaseTimer = setTimeout(() => {
      for (const release of releaseInitialRanges) release();
    }, 2_300);
    const config = createDownloadConfig({
      DOWNLOAD_DIR: dir,
      DOWNLOAD_MIN_FREE_BYTES: "0",
      DOWNLOAD_PARALLEL_SEGMENTS: "2",
      DOWNLOAD_PARALLEL_MAX_SEGMENTS: "4",
      DOWNLOAD_PARALLEL_STAGGER_MS: "0",
      DOWNLOAD_PARALLEL_MIN_BYTES: "1",
      DOWNLOAD_PARALLEL_CHUNK_BYTES: String(8 * 1024 * 1024),
      DOWNLOAD_PARALLEL_WRITE_BATCH_BYTES: String(1024 * 1024),
      DOWNLOAD_PARALLEL_TARGET_BYTES_PER_SECOND: String(1024 * 1024 * 1024),
      DOWNLOAD_PARALLEL_SCALE_INTERVAL_MS: "1000",
      DOWNLOAD_PARALLEL_SCALE_STEP: "2"
    });
    const service = await new FirmwareDownloadService({
      config,
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      fetchImpl: async (_url, init = {}) => {
        const rangeValue = String(init.headers?.range || init.headers?.Range || "");
        const match = rangeValue.match(/^bytes=(\d+)-(\d+)$/);
        if (!match) return new Response(fixture, { status: 200 });
        const start = Number(match[1]);
        const end = Math.min(fixture.length - 1, Number(match[2]));
        const headers = {
          "content-range": `bytes ${start}-${end}/${fixture.length}`,
          "content-length": String(end - start + 1)
        };
        if (start === 0 && end === 0) return new Response(fixture.subarray(0, 1), { status: 206, headers });
        activeRanges += 1;
        maximumActiveRanges = Math.max(maximumActiveRanges, activeRanges);
        let closed = false;
        const closeRange = (controller) => {
          if (closed) return;
          closed = true;
          activeRanges -= 1;
          controller.close();
        };
        const body = new ReadableStream({
          start(controller) {
            if (initialRangeStarts.has(start)) {
              let offset = start;
              const sendWarmupChunk = () => {
                const next = Math.min(start + 4 * 1024 * 1024, end + 1, offset + 1024 * 1024);
                if (next <= offset || closed) return false;
                controller.enqueue(fixture.subarray(offset, next));
                offset = next;
                return offset < start + 4 * 1024 * 1024;
              };
              sendWarmupChunk();
              const warmupTimer = setInterval(() => {
                if (!sendWarmupChunk()) clearInterval(warmupTimer);
              }, 400);
              releaseInitialRanges.push(() => {
                try {
                  clearInterval(warmupTimer);
                  controller.enqueue(fixture.subarray(offset, end + 1));
                  closeRange(controller);
                } catch {}
              });
              return;
            }
            setTimeout(() => {
              try {
                controller.enqueue(fixture.subarray(start, end + 1));
                closeRange(controller);
              } catch {}
            }, 200);
          },
          cancel() {
            if (!closed) {
              closed = true;
              activeRanges = Math.max(0, activeRanges - 1);
            }
          }
        });
        return new Response(body, { status: 206, headers });
      }
    }).init({ startQueue: false });
    const job = await service.create({ sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/adaptive-lanes.zip" }, "owner");
    await service.runJob({ data: { id: job.id } });
    clearTimeout(releaseTimer);
    assert.equal(service.get(job.id).state, "completed");
    assert.equal(maximumActiveRanges, 4);
    assert.deepEqual(await readFile(join(dir, service.get(job.id).fileName)), fixture);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel download pauses safely and resumes only unfinished ranges", async () => {
  const dir = await tempDir();
  try {
    const fixture = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ--resume-fixture", "utf8");
    const rangeCalls = [];
    let firstSegmentStarted;
    const firstSegmentReady = new Promise((resolveReady) => { firstSegmentStarted = resolveReady; });
    let stalledOnce = false;
    const config = createDownloadConfig({
      DOWNLOAD_DIR: dir,
      DOWNLOAD_MIN_FREE_BYTES: "0",
      DOWNLOAD_PARALLEL_SEGMENTS: "2",
      DOWNLOAD_PARALLEL_MAX_SEGMENTS: "2",
      DOWNLOAD_PARALLEL_STAGGER_MS: "0",
      DOWNLOAD_PARALLEL_MIN_BYTES: "1",
      DOWNLOAD_PARALLEL_RETRIES: "0"
    });
    const service = await new FirmwareDownloadService({
      config,
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      fetchImpl: async (_url, init = {}) => {
        const rangeValue = String(init.headers?.range || init.headers?.Range || "");
        rangeCalls.push(rangeValue);
        const match = rangeValue.match(/^bytes=(\d+)-(\d+)$/);
        if (!match) return new Response(fixture, { status: 200 });
        const start = Number(match[1]);
        const end = Math.min(fixture.length - 1, Number(match[2]));
        const headers = {
          "content-range": `bytes ${start}-${end}/${fixture.length}`,
          "content-length": String(end - start + 1)
        };
        const firstSegmentEnd = Math.ceil(fixture.length / 2) - 1;
        if (!stalledOnce && start === 0 && end === firstSegmentEnd) {
          stalledOnce = true;
          const chunk = fixture.subarray(start, start + 12);
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              firstSegmentStarted();
              const onAbort = () => controller.error(init.signal?.reason || new Error("paused"));
              init.signal?.addEventListener("abort", onAbort, { once: true });
            }
          });
          return new Response(body, { status: 206, headers });
        }
        return new Response(fixture.subarray(start, end + 1), { status: 206, headers });
      }
    }).init({ startQueue: false });

    const job = await service.create({ sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/resume.zip" }, "owner");
    const running = service.runJob({ data: { id: job.id } });
    await firstSegmentReady;
    assert.equal(await service.pause(job.id), true);
    await assert.rejects(() => service.resume(job.id), /pause is still being applied/);
    await running;

    const paused = service.get(job.id);
    assert.equal(paused.state, "paused");
    assert.ok(paused.bytes > 0 && paused.bytes < fixture.length);
    assert.equal((await stat(join(dir, `${job.id}.part`))).size, fixture.length);

    assert.equal(await service.resume(job.id), true);
    await service.runJob({ data: { id: job.id } });
    const completed = service.get(job.id);
    assert.equal(completed.state, "completed");
    assert.deepEqual(await readFile(join(dir, completed.fileName)), fixture);
    assert.ok(rangeCalls.includes(`bytes=12-${Math.ceil(fixture.length / 2) - 1}`));
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production download server refuses to start without Redis", async () => {
  await assert.rejects(
    () => startDownloadServer({ env: { DOWNLOAD_API_SECRET: "test-download-secret" } }),
    /REDIS_URL is required/
  );
});

test("VPS FUS resolver uses the Bifrost-compatible authentication flow without exposing it", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    calls.push({ url: value, headers: init.headers || {}, body: String(init.body || "") });
    if (value.includes("GenerateNonce")) {
      return new Response("", { status: 200, headers: { nonce: "0123456789abcdef", "set-cookie": "JSESSIONID=test-session; Path=/; Secure" } });
    }
    if (value.includes("BinaryInform")) {
      assert.match(String(init.headers.authorization || ""), /^FUS nonce="0123456789abcdef", signature="[0-9a-f]+"/);
      assert.match(String(init.body), /BINARY_SW_VERSION/);
      return new Response("<FUSMsg><FUSBody><Results><Status>200</Status><BINARY_SW_VERSION>S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1/S9480ZCS4AZG1</BINARY_SW_VERSION></Results><Put><BINARY_NAME>SM-S9480_TEST.zip.enc4</BINARY_NAME><MODEL_PATH>path/</MODEL_PATH><BINARY_BYTE_SIZE>32</BINARY_BYTE_SIZE><BINARY_CRC>0</BINARY_CRC><DEVICE_MODEL_TYPE>SM-S9480</DEVICE_MODEL_TYPE><LOGIC_VALUE_FACTORY>0123456789abcdef0123456789abcdef</LOGIC_VALUE_FACTORY></Put></FUSBody></FUSMsg>", { status: 200 });
    }
    if (value.includes("BinaryInit")) {
      assert.match(String(init.body), /BINARY_NAME/);
      return new Response("<FUSMsg><FUSBody><Results><Status>200</Status></Results></FUSBody></FUSMsg>", { status: 200 });
    }
    throw new Error(`Unexpected FUS request: ${value}`);
  };
  const result = await resolveVpsOfficialFirmwareDownload({}, "SM-S9480", "CHC", "S9480ZCS4AZG1/S9480CHC4AZG1/S9480ZCS4AZG1/S9480ZCS4AZG1", { fetchImpl });
  assert.equal(result.fileName, "SM-S9480_TEST.zip.enc4");
  assert.equal(result.decryption.mode, "enc4");
  assert.equal(result.crc32, "0");
  assert.match(result.sourceUrl, /file=path\/SM-S9480_TEST\.zip\.enc4$/);
  assert.doesNotMatch(result.sourceUrl, /%2F/i);
  assert.equal(calls.filter((call) => call.url.includes("BinaryInform")).length, 1);
  assert.equal(calls.filter((call) => call.url.includes("BinaryInit")).length, 1);
  assert.equal(Object.hasOwn(result, "sourceHeaders"), true);
  assert.match(result.sourceHeaders.authorization, /^FUS nonce="0123456789abcdef", signature="[0-9a-f]+"/);
  assert.equal(result.sourceHeaders["cache-control"], "no-cache");
  assert.equal(Object.hasOwn(result.sourceHeaders, "cookie"), false);
});

test("FUS download refreshes an expired authorization and resumes unfinished Range segments", async () => {
  const dir = await tempDir();
  try {
    const fixture = Buffer.from("FUS authorization resume fixture", "utf8");
    let resolveCalls = 0;
    let markHealthyLaneStarted;
    const healthyLaneStarted = new Promise((resolve) => { markHealthyLaneStarted = resolve; });
    let healthyLaneCancelled = false;
    const rangeAuthorizations = [];
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({
        DOWNLOAD_DIR: dir,
        DOWNLOAD_MIN_FREE_BYTES: "0",
        DOWNLOAD_PARALLEL_MIN_BYTES: "1",
        DOWNLOAD_PARALLEL_SEGMENTS: "2",
        DOWNLOAD_PARALLEL_MAX_SEGMENTS: "2",
        DOWNLOAD_PARALLEL_CHUNK_BYTES: "8",
        DOWNLOAD_PARALLEL_STAGGER_MS: "0"
      }),
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      resolveImpl: async () => {
        resolveCalls += 1;
        return {
          sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/refresh.zip",
          sourceHeaders: { authorization: `session-${resolveCalls}` },
          fileName: "SM-S9380_REFRESH.zip",
          size: fixture.length
        };
      },
      fetchImpl: async (_url, init = {}) => {
        const authorization = String(init.headers?.authorization || "");
        const rangeValue = String(init.headers?.range || init.headers?.Range || "");
        const match = rangeValue.match(/^bytes=(\d+)-(\d+)$/);
        rangeAuthorizations.push(`${authorization}:${rangeValue}`);
        if (!match) return new Response(fixture, { status: 200 });
        const start = Number(match[1]);
        const end = Math.min(fixture.length - 1, Number(match[2]));
        if (authorization === "session-1" && start === 0 && end > 0) {
          return new Response(new ReadableStream({
            start(controller) {
              markHealthyLaneStarted();
              controller.enqueue(fixture.subarray(start, start + 4));
              setTimeout(() => {
                try {
                  controller.enqueue(fixture.subarray(start + 4, end + 1));
                  controller.close();
                } catch {}
              }, 25);
            },
            cancel() { healthyLaneCancelled = true; }
          }), {
            status: 206,
            headers: {
              "content-range": `bytes ${start}-${end}/${fixture.length}`,
              "content-length": String(end - start + 1)
            }
          });
        }
        if (authorization === "session-1" && start > 0) {
          await healthyLaneStarted;
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(fixture.subarray(start, end + 1), {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end}/${fixture.length}`,
            "content-length": String(end - start + 1)
          }
        });
      }
    }).init({ startQueue: false });
    const job = await service.create({ model: "SM-S9380", csc: "CHC", version: "S9380TEST/S9380CHC/S9380MODEM" }, "owner");
    await service.runJob({ data: { id: job.id } });
    assert.equal(service.get(job.id).state, "completed");
    assert.equal(resolveCalls, 2);
    assert.equal(healthyLaneCancelled, false);
    assert.ok(rangeAuthorizations.some((value) => value === "session-1:bytes=0-0"));
    assert.ok(rangeAuthorizations.some((value) => value.startsWith("session-1:bytes=") && !value.endsWith("bytes=0-0")));
    assert.ok(rangeAuthorizations.some((value) => value.startsWith("session-2:bytes=") && !value.endsWith("bytes=0-0")));
    assert.deepEqual(await readFile(join(dir, service.get(job.id).fileName)), fixture);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FUS download stops safely when refreshed authorization makes no transfer progress", async () => {
  const dir = await tempDir();
  try {
    let resolveCalls = 0;
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({
        DOWNLOAD_DIR: dir,
        DOWNLOAD_MIN_FREE_BYTES: "0",
        DOWNLOAD_PARALLEL_MIN_BYTES: "1"
      }),
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      resolveImpl: async () => {
        resolveCalls += 1;
        return {
          sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/refresh-fail.zip",
          sourceHeaders: { authorization: `session-${resolveCalls}` },
          fileName: "SM-S9380_REFRESH_FAIL.zip",
          size: 32
        };
      },
      fetchImpl: async () => new Response("unauthorized", { status: 401 })
    }).init({ startQueue: false });
    const job = await service.create({ model: "SM-S9380", csc: "CHC", version: "S9380TEST/S9380CHC/S9380MODEM" }, "owner");
    await assert.rejects(
      () => service.runJob({ data: { id: job.id } }),
      /repeatedly rejected a refreshed FUS authorization before download progress/
    );
    assert.equal(resolveCalls, 2);
    assert.equal(service.get(job.id).state, "failed");
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download API requires an admin key and serves only completed files", async () => {
  const dir = await tempDir();
  try {
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_API_SECRET: "test-download-secret", DOWNLOAD_MIN_FREE_BYTES: "0" }),
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "11" }),
        body: (async function* body() { yield Buffer.from("hello world"); })()
      })
    }).init({ startQueue: false });
    const app = buildDownloadApp({ app: Fastify(), service });
    await app.ready();

    const denied = await app.inject({ method: "GET", url: "/api/v1/downloads" });
    assert.equal(denied.statusCode, 403);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/downloads",
      headers: { "x-download-api-key": "test-download-secret", "x-admin-id": "owner" },
      payload: { sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/test.bin", model: "SM-S9380", csc: "CHC", version: "TEST" }
    });
    assert.equal(created.statusCode, 202);
    const id = created.json().download.id;

    const pending = await app.inject({ method: "GET", url: `/api/v1/downloads/${id}`, headers: { "x-download-api-key": "test-download-secret" } });
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.json().download.state, "queued");

    await service.runJob({ data: { id } });
    const completed = await app.inject({ method: "GET", url: `/api/v1/downloads/${id}`, headers: { "x-download-api-key": "test-download-secret" } });
    assert.equal(completed.json().download.state, "completed");
    assert.equal(completed.json().download.percent, 100);

    const file = await app.inject({ method: "GET", url: `/files/${id}`, headers: { "x-download-api-key": "test-download-secret" } });
    assert.equal(file.statusCode, 200);
    assert.equal(file.body, "hello world");
    assert.equal(file.headers["content-type"], "application/octet-stream");

    const pausable = await service.create({ sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/pause.bin" }, "owner");
    const paused = await app.inject({ method: "POST", url: `/api/v1/downloads/${pausable.id}/pause`, headers: { "x-download-api-key": "test-download-secret" } });
    assert.equal(paused.statusCode, 200);
    assert.equal(service.get(pausable.id).state, "paused");
    const resumed = await app.inject({ method: "POST", url: `/api/v1/downloads/${pausable.id}/resume`, headers: { "x-download-api-key": "test-download-secret" } });
    assert.equal(resumed.statusCode, 200);
    assert.equal(service.get(pausable.id).state, "queued");

    await app.close();
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download API rejects non-official and non-HTTPS URLs", async () => {
  const dir = await tempDir();
  try {
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_API_SECRET: "test-download-secret", DOWNLOAD_MIN_FREE_BYTES: "0" }),
      lookupImpl: async () => [{ address: "93.184.216.34" }]
    }).init({ startQueue: false });
    await assert.rejects(() => service.create({ sourceUrl: "http://example.com/file.bin" }), /HTTPS/);
    await assert.rejects(() => service.create({ sourceUrl: "https://example.com/file.bin" }), /official Samsung allowlist/);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download service rejects a Samsung file whose advertised CRC32 does not match", async () => {
  const dir = await tempDir();
  try {
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_API_SECRET: "test-download-secret", DOWNLOAD_MIN_FREE_BYTES: "0" }),
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      resolveImpl: async () => ({
        sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/test.zip",
        fileName: "SM-S9380_CHC_TEST.zip",
        size: 5,
        crc32: "0"
      }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "5" }),
        body: (async function* body() { yield Buffer.from("hello"); })()
      })
    }).init({ startQueue: false });
    const job = await service.create({ model: "SM-S9380", csc: "CHC", version: "S9380TEST/S9380CHC/S9380MODEM" }, "owner");
    await assert.rejects(() => service.runJob({ data: { id: job.id } }), /CRC verification failed/);
    assert.equal(service.get(job.id).state, "failed");

    const retrying = await service.create({ model: "SM-S9380", csc: "CHC", version: "S9380TEST/S9380CHC/S9380MODEM" }, "owner");
    await assert.rejects(
      () => service.runJob({ data: { id: retrying.id }, opts: { attempts: 2 }, attemptsMade: 0 }),
      /CRC verification failed/
    );
    assert.equal(service.get(retrying.id).state, "queued");
    assert.match(service.get(retrying.id).error, /automatic retry is scheduled/);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download preview verifies Samsung metadata without queuing a job, and terminal jobs can be removed", async () => {
  const dir = await tempDir();
  try {
    let resolves = 0;
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_API_SECRET: "test-download-secret", DOWNLOAD_MIN_FREE_BYTES: "0" }),
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      resolveImpl: async () => {
        resolves += 1;
        return {
          sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/test.zip",
          sourceHeaders: { authorization: "FUS test" },
          fileName: "SM-S9380_CHC_TEST.zip",
          size: 5
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "5" }),
        body: (async function* body() { yield Buffer.from("hello"); })()
      })
    }).init({ startQueue: false });

    const preview = await service.preview({ model: "SM-S9380", csc: "CHC", version: "S9380TEST/S9380CHC/S9380MODEM" });
    assert.equal(preview.originalName, "SM-S9380_CHC_S9380TEST.zip");
    assert.equal(preview.totalBytes, 5);
    assert.equal(service.list().length, 0);
    assert.equal(Object.hasOwn(preview, "sourceHeaders"), false);

    const job = await service.create({ model: "SM-S9380", csc: "CHC", version: "S9380TEST/S9380CHC/S9380MODEM" }, "owner");
    await service.runJob({ data: { id: job.id } });
    assert.equal(service.get(job.id).state, "completed");
    assert.ok(resolves >= 2);
    assert.equal(await service.remove(job.id), true);
    assert.equal(service.get(job.id), null);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download service decrypts Samsung enc4 firmware before marking it complete", async () => {
  const dir = await tempDir();
  try {
    const keySeed = "enc4-test-key-seed";
    const plaintext = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    const cipher = createCipheriv("aes-128-ecb", createHash("md5").update(keySeed, "utf8").digest(), null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_API_SECRET: "test-download-secret", DOWNLOAD_MIN_FREE_BYTES: "0" }),
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      resolveImpl: async () => ({
        sourceUrl: "https://fota-cloud-dn.ospserver.net/firmware/test.zip.enc4",
        sourceHeaders: { authorization: "FUS temporary-test-value" },
        fileName: "SM-S9380_CHC_TEST.zip.enc4",
        size: encrypted.length,
        crc32: crc32Hex(encrypted),
        decryption: { mode: "enc4", keySeed }
      }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(encrypted.length) }),
        body: (async function* body() {
          yield encrypted.subarray(0, 13);
          yield encrypted.subarray(13);
        })()
      })
    }).init({ startQueue: false });

    const job = await service.create({ model: "SM-S9380", csc: "CHC", version: "S9380TEST/S9380CHC/S9380MODEM" }, "owner");
    await service.runJob({ data: { id: job.id } });
    const completed = service.get(job.id);
    assert.equal(completed.state, "completed");
    assert.equal(completed.originalName, "SM-S9380_CHC_S9380TEST.zip");
    assert.equal(completed.percent, 100);
    assert.equal(Object.hasOwn(completed, "decryption"), false);
    assert.deepEqual(await readFile(join(dir, completed.fileName)), plaintext);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download service resolves a Samsung FUS job inside the VPS worker", async () => {
  const dir = await tempDir();
  try {
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_API_SECRET: "test-download-secret" }),
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      resolveImpl: async () => ({
        sourceUrl: "http://cloud-neofussvr.samsungmobile.com/NF_SmartDownloadBinaryForMass.do?file=path%2Ffirmware.zip",
        sourceHeaders: { authorization: "FUS temporary-test-value", "user-agent": "SMART 2.0" },
        fileName: "SM-S9380_CHC_TEST.zip",
        size: 5
      }),
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.authorization, "FUS temporary-test-value");
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": "5" }),
          body: (async function* body() { yield Buffer.from("hello"); })()
        };
      }
    }).init({ startQueue: false });
    const job = await service.create({ model: "SM-S9380", csc: "CHC", version: "S9380TEST/S9380CHC/S9380MODEM" }, "owner");
    assert.equal(job.downloadMode, "fus");
    assert.equal(Object.hasOwn(job, "sourceUrl"), false);
    await service.runJob({ data: { id: job.id } });
    const completed = service.get(job.id);
    assert.equal(completed.state, "completed");
    assert.equal(completed.originalName, "SM-S9380_CHC_S9380TEST.zip");
    assert.equal(Object.hasOwn(completed, "sourceHeaders"), false);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
