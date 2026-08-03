# VPS deployment runbook

The VPS runtime is composed from PostgreSQL, Redis and BullMQ. The application
process exposes the Fastify API and starts the BullMQ workers in the same
process. `src/vps/server.js` remains an offline memory-only foundation
entrypoint; production uses `npm run vps:start`.

## Application prerequisites

The following must already exist outside this repository:

- PostgreSQL with a dedicated database and least-privilege application user.
- Redis reachable by the application user.
- A secret/environment manager that injects `DATABASE_URL`, `REDIS_URL`,
  `WEBHOOK_SECRET`, `INTERNAL_API_SECRET`, and, when sending is enabled,
  `TELEGRAM_BOT_TOKEN`.
- Either a public HTTPS URL that forwards Telegram requests to `/telegram`, or Telegram long polling when no domain is available.

Do not put real values in `docs/VPS_ENV.example`, source files, or `.env`
files committed to the repository.

## Telegram transport without a domain

When the VPS has no public domain, enable long polling instead of webhook delivery:

```text
VPS_PUBLIC_BASE_URL=
VPS_SHADOW_MODE=false
TELEGRAM_SEND_ENABLED=true
TELEGRAM_POLLING_ENABLED=true
TELEGRAM_POLLING_TIMEOUT_SECONDS=30
```

Long polling does not modify Telegram webhook state. If the bot currently has a webhook configured, the operator must remove it through the separately approved Telegram procedure before `getUpdates` can receive updates. Only one polling process should run for a bot token.

## Database initialization

Run the migration once with the runtime environment injected:

```text
npm run db:migrate
```

The migration creates `app_kv`, `runtime_state`, `runtime_alarms`, and the
schema migration marker. It does not export, import, or delete application
data.

## Staged startup

Start in shadow mode first:

```text
npm run vps:start
```

The process starts the Fastify API, PostgreSQL/Redis-backed runtime, BullMQ
workers, and a minute-level scheduler tick. The default safety gates are:

```text
VPS_SHADOW_MODE=true
TELEGRAM_SEND_ENABLED=false
MONITOR_NOTIFICATIONS_ENABLED=false
TELEGRAM_COMMAND_SYNC_ENABLED=false
TELEGRAM_WEBHOOK_AUTOFIX_ENABLED=false
```

The application does not change the Telegram webhook automatically. Configure
the Telegram webhook through the separately approved operator procedure, then
verify `/health` and the Telegram secret header before enabling sending.

## Production gates

Only after the shadow run is healthy should the operator set:

```text
VPS_SHADOW_MODE=false
TELEGRAM_SEND_ENABLED=true
MONITOR_NOTIFICATIONS_ENABLED=true
```

The current code intentionally does not perform these external changes. A
system service, reverse proxy, firewall, DNS, secret manager, and Telegram
webhook remain operator-owned deployment steps.
