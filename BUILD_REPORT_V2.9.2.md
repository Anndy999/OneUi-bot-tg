# Build Report v2.9.2

构建日期：2026-07-14

## 修改范围

- `.github/workflows/deploy.yml`：Cloudflare Account ID 与 KV Namespace ID 改为 GitHub Secrets 优先，并兼容同名 Variables。
- `src/firmware-input-parser.js`：查询前识别已知错误 CSC 组合并直接返回正确输入提示。
- `src/utils.js`：新增 Tab S11 Ultra、Watch8 系列精确别名，并让 `930`、`936C` 正确解析为 `SM-X` 平板型号。
- `src/index.js`：向输入帮助传递纠错信息；版本升级为 `2.9.2`。
- 保留 v2.9.1 中英文管理员界面和 SmartHistory 缺少 Android 字段的编码保护。
- 文档与测试同步更新。

## 保持不变

- Samsung SmartHistory History-only 查询链路
- 精确 Model/CSC 判定
- Durable Object 调度器与 Query Coordinator
- Cloudflare Queue、通知幂等与重试
- KV 配额保护、监控间隔与并发配置
- 现有监控目标和 Worker Secrets

## 验证结果

- Node.js 自动测试：103/103 通过
- 安全扫描：59 个文件，未发现提交的凭据
- JavaScript 语法检查：通过
- Wrangler 部署链路由 GitHub Actions 进行最终验证

## 兼容性

v2.9.1 可直接覆盖升级到 v2.9.2，不新增 Cloudflare 资源、Durable Object migration、Queue 或 Worker Secret。GitHub 中现有 Variables 可以继续使用，但 Secrets 优先。
