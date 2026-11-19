# 文档清单

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-000 |
| 文档名称 | 文档清单 |
| 版本 | V1.89.0 |
| 文档状态 | 生效 |
| 密级 | — |
| 编制 | DSH 平台组 |
| 负责 | 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-11-19 |
| 门禁 | — |

## 1. 清单

受控文档在正文顶部维护唯一的编号、名称、版本、状态与责任信息。运行 `pnpm docs:catalog` 按编号查看派生清单；命令只读，不生成入库文件。

- [文档地图与治理规则](README.md#22-领域文档职责)
- [需求与场景基线](requirements/requirements-baseline.md) · [总体架构](architecture/platform-architecture.md) · [外部契约](contracts/)
- [逐模块设计](design/README.md) · [实施计划](plans/) · [跨团队协作](collaboration/) · [工程约定](engineering/)
- [运维手册与现场排查](operations/README.md)

### 1.1 辅助图解资源（不另立技术契约）

图解是阅读辅助或历史快照，不代替正文契约、门禁或实测结论。

- [统一认证与模型访问图解](<assets/enterprise-authentication-flow.html>)
- [工程仓库结构设计提案图解](<assets/repository-structure-proposal.html>)
- [网关静态 Key 方案设计](<assets/gateway-credential-options.html>)
- [插件市场功能架构图](<assets/plugin-market-architecture.html>)
- [品牌资产套件（河洛苍螭，方案 B）](<assets/branding/cyber-long/index.html>)
- [开放 Issue 实施路径总览](<assets/issue-implementation-path.html>)

### 1.2 历史核查记录

- [2026-11-16 文档漂移检查记录](engineering/reviews/2026-11-16-drift-report.md)为历史快照；当前结论沿[设计索引 §2.2](design/README.md#22-实现与验证入口)查阅。

### 1.3 无独立正文的保留编号

| 编号 | 名称 | 状态 | 负责 | 门禁或去向 |
|---|---|---|---|---|
| CORP-DSH-CONF-003 | 插件市场企业接入问询函（P0） | 已废止 | 平台组 | 内容已吸收至 DESIGN-007/012 及 P0 取证单，问询草案已废止删除 |
| CORP-DSH-KYLIN-001 | 银河麒麟验证 | 待启动 | 平台组 | G0 前置验证；G2 安装与隔离 |
| CORP-DSH-DIST-001 | 分发与市场 | 待启动 | 平台组 + IT | G2 |
| CORP-DSH-PKG-001 | 终端打包 | 待启动 | 平台组 + IT | G2 |
| CORP-DSH-PILOT-001 | 试点推广 | 待启动 | PMO | G2 |
| CORP-DSH-IAM-001 | IAM 接入 | 待启动 | IAM 团队 | G0 方向及 P0 联调；G1 接入契约；G2 生产运行流程 |
| CORP-DSH-POLICY-001 | 策略与审计 | 待启动 | 安全 + 平台组 | G2 |
| CORP-DSH-DEVOPS-001 | DevOps 接入 | 待启动 | DevOps 团队 | G1 查询契约；G2 受控写批准/验证与运行参数，未准入不开放 |
| CORP-DSH-GITEE-001 | Gitee 接入 | 待启动 | 平台组 | G1 查询契约；G2 受控写批准/验证，未准入默认禁用 |
| CORP-DSH-SDD-001 | SDD 兼容与退役盘点（已完成） | 已废止 | 平台组 | 2026-11-03 完成：包删除、企业依赖与 bin 移除；已安装 profile/制品不动 |

## 2. 维护规则

- 新建、改名、升版、变更状态或有正文的文档废止时，维护正文和受影响的实质链接，不同步本页登记行或版本。
- 只有确需先分配编号而无正文时才登记预留条目；文件落地与移除对应预留行在同一变更完成。无正文的已废止条目保留编号及去向，不得重新分配。
- 文档职责、元数据、状态与版本规则见[文档总览 §6](README.md#6-编写约定)。`pnpm check:docs` 校验元数据、编号唯一性、链接及保留记录。
