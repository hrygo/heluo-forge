# 河洛 · Heluo Forge

河洛企业级智能研发平台（Heluo Forge — Enterprise AI Engineering Platform）是基于 DeepSeek Harness（DSH）构建的企业级智能研发平台，连接模型、工具与研发流程，目标是为研发团队提供可信、可控的智能协作能力。

## 项目信息

| 项 | 内容 |
|---|---|
| 中文名称 | 河洛企业级智能研发平台 |
| 英文名称 | Heluo Forge |
| 工程标识 | `heluo-forge` |
| 项目编号 | CORP-DSH |
| 版本 | V1.6.2 |
| 状态 | 方案评审；工程底座已建立，业务插件未实现 |
| 最后更新 | 2026-10-20 |
| 文档清单 | [docs/DOCUMENT-REGISTER.md](<docs/DOCUMENT-REGISTER.md>) |
| 文档总览 | [docs/README.md](<docs/README.md>) |
| 范围 | 用 DSH 与 DSH 插件体系承载企业研发体系：身份与授权、模型与成本、工程系统、研发流程、分发与治理 |

品牌名称统一为“河洛 / Heluo Forge”，包名统一为 `@heluo/forge-*`，包目录统一为 `packages/forge-*`。`CORP-DSH-*` 沿用为文档编号以保持历史可追溯，DSH 仍指上游 DeepSeek Harness。

## 1. 结论

当前方案是**可继续评审的目标路线，非已实测可行的交付结论**。仓库已完成结构调整：文档按类别维护，九个安装包与两个独立服务建立了职责入口，工程检查与最小 CI 可运行；**插件、服务与私有市场尚未实现**。

企业能力拟落在插件、bundle、MCP、skill 与配置上，唯一允许的核心补丁是 `dsh-mcp-client` 按请求获取 token 及 `stdio` 凭据重连；50–80 行只是规模粗估，不是已完成代码量或交付上限，仍须联调、回归并由内部源兜底。一期保持 3 部门 800 人、每人独立实例；Windows（50%）使用桌面 App，银河麒麟 aarch64（50%）使用仅绑定 `127.0.0.1` 的本机 Web。

主要不确定性包括：Windows 与麒麟双端凭据/执行隔离、IAM/网关/DevOps/Gitee 接口契约、模型与网关容量、支持投入和分批观察窗口。800 人不等于 800 并发；15 周仅是依赖和资源满足时的条件基准，不是日期承诺。现有源码依据不等于企业部署验证，完整边界见[需求基线](<docs/requirements/requirements-baseline.md>)、[总体架构](<docs/architecture/platform-architecture.md>)及[实施计划](<docs/plans/rollout-plan.md>)。

## 2. 仓库结构

```text
heluo-forge/
├── README.md / AGENTS.md / CONTRIBUTING.md / SECURITY.md
├── package.json / pnpm-workspace.yaml / pnpm-lock.yaml
├── .github/                  # PR、Issue 模板与只读检查工作流
├── docs/
│   ├── README.md             # 文档总览
│   ├── DOCUMENT-REGISTER.md  # 编号、版本、状态与路径
│   ├── requirements/         # 需求与指标基线
│   ├── architecture/         # 总体架构与 ADR
│   ├── plans/                # 实施与推广计划
│   ├── design/               # 逐模块设计索引（详细设计待编写）
│   ├── contracts/            # 外部系统字段级契约
│   ├── operations/           # 分发、发布、回滚与支持手册（待编写）
│   ├── collaboration/        # 跨团队询问与回函
│   ├── engineering/          # 仓库结构与工程约定
│   ├── templates/            # 受控文档与模块设计模板
│   └── assets/               # 可离线打开的 HTML 图解
├── packages/                 # 九个规划包，仅职责说明，无源码
├── services/                 # 两个规划服务，仅职责说明
├── deploy/                   # registry、双端分发与部署资产
├── scripts/                  # 文档与仓库检查器
└── tests/                    # 检查器单元测试
```

目录只表达职责与边界。`packages/` 与 `services/` 下没有包清单、源码或可运行服务；只有通过设计评审的模块才建立清单与测试。

## 3. 文档地图

| 文档 | 内容 | 主要读者 |
|---|---|---|
| [文档总览](<docs/README.md>) | 分类目录、十份领域交付物、协作与工程入口 | 全体 |
| [需求与场景基线](<docs/requirements/requirements-baseline.md>) | L2 基线（V1.2.2，评审稿）：范围唯一真源、7 类角色、8 条场景、23 条需求、M1–M6 | PM、业务方、安全、试点用户 |
| [总体架构设计](<docs/architecture/platform-architecture.md>) | L1 架构（V1.3.3，评审稿）：责任与信任边界、领域设计、安全、ADR | 架构评审、各团队负责人 |
| [推广实施方案](<docs/plans/rollout-plan.md>) | L2 计划（V1.2.2，评审稿）：关键路径、条件排期、G0–G3 证据、验收 A1–A14 | PM、实施团队 |
| [AI 网关契约](<docs/contracts/gateway-contract.md>) | L3 草案（V0.8.2）：模型鉴权、双维度额度、错误与日志边界 | 网关、模型与安全团队 |
| [逐模块设计索引](<docs/design/README.md>) | 九个包与两个服务的设计状态、顺序与完成判据 | 插件与服务开发者 |
| [工程开发与发布约定](<docs/engineering/development-conventions.md>) | 工作区、测试分层、版本、发布与 CI 规则 | 维护者 |
| [工程仓库结构设计](<docs/engineering/repository-structure-design.md>) | 目录、模块边界、迁移与私有市场分层 | 工程负责人 |
| [跨团队确认询问函](<docs/collaboration/team-confirmation-letters.md>) | 七封可独立转发的正文，47 项问题 | 发函人、各接入团队 |
| [文档清单](<docs/DOCUMENT-REGISTER.md>) | 编号、版本、状态、负责团队与门禁 | 全体 |
| [协作规范](<AGENTS.md>) | 文档体系、变更流程、验证要求与禁止事项 | 全体协作者与 agent |

