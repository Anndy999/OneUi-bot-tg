# v2.3.0 — Priority Monitor and Fast Telegram

v2.3.0 按以下顺序优化：

1. 自动监控发现速度
2. Telegram 交互速度与稳定性
3. 固件查询速度与准确性

## 监控速度

- Cron 每分钟唤醒，但只查询真正到期的目标。
- 默认全天、周末持续监控；每个目标可设置独立间隔与优先级。
- 重点示例目标默认 2 分钟，发布窗口内合法目标可提升为 1 分钟。
- 临时网络失败按 60、120、240 秒指数退避，最长 5 分钟。
- 明确的无效/无固件错误采用较慢退避，避免持续浪费 FUS 请求。
- 到期目标状态读取采用有限并发，并按发布窗口、高优先级、失败次数和逾期时长排序。
- FUS 改为独立的交互 Lane 与两个监控 Lane；监控故障不会打开手动查询熔断器。
- 修复默认目标全部被旧哈希分到同一个 Lane、导致实际串行的问题。
- 同一 Worker 实例中，定时检查与手动 `/checknow` 会共享相同目标的进行中任务，避免重复查询和重复通知。
- 固件查询与 Telegram 通知流水线解耦：先继续检查其他到期目标，再统一等待通知完成。
- 白名单批量通知使用有限并发，慢用户不会逐个串行阻塞监控。
- 发布窗口仍只接受精确 `{model,csc}` 配对，不会生成 `SM-S9380 / EUX` 等错误组合。

## Telegram 交互

- Webhook 解析完 JSON 后立即返回 `200`，所有命令、查询与按钮处理交给 `ctx.waitUntil()`，避免 Telegram 因超时重复投递。
- 缓存未命中时先发送查询占位消息，完成后原地编辑，减少刷屏。
- 近期旧 History 可立即返回，并在后台重新验证后更新同一条消息。
- `/checknow` 和管理员按钮在同一条消息里持续更新进度。
- Callback Query 的确认请求与实际按钮动作并行执行，并在内存中短暂去重，按钮不再等待一次额外 Telegram 往返。
- 长消息自动拆分到 Telegram 限制以内。
- Telegram 429、5xx 和网络错误会进行一次有限重试；发送失败不会消耗提醒次数，下一轮仍可补发。
- “message is not modified” 被视为成功，不再错误地补发重复消息。
- 所有 Telegram API 辅助请求均设置 5 秒超时。

## 固件查询

- SmartHistory 继续作为权威来源；普通查询不会无条件同时请求 XML。
- 明确刷新才启用 XML 验证；History 失败时 XML 作为短期降级结果。
- CSC 选择顺序仍为 Local 精确匹配、Buyer 匹配、Generic；Foreign 记录禁止获胜。Generic 只允许带警告展示，自动监控不会据此初始化或推送。
- 明确 `BINARY_EXIST=0/N/NO/FALSE` 的撤回或不可用记录会被过滤。
- 管理员默认不再强制实时查询；需要实时结果时使用 `/refresh`。
- L1 5 秒、权威新鲜缓存 8 秒；近期 stale History 支持立即返回后后台刷新。XML 或 Generic 降级不会延长旧 History 的过期时间，新的精确 History 成功查询会正常续期。
- 交互查询拥有独立 FUS Session Lane，不会排在监控队列之后。

## 部署与隐私

- `wrangler.toml` 不再包含真实 KV Namespace ID，只提交 32 个零的占位符。
- 新增 GitHub Secret：`CLOUDFLARE_KV_NAMESPACE_ID`。
- Actions 在 Runner 中生成临时部署配置，部署后删除。
- 新增 `npm run security-check`，扫描 Telegram Token、GitHub Token、私钥、环境文件、硬编码敏感变量和真实 KV ID。
- 仓库可以保持 Private，也可以是 Public；Token 始终只能存放在 Secrets 中。

## 测试

当前自动测试覆盖 35 项，包括：

- 严格 CSC、Buyer fallback、Generic 降级和监控拒绝
- Foreign CSC 拒绝
- 撤回 History 记录过滤
- XML 故障降级、Hedge 取消与旧 History 过期保护
- Nonce/Session 复用与过期更新
- FUS Lane 隔离、并发和默认目标分布
- 监控快速重试、优先级与发布窗口
- 重叠监控任务 Single-flight
- Telegram Webhook 快速确认、Callback 并行处理、提醒失败重试、编辑、消息 ID 与长消息拆分
- 全天/跨午夜监控窗口

## 仍未解决的架构边界

Workers KV 是最终一致存储。当前版本已经减少同一实例中的重复任务，但无法从根本上保证全球节点间的原子锁和全球 Single-flight。若监控规模进一步扩大，下一阶段应使用 Durable Objects 作为监控协调器和权威状态层。
