import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", ".wrangler", "coverage"]);
const ignoredExtensions = new Set([".zip", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"]);
const forbiddenFileNames = new Set([".env", ".dev.vars", "token.json", "secret.json"]);
const localOnlyFiles = new Set(["wrangler.local.toml", "wrangler.deploy.toml"]);
const execFileAsync = promisify(execFile);
const sensitiveNames = [
  "TELEGRAM_BOT_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_KV_NAMESPACE_ID",
  "TELEGRAM_CHAT_ID",
  "WEBHOOK_SECRET",
  "GITHUB_TOKEN"
];
const safeLiteralPrefixes = ["test", "fake", "example", "placeholder", "your_", "<", "{"];
const findings = [];

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }
    if (!entry.isFile() || ignoredExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    files.push(fullPath);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function report(file, lineNumber, message) {
  findings.push(`${relative(file)}:${lineNumber}: ${message}`);
}

function isSafeLiteral(value) {
  const normalized = String(value || "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (!normalized) return true;
  if (/^\d{1,5}$/.test(normalized)) return true;
  return safeLiteralPrefixes.some((prefix) => normalized.startsWith(prefix));
}

let files;
try {
  await fs.access(path.join(root, ".git"));
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  files = stdout.split("\0").filter(Boolean).map((item) => path.join(root, item));
} catch {
  files = (await walk(root)).filter((file) => !localOnlyFiles.has(path.basename(file)));
}

for (const file of files) {
  const name = path.basename(file);
  if (forbiddenFileNames.has(name) || name.startsWith(".env.") || name.startsWith(".dev.vars.")) {
    report(file, 1, "environment secret file must not be committed");
    continue;
  }

  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/.test(line)) {
      report(file, lineNumber, "possible Telegram bot token");
    }
    if (/\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(line)) {
      report(file, lineNumber, "possible GitHub access token");
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) {
      report(file, lineNumber, "private key material");
    }
    if (relative(file) === "wrangler.toml") {
      const namespace = line.match(/^\s*id\s*=\s*["']([0-9a-fA-F]{32})["']/);
      if (namespace && namespace[1] !== "00000000000000000000000000000000") {
        report(file, lineNumber, "real Cloudflare KV namespace ID must not be committed");
      }
    }

    for (const key of sensitiveNames) {
      const match = line.match(new RegExp(`\\b${key}\\b\\s*(?:=|:)\\s*([^#\\s,]+)`, "i"));
      if (!match) continue;
      const value = match[1];
      const referenceOnly = /\$\{\{|secrets\.|env\.|process\.env|env\[|env\.|\$[A-Za-z_][A-Za-z0-9_]*/i.test(line);
      if (!referenceOnly && !isSafeLiteral(value)) {
        report(file, lineNumber, `${key} appears to contain a literal value`);
      }
    }
  });
}

if (findings.length) {
  console.error("Security check failed:\n" + findings.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Security check passed (${files.length} files scanned; no committed credentials detected).`);
