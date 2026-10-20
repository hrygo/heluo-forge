# 河洛 · Heluo Forge

河洛企业级智能研发平台（Heluo Forge）基于 DeepSeek Harness（DSH），通过插件、配置组合、Model Context Protocol（MCP，模型上下文协议）与技能包连接企业身份、模型网关和研发系统。

**当前处于方案评审与工程底座阶段。** 仓库提供方案文档、模块职责入口和可执行的工程检查；业务插件、独立服务、私有市场与客户端分发尚未实现，当前没有可安装的河洛产品。

| 项 | 内容 |
|---|---|
| 工程标识 | `heluo-forge` |
| 文档编号前缀 | `CORP-DSH-*`，保留历史编号；DSH 指上游运行时 |
| 仓库边界 | 企业方案与扩展工程仓库，不包含或分发 DSH 本体 |
| 使用与分发 | 公开（public）仓库；根工程 `private: true` 禁止 npm 发布，`UNLICENSED` 表示未授予开源许可 |

## 1. 项目解决什么问题

项目目标是在企业现有系统上提供统一身份、模型访问与额度治理、受控研发工具、研发流程及内部能力分发。企业能力优先通过 DSH 扩展体系承载，客户端控制与服务端授权各负其责。

一期面向 Windows 桌面端和银河麒麟 aarch64 本机 Web，每人独立实例。完整范围、非目标与核心补丁例外以[需求基线 §2](docs/requirements/requirements-baseline.md#2-范围边界唯一真源)为准；系统责任与技术取舍见[总体架构](docs/architecture/platform-architecture.md)。这些是方案基线，企业接口、双端隔离与部署效果仍须验证。

## 2. 从哪里开始

按任务选择入口；各文档的版本、状态、责任团队与门禁统一查[文档清单](docs/DOCUMENT-REGISTER.md)。

| 你要做什么 | 从这里开始 |
|---|---|
| 理解需求、一期边界与成功指标 | [需求与场景基线](docs/requirements/requirements-baseline.md) |
| 评审架构、信任边界与技术取舍 | [总体架构设计](docs/architecture/platform-architecture.md) |
| 评估排期、依赖、门禁与验收 | [推广实施方案](docs/plans/rollout-plan.md) |
| 查找契约、团队交付物或待确认问题 | [文档总览](docs/README.md) |
| 开始模块设计或开发 | [逐模块设计索引](docs/design/README.md) → [工程开发与发布约定](docs/engineering/development-conventions.md) |
| 修改仓库、提交变更或发起评审 | [贡献指南](CONTRIBUTING.md)；agent 同时遵循 [AGENTS.md](AGENTS.md) |
| 报告安全问题或疑似泄露 | [安全策略](SECURITY.md) |

## 3. 本地检查

当前可执行入口是工程检查。先安装或切换到仓库声明的工具链：Node.js 精确版本见 [.node-version](.node-version)，pnpm 版本见 [package.json](package.json) 的 `packageManager`；不要直接采用本机默认版本代替项目约束。

在仓库根目录执行：

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
```

首次检出用冻结锁文件安装；检查器仅使用 Node 标准库，日常重复检查无需安装依赖。安装可能访问包源；`pnpm check` 本身执行离线检查，不访问企业系统。

| 命令 | 验证范围 |
|---|---|
| `pnpm check` | 依次执行文档检查、仓库检查与检查器单元测试 |
| `pnpm check:docs` | 文档元数据、登记一致性、本地链接与锚点、表格及询问问题序列 |
| `pnpm check:repo` | 工程结构、工作区、模块状态、工作流权限与敏感信息规则 |
| `pnpm test:unit` | 工程检查器的正向与失败用例 |

[CI 工作流](.github/workflows/check.yml)定义了相同检查的直接 Node 命令，以只读权限运行，外部动作固定到提交 SHA。本地检查通过只证明对应工程规则和用例通过；远端 CI、分支保护、业务兼容性、企业联调与实机效果需分别取证。

## 4. 仓库如何组织

| 路径 | 维护内容 | 当前边界 |
|---|---|---|
| `docs/` | 需求、架构、计划、契约、设计、运维、协作与工程文档 | 导航见[文档总览](docs/README.md)，登记见[文档清单](docs/DOCUMENT-REGISTER.md) |
| `packages/` | 安装进 DSH 的 `@heluo/forge-*` 扩展包 | 仅职责 README，无业务清单、源码或测试 |
| `services/` | 独立运行的 DevOps MCP、市场目录与发布控制服务 | 仅职责 README，无可运行服务 |
| `deploy/` | 私有制品仓库接入与双端分发资产 | 仅[规划说明](deploy/README.md)，没有可执行部署配置或制品 |
| `scripts/`、`tests/` | 工程检查器及其测试 | 已建立本地可执行入口 |
| `.github/` | Issue/PR 模板与检查工作流 | 仓库文件不证明服务端保护或审批已启用 |

私有市场分为客户端接入包、目录与发布控制服务、私有 npm 制品仓库三层；具体职责和演进依据见[工程仓库结构设计](docs/engineering/repository-structure-design.md)。模块目录与设计模板的存在不表示相应能力已实现。

## 5. 如何参与

按[贡献指南](CONTRIBUTING.md)准备变更。文档内容在对应职责文件维护，README 保留概览和入口；新增、升版、改名或废止文档时按[文档治理规则](docs/README.md#6-编写约定)同步登记与引用。agent 的任务路由、授权和交付要求见 [AGENTS.md](AGENTS.md)。

支持与报告范围以[安全策略](SECURITY.md)及[运维索引](docs/operations/README.md)为准；尚未指定的联系人、支持时限与发布责任方保持待确认。
