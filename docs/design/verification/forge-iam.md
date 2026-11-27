# forge-iam 实现与验证记录

本页区分仓库离线用例、本机探针、历史实机记录和待企业联调事项。设计约束见[IAM 接入详细设计](../plugins/forge-iam.md)，模块准入见[设计索引](../README.md#22-实现与验证入口)。

**实现边界**：Host + Client 开发骨架；内置 SQLite 组合绑定单记录信任与网关联合 adapter，刷新和退出以 pending 状态及条件提交处理；旧网关 V1 不被采用，凭据保留且不覆盖，异常记录不自动修复。

**验证结果与限制**：本机合成测试不证明目标平台耐久提交、企业 IAM/UAG、真实授权或工具入口；未知 provider 不获写入信任，退出及远端撤销未知不报告成功。墓碑不等于物理删除；Client 走 interim route。

## 多端与网关证据

[issue #303](https://github.com/hrygo/heluo-forge/issues/303) 汇总插件已在 Windows、麒麟、UOS 与 macOS 多机真测；权限、重启、用户隔离和恢复等专项及其版本与证据仍待逐项整理，不能由多机汇总推定专项通过。网关地址、SSE 与错误处理的后续验证由 [issue #304](https://github.com/hrygo/heluo-forge/issues/304) 跟踪。

[issue #509](https://github.com/hrygo/heluo-forge/issues/509) 的 Windows 私版制品身份、首次计划续期、挂起恢复及企业 IAM/网关联调仍待实机取证。验收步骤和判据见 [PLAN-028](../../plans/2026-11-27-iam-session-freshness.md#5-windows-与真实-iam-取证)。

## IAM 离线验收清单

账户操作见[用户指南](<../../../packages/forge-iam/docs/user-guide.md>)，代码接口和验证方法见[开发指南](<../../../packages/forge-iam/docs/developer-guide.md>)。下表区分可重复验证的当前行为、尚未闭合的本地缺口与外部证据，不用 mock 结果代替生产准入。

2026-11-23 外部评审的逐项核查结论见 [IAM 外部评审核查记录](<../../engineering/reviews/2026-11-23-iam-external-design-review.md>)，待闭合项的批次与验收判据见 [PLAN-025](<../../plans/2026-11-23-iam-fast-launch-and-iteration.md>)。能力基线按 [ADR-32](<../../architecture/platform-architecture.md#14-架构决策记录>) 固定为 IAM 6.0.3 版本反馈。评审提及但与 6.0.3 反馈或当前实现不符的三项（机密来源缺失、官方行未补全、回调须逐字精确匹配）以 6.0.3 反馈与本页为准。

| 能力 | 验收入口 | 当前边界或待闭合项 |
|---|---|---|
| 配置与 OIDC 登录 | `config`、`login`、`oidc`、`security-matrix` 及 [错误字段脱敏](<../../../packages/forge-iam/test/oidc-error-redaction.test.mjs>) | `apply` 默认使用 public，所有模式强制 S256。机密 Basic/Post 通过内置 SQLite 的专用来源接入。IAM 6.0.3 反馈只确认 PKCE 能力具备、允许 `plain`、未强制 S256；本实现固定 S256、无配置关闭项、不提供 `plain` 分支，S256 是否被目标部署接受未测。HTTP error 只保留精确标准码，合法 `invalid_grant` 及成功业务数据保持 IAM 2026-11-23 答复确认 S256 可正常发码、省略参数按 `plain`，故参数必须显式携带；我方真实往返仍待做。 |
| 回环回调监听 | [callback-port](<../../../packages/forge-iam/test/callback-port.test.mjs>) | 插件自建回环监听，端口由系统分配（也可固定），只在登录尝试期间存在；`redirect_uri` 逐字节相等，Host 与路径精确，端口占用记 `IAM_CALLBACK_PORT_UNAVAILABLE` 并拒登录。mock 下完成授权→回调→换票；IPv6 回环在 Ubuntu/Windows CI 均实测可绑定，IAM 是否接受 `[::1]` 未验 2026-11-23 答复指出 OIDC 授权流程不校验 `redirect_uri`，服务端登记不产生拒绝，回调合法性由本页所列客户端校验承担（ADR-33）。 |
| 机密认证基础与隔离服务 | [配置](<../../../packages/forge-iam/test/client-auth-config.test.mjs>)、[来源](<../../../packages/forge-iam/test/client-auth-source.test.mjs>)、[HTTP](<../../../packages/forge-iam/test/client-auth-transport.test.mjs>)及[格式/跨模式](<../../../packages/forge-iam/test/client-auth-record.test.mjs>)、[实际服务](<../../../packages/forge-iam/test/client-auth-service.test.mjs>)、[生命周期](<../../../packages/forge-iam/test/client-auth-lifecycle.test.mjs>)、[刷新](<../../../packages/forge-iam/test/client-auth-refresh.test.mjs>) | 受信来源驱动 Basic/Post 换票、刷新、撤销与 V2 恢复。V1/V2 与 `authContext` 分别绑定各自模式，来源或代际变化时拒绝旧操作，结果未知时保留状态。HTTPS Discovery 返回 HTTP 端点且部署未允许时，换票、刷新和回调清理均零凭据请求，刷新无 pending 写入。目标企业端点待联调 |
| 管理 API 认证 | `routes` 测试 | 仅 Connection 同步返回 undefined 时放行；异常结果拒绝且 service 零调用 |
| 会话同步与 provider 归属 | `provider-replacement-read`、`sync-provider-replacement` 测试 | 同步前后复查 provider，以本地采纳版本和身份快照保护结果；旧读取/错误不覆盖新会话或新确认的空状态，替换仅清本次仍持有的旧身份。`getView/getPrincipal` 只读缓存，不提供即时撤权检查 |
| 刷新与重启恢复 | `dual-process-refresh`、`refresh-complete-validation`、`service-singleflight-regression` 测试 | pending/complete 协议依赖受信原子后端；内置 SQLite 组合已接入，本机离线验证不代表目标平台与企业联调通过 |
| 后台续期与模型授权 | [renewal-lead](<../../../packages/forge-iam/test/renewal-lead.test.mjs>)、[model-transport-sqlite](<../../../packages/forge-iam/test/model-transport-sqlite.test.mjs>) | 验证提前 10 分钟排程、较早的令牌到期点和短寿命上限。真实 SQLite 与环回 HTTP 覆盖单、双 Host 的同一流续接、新请求单次发送、五秒截止、退出、网关撤权及双 Host 同时只换票一次。IAM 与网关响应使用合成数据 |
| 会话到期与派发前续期 | [Host 期限与订阅](../../../packages/forge-iam/test/session-renewal-view.test.mjs)、[HTTP 和 SSE](../../../packages/forge-iam/test/routes.test.mjs)、[共享页面核验](../../../packages/forge-iam/test/client-shared-session-stream.test.mjs)、[调用回归](../../../packages/forge-iam/test/iam-call-recovery.test.mjs) | 受控 Host 和浏览器时钟覆盖快照取样与排程之间的刷新截止、迟到的初始 HTTP 和 SSE 首帧、期限变更、前台恢复、目录先确认续期后晚到的旧帧和纯轮询读取、限次补查及侧栏重新登录。三条浏览器路由传递 Host 取样时间。浏览器墙钟独立推进时，按单调时钟核验，不为迟到的 HTTP 或 SSE 首帧追加展示时间。真实 IAM 服务和原生适配器装配使用合成传输，覆盖直接与经 Host guard 的最后取票、确认未发送后在 SDK 错误回调及退避期间的到期。可续期时单次换票并用新令牌发送一笔 POST。刷新耗尽、超时、取消、退出或 Key 变化时零新派发。已有 HTTP 拒绝的调用保留原派发记录 |
| 推理连接恢复 | [model-transport](<../../../packages/forge-iam/test/model-transport.test.mjs>)、[gateway-failure](<../../../packages/forge-iam/test/gateway-failure.test.mjs>) | 环回 HTTP 与合成连接错误验证临时 DNS、连接超时和多地址建连失败恢复后只收到一次 POST。覆盖单次预算、取消、退出、错误分类与诊断脱敏、普通 429/503、发送状态不明和流中断后的禁止重放。真实网关未受理语义与计费待联调 |
| 条件退出及远端撤销结果 | `signout-pending`、`signout-replacement`、`routes` 及 [RP 行为保护](<../../../packages/forge-iam/test/rp-logout-issuer-context.test.mjs>) | 清理未知不等于退出成功；墓碑不是物理删除，成功撤销响应不证明后代授权已终结。合法 RP 配置要求显式退出地址且优先于 discovery；迟到 metadata 不替换该地址，六项内存回归保护现有行为，不是漏洞修复 |
| 账户恢复、取消及退出交错 | `client-signout-behavior` 测试 | 真实 Client 源码的模拟渲染与受控交付；不证明跨入口/跨进程排序 |
| 网关凭据读写与归属 | [未受信拒绝](<../../../packages/forge-iam/test/gateway-atomic-policy.test.mjs>)、[联合条件提交](<../../../packages/forge-iam/test/gateway-atomic-transactions.test.mjs>)、[服务集成](<../../../packages/forge-iam/test/gateway-atomic-service.test.mjs>)、[SQLite 存储](<../../../packages/forge-credentials-keychain/test/sqlite-store.test.mjs>)及 `gateway-provider-context`、`store`、`service` | 内置 SQLite adapter 提供双键条件提交；门禁不满足时保存/清除拒绝，旧网关 V1 不被采用，凭据保留且不覆盖；orphan 和不一致 pair 保留且不自动迁移。离线测试覆盖快照 CAS、guard、墓碑和失败回滚；不证明跨进程 grant 授权、目标机耐久提交或真实调用 |
| discovery-only 的旧会话绑定 | [issuer-context-policy](<../../../packages/forge-iam/test/issuer-context-policy.test.mjs>)、[discovery-issuer-outbound](<../../../packages/forge-iam/test/discovery-issuer-outbound.test.mjs>)、[service-races](<../../../packages/forge-iam/test/service-races.test.mjs>) | discovery-only 冷启动在读取旧会话前解析一次 Discovery 文档并以文档 issuer 绑定；拉取失败、无匹配 issuer 或文档 issuer 与记录不符时拒绝采用旧身份、AT 及主体并保留记录。显式 pin 模式不启动网络探测。带 `sessionInstanceId` 且与解析或显式 pin 匹配的公共 V1 可读；缺少该标识的会话拒绝采用；直接 `resolveToken` 不补齐 issuer，异步操作与共享刷新固定 issuer，错误出口不发送旧 RT |
| 用户自助信息 | [client-clipboard-behavior](<../../../packages/forge-iam/test/client-clipboard-behavior.test.mjs>)、Client 与随包指南测试 | 账户页可主动复制已取得的登录链接和最小白名单诊断；不额外联网、不导出身份或凭据。异步结果受页面代际/链接身份/生命周期保护；不代替真实浏览器权限或原生剪贴板验收 |
| 模型只读编排与隔离适配 | [实际 Host 编排](<../../../packages/forge-iam/test/model-selection-host.test.mjs>)、[企业模型默认选择](<../../../packages/forge-iam/test/host-default-model.test.mjs>)、`model-gate`、`model-selection` 及 [outcome 回归](<../../../packages/forge-iam/test/model-selection-outcome.test.mjs>) | 实际 apply/服务和企业模型运行时使用模拟 SDK 验证严格只读、保存 getter 零访问、目录刷新及启用集变更后原选择不变、单飞与解绑、异步旧结果失效及模型错误不清 OIDC grant。只复用纯判定，不应用切换；记录式 sink 写入保持独立，异常用 written:null 标示未知。SDK无明确空态/条件保存；另有隔离执行组合证据见下表，真实人员/用途授权仍未接线 |
| 企业模型运行时与动态目录 | [managed-models](<../../../packages/forge-iam/test/managed-models.test.mjs>)、[manual-models](<../../../packages/forge-iam/test/manual-models-backend.test.mjs>)、[扩展凭据](<../../../packages/forge-iam/test/service-ext-tokens.test.mjs>)、[组合探针](<../../../scripts/probe/run-iam-managed-models-probe.mjs>) | 设置页拆分为「企业账号」（`forge-iam` `-10`，含网关配置，无研发凭据槽位）、「企业模型」（`forge-models` `10`，含 `${baseURL}/models` 动态目录与手动模型增删；目录被拒或不可达时仍从本机记录还原手动声明与启用集，写入前必须先成功读取记录，见 [manual-models](<../../../packages/forge-iam/test/manual-models-backend.test.mjs>)）及 3 步通用引导；[重新登录回归](<../../../packages/forge-iam/test/managed-models.test.mjs>)覆盖目录在途、返回错误或响应非法时，已启用的手动模型及同一网关的缓存模型可继续发起推理，目录错误独立呈现，恢复零配置写入，实际推理鉴权及账号切换门禁继续生效；扩展凭据 Broker 支持领域无关存储与子进程注入，研发凭据卡片位于各工具面板；双定位 UI 契约由 [tests/ui-contract.test.mjs](<../../../tests/ui-contract.test.mjs>) 守卫。调用失败自愈把内部 `IAM_*`／`CRED_*` 码映射为已登记用户码，绑定变化时在首个输出分片前可重建并重试一次；真实请求是否已发送尚待核验；[调用自愈用例](<../../../packages/forge-iam/test/iam-call-recovery.test.mjs>)覆盖同地址换 Key、地址变化、主体变化、流中授权边界与捕获异常前取消不重试；重建等待期间取消仍待修复和验证。上述探针只用模拟 IAM／UAG 与合成内存存储，不证明生产认证、企业网关、工具侧系统凭据库或双端 GUI 专项通过；多机真测与待补证据见[多端与网关证据](#多端与网关证据) |
| 包说明与制品 | `package-shape`、仓库包体检查 | 用户/开发指南随包，检查本地链接、锚点与表格；不代替 GUI 或生产操作验收 |
| 官方行禁用与独占断言 | [bundle-patch](<../../../packages/forge-enterprise/test/bundle-patch.test.mjs>)、[reflow](<../../../packages/forge-enterprise/test/reflow.test.mjs>) | 补丁停用 7 行，装配期按 `OFFICIAL_ROWS` 断言缺席行并把跳过与禁用分开记录。运行期独占断言只检查 `deepseekAccount` 服务，其余官方行残留只有装配期可见；`DEEPSEEK_API_KEY` 等环境旁路无运行期检测。以上为待闭合项，不是已交付能力 |
| 官方旁路环境变量检测 | [exclusive-env-bypass.test.mjs](<../../../packages/forge-iam/test/exclusive-env-bypass.test.mjs>) | `detectEnvBypass` 只返回变量名，空白与非字符串不计；`formatEnvBypassWarning` 文案不含变量值；`apply` 在 `requireExclusive` 未关闭时告警一次，`requireExclusive: false` 不告警。服务查找抛错时不产生残留告警，另记一条 `debug` 指明读取失败的服务名，缺失告警不与无残留等价。阻断未实现，默认只告警 |
| 网关身份头配置化 | [gateway-identity-config.test.mjs](<../../../packages/forge-iam/test/gateway-identity-config.test.mjs>) | 默认头名与 consumer 类型不变；配置后只发自定义头，默认头不再出现 |
| 独占断言服务列表 | 同上 | `exclusiveServices` 命中任一残留服务即 `exclusive-violation`，`officialServicePresent` 给出具体服务名；空列表回落默认服务，回落值与 `config.mjs` 的 schema 默认值由用例断言相等 |
| UserInfo 映射入口 | 同上 + [private-bundle.test.mjs](<../../../tests/private-bundle.test.mjs>) | 插件配置只接受 `workNo`/`name` 与 claim token；私版 `HELUO_IAM_PROFILE_FIELDS` 生成同一映射，非法键、重复键或非法 claim 直接 `CONFIG_INVALID` |
| 网关身份头 | [model-transport](<../../../packages/forge-iam/test/model-transport.test.mjs>)、[managed-models](<../../../packages/forge-iam/test/managed-models.test.mjs>) | 请求头名 `X-IAM-Token` 与 `X-Consumer-Type: personal` 硬编码在传输层，无法按部署切换；改用 `Authorization: Bearer` 需改代码。用例固定现有头形态，尚无用例覆盖可配置头名 |
| 身份画像字段映射 | [userinfo](<../../../packages/forge-iam/test/userinfo.test.mjs>) | 端点读取、严格投影与失败只丢弃画像的行为已覆盖；字段名映射仅由 Host 选项注入，私版配置无对应键，未配置时不请求 UserInfo。claim 名待 IAM 书面答复 |

### 按策略关闭项与剩余可模拟项

下表区分已按策略关闭的真实自动保存与尚未闭合的本地功能，后者不应笼统归为“仅缺真实环境”。前置决定未定时保留现状，不虚构生产协议或用 fixture 自动批准。

| 事项 | 可在隔离环境验证的部分 | 决定与剩余边界 |
|---|---|---|
| 宿主默认模型选择 | 实际 Host 与受管模型运行时均只读观察；离线用例覆盖目录刷新、启用集变化与并发选择，见[实施计划](<../../plans/2026-11-02-iam-default-model-readonly.md>) | 用户在宿主中选择模型，插件不自动保存；当前选择不可用时，由用户选择其他已启用模型。 |
| 机密客户端与 secret 生命周期 | [部署组合回归](../../../packages/forge-iam/test/client-auth-deployment.test.mjs)、[续期诊断回归](../../../packages/forge-iam/test/session-renewal-log.test.mjs)、[私版制作回归](../../../tests/private-bundle.test.mjs) | 实际 Host apply、内置加密 SQLite、管理员 CLI 和本地 IAM 模拟覆盖无客户端认证换票后首次续期收到 401、pending 防重放，及 Basic/Post 换票、`refresh-committed` 和会话保持 `ready`。同一旧绑定的并发纠错仅一笔提交，纠正后可登录。轮换后拒绝旧授权，刷新会话后可重新登录。私版仅写非秘密配置。目标环境的客户端类型、两种 grant 权限、认证方法和实际计划续期仍待 G1 核验。 [issue #408 的 IAM 核对结论](https://github.com/hrygo/heluo-forge/issues/408#issuecomment-7034227656) |
| 模型与工具执行入口 | SDK 形状接缝的本地必要条件拒绝、下游零调用与失效交错；[DESIGN-017](<../iam-consumer-isolated.md>)与[IAM-003](<../../contracts/iam-consumer-isolated.md>)为已批准的私有source/mock设计 | 用户已批准完整“假账号、假模型、假工具、不动真实环境” source/mock 设计。实际工厂会话见证A已实现并通过57新例/760项必要合并，peer与代表性变异已关闭；按[PLAN-007](<../../plans/2026-11-02-iam-consumer-isolated.md>)已验收B局部许可算法（62新例/210项policy回归及独立变异），C合成工具/命令已验收（31新例/241回归及独立变异），D合成模型已验收（29新例/270项policy回归，含最终错误桥修复与独立复核）；E根16项实际IAM联合已验收（含不同issuer/person整体替换），分段/联合独立审阅已关闭；Root最终完整检查1889总项、1887通过、0失败/取消、2平台跳过、exit0。首次discovery ready不补见证票，不开放真实调用。不能随 IAM 卸载撤闸，也不能以缓存 ready 代替人员/用途授权；真实 provider/action 与授权契约独立待核。 |

Remote/watch 和 tokenFor 的目标接口、凭据探测及企业授权路线仍按模块准入单独处理。网关路线 B 与既有 P0 原生 Key 路线的能力差距按[网关契约 §4.1.2](../../contracts/gateway-contract.md#412-阶段能力矩阵)的阶段判据收口，不由本清单替责任方裁决生产授权。

2026-11-20 在 macOS 使用 DSH `0.2.2-rc.5` 自带的 Cordis 运行时、临时加密存储和本机模拟 IAM，以 `client_secret_post` 完成一次换票和一次正常排程刷新，收到 `refresh-committed` 后会话保持 `ready`。Node `24.21.0` 下的 [安装回归](../../../tests/bundle-install-rehearsal.test.mjs)从已安装制品直接调用管理员 CLI，验证合成密钥可写入隔离存储。

2026-11-02 的剩余边界盘点将“能够模拟”与“协议已经决定”分开：

| 事项 | 当前证据与下一最小动作 |
|---|---|
| Client Remote/watch | Host watch 与 HTTP SSE 已接线；同一页面共享连接，SSE 不可用时回落共享轮询。[私有只读订阅接缝](<../../contracts/iam-view-observer-isolated.md>)已按 source/mock 实现：共享单飞读、独立管理面校验、代际取消；Client Remote 未接线，真实上下文/资源策略与生产准入未开放 |
| tokenFor(resource) | 当前只有resolveToken；资源/audience信任与实际消费者未定。不把旧AT加标签当资源换票，也不以fixture新增提供方能力 |
| 网关凭据probe | 当前只保存/读取，无探测。无副作用端点、owner/用途依据与错误分类须由网关协议确认，不把configured或假成功当有效授权 |

这些待定接口不混入已批准的PLAN-007，也不因本批完成就自动删除或宣称全目标关闭；后续隔离设计与批准须另行收口。正式secret投递、OS保护、实时人员用途与五分钟撤权依赖提供方证据；本地模拟不替其背书。

后续按[PLAN-008收尾计划](<../../plans/2026-11-03-iam-mock-closeout.md>)推进。[只读订阅私有接缝](<../plugins/forge-iam.md#523-最小只读订阅接缝sourcemock-已实现>)已按批准范围实现并验收：白名单投影、Host 单飞同步、独立管理校验与代际取消。真实注册、真实 Host 上下文与资源策略仍待准入；旧 SDK 入口文字证据不能替代生命周期兼容。probe 缺正式契约保持未启用；模拟验收不写成真实接通。


执行入口的只读核验（2026-11-02）还确认以下限度，不是已接 IAM 门禁的声明：

- SDK 的 tools.guard 是同步、单调拒绝，llm/stream 则是可短路的 waterfall；后者不能被写成任意监听顺序下的硬闸。注册均有所属上下文，卸载会移除。
- [policy 当前注册](<../../../packages/forge-policy/src/index.mjs>)只覆盖登记范围，卸载撤销 guard 和服务，没有读取 IAM；[DevOps 硬依赖](<../../../packages/forge-devops/src/index.mjs>)确实声明 policy，但不因此获得实时 IAM 身份或用途授权。[模型纯判定](<../../../packages/forge-iam/src/model-gate.mjs>)也不是执行拦截。
- 受保护对象、独立于 IAM 的门禁所有者及可信授权来源仍是下一阶段的关键边界。缺来源拒绝、失效交错、下游零调用和解绑可由 mock 验证；真实人员/用途授权与五分钟撤权不能由 fixture 承诺。

## 准入核对要点

**设计与接入边界**：O3 独占；Host+Client 骨架、OIDC mock 流程、网关凭据录入/清除/状态、模型门禁与默认模型判定、默认模型隔离写入适配、调用失败自愈、内部码到用户码映射及安全本地诊断（离线测试覆盖，未实机）；禁用插件/独占冲突 fail closed 本地验证；新对话默认模型由用户选择，插件只读观察，不自动写入；[受控模型运行时](../../../packages/forge-iam/src/managed-models.mjs)（企业账号页地址与 Key、`${baseURL}/models` 动态目录与手动模型边界、七行禁用与回灌检查）本地实现，见 [IAM 离线验收清单](#iam-离线验收清单)；Host watch 与 HTTP SSE 已接线，Client Remote 未接线。

**准入关注点**包括目标环境的客户端登记、密钥预置与续期、目标平台存储、官方行运行时模型面、企业联调及 UAG 凭据探测。
