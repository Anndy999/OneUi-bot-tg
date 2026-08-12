# VPS maintenance and recovery checks

These tools are read-only except `backup.sh`, which creates a new backup. They
never print Telegram tokens, API secrets, Redis passwords, or Samsung FUS URLs.

## Before an update

`update-vps.sh` runs this automatically. You can also run it alone:

```bash
sudo /opt/oneui-bot/deploy/preflight-vps.sh
```

It blocks an update only when a required dependency, protected file permission,
checkout, runtime executable, or basic project-disk reserve is unsafe. A bot
or download process that is down is reported as a warning so the update can
still repair it.

## Download speed diagnosis

Start an administrator download, wait until it is actively transferring, then
run:

```bash
sudo /opt/oneui-bot/deploy/download-route-diagnose.sh
```

The report shows download-service health, active external TCP lane count, CPU,
memory, free space, and the TCP congestion-control settings. It intentionally
does not test an unauthenticated Samsung URL and never prints authorization
data. Compare reports only while downloading the same firmware on the same VPS
route; a local PC benchmark is not evidence of VPS-to-Samsung performance.

## Disk reserve and completed files

The download service exposes `lowDisk` in its local health response and writes
one journal warning per configured interval when its reserve is breached.
Downloads are blocked below the reserve; no firmware is deleted automatically.

```bash
sudo journalctl -u oneui-download.service -g 'capacity warning' --since '7 days ago' --no-pager
```

Remove completed firmware only from the OpenList-visible storage path after you
have confirmed it is no longer needed. Do not manually delete active `.part`
files; use the Telegram download controls.

## Backup and verification

Create a protected backup without copying downloaded firmware payloads:

```bash
sudo /opt/oneui-bot/deploy/backup.sh
```

The script uses the protected local runtime file internally and never prints
its values. Do not paste the database URL into chat. The project archive
excludes `data/firmware` but retains the lightweight download-state index.

Verify the newest backup without restoring anything:

```bash
sudo /opt/oneui-bot/deploy/verify-backup.sh /opt/oneui-backups
```

For a recovery drill, create a VPS snapshot first, run the verification command,
and restore only to a separate disposable PostgreSQL database. Never overwrite
the live database during a drill.

## Retired device subscriptions

The user-facing “My Devices” feature is retired. Existing historical records
are deliberately left untouched for rollback safety. They no longer control
notifications: a newly monitored firmware version is broadcast once to every
authorized user. Do not delete historical records or migrations unless you
separately decide that data-retention change.
