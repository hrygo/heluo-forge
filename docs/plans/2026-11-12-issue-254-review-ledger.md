# Issue #254 审查意见处置与覆盖台账

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-020 |
| 文档名称 | Issue #254 审查意见处置与覆盖台账 |
| 版本 | V0.4.0 |
| 文档状态 | 草案（代拟，待负责人确认） |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 编制依据 | issue #254（2026-11-12）的 26 条逐条审查意见与 1 个「41 个文件机器人未覆盖」勾选项；本轮分支 `feature-issue-254`，基线 `5bfcf2a`（PR #237 合并提交）上的离线用例与本地复跑记录 |
| 关联文档 | [文档清单](../DOCUMENT-REGISTER.md)、[IAM 接入详细设计](../design/plugins/forge-iam.md)、[多端凭据存储方案](2026-11-03-credential-multiplatform.md)、[凭据存储整洁架构方案](2026-11-12-credential-storage-clean-arch.md)、[设计索引](../design/README.md) |
| 最后更新 | 2026-11-13 |
| 门禁 | 不改变任何 G 门禁；只记录每条意见的当前处置结论与证据级别，不宣称企业环境或目标平台已验收 |

> 范围：issue #254 的 26 条逐条审查意见逐条记账，加上该 issue 第 1 个勾选项要求的 41 个文件复核结论、本轮复核中新发现的 13 项独立缺口（编号 F1—F17，见 §4），以及 PR #256 评审 5872697951 的 5 条意见（编号 R1—R5，见 §8）。本台账只记录**本分支离线证据**；企业 IAM／网关、Windows 与麒麟目标机的实机结论仍为空，不以本地测试替代。

## 1. 结论摘要

- **26 条意见**（合并 `origin/main`（`f8f7a29`，PR #253）后重新判定）：18 条「仍存在并已修复」；5 条「已由 #253 架构消解」（第 1、2、3、11、22 条，缺陷在基线成立，但 #253 用静态注册、单事务与 SQLite 行锁把原文件后端整体替换，旧路径不复存在）；1 条「主线已实现且更严」（第 12 条）；1 条「由主线方案承接」（第 21 条，改为 `HELUO_FORGE_STORE_DIRECTORY` + 只读 `openCredentialReader()`）；1 条「已解决」（第 4 条 npm shim 入口，基线 `5bfcf2a` 即无此缺陷）。逐条见 §3。
- **41 个文件**：全部完成「结构 + 关键路径」复核，逐文件结论见 §5。其中 15 个文件由既有或本轮新增用例直接覆盖；其余为文档、工作流与支撑件，按 §5 的说明如实标注覆盖来源或缺口。
- **独立发现 13 项**：合并前修复 8 项（F1、F2、F4、F6、F7、F12、F15、F16）；合并后 F6 随主线 loopback-only 桥边界、F12 随 #253 的 `credentials.sqlite.init` fail closed 承接，其余 6 项保留；列为 follow-up 5 项（F3、F8、F9、F13、F17）。F13 经复核属于既有决策 D1 的已知取舍，按「如实披露 + 待平台支持后变更」处理，不计为缺陷。逐项见 §4。
- **PR #256 评审 6 条**（首轮 5 条 + 复查 1 条）：R1、R4、R5、R6 在合并后仍成立并保留修复；R2、R3 因 #253 把文件后端换成 SQLite 事务而消解；另按评审 4550143463、4550143490、4550143505 处理 #253 合入带来的三处边界，逐条见 §8 与 §9。
- **本轮不宣称**：真实企业 IAM／网关联调、Windows 与麒麟目标机实机验收、Release 工作流的同 SHA CI 门禁均为 NOT RUN 或未实施，见 §7。

## 2. 证据级别

- **L1**：本分支可复跑的离线单元/集成测试（`node --test`），以及可复跑的检查器（`scripts/*.mjs`）。
- **L2**：基线宿主探针记录（引用既有探针结论，本轮未重跑的部分显式标注）。
- **L3**：夹具/合成适配器等价构造（如伪造 npm shim、注入失败 executor、合成 discovery 文档）。L3 只证明分支逻辑，不证明真实平台行为。
- **NOT RUN**：未执行或无法在本机执行（企业环境、目标机、需平台配合的协议变更）。

## 3. 26 条审查意见逐条结论

结论口径：**仍存在并已修复**＝本轮改动后消失且有用例判据；**已解决**＝缺陷在基线 `5bfcf2a` 中已不存在，本轮只核验并补判据；**已由 #253 架构消解**＝缺陷在基线成立，但合并 `origin/main`（`f8f7a29`）后旧实现整体被 SQLite 引擎替换，原路径不复存在，判据落到新实现的用例上；**主线已实现**＝主线以更严的方式实现了同一目标；**由主线方案承接**＝本分支方案放弃，改由主线等价或更严的方案承接；**不适用**＝本轮实现下不构成缺陷。每条的「改动位置」与「判据用例」均为合并后代码，判据正反两向：正向用例在修复后通过，负向/变异用例在旧代码上失败。

