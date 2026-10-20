# 文档总览

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-001 |
| 文档名称 | 文档总览 |
| 版本 | V1.8 |
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
| V1.0 | 2026-10-20 | DSH 平台组 | 初版十份团队交付物索引 |
| V1.1 | 2026-10-20 | DSH 平台组 | 补齐文档信息与修订记录；同步网关契约、Gitee 集成与终端打包待回答事项 |
| V1.2 | 2026-10-20 | DSH 平台组 | 同步最终需求基线 V1.2、网关草案 V0.8 与主方案版本；纳入七域询问函协作入口，区分十份技术交付物与回函闭环，不以回函代替契约、实测或门禁批准 |
| V1.3 | 2026-10-20 | DSH 平台组 | 询问函未纳入本次仓库，保留其预留编号与问题域跟踪说明，不引用未提交文件 |
| V1.4 | 2026-10-20 | DSH 平台组 | 补齐当前元数据版本的修订记录，保留既有并行历史；函件纳管及入口一致性尚待统一协调，不据本版宣称已关闭 |
| V1.5 | 2026-10-20 | DSH 平台组 | 将已生成的跨团队询问函V0.2登记为独立协作入口，纠正需求与网关版本引用，保留十份技术交付物边界及既有历史 |
| V1.6 | 2026-10-20 | DSH 平台组 | 增加仓库内统一认证与模型访问HTML辅助图解入口，保持十份技术交付物与询问函的独立边界 |
| V1.7 | 2026-10-20 | DSH 平台组 | 增加独立的工程治理设计草案与图解入口；保持十份领域交付物边界，不表示目录迁移或插件开发已完成 |
| V1.8 | 2026-10-20 | DSH 平台组 | 升级为文档总入口：按需求、架构、计划、设计、契约、运维、协作、工程分类，保留十份领域交付物与回函边界；引用迁移后路径，新增设计与运维索引 |

## 1. 结论

文档按读者和变更频率分类：范围与指标、跨域架构、实施计划、字段级契约、逐模块设计、运行与发布、跨团队协作、工程约定分别成目录，不再堆在单一子文档目录。

[需求与场景基线](<requirements/requirements-baseline.md>)仍是范围与指标的唯一真源；[总体架构](<architecture/platform-architecture.md>)只保留跨域决策与摘要；字段级契约维护在 `contracts/`。细节冲突时以对应契约文档为准，L1 不复制字段。

分类只改变文件的维护位置，不改变文档编号、历史修订、审批状态或任何业务口径。

## 2. 文档地图

| 目录 | 内容 | 入口 | 主要读者 |
|---|---|---|---|
| `requirements/` | 范围、画像、场景、需求与指标 | [需求与场景基线](<requirements/requirements-baseline.md>) | 业务方、PM、安全、试点用户 |
| `architecture/` | 跨域决策、信任边界、领域设计、ADR | [总体架构设计](<architecture/platform-architecture.md>) | 架构评审、各团队负责人 |
| `plans/` | 关键路径、门禁证据、验收与试点运行 | [推广实施方案](<plans/rollout-plan.md>) | PM、实施团队 |
| `design/` | 逐模块详细设计的索引与状态 | [设计索引](<design/README.md>) | 插件与服务开发者 |
| `contracts/` | 外部系统字段级契约 | [AI 网关契约](<contracts/gateway-contract.md>) | 网关、模型与安全团队 |
| `operations/` | 分发、发布、回滚、支持和运行手册 | [运维索引](<operations/README.md>) | 平台运维、IT |
| `collaboration/` | 跨团队询问与回函协作 | [跨团队确认询问函](<collaboration/team-confirmation-letters.md>) | 发函人、各接入团队 |
| `engineering/` | 仓库结构、开发测试与发布约定 | [工程结构设计](<engineering/repository-structure-design.md>) | 工程负责人、维护者 |
| `templates/` | 受控文档与模块设计模板 | [_template.md](<templates/_template.md>) | 全体撰写人 |
| `assets/` | 可离线打开的 HTML 图解 | [认证流程图解](<assets/enterprise-authentication-flow.html>) | 评审与对接人员 |

文档编号、版本与责任团队统一登记在[文档清单](<DOCUMENT-REGISTER.md>)。

## 3. 领域技术交付物

下列十份交付物承载字段级契约或运行手册；标“待启动”的由负责团队按[模板](<templates/_template.md>)起草，过门禁后只在决策变化时回写架构。

