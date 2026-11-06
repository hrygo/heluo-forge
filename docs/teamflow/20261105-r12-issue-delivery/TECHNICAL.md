<!-- meta: summary="单 Issue 交付技术方案：正式 Skill 分发、原生 Teamflow 接口取证、版本快照与证据纪律；M1 存在提交前缀、权威关联、只读审查及工作树交接阻塞，未准入不得实施完整链路。" -->
# 单 Issue 可信待验收交付技术方案

> 编制：高级全栈工程师（代拟）；日期：2026-11-05；状态：技术设计已形成，M1 未通过，非实现／联调通过结论。需求以本任务 [PRD](<PRD.md>) 为准，沿用 r10 平台分工、r9 安全与生命周期基线，不取代历史 AC、不修改历史任务夹。

## 1. 架构结论与准入

**选择“正式企业 Skill + 原生 Teamflow 唯一执行 + Gitee 本地版本读取”。** Skill 只补企业语义与证据交接，不接管排程、任务状态、授权或关闭判定。复用 Node ESM、Cordis、pnpm workspace、`node --test` 和既有自包含 tarball 构建；不加数据库、流程框架、前端页面或宿主补丁。

| 方案 | 权衡与决定 |
|---|---|
| 正式 Skill + 既有插件 + 原生 Teamflow（选择） | 分发闭包可复用，业务来源与执行来源清晰；但原生提交、关联及证据接口必须先取证，不能靠提示词补能力 |
| 仅把个人试点提示词复制进 README | 修改少，但无运行时发现／资源闭包，不能满足 AC-1～3，否决 |
| 自建协调器、run 映射库或改 Teamflow／DSH | 可定制流程，但越过非目标，形成第二状态机，否决 |

### 1.1 M1 判定：阻塞，不得静默推进完整实施

| 门禁 | 本轮证据与结论 | 解除条件 |
|---|---|---|
| G0 授权 worktree 一致性 | shell 的 cwd／Git 根均为用户授权隔离工作树，分支 `feat/plugin-workflow-new`、HEAD `55e964c7d347cfd1a89160de8035ebee16992ae9`。但真实 status 的 run 日志仍载旧分支，并声称未读到本工作树实际存在的 PRD 状态；尚不能证明阶段、状态读取与最终提交使用同一授权根。不能只凭旧日志断言当前根或猜原因 | 发起端核实宿主 journal／阶段 cwd／机器通道／最终提交根均指向本 worktree；主目录零写、零 stash、零提交。不能定位就停止，不用修补主目录绕过 |
| G1 实际提交前缀 | 已装 Teamflow 0.3.2 的 `commit.final` 固定为 `feat: {req}…`，最终 `git commit -m` 使用该模板；`commitMessage` 仅作用于 `preAction=commit`。源码已显示与 AC-10 的 `[变更号]` 首行不兼容 | 出示支持公开提交契约的宿主／插件版本及隔离 Git 实跑，或用户另行决定范围；不得改上游、amend、跳 hook 或补一条提交掩盖不合规提交 |
| G2 权威关联 | 当前 Issue 详情投影不含结构化变更关联，DevOps 卡片返回 `REPO_FACTS_EXTERNAL`；缺完整的 Issue→唯一变更→唯一仓库权威证据。缺字段不证明平台永远没有接口 | 真实只读接口提供完整关联、范围／验收／依赖及可复核要求版本；无接口则阻断真实企业任务，不能用手填、标题或正文推断替代 |
| G3 去重与跨重启关联 | status 无参仅列当前工作区最近 10 个 run，需求摘要截至 60 字；start 没有 Issue 关联／外部幂等键参数 | 证明可完整查既有 run 与业务绑定；已有可信 runId 可直查。无法排除更早 run、映射不可信或不唯一则禁止新启动／续跑，不建第二映射库 |
| G4 独立只读审查 | Inspect 发现独立子上下文创建能力，但未取得该链路权限收窄／写拒绝实测；当前子代理深度已用尽且不允许扩大权限 | 独立宿主上下文证明身份、实际模型、只读权限及写拒绝，再审查实际版本；“请只读”或自造 `readOnly` 参数不是证明 |
| G5 目标版本与企业条件 | 仓库 [DSH 版本声明](<../../../.dsh-version>) 为 rc.3，本机 `dsh --version` 为 rc.5；首个真实 Issue、仓库必要规则及企业关联读面未给出，目标宿主未验 | 分别取得目标版本与实际环境证据；目标变更须用户决定。没有企业条件只能交明确标注的机制演示 |

