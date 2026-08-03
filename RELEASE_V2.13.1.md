# OneUI Firmware Worker v2.13.1

## Owner-controlled daily monitoring summary

From `/admin` → Monitoring → Schedule, select:

- `Enable daily summary`
- `Disable daily summary`

The state is stored in `MonitorScheduler`, so it survives a Worker restart and deployment. It only controls the daily owner summary; it does not pause monitoring or suppress real firmware-update notifications.

The delivery time remains `DAILY_MONITOR_SUMMARY_HOUR` in Beijing Time, defaulting to 21:00.