| 编号 | 交付物 | 文件 | 负责 | 门禁 | 状态 | 必须先回答 |
|---|---|---|---|---|---|---|
| CORP-DSH-IAM-001 | IAM 接入 | 待创建 | IAM 团队 | G0 | 待启动 | `resource` 支持、claims、client 注册、TTL、撤销 |
| CORP-DSH-GW-001 | AI 网关契约（V0.8.1） | [gateway-contract.md](<contracts/gateway-contract.md>) | 网关团队 | G0 | 草案 | 验签方式、consumer 生命周期、双维度额度、429 契约、C1/C4 与待批准保留期；方向回函不替代 G1/G2 冻结与验证 |
| CORP-DSH-KYLIN-001 | 银河麒麟验证 | 待创建 | 平台组 | G0 | 待启动 | 内核、沙箱、原生模块、浏览器 |
| CORP-DSH-DEVOPS-001 | DevOps MCP | 待创建 | DevOps 团队 | G1 | 待启动 | 工具清单、scope、PRM、错误码、生产异步审批单对接 |
| CORP-DSH-GITEE-001 | Gitee 集成 | 待创建 | 平台组 | G1 | 待启动 | 版本、arm64 构建、IAM 身份映射或凭据方案、写操作开关 |
| CORP-DSH-POLICY-001 | 策略与审计 | 待创建 | 安全 + 平台组 | G2 | 待启动 | 规则、`$DSH_HOME` 硬拒绝、客户数据外发确认（C3）、决策 schema、保留期 |
| CORP-DSH-DIST-001 | 分发与市场 | 待创建 | 平台组 + IT | G2 | 待启动 | registry、index、通道、回滚 |
| CORP-DSH-PKG-001 | 终端打包 | 待创建 | 平台组 + IT | G2 | 待启动 | MSI 自助安装/MDM、deb/apt/`systemd --user` 与 `dsh-web-open` 启动脚本 |
| CORP-DSH-SDD-001 | SDD 流程 | 待创建 | 平台组 | G2 | 待启动 | skill、CLI、CI、产物契约 |
| CORP-DSH-PILOT-001 | 试点推广 | 待创建 | PMO | G2 | 待启动 | 3 部门 800 人分批计划、指标采集、支持渠道、退出条件 |

## 4. 协作与工程入口

| 入口 | 文档 | 用途与边界 |
|---|---|---|
| 跨团队回函 | [跨团队确认询问函](<collaboration/team-confirmation-letters.md>) | 七封可独立转发的正文、47 项稳定问题；回函核验后写入技术契约，不自动构成准入 |
| 仓库结构 | [工程仓库结构与长期迭代设计](<engineering/repository-structure-design.md>) | 目录、模块边界、迁移与私有市场分层；已批准实施，业务能力仍按门禁验证 |
| 开发约定 | [工程开发与发布约定](<engineering/development-conventions.md>) | 分支、提交、测试分层、版本与发布边界 |
| 逐模块设计 | [设计索引](<design/README.md>) | 九个安装包与两个独立服务的详细设计状态与路径 |
| 运维入口 | [运维索引](<operations/README.md>) | 分发、发布、回滚、支持的待建交付物 |

辅助图解：[统一认证与模型访问](<assets/enterprise-authentication-flow.html>)、[工程结构提案](<assets/repository-structure-proposal.html>)。两者可离线打开并保留页面源稿，不替代受控文档。

## 5. 阅读顺序

1. [需求与场景基线](<requirements/requirements-baseline.md>) §1–§6：先定范围、人群与指标。
2. [总体架构设计](<architecture/platform-architecture.md>) §1–§7：原则、总体架构、插件形态与五个领域。
3. [推广实施方案](<plans/rollout-plan.md>) §4–§8：关键路径、验收、风险与试点运行。
4. [AI 网关契约](<contracts/gateway-contract.md>) §4：验签、额度与错误语义。
5. [设计索引](<design/README.md>) 与[开发约定](<engineering/development-conventions.md>)：进入实现前的模块边界与工程规则。
6. [跨团队确认询问函](<collaboration/team-confirmation-letters.md>) §4：按收件团队选择正文，填写联系人、期限与署名后转发。

## 6. 编写约定

- 受控文档按[模板](<templates/_template.md>)填写文档信息、修订记录、编制依据与关联文档。
- 逐模块设计按[模块设计模板](<templates/design-template.md>)撰写，覆盖接口核验、权限、生命周期与测试。
- 结论先行；契约使用表格或示例，不写背景铺垫；待确认项单独成节。
- 子文档之间不复制同一份契约，用相对链接引用；链接必须可在仓库内解析。
- 新增、改名或升版时同步[文档清单](<DOCUMENT-REGISTER.md>)，并由清单校验检查一致性。