本次技术文档可以交付，**不能据此宣称完整链路具备实施准入或真实 Issue 已待验收**。机器蓝图当前只释放 T0 只读准入复核；T1～T5 是门禁解除后的条件化并行设计，不提前派发。T0 无法解除必需缺口时记录阻塞并结束，不制造 mock 成功。

## 2. 已核对的工程事实

- 当前 worktree 就是项目根，不建 `products/<product>/` 镜像；遵循[团队约定](<../../../AGENTS.md>)。[企业组合清单](<../../../packages/forge-enterprise/package.json>)只依赖凭据、策略、IAM 三包，[组合补丁](<../../../packages/forge-enterprise/cordis.patch.yml>)未挂研发 Skill、DevOps 或 Gitee。
- [Skill 装配](<../../../packages/forge-enterprise/src/skills.mjs>)已有加载、选择、预算、注册和 dispose；[组合入口](<../../../packages/forge-enterprise/src/index.mjs>)是库导出，不是业务 Skill 自动注册 `apply`。现有 provider 的 `get(name)` 是历史形状，不能拿旧夹具证明目标宿主参数兼容。
- [构建器](<../../../scripts/build-enterprise-bundle.mjs>)已经递归闭合 workspace 依赖、实体资源与 bundled dependencies，禁止未闭合依赖、软链和安装钩子；保留 `buildBundle({root,entry,destination,version})`／`buildEnterpriseBundle(options)`，不重写打包器。
- [Gitee 入口](<../../../packages/forge-gitee/src/index.mjs>)已有服务与 10 工具；[Git 适配器](<../../../packages/forge-gitee/src/gitee-git.mjs>)提供 `head(into)`、`branch(into)`、`commit({changeId,message,cwd})`、`push({remote,branch,cwd})`。只有 HEAD／branch 无法描述脏代码，关闭四项判定也不是候选资格证明。
- [Gitee 适配器](<../../../packages/forge-gitee/src/gitee-adapter.mjs>)及 [CLI 规格](<../../contracts/gh-cli-spec.md>)的 Issue 详情投影有 8 字段、无 `updated_at`；不能把 `created_at` 冒作要求最新版本。[DevOps 归一](<../../../packages/forge-devops/src/change-context.mjs>)不判仓库归属，业务字段继续单源映射。
- 三层策略目前为 **6 条只读并集、0 条 write**，不是旧摘要中的 5 条。保持共享 `heluo-policy` 的完整 config 逐字一致、无 isolate，不新增默认审批或远端写。
- [Node 声明](<../../../.node-version>)为 24.21.0，[根清单](<../../../package.json>)固定 pnpm 11.28.5；本阶段实跑 Node 24.13.0、pnpm 11.28.5。报告差异、不升级环境，不把声明当本轮运行版本。

## 3. 目标宿主接口核验表（AC-6）

核验日期 2026-11-05；实际可见组合为 DSH rc.5／Teamflow 0.3.2，仓库目标 rc.3 **NOT RUN**。运行时 Inspect、已装包源码及真实只读调用分别列证，不把接口发现写成行为通过。

