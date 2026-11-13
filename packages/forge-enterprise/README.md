# @heluo/forge-enterprise

`heluo-forge` 企业账号与模型通用底座组合包（[详细设计](../../docs/design/plugins/forge-enterprise.md)）。

| 项 | 值 |
|---|---|
| 包名 | `@heluo/forge-enterprise` |
| 详细设计 | [详细设计](../../docs/design/plugins/forge-enterprise.md)（[CORP-DSH-DESIGN-004](../../docs/design/plugins/forge-enterprise.md)） |
| 实现状态 | 状态：可用（组合骨架：官方 7 行禁用层与回灌检测 [reflow.mjs](src/reflow.mjs) 已实现并有离线用例；[cordis.patch.yml](cordis.patch.yml) 仅装配通用底座三项成员：`@heluo/forge-credentials-keychain`、`@heluo/forge-policy`、`@heluo/forge-iam`；不包含任何研发工具、研发面板或研发 Skill）；企业真实 IAM 端点与 OS 凭据集成待实机联调 |
| 运行时 | DSH 宿主装载 [cordis.patch.yml](cordis.patch.yml)；包根模块仅导出官方行回灌检测器，不包含客户端 UI 容器 |

## 核心组成与补丁边界

- [cordis.patch.yml](cordis.patch.yml) 完成两件事：
  1. 禁用 7 条官方旁路：`deepseek-account`、`ui-settings-account`、`llm-deepseek-account`、`llm-deepseek`、`llm-pi-ai`、`ui-settings-models`、`credentials`。
  2. 插入 3 个通用底座成员：`heluo-credentials-keychain`（`@heluo/forge-credentials-keychain`）、`heluo-policy`（`@heluo/forge-policy`，携带 6 条并集动作目录与内存审计）与 `heluo-iam`（`@heluo/forge-iam`，提供「企业账号」`-10` 与「企业模型」`10` 设置入口）。
- [src/reflow.mjs](src/reflow.mjs) 提供官方行回灌检测器 `detectOfficialRowReflow()`，在 DSH 宿主升级后核对 `dsh --dump-config` 中官方 7 行是否仍维持 `disabled: true`。

## 验证

```sh
pnpm --filter @heluo/forge-enterprise test
```

## 边界

- 本包面向全体企业员工，只包含账号登录、AI 网关、模型目录管理、加密凭据存储与通用策略底座；不含任何研发域成员或界面容器，可单独预装，也可与独立的 `@heluo/forge-engineering` 并存安装（共存时同名 `heluo-policy` 由 Cordis Loader 合并为单实例）。
- 每个插入行可按环境配置单独覆盖；策略、认证或加密存储不可用时按 fail-closed 语义拒绝，不以「可禁用」为由回退明文凭据或放行未授权访问。
- 生产与合规审计场景须在运行配置注入持久审计 sink 并移除 `allowNonDurable: true`；真实企业网关、IAM 与 OS 凭据联动以企业环境实测为准。
