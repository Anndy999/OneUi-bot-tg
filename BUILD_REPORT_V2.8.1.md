# Build Report v2.8.1

## Result

```text
Status: PASS
Automated tests: 86 / 86
Dependency vulnerabilities: 0
Credential scan: PASS, 48 files
Wrangler dry-run: PASS
Wrangler version: 4.107.0
Upload size: 354.26 KiB
gzip size: 77.14 KiB
```

## Main changes verified

- Query cards contain the full official version without PDA/CSC/MODEM component rows.
- Administrator, approved-user, baseline, and reminder notification copy are distinct.
- Approved-user update broadcasts are enabled by default.
- HIGH defaults to three minutes.
- WATCH is not automatically renewed by a high score.
- Explicit release boosts enter WATCH.
- HOT and COOLDOWN use configurable minute profiles.
- Interval profiles persist in MonitorScheduler Durable Object Storage.
- Per-target interval overrides take precedence.
- Existing exact-CSC SmartHistory safeguards remain covered by tests.
- KV quota failures do not block successful interactive queries.

## Security

The release archive does not include:

- Telegram bot tokens.
- Cloudflare API tokens.
- Webhook secrets.
- Real KV namespace IDs.
- `.env` or `.dev.vars` files.
- `node_modules` or `.wrangler` state.

`wrangler.toml` retains the all-zero KV namespace placeholder.
