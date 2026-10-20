# 河洛 · Heluo Forge

河洛企业级智能研发平台（Heluo Forge）基于 DeepSeek Harness（DSH），通过插件、配置组合、企业现有 CLI 与技能包连接企业身份、模型网关和研发系统；Model Context Protocol（MCP，模型上下文协议）按集成需要另行评估。

**当前处于方案评审与市场模块实现阶段，尚无完整河洛产品发行版。** `@heluo/forge-market` 已有宿主插件、客户端列表面板及安装链路，`market-index` 已有可本地运行的 HTTP 参考服务；其余八个包与 DevOps MCP 服务仍为规划入口。企业联调、完整市场治理与双端产品分发尚未完成。

现状核对日期：2026-10-21。以下区分仓库实现、历史实机记录与待验证目标，不以目录或设计草案证明上线能力。

| 项 | 内容 |
|---|---|
| 工程标识 | `heluo-forge` |
| 文档编号前缀 | `CORP-DSH-*`，保留历史编号；DSH 指上游运行时 |
| 仓库边界 | 企业方案与扩展工程仓库，不包含或分发 DSH 本体 |
| 使用与分发 | 公开（public）仓库；根工程 `private: true` 禁止 npm 发布，`UNLICENSED` 表示未授予开源许可 |

## 1. 项目解决什么问题

项目目标是在企业现有系统上提供统一身份、模型访问与额度治理、受控研发工具、研发流程及内部能力分发。企业能力优先通过 DSH 扩展体系承载，客户端控制与服务端授权各负其责。

