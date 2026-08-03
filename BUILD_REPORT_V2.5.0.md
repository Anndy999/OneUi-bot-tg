# v2.5.0 构建与审计报告

## 范围

- 正式固件数据源：Samsung FUS SmartHistory
- CSC：只接受精确 Local/Buyer 匹配
- 监控：Durable Object 原子领取、手动与 Cron 去重、严格错误退避
- Telegram：Header Secret、update_id 幂等、快速确认
- 部署：真实 KV Namespace ID 仅由 GitHub Secret 临时注入

## 验证

- Node 自动测试：50/50 通过
- 仓库凭据扫描：通过
- Wrangler dry-run：通过
- Worker dry-run 上传体积：242.06 KiB
- gzip：53.67 KiB

## 迁移要求

GitHub Actions Secrets 必须包含：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_KV_NAMESPACE_ID`

Cloudflare Worker Secrets 必须保留：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `WEBHOOK_SECRET`

生产 Webhook 使用 `POST /telegram`，并由 Telegram 请求头 `X-Telegram-Bot-Api-Secret-Token` 验证。
