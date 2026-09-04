# OneUI Firmware Bot v2.22.7

## Notification Safety / 通知安全

This release intentionally freezes Samsung query, download, decryption, and rollout-stage semantics. It changes only update-notification safety and presentation.

本版本刻意冻结 Samsung 查询、下载、解密和发布链核心语义，仅修改新版通知安全与展示体验。

### 1. Latest-snapshot-only monitoring / 只通知当前最新快照

- SmartHistory remains the only automatic-monitoring source.
- Every monitor check still bypasses old query caches and requests Samsung SmartHistory in realtime.
- `BINARY_SEQUENCE` is treated as a monotonic release cursor when both the saved baseline and the new response contain it.
- An older sequence is treated as a stale Samsung replica snapshot: it is ignored, the saved baseline is not downgraded, the global query cache is not overwritten, and no Telegram notification is sent.
- A higher sequence with an identical firmware fingerprint is treated as metadata churn, not a new firmware release.
- Installations that already have a firmware baseline but no saved sequence silently attach the current Samsung sequence once. This migration cannot replay historical firmware as a fresh update.
- SmartHistory history rows are never replayed one-by-one. The monitor continues to act only on the single latest row selected by the Samsung/Bifrost-style parser.

- 自动监控仍然只使用 SmartHistory。
- 每轮自动监控继续强制绕过旧查询缓存并实时请求 Samsung SmartHistory。
- 当已保存基线与新响应都包含 `BINARY_SEQUENCE` 时，将其作为单调递增的发布游标。
- 如果三星临时返回更小的 sequence，视为服务器副本同步中的旧快照：不降低基线、不覆盖全局查询缓存、不发送 Telegram 通知。
- sequence 增加但固件指纹完全相同，仅视为元数据变化，不当作新固件通知。
- 老安装如果已有固件基线但还没有 sequence，会先静默绑定当前 Samsung sequence 一次，避免升级后补发历史固件。
- SmartHistory 中的历史记录不会逐条回放，监控只处理 Bifrost 风格解析得到的唯一当前最新记录。

### 2. S25/S26 multi-model notification batching / S25/S26 多机型合并通知

- S25 and S26 updates from the same CSC are buffered for a short 20-second window.
- Multiple model updates in that window are sent as one Telegram card per recipient.
- Chinese and English cards are both implemented.
- If durable batching is unavailable, the bot falls back to the existing one-model notification path rather than dropping updates.
- Delivery remains idempotent. A retry cannot intentionally create a second user-visible delivery for the same batch.

- 同一 CSC 的 S25/S26 更新会短暂等待 20 秒进行合并。
- 同一窗口内的多台机型只向每位接收者发送一条 Telegram 消息。
- 中文与英文文案同步支持。
- 如果持久化合并机制不可用，会自动退回原有单机型通知路径，不会因为合并失败而丢通知。
- 保留通知幂等机制，重试不会故意重复发送同一批次。

### Unchanged / 未修改

- Samsung FUS SmartHistory query/authentication logic
- `version.xml` manual-query fallback policy
- automatic monitoring source policy (SmartHistory only)
- rollout stage progression rules
- firmware download / BinaryInform / BinaryInit
- decryption and file handling
- user permissions and query limits

