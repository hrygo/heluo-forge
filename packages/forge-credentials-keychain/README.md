# @heluo/forge-credentials-keychain

状态：可用（开发骨架；已用 macOS Security CLI 在真实系统钥匙串上跑通 backend 契约、失败语义与旧 0600 迁移演练（仅副本），该适配器**非生产**且需显式 opt-in；`@napi-rs/keyring` 2.1.2 的三平台预编译 addon（win32-x64、linux-x64、linux-arm64）随包暂存并按 platform-arch 解析，Windows/UOS/麒麟适配器因此可挂载，但**未在目标机取证**，仍以 `unvetted` 拒绝默认启用；本地 0600 file backend 仅显式开发/试点）。

一句话：`ctx.credentials` 的 keychain provider 骨架。提供 backend 契约、内存/不可用/显式 0600 file backend、记录/引用读写与进程内单键锁；Windows 凭据管理器与麒麟/UOS Secret Service 由 `vendor/` 下的预编译 addon 接入，尚未在目标机取证。

## 当前实现

| 项 | 状态 |
|---|---|
| 形态 | 替换 `ctx.credentials` 的 provider 插件 |
| backend | 内存、不可用、显式 0600 file（含跨进程事务锁）、macOS Security CLI spike、`vendor/` 下三平台预编译 addon（除内存外都需 `allowUnvettedPlatformAdapter: true`）；生产级取证待目标机 |
| provider | `resolve / describe / set / unset / readRecord / describeRecord / listRecords / modifyRecord / deleteRecord` |
| 迁移 | `migrateLegacyFileToKeychain()` 暂时 fail closed：不读取旧文件、不访问目标、不复制也不删除；`legacyRetained: null` 表示未核实旧文件是否存在。跨进程互斥和源文件隔离契约核验前不可迁移 |
| 并发 | 进程内单键串行；file backend 使用本地 O_EXCL 文档锁与每次读取的独立快照（仅 dev/pilot），锁争用超时后 fail closed；只有锁记录的 PID 确已不存在时才用原子 rename 回收，存活进程持有的锁不会被顶替；OS backend 未实现 |
| 记录 | `api-key` / `grant` JSON；损坏记录显式报错，不静默当作空 |
| 生命周期 | 清理登记为 `ctx.effect`（Cordis 4 不收集普通 `function apply` 的返回值）；卸载时撤销 `ctx.credentials` 并 `close` backend |
| 配置 | `Config` 归一化幂等：缺省 `filePath` 为空串表示“不启用 file backend”，可被框架二次校验接受 |
| 事件 | 按 seam 要求逐个监听器隔离并记录失败；同步抛错不截断后续监听器，异步拒绝不产生未处理 rejection |
| 组合 | 企业补丁已默认禁用 `dsh-credentials-local`（只禁用、不删除该行）；检测到已有 `credentials` 时本插件拒绝挂载，不静默接管 |
| 安全 | 空值拒绝；不落日志；不可用/临时/不安全 backend 默认 fail closed |

## backend 选择

