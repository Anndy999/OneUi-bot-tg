# v2.6.0 — Global Coordination and Reliable Notifications

## 定位

v2.6.0 不增加第二个机器人，也不增加非正式固件查询功能。它强化的是同一个正式固件机器人的跨节点查询去重、监控吞吐与 Telegram 投递可靠性。

## FirmwareQueryCoordinator Durable Object

- 每个精确 `MODEL:CSC` 使用一个全局唯一协调对象。
- 用户查询、管理员刷新和定时监控跨 Cloudflare 节点共享同一个 SmartHistory 上游任务。
- 3 秒微缓存吸收重复点击、Cron 重叠和热门型号突发查询。
- 精确 CSC 永久类错误使用短期持久负缓存，避免多个节点重复请求无效目标。
- 权威 Canonical Cache 由协调对象统一写入。
- 调用方超时不会取消其他调用方共享的上游任务。

## Cloudflare Queue 通知流水线

- Telegram 通知从监控查询关键路径中移出。
- Queue Consumer 使用稳定通知 ID 与 MonitorScheduler 做幂等投递。
- 支持单消息 `ack()`、延迟 `retry()`、最大重试次数和 DLQ。
- Telegram 已发送但 KV 状态更新失败时，重试只补写状态，不重复发送消息。
- 提醒次数仅在发送成功后增加。

## MonitorScheduler 扩展

- 增加通知领取、忙锁、完成和 7 天幂等记录清理。
- 保留 Telegram `update_id` 幂等和监控任务原子领取。

## 部署

- 新增 `FIRMWARE_QUERY_COORDINATOR` SQLite-backed Durable Object migration。
- 新增主通知 Queue 与 Dead Letter Queue。
- GitHub Actions 自动检查并创建 Queue。
- Cloudflare API Token 需要 Queue 管理权限。
- 不新增任何 GitHub Secret；仍使用原有三个部署 Secret。

## 安全

- 未写入任何真实 Telegram Token、Cloudflare Token、Chat ID 或 KV Namespace ID。
- 公开 `wrangler.toml` 继续使用全零 KV 占位符。
