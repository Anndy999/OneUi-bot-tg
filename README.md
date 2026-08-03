# OneUI Firmware Worker v2.13.4

基于 Cloudflare Workers 与 Telegram 的三星正式固件查询、智能监控和通知机器人。

## v2.13.4: UTF-8 audit and help reliability

- Audited all source, test, configuration, script, and documentation files with strict UTF-8 decoding. No invalid UTF-8, replacement characters, or common mojibake markers remain.
- Fixed administrator help so Telegram receives newline-formatted strings instead of nested arrays that could render with commas.
- `/adminhelp`, the administrator Help button, and monitoring interval validation now follow the administrator's saved Chinese or English language.
- Removed unreachable duplicate help and Telegram command-registration blocks, and added bilingual regression coverage.

## v2.13.3: Monitor interval help

- The administrator quick guide and /adminhelp now explain /moninterval 15, its 1-1440 minute range, and its default-target-only behavior.

## v2.13.2: Simplified monitoring interval control

- The **Monitoring interval** page now contains one owner-controlled setting instead of HIGH/NORMAL/LOW/WATCH/HOT/COOLDOWN presets.
- Send `/moninterval 15` to apply one 15-minute cadence to all default monitor targets. Any existing per-target override remains unchanged.
- Valid values are 1-1440 minutes. Legacy callbacks remain compatible for already-sent Telegram messages but are no longer shown in the current UI.
- The administrator command help also documents that `/moninterval 15` sets the default monitoring interval and does not overwrite per-device overrides.

## v2.13.1: Administrator-controlled daily summary

- Daily monitoring summaries can now be enabled or disabled by the owner from `/admin` → **Monitoring** → **Schedule**. The button always shows the next action, and the selected state persists in `MonitorScheduler` across Worker restarts and deployments.
- The toggle affects only the once-daily owner summary. Automatic monitoring, immediate new-firmware notices, Samsung source health, and user update delivery remain unchanged.
- The summary hour remains the existing `DAILY_MONITOR_SUMMARY_HOUR` Beijing-Time setting, defaulting to 21:00.

## v2.13.0: Monitor observability and daily summary

- The monitoring center now includes **Recent events**. It retains only the latest 50 meaningful events: version detected, Samsung source failure, recovery, and confirmed Telegram delivery. Unchanged polling runs are not stored.
- **Monitor health** now labels Samsung source state as healthy, retrying, needs attention, or model/CSC configuration issue, with a bounded 0-100 score. A transient HTTP 521 remains retryable; it is not presented as a permanent firmware error.
- A concise daily monitoring summary is sent to the owner at 21:00 Beijing Time by default. It is atomically claimed in `MonitorScheduler`, so duplicate Cron invocations cannot send it twice. Set `DAILY_MONITOR_SUMMARY_ENABLED=false` to disable it, or set `DAILY_MONITOR_SUMMARY_HOUR` to a Beijing hour from 0 to 23.
- Existing official CSC candidate correction remains enabled: invalid or unavailable CSC input returns only candidates extracted from Samsung SmartHistory, never a mismatched region as a firmware result.
- No configuration export/import and no administrator audit trail were added. The Worker remains a firmware-query and monitoring tool without download functionality.

## v2.12.0: Monitor operations cleanup

- Firmware updates remain one-shot notifications. The retired `/ack` and `/pending` interaction is no longer available to users or administrators.
- Added **Monitor health** in the admin monitoring center. It shows per-target last success, next check, consecutive failures, retry status, and the latest FUS error when applicable.
- Each monitored device now has its own **Allowed-user update** switch. Turn it off for a target when only the owner should receive that target's update message.
- Existing monitor targets keep allowed-user delivery enabled by default, preserving the current broadcast behavior until the owner changes a target.
- The GitHub Actions deployment now runs on Node.js 24 and publishes the compact Telegram command menu only once.

## v2.11.1: Monitoring center layout, safely merged