| 能力 | 实际接口与返回依据 | 作用域／证据及缺口 |
|---|---|---|
| Skill 注册／发现／读取 | `skills.registerProvider(create) -> disposer`；provider 暴露 list/get；`skills.list(options)`／`snapshot(options)` 返回摘要／目录快照，支持 scope、cwd | 通过 Host `Service.listService({service:'skills'})` 发现真实契约；注册在 Context 层、dispose 撤销。未做本轮 tarball 注册，lookup 参数和 resourceBase 在 T0/T1 按目标版本核验 |
| 企业事实 | `forge_devops_change_context({target})`／`forge_devops_query({action:'change.read',target})`；`forge_gitee_issue_read({target,…})`／`forge_gitee_repository_read({target})` 返回原有读信封 | 工具定义、仓库适配器和企业 CLI 契约证明接口形态；本轮企业调用未做。能读对象不等于证明关联，G2 未解除 |
| 任务关联 | start 无外部 Issue 字段；可把已核验绑定与来源放进 requirement，但不能宣称有原生关联服务 | 已装 Teamflow 工具定义 L13009～13086；未发现可直接承诺的权威关联／全历史检索，G3 未解除 |
| 启动 | `teamflow_start({requirement,teamId?,productRoot?,branchPolicy?,…}) -> {status,runId?,kind?,question?,options?,blockers?,…}` | 已装工具定义 L13007～13103；本阶段启动 0 次。needs-decision／needs-clarification 不能当已启动，不能虚构跳阶段参数 |
| 查询 | `teamflow_status({runId?}) -> {runId,status,workspace,reminder,snapshot}`；无参返回最近 run 摘要 | 本轮真实只读调用返回当前 run 的 running、stages、owner、日志及资源地址；源码 L13460～13503。workspace 是键而非 Git 根，且存在旧状态冲突；近 10 条不证明无历史 run |
| 续跑 | `teamflow_resume({runId,supplement?}) -> {ok,runId?,resumedFrom?,error?}` | 工具／实现 L13725～13764；本阶段调用 0 次。supplement 仅在 PRD 前／确认暂停点生效，不能晚阶段灌入新要求；取消与确认不得代用户批准 |
| 提交 | `teamflow_start.commitMessage` 仅控制预处理提交；原生最终收口使用 `commit.final`。`forge_gitee_git_commit({changeId,message})` 只控制其自身本地提交 | 已装 Teamflow L675、L12002～12079、L13055～13057，及仓库 Git 适配器。源码确认 G1 不兼容；实际最终提交 NOT RUN。前缀写进 requirement 仍会得到 feat 前缀，不算修复 |
| 完成读取 | status.snapshot 提供原生 status／stages／humanIntervention／resultPreview 等，但不保证已提交 SHA、业务绑定或审查版本 | 只有 running 查询实测；completed 结果／候选绑定 NOT RUN。不构造未证明的 `snapshot.commitSha` 等字段 |
| 独立审查 | Inspect 可发现 `subagents`／`agentLoop` 独立创建能力；当前 subagent／fork 无剩余层级 | 证明“能创建”不等于“可强制只读”。没有只读权限／写拒绝／同版本审查实跑，G4 未解除 |

依据为当前会话原始工具记录及已装 Teamflow 包坐标／源码行号，不复制个人路径、宿主源码或整段输出。Teamflow 不在本次 Inspect Service 目录中出现，不据此断言不存在：公开工具可用、包已装，但无 Inspect 业务 Service 编码契约，因此只设计调用已公开工具，不臆造 `ctx.teamflow.startIssue()`。

## 4. 分层、模块与正式分发

### 4.1 准入后的目标模块

下表是新增设计签名，不是当前已经存在的 API；既有接口保持名称与语义。

| 路径 | 职责／公开签名 | 依赖与装配次序 |
|---|---|---|
| `packages/forge-enterprise/src/issue-delivery-skill.mjs`（新） | Host 插件导出 name、`inject=['skills']`、`apply(ctx) -> void`；注册 enterprise-issue-delivery，dispose 撤注册，不注册业务工具／启动 run | 既有 assembleEnterpriseSkills，次序 2 |
| [skills.mjs](<../../../packages/forge-enterprise/src/skills.mjs>)（改） | 保留 `assembleEnterpriseSkills(ctx,input)`、`registerEnterpriseSkillsViaProvider(ctx,input)`、`registerEnterpriseSkills(ctx,input)`；input 增加可选 resourceBase，贯穿摘要／正文，并按实际核验契约兼容 lookup | 宿主 skills，次序 1；不复制加载器 |
| `packages/forge-enterprise/skills/clauses.json`（新） | 单项 id=issue-delivery、level=hard、body=issue-delivery/SKILL.md，使用现有索引字段形状 | load/select，次序 1；不是第二业务要求 |
| `packages/forge-enterprise/skills/issue-delivery/SKILL.md`（新） | 目的、显式触发、缺依赖短路、只读关联、原生交接、证据边界；references/handoff.md 与 references/evidence.md 按需加载 | 包内实体资源，次序 1 |
| `packages/forge-gitee/src/gitee-snapshot.mjs`（新） | `createGiteeSnapshotReader({runner,now?}) -> {read(cwd): Promise<SnapshotResult>}`；`snapshotToolDefinitions(service,resolveCwd) -> ToolDefinition[]` | 同包 runner、Node fs/path/crypto、既有脱敏约定，次序 1 |
| [Gitee 入口](<../../../packages/forge-gitee/src/index.mjs>)（改） | 服务追加 `snapshot(cwd) -> Promise<SnapshotResult>`，仅装配 reader；原有 read/write/git 契约不变 | 与既有 runner 共用执行体，次序 2 |
| [Gitee 工具表](<../../../packages/forge-gitee/src/gitee-tools.mjs>)（改） | 保留 `buildGiteeTools(service,options={})`；新增 `GITEE_SNAPSHOT_TOOLS=['forge_gitee_delivery_snapshot']` 单源枚举，总工具升 11 | snapshot definitions，次序 3；计数、装配与文档同步 |
| [企业清单](<../../../packages/forge-enterprise/package.json>)／[补丁](<../../../packages/forge-enterprise/cordis.patch.yml>)（改） | 增 DevOps/Gitee workspace 与 bundledDependencies，导出 ./issue-delivery-skill，包含 skills／locale／icon，插入同 id 研发能力及 Skill 行 | 现有 buildBundle，次序 3，不另建构建器 |

