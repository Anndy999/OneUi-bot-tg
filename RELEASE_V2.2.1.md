# OneUI Firmware Worker v2.2.1

## 目标

本次是发布窗口安全热修复。它修正了“同系列型号与 CSC 被错误做笛卡尔组合”的设计风险，并在不增加错误 Model / CSC 配对的前提下，将关联固件的自动监控缩短到每分钟。

## 核心行为

1. 发布组只接受精确 `{model, csc}` 目标。
2. 配置出现 `models` 或 `cscs` 数组时直接拒绝整组配置。
3. 更新发生后，只提升同组且已经存在于监控列表中的目标。
4. 不自动添加监控设备，不推导新的 Model / CSC。
5. 普通目标继续按默认 5 分钟执行；发布窗口目标在 120 分钟内每分钟执行。
6. 发布窗口到期后由 KV TTL 自动恢复正常间隔。

## 当前 S25 Ultra 精确组

```text
SM-S9380 / CHC
SM-S9380 / TGY
SM-S9380 / BRI
SM-S938B / EUX
```

明确不会生成：

```text
SM-S9380 / EUX
SM-S938B / CHC
```

## 新增环境变量

```toml
RELEASE_WINDOW_ENABLED = "true"
RELEASE_WINDOW_DURATION_MINUTES = "120"
RELEASE_WINDOW_INTERVAL_MINUTES = "1"
RELEASE_WINDOW_GROUPS_JSON = "...exact target groups..."
```

这些都是普通配置，不包含 Token。Telegram 和 Cloudflare 凭据仍只保存在 GitHub Actions Secrets 或 Cloudflare Worker Secrets。

## 部署前验证

```bash
npm ci
npm test
npx wrangler deploy --dry-run
```

预期测试数量：13。
