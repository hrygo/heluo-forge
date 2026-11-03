# 文档清单

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-000 |
| 文档名称 | 文档清单 |
| 版本 | V1.63.3 |
| 文档状态 | 生效 |
| 密级 | — |
| 编制 | DSH 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-11-03 |
| 门禁 | — |

## 1. 清单

| 编号 | 文档名称 | 路径 | 版本 | 状态 | 负责 | 门禁 |
|---|---|---|---|---|---|---|
| CORP-DSH-DOC-000 | 文档清单 | [DOCUMENT-REGISTER.md](<DOCUMENT-REGISTER.md>) | V1.63.3 | 生效 | 平台组 | — |
| CORP-DSH-DOC-001 | 文档总览 | [README.md](<README.md>) | V1.39.2 | 生效 | 平台组 | — |
| CORP-DSH-DOC-002 | 逐模块设计索引 | [design/README.md](<design/README.md>) | V0.37.3 | 生效 | 平台组 | — |
| CORP-DSH-DOC-003 | 运维索引 | [operations/README.md](<operations/README.md>) | V0.4.1 | 生效 | 平台组 | — |
| CORP-DSH-DESIGN-001 | 网关凭据双模式支持设计 | [design/credential-modes.md](<design/credential-modes.md>) | V0.4.0 | 评审稿 | 平台组（代拟） | G1 |
| CORP-DSH-DESIGN-002 | IAM 接入详细设计 | [design/plugins/forge-iam.md](<design/plugins/forge-iam.md>) | V1.17.10 | 草案 | 平台组（代拟） | G0 认领；G1 接入与生命周期契约；G2 双端联调准入 |
| CORP-DSH-DESIGN-003 | 策略与审计详细设计 | [design/plugins/forge-policy.md](<design/plugins/forge-policy.md>) | V0.14.0 | 草案 | 平台组（代拟） | G2 |
| CORP-DSH-DESIGN-004 | 企业组合包详细设计 | [design/plugins/forge-enterprise.md](<design/plugins/forge-enterprise.md>) | V1.5.2 | 草案 | 平台组（代拟） | G2 |
| CORP-DSH-DESIGN-005 | 模型网关接入详细设计 | [design/plugins/forge-gateway.md](<design/plugins/forge-gateway.md>) | V0.4.0 | 草案 | 平台组（代拟） | G2 |
| CORP-DSH-DESIGN-006 | 品牌与外观详细设计 | [design/plugins/forge-brand.md](<design/plugins/forge-brand.md>) | V0.1.1 | 草案 | 平台组（代拟） | G2 |
| CORP-DSH-DESIGN-007 | 企业插件市场（轻量原生索引模式） | [design/plugins/forge-market.md](<design/plugins/forge-market.md>) | V2.2.3 | 评审稿 | 平台组（代拟） | G1 索引接入；G2 三目标安装 |
| CORP-DSH-DESIGN-008 | SDD 兼容与退役设计 | [design/plugins/forge-sdd.md](<design/plugins/forge-sdd.md>) | V0.7.0 | 已废止 | 平台组（代拟） | 已退役：包删除，企业依赖与 bin 移除；无在库交付 |
| CORP-DSH-DESIGN-009 | DevOps 接入详细设计 | [design/plugins/forge-devops.md](<design/plugins/forge-devops.md>) | V0.4.0 | 草案 | 平台组（代拟） | G1 |
| CORP-DSH-DESIGN-010 | Gitee 接入详细设计 | [design/plugins/forge-gitee.md](<design/plugins/forge-gitee.md>) | V0.3.0 | 草案 | 平台组（代拟） | G1 |
| CORP-DSH-DESIGN-011 | DevOps MCP 服务详细设计 | [design/services/devops-mcp.md](<design/services/devops-mcp.md>) | V0.1.3 | 草案 | 平台组（代拟） | G1 |
| CORP-DSH-DESIGN-012 | 插件索引契约（format-1 / AIHUB 交付） | [design/services/market-index.md](<design/services/market-index.md>) | V2.0.1 | 评审稿 | 平台组（代拟） | G1 索引契约；G2 三目标安装 |
| CORP-DSH-DESIGN-013 | 企业研发全流程能力面设计 | [design/plugins/forge-devops-lifecycle.md](<design/plugins/forge-devops-lifecycle.md>) | V0.4.1 | 草案 | 平台组（代拟） | G1 查询核验；G2 受控写另行准入 |
| CORP-DSH-DESIGN-014 | 跨模块冲突收口 | [design/conflict-resolution.md](<design/conflict-resolution.md>) | V0.3.1 | 草案 | 平台组（代拟） | G1 |
| CORP-DSH-DESIGN-015 | DSH 客户端标识（UA）方案设计 | [design/client-identification.md](<design/client-identification.md>) | V0.2.0 | 草案 | 平台组（代拟） | G1 接入契约 |
| CORP-DSH-DESIGN-016 | IAM 机密客户端隔离开发设计 | [design/iam-confidential-isolated.md](<design/iam-confidential-isolated.md>) | V0.3.0 | 草案 | 平台组（代拟） | 用户已批准 source/mock 设计；不开放真实来源与生产 |
| CORP-DSH-DESIGN-017 | IAM 模型与工具隔离消费设计 | [design/iam-consumer-isolated.md](<design/iam-consumer-isolated.md>) | V0.7.0 | 草案 | 平台组（代拟） | 用户已批准完整 source/mock 设计；真实环境关闭，A/B/C/D分段已验收，E根联合已实现，本批本地验收已完成；真实准入未开放 |
| CORP-DSH-IAM-002 | IAM 机密客户端隔离开发契约 | [contracts/iam-client-auth-isolated.md](<contracts/iam-client-auth-isolated.md>) | V0.4.1 | 草案 | 平台组（代拟） | 用户已批准 source/mock 设计；生产 G1 未关闭 |
| CORP-DSH-IAM-003 | IAM 模型与工具隔离消费契约草案 | [contracts/iam-consumer-isolated.md](<contracts/iam-consumer-isolated.md>) | V0.7.0 | 草案 | 平台组（代拟） | 用户已批准 source/mock 设计；见证/许可/合成工具与模型已分段验收，E根联合已实现，本批本地验收已完成；真实准入未开放 |
| CORP-DSH-IAM-004 | IAM 只读状态订阅隔离契约 | [contracts/iam-view-observer-isolated.md](<contracts/iam-view-observer-isolated.md>) | V0.3.0 | 草案 | 平台组（代拟） | 私有接缝已实现并定向验收；真实注册关闭 |
| CORP-DSH-TOOLS-001 | 企业工程工具最小契约 | [contracts/engineering-tools.md](<contracts/engineering-tools.md>) | V0.3.0 | 草案 | 平台组（代拟） | G1 查询映射；G2 受控写准入 |
| CORP-DSH-METRICS-001 | 研发观察事件与上报契约 | [contracts/metrics-events.md](<contracts/metrics-events.md>) | V0.2.4 | 草案 | 平台组（代拟） | G2；指标导出启用前冻结 |
| CORP-DSH-ARCH-001 | 总体架构设计 | [architecture/platform-architecture.md](<architecture/platform-architecture.md>) | V3.2.3 | 评审稿 | 平台组 | G0 |
| CORP-DSH-ARCH-002 | AI 网关个人凭证（静态 Key）接入 | [architecture/gateway-static-key-option.md](<architecture/gateway-static-key-option.md>) | V0.4.0 | 评审稿 | 平台组（代拟） | 历史依据；当前目标见 ADR-16 |
| CORP-DSH-ARCH-003 | 企业插件市场调研与落地建议 | [architecture/plugin-market-research.md](<architecture/plugin-market-research.md>) | V0.3.1 | 草案 | 平台组（代拟） | 历史取证保留；来源与控制面建议由 ADR-11/13 替代 |
| CORP-DSH-ARCH-004 | 插件市场决策：企业 Artifactory + AIHUB 原生索引 | [architecture/plugin-registry-source-decision.md](<architecture/plugin-registry-source-decision.md>) | V2.0.0 | 评审稿 | 平台组（代拟） | 正式技术方案；G1 接入与发行基线核验，G2 安装开放验证 |
| CORP-DSH-ARCH-005 | DSH 与 Agent 模型网关认证方案评审稿 | [architecture/gateway-identity-review.md](architecture/gateway-identity-review.md) | V1.1.0 | 评审稿 | 平台组（代拟） | G0 认领与路线评估；G1 契约；G2 联调与安全准入 |
| CORP-DSH-PLAN-001 | 推广实施方案 | [plans/rollout-plan.md](<plans/rollout-plan.md>) | V4.2.1 | 评审稿 | 平台组 | G0 |
| CORP-DSH-PLAN-002 | 插件市场 P0 接入取证单 | [plans/market-p0-verification.md](<plans/market-p0-verification.md>) | V0.3.0 | 草案 | 平台组（代拟） | G1 |
| CORP-DSH-PLAN-003 | 已关闭任务修复验收台账 | [plans/fix-acceptance-ledger.md](<plans/fix-acceptance-ledger.md>) | V0.1.0 | 草案（代拟，待负责人确认） | 平台组（代拟） | — |
| CORP-DSH-PLAN-004 | IAM 网关联合变更实施计划 | [plans/2026-11-02-iam-gateway-atomic.md](<plans/2026-11-02-iam-gateway-atomic.md>) | V0.1.1 | 草案 | 平台组（代拟） | 本地模拟验收；不授予生产能力 |
| CORP-DSH-PLAN-005 | IAM 默认模型只读编排实施计划 | [plans/2026-11-02-iam-default-model-readonly.md](<plans/2026-11-02-iam-default-model-readonly.md>) | V0.1.1 | 草案 | 平台组（代拟） | 源码与隔离模拟；禁止真实模型设置写入 |
| CORP-DSH-PLAN-006 | IAM 机密客户端隔离开发实施计划 | [plans/2026-11-02-iam-confidential-isolated.md](<plans/2026-11-02-iam-confidential-isolated.md>) | V0.2.0 | 草案 | 平台组（代拟） | 用户已批准 source/mock 设计；真实来源与生产关闭 |
| CORP-DSH-PLAN-007 | IAM 模型与工具隔离消费实施计划 | [plans/2026-11-02-iam-consumer-isolated.md](<plans/2026-11-02-iam-consumer-isolated.md>) | V0.6.0 | 草案 | 平台组（代拟） | 完整 source/mock 设计已获用户批准；不动真实环境 |
| CORP-DSH-PLAN-008 | IAM 下一阶段收尾计划 | [plans/2026-11-03-iam-mock-closeout.md](<plans/2026-11-03-iam-mock-closeout.md>) | V0.6.0 | 草案 | 平台组（代拟） | 最小订阅source/mock已实现并定向验收；真实注册、真实Client接线与probe不开放 |
| CORP-DSH-PLAN-009 | SDD 退出实施计划 | [plans/2026-11-03-sdd-retirement-implementation.md](<plans/2026-11-03-sdd-retirement-implementation.md>) | V0.2.0 | 草案 | 项目负责人（代拟） | 待用户授权实施；退役前完成调用方盘点与回退演练 |
| CORP-DSH-PLAN-010 | 多端凭据存储实现与验收方案 | [plans/2026-11-03-credential-multiplatform.md](<plans/2026-11-03-credential-multiplatform.md>) | V0.6.1 | 草案 | 平台组（代拟） | A 已实现并在本机 macOS 取证（组合探针 18/18）；B 原生样机已实现、仅合成用例；G1 枚举/容量/事务/可信装配未关闭；G2 Windows/UOS/麒麟未验 |
| CORP-DSH-PLAN-011 | IAM 相关 Issue 整体实施计划 | [plans/2026-11-04-iam-issues-implementation.md](<plans/2026-11-04-iam-issues-implementation.md>) | V0.1.0 | 草案 | 平台组（代拟） | 仓库内工作项按里程碑实施；硬件与外部接口依赖项保持 BLOCKED |
| CORP-DSH-REQ-001 | 需求与场景基线 | [requirements/requirements-baseline.md](<requirements/requirements-baseline.md>) | V3.0.1 | 评审稿 | 平台组 | G0 |
| CORP-DSH-REQ-002 | Issue 交付单元与研发职责调整方案 | [requirements/issue-delivery-adjustment-proposal.md](<requirements/issue-delivery-adjustment-proposal.md>) | V1.0.1 | 生效 | 项目负责人（当前用户） | 需求决定已确认；技术缺口按 G1/G2 验证，实际退役实施另列任务 |
| CORP-DSH-GW-001 | AI 网关契约 | [contracts/gateway-contract.md](<contracts/gateway-contract.md>) | V2.0.0 | 评审稿 | 网关团队 | G0 方向与 P0 联调；G1 接入契约；G2 运行参数、联调与安全准入 |
| CORP-DSH-ENG-001 | 工程仓库结构与长期迭代设计 | [engineering/repository-structure-design.md](<engineering/repository-structure-design.md>) | V0.7.1 | 草案 | 平台组（代拟） | 工程整理已获准并完成；业务仍按 G0—G3 |
| CORP-DSH-ENG-002 | 工程开发与发布约定 | [engineering/development-conventions.md](<engineering/development-conventions.md>) | V0.6.7 | 草案 | 平台组（代拟） | 随首个可发布包复核 |
| CORP-DSH-CONF-001 | 跨团队确认询问函 | [collaboration/team-confirmation-letters.md](<collaboration/team-confirmation-letters.md>) | V0.13.2 | 草案 | 平台组统筹，各团队回函 | G0分流；G1/G2关闭技术与运行事项；G3试点评估 |
| CORP-DSH-CONF-002 | 私有化 Gitee 内部插件源码接入问询函 | [collaboration/gitee-market-clarification.md](<collaboration/gitee-market-clarification.md>) | V0.3.0 | 草案 | 平台组（代拟）；Gitee 团队回函 | G1 源码接口联调前；G2 开放前确认运行事项 |
| CORP-DSH-CONF-003 | 插件市场企业接入问询函（P0） | 已废止 | — | 废止 | 平台组 | 内容已吸收至 DESIGN-007/012 及 P0 取证单，问询草案已废止删除 |
| CORP-DSH-CONF-004 | IAM 统一登录与权限接入问询函 | [collaboration/iam-confirmation-letter.md](<collaboration/iam-confirmation-letter.md>) | V0.6.3 | 草案 | 平台组（代拟）；IAM 团队答复；实施协调汇总 | G0 方向与认领；G1 身份登录与令牌闭环；G2 撤销与登出联动 |
| CORP-DSH-CONF-005 | DSH 和应用 Agent 调用 AI 网关补充问询函 | [collaboration/gateway-confirmation-letter.md](collaboration/gateway-confirmation-letter.md) | V0.5.0 | 草案 | 平台组（代拟）；网关团队答复；实施协调汇总 | G0 认领与能力评估；G1 契约；G2 联调准入 |
| CORP-DSH-CONF-006 | DSH 研发助手接入企业 IAM 确认函 | [collaboration/iam-access-confirmation.md](<collaboration/iam-access-confirmation.md>) | V0.5.1 | 草案 | 平台组（代拟）；IAM 团队确认；实施协调汇总 | G1 身份登录与令牌闭环；G2 撤销与登出联动 |
| CORP-DSH-KYLIN-001 | 银河麒麟验证 | 待创建 | — | 待启动 | 平台组 | G0 前置验证；G2 安装与隔离 |
| CORP-DSH-DIST-001 | 分发与市场 | 待创建 | — | 待启动 | 平台组 + IT | G2 |
| CORP-DSH-PKG-001 | 终端打包 | 待创建 | — | 待启动 | 平台组 + IT | G2 |
| CORP-DSH-PILOT-001 | 试点推广 | 待创建 | — | 待启动 | PMO | G2 |
| CORP-DSH-IAM-001 | IAM 接入 | 待创建 | — | 待启动 | IAM 团队 | G0 方向及 P0 联调；G1 接入契约；G2 生产运行流程 |
| CORP-DSH-POLICY-001 | 策略与审计 | 待创建 | — | 待启动 | 安全 + 平台组 | G2 |
| CORP-DSH-DEVOPS-001 | DevOps 接入 | 待创建 | — | 待启动 | DevOps 团队 | G1 查询契约；G2 受控写批准/验证与运行参数，未准入不开放 |
| CORP-DSH-GITEE-001 | Gitee 接入 | 待创建 | — | 待启动 | 平台组 | G1 查询契约；G2 受控写批准/验证，未准入默认禁用 |
| CORP-DSH-SDD-001 | SDD 兼容与退役盘点（已完成） | 已归档（无独立正文） | — | 已废止 | 平台组 | 2026-11-03 完成：包删除、企业依赖与 bin 移除；已安装 profile/制品不动 |

