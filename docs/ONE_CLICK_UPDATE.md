# One-click VPS update

After the initial deployment, update the OneUI application with:

```bash
sudo /opt/oneui-bot/deploy/update-vps.sh
```

Before updating, the script verifies protected environment-file permissions,
the OneUI PostgreSQL and Redis dependencies, the clean `main` checkout, Node,
npm, and available project-disk space. A stopped bot or download service is
reported as a warning so an update can still be used as a repair deployment.

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

## Optional OpenList button for completed firmware

The bot keeps firmware files private by default. To show administrators an
**Open in OpenList** button after a task completes, add these non-secret values
to `/etc/oneui-bot/oneui-bot.env` using the address and folder that already
exist in your OpenList installation:

```ini
OPENLIST_BASE_URL=https://openlist.example.com
OPENLIST_FIRMWARE_PATH=/firmware
```

The button is hidden until both values are valid. It contains no API key,
temporary bypass, or file-server credential; OpenList must be configured to
require login before it permits access to that folder. Restart `oneui-bot.service`
after changing this optional setting.

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

## Backup and rollback discipline

Keep at least one recent PostgreSQL custom-format dump and a source archive
outside the application directory. Keep the previous Git commit identified in
the update log. For user-impacting changes, stop and choose between a code-only
revert and a coordinated database restore; do not make that choice
automatically.

For routine maintenance, see [VPS_MAINTENANCE.md](VPS_MAINTENANCE.md).
