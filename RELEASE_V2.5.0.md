# v2.5.0 — Official History Only

## Removed

- Removed unsupported non-production firmware discovery entry points and runtime signals.
- Removed legacy FOTA metadata verification and fallback from live queries.
- Removed non-exact Generic History from user-visible query results and canonical cache writes.

## Monitoring correctness and speed

- Fixed permanent-error backoff so 403/404-class failures wait the full configured period.
- Reduced each Durable Object due-claim batch to twice the monitor concurrency.
- Increased the scheduler lock to five minutes and validates completion lock tokens.
- Added manual monitor claims so `/checknow` does not overlap an active Cron target.
- Prioritizes due targets inside the Durable Object.
- Long-dormant devices are de-prioritized instead of becoming increasingly aggressive.
- Ordered release-boost runtime writes to avoid same-isolate read-modify-write overwrite.

## Telegram

- New production webhook: `POST /telegram`.
- Validates `X-Telegram-Bot-Api-Secret-Token`.
- Adds `update_id` idempotency through the Durable Object, with KV fallback.
- Moves webhook self-healing off the user reply critical path.

## Query and cache

- SmartHistory is the sole live source.
- Exact Local CSC and Buyer CSC are accepted; Generic and foreign rows are rejected.
- Canonical cache accepts exact SmartHistory only.
- Shared upstream tasks own their timeout; one caller cancellation cannot cancel other callers.
- Role-specific query classes preserve interactive/admin/monitor isolation.

## Deployment security

- Replaced the committed KV Namespace ID with an all-zero placeholder.
- GitHub Actions requires `CLOUDFLARE_KV_NAMESPACE_ID` and builds a temporary private Wrangler config.
- Security scan rejects real KV IDs and additional sensitive variable literals.
