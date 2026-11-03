# IAM 模型与工具隔离消费设计

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DESIGN-017 |
| 文档名称 | IAM 模型与工具隔离消费设计 |
| 版本 | V0.7.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-03 |
| 门禁 | 用户已批准完整 source/mock 设计；真实环境保持关闭 |

> 编制依据：用户于 2026-11-02 批准完整“假账号、假模型、假工具、不动真实环境”的隔离消费设计及仅模拟代码实施；先完成机密服务本批验收，不授予真实环境或团队准入。
>
> 关联文档：[IAM-003](<../contracts/iam-consumer-isolated.md>)、[实现验收索引](<README.md#221-iam-离线验收清单>)、[需求基线](<../requirements/requirements-baseline.md>)。

## 1. 先说清楚验证什么

本设计验证：没有有效登录或没有对应权限时，模型和工具不能执行；退出、换人或授权失效后，旧调用不能继续取得新结果。

账号经过实际 IAM 工厂与 mock IdP 登录。模型和工具是测试控制器独享的假下游，只记录调用次数和返回合成结果。控制器不另造一份 signedIn 状态。

用户于 2026-11-02 完整批准本设计与 IAM-003，并选择仅实施模拟代码。机密服务本批验收后再实施；不批准真实调用、当前 profile 变更或真实默认模型保存。

需求唯一真源仍是[需求基线 §2](<../requirements/requirements-baseline.md#2-范围边界唯一真源>)；人员、用途与退出要求见[§4.6](<../requirements/requirements-baseline.md#46-模型访问身份与专用凭证要求>)。本设计不改变平台形态与真实默认模型严格只读策略；拟议信任边界记录于[总体架构 ADR-22](<../architecture/platform-architecture.md>)。

## 2. 两道门，各自证明什么

| 门 | 证明 | 不证明 |
|---|---|---|
| IAM 会话见证 | 实际工厂已采用同一会话；实例、绑定和认证代际仍连续 | 人员已开通某模型或某工具 |
| 独立合成授权源 | 该见证对应人员可在当前合成 target/purpose 下执行 | 真实企业网关权限、额度或五分钟撤权 |

两道门同时有效，才允许一次假下游调用。缓存 ready、getPrincipal、官方 Key、source 自报可信或配置布尔均不能代替其中任一道门。

字段、私有签名与错误草案集中在 [IAM-003](<../contracts/iam-consumer-isolated.md>)，不建立公共 Cordis Service、HTTP/Remote 或持久许可格式。

## 3. 为什么需要最小私有见证

当前[模型模块](<../../packages/forge-iam/src/model-gate.mjs>)只做纯判定；getView/getPrincipal 是缓存只读，不提供操作级会话连续性证据。测试专用注册回调已由实际 IAM 工厂交出只读 witness source；它只能见证本地会话，不授业务权限。

见证在 signOut、cancel 和 dispose 的首个 await 前失效。会话采纳、实际 provider 解绑或替换使旧见证失效。绑定控制器只表达真实依赖的绑定代际，不维护第二份登录真相。

只读设计审阅确认需要非秘密绑定信号：凭据对来自实际 provider binder，来源对来自实际 secret fixture 控制器，两者由可信组合精确配对认可，不另建全局控制器。marker 在真实解绑、重绑、轮换、删除和恢复时同步换代，旧对象不复用。

工厂在对应认证/会话采纳的 await 链开始时先固定 marker（来源已具体认可后、read 前）；结束时复查一致且认证 guard 仍有效，成功采用后才更新见证 pin。不能到 capture 时取新 marker 给旧 cached ready 背书，也不把原秘密 snapshot、secret-bearing operation、相关闭包或整份 grant 挂到见证。

缺少可认可的真实控制入口时，相应消费保持拒绝。私有会话见证已由实际工厂与 fixture 绑定入口实现并分段验收，不改变已批准 IAM-002 的 source 接口；实际IAM与下游消费者已有根组合验证；最终证据按PLAN-007收口，真实原生入口仍未接。

## 4. 工具与模型分别接在哪里

### 4.1 工具：复用 policy，不随 IAM 卸载撤闸

复用[现有 policy 执行屏障](<../../packages/forge-policy/src/index.mjs>)及同步 tools.guard。消费 owner 与 IAM 实例分别拥有生命周期；IAM 缺席时保护仍在，只返回拒绝。仅处理测试组合明确登记的合成 action；普通未登记工具保持原有行为。

许可准备和必要审计在异步阶段完成。最终 guard 只同步复验原见证、原许可、同一执行对象与规范化输入，不 await。若合成 callee 自身还要 await，发送前再次同步复验，复验到假下游之间不再 await。未经该入口的工具不在声明范围内。

2026-11-02只读Inspect与当前安装SDK派发源码确认：ToolRunContext继承ToolExecution，pre、guard、execute waterfall到tool body沿用同一个execution对象及冻结arguments。私有WeakMap可以取得原operation，不需把许可附到exec或在body重新prepare。signal会由wrapper融合，不能用signal引用恒等作为授权绑定；这是当前安装实现证据，不是跨版本保证。

同次只读核验确认：post是可短路waterfall，tools/result仅观察冻结结果，无替换或拒绝通道。只有definition-owned同步finalizeContent能在post后取得原exec复验；这不是通用ResultGuard。合成工具可在自己的该hook中收束原operation，不声称任意工具、任意后续observer都受保护。CommandInvocation没有root/token字段；私有命令适配显式生成内部执行标识，不冒充SDK原生。

### 4.2 模型：在合成 adapter 的实际执行体检查

只为测试控制器独享的合成 route 装配 callee。检查位于实际进入 owned adapter.stream 的非 async 包装函数，不在 metadata prepareCall 或外层 stream 创建时取样。外层 stream 立即进入 waterfall，默认下游 async generator 则延迟到迭代才派发；本地 SDK-shaped harness 按该时序装配，不宣称已接真实 Host。此入口不修改真实原生 provider，不覆盖默认选择，不注册生产 route。

2026-11-02 的 SDK Inspect 确认 llm/stream 是 waterfall，可被其他 listener 短路，不能写成任意顺序下的硬闸。合成 adapter 发送边界由测试组合独占，才可断言下游零调用；无法插入该边界的真实消费者保持未接。

合成adapter显式返回normal/maxRetries=0策略，受控caller不自动重放未知结果；这不是宿主全局重试硬闸。当前SDK的恢复插件仍可经其他request-error listener要求新调用，没有通用强制不可重试标记。本阶段只验证受控caller与原owned operation，不能由错误分类推定任意宿主监听器都不会重发。

### 4.3 依赖与卸载

测试组合单向装配 IAM、policy 和合成消费者；IAM 不导入 policy，policy 不导入 IAM 源码。必要测试入口从既有包显式导出，不跨包导入 src，不新增包或通用许可框架。

IAM 卸载只移除见证来源，消费闸保持拒绝。消费 owner 卸载时撤销自己拥有的合成 route/action，并使旧操作失效。框架不具备的跨 owner 原子卸载不得由 fixture 冒充。

## 5. 一次调用如何结束

1. 固定原 IAM 实例、见证来源、独立授权源、执行对象及精确 scope。
2. 从实际工厂取得一次见证，再取得独立许可。
3. 每个 await 后复验原件与代际；不借新会话或新许可挽救旧操作。
4. 最终同步 guard 通过后，假下游只发送一次。
5. 结果采纳前复验取消和生命周期；迟到成功或错误不覆盖新上下文。
6. 已发送而结果不明时报告 unknown，不重发、不补偿，不宣称撤回。

见证、许可与 operation 只在本地调用内存中存在。它们不进入 tool arguments、exec 字段、session log、提示词或诊断。原 token 仅留 IAM 的既有认证操作，不交给假模型或工具。

## 6. 其他方案为何不选

| 方案 | 不采用的原因 |
|---|---|
| IAM 自己安装执行闸 | IAM 卸载会同时移走保护，而消费者可能仍存在 |
| 只检查 ready 或只装 waterfall | 前者不证明当前权限，后者不保证最终执行边界仍被检查 |
| 新建通用权限服务或持久 lease | 本阶段只需验证本地必要条件；新增生产协议和存储超出本次设计 |

## 7. 四组验收与完成判断

| 组 | 必须实测 |
|---|---|
| 身份与权限 | 实际工厂未登录、退出、IAM 缺席、来源无效、换人、target/purpose 不符时，下游0；合成许可完整有效时恰好1次 |
| 异步交错 | 在许可、审计、listener、callee 等待和结果返回处失效；旧成功/错误不采用，取消和未知结果不重放 |
| 归属与卸载 | IAM 卸载闸仍在；owner 卸载移除合成能力；实际绑定同对象重绑使旧见证失效；普通工具原行为不变 |
| 负向与隐私 | 未注册来源、伪造 DTO、Promise verifier/current、字段变异和异常均固定脱敏拒绝，无 token/secret 输出 |

本批已按TDD接线、独立审查及代表性变异、源码冻结、最终完整检查的顺序验收。机密C的前置证据独立登记于[PLAN-006](<../plans/2026-11-02-iam-confidential-isolated.md>)，不与消费组合证据混用。

本阶段完成只证明规定的本地模拟执行边界。真实 provider/action 清单、原生 adapter 接线、实时人员授权、网关额度与网络策略、远端撤权和五分钟指标仍须提供方证据与另行准入；本设计不提前宣称这些能力。

**当前实现**：实际工厂会话见证、独立许可核心、自有工具/命令与合成模型均已实现并分段验收。根组合通过实际mock登录驱动这两道独立前置条件，不另造登录状态。

根16项覆盖明确issuer的public/Basic组合，另含不同issuer与subject的实际IAM整体替换；不是同issuer纯换人或discovery首次ready正向。分段RED/GREEN、独立审阅、代表性变异和最终完整检查统一登记于[PLAN-007](<../plans/2026-11-02-iam-consumer-isolated.md>)；分段、联合独立审阅与本批完整检查均已完成。

**保守边界**：A正向只覆盖明确issuer的public/Basic/Post登录、恢复与刷新。首次discovery-only开始时尚无已知issuer，不生成原ticket；callback不补票，所以首次ready无见证。后续metadata已知的真实sync/resolve重验证成功后才可能提供见证；这不是首次discovery正向实测结果。
