# VPS troubleshooting

This deployment is local-only: the Node process listens on `127.0.0.1:8787`
and Telegram uses outbound long polling. There is no required domain, Nginx,
HTTPS/443 listener, or inbound Telegram Webhook.

The optional firmware download process is a separate unit on
`127.0.0.1:8788`. It does not require DNS or UFW while it is local-only.

## First checks

```bash
sudo systemctl status oneui-bot.service --no-pager -l
sudo systemctl status oneui-postgresql.service oneui-redis.service --no-pager -l
curl --fail --silent --show-error http://127.0.0.1:8787/health
sudo journalctl -u oneui-bot.service -n 120 --no-pager
```

For the optional download interface:

```bash
sudo systemctl status oneui-download.service --no-pager -l
curl --fail --silent --show-error http://127.0.0.1:8788/health
sudo journalctl -u oneui-download.service -n 120 --no-pager
```

If the download unit fails, check that `/etc/oneui-bot/oneui-download.env`
exists, contains no placeholder values, points to the dedicated Redis URL, and
that `oneui` owns `/opt/oneui-bot/data/firmware`. Do not paste that environment
file into logs or chat. A public domain and inbound port are not a fix for a
local service failure.
If the Telegram admin menu says the download service is not configured, check
that `/etc/oneui-bot/oneui-bot.env` contains the same local API secret and
`DOWNLOAD_API_URL=http://127.0.0.1:8788`. Restart only `oneui-bot.service` after
editing that protected file.

Never paste the environment file or full connection URLs into an issue or
chat. Logs should contain error categories, not Tokens or passwords.

## Firmware download speed, pause, and resume

Large Samsung files use bounded, staggered HTTP Range connections. The
download unit defaults to 16 connections and permits at most 16. This can
improve throughput when Samsung limits one TCP connection, but it cannot
guarantee a speed higher than Samsung's route to the VPS.

Use **暂停** in the administrator download detail view to preserve a
Range-capable partial download, then **继续下载** to request only its unfinished
ranges. A VPS or service restart also preserves the saved ranges. Do not remove
`*.part` files manually: use the bot's **删除** action to discard the task and
its partial data intentionally. Downloads in the verification or decryption
phase can only be terminated; a paused download may be resumed only when no
other task is active.

If a speed change is needed, edit only the protected download environment file,
then restart only the download service:

```bash
sudo systemctl restart oneui-download.service
sudo systemctl status oneui-download.service --no-pager -l
```

Use `DOWNLOAD_PARALLEL_SEGMENTS=24` for the bounded high-throughput profile.
The downloader assigns 256 MiB Range work blocks to those lanes dynamically,
so a slow final Samsung connection does not hold the entire file open. If the
official source starts rejecting or slowing Range requests, return to `16`,
then `12`. The hard cap is `32`; do not use unbounded connection counts.

## Service will not start

Check the application unit and dependencies:

```bash
sudo systemctl cat oneui-bot.service
sudo systemctl is-enabled oneui-postgresql.service oneui-redis.service oneui-bot.service
sudo journalctl -u oneui-bot.service -b --no-pager
```

Common causes are a missing protected environment file, wrong Node path in the
systemd template, a failed dedicated PostgreSQL/Redis unit, or a missing
migration. Do not replace the default PostgreSQL/Redis units to fix OneUI.

## Health returns 503

The health response identifies the failing check without returning secrets:

```bash
curl -sS http://127.0.0.1:8787/health
```

- `postgres` failure: verify `oneui-postgresql.service`, its local port, and
  that the database migration was approved and completed.
- `redis` failure: verify `oneui-redis.service`, its local port and password
  configuration, and its journal.
- `telegramPolling` failure: the long-poll loop has not completed a successful
  `getUpdates` request within its grace period. Check the OneUI service log for
  the sanitized Telegram error category; do not print the environment file or
  Token. HTTP 401 or 409 is immediately unhealthy because it indicates an
  invalid Token or a polling/Webhook conflict.
- queue failure: inspect BullMQ/Redis errors in the application journal; do not
  delete Redis data while jobs are being investigated.

## Telegram updates are not received

Long polling requires all of the following:

