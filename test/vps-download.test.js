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

test("download configuration defaults to an isolated local API", () => {
  const config = createDownloadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8788);
  assert.equal(config.indexDir, config.dir);
  assert.equal(config.parallelSegments, 24);
  assert.equal(config.parallelChunkBytes, 256 * 1024 * 1024);
  assert.equal(config.bodyIdleTimeoutMs, 120_000);
  assert.equal(config.jobStaleMs, 5 * 60_000);
  assert.equal(createDownloadConfig({ DOWNLOAD_PARALLEL_SEGMENTS: "100" }).parallelSegments, 32);
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

test("download speed uses a phase-local rolling window", () => {
  const job = {};
  updateRollingSpeed(job, "download", 0, 0);
  updateRollingSpeed(job, "download", 100, 1000);
  updateRollingSpeed(job, "download", 200, 2000);
  assert.equal(job.speedBytesPerSecond, 100);
  updateRollingSpeed(job, "decrypt", 0, 3000);
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

test("parallel Range lanes claim later work ranges without exceeding the configured connection count", async () => {
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
    assert.equal(dataRangeCalls, Math.ceil(fixture.length / (8 * 1024 * 1024)));
    assert.deepEqual(await readFile(join(dir, completed.fileName)), fixture);
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
    assert.equal(preview.originalName, "SM-S9380_CHC_TEST.zip");
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
    assert.equal(completed.originalName, "SM-S9380_CHC_TEST.zip");
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
    assert.equal(completed.originalName, "SM-S9380_CHC_TEST.zip");
    assert.equal(Object.hasOwn(completed, "sourceHeaders"), false);
    await service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
