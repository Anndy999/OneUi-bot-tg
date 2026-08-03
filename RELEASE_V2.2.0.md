# oneui-firmware-worker v2.2.0

发布日期：2026-07-10

## 发布目标

本版本聚焦一件事：在三星固件“最新版查询”上做到比普通桌面查询器更适合长期在线服务——结果不串区、热查询更快、History 故障时更快降级，并能每 5 分钟主动发现更新。

## 已修复问题

### 1. 严格 CSC 选择

旧逻辑先比较 `BINARY_SEQUENCE`，可能把 EUX 等其他 CSC 的高序列固件当成 CHC 的最新版。

v2.2.0 先按 CSC 建立候选组：

1. `BINARY_LOCAL_CODE` 精确匹配请求 CSC。
2. 没有 Local 精确记录时，使用 `BINARY_BUYER_CODE` 精确匹配。
3. 前两者都没有时，才允许无 CSC 的通用记录。
4. 明确属于其他 CSC 的记录绝不参与最终版本竞争。

在选定的 CSC 候选组内部，再按 `BINARY_SEQUENCE`、开放日期和响应顺序选择最新版。

### 2. FUS Session 生命周期

新增：

```toml
FUS_SESSION_TTL_MS = "300000"
```

Session 默认复用 5 分钟，过期后自动重新生成 Nonce，避免长时间复用已经失效的认证状态。

### 3. 并发认证保护

FUS 的 Nonce 和 Cookie 是可变共享状态。v2.2.0 在单个 Worker isolate 内串行处理 FUS Session 操作，防止两个型号并发查询时互相覆盖认证状态。

### 4. FUS 熔断

新增：

```toml
FUS_CIRCUIT_FAILURE_THRESHOLD = "3"
FUS_CIRCUIT_COOLDOWN_MS = "30000"
```

连续失败达到阈值后，30 秒内不再反复冲击 FUS，而是让上层快速进入 XML 或 stale History 降级路径。冷却结束后会自动恢复探测。

### 5. 更短的新鲜缓存

```toml
L1_CACHE_TTL_SECONDS = "5"
FIRMWARE_CACHE_FRESH_SECONDS = "8"
ADMIN_REALTIME_QUERY_ENABLED = "true"
```

普通用户仍能获得快速热缓存；管理员查询默认绕过缓存直接请求 History。旧 History 的原始抓取时间会被保留，不再因为一次降级服务而显示成“刚刚抓取”。

### 6. 自适应 XML Hedge

初始值调整为：

```toml
XML_HEDGE_DELAY_MS = "800"
```

Worker 会记录近期 History 延迟，使用不低于配置值的 p90 延迟启动 XML Hedge，减少无意义的双源请求，同时在 History 变慢时及时准备降级结果。

### 7. 5 分钟更新监控

```toml
DEFAULT_MONITOR_INTERVAL_MINUTES = "5"
```

Telegram 支持：

```text
/moninterval 5
/moninterval 10
/moninterval 15
/moninterval 30
/moninterval 60
```

Cron 仍为每 5 分钟触发一次，因此 5 分钟是当前架构的最快自动检测间隔。

## 自动化测试

运行：

```bash
npm ci
npm test
```

v2.2.0 包含 8 项测试：

- 目标 CSC 不被其他 CSC 的高序列覆盖。
- Buyer CSC 正确降级选择。
- 只有其他 CSC 时拒绝误报。
- History 失败时 XML 明确标记为降级。
- 并发查询只生成一次 Nonce。
- Session 过期后自动更新。
- 连续失败触发 FUS 熔断。
- 5 分钟监控配置有效。

## Private GitHub 仓库自动部署

仓库无需公开。推送到 `main` 后，现有 `.github/workflows/deploy.yml` 会：

1. `npm ci`
2. `npm test`
3. 校验 GitHub Secrets
4. `wrangler deploy`
5. 同步 Telegram Worker Secrets
6. 在配置 `WORKER_URL` 时更新 Telegram Webhook 并检查 `/health`

需要的 GitHub Secrets：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
WEBHOOK_SECRET
```

可选 Repository Variable：

```text
WORKER_URL
```

## 上线后检查

```text
/refresh 9380 CHC
/debugquery 9380 CHC
/status
```

确认：

- 返回地区是 CHC，而不是其他 CSC。
- 来源优先显示 Samsung FUS SmartHistory。
- History 故障时才显示 XML degraded fallback。
- GitHub Actions 与 Cloudflare Deployments 均显示最新 commit。