- `TELEGRAM_POLLING_ENABLED=true`;
- `VPS_SHADOW_MODE=false` and `TELEGRAM_SEND_ENABLED=true`;
- a valid protected `TELEGRAM_BOT_TOKEN`;
- exactly one polling process for that Bot Token;
- no active Telegram Webhook for that Bot Token.

The application does not automatically call `setWebhook` or `deleteWebhook`.
Any Telegram-side change requires a separately approved operator action. The
poller stores its next update offset in PostgreSQL under an internal key and
uses stable BullMQ job IDs to avoid ordinary duplicate enqueueing.

Transient Telegram/network timeouts and temporary PostgreSQL failures are
retried with backoff. If the poller remains stale beyond its grace period, the
application exits with a failure status and the existing `Restart=on-failure`
systemd policy starts it again. This is visible without exposing secrets:

```bash
curl -sS http://127.0.0.1:8787/health
sudo systemctl show oneui-bot.service -p NRestarts -p ExecMainStatus --no-pager
```

HTTP 401 means the Token is invalid or revoked; HTTP 409 means another process
is polling the same Bot Token or a Webhook is still active. Automatic restarts
cannot correct those Telegram-side conflicts. Keep exactly one polling process
and resolve the Token/Webhook issue through the separately approved Telegram
operation.

## Messages are queued but not handled

```bash
sudo journalctl -u oneui-bot.service -f
```

Download logs are separate:

```bash
sudo journalctl -u oneui-download.service -f
```

Look for BullMQ worker errors, Telegram API errors, or PostgreSQL/Redis
connectivity changes. Restart only the OneUI service after collecting logs:

```bash
sudo systemctl restart oneui-bot.service
```

Do not restart unrelated VPS services.

## Concurrent queries and timeout protection

Interactive queries share identical in-flight requests, while different users
can be processed in parallel. Updates from the same chat are serialized so a
new command cannot overwrite an earlier query or confirmation state. Database
and health-check operations have bounded timeouts; transient query-message
delivery failures are placed into the existing notification queue for retry.

The defaults are conservative and require no extra environment values:

- PostgreSQL connection: 5 seconds;
- PostgreSQL query and statement: 15 seconds;
- health checks: 5 seconds;
- VPS HTTP request: 30 seconds.

If the VPS is under unusual load, inspect queue state and memory before raising
concurrency. Do not remove the timeout protection or use unlimited worker
concurrency. A Telegram 401/409, invalid credentials, a second poller, or an
active Webhook remains an external configuration problem and must be resolved
separately.

## Update failed

Use the update runbook's validation sequence:

```bash
sudo /opt/oneui-bot/deploy/update-vps.sh
```

The script stops on dirty working trees, failed tests, security findings,
high-severity production dependency audit findings, or an unhealthy service.
It does not automatically reset Git or restore a database. Preserve logs and
choose an approved code revert or database restore only after checking whether
any schema change was involved.

## Migration issue

```bash
cd /opt/oneui-bot
sudo -u oneui npm run db:migrate
```

This command is an approved schema operation, not part of the normal update.
Review the SQL, take a backup, and confirm the impact on existing users before
running it. Use a protected secret store for `DATABASE_URL`; never place a
real connection string in this document or shell history.

## Backups and recovery

Use `deploy/backup.sh` with a protected `DATABASE_URL`. Keep PostgreSQL dumps
and source archives outside `/opt/oneui-bot`, test that dumps can be read, and
retain enough history to cover one successful update and one rollback. Treat
Redis persistence as supplementary; PostgreSQL is the durable application
store.

## `npm: command not found` during update

The OneUI service uses the Node.js installation owned by the `oneui` user.
The update script calls that installation by its absolute path, so a normal
update should not depend on root's interactive shell PATH. If the path is
missing, inspect the installed runtime without printing the environment file:

```bash
sudo test -x /home/oneui/.nvm/versions/node/v22.23.2/bin/npm && echo npm-ok
sudo systemctl show oneui-bot.service -p ExecStart --no-pager
```

Do not install a second Node.js runtime or change the system default Node.js
without reviewing the systemd unit and the application runtime first.