| 条号 | 意见要点 | 结论 | 改动位置（文件:行） | 判据与证据 |
|---|---|---|---|---|
| 1 | 原子存储信任只按方法形状授予：任何带 `snapshot`/`compareAndSwap` 的外来 backend 都能拿到 `iam-atomic-store` 信任 | **已由 #253 架构消解** | 合并 `origin/main`（`f8f7a29`，PR #253）后，信任绑定到静态注册：`packages/forge-credentials-keychain/src/backend-registry.mjs` 的 `BACKENDS` 只为 `sqlite` 登记 `crossProcessLock` 与 `jointAtomic`，`createDefaultBackend()` 返回 frozen `{backend, capabilities}`，注释写明注入的 backend 不经过注册函数；`src/index.mjs:279-285` 仅当两个能力都为真才提供 `iam-atomic-store` | `packages/forge-credentials-keychain/test/backend-registry.test.mjs:221`、`test/sqlite-composition.test.mjs:55`；包内 `223 / 223`。L1。原修复（模块私有 `WeakMap` + `verifiedCapabilities()`）随旧文件后端一并删除 |
| 2 | `compareAndSwap` 在 guard 与 `rename` 之间仍有多个 `await`，生命周期变化可插入已提交内容 | **已由 #253 架构消解** | 异步 `prepare()` 阶段不存在：`src/encrypted-adapter.mjs:97-113` 的 pair 比较、同步 guard 与双写整体位于 `src/sqlite-backend.mjs:188-212` 的 `BEGIN EXCLUSIVE` 事务内，COMMIT 是唯一提交点 | `test/encrypted-adapter.test.mjs`、`test/sqlite-read-contention.test.mjs:73`。L1。原 `test/atomic-document.test.mjs` 已删除（它测的是旧 file backend 的两阶段提交） |
| 3 | 死锁回收仅按 PID 判定，两个等待者可同时回收同一把锁 | **已由 #253 架构消解** | 锁从文件移到 `meta('lock')` 行：`src/sqlite-backend.mjs:296-330` 在事务内 CAS 换锁；存活 PID 的锁仅在其同时发布 `credentials.sqlite.abandoned.<pid>.<digest>` 且 digest 匹配时才可回收（`:143-160`），不存在按 PID 强抢 | `test/sqlite-read-contention.test.mjs:234,319,403`、`test/sqlite-key-provider.test.mjs:130,175`。L1。原 `test/file-backend-races.test.mjs` 已删除 |
| 4 | Windows 上 `npm` 入口可能解析到 shell shim 而非 `npm-cli.js` | **已解决**（基线不存在） | 基线即 `scripts/init-enterprise-plugin.mjs:273-280` 固定取 `node_modules/npm/bin/npm-cli.js` | `tests/init-enterprise-plugin.test.mjs:346-360`（夹具里先放 `npm-prefix.js` 干扰）、`:293-313`、`:315`（找不到即 fail closed）。L1 |
| 5 | `INSTALL_FAILED` 只给错误码，不带 pnpm 的真实 stderr，现场无法自诊 | 仍存在并已修复 | `scripts/init-enterprise-plugin.mjs:923-930`（`reasonTail`）、`:402`、`:628`（stderr/stdout 末 3 行、上限 300 字符） | `tests/init-enterprise-plugin.test.mjs:642-680`。L1 |
| 6 | `--profile desktop` 未经核验就先 `plugin add`，宿主不支持 Desktop 时留下写了一半的安装 | 仍存在并已修复 | `scripts/init-enterprise-plugin.mjs:703-716 assertDesktopVerifiable`、`:919-921`（在 `plugin add` 前跑 `--profile desktop --dump-config`，失败抛 `DESKTOP_PROFILE_UNSUPPORTED`，零写入） | `tests/init-enterprise-plugin.test.mjs:584-610`（`calls.length===1`、manifest 逐字节不变）；变异（注释 `:920`）→ 3 用例红。L1 |
| 7 | maker 不按目标插件真实配置契约校验：接受 `HELUO_GITEE_HOST=https://…`、`scopes=profile`、`REDIRECT_PATH=/api/forge-iam/callback` | 仍存在并已修复（`CALLBACK_ADDRESS=localhost` 子项基线已拒绝，仅补用例） | `scripts/lib/private-bundle.mjs:107-108`（主机名/长度）、`:354-362`（gitee 裸主机名）、`:320-323`（scopes 必须含 openid）、`:274 redirectPathProblem` + `:395`、`:364-371`（cliPath 拒绝 URL/wrapper）；文档 `.agents/skills/heluo-forge-release-bundle/{SKILL.md,references/sop.md}` | `tests/private-bundle-boundary.test.mjs:138`（产物喂真实 `validateConfig`/`validateGiteeConfig`）、`:156/:162/:168/:179/:185/:191`（每行同时断言插件也拒绝同值）；旧代码实测三项全部放行。L1 |
| 8 | 只有 discovery URL 就判「已配置」，无独立可信 issuer；`verifyDiscovery` 在 issuer 为空时直接采用文档里的 issuer | 仍存在并已修复 | `scripts/lib/private-bundle.mjs:123-131 isLoginConfigured`（issuer 为强制项，先于 discoveryUrl 判定）、`:152-157`（缺 issuer → `DISCOVERY_ISSUER_REQUIRED`）；打包期 `HELUO_IAM_ISSUER is required` | `tests/discovery.test.mjs:104`（discovery-only 不是信任锚）、`:78`、`:47`；旧代码返回 `{checked:true, issuer:'https://other.example'}`（实测）。L1 |
| 9 | `verifyDiscovery` 对 issuer 去尾斜杠比较，与 IAM 运行时的严格比较不一致 → maker 放行、登录报 `IAM_DISCOVERY_ISSUER_MISMATCH` | 仍存在并已修复 | `scripts/lib/private-bundle.mjs:191-194`：`document.issuer !== iam.issuer`，**严格相等、零规范化**，与 `packages/forge-iam/src/oidc.mjs:312` 同语义；旧 `sameUrl` 已整体删除；endpoint 同形比较 | `tests/discovery.test.mjs:115`（两侧尾斜杠差异两个方向都判不一致）、`:150`；旧代码实测放行。L1 |
| 10 | `verifyDiscovery` 结果对象直接进入预览与发布输出，回显企业 issuer 与全部端点；失败分支也打印 URL | 仍存在并已修复 | `scripts/lib/private-bundle.mjs:196-235`（只返回 `{checked, matched:[字段名]}`）、失败消息去值（`:157/:194/:205`）；`scripts/make-private-bundle.mjs:136` 预览只给 `discoveryCheck` | `tests/discovery.test.mjs:52/:63/:126`（失败消息保留错误类型、不回显 URL）、`tests/private-bundle-boundary.test.mjs:208`（预览 stderr 无 `corp.example`）。L1 |
| 11 | provider 的 `source` 恒报 `keychain`，文件后端也如此，账号页因此不提示「非系统凭据库」 | **已由 #253 架构消解** | 原生钥匙串适配器（`native-keyring.mjs`、`security-cli.mjs`）整体删除，`packages/forge-credentials-keychain/src/provider.mjs:113` 只可能报 `memory` 或 `file`，不存在可谎报的 `keychain` 来源 | `test/provider.test.mjs:16`、`test/sqlite-composition.test.mjs:52-53`。L1（GUI 文案未人工确认，见 §7） |
| 12 | `storeDirectory` 绕过「不得位于 Git 工作树内」检查（`filePath` 有、目录没有），而两者落盘的是同一组文件 | **主线已实现（比原方案更严）** | `packages/forge-credentials-keychain/src/index.mjs:33-48 assertDirectoryOutsideRepository`，在 `:182-186` 挂载路径与 `:189-197` CLI 只读打开都调用；`src/key-paths.mjs:35,61-62` 再校验 directory 与 keyDirectory，`src/sqlite-backend.mjs:80,225` 打开前各查一次 | `test/apply.test.mjs:298`。L1 |
| 13 | 公开发布构建把归档写入磁盘后才发现敏感内容，且工具归档未按解密后的条目扫描 | 仍存在并已修复 | `scripts/build-public-release.mjs`（源码归档改 `readBundleEntries(...,{withContent:true,prefix})` 后 `scanReleaseFiles(...,{publicOnly:false})`，命中 `SOURCE_UNSAFE`；工具归档解析后扫描，命中 `TOOLS_SENSITIVE`；两处扫描均在写盘前） | `tests/release-public.test.mjs`；变异（禁用任一扫描）→ 新用例红。L1 |
| 14 | 私有产物边界用 `startsWith('..')` 字符串判定：仓库内 `..secret` 被误判为在外，指向仓库内的 symlink 放行 | 仍存在并已修复（含并发发现的同类点） | `scripts/lib/release-support.mjs:94-113 realpathOfNearestExisting`、`:118-124 assertOutsideDirectory`（最近存在祖先 realpath + 路径分量）；`scripts/lib/private-bundle.mjs` 改用该函数；`scripts/make-private-bundle.mjs:112-119` 编码 `CONFIG_INSIDE_REPO`/`OUTPUT_INSIDE_REPO`；**`scripts/release-delivery.mjs:125-134`**（本轮一并改为同一函数，原为 resolve 后字符串前缀判定） | `tests/private-bundle-boundary.test.mjs:232`（`:240` 在内拒绝、`:244` 兄弟 `repo..secret` 放行、`:249-252` symlink 拒绝）、`:254/:273/:281`；`tests/release-delivery.test.mjs` 新增「指回 checkout 的 symlink → `OUTPUT_INSIDE_REPO`」与「同名 `..delivery` 兄弟目录不误判」两例；旧代码实测前两类被放行。L1 |
| 15 | 直接 maker 入口只比对 digest 就报成功，缺少既有产物闭包校验（删掉原生 addon 并重算 digest 仍成功） | 仍存在并已修复 | `scripts/lib/private-bundle.mjs:640-651 assertArtifactClosure`（复用 `verifyBundle`）、`:671 PUBLIC_INCOMPLETE`（输入侧）、`:742-743 ARTIFACT_VERIFY_FAILED`（rename 前，staging 由既有 catch 清理）、返回对象新增 `verified:true`；`scripts/make-private-bundle.mjs:171` 透出 | `tests/private-bundle-boundary.test.mjs:319/:332/:363`；旧代码中 `verifyBundle` 出现 0 次（静态判定，未实跑）。L1 |
| 16 | 发布失败时已写出的产物残留（目录先建、zip 后做），重试撞 `OUTPUT_EXISTS`，且可能清掉用户既有文件 | 仍存在并已修复 | `scripts/release-delivery.mjs:349-356`（独立 staging）、`:395-404`（先 zip，失败即 `ARCHIVE_FAILED` 且 nothing published）、`:406-410`（zip 成功后才落目录）、`:425-437`（finally 只清本次产物） | `tests/release-delivery.test.mjs:330`（zip 失败不留产物、重试不被 `OUTPUT_EXISTS` 挡）、`:347`（既有空目录与用户文件不被删）。L1 |
| 17 | tar 写入器给 PAX 扩展头写错了 typeflag，且目录/条目 mode 被固定 | 仍存在并已修复 | `scripts/lib/bundle-write.mjs`（`header()` 增加 typeflag 参数，PAX 头用 `'x'`，后续目标头继承 `file.mode`；单段 >100 字节仍在写前 fail） | `tests/bundle-write.test.mjs`（本轮新增）；变异（写死 `0644`、去掉 `'x'`）→ 用例红。L1 |
| 18 | 文本扩展名正则带 `/u` 漏掉 `.MD`/`.JSON`，敏感扫描可绕过 | 仍存在并已修复 | `scripts/lib/repo-rules.mjs:40`（扩展名清单改用大小写不敏感匹配，并注释说明 `.MD`/`.JSON` 与各自小写形式是同一文本载体） | `tests/check-repo.test.mjs`；变异（还原 `/u`）→ 用例红。L1 |
| 19 | `--sha256` 被当作来源证明（provenance）向安装方呈现 | 仍存在并已修复 | `scripts/init-enterprise-plugin.mjs:851-852`（标明「属自证，只能证明未损坏」）、`scripts/release-delivery.mjs:150,163,243-244`（INSTALL.md 同口径） | `tests/release-delivery.test.mjs:360` 等文档断言。L1 |
| 20 | UAT 文档称凭据会被自动清理，实际留在目录里 | 仍存在并已修复（文档侧随主线重写后恢复精确说明） | `packages/forge-iam/docs/local-mock-testing.md`：合并时正文取主线重写（已声明「停止进程后原目录仍可能保留」但未给路径与权限），本轮补回精确事实——凭据在脚本打印的 `dsh/credentials` 下以 `credentials.sqlite` 保存，密钥在兄弟目录 `dsh/credentials.keys/keyring.json`，两目录 0700、属主为当前用户、停止后保留，并给出只删本次目录的 `rm -rf` 指令；`scripts/probe/run-iam-local-uat.sh` 的注释与退出提示同步改为 SQLite 口径（原注释仍在描述已删除的应用层加密文档后端），`cleanup_hint` 与 `trap cleanup_hint EXIT` 保留 | `node scripts/check-docs.mjs` ok；脚本改为 `bash -n` 语法自检通过、退出提示与实际存储目录一致；按主线契约核对 `packages/forge-iam/docs/credential-access.md` 的 `HELUO_FORGE_STORE_DIRECTORY` 说明。L1（真实宿主 UAT 未重跑，见 §7） |
| 21 | CLI 无法读取 Host 用 `storeDirectory` 配置的凭据目录，只能读默认目录 → 可能用到另一份身份 | **由主线方案承接** | 按「凭据相关以 #253 为准」，本分支原方案（`HELUO_FORGE_CREDENTIALS_DIRECTORY`、`IAM_CREDENTIALS_DIRECTORY_UNAVAILABLE`、`IAM_CREDENTIALS_CONFIG_CONFLICT`）整体放弃；主线以 `packages/forge-iam/bin/heluo-forge.mjs:45` 的 `HELUO_FORGE_STORE_DIRECTORY` 承接，CLI 经 `openCredentialReader()`（`src/index.mjs:189-197`）只读打开同一目录，目录不可用即失败、不回退默认目录 | `packages/forge-iam/test/bridge-real-provider.test.mjs`（Host 与 CLI 共享自定义目录、兄弟 key 目录）、`test/cli-reader.test.mjs`、`test/read-paths-matrix.test.mjs`；本合并树的全量 `node --test` 通过；同一批用例在 `f8f7a29` 的托管 CI 6 个平台运行器上已通过（L2，针对主线提交，非本合并树）。L1 |
| 22 | Windows 上旧配置（`allowUnvettedPlatformAdapter`）在新版本静默换到应用层加密文档，旧原生记录不再被读且无提示 | **已由 #253 架构消解** | 原生适配器删除后不再有「换到应用层加密文档却无提示」的静默迁移；`src/index.mjs:155-159` 对 `platformAdapter`、`allowUnvettedPlatformAdapter` 等旧配置直接报 unsupported，迁移提示函数无适用对象 | `test/apply.test.mjs`（legacy backend configuration is rejected…）。L1 |
| 23 | 发布工具完整性检查 `roots.filter(existsSync)` 后再 `existsSync` 形同虚设，缺脚本仍能出包 | 仍存在并已修复 | `scripts/build-public-release.mjs`（新增 `RELEASE_TOOL_FILES`/`TOOL_SKILL_ENTRY`，先核验 8 个必需脚本 + `.agents/skills/heluo-forge-release-bundle/SKILL.md`，缺即 `TOOLS_INCOMPLETE` 并列出缺失路径；`scripts/lib` 无 `.mjs` 也失败；校验提前到打包前） | `tests/release-public.test.mjs`；变异（禁用 `TOOLS_INCOMPLETE`）→ 用例红。L1 |
| 24 | 只按版本号判断安装包是不是同一制品，同名同版本可替换 | 仍存在并已修复 | `scripts/init-enterprise-plugin.mjs:647 artifactIdentityOf`（按安装时刻留存的证据核对，见 §8 R5：`profile/node_modules` 内已装目录存在 → 证据文件 `profiles/<p>/.heluo-enterprise-install.json` 存在 → 记录的版本与交付版本相同 → 记录的 tgz 摘要等于本次交付（不等即 `conflict`）→ 重算已装目录摘要与记录相同（不等即 `unconfirmed`））、`:974-997`（已装同版本但冲突 → `ARTIFACT_CONFLICT` 零写入；无法确认则继续并给「仅版本相同不能证明是同一制品」warning） | `tests/init-enterprise-plugin.test.mjs:533/:566/:602/:629/:660/:505`；变异（插回「按 profile 的 `file:` 路径当前内容哈希」）→ 4 条红。L1 |
| 25 | 发行默认宿主版本常量（rc.5）高于仓库基线（`.dsh-version` = rc.3），发行物与 CI 口径不一致 | 仍存在并已修复 | `scripts/init-enterprise-plugin.mjs:43 DEFAULT_HOST_VERSION='0.2.1-rc.3'`（= `.dsh-version`，且 ≥ 全部 `engines.dsh` 下限 rc.2）；`scripts/lib/dsh-version.mjs:228-266` 新增 `RELEASE_DEFAULT_HOSTS`/`checkReleaseDefaults`/`rewriteReleaseDefaults`、`:391-396` 字面量必须等于基线（**删除 `CODE_LITERAL_EXCEPTIONS` 白名单**）；`scripts/dsh-version.mjs:110` 纳入 `check`、`:159-176` `apply` 一并改写 | `tests/dsh-version.test.mjs`、`tests/init-enterprise-plugin.test.mjs`；变异（改回 rc.5）→ 2 errors；`node scripts/dsh-version.mjs check` ok。L1 |
| 26 | SOP 让安装方「打开 DSH Desktop」，本地必须先用 `dsh web` 起 Host，Desktop 起不来 | 仍存在并已修复 | `scripts/release-delivery.mjs:248-253`（第 1 步 `dsh web`，加粗「不要用打开 Desktop 代替」）、`:255-266`（Desktop 用户单列一段并说明前提）、`:206-210`（Windows 启动器回显）；SOP `.agents/skills/heluo-forge-release-bundle/references/sop.md:64-66`、`SKILL.md:104` | `tests/release-delivery.test.mjs:360`（生成的 INSTALL.md 含 `dsh web` 步骤与 Desktop 限定）。L1 |

