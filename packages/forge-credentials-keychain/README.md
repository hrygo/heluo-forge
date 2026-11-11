# @heluo/forge-credentials-keychain

状态：可用（开发骨架）。`@napi-rs/keyring` 2.1.2 的四个预编译 addon（win32-x64、win32-arm64、linux-x64、linux-arm64）在发布前暂存后随包分发（缺失时构建与产物核验均硬失败），运行时按 platform-arch 解析，Windows/UOS/麒麟适配器因此可挂载；macOS 不使用 addon，也不使用系统钥匙串，而是走应用层加密文档后端（AES-256-GCM，密钥 0600），因此不依赖代码签名、不要求图形会话；Windows 默认同一套加密文档后端。四个 addon 组合**未在目标机取证**，`unvetted` 全局开关保持关闭；macOS 加密后端已于 2026-11-06 在本机与一台远程 Apple Silicon Mac 的 SSH 会话中分别实测 7/7。本地 0600 明文 file backend 仅显式开发/试点。

一句话：`ctx.credentials` 的 keychain provider。提供 backend 契约、内存/不可用/显式 0600 file backend、macOS 加密文档后端、记录/引用读写与进程内单键锁；Windows 与 macOS 由应用层加密文档接入（同一文档锁与记录/引用联合提交），麒麟/UOS Secret Service 与 Windows 凭据管理器由 `vendor/` 下的预编译 addon 以未取证状态接入。

## 当前实现

| 项 | 状态 |
|---|---|
| 形态 | 替换 `ctx.credentials` 的 provider 插件 |
| backend | 内存、不可用、显式 0600 file（含跨进程事务锁）、macOS 加密文档（AES-256-GCM + 0600 密钥，含同一文档锁）、`vendor/` 下四组合预编译 addon（原生 addon 需 `allowUnvettedPlatformAdapter: true`）；生产级取证待目标机 |
| provider | `resolve / describe / set / unset / readRecord / describeRecord / listRecords / modifyRecord / deleteRecord` |
| 迁移 | `migrateLegacyFileToKeychain()` 暂时 fail closed：不读取旧文件、不访问目标、不复制也不删除；`legacyRetained: null` 表示未核实旧文件是否存在。跨进程互斥和源文件隔离契约核验前不可迁移 |
| 并发 | 进程内单键串行；加密文档后端（macOS/Windows）与明文 file backend 都用本地 O_EXCL 文档锁，锁内读取独立快照，争用超时 fail closed；只有锁记录的 PID 确已不存在时才用原子 rename 回收，存活进程持有的锁不会被顶替。`snapshot(scope)` 与 `compareAndSwap(scope, expected, next, guard)` 在同一文档、同一把锁内完成比较、单次同步 guard 与两键写入，一次 fsync+rename 是唯一提交点；guard 拒绝或快照过期时零写入，异步 guard 直接拒绝。原生 OS backend 不提供联合提交 |
| 记录 | `api-key` / `grant` JSON；损坏记录显式报错，不静默当作空 |
| 生命周期 | 清理登记为 `ctx.effect`（Cordis 4 不收集普通 `function apply` 的返回值）；卸载时撤销 `ctx.credentials` 并 `close` backend |
| 配置 | `Config` 归一化幂等：缺省 `filePath` 为空串表示“不启用 file backend”，可被框架二次校验接受 |
| 事件 | 按 seam 要求逐个监听器隔离并记录失败；同步抛错不截断后续监听器，异步拒绝不产生未处理 rejection |
| 组合 | 企业补丁已默认禁用 `dsh-credentials-local`（只禁用、不删除该行）；检测到已有 `credentials` 时本插件拒绝挂载，不静默接管 |
| 安全 | 空值拒绝；不落日志；不可用/临时/不安全 backend 默认 fail closed |

## backend 选择

