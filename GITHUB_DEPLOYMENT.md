# GitHub Actions 自动部署指南（v2.10.0）

仓库可以保持 Private，也可以是 Public。部署依赖工作流与 GitHub Secrets，不依赖仓库可见性。

## Cloudflare 资源

这仍然是同一个 Worker 和同一个 Telegram 机器人。v2.10.0 不新增 Secret、Worker、Durable Object 类或 Queue，继续使用现有资源：

```text
FIRMWARE_QUERY_COORDINATOR         SQLite-backed Durable Object
oneui-firmware-notifications       Cloudflare Queue
oneui-firmware-notifications-dlq   Dead Letter Queue
```

并继续保留：

```text
MONITOR_SCHEDULER                  SQLite-backed Durable Object
FIRMWARE_KV                        KV Namespace
```

从旧版本升级到 v2.10.0 不需要新增 Durable Object migration、Queue 或 Secret。`MonitorScheduler` 会继续使用原对象，并逐步补充新状态字段。

## Repository Secrets

进入：

`Settings → Secrets and variables → Actions → Secrets`

必需：

| 名称 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 部署 Worker，并创建/管理通知 Queue |
| `CLOUDFLARE_ACCOUNT_ID` | 目标 Cloudflare Account ID |
| `CLOUDFLARE_KV_NAMESPACE_ID` | `FIRMWARE_KV` 的 32 位 Namespace ID |

可选，用于部署后自动设置 Telegram Webhook：

| 名称 | 用途 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather Token |
| `WEBHOOK_SECRET` | Telegram `secret_token` 与 Worker Header 校验值 |

不要将这些值写入代码、README、Issue、PR 评论、截图、`.env` 或 `.dev.vars`。

## Cloudflare API Token 权限

现有 Token 如果只能编辑 Worker，第一次部署可能在 `Ensure notification queues exist` 步骤失败。

请让该 Token 至少具备：

```text
Workers Scripts：Edit
Workers Queues：Edit（或账户中等效的 Queues 管理权限）
```

并将 Account Resources 限制为实际部署机器人的 Cloudflare 账户。

不需要把 Token 发到聊天，也不需要写进仓库。

## Repository Variables

可选：

| 名称 | 示例 |
| --- | --- |
| `WORKER_URL` | `https://oneui-firmware-worker.<subdomain>.workers.dev` |

工作流优先读取同名 Repository Secrets，并兼容已有的 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_KV_NAMESPACE_ID` Variables；推荐逐步迁移到 Secrets。

## 自动部署流程

推送到 `main` 或 `master` 后：

1. `npm ci`
2. `npm run security-check`
3. `npm test`
4. 验证 Cloudflare 三个部署 Secret
5. 将全零 KV 占位符替换到临时 `wrangler.deploy.toml`
6. 检查并创建主通知 Queue 与 DLQ
7. `wrangler deploy --config wrangler.deploy.toml --keep-vars`
8. 删除临时配置
9. 可选调用 Telegram `setWebhook`
10. 请求 `/health`

真实 KV ID 只在 Actions Runner 内短暂存在，不会提交到 GitHub。

## 升级到 v2.10.0

1. 保留现有 GitHub Secrets：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_KV_NAMESPACE_ID`
2. 检查 `CLOUDFLARE_API_TOKEN` 是否具有 Queue 管理权限。
3. 保留 Worker Secrets：
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `WEBHOOK_SECRET`
4. 推送 v2.10.0 到 `main`。
5. 查看 `Test and deploy Cloudflare Worker`。
6. 部署完成后检查：
   - `/health` 显示 `2.10.0`
   - `queryCoordinator: true`
   - `notificationQueue: true`
   - Telegram `/status`
   - `/refresh 9380 CHC`
   - `/checknow`

## 常见错误

### Queue provisioning failed

Cloudflare API Token 缺少 Queue 创建/管理权限。更新 Token 权限后重新运行失败的 Actions Job。

### Missing CLOUDFLARE_KV_NAMESPACE_ID

新增同名 Repository Secret。不要把真实值写回 `wrangler.toml`。

### KV namespace not found

Account ID、API Token 和 KV Namespace 必须属于同一 Cloudflare 账户。

### Webhook 403

重新运行 Actions，或重新调用 Telegram `setWebhook`，确保 URL 为 `/telegram`，并设置与 Worker `WEBHOOK_SECRET` 相同的 `secret_token`。

### 通知进入 DLQ

在 Cloudflare Queues 中检查：

```text
oneui-firmware-notifications-dlq
```

常见原因包括 Telegram Token 失效、Chat ID 无效、Telegram 长时间 429/5xx 或 Worker Secret 丢失。修复后可重新发送失败消息。

### 安全扫描失败

删除日志指出的真实凭据或基础设施 ID。若 Token 曾提交到公开仓库，必须立即撤销并重新生成。


## v2.9.1 调度与 KV 配额保护

发布窗口会使用现有 `MonitorScheduler` Alarm 与通知 Queue 调度亚分钟检查：

```text
WATCH      默认 3 分钟
HOT        默认 1 分钟，持续约 3 分钟
COOLDOWN   默认 3 分钟，持续约 10 分钟
NORMAL     回到 HIGH/NORMAL/LOW/IDLE 或单设备间隔
```

一分钟 Cron 仍作为普通目标调度、Alarm 恢复和健康检查的兜底，但正常路径只在 `MonitorScheduler` Durable Object 中领取分钟槽，不写入 Workers KV。`MONITOR_ALLOW_KV_CRON_FALLBACK` 默认必须保持 `false`，防止 Durable Object 异常时退回每分钟 KV `put()`。暂停的目标不会被 Cron、Alarm 或 `/checknow` 查询。

新增非敏感变量：

```text
ALLOWED_USER_DAILY_MODEL_QUERY_LIMIT = "10"
MONITOR_ALLOW_KV_CRON_FALLBACK = "false"
```

第一个变量控制每位白名单用户每天同一 Model 的查询次数；不同 CSC 共用次数。第二个变量用于保护 KV 免费额度，除非明确接受旧回退路径的写入量，否则不要开启。

## 旗舰联动配置

该功能不需要新增 Secret 或 Cloudflare 资源。部署前检查 `wrangler.toml` 中的：

```text
FLAGSHIP_LINKAGE_ENABLED
FLAGSHIP_LINKAGE_RULES_JSON
```

规则必须使用精确 `source` 与 `previousTargets`。管理员确认前不会修改监控列表。
