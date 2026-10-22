# @heluo/forge-credentials-keychain

状态：可用（开发骨架；未接 OS keychain；本地 0600 file backend 仅显式开发/试点）。

一句话：`ctx.credentials` 的 keychain provider 骨架。提供 backend 契约、内存/不可用/显式 0600 file backend、记录/引用读写与进程内单键锁；Windows DPAPI/凭据管理器与麒麟 libsecret/keyring 适配尚未实现。

## 当前实现

| 项 | 状态 |
|---|---|
| 形态 | 替换 `ctx.credentials` 的 provider 插件 |
| backend | 内存、不可用、显式 0600 file（含跨进程事务锁）；OS adapter 待实现 |
| provider | `resolve / describe / set / unset / readRecord / describeRecord / listRecords / modifyRecord / deleteRecord` |
| 并发 | 进程内单键串行；file backend 使用本地 O_EXCL 文档锁与每次读取的独立快照（仅 dev/pilot），锁争用超时后 fail closed，不自动回收；OS backend 未实现 |
| 记录 | `api-key` / `grant` / `gateway-credential` JSON；损坏记录显式报错，不静默当作空 |
| 生命周期 | 清理登记为 `ctx.effect`（Cordis 4 不收集普通 `function apply` 的返回值）；卸载时撤销 `ctx.credentials` 并 `close` backend |
| 配置 | `Config` 归一化幂等：缺省 `filePath` 为空串表示“不启用 file backend”，可被框架二次校验接受 |
| 事件 | 按 seam 要求逐个监听器隔离并记录失败；同步抛错不截断后续监听器，异步拒绝不产生未处理 rejection |
| 组合 | 必须禁用 `dsh-credentials-local`；检测到已有 `credentials` 时拒绝挂载 |
| 安全 | 空值拒绝；不落日志；不可用/临时/不安全 backend 默认 fail closed |

## backend 选择

- `createPlatformBackend()` 当前固定返回不可用；平台 adapter 未实现时 `apply` 直接失败。
- `createMemoryBackend()` 只用于测试/开发，默认拒绝，需 `allowEphemeral: true`。
- `createFileBackend({ path })` 是显式 0600 明文 fallback，默认拒绝，需 `allowInsecureFile: true`；文件权限在 POSIX 上校验为 `0600`。
- 生产必须使用 Windows DPAPI/凭据管理器或麒麟 libsecret/keyring 的审核实现；file backend 不是生产方案。

## 不可用于生产

- file backend 的跨进程锁是本地文件锁，只用于开发/试点；生产 OS backend 必须自行提供等价的跨进程互斥，当前尚未实现。
- 为避免“检查旧锁后删除了另一进程的新锁”的竞态，file backend 不按时间或 PID 自动接管锁。等待超过 10 秒抛出 `KEYCHAIN_LOCK_TIMEOUT`，不写入凭据。异常退出留下锁时，须先确认使用同一凭据文件的全部进程已停止，再人工检查并清理该文件旁的 `.lock`；运行中不得删除锁。自动崩溃恢复与生产 OS adapter 不属于此 fallback 的能力。
- file backend 是明文落盘，仅限本地开发/试点；不得进入生产配置。
- OS keychain 双端实测尚未完成。

## 测试

```sh
node --test packages/forge-credentials-keychain/test
```

根检查：

```sh
pnpm check
git diff --check
```

## 关联

- IAM 设计：`docs/design/plugins/forge-iam.md` §6、§11
- 凭据模式：`docs/design/credential-modes.md`
- 实施 issue：`#13`
