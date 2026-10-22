# @heluo/forge-iam

状态：可用（开发骨架；未接 IAM、未联调、未上线）。

一句话：企业 IAM 独占登录的 Host 插件骨架；当前只建立配置、状态机、凭据记录校验与 fail-closed 服务面，登录/刷新/UI 在 IAM 回函后按实施 issue 继续。

## 当前实现

| 项 | 状态 |
|---|---|
| 形态 | Host + Client 插件；Client 账户页骨架已接 interim route |
| 配置 | `src/config.mjs`：字段校验、默认值、`unconfigured` 判定 |
| 状态机 | `src/state.mjs`：`unconfigured` / `signed-out` / `authenticating` / `ready` / `expired` / `unreachable` / `error` |
| 凭据记录 | `src/record.mjs`：`IamGrantV1` 校验、到期/刷新判定；未接 `credentials` |
| 凭据适配 | `src/store.mjs`：GrantRecord、`ENTERPRISE_ACCESS_TOKEN` 镜像、官方旧记录检测；未接真实 `ctx.credentials` |
| Host 服务 | `src/index.mjs`：注册 `ctx.iam`、独占断言、`/api/forge-iam/*` interim route；未接 IAM 时 `startSignIn` fail closed |
| 登录/刷新/撤销 | 未实现；等待 IAM 书面回函与契约冻结 |
| keychain provider | 独立包 `@heluo/forge-credentials-keychain` 骨架已建立；OS adapter 未实现 |
| Client UI | `client.js`：`settings.section` 账户页、`settings.launcher` 入口、`shell.overlay` 四步 onboarding 与未登录横幅骨架；登录仍返回 501 |

## 边界

- 不修改 DSH 内核，不 fork；不把官方登录、官方模型、官方 API Key 或静态 Key 作为旁路。
- 未登录时企业能力 fail closed；应用外壳可打开，不做入口门禁。
- 凭据只经 `credentials` 接口读写；不把 token 写入日志、命令参数或模型上下文。
- 当前 `startSignIn` 只返回 `IAM_NOT_IMPLEMENTED`，不会伪造登录成功；UI 不应把该错误显示成“网络失败”。
- 独占断言发现 `deepseekAccount` 仍挂载时进入 `error`，不进入 ready、不写镜像。
- Client 当前使用 `/api/forge-iam/view`、`/api/forge-iam/sign-in`、`/api/forge-iam/sign-out` 的 interim same-origin route；IAM Remote 可用后必须替换，不把该 route 当生产契约。

## 测试

```sh
node --test packages/forge-iam/test
```

根检查：

```sh
pnpm check
git diff --check
```

## 关联

- 实施 issue：`#13`
- 详细设计：`docs/design/plugins/forge-iam.md`
- 官方行禁用：`docs/design/plugins/forge-enterprise.md`
- IAM 询问函：`docs/collaboration/team-confirmation-letters.md` §4.2