一期面向 Windows 桌面端和银河麒麟 aarch64 本机 Web，每人独立实例。完整范围、非目标与核心补丁例外以[需求基线 §2](docs/requirements/requirements-baseline.md#2-范围边界唯一真源)为准；系统责任与技术取舍见[总体架构](docs/architecture/platform-architecture.md)。这些是方案基线，企业接口、双端隔离与部署效果仍须验证。

DevOps 与 Gitee 的当前接入基线是复用现有 CLI，通过只读命令白名单接入；双端产物、凭据注入、结构化输出和权限仍待提供方核验。CLI 不满足前提时，先关闭相关能力并提交替代形态评审；MCP 服务与核心补丁不自动恢复为实施项。

## 2. 从哪里开始

按任务选择入口；各文档的版本、状态、责任团队与门禁统一查[文档清单](docs/DOCUMENT-REGISTER.md)。

| 你要做什么 | 从这里开始 |
|---|---|
| 理解需求、一期边界与成功指标 | [需求与场景基线](docs/requirements/requirements-baseline.md) |
| 评审架构、信任边界与技术取舍 | [总体架构设计](docs/architecture/platform-architecture.md) |
| 评估排期、依赖、门禁与验收 | [推广实施方案](docs/plans/rollout-plan.md) |
| 查找契约、团队交付物或待确认问题 | [文档总览](docs/README.md) |
| 开始模块设计或开发 | [逐模块设计索引](docs/design/README.md) → [工程开发与发布约定](docs/engineering/development-conventions.md) |
| 了解已实现的市场工具、面板或本地服务 | [市场插件](packages/forge-market/README.md) → [目录服务](services/market-index/README.md) |
| 修改仓库、提交变更或发起评审 | [贡献指南](CONTRIBUTING.md)；agent 同时遵循 [AGENTS.md](AGENTS.md) |
| 报告安全问题或疑似泄露 | [安全策略](SECURITY.md) |

## 3. 本地检查

先安装或切换到仓库声明的工具链：Node.js 精确版本见 [.node-version](.node-version)，pnpm 版本见 [package.json](package.json) 的 `packageManager`；不要直接采用本机默认版本代替项目约束。

在仓库根目录执行：

```sh
node --version
pnpm --version
pnpm check
```

当前检查器、市场宿主代码和参考服务使用 Node 标准库，运行检查无需安装依赖；客户端面板由 DSH 提供 React。需要安装工作区依赖时使用 `pnpm install --frozen-lockfile`，安装可能访问包源。`pnpm check` 本身离线运行，测试只启动本机临时 HTTP 服务，不访问企业系统。

| 命令 | 验证范围 |
|---|---|
| `pnpm check` | 依次执行文档检查、仓库检查与 Node 自动发现的全部测试 |
| `pnpm check:docs` | 文档元数据、登记一致性、本地链接与锚点、表格及询问问题序列 |
| `pnpm check:repo` | 工程结构、工作区、模块状态、工作流权限与敏感信息规则 |
| `pnpm test:unit` | 当前实际执行 `node --test`，包含检查器、市场包、参考服务及本地集成用例 |
| `node --test packages/forge-market/test/*.test.mjs` | 单独验证市场插件的逻辑、契约及本地安装链路 |
| `node --test services/market-index/test/*.test.mjs tests/integration/*.test.mjs` | 单独验证目录服务与跨模块集成 |

[CI 工作流](.github/workflows/check.yml)通过 `node --run check` 执行相同定义，以只读权限运行，外部动作固定到提交 SHA。本地检查通过只证明对应规则和离线用例通过；远端 CI、分支保护、企业联调与 Windows / 麒麟实机效果需分别取证。

## 4. 仓库如何组织

| 路径 | 维护内容 | 当前边界 |
|---|---|---|
| `docs/` | 需求、架构、计划、契约、设计、运维、协作与工程文档 | 导航见[文档总览](docs/README.md)，登记见[文档清单](docs/DOCUMENT-REGISTER.md) |
| `packages/` | 安装进 DSH 的九个 `@heluo/forge-*` 扩展入口 | `forge-market` 已有私有包清单、源码、面板、补丁与测试；其余八个仅职责 README |
| `services/` | 市场目录与发布控制、条件建设的 DevOps MCP | `market-index/server.mjs` 可本地运行并有测试；无独立包清单或生产部署；DevOps MCP 暂不建设 |
| `deploy/` | 私有制品仓库接入与双端分发资产 | 仅[规划说明](deploy/README.md)，没有可执行部署配置或制品 |
| `scripts/`、`tests/` | 工程检查器、检查器测试与市场跨模块测试 | 已建立离线检查与本地 HTTP 归档安装用例 |
| `.github/` | Issue/PR 模板与检查工作流 | 仓库文件不证明服务端保护或审批已启用 |

市场分为客户端插件、目录与发布控制、制品来源三层。当前安装实现取 Gitee tag 归档；企业 registry 的接入与镜像策略仍待确认，不能把 `deploy/registry/` 当作已部署设施。结构及历史整理范围见[工程仓库结构设计](docs/engineering/repository-structure-design.md)。

当前市场能力与验证边界：

| 对象 | 已有能力与证据 | 尚未完成 |
|---|---|---|
| 市场插件 | 十个 agent 工具、服务/本地 JSON 目录、缓存回退、归档下载解包与可选落盘、登记行生成；见[模块说明](packages/forge-market/README.md) | 完整市场页面、IAM 会话与角色治理；安装落盘后仍需登记到 profile |
| 参考服务 | 列表、详情、提交入队、评审/撤回、下载请求计数；管理端点校验共享令牌 | Gitee 自动扫描、账号与角色授权、服务端完整包校验、业务数据与审计持久化；诊断接口目前为空列表 |
| DSH 挂载 | [设计记录](docs/design/plugins/forge-market.md#61-面板的两种视图)记载 2026-10-20 在测试 profile 激活插件并渲染三种面板状态；验证后已卸载并恢复 | 本次未重做实机验证；不代表企业 Gitee、生产服务或双端均已联调 |

安装链路已有域名白名单、路径校验、安装脚本拦截与条件摘要/版本检查；专门 group 授权、必需摘要、完整兼容性和角色安装限制仍须闭环。详细实现限制见[市场插件说明](packages/forge-market/README.md#当前实现限制)。

## 5. 如何参与

按[贡献指南](CONTRIBUTING.md)准备变更。文档内容在对应职责文件维护，README 保留概览和入口；新增、升版、改名或废止文档时按[文档治理规则](docs/README.md#6-编写约定)同步登记与引用。agent 的任务路由、授权和交付要求见 [AGENTS.md](AGENTS.md)。

支持与报告范围以[安全策略](SECURITY.md)及[运维索引](docs/operations/README.md)为准；尚未指定的联系人、支持时限与发布责任方保持待确认。
