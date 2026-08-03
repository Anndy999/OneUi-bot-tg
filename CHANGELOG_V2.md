# v2.11.1

- Added the monitoring-center layout with status filters for active, paused, awaiting-resume, and failing targets.
- Added a safe bulk-delete workflow with an expiring, typed final confirmation that never blocks ordinary commands or firmware queries.
- Preserved existing unacknowledged-update reminders, automatic timed resume, bilingual UI, build-month fallback, and transient HTTP 521 diagnostic protection.

# v2.10.1

- When Samsung SmartHistory omits `BINARY_OPEN_DATE`, query results and monitor cards now infer only the PDA build month from Samsung's version code, for example `2026-06（月份由版本号推算）`.
- Official SmartHistory dates remain authoritative; the Worker never invents a build day.
- Preserved the v2.10.0 bilingual UI and the current monitor diagnostics threshold, including the protection against one transient SmartHistory HTTP 521 alert.

# v2.10.0

- Added official SmartHistory-driven CSC correction for every syntactically valid Samsung mobile model, including phones, tablets, watches, earbuds and rings.
- When the requested CSC has no exact record, the Worker extracts only still-usable CSC rows returned by Samsung SmartHistory, ranks the two most likely choices, and provides direct-query buttons.
- Added a paginated “more official CSCs” panel with CSC, region, latest PDA and open date.
- Preserved alternative CSC metadata through in-memory negative cache and FirmwareQueryCoordinator Durable Object negative cache.
- Corrected-query buttons reuse the original model attempt without charging the approved-user model quota a second time, while retaining short anti-spam rate limiting.
- Kept strict exact-CSC result selection: foreign rows are suggestions only and can never become the requested firmware result.
- Expanded regression coverage to 107 tests, including the existing bilingual UI and UTF-8 fallback protections.

# v2.9.2

- GitHub Actions 改为 Secrets 优先、Variables 兼容，修复部署文档与工作流读取位置不一致。
- 增加 `SM-X930 CHC → SM-X930 CHN`、`SM-X936C CHN → SM-X936C CHC` 的查询前纠错。
- 增加 Tab S11 Ultra 与 Watch8 系列精确别名，以及 `930`、`936C` 平板短型号解析。
- 保留现有双语界面和编码保护，不修改 SmartHistory、监控调度、Durable Object、Queue、缓存和通知核心行为。

# V2.9.1 - Cron KV Protection, Daily Model Quota and Timed Resume

- Moved per-minute Cron slot ownership completely to MonitorScheduler Durable Object storage on the normal deployment path.
- Disabled legacy KV Cron locking by default; scheduler outages now fail closed and retry on the next Cron tick without consuming Workers KV writes.
- Added a configurable 10-query daily limit per approved user and model, shared across CSCs and reset at Beijing midnight; administrators are exempt.
- Added post-update administrator decisions to continue the original plan or pause monitoring for a preset/custom duration.
- Added automatic timed resume through Durable Object Alarm with an administrator Queue notification.
- Preserved target version, priority score and history while paused, and reset temporary HOT/WATCH state to NORMAL when monitoring resumes.
- Added `/monsnooze MODEL CSC 90m|6h|2d` and expanded regression coverage to 98 tests.

# V2.9.0 - Reliability and Observability

- Migrated frequently-mutated access, flagship and monitor runtime state from Workers KV to MonitorScheduler Durable Object storage with legacy read migration.
- Added structured firmware version records and canonical fingerprints.
- Added persistent performance metrics, administrator performance and diagnostics panels, and deduplicated automatic fault alerts.
- Added an hourly monitoring query budget, concurrency guard, minimum interval and adaptive upstream throttling.
- Migrated the legacy HIGH one-minute default to three minutes without blocking explicit administrator overrides.
- Split monitoring interval/admin observability messages and services into dedicated modules.
- Added 6 new tests; 93/93 tests pass.
- User subscription management and configuration export/import were intentionally not added.

# V2.8.2 - Canonical Firmware Version Display

- Removed the legacy synthetic fourth firmware field that duplicated PDA in normal `PDA/CSC/MODEM` versions.
- Canonicalized query cards, administrator notifications, approved-user broadcasts, baselines, reminders, flagship prompts, and pending-update panels.
- Kept old stored four-part duplicate values backward-compatible so deployment does not create false update notifications.
- Avoided repeating the same fallback Model/CSC name twice in monitor cards.
- Normalized raw Android labels such as `B(Android 16)` to the compact user-facing value `16`.
- Expanded the automated suite from 86 to 87 tests.

# V2.8.1 - Compact Notifications and Configurable Intervals

## Telegram copy

- Reduced query results to the full official version, Android, build date, latency, and simple SmartHistory status.
- Added separate administrator update, approved-user broadcast, baseline, and reminder cards.
- Removed PDA, CSC component, MODEM, decoded-build, and internal cache-layer labels from normal user messages.

