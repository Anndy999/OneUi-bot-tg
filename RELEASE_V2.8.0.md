# v2.8.0 Fast Query and Sub-minute Discovery

## Scope

This release improves official firmware query latency and release-window monitoring speed. It does not add Telegram Inline Query, test firmware discovery, `version.xml` fallback, a new bot, or a new Worker.

## Telegram query input

The plain-text query route now accepts:

```text
9480 tgy
s9480 tgy
sm-s9480 tgy
SM-S9480 TGY
SM-S9480/TGY
SM-S9480:TGY
```

All forms normalize to the exact target `SM-S9480 / TGY`. Plain text only queries firmware; only the administrator-only `/add` command changes monitoring configuration. Missing CSC and unrelated text receive a visible format guide instead of being silently ignored.

## KV write reduction

- Query rate limiting and query-demand counters moved to `MonitorScheduler` Durable Object storage.
- Monitor items are saved to Durable Object storage first and mirrored to KV only after a material change.
- Monitor-item upsert and removal are serialized inside the Durable Object, so concurrent administrator actions cannot overwrite each other.
- A KV quota failure leaves the Durable Object state intact and schedules a later mirror retry.
- Canonical firmware KV mirrors are keyed by firmware fingerprint; the same version is not written repeatedly.
- A failed canonical mirror enters quota-aware backoff; repeated real-time refreshes do not retry the same `put()` before the backoff expires.
- Unchanged DO-scheduled monitor checks keep runtime and version state in the scheduler and perform zero additional KV writes.

Expected write behavior:

| Operation | KV writes in the normal DO path |
| --- | ---: |
| Plain query, unchanged firmware | 0 |
| Unchanged monitor check | 0 |
| Repeated identical `/add` | 0 |
| Changed monitor configuration | 1 best-effort mirror |
| New firmware fingerprint | 1 canonical mirror plus update notification state |

## Query latency

- SmartHistory begins before any Telegram placeholder request.
- The placeholder is delayed for about 300ms and omitted for fast queries.
- Query Coordinator uses a memory micro-cache and a short DO Storage cache.
- KV canonical persistence is write-behind and cannot turn a successful Samsung response into a query failure.
- Dynamic hot targets include high-priority monitors, flagship-linked targets, and recently queried exact Model/CSC targets.

## Sub-minute monitoring

`MonitorScheduler` now supports:

```text
NORMAL -> WATCH -> HOT -> COOLDOWN -> NORMAL
```

- `WATCH`: every 30 seconds.
- `HOT`: every 15 seconds for 3 minutes after an update signal.
- `COOLDOWN`: every 30 seconds for 10 minutes.
- `NORMAL`: existing priorityScore interval.

Durable Object Alarm claims a target with the same lock used by Cron and `/checknow`, then sends a `monitor_check` task through the existing Queue. Repeated Alarm delivery cannot claim an in-flight target. The one-minute Cron remains the recovery and normal-schedule fallback.

Queue consumers validate the claim before querying Samsung, and task completion requires the exact active Lock Token. Redelivered, expired, or paused-target messages are rejected before an upstream request.

## FUS protection

Interactive, admin, and monitor service classes remain isolated. A new adaptive lane selector considers queue length, latency EWMA, Session availability, circuit state, and recent errors. The same target retains temporary lane affinity to preserve Session reuse and circuit behavior.

Negative query cache classes distinguish exact-CSC missing, empty History, 403, 404, 429, timeout, upstream 5xx, parse errors, and network errors. Release-window empty History uses a shorter cache than normal operation.

## Observability

Query metrics now separate Lane queue wait, Session acquisition, Nonce creation, SmartHistory network time, History parsing, coordinator hop, cache layer, and single-flight joins. A bounded in-memory sample emits rolling P50/P95/P99 latency, cache-hit, join, and success rates every 20 queries without logging message text or credentials.

## Security

- No Token, Secret, Chat ID, Account ID, or real KV Namespace ID is stored in the release.
- `wrangler.toml` keeps the all-zero KV placeholder.
- Official firmware remains exact-CSC SmartHistory only.
- Test/internal firmware and `version.xml` remain excluded.

## Verification

```text
npm ci: passed, 0 vulnerabilities
JavaScript syntax: passed
Automated tests: 82 / 82 passed
Credential scan: passed, 45 files scanned
Wrangler dry-run: passed
Upload: 342.50 KiB
gzip: 75.02 KiB
```
