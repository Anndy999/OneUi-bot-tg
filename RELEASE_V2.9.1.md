# OneUI Firmware Worker v2.9.1

## 本版目标

v2.9.1 解决 Workers KV 免费套餐每日 `put()` 被每分钟 Cron 运行标记耗尽的问题，并增加白名单用户的按型号日查询限额，以及监控发现更新后的“继续或定时恢复”管理流程。

## Cron 与 KV 配额保护

Cron 仍然每分钟唤醒 Worker，但它只负责领取当前分钟槽位、检查到期目标、处理提醒和触发诊断，不等于每分钟查询全部设备。

正常部署路径现在由 `MonitorScheduler` Durable Object 原子领取 Cron 槽位，不再写入：

```text
monitor:run:<date>:<slot>
monitor:lock:<date>:<slot>
```

当 Durable Object 暂时不可用时，本轮 Cron 默认安全跳过并等待下一分钟重试，不会自动退回到每分钟 KV 写入。旧 KV 回退必须显式设置：

```toml
MONITOR_ALLOW_KV_CRON_FALLBACK = "true"
```

默认保持 `false`，以保护免费套餐每日 1,000 次 KV 写入额度。

## 白名单用户每日同型号最多查询 10 次

默认配置：

```toml
ALLOWED_USER_DAILY_MODEL_QUERY_LIMIT = "10"
```

规则：

- 仅对白名单用户生效，管理员不受限制。
- 按“Chat ID + 北京日期 + Model”计数。
- 同一 Model 的不同 CSC 共用次数，例如 `SM-S938B/EUX` 与 `SM-S938B/BTU` 共用 10 次。
- 第 1～10 次正常查询；第 11 次开始显示“今日查询次数已达上限”。
- 每天北京时间 00:00 自动进入新计数周期。
- 普通输入、实时刷新命令和结果卡片的实时刷新按钮都使用同一额度。
- 被秒级频率限制直接拦截的请求不计数；进入正式查询流程的请求会计数，包括缓存命中或上游最终失败。
- 计数存储在 Durable Object，不消耗 Workers KV `put()`。

## 发现新固件后的监控计划

管理员更新卡片新增：

```text
[▶️ 按原计划继续] [⏸ 稍后恢复]
```

选择“按原计划继续”：

- 清除本次更新产生的 HOT/WATCH 临时状态。
- 保留原优先级、单设备间隔和全局强度设置。
- 按原计划计算下一次检查时间。

选择“稍后恢复”：

- 立即暂停该 Model/CSC，不删除监控配置。
- 保留上次正式版本、智能评分、失败记录和关联来源。
- 支持 1、3、6、12 小时及 1、3、7 天预设。
- 支持自定义命令：

```text
/monsnooze SM-S938B EUX 90m
/monsnooze SM-S938B EUX 6h
/monsnooze SM-S938B EUX 2d
```

自定义范围为 30 分钟至 30 天。

到期后 Durable Object Alarm 会：

1. 自动启用该监控目标。
2. 将临时发布状态恢复为 `NORMAL`。
3. 按原优先级或单设备间隔重新调度。
4. 通过通知 Queue 告知管理员“固件监控已自动恢复”。

## 兼容性与安全

- 不新增 Secret、Worker、Queue 或 Durable Object 类。
- 继续使用现有 `MONITOR_SCHEDULER`、`FIRMWARE_QUERY_COORDINATOR`、`FIRMWARE_KV` 与 `NOTIFICATION_QUEUE` 绑定。
- 正式固件仍只来自精确 CSC 的 Samsung SmartHistory。
- 不使用 `version.xml` 判断最新版。
- 不查询测试、内部或工程固件。
- 不生成 Model × CSC 笛卡尔积。
- 压缩包不包含真实 Token、Secret、Account ID 或 KV Namespace ID。

## 部署后检查

1. `/health` 显示 `2.9.1`。
2. `/diagnostics` 中 `MonitorScheduler` 绑定正常。
3. `MONITOR_ALLOW_KV_CRON_FALLBACK` 保持 `false`。
4. 白名单用户对同一 Model 连续完成 10 次查询后，第 11 次被拦截。
5. 测试监控更新卡片的“按原计划继续”和“稍后恢复”。
6. 设置一个较短的测试暂停时长，确认到期后管理员收到自动恢复通知。
