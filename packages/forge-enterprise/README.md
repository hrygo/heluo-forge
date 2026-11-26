# @heluo/forge-enterprise

`heluo-forge` 企业账号与模型通用底座组合包（[详细设计](../../docs/design/plugins/forge-enterprise.md)）。

| 项 | 值 |
|---|---|
| 包名 | `@heluo/forge-enterprise` |
| 详细设计 | [详细设计](../../docs/design/plugins/forge-enterprise.md)（[CORP-DSH-DESIGN-004](../../docs/design/plugins/forge-enterprise.md)） |
| 实现状态 | 状态：可用（组合骨架：官方 7 行禁用层与回灌检测 [reflow.mjs](src/reflow.mjs) 已实现并有离线用例；[cordis.patch.yml](cordis.patch.yml) 装配通用底座四项成员：`@heluo/forge-credentials-keychain`、`@heluo/forge-policy`、`@heluo/forge-iam` 与 `@heluo/forge-brand`（品牌令牌，中性行不带 config）；不包含研发工具、研发面板或研发 Skill）；企业真实 IAM 端点与 OS 凭据集成待实机联调 |
| 运行时 | DSH 宿主装载 [cordis.patch.yml](cordis.patch.yml)；包根模块仅导出官方行回灌检测器，不包含客户端 UI 容器 |

## 核心组成与补丁边界

- [cordis.patch.yml](cordis.patch.yml) 完成三件事：
  1. 禁用 7 条官方旁路：`deepseek-account`、`ui-settings-account`、`llm-deepseek-account`、`llm-deepseek`、`llm-pi-ai`、`ui-settings-models`、`credentials`。
  2. 插入 4 个通用底座成员：`heluo-credentials-keychain`（`@heluo/forge-credentials-keychain`）、`heluo-policy`（`@heluo/forge-policy`，携带 12 条并集动作目录（6 读 + 6 写）与内存审计；登记不等于放行）、`heluo-iam`（`@heluo/forge-iam`，提供「企业账号」`-10` 与「企业模型」`10` 设置入口）与 `heluo-brand`（`@heluo/forge-brand`，「河洛 Forge 企业版」品牌令牌 bundle；行不带 config，身份默认值在包内）。
- [src/reflow.mjs](src/reflow.mjs) 提供官方行回灌检测器 `detectOfficialRowReflow()`，在 DSH 宿主升级后核对 `dsh --dump-config` 中官方 7 行是否仍维持 `disabled: true`。

## 验证

```sh
pnpm --filter @heluo/forge-enterprise test
```

## 边界

- 本包面向全体企业员工，只包含账号登录、AI 网关、模型目录管理、加密凭据存储、通用策略底座与品牌令牌；不包含研发域成员，可单独预装，也可与独立的 `@heluo/forge-engineering` 并存安装（共存时同名 `heluo-policy` 由 Cordis Loader 合并为单实例）。
- 每个插入行可按环境配置单独覆盖；策略、认证或加密存储不可用时按 fail-closed 语义拒绝，不以「可禁用」为由回退明文凭据或放行未授权访问。
- 内置运行时的载荷由桌面壳随包携带，本包只交出让它对 `web` profile 生效的两行配置；载荷的暂存、体积与随包许可见[验证记录](../../docs/design/verification/desktop-primary-runtime.md)。
- 生产与合规审计场景需把 `audit.sink` 从默认的 `memory` 改为 `file`（按天 JSONL、保留 `keepDays` 天）；组织信封要求持久审计时 `memory` 会被拒（`POLICY_AUDIT_NOT_DURABLE`）。服务另提供 `setAuditSink` 程序注入入口；真实企业网关、IAM 与 OS 凭据联动以企业环境实测为准。

  3. 按 id 覆盖内置运行时的两行 `workspace-dependencies` 与 `skill-office`：带 `name` 守卫，只在桌面壳设置 `DSH_PRIMARY_RUNTIME` 时生效；没有该变量时工具行保持停用、Office 技能指向用户自己的 Python，终端 CLI 不受影响。