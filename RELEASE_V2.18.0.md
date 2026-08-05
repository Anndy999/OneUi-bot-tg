# OneUI Firmware Worker v2.18.0

## 本版本重点

- 普通监控中心改为精简管理界面：正常、更新、异常、暂停四类状态。
- 设备列表只显示型号和 CSC，点击设备后再执行暂停、恢复、查询或删除。
- 待确认的新版本单独归入“更新”，不再与普通运行状态混淆。
- 发布链目标继续与普通监控隔离，发布链逻辑和审批流程不变。
- 失败设备集中显示，管理员可以一次检查异常设备。
- GitHub VPS CI 改为手动运行，VPS push 更新不会再自动触发失败邮件。
- 修复下载测试在 GitHub runner 磁盘空间较少时的误报，不改变 VPS 的生产磁盘保留策略。
- 继续使用 VPS 长轮询、PostgreSQL、Redis、BullMQ 和管理员专用下载服务。

## 验证结果

- `npm test`：168/168 通过
- `npm run security-check`：通过
- `npm audit --omit=dev --audit-level=high`：0 个高危漏洞

## 部署

推送到 `main` 后，在 VPS 执行现有 `deploy/update-vps.sh` 即可更新。运行中的用户配置、数据库和下载文件不属于本说明文件的清理范围。
