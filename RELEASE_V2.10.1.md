# OneUI Firmware Worker v2.10.1

This release fills missing Samsung SmartHistory build dates without changing the query source, monitor schedule, notifications, or state storage.

## Build date fallback

- Uses the official SmartHistory `BINARY_OPEN_DATE` whenever Samsung provides one.
- If the official date is missing or an invalid placeholder, parses the standard Samsung PDA version code and displays only its encoded year and month.
- Chinese example: `2026-06（月份由版本号推算）`.
- English example: `2026-06 (month inferred from firmware version)`.
- Does not fabricate a day of the month.

## Compatibility

- No new Secret, KV Namespace, Durable Object, Queue, or migration.
- Existing monitor targets, firmware fingerprints, scheduling, notification idempotency, and the HTTP 521 diagnostics-noise protection remain unchanged.
