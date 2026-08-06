import { createDecipheriv } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

const key = Buffer.from(String(workerData?.keyHex || ""), "hex");
if (!parentPort || key.length !== 16) throw new Error("decrypt worker received an invalid AES key");

parentPort.on("message", ({ id, data }) => {
  try {
    const input = Buffer.from(data);
    if (!input.length || input.length % 16 !== 0) {
      throw new Error("encrypted firmware size is not AES block aligned");
    }
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(false);
    const output = Buffer.concat([decipher.update(input), decipher.final()]);
    const result = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
    parentPort.postMessage({ id, data: result }, [result]);
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
