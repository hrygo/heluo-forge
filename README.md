# 企业 DSH 研发平台（corp-dsh）

## 项目信息

| 项 | 内容 |
|---|---|
| 项目编号 | CORP-DSH |
| 版本 | V1.0 |
| 状态 | 方案评审 |
| 最后更新 | 2026-10-20 |
| 文档清单 | [DOCUMENT-REGISTER.md](docs/DOCUMENT-REGISTER.md) |
| 范围 | 用 DSH 与 DSH 插件体系承载企业研发体系：身份与授权、模型与成本、工程系统、研发流程、分发与治理 |

## 1. 结论

方案可行，且不需要修改 DSH 核心：企业能力全部落在插件、bundle、MCP、skill 与配置上，唯一的核心修改是 MCP 按请求获取 token。一期按“每人一套 DSH”落地，不做多租户；Windows 使用桌面 App，银河麒麟使用本机 Web。当前不确定性集中在三处：企业 IAM 的 `resource` 支持、DevOps MCP 的 PRM 归属、银河麒麟 aarch64 实机验证。

## 2. 文档地图

| 文档 | 内容 | 主要读者 |
|---|---|---|
| [总体架构设计](docs/platform-architecture.md) | L1 架构：插件形态、软件包组合、领域设计、标准符合性、安全、ADR | 架构评审、各团队负责人 |
| [推广实施方案](docs/rollout-plan.md) | L2 执行：WBS、Fork 选型、验收 A1–A14、风险、待确认事项 | PM、实施团队 |
| [文档清单](docs/DOCUMENT-REGISTER.md) | 全部文档的编号、版本、状态、负责团队与门禁 | 全体 |
| [协作规范](AGENTS.md) | 文档体系、变更流程、验证要求与禁止事项 | 全体协作者与 agent |
| [子文档索引](docs/subdocs/README.md) | 十份团队交付物的入口、责任、门禁与状态 | 各团队负责人 |
| [分层架构图](docs/assets/architecture-layers.png) | 客户端 / 运行时 / 插件 / 平台四层 | 汇报与评审 |
| [能力价值矩阵](docs/assets/capability-value-matrix.png) | 哪些能力随模型与宿主增强而升值 | 决策沟通 |

## 3. 阅读顺序

1. 架构设计 §1–§4：背景、原则、标准符合性、总体架构。
2. 架构设计 §5–§7：插件形态、软件包组合、五个领域。
3. 架构设计 §8–§11：契约、安全、部署、版本。
4. 架构设计 §12：交付组织与子文档分工。
5. 推广实施方案 §4：WBS；§7：验收；§8：风险；§9：待确认事项。

## 4. 关键决策

- **每人一套 DSH**，不做多租户；多租户整块移出一期。
- **令牌直通网关**，客户端不持有上游 Key；一个会话、按资源获取 token。
- **额度由网关承担**，支持按人（`sub`）与 consumer 双维度；DSH 不自建账本。
- **外部系统使用 MCP，策略使用原生插件**；门禁基于 `tools/pre-execute` 与 `guard`，不维护每宿主 hooks。
- **SDD 只做 skill 包**，维护三条不变量（一致性、原子性、可追溯），不做五环产品。
- **必装能力走组合 bundle，可选能力走私有大市场**；公网源不回落。

## 5. 待确认事项

1. 企业 IAM 是否支持 RFC 8707 `resource`；不支持时能否按 audience 预注册 client。
2. DevOps MCP 的 canonical URI 与 Protected Resource Metadata 由谁实现与运维。
3. 银河麒麟的版本、内核、沙箱与原生模块实机结果。
4. 网关验签采用 JWKS 还是 introspection；双维度额度同时超限时的错误表达与查询端点。
5. 是否白标；这决定 Windows 使用官方 App 还是自建 MSI。

## 6. 目录结构

```text
corp-dsh/
├── AGENTS.md
├── README.md
└── docs/
    ├── DOCUMENT-REGISTER.md
    ├── platform-architecture.md
    ├── rollout-plan.md
    ├── subdocs/
    │   ├── README.md
    │   ├── _template.md
    │   └── gateway-contract.md
    └── assets/
        ├── architecture-layers.png
        └── capability-value-matrix.png
```

## 7. 维护约定

- 结论变化回写主文档对应章节，不追加“进展/更新”式流水账。
- 字段级契约、接口清单、运行手册进入子文档（架构设计 §12），主文档只保留跨域决策。
- 文档改名、升版或状态变化时，同步更新 [文档清单](docs/DOCUMENT-REGISTER.md) 与 [子文档索引](docs/subdocs/README.md)。
- 本目录独立于 `本机优化配置` 仓库，不再回链；历史证据以各文档的核验日期为准。
