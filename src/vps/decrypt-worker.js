import { createDecipheriv } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

const key = Buffer.from(String(workerData?.keyHex || ""), "hex");
if (!parentPort || key.length !== 16) throw new Error("decrypt worker received an invalid AES key");

parentPort.on("message", ({ id, data }) => {
  try {
    // `data` arrives as a transferred ArrayBuffer. Keep it as a view instead
    // of copying every firmware block a second time in the worker.
    const input = data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (!input.length || input.length % 16 !== 0) {
      throw new Error("encrypted firmware size is not AES block aligned");
    }
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(false);
    const output = decipher.update(input);
    // ECB with disabled padding has no final payload. Calling final still
    // validates the cipher state without allocating a second full-size buffer.
    if (decipher.final().length) throw new Error("AES-ECB produced an unexpected final block");
    // Transfer the typed-array view itself. ArrayBuffer#slice and Buffer.from
    // on a typed array both copy the full block and were avoidable overhead.
    parentPort.postMessage({ id, data: output }, [output.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