独立快照模块用于解决既有 HEAD／branch 不足，也避免继续膨胀 commit/push 模块。DevOps 只负责业务事实，Gitee 只负责仓库／Issue／PR／Git；不提取跨平台万能适配器，不在 Skill 重映射原生字段。

### 4.2 包体、发现与停用

1. Skill 插件行固定 id=heluo-issue-delivery-skill、name=@heluo/forge-enterprise/issue-delivery-skill；DevOps 沿用 forge-devops，Gitee 沿用 heluo-gitee，策略沿用 heluo-policy。同 id 折叠，不靠 YAML 行序保证异步依赖。
2. 企业组合从 3 扩为 5 个企业依赖包，加上组合自身。skills／tools／Teamflow／只读审查能力为宿主前置，不分发 DSH 本体，不在安装脚本补依赖；Teamflow 不符合现有仅企业 workspace 依赖的闭包规则，不偷偷加入 runtime dependency。
3. Skill 摘要展示名称、用途、显式触发和权限；`modelInvocable:false/userInvocable:true`，沿用宿主真实用户入口。正式资源不读取、复制或删除个人试点 Skill，隔离用户目录也应可发现。
4. resourceBase 指向包内 Skill 实体目录，正文的两个 references 全部进 files；路径逃逸、缺资源或越界软链拒绝注册。provider lookup 按已取证形状实现，不吞错后假成功。
5. 新增中英 locale，root 与新增子路径导出 locale/icon；图标用仓库[企业标识](<../../assets/branding/cyber-long/components/forge-enterprise-app-icon.svg>)逐字节副本。详情说明宿主前置、触发和缺依赖下一步，不加通用 doctor。
6. 缺 skills 时 Loader 不激活该行，由标准插件详情／README 提供定位；缺其他依赖时 Skill 可发现但执行短路。CLI 缺失复用现有 NO_READER 等信封及配置页，不启动执行链。
7. disable/dispose 只撤该条注册；不删除企业对象、用户配置或其他 Skill，不为卸入口删除共享 policy。沿用现有补丁层精确清理原则。

## 5. 数据模型与存储

不建数据库、run 映射 JSON 或第二任务库，不直接写原生 backlog。企业系统持有业务事实，原生 Teamflow 持有执行事实；下列是证据投影，不是新企业 API 或授权凭证。

| 模型 | 必需字段 | 来源与存放 |
|---|---|---|
| Binding | issueRef、唯一 changeId、唯一 repositoryRef、requirementsRevision、scope、acceptance[]、dependencies[]、sourceRefs[]、completeness | 权威企业读取；调用参数只是查找线索。随已核验正文传给原生 requirement 并保留来源，不另建映射库 |
| RunObservation | runId、宿主 workspace 键、完整绑定引用、原生 status、原生证据引用 | 原生 status／已有记录；标题匹配不算绑定，最近列表不证明历史不存在 |
| CodeVersion | workspaceId、commit、tree、branch、dirty、contentId、observedAt | snapshot 只读返回，宿主工具记录保存；绝对路径仅内部校验，不回显／落库 |
| ValidationRecord | 命令、起止时间、工具／宿主版本、前后 CodeVersion、退出码／断言／skip、必需项、证据引用 | 实际工具执行记录；报告中的 pass 不能替代原始执行 |
| ReviewRecord | 审查上下文与模型、实现上下文、只读权限／写拒绝证据、前后版本、发现及结论、原始引用 | 独立原生会话记录；同模型披露，异模型偏好未确认不得自称通过 |
| DeliveryView | Binding、相关 run、实际版本／已有 PR、验证、独立审查、依赖规则与未验项；分列执行、候选、用户、CI、合入、Issue、业务状态 | 当前会话摘要引用原始材料；复用原生任务产物，不统一搬迁／新建 manifest |

证据展示类型区分 repository-source、local-execution、host-execution、enterprise-read、fixture、declaration，不覆盖现有 sourceType=mock/enterprise。程序被发现或标签写 enterprise 不证明真实关联；每项都须可回到原始记录。

