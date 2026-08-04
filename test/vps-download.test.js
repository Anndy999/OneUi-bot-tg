import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FirmwareDownloadService,
  buildDownloadApp,
  createDownloadConfig,
  isAllowedOfficialHost,
  startDownloadServer
} from "../src/vps/download-service.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "oneui-download-test-"));
}

test("download configuration defaults to an isolated local API", () => {
  const config = createDownloadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8788);
  assert.deepEqual(config.allowedHosts, ["samsung.com", "samsungmobile.com", "ospserver.net", "cdngc.net"]);
  assert.equal(isAllowedOfficialHost("fota-cloud-dn.ospserver.net"), true);
  assert.equal(isAllowedOfficialHost("example.com"), false);
});

test("production download server refuses to start without Redis", async () => {
  await assert.rejects(
    () => startDownloadServer({ env: { DOWNLOAD_API_SECRET: "test-download-secret" } }),
    /REDIS_URL is required/
  );
});

test("download API requires an admin key and serves only completed files", async () => {
  const dir = await tempDir();
  try {
    const service = await new FirmwareDownloadService({
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_API_SECRET: "test-download-secret" }),
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
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_API_SECRET: "test-download-secret" }),
      lookupImpl: async () => [{ address: "93.184.216.34" }]
    }).init({ startQueue: false });
    await assert.rejects(() => service.create({ sourceUrl: "http://example.com/file.bin" }), /HTTPS/);
    await assert.rejects(() => service.create({ sourceUrl: "https://example.com/file.bin" }), /official Samsung allowlist/);
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
      config: createDownloadConfig({ DOWNLOAD_DIR: dir, DOWNLOAD_API_SECRET: "test-download-secret" }),
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
