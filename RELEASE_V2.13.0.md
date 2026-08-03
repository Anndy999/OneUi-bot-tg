# OneUI Firmware Worker v2.13.0

## Monitoring reliability and visibility

- Added a bounded monitor event stream in `MonitorScheduler`.
- Added Samsung source health scoring for the monitoring center.
- Added Telegram delivery confirmation events for update notifications.
- Added one daily owner summary at 21:00 Asia/Shanghai by default.
- Kept official SmartHistory CSC suggestion and exact-CSC safety rules unchanged.

## Configuration

```text
DAILY_MONITOR_SUMMARY_ENABLED=true
DAILY_MONITOR_SUMMARY_HOUR=21
```

Set `DAILY_MONITOR_SUMMARY_ENABLED=false` to disable the daily summary. The hour is interpreted in Beijing Time and must be an integer from 0 through 23.

## Safety

- Only the latest 50 important monitor events are retained.
- No tokens, secrets, message content, configuration export, or administrator audit logs are stored by this feature.
- This release does not add firmware download, OTA package, or decryption functionality.
