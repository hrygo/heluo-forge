# 企业研发工具套件详细设计

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DESIGN-019 |
| 文档名称 | 企业研发工具套件详细设计 |
| 版本 | V1.0.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-13 |
| 门禁 | G2 |
| 模块状态 | 可用（独立可预装企业研发组合包：`heluo-engineering-ui`、`enterprise-issue-delivery`、`@heluo/forge-devops`、`@heluo/forge-gitee` 与共享 `@heluo/forge-policy` 六动作目录；实现与验证见[设计索引 §2.2](../README.md#22-实现与验证入口)） |

> 编制依据：依据 [总体架构](../../architecture/platform-architecture.md)、[企业组合包详细设计](forge-enterprise.md)、[企业设置菜单统一与 Token 收敛详细设计](../enterprise-menu-and-token-unification.md)、[DevOps 接入设计](forge-devops.md) 与 [Gitee 接入设计](forge-gitee.md) 编制；双包同装与单包独立装配语义基于 DSH 宿主机清单与 `cordis-plugin-loader` 合并实测。真实企业 DevOps / Gitee CLI、OS 凭据库与双端 GUI 实机联调尚未完成。
>
> 关联文档：[文档清单](../../DOCUMENT-REGISTER.md)、[逐模块设计索引](../README.md)、[企业账号与模型组合包](forge-enterprise.md)、[设置菜单统一与 Token 收敛](../enterprise-menu-and-token-unification.md)、[DevOps 接入](forge-devops.md)、[Gitee 接入](forge-gitee.md)。

## 1. 结论

`@heluo/forge-engineering`（中文展示名：**企业研发工具套件**，英文展示名：**Enterprise Engineering Suite**）是面向研发场景的独立可预装 DSH 组合包，与通用底座 `@heluo/forge-enterprise`（**企业账号与模型**）各自独立打包、独立分发、自由组合。

本包承担三项职责：

1. **统一研发设置入口（`heluo-engineering-ui`）**：在 DSH「设置」导航注册独立分区 `forge-engineering`（`order: 30`，中文「企业研发工具」），声明子槽位 `heluo.engineering.tab`，收纳 `DevOps`（`order: 10`）与 `Gitee`（`order: 20`）两个工具面板，并注册矢量分区图标。
2. **企业平台工具能力闭合**：Bundled 并插入 `@heluo/forge-devops`、`@heluo/forge-gitee` 与共享策略门禁 `@heluo/forge-policy`（固定六动作默认目录），支持开箱完成单包就绪检查、本地命令行配置、Token 独立指定与受控研发操作。
3. **按需 Issue 交付技能（`heluo-issue-delivery-skill`）**：导出 `./issue-delivery-skill`、`./skills`、`./switches` 与标准 Agent Skill 资源 `skills/issue-delivery/`，以 `enterprise-issue-delivery` 向 DSH 注册显式触发的 Issue 交付工作流与条款装配能力。

**不越界边界**：`@heluo/forge-engineering` 不禁用任何 DSH 官方账号、模型或凭据行，可单独安装运行，也可与 `@heluo/forge-enterprise` 并发安装在同一 DSH Profile 中；不侵入「设置 → 企业账号」页面，DevOps 与 Gitee 的 Token 配置及状态提示全部内置于各自设置面板中。

## 2. 定位、组合关系与共存机制

| 维度 | `@heluo/forge-enterprise`（企业账号与模型） | `@heluo/forge-engineering`（企业研发工具套件） |
|---|---|---|
| 适用对象 | 所有企业终端用户（个人助理底座） | 需要 DevOps / Gitee / Issue 交付的研发人员 |
| 包含组件 | `forge-credentials-keychain`、`forge-policy`、`forge-iam` | `forge-engineering`（容器 + 交付 Skill）、`forge-policy`、`forge-devops`、`forge-gitee` |
| 官方行处理 | 禁用 7 个官方账号、模型与明文凭据行 | 不修改官方行（保持中性） |
| 设置侧栏条目 | `企业账号`（`order: -10`）、`企业模型`（`order: 10`） | `企业研发工具`（`order: 30`，内含 `DevOps` 与 `Gitee` 标签页） |
| 安装方式 | 可单独预装或通过插件市场安装 | 可单独预装、通过插件市场安装，或与 `forge-enterprise` 并行安装 |

### 2.1 双包同装与单实例收敛

两个组合包都在各自的 `cordis.patch.yml` 中声明同一策略插件行：

- `id: heluo-policy`
- `name: '@heluo/forge-policy'`
- `config.failClosed: true`
- `config.audit.retentionDays: 90`
- `config.catalog`: 固定 6 条 `kind: 'read'` 默认开放动作（`change.read`、`change.list`、`gitee.repository.read`、`gitee.issue.read`、`gitee.pr.read`、`gitee.delivery.judge`），两份补丁文件与 DevOps/Gitee 子包中的目录逐字节一致；写动作不预置登记，保持默认拒绝。

在 DSH 宿主补丁合并语义下：

- 单独安装 `@heluo/forge-engineering` 时，`heluo-policy` 直接激活，策略门禁、DevOps 与 Gitee 工具完整可用，无需先安装 `@heluo/forge-enterprise`；
- 同时安装 `@heluo/forge-enterprise` 与 `@heluo/forge-engineering` 时，两者补丁层均不使用 `isolate`，同 id 行 `heluo-policy` 在合并配置树中折叠为唯一实例，不产生冲突或重复挂载。

## 3. 清单、导出与补丁架构

### 3.1 包清单与导出边界

`@heluo/forge-engineering` 声明为私有插件包（`private: true`、`type: module`），主要分发入口与元数据如下：

| 字段 / 出口 | 值 | 用途 |
|---|---|---|
| `name` | `@heluo/forge-engineering` | DSH 组合包与 npm workspace 包名 |
| `main` | `./src/index.mjs` | 组合与 Skill / Switch 纯逻辑聚合入口 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 组合层 `insert:` 定义 |
| `dsh.client` | `{ platform: 'web', immediately: true, inject: ['slots', 'locale'] }` | Web 设置页容器注册入口（`exports['./client'] = './client.js'`） |
| `exports['./issue-delivery-skill']` | `./src/issue-delivery-skill.mjs` | DSH Host Skill Provider 插件入口 |
| `exports['./skills']` | `./src/skills.mjs` | 条款包加载、预算校验与 Skill 装配工具 |
| `exports['./switches']` | `./src/switches.mjs` | 企业研发五类开关状态与角色预设纯计算 |
| `exports['./locale/*.json']` | `./locale/*.json` | 插件市场及详情页中英双语元数据 |
| `exports['./icon']` | `./icon.svg` | 套件 SVG 图标（逐字节复用官方 `forge-cli-app-icon.svg`） |
| `dependencies` / `bundledDependencies` | `@heluo/forge-policy`、`@heluo/forge-devops`、`@heluo/forge-gitee` | 统一使用 `workspace:*` 并打入自包含 tarball 闭包 |

### 3.2 `cordis.patch.yml` 插入行

```yaml
- insert:
    - id: heluo-policy
      name: '@heluo/forge-policy'
      config: # 固定 failClosed / 90 天审计 / 6 条 read catalog
    - id: heluo-engineering-ui
      name: '@heluo/forge-engineering'
    - id: heluo-issue-delivery-skill
      name: '@heluo/forge-engineering/issue-delivery-skill'
    - id: forge-devops
      name: '@heluo/forge-devops'
      config: {}
    - id: heluo-gitee
      name: '@heluo/forge-gitee'
      config: {}
```

## 4. 客户端设置界面与独立凭证归位

### 4.1 研发工具设置容器（`client.js`）

`packages/forge-engineering/client.js` 以单一浏览器 IIFE 模块（`id: '@heluo/forge-engineering'`，`__ModuleLoader__.load`）向宿主注册：

1. `settings.section`：
   - `id: 'forge-engineering'`、`order: 30`、`label: () => t('section.label')`（默认「企业研发工具」 / `Engineering Tools`）；
   - `children: { 'heluo.engineering.tab': { kind: 'list', scope: 'root' } }`。
2. `settings.section.icon`：匹配 `id: 'forge-engineering'` 的 SVG 终端锐角标识。
3. 顶部说明：明确声明「统一管理 DevOps 与 Gitee 工具就绪状态、本地命令行路径及访问凭证」；未安装任何研发子插件或子槽位为空时，容器内呈现明确占位引导而非静默空白。

### 4.2 凭证条目内置与单包降级

DevOps（`DEVOPS_API_KEY`）与 Gitee（`GITEE_TOKEN`）不再向「企业账号」注槽，而是将各自凭据条目组件（`DevopsCredentialItem`、`GiteeCredentialItem`）直接渲染在对应的 `DevopsSection` 与 `GiteeSection` 底部区域：

- 当同 Profile 安装并启用了 `@heluo/forge-iam` 时，组件正常读写 `/api/forge-iam/ext-credentials` 及 `/api/forge-iam/ext-credentials/<id>`，提供加密覆盖保存、清除恢复、账号归属校验与 Gitee 明文风险告警；
- 当 `@heluo/forge-engineering` 独立运行且 `/api/forge-iam/ext-credentials` 返回 `404` 或 `501` 时，界面静默呈现可用提示（说明当前以本机命令行环境或工具自带登录态运行，并提示安装「企业账号与模型」包后可使用统一加密托管），不显示红色报错卡片或错误码，也不阻塞本地 CLI 路径保存与就绪检查。

## 5. 按需研发 Skill 与条款开关

- **Skill 资源与分发**：`skills/issue-delivery/` 包含主正文 `SKILL.md` 与按需参考手册 `references/handoff.md`、`references/evidence.md`；由 `src/issue-delivery-skill.mjs` 注册为 provider `enterprise-clauses` / skill `enterprise-issue-delivery`。
- **调用边界**：`invocation.modelInvocable = false`、`invocation.userInvocable = true`，仅响应用户显式触发；`list()` 只暴露轻量摘要与定位信息，`get()` 按需读取正文与目录引用。
- **开关与条款模型**：`src/skills.mjs` 负责规范条款加载与冲突显式暴露；`src/switches.mjs` 以 fail-closed 方式计算 `read` / `research-write` / `ai-publish` / `human-review` / `observe` 五类开关及角色收窄矩阵（角色 preset 仅收紧权限，绝不放大已批准范围）。

## 6. 图标、双语简介与插件市场呈现

为确保插件在 DSH「插件管理 / 市场详情页」呈现准确、简洁且具辨识度的信息，本套件随包携带以下静态资产：

- `icon.svg`：逐字节复制自 [赛博苍螭 cli App Icon](<../../assets/branding/cyber-long/components/forge-cli-app-icon.svg>)，与 `@heluo/forge-enterprise` 主标形成视觉区分；
- `locale/zh.json` 与 `locale/en.json`：定义 `meta.title`、`meta.description` 与 `meta.detail`（指向 `./docs/DETAIL.zh.md` 与 `./docs/DETAIL.md`）；
- `docs/DETAIL.zh.md` 与 `docs/DETAIL.md`：面向终端研发人员的介绍页正文，简明说明套件包含组件（DevOps、Gitee、Issue 交付 Skill、共享策略门禁）、初始配置指引与安全边界，不含内部排障流水或误导性「只读」标签。

## 7. 验证基线与未覆盖事项

- **包结构与闭环门禁**：由 `pnpm check:repo`、`pnpm check:tarballs`、`pnpm check:skills`、`tests/plugin-patch-layers.test.mjs`、`tests/ui-contract.test.mjs` 及 `packages/forge-engineering/test/*.test.mjs` 执行离线覆盖；
- **真实装包与共存验证**：使用真实 `dsh` 构建 `@heluo/forge-engineering` tarball 并独立/联合安装至测试 Profile，核查 `--dump-config` 中 `heluo-policy` 单实例折叠、双包依赖闭环与元数据可读性；
- **未联调外部项**：真实企业 DevOps CLI、Gitee 内网 `gh` CLI、企业 OS 凭据库联动及双端桌面 GUI 交互流程仍待外部环境实机联调。