- Added a compact monitoring center with Active, Paused, Awaiting resume, and Failing filters.
- Monitoring targets remain directly actionable from the filtered list.
- Added a guarded bulk-delete flow: button confirmation plus a 10-minute typed final confirmation. Any unrelated command or model query cancels the pending delete and continues normally.
- Kept the established monitor behavior intact: timed snoozes resume automatically, bilingual rendering remains enabled, missing build dates retain the safe month fallback, and one transient SmartHistory HTTP 521 does not cause a diagnostic alert.

本项目仍然只有**一个 Telegram 机器人和一个 Worker 项目**。Durable Object 与 Queue 只是同一项目内部的协调与可靠投递组件。

## v2.10.1：缺失构建日期的安全推算

- Samsung SmartHistory 有时不会提供 `BINARY_OPEN_DATE`，特别是在部分手表、耳机和戒指记录中；现在会从标准 PDA 版本号推算构建的年和月。
- 例如 `L500XXS2AZF4` 会显示 `2026-06（月份由版本号推算）`；英文界面对应显示 `2026-06 (month inferred from firmware version)`。
- 只推算 `YYYY-MM`，不会虚构具体日号。只要三星给出官方日期，官方日期始终优先。
- 手动查询与自动监控通知统一使用这套显示规则，不改变 SmartHistory 数据源、调度、KV、Durable Object 或通知去重逻辑。



## v2.10.0：三星官方 CSC 智能纠错

- 当输入的 Model 合法、但 CSC 与三星官方 SmartHistory 记录不匹配时，不再只返回“无记录”。
- 直接从本次三星官方 SmartHistory 响应中提取该型号仍有可用固件历史的 CSC；不使用第三方固件库，也不把未经官方响应验证的候选展示给用户。
- 按“用户输入地区相似度 + 当前语言/地区优先级 + 型号地区特征 + 官方记录新鲜度”排序，默认展示最可能的两个 CSC。
- 每个建议都显示 CSC、地区、最新 PDA 和公开日期，可点击按钮直接查询；存在更多候选时提供“查看更多官方 CSC”分页。
- 手机、平板、手表、耳机和戒指统一使用同一套机制，不再只针对某几个平板型号写死。
- CSC 建议会在内存中短暂缓存；“查看更多”在缓存失效后会重新向三星官方 SmartHistory 核验，不新增 KV 高频写入。
- 仍然坚持精确 CSC：其他地区的固件只用于纠错建议，不会被当作用户所请求 CSC 的正式结果。

## v2.9.2：稳定性收尾与设备输入纠错

- GitHub Actions 优先读取 Repository Secrets，并兼容现有同名 Variables，避免部署文档与工作流不一致。
- `SM-X930 CHC` 会在访问三星服务器前提示改用 `SM-X930 CHN`，避免错误组合长时间停留在查询占位状态。
- 新增 Tab S11 Ultra 与 Watch8 系列的精确别名，同时保留现有双语界面、SmartHistory、监控调度、Queue 和 Durable Object 核心链路。

## v2.9.1：KV 配额保护、白名单日限额与更新后定时恢复

- 每分钟 Cron 只负责唤醒调度器、领取当前分钟槽位并检查哪些目标到期；正常路径不再为 `monitor:run` 或 Cron 锁写入 Workers KV。
- `MonitorScheduler` Durable Object 不可用时默认停止本轮 Cron 并等待下一分钟重试，避免自动退回到每分钟 KV `put()`。旧 KV Cron 回退只有显式设置 `MONITOR_ALLOW_KV_CRON_FALLBACK = "true"` 才会启用。
- 白名单用户按“用户 + 北京日期 + Model”计数，同一型号每天最多查询 10 次；不同 CSC 共用次数，管理员不受此限制。默认值可用 `ALLOWED_USER_DAILY_MODEL_QUERY_LIMIT` 调整。
- 第 1～10 次查询正常执行，第 11 次开始返回“今日查询次数已达上限”，并在北京时间次日 00:00 自动重置。
- 每个监控目标发现正式新版本并通知管理员后，可选择“按原计划继续”或“稍后恢复”。
- “稍后恢复”提供 1/3/6/12 小时、1/3/7 天预设，也支持 `/monsnooze MODEL CSC 90m|6h|2d`，范围为 30 分钟至 30 天。
- 暂停期间保留 Model/CSC、优先级、上次正式版本、评分和历史状态；到期后自动恢复 NORMAL 原计划，并通过通知 Queue 告知管理员。
- 自动恢复不会继续沿用发现更新时的 HOT 临时窗口，也不会删除监控配置。

