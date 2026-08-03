# v2.7.0 — Intelligent Flagship Priority Lifecycle

v2.7.0 在 v2.6.0 的跨节点查询协调与可靠通知基础上，新增“最新直板旗舰更新 → 管理员确认 → 上一代对应 CSC + TGY 高优先级监控”的完整生命周期。

## 新增功能

### 旗舰联动确认

- 最新旗舰每次发现新的正式 SmartHistory 版本后，都会向管理员发送确认卡片。
- 管理员确认后，精确配置的上一代对应 CSC 与 TGY 自动加入监控并设为 `high`。
- 管理员拒绝或不处理时，不修改监控列表。
- 所有配对来自 `FLAGSHIP_LINKAGE_RULES_JSON`，禁止自动 Model × CSC 组合。

### 上一代更新后的生命周期

当联动设备自身发现正式更新时，管理员可以选择：

- 恢复普通优先级。
- 继续保持高优先级。
- 暂停监控但保留配置。

继续保持 high 后，下一次更新仍会再次询问。

### 高优先级管理面板

- 管理员菜单新增“高优先级”。
- `/high` 可直接打开面板。
- 面板显示设备状态、优先级和联动来源。
- 可在按钮中暂停、恢复或降为 normal。
- 新增 `/monitempause` 与 `/monitemresume`。

## 数据模型

监控项新增：

```text
enabled
paused
pauseReason
prioritySource
linkedFrom
linkedRuleId
linkedAt
adminDecision
```

暂停设备继续保存在 KV，但不会进入 MonitorScheduler，也不会被 `/checknow` 查询。

## 安全与准确性

- 仍然只使用精确 CSC SmartHistory 作为正式数据。
- 不加入测试固件、XML 或 Generic History 查询。
- 旗舰联动只操作精确配置的合法 Model/CSC。
- 管理员确认之前不会自动改变设备优先级。

## 兼容性

- 不新增 Cloudflare Durable Object、Queue 或 Secret。
- 沿用 v2.6.0 的 `MonitorScheduler`、`FirmwareQueryCoordinator` 与 Notification Queue。
- 旧监控项会自动补充默认生命周期字段。
- 固定间隔命令保留兼容提示，但不再出现在主要交互入口中。
