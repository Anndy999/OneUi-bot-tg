# v2.22.8 Security Patch

## 中文

这是一个仅包含依赖安全更新的保守补丁，不修改三星固件查询、SmartHistory、自动监控、发布链、下载、解密、Telegram UI 或通知业务逻辑。

- Fastify 固定到 `5.12.1`，修复已披露的 Fastify 安全问题。
- `fast-uri` 3.x 锁定到 `3.1.6`。
- `fast-uri` 4.x 锁定到 `4.1.3`。
- 保留 v2.22.7 的通知安全与多机型合并逻辑。

升级后建议在服务器执行：

```bash
npm audit
```

预期不再报告本次 `fastify` / `fast-uri` 漏洞。

## English

This is a conservative dependency-only security patch. It does not change Samsung firmware queries, SmartHistory, automatic monitoring, rollout chains, download/decryption logic, Telegram UI, or notification behavior.

- Pins Fastify to `5.12.1` to address the disclosed Fastify security issues.
- Locks `fast-uri` 3.x to `3.1.6`.
- Locks `fast-uri` 4.x to `4.1.3`.
- Keeps all v2.22.7 notification-safety and multi-model aggregation behavior unchanged.

After deployment, run:

```bash
npm audit
```

The previously reported `fastify` / `fast-uri` findings should no longer appear.