### Cron 的职责

Cron 每分钟唤醒一次并不等于每分钟查询所有设备。它只做三件事：

1. 向 Durable Object 领取当前分钟的唯一执行槽，防止重复运行。
2. 读取调度器中已经到期的目标，未到期设备不查询 Samsung。
3. 触发更新通知、诊断与故障恢复等轻量任务。

设备真正的查询频率仍由 HIGH/NORMAL/LOW/IDLE、单设备覆盖、WATCH/HOT/COOLDOWN 和全局查询预算共同决定。

## v2.9.0：可靠性、性能中心与查询预算

- `allowed:users`、访问申请、自动审批、旗舰提案、监控运行状态与发布加速状态迁移到 `MonitorScheduler` Durable Object；KV 只保留旧数据兼容读取和低频固件缓存镜像。
- 固件版本新增结构化记录：`components`、`pda`、`cscVersion`、`modem`、`extras`、`canonical` 与 `fingerprint`，显示层继续只展示完整规范版本。
- 新增管理员“性能中心”和 `/metrics`：持久化最近 24 小时查询量、成功率、缓存命中率、Single-flight 合并率、P50/P95/P99、监控更新与失败。
- 新增管理员“系统诊断”和 `/diagnostics`：显示超时目标、连续失败、KV 镜像积压、绑定状态、Alarm 与查询预算。
- 新增主动异常告警；同一故障签名一小时内只提醒一次，避免刷屏。
- 新增全局监控查询预算与自适应限速：默认每小时 300 次、最多 3 个后台监控并发、单目标最小间隔 60 秒。遇到 403、429、5xx、超时或网络错误会自动扩大间隔，连续恢复后逐步回落。
- 旧版本遗留的 `HIGH=1 分钟` 默认配置会一次性迁移为 3 分钟；管理员明确设置的 1 分钟仍然有效。
- Telegram 管理文案进一步模块化到 `src/messages/`，性能与诊断逻辑拆到 `src/services/`。
- 未加入按用户订阅管理，也未加入配置导出/导入，保持当前广播与配置方式不变。

### WATCH、HOT 与 COOLDOWN

- `WATCH 发布信号观察`：目标本身尚未确认更新，但同系列、旗舰联动或其他明确发布信号出现后，临时提高检查频率。默认每 3 分钟，最长持续 2 小时。
- `HOT 更新确认窗口`：目标已经发现正式版本变化后进入，用于快速复核、跟踪其他地区同步和防止短时间上游数据波动。默认每 1 分钟，持续 3 分钟。
- `COOLDOWN 降频观察`：HOT 结束后的缓冲阶段，默认每 3 分钟，持续 10 分钟，然后回到 HIGH/NORMAL/LOW/IDLE。

## v2.8.2：修复固件版本重复显示

- 修复查询卡片将三段正式版本错误扩展成 `PDA/CSC/MODEM/PDA` 的问题。
- 现在只移除历史版本中由机器人合成的重复第四段，不会再人为补齐或复制版本字段。
- 查询结果、管理员更新通知、白名单广播和首次监控基线统一使用规范版本。
- 旧 KV、Durable Object 或待确认记录中的四段重复值会在显示和指纹比较时自动兼容为三段，不会误报成一次新固件更新。
- 监控通知不再在缺少友好设备名称时重复显示两遍相同的 Model/CSC。
- `B(Android 16)` 这类上游原始值会在用户文案中规范显示为 `Android：16`。
- 正式固件仍然只来自精确 CSC 的 Samsung SmartHistory。

## v2.8.1：精简文案与可配置监控强度