- `resolvePlatformBackend()` 是默认解析：`win32-x64` / `linux-x64` / `linux-arm64` 映射到 `vendor/` 下对应 addon，其余组合（含 `darwin-*`）返回不可用 backend，任何分支都不会落到明文。
- `createPlatformBackend()` 固定返回不可用，是上述“其余组合”的兜底，也用于断言不存在静默降级。
- `createMemoryBackend()` 只用于测试/开发，默认拒绝，需 `allowEphemeral: true`。
- `createFileBackend({ path })` 是显式 0600 明文 fallback，默认拒绝，需 `allowInsecureFile: true`；文件权限在 POSIX 上校验为 `0600`。
- `createSecurityCliBackend()` 是 macOS Security CLI 的**验证用**适配器：口令经 stdin 双次输入写入、不进 argv；`list()` 直接报 `KEYCHAIN_LIST_UNSUPPORTED`（不把"读不到"伪装成"没有记录"）；`secretTransport: 'argv'` 需显式 `allowArgvSecret: true`。
- 组合层启用该适配器还要 `allowUnvettedPlatformAdapter: true`，否则挂载即 `KEYCHAIN_UNVETTED_ADAPTER_REFUSED`。
- `createNativeKeyringBackend({ service, load })` 包装 `@napi-rs/keyring` 2.1.2 的预编译 addon，按 `platform-arch` 以**绝对路径**加载本包 `vendor/<triple>/keyring.node`，不走 `node_modules` 解析，本包也不声明该依赖；`load` 仅用于测试注入；backend key 原样作为 account，`getPassword()` 的 `null` 归一为 `undefined`，Linux 每个 Entry 固定 `{ linux: { store: 'secret-service' } }`（拒绝 keyutils 回退），Windows 按 UTF-16LE 字节拒绝超过 2560 B 的值。它不导出 `transaction()`、不自报跨进程锁，因此 provider 不会声称原子能力；`durable: true` 是对 OS 钥匙串持久性的假设，Linux Secret Service 集合是否跨重启保留未在目标平台验证。枚举默认显式 `KEYCHAIN_LIST_UNSUPPORTED`，只有 `allowUnverifiedEnumeration: true` 才走 `findCredentials`（Windows 过滤语法与 macOS 静默跳过不可读条目的差异仍未核验）。
- 该样机的枚举默认不可用：`listRecords()` 报 `KEYCHAIN_LIST_UNSUPPORTED`，而不是返回空表；只有显式 `allowUnverifiedEnumeration: true` 才使用 `findCredentials`，且各平台的过滤/编码差异仍未核验。没有它，IAM 拿不到 `listRecords`，写路径仍应保持关闭。
- 实测（2026-10-24，darwin-arm64）：未命中条目退出码 44；`add-generic-password -U` 覆盖同名条目；删除幂等；spike 过程无明文文件、测试条目已清理。复跑：`node scripts/probe/run-keychain-spike.mjs`（10/10 步通过）。
- 2026-10-24 的 macOS 迁移演练曾在旧实现上以合成副本记录 9/9；该历史结果不证明当前实现或真实迁移可用。现有 `node scripts/probe/run-keychain-migration-rehearsal.mjs` 只用临时合成文件验证关闭路径：不调用旧读取器、删除器或目标，测试通过仅代表该阻断生效，不代表迁移或目标平台验收通过。受控 IAM 设计中的旧迁移表待同步。
- 生产必须使用 Windows 凭据管理器或麒麟/UOS Secret Service 的审核实现；file backend 与 macOS spike 适配器都不是生产方案。三平台 addon 已随包分发，但**目标机读写、失效与跨进程可见尚未取证**，`unvetted` 因此保持为真，默认挂载需要 `allowUnvettedPlatformAdapter: true`；取证通过后由一处开关（`NATIVE_ADAPTER_VETTED`）转为默认可用。

## 预编译 addon 的暂存与校验

`vendor/` 存放三平台预编译产物，运行时按 `platform-arch` 选文件：

| 目录 | 目标 |
|---|---|
| `win32-x64-msvc/` | Windows 10/11 x64 |
| `linux-x64-gnu/` | UOS 20 amd64 |
| `linux-arm64-gnu/` | 银河麒麟 aarch64 |

暂存与校验都用同一份清单（`scripts/native-keyring.json` 固定版本与 tarball integrity）：

```sh
node scripts/fetch-native-keyring.mjs            # 三种目标
node scripts/fetch-native-keyring.mjs --check    # 校验 CHECKSUMS.json 与文件一致
```

`vendor/CHECKSUMS.json` 记录每个 addon 的 sha256、字节数、来源包与版本；下载的 tarball 与清单
integrity 不一致时立即中止且不写入任何文件。`darwin-arm64` 不属于交付目标，只在本机开发时用
`--with-dev` 暂存，且被 `.gitignore` 排除。细节见 `vendor/README.md`。

## 开发/试点覆盖层（非生产）

企业组合只挂本包，并已禁用官方 `credentials` 行。企业默认补丁不给该行任何 `config`，选择顺序因此落到 `createPlatformBackend()`，而它在所有平台都返回不可用：`apply` 抛 `KEYCHAIN_UNAVAILABLE` 并拒绝挂载，属于预期的 fail closed，不是缺陷，也不是某个平台的兼容问题。

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
