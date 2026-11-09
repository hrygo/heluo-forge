# 企业包原生 addon 缺失修复实施计划

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-016 |
| 文档名称 | 企业包原生 addon 缺失修复实施计划 |
| 版本 | V0.2.1 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-09 |
| 门禁 | 构建期前置与产物期字节校验已实现并本机实测；离线结构检查保持离线；目标机实机取证仍按 #182 另行关闭 |
| 文档层级 | L2 实施计划；发布资源边界依据需求基线，构建与核验契约回写对应工程约定 |

> 编制依据：[issue #216](https://github.com/hrygo/heluo-forge/issues/216) 的报告，以及 2026-11-09 在 `origin/main` = `6b092b0` 上用 `git archive` 纯净快照做的独立复现（Node 24.21.0、npm 11.19.0、macOS 宿主）。复现内容与报告结论逐条一致，另有两点补充：同一提交的产物在"已暂存 / 未暂存"两种本机状态下分别是 136 文件与 128 文件；现有 CI 矩阵把"缺 addon 就拒绝挂载"当作正确负例，因此无法发现交付物缺这一层。
>
> 关联文档：[需求与场景基线](<../requirements/requirements-baseline.md>)、[总体架构](<../architecture/platform-architecture.md>)、[逐模块设计索引](<../design/README.md>)、[多端凭据存储实现与验收方案](<2026-11-03-credential-multiplatform.md>)、[企业组合包详细设计](<../design/plugins/forge-enterprise.md>)、[凭据包说明](<../../packages/forge-credentials-keychain/README.md>)、[试点运行手册](<../teamflow/20261106-r2/RUNBOOK.md>)、[工程开发与发布约定](<../engineering/development-conventions.md>)、[文档清单](<../DOCUMENT-REGISTER.md>)。

## 1. 缺陷定义与判定

**缺陷**：`heluo-forge-enterprise-0.1.0.tgz` 的 `packages/forge-credentials-keychain/vendor/` 只有清单与说明，四个平台的 `keyring.node` 全部缺失；构建与两道核验门禁全绿，企业 profile 在挂载期 fail closed，整个组合无法启动。

**判定**：交付阻断（P1）。企业组合已禁用官方 `credentials` 行，本包是唯一凭据提供方，缺 addon 等于 Windows x64/arm64 与 Linux x64/arm64 四个交付目标全部不可启动；macOS 走应用层加密文档后端，不受影响——受影响面恰好等于交付目标面。

**性质**：不是配置错误，也不是运行时兼容问题，而是**发布资源身份链断裂**。二进制按既定决定不入 Git，于是"产物里必须存在哪些文件"在构建与核验两侧都没有任何表达，只剩计划文档里一句前置条件。[多端凭据存储实现与验收方案](<2026-11-03-credential-multiplatform.md>) 已写明"发布打包前必须先暂存并跑 `--check`"，缺的是执行点而非决策。

## 2. 复现证据

纯净快照构建（`git archive`，排除工作区本地状态）：

| 检查项 | 观测结果 |
|---|---|
| 构建 | exit 0，128 文件，解包总字节 1767809，tarball 550354 字节 |
| 快照 `vendor/` | 仅 `CHECKSUMS.json` 与 `README.md` |
| 产物 `vendor/` | 同样两文件，`keyring.node` 计数 0 |
| `verify-enterprise-bundle` | `bundle: ok`，exit 0 |
| `check-bundle-tarballs` | `bundles: ok`，exit 0 |
| 运行时后端 | `KeychainBackendError` / `KEYCHAIN_UNAVAILABLE`，缺失信息指名 `win32-x64-msvc` |
| 对照：工作区（已暂存） | 136 文件，解包总字节 12030591，tarball 4794843 字节，`vendor/` 下 10 个条目 |

结论：**同一 commit 的产物身份取决于一个被 gitignore 的目录当时在不在**。因此"两次构建 sha256 相同"不能证明产物正确，只能是"两次都缺"的稳定复现。

## 3. 根因分层

| 层 | 位置 | 现状 | 缺口 |
|---|---|---|---|
| 资源入库 | [.gitignore](../../.gitignore) 第 126 行 | `vendor/*/` 整体忽略，符合"二进制不入库"决定 | 无（决定正确），但缺少对其后果的兜底 |
| 构建 | [build-enterprise-bundle.mjs](../../scripts/build-enterprise-bundle.mjs) | 按各包 `manifest.files` 复制资源，`vendor` 在 `files` 中 | 没有"必需资源"概念，无前置断言 |
| 结构审计 | [bundle-rules.mjs](../../scripts/lib/bundle-rules.mjs) | `auditTarball` 只校验声明条目存在，目录形态由任一文件满足 | 不读取 `CHECKSUMS.json` 的条目清单，不校验 addon |
| 产物核验 | [verify-enterprise-bundle.mjs](../../scripts/verify-enterprise-bundle.mjs) | 只做结构规则与 manifest diff | manifest 由同一坏产物生成，自洽，永不红 |
| 运行时 | [native-keyring.mjs](../../packages/forge-credentials-keychain/src/native-keyring.mjs) | `store()` 在挂载期加载 addon，缺失即抛错 | 唯一报警器，但位于客户机器上 |

**三处绿灯互不相关的原因**：本机 `vendor/*/` 已暂存（日常构建是 136 文件的正确产物）；macOS 在解析层就分到加密文档后端，不触碰 addon；CI 的 `device-matrix` 在无 addon 的 runner 上把"缺 addon 就 `KEYCHAIN_UNAVAILABLE`"作为正确行为断言通过。

## 4. 修复目标

| 编号 | 目标 | 判据 |
|---|---|---|
| R1 | 缺 addon 时不可能产出制品 | 干净检出执行构建即非零退出，且不留下 tgz |
| R2 | 已产出制品可被独立证伪 | 对含缺失 addon 的归档执行核验即非零退出，只需归档字节 |
| R3 | 判据本身会被违反 | 每条新规则配套至少一条负例，并用变异证明它会失败 |
| R4 | 离线检查保持离线 | `node --run check` 不联网、不安装依赖、不在干净检出上必红 |
| R5 | 文档与门禁同源 | 运行手册、设计索引与包说明不再宣称"已随包分发" |

**单一真源**：`vendor/CHECKSUMS.json`。它是"应当存在什么"的既有记录，不新增第二份必需资源清单，避免再次漂移。

## 5. 实施步骤

### 5.1 构建期前置（对应 R1）

在 [build-enterprise-bundle.mjs](../../scripts/build-enterprise-bundle.mjs) 的打包容忍度之前加一道发布前置：

- 新增 [scripts/lib/native-resources.mjs](../../scripts/lib/native-resources.mjs)：`parseNativeChecksums` 拒绝空记录、含 `.`/`..` 的路径、非小写 sha256 与非正字节数；记录同时包含各 addon 与许可证的摘要和长度。`auditNativeRecords` 返回结构化结论，`describeNativeFindings` 只负责分组措辞，构建、核验与测试共用同一份判定。
- `auditStagedNativeResources({ dir, label, releaseFiles })` 对成员目录求值：先要求完整 `vendor/` 在发布文件集内，再逐条校验 addon 与 `LICENSE.third-party.md` 的字节数和 sha256，并拒绝未记录的 `.node` 文件；凭据包缺少记录或整个目录时也拒绝。
- `releaseFiles` 把「记录必须随包」变成构建期判据：只校验磁盘会让「记录在仓库、不在产物」重新成为盲区——产物侧只有拿到记录才有东西可判。
- 前置位置：`visit()` 进入即校验；`npm pack` 后再次读取归档，将实际记录及字节与暂存记录比对，排除 npm 忽略文件造成的遗漏。任一阶段失败均不产制品，目标目录不会被创建。
- 失败消息给成员名、triple 与具体问题；暂存能修复的缺失或字节不符附 `node scripts/fetch-native-keyring.mjs` 提示。
- `buildBundle` 新增 `requireNativeResources`（默认 `true`）；发布路径没有环境变量或命令行逃生。工作区由可选的 `--root <dir>` 选择，用于对 fixture 树跑同一个入口——它换的是树，不是判据。
- [check-bundle-tarballs.mjs](../../scripts/check-bundle-tarballs.mjs) 以结构化模式调用（`requireNativeResources: false`），保持现有"离线、不要求原生产物"的定位，并由产物侧判据兜住。

### 5.2 产物期字节校验（对应 R2）

在 [verify-enterprise-bundle.mjs](../../scripts/verify-enterprise-bundle.mjs) 的 `inspectBundle` 内新增 `auditPackagedNativeResources({ label, content, read })` 调用：

- 扫描归档内每个以 `vendor/CHECKSUMS.json` 结尾的条目（含嵌套成员），用该条目的 `content` 解析清单，再通过 `read` 从同目录取 `vendor/<relative>`；每个包的字节差异汇总为一条错误。凭据包自身即使整个 `vendor/` 缺失也必须报错。
- 记录损坏（解析失败）折成错误行而不是抛出：`inspectBundle` 的不变式是「只返回错误行」，据此 CLI 才给出 `exit 1` 的产物判决，而不是 `exit 2` 的用法错误。
- CLI 新增 `--json`：一次输出 `{ok, tarball, files, bytes, sha256, entry, members, toolchain, errors}`，退出码仍是 `0`/`1`/`2`；发布脚本与证据归档按 JSON 分支，不再抓文本。
- 复用归档里已有的 `entry.content`，不引入解压落盘。
- 旧归档缺少 addon，或其记录缺少许可证摘要与字节数时，核验失败；须按锁文件重新暂存并构建。

### 5.3 反例与变异（对应 R3、R4）

新增 `tests/bundle-native.test.mjs`，夹具用两包工作区（成员 + 伞包）与可辨识的假字节，不把真实 addon 带进测试树；判据只比哈希与字节数，不加载 addon（对象头与架构属于暂存脚本的职责）：

| 用例 | 输入 | 期望 |
|---|---|---|
| 正例 | 四个 triple 假 addon + 对应清单 | 构建成功，产物含 4 个 `keyring.node`，产物核验通过 |
| 缺一 | 去掉一个 triple | 构建非零退出，消息含该 triple，且无 tgz 残留 |
| 篡改 | 改一字节 | 构建失败（staging 校验）；构造出的归档核验失败（产物校验） |
| 清单漂移 | `CHECKSUMS.json` 记录与实际不符 | 两侧均失败，消息区分"记录不符"与"文件缺失" |
| 记录 ↔ 锁文件 | 仓库提交的 `CHECKSUMS.json` 与 `scripts/native-keyring.json` | 无需 addon 字节即可判定：triple 集合、`source`、`integrity`、`version`、`license` 全等；任一侧多/少一个 triple 都红 |
| 映射 ↔ 产物 | 四组 platform-arch 经 `nativeTargetFor` 反推 | 产物中确实存在该 triple 的 `vendor/<triple>/keyring.node` |
| CLI 机器可读 | `verify:bundle --json` | 通过/失败都给可解析 JSON，退出码与文本界面一致 |
| CI 真实存取 | `native-keychain` 作业（win32/linux × x64/arm64 真机 runner） | 暂存 → 构建真实产物 → 离线安装 → 探针写/读/改/删/跨进程；`ok:true` 才算过（Linux 需 gnome-keyring 与 session bus） |
| 目录空壳 | `vendor/` 只有清单与说明 | 构建失败；归档核验失败 |

变异记录（实施完成时写入手工验证记录，不写进文档流水）：注释掉 5.1 的断言后"缺一"用例必须红；注释掉 5.2 的比对后"篡改"用例必须红。

### 5.4 附带修正

- [fetch-native-keyring.mjs](../../scripts/fetch-native-keyring.mjs) 的 `verifyStagedLayout` 目前只比 `version` 与 `license`，不与锁文件比 `integrity` 与 `source`，导致 `CHECKSUMS.json` 的 integrity 漂移时 `--check` 仍绿；补齐交叉比较并加负例。
- 同文件头注释写 `native/<triple>/`，实际目录是 `vendor/<triple>/`；改正注释。
- 关联计划"三个目标全部就位"与清单的四组合不一致；按四组合表述。

### 5.5 文档同步（对应 R5）

- [试点运行手册](<../teamflow/20261106-r2/RUNBOOK.md>) S2 增补：暂存步骤与 `--check`、产物 `vendor/` 期望 10 个条目、`verify:bundle` 期望输出；另说明试点机需 `allowUnvettedPlatformAdapter: true` 覆盖层（默认仍拒绝），Windows 另需 Visual C++ 2015-2022 运行库。
- [逐模块设计索引](<../design/README.md>) 第 59 行与[凭据包说明](../../packages/forge-credentials-keychain/README.md) 的状态句：把"已随包分发"改为"发布前必须暂存；构建门禁对缺失硬失败"，并注明证据成立的前提。
- 本文件在[文档清单](<../DOCUMENT-REGISTER.md>)登记；相关条目版本与门禁同步。

## 6. 验收命令

```sh
# 干净检出必须红（缺 addon）
git archive HEAD | tar -x -C <tmp> && cd <tmp>
node scripts/build-enterprise-bundle.mjs <out>        # 期望 exit≠0，消息含缺失 triple

# 暂存后必须绿，且 vendor 条目齐全
node scripts/fetch-native-keyring.mjs --check
node scripts/build-enterprise-bundle.mjs <out>
tar -tzf <out>/heluo-forge-enterprise-<version>.tgz | grep -c 'vendor/.*keyring.node'   # 期望 4
node scripts/verify-enterprise-bundle.mjs <out>/heluo-forge-enterprise-<version>.tgz    # 期望 ok

# 离线闭环与反例
pnpm check:docs && pnpm check:repo
pnpm check:tarballs            # 结构化模式，干净检出仍绿
node --test tests/bundle-native.test.mjs
```

## 7. 边界：不做什么

- 不把 addon 提交进 Git（每版本约 9.5 MB，且提交钩子对不可扫描二进制是硬停，只能靠放行规则绕过）。
- 不让 `node --run check` 联网或安装依赖；发布暂存与原生钥匙串 CI 作业可访问上游包源。
- 不因"可禁用"放宽 `unvetted` 默认拒绝，不在企业补丁里塞 `allowUnvettedPlatformAdapter`。
- 不删除既有 fail-closed 用例；不把"缺 addon"从负例改成跳过。
- 规则覆盖随包携带 `vendor/CHECKSUMS.json` 的成员；凭据包还强制要求记录存在。其他包若引入同名记录，即自动接受同一约束；这不是通用 vendor 目录检查器。
- 结构化模式（`requireNativeResources: false`）用于离线 `check-bundle-tarballs` 与安装排练，不对外暴露成发布开关；排练证据明确标记原生资源未经核验。

## 8. 待确认事项

| 编号 | 事项 | 结论（2026-11-09） |
|---|---|---|
| D1 | 发布门禁落在允许联网的发布 job，还是人工发布清单 | 初始取人工清单：构建期硬失败 + RUNBOOK S2.0；后续新增原生钥匙串 CI 作业，见 R8 |
| D2 | 产物期校验设为阻断（现存归档转红） | 已采纳：旧归档 `128 files` 产物被判 8 条错误、`exit 1` |
| D3 | 二进制是否永久不入库 | 保持不入库；`vendor/<triple>/` 仍由 `.gitignore` 排除 |
| D4 | 试点覆盖层是否随运行手册给出 | 已写入 RUNBOOK S2 与包 README，默认仍是拒绝挂载 |
| D5 | #182 的"已随包分发"取证结论是否同步回退 | 已回退表述：改为"随包由发布前暂存与双门禁保证，仍未实机取证" |

## 9. 实施顺序与提交切分

| 提交 | 内容 | 验证 |
|---|---|---|
| 1 | 5.1 构建前沿 + 5.3 正反例 | `node --test tests/bundle-native.test.mjs` |
| 2 | 5.2 产物校验 + 对应负例 | 先对现存归档取得失败输出，再对修复后归档取得通过输出 |
| 3 | 5.4 附带修正 | `node scripts/fetch-native-keyring.mjs --check` 及负例 |
| 4 | 5.5 文档同步与登记 | `pnpm check` |

## 10. 实施结果（2026-11-09）

本机 macOS arm64 / Node 24.21.0 / npm 11.19.0，在工作区与"仅跟踪文件 + 两个新增文件"的干净快照上分别实测：

| 编号 | 命令 | 结果 |
|---|---|---|
| R1 | 干净快照 `node scripts/build-enterprise-bundle.mjs <out>` | `exit 1`，一行汇总 `4 recorded file(s) missing: …` 与 `4 addon license(s) missing: …`，并给出 `fetch-native-keyring.mjs`；`<out>` 未被创建 |
| R2 | 对旧坏产物（`128 files`、`bd8367…`）执行 `verify-enterprise-bundle` | `exit 1`，一条汇总 `vendor/CHECKSUMS.json: 4 recorded file(s) missing …; 4 addon license(s) missing …` |
| R2 | 暂存后构建并核验 | `136 files`、`12031149` 字节、`sha256 029adc…e2c2`（仅含本次改动的树）；并入 `main` 39477b5 后为 `140 files`、`12230489` 字节、`sha256 86b5bc…42f7`；两次均 `bundle: ok`，归档内 `vendor/` 10 条、`keyring.node` 4 个 |
| R4 | 干净快照 `check-bundle-tarballs` | `bundles: 7 packed, 313 files`、`bundles: ok`（结构化模式，保持离线；`305` 为 rebase 到 main 之前的树） |
| R3 | `node --test tests/bundle-native.test.mjs` | 19 通过、0 失败 |
| R3 | 变异：`auditNativeRecords` 直接返回空 | 8 条用例转红（判定确实生效） |
| R3 | 变异：构建前置短路为 `if (false)` | 8 条用例转红 |
| R3 | 变异：产物核验规则短路 | 3 条用例转红 |
| R3 | 变异：`releaseFiles` 覆盖判据短路 | 1 条用例转红（新增的「记录不随包」用例） |
| R3 | 恢复四处变异后重跑 | 19 通过、0 失败 |
| — | `node --test tests/fetch-native-keyring.test.mjs` | 14 通过（新增 `integrity`/`source` 漂移两例） |
| R5 | 干净克隆 `node --run check`（等价 CI 的离线检出） | docs/repo/bundles 全绿；3136 用例、3131 通过、5 跳过、0 失败 |
| R5 | 同一干净克隆执行发布构建 | `exit 1`，目标目录未创建——新门禁在真实离线检出上生效 |
| R6 | 审查发现：记录可以被声明却不随包 | 已加 `releaseFiles` 判据与对应用例；短路该判据时 1 条用例转红 |
| R6 | 审查发现：归档内记录损坏让核验器抛异常 | 已折成错误行，`verifyBundle` 返回 `ok=false`、CLI `exit 1`；对应用例同时断言两者 |
| R6 | 审查发现：记录路径可含 `..`、消息重复八次、夹具三份拷贝 | 路径按段拒绝、消息按包汇总（干净检出 1 行）、夹具收敛到 `tests/fixtures/release-tree.mjs` |
| R7 | 干净检出补门禁：记录 ↔ 锁文件一致性 | `tests/native-records.test.mjs` 7 通过；短路该判定后 5 条转红 |
| R7 | 打包 E2E：映射 ↔ 产物路径闭合 | `bundle-native` 20 通过（新增一条按 `nativeTargetFor` 反推四组路径） |
| R7 | `verify:bundle --json` | 真实产物输出 `140 files` / `12230489` / `86b5bc…42f7`、退出码 0；篡改产物输出 `ok:false` 与首错、退出码 1 |
| R8 | CI 一直只验结构：`verify` 无 addon 字节，`device-matrix` 注入原生模块，两者都不加载 `keyring.node` | 新增 `native-keychain` 作业，2026-11-09 四个 runner 全绿：linux-x64/linux-arm64 构建出 `140 files` / `12230489` / `86b5bc…42f7`（与本机逐字节相同），安装后 addon 与记录一致；win32-x64/win32-arm64 打包凭据包后安装，四个 addon 一致。四者均 `store probe: 6 steps ok`（read-absent、write-read、overwrite-read、cross-process-read、delete、delete-idempotent），真实 triple 为 `linux-x64-gnu`、`linux-arm64-gnu`、`win32-x64-msvc`、`win32-arm64-msvc` |
| R9 | CI 存在与 `verify` 重复的矩阵腿，且同一平台被两个作业各占一台 runner | TAP 点名确认 keychain 包测试、`callback-port`、`sensitive-scan` 均在根目录 `node --test` 内，先删三条重复腿（14 → 11，零覆盖损失），再把 `device-matrix` 的平台单测折进 `native-keychain` 的前置步骤（单测先于任何网络访问，注册表故障不掩盖平台信号）：每平台一台 runner，14 → 8 个作业 |
| R9 | 真实钥匙串作业不在必需检查里 | 暂存加 `actions/cache`（键为锁文件哈希，命中仍先过 `--check`），四个 `native keychain (*)` 加入 `main` 必需检查；`verify` 的结构性绿灯不再能单独放行缺件产物 |
| R10 | 目标覆盖面只到 4 条主干腿，macOS 与「缺依赖企业机」没有 CI 证据 | 补 `document backend (macos-15)` / `(macos-15-intel)`（macOS 无 addon，驱动加密文档后端，断言 `triple`/`addon` 为空）、`native keychain (linux-x64)` 内的 `no-store refusal`（无 session bus 时六步全部 `KEYCHAIN_OPERATION_FAILED`，随后装上 Secret Service 后同一 job 六步全过），以及前进兼容腿 `(linux-x64, ubuntu-26.04)`、`(win32-x64, windows-2025)`。主干四腿与两条 macOS 腿为必需检查，前进兼容腿不必需 |
| R10 | 拒绝用例首版假设错误 | ubuntu-24.04 镜像自带 libsecret，addon 能加载，拒绝落在第一次存储操作（D-Bus 不可用），JSON 无顶层 `error`；断言改为从顶层与失败 step 两处收集 `code`，并以合成 JSON 验证构造期、操作期、意外成功三条路径 |
| R11 | PR 审查：缓存可同时覆盖记录与二进制，暂存又可重写错误提交的记录 | CI 改为缓存 npm 来源包，每次按锁文件验证 tarball 后提取，并以 `git diff --exit-code` 比对生成记录；冷缓存和热缓存离线重暂存均已本机验证 |
| R11 | PR 审查：只声明记录、整个 `vendor/` 缺失、npm 排除文件、许可证损坏或存在未记录 addon 时门禁有盲区 | 构建前置与打包后归档双重核验，凭据包强制带记录；记录新增许可证摘要与长度，独立核验同时拒绝未记录的 `.node` 文件 |
| R11 | 负向判据变异 | 在隔离副本中分别短路发布文件集、构建/归档缺记录、打包字节、许可证摘要、未记录 addon、来源包 integrity、缓存目录和提交记录比对，共 9 项均被用例检出 |
| R11 | 排练证据与 CI 凭据 | 结构化安装排练标注原生资源未经核验；macOS 后端作业不持久化 checkout 凭据 |
| R8 | 该作业第一次跑出了三个平台缺陷 | ①`npm.cmd` 不能经 `execFile` 启动（Node 命令注入修复）→ 改为用 `process.execPath` 跑 npm CLI 脚本；②GNU tar 把 `C:\...` 当远端主机 → 改用 `readBundleEntries` 内存解包；③release 闭包要求 bin 带 `+x`，Windows 检出无法表达 → 企业 tarball 仍只在 POSIX 产出，Windows 腿改测凭据包 |
| 复盘 | 首次 PR CI `verify` 失败 | 四条既有用例以“在干净检出里成功构建真实仓库”为前提，正是被本次判据否定的事实：两条 CLI 用例改用 fixture 工作区（新增 CLI `--root`），安装排练探针改为显式结构化构建；原生资源状态的后续修正见 R11 |

未被本机实测覆盖、仍需目标机证据的部分：Windows/麒麟/UOS 上 addon 的实际加载与读写（需要 `allowUnvettedPlatformAdapter: true` 的试点覆盖层与 Visual C++ 运行库），以及 #182 要求的失效、跨进程与重启后保留取证。

## 11. 证据索引

| 事实 | 位置 |
|---|---|
| 二进制不入库 | [.gitignore](../../.gitignore) 第 126 行 |
| 构建前置（记录覆盖 + 字节判定）与复制范围 | [build-enterprise-bundle.mjs](../../scripts/build-enterprise-bundle.mjs) 第 86 行起、第 94 行起 |
| 结构审计只验条目存在 | [bundle-rules.mjs](../../scripts/lib/bundle-rules.mjs) 第 284 行、第 299 行起 |
| 产物核验的原生资源规则 | [verify-enterprise-bundle.mjs](../../scripts/verify-enterprise-bundle.mjs) 第 70 行起 |
| 挂载期加载与抛错 | [native-keyring.mjs](../../packages/forge-credentials-keychain/src/native-keyring.mjs) 第 137 行、第 142 行、第 411 行 |
| 原生后端未取证即拒绝 | [index.mjs](../../packages/forge-credentials-keychain/src/index.mjs) 第 202 行、第 320 行起 |
| macOS 不经 addon | [backend.mjs](../../packages/forge-credentials-keychain/src/backend.mjs) 第 106 行起 |
| 企业组合禁用官方凭据行 | [cordis.patch.yml](../../packages/forge-enterprise/cordis.patch.yml) 第 36 行起 |
| 发布前暂存的前置条件 | [多端凭据存储实现与验收方案](<2026-11-03-credential-multiplatform.md>) 第 248 行所在条目 |
| 判定实现 | [native-resources.mjs](../../scripts/lib/native-resources.mjs) 全文 |
| 测试夹具 | [release-tree.mjs](../../tests/fixtures/release-tree.mjs) |
| CI 离线 verify 与设备矩阵 | [.github/workflows/check.yml](../../.github/workflows/check.yml) |
