# 多端凭据存储实现与验收方案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-010 |
| 文档名称 | 多端凭据存储实现与验收方案 |
| 版本 | V0.6.4 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-10 |
| 门禁 | A 已实现；B 样机已实现（仅合成用例）；macOS 加密后端已本机与远程 SSH 取证；G1 关键存储能力待关闭；G2 目标未验 |
| 文档层级 | L2 实施计划；范围由需求基线承担，接口与存储决策先回写对应设计再实施 |

> 编制依据：2026-11-03 的 macOS 开发机与远程 Mac 安装试验、[#125](https://github.com/hrygo/heluo-forge/issues/125) 的 Linux 报告，以及同日对本仓库、已安装 DSH `0.2.1-rc.5`、`@napi-rs/keyring` **2.1.2** 发布元数据与固定提交源码的只读核对。目标 DSH 版本以根 [.dsh-version](<../../.dsh-version>) 为准；rc.5 读码不替代目标版本实测。Windows ARM64 本地虚拟机有合成数据验证；Windows、UOS、麒麟尚无企业目标机完整验收证据。历史试验、读码与推断分别列出，不作为生产批准。
>
> 关联文档：[需求与场景基线](<../requirements/requirements-baseline.md>)、[总体架构](<../architecture/platform-architecture.md>)、[IAM 接入设计](<../design/plugins/forge-iam.md>)、[企业组合设计](<../design/plugins/forge-enterprise.md>)、[凭据包说明](<../../packages/forge-credentials-keychain/README.md>)、[IAM 联合变更计划](<2026-11-02-iam-gateway-atomic.md>)、[文档清单](<../DOCUMENT-REGISTER.md>)。

**2026-11-03 范围更新**：client_id/client_secret 泄露不在评估范围，视为无影响；本计划的明文回退修复仍按 IAM 用户令牌保护、单 provider 与 fail-closed 执行，不以 client secret 泄露为由。

## 1. 执行判断

**先修 #125，再验证原生后端，最后开放 IAM。不能把“库能读写”当作“生产凭据存储已完成”。**

| 工作包 | 目标 | 可以交付什么 | 不能据此宣称什么 |
|---|---|---|---|
| A：默认组合止血 | 禁用 local，消除默认明文提供方；保留显式非生产覆盖层 | 可独立实施的安全修复与组合证据 | 普通插件抛错不等于整个 DSH 已退出，也不等于 #125 全部验收完成 |
| B：原生技术样机 | 按现有 backend 契约接入固定版本候选库 | 合成数据上的读写删、枚举、错误与包体证据 | 不授予 IAM 原子能力，不承诺登录、刷新或网关联合写可用 |
| C：生产设计准入 | 关闭枚举、长记录、跨进程事务和可信装配缺口 | 经过评审的接口、存储布局、原语与故障判据 | 本计划不虚构库未提供的事务，也不自行批准新的加密文件方案 |
| D：业务与交付验收 | 用真实装配验证 IAM、生命周期及相同最终制品 | G2 证据与发布判断 | 单机或模拟后端结果不替代企业目标机验收；macOS 为独立目标，需自己的取证 |

A 可先推进；B 只能作为显式 opt-in 样机。**C 未通过，D 不开放，整个生产方案不能判为可交付。**本次文档审查不实施适配器、不修改宿主、不安装或发布制品。

### 1.1 验证目标

范围只引用[需求基线 §2](<../requirements/requirements-baseline.md#2-范围边界唯一真源>)与[§5.5](<../requirements/requirements-baseline.md#55-插件制品来源决策>)。以下是取证分组，不另立产品范围：

| 取证对象 | 系统 / 架构 | 原生资源候选 | 门禁用途 |
|---|---|---|---|
| Windows 桌面 | Windows 10 amd64 | `win32-x64-msvc` | 必须通过 G2 |
| UOS 本机 Web | 统信 UOS 20 amd64 | `linux-x64-gnu` | 必须通过 G2，不是按需项 |
| 麒麟本机 Web | 银河麒麟 aarch64 | `linux-arm64-gnu` | 必须通过 G2，不能用 Ubuntu 代替 |
| macOS 端 | macOS Apple Silicon 与 Intel（arm64 / x64） | 应用层加密文档（AES-256-GCM + 0600 密钥） | 一期交付目标（[需求基线 §2](<../requirements/requirements-baseline.md#2-范围边界唯一真源>) S9）；不使用系统钥匙串，不要求签名，单独记录本机与远程取证 |

Node 与 pnpm 使用仓库固定版本；不顺带升级 [.dsh-version](<../../.dsh-version>)、兼容下限或平台范围。

## 2. 事实与证据边界

| # | 已知事实 | 证据 / 范围 | 能支持的判断 |
|---|---|---|---|
| 1 | 2.1.2 导出 `Entry`、`AsyncEntry` 与 `findCredentials` 等 API；开发机 GUI 下合成值读写删与枚举成功 | 历史 macOS 单机试验；发布包类型 | 只证明该环境的成功路径，不证明三目标完整枚举或事务 |
| 2 | 远程签名应用进程可加载平台原生包 | macOS arm64，DSH rc.5，导出符号已核 | 只证明原生加载；不代表应用内读写已通过 |
| 3 | 正常 pnpm 安装后应用能按包名解析平台包 | 同一远程 Mac 的独立试验 | 技术可加载不等于符合本仓库自包含制品政策 |
| 4 | 当时应用包含 `disable-library-validation` entitlement；独立 bundled Node 仍曾因 Team ID 不匹配拒载 | 同一应用与签名上下文 | 必须在实际宿主进程验载，不去签名、不改签名绕过 |
| 5 | SSH 启动的应用内写入报 `User interaction is not allowed` | 同一远程 Mac 的一次失败路径 | 会话、解锁与访问控制相关；不能推论所有 SSH 均不支持、GUI 必成功 |
| 6 | 企业包卸载后组合 dump 与安装前基线一致 | 同一 Mac，rc.5 | 只证明组合配置恢复，不证明系统凭据条目被删除 |
| 7 | 默认补丁插入 keychain，却未禁用官方 `credentials` 行 | [组合补丁](<../../packages/forge-enterprise/cordis.patch.yml>) | 两个提供方可被启用；provider 内的先挂载检查不能覆盖后挂载方 |
| 8 | IAM 的 `findLegacyRecords()` 有枚举代码，未找到生产调用方 | [store](<../../packages/forge-iam/src/store.mjs>) | 不能因此删除 `listRecords` 契约；其他消费者仍可使用 |
| 9 | `createPlatformBackend()` 目前始终返回 unavailable | [backend](<../../packages/forge-credentials-keychain/src/backend.mjs>) | 生产原生适配器并未实现；provider 不主动降级，默认组合却可能仍激活 local |
| 10 | 首版制品自包含：随包携带 `win32-x64`、`win32-arm64`、`linux-x64`、`linux-arm64` 四个 addon；macOS 使用应用层加密文档，不需要 addon；G2 按 Windows / UOS / 麒麟 / macOS 各自判定 | [需求基线](<../requirements/requirements-baseline.md>) | 必须补 UOS；macOS 证据不能顶替其他目标 |
| 11 | #125 报告 Linux aarch64 默认组合启动后 local 接管，创建 161 B 明文 YAML，含 `secret` 字段 | [#125](https://github.com/hrygo/heluo-forge/issues/125)，DSH rc.3；本轮未复现 | 明文提供方可达且发生写盘；不能仅凭大小与字段断定企业 AT/RT 已落盘 |
| 12 | #125 报告文件后端先注册成功后，local 后挂载撞名 | 同一报告；mock 单测与真实组合不同 | 必须验证激活时序与实际 owner，不能依赖 YAML 行顺序 |
| 13 | 已安装 rc.5 的 Connection 会将 `client-connection/browser-session` 随机签名 secret 写入 credentials；launch token 另存于进程内 | 已安装 `dsh-client-connection`、`dsh-credentials-local` 读码，非本仓库文件 | 启动产生的 `secret` 可能是宿主浏览器认证材料；不得把风险写成已取证的企业令牌泄漏 |
| 14 | 已安装 rc.5 的 Loader 并发创建并等待 all-settled；app-boot 只对 required 节点失败终止启动 | 已安装 `cordis-plugin-loader` / `dsh-app-boot` 读码 | 普通企业插件抛错不足以保证进程退出；目标版本仍须独立取证 |
| 15 | IAM 要求可信单记录原子能力；网关写还要求私有双键原子适配器，真实 apply 尚未装配这些能力 | [service](<../../packages/forge-iam/src/service.mjs>)、[store](<../../packages/forge-iam/src/store.mjs>)、[apply](<../../packages/forge-iam/src/index.mjs>) | 替换 backend 后仍不能直接开放 IAM 写路径 |

### 2.1 固定版本的官方依据

核验日期均为 2026-11-03。2.1.2 的 npm `gitHead` 为 `52184fbebffeef8a061234f60f313c479b954f9f`；以下使用固定提交而不是不断变化的 main。源码核对不等于已核验每个平台预编译二进制。

| 来源 | 已核内容 / 限制 |
|---|---|
| [npm 2.1.2 元数据](https://registry.npmjs.org/@napi-rs%2fkeyring/2.1.2)、[类型](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/index.d.ts) | `getPassword()` 缺失为 `null`；`findCredentials(service, target?)` 不接受 store options；主包与平台包同为 2.1.2 |
| [Entry 构造](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/src/entry_builder.rs)、[Linux 默认选择](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/src/linux_credential_builder.rs) | Linux CRUD 默认可退 keyutils；传 `{ linux: { store: 'secret-service' } }` 才固定存储 |
| [发布版本枚举实现](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/src/entry.rs) | Linux 枚举直接走 Secret Service；macOS 枚举会过滤单条读取失败；Windows 默认使用 `*.{service}` 过滤串 |
| [Microsoft CredEnumerateW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credenumeratew) | 官方过滤语义是“名称前缀 + 星号”；不能未经实测就承诺库的默认过滤覆盖全部本服务条目。登录会话也影响可用性 |
| [Microsoft CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)、[Windows store 1.1.0 校验](https://github.com/open-source-cooperative/windows-native-keyring-store/blob/v1.1.0/src/utils.rs) | blob 上限为 2560 字节；`setPassword` 按 UTF-16LE 字节计，`setSecret` 也不扩容。长 grant / Unicode 不能按字符数粗算 |
| [库 README](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/README.md)、[Cargo.lock](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/Cargo.lock) | 平台许可、预编译资源与 Rust 依赖须随制品核验；不能把其他版本的内部锁能力套用到此版本 |
| [Apple TN2083](https://developer.apple.com/library/archive/technotes/tn2083/_index.html) | 会话与安全上下文影响后台程序；资料本身是历史说明，不作为当前 macOS 所有会话的行为保证 |

## 3. 实现约束与接口落点

### 3.1 保留真实 backend 契约

以现有 [provider](<../../packages/forge-credentials-keychain/src/provider.mjs>) 为准，不另造 `listRecords(prefix)` 或把完整键缩成 IAM 专用键。

| 接口 / 地址 | 必须保持的语义 |
|---|---|
| `backend.get(key)` | 返回 `string` 或 `undefined`；库的 `null` 必须转为 `undefined`，其他失败不得当作缺失 |
| `backend.set(key, value)` | 保存原字符串；不双重 JSON 序列化，不擅自改变记录格式 |
| `backend.delete(key)` | 缺失幂等；拒绝访问、锁定或删除结果未知必须报错 |
| `backend.list(prefix)` | 返回本命名空间内匹配的**完整 backend key 字符串数组**；不把密码列表交给上层 |
| `provider.listRecords()` | 无参数；调用 `backend.list(recordPrefix)`，最终只返回 `{ key, kind }[]` |
| `backend.transaction(key, fn)` | 若提供，必须覆盖读取、异步 mutator、提交整个区间；单次 set 原子不等于此事务 |
| backend key | 当前默认例为 `heluo-forge/iam/record/heluo-iam/session` 与 `heluo-forge/iam/ref/ENTERPRISE_STATIC_KEY` |

B 样机用同一 OS service 下的 account 原样保存完整 backend key，值统一走字符串 `setPassword/getPassword`。不混用二进制记录绕过长度限制；Windows 枚举自身按 UTF-16 解码，须与写入链路一致。

### 3.2 命名空间与共享策略

生产候选必须显式配置稳定、非秘密的 `service`，例如 `heluo-forge-pilot-one`；`accountPrefix` 保留 `iam` 或使用现有语法允许的显式值。不同环境、独立 profile 默认不共用该组合；CLI 与桌面如需共享，必须有意使用同一组合。固定的 `client_id` 不等于所有 profile 应共享本地会话。

OS service、完整键前缀、锁域、可信能力身份必须指向同一存储域。相同域不能因 `DSH_HOME` 不同而各用一把锁；不同域的枚举不应先把彼此的秘密读入内存再过滤。现有 file backend 的默认配置不因此被静默迁移，变更命名空间后也不自动读取、搬运或删除旧条目。

### 3.3 平台适配与枚举准入

| 对象 | B 必须实现 / 验证 | C 的停止条件 |
|---|---|---|
| Linux CRUD | 每个 `Entry/AsyncEntry` 都传 `{ linux: { store: 'secret-service' } }`；适配器内部固定，不新增可放宽到 keyutils 的配置 | Secret Service 不可达、锁定或拒绝时明确失败，绝不退 keyutils / 文件 |
| Linux 枚举 | `findCredentials(service)` 的该版本源码直接使用 Secret Service；单独核对结果、锁定项与前缀 | 不存在 `findCredentials(service, { store })` 这一签名；失败不得返回空列表 |
| Windows 枚举 | 实际写入已知合成条目，比较枚举全集与逐键回读，覆盖服务内外、Unicode、空集与编码边界 | 默认过滤与官方语义有差异，未闭合前不能宣称通用枚举可用 |
| macOS 枚举 | 验证可读与不可读条目同时存在时的行为 | 当前库会吞单条读取失败；仅在外层 catch 不能补回，不能当完整、严格失败的枚举 |
| Windows 记录长度 | 对最终 JSON、刷新 pending marker、可选 ID Token 按实际编码测字节边界；超限在写前拒绝且保留原值 | IAM 真实最大 grant 未知或超限即阻断；更换存储布局须先评审，不能临时分片、截断或明文旁路 |

`findCredentials` 有导出，不等于已满足 `listRecords()`。枚举不合格时，样机明确报能力不支持并保持非生产；优先验证已修正的上游版本或成熟平台 API，重新固定版本并复验。**不在本计划中批准 fork、手写秘密索引或“系统命令 + 索引”兜底。**

### 3.4 原子能力与可信装配

[provider](<../../packages/forge-credentials-keychain/src/provider.mjs>) 的进程内锁和 `durable/crossProcessLock` 标记不能签发生产能力。[atomic-gate 测试](<../../packages/forge-iam/test/atomic-gate.test.mjs>) 已明确拒绝自报能力的 provider。

C 必须先在 [IAM 设计](<../design/plugins/forge-iam.md>)及[联合变更计划](<2026-11-02-iam-gateway-atomic.md>)收敛以下内容，再实施：

1. **单记录事务**：选择成熟库或 OS 进程持有型锁原语，固定版本、许可与三目标资源。证明锁覆盖 `get → await mutator → commit`，所有冲突写入与删除遵守同一锁域；明确超时、进程崩溃、休眠与恢复。不能把 dev file backend 的 O_EXCL 锁直接标成生产实现，也不能按时间/PID 擅自删除活锁。
2. **可信身份**：由受信装配代码绑定精确 provider 实例、命名空间、backend 实例与生命周期，向 `createIamService` 注入同步 `verifyAtomicStore`；替换、卸载后立即失效。不得采用 `() => true`、仅检查方法存在或读取 provider 自报标记。
3. **网关双键提交**：现有 [store](<../../packages/forge-iam/src/store.mjs>) 另需 `snapshot(scope)` 与 `compareAndSwap(scope, expected, next, guard)`；比较、一次同步 guard、record/ref 两项提交必须有同一原子提交点，并返回可核对收据。这不是 SDK credentials 方法，也不是两个顺序写操作加一把互斥锁就能提供的崩溃原子性。
4. **真实接线**：当前 [IAM apply](<../../packages/forge-iam/src/index.mjs>)没有注入上述私有能力。后续设计必须确定可信工厂/装配导出与卸载落点，通过包的公开 exports 接入，禁止跨包导入源码。测试 fixture 不是生产 adapter。
5. **存储布局决策**：若候选系统库不能同时满足长 grant、单记录事务及双键提交，提交有具体证据的替代方案。采用 OS 保护的加密事务文件等路线会改变物理存储与恢复边界，须先获设计/安全确认；未批准前保持关闭，不自行实现加密协议。

因此 B 不设置生产 trust；C 未通过时，登录/刷新等写路径仍应报 `IAM_ATOMIC_STORE_UNVERIFIED`，网关变更仍报 `IAM_GATEWAY_ATOMIC_UNVERIFIED`。既有只读兼容行为不因本文被扩大或删除。

### 3.5 错误、会话与历史文件

- 只把系统明确的“不存在”映射为缺失；不可达、锁定、拒绝、歧义、损坏与超限均为失败。公开错误使用白名单代码与脱敏固定提示，不透传原始错误对象、密码或完整环境。
- 超时/崩溃不等于操作未提交。结果未知时不得自动重放写入、删除或迁移，也不谎报已删除。
- Linux 检查真实用户的 D-Bus 与 Secret Service 提供方、collection 状态和重启持久性；环境变量存在不等于可用，缺少桌面也不自动等于不可能使用。
- macOS 分别记录 CLI、GUI 应用、SSH 启动与锁定状态；Windows 分别记录交互登录与远程会话。按真实会话结果定义支持范围，不预设“SSH 必须失败”。
- 遗留明文文件只做经授权的结构化诊断，不读取/打印秘密、不自动迁移或删除。**文件存在本身不证明本次运行发生了回退，也不是未设计的全局启动拒绝条件。**

## 4. A：#125 安全止血

### 4.1 文件与交付

| 修改点 | 任务 |
|---|---|
| [企业组合补丁](<../../packages/forge-enterprise/cordis.patch.yml>) | 增加 `id: credentials` / `disabled: true`，保留四个官方登录/模型行禁用；纠正“顺序即加载顺序”的注释 |
| [补丁测试](<../../packages/forge-enterprise/test/bundle-patch.test.mjs>) | 先补失败断言，再把 exact-four 更新为四个原有行 + credentials；不误改实际三个企业插入行的约束 |
| [keychain apply](<../../packages/forge-credentials-keychain/src/index.mjs>)与[apply 测试](<../../packages/forge-credentials-keychain/test/apply.test.mjs>) | 保留冲突与后端拒绝语义；为显式不安全文件后端增加脱敏“非生产”提示及正反用例 |
| 新建 `scripts/probe/run-credentials-composition-probe.mjs` | 完整组合 + 真实 Cordis/Loader + 实际 local provider 的隔离探针，见 §4.2 |
| [企业包说明](<../../packages/forge-enterprise/README.md>)、[凭据包说明](<../../packages/forge-credentials-keychain/README.md>)、[企业组合设计](<../design/plugins/forge-enterprise.md>) | 同一变更写明默认停用 local、显式覆盖、故障行为及兼容影响；同步登记与设计索引的事实 |

实施按“写失败用例 → 确认因缺少 local 禁用而失败 → 最小修复 → 定向验证 → 审查”推进。不能为了让试点启动而重新开启 local。

### 4.2 真实组合测试不是倒置 YAML

复用 [SDK 定位器](<../../scripts/lib/dsh-probe-runtime.mjs>)与[安装演练](<../../scripts/probe/run-bundle-install-rehearsal.mjs>)的 `resolveDshProbeHost → createRequire` 路线；ASAR 布局在实际应用的 Electron 运行。现有演练只挂企业 inserted 行，**不能替代本探针**。

新探针必须：

- 使用独立临时 `DSH_HOME`、实际 local provider 的临时路径与 `watch: false`，keychain 后端使用明确的合成 fixture；不碰用户 profile 或系统真实凭据。
- 从基线条目和补丁形成完整组合，断言 `credentials` 行确实命中并禁用；缺行、覆盖未命中、高优先层重新启用都不能判通过。
- 用生命周期屏障控制 keychain/local 实际激活先后，记录真实 fiber 与 owner；不能仅逆转数组。分别保留错误组合的复现证据和修复组合的通过证据。
- 修复组合中，后端可用时实际 `credentials` 是预期 keychain 实例；不可用时不发布 provider，local 不激活、不调用写盘。既验证冷启动，也验证后端撤销/卸载后消费者不能继续使用旧绑定。
- 对空临时 HOME 验证不新建默认 `.credentials.yaml`；对预置合成遗留文件验证哈希不变。显式 file 覆盖仅写指定文件，打印非生产提示。
- 最终卸载真实 fiber、关闭 watcher/backend 并核对无剩余任务；只清理本探针有所有权证据的临时资源。

正确的 dump 判据是：**local 行仍可见但 `disabled: true`，keychain 行启用且配置正确**。禁用不是删除；dump 也不能证明服务已经 ACTIVE。运行时 owner、关键 fiber 状态与写盘次数须另测。

仓库离线 CI 当前不安装 Cordis/Loader 测试依赖。该探针使用**预装的目标 SDK**，是独立 P0 证据；SDK 缺失记录 `NOT RUN`，不能用 skip 作为门禁通过。若要加入 CI 必过项，先批准测试专用依赖与 runner 变更，不能偷偷引入运行时外部依赖。

### 4.3 “拒绝企业能力”与“进程退出”分开取证

A 直接保证的范围是：默认组合不启用明文 local，不可用后端不提供服务。企业业务调用的完整保护仍依赖 [#122](https://github.com/hrygo/heluo-forge/issues/122) 的真实执行入口接线，不能据 A 宣称已经保护所有模型/工具。

#125 还要求“启动失败”。已有 rc.5 读码表明：普通插件失败会被隔离；web 中 required Connection 缺 credentials 可能间接终止启动，但这不是任意插件、profile 或版本的通用保证。**不要新增一个普通 guard 然后把 throw 当成进程退出证明。**

A 的宿主子任务必须在目标版本、实际 web 与桌面 profile 上用独立子进程核验：退出码、退出时限、端口/资源关闭，以及没有任何 local 写入。先核验公开 launcher/boot 的退出合同和支持边界；若无通用能力，记录缺口并提交 #125 的验收裁定，不修改 DSH 核心，也不擅自改写 issue 的完成标准。该项未关闭，#125 不整体关单。

### 4.4 显式非生产覆盖层

下例使用现有 file 配置与 Loader 表达式；仅供独立开发/试点，由人明确叠加，默认企业补丁不内置。覆盖层替换整个 `config`，应完整重述所需字段；“非生产”日志是 A 需要补充验证的行为。

```yaml
- id: credentials
  disabled: true
- id: heluo-credentials-keychain
  config:
    service: heluo-forge-dev-one
    accountPrefix: iam
    filePath: !!js dshHomePath('credentials.dev.json')
    allowInsecureFile: true
```

批准覆盖层只表示允许非生产明文文件，不给 IAM 注入生产原子 trust，不满足 C/D，也不授权读取或搬运真实存量凭据。

## 5. B/C：原生样机与生产设计任务

### 5.1 具体任务顺序

| 任务 | 文件落点 | 最小验证与停止点 |
|---|---|---|
| B1 backend 样机（已实现） | 新建 `packages/forge-credentials-keychain/src/native-keyring.mjs` 及同包测试；修改现有 [backend 选择与 Config](<../../packages/forge-credentials-keychain/src/index.mjs>) | 已用注入的假 loader 验证 §3.1 的接口、null 归一化、错误传播、命名空间、Linux pin、Windows 字节上限与卸载；未访问真实 OS store |
| B2 安全启用 | 同上；现有 [provider](<../../packages/forge-credentials-keychain/src/provider.mjs>)只做必要兼容，不扩写公开 Service | 新增的 `platformAdapter: native-keyring` 仍需 `allowUnvettedPlatformAdapter: true`，backend 标 `unvetted`；不自报 cross-process trust |
| B3 原生专项 | 新建独立 native probe；按 §6 交付资源 | 只用随机合成数据，证明成功/缺失/拒绝/枚举与重启；清理只限本次命名空间，失败保留非秘密诊断 |
| C1 能力决策 | [IAM 设计](<../design/plugins/forge-iam.md>)、[联合变更计划](<2026-11-02-iam-gateway-atomic.md>)及必要的架构评审 | 选定 §3.3/§3.4 的存储/锁/提交与长度方案，写明 guard 的线性化点；缺一项不准生产实现 |
| C2 可信装配设计 | 凭据包公开导出、[IAM apply](<../../packages/forge-iam/src/index.mjs>)及其测试 | 明确具体工厂、精确实例证明、重绑与卸载；缺失/伪造/异步 verifier、跨域与陈旧实例一律拒绝 |
| C3 按获批设计实现 | 文件表由 C1/C2 冻结，不预建未知锁/事务模块 | 真实两进程竞争、提交前后 kill、锁超时、刷新与退出竞争、双键中断均有证据后才发能力 |

B1/B2 的配置是**拟新增接口**，当前 Config 只接受 `security-cli`，不能将下例当作当前可执行配置。Linux pin 在实现内部强制，不存在顶层 `store` 配置：

```yaml
- id: heluo-credentials-keychain
  config:
    service: heluo-forge-dev-one
    accountPrefix: iam
    platformAdapter: native-keyring
    allowUnvettedPlatformAdapter: true
```

C 通过前，不把原生样机改为默认生产 backend。是否升级候选库、改变物理存储或扩展私有适配器，均须记录准确的批准范围，不能由样机成功推导。

### 5.2 原子性验收必须包含失败路径

| 能力 | 必须证明 |
|---|---|
| 单记录 RMW | 两进程同时读取旧值不会丢更新；异步 mutator 区间仍排他；set/delete 与事务竞争时同域串行 |
| 刷新与退出 | 同一 refresh token 只有一个进程获准发 POST；pending、完成、退出墓碑与旧回调按既有规则竞争，未知结果不重放 |
| 双键 CAS | 比较冲突零写且不调用 guard；比较匹配后，提交前 guard 恰好一次，拒绝则零写；ref/record 具有同一原子提交点。提交后异常、收据丢失或生命周期变化不证明未提交，不补偿、不自动重放；存储结果未知按 `IAM_GATEWAY_WRITE_UNKNOWN` 处理，已确认提交不因后续生命周期变化回滚；中断不得留下可用半对 |
| 可信绑定 | 新 provider、伪造属性、不同命名空间、异步 verifier、卸载与旧收据都不能获得旧能力 |
| 持久性与恢复 | 进程和系统重启后数据/代际一致；锁持有者崩溃有明确恢复策略，不依赖自动删除未证实的活锁 |
| 长记录 | 覆盖业务最大值、编码边界、pending marker、可选 ID Token；失败不破坏已有 grant，不截断 |

现有 [跨进程探针](<../../scripts/probe/run-keychain-cross-process-probe.mjs>)只证明可见性；现有 [网关原子 fixture](<../../packages/forge-iam/test/support/atomic-gateway.mjs>)只在单次 JS turn 更新内存 Map。两者均不证明生产事务。

## 6. 自包含制品路线

**选择构建期闭合原生资源，不让终端解析 keyring 的 optionalDependencies。** 企业 npm 有镜像不等于终端制品已自包含。

现行闭包政策不变：构建器拒绝 peer/optional 与任何非 `@heluo/forge-*` 的运行依赖，闭包审计与负向测试锁定该政策。原生 addon 以发布资源随包分发，因此三条约束同时满足：终端不编译、不联网、不解析外部包。

落点（`packages/forge-credentials-keychain`）：

1. 锁定清单 [scripts/native-keyring.json](<../../scripts/native-keyring.json>) 固定上游包、精确版本与每个 tarball 的 integrity；`vendor/CHECKSUMS.json` 记录落地文件的 sha256、字节数、来源包与许可。
2. [scripts/fetch-native-keyring.mjs](<../../scripts/fetch-native-keyring.mjs>) 按清单下载、校验 integrity、暂存到 `vendor/<triple>/keyring.node` 并写校验和；任何一项不符立即中止且不写文件，`--check` 只校验不下载。
3. 二进制不进入 Git：提交钩子拒绝二进制与大文件，`vendor/*/` 已由 [.gitignore](<../../.gitignore>) 排除。干净克隆只有清单与校验和、没有字节，因此不能出制品；发布打包前必须先暂存并跑 `--check`，四个目标（win32-x64、win32-arm64、linux-x64、linux-arm64）全部就位才出制品。该前置由构建期校验强制，缺失即非零退出；记录本身也必须列在发布文件集内，否则构建同样拒绝——否则产物核验连「有记录可判」这个前提都不成立。离线检查器不要求原生产物，避免 CI 依赖网络。
4. 加载器 `src/native-keyring.mjs` 用 `nativeTargetFor()` 映射 `platform-arch`，按**相对本包的绝对路径**加载，不做 `node_modules` 解析；未列入映射的组合返回不可用 backend；macOS 在解析层直接进入加密文档后端，不经过 addon 映射。
5. 启用分两步：`NATIVE_ADAPTER_VETTED` 为 `false` 时挂载需要 `allowUnvettedPlatformAdapter: true`；目标机完成读、写、删、失效、跨进程与重启后保留的记录后置为 `true`，此后无需平台相关配置。

负例覆盖：缺目标、错哈希、混版本、错误架构、丢许可证、额外外部依赖，以及“映射表被改成默认放开时用例必须失败”。新增测试不得删除既有拒绝用例。

若资源导入或平台 API 需改变既有闭包政策，先修改对应设计并评审；不能退回“现场 pnpm 自动装平台包”作为临时发布路线。

### 6.1 上游语义调研

目标机之外可以先确定为事实的部分来自上游源码（`@napi-rs/keyring` 2.1.2 及其锁定版本）：

- **上游默认写入形态**：Windows 凭据 target 为 `{account}.{service}`，password 以 UTF-16LE 存入 blob；Linux 为 Secret Service 条目，属性含 `service`、`username`（`windows-native-keyring-store` 1.1.0 `src/cred.rs`、`dbus-secret-service-keyring-store` 1.0.1 `src/cred.rs`）。
- **枚举**：Windows 走 `CredEnumerateW`，过滤串 `*.{service}`，account 取 `UserName`；Linux 按属性 `service` 搜索、account 取 `username`（`keyring-node` 2.1.2 `src/entry.rs`）。Windows 的后缀过滤会带回同后缀的他人条目，Linux 静默跳过缺 `username` 的条目。
- **上限与编码**：Windows account ≤ 513 字节（UTF-8 计）、blob ≤ 2560 字节（UTF-16LE 计），超限由上游返回 `TooLong`；Linux 无库级上限（`src/utils.rs`）。
- **失败模式**：Windows 命中集合中任一凭据 blob 奇数长或非法 UTF-16 时，整次枚举抛错且不返回部分结果。
- **平台默认值**：Windows 未指定修饰符时按 `CRED_PERSIST_ENTERPRISE` 写入，域环境 + 漫游配置下凭据随用户配置文件漫游；Linux 写入集合 `default`，集合锁定时读失败而不是返回空。绑定未暴露 `persistence` 与解锁流程，这两项只能作为部署前提记录，不能在本包内改变（`src/store.rs`、`src/cred.rs`）。
- **macOS 实测（2026-11-06）**：`scripts/probe/native-keyring-store-probe.mjs --platform --enumeration` 在本机图形会话与一台远程 Apple Silicon Mac 的 SSH 会话中均 7/7 通过（Node v24.21.0，未签名产物），覆盖读写、覆盖、跨进程可见、枚举命中、删除与幂等删除，探针条目已删除。这是 macOS 加密文档后端证据，不是 Windows/UOS/麒麟 证据。
- **macOS 存储语义**：文档 `~/Library/Application Support/HeluoForge/credentials.json` 以 AES-256-GCM 加密，密钥为同目录 0600 文件；目录 0700；密钥权限或所有者不符、认证标签校验失败时显式报错，不回退明文。枚举由整篇解密后按 key 前缀过滤，不依赖系统枚举差异。
- **加载前提**：Windows 产物直接导入 `VCRUNTIME140.dll`，缺 Microsoft Visual C++ 2015-2022 Redistributable 时 `require` 报“找不到模块”，与凭据逻辑无关；Linux 产物导入的符号版本最高为 x64 `GLIBC_2.15`、arm64 `GLIBC_2.17`，均低于 UOS 20 与麒麟的发行版基线。适配器在 Windows 上先探测该 DLL，缺失即以 `KEYCHAIN_UNAVAILABLE` 说明安装项。

Windows 新格式保留原始 account，并在内部 service 中加入原始 service 与 key 的精确字节摘要，避免大小写不同的键落到同一 target。单键操作先检查旧格式，存在即 `KEYCHAIN_LEGACY_RECORD`，不迁移或删除；枚举按调用方 key 前缀取候选，再逐键检查旧目标并回读当前 service 的新目标。绑定的 `withTarget` 在 Windows 构造时会写入空占位凭据，因此该路径不使用它。旧版与新版并发操作仍无跨进程互斥。

**2026-11-10 本地验证**：Parallels Windows 11 ARM64 虚拟机上，Node v24.21.0 的合成数据探针完成标准 7/7、大小写区分、service 区分、旧新记录共存保护和删除清理。512 字节 ASCII account 在旧格式与新格式均可写，513 字节均被系统以错误 1734 拒绝，故上游的 513 字节检查不保证目标机写入成功。跨用户隔离未运行；Windows x64、企业 Windows 目标机、UOS 与麒麟未由本次验证覆盖。该记录不关闭 G1/G2，也不改变适配器默认门禁。

已实现的共性边界包括按调用方前缀过滤、把上游无码错误归一为 `KEYCHAIN_OPERATION_FAILED`、按上述上限提前拒绝。Linux 丢弃不可作 key 的 account；Windows 对无法辨认的候选显式失败。仍须目标机确认真实集合中的持久性、跨进程与重启后可见性、枚举过滤的实际命中集合，以及安全软件拦截时的错误形态。

## 7. 执行清单、估算与命令

### 7.1 顺序与交付判据

- [x] **A1**：补丁正反用例先红后绿，完成默认 local 禁用、非生产提示与说明同步。（`bundle-patch.test.mjs` 5 项通过；`apply.test.mjs` 覆盖非生产提示与 native 配置拒绝）
- [x] **A2**：在已安装 SDK `0.2.1-rc.5` 上跑真实组合探针，两种挂载顺序各 9 步：启用 local 时第二个提供方按顺序被拒（local 先挂由 keychain 抛冲突码、keychain 先挂由 Cordis 拒绝重复注册），local 先挂时写入落到明文文件（#125 形态）；禁用后单一提供方且写入走 keychain backend；后端不可用不发布提供方且不落盘；遗留文件不被迁移或删除（并要求该次组合确实挂载成功）。18 步全部为可失败断言。`tests/credentials-composition.test.mjs` 1 项通过（无宿主时 skip，不冒充已验）。**仍未完成**：进程退出专项取证（见 §4.3），#125 不整体关单。
- [x] **B1/B2**：可注入 native loader 的字符串 backend 样机与 19 项单元测试完成，默认 `KEYCHAIN_LIST_UNSUPPORTED`、Linux 固定 Secret Service、Windows 2560 B 上限、`null → undefined`；未审核适配器默认拒绝，不签发 IAM trust。
- [ ] **B3**：按 §6 构建原生资源闭包；用最终安装产物完成分平台合成探针。
- [ ] **C**：关闭 §9 的 G1 关键项，回写设计、契约与冻结文件表，经评审后才实现生产事务与可信装配。
- [ ] **D1**：通过 [atomic-gate](<../../packages/forge-iam/test/atomic-gate.test.mjs>)、[网关事务回归](<../../packages/forge-iam/test/gateway-atomic-transactions.test.mjs>)及真实双进程故障注入，再做 IAM/网关联调。
- [ ] **D2**：同一最终 tgz 完成 Windows / UOS / 麒麟 / macOS G2；macOS 以加密文档后端取证，不要求签名与图形会话。同步证据、登记与相关 issue，未经门禁不发布、不扩试点。

工作量仅作工程预算：A 约 **1–2 人日**，B 的接口样机与候选验证约 **2–3 人日**；合计 **3–5 人日不含制品闭包扩展、目标机等待、C/D 与评审**。原先 8.5 人日不能作为完整生产交付承诺：长 grant、严格枚举、生产事务和可信装配尚未定型，C1 结束后须按冻结设计重新估算。没有证据时不补一个“系统命令 + 索引再加 2–3 日”的回退报价。

### 7.2 验证命令

以下是已有检查入口，不预报数量或成功结果；从仓库根执行，使用固定工具链。命令采用 POSIX shell / Git Bash 写法，其他 shell 使用展开后的显式测试文件列表，不把目录直接传给 `node --test`。修改源码后先执行对应定向测试，冻结快照后运行一次完整检查。

```sh
mise exec node@24.21.0 -- pnpm check:docs
mise exec node@24.21.0 -- node --test packages/forge-enterprise/test/bundle-patch.test.mjs packages/forge-credentials-keychain/test/*.test.mjs
mise exec node@24.21.0 -- node --test tests/bundle-build.test.mjs tests/bundle-closure.test.mjs
DSH_KEYCHAIN_SPIKE=0 mise exec node@24.21.0 -- pnpm check
git diff --check
```

A/B 新 probe 完成后再登记可执行命令，必须记录 SDK 来源、实际 DSH/Node 版本、profile、制品哈希、命名空间、用例结果与退出状态。不把尚不存在的 runner 写成已可复跑，也不把 `DSH_KEYCHAIN_SPIKE=0` 的离线检查说成原生验收。

原生存储探针（目标机执行，不挂载宿主、不联网、不打印存储值）：

```sh
# 仓库检出中运行；只有制品时加 --package <安装目录>/node_modules/@heluo/forge-credentials-keychain
node scripts/probe/native-keyring-store-probe.mjs --enumeration
```

输出 JSON 记录平台、triple、addon 路径与逐项结论，作为 §8 矩阵“字符串读写删与枚举”一行的原始证据归档；非目标平台以退出码 2 结束属于预期，不记为缺陷。

目标机取证顺序（每台机各跑一次，结果贴进 issue #182）：

1. `node scripts/fetch-native-keyring.mjs --check` 确认随包产物与校验和一致；
2. `node scripts/probe/native-keyring-store-probe.mjs --enumeration --keep` 记录读写、跨进程与枚举命中集合，并留下探针键；
3. 重启后用 `--key <上一步的键> --expect-present` 复读，确认值仍在；
4. 同一 OS 的另一个用户账户下 `--expect-present` 应为“读不到”（退出码 1），这就是隔离性的期望结果；
5. 用 `--key <键> --cleanup` 清除，并记录 `cmdkey /list`（Windows）或 `secret-tool search service heluo-forge`（Linux）的可见性与权限位。

## 8. D：验收矩阵与证据

下表均为**待实施判据，尚未通过**；不把历史文件覆盖试验混入生产矩阵。

| 场景 | Windows | UOS | 麒麟 | 通过断言 |
|---|---|---|---|---|
| 完整组合 | 待验 | 待验 | 待验 | local 行命中且禁用，预期 keychain owner ACTIVE；不存在双提供方或 local 写调用 |
| 无适配器/锁定/失效 | 待验 | 待验 | 待验 | 不回退文件或 keyutils；不发布失效能力；进程是否退出按 A 宿主专项单独记录 |
| 宿主浏览器认证 | 待验 | 待验 | 待验 | Connection 等实际消费者可用；完整 keychain 替代 local，不因启动需要重新启用 local |
| 字符串读写删与枚举 | 待验 | 待验 | 待验 | 合成记录全集正确；无秘密返回到 listRecords；拒绝不冒充不存在/空集 |
| 单记录与双键原子性 | 待验 | 待验 | 待验 | §5.2 的真实两进程/中断断言成立，精确实例 trust 可撤销 |
| 长 grant / 编码 | 待验 | 待验 | 待验 | 业务上限可存；边界与超限安全失败；pending/退出过程不破坏记录 |
| 应用/系统重启、锁定与恢复 | 待验 | 待验 | 待验 | 持久性与恢复策略成立，失败明确，不自动重放未知写入 |
| 用户、profile 与环境隔离 | 待验 | 待验 | 待验 | 不同 OS 用户及独立命名空间互不读写/枚举/清除；显式共享域同锁 |
| 同一最终制品 | 待验 | 待验 | 待验 | 自包含、无终端编译/外部解析、真实 App/Web 可加载，许可与哈希齐全 |
| 升级、回退、卸载 | 待验 | 待验 | 待验 | 组合恢复且数据未被静默迁移/删除；权限/ACL 变化有记录，不能把 dump 无残留当作凭据删除 |
| IAM/网关业务闭环 | 待验 | 待验 | 待验 | 登录、刷新、退出、网关 CAS 与真实执行入口均按既有契约验收，不以账户页 ready 代替 |

macOS 使用同一探针的 `--platform` 模式，记录本机图形会话与 SSH 会话、密钥权限负例与升级行为；它不依赖签名，也不使用钥匙串。

历史可用证据仅为 §2 的 macOS 加载/GUI 成功路径、SSH 写入拒绝与组合卸载恢复；#125 Linux 属于外部报告。本轮只读审查没有重跑这些实机动作。正式证据保存在团队受控位置并登记引用；日志只含非秘密元数据，不记录 AT/RT、Key、密码、完整 grant、secret 摘要或真实用户数据。

## 9. 未决事项与停止条件

| 问题 | 责任方（待认领） | 截止门禁 / 未关闭时的行为 |
|---|---|---|
| #125 的“启动失败”是哪些 profile 的进程非零退出，还是企业凭据能力拒绝？目标宿主是否有满足要求的公开退出合同？ | 平台组、宿主维护方、安全 | A 宿主专项；保留 issue 原验收，未裁定不整体关单、不修改核心 |
| 严格枚举：Windows 过滤/编码、macOS 单条失败不可见如何解决？ | 平台组、候选库维护方 | G1；有导出或返回空表不通过，不生产启用样机 |
| IAM 真实最大 grant 与刷新 marker 是否满足 Windows 字节上限？ | IAM 团队、平台组 | G1；超限或上限未确定不开放，不截断或分片冒充原子存储 |
| 哪个成熟原语/库提供生产跨进程 RMW、崩溃恢复与网关双键原子提交？ | 平台组、安全 | G1；未定型只做 B，不能签发可信能力；存储布局变化须先评审 |
| 可信工厂/导出、实例与命名空间绑定、卸载失效如何接入真实 apply？ | 凭据与 IAM 负责人 | G1；不以测试 fixture 或自报属性授权 |
| UOS/麒麟准确镜像、glibc、Secret Service 提供方、collection 与重启策略 | IT、平台组 | B3/G2；Ubuntu 和环境变量不能替代目标机证据 |
| 显式共享哪些 profile？非生产覆盖层的责任人、有效期与退出方式？ | 平台组、安全、试点负责人 | A/生产配置冻结前；默认不跨独立环境共享、不内置文件后端 |
| 原生资源闭包、许可证与三目标缓存由谁提供和验收？ | 平台组、AIHUB/制品团队 | 制品构建前；缺任一必选资源不输出可发布包 |
| 存量明文与旧命名空间是否另行迁移？ | 用户、平台组、安全 | 独立范围/设计评审；本方案不自动迁移、不自动删除 |

审核与批准保持“待定”。方案可指导 A/B 开工，不代表 C 已获批或 D 已验证；遇到表中停止条件只停止受影响阶段，继续有独立价值的验证，不用不安全降级换取进度。

## 10. 跟踪关系

- [#125](https://github.com/hrygo/heluo-forge/issues/125)：A 的默认组合、非生产覆盖和宿主失败语义；不在该 issue 偷做原生适配器。
- [#121](https://github.com/hrygo/heluo-forge/issues/121)：B/C 的生产存储与 secret 生命周期，联动既有机密客户端契约。
- [#123](https://github.com/hrygo/heluo-forge/issues/123)：D 的终端与安全证据；交付矩阵以需求基线的三个目标为准。
- [#122](https://github.com/hrygo/heluo-forge/issues/122)：真实模型/工具执行入口与组合保护；不能由凭据 backend 成功替代。
- 实现与验证状态最终回写[设计索引 §2.2](<../design/README.md#22-实现与验证入口>)；本文的工作清单不构成上线或生产批准。

> 执行交接：未来获得代码实施授权后按 A/B/C/D 顺序逐项执行，先补失败用例，再最小实现与独立审阅；不将本次方案审查扩成实现、推送或发布授权。