## 4. 本轮独立发现（F1—F17）

本轮对 41 个文件做「结构 + 关键路径」复核时另发现 17 项缺口，编号 F1—F17（无 F5/F10/F11/F14，编号由复核过程保留，未重排）。处置分三类：**本轮修复**、**follow-up（记入待办，不在本次改动内）**、**不计为缺陷（既有决策的已知取舍，改为如实披露）**。

| 编号 | 级别 | 发现 | 处置 | 证据 |
|---|---|---|---|---|
| F1 | P2 | 制品门禁弱于源码门禁：`FORBIDDEN_NAMES` 缺 `.pem/.key/.p12/.pfx/.jks/.keystore/.ppk`，且只按扩展名决定是否扫内容 → 扩展名不在名单里的载体（如 `.pem`）即使正文含完整私钥块也返回空 | 本轮修复：`scripts/lib/release-support.mjs:42 FORBIDDEN_EXTENSIONS`、`:59 PRIVATE_KEY_BLOCK`、`:191`、`:200`（**每个条目不论扩展名**都解码找完整私钥块，64 KiB 窗口） | `tests/private-bundle-boundary.test.mjs:379-459`（7 种扩展名 + 内容判定 + 跨扩展名私钥块）；旧版对 `.pem` 与 `.bin/.dat/无扩展名` 返回 `[]`（实测）。取舍：只匹配完整块（`.pem` 按名拒绝，证书类随包用 `.crt/.cer` 且仍扫内容） |
| F2 | P3 | `HOST_PATH` 的 Windows 分支要求两个反斜杠，单反斜杠的 `C:` 用户目录不命中 | 本轮修复（Lead）：`scripts/lib/sensitive-patterns.mjs` 的 `HOST_PATH` 采用 `\\{1,2}` 与 `/` 两种分隔符各接受一次或两次 | `tests/sensitive-patterns.test.mjs`（本轮新增：POSIX／单反斜杠／转义双反斜杠为正例，「Users/example」、「the Users directory」、https URL 为反例） |
| F3 | P3 | `release-bundle.yml` 由 tag/手动触发，构建前不校验同 SHA 的 CI 结果，红灯提交也能出包 | follow-up：是否以「同 SHA CI 绿」为发版前置属发布策略，需负责人裁决后实施 | `.github/workflows/release-bundle.yml`（无自动化测试） |
| F4 | P3 | `make-private-bundle --json` 不输出 discovery 状态，跳过 discovery 校验没有痕迹 | 本轮修复：`scripts/make-private-bundle.mjs:119-126 discoveryState`、`:136`、`:144-146`（人类可读行 `discovery: verified\|skipped(…)\|not verified(…)`）、`:171` | `tests/private-bundle-boundary.test.mjs:513/:540` |
| F6 | P3 | `HELUO_FORGE_IAM_URL` 无约束，桥能力值（Bearer）可被发往任意地址 | **随主线桥边界消解**：合并后 `packages/forge-iam/bin/heluo-forge.mjs:60` 只接受 `127.0.0.1` 与 `[::1]`，`:73` 明确 `redirect: 'error'`，越界地址在发请求前被拒；本分支原方案的「任意 HTTPS + 不安全 HTTP 逃生口」按评审 4550143463 整体放弃，不放宽 | `packages/forge-iam/test/cli-session.test.mjs`（主线版，11 例；含 Host 白名单与重定向拒绝）。L1 |
| F7 | P3 | `client-login-window.test.mjs` 只统计 `sign-in` 字面出现 4 次，不是「所有调用都带超时」——删掉超时也不会红 | 本轮修复：`packages/forge-iam/test/client-login-window.test.mjs:23-24` 改为两级计数（调用点数 N、带 `timeoutMs` 的数 M，断言 `N>0` 且 `N===M`） | 变异（删一条 `timeoutMs`）→ `AssertionError: every sign-in call site must pass the timeout` |
| F8 | P3 | `client-shape.test.mjs` 只枚举 `fetch('…')` 字面量，`postJson` 目标不受约束 | follow-up：需先扩展 `packages/forge-iam/test/support/client-source.mjs` 提供结构化调用记录，再断言全部 `/api/forge-iam/` 前缀 | `packages/forge-iam/test/client-shape.test.mjs:22,59`；邻域观察：`:23` 把 `{timeoutMs:…}` 写成可选项，同样不会因缺超时失败 |
| F9 | P3 | `issue-delivery-contract.test.mjs` 用手写 `known` Set 自证 SKILL 里的工具名存在，未 import 真实注册表 | follow-up：改测试需给 `packages/forge-gitee` 增加公共出口（`GITEE_SNAPSHOT_TOOLS` 等），AGENTS.md 禁止跨包相对路径导入；退化方案是落到 `packages/forge-gitee/test/host-contract.test.mjs` | `packages/forge-enterprise/test/issue-delivery-contract.test.mjs:50-60` |
| F12 | P3 | 锁文件在 `open('wx')` 与写 owner token 之间崩溃会留空锁，`lockOwnerPid('')` 得 `undefined` → 永不回收 → 永久 `KEYCHAIN_LOCK_TIMEOUT` | **已由 #253 架构消解（有残余风险）**：文件锁已不存在，改为 SQLite 行锁；初始化中断由 `credentials.sqlite.init` 标记 fail closed（`src/sqlite-backend.mjs:240-250,290-294`，README:13「初始化中断且完整性无法确认时保留文件并拒绝写入，需人工核查」），不按 age 自动回收 | `test/sqlite-concurrent-init.test.mjs`。L1。残余风险：创建者在建库后、写密钥前崩溃会留下 init 标记，后续写操作在 `lockTimeoutMs` 后返回 `CRED_LOCK_TIMEOUT`，需人工删除标记 |
| F13 | P3 | 退出撤销把 access token 放在 URL query（`GET <revocationEndpoint>?access_token=…`），易落日志 | 不计为缺陷（既有决策 D1 的已知取舍），但按实披露并给出方向：`docs/design/plugins/forge-iam.md` §5.7 写明现状与 RFC 7009 的 POST 建议；`packages/forge-iam/docs/credential-access.md` §4 同步限定。改用 POST 取决于企业端点是否支持，列为待确认 | `packages/forge-iam/src/oidc.mjs:425,429-471` |
| F15 | P3 | `scripts/probe/README.md` 两处对「子 Agent 是否继承视图 `restrict`」自相矛盾 | 本轮修复：统一为「已实测（目标 DSH）：作用域 guard 约束子 Agent、父视图 `restrict` 不继承」+「未跑通仅剩官方行运行时模型面」，证据链为 `scripts/probe/host-probe-plugin.mjs:1139`（步名 `subagent-inherits-parent-guards-not-view-restrictions`，不依赖模型）与 `docs/design/plugins/forge-policy.md:26`（2026-10-24 委派继承实验 32/32 通过、1 blocked）、`:134` | `scripts/probe/README.md`（文档）；`check-docs` ok |
| F16 | P2 | `docs/design/plugins/forge-iam.md:462` 宣称「任一进程登出后其他进程立即阻断」，实际 `resolveToken()` 只读进程内状态，靠远端撤销；撤销 failed/unknown 时不成立 | 本轮修复（文档对齐实现）：§5.7 重写为「本进程即时／跨进程收敛（同步点仅 `hydrate`、`GET /api/forge-iam/view`、观察者 2 秒轮询）／远端撤销有边界／未受信来源不写墓碑／视图不是撤权屏障」；`packages/forge-iam/docs/credential-access.md` §4 同步 | `packages/forge-iam/src/{routes.mjs:470-478,service-token.mjs:33,store.mjs:6,iam-view-observer.mjs}` 为改写依据；设计文档版本 V1.27.2 |
| F17 | P3 | `packages/forge-iam/src/index.mjs:137-164` teardown 无 `try/finally`：任一步抛错则 `disposeProvide` 不执行，且 `tornDown` 已置真不再重试 | follow-up：属生命周期健壮性，需配 `lifecycle.test.mjs` 覆盖「部分 dispose 抛错仍完成其余释放」 | `packages/forge-iam/src/index.mjs:137-164`；§5 第 1 行「F17 无测试」 |

