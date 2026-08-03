# OneUI VPS deployment

This project runs on the VPS as a Node.js process with PostgreSQL, Redis and
BullMQ. When no public domain is available, Telegram uses long polling through
`getUpdates`; no webhook, Nginx, HTTPS certificate or public application port
is required.

## Runtime

- Node.js 22.23.2 is currently installed for user `oneui`.
- Production entrypoint: `npm run vps:start`.
- Database migration: `npm run db:migrate`.
- Long polling is enabled with `TELEGRAM_POLLING_ENABLED=true`.
- The application binds to `127.0.0.1` by default.
- The service runs as the non-root `oneui` user.

## Protected configuration

Create the environment file outside this repository, for example:

```text
/etc/oneui-bot/oneui-bot.env
```

Do not paste or commit its contents. Required production values are
`DATABASE_URL`, `REDIS_URL`, `WEBHOOK_SECRET`, `INTERNAL_API_SECRET` and
`TELEGRAM_BOT_TOKEN`. Use the variable names in `.env.example` as the
reference. Set the file permissions so only root and the `oneui` service user
can read it.

For a no-domain deployment, set:

```text
VPS_PUBLIC_BASE_URL=
VPS_SHADOW_MODE=false
TELEGRAM_SEND_ENABLED=true
TELEGRAM_POLLING_ENABLED=true
TELEGRAM_POLLING_TIMEOUT_SECONDS=30
```

Long polling does not change Telegram webhook state. If this bot token has an
old webhook, remove it through the separately approved Telegram operation
before starting polling. Only one polling process may use a bot token.

## Migration and service

After PostgreSQL and Redis are reachable and the protected environment is
available:

```text
npm ci --ignore-scripts
npm run db:migrate
```

The systemd template is [deploy/oneui-bot.service](deploy/oneui-bot.service).
Install it as a new service only; do not modify existing services:

```text
install -d -m 0750 -o root -g oneui /etc/oneui-bot
install -m 0640 -o root -g oneui /path/to/oneui-bot.env /etc/oneui-bot/oneui-bot.env
install -m 0644 -o root -g root /opt/oneui-bot/deploy/oneui-bot.service /etc/systemd/system/oneui-bot.service
systemctl daemon-reload
systemctl enable oneui-bot.service
systemctl start oneui-bot.service
```

The commands above add only the OneUI Bot unit. They must not be used to
restart or replace an existing PostgreSQL, Redis, Docker, Nginx or other
service.

## Health and logs

```text
./deploy/health-check.sh
systemctl status oneui-bot.service --no-pager
journalctl -u oneui-bot.service -n 100 --no-pager
journalctl -u oneui-bot.service -f
```

## Backup

`deploy/backup.sh` creates a PostgreSQL custom-format dump and a source
archive while excluding `.env*`, `node_modules`, npm cache, logs and the
backup directory itself. It requires `pg_dump` and a protected
`DATABASE_URL`; it is not run automatically during deployment.

## Rollback

Stop and disable only the OneUI Bot unit, restore the previous project copy
and restore the PostgreSQL dump through the database administrator's approved
procedure. Do not delete or reset existing VPS services or data as part of a
rollback.