## Monitoring and broadcasts

- Enabled approved whitelist-user update broadcasts by default.
- Changed HIGH to a three-minute default and removed automatic WATCH renewal from high scores.
- Added administrator-configurable HIGH/NORMAL/LOW/IDLE/WATCH/HOT/COOLDOWN minute profiles.
- Added global and per-target interval commands and Telegram interval panels.
- Stored interval settings in MonitorScheduler Durable Object Storage and rescheduled targets without high-frequency KV writes.

## Verification

- Expanded the automated test suite from 82 to 86 tests.
- Passed dependency audit, credential scan, and Wrangler dry-run.

# v2.7.3

- 修复切换语言和开关自动监控时因 Workers KV 写入受限而显示“未能确认操作结果”的问题。
- 复用现有 `MonitorScheduler` Durable Object 保存语言和调度状态，旧 KV 数据会自动兼容读取。
- 为固件结果、调度、设备、用户、更新确认和二次确认卡片补齐返回上一级或首页导航。
- 增加 KV 写入完全失败条件下的语言、调度与导航回归测试。
- 自动测试扩展至 70 项。

# v2.7.2

- Telegram Callback Query 改为 1.5 秒快速确认通道，并在状态动作前完成确认。
- 调度、监控设备、自动审批和缓存按钮增加明确的保存成功结果。
- 监控设备添加、删除、暂停、恢复和优先级切换增加可见结果横幅。
- 按钮动作异常时不再只写日志，原消息会显示失败状态与重试入口。
- 新增回调顺序、成功反馈和失败反馈回归测试。

# v2.7.1

- Telegram 公开快捷命令精简为 `/start`、`/apply`、`/whoami`、`/status`。
- `/start` 按未授权、已授权和管理员身份显示不同主菜单。
- 管理员面板拆分为监控、用户权限、待确认更新、系统缓存四个区域。
- 监控设备支持按钮调整优先级、暂停恢复、实时查询和二次确认删除。
- 固件查询结果支持管理员一键加入监控或清理当前目标缓存。
- 自动审批、调度、周末监控和缓存设置改为状态化按钮。
- 授权用户支持按钮移除，全部缓存清理需要二次确认。
- 旧命令继续兼容但不再占用公开菜单；帮助文案改为按身份展示的简明说明。
- 自动测试扩展至 67 项。

# v2.7.0

- 新增最新直板旗舰更新后的管理员确认流程。
- 确认后自动添加上一代对应 CSC + TGY，并设为 high。
- 上一代发现更新后可恢复 normal、继续 high 或暂停保留配置。
- 新增 `/high` 高优先级管理面板。
- 新增 `/monitempause` 与 `/monitemresume`。
- 暂停设备不会进入调度器或手动 `/checknow`。
- 旗舰联动规则仅接受精确 Model/CSC，禁止笛卡尔组合。
- 自动测试增至 63 项。

# v2.6.0

- 新增每个 `MODEL:CSC` 一个 FirmwareQueryCoordinator Durable Object，实现跨 Cloudflare 节点 Single-flight。
- 用户查询、管理员刷新与定时监控共享同一上游 SmartHistory 请求。
- 新增 3 秒微缓存与持久精确错误负缓存，减少热门目标和无效目标的重复请求。
- 权威 Canonical Cache 改由查询协调对象统一写入，降低跨节点写覆盖风险。
- Telegram 通知迁移到 Cloudflare Queue，监控不再等待 Telegram API。
- 新增通知幂等领取、延迟重试、最大重试和 Dead Letter Queue。
- 修复 Telegram 已发送但 KV 后处理失败时重试重复发消息的问题。
- GitHub Actions 自动检查并创建通知 Queue 与 DLQ。
- 自动测试扩展至 57 项。

# v2.5.0

- 正式查询改为 SmartHistory-only，只接受精确 Local/Buyer CSC。
- 删除非正式固件发现相关的产品入口与监控评分信号。
- 删除旧 FOTA 元数据的验证与降级链路。
- 修复永久错误退避被动态间隔提前覆盖。
- Durable Object 缩小领取批次、延长锁，并为手动检查提供原子领取。
- 长期无更新设备自动降频；发布窗口仍只使用精确合法配对。
- Telegram Webhook 改为 `/telegram` + Secret Header，并增加 update_id 幂等。
- 公开配置使用全零 KV ID，真实 Namespace ID 由 GitHub Secret 临时注入。
- 增加未来公开日期拦截，避免尚未到公开日的高 Sequence 记录成为正式最新版。
- 自动测试扩展至 50 项。

# v2.3.0

