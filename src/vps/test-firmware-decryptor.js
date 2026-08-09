import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("./decrypter10.py", import.meta.url));

function safeProcessError(error) {
  return String(error?.message || error || "decrypter process failed").slice(0, 240);
}

function pythonCandidates(env = {}) {
  const configured = String(env.TEST_FIRMWARE_PYTHON_BIN || "").trim();
  const values = configured ? [configured] : process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  return [...new Set(values)];
}

function parseProgressLine(line) {
  const prefix = "ONEUI_TEST_FIRMWARE_PROGRESS ";
  if (!String(line).startsWith(prefix)) return null;
  try {
    const value = JSON.parse(String(line).slice(prefix.length));
    if (!value || typeof value !== "object") return null;
    return {
      phase: String(value.phase || "decrypting"),
      candidates: Math.max(0, Number(value.candidates) || 0),
      maxCandidates: Math.max(0, Number(value.maxCandidates) || 0),
      matched: Math.max(0, Number(value.matched) || 0)
    };
  } catch {
    return null;
  }
}

function runPython(binary, payload, timeoutMs, logger, onProgress = null) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, [SCRIPT_PATH], {
        cwd: fileURLToPath(new URL("./", import.meta.url)),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let stderrRemainder = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
      finish(reject, new Error(`test firmware decryptor timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderrRemainder += chunk.toString();
      const lines = stderrRemainder.split(/\r?\n/);
      stderrRemainder = lines.pop() || "";
      for (const line of lines) {
        const progress = parseProgressLine(line);
        if (progress) {
          try { onProgress?.(progress); } catch (error) {
            logger?.warn?.(`test firmware progress callback failed: ${safeProcessError(error)}`);
          }
        } else {
          stderr += `${line}\n`;
        }
      }
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (stderrRemainder) {
        const progress = parseProgressLine(stderrRemainder);
        if (progress) {
          try { onProgress?.(progress); } catch (error) {
            logger?.warn?.(`test firmware progress callback failed: ${safeProcessError(error)}`);
          }
        } else {
          stderr += stderrRemainder;
        }
      }
      if (code !== 0) {
        finish(reject, new Error(`test firmware decryptor exited ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${stderr.trim() ? `: ${stderr.trim().slice(0, 180)}` : ""}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        finish(resolve, result);
      } catch (error) {
        logger?.warn?.(`test firmware decryptor returned invalid JSON: ${safeProcessError(error)}`);
        finish(reject, new Error("test firmware decryptor returned invalid JSON"));
      }
    });
    child.stdin.once("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function runTestFirmwareDecryptor(payload, { env = {}, timeoutMs = 120_000, logger = console, onProgress = null } = {}) {
  let lastError = null;
  for (const binary of pythonCandidates(env)) {
    try {
      const result = await runPython(binary, payload, timeoutMs, logger, onProgress);
      if (!result || typeof result !== "object") throw new Error("invalid decryptor result");
      return result;
    } catch (error) {
      lastError = error;
      if (!/ENOENT|not found|spawn .* failed/i.test(safeProcessError(error))) break;
    }
  }
  throw lastError || new Error("unable to start the test firmware decryptor");
}

export { SCRIPT_PATH };