### 1.1 辅助图解资源（不另立技术契约）

| 资源 | 路径 | 关联主文档 | 用途与边界 |
|---|---|---|---|
| 统一认证与模型访问图解 | [enterprise-authentication-flow.html](<assets/enterprise-authentication-flow.html>) | [总体架构设计](<architecture/platform-architecture.md>)§7.1—§7.2 | 可离线浏览的辅助说明，包含总体关系及5类详细流程；模型访问为历史示意，当前 A/B 路线按 ADR-16 及 ARCH-005 评审，尚未选定；不能据图认定能力已具备；不替代受控方案、正式契约或企业实测 |
| 工程仓库结构设计提案图解 | [repository-structure-proposal.html](<assets/repository-structure-proposal.html>) | [工程结构设计](<engineering/repository-structure-design.md>) | 工程整理时点的目录与迁移摘要；当前市场实现见设计索引，图解不作实时清单 |
| 网关静态 Key 方案设计 | [gateway-credential-options.html](<assets/gateway-credential-options.html>) | [个人凭证接入](<architecture/gateway-static-key-option.md>)、[网关契约](<contracts/gateway-contract.md>)§4 | 2026-10-20 原静态 Key 提议（`csk_`/API/HMAC/设备头）的辅助图解；已被 2026-10-22 ADR-14 的 UAG 个人凭证方案取代，仅作历史参考，不替代正文 |
| 插件市场功能架构图 | [plugin-market-architecture.html](<assets/plugin-market-architecture.html>) | [轻量市场设计](<design/plugins/forge-market.md>)、[索引契约](<design/services/market-index.md>)、[ADR-11／13](<architecture/plugin-registry-source-decision.md>) | 轻量原生索引示意：AIHUB 索引、原生索引源、官方 manager、Artifactory、能/不能保证与验收；评审稿示意，不替代正文、企业接入或门禁证据 |
| 品牌资产套件（河洛苍螭，方案 B） | [branding/cyber-long/index.html](<assets/branding/cyber-long/index.html>) | [品牌与外观详细设计](<design/plugins/forge-brand.md>) | 现存的唯一预置品牌资产：主标、11 个组件标识与多分辨率切图，配 `manifest.json` 校验清单与 `usage.txt` 使用规则；状态为建议稿（代拟），方案 B 由用户选定，正式审核与批准待定；组件标识只描述职责，不表示对应模块已实现、已部署或已批准；`packages/forge-iam/icon.svg` 逐字节取自其中 `forge-iam-symbol.svg`，由 `packages/forge-iam/test/package-shape.test.mjs` 校验 |
| 开放 Issue 实施路径总览 | [issue-implementation-path.html](<assets/issue-implementation-path.html>) | [推广实施方案](<plans/rollout-plan.md>)、[设计索引](<design/README.md>) | 2026-10-23 对 GitHub Issue #12、#13、#15、#20—#40 的辅助分析：紧迫性、实施条件、ROI 与依赖，含阶段 0—3 与一条并行流；人日为工程粗估，不含跨团队等待与审批，不构成日历承诺；Issue 状态以 GitHub 为准，图解不替代受控正文、门禁证据或责任方裁定 |

## 2. 维护规则

- 平台名称为“河洛 / Heluo Forge”，工程标识为 `heluo-forge`；以下编号体系保持连续，不因品牌更名重新编号。
- 编号格式：`CORP-DSH-<域>-<三位序号>`，域使用大写英文缩写。
- 本表负责登记；文档职责、元数据、状态与版本规则统一见[文档总览 §6](README.md#6-编写约定)。
- 新增、改名、升版或状态变化时，同步更新本表与受影响的总览条目，不把历史版本引用改成当前版本。
- 文档状态取值：待启动 / 草案 / 评审稿 / 生效 / 已废止。
- 已废止文档保留条目与路径，不删除历史编号。
- 本表与文档元数据的一致性由 `scripts/check-docs.mjs` 校验，不靠人工比对。
