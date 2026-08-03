# One-click VPS deployment

This runbook deploys OneUI as a VPS long-polling service. It intentionally
does not need a domain, Nginx, port 443, HTTPS, or a Telegram webhook. The
application listens on `127.0.0.1:8787`; Telegram connections are outbound.

The first installation needs a human with the existing VPS administrator
authority because it installs packages and creates `/etc`, `/var`, users, and
systemd units. Those commands are documented here but were not executed from
this task.

## 1. Preflight

Confirm the following before starting:

- The VPS has an existing `oneui` application user and a systemd host.
- The repository will be placed at `/opt/oneui-bot` and owned by `oneui`.
- OneUI will use its own PostgreSQL service on `127.0.0.1:55432` and Redis
  service on `127.0.0.1:56379`; default VPS services are not changed.
- A protected environment file will be created at
  `/etc/oneui-bot/oneui-bot.env`; it must never be committed or pasted into
  documentation.
- If existing Cloudflare user configuration must be retained, an approved
  export must be placed at
  `/opt/oneui-bot/migration-data/cloudflare-monitor-state.json` before the
  bootstrap script runs. This file is intentionally ignored by Git. Do not
  invent an empty snapshot when preserving users is required.

The bootstrap script prompts for the Telegram Bot Token and administrator Chat
ID without printing the Token. Do not put either value in a shell history,
source file, log, or Git commit.

## 2. Install the project

Run the following manually on the VPS using the approved administrator
procedure. Replace only the repository transport if your VPS uses a different
authenticated Git method; never put a GitHub token in the command line.

```bash
sudo install -d -o oneui -g oneui -m 0755 /opt/oneui-bot
sudo -u oneui git clone https://github.com/Anndy999/OneUi-bot-tg.git /opt/oneui-bot
cd /opt/oneui-bot
```

If `/opt/oneui-bot` already contains the approved checkout, do not clone over
it. Stop and inspect it instead.

## 3. Run the isolated bootstrap once

```bash
sudo bash /opt/oneui-bot/deploy/oneui-vps-bootstrap.sh
```

The script is guarded against an existing OneUI installation, does not remove
partial systemd units, does not modify default PostgreSQL/Redis, and does not
change Telegram Webhook state. It creates:

- `oneui-postgresql.service` with a dedicated data directory and database;
- `oneui-redis.service` with a dedicated data directory and password;
- `oneui-bot.service` running as the non-root `oneui` user;
- the protected environment file;
- the PostgreSQL runtime migration;
- enabled-at-boot systemd units.

The application starts with `TELEGRAM_POLLING_ENABLED=true`,
`VPS_SHADOW_MODE=false`, and `TELEGRAM_SEND_ENABLED=true` in the generated
environment. Confirm the Bot Token has no active webhook and no second polling
process before allowing the service to start. This task does not perform that
Telegram check or any Telegram mutation.

## 4. Verify PostgreSQL, Redis, systemd, and health

```bash
sudo systemctl status oneui-postgresql.service --no-pager
sudo systemctl status oneui-redis.service --no-pager
sudo systemctl status oneui-bot.service --no-pager
cd /opt/oneui-bot
sudo ./deploy/health-check.sh
```

Healthy output contains `"ok":true` and successful PostgreSQL, Redis, and
queue checks. The service is enabled with `systemctl enable`, so it starts
after reboot. No inbound firewall rule, Nginx site, DNS record, certificate,
or port 443 is needed.

## 5. Logs and backup

```bash
sudo journalctl -u oneui-bot.service -n 100 --no-pager
sudo journalctl -u oneui-bot.service -f
```

Before the first production update and on a regular schedule, run the backup
script with `DATABASE_URL` already injected by the protected environment:

```bash
cd /opt/oneui-bot
sudo -u oneui ./deploy/backup.sh
```

Do not put a real connection string in the command line or shell history. The
backup contains a PostgreSQL custom-format dump and source archive, excludes
`.env*` and `node_modules`, and should be copied to storage outside the VPS.
Redis is a cache/queue coordination dependency here; protect its persistence
volume as defense in depth, but PostgreSQL remains the durable application
store.

## 6. Later updates

After this one-time setup, the normal update is the single command in
[`ONE_CLICK_UPDATE.md`](ONE_CLICK_UPDATE.md):

```bash
sudo /opt/oneui-bot/deploy/update-vps.sh
```

Do not run `npm run db:migrate` as part of an unapproved update. A future
schema migration must be reviewed, backed up, and explicitly approved first.