## 5. 41 个文件复核结论

覆盖判据：`覆盖结论` 只写实际读到的测试文件（按 `packages/*/test` 与 `tests/` 中对被测模块的引用核对）；文档类文件不虚报自动化测试。

| # | 文件 | 复核内容 | 覆盖结论 |
|---|---|---|---|
| 1 | `packages/forge-iam/src/index.mjs` | `apply` 装配、`provide`/`inject` 各轴、固定端口双路由、teardown 顺序、`void hydrate()` | 装配由 `callback-port`、`cli-session`、`client-auth-config`、`exclusive`、`lifecycle`、`service.test`、`trust-wiring` 覆盖；**F17 无测试**（follow-up） |
| 2 | `scripts/make-private-bundle.mjs` | 参数与 `--confirm`、仓库外边界、public 预检、discovery 门、`planDigest` | `private-bundle-boundary`、`release-public` 覆盖；**F4 已修并加用例** |
| 3 | `tests/probe-mock-iam-gateway.test.mjs` | 真实 spawn mock IdP：discovery／PKCE／RS256／JWKS／刷新轮换／流式 | 自身即测试级端到端，未发现自证 |
| 4 | `scripts/lib/release-support.mjs` | 路径边界（符号链接解析）、`atomicWrite`、`scanText`/`scanReleaseFiles`、配置键脱敏 | `release-public`、`private-bundle-boundary` 覆盖边界与脱敏；**F1 已修并加用例** |
| 5 | `packages/forge-credentials-keychain/src/backend.mjs` | 密钥 0600/uid、AES-GCM 文档、`withFileLock`、`transaction`、`compareAndSwap` + guard | `backend-contract`、`encrypted-backend`、`file-backend`、`file-backend-races`、`joint-store` 覆盖；**F12 已修并加用例** |
| 6 | `docs/operations/enterprise-uat-2026-11/验收测试清单.md` | U-01…U-10、O-01…O-07、诊断字段、判读与排查顺序 | 文档，无自动化测试；未发现问题（rc.5/rc.3 口径属第 25 条同源缺口） |
| 7 | `tests/discovery.test.mjs` | discovery 9 用例：issuer 匹配、端点不一致、非 2xx、明文开关 | 自身；尾斜杠差异已改为不匹配断言（第 9 条同源） |
| 8 | `packages/forge-credentials-keychain/test/platform-backends.test.mjs` | 平台映射、未映射拒绝、vetted 切换、缺 addon、锁文件与 manifest 一致 | 自身；无缺口 |
| 9 | `scripts/lib/bundle-archive.mjs` | 只认 gzip + ustar、pax、路径归一、重复/超限、硬链与符号链拒绝 | `bundle-verify`、`release-public`、`private-bundle`、`bundle-write` 覆盖；无功能缺口（校验和与结尾零块由调用方全量比对） |
| 10 | `docs/design/plugins/forge-iam.md` | 信任边界 §6、撤销语义 §3、§5.7 跨进程失效、令牌暴露面 | 文档，无自动化测试；**F16 已按实现改写 §5.7** |
| 11 | `packages/forge-iam/test/trust-wiring.test.mjs` | 绑定同实例放行、换实例拒绝、无 trust 拒绝 | 自身；第 1 条同源，已补「方法齐全但未验证」负例 |
| 12 | `packages/forge-iam/src/oidc.mjs` | ID Token 全套校验、discovery 合并、PKCE、撤销三态、`safeStateEqual` | `oidc.test`、`revoke-access-token`、`client-auth-source`、`client-auth-transport`、`oidc-error-redaction` 覆盖行为；**F13 为既有决策 D1**（见 §4） |
| 13 | `packages/forge-iam/src/service-signin.mjs` | attempt/epoch/guard、回调 Origin/state 校验、清理与撤销分支 | 直接仅 `service-state-structure.test`（结构）；行为经 `login`、`client-auth-lifecycle`、`routes.test` 间接覆盖 |
| 14 | `packages/forge-credentials-keychain/test/apply.test.mjs` | 挂载/拒绝矩阵、ephemeral、明文 opt-in、teardown、监听器隔离 | 自身；已补第 22 条安全提示用例 |
| 15 | `.github/workflows/release-bundle.yml` | tag 触发、权限、Action SHA pin、license 门、build + verify 上传 | **无自动化测试**；**F3 缺口**（不校验同 SHA 的 CI 结果，follow-up） |
| 16 | `scripts/dsh-version.mjs` | `report`/`check`/`apply`、canonical 全量比对、engines 下限 | `dsh-version.test`、`init-enterprise-plugin.test`、`host-probe.test` 覆盖；第 25 条已将发行默认宿主纳入 `check` |
| 17 | `scripts/lib/dsh-version.mjs` | canonical spots、engine floor、预发布比较、重写范围 | 同上；第 25 条新增 `checkReleaseDefaults`/`rewriteReleaseDefaults` 并删除白名单 |
| 18 | `packages/forge-credentials-keychain/test/joint-store.test.mjs` | 无联合提交得 `undefined`、scope 映射、非法 scope、服务名 | 自身；第 1 条同源，已补 `verifiedCapabilities` 前置门负例 |
| 19 | `packages/forge-iam/src/routes.mjs` | Connection fail-closed、bridge 403/401、callback Host/Origin、CSRF 头、8 KiB 上限、SSE | `routes.test`、`client-auth-routes`、`callback-port`、`read-paths-matrix`、`gateway-atomic-service` 覆盖；无缺口 |
| 20 | `packages/forge-iam/test/support/mock-oidc.mjs` | 真 RSA-2048、PKCE S256 校验、撤销 GET/POST、control 开关 | 支撑件，被 oidc/refresh/revoke 用例使用；无缺口 |
| 21 | `packages/forge-credentials-keychain/src/joint-store.mjs` | scope 前缀映射、能力门、方法形状 | `joint-store.test` 覆盖；已改为 `verifiedCapabilities(backend).jointCommit` 并补负例 |
| 22 | `packages/forge-enterprise/test/issue-delivery-contract.test.mjs` | SKILL 字节预算、条款形状、工具名存在性、禁止文案、证据章节 | 自身；**F9 缺口**（工具名用手写 Set 自证，follow-up） |
| 23 | `packages/forge-credentials-keychain/src/provider.mjs` | ref/record 编解码强校验、`modifyRecord` 事务、`listRecords` 外部键 | `provider.test`、`joint-store`、`native-keyring`、`file-backend` 覆盖；`source` 语义为第 11 条，已修 |
| 24 | `packages/forge-iam/test/routes.test.mjs` | 45+ 契约用例：callback、CSRF、Connection、凭据、bridge、events、模型失败 | 自身；已复核 bridge 403/401 与帧内不含 `eyJ`，无自证 |
| 25 | `packages/forge-iam/bin/heluo-forge.mjs` | `whoami`/`token`、退出码、bridge 取票、`accessTokenOf` 回退 | `cli-session.test` 覆盖；第 21 条已补目录通道用例，**F6 已加 URL 约束用例** |
| 26 | `scripts/lib/repo-rules.mjs` | REQUIRED 清单、workspace/包约束、workflow SHA、敏感扫描 | `check-repo.test`、`bundle-closure.test` 覆盖；第 18 条已修 |
| 27 | `packages/forge-iam/test/oidc.test.mjs` | PKCE、ID Token、discovery、撤销、`at_hash` 等 28 条用例名 | 自身；用例清单级复核（未逐条读断言），行为覆盖见第 12 行 |
| 28 | `package.json` | `scripts.check` 链、engines、`packageManager` pin、测试入口 | `check-repo.test` 间接覆盖（强制 `scripts.check` 与 engines）；无缺口 |
| 29 | `docs/contracts/iam-client-auth-isolated.md` | `authMode`/secret 约束、grant 隔离、错误表、跨进程限度 | 文档；与 `client-auth-source`/`client-auth-transport` 用例呼应，无缺口 |
| 30 | `docs/design/iam-confidential-isolated.md` | 机密路径证据表、不启用声明、§4 限度 | 文档；§4 已写明「防不了什么」，无缺口 |
| 31 | `packages/forge-iam/test/client-login-window.test.mjs` | 超时、`AbortController`、弹窗回退、`about:blank` 兜底 | 自身；**F7 已修**（改为「全部 sign-in 调用点均带超时」） |
| 32 | `scripts/probe/README.md` | 探针断言表、blocked 项、钥匙串/SSE/mock 网关说明 | 文档（对应 `scripts/probe/*.mjs`）；**F15 已按探针证据统一表述** |
| 33 | `packages/forge-iam/docs/credential-access.md` | 存储格式附录 A、退出码、能力值路径、令牌事实、已知限制 | 文档；**§4 令牌失效表述已随 F16 加限定** |
| 34 | `packages/forge-iam/test/client-clipboard-behavior.test.mjs` | 复制/诊断：白名单投影、失败文案、迟到回执、重复点击 | 自身（真跑面板代码）；无缺口 |
| 35 | `packages/forge-iam/test/client-shape.test.mjs` | 路由面、令牌词法、主题变量、manifest、槽位 | 自身；**F8 缺口**（只枚举 `fetch('…')` 字面量，follow-up） |
| 36 | `scripts/lib/sensitive-patterns.mjs` | `HOST_PATH`/`SECRETS` 正则 | `tests/sensitive-patterns.test.mjs`（本轮新增）；**F2 已修** |
| 37 | `packages/forge-iam/docs/developer-guide.md` | 配置表、Host/HTTP 接口、原子信任、刷新/退出/卸载边界 | 文档；边界披露充分，无缺口 |
| 38 | `docs/teamflow/20261106-r2/RUNBOOK.md` | S0–S8 判据、退出码、NOT RUN 预判、命令台账 | 文档，无自动化测试；无缺口（rc.5/rc.3 口径与第 25 条同源） |
| 39 | `packages/forge-iam/test/client-structure.test.mjs` | §1–§17 锚点唯一性、五类越界基线、`render` 参数、错误文案 | 自身；无缺口 |
| 40 | `packages/forge-iam/src/service.mjs` | 装配、`watch`、`dispose`、`signOut` 编排、`resolveToken` 入口 | `service.test`、`service-races`、`client-auth-service`、`login`、`signout-replacement` 等 23 个文件覆盖；无功能缺口 |
| 41 | `packages/forge-enterprise/skills/issue-delivery/SKILL.md` | 适用/不适用、依赖短路、证据边界、版本判定 | `issue-delivery-contract.test` 覆盖字节预算、条款形状与引用；**F9 为工具名真值缺口**（follow-up） |

