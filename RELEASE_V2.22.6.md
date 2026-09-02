# OneUI Firmware Bot v2.22.6

## Rollout monitoring now tracks only the latest baseline

- When a rollout stage becomes active (manual next-stage, restart from Korea, automatic confirmed advance, dependent-chain start, or recovery), every target in that stage is marked for a one-time silent baseline refresh.
- The first scheduled check still bypasses caches and queries Samsung FUS SmartHistory in real time.
- Samsung's current latest firmware becomes the new monitoring baseline and does **not** generate a Telegram "new version" notification, even if an old stored `lastVersion` exists from weeks ago.
- Only versions discovered **after** that baseline can trigger update notifications and rollout proposals.
- A failed baseline query remains pending and retries later; it is never silently accepted from stale cache.
- Ordinary non-rollout monitor targets keep their existing behavior.

This prevents historical firmware from being replayed when an old rollout stage is re-enabled while preserving real-time Samsung checks introduced in v2.22.5.
