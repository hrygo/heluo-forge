# 企业 DSH 研发平台（corp-dsh）

> 文档类型：项目入口（非 SSOT）
>
> 状态：方案定稿（待关键决策确认），未实施
>
> 最后核验：2026-10-20
>
> 范围：用 DSH 与 DSH 插件体系承载企业研发体系——身份与授权、模型与成本、工程系统、研发流程、分发与治理

## 结论

方案可行，且不需要 fork DSH 核心：企业能力全部落在插件、bundle、MCP、skill 与配置上，唯一的核心补丁是 MCP 按请求取 token。一期按“每人一套 DSH”落地，不做多租户；Windows 走桌面 App，银河麒麟走本机 Web。真正的不确定性只剩三处：企业 IAM 的 `resource` 支持、DevOps MCP 的 PRM 归属、麒麟 aarch64 实机。

## 文档地图

| 文档 | 内容 | 主要读者 |
|---|---|---|
| [平台设计](docs/2026-10-20-dsh-enterprise-platform-design.md) | L1 架构：六种插件形态、包组合、五个领域设计、标准对齐、安全、ADR | 架构评审、各团队负责人 |
| [推广方案](docs/2026-10-20-dsh-enterprise-rollout.md) | 执行：WBS、fork 选型、验收 A1–A14、风险、开放问题 | PM、实施团队 |
| [分层架构图](docs/assets/2026-10-20-dsh-enterprise-architecture.png) | 客户端 / 运行时 / 插件 / 平台四层 | 汇报与评审 |
| [价值四象限](docs/assets/2026-10-20-dsh-value-quadrant.png) | 哪些能力随模型/宿主增强而升值 | 决策沟通 |

## 阅读顺序

1. 设计稿 §1–§3：问题、原则、总体架构。
2. 设计稿 §4–§6：插件形态映射、包组合、五个领域。
3. 设计稿 §7–§10：契约、安全、部署、版本。
4. 推广方案：WBS、验收、风险。
5. 设计稿 §11：子文档清单与团队责任。

## 关键决策

- **每人一套 DSH**，不做多租户；多租户整块移出一期。
- **令牌直通网关**，客户端不持有上游 Key；一个会话、按资源取 token。
- **额度由网关承担**，支持按人（`sub`）与 consumer 双维度；DSH 不自建账本。
- **外部系统用 MCP，策略用原生插件**；门禁用 `tools/pre-execute` + `guard`，不用每宿主 hooks。
- **SDD 只做 skill 包**，守三条不变量（一致性、原子性、可追溯），不做五环产品。
- **必装走 umbrella bundle，可选走私有市场**；公网源不回落。

## 未决事项

1. 企业 IAM 是否支持 RFC 8707 `resource`；不支持时能否按 audience 预注册 client。
2. DevOps MCP 的 canonical URI 与 Protected Resource Metadata 由谁实现与运维。
3. 银河麒麟的版本、内核、沙箱与原生模块实机结果。
4. 网关验签用 JWKS 还是 introspection；双维度额度同时超限时的错误表达与查询端点。
5. 是否白标；这决定 Windows 走官方 App 还是自建 MSI。

## 目录

```text
corp-dsh/
├── README.md
└── docs/
    ├── 2026-10-20-dsh-enterprise-platform-design.md
    ├── 2026-10-20-dsh-enterprise-rollout.md
    └── assets/
        ├── 2026-10-20-dsh-enterprise-architecture.png
        └── 2026-10-20-dsh-value-quadrant.png
```

## 维护约定

- 结论变化回写主文档对应章节，不追加“进展/更新”式流水账。
- 字段级契约、接口清单、运行手册进子文档（设计稿 §11），主文档只留跨域决策。
- 本目录独立于 `本机优化配置` 仓库，不再回链；历史证据以各自文档的“最后核验”为准。
