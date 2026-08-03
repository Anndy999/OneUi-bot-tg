# Build Report — v2.9.1

## 构建范围

- Cron 分钟槽从 Workers KV 迁移到 MonitorScheduler Durable Object。
- Durable Object 异常时默认禁止 KV Cron 回退。
- 白名单用户按 Model 的每日 10 次查询额度。
- 更新后继续原计划或定时暂停/自动恢复。
- 自动恢复后清除 HOT/WATCH 临时状态并保留正式版本与智能评分。

## 验证结果

```text
版本：2.9.1
JavaScript 语法检查：通过
自动测试：98 / 98 通过
生产依赖漏洞：0
凭据安全扫描：57 个文件通过
Wrangler：4.107.0
wrangler deploy --dry-run：通过
Worker 上传体积：417.27 KiB
gzip：90.18 KiB
```

## 关键回归测试

- 同一分钟 Cron 只能在 Durable Object 中领取一次，不产生 KV 写入。
- Durable Object 调度器不可用时，本轮 Cron 安全跳过且 KV 读写均为 0。
- 未显式启用旧回退时，无 Durable Object 绑定也不会创建 KV Cron 锁。
- 同一白名单用户对同一 Model 的前 10 次查询允许，第 11 次拒绝。
- 新日期自动重置额度；其他 Model 使用独立额度。
- 定时暂停保留 `lastVersion` 与 `priorityScore`。
- 自动恢复将监控模式重置为 `NORMAL`，重新安排原计划，并只向管理员发送一次 Queue 通知。
- 现有精确 CSC、History-only、通知幂等、旗舰联动和 KV 配额退避测试全部继续通过。

## KV 写入影响

正常部署且 `MONITOR_SCHEDULER` 可用时：

```text
每分钟 Cron 运行标记：0 KV put
每分钟 Cron 锁：0 KV put
白名单查询额度计数：0 KV put
定时暂停状态：0 KV put
自动恢复状态：0 KV put
```

项目仍会在固件正式版本变化、待确认更新、低频镜像或兼容回退等场景使用 KV；本版目标不是完全移除 KV，而是清除固定每分钟写入。

## 已知运行条件

- 自动恢复依赖 `MONITOR_SCHEDULER` Durable Object Alarm。
- 自动恢复通知依赖 `NOTIFICATION_QUEUE` 与管理员 `TELEGRAM_CHAT_ID`。
- `MONITOR_ALLOW_KV_CRON_FALLBACK` 默认应保持 `false`；开启后旧路径仍可能产生每分钟 KV 写入。
- 查询额度按已接受的查询请求计数，缓存命中和上游失败也会占用一次，防止通过无效请求绕过资源保护。

## 安全结论

未提交或打包以下内容：

```text
TELEGRAM_BOT_TOKEN
WEBHOOK_SECRET
CLOUDFLARE_API_TOKEN
真实 Cloudflare Account ID
真实 KV Namespace ID
.env
.dev.vars
node_modules
.wrangler
```
