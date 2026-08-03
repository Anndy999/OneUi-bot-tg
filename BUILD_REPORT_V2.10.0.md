# Build Report v2.10.0

生成日期：2026-07-14

## 代码变更

- `src/fus.js`
  - 拆分 SmartHistory 行解析。
  - 在精确 CSC 缺失时附带三星官方返回的可用 CSC 候选。
- `src/csc-suggestions.js`
  - 新增官方候选归一化、去重、地区排序、短期内存缓存与显示标签。
- `src/firmware-query-coordinator.js`
  - Durable Object 的实时错误响应和负缓存均保留 `officialCscOptions`。
- `src/cache.js`
  - 本地负缓存改为结构化错误，避免重复查询时丢失 CSC 建议。
- `src/index.js`
  - 新增最可能两个 CSC、直接查询、查看更多和分页回调。
  - 修正后的 CSC 查询不重复扣除同一次 Model 日额度。
  - 应用版本升级到 `2.10.0`。
- `src/csc.js`
  - 补充常见美国、韩国、日本运营商 CSC 的地区名称。

## 保持不变

- Samsung FUS SmartHistory History-only 数据源。
- 精确 Local/Buyer CSC 的正式结果要求。
- MonitorScheduler 与 FirmwareQueryCoordinator Durable Object 类和 Migration。
- Notification Queue、DLQ、通知幂等和自动重试。
- Cron、KV 配额保护、监控目标与定时恢复。
- GitHub Secrets 优先、Variables 兼容部署方式。
- 现有中英文管理员界面和 SmartHistory Android 缺失值编码保护。

## 自动验证

- Node.js 自动测试：107/107 通过。
- JavaScript 语法检查：通过。
- 安全扫描：62 个文件，未发现提交的凭据。
- GitHub Actions 部署链路：以最终 CI 结果为准。
- 压缩包完整性与 SHA-256：通过。

## 已知边界

三星没有公开一个可一次性枚举所有移动设备 Model/CSC 的官方目录。本功能以每次 SmartHistory 返回的官方记录为依据，因此能对任意合法型号的错误 CSC 提供官方候选；对于完全拼错、且三星接口不返回任何关联记录的 Model，不进行猜测式纠正。
