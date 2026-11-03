# IAM 机密客户端隔离开发设计

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DESIGN-016 |
| 文档名称 | IAM 机密客户端隔离开发设计 |
| 版本 | V0.3.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-02 |
| 门禁 | 用户已批准完整 source/mock 设计；不开放真实来源与生产 |

> 编制依据：用户于 2026-11-02 选择管理员预置的隔离开发基线，并批准完整设计进入 source/mock 实施；同日只读 Inspect 核验 credentials 契约。设计的隔离服务实现已接入；本地验证不代表正式团队审批或供应商支持。
>
> 关联文档：[字段与错误契约](<../contracts/iam-client-auth-isolated.md>)、[现行 IAM 模块](<plugins/forge-iam.md>)、[需求基线](<../requirements/requirements-baseline.md>)、[开发约定](<../engineering/development-conventions.md>)。

## 1. 结论与范围

本阶段把 code、refresh、revoke 的机密认证接入真实服务代码，并以管理员/测试控制器预置的 synthetic source 验证闭环。没有登记服务、enrollment UI、真实 secret 获取器、生产存储格式、管理员写工具、核心补丁或新服务包。真实 apply 不注入来源、不发现隐藏来源，配置本身不能解除门禁；当前机器及当前 profile 的 secret 不读不写。

保持公共原型的兼容默认和 mandatory PKCE S256。secret 来源、grant 单记录提交、网关联合变更是三个不同信任边界，不互相证明。标准请求编码可离线验证，真实 IAM 是否接受某方法、客户端注册和远端轮换仍由 G1 证据决定。

**当前状态**：实际服务已接入 Basic/Post 的 code/refresh/revoke、V2 生产与恢复、有效 AT、共享刷新完整认证 pin 和 cleanup。54 项新服务用例及合并回归851项通过；完整检查与独立审查以[实施计划](<../plans/2026-11-02-iam-confidential-isolated.md>)最终证据为准。public 不采用、返回或盲删 V2。真实 apply 仍不注入来源，配置本身不能启用，供应商与生产能力没有因此获准。

## 2. 证据与选择

