# One-click VPS update

After the initial deployment, update the OneUI application with:

```bash
sudo /opt/oneui-bot/deploy/update-vps.sh
```

The script is intentionally limited to the OneUI application. It verifies the
checkout is on `main` and clean, fast-forwards from `origin/main`, then always
installs the locked Node dependencies without lifecycle scripts, runs tests,
runs the repository security scan, runs the production dependency audit,
restarts only `oneui-bot.service`, and waits for `/health`. Re-running after a
failed update therefore revalidates the same checkout instead of skipping
tests.

It does not restart PostgreSQL or Redis, change Telegram Webhook state, touch
Cloudflare, modify Nginx/firewall/SSH, or run a database migration.

## Expected verification

```bash
sudo systemctl is-active oneui-bot.service
curl --fail --silent --show-error http://127.0.0.1:8787/health
sudo journalctl -u oneui-bot.service -n 80 --no-pager
```

The health endpoint must report `ok: true`. It checks PostgreSQL and Redis
connectivity, long-polling liveness, and queue counts without exposing
credentials.

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

## Schema changes

The normal update does not apply migrations. If a release adds a migration,
take a PostgreSQL backup, review the SQL and compatibility impact, and approve
the separate command before running it. Use the protected secret store to
inject `DATABASE_URL`; never paste a real connection string into shell history
or Git.

```bash
cd /opt/oneui-bot
sudo -u oneui npm run db:migrate
```

## Backup and rollback discipline

Keep at least one recent PostgreSQL custom-format dump and a source archive
outside the application directory. Keep the previous Git commit identified in
the update log. For user-impacting changes, stop and choose between a code-only
revert and a coordinated database restore; do not make that choice
automatically.
