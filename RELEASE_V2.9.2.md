# OneUI Firmware Worker v2.9.2

这是基于 v2.9.1 的稳定性收尾版本，仅处理部署配置一致性与设备输入体验，不重构监控核心。

## 改动

- GitHub Actions 优先读取 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_KV_NAMESPACE_ID` Secrets，并兼容现有 Variables。
- 已知错误 CSC 组合会在请求三星服务器前直接提示正确输入。
- 支持 `930 CHN`、`936C CHC`、`tab11u wifi CHN`、`tab11u 5g CHC` 和 Watch8 精确别名。
- 保留现有中英文界面、Durable Object、Queue、KV 配额保护、SmartHistory 精确 CSC 和通知幂等逻辑。

## 升级

直接覆盖部署即可，不新增 Cloudflare 资源、迁移或 Worker Secret。