- 固件查询主卡片只保留精确 Model/CSC、完整正式版本、Android、构建日期、耗时和 SmartHistory 状态。
- 普通用户不再看到 PDA、CSC 组件、MODEM、版本解析或内部缓存层名称。
- 管理员更新卡片、白名单广播、首次监控基线和未确认提醒使用不同文案。
- 发现正式新固件后默认同步通知全部已授权白名单用户；管理员仍单独收到确认与管理按钮。
- HIGH 默认改为 3 分钟；WATCH 不再因高评分自动长期触发，只由明确发布信号触发。
- 管理员可分别设置 HIGH、NORMAL、LOW、IDLE、WATCH、HOT、COOLDOWN 的分钟间隔。
- 支持 `/intervals`、`/interval high 3` 与 `/interval SM-S9480 TGY 5`；单设备设置优先于全局强度。
- 监控间隔保存在 `MonitorScheduler` Durable Object，不消耗 KV 高频写入；修改后立即重新安排未执行目标。

默认间隔：

```text
HIGH      3 分钟
NORMAL   10 分钟
LOW      30 分钟
IDLE     60 分钟
WATCH     3 分钟
HOT       1 分钟
COOLDOWN  3 分钟
```

## v2.8.0：快速查询与亚分钟发布窗口

- 普通文本统一支持 `9480 tgy`、`s9480 tgy`、`SM-S9480 TGY`、`SM-S9480/TGY` 与 `SM-S9480:TGY`；v2.9.2 另支持 `930 CHN`、`tab11u wifi CHN`、`tab11u 5g CHC`、`watch8 44 CHC` 等精确别名。
- 缺少 CSC 或无法识别时明确返回格式提示，不再静默丢弃消息。
- 查询限流、查询热度和监控列表以 `MonitorScheduler` Durable Object 为权威状态，KV 写额度耗尽不会阻断查询或 `/add`。
- 监控项新增、更新和删除在 Durable Object 内原子合并；并发管理操作不会互相覆盖。
- SmartHistory 立即启动；仅当查询超过约 300ms 时才显示 Telegram 占位消息。
- Query Coordinator 增加 DO Storage 短缓存，并只在固件指纹变化时异步镜像 KV。
- KV 镜像遇到每日配额限制后进入退避，同一固件不会因连续刷新重复尝试写入。
- 动态热门目标取代写死型号，管理员 high、旗舰联动和近期查询都可预热内存缓存。
- FUS Lane 按队列、延迟、Session 和错误状态自适应选择，同时保留同目标亲和与服务等级隔离。
- 发布窗口增加 `WATCH → HOT → COOLDOWN → NORMAL` Alarm 状态机；v2.8.1 起默认使用 3、1、3 分钟，并可由管理员分别设置。
- Alarm 与 Queue 使用严格 Lock Token；重复或过期任务会在访问 Samsung 前被拒绝。
- 通知 Queue 的批处理等待降为 Wrangler 支持的 0 秒，仍保留重试、DLQ 和通知幂等。
- 查询日志拆分 Lane 排队、Session、Nonce、SmartHistory 和解析耗时，并滚动输出 P50/P95/P99 汇总。
- 仍然只查询精确 CSC 的正式 SmartHistory，不使用 `version.xml`，不查询测试或内部固件。

## v2.7.3：交互状态可靠保存与完整导航

- 语言与自动监控规则由现有 `MonitorScheduler` Durable Object 可靠保存，KV 保留兼容读取与回退。
- 修复 Workers KV 写入受限时切换语言、暂停或恢复自动监控进入失败页的问题。
- 固件结果和全部二级、三级管理面板增加返回上一级或返回首页按钮。
- 不新增 Worker、仓库、Secret 或 Telegram Inline Query，查询与监控核心逻辑不变。

## v2.7.2：按钮结果即时反馈

- Telegram 收到按钮操作后先快速结束加载状态，再执行 KV 或查询动作。
- 调度、监控设备、用户权限和缓存按钮会明确显示“设置已保存”及最终状态。
- 按钮操作异常时会直接显示失败界面，并提供重试和返回主菜单按钮。
- Webhook 仍快速返回 HTTP 200，固件查询与监控核心逻辑保持不变。