requirementsRevision 优先平台真实版本。平台确无修订字段时，仅在权威读取内容完整、接口契约有据时，才可对完整要求载荷计算稳定摘要并标“内容版本，非平台修订号”。对手填内容散列不能变为独立核验，当前 G2 不因散列解除。

## 6. API、版本读取与调用协议

### 6.1 新增本地只读工具（目标设计，未注册）

`forge_gitee_delivery_snapshot({}) -> SnapshotResult`。参数不接 cwd、repoRoot、bin、argv、pass、sourceType；从真实调用 Agent 的授权工作区解析 cwd，不能默认使用进程全局 cwd。拿不到可信调用根就拒绝。

成功字段：`{status:'succeeded',workspaceId,commit,tree,branch,dirty,contentId,commitMessage,observedAt,evidence}`。evidence 仅含逻辑命令、时间与本地来源，不含绝对路径、文件正文或环境变量；失败返回 `{status:'failed'|'unknown',reason,message,next,observedAt}`，缺失值不编 SHA，不直传 stderr。

- workspaceId 是规范化真实 worktree 身份摘要，不作授权；同仓库主目录与 linked worktree 也必须区分。commit/tree 使用实际完整对象 ID，不沿用短 SHA／固定 40 位假设误截断。
- contentId 对规范排序的 HEAD、索引项、模式、工作树内容摘要及未跟踪集合计算 SHA-256。包含 staged／unstaged、删除、重命名、未跟踪代码；ignored 文件不进默认源码集合，若必需源码被忽略则缺完整覆盖，不能称完整版本。
- 全部子进程仅走 [现有 runner](<../../../packages/forge-gitee/src/gitee-cli.mjs>) 的 `runGit({args,purpose,cwd})`。固定读取命令：rev-parse --show-toplevel、rev-parse HEAD、rev-parse HEAD^{tree}、branch --show-current、status --porcelain=v1 -z --untracked-files=all、ls-files --stage -z、ls-files --others --exclude-standard -z、show -s --format=%H%x00%B HEAD。不新增 shell、通用 argv、外部 diff/textconv、write-tree 或写命令。
- NUL 分隔解析路径；拒绝逃逸、未知模式、未支持 gitlink、越界软链或不可读项。内容只在内存散列，不发给模型／日志。沿用 runner 超时和 1 MiB 输出上限；截断、超时或前后 Git 状态变化返回 unknown，不截掉余项后给有效版本。
- 前后采样，收口时无运行中的写入者。两次一致不是 OS 原子快照保证；发现并发或不能证明稳定则暂停，不自建锁服务。
- 新工具是本地只读，无企业远端动作，不新增策略 write，也不绕过宿主文件／工具权限。工具层及服务均保留工作区守卫，不能以模型传入根路径获得授权。

### 6.2 关联与原生交接

不新增 HTTP 路由、Remote 方法或 startIssue；现有业务 read API 保持平台边界，snapshot 是唯一本轮新增本地读面。

1. 用户显式进入 Issue，或从变更入口选一个 Issue；依赖／worktree 核对后进行权威只读核实。缺失、多关联、冲突、读失败均零启动／续跑／提交／远端写。用户补线索必须重新读取。
2. 查询可信已有 run，只接受完整绑定及唯一结果；多个候选、声明映射、查询失败或近 10 条不足以排除历史，均暂停。原生 workspace busy 只作补充防线，不是 Issue 幂等证明。
3. 运行中仅 status；可续跑且有当次用户许可的中断 run 原生 resume 一次；已完成先核对版本与证据；取消不自动恢复。只有能排除旧 run、G0～G5 全满足才 start 最多一次。请求 unknown 后先查，不重发 start/resume。
4. requirement 承载现有范围／验收和清晰来源，附已核验变更号与提交要求，不成为第二业务真源。不添加不存在的 issueRef／finalCommitMessage 参数，不靠特殊 mode 假称跳 PRD／确认关卡。
5. 本次 branchPolicy=keep 只适用于已授权 worktree；不传 preAction=stash/commit，不套用到主目录。宿主提出额外决策如实交用户，不代批准。
6. 获取 runId 后保留原生记录引用，后续回读绑定；跨重启找不回、查询不完整就停止，不自动开第二个 run。

### 6.3 候选资格与关闭分离

候选同时要求权威唯一关联、同要求版本、同代码版本、必要本地验证、独立只读审查及必要仓库规则证据。completed、实现者自审、调用方 pass、mock 或旧版本记录都不足。

