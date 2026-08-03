# v2.11.5 - Compact Telegram commands

The Worker clears inherited default, private-chat, group, and group-admin
command scopes before publishing the current compact menu:

- /start
- /language
- /apply
- /whoami
- /status

Administrative actions remain available through the in-bot admin panel and
are intentionally hidden from Telegram's command menu.