辅助图解：[统一认证与模型访问](<docs/assets/enterprise-authentication-flow.html>)、[工程结构提案](<docs/assets/repository-structure-proposal.html>)。可离线打开，内嵌源稿，不替代受控文档。

## 4. 工程入口

| 命令 | 作用 |
|---|---|
| `pnpm check` | 文档检查、仓库检查与检查器单元测试 |
| `pnpm check:docs` | 元数据、登记一致性、链接与锚点、表格、问题序列 |
| `pnpm check:repo` | 目录结构、工作区配置、模块状态、工作流权限、凭据扫描 |
| `pnpm test:unit` | 检查器正反向用例 |

- 工作区由 `pnpm-workspace.yaml` 声明 `packages/*` 与 `services/*`；根工程 `private`，不发布。
- 无第三方运行时依赖，检查器只用 Node 标准库；Node 版本由 `.node-version` 固定。
- CI 以只读权限执行同一组离线检查，外部动作固定到提交 SHA。

## 5. 关键决策（方案基线 / 待验）

以下概括既定目标路线，不表示接口、安全控制或部署已实现。详细证据和准入条件以[需求基线](<docs/requirements/requirements-baseline.md>)、[架构设计](<docs/architecture/platform-architecture.md>)和[实施计划](<docs/plans/rollout-plan.md>)为准。

- **每人一套 DSH**，一期 3 部门 800 人，Windows 与麒麟各半；不做多租户、macOS 客户端或白标，调整非目标须范围变更并单独立项。
- **模型经企业网关、机构内私有化部署**，客户与生产数据进入上下文须守住 C1–C4。会话正文默认不进安全事件平台，网关/模型正文日志默认关闭；采样和元数据保留数值均待安全及相关团队批准。
- **按资源授权、客户端不持上游 Key**；凭据路径拒绝与执行隔离均为双端待验证目标。本机管理员可改 preset/配置，企业权限仍由服务端鉴权与审批兜底。
- **额度由网关承担**，拟按人（`sub`）与 consumer 双维度约束；DSH 不建第二套账，具体接口和错误语义待回函、联调。
- **外部系统用 MCP，策略用原生插件**；DevOps 目标为 `streamable-http`，Gitee 用本地 `stdio`；门禁与 SDD 路径规则收敛到策略插件。
- **生产写操作两层审批**：本机确认只代表当前操作者，不替代平台审批；`approval=never`、无 UI、取消/拒绝、超时或异常不得视为确认。结果未知时先查单或使用服务端幂等，不盲目重放。
- **可选能力独立停用，安全依赖失效则拒绝**；无法分类的风险工具拒绝，工具自报标签不是授权依据。
- **SDD 只做 skill 包**，守一致性、原子性、可追溯三条不变量。
- **必装走组合包、可选走私有市场**；全员禁公网源，开发者可装内部已审批源，只读/受限角色禁用插件管理。安装、升级、回退与支持能力均须门禁验证。

## 6. 待确认事项

跨域问题按七个团队域与 G0/G1/G2 门禁闭环，并以稳定的 `CONF-<域>-*` 问题 ID 跟踪；以下仅作入口摘要，未回函不视同同意，方向确认不替代实测或门禁签署。

1. IAM 协议、多资源刷新及 RFC 8707 `resource` 支持；替代 client 方案仍须一资源一 token。
2. DevOps canonical URI / PRM、服务端授权、平台审批、幂等/查单及运行维护归属；Gitee 的用户身份和凭据映射。
3. Windows 与银河麒麟的凭据/执行隔离，以及麒麟版本、内核、沙箱、原生模块和安装包实机结果。
4. 网关鉴权、额度、首调用/日活统计与模型兼容性；P1 测量容量基线，G2 阈值由网关/PMO 等有权团队确认。
5. 官方 App 的企业配置、签名/分发与范围变更批准链；白标默认不做，确需则单独立项。
6. 800 人批次、观察起点/可比性、支持资源与事件归属；C3 外发规则、C2/C4 采样和元数据保留、退出与恢复。

## 7. 维护约定

- 结论变化回写主文档对应章节，不追加“进展/更新”式流水账。
- 字段级契约进入 `docs/contracts/`，逐模块设计进入 `docs/design/`，主文档只保留跨域决策。
- 文档改名、升版或状态变化时，同步[文档清单](<docs/DOCUMENT-REGISTER.md>)，并运行 `pnpm check`。
- 文件移动使用 `git mv`，同一变更内更新全部引用；不保留重复正文或旧路径导航桩。
- 本目录独立于其他本地仓库，历史证据以各文档的核验日期为准。


## 修订记录

| 版本 | 日期 | 修订人 | 修订说明 |
|---|---|---|---|
| V1.6.1 | 2026-10-20 | DSH 平台组（代拟） | 统一河洛 Heluo Forge 品牌、工程标识、包名与目录，保留文档编号及上游 DSH 标识 |
