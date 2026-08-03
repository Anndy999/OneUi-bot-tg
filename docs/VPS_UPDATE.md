# VPS update

The canonical update procedure is [`ONE_CLICK_UPDATE.md`](ONE_CLICK_UPDATE.md).

Run the following on the VPS after the one-time bootstrap:

```bash
sudo /opt/oneui-bot/deploy/update-vps.sh
```

The update checks the clean `main` checkout, locked dependencies, tests,
security scan, production dependency audit, application restart, and local
health. It restarts only `oneui-bot.service`; it does not restart or modify
the dedicated PostgreSQL/Redis services, default VPS services, Telegram,
Cloudflare, Nginx, firewall, or SSH.

For failures, use [`VPS_TROUBLESHOOTING.md`](VPS_TROUBLESHOOTING.md). Database
migrations and user-data restores are separate, approved operations.
