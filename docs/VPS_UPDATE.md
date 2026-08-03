# VPS 更新与管理

## 日常更新

在 VPS 上以 `tempadmin` 登录后执行：

```bash
sudo /opt/oneui-bot/deploy/update-vps.sh
```

脚本会从私人 GitHub 仓库的 `main` 分支获取代码，确认工作目录没有未提交修改，然后依次运行：

- `npm ci --ignore-scripts`
- `npm test`
- `npm run security-check`
- `npm audit --omit=dev --audit-level=high`
- 仅重启 `oneui-bot.service`
- 检查 `http://127.0.0.1:8787/health`

普通代码更新不会重启 PostgreSQL 或 Redis。

## 服务查看

```bash
sudo systemctl status oneui-bot.service --no-pager
sudo systemctl status oneui-postgresql.service --no-pager
sudo systemctl status oneui-redis.service --no-pager
```

查看机器人日志：

```bash
sudo journalctl -u oneui-bot.service -f
```

## 运行时敏感配置

真实配置只保存于：

```text
/etc/oneui-bot/oneui-bot.env
```

不要把这个文件复制到 GitHub，不要把 Telegram Token、数据库密码、Redis 密码或 Cloudflare Token 写进项目文件。

## GitHub 发布原则

仓库应保持 Private。提交前确认以下内容未被跟踪：

- `.env` 和 `.env.*`
- `migration-data/`
- `*.zip`
- `.npm-cache/`
- PostgreSQL/Redis 数据目录
- 任何私钥或 Token
