# Build Report v2.8.2

## Scope

- Removed the bot-generated duplicate fourth firmware component from normal `PDA/CSC/MODEM/PDA` values.
- Canonicalized firmware versions across query cards, monitor updates, approved-user broadcasts, baselines, reminders, pending panels, and flagship prompts.
- Preserved compatibility with legacy stored values so deployment does not create false update notifications.
- Normalized user-facing Android labels such as `B(Android 16)` to `16`.
- Avoided duplicate fallback Model/CSC lines in monitor cards.

## Root cause

v2.8.1 `normalizeFirmwareVersion()` appended PDA as a fourth component whenever SmartHistory returned a normal three-part version. The displayed fourth component was synthetic, not a separate model or a second firmware package.

## Verification

```text
Node.js: v22.16.0
npm test: 87 / 87 passed
npm audit: 0 vulnerabilities
Credential scan: passed, 49 files scanned
JavaScript syntax checks: passed
Wrangler: 4.107.0
wrangler deploy --dry-run: passed
Upload: 356.32 KiB
gzip: 77.42 KiB
```

## Compatibility

- No new Worker binding.
- No new Durable Object migration.
- No new Queue or KV namespace.
- No new Secret.
- Existing four-part cached values ending in a duplicate PDA are normalized when read or displayed.
- Exact CSC SmartHistory remains the only live latest-version authority.
