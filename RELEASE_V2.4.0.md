# v2.4.0 - Intelligence Upgrade

This release upgrades monitoring intelligence and query infrastructure without adding Telegram Inline Query or changing the SmartHistory-authoritative query policy.

## Intelligent monitoring

- Calculates `priorityScore` from 24-hour query demand, flagship status, related CSC releases, time since the last official update, and consecutive failures.
- Maps scores to 1, 3, 10, 30, or 60-minute intervals. A release-window boost raises only configured exact targets to the one-minute tier.
- Routes every Model/CSC through `validateModelCsc()`. Release peers must also exist in the current monitor list.
- Keeps the one-minute Cron trigger while avoiding a full monitor-list scan on normal ticks.

## MonitorScheduler compatibility layer

- Adds a singleton Durable Object with ordered `nextCheckAt` keys, `inFlight`, `lastVersion`, and expiring locks.
- Claims due targets atomically so concurrent Cron invocations cannot query the same target twice.
- Keeps monitor lists, runtime history, notification state, query caches, and failure records in Workers KV.
- Synchronizes the target registry on first use and after monitor-list changes; automatically falls back to KV scheduling if the binding is unavailable.

## Query infrastructure

- Adds one admin lane, three stable-hash interactive lanes, and three stable-hash monitor lanes.
- Adds a 60-second `firmwareMemoryCache` for SM-S9380, SM-S9280, and SM-S9180. It accepts only exact canonical History records and does not replace KV authority.
- Stores up to 20 exact History entries as `historyChain` with version, build date, security patch, and sequence. XML and generic History cannot append to the chain.
- Decodes Samsung firmware strings into model, Bootloader, build year/month, and revision for result display.

## Security and deployment

- Reads the Cloudflare account from `CLOUDFLARE_ACCOUNT_ID` in GitHub Actions instead of `wrangler.toml`.
- Extends the repository scanner to reject `.env`, `.dev.vars`, `token.json`, and `secret.json`.
- Preserves the existing private repository, Worker, KV namespace, GitHub Actions workflow, and Worker secrets.