## 6. 验证命令与结果（本分支本地实测）

以下命令均在本工作树（`feature-issue-254`，基线 `5bfcf2a`）实际执行，输出为实测末行。`pnpm check` 的等价链路（`package.json` 的 `scripts.check`）逐条跑通，未通过 pnpm 包装调用。

| 顺序 | 命令 | 结果 |
|---|---|---|
| 1 | `node scripts/link-workspace.mjs` | ok（workspace 软链就位，包间 import 可解析） |
| 2 | `node scripts/check-docs.mjs` | `160 files, 1070 tables, 1247 local links, 175 fragments, 49 controlled documents` → ok |
| 3 | `node scripts/check-repo.mjs` | `24 required entries, 9 packages, 2 services, 4 workflows, 1021 tracked files` → ok |
| 4 | `node scripts/check-skills.mjs` | `2 files` → ok |
| 5 | `node scripts/check-bundle-tarballs.mjs` | `7 packed, 341 files` → ok |
| 6 | `node scripts/dsh-version.mjs check` | 退出 0（含第 25 条的发行默宿主字面量校验；提示 7 个包 `engines.dsh` 仍为 rc.2 属既有保留） |
| 7 | `node --test`（Node 24.21.0，`.node-version`） | `tests 3790 / pass 3787 / fail 0 / skipped 3`（69.4 s）；基线 `5bfcf2a` 同环境为 `3450 / 3445 / 0 / 5`，本分支净增 340 条；3 条 skipped 为既有平台跳过 |
| 8 | `git diff --check` | 无输出（无空白错误） |

