# IAM 模型与工具隔离消费实施计划

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-007 |
| 文档名称 | IAM 模型与工具隔离消费实施计划 |
| 版本 | V0.6.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-03 |
| 门禁 | 用户已批准完整 source/mock 设计；A/B/C/D已分段验收，E根16项通过；源码、联合审阅与本批完整检查已完成，不动真实环境 |

> 编制依据：用户于 2026-11-02 完整批准 [DESIGN-017](<../design/iam-consumer-isolated.md>) 与 [IAM-003](<../contracts/iam-consumer-isolated.md>)，明确仅实施模拟代码；先完成 [PLAN-006](<2026-11-02-iam-confidential-isolated.md>)的机密 C 验收。
>
> 关联文档：[总体架构 ADR-22](<../architecture/platform-architecture.md>)、[设计索引](<../design/README.md#221-iam-离线验收清单>)、[开发约定](<../engineering/development-conventions.md>)。

**实施方式**：单个 source writer 顺序交付，独立 reviewer 只读；root 维护文档并在必要修复后独占完整检查。不另开并行 IAM writer，不提交、不安装。直接执行任务时使用 executing-plans；每项均按 RED→最小GREEN→必要重构。

## 1. 目标、技术与约束

目标是在实际 IAM 工厂的模拟账号上，验证合成模型与工具的必要执行条件；不是把账户页或第二份假 signedIn 当作端到端证明。平台范围与指标仍以[需求基线](<../requirements/requirements-baseline.md>)为唯一真源。

技术沿用 Node24.21.0、ESM、node:test、可注入时钟与 fetch、现有 mock IdP；不加外部依赖、不改 SDK 或当前 profile。模拟 adapter 只装在本地 SDK-shaped harness，不注册真实 provider 或改变默认模型。

全局约束：

- IAM-003 是唯一字段真源；私有 registerWitness、两种 bindingScope getter、verifyWitnessBindings 与 verifyConsumerSources 不得偷换为配置布尔或 source 自证。
- marker 必须在实际认证/采纳等待链前固定、成功结束时复查；不能 capture 新 marker 追认旧 ready。provider binder 与 secret 控制器分别驱动本对 getter；不新建全局控制器。
- 见证与 operation 不含 token/secret/整 grant，不捕获 secret-bearing operation 或原 snapshot；公共分支零访问秘密来源属性。
- IAM 缺席时闸仍拒绝；消费 owner 卸载撤自己的合成能力。普通未登记工具不受新增规则影响。
- 每次 await 后与实际发送、结果采用边界检查原件；失效不借新会话或新许可继续，不自动重试已发送/未知结果。
- 保留现有只读模型、issuer、单记录和网关联合门禁；不加存储 key、锁、lease、跨包源码引用或生产新 API。
- 真实 apply 不传见证/许可测试选项，不探测隐藏来源；不读写真实 keychain，不 stage/commit/push/install/publish。

## 2. 文件职责

现有源文件仅作必要接缝：

- [IAM service](<../../packages/forge-iam/src/service.mjs>)：实际生命周期同步失效、认证链前取样与成功采纳后的非秘密 pin。
- [client-auth](<../../packages/forge-iam/src/client-auth.mjs>)：仅在确有需要时暴露内部来源已具体认可、read前的非秘密取样点；不把认证 operation 交给见证。
- [policy index](<../../packages/forge-policy/src/index.mjs>)与[gate](<../../packages/forge-policy/src/gate.mjs>)：复用既有 pre/guard/命令屏障，不改变普通 apply 默认行为。
- 两包[清单 IAM](<../../packages/forge-iam/package.json>)/[policy](<../../packages/forge-policy/package.json>)：必要的显式隔离测试导出；原根入口和 bundle 不激活该能力。

拟新增文件（名字为实施定位，不代表已存在）：

```text
packages/forge-iam/src/consumption-witness.mjs       工厂私有非秘密见证与代际
packages/forge-iam/src/isolated-testing.mjs          显式测试工厂入口，不注册插件
packages/forge-iam/test/consumption-witness.test.mjs 实际public/confidential工厂用例
packages/forge-policy/src/iam-consumer.mjs           小型操作准备、同步复验及单次发送
packages/forge-policy/src/isolated-testing.mjs       合成工具/模型装配测试入口
packages/forge-policy/test/iam-consumer.test.mjs     来源、许可及操作负向
packages/forge-policy/test/iam-consumer-tools.test.mjs
packages/forge-policy/test/iam-consumer-models.test.mjs
tests/iam-consumption.test.mjs                      两包公开测试导出的实际组合
```

跨包运行时仅按两包清单精确登记的 package exports 访问，拒绝未导出 subpath；不写跨包 src import、不安装包，不加运行时 fallback 或通用 resolver。根组合测试可相对复用已核验的纯 test/support scaffolding：mock-oidc、memory-credentials、client-secret-source 及 tool/model-runtime；这些只提供模拟下游与调度，不导入内部 src/factory，不绕过公开测试导出，不伪造 witness。所有新导出目标必须在既有 files 包体中，包体检查仍通过。

## 3. 逐项 TDD 交付

### A. 实际工厂会话见证

- [x] 前置核对 PLAN-006 最终有效完整结果、七源码冻结与 peer；不能以851定向替代该门禁。
- [x] 写实际 IAM 工厂＋mock IdP 测试：未登录无见证，public/confidential 正常登录/恢复/刷新后可捕获；先运行确认 RED 来自缺接线而非环境。
- [x] 实现 IAM-003 registerWitness/capture/isCurrent；工厂私有映射只保留最小非秘密字段、有效期与代际。真实 apply 不传新参数；无注入时不访问这些私有 getter。
- [x] 在实际认证等待链前固定来源与 marker，read前须已有具体来源认可；末端原 guard 和 marker均有效且会话真正采纳后更新 pin。登录/恢复/刷新失败不更新。
- [x] signOut/cancel/dispose 在首个 await 前失效；新采纳、真实解绑/重绑和 getter替换拒绝原见证。
- [x] 增补 RED→GREEN：只rotate不sync的旧ready、同对象provider ABA、同值/同revision恢复、伪造恒定scope、Promise/throw/getter变更。单独更新marker不能使未登录变可capture。
- [x] 验证缺失见证信号仅拒绝隔离消费，不改既有 public/confidential服务语义；跑原client-auth/lifecycle/issuer/store/只读模型定向。

### B. 独立许可与私有操作

- [x] 写RED：来源未经认可、issuer/subject/kind/target/purpose不符、过期、异步verifier/current均下游0。
- [x] 小模块实现许可准备、原见证/许可同步复验、单次发送与释放。具体内部函数名可由builder选择，不改变IAM-003五项认可签名。
- [x] 原执行对象、scope和规范化输入固定于私有映射，不放exec/arguments，不依赖调用方可写字段。来源、getter、owner注册代际的替换均拒绝旧operation。
- [x] 对原件身份与独立字段副本复核；许可撤销、时钟到期、输入变异、非法Promise与异常固定脱敏拒绝；不能复读新许可挽救旧操作。
- [x] 结果未知与取消迟到成功/错误不重放、不污染新上下文；正向恰好一次，重复消费原operation拒绝。

### C. 工具实际屏障

只读接线依据（2026-11-02）：tools.guard接收Readonly<ToolExecution>并同步返回拒绝字符串或undefined；pre为exec/next异步决策。当前安装SDK的ToolRunContext继承ToolExecution，实际body使用同一exec与冻结arguments，private WeakMap可桥接原receipt。signal会融合，不按其引用恒等绑定；不以callId或复制DTO取代实际execution。 post waterfall可短路，result observer不能撤回；owned finalizeContent(exec,result)可在post后同步复验同一exec并收束原op。命令Invocation只有commandId/agent/rawInput/attachments/signal；owned adapter显式mint私有执行标识，不能宣称原生root/token或伪造agent。


- [x] 只读 Inspect 核对 tools.guard/pre/execute 的当前签名和归属，local harness 使用真实契约形状，不调用当前profile业务服务。
- [x] 写RED：已登记合成 action 在IAM缺席/退出/失效时实际handler零调用；普通未登记工具不受影响。
- [x] 复用policy异步pre、必要审计与同步单调guard；私有隔离装配与普通apply共用执行体，不从配置开放scope。命令共用屏障不得绕过。
- [x] callee内部还有await时在最终假发送前同步复验。逐点控制许可/审计/listener/callee/结果等待，不能仅测前置判断。
- [x] IAM卸载不移走闸；owner卸载撤合成action并失效旧operation。恢复/重绑同实例不恢复旧许可。

### D. 模型实际合成发送体

只读接线依据（2026-11-02）：registerAdapter(providers[],adapter)返回fiber归属disposer及replace，注册时还同步调用providerInfo(provider)返回id/name、providerRetryPolicy(provider)返回ResolvedRetryPolicy或undefined。plain mock显式实现实际被调用方法，不假借LlmAdapter基类。

llm.prepareCall(config,signal?,configure?)返回PreparedLlmCall；adapter.prepareCall(provider,model,signal?)才返回model与stream。两者stream均为函数stream(options:GenerateOptions):AsyncIterable<StreamChunk>，非Promise、裸Iterable属性或Omit。实际派发按provider取adapter，await其prepareCall并校验model，再调用stream取得asyncIterator；不自动调用listModels。

认证取样起点是实际进入 owned adapter.stream 的非 async 包装函数，不是 metadata prepareCall 或外层 stream 创建；外层立即进入 waterfall，默认下游 lazy 到迭代才派发。GenerateOptions必需provider/model/messages，可选signal等；无agent/callId/root/token。内部执行frame必须明确为owner生成的本地元数据并绑定原options，不能冒充SDK字段；业务许可purpose不写进SDK仅compaction/session-title的purpose。finish.reason为kind对象，不是字符串。provider catalog不等于已注册路由。

ResolvedRetryPolicy的normal形态有maxRetries/retryableCodes，以及initialDelayMs/maxDelayMs/jitterRatio；合成adapter显式maxRetries=0、空retryableCodes关闭内置重试。undefined会选默认5次。其他request-error listener仍可经next要求重试，没有全局强制不可重试码；只断言受控caller与原owned operation不重放，不拿fixture证明任意恢复插件行为。


- [x] 只读 Inspect 核对 adapter定义、注册、流式结果和取消形状；不把llm/stream waterfall当全局硬闸。
- [x] 写RED：合成adapter已被实际调用但发送前两道门不满足时，假模型调用0；满足时仅1次。不得直接调用判定函数冒充adapter测试。
- [x] 在控制器独享合成route的adapter执行体使用同一操作模块；不触碰真实provider/默认选择，不自动重试。
- [x] 验证异步准备/发送/流式结果间失效、取消及owner卸载；已发请求不可撤回，旧片段和错误不采用。保留需求对已接收流可按截止结束与本地退出取消的区别，不推导真实提供方能力。

### E. 组合、审阅与终态文档

- [x] 根组合测试只用实际IAM工厂、mock IdP、公开测试导出、合成工具与模型；不同时改两份假登录状态。
- [x] 按DESIGN-017四组要求保留分段证据与实际联合子集；根16项正向仅限已登记scope，包含不同issuer/person整体替换，不冒称同issuer纯换人；凭据、秘密不进入请求、提示词、日志或结果。
- [x] writer冻结后独立peer与一项代表性内存变异；先修必要finding，不扩无界fuzz或大框架。
- [x] 同步随包指南、契约与索引：明确已实现模拟执行屏障，真实原生provider、人员授权、网关及五分钟仍未验证。随包材料不得链接包外文件。
- [x] 最后唯一有效完整检查并收集输出：`DSH_KEYCHAIN_SPIKE=0 mise exec node@24.21.0 -- pnpm check`；再检查文档与tracked/new空白。无新修复不重复有效全仓。

## 4. 当前证据

A/B/C/D分段验收已关闭，E根16项实际IAM组合已通过定向验证；分段、联合独立审阅与本批完整检查均已完成。联合中的IAM是真实服务工厂，IdP与执行接缝仍是本地模拟，不代表真实提供方接通。

| 证据 | 实际结果与边界 |
|---|---|
| A新增 | 实际工厂与mock IdP 57项；明确issuer的public/Basic/Post登录、恢复、刷新与失效交错 |
| A合并 | 显式Node24、关闭keychain spike；760/760通过，0失败/跳过/取消，18.408586042s，exit0；含原C54、41错误脱敏、public/issuer/store/只读模型/package-shape |
| A独立peer | 无剩余必要源码修复；六owned文件指纹与freeze一致 |
| A代表性变异 | 只内存删callback禁止补票null sentinel；原57有1项因错误获得witness失败，56通过/1语义失败、exit1；正版57通过、exit0；六hash前后不变 |
| A保守边界 | 首次discovery-only开始时issuer未知，不生成原ticket，callback不补票；后续metadata已知的真实sync/resolve成功重验证才可能给见证；不宣称首次discovery正向已测 |
| B局部算法 | 62新例；policy全包210/210通过，0失败/跳过/取消，72.202125ms、exit0；148原用例保持，未改index/gate/egress |
| B独立peer/变异 | 无必要剩余修复；内存仅去arguments身份比较保留digest，原62有1项错误send成功，61通过/1语义失败、exit1；正版62通过、exit0；五hash前后同 |
| B证据限度 | source/authorizer fixture仅局部算法控制器，不是实际IAM联合；C/D/E的独立证据另列，不能以B替代 |
| C实际合成接线 | 31项新例；policy全包241/241通过，0失败/跳过/取消，148.294917ms、exit0；包含末次callee late-error current修复及原62B/148policy |
| C独立peer | 无必要剩余修复；SDK raw register/view/get保原definition引用，owned finalizer抛错会丢旧canonical value物化error；八hash前后同 |
| C代表性变异 | 只内存noop owned finalizer，其余守卫保留；原31中normal/短路post失效两项错误旧success，29通过/2语义失败、exit1；正版31通过、exit0 |
| C证据限度 | 本地SDK-shaped registry及B算法源，非实际IAM联合或真实宿主业务；不声称任意非owned observer受保护 |
| D实际合成接线 | 29项新例（含最终错误桥修复）；原241项加D新例共270/270通过，0失败/跳过/取消，100.079375ms、exit0；非Native profile或真实provider业务 |
| D错误桥RED→GREEN | 必要桥修RED为29项中27通过/2语义失败；fixedError改为自身冻结failure数据且carried.code与自身code一致，受控carrier保允许字段，普通Error.code仍按SDK UNKNOWN处理；最终采用上述270项结果，不以中间267项代替 |
| D独立peer与桥接增量 | 无必要剩余finding；只对新增3项桥接用例独立复核，3/3通过、无unhandled rejection，六文件hash前后同；fixedLlmFailure固定code/message符合已核实际SDK错误ABI |
| D代表性变异 | 只在内存删除stream结果复验，原26项中23通过/3语义失败，覆盖first/later/owner-unload旧片；正版26项通过。最终桥修后stream守卫后缀逐字节未变，沿用该变异证据，不声称对最终29项重跑同一变异 |
| D证据限度 | 认证起点仅实际owned adapter.stream；normal/maxRetries=0仅约束内置与受控caller原操作，不保证其他request-error listener零重试。已yield片段或已发HTTP不能撤回；D本身仍是局部接缝，实际IAM联合另见E证据 |
| E根组合 | [根测试](<../../tests/iam-consumption.test.mjs>)16项＋两包shape8，共24/24通过，0失败/跳过/取消，415.105792ms、exit0；仅本地actual IAM工厂＋mock IdP＋原SDK-shaped注册链 |
| E根装配RED→GREEN | 原15项7通过/8语义失败；实际登录与独立许可已成，未显式登记实际consumer时拒绝发送。只登记returned工具/命令definition与adapter，未削弱业务guard |
| E原独立peer/变异 | 原15无必要finding；内存只让binder按对象ref变化换marker，14通过/1语义失败：旧实际witness错误保持current；即时断言即失败，未到发送，不声称错误send1。正版15通过，两hash前后同 |
| E账号替换补充 | 新focused RED为两个实际账号已登录但未转交注册，旧A错误send1；补actual factory registerWitness转交后合并24通过。A旧source/witness/permit仍current时旧op拒绝，旧disposer不擦新B，显式新B许可后新调用成功。原15与binder字节未变，沿用原marker变异，不声称新16重做；最后delta独立focused 1/1通过、无after-test/unhandled，两hash前后同；未重复原15/marker变异或合并测试 |
| E边界 | 明确issuer public/Basic、不同issuer与subject整体替换；非同issuer纯换人、discovery首次ready、真实provider、人员用途/网关授权、五分钟撤权或网络策略。21个已冻A/B/C/D文件完整指纹保持 |
| 最终完整检查 | Root在冻结源码上执行`DSH_KEYCHAIN_SPIKE=0 mise exec node@24.21.0 -- pnpm check`：1889总项、1887通过、0失败/取消、2跳过，47239.28425ms、exit0；无重复有效全仓 |
| 完整检查前置链 | docs55文件/464表/743本地链接/93锚点/24受控文档通过；repo24入口/10包/2服务/2workflows/616 tracked通过；bundle7包/139文件通过；版本基线0.2.1-rc.3校验通过，既有rc.2候选例外未改变 |
| 两项跳过 | 真实macOS keychain spike由显式DSH_KEYCHAIN_SPIKE=0关闭；Windows 8.3别名实机测试不适用当前平台。不是IAM新增用例跳过，不冒充真实平台安全证据 |
| 本批完成边界 | A/B/C/D/E规定的source/mock执行边界已验收，既有真实Host只读策略保持；Remote迁移、凭据probe等后续候选仍按准入单独收口，整个IAM目标未据此关闭 |
