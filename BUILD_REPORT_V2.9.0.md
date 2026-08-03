# Build Report v2.9.0

## Verification

- Node syntax check: passed for all JavaScript/MJS files
- Automated tests: 93 / 93 passed
- New v2.9 tests: 6
- Security scan: passed, 55 files scanned, no committed credentials detected
- npm audit: 0 vulnerabilities
- Wrangler dry-run: passed
- Worker upload size: 386.65 KiB
- gzip size: 83.92 KiB

## Tested additions

- Structured firmware version records and legacy fourth-field cleanup
- Legacy HIGH=1 default migration and explicit administrator one-minute override
- Durable Object control-state support for users, access settings, flagship proposals and monitor boosts
- Durable Object target runtime state
- Persistent 24-hour performance summaries
- Global hourly query budget and concurrency limits

## Deployment notes

No new Durable Object class or migration tag is required. Existing MonitorScheduler storage is reused.

New optional environment variables:

```toml
MONITOR_MAX_QUERIES_PER_HOUR = "300"
MONITOR_MAX_CONCURRENT_QUERIES = "3"
MONITOR_MIN_TARGET_INTERVAL_SECONDS = "60"
```

Existing secrets remain unchanged.
