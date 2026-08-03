# v2.3.1 - Faster Query and One-Minute Monitor

This release is intentionally limited to query latency and new-firmware detection speed.

## Query speed

- Coalesces concurrent SmartHistory requests for the same exact Model/CSC across interactive queries and monitoring.
- Reuses recent in-isolate History for stale-while-revalidate without an extra KV read.
- Retains L1 History for 120 seconds while preserving the independent 8-second freshness deadline.
- Reuses FUS sessions for up to 10 minutes, with the existing authorization retry as recovery.

## Monitoring speed

- Checks high-priority targets every minute, including targets already stored in KV with a slower item interval.
- Runs the three configured targets on three independent FUS lanes and three monitor workers.
- Skips `version.xml` after monitor History failures because XML is never authoritative for automatic monitoring.
- Persists a detected version, activates peer release windows, and prepares notification state concurrently.

Strict Model/CSC matching, History authority, generic-History rejection, XML cache lifetime rules, and notification deduplication are unchanged.