- 监控改为每分钟调度、按目标到期时间与优先级执行，并使用独立 FUS Lane。
- 修复默认监控目标哈希碰撞导致的伪并发。
- 查询与通知流水线解耦，重叠监控共享查询与单次通知。
- XML 和 Generic History 不得触发监控更新；Generic 仅带警告展示。
- XML 降级不能延长旧 History 过期时间；精确 History 成功刷新可正常续期。
- 快速 History 会取消尚未开始的 XML Hedge，减少三星上游请求。
- Telegram Webhook 立即确认，Callback 确认与动作并行。
- Telegram 发送失败不消耗提醒次数；长消息、重试和编辑行为更稳健。
- 清理不再生效的旧 user/global 缓存命令，避免管理员误判。
- GitHub Actions 增加凭据扫描，KV Namespace ID 改为 Secret 注入。
- 自动测试扩展到 35 项。


# V2.2.1 - Safe Release Window

## Monitoring correctness

- Added exact-pair release-window groups; model and CSC arrays can no longer be combined as a Cartesian product.
- Added explicit regression coverage proving `SM-S938B / EUX` can boost configured `SM-S9380 / CHC`, `TGY`, and `BRI` peers without ever creating `SM-S9380 / EUX`.
- Release acceleration only applies to exact peers already present in the monitor list; it never creates a new monitor item automatically.

## Monitoring speed

- Changed Cron wake-up to every minute.
- Added per-target last-check timestamps, so normal targets retain the configured interval while boosted targets can run every minute.
- Added a configurable 120-minute release window that automatically expires through Workers KV TTL.

## Tests

- Expanded the test suite from 8 to 13 tests.

# V2.2.0 - Strict CSC and Faster History

## Correctness

- Fixed a critical cross-CSC selection bug: a higher `BINARY_SEQUENCE` from another region can no longer override the requested CSC.
- Selection order is now exact local CSC, buyer CSC, generic row; foreign-only rows are rejected.
- Preserved SmartHistory metadata through the hybrid result wrapper, including sequence, open date, returned CSC and match type.

## Reliability and speed

- Added a configurable FUS Session TTL and automatic nonce renewal.
- Serialized mutable FUS session operations inside each Worker isolate to prevent concurrent nonce/cookie races.
- Added a local circuit breaker to stop repeated FUS failures during cooldown and allow fast XML/stale fallback.
- Increased the initial XML hedge delay to 800 ms and made it adapt to recent History latency.
- Reduced hot cache freshness to 5-second L1 and 8-second canonical cache; administrator real-time queries now bypass cache by default.
- Added 5-minute monitoring support and made it the production default.
- Preserved original History/XML fetch timestamps instead of making stale data appear newly fetched.

## Tests and documentation

- Expanded the test suite from 3 to 8 tests.
- Added private-repository GitHub Actions guidance and a v2.2 deployment verification checklist.
- Added `RELEASE_V2.2.0.md` as the current release and operations document.

# V2.1.0 - GitHub Continuous Deployment

## Deployment automation

- Added GitHub Actions deployment on every push to `main` or `master`.
- Added locked dependency installation, tests, and Cloudflare dry deploy compatibility.
- Added required GitHub Actions Secrets validation before deployment.
- Added automatic synchronization of Telegram values to Cloudflare Worker Secrets.
- Added optional Telegram Webhook configuration and `/health` verification through `WORKER_URL`.
- Added deployment concurrency control so an older run cannot overwrite a newer commit.

## Documentation and safety

- Added a dedicated GitHub deployment guide.
- Added ignore rules for local secrets, dependencies, Wrangler state, logs, and coverage.
- No credentials are stored in the repository or release archive.

# V2.0.0 - History Authoritative Query

## Query correctness

- Samsung FUS SmartHistory is now the authoritative firmware source.
- `version.xml` can verify History or provide a short-lived degraded fallback, but cannot win merely because it returns faster.
- SmartHistory was sequence-first in v2.0; v2.2 supersedes this behavior with strict CSC-first selection to prevent cross-region false positives.
- XML `Error` and `AccessDenied` payloads are recognized explicitly.

## Performance

- Added module-memory LRU caching for hot Model / CSC pairs.
- Added one canonical KV cache entry per normalized Model / CSC.
- Added Single-flight deduplication for concurrent identical queries.
- Cache writes and XML verification run through `ctx.waitUntil()` when available.
- Added FUS nonce generation deduplication and session reuse until a 401 response.
- Added structured firmware query timing logs.

## Output

- Added Country / Region based on a local CSC map.
- Added Build Date from `BINARY_OPEN_DATE` when History provides it.
- Added degraded and XML-conflict status to query responses.

## Reliability

- Added bounded Telegram API timeout and one retry for 429 / 5xx / network failures.
- Added stale History fallback when Samsung is temporarily unavailable.
- Added tests for History authority, XML degradation, CSC sequence selection, and concurrent nonce reuse.
