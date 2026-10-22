# @heluo/forge-credentials-keychain

状态：可用（开发骨架；未接 OS keychain）。

一句话：`ctx.credentials` 的 keychain provider 骨架。当前提供 backend 契约、内存 backend、记录/引用读写与进程内单键锁；Windows DPAPI/凭据管理器与麒麟 libsecret/keyring 适配尚未实现。平台 backend 不可用时 `apply` 直接失败，不回退 0600 文件。

## 当前实现

| 项 | 状态 |
|---|---|
| 形态 | 替换 `ctx.credentials` 的 provider 插件 |
| backend | `src/backend.mjs`：内存 backend、不可用 backend；OS 适配待实现 |
| provider | `resolve / describe / set / unset / readRecord / describeRecord / listRecords / modifyRecord / deleteRecord` |
| 并发 | 进程内单键串行；跨进程锁未实现，刷新链路暂不可用 |
| 记录 | `api-key` / `grant` JSON；损坏记录显式报错，不静默当作空 |
| 组合 | 必须禁用 `dsh-credentials-local`；检测到已有 `credentials` 时拒绝挂载 |
| 安全 | 空值拒绝；不落日志；不可用/临时 backend 默认 fail closed |

## 不可用于生产

- `createPlatformBackend()` 当前固定返回不可用；这是刻意的 fail closed，不是完成态。
- 内存 backend 只用于测试/开发，默认不允许注册（`allowEphemeral: true` 才允许）。
- 跨进程锁未实现；在 keychain backend 提供锁之前，不要把本 provider 用于 refresh token 轮换。
- 生产仍需 Windows DPAPI/凭据管理器、麒麟 libsecret/keyring 的适配与双端实测。

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