- `resolvePlatformBackend()` 是默认解析：`win32-*` 与 `darwin-*` 映射到加密文档后端（Windows 根目录 `%LOCALAPPDATA%\\HeluoForge`）；`linux-x64` / `linux-arm64` 映射到 `vendor/` 下对应 addon，仍未取证、需显式开关；其余组合返回不可用 backend。显式指定的 platform-arch 不会被本机架构顶替，任何分支都不会落到明文。
- `createPlatformBackend()` 在 macOS 与 Windows 返回加密文档后端（Windows 根目录为 `%LOCALAPPDATA%\\HeluoForge`），在其余未映射平台返回不可用 backend，是上述“其余组合”的兜底，也用于断言不存在静默降级。
- `createMacosBackend({ directory })` 是 macOS 的生产存储：`~/Library/Application Support/HeluoForge/credentials.json`（0600）以 AES-256-GCM 加密，密钥为同目录 `credentials.key`（32 B 随机，0600，首次使用时生成）。目录 0700；密钥文件权限不是 0600、所有者不是当前用户、或文档无法通过认证标签校验时一律拒绝，不回退明文。枚举由 `listEntries()` 支持，不需要显式开关。
- `createMemoryBackend()` 只用于测试/开发，默认拒绝，需 `allowEphemeral: true`。
- `createFileBackend({ path })` 是显式 0600 明文 fallback，默认拒绝，需 `allowInsecureFile: true`；文件权限在 POSIX 上校验为 `0600`。
- `createSecurityCliBackend()` 是 macOS Security CLI 的**验证用**适配器，不参与生产路径：口令经 stdin 双次输入写入、不进 argv；`list()` 直接报 `KEYCHAIN_LIST_UNSUPPORTED`（不把"读不到"伪装成"没有记录"）；`secretTransport: 'argv'` 需显式 `allowArgvSecret: true`。它用于对照系统钥匙串行为，不随 macOS 生产后端启用。
- 组合层启用该适配器还要 `allowUnvettedPlatformAdapter: true`，否则挂载即 `KEYCHAIN_UNVETTED_ADAPTER_REFUSED`。
- `createNativeKeyringBackend({ service, load })` 包装 `@napi-rs/keyring` 2.1.2 的预编译 addon，按 `platform-arch` 以**绝对路径**加载本包 `vendor/<triple>/keyring.node`，不走 `node_modules` 解析，本包也不声明该依赖；`load` 仅用于测试注入；backend key 原样作为 account，`getPassword()` 的 `null` 归一为 `undefined`，Linux 每个 Entry 固定 `{ linux: { store: 'secret-service' } }`（拒绝 keyutils 回退），Windows 按 UTF-16LE 字节拒绝超过 2560 B 的值。Windows 新目标名以 service 与 key 的精确字节摘要区分大小写；读写删前检测同键旧格式，命中即 `KEYCHAIN_LEGACY_RECORD`，不返回旧值、不迁移、不删除。要重新录入可使用新的 service；旧数据迁移另行处理。它不导出 `transaction()`、不自报跨进程锁，因此 provider 不会声称原子能力；`durable: true` 是对 OS 钥匙串持久性的假设，Linux Secret Service 集合是否跨重启保留未在目标平台验证。枚举默认显式 `KEYCHAIN_LIST_UNSUPPORTED`，只有 `allowUnverifiedEnumeration: true` 才走 `findCredentials`。
- 该样机的枚举默认不可用：`listRecords()` 报 `KEYCHAIN_LIST_UNSUPPORTED`，而不是返回空表；只有显式 `allowUnverifiedEnumeration: true` 才使用 `findCredentials`，且各平台的过滤/编码差异仍未核验。没有它，IAM 拿不到 `listRecords`，写路径仍应保持关闭。
- 实测（2026-10-24，darwin-arm64）：未命中条目退出码 44；`add-generic-password -U` 覆盖同名条目；删除幂等；spike 过程无明文文件、测试条目已清理。复跑：`node scripts/probe/run-keychain-spike.mjs`（10/10 步通过）。
- 2026-10-24 的 macOS 迁移演练曾在旧实现上以合成副本记录 9/9；该历史结果不证明当前实现或真实迁移可用。现有 `node scripts/probe/run-keychain-migration-rehearsal.mjs` 只用临时合成文件验证关闭路径：不调用旧读取器、删除器或目标，测试通过仅代表该阻断生效，不代表迁移或目标平台验收通过。受控 IAM 设计中的旧迁移表待同步。
- 生产使用 Windows/macOS 加密文档后端与麒麟/UOS Secret Service 的审核实现；Windows 凭据管理器只经未取证的原生适配器接入；file backend 与 macOS `security` CLI spike 都不是生产方案。四组合 addon 由发布前暂存随包分发，构建期前置（记录必须列在 `files` 内且逐条满足）与产物期字节校验都按 `CHECKSUMS.json` 硬失败；但**目标机读写、失效与跨进程可见尚未取证**，`unvetted` 因此保持为真，默认挂载需要 `allowUnvettedPlatformAdapter: true`；取证通过后由一处开关（`NATIVE_ADAPTER_VETTED`）转为默认可用。macOS 加密后端不经过该开关。