## v2.7.1：精简按钮交互

- `/start` 根据用户权限显示对应主菜单。
- 公开快捷命令精简为 4 个，旧命令继续兼容。
- 管理员通过分层按钮管理监控、用户、更新确认、调度和缓存。
- 设备删除、用户移除和全部缓存清理提供二次确认。
- 固件查询和监控核心逻辑保持不变。

## 查询原则

- **Samsung FUS SmartHistory 是唯一实时权威数据源。**
- 只接受请求 Model/CSC 的精确 `BINARY_LOCAL_CODE` 或 `BINARY_BUYER_CODE`。
- 其他 CSC 的更高 Sequence 不得覆盖目标 CSC。
- Generic、未来公开日期、撤回记录和 XML 结果都不能成为正式最新版。
- SmartHistory 临时失败时，只能返回仍在有效期内的最后一次精确 History 缓存。
- 不提供测试、内测或工程固件查询。

## v2.7.0：旗舰优先级生命周期

当配置中的最新直板旗舰发现正式更新时，机器人会先正常发送固件更新，再向管理员发送确认卡片：

```text
最新旗舰正式更新
        ↓
询问管理员是否提升上一代直板旗舰
        ↓
管理员确认
        ↓
上一代“对应 CSC + TGY”自动加入监控
        ↓
优先级设为 high
```

机器人**不会自动生成 Model × CSC 组合**。所有来源型号和上一代目标都必须在 `FLAGSHIP_LINKAGE_RULES_JSON` 中逐条精确配置。

上一代联动设备自身发现正式更新后，管理员会看到：

```text
[恢复普通优先级]
[继续高优先级]
[暂停监控]
```

规则：

- 选择“继续高优先级”后，下次发现更新仍会再次询问。
- 选择“恢复普通优先级”后继续监控，但恢复 `normal`。
- 选择“暂停监控”后不删除配置，仅从调度器移除；之后可以恢复。
- 最新旗舰每次出现新的正式版本，都会重新询问管理员。

## 高优先级管理界面

管理员菜单新增 **高优先级** 面板，也可直接发送：

```text
/high
```

面板会显示：

- 当前所有 high 设备。
- 是否正在监控或已暂停。
- 旗舰联动来源。
- 恢复普通优先级按钮。
- 暂停或恢复单个目标按钮。

新增命令：

```text
/monitempause 9380 EUX
/monitemresume 9380 EUX
```

暂停单个设备不会删除历史、名称、关联关系或优先级记录。

## 核心架构

```text
Telegram / Cron / 管理员查询
            │
            ▼
    Cloudflare Worker
            │
            ├── MonitorScheduler Durable Object
            │     ├── 到期任务原子领取
            │     ├── Cron 与 /checknow 去重
            │     ├── Telegram update_id 幂等
            │     └── 通知投递幂等
            │
            ├── FirmwareQueryCoordinator Durable Object
            │     ├── 每个 MODEL:CSC 一个全局协调对象
            │     ├── 跨节点 Single-flight
            │     ├── 3 秒微缓存
            │     └── 权威缓存统一写入
            │
            └── Notification Queue
                  ├── Telegram 发送与查询解耦
                  ├── 延迟重试
                  ├── 防重复通知
                  └── 超限进入 DLQ
```

## 旗舰联动配置

示例：当前欧版旗舰更新后，管理员确认才会添加上一代欧版与 TGY：

```json
[
  {
    "id": "s26-ultra-eux-to-s25-ultra",
    "name": "S26 Ultra EUX → S25 Ultra",
    "source": {
      "model": "SM-S948B",
      "csc": "EUX",
      "name": "S26 Ultra 欧版"
    },
    "previousTargets": [
      {
        "model": "SM-S938B",
        "csc": "EUX",
        "name": "S25 Ultra 欧版"
      },
      {
        "model": "SM-S9380",
        "csc": "TGY",
        "name": "S25 Ultra 港版"
      }
    ]
  }
]
```

配置变量：

