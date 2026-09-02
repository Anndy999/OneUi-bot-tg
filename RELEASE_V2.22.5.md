# v2.22.5 — Realtime monitor queries

- Automatic monitor checks now set `refresh: true` when calling the firmware query coordinator.
- Scheduled checks bypass coordinator positive and negative caches and verify Samsung SmartHistory directly.
- Existing single-flight behavior is retained, so simultaneous checks for the same target can share one live Samsung request.
- Monitor runtime records the latest query source/mode/cache status.
- Rollout-chain detail panels show the most recent successful realtime query time, source, and whether a cache was used.
- Manual interactive queries keep their existing cache behavior.
- Bifrost-compatible SmartHistory logic and rollout controls from v2.22.4 are unchanged.