## macOS 存储边界

macOS 不提供“免签名且无需交互”的系统凭据库：钥匙串条目 ACL 绑定调用方的代码签名，未签名构建每次重建都会变成新身份，SSH/后台会话还触达不到登录钥匙串。一期不提供 Developer ID 签名，因此 macOS 使用应用层加密文档：

- 数据文件 `~/Library/Application Support/HeluoForge/credentials.json`：AES-256-GCM，随机 96 位 IV，认证标签覆盖密文，AAD 绑定文件路径
- 密钥文件同目录 `credentials.key`：32 字节随机，0600；目录 0700；两者所有者必须是当前用户
- 跨进程写入共用同一文档锁与 fsync 原子替换，失败不会留下明文临时文件

它保护**静态数据与离线副本**：只拿到文档、没有密钥文件时无法解密。它**不提供按应用隔离**：同一用户下的进程可以读取密钥并解密，与 0600 文件同级。需要按应用隔离只能回到“带稳定签名的系统钥匙串”，该形态不在本包的一期范围。

## 枚举与边界（依上游源码调研）

依据 `@napi-rs/keyring` 2.1.2 及其锁定的 `keyring-core` 1.0.1、`windows-native-keyring-store` 1.1.0、`dbus-secret-service-keyring-store` 1.0.1 源码：

| 平台 | 写入形态 | 枚举检索键 | account 来源 | 已知失败模式 |
|---|---|---|---|---|
| Windows | account 为原始 key；target 为 `{account}.~heluo-forge-v1-{service 摘要}-{key 摘要}`，blob 为 UTF-16LE；旧目标为 `{account}.{service}` | `CredEnumerateW` 按调用方 key 前缀取得候选 account，再逐键检查旧目标并回读当前 service 的新目标 | 凭据的 `UserName` | 上游不返回目标名；其他 service 的同前缀条目、含糊的 account 或不匹配的值会阻断枚举，非法 blob 也会使整次枚举失败 |
| Linux | Secret Service 条目，属性含 `service`、`username` | 按属性 `service` 搜索 | 属性 `username` | 缺 `username` 属性的条目被上游静默跳过；集合锁定时搜索失败 |
| macOS / Windows | 应用层加密文档：AES-256-GCM，密钥 0600 同目录保存（Windows 位于用户目录 `%LOCALAPPDATA%`） | 整篇文档解密后按 key 前缀过滤 | 文档内的 key 原样 | 密钥权限放宽、密钥与文档不匹配或文档被篡改时显式报错，不回退明文；Windows 上隔离边界是用户账户，不是单个应用 |

原生后端的枚举默认关闭，`allowUnverifiedEnumeration: true` 才走 `findCredentials`。Windows 枚举逐个核对候选 account、旧目标及本 service 新目标的值，仅返回通过核验的结果；重复 account、无法对应的新目标或值不一致时以 `KEYCHAIN_OPERATION_FAILED` 拒绝整次枚举。其他 service 即使使用不同 account，只要目标前缀命中，也可能阻断枚举；单键读写仍按 service 隔离。结果按大小写敏感前缀过滤；非 ASCII 前缀仅大小写不同而无法确认 Windows 比较语义时拒绝枚举。Windows 的调用方前缀若含 `*`，返回 `KEYCHAIN_LIST_UNSUPPORTED`；Windows key 与前缀还须为完整 Unicode。Linux 丢弃不能作为 key 的空 account 与含控制字符的 account。macOS 加密文档后端由 `listEntries()` 直接枚举，不需要该开关。上游错误统一归一为 `KEYCHAIN_OPERATION_FAILED` 并保留平台文本。上游检查的 Windows account 上限为 513 字节（UTF-8）、blob 上限为 2560 字节（UTF-16LE）；实际系统还可能拒绝上游检查允许的账户名：本地 Windows 11 ARM64 虚拟机的合成测试中，512 字节 ASCII account 可写，513 字节以 Windows 错误 1734 拒绝，旧格式与新格式一致。Linux 无库级大小上限，实际受 D-Bus 报文大小约束。

