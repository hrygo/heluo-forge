# @heluo/forge-policy

状态：可用（P0 受控写最小门禁 + P1 身份永远开、人工确认卡片与决策复用 + P2 内容闸 + P3 流程闸的四条纯参数规则、未登记动作/人工留痕/受保护路径三个语义开关与只读命令 `/policy-audit`；未接企业环境，未做双端实机）

一句话：只对目录里登记的写动作负责——登记动作必须解析出 IAM 身份、先落前置执行记录再放行、执行前复验身份与参数、执行后结清；`gitee.git.push` 与 `change.clarification.write` 在开关开启时经宿主 `userQuestions` 卡片按次确认；未登记的工具与动作默认不在本门禁作用域，直接放行且不读身份、不记审计，开启 `denyUnknownAction` 后才拒绝未登记写；七条规则开关代码默认全关，且七条都已接入判定链路，置真即生效。

| 项 | 内容 |
|---|---|
| 形态 | Host 插件（提供 `policy` 服务） |
| 职责 | 受控写动作的身份校验与前置审计、执行前复验、人工确认与决策复用、命令面同源判定、组织信封上限、受保护路径查询、语义开关（未登记动作/人工留痕/受保护路径）与审计查询命令 |
| 不负责 | 不替代服务端鉴权；不拦截未登记的工具；不对读动作做统计或审计（`denyUnknownAction` 只拦未登记写）；不维护独立 hook 引擎 |
| 衔接点 | `tools/pre-execute`（await 判定、身份与前置审计）、`tools.guard`（同步核验一次性收据）、`tools/result`（兜底结清）、宿主 `userQuestions`（确认卡片）、`ctx.commands`（命令面）、`policy` 服务 |
| 详细设计依据 | CORP-DSH-DESIGN-003；分阶段实施见 [实施计划 §5](../../docs/plans/2026-11-19-policy-minimal-gates.md#5-实施计划) |
| 实现状态 | 目录编译、判定合成、身份校验、恒开审计（memory/file 两种落点）、一次性收据与执行前复验、命令注册、组织信封验签、路径检查、过程观察投影、确认卡片与决策复用、内容闸（9 条内置规则、按动作字段映射、跨字段字节预算、截断与读不到语义）、流程闸（保护分支、强制推送、验收小节、评审来源四条规则；正文类规则读 `exec.content` 快照）、三个语义开关与只读 `/policy-audit` 均已实现并有离线用例 |

## 当前实现

| 项 | 状态 |
|---|---|
| 目录 | `compileCatalog`：只接受 `action`/`target`/`category`，未知字段（含旧键 `revision`/`enabled`/`kind`/`egress`）与未分类动作一律拒绝装载；类别与默认决策来自内置分类表，运行期不读工具自报属性 |
| 判定 | `decideAction`：未登记动作默认按 `out-of-scope` 放行；`denyUnknownAction` 开启后未登记写动作（dev-write/review-write/remote-write/human-record）改为 `unregistered-action` 拒绝，未登记只读动作仍是 `out-of-scope`；登记动作缺业务目标即拒绝；人工留痕动作在 `denyHumanRecord` 关闭时按 `out-of-scope` 放行、开启即拒绝；其余登记动作放行并进入身份与审计阶段。`confirmPush` 开启时只有 `gitee.git.push`、`confirmDopWrite` 开启时只有 `change.clarification.write` 进入确认阶段，其余写动作不弹卡；`enforceProcessRules` 开启时先过流程闸（硬规则直接拒、软规则在有确认通道时并入确认卡） |
| 流水线 | `buildPipeline` 按已实现的开关装配阶段：`resolve → identity → audit → receipt` 常开；`denyUnknownAction`、`denyHumanRecord`、`protectPaths` 在身份之后依次插入，流程闸在内容闸之前，内容闸在确认之前，确认阶段在审计之前；关闭的规则不出现在阶段表里，因此不会"进入后放行"，也不会因为走过阶段而多写审计 |
| 身份 | 登记动作必须解析出 IAM actor（宿主 IAM 视图）；解析不出即拒绝，文案指向「设置 → 账号」完成登录后重试；子 Agent 继承父会话身份，不单独查 |
| 内容闸 | `contentGate` 开启时按动作声明字段扫描正文（issue/pr 的 title+body、review 的 body+comment、变更澄清的 summary+description+aiAc、push 的提交消息与 diff），未知动作退回全局白名单；9 条内置规则分三档：私钥块与云长期密钥不可确认（HARD 直接拒绝），带凭据连接串与常见令牌可确认，`.env` 提交、内网地址、本机绝对路径、超长 base64 只记录；一次调用的所有字段共享 256 KiB 预算（`content.maxBytes`），超出部分记 `truncated` 后按已扫内容判定，二进制跳过；正文读不到按放行并在审计记 `content:unreadable`，该结论不进复用缓存；扫描器自身失败按不可确认拒绝（`POLICY_CONTENT_SCAN_FAILED`）；命中值与正文都不进审计、卡片与错误文案，只留首尾各 4 字符的脱敏摘录 |
| 确认卡片 | 一次 `ask`、每题一对固定标签「允许本次写入 / 取消本次写入」，只有每题都恰好选中允许标签才放行；动作确认与内容风险同时成立时是一次 `ask` 带两题（先动作、后内容），客户端按题分步呈现、最后一次提交；其余应答（缺失、结构非法、未知标签、带自定义文本）一律按未确认拒绝。卡片只含动作可读名、目标定位与原因类别，不含正文、参数原文、令牌或绝对路径 |
| 确认超时 | 默认 120000 ms（`confirmation.timeoutMs`，装载期校验为正整数）；超时映射为 `POLICY_CONFIRM_TIMEOUT`，文案明确是等待超时而不是用户拒绝。判定由本包自己的计时器执行，宿主侧挂起询问在结论落定后立即 abort |
| 无 UI 环境 | 没有可用的 `userQuestions` 服务时装载照常完成并给出一次告警，但每次需要卡片的受控写都以 `POLICY_CONFIRM_UNAVAILABLE` 拒绝（fail-closed），不会降级为直接放行 |
| 错误码 | 八类结论各有唯一码：`POLICY_CONTENT_HARD`、`POLICY_CONTENT_SCAN_FAILED`、`POLICY_CONFIRM_DENIED`、`_TIMEOUT`、`_UNAVAILABLE`、`_INVALID_ANSWER`、`_DELEGATED`、`_ERROR`；码同时出现在结构化判定结果与审计里，用户文案不拼码 |
| 决策复用 | 只缓存"允许"的决定，键为 `工具名 + callId + 动作 + 参数摘要`，同一键的重试不再打扰用户但必须重过身份校验、一次性收据与执行后复验；拒绝、超时、无应答、非法应答、执行失败与正文读不到都不入缓存。缓存最多 32 条、进程内 LRU、不落盘，卸载即清空 |
| 子代理来源 | 需要人工确认的写由存活的主会话根代问（卡片弹在主会话，正文写明「本次写入由子代理发起」）；找不到唯一存活的根才以 `POLICY_CONFIRM_DELEGATED` 拒绝。不需确认的写与主会话同路径，不因来源被拒 |
| 审计 | `audit.begin` 在放行前落记录（主体取 provider 自证、身份单列 `actor`、摘要覆盖参数与正文），`audit.settle` 执行后补 `durationMs` 与 `decision`；memory 是进程内环形缓冲（默认 1000），file 按天一个 JSONL、保留 `keepDays` 天；写入失败中止本次受控调用给可操作提示，绝不静默回落 memory；上一次未结清时下一次受控写中止，缺口由 `auditGaps()`/`acknowledgeAuditGaps()` 处理 |
| 记录最小化 | 只写白名单字段；`arguments`/`content`/`stdout`/`stderr` 等禁用字段直接报错；`params` 只存摘要，路径只留尾 4 段 |
| 收据 | 一次性收据绑定同一执行对象与静态摘要；`tools.guard` 同步核验并消费，执行前 `recheck` 复验卸载、取消、参数与身份变化，任一变化即拒绝执行；结清立即释放准入条目（`pendingAdmissions()` 可查在途数） |
| 命令面 | `policy.registerCommand`：未登记动作拒绝注册；判定、身份、前置审计与结清复用同一屏障；简单命令须有明确业务目标，结构化命令提供 `resolveArguments(invocation)`，处理函数第二参数为规范化参数 |
| 受保护路径 | `protectPaths` 开启后按"会话工作区 cwd + `protectedPaths`/`paths.append` 追加根"判包含：`path`/`file` 字段任意深度、`target` 仅在可确认为路径时判定；工作区内固定九类文件名（`.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc`、`.netrc`、`credentials*`、`*.p12`）与追加根命中即拒绝，证据只记 `name:<pattern>`/`root:<template>`，不写绝对路径；工作区外交给沙箱；工作区不可得、符号链接循环或不可判定一律 fail-closed。服务暴露 `protectedPaths()`（仅配置的追加根模板）、`checkPath(candidate, workspaceRoot?)` 返回布尔（true = 已判定且受保护）与 `judgePath(candidate, workspaceRoot?)` 返回 `{ judged, protected, category? }` |
| 审计查询 | 宿主有 `ctx.commands` 时注册只读命令 `/policy-audit [N]`（默认 20、上限 200）：按新 → 旧展示最近记录，八列 `时间/阶段/动作/目标/决策/规则/耗时/agent.kind`，memory 与 file 落点同构；无记录、审计源不可读与坏行分别给可操作提示；不写审计、不改策略状态、不触发重扫 |
| 组织信封 | `heluo.policy.org.v1` 的 Ed25519 验签信封：`verified` 进托管模式、`absent` 是个人模式、`invalid` 只降级写动作；`caps` 只能收紧不能放宽 |
| 过程观察 | 默认关闭导出；有界内存缓冲、按契约字段白名单整条拒绝未知载荷；观察链路故障只降级观察，不改变判定与必要审计 |
| 生命周期 | 卸载撤销 guard、监听器与服务；等待确认、前置审计或下游 listener 期间卸载/取消，旧调用仍拒绝；已获准但结果未明的调用留 `unknown` 缺口，不伪造完成、不重放；已挂载时拒绝再次挂载 |
| 安全 | 目录无效、受保护根模板未解析或宿主缺少 `tools.guard` 时拒绝挂载；**不提供 fail-open、通用 `run(command)` 或正则黑名单式保证** |

## 规则开关与交付边界

三个语义开关（`denyUnknownAction`、`denyHumanRecord`、`protectPaths`）默认关闭、可独立开启、只收紧权限、依赖不可用时 fail-closed；关闭时不生成流水线阶段、不读身份、不写审计。`gitee.review.record`（及工具 `forge_gitee_review_record`）在 `denyHumanRecord` 开启后由本包拒绝，命令面的人工记录仍由 `POLICY_COMMAND_ACTION_RESERVED` 拒绝；受保护路径默认九类、只能追加不能缩减，归一化失败按拒绝处理。

流程规则中依赖 dop 变更状态与计划状态的两条（`change-in-progress`、`plan-confirmed`）要等事实源注入后才参与判定；在此之前它们不参与判定，也不存在"配了却静默不生效"的中间态，其余配置面见[实施计划 §5](../../docs/plans/2026-11-19-policy-minimal-gates.md#5-实施计划)。

## IAM隔离许可算法

[私有算法](<src/iam-consumer.mjs>)与[显式测试入口](<src/isolated-testing.mjs>)已实现许可准备、原件同步复验、单次发送与结果收束；62项新例及210项policy全包回归通过，独立审阅关闭。它绑定实际执行对象、原arguments对象与摘要、原会话见证和原许可；不把operation或许可放进exec/arguments，不借新会话重试。

这些是局部算法与合成授权控制器证据，不是实际IAM、SDK工具或模型联合接通证明。普通apply没有注入这些私有来源。

[合成工具/命令入口](<src/iam-consumer-tools.mjs>)已在本地SDK-shaped注册链通过31项新例与241项policy回归，独立审阅关闭。原操作贯穿pre、审计、同步guard、callee等待与发送；owned finalizeContent在post后收束原操作，result观察者只清理、不撤回。IAM来源消失时工具闸仍留；owner卸载撤自己能力。命令内部执行标识由owned adapter生成，不是SDK Invocation字段。

[合成模型入口](<src/iam-consumer-models.mjs>)已实现，并经29项新例及270项policy回归验证，包含最终错误桥修复与独立复核。显式测试入口的模型工厂只装配控制器独享route，在实际进入owned adapter.stream时准备许可，不以metadata prepareCall或外层stream创建当作认证起点。原operation贯穿异步等待与流式片段检查，失效不借新许可继续；fixedLlmFailure只输出固定code/message，错误carrier按已核SDK ABI收敛。

这些是私有API的本地SDK-shaped证据，普通apply不启用、不改变默认模型、不接真实provider。根组合另有16项实际IAM工厂＋mock IdP联合验证，覆盖public/Basic及不同issuer/person整体替换；不是同issuer纯换人或真实提供方联调。maxRetries=0只约束内置与受控caller原操作，不证明任意恢复listener不会重试；已经输出的片段不能撤回。真实人员/用途、提供方权限及五分钟撤权仍需独立验收。

## 边界

- 门禁只约束**经工具调用的正常路径**：同权进程内代码（同进程 JS、直接调服务方法）能绕开本包，安全声明不覆盖这类绕过。
- 未登记的工具与动作（含全部读动作）默认不在作用域：既不查身份也不写审计，因此本包不能用来统计读取行为，也不能声称"所有工具都受控"；开启 `denyUnknownAction` 后只额外拦截未登记写动作。
- 审计记录是本地记录：memory 落点随进程退出丢失，file 落点按天保留 `keepDays` 天；都不构成企业审计留存，企业落点未获准前不得当作合规证据。
- 客户端策略不能替代服务端授权；本机管理员可改配置，因此服务端仍须独立鉴权。
- 命令面：宿主没有全局命令拦截 seam，本包只能对**经本包登记**的命令兑现同一判定；其他插件注册的命令不在其内。
