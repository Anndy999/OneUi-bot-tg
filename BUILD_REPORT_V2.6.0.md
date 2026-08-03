# v2.6.0 构建与审计报告

## 范围

- 正式固件数据源：Samsung FUS SmartHistory
- CSC：只接受精确 Local/Buyer 匹配
- 查询：每目标 Durable Object 跨节点 Single-flight 与统一权威缓存写入
- 监控：MonitorScheduler 原子领取、手动与 Cron 去重、严格错误退避
- Telegram：Cloudflare Queue、通知幂等、延迟重试、DLQ
- 部署：真实 KV Namespace ID 仅由 GitHub Secret 临时注入

## 回归验证

- Node 自动测试：57/57 通过
- 仓库凭据扫描：通过
- JavaScript 语法检查：通过
- Wrangler dry-run：通过
- Worker dry-run 上传体积：258.34 KiB
- gzip：57.01 KiB

## 新增测试覆盖

- 跨调用方共享一次全局 History 查询
- 查询协调器 3 秒微缓存
- 精确错误持久负缓存跨对象重启生效
- 协调器统一写入 Canonical Cache
- Queue 生产者不阻塞 Telegram API
- Queue Consumer 成功 ack
- 通知 ID 幂等
- Telegram 已发送、KV 后处理失败时不重复发送

## 迁移要求

GitHub Actions Secrets 保持：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_KV_NAMESPACE_ID`

Cloudflare Worker Secrets 保持：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `WEBHOOK_SECRET`

Cloudflare API Token 需要增加 Queue 创建/管理权限。第一次部署会创建：

- `oneui-firmware-notifications`
- `oneui-firmware-notifications-dlq`
