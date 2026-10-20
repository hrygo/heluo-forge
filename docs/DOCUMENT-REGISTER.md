# 文档清单

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-000 |
| 文档名称 | 文档清单 |
| 版本 | V1.5 |
| 文档状态 | 生效 |
| 密级 | 内部 |
| 编制 | DSH 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-10-20 |
| 门禁 | — |

## 修订记录

| 版本 | 日期 | 修订人 | 修订说明 |
|---|---|---|---|
| V1.0 | 2026-10-20 | DSH 平台组 | 建立全库受控文档清单 |
| V1.1 | 2026-10-20 | DSH 平台组 | 纳管需求与场景基线（CORP-DSH-REQ-001），同步主文档与网关契约版本号 |
| V1.2 | 2026-10-20 | DSH 平台组 | 对齐架构、实施计划、需求基线与网关契约当前版本；移除未纳入仓库的询问函条目 |
| V1.3 | 2026-10-20 | DSH 平台组 | 询问函编号保留为待启动，不将未纳入本次推送的草稿作为仓库入口；同步受控文档的当前版本 |
| V1.4 | 2026-10-20 | DSH 平台组 | 对齐子文档索引 V1.4，保留询问函待创建状态 |
| V1.5 | 2026-10-20 | DSH 平台组 | 纳管已存在的跨团队确认询问函V0.2草案，更新子文档索引V1.5；保留原预留编号及全部历史，不改变既有方案或审批状态 |

## 1. 清单

| 编号 | 文档名称 | 路径 | 版本 | 状态 | 负责 | 门禁 |
|---|---|---|---|---|---|---|
| CORP-DSH-DOC-000 | 文档清单 | [DOCUMENT-REGISTER.md](<DOCUMENT-REGISTER.md>) | V1.5 | 生效 | 平台组 | — |
| CORP-DSH-ARCH-001 | 总体架构设计 | [platform-architecture.md](platform-architecture.md) | V1.3 | 评审稿 | 平台组 | G0 |
| CORP-DSH-PLAN-001 | 推广实施方案 | [rollout-plan.md](rollout-plan.md) | V1.2 | 评审稿 | 平台组 | G0 |
| CORP-DSH-REQ-001 | 需求与场景基线 | [requirements-baseline.md](requirements-baseline.md) | V1.2 | 评审稿 | 平台组 | G0 |
| CORP-DSH-DOC-001 | 子文档索引 | [subdocs/README.md](<subdocs/README.md>) | V1.5 | 生效 | 平台组 | — |
| CORP-DSH-GW-001 | AI 网关契约 | [subdocs/gateway-contract.md](<subdocs/gateway-contract.md>) | V0.8 | 草案 | 网关团队 | G0 |
| CORP-DSH-IAM-001 | IAM 接入 | 待创建 | — | 待启动 | IAM 团队 | G0 |
| CORP-DSH-KYLIN-001 | 银河麒麟验证 | 待创建 | — | 待启动 | 平台组 | G0 |
| CORP-DSH-DEVOPS-001 | DevOps MCP | 待创建 | — | 待启动 | DevOps 团队 | G1 |
| CORP-DSH-GITEE-001 | Gitee 集成 | 待创建 | — | 待启动 | 平台组 | G1 |
| CORP-DSH-POLICY-001 | 策略与审计 | 待创建 | — | 待启动 | 安全 + 平台组 | G2 |
| CORP-DSH-DIST-001 | 分发与市场 | 待创建 | — | 待启动 | 平台组 + IT | G2 |
| CORP-DSH-PKG-001 | 终端打包 | 待创建 | — | 待启动 | 平台组 + IT | G2 |
| CORP-DSH-SDD-001 | SDD 流程 | 待创建 | — | 待启动 | 平台组 | G2 |
| CORP-DSH-PILOT-001 | 试点推广 | 待创建 | — | 待启动 | PMO | G2 |
| CORP-DSH-CONF-001 | 跨团队确认询问函 | [subdocs/team-confirmation-letters.md](<subdocs/team-confirmation-letters.md>) | V0.2 | 草案 | 平台组统筹，各团队回函 | G0分流；G1/G2关闭技术与运行事项；G3试点评估 |

## 2. 维护规则

- 编号格式：`CORP-DSH-<域>-<三位序号>`，域使用大写英文缩写。
- 新增、改名、升版或状态变化时，同步更新本表与子文档索引。
- 文档状态取值：待启动 / 草案 / 评审稿 / 生效 / 已废止。
- 已废止文档保留条目与路径，不删除历史编号。