不新增“资格通过”写工具，不把模型填写 evidence 反灌为事实，不调用关闭四项判定拼全绿代替候选核对。Skill 输出是证据摘要不是硬授权，授权仍由宿主／策略／企业控制。用户结论只引用实际消息与所验版本，来源不足标 declaration，不代写人工确认。

## 7. 前端与状态管理

**无新增页面、组件、Client bundle 或前端 store。**

| 现有入口 | 本轮作用与状态所有者 |
|---|---|
| 原生 Skill 发现／触发 | 摘要、边界、按需正文，由 skills scope 目录管理 |
| 原生插件详情 | locale、README、缺依赖指引，由 Loader／插件管理维护 |
| 现有 DevOps 配置页 | CLI 配置／发现与失败下一步，复用当前配置及刷新读面 |
| 当前会话／Teamflow 工作台 | 原生 run/stages 与候选摘要／证据链接，Teamflow 是唯一执行状态 |

阻塞／跟踪／续跑／候选是当前记录的展示投影，不新建持久状态机。重新进入重新读取；聊天缓存、分支名和标题不是权威映射。过期证据保留历史，但不自动复用。

## 8. 版本、审查与失效

1. 绑定键包含权威 requirementsRevision、workspaceId、完整 commit、tree、contentId；分支／runId 仅辅助。切提交即使树相同也重新核验，不自动沿用旧确认。
2. 脏版本验证保留 contentId 与可复核原始记录。候选优先在原生最终提交后，针对最后 SHA 重新验证与独立审查；不得把旧检查记录的 SHA 替换成新 SHA。
3. 不排除测试、lockfile、依赖声明或验收要求来维持假稳定。代码／测试／依赖／要求变化使旧证据失去自动适用资格；未知差异按未覆盖。staged／untracked 不得遗漏。
4. 必要检查须实际成功且前后版本一致；缺失、失败、未运行均不通过。既有 skip 单列，新验收用例零 skip；修复后重新验证并复审。
5. 审查前证明与实现者分离、实际权限只读，写拒绝在隔离 scratch 验证，不在业务仓库做破坏性尝试。审查者不修代码，修复回实现上下文，修后再次 snapshot／复审。
6. 摘要优先放宿主会话记录并引用既有产物，避免验证后再往代码树追加一份需提交的 manifest。必须改交付文档／测试／代码时重新核对版本，不能模糊忽略整个任务夹。
7. G1 未解除不得先提交、跳 hooks、补提交、改 requirement 措辞或重签历史来假修复前缀。原生收口可能整树暂存，必须证明无未授权差异，否则不能交其提交。

## 9. 测试策略与验收覆盖

使用现有 node:test；单元夹具、真实本地 Git、真实宿主、企业／双端分列。宿主缺失时独立探针报告 NOT RUN 及影响，不用 test.skip 或夹具替代。

| AC | 验证内容 | 证据层／位置 |
|---|---|---|
| AC-1、AC-2 | 最终 tarball 正文、references、locale/icon；无个人副本发现；闭包、同能力单注册、停用保留配置 | 企业 tests，既有 bundle-build／closure／install-rehearsal、patch tests，最终制品真实装配 |
| AC-3 | 分别移除插件、skills、Teamflow、CLI；缺项／步骤／下一步齐全；启动续跑远端写 0 | Skill 负测＋隔离宿主；缺 skills 由标准 Loader 诊断 |
| AC-4、AC-5 | 唯一关联；无关联、多变更、多仓库、入口冲突、读取失败；声明／标题不能解锁，补线索重读 | 已核实字段夹具＋真实企业；当前企业 NOT RUN |
| AC-6 | 真实版本、参数、作用域、来源与缺口，无虚构提交／只读参数 | T0 准入记录及宿主探针，源码不代执行 |
| AC-7、AC-8、AC-19 | 首次 start/resume=1/0，重复／运行中 0/0，中断 0/1，完成 0/0；多候选、列表不足、unknown 不重放 | 真实隔离宿主原始调用计数，不能只测提示词 |
| AC-9 | cwd 错位、仓库不符、未经授权分支改变时停止；他处写、stash、commit 0 | scratch 多 worktree 真 Git＋宿主交接 |
| AC-10 | 实际最终提交首行有权威变更号，SHA 可读，未绕 hook／签名 | 原生真实 Git 记录；当前源码不兼容，不记通过 |
| AC-11、AC-14 | staged／unstaged／untracked／删除／重命名／空 HEAD／分离 HEAD／特殊路径／软链／gitlink／并发／截断；代码、测试、依赖、要求、提交变化失效 | snapshot 单元＋真 Git；交付真实版本读取，未知形态 unknown |
| AC-12、AC-13 | 退出与断言可溯，独立上下文／只读写拒绝／同版本；自报 pass／修后未审失败 | 真实宿主审查，当前 NOT RUN，不由技术阶段自审补票 |
| AC-15、AC-16、AC-17 | 摘要可溯；伪造 pass、错版本、fixture、completed 不足；用户／CI／合入／关闭分记，远端写 0 | 机制负测＋真实结果；既有 delivery_gate 不改语义 |
| AC-18、AC-20 | 脱敏、审批回读、unknown 不重放、6 条并集、IAM／凭据 fail-closed；忽略及全仓回归 | 既有安全／补丁／卸载测试＋全仓 check；企业与双端另列 |