分模块实测（用于定位，不替代第 7 行）：

| 模块 | 命令 | 结果 |
|---|---|---|
| 凭据存储 | `cd packages/forge-credentials-keychain && node --test "test/*.test.mjs"` | `223 / 223 pass / 0 fail`（#253 的 SQLite 后端用例组） |
| IAM 插件 | `cd packages/forge-iam && node --test "test/*.test.mjs"` | `1557 / 1557 pass / 0 fail` |
| 私有打包 | `node --test tests/private-bundle.test.mjs tests/private-bundle-boundary.test.mjs tests/discovery.test.mjs tests/release-delivery.test.mjs` | `88 / 88`（24 + 26 + 17 + 21） |
| discovery | `node --test tests/discovery.test.mjs` | `17 / 17`（含双向尾斜杠严格比对与不回显断言） |
| 发布交付 | `node --test tests/release-delivery.test.mjs` | `21 / 21`（含 R4 的清理边界三例与 `OUTPUT_EXISTS` 并发用例） |
| 发布扫描回归 | `node --test tests/release-scan-clean.test.mjs tests/release-public.test.mjs tests/bundle-build.test.mjs tests/bundle-closure.test.mjs` | `74 / 74`（R1 的仓级护栏 + 缺文件与内容扫描用例） |
| 敏感模式 | `node --test tests/sensitive-patterns.test.mjs tests/check-repo.test.mjs` | `21 / 21` |
| CLI 会话 | `node --test packages/forge-iam/test/cli-session.test.mjs` | `11 / 11`（合并后为主线版：Host 白名单、`redirect: error`、`HELUO_FORGE_STORE_DIRECTORY` 解析） |
| 安装器 | `node --test tests/init-enterprise-plugin.test.mjs` | `30 / 30`（R5 证据链三态 + R6 无证据降级用例） |

**负向控制（变异）**：仅让正向用例通过不足以证明判据有效，以下变异均实测使对应用例失败——`TEXT_EXTENSIONS` 还原 `/u`；tar PAX 头去掉 `'x'`；mode 写死 `0644`；禁用 `TOOLS_INCOMPLETE`；禁用源码/工具两处敏感扫描；`DEFAULT_HOST_VERSION` 改回 rc.5；注释掉 `plugin add` 前的 `--profile desktop` 探测；client 删掉一条 `timeoutMs`；把 `bin/heluo-forge.mjs`、`backend.mjs`、旧 `src/*.mjs` 换回 `git show HEAD:` 版本（旧代码上新用例分别 6/2/6 条失败，还原后用 `cmp` 校验字节一致）。

**门禁对齐**：本轮收紧的 `HOST_PATH` 先在 `check-repo` 上命中了本仓库自身——`packages/forge-iam/test/cli-session.test.mjs` 的两条「URL 内嵌口令」夹具与 `scripts/lib/sensitive-patterns.mjs` 的文档注释。前者的临时处理是加扫描豁免标记，评审 R1 指出这正是门禁可被豁免绕过的地方，最终处理改为：夹具用 `credentialedUrl()` 运行时拼接，**豁免标记全部删除**（该文件不再出现 `security-scan: allow`），注释改为不含字面示例的表述；规则本身未放宽，`check-repo` 与发布扫描随后 ok。详见 §8.1。

**测试工具链版本注记**：全量用 `.node-version` 指定的 Node 24.21.0 执行。本机默认（Homebrew）Node 24.13.0 下 `node:sqlite` 仍打印 `ExperimentalWarning: SQLite is an experimental feature`，该警告进入 CLI 子进程 stderr，使 `packages/forge-iam/test/bridge-real-provider.test.mjs` 的 4 个「stderr 必须为空」用例失败；改用 24.21.0 后 14/14 通过，且 `f8f7a29` 的 CI 日志（同为 24.21.0）不含该警告。因此这 4 条是工具链版本差异，不是代码缺陷；也说明本仓库的验证必须在 `.node-version` 指定的补丁版本下进行。

## 7. 未验证项与风险

**L2（托管 CI 跨平台实跑，不等于企业实机）**

PR #256 的 `check` 工作流在 `main` 之外的三个 Windows 运行器（`win32-x64`、`win32-arm64`、`windows-2025`）与两个 macOS 运行器（`macos-15`、`macos-15-intel`）上通过，运行的是 `native keychain`、`document backend`、`iam callback`、`sensitive scan` 四项作业。它覆盖了第 21 条与 F6 的 CLI 启动路径（含 `--import` 预载与 URL 校验分支），但运行的是 GitHub 托管 runner，既不是企业 Windows 镜像，也没有真实 keyring — 因此只证明「代码在这些平台上按用例预期执行」，不构成第 2 节列的实机结论。

首轮 CI 在该维度上确实红过：`packages/forge-iam/test/cli-session.test.mjs` 把裸绝对路径传给 `node --import`，Windows 的默认 ESM 加载器拒绝（`ERR_UNSUPPORTED_ESM_URL_SCHEME`，`received protocol 'c:'`）。修法是让 `fetchRecorder()` 返回 `pathToFileURL(module).href`，三处调用点统一使用；这与被测代码无关，属用例自身的可移植性缺陷。

**NOT RUN（需真实环境，本轮无证据）**

1. 企业 IAM／OIDC 提供方与 AI 网关的真实联调：discovery、授权码、刷新、撤销全部端到端流程。
2. Windows 实机：第 4 条 npm shim 解析、第 21 条「Host 用自定义目录、CLI 只认该目录」的端到端行为、第 22 条 `apply` 内的 `ctx.logger.warn` 接线（win32 分支才生效）。
3. 麒麟／Linux 目标机：凭据后端按 fail closed 关闭后的 CLI 与插件实际表现，以及启动器脚本在目标 shell 下的行为。
4. DSH Desktop 真机与真实 Windows 启动器：第 6 条的 Desktop profile 探测、第 26 条的 `dsh web` 优先步骤。
5. `scripts/probe/run-bundle-install-rehearsal.mjs` 需要真实 dsh + npm 环境；全量用例中该脚本为外部依赖路径，本轮在并行负载下曾失败一次、单跑与后续全量均通过，判定为环境抖动，仍属未取证项。

**L3（夹具/合成构造，只证明分支逻辑）**

6. 第 5、16、24 条：伪造的 npm shim、注入失败的 executor、构造的冲突制品；不代表真实 pnpm/registry/磁盘故障。
7. F1 的私钥块检测：以合成 `.pem` 文本验证，未用真实密钥材料。

**已知局限（有意取舍，已在正文披露）**

