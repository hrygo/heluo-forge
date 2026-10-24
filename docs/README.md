# 文档总览

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-001 |
| 文档名称 | 文档总览 |
| 版本 | V1.21.7 |
| 文档状态 | 生效 |
| 密级 | — |
| 编制 | DSH 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-10-25 |
| 门禁 | — |

## 1. 结论

本文档集服务于河洛企业级智能研发平台（Heluo Forge），工程标识统一为 `heluo-forge`；`CORP-DSH-*` 文档编号保持不变。

文档按读者和变更频率分类：范围与指标、跨域架构、实施计划、字段级契约、逐模块设计、运行与发布、跨团队协作、工程约定分别成目录，不再堆在单一子文档目录。

[需求与场景基线](<requirements/requirements-baseline.md>)是范围与指标的唯一真源；[总体架构](<architecture/platform-architecture.md>)保留跨域决策与摘要；字段级契约维护在 `contracts/`。内容按职责归属维护，具体冲突处理见 §6.2，不能仅凭 L1/L2/L3 层级或文档详细程度覆盖已有决策。

本总览负责文档导航、内容归属与治理规则；编号、路径、版本和状态的登记由[文档清单](DOCUMENT-REGISTER.md)维护。入口调整不改变业务范围、版本号或已有审批记录。

当前仓库已从纯方案推进到轻量市场接入准备：索引契约、P0 取证单与 AIHUB issue #12 已建立，市场模式与当前状态见[索引契约 §1](<design/services/market-index.md#1-一页速览>)；代码存在或本地检查通过不代表 G0–G3 获批。DevOps/Gitee 按现有 CLI 只读基线评审，MCP 服务与核心补丁为条件项。

## 2. 文档地图

### 2.1 仓库入口职责

| 文件 | 负责 | 内容边界 |
|---|---|---|
| [根 README](../README.md) | 项目是什么、成熟度、起步命令与阅读入口 | 不维护架构决策清单、契约字段或完整待确认台账 |
| [AGENTS.md](../AGENTS.md) | agent 的任务路由、授权边界、修改与验收要求 | 不复制贡献手册、文档元数据规范或本机个人配置 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 贡献者环境准备、变更流程与评审提交 | 文档规则引用本总览；工程细则引用开发约定 |
| [SECURITY.md](../SECURITY.md) | 安全报告、敏感信息处理与支持范围 | 不虚构联系人，不承载业务系统的完整安全设计 |
| 本总览 / [文档清单](DOCUMENT-REGISTER.md) | 总览管导航与治理；清单管编号及生命周期登记 | 索引摘要不代替原文；版本、状态变化时同步相关入口 |

### 2.2 领域文档职责

| 目录 | 内容 | 入口 | 主要读者 |
|---|---|---|---|
| `requirements/` | 范围、画像、场景、需求与指标 | [需求与场景基线](<requirements/requirements-baseline.md>) | 业务方、PM、安全、试点用户 |
| `architecture/` | 跨域决策、信任边界、领域设计、ADR | [总体架构设计](<architecture/platform-architecture.md>)；[专用访问评审](architecture/gateway-identity-review.md)，[静态 Key 接入](architecture/gateway-static-key-option.md)仅保留历史依据 | 架构评审、各团队负责人 |
| `plans/` | 关键路径、门禁证据、验收与试点运行 | [推广实施方案](<plans/rollout-plan.md>)；市场侧 [P0 接入取证单](<plans/market-p0-verification.md>) | PM、实施团队 |
| `design/` | 逐模块详细设计的索引与状态 | [设计索引](<design/README.md>) | 插件与服务开发者 |
| `contracts/` | 外部系统字段级契约 | [AI 网关契约](<contracts/gateway-contract.md>) | 网关、模型与安全团队 |
| `operations/` | 分发、发布、回滚、支持和运行手册 | [运维索引](<operations/README.md>) | 平台运维、IT |
| `collaboration/` | 跨团队询问与回函协作 | [跨团队确认询问函](<collaboration/team-confirmation-letters.md>) | 发函人、各接入团队 |
| `engineering/` | 仓库结构、开发测试与发布约定 | [工程结构设计](<engineering/repository-structure-design.md>) | 工程负责人、维护者 |
| `templates/` | 受控文档与模块设计模板 | [_template.md](<templates/_template.md>) | 全体撰写人 |
| `assets/` | 可离线打开的 HTML 图解与品牌资产 | [认证流程图解](<assets/enterprise-authentication-flow.html>)；品牌见[品牌全景](<assets/branding/cyber-long/index.html>)与[生图规范](<assets/branding/prompts.md>) | 评审与对接人员 |

