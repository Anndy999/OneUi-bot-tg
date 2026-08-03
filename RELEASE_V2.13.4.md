# OneUI Firmware Worker v2.13.4

## Fixes

- Completed a strict UTF-8 and mojibake audit across the deployable project.
- Fixed administrator help formatting by returning complete text messages rather than nested arrays.
- Made administrator help and monitor-interval feedback follow the saved Chinese or English language.
- Removed unreachable duplicate help and Telegram command-registration code.
- Added regression coverage for bilingual, newline-formatted administrator help.

No command names, callback data, monitoring state, user access, cache data, or Cloudflare bindings were changed.
