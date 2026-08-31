# OneUi Bot v2.22.3 — Bifrost SmartHistory + S25 Hong Kong recovery

## What changed

- Align Samsung SmartHistory authentication with current Bifrost behavior:
  - `SmartHistory.do` now uses the device model as the interface signature.
  - The interface signature hash uses Samsung's raw `NONCE`, matching Bifrost.
- Align SmartHistory latest-version selection more closely with Bifrost:
  - Keep `BINARY_OPEN_DATE` and `BINARY_EXIST` as metadata instead of hiding newly staged rows.
  - Continue excluding `Z(Android 99)` beta rows.
  - Continue rejecting rows that explicitly identify a different CSC.
  - Allow generic rows returned inside the exact Model/CSC-scoped SmartHistory response.
- Keep the stable source order: SmartHistory is primary; `version.xml` remains the interactive fallback when History is unavailable/unusable.
- Add a one-time production recovery for the S25 rollout chain:
  - Existing deployments that are still on the Europe (`EUX`) stage advance once to Hong Kong (`TGY`).
  - S26 is not changed.
  - Fresh installations are not force-advanced.
- Add regression coverage for Bifrost-compatible SmartHistory auth/selection and the S25 EU → HK recovery.

## Validation

- `test/query.test.js`: 150 passed, 0 failed.
- `test/maintenance.test.js` + `test/v290.test.js`: 15 passed, 0 failed.
- `npm run security-check`: passed.

The local sandbox could not finish installing all npm dependencies before timeout, so the three integration tests that require `fastify`/`pg` were not runnable here. The existing VPS one-click updater runs `npm ci` and the full test suite before restarting the service; if those checks fail, deployment stops before restart.