文档编号、版本与责任团队统一登记在[文档清单](<DOCUMENT-REGISTER.md>)。

## 3. 领域技术交付物

十份交付物中标注“待创建”的由负责团队按[模板](<templates/_template.md>)起草，过门禁后只在决策变化时回写架构。交付物的负责方、门禁与状态以[文档清单](<DOCUMENT-REGISTER.md>)为唯一真源；本表不复制这三项，只保留各交付物启动前必须先回答的问题。

| 编号 | 交付物 | 文件 | 必须先回答 |
|---|---|---|---|
| CORP-DSH-IAM-001 | IAM 接入 | 待创建 | `resource` 支持、claims、client 注册、TTL、撤销 |
| CORP-DSH-GW-001 | AI 网关契约（V1.0.0） | [gateway-contract.md](<contracts/gateway-contract.md>) | 当前人员与用途、A/B 候选、应用受控开通、IP、五分钟撤权/单授权退出及 C1/C4；能力待核验，不以历史 key-auth 调通代替 |
| CORP-DSH-KYLIN-001 | 银河麒麟验证 | 待创建 | 内核、沙箱、原生模块、浏览器 |
| CORP-DSH-DEVOPS-001 | DevOps CLI 接入 | 待创建 | 系统变更查询契约；澄清/进展受控写的范围、C3分类及版本/回查待批待验；CLI 不足时另评替代形态 |
| CORP-DSH-GITEE-001 | Gitee CLI 接入 | 待创建 | CLI/双端产物、查询清单、JSON/凭据；常规研发/评审写范围、C3分类、可信来源及回查待批待验 |
| CORP-DSH-POLICY-001 | 策略与审计 | 待创建 | 规则、`$DSH_HOME` 硬拒绝、客户数据外发确认（C3）、决策 schema、保留期 |
| CORP-DSH-DIST-001 | 分发与市场 | 待创建 | registry、index、通道、回滚 |
| CORP-DSH-PKG-001 | 终端打包 | 待创建 | MSI 自助安装/MDM、deb/apt/`systemd --user` 与 `dsh-web-open` 启动脚本 |
| CORP-DSH-SDD-001 | SDD 流程 | 待创建 | skill、CLI、CI、产物契约 |
| CORP-DSH-PILOT-001 | 试点推广 | 待创建 | 3 部门 800 人分批计划、指标采集、支持渠道、退出条件 |

企业研发跨模块草案：[全流程能力设计](design/plugins/forge-devops-lifecycle.md)、[工具动作契约](contracts/engineering-tools.md)、[观察事件契约](contracts/metrics-events.md)。覆盖已确认受控写目标与待审批项，不改变上述十项团队交付物的负责关系，也不代表接口已核验。

## 4. 协作与工程入口