开发阶段可复跑入口，**不是本技术阶段已运行结果**：

```sh
node --test packages/forge-enterprise/test/skills.test.mjs packages/forge-enterprise/test/issue-delivery-skill.test.mjs packages/forge-enterprise/test/issue-delivery-contract.test.mjs
node --test packages/forge-gitee/test/snapshot.test.mjs
node --test packages/forge-gitee/test/
node --test tests/bundle-build.test.mjs tests/bundle-closure.test.mjs tests/bundle-install-rehearsal.test.mjs tests/plugin-patch-layers.test.mjs
node scripts/probe/run-issue-delivery-probe.mjs
pnpm check
git diff --check
```

新增文件由下述任务创建；既有测试不为适应 11 工具而删除或缩减。每项记录命令、时间、实际宿主／工具版本、对象与来源、退出／断言／skip、原始位置，不制造整段输出副本。

## 10. 任务划分与所有权

本 run 无独立派发 task 列表。**当前只派 T0；T1～T5 必须等发起端确认 G0～G5 已闭合才释放。** 原生任务表无本方案自造的 dependsOn 字段，文字依赖不能当调度硬保证。

### T0：只读准入复核与停止点（当前唯一可执行项）

- 修改：`docs/teamflow/20261105-r12-issue-delivery/HOST-VERIFICATION.md`，只存短证据表，非日志 dump；其余相关仓库／宿主契约只读。
- 核对授权 worktree、机器通道、宿主最终提交、权威关联、完整 run 查询与独立只读能力。不得启动业务 run、续跑、提交、安装、升级、改 profile 或触碰主目录。
- 验收：每项有真实版本／证据／结论。必需能力仍不支持则明确阻塞并结束，不制造准入通过；发起端工作根或宿主选择不能代决。

### T1：正式注册与企业组合闭包

- 修改：企业清单、补丁、src/skills.mjs、test/skills.test.mjs、test/bundle-patch.test.mjs；新增 src/issue-delivery-skill.mjs、locale/en.json、locale/zh.json、icon.svg、test/issue-delivery-skill.test.mjs（均在企业包内）。
- 只读：构建器／bundle-rules、三层策略、T3 资源约定、目标 skills 契约、品牌真源。
- 先写注册／dispose／缺依赖／资源逃逸负测，再最小接线；apply 副作用受 Context 管理。保留旧 exports，补齐真实资源和成员，不改官方禁用／策略目录及审计语义。
- 验收：真实 provider 参数可用、摘要无正文、资源有界、单注册与完整清理，tarball 无个人目录依赖；不重建加载器／打包器。

### T2：只读代码版本快照

- 新增：`packages/forge-gitee/src/gitee-snapshot.mjs`、`packages/forge-gitee/test/snapshot.test.mjs`；修改 Gitee src/index.mjs、src/gitee-tools.mjs 及同包所有受工具数量影响的既有测试。
- 只读：runner、Git 适配器、runtime-config、工具 schema 模式与 T0 授权契约。
- 严格实现第 6.1 节签名；先临时真 Git 测脏代码／未跟踪／版本变化再接 runner；新模块不导入 child_process，不改变 commit/push。
- 验收：11 工具单源枚举，cwd 无模型透传，全范围版本与 unknown 可复现，失败不泄漏路径／秘密，未支持形态不产有效快照。

### T3：正式 Skill 语义与按需材料

- 新增：企业包 skills/clauses.json、skills/issue-delivery/SKILL.md、references/handoff.md、references/evidence.md（references 在该 Skill 目录下）、test/issue-delivery-contract.test.mjs。
- 只读：T0 真实接口表、T1 注册路径、T2 快照契约、PRD、既有业务工具定义。
- 主正文仅放目的／触发／依赖／边界／加载指引；handoff 放关联查询、次数与暂停规则；evidence 放版本、审查和来源。不得承诺跳阶段或不存在的提交参数。
- 验收：静态测试仅证明资源契约，实际次数由 T4 证明；声明 pass、mock、映射不可信、目标未知均短路；文案不冒充硬门禁。

