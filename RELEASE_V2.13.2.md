# OneUI Firmware Worker v2.13.2

## Simplified monitor interval control

The administrator-facing monitoring interval page now shows one simple input workflow:

```text
/moninterval 15
```

The value is stored in `MonitorScheduler` and applies to all default monitor
cadences, including normal monitoring and temporary release observation modes.
Valid values are from 1 to 1440 minutes. Per-device interval overrides remain
unchanged.

Existing preset callbacks are retained only for compatibility with previously
sent Telegram messages; they are not exposed by the new page.