| 入口 | 文档 | 用途与边界 |
|---|---|---|
| 跨团队回函 | [跨团队确认询问函](<collaboration/team-confirmation-letters.md>) | 原七域及专项子函路由；本轮网关新函、IAM 原函补充；回函核验后写契约，不自动准入 |
| 市场方案 | [轻量市场设计](<design/plugins/forge-market.md>)、[索引契约](<design/services/market-index.md>) | 评审稿；市场模式与当前状态见[索引契约 §1](<design/services/market-index.md#1-一页速览>)；不等企业批准或上线 |
| AIHUB 索引交付 | [issue #12](https://github.com/hrygo/heluo-forge/issues/12) | 外部交付 issue：URL、format-1、registry、更新/撤回时限、三目标联调；作为验收跟踪，不替代企业批准 |
| 市场来源与索引 | [企业 Artifactory + AIHUB 原生索引决策](<architecture/plugin-registry-source-decision.md>) | ADR-11/13 已确认唯一制品源与轻量索引；市场模式与当前状态见[索引契约 §1](<design/services/market-index.md#1-一页速览>)；索引交付、三目标安装与全通道边界仍需验 |
| 市场调研 | [企业插件市场调研与落地建议](<architecture/plugin-market-research.md>) | 保留社区/官方证据；原Gitee制品和复杂审批控制面建议已由ADR-11替代 |
| Gitee 市场专题问询 | [私有化 Gitee 内部插件源码接入问询函](<collaboration/gitee-market-clarification.md>) | 仅内部定制源码group/repo/commit、权限与来源证据；npm同步/下载归企业仓库方，不代发或代表批准 |
| IAM 登录与权限专题问询 | [IAM 原函及本轮补充确认](<collaboration/iam-confirmation-letter.md#9-本轮补充确认正文代拟未发送>) | 补充正文先列业务需求、原函覆盖与待确认问题；原 21 项及已有答复保留；面向 IAM 团队补充产品依据，共同事项由行内实施团队协调汇总；未发送 |
| 专用访问评审 | [DSH 与 Agent 模型网关认证方案](architecture/gateway-identity-review.md) | 需求方已确认；比较纯令牌/Key＋令牌，能力及路线待核验，技术审核/批准待定 |
| 网关新问询 | [DSH 和应用 Agent 调用 AI 网关补充问询函](collaboration/gateway-confirmation-letter.md) | 先说明定制化 DeepSeek Harness 与应用自动调用两类场景，再按 CONF-GW-09—20 询问是否支持；正文面向网关团队；跨函问题对应与协调放在内部说明 §3.1，避免重复问询；代拟未发送 |
| 仓库结构 | [工程仓库结构与长期迭代设计](<engineering/repository-structure-design.md>) | 目录、模块边界、迁移与私有市场分层；已批准实施，业务能力仍按门禁验证 |
| 开发约定 | [工程开发与发布约定](<engineering/development-conventions.md>) | 分支、提交、测试分层、版本与发布边界 |
| 逐模块设计 | [设计索引](<design/README.md>) | 各扩展包与两个独立服务的详细设计状态与路径（含实现与验证入口） |
| 跨模块冲突收口 | [跨模块冲突收口](<design/conflict-resolution.md>) | 五条跨模块冲突的定位与结论（责任方 2026-10-24 已确认）；确认不等于企业能力已联调 |
| 凭据模式 | [凭据存储模式](<design/credential-modes.md>) | 文件 backend / OS keychain / 迁移与不可用时的 fail-closed 口径 |
| 运维入口 | [运维索引](<operations/README.md>) | 分发、发布、回滚、支持的待建交付物 |

辅助图解：[统一认证与模型访问](<assets/enterprise-authentication-flow.html>)、[工程结构提案](<assets/repository-structure-proposal.html>)、[网关静态 Key 方案（历史提议）](<assets/gateway-credential-options.html>)。三者可离线打开并保留页面源稿，不替代受控文档或当前实现清单；网关静态 Key 页描述的是 2026-10-20 原提议，先被 2026-10-22 ADR-14 取代；当前身份/用途目标见 ADR-16 与专用访问评审，历史图解不代表已选定路线，涉及旧 MCP 形态与工程整理时点的图文须结合现行需求和模块说明阅读。市场整体功能架构另见[插件市场功能架构图](<assets/plugin-market-architecture.html>)（V2.0.0 评审稿示意，不替代正文契约或实现清单）。开放 Issue 的排期分析另见[实施路径总览](<assets/issue-implementation-path.html>)（2026-10-23 辅助分析，人日为粗估，不构成排期承诺或门禁证据）。

## 5. 阅读顺序

1. [需求与场景基线](<requirements/requirements-baseline.md>) §1–§6：先定范围、人群与指标。
2. [总体架构设计](<architecture/platform-architecture.md>) §1–§7：原则、总体架构、插件形态与五个领域。
3. [推广实施方案](<plans/rollout-plan.md>) §4–§8：关键路径、验收、风险与试点运行。
4. [AI 网关契约](<contracts/gateway-contract.md>) §4：当前人员、用途、候选凭据、生命周期、预算与错误语义。
5. [设计索引](<design/README.md>) 与[开发约定](<engineering/development-conventions.md>)：进入实现前的模块边界与工程规则。
6. [跨团队确认询问函](<collaboration/team-confirmation-letters.md>) §4：按收件团队选择正文，填写联系人、期限与署名后转发。

## 6. 编写约定

本节承载全体撰写人共用的文档治理规则；agent 按任务读取，不在根指令中复制完整手册。

### 6.1 文档类型与元数据

需求、架构、计划、契约、协作、工程文档，以及后续详细设计和运行手册均按受控文档维护。使用[通用模板](templates/_template.md)；模块设计使用[模块模板](templates/design-template.md)，覆盖接口核验、权限、生命周期与测试。

| 类型 | 必备内容 |
|---|---|
| 文档信息 | 编号、名称、版本、状态、密级、编制、审核、批准、最后更新、门禁 |
| 编制依据 | 来源及适用版本、核验日期、已验方式与范围、未验项；上游源码路径不能当作本仓库文件 |
| 待确认表 | 具体问题、回答责任方、截止门禁；现有模块模板的“未决事项”表应同时写明截止门禁 |
| 版本历史 | 不写修订记录表：版本号只维护在文档信息与文档清单，历史由 Git 提交记录承担 |
| 仓库说明与模板 | 根 README、AGENTS、CONTRIBUTING、SECURITY、模块职责 README 和模板不因存在而成为已批准的技术契约，不强加受控正文编号 |

受控正文缺少必备内容时按草案处理，不标“评审稿”或“生效”。agent 代拟时标注“代拟”，新增审核、批准栏保持“待定”；既有审批记录保留，不倒填审批人。

### 6.2 内容归属与冲突处理

L1 是总体架构，L2 是需求与实施计划，L3 是字段级契约、模块设计及运行手册。层级描述内容粒度，不能单独决定冲突时的效力。

- 范围、场景和指标在需求基线维护；跨域决策与 ADR 在架构维护；排期、WBS、门禁证据和验收在计划维护。
- 外部字段、错误语义在对应契约维护；模块设计引用契约，只定义本模块接口和行为；运行手册记录经验证的操作与恢复步骤。
- 询问函承载问题和回函，不自动成为技术契约或准入批准；图解是辅助说明，不替代受控正文。
- 运行状态以当前实测为证，预期行为以有效契约及已确认决策为准。草案、未采纳备选、历史记录或实测偏差不自动修改预期行为；发现冲突时记录双方依据、适用版本和影响，交责任方裁定并同步受影响文档。
- 入口只保留必要摘要和链接，避免复制完整范围清单、契约字段及待确认台账。当前版本和状态以正文元数据与清单相互校验，不一致时修正，不以任一处静默覆盖另一处。

### 6.3 编号、命名与写法

- 新增受控文档前查[文档清单](DOCUMENT-REGISTER.md)；编号格式为 `CORP-DSH-<域>-<三位序号>`，域为大写英文缩写。编号不复用，废止后保留编号、条目与路径。
- 一份文件一个一级标题，使用 ATX 标题；中文为主，技术标识保留原文，缩写首次出现说明含义，术语对齐需求与架构的术语表。
- 结论先行，分开事实、决策、推断和待确认；推断显式标注。契约写可核对的字段与示例，验收写可判定断言，不用规划文本证明实测。
- 不写修订记录、变更日志或“本次更新”段落；版本变化只改文档信息、清单与受影响的索引摘要。
- 表格列数一致；代码块标注语言；仓库内链接使用相对路径与有效锚点。图示优先 Mermaid，离线资源放 `docs/assets/`，HTML 自包含且不引用外部脚本。
- 密级未指定时填“—”；示例使用占位值，不写真实地址、凭据、用户数据或本机绝对路径。外部规范注明适用版本与核验日期，不把当前网页内容套用到未验证的旧版本。

### 6.4 状态、版本与历史

| 项 | 规则 |
|---|---|
| 状态 | 正常推进为“待启动 → 草案 → 评审稿 → 生效”；任一已建文档可按授权废止，保留原文和替代说明。回退写明原因 |
| 生效 | 受控正文须有真实审核与批准记录；未获得批准保持草案或评审稿。辅助索引由平台组维护，可直接生效，不代表正文方案获批 |
| 版本 | `V0.x` 用于草案与初步评审，`V1.0` 及以上用于正式评审稿与生效正文；辅助索引的版本不表示正文批准程度 |
| 升版 | 不兼容的契约或架构变更升主版本；新增章节或跨文档口径同步升次版本；文字修订及纯路径迁移升修订号 |
| 历史 | 由 Git 承担；正文不留修订记录表、变更日志或进展流水账，需要追溯时查提交历史 |

### 6.6 状态词与证据等级

同一事实只写一处：**实现与验证状态**写[设计索引 §2.2](<design/README.md#22-实现与验证入口>)；**交付物负责方与门禁**写[文档清单](<DOCUMENT-REGISTER.md>)；**排期与阶段门禁**写[推广实施方案](<plans/rollout-plan.md>)；模块设计"模块状态"只写设计阶段（规划 / 可用 / 已废止），不复述实现细节。其余入口引用，不复制。

状态词按下表取值，不要互相替代：

| 词 | 含义 | 需要什么才能改口 |
|---|---|---|
| 未核验 | 接口、字段或命令未与提供方确认 | 提供方书面确认或实测记录 |
| 未测 | 尚无本仓库可复现的证据 | 一条可复跑的命令 + 证据位置 |
| 未联调 | 未对企业真实系统跑通 | 企业环境中的一次真实往返记录 |
| 待批 | 未获责任方或安全批准 | 签署记录（进入台账等可查载体） |
| 已实测 | 有可复现命令与证据位置 | 证据失效或环境变更时改回"未测" |
| 已联调 | 已在企业环境跑通并有记录 | 仅在企业环境再次跑通时维持 |

### 6.5 变更与验证

| 变更 | 必做动作 |
|---|---|
| 架构决策 | 更新或新增架构中的 ADR、版本与登记；字段仍留在契约 |
| 契约字段 | 先改对应契约；涉及跨域决策时同步 L1 摘要，变更保留待责任方确认状态 |
| 新增文档 | 使用对应模板、分配编号、登记清单，并补充实际需要的导航入口 |
| 改名或移动 | 使用 `git mv`，同一变更更新全库引用和登记路径；不保留重复正文或导航桩 |
| 版本变化 | 同步文档信息、文档清单与受影响的索引摘要；不写修订行，历史编制依据中的当时版本不改成当前版本 |
| 废止文档 | 保留路径与编号，标注废止原因及替代文档；无替代时明确写明 |

交付前运行 `pnpm check` 与 `git diff --check`，确认相对链接与锚点、表格、登记路径、版本及状态一致，涉及迁移的旧引用已清理。检查器的具体覆盖以当前实现为准，尤其是后续新增的嵌套设计和运行手册仍须人工核对受控要素。格式检查通过不等于内容正确或技术方案已经验证。

## 7. 治理依据与核验边界

核验日期：2026-10-20。已阅读以下官方资料，并核对本仓库入口、需求范围、工程配置、工作流和模块状态；资料与静态核对只支持文档组织及规则设计，不证明 agent 行为效果、远端保护、企业联调或双端部署已经验证。

| 来源 | 采用原则与本项目适用边界 |
|---|---|
| [OpenAI：Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md) | 项目指令分层、根规则与目录差异分开、审查规则简洁；不在仓库复制个人配置或扩大授权 |
| [GitHub：About the repository README file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) | README 说明项目用途、起步与参与入口，长文用链接组织；本项目保留受控文档目录，不迁到 Wiki |
| [GitHub：Setting guidelines for repository contributors](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors) | CONTRIBUTING 负责贡献流程和评审准备；仓库公开可见不代表授予开源许可 |

具体内容归属、文档层级与治理流程是结合本项目的维护选择；上述资料不构成团队审批，也不规定唯一的企业工程目录。
