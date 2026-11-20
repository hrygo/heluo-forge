# forge-credentials-keychain 实现与验证记录

使用说明见[凭据扩展包](../../../packages/forge-credentials-keychain/README.md)，存储边界见[SQLite 存储约定](../../engineering/sqlite-storage-conventions.md)。

**实现边界**：SQLite 值级 AES-256-GCM、版本化 keyring、跨进程逻辑锁与单记录/双键条件提交；内存后端仅供测试；旧布局及未绑定旧库保留且拒绝访问。

**验证结果与限制**：2026-11-12 在 macOS arm64、Node 24.21.0 使用临时合成数据通过凭据包离线测试、CLI 重开与子进程中断测试；Windows、麒麟、Electron 及企业环境未实机验证，不代表生产准入。

2026-11-20 的 [IAM 部署组合回归](../../../packages/forge-iam/test/client-auth-deployment.test.mjs)使用跨进程管理员 CLI 预置、轮换同一凭据命名空间中的密钥。Host 读取来源后完成 Basic/Post 续期，重写相同值时也停止采用原凭据 revision。目标终端预置及权限边界待实机验证。

[SQLite 组合回归](../../../packages/forge-credentials-keychain/test/sqlite-composition.test.mjs)使用隔离目录覆盖 keyring 缺失、损坏及单个历史密钥缺失。同步检查拒绝依赖不可用密钥的快照，恢复原 keyring 后可重新读取对应记录。