Windows 构造目标时使用普通 `Entry`，不使用 2.1.2 的 `withTarget`：后者在 Windows 构造期间会写入空占位凭据。枚举与逐键回读没有跨进程快照或锁，并发写入和外部修改可能导致结果不一致；旧格式检测与新目标操作之间也没有跨进程锁，旧版与新版不得并发修改同一凭据。如需迁移或回退，须先停止相关进程并保留旧数据。

## 运行前提

| 平台 | 前提 | 校验方式 |
|---|---|---|
| Windows 10/11 x64 与 Windows 11 on ARM | Microsoft Visual C++ 2015-2022 Redistributable：addon 直接导入 `VCRUNTIME140.dll`（UCRT 由系统自带）；arm64 进程需装 arm64 版本，模拟层下的 x64 进程装 x64 版本 | 挂载前检查 `%SystemRoot%\System32\vcruntime140.dll`，缺失即 `KEYCHAIN_UNAVAILABLE` 并指名安装项；探针报告的 `windowsRuntime` 记录同一判断 |
| UOS 20 amd64 | glibc ≥ 2.15（产物导入的符号版本最高为 `GLIBC_2.15`） | `strings vendor/linux-x64-gnu/keyring.node \| grep GLIBC_` |
| 银河麒麟 aarch64 | glibc ≥ 2.17（最高为 `GLIBC_2.17`） | `strings vendor/linux-arm64-gnu/keyring.node \| grep GLIBC_` |
| macOS arm64 / x64 | 无额外运行库；不需要代码签名，也不需要图形会话 | 目录 0700、数据与密钥文件 0600 由探针与单元测试覆盖 |

这两个 glibc 下限低于对应发行版基线，不构成额外部署要求；Windows 的 VC++ 运行库则需要在镜像或安装脚本中显式保证，缺它时加载失败与凭据逻辑无关。

除运行库外，系统凭据库还要求进程位于该用户的**图形登录会话**，并且默认集合已创建、已解锁。2026-11-06 实测：

- macOS 不使用系统钥匙串，因此没有会话前提：2026-11-06 在本机图形会话与一台远程 Apple Silicon Mac 的 SSH 会话中（Node v24.21.0，无签名产物），探针均 7/7 通过，覆盖读写、覆盖、跨进程可见、枚举命中、删除与幂等删除。
- Linux（Ubuntu 24.04 aarch64）：桌面会话只有 `session` 集合、没有默认集合时写入报 `Secret Service: no result found`；用隔离的 `dbus-run-session` + `gnome-keyring-daemon` 建立并解锁 `login` 集合后，同一份产物 7/7 通过。

## 平台默认行为

Windows/Linux 的默认值来自上游绑定源码（`windows-native-keyring-store` 1.1.0 `src/store.rs`、`dbus-secret-service-keyring-store` 1.0.1 `src/cred.rs`）；macOS 行是本包自己的存储契约，与钥匙串绑定无关：

| 平台 | 默认值 | 含义 | 本包能否改变 |
|---|---|---|---|
| Windows | `CRED_PERSIST_ENTERPRISE` | 域环境且启用漫游配置时，凭据随用户配置文件漫游到其他计算机 | 不能：绑定只暴露 `target` 修饰符，未暴露 `persistence` |
| Linux | 集合 `default`（通常是 `login`），条目属性 `service`/`username` | 集合锁定时读取失败并报错，不返回空值；本包不实现解锁交互 | 不能：只固定 `linux.store = secret-service`，不控制解锁 |
| macOS | 文档 `~/Library/Application Support/HeluoForge/credentials.json`，AES-256-GCM，密钥 0600 | 条目在删除前一直有效；跨进程共享同一文档，锁与 fsync 保护写入 | 可以：路径与密钥位置由本包决定 |

