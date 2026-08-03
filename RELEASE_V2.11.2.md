# OneUI Firmware Worker 2.11.2

## Reliability

- Added a monitoring-center recovery control that requeues only active targets with recorded failures. It does not start a burst of direct Samsung requests; the scheduler keeps the configured concurrency limit.
- Added a post-deploy GitHub Actions smoke check. The workflow now verifies that the public `/health` endpoint reports the same version as the source before continuing.

## GitHub Actions secrets

To let automatic deployment reconfigure Telegram safely, add these repository secrets in GitHub:

- `TELEGRAM_BOT_TOKEN`
- `WEBHOOK_SECRET`

`WEBHOOK_SECRET` must be the same value configured for the deployed Cloudflare Worker. Never commit or paste either value into source files, issues, or chat messages.
