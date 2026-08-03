# VPS foundation

This branch adds the server-independent foundation for the VPS migration. The
Cloudflare Worker entrypoint remains unchanged and is still the production
implementation until a later cutover.

## Implemented boundary

- `src/runtime/storage.js`: Cloudflare-KV-shaped `MemoryStorage`, paginated list
  semantics, TTL handling, and a PostgreSQL `app_kv` adapter.
- `src/runtime/cache.js`: memory/Redis cache contracts and process-local
  single-flight. Redis is never the durable authority for business state.
- `src/runtime/locks.js`: token-owned memory/Redis locks with TTL, refresh and
  safe release.
- `src/runtime/queue.js`: the five VPS queue names, an idempotent memory queue,
  and an injected BullMQ adapter.
- `src/runtime/scheduler.js`: an offline claim/token scheduler contract that
  mirrors the future PostgreSQL transaction boundary.
- `src/runtime/context.js`: one runtime context for gates, storage, cache,
  locks, queues, logging and background work.
- `src/vps/config.js`: shadow/send/monitor-notification gates and constant-time
  secret comparison.
- `src/vps/api.js` and `src/vps/app.js`: Fastify-compatible `/`, `/health`,
  `/telegram`, `/metrics`, `/internal/check` and `/internal/diagnostics` routes.
- `src/vps/server.js`: local-only foundation server using memory adapters. It
  is not a production deployment and does not send Telegram messages.
- `docs/VPS_ENV.example`: non-secret environment key template for the later VPS
  configuration step.

## Safety defaults

The VPS defaults to:

```text
VPS_SHADOW_MODE=true
TELEGRAM_SEND_ENABLED=false
MONITOR_NOTIFICATIONS_ENABLED=false
```

The API does not configure or change a Telegram webhook. The current
Cloudflare Worker, KV, Durable Objects, Queue and Cron remain untouched.

## What is deliberately not claimed yet

- The scheduler mutation path is not yet connected to PostgreSQL typed tables.
- The Telegram handler is not yet moved out of the Worker entrypoint.
- BullMQ workers are not started and no Redis/PostgreSQL connection is opened
  by the foundation server.
- No production data is exported or imported.

## Offline verification

Run from the repository root:

```powershell
npm test
npm run security-check
```

The added tests exercise TTL/pagination, single-flight, lock ownership, queue
job deduplication, shadow gates, webhook authentication and internal route
authentication without a server.