8. 锁回收：`O_EXCL`/`rename` 在 NFS/SMB 等网络文件系统上的语义未验证；回收者自身在守卫段内崩溃会留下 `.reclaim`，该文档此后持续超时（fail closed，需人工清理）；空锁有 2 s 宽限期，靠「拿锁后同步写 token」把窗口压到微秒级。
9. 第 2 条的同步提交段对超大凭据文档会短暂阻塞事件循环（凭据文档规模下可接受，已在代码注释说明）。
10. 第 21 条的设计边界：CLI 无法自动发现 Host 的 `storeDirectory`（bridge 只有取票端点），必须由部署方显式设置环境变量；未设置时行为与过去一致（读默认目录）。该限制已写入 `packages/forge-iam/docs/credential-access.md`。
11. 账号页「非系统凭据库」文案：只核验了 provider 报告的 `source` 取值，未在真实 GUI 页面人工确认提示出现。

**合并（#253）带来的新增风险**

16. `credentials.sqlite.init` 标记：初始化在建库之后、写密钥之前中断会留下标记，之后所有写操作在 `lockTimeoutMs` 后返回 `CRED_LOCK_TIMEOUT`，需人工删除标记；这是 #253 明确的 fail closed 取舍，不按 age 自动回收，已写入 `packages/forge-credentials-keychain/README.md`。
17. 仓库边界检查的失败语义：`assertDirectoryOutsideRepository` 在 `realpathSync` 不可用（如父目录权限受限）时抛错而非放行，属 fail closed，但错误码仍是 `KEYCHAIN_FILE_INSIDE_REPOSITORY`，与「确实位于仓库内」共用同一码，语义略偏。
18. Windows ACL 与目录持久性：主线 README 仍标注待实证，本轮未在 Windows 实机验证。
19. 合并树的托管 CI 未跑：§6 的数字全部来自本机 Node 24.21.0；跨平台结论仍针对主线提交 `f8f7a29`。


**follow-up 待裁决项**

12. F3：Release 工作流是否以「同 SHA CI 绿」为发版前置，属发布策略，需负责人裁决。
13. F8、F9、F17：分别为客户端调用面断言升级、SKILL 工具名真实注册表校验、teardown 的 `try/finally` 与生命周期用例，均记录在 §4，未纳入本次改动。
14. F13：`GET` 撤销改为 RFC 7009 的 `POST` 取决于企业撤销端点是否支持，待提供方确认后实施。
15. `.github/workflows/release-bundle.yml` 仍无自动化测试，本次未补。


## 8. PR #256 评审意见（5872697951）处置

bot 评审共 6 条代码行级意见（首轮 5 条，`59a4184` 后复查新增 1 条），均针对本节改动前的本分支代码，逐条核实后全部成立并修复。口径同 §3：改动位置给到文件与函数，判据给正向用例与负向（变异）证据。

| 条号 | 意见要点 | 结论 | 改动位置（文件:行） | 判据与证据 |
|---|---|---|---|---|
| R1 | 发布扫描（`scanReleaseFiles`）会拒绝本仓库自身的测试夹具——`packages/forge-iam/test/cli-session.test.mjs` 里的「用户名+口令+主机」字面量靠注释里的豁免标记放行，等于用豁免绕过发布门禁 | 属实并已修复 | `packages/forge-iam/test/cli-session.test.mjs:30` 新增 `credentialedUrl(user, password, host)` 运行时拼接助手，`:321`、`:368` 两处夹具改用它；**删除两处 `// security-scan: allow` 豁免**。发布扫描与 `scripts/lib/release-support.mjs` 一行未改（不放宽规则） | 该文件 `14 / 14`；负向：把 `git show HEAD:` 的旧内容喂 `scanReleaseFiles(..., { publicOnly: false })` → 2 条 `possible URL with embedded password`（行 311、358），新内容 → `[]`。L1 |
| R2 | 文件后端持有锁后不做所有权复核：锁被回收者挪走并重建时，原持有者仍往已被 unlink 的 inode 写、并 `rename` 覆盖他人的文档 | **已由 #253 架构消解** | 文件锁整体替换为 SQLite 行锁：`packages/forge-credentials-keychain/src/sqlite-backend.mjs:135-139 assertToken` 在 `BEGIN EXCLUSIVE` 事务内校验 pid 与 token digest，`commit()` 于动作前（`:199`）与 COMMIT 前（`:203`）各校验一次，释放路径（`:346`）同样校验，失败即 `CRED_LOCK_LOST` | `test/sqlite-read-contention.test.mjs` 的锁接管用例组。L1。原 `test/file-backend-races.test.mjs` 已删除 |
| R3 | 提交路径用单次 `writeSync`，短写会先 `fsync` 再 `rename`，把完整凭据文档替换成被截断的文档并报告成功 | **已由 #253 架构消解** | 凭据写入是 SQLite 事务（整行提交，不存在「写文档 → fsync → rename」路径）；唯一裸文件写是初始化标记 token 的 `writeFileSync(fd, token)`（`src/sqlite-backend.mjs:255`，Node 内部保证写满） | `test/sqlite-concurrent-init.test.mjs`、`test/encrypted-adapter.test.mjs`。L1。原 `test/file-backend-writes.test.mjs` 已删除（不为通过测试恢复旧文件后端） |
| R4 | 发布失败清理会删除「本次运行并未创建」的路径：`finally` 无条件 `rmSync(archive)`，并用 `rmSync(output, { recursive })` 删掉并发运行或用户已经发布出来的目录 | 属实并已修复 | `scripts/release-delivery.mjs:153-161 readTextOf()`、`:163-185 removeOwnArchive()`（**按内容判定归属**：只删内容仍是本运行占位标记的占位文件，或内容摘要等于本运行刚打出的 zip；其余保留并告警）、`:407` 告警出口（默认写 stderr，测试可注入）、`:410-412` 本次运行唯一占位标记、`:413-429` 发布前用 `openSync(archive,'wx',0o600)` 独占**预留** zip 路径（`EEXIST` → `OUTPUT_EXISTS`）并写入来历说明、`:474-495` 替换前按占位内容复核（内容不符 → `OUTPUT_EXISTS`，不覆盖）、目录 `rename` 冲突且 output 已存在 → `OUTPUT_EXISTS` 且不删任何东西、`:505-517` `finally` 只清理本次创建的 zip，**不再删除 output 目录**；未新增错误码 | `tests/release-delivery.test.mjs:433`（别的进程写出的 zip 不被删，且恰好 1 条告警）、`:457`（并发运行已发布的目录原样保留，含 `INSTALL.md` 内容不变）、`:479`（本次自己的产物仍清干净）；`17 / 17`，三个假 zip 用例 `{ skip: win32 }`（假 zip 为 POSIX shell，与仓库既有先例一致）。变异：`git show HEAD:scripts/release-delivery.mjs` 副本 → `15 pass / 2 fail`（外部 zip 被删；裸 `ENOTEMPTY` 并随后删掉先到者目录）。L1 |
| R5 | 「已安装的是不是这份交付」按 profile 记录里的 `file:` 路径**当前**内容比对：管理员把新交付物放到同一路径时，旧包仍装在 `node_modules` 里，比对的是新文件而不是已安装内容，会把旧安装误判为新交付 | 属实并已修复 | `scripts/init-enterprise-plugin.mjs:553 INSTALL_RECORD_FILE`（证据写到 `profiles/<p>/.heluo-enterprise-install.json`，0600）、`:555 installedPackageDir()`、`:562 installedTreeSha256()`（排序后按「类型 + 相对路径 + 字节/链接目标」摘要，符号链接不跟随）、`:587 readInstallRecord()`、`:607 writeInstallRecord()`、`:647 artifactIdentityOf()` 改为证据链、`:1029-1034` 安装成功后写证据（写不了降级为告警）；删除 `FILE_SPEC` 路径比对 | `tests/init-enterprise-plugin.test.mjs:566`（主场景：路径上的 tgz 被换成新交付，已装内容未变 → 不报 `confirmed`）、`:602`（无证据 → `unconfirmed` 且不声称逐字节）、`:533/:629/:660/:505`；`29 / 29`。变异（插回旧「按 `file:` 路径当前内容哈希」）→ 4 条红。L1 |
| R6 | 全新安装恒报 `artifact.identity: 'confirmed'`：即使 `writeInstallRecord()` 返回 `null`（读不到已安装目录或写不进去），JSON 结论仍声称已核对，与同一次运行打出的「未能留存制品证据」告警自相矛盾 | 属实并已修复 | `scripts/init-enterprise-plugin.mjs:1029-1046` 结论改由证据写没写成决定：`record === null` → `{ identity: 'unconfirmed', detail: '…未能留存安装时刻的制品证据…' }`，写成 → `{ identity: 'confirmed', detail: '安装时刻记录与已安装内容一致（tgz 摘要 …）' }`；`result.artifact` 同时带出 `identity` 与 `detail`（与 `artifactIdentityOf()` 的返回形状一致） | `tests/init-enterprise-plugin.test.mjs` 新增「装完但留不下制品证据」用例：用目录占住 `profiles/<p>/.heluo-enterprise-install.json` 让写入必然失败 → 断言 `artifact.identity === 'unconfirmed'`、`detail` 说明原因、有告警、且回显里没有「制品证据：已记录」；`30 / 30`。变异（把该分支改回 `'confirmed'`）→ 该用例红。L1 |

