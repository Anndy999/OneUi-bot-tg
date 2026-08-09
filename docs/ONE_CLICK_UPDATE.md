# One-click VPS update

After the initial deployment, update the OneUI application with:

```bash
sudo /opt/oneui-bot/deploy/update-vps.sh
```

The script is intentionally limited to the OneUI application. It verifies the
checkout is on `main` and clean, fast-forwards from `origin/main`, then always
installs the locked Node dependencies without lifecycle scripts, runs tests,
runs the repository security scan, runs the production dependency audit,
applies all idempotent database migrations, restarts `oneui-bot.service` and,
if the optional download service is already active, restarts
`oneui-download.service` and checks its local health endpoint.
Re-running after a
failed update therefore revalidates the same checkout instead of skipping
tests.

It does not restart PostgreSQL or Redis, change Telegram Webhook state, touch
Cloudflare, modify Nginx/firewall/SSH, or restart PostgreSQL/Redis.

## Expected verification

```bash
sudo systemctl is-active oneui-bot.service
curl --fail --silent --show-error http://127.0.0.1:8787/health
sudo journalctl -u oneui-bot.service -n 80 --no-pager
```

The health endpoint must report `ok: true`. It checks PostgreSQL and Redis
connectivity, long-polling liveness, and queue counts without exposing
credentials.

If the independent download interface has been installed:

```bash
sudo systemctl is-active oneui-download.service
curl --fail --silent --show-error http://127.0.0.1:8788/health
sudo journalctl -u oneui-download.service -n 80 --no-pager
```

## If an update fails

- If the working tree check fails, stop. Do not overwrite local changes; save
  or review them before retrying.
- If `npm test`, `security-check`, or `npm audit` fails, the script exits before
  restarting the service. Read the command output, fix the approved project
  issue, and rerun the same command.
- If the service restart or health check fails, inspect:

  ```bash
  sudo systemctl status oneui-bot.service --no-pager -l
  sudo journalctl -u oneui-bot.service -n 120 --no-pager
  sudo systemctl status oneui-postgresql.service oneui-redis.service --no-pager
  ```

- If the code was fast-forwarded but the service was not restarted, the old
  process remains running. Resolve the validation error and rerun the update;
  the script will not silently reset the checkout.
- If the new process starts and then fails, keep PostgreSQL and Redis running,
  preserve the logs, and use an approved Git revert/rollback procedure. Do not
  delete `app_kv`, `runtime_state`, `runtime_alarms`, Redis data, or user
  configuration as a troubleshooting shortcut.

## Samsung test-build scan

The VPS-only test-build pipeline uses only the `version.test.xml` hash list and
the pure Python decryption logic included in the repository. It does not
download firmware, handle IMEI/device identity, or expose a public decryption
endpoint.

On the first start after this release, the service pauses the existing S26/S25
rollout chains without deleting their targets or history, then queues one
immediate `SM-S948N/KOO` scan. After an administrator verifies the returned
full version, use the button in the notification or `/testconfirm`. The bot
then queues `SM-S948B/EUX`; only a successful EUX decryption enables that
target's official firmware monitor. The existing rollout definitions remain
recoverable and are not automatically deleted.

The production scheduler claims at most one regular scan per Beijing date in
the 18:00 window. New unresolved hashes are stored and warned to administrators
once; they are not broadcast to ordinary users.

```text
/testscan              # administrator: run the current staged pipeline targets
/testscan SM-S9480 CHC # administrator: scan one target and retry unresolved hashes
/testconfirm            # confirm KOO and enable the EUX stage
```

The no-argument scheduled pipeline scans only KOO before confirmation and KOO
plus EUX after confirmation. `/testscan MODEL CSC` remains available for an
administrator's one-off diagnostic scan; EUX is still blocked until KOO is
confirmed.

The VPS service synchronizes the Telegram shortcut command list on startup.
The administrator's private command menu includes `/testconfirm`; if Telegram
has cached an old menu, send `/synccommands` once from an administrator chat.
During KOO or EUX decryption, the bot edits one progress message with the
current phase, candidate count, percentage, and matched count. If Telegram
delivery is temporarily unavailable, the scan continues and the final summary
is sent when delivery recovers.

The one-click update applies the repository migrations before restarting the
application. It reads the protected `DATABASE_URL` from the VPS environment
file without printing it. Keep a PostgreSQL backup before a production update.

The scheduled scan is controlled by these non-secret settings in
`/etc/oneui-bot/oneui-bot.env`:

```text
TEST_FIRMWARE_SCAN_ENABLED=true
TEST_FIRMWARE_SCAN_TIME=18:00
TEST_FIRMWARE_TIMEZONE=Asia/Shanghai
```

Do not manually add a second timer or cron job for this feature.

## Backup and rollback discipline

Keep at least one recent PostgreSQL custom-format dump and a source archive
outside the application directory. Keep the previous Git commit identified in
the update log. For user-impacting changes, stop and choose between a code-only
revert and a coordinated database restore; do not make that choice
automatically.
