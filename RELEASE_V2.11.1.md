# OneUI Firmware Worker v2.11.1

## Monitoring center

- Provides a compact administrator monitoring center with status filters:
  Active, Paused, Awaiting resume, and Failing.
- Each displayed target opens the existing target-detail panel, so priority,
  pause/resume, realtime query, interval, and single-target deletion controls
  remain available.

## Safe bulk deletion

1. Select **Delete all monitors** in the monitoring center.
2. Confirm the intent with the inline button.
3. Send exactly `DELETE ALL` or `删除全部` within 10 minutes.

Any other message cancels the pending bulk deletion and is handled normally.

## Preserved behavior

- Unacknowledged firmware update reminders continue on their configured cadence.
- Timed monitor pauses resume automatically under the existing scheduler rules.
- Query/monitor cards continue to infer only the build month when Samsung does
  not publish an official build date.
- A single transient Samsung SmartHistory HTTP 521 remains diagnostic-noise
  protected.
