# v2.8.1 Compact Notifications and Configurable Monitoring Intervals

## Scope

This release refines Telegram firmware copy, enables approved-user broadcasts by default, and replaces aggressive long-running sub-minute monitoring with administrator-controlled minute profiles.

The official data rules are unchanged:

- Exact CSC Samsung SmartHistory is the only live authority.
- `version.xml` is not used to select the latest firmware.
- Test, internal, engineering, generic, foreign-only, future-dated, and withdrawn firmware records are excluded.
- Model/CSC combinations are never generated as a Cartesian product.

## Compact query card

The main query response now shows only:

- Exact Model / CSC and country or region.
- Full official firmware version.
- Android version.
- Build date.
- Query latency.
- Simple SmartHistory live/cache status.

PDA, CSC component version, MODEM, decoded build details, cache implementation names, and the official-notes URL are removed from the message body. Realtime refresh, monitor management, and official notes remain available through buttons.

## Update notification copy

Separate cards are used for:

1. Administrator update confirmation.
2. Approved-user firmware broadcast.
3. First monitoring baseline.
4. Unconfirmed update reminder.

The administrator card includes confirmation, realtime query, HIGH/NORMAL/pause controls, official notes, and pending-update navigation. The approved-user card contains only query and official-notes actions.

Reminder copy uses the actual configured `UPDATE_REMINDER_INTERVAL_MINUTES` value instead of a hardcoded five-minute sentence.

## Approved-user broadcast

`NOTIFY_ALLOWED_USERS_ON_UPDATE` now defaults to `true` and is set to `true` in `wrangler.toml`.

When an exact official update is detected:

- The administrator receives one management notification.
- Every currently approved whitelist user receives one compact update notification.
- The administrator is excluded from the whitelist broadcast to prevent duplicates.
- Unauthorized or unknown chats are never broadcast recipients.

Set the variable explicitly to `false` to disable approved-user broadcasts.

## Monitoring interval profiles

Defaults:

| Profile | Minutes |
| --- | ---: |
| HIGH | 3 |
| NORMAL | 10 |
| LOW | 30 |
| IDLE | 60 |
| WATCH | 3 |
| HOT | 1 |
| COOLDOWN | 3 |

A high priority score no longer automatically renews WATCH mode. WATCH is entered only from an explicit release boost. A confirmed version change enters HOT, then COOLDOWN, then NORMAL.

Administrator controls:

```text
/intervals
/interval high 3
/interval normal 10
/interval low 30
/interval idle 60
/interval watch 3
/interval hot 1
/interval cooldown 3
/interval SM-S9480 TGY 5
```

The Telegram monitoring center also provides interval profile buttons with common presets.

Priority order:

```text
Per-target override
→ administrator profile setting
→ system default
```

Settings are stored in `MonitorScheduler` Durable Object Storage. They do not create recurring KV writes. Changing a profile immediately reschedules idle targets while preserving a newly added target's immediate baseline check.

## Compatibility

- No new Worker, Durable Object class, Queue, KV namespace, Secret, or migration is required.
- Existing monitor items and runtime state remain compatible.
- Missing interval settings automatically use the v2.8.1 defaults.
- Existing `/moninterval` and `/moniteminterval` commands remain supported as aliases for the new interval controls.

## Verification

```text
npm ci: passed, 0 vulnerabilities
JavaScript syntax: passed
Automated tests: 86 / 86 passed
Credential scan: passed, 48 files scanned
Wrangler 4.107.0 dry-run: passed
Upload: 354.26 KiB
gzip: 77.14 KiB
```