Windows 的持久性默认值属于部署决策：若要求凭据只留在本机，当前绑定无法表达，需要换实现或申请上游参数，不能在本包内伪装成本地持久。

## 错误码

| 错误码 | 触发条件 | 是否已写盘 |
|---|---|---|
| `KEYCHAIN_UNAVAILABLE` | 该 platform-arch 无对应 addon、addon 缺失或加载失败、后端整体不可用 | 否 |
| `KEYCHAIN_UNVETTED_ADAPTER_REFUSED` | 适配器未取证且未显式 `allowUnvettedPlatformAdapter` | 否 |
| `KEYCHAIN_LIST_UNSUPPORTED` | 枚举未开启，或该平台枚举未验证，或 Windows 枚举前缀含 `*` | 否 |
| `KEYCHAIN_LEGACY_RECORD` | Windows 同键旧格式记录存在，或枚举发现相关旧记录 | 否，旧记录保留 |
| `KEYCHAIN_VALUE_EMPTY` / `KEYCHAIN_VALUE_INVALID` / `KEYCHAIN_VALUE_TOO_LARGE` | 空值；非字符串或含孤立代理项；Windows 超过 2560 B（UTF-16LE 计） | 否 |
| `KEYCHAIN_KEY_INVALID` | backend key 为空、含控制字符或不合命名空间文法；Windows key 或枚举前缀不是完整 Unicode；或密钥文件不是 32 字节 | 否 |
| `KEYCHAIN_KEY_PERMISSIONS` | 密钥文件权限不是 0600 或所有者不是当前用户 | 否 |
| `KEYCHAIN_FILE_TAMPERED` | 加密文档无法通过认证标签校验（被修改或密钥不匹配） | 否 |
| `KEYCHAIN_KEY_TOO_LONG` | Windows account 超过 513 字节（UTF-8） | 否 |
| `KEYCHAIN_OPERATION_FAILED` | 存储返回非字符串、枚举形状异常、删除后条目仍可读 | 删除分支可能已部分生效 |
| `KEYCHAIN_EPHEMERAL_REFUSED` / `KEYCHAIN_INSECURE_FILE_REFUSED` | 临时后端或明文文件后端未显式允许 | 否 |
| `KEYCHAIN_LOCK_TIMEOUT` | 文件后端跨进程锁等待超时 | 否 |

## 预编译 addon 的暂存与校验

`vendor/` 存放四组合预编译产物，运行时按 `platform-arch` 选文件（macOS 不使用 addon）：

| 目录 | 目标 |
|---|---|
| `win32-x64-msvc/` | Windows 10/11 x64 |
| `win32-arm64-msvc/` | Windows 11 on ARM（原生 arm64 Node） |
| `linux-x64-gnu/` | UOS 20 amd64 |
| `linux-arm64-gnu/` | 银河麒麟 aarch64 |

暂存与校验都用同一份清单（`scripts/native-keyring.json` 固定版本与 tarball integrity）：

```sh
node scripts/fetch-native-keyring.mjs            # 四个目标
node scripts/fetch-native-keyring.mjs --check    # 校验 CHECKSUMS.json 与文件一致
```

`vendor/CHECKSUMS.json` 记录每个 addon 的 sha256、字节数、来源包与版本，也是"发布必须带哪些文件"的
唯一真源：企业包构建在打包前按它逐条校验暂存目录（缺文件、字节数或 sha256 不符即非零退出、不产制品），
`verify-enterprise-bundle` 在产物一侧再按归档字节复核同一份记录。下载的 tarball 与清单 integrity
不一致时立即中止且不写入任何文件。`--check` 不只比对哈希：它还按 triple 校验对象头
（PE/AMD64、PE/ARM64、ELF/x86-64、ELF/AArch64）与记录中的 `version`/`license`/`source`/`integrity`，
清单里钉错架构或与锁文件漂移都会被拒绝。细节见 `vendor/README.md`。

干净检出没有 addon 字节，`--check` 跑不了，所以另有一条**只用文档**的一致性检查常驻 CI：提交的
`vendor/CHECKSUMS.json` 必须与 `scripts/native-keyring.json` 在 triple 集合、`source`、`integrity`、
`version`、`license` 上完全一致。手改记录、或只升级了锁文件却忘了重新暂存，会在普通 `pnpm check` 上直接红，
不再等到发布机。