### 8.1 R 项带来的一处门禁能力补强

R1 的根因不只是夹具写法：发布扫描此前**认可代码行上的豁免标记**，而源码归档与工具归档都把它当作安全门禁，于是「门禁命中 → 加一行豁免」成了看似合法的主流做法。本轮处理方向相反——夹具改为运行时拼接，扫描器不放宽也不新增豁免；同时新增 `tests/release-scan-clean.test.mjs`（`scripts/build-public-release.mjs:146-168` 导出 `createReleaseSource()` 供测试调用）：它直接对 `git archive HEAD` 产出的源码归档与工具归档跑发布扫描，断言两者均为零命中。这条用例在修复提交前**必然是红的**（扫描的是已提交树），因此它同时是「提交后回归」与「不许再加豁免」的护栏；判据本身的牙齿由变异证明：向副本 `scripts/build-enterprise-bundle.mjs` 注入一行带内嵌口令的 URL 字面量后两条用例同时红。

### 8.2 R4、R5 的取舍与自证边界

- **R4 只预留 zip，不预留目录**：目录无法跨平台原子预留（POSIX 允许 `rename` 覆盖空目录，Windows 直接失败），而 zip 的独占创建两个平台都是原子的。并发运行因此在第一个动作上就被串行化，目录侧只在发布 `rename` 时显式报 `OUTPUT_EXISTS` 兜底——真正持有字节的产物是预留的那个。
- **R4 强杀残留**：进程在预留与发布之间被强杀，会在最终 zip 路径留下一个写明来历的文本占位文件，下次运行报 `OUTPUT_EXISTS` 需人工删除。这是「不误删别人的产物」的必然代价，已在文件头注释与告警文案写明。
- **R4 的归属判定为什么不是 inode**：首版用 `dev+ino` 判定「这还是我创建的那个文件吗」，在本机 macOS 通过，但在托管 CI 的 `ubuntu-x64` 上失败——Linux 与容器文件系统在删除后立刻复用 inode，模拟「别人换掉 zip」的步骤拿到的 ino 与预留时相同，于是自己的判断被绕过、真的删掉了别人的文件。改为**内容判定**后同一用例在 `node:22-alpine`（apt 装 `zip`/`git`）容器里 17/17 通过；本机 macOS 同样 17/17。这条 CI 失败恰好验证了评审意见的严重性，也说明「用一个可复用的标识证明归属」是不成立的思路。
- **R5 的证据仍是自证**：证据文件由安装脚本自己写，只证明「装进去的字节与本次交付一致」，不证明来源；由宿主 CLI 或旧版脚本安装的 profile 没有证据，恒为 `unconfirmed` 并提示先 remove 再重装。`installedTreeSha256()` 在 pnpm 符号链接布局下的真实形态未在真机验证（本地夹具为真实目录树）。

## 9. 与 origin/main（#253）的合并边界

`origin/main` 在台账首次成稿后前进 12 个提交（238 文件，+18227 / −6974），其中 PR #253「完善凭据存储、IAM 续期与企业打包」把凭据后端从文件锁 + 原子文档整体替换为 SQLite 引擎，PR #257／#261／#265／#271 同时占用了原计划的 PLAN-017、017A、018、019 编号。合并提交前，本分支与主线的边界按下列口径固定。

| 边界 | 处置 | 依据 |
|---|---|---|
| 桥地址与重定向（评审 4550143463） | 取主线：`packages/forge-iam/bin/heluo-forge.mjs:60` 只接受 `127.0.0.1` 与 `[::1]`，`:73` `redirect: 'error'`；本分支的「任意 HTTPS + 不安全 HTTP 逃生口」整体放弃，测试与文档同步 | 「凭据相关以 #253 为准」，放宽会重新引入 SSRF 面 |
| CLI 凭据目录（第 21 条） | 取主线 `HELUO_FORGE_STORE_DIRECTORY` + `openCredentialReader()`；放弃自建 `HELUO_FORGE_CREDENTIALS_DIRECTORY`、`IAM_CREDENTIALS_DIRECTORY_UNAVAILABLE`、`IAM_CREDENTIALS_CONFIG_CONFLICT` | 主线已实现同一目标，且目录边界检查更严（`src/index.mjs:33-48`） |
| 发布工具清单（评审 4550143490） | 在主线 6 个脚本清单上保留缺文件检查（`TOOLS_INCOMPLETE`）；新增 `RELEASE_IAM_FILES` 承接主线的 `IAM_VALIDATOR_MODULES` 闭包；源码归档按 `publicOnly:false` 扫描、工具归档解析后扫描，两处均在写盘前 | 固定清单必须跟着主线的工具集走，否则缺件检查会误报或失效 |
| 旧文件后端测试（评审 4550143505） | 删除 `test/atomic-document.test.mjs`、`test/file-backend-races.test.mjs`、`test/file-backend-writes.test.mjs` 与 R2/R3 的针对性用例；R2、R3 判定改为「已由 #253 架构消解」，不为通过测试恢复旧后端 | 主线 `backend.mjs` 不再导出 `createFileBackend`／`writeAllSync` |
| 配置路径检查 | 放弃本分支的 `CONFIG_INSIDE_REPO`；仅保留产物侧 `OUTPUT_INSIDE_REPO` | 主线明确把仓库内被 git 忽略的 `.env` 作为推荐工作流，且有两个 CLI 必须接受它的断言（`tests/release-delivery.test.mjs:150-190`） |
| discovery 结果形状 | 取并集 `{ checked, matched, revocationEndpoint }`；保留 `DISCOVERY_ISSUER_REQUIRED` 与 issuer 逐字符比对（严格 `!==`） | 主线补了撤销/登出/userinfo 端点校验，我们的信任锚与脱敏证据（`matched`）不冲突 |
| IAM 校验器一致性 | 保留主线新增的 `assertIamValidatorMatches`；边界测试夹具改为打包真实 IAM 模块字节，避免与工具链漂移 | 假校验器夹具会让 10 条边界用例误红 |

**保留在主线之上的能力**：第 7 条的 Gitee host／cliPath／scopes／回调路径约束与其真实校验器用例；第 8 条的 issuer 前置守卫；第 9 条的双向尾斜杠反向用例；第 10 条的 `matched` 脱敏字段与「失败消息不回显端点」断言；第 14 条的 `realpathOfNearestExisting` 路径分量判定；第 15 条的制品闭包校验（`assertArtifactClosure`、`PUBLIC_INCOMPLETE`、写入后 `ARTIFACT_VERIFY_FAILED`）；F4 的 `discoveryState` 三态；R1 的运行时拼接夹具（发布扫描不放宽、无豁免）；R4 的内容判定式清理；R5／R6 的安装时刻证据链与「无证据即降级」。

**编号与文档口径**：本台账由 CORP-DSH-PLAN-018 改号 **CORP-DSH-PLAN-020**（主线已占用 018），文档清单版本升至 V1.82.0；`docs/design/plugins/forge-iam.md` 版本取主线 V3.0.0 后升 **V3.0.1**，正文保留本分支 §5.7 的「跨进程失效与撤销边界」五条；`packages/forge-iam/docs/credential-access.md` 与 `local-mock-testing.md` 取主线（SQLite 存储、`HELUO_FORGE_STORE_DIRECTORY`、loopback 桥描述更新）。

**合并后的验证**：见 §6（`node --test` 3790 / 3787 / 0 / 3，检查器全 ok）。本节只给本地离线证据；合并树尚未推送，跨平台托管 CI 的结论仍针对主线提交 `f8f7a29`，不构成对合并树的验收。
