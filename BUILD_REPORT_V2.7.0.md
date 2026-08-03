# v2.7.0 构建与审计报告

## 范围

- 正式固件数据源：Samsung FUS SmartHistory
- CSC：只接受精确 Local/Buyer 匹配
- 查询：沿用 v2.6.0 每目标 Durable Object 全局协调与权威缓存写入
- 监控：最新直板旗舰正式更新后，管理员确认才联动上一代对应 CSC + TGY
- 生命周期：联动目标支持 high、normal、暂停保留与恢复
- Telegram：新增高优先级管理面板与交互式确认卡片
- 部署：不新增 Cloudflare Queue、Durable Object 或 Secret

## 已实现规则

1. 最新直板旗舰每次发现新的正式版本，都会询问管理员。
2. 管理员确认后，只添加规则中精确配置的上一代目标：对应 CSC 与 TGY。
3. 已存在目标直接启用并提升为 high；不存在目标自动加入监控。
4. 上一代联动目标发现正式更新后，管理员可选择：
   - 恢复 normal；
   - 继续 high；
   - 暂停监控但保留配置。
5. 选择继续 high 后，下一次更新仍会再次询问。
6. 暂停目标不会进入 Cron 调度或 `/checknow`，但名称、历史和联动来源继续保留。
7. 所有联动仅接受 `FLAGSHIP_LINKAGE_RULES_JSON` 中的精确 Model/CSC，不生成笛卡尔组合。

## 回归验证

- Node 自动测试：63/63 通过
- 仓库凭据扫描：通过（41 个文件）
- JavaScript 语法检查：通过
- Wrangler dry-run：通过
- Worker dry-run 上传体积：282.74 KiB
- gzip：62.47 KiB
- npm 依赖漏洞：0（此前全新安装验证）

## 新增测试覆盖

- 旗舰联动规则只使用精确 source 与 previousTargets
- 不生成 Model × CSC 非法组合
- 生命周期字段在监控项归一化后保持完整
- 管理员确认后加入对应 CSC + TGY 并设为 high
- 上一代更新后可恢复 normal、保持 high 或暂停保留
- 高优先级面板暂停目标时不会删除配置
- 最新旗舰更新只创建管理员确认，不会未确认就修改上一代目标

## 配置检查

部署前应复核 `wrangler.toml` 中：

- `FLAGSHIP_LINKAGE_ENABLED`
- `FLAGSHIP_LINKAGE_RULES_JSON`
- `MONITOR_ITEMS_JSON`

映射必须逐条确认真实 Model/CSC 关系。若三星下一代型号或地区命名变化，只修改精确映射，不应使用前缀自动推断。

## 迁移要求

GitHub Actions Secrets 保持：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_KV_NAMESPACE_ID`

Cloudflare Worker Secrets 保持：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `WEBHOOK_SECRET`

v2.7.0 不要求新增 Cloudflare 资源或 Secret。推送至 `main` 后，现有 GitHub Actions 可继续完成测试和部署。
