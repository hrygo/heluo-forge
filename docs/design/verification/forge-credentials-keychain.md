# forge-credentials-keychain 实现与验证记录

使用说明见[凭据扩展包](../../../packages/forge-credentials-keychain/README.md)，存储边界见[SQLite 存储约定](../../engineering/sqlite-storage-conventions.md)。

**实现边界**：SQLite 值级 AES-256-GCM、版本化 keyring、跨进程逻辑锁与单记录/双键条件提交；内存后端仅供测试；旧布局及未绑定旧库保留且拒绝访问。

**验证结果与限制**：2026-11-12 在 macOS arm64、Node 24.21.0 使用临时合成数据通过凭据包离线测试、CLI 重开与子进程中断测试；Windows、麒麟、Electron 及企业环境未实机验证，不代表生产准入。
