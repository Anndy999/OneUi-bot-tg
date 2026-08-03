# OneUI Firmware Worker v2.12.0

- Removed the retired acknowledgement and pending-update user flow. Firmware discoveries are delivered once and monitoring continues independently.
- Added the administrator Monitor Health view with target health, last success, next check, failure count, and FUS retry state.
- Added a per-target Allowed-user update switch in the monitoring target detail screen.
- Preserved enabled broadcasts for existing targets by default.
- Updated the GitHub deployment workflow to Node.js 24 and removed the duplicate Telegram command publication request.
