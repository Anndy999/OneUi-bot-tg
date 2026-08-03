# OneUI VPS deployment

The supported VPS target is a single, non-root Node.js service using dedicated
OneUI PostgreSQL and Redis instances. Telegram is consumed with `getUpdates`
long polling. This deployment does not require a domain, Nginx, HTTPS/443, or a
Telegram webhook.

Use [`ONE_CLICK_DEPLOY.md`](ONE_CLICK_DEPLOY.md) for first installation and
[`ONE_CLICK_UPDATE.md`](ONE_CLICK_UPDATE.md) for later updates. The repository
contains the following runtime pieces:

- `src/vps/production-server.js`: Fastify process and production runtime.
- `src/vps/workers.js`: BullMQ workers, scheduler ticks, and long polling.
- `src/vps/telegram-polling.js`: persistent Telegram update offset handling.
- `migrations/001_vps_runtime.sql`: idempotent PostgreSQL runtime tables.
- `deploy/oneui-bot.service`: systemd unit for the application.
- `deploy/health-check.sh`: local health endpoint check.

The application binds to `127.0.0.1` by default. PostgreSQL and Redis should
also bind only to localhost on their OneUI-specific ports. The checked-in
environment template is a placeholder only; real values belong in the
protected environment file outside Git.

Long polling does not change Telegram webhook state. If the Bot Token still
has a webhook, an administrator must handle that separately before polling is
enabled. The bootstrap script deliberately does not call `deleteWebhook` or
`setWebhook`. Only one polling process may use a Bot Token.

Do not use the bootstrap or update instructions to restart, reconfigure, or
replace any default PostgreSQL, Redis, Docker, Nginx, firewall, Cloudflare, or
other VPS service. Database schema changes and any user-data import remain
operator-approved steps.
