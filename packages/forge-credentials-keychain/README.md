# @heluo/forge-credentials-keychain

状态：可用（开发骨架；未接 OS keychain；本地 0600 file backend 仅显式开发/试点）。

一句话：`ctx.credentials` 的 keychain provider 骨架。提供 backend 契约、内存/不可用/显式 0600 file backend、记录/引用读写与进程内单键锁；Windows DPAPI/凭据管理器与麒麟 libsecret/keyring 适配尚未实现。

## 当前实现

| 项 | 状态 |
|---|---|
| 形态 | 替换 `ctx.credentials` 的 provider 插件 |
| backend | 内存、不可用、显式 0600 file；OS adapter 待实现 |
| provider | `resolve / describe / set / unset / readRecord / describeRecord / listRecords / modifyRecord / deleteRecord` |
| 并发 | 进程内单键串行；跨进程锁未实现，刷新链路暂不可用 |
| 记录 | `api-key` / `grant` JSON；损坏记录显式报错，不静默当作空 |
| 组合 | 必须禁用 `dsh-credentials-local`；检测到已有 `credentials` 时拒绝挂载 |
| 安全 | 空值拒绝；不落日志；不可用/临时/不安全 backend 默认 fail closed |

## backend 选择

- `createPlatformBackend()` 当前固定返回不可用；平台 adapter 未实现时 `apply` 直接失败。
- `createMemoryBackend()` 只用于测试/开发，默认拒绝，需 `allowEphemeral: true`。
- `createFileBackend({ path })` 是显式 0600 明文 fallback，默认拒绝，需 `allowInsecureFile: true`；文件权限在 POSIX 上校验为 `0600`。
- 生产必须使用 Windows DPAPI/凭据管理器或麒麟 libsecret/keyring 的审核实现；file backend 不是生产方案。

## 不可用于生产

- 跨进程锁未实现；在 backend 提供跨进程锁之前，不要把本 provider 用于 refresh token 轮换。
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
