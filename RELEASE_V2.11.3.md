# v2.11.3 - One-shot update alerts

- Firmware update messages now show only Model/CSC, old version, new version,
  detected time, and source.
- Device nickname, Android version, build date, acknowledgement controls, and
  reminder text were removed from update alerts.
- A detected update sends one notification to the administrator and, when
  enabled, one notification to each allowed user. No repeat reminders occur.
- Legacy pending acknowledgement records are cleaned during scheduled runs.
- There is no monthly pause/resume workflow. The existing `/monsnooze` feature
  remains a timed pause and resumes automatically at its configured time.