### T4：制品与真实宿主交接探针

- 新增：`scripts/probe/run-issue-delivery-probe.mjs`；扩展 `tests/bundle-build.test.mjs`、`tests/bundle-closure.test.mjs`、`tests/bundle-install-rehearsal.test.mjs`，必要时扩展现有 `scripts/probe/run-bundle-install-rehearsal.mjs`，不重建 checker。
- 只读：T1～T3、真实公开工具契约与现有装配探针。
- 入口 `runIssueDeliveryProbe({invoke,workspace,mode}) -> Promise<ProbeReport>`；invoke 是隔离真实宿主工具调用端口，非臆造业务服务；mode 分 local-fixture／host，mock invoke 不得标 host。
- 验收：9 类场景有实际计数、真实提交与版本；tarball 发现／停用和交接分列取证。条件缺失报 NOT RUN，不降成 skip；不装当前 profile、不替换 GUI、不自动合并关闭发布。

### T5：文档、忽略规则与交付自检

- 修改：根 README、企业／Gitee README、受影响设计索引／模块设计／契约引用；审计现有 .gitignore，仅实际缺口才改。任务内实施短结论写 `docs/teamflow/20261105-r12-issue-delivery/IMPLEMENTATION.md`，不改历史夹、PRD、TECHNICAL 或 AGENTS。
- 只读：最终 diff／制品文件表／文档登记规则／任务证据。现有忽略已覆盖 logs、dist、tgz、依赖与秘密；按真实新增路径 check-ignore，不宽泛隐藏 Skill 正式资源。
- 这是交付自检：发现缺陷立即修复、只记结论；如需改 T1～T4 文件，待其完成再串行接管，不并行双写。定向回归及 pnpm check／git diff --check，不跑跨浏览器全矩阵，不写 QA-REPORT／ACCEPTANCE。
- 验收：0 新增 skip，无日志／制品／秘密入库，文档与 diff 实测；企业未验保留 NOT RUN。无权威变更号不伪造提交前缀，无单独授权不推送／建 PR／合并／发布。

并发：T0 先行；准入解除后 T1／T2／T3 文件集不交叠，可并行；T4 等三者，T5 最后串行。reads 不产生所有权，发现共享文件则合并或串行。机器蓝图仅放 T0 防止未准入任务被原生直接展开。

## 11. Git、安全与回滚

- 每次写前、续跑／提交前核对 cwd／Git 根／分支／HEAD／目标差异；只在授权 worktree 沿用 feat/plugin-workflow-new，不新分支、不转主目录、不 stash、不搬运旧快照文件。重叠改动暂停核实，不清他人数据。
- 实际提交首行必须为权威关联的 `[变更号]`；Issue 内联／正文引用，不以 # 起头；不跳敏感扫描，不 amend／rebase／reset 签名历史。G1 未解决不能默认原生满足，也不能在拆任务时丢掉提交约束。
- 原生整树暂存范围必须与授权差异一致，未知改动不提交。另获推送授权后才跑现有 attestation verify 再推送，本轮没有推送授权。
- 回滚优先停用新增 Skill 行／撤注册，快照只读可撤工具注册；不删用户配置、共享策略或企业对象，不借回滚重写提交历史。
- IAM／OS keychain／企业凭据／持久审计未验保留边界；内存审计仍是试点。不开放默认远端写，不新增 merge／close／release／workflow／change done。

## 12. 本技术阶段交付边界

已执行 worktree／Git 状态和 HEAD 核对，Node／pnpm／DSH 版本读取，Inspect 只读发现，一次当前 run 的 teamflow_status，以及相关仓库／已装宿主源码取证。仅写本技术文档及规定机器通道；未改产品代码／profile、未提交、未安装、未启动／续跑业务 run，未触碰主目录。

文档结构／链接／机器通道验证结果见最终回复。这些静态验证不等于 pnpm check、真实最终提交／续跑／只读审查、目标 rc.3、企业 Gitee／dop 关联、IAM／凭据、Windows／麒麟或生产规则通过。接收技术方案不等于解除 M1 或验收代码。

下一步由发起端先处理授权 worktree 交接一致性、最终提交前缀能力、权威关联与独立只读证据，再释放条件化实施。当前能力确实不足时按 PRD 报具体阻塞或另行批准切片，不能偷换成第二引擎。
