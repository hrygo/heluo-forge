# IAM 模型与工具隔离消费契约草案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-IAM-003 |
| 文档名称 | IAM 模型与工具隔离消费契约草案 |
| 版本 | V0.7.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-03 |
| 门禁 | 用户已批准完整 source/mock 设计；见证/许可及合成工具/模型已分段验收，根联合已实现；本批本地验收已完成；真实准入未开放 |

> 编制依据：用户于 2026-11-02 完整批准本契约与设计，仅实施隔离模拟代码；[DESIGN-017](<../design/iam-consumer-isolated.md>)定义两道独立前置条件，本契约集中私有字段与分段实现边界，不代表真实环境、原生 SDK 或团队 G1/G2 已获批准。
>
> 关联文档：[DESIGN-017](<../design/iam-consumer-isolated.md>)、[IAM-002](<iam-client-auth-isolated.md>)、[需求基线 §4.6](<../requirements/requirements-baseline.md#46-模型访问身份与专用凭证要求>)。

## 1. 性质与信任来源

本契约属于[隔离消费设计](<../design/iam-consumer-isolated.md>)。所有类型均为本地私有测试端口，不是SDK原生方法、真实授权服务器协议或新增HTTP/Remote API。会话见证已接实际工厂，独立许可/私有操作算法已局部验证，合成工具/命令及模型已在SDK-shaped本地接缝分段验收，根联合已由实际工厂与mock IdP验证；本批本地验收已完成；真实准入未开放，分段及联合证据见[PLAN-007](<../plans/2026-11-02-iam-consumer-isolated.md>)。

账号来自实际 createIamService 工厂与 mock IdP。独立授权控制器仅管理合成人员权限与调度，不伪造工厂登录状态。真实 apply 不注册见证源，不启用合成 provider/action，不接管理员配置布尔或 DTO 自报授权。

## 2. 精确请求作用域

```ts
// 私有会话见证类型；已接实际隔离工厂，不是 ctx.iam 公共接口。
type ConsumerScope = Readonly<{
  kind: 'model' | 'tool';
  target: string;
  purpose: string;
}>;
type SessionWitness = Readonly<{
  pin: object;
  issuer: string;
  subject: string;
}>;
interface WitnessSource {
  capture(): SessionWitness | undefined;
  isCurrent(original: SessionWitness): boolean;
}
type RegisterWitness = (
  iam: object, source: WitnessSource
) => () => void;
```

kind/target/purpose 来自可信测试组合明确列出的合成对象，不从工具自报 readOnly、模型名称猜测、任意前缀或网络返回的指令推导。空值、缺项、未知字段及未登记 scope 固定拒绝；不替生产清单定义真实名称。

## 3. 实际工厂见证

registerWitness 是实际 IAM 工厂已接入的私有测试注入参数，只交付工厂所有的 source。capture 同步只读，不联网、不刷新、不读持久存储。issuer/subject 仅供独立授权源做一致性绑定，不单独授予权限。

工厂私有映射固定原见证对应的实际实例、已采用 sessionInstanceId、credentials/store/provider 绑定、认证/会话代际及认证上下文。见证是冻结原件；pin 不可由 DTO 替代。无已采用有效会话、issuer 不匹配、signingOut/authenticating、disposed、过期或所需来源无法同步验证时，capture 返回 undefined。

signOut/cancel/dispose 的入口在第一个 await 前失效旧代际；采用新会话和依赖解绑/替换也失效。isCurrent 只验证原件，不能重 capture 新会话续行。

### 3.1 同步非秘密绑定信号

```ts
// 已接入的私有测试参数，不是 SDK 方法，也不改变 IAM-002 source。
getCredentialsBindingScope?: () => object | undefined;
getClientSecretBindingScope?: () => object | undefined;
verifyWitnessBindings?: (
  credentials: object, sourceOrUndefined: object | undefined,
  authScope: object, readers: Readonly<object>
) => boolean;
```

两个 getter 返回实际控制器生成的冻结空对象身份，不含会话、secret、ref 或 revision。provider 的实际 bind/unbind/rebind 同步更新 credentials marker；机密来源的实际 replace/rotate/remove/restore 及 source 绑定变化同步更新 secret marker，缺席返回 undefined。旧 marker 不复用；同对象重绑、同值或同 revision 恢复也换 marker。

credentials getter 与其 marker 来自同一 provider binder 私有槽；source getter、实际来源控制器与 secret marker 同源。verifyWitnessBindings 由可信测试组合的私有注册表精确认可具体 credentials/source、全部 reader 函数身份及精确 authScope，不接受调用方随意提供恒定 getter。readers 是固定副本：公共模式只含 getCredentials/getCredentialsBindingScope，机密模式另含 getClientSecretSource/getClientSecretBindingScope；公共分支不访问后两项属性。

authScope 公共模式为 mode/issuer/clientId/method=none；机密模式另绑定 IAM-002 的精确 issuer/clientId/ref/method。缺 getter、undefined marker、异常、Promise 或非字面 true 均拒绝并收敛非法 Promise 拒绝；形状不是来源证明。

**在采纳 await 链之前固定，不在 capture 时补配。** 工厂开始实际 IAM 登录、hydrate 或 refresh 的对应认证/采纳等待链时，先固定实际依赖、reader 和 marker；机密来源应在具体认可后、read 前取样。链结束时复查相同 marker 和原认证 guard，成功采用后才更新 adopted-session pin。不能在全部 await 结束后取得新 marker，追认等待期间已发生的 ABA。

两对 getter 分别属于实际 provider binder 与实际 secret fixture 控制器，由可信组合注册表配对认可，不要求新建全局控制器。capture/isCurrent 只比较已采用 pin 和当前工厂状态，不读取 secret，也不调用需要原秘密 snapshot 的 IAM-002.isCurrent。映射只留非秘密 session/context/epochs 与必要有效期；原 snapshot、client-auth operation、捕获它们的闭包及整份 grant 均不放入见证。

marker 改变只会拒绝旧见证。单独刷新 marker 不能让未登录状态产生见证，也不能给旧 ready/grant 重新背书；必须经实际 IAM 重新验证并成功采用后，才产生新 pin。getter 函数被替换，即便返回值相同也拒绝旧 operation。

如果实际装配没有这一个真实控制入口，verifier 不得认可，该路径保持拒绝；不能以两个独立变量同时赋值伪装归属。本节已由实际工厂与真实fixture变更入口实现；57项新用例、760项必要合并通过，独立peer已关闭。仅明确issuer正向获证；首次discovery-only不在callback补票，后续真实sync/resolve成功重验证才可能给见证。合成工具/命令及模型已有局部接线证据，实际IAM联合尚未完成。

## 4. 独立授权许可

```ts
// 已由局部算法消费的私有类型；不代表真实 IAM/网关提供这些方法。
type ConsumerPermit = Readonly<{
  issuer: string;
  subject: string;
  kind: 'model' | 'tool';
  target: string;
  purpose: string;
  revision: string;
}>;
interface SyntheticAuthorizer {
  read(witness: SessionWitness, scope: ConsumerScope):
    Promise<ConsumerPermit | undefined>;
  isCurrent(original: ConsumerPermit): boolean;
}
```

测试组合独立精确认可实际 iam、WitnessSource、SyntheticAuthorizer、consumer、所请求 scope 及其绑定身份。认可签名固定为 verifyConsumerSources(iam, witnessSource, authorizer, consumer, scope): boolean；owner 的私有注册表精确匹配五项与当前注册生命周期，不把上述结构或 source 自报字段当作来源证明。

认可与 current 均同步字面 true；异常、Promise、缺失及错误对象拒绝，并收敛非法 Promise 拒绝。source 回传字段严格匹配原见证 issuer/subject 与全部 scope；revision 非空，只是当前许可版本，不是秘密。isCurrent 同时验证控制器中的当前权限记录及其本地截止时间；不因许可仍在内存就视作未过期。

服务保留原许可身份及独立字段副本；字段变异、撤销、换人或 scope 改变均使旧 operation 失效。不存在给调用方传 allowed=true 的授权捷径。client-secret source 与本授权源职责不同，不互相替代。

当前[局部算法](<../../packages/forge-policy/src/iam-consumer.mjs>)从owner控制的getSources取得稳定stage；stage只保存实际iam、witnessSource、authorizer、consumer四引用。同四对象重绑也更换stage身份，不能复用旧代际；getter或verifier换函数同样使旧操作失效。这是内部测试装配约定，不是SDK服务、配置字段或自报可信证明。

## 5. 操作与错误

每次调用创建一次本地私有 operation，绑定原见证、原许可、实际执行对象、规范化请求及生命周期。原件/current、绑定身份和取消在每个 await 后、最终同步发送边界、结果采纳前复验。

许可准备可以 await，tools.guard 不得 await。已发送且结果不明不自动重试；未知状态不回落静态 Key，不补发旧请求。operation 不进入 exec、arguments、session log、提示词、持久记录或诊断；不含 token/secret。

| 已实现的私有算法分类 | 含义 |
|---|---|
| IAM_CONSUMPTION_INPUT_INVALID | 请求不符合精确合成 scope |
| IAM_CONSUMPTION_UNVERIFIED | 无独立认可的实际见证或授权来源 |
| IAM_CONSUMPTION_DENIED | 无当前会话或当前人员/用途许可 |
| IAM_CONSUMPTION_CHANGED | 原见证、许可、绑定或生命周期已改变 |
| IAM_CONSUMPTION_UNKNOWN | 已发送而结果不能确认，禁止重放 |

错误采用固定code/message，不回显token、Basic、source异常、参数正文或下游任意错误。C的owned tool finalizer已验证固定错误物化；D的finish片段在reason.failure中输出固定code/message。

模型入口的fixedError附自身冻结的failure数据，carried.code与自身code精确一致，符合已核验SDK的错误carrier接受条件。本地bridge仅实现受控subset，独立复制允许字段；普通Error.code仍按SDK UNKNOWN处理，不凭异常属性自报可信。

这些是本地SDK-shaped接线证据，未增加HTTP/Remote API，也不代表Native Host或真实provider联调。

## 6. 准入与未验证范围

完整source/mock设计已获用户批准；会话见证A与独立许可算法B已分段验收，合成工具/命令C及模型D已分段验收，根组合E已实现并完成16项定向验证，独立审阅与本批完整检查已通过。联合正向由实际IAM工厂登录驱动；B/C/D的局部fixture不是联合证据的替代。E覆盖明确issuer的public/Basic及不同issuer与subject的整体IAM替换，不声称同issuer纯换人或discovery首次ready正向。

本契约不证明真实原生 provider 被保护，也不承诺跨进程来源线性一致、远端撤权、人员用途实际开通或五分钟指标；这些仍按需求和生产门禁独立核验。
