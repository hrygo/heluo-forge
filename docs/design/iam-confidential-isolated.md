# IAM 机密客户端认证设计

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DESIGN-016 |
| 文档名称 | IAM 机密客户端认证设计 |
| 版本 | V1.1.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 负责 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-20 |
| 确认人 | 项目负责人 |
| 确认日期 | 2026-11-02 |
| 确认事项 | 采用管理员预置的隔离开发基线，批准 DESIGN-016 与 IAM-002 进入 source/mock 实施 |
| 适用范围 | 可选机密客户端的隔离设计与模拟实现 |
| 门禁 | 客户端登记、部署预置与实际计划续期须通过 G1，双端交付须通过 G2 |

> 适用范围：要求客户端认证的企业 IAM 部署。授权码换票与刷新统一使用预注册机密客户端及 PKCE S256。
>
> 编制依据：[issue #408 的 IAM 核对结论](https://github.com/hrygo/heluo-forge/issues/408#issuecomment-7034227656)、[总体架构 ADR-31](../architecture/platform-architecture.md)及本机组合与凭据接口。实现验证和未验项见 [IAM 实现与验证记录](verification/forge-iam.md)。
>
> 关联文档：[字段与错误契约](<../contracts/iam-client-auth-isolated.md>)、[现行 IAM 模块](<plugins/forge-iam.md>)、[需求基线](<../requirements/requirements-baseline.md>)、[开发约定](<../engineering/development-conventions.md>)。

## 1. 结论与范围

私版配置携带 clientId、认证方式及 clientSecretRef。管理员在目标终端通过独立运维入口预置 client secret，Host 从内置加密凭据组合注入来源，并对 code、refresh 与回调清理的撤销 POST 应用同一种方法。默认退出使用访问令牌自证的 GET 撤销路径。

两种客户端模式均要求 PKCE S256。public/none 是通用插件兼容默认，适用于明确允许两个 grant 均无客户端认证的部署。secret 来源、grant 单记录提交和网关联合变更各自验证具体能力。IAM 登记方法、远端轮换和计划续期由 G1 实测确认。

Host 支持 Basic/Post、V2 会话生成与恢复、共享刷新及回调清理。来源缺失、来源与凭据实例不匹配，或记录与 issuer/clientId/method/ref 不符时，机密操作拒绝。public 会话使用 V1。V1/V2 不能相互采用。

## 2. 证据与选择

| 核实项 | 结论与设计影响 |
|---|---|
| SDK CredentialRef | 与 CredentialKey 是不同 brand；resolve 先 provider 再 ambient env/.env，无无回落参数或版本/CAS；set/unset 也不证明来源，unset 后 ambient 可能重新生效。逻辑 selector 不调用这些方法 |
| SDK CredentialRecord | readRecord 不叠 env；记录仅 api-key/grant，其中 GrantRecord.payload 可承载未知数据；describeRecord 不证明加密或来源，modifyRecord 仅单记录，不覆盖独立来源+HTTP+grant 提交 |
| 升级前 V1 reader | 旧 record 仅校验 version=1、保留未知扩展，旧 service 仅绑定 issuer/client/resource；可选机密标记可能被旧 reader 忽略，因此 confidential 采用 format2。现行 V1 codec 已另加认证标记拒绝，但不能追溯改变已部署旧 reader |
| 标准 HTTP | [RFC 6749 §2.3.1](<https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1>)定义 Basic 的双端 form 编码和可选 Post，不允许一请求多方法；[RFC 7009 §2.1](<https://www.rfc-editor.org/rfc/rfc7009.html#section-2.1>)要求撤销时认证 |

运行期来源复用内置值级加密存储。专用记录 `iam-client-secret/<ref>` 绑定 issuer、clientId 和 method。预置和轮换使用同一单记录提交。已认证的加密信封产生非秘密 revision；同步检查采用当前密文行身份。管理员运维路径、隔离 fixture 与 Host 源的详细要求见[客户端认证契约](../contracts/iam-client-auth-isolated.md)。

SDK Inspect 只提供接口证据，不是 backend 或真实 secret 已运行的证据。引用的标准在 2026-11-02 核验，不替代供应商 client authentication 配置与实测。

## 3. 数据与生命周期

具体字段、允许值、私有签名、格式隔离与固定错误以[契约](<../contracts/iam-client-auth-isolated.md>)为准。实施者不能临时用配置布尔、source 自报属性或单记录 verifier 代替独立来源认可。

### 3.1 登录与回调

1. 校验完整配置。confidential 缺私有 getter/verifier 时在产生授权 URL 或发送凭据请求前固定失败；不能回落 public。
2. 显式登录取得并验证 metadata，才形成可信 issuer/端点上下文。读取一次被具体认可的 snapshot，核对 issuer/client/ref 与 revision，再检查来源、credentials/store、独占与认证代际。
3. 建立 attempt，只留非秘密 auth pin、source 身份和已有 nonce/state/verifier/redirect/resource/端点上下文，不长期保存 value。
4. callback 沿现有唯一 attempt/state 检查。重新读取同一 revision 与上下文后发送 code POST。进入 fetch 前同步检查源和快照，检查失败不发请求。
5. HTTP、解析、验签及其他 await 后复查。写 grant 的现有单记录 guard 内只做同步本地检查，失败不得采用 token 响应或写新 grant。
6. 失败 cleanup 只能在原 attempt pin 仍有效时使用原认证上下文撤销一次。轮换、取消或来源消失就标未确认，不借新 secret 为旧 code/RT 补发。

### 3.2 刷新与共享恢复

- confidential 的 hydrate/sync/resolveToken 在采用 V2、返回未过期 AT、加入或采纳共享刷新前，都验证配置、当前 source 与非秘密 auth pin。public V1 仍要求已知匹配的 issuer；discovery-only 冷启动可在 hydrate/sync 读取记录前解析 Discovery 文档取得该上下文，直接 resolveToken 不补齐。两种格式双向不迁移。
- snapshot 准备在 grant 锁外。claim 与 final commit 仍用现有单记录协议；三处手列身份、完整 base、完成采纳及 callback discard 都纳入 authContext。
- refresh 单飞归属不仅是 issuer/store，也包括当前认证 context 与来源作用域。不同 method/ref/revision 的等待者不能采用旧完成结果或接管 pending。
- claim 后来源失效保留 pending，不重置、轮询重发或换方法。未知 POST 仍只有原协议允许的一次发送，不自动重放。

### 3.3 退出、轮换与缓存

- signOut 校验受信存储、issuer 和客户端绑定并读取 grant 快照，锁内写入匹配该快照的 pending；网络请求在锁外以 AT 自证 GET 撤销，成功后才在同记录锁内核验并写墓碑。未配置撤销端点时可直接本地完成，不宣称远端撤销。
- secret 缺失不阻止满足上述条件的冷启动 V2 退出；普通 signOut 不读取 secret。远端撤销拒绝或结果不明时保留 pending，不报告清理完成、不重发旧令牌。不同 issuer/client/mode 或不匹配快照的记录保留，不盲删。回调失败后的机密认证 POST cleanup 仍要求原来源及认证上下文有效，不借新 secret 补发。
- 管理员在 IAM 侧轮换，再将对应值预置到同一引用。每次写入都产生新 revision。旧会话需重新登录。已发出请求和服务端令牌撤销由 IAM 自身的处理与生效时序决定。
- getView/getPrincipal 保持缓存只读，不做 secret I/O，不扩充 view、诊断、Remote 或路由。缓存展示不是实时授权；模型严格只读编排不连接认证写入或 cleanup。

## 4. 网络与失败边界

授权码与刷新 POST、回调清理的撤销 POST 使用机密认证编码；普通 signOut 使用不带客户端认证的 AT 自证 GET。各路径保持各自的 HTTP(S) 端点校验、redirect:error、超时与取消边界。HTTP 不提供传输加密或端点身份认证，机密客户端 secret 和令牌可能被窃取或篡改。构造的 Basic header、Post body 和 snapshot 只在操作局部保留；不进入错误或制品。

机密认证的 code、refresh 与清理操作在相关边界核对当前 getter 的 source 身份、独立 verifier 字面 true、原 snapshot 仍为 current、私有副本与原数据一致、mode/method/issuer/client/ref/revision、credentials/store、现有认证/操作代际；普通 signOut 按 §3.3 的独立路径校验，不读取 secret。local 失效错误不得被网络 catch 误包装为 IAM_UNREACHABLE。来源异常与任意 HTTP error 原文不输出；合法 invalid_grant 的既有分类保留。

**限度**：单记录 guard 不冻结独立 source；check→send 和远端处理之间存在不可封死的窗口。post guard 只能拒绝采用结果，不能撤回请求。没有跨进程来源通知、远端实时轮换、五分钟撤权、后代撤销、OS 耐久提交或安全隔离同权 JS 的保证。format 2 是 reader 隔离，不阻止已获权旧 writer 改写同一 key；fixture 独享存储，不增加锁、lease、第三键或新事务。

## 5. 实施归属与验收

凭据包负责加密记录、快照与独立来源注册。IAM Host 只读该来源并管理请求、会话和日志。私版制作器只注入结构化配置。

回归覆盖无客户端认证的刷新请求收到 401 且保留 pending、Basic/Post 下的实际 Host 换票与计划续期、已确认提交后保持 `ready`，以及删除或轮换来源后拒绝采用旧授权。验证同时检查 secret 排除于授权 URL、会话记录、错误、诊断及交付物之外。

## 6. 完成判断与后续门禁

G1 使用已核对客户端类型、两个 grant 权限及 `token_endpoint_auth_method` 的实际登记，在目标环境预置凭据后新登录，观察计划续期的 `refresh-committed`、新 AT 可用和会话保持 `ready`。远端撤销、轮换生效和双端交付各自取证。
