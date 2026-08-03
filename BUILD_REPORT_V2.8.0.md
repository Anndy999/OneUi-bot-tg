# v2.8.0 Build Report

## Verification

```text
npm ci: passed
Installed packages: 35
Dependency vulnerabilities: 0
JavaScript syntax check: passed
npm test: 82 / 82 passed
Credential scan: passed, 45 files scanned
Wrangler 4.107.0 dry-run: passed
Worker upload: 342.50 KiB
Worker gzip: 75.02 KiB
```

## Functional evidence

- Plain input accepts short, full, slash, and colon Model/CSC forms.
- Missing or unrelated input produces visible guidance instead of a silent return.
- Fast queries omit the Telegram placeholder; slow queries show it after about 300ms and edit it with the result.
- A KV quota failure does not block firmware queries or Durable Object monitor-item persistence.
- Concurrent monitor additions are merged atomically.
- Unchanged DO-scheduled checks produce zero additional KV writes.
- Repeated canonical mirrors are suppressed both after success and during quota backoff.
- Alarm and Queue redelivery cannot reuse a completed Lock Token.
- Exact CSC SmartHistory remains the only authoritative latest-firmware source.
- `version.xml`, generic History, test firmware, and foreign CSC records cannot become the official result.

## Expected KV writes

| Operation | Normal Durable Object path |
| --- | ---: |
| Plain query with unchanged firmware | 0 |
| Unchanged scheduled monitor check | 0 |
| Repeated identical `/add` | 0 |
| Changed monitor configuration | 1 best-effort mirror |
| New firmware fingerprint | 1 best-effort canonical mirror |

## Security

The release contains no `.env`, `.dev.vars`, `.wrangler`, deployment-generated config, real Token, Secret, Chat ID, Account ID, or KV Namespace ID. The public Wrangler configuration keeps the all-zero KV placeholder.

## Residual risk

- Local tests use deterministic Samsung and Telegram fixtures; production latency and upstream throttling require Cloudflare runtime metrics.
- Sub-minute Alarm intervals intentionally increase requests only in WATCH, HOT, and COOLDOWN modes. Their durations should be tuned from P95 latency and 403/429 rates after deployment.
- KV mirrors are best effort. During a daily quota outage, Durable Object state remains authoritative and retries after backoff.

## Deployment status

This release was built and verified locally only. It was not pushed to GitHub and was not deployed to Cloudflare as part of this change set.
