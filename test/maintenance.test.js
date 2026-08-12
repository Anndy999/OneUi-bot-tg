import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("update runs a non-secret preflight before changing the checkout", async () => {
  const [update, preflight] = await Promise.all([
    read("../deploy/update-vps.sh"),
    read("../deploy/preflight-vps.sh")
  ]);
  assert.ok(update.indexOf('bash "${PREFLIGHT_SCRIPT}"') < update.indexOf('git_cmd fetch --prune origin main'));
  assert.match(preflight, /oneui-postgresql\.service/);
  assert.match(preflight, /oneui-redis\.service/);
  assert.match(preflight, /status --porcelain/);
  assert.match(preflight, /8#\$\{mode\} <= 8#640/);
  assert.doesNotMatch(preflight, /source "\$\{BOT_ENV_FILE\}"/);
  assert.doesNotMatch(preflight, /cat "\$\{BOT_ENV_FILE\}"/);
});

test("maintenance scripts protect storage and do not expose credentials", async () => {
  const [backup, verify, diagnose] = await Promise.all([
    read("../deploy/backup.sh"),
    read("../deploy/verify-backup.sh"),
    read("../deploy/download-route-diagnose.sh")
  ]);
  assert.match(backup, /backup_dir="\$\{BACKUP_DIR:-\/opt\/oneui-backups\}"/);
  assert.match(backup, /--exclude='\.\/data\/firmware'/);
  assert.match(backup, /source "\$\{env_file\}"/);
  assert.match(verify, /\/opt\/oneui-backups/);
  assert.match(verify, /pg_restore --list/);
  assert.match(verify, /tar -tzf/);
  assert.doesNotMatch(diagnose, /DOWNLOAD_API_SECRET|REDIS_URL|source .*env/i);
  assert.match(diagnose, /intentionally omits FUS URLs/);
});