| 核实项 | 结论与设计影响 |
|---|---|
| SDK CredentialRef | 与 CredentialKey 是不同 brand；resolve 先 provider 再 ambient env/.env，无无回落参数或版本/CAS；set/unset 也不证明来源，unset 后 ambient 可能重新生效。逻辑 selector 不调用这些方法 |
| SDK CredentialRecord | readRecord 不叠 env；记录仅 api-key/grant，其中 GrantRecord.payload 可承载未知数据；describeRecord 不证明加密或来源，modifyRecord 仅单记录，不覆盖独立来源+HTTP+grant 提交 |
| 升级前 V1 reader | 旧 record 仅校验 version=1、保留未知扩展，旧 service 仅绑定 issuer/client/resource；可选机密标记可能被旧 reader 忽略，因此 confidential 采用 format2。现行 V1 codec 已另加认证标记拒绝，但不能追溯改变已部署旧 reader |
| 标准 HTTP | [RFC 6749 §2.3.1](<https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1>)定义 Basic 的双端 form 编码和可选 Post，不允许一请求多方法；[RFC 7009 §2.1](<https://www.rfc-editor.org/rfc/rfc7009.html#section-2.1>)要求撤销时认证 |

采用最少新增机制的只读 fixture source：snapshot、独立精确认可与同步本地 current 检查。不选择把真实秘密塞入新 CredentialRecord：那还需要批准持久格式、key selector、平台来源及生命周期，单记录成组也没有消除与会话记录的检查/使用窗口。

SDK Inspect 只提供接口证据，不是 backend 或真实 secret 已运行的证据。引用的标准在 2026-11-02 核验，不替代供应商 client authentication 配置与实测。

## 3. 数据与生命周期

具体字段、允许值、私有签名、格式隔离与固定错误以[契约](<../contracts/iam-client-auth-isolated.md>)为准。实施者不能临时用配置布尔、source 自报属性或单记录 verifier 代替独立来源认可。

### 3.1 登录与回调

1. 校验完整配置。confidential 缺私有 getter/verifier 时在产生授权 URL 或发送凭据请求前固定失败；不能回落 public。
2. 显式登录取得并验证 metadata，才形成可信 issuer/端点上下文。读取一次被具体认可的 snapshot，核对 issuer/client/ref 与 revision，再检查来源、credentials/store、独占与认证代际。
3. 建立 attempt，只留非秘密 auth pin、source 身份和已有 nonce/state/verifier/redirect/resource/端点上下文，不长期保存 value。
4. callback 沿现有唯一 attempt/state 检查；重新 read，要求同一 revision 与上下文，再发送 code POST。请求构造后至真正 fetch 之间不再 await；pre-send guard 失败零请求。
5. HTTP、解析、验签及其他 await 后复查。写 grant 的现有单记录 guard 内只做同步本地检查，失败不得采用 token 响应或写新 grant。
6. 失败 cleanup 只能在原 attempt pin 仍有效时使用原认证上下文撤销一次。轮换、取消或来源消失就标未确认，不借新 secret 为旧 code/RT 补发。

### 3.2 刷新与共享恢复

- confidential 的 hydrate/sync/resolveToken 在采用 V2、返回未过期 AT、加入或采纳共享刷新前，都验证配置、当前 source 与非秘密 auth pin。public V1 保留旧严格 issuer 策略；两种格式双向不迁移。
- snapshot 准备在 grant 锁外。claim 与 final commit 仍用现有单记录协议；三处手列身份、完整 base、完成采纳及 callback discard 都纳入 authContext。
- refresh 单飞归属不仅是 issuer/store，也包括当前认证 context 与来源作用域。不同 method/ref/revision 的等待者不能采用旧完成结果或接管 pending。
- claim 后来源失效保留 pending，不重置、轮询重发或换方法。未知 POST 仍只有原协议允许的一次发送，不自动重放。

### 3.3 退出、轮换与缓存

- signOut 在锁外准备所需的原上下文，锁内/网络前 guard 只同步检查；本地清理仍由精确 grant snapshot 与受信存储决定，不扩大删除范围。
- secret 缺失/失效不能阻止已授权的本地清理，但远端撤销不裸发、不换新 secret，采用既有未确认语义。不同 issuer/client/mode 的记录保留，不盲删。
- fixture 控制器轮换仅替换不可变 current 快照并换 revision；它的写方法不交给服务。不承诺远端 IdP 已吊销旧 secret，或已签发 AT/RT 后代自动失效。
- getView/getPrincipal 保持缓存只读，不做 secret I/O，不扩充 view、诊断、Remote 或路由。缓存展示不是实时授权；模型严格只读编排不连接认证写入或 cleanup。

## 4. 网络与失败边界

三条后端 POST 及 cleanup 共用一种编码路径，保持当前 safeEndpoint、redirect:error、TLS/显式 loopback 测试例外、超时、取消、资源与精确回调限制。构造的 Basic header、Post body 和 snapshot 只在操作局部保留；不进入错误或制品。

所有可观察边界同时核对：当前 getter 的 source 身份、独立 verifier 字面 true、原 snapshot 仍为 current、私有副本与原数据一致、mode/method/issuer/client/ref/revision、credentials/store、现有认证/操作代际。local 失效错误不得被网络 catch 误包装为 IAM_UNREACHABLE。来源异常与任意 HTTP error 原文不输出；合法 invalid_grant 的既有分类保留。

**限度**：单记录 guard 不冻结独立 source；check→send 和远端处理之间存在不可封死的窗口。post guard 只能拒绝采用结果，不能撤回请求。没有跨进程来源通知、远端实时轮换、五分钟撤权、后代撤销、OS 耐久提交或安全隔离同权 JS 的保证。format 2 是 reader 隔离，不阻止已获权旧 writer 改写同一 key；fixture 独享存储，不增加锁、lease、第三键或新事务。

## 5. 实施归属与验收

一个 source writer 顺序维护[配置](<../../packages/forge-iam/src/config.mjs>)、[OIDC](<../../packages/forge-iam/src/oidc.mjs>)、[记录 codec](<../../packages/forge-iam/src/record.mjs>)、[存储](<../../packages/forge-iam/src/store.mjs>)和[服务](<../../packages/forge-iam/src/service.mjs>)；必要的小型认证 helper 单职责，不跨包引源码。真实 [apply](<../../packages/forge-iam/src/index.mjs>)不注入秘密来源。root 维护文档，独立 reviewer 不同时写 source。

批准后按 TDD 分四个可审查交付：

1. 配置 tagged union、可信 fixture source 与三种纯 HTTP 构造；缺/错/Promise verifier 先 RED，PKCE 与原公共路径不变。
2. V1/V2 parser、严格 authContext、双向模式/方法/ref/revision 规则及完整 base；旧 V1 不自动迁移，秘密不进 attempt/grant/pending。
3. 实际 service 的 code/refresh/revoke/cleanup 与共享刷新；受控 Promise 覆盖 pre-send、HTTP pending、响应后、提交内、provider/来源替换及 cancel/signout/dispose。每条异常路径断言请求次数与下游零重放。
4. 独立审查、用户/开发文档同步、定向及一次有效完整检查；关闭真实 keychain spike，不安装当前 profile、不提交/发布，不把 mock 写成生产验收。

必须覆盖 Basic/Post 的 code/refresh/revoke、冒号/空格/加号/非 ASCII 编码、无双发 secret、授权 URL 不含 secret、错误字段回显和 Basic 串、成功业务数据未被误删。真实 apply 的 confidential 配置在无来源时零 secret I/O、零带凭据 POST；public 旧行为与模型只读回归保持。

## 6. 完成判断与后续门禁

本阶段的完成仅指当前 source 与隔离 fixture 的规定功能和时序可验证、所有安全断言保留、文档一致。管理员真实预置/轮换工具、钥匙串 native source、真实 IAM 方法与 revoke 契约、客户端注册、双端 GUI、跨进程一致、远端撤权及团队准入仍独立待证；没有 env/file/static-secret 后备。