```toml
FLAGSHIP_LINKAGE_ENABLED = "true"
FLAGSHIP_LINKAGE_RULES_JSON = '''
[ ...exact rules... ]
'''
```

安全约束：

- `source` 必须是精确 Model/CSC。
- `previousTargets` 必须逐条列出。
- 禁止 `models`、`cscs` 数组与笛卡尔组合。
- 管理员确认前不会自动新增或提升任何设备。

## 智能调度

Cron 每分钟唤醒，但仅查询真正到期且 `enabled=true` 的目标。

默认强度映射：

```text
priorityScore 80–100  → HIGH      → 3 分钟
priorityScore 50–79   → NORMAL   → 10 分钟
priorityScore 20–49   → LOW      → 30 分钟
priorityScore 0–19    → IDLE     → 60 分钟
```

发布模式默认：`WATCH=3`、`HOT=1`、`COOLDOWN=3` 分钟。HIGH 评分本身不会自动进入 WATCH。

管理员命令：

```text
/intervals
/interval high 3
/interval normal 10
/interval watch 3
/interval hot 1
/interval SM-S9480 TGY 5
```

优先顺序：单设备覆盖 → 全局强度设置 → 系统默认值。暂停目标会保留配置，但不会被 Cron、Alarm 或 `/checknow` 查询。


## 更新广播

`NOTIFY_ALLOWED_USERS_ON_UPDATE` 默认是 `true`。监控发现正式新固件后：

- 管理员收到带确认、优先级和暂停按钮的管理卡片。
- 所有已审批白名单用户收到精简更新卡片和查询/官方说明按钮。
- 管理员会从白名单广播列表中排除，避免重复通知。
- 未审批用户和从未授权的陌生会话不会收到广播。

可在 `wrangler.toml` 中显式关闭：

```toml
NOTIFY_ALLOWED_USERS_ON_UPDATE = "false"
```

## Cloudflare 资源

```text
FIRMWARE_KV
MONITOR_SCHEDULER
FIRMWARE_QUERY_COORDINATOR
oneui-firmware-notifications
oneui-firmware-notifications-dlq
```

v2.8.1 不新增新的 Cloudflare 资源或 Secret。

## 必需 Secrets

Cloudflare Worker：

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
WEBHOOK_SECRET
```

GitHub Actions：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_KV_NAMESPACE_ID
```

可选 Actions Secrets：

```text
TELEGRAM_BOT_TOKEN
WEBHOOK_SECRET
```

不要把真实 Token、Chat ID、Account ID 或 KV Namespace ID 写进仓库。

## Telegram 常用命令

公开快捷命令只保留：

```text
/start
/apply
/whoami
/status
/devices
```

固件查询仍直接发送 Model / CSC：

```text
948B EUX
SM-S948B EUX
930 CHN
tab11u wifi CHN
watch8 44 CHC
```

精确查询必须包含 CSC。若型号存在、但输入的 CSC 没有精确官方记录，机器人会从三星 SmartHistory 本次返回的数据中展示最可能的两个官方有效 CSC，并提供“查看更多”和直接查询按钮。其他 CSC 只用于建议，不会冒充当前查询结果。

`/start` 会按当前身份显示主菜单。管理员可通过按钮管理监控设备、优先级、调度、用户权限、监控健康度和缓存。

旧管理员命令继续兼容并作为故障备用，不再显示在公开快捷命令中。发送 `/adminhelp` 可查看精简的备用命令列表。固定间隔命令仅保留兼容提示，实际间隔由智能评分决定。

## Worker 路由

```text
GET  /
GET  /health
POST /telegram
GET  /check/{legacy-secret}
GET  /webhook_info/{legacy-secret}
GET  /fix_buttons/{legacy-secret}
```

生产 Telegram Webhook 使用 `/telegram` 与 `X-Telegram-Bot-Api-Secret-Token` 请求头。

## 本地验证

```bash
npm ci
npm run security-check
npm test
npx wrangler deploy --dry-run
```
>>>>>>> f3d3e4a (Prepare VPS runtime deployment)
