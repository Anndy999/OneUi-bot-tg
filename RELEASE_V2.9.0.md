# OneUI Firmware Worker v2.9.0

## 版本目标

本版重点是长期稳定性、真实性能观测、KV 配额隔离和上游保护，不增加测试固件、XML 最新版本回退或自动生成 Model/CSC 组合。

## 主要改进

### Durable Object 状态迁移

以下频繁变更状态以 MonitorScheduler Durable Object 为权威来源：

- 授权用户列表
- 待审批申请
- 自动审批设置
- 旗舰联动提案
- 监控运行状态与最后检查时间
- 发布加速状态
- 缓存管理设置

首次读取时会从旧 KV 数据迁移；Durable Object 不可用时才回退到 KV。

### 性能中心

管理员可通过按钮或 `/metrics` 查看最近 24 小时：

- 查询次数与成功率
- 缓存命中率
- Single-flight 合并率
- 查询耗时 P50/P95/P99
- SmartHistory 耗时 P50/P95
- 监控检查、更新和失败数量
- 本小时查询预算、并发和自适应限速倍率

### 系统诊断与主动告警

管理员可通过按钮或 `/diagnostics` 查看：

- Durable Object 初始化和目标数量
- 超时未执行目标
- 连续失败设备
- KV 镜像积压
- Alarm 支持
- Scheduler、Coordinator、Queue、KV 绑定状态

Cron 会被动检查异常。相同故障签名一小时内只告警一次。

### 查询预算保护

新增默认配置：

```toml
MONITOR_MAX_QUERIES_PER_HOUR = "300"
MONITOR_MAX_CONCURRENT_QUERIES = "3"
MONITOR_MIN_TARGET_INTERVAL_SECONDS = "60"
```

发生 403、429、5xx、超时或网络错误时，后台监控间隔自动扩大；连续成功后逐步恢复。交互查询仍由独立 FUS Lane 优先处理。

### 结构化固件版本

内部版本对象包含：

```json
{
  "raw": "A/B/C",
  "components": ["A", "B", "C"],
  "pda": "A",
  "cscVersion": "B",
  "modem": "C",
  "extras": [],
  "canonical": "A/B/C",
  "fingerprint": "A/B/C"
}
```

显示层只展示 `canonical`，继续兼容并修复旧的 `A/B/C/A` 重复第四段。

## WATCH、HOT、COOLDOWN

- **WATCH 发布信号观察**：目标尚未发现更新，但同系列或旗舰联动出现明确发布信号。默认 3 分钟一次，最长 2 小时。
- **HOT 更新确认窗口**：目标已经发现正式新版本后进行快速复核。默认 1 分钟一次，持续 3 分钟。
- **COOLDOWN 降频观察**：HOT 结束后逐步回落。默认 3 分钟一次，持续 10 分钟。

旧部署中无 schema 标记且 HIGH 为 1 分钟的默认值会迁移为 3 分钟；管理员之后仍可明确设置为 1 分钟。

## 未包含

根据产品决定，本版不加入：

- 用户按设备订阅与免打扰
- 配置导出、导入与备份恢复

## 安全和正确性不变

- 最新固件只来自精确 CSC Samsung SmartHistory。
- 不使用 version.xml 决定最新版本。
- 不查询或推送测试、内部固件。
- 不做 Model × CSC 笛卡尔积。
- 不提交 Token、Secret、真实 Account ID 或 Namespace ID。