## 开发/试点覆盖层（非生产）

企业组合只挂本包，并已禁用官方 `credentials` 行。企业默认补丁不给该行任何 `config`，选择顺序落到 `resolvePlatformBackend()`：`win32-x64`、`win32-arm64`、`linux-x64`、`linux-arm64` 解析到随包的预编译 addon（随包由构建期前置保证），`darwin-arm64`、`darwin-x64` 解析到 macOS 加密文档后端，其余组合返回不可用 backend。四个 addon 组合已在 CI 的四个真机 runner（`native-keychain` 作业）上完成写/读/改/删/跨进程验收（Windows 凭据管理器、Linux Secret Service），但目标机与桌面发行版仍未取证，故仍按 `unvetted` 处理，挂载需 `allowUnvettedPlatformAdapter: true`，否则 `KEYCHAIN_UNVETTED_ADAPTER_REFUSED`；未映射平台抛 `KEYCHAIN_UNAVAILABLE`。两者都是预期的 fail closed，不是某个平台的兼容缺陷。

开发/试点需要可用凭据时，在 profile 上再叠一层补丁，显式启用文件后端：

```yaml
- id: heluo-credentials-keychain
  config:
    filePath: /tmp/forge-pilot/credentials.json   # 必须在仓库外
    allowInsecureFile: true
```

Windows 开发机用同一层补丁，把路径换成该机器上真实的绝对路径（正斜杠，目录同样须在任何 git 工作树之外；开发机上通常落在用户主目录下的 `.dsh/forge-dev/`）：

```yaml
- id: heluo-credentials-keychain
  config:
    service: heluo-forge-dev
    accountPrefix: iam
    filePath: 'D:/forge-dev/credentials.dev.json'
    allowInsecureFile: true
```

覆盖层替换整个 `config`，不按字段深合并：`service` 与 `accountPrefix` 不写就回落到 `heluo-forge` / `iam` 默认值，需要非默认命名空间时在这一层写全。

约束：

- 路径放在仓库外，POSIX 权限 `0600`，只放开发/试点账号，不复用生产 IAM 会话。
- `allowInsecureFile` 不得进入企业默认补丁；启用时 `apply` 会打印 non-production 告警。
- 要回到生产形态，删掉这层补丁即可，不需要改默认组合。
- Windows 上该文件是明文，`chmod 0600` 只是 best-effort，不会设置 NTFS ACL；实际保护来自 `%USERPROFILE%` 继承的权限。共享机器不放开发账号，目录不上网络盘——跨进程锁是本地文件锁。

## 不可用于生产

- file backend 的跨进程锁是本地文件锁，只用于开发/试点；生产 OS backend 必须自行提供等价的跨进程互斥，当前尚未实现。
- 崩溃遗留锁按“所有者确定已消失”回收：锁文件里记 `pid:随机串`，等待方只在 PID 不存在（`process.kill(pid, 0)` 返回 ESRCH）时，用一次原子 `rename` 把旧锁移到唯一名字再删除。rename 只有一个赢家，落败者看到 ENOENT 后重试独占创建，因此不会误删别人刚建的新锁。锁的 PID 读不出来、或进程仍活着（含 EPERM 的非本用户进程）时不接管，等待超过 `lockTimeoutMs`（默认 10 秒）抛 `KEYCHAIN_LOCK_TIMEOUT`。
- 掉电语义：写入先 `fsync` 临时文件、再 `rename`、最后对目录做一次 best-effort `fsync`（Windows 无法以 fd 打开目录，那里跳过目录同步，`rename` 本身仍是原子的）。这样崩溃后不会出现新名字指向空文件的形态；尚未在真实掉电或 `kill -9` 窗口下实测。
- file backend 是明文落盘，仅限本地开发/试点；不得进入生产配置。
- OS keychain 双端实测尚未完成。

## 测试

```sh
node --test packages/forge-credentials-keychain/test
```

根检查：

```sh
pnpm check
git diff --check
```

## 关联

- IAM 设计：`docs/design/plugins/forge-iam.md` §6、§11
- 凭据模式：`docs/design/credential-modes.md`
- 实施 issue：`#13`
