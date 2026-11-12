<!-- meta: summary="2026-11 旧制品企业内网安装与验收历史运行记录：保留九段 S0–S8 的命令、预期、失败分支和证据状态，不作为当前凭据存储版本的操作手册。" -->
# 企业内网安装与验收运行手册（RUNBOOK）

> **历史适用性**：本文针对 2026-11 的旧制品和原生 keyring 方案保留命令及证据，不适用于当前 SQLite 凭据存储版本；其中已删除的构建和探针脚本不得作为现行操作步骤。当前源码与验证范围见[设计索引](../../design/README.md#22-实现与验证入口)，企业插件验收入口见[验收测试清单](../../operations/enterprise-uat-2026-11/验收测试清单.md)；目标机和企业环境仍须另行取证。

**历史适用**：`@heluo/forge-enterprise` 旧企业组合包（tarball + `bundle-manifest.json` + `SHA256SUMS`）在**企业内网目标机**上的安装、装载核对、功能抽查、升级/回退、卸载与证据归档。
**基线**：`docs/teamflow/20261106-r2/PRD.md`（AC-5～AC-9）、`TECHNICAL.md` §2.4/§5.3、`AC-EVIDENCE-TEMPLATE.md`、`HOST-PROBE-DISPOSITION.md`。
**版本**：v2.2 · 2026-11-09（代拟）。**状态**：S0–S2、S5（离线部分）、S8（本机可执行部分）已本机实测；S3、S4（真实安装面）、S6、S7 及全部目标 rc.3 专属项按实际执行回填，当前记 `NOT RUN`。整包 SHA 和字节数以本目录自校验为准，并记录 Node/npm 版本；包内容与工具链不同时不以示例值作为判据。

> **本手册不替代证据表**。每条命令执行后必须写入 `AC-EVIDENCE-TEMPLATE.md` 的明细块与汇总表；手册只提供“命令 + 预期 + 退出码 + 失败分支 + 取证环境”。

---

## 0. 前置检查（S0）

### 0.0 执行口径与环境标签

**四种结果**（与 `AC-EVIDENCE-TEMPLATE.md` §2.1 逐字一致）：

| 结果 | 判定 | 退出码列 | 计入通过 | 后续动作 |
|---|---|---|---|---|
| `PASS` | 在声明的环境中真实执行，退出码与预期一致且关键输出匹配 | 实际（通常 `0`） | 是 | 继续下一步 |
| `FAIL` | 已执行，退出码或关键输出不符 | 实际（非 0） | 否 | **停止当前段** → 执行该段失败分支（回滚/清理） → 记账 → 转 S8 |
| `NOT RUN` | 未执行（宿主版本 / 平台 / 企业依赖 / 权限不具备） | `—` | **否** | 可继续不依赖该项的步骤，但保留为未关闭项 |
| `BLOCKED` | 前置条件不满足，无法开始（profile 不可写、pnpm 缺失、磁盘不足） | `—` | 否 | 停止依赖该项的后续步骤，其余可继续 |

**必填记账字段**（AC-6）：步骤号、命令（逐字）、实际输出摘要、退出码、执行时间、OS/arch、node/npm/pnpm/dsh 版本、来源类型、证据文件路径 + 证据 SHA-256。NOT RUN 另填**原因类别**（`宿主版本` / `平台` / `企业依赖` / `权限`）；FAIL 另填**回滚动作与回滚结果**；BLOCKED 另填阻塞点与解除条件。

**来源类型**（四选一，与模板 §2.2 一致）：`本机实测`、`目标机实测`、`历史实机记录`、`未执行`。mock/夹具一律备注「夹具；不计企业证据」，不得单独关闭需要企业环境的 AC。

**取证环境标签**（每段“预期关键行”必须标注其一）：

| 标签 | 含义 | 本手册取值 |
|---|---|---|
| `E-LOCAL` | 本机 macOS arm64 / Node v24.13.0 / npm 11.6.2 / pnpm 11.28.5 / DSH 0.2.1-rc.5 | 2026-11-06 实测 |
| `E-TARGET` | 目标机 Linux aarch64 / Node v24.15.0 / pnpm 以实测 / DSH 0.2.1-rc.3 | **未执行**（本机无该环境） |
| `E-NONE` | 未执行，原因类别见该步 | 见 §9 |

**占位符**（AC-9）：`<workspace>` 仓库根、`<profile>` 目标 profile 名、`<outdir>` 构建输出目录、`$EVIDENCE_ROOT` 证据根（目标机本地目录，**不得**在仓库内）、`corp.example` 企业域名、`<target-host>` 主机、`<token>` 凭据。命令输出中的绝对路径与主机名在证据里按 `AC-EVIDENCE-TEMPLATE.md` §8.2 规则 3 脱敏为 `<workspace>/…`。

---

### S0.1 平台与架构

- **命令**：
  ```sh
  uname -sm
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测）：`Darwin arm64`
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`Linux aarch64`
- **退出码**：`0`。
- **失败分支**：若目标机输出非 `Linux aarch64` → 记 `NOT RUN`（原因类别 `平台`），后续要求目标平台的段（S2/S3–S7）全部记 `NOT RUN`，**不得**用其他平台结果顶替；本段不停止，直接进入 S8。
- **记账**：证据ID `E-AC05-01`，来源类型 `目标机实测`（执行后回填）。

### S0.2 工具链版本

- **命令**：
  ```sh
  node --version && npm --version && pnpm --version && dsh --version
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测）：
  ```text
  v24.13.0
  11.6.2
  11.28.5
  0.2.1-rc.5
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：
  ```text
  v24.15.0
  <目标机 npm 实测版本>
  <目标机 pnpm 实测版本>
  0.2.1-rc.3
  ```
- **退出码**：`0`；任一命令不存在 → `127`。
- **失败分支**：
  - `node` 不存在或**主版本非 24** → `BLOCKED`（阻塞点：Node 版本），停止 S1 之后全部步骤；
  - `pnpm` 不存在 → `BLOCKED`（阻塞点：pnpm 缺失；S3 的 `dsh plugin` 会向 profile 转发 pnpm，必然 `exit 127`）；
  - `dsh` 不存在 → `BLOCKED`（阻塞点：宿主不可执行），S3–S7 全部 `NOT RUN`（原因类别 `权限`）；
  - `dsh` 版本 ≠ `0.2.1-rc.3` → **不停止**，但本段记 `NOT RUN`（原因类别 `宿主版本`），且 S4–S7 中标「rc.3 专属」的运行时项一并记 `NOT RUN`；安装/卸载命令本身仍可执行并记录实际版本。
- **记账**：证据ID `E-AC14-01`；备注写实际四版本，版本差异不得写成“与预期一致”。

### S0.3 仓库固定版本（pin 只读，不修改）

- **命令**：
  ```sh
  cat .node-version .dsh-version
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测）：
  ```text
  24.21.0
  0.2.1-rc.3
  ```
- **退出码**：`0`。
- **失败分支**：任一文件缺失 → `FAIL`，停止本段并回报打包负责人（pin 缺失会让验收基准漂移）。
- **判定规则**：仓库 pin 是**开发基线**，目标机实测（Node v24.15.0）是**验收基线**；pin 在本单内**不得修改**，两者差异只记录、不追平。
- **记账**：证据ID `E-AC01-02`。

### S0.4 工作区状态（构建噪音检查）

- **命令**：
  ```sh
  git rev-parse --abbrev-ref HEAD && git log --oneline -1 && git status --short
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测）：
  ```text
  feat/plugin-workflow-new
  4033bdc feat(forge-enterprise,forge-gitee): 企业 Issue 交付链与企业组合闭包
  ```
  `git status --short` 中不得出现 `?? artifacts/`（`artifacts/` 已被根 `.gitignore` 忽略）。
- **退出码**：`0`。
- **失败分支**：出现 `?? artifacts/` → `FAIL`（构建噪音入仓风险），先执行 S2.4 的忽略核对；出现他人未提交改动 → **不停止**，只记入备注，禁止 `stash`/`reset`/`checkout --` 清理。
- **记账**：证据ID `E-AC14-02`。

### S0.5 磁盘空间

- **命令**：
  ```sh
  df -h .
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测）：`/dev/disk3s1s1  461G  413G   49G  90% /`（可用列 `49G`）。
- **退出码**：`0`。
- **失败分支**：可用空间 < `2 GiB` → `BLOCKED`（阻塞点：磁盘不足；依赖 S3–S7 的步骤全部停），清理后重跑本步。
- **记账**：证据ID `E-AC05-02`。

### S0.6 宿主可执行与 profile 可读

- **命令**（`<profile>` 由执行人填；`desktop` 不可选，见 §9 N-1）：
  ```sh
  dsh --profile <profile> --dump-config | head -3
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，profile 取 `sdk`）：
  ```text
  # == @deepseek-ai/dsh-base
  - id: tool-plugin-manager
    name: '@deepseek-ai/dsh-plugin-manager/tools'
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：首行为 `# == @deepseek-ai/dsh-base`，退出码 `0`。
- **退出码**：`0`；profile 不存在 / 无权限 → 非 0。
- **失败分支**：非 0 且错误含 `profile` → `BLOCKED`（阻塞点：profile 不可读/不存在），按目标机实际 profile 名重试一次仍失败则停 S3–S7。
- **记账**：证据ID `E-AC05-03`。

### S0.7 核验入口可调用

- **命令**（故意不带参数，验证 `pnpm` 脚本接线）：
  ```sh
  pnpm verify:bundle
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，退出码 `2`）：
  ```text
  bundle: usage: node scripts/verify-enterprise-bundle.mjs <tarball> [--manifest <json>]
  [ELIFECYCLE] Command failed with exit code 2.
  ```
- **退出码**：`2`（**本步预期就是 2**；`0` 反而说明参数被脚本吞掉，记 `FAIL`）。
- **失败分支**：`127`（`pnpm` 无该脚本，说明仓库版本过旧）→ `BLOCKED`（阻塞点：交付物缺失），回报打包负责人。
- **记账**：证据ID `E-AC02-01`；备注「无参调用，预期 exit 2」。

---

## 1. 产物校验（S1）

> 前提：S0 无 `BLOCKED`。证据根建议 `<outdir>` 全量归档（见 S8.1）。

### S1.1 三件套齐全

- **命令**：
  ```sh
  ls -l <outdir> && cat <outdir>/SHA256SUMS && node --version && npm --version
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-09 实测，`<outdir>` = `artifacts/release-a`，含四组合 addon；下例仅为本机示例，字节数/SHA 随包内容与工具链变化）：
  ```text
  -rw-r--r--  ...  186     ... SHA256SUMS
  -rw-r--r--  ...  29403   ... bundle-manifest.json
  -rw-r--r--  ...  4849086 ... heluo-forge-enterprise-0.1.0.tgz
  86b5bc09885f8097b9c3a934d48db70b25c77596e27745e496ab86e461ef42f7  heluo-forge-enterprise-0.1.0.tgz
  5c251873fa9b0f66e6cee25fc72e9425da0a8b57c25cd747f1b47d1f4aa6df1d  bundle-manifest.json
  ```
- **退出码**：`0`。
- **失败分支**：缺任一文件 → `FAIL`，停止本段（不得用 `verify:bundle` 无 manifest 模式冒充完整核验，也不得自行生成 sidecar 后宣称通过）。
- **记账**：证据ID `E-AC02-02`；把两行 `SHA256SUMS` 原文与 `node --version`/`npm --version` 粘进明细块。整包 SHA 只用于本目录自洽与同工具链复现，不与手册示例逐字比对。

### S1.2 归档哈希自校验（GNU 两空格格式）

- **命令（目标机 Linux）**：
  ```sh
  cd <outdir> && sha256sum -c SHA256SUMS
  ```
- **命令（macOS 旁证）**：
  ```sh
  cd <outdir> && shasum -a 256 -c SHA256SUMS
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，`shasum -a 256 -c`，退出码 `0`）：
  ```text
  heluo-forge-enterprise-0.1.0.tgz: OK
  bundle-manifest.json: OK
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：两行 `: OK`，退出码 `0`。
- **退出码**：`0` 全部一致；`1` 任一不一致。
- **失败分支**：任一行 `FAILED` → `FAIL`，停止本段：**不要**重新生成 sidecar 覆盖（那会把篡改洗成一致），保留原文件并回报打包负责人，转 S8 归档不一致证据。
- **记账**：证据ID `E-AC02-03`；备注写实际命令（`sha256sum` 或 `shasum`）。

### S1.3 manifest 逐文件核验（主判据）

- **命令**：
  ```sh
  pnpm verify:bundle <outdir>/heluo-forge-enterprise-0.1.0.tgz --manifest <outdir>/bundle-manifest.json
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-09 实测，退出码 `0`；数值为本机示例，判据是与同目录 `SHA256SUMS` 自洽）：
  ```text
  bundle: heluo-forge-enterprise-0.1.0.tgz | 140 files | 12230489 bytes | sha256 86b5bc09885f8097b9c3a934d48db70b25c77596e27745e496ab86e461ef42f7
  bundle: manifest ok (formatVersion 1, 6 packages)
  bundle: ok
  ```
- **机器可读旁路（可选）**：同一判据可加 `--json`，一次取全 ok / files / bytes / sha256 / entry / members / toolchain / errors 八个字段，退出码不变；证据要求按 JSON 归档时用它，不要靠解析文本输出拼字段。
- **预期关键行**（取证环境：`E-TARGET`，未执行）：三行结构相同；`files` 数与 `packages` 数必须与交付清单一致（文件数含四组合 addon 与许可证；缺 addon 的坏产物实测为 `128 files`，见 S1.6），`sha256` 必须与**本目录** `SHA256SUMS` 首行一致；不与手册示例值比对。
- **退出码**：`0` 一致（PASS）；`1` 存在差异或结构违规（FAIL）；`2` 用法/读取错误（FAIL 但先修命令）。
- **失败分支**：
  - `1` 且首行差异为 `<path>: sha256 mismatch` → `FAIL`，**停止 S1 及后续安装**；保留 tarball+manifest 原件，转 S8 归档首错行；不得重打包后继续（重打包会掩盖来源问题）。
  - `1` 且为结构违规（`workspace:` / `tests/*.test.mjs` / bin 模式）→ `FAIL`，停止并回报打包负责人。
  - `2` → 检查路径/`--manifest` 参数后**仅重试一次**；仍 `2` → `BLOCKED`（阻塞点：核验入口不可用）。
- **记账**：证据ID `E-AC02-04`；明细块粘贴完整三行 + 退出码。

### S1.4 无 manifest 的结构校验（旁证，不替代 S1.3）

- **命令**：
  ```sh
  pnpm verify:bundle <outdir>/heluo-forge-enterprise-0.1.0.tgz
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-09 实测，退出码 `0`）：
  ```text
  bundle: heluo-forge-enterprise-0.1.0.tgz | 140 files | 12230489 bytes | sha256 86b5bc09885f8097b9c3a934d48db70b25c77596e27745e496ab86e461ef42f7
  bundle: manifest not provided; structure rules only
  bundle: ok
  ```
  （同上：数值为本机示例，判据是结构规则与退出码。）
- **退出码**：`0` / `1` / `2`（含义同 S1.3）。
- **失败分支**：与 S1.3 同，但**本条通过不能单独关闭 AC-2**（无 manifest 不校验逐文件哈希），备注必须写「仅结构规则」。
- **记账**：证据ID `E-AC02-05`。

### S1.5 差异必须失败（负向确认）

- **命令**（复核六负测；核验器对内容篡改/未声明文件/`workspace:`/删文件/bin 模式/打入测试 六类必须全红）：
  ```sh
  node --test tests/bundle-verify.test.mjs
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，退出码 `0`）：
  ```text
  ✔ verifier CLI uses exit codes 0/1/2 as documented
  ℹ tests 8
  ℹ pass 8
  ℹ fail 0
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：全部用例通过、`fail 0`，退出码 `0`；用例总数以当前测试输出为准。
- **退出码**：`0` 全绿；非 0 → `FAIL`。
- **失败分支**：任一用例失败 → `FAIL`，停止本段：说明核验器本身不可信，**不得**继续用 S1.3 的结果宣称产物通过；回报打包负责人。
- **手工篡改旁证**（可选，执行后必须还原）：对 tarball 副本改 1 字节后重跑 S1.3，预期 `exit 1` 且首错形如 `package/…/client.js: sha256 mismatch (manifest <a> vs tarball <b>)`；本机 2026-11-06 实测该形态为 `bundle: failed with 3 error(s); first: package/node_modules/@heluo/forge-devops/client.js: sha256 mismatch (…)`（含 tarball sha/bytes 连带差异）。**只改副本**，原产物不动。
- **记账**：证据ID `E-AC03-01`（六负测）/`E-AC03-02`（手工篡改）。

### S1.6 原生 addon 随包齐全性（产物侧，独立于构建）

- **命令**：
  ```sh
  tar -tzf <outdir>/heluo-forge-enterprise-0.1.0.tgz | grep 'vendor/' | sort
  tar -tzf <outdir>/heluo-forge-enterprise-0.1.0.tgz | grep -c 'vendor/.*keyring.node'
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-09 实测，第二条输出 `4`）：`vendor/` 下恰好 10 条——`CHECKSUMS.json`、`README.md`，以及 `win32-x64-msvc`、`win32-arm64-msvc`、`linux-x64-gnu`、`linux-arm64-gnu` 各自的 `keyring.node` 与 `LICENSE.third-party.md`。
- **退出码**：`0`；`grep -c` 计数为 `0` 时退出码 `1`（**本步正是靠这个 1 发现 issue #216 的缺陷形态**）。
- **失败分支**：`keyring.node` < 4 或 `vendor/` 少于 10 条 → `FAIL`，停止本段。企业组合已禁用官方 `credentials` 行，缺 addon 时 profile 会在挂载期 `KEYCHAIN_UNAVAILABLE` 整体启动中止；不得用“目标机再补文件”绕过，退回打包负责人重做 S2。`verify:bundle` 对记录缺失、记录缺少许可证摘要、addon 或许可证的缺失与字节不符分别报错；须结合具体错误定位，不能仅以文件计数代替字节校验。
- **记账**：证据ID `E-AC02-06`；粘贴两条命令的原文输出。

---

## 2. 目标机重建与比对（S2）

> 目的：证明“交付的字节”能在目标工具链上重建。**同一工具链**才比较 tarball 字节 SHA-256；跨工具链（本机 v24.13.0 → 目标 v24.15.0）只比较**逐文件** sha256 与 manifest 结构。

### S2.0 原生 addon 暂存与前置校验（构建前必做）

> 四组合 addon 不入 Git（`vendor/<triple>/` 已被 `.gitignore` 忽略），干净检出必须先在**发布机**暂存。构建期已强制同一判据：缺任一条目时 `pnpm build:enterprise` 直接非零退出、不产制品（issue #216 的修复点一）。

- **命令**：
  ```sh
  node scripts/fetch-native-keyring.mjs --check
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-09 实测，退出码 `0`）：`native keyring: verified 4 staged addon(s)`
- **首次或上游版本变化时**（需网络；内网可用 `HELUO_NATIVE_REGISTRY` 指向镜像）：
  ```sh
  node scripts/fetch-native-keyring.mjs
  ```
  预期四行 `staged <triple>/keyring.node (<bytes> bytes)`，末行 `native keyring: 4 addon(s) under packages/forge-credentials-keychain/vendor; registry <url>`。
- **退出码**：`0`；缺文件、addon 或许可证的长度与哈希不符、对象头不符 → `1`。
- **失败分支**：
  - `staged file is missing` → 先执行上面的暂存命令；网络不可达 → `BLOCKED`（阻塞点：发布机无法获取固定版本 addon），**不得**跳过本步直接 S2.1（会得到缺 addon 的坏产物，构建现在也会拒绝）；
  - `integrity mismatch` / `sha256 mismatch` / `recorded ... does not match the lock file` → `FAIL`：上游制品或记录漂移，保留输出并回报，**不得**手改 `CHECKSUMS.json`；记录缺少许可证摘要时按锁文件重新暂存并重新构建。
- **记账**：证据ID `E-AC01-07`。

### S2.1 重建第一次

- **命令**：
  ```sh
  pnpm build:enterprise <outdir>-a
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-09 实测，`<outdir>-a` = `artifacts/release-a`，退出码 `0`，已按 S2.0 暂存；测得于 `main` 39477b5；数值为本机示例）：
  ```text
  "files": 140,
  "sha256": "86b5bc09885f8097b9c3a934d48db70b25c77596e27745e496ab86e461ef42f7",
  "manifest": "<workspace>/artifacts/release-a/bundle-manifest.json",
  "sums": "<workspace>/artifacts/release-a/SHA256SUMS"
  ```
  （`members` 为 6 个包；`tarball`/`manifest`/`sums` 均落在 `<outdir>` 内。）
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`exit 0`，恰好一个 `heluo-forge-enterprise-<version>.tgz` + 两个 sidecar，`files`/`sha256` 与交付清单一致或按 S2.3 口径记账。
- **退出码**：`0`；`1` 目标目录已有同名产物或 pack 失败；`2` 参数错误。
- **失败分支**：
  - `refusing to replace existing artifact`（exit 1）→ 换新目录重跑（**不要**删已有产物；若需清理只删本次新建的空目录）；
  - 输出 `<package>: <n> recorded file(s) missing: <triple>/keyring.node`（exit 1）→ 未完成 S2.0 暂存；回到 S2.0 补齐后重跑，**不得**用任何方式伪造或跳过该前置；
  - 输出 `<package>: vendor/ is not part of the release files …`（exit 1）→ 该包的 `files` 漏了 `vendor`，记录与 addon 都不会进包；补回后重跑，**不得**靠改 `CHECKSUMS.json` 绕过；
  - `npm pack` 失败 → `FAIL`，停止本段，保留完整输出（registry 不可达属预期内：构建用 `--offline`）；
  - 目标目录不可写 → `BLOCKED`（阻塞点：目录权限）。
- **记账**：证据ID `E-AC01-03`；明细块写 `files`、`sha256`、退出码与 Node/npm/pnpm 版本。

### S2.2 重建第二次（确定性）

- **命令**：
  ```sh
  pnpm build:enterprise <outdir>-b
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，两次 `sha256` 相同）：`"sha256"` 与 S2.1 逐字相同（同一工具链、同一内容下这是判据；跨工具链见 S2.3），`"files"` 与 S2.1 相同。
- **预期关键行**（取证环境：`E-TARGET`，未执行）：同工具链下两次 SHA-256 相同；不同则 `FAIL`。
- **退出码**：`0`。
- **失败分支**：两次 SHA-256 不同 → `FAIL`，停止 S2 与后续安装（不可复现的产物不能作为验收对象），归档两份 manifest 供定位。
- **记账**：证据ID `E-AC01-04`。

### S2.3 sidecar 逐字比对（同工具链）/ 逐文件比对（跨工具链）

- **命令（同工具链，逐字）**：
  ```sh
  diff <outdir>-a/bundle-manifest.json <outdir>-b/bundle-manifest.json && diff <outdir>-a/SHA256SUMS <outdir>-b/SHA256SUMS
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测）：无输出，退出码 `0`（两份 manifest 与两份 `SHA256SUMS` 均逐字节相同，`toolchain` 段来自同一工具链）。
- **命令（跨工具链，逐文件）**：
  ```sh
  node -e "const fs=require('fs');const a=JSON.parse(fs.readFileSync('<outdir>-a/bundle-manifest.json','utf8'));const b=JSON.parse(fs.readFileSync('<delivered>/bundle-manifest.json','utf8'));const m=new Map(b.files.map(f=>[f.path,f.sha256]));const d=a.files.filter(f=>m.get(f.path)!==f.sha256);console.log('differing files:',d.length,'of',a.files.length);d.slice(0,5).forEach(f=>console.log(f.path))"
  ```
- **预期关键行**（取证环境：`E-LOCAL`，本机两次构建实测。跨工具链差异在**目标机**执行后回填）：`differing files: 0 of 140`
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`differing files: 0 of 140`；若 >0，逐条列出 path 并判 `FAIL`（内容漂移），仅 `toolchain`/`tarball` 字段差异不算失败。
- **退出码**：`0`。
- **失败分支**：逐文件差异 >0 → `FAIL`，停止安装；差异只出现在 `toolchain`（node/npm 版本）→ **不算失败**，备注记「跨工具链，字节不比较」。
- **记账**：证据ID `E-AC01-05`。

### S2.4 忽略规则与工作区零差异

- **命令**：
  ```sh
  git check-ignore -v <outdir>/heluo-forge-enterprise-0.1.0.tgz <outdir>/bundle-manifest.json <outdir>/SHA256SUMS
  git status --short packages/
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测）：
  ```text
  .gitignore:49:/artifacts/	<outdir>/heluo-forge-enterprise-0.1.0.tgz
  .gitignore:49:/artifacts/	<outdir>/bundle-manifest.json
  .gitignore:49:/artifacts/	<outdir>/SHA256SUMS
  ```
  第二条命令**无输出**（`packages/` 前后面 0 差异）。
- **退出码**：`check-ignore` 三条命中时 `0`；`git status` 无输出时 `0`。
- **失败分支**：任一产物未被忽略（`check-ignore` 无输出且退出码 1）→ `FAIL`：产物必须位于 `artifacts/` 或 OS 临时目录；`packages/` 出现改动 → `FAIL`（构建污染源码树），回报打包负责人。
- **记账**：证据ID `E-AC04-01`。

### S2.5 覆盖防护（不得覆盖既有产物）

- **命令**（对已存在同名产物的目录重跑）：
  ```sh
  pnpm build:enterprise <outdir>-a
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，退出码 `1`）：
  ```text
  bundle build: refusing to replace existing artifact heluo-forge-enterprise-0.1.0.tgz
  ```
  目录内容保持不变（不新增 sidecar、不改已有 tarball）。
- **退出码**：`1`（**本步预期 1**；`0` 说明发生了覆盖，记 `FAIL`）。
- **失败分支**：`0` → `FAIL`，立即比对 S1.2 哈希确认原产物是否已被改写；被改写则停止全部验收并回报。
- **记账**：证据ID `E-AC04-02`。

---

## 3. 安装（S3）

> 本段起为**真实 profile 操作**。本机（`E-LOCAL`）按 PRD §8 纪律**不**把企业包装入真实 profile，故 S3–S7 的实装命令在本机一律 `NOT RUN`（原因类别 `权限`），其可离线验证的等价面由 S5.1/S5.2 承担；目标机执行后回填 `目标机实测`。

### S3.0 原生凭据适配器试点前提

> **已被取代（2026-11-11）**：Windows 与 macOS 的默认凭据后端是应用层加密文档，企业补丁不再注入任何适配器开关，`HELUO_KEYCHAIN_ALLOW_UNVETTED_ADAPTER` 已退役——旧 `.env` 里残留该键会以 `CONFIG_UNKNOWN_KEY` 明确失败。以下原生适配器试点步骤只作历史记录，不要在目标机上执行。

Windows/Linux 的原生适配器仍属未审核样机。企业默认补丁不启用试点开关，挂载时会以 `KEYCHAIN_UNVETTED_ADAPTER_REFUSED` 拒绝；addon 已随包不代表 profile 可以直接启动或具备生产资格。仅在非生产试点 profile 上，确认接受该限制后，叠加独立补丁：

```yaml
- id: heluo-credentials-keychain
  config:
    allowUnvettedPlatformAdapter: true
```

覆盖层替换整个 `config`，不会逐字段合并；若需非默认 `service` 或 `accountPrefix`，须在此层一并写全。试点结束后移除此覆盖层，即恢复默认拒绝；不得改企业默认补丁或重新启用官方明文凭据行。此开关只允许试点取证，不表示适配器已审核或可用于生产。

Windows 目标机须具备 Microsoft Visual C++ 2015–2022 Redistributable；Linux 目标机须有可用的 Secret Service 会话和集合，且系统运行库满足对应 addon 要求，详见[凭据包平台前提](../../../packages/forge-credentials-keychain/README.md)。目标机的加载、读写及重启后持久性仍须实测并按实际结果记账；缺少前提时停止依赖该适配器的步骤，不以 CI 结果替代目标机证据。

### S3.1 前置：`dsh plugin` 的 pnpm 转发可用

- **命令**：
  ```sh
  dsh plugin --profile <profile> list
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：列出 profile 现有依赖，退出码 `0`；`@heluo/forge-*` 尚未出现（清装基线）。
- **退出码**：`0`；缺 pnpm → `127`。
- **失败分支**：`127` → `BLOCKED`（阻塞点：profile 内 pnpm 不可用）。处置：在目标机装 `pnpm@11.28.5`（或实测版本）后重跑本步；历史实机记录（2026-10-24，DSH rc.2，六个分装 tarball）显示首次即 `exit 127`、装 pnpm 后六次均 `exit 0`，见 `docs/design/plugins/forge-enterprise.md` §11。
- **记账**：证据ID `E-AC05-04`；备注写 pnpm 实测版本。

### S3.2 安装组合包

- **命令**：
  ```sh
  dsh plugin --profile <profile> add <outdir>/heluo-forge-enterprise-0.1.0.tgz
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：安装器 pnpm 输出 `+ @heluo/forge-enterprise 0.1.0`（及其 5 个 bundled 成员），退出码 `0`。
- **退出码**：`0` 成功；`1` 版本不兼容/包损坏/store 不匹配；`127` pnpm 缺失。
- **失败分支**：
  - `engines.dsh` 拒绝（`exit 1`，提示版本不满足）→ `FAIL`（宿主版本低于包要求），归档错误行并停止 S3–S7；
  - `ERR_PNPM_*`（store/锁文件冲突）→ `FAIL`，按错误给出的 store 路径重试**一次**，仍失败则 `BLOCKED`（阻塞点：profile 依赖状态污染），先按 S7 清理再重来；
  - `exit 127` → 回到 S3.1。
- **记账**：证据ID `E-AC05-05`；归档安装器完整输出（脱敏后）与退出码。

### S3.3 安装结果确认（包面）

- **命令**：
  ```sh
  dsh plugin --profile <profile> list | grep -c '@heluo/forge'
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`6`（`@heluo/forge-enterprise` + credentials-keychain/policy/iam/devops/gitee 五个 bundled 成员）。
- **退出码**：`0`（`grep` 有命中）；无命中 → `1`。
- **失败分支**：计数 < 6 或 `1` → `FAIL`，停止 S3：安装不完整（bundledDependencies 未落地），归档 `pnpm list --depth 1` 输出；**不得**用逐个 member tarball 补装来“凑满 6”（那会改变交付形态，需打包负责人出新产物）。
- **记账**：证据ID `E-AC05-06`。

### S3.4 安装后立即做装载核对

- **命令**：直接转 **S4.1**（`dsh --profile <profile> --dump-config`）。
- **判定**：S4 的“六行挂载 / 七行官方禁用”是安装成功的**必要条件**；S3.2 退出码 0 但 S4 缺行 → 记 `FAIL`（安装 ≠ 挂载），按 S4 的失败分支处理。
- **记账**：与 S4 共用证据ID `E-AC05-07`。

### S3.5 安装失败的回滚

- **命令**：
  ```sh
  dsh plugin --profile <profile> remove @heluo/forge-enterprise
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：安装器输出 `- @heluo/forge-enterprise 0.1.0`，退出码 `0`。
- **退出码**：`0` 已移除；`1` store 不匹配/包名不存在。
- **失败分支**：`ERR_PNPM_UNEXPECTED_STORE` → 必须沿用**安装时同一 store** 重试；仍失败 → 保留现场，记 `BLOCKED`（阻塞点：profile 依赖残留），转 S8 归档，禁止手删 `node_modules` 冒充回滚完成。
- **记账**：证据ID `E-AC05-08`；回滚后必须重跑 S0.6 与 S4.1，确认组合树回到清装基线。

---

## 4. 装载检查（S4）

### S4.1 采集组合树

- **命令**：
  ```sh
  dsh --profile <profile> --dump-config > "$EVIDENCE_ROOT/dump-installed.txt" 2> "$EVIDENCE_ROOT/dump-installed.err"
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测口径演示。本机**未安装**，用显式补丁层合成同一层：`dsh --profile sdk --patch packages/forge-enterprise/cordis.patch.yml --dump-config`，退出码 `0`。**此结果不替代目标机安装后的 dump**）：
  ```text
  # == @deepseek-ai/dsh-base, patched by <workspace>/packages/forge-enterprise/cordis.patch.yml
  ```
  文件尾段出现 `insert` 六行（见 S4.2）。
- **预期关键行**（取证环境：`E-TARGET`，未执行）：退出码 `0`，`dump-installed.txt` 中出现 `patched by` 标记的补丁层段与六行 `heluo-*`/`forge-devops`。
- **退出码**：`0`。
- **失败分支**：非 0 → `FAIL`，停止本段（组合树不可读时后续全部判据失效）；`stderr` 出现 `patch: entry "<id>" not found` **不算失败**，转 S4.4 按「缺席」记账。
- **记账**：证据ID `E-AC05-07`；证据文件路径 + SHA-256 必填。

### S4.2 六行挂载（insert）

- **命令**：
  ```sh
  grep -cE '^- id: (heluo-credentials-keychain|heluo-policy|heluo-iam|heluo-issue-delivery-skill|forge-devops|heluo-gitee)$' "$EVIDENCE_ROOT/dump-installed.txt"
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，显式补丁层）：`6`
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`6`
- **退出码**：`0`；无命中 → `1`。
- **失败分支**：`<6` → `FAIL`，停止本段并停止 S5–S7（组合未挂载，后续功能抽查无意义）；逐个 `grep "^- id: <缺的id>$"` 定位缺失行，归档后回报打包负责人。`>6`（重复行）→ `FAIL`（同 id 重复加载），归档重复段。
- **记账**：证据ID `E-AC05-09`；备注写明缺/多的是哪一行。

### S4.3 七行官方禁用

- **命令**：
  ```sh
  awk '/^- id: /{id=$3} /disabled: true/{print id}' "$EVIDENCE_ROOT/dump-installed.txt" \
    | grep -Ex 'deepseek-account|ui-settings-account|llm-deepseek-account|llm-deepseek|llm-pi-ai|ui-settings-models|credentials' \
    | sort
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，**sdk profile**。该 profile 无 UI 行，故只命中 5 行，另 2 行按 S4.4 记「缺席」）：
  ```text
  credentials
  deepseek-account
  llm-deepseek
  llm-deepseek-account
  llm-pi-ai
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：带 UI 的 profile（如 `web`）应输出 **7 行**并按字母序；`sdk` 类无 UI profile 输出 5 行 + 2 条 `not found` 警告。
- **退出码**：`0`（有命中）；`1`（一行都没命中 → 补丁层未生效）。
- **失败分支**：
  - 应禁用而未禁用（缺行且 stderr **无**对应 `not found`）→ `FAIL`：补丁层未命中，停止 S4–S7；归档 `dump-installed.err`；
  - 行存在但无 `disabled: true` → `FAIL`（覆写未生效）；
  - profile 本身不含该行（`not found` 警告）→ 按 S4.4 记「缺席」，**不算**禁用，也不判 FAIL。
- **记账**：证据ID `E-AC05-10`；备注逐行列出「禁用 / 缺席」两类。

### S4.4 缺席 ≠ 已禁用

- **命令**：
  ```sh
  grep -c 'not found' "$EVIDENCE_ROOT/dump-installed.err"
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，sdk profile）：`2`（`entry "ui-settings-account" not found`、`entry "ui-settings-models" not found`）
- **预期关键行**（取证环境：`E-TARGET`，未执行，`web` profile）：`0`
- **退出码**：`0`。
- **失败分支**：`web` 类 profile 出现 `not found` → `FAIL`（官方行 id 在目标宿主上不匹配，禁用策略落空），停止 S4 并回报；**不得**把“跳过”写成“已禁用”（Loader 跳过不等于禁用）。
- **记账**：证据ID `E-AC05-11`；缺席行逐条列入备注。

### S4.5 策略目录逐字（6 条并集）

- **命令**：
  ```sh
  awk '/^- id: heluo-policy$/,/^- id: heluo-iam$/' "$EVIDENCE_ROOT/dump-installed.txt" | grep -c 'action:'
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，显式补丁层）：`6`
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`6`，且六条 action 逐字为 `change.read`、`change.list`、`gitee.repository.read`、`gitee.issue.read`、`gitee.pr.read`、`gitee.delivery.judge`。
- **退出码**：`0`。
- **失败分支**：`≠6` 或 action 名不符 → `FAIL`，停止 S4；`heluo-policy` 出现两次 → `FAIL`（策略层重复），归档两段。
- **记账**：证据ID `E-AC05-12`。

### S4.6 重启后无回灌

- **命令**：
  ```sh
  dsh --profile <profile> --dump-config > "$EVIDENCE_ROOT/dump-installed-2.txt" 2>&1 && diff "$EVIDENCE_ROOT/dump-installed.txt" "$EVIDENCE_ROOT/dump-installed-2.txt"
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测口径演示（同一显式补丁层连续两次 dump）：两次输出逐字节相同，`diff` 无输出，退出码 `0`。
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`diff` 无输出，退出码 `0`。
- **退出码**：`0`。
- **失败分支**：出现差异且差异是官方行由 `disabled: true` 变回默认 → `FAIL`（回灌），停止 S4 并回报；差异仅为补丁路径等环境值 → 备注说明，不判失败。
- **记账**：证据ID `E-AC05-13`。

---

## 5. 功能抽查（S5）

### S5.1 Loader 级装配与工具面（离线可复跑）

- **命令**：
  ```sh
  node scripts/probe/run-bundle-install-rehearsal.mjs
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，退出码 `0`）：
  ```text
  ok   install-real-loader-instantiates-members
  ok   install-services-queryable
  ok   uninstall-removes-packages-and-keeps-workspace
  rehearsal: 33/33 steps ok
  rehearsal: evidence <tmp>/install-rehearsal.json
  ```
  覆盖 `install-*`、`upgrade-*`、`rollback-*` 三组各 8 步 + 组合/工作区保护 9 步；全程 `DSH_HOME`、`npm_config_cache`、`npm_config_registry` 指向隔离临时目录，**不接触真实 profile**。
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`rehearsal: 33/33 steps ok`，退出码 `0`。
- **退出码**：`0` 全步 ok；`1` 任一步失败；`2` 环境不可运行（无 SDK / 平台不支持）。
- **失败分支**：`1` → `FAIL`，停止 S5 并归档 `install-rehearsal.json` 中失败的 step id；`2` → `NOT RUN`（原因类别 `权限`：宿主 SDK 不可见），备注写退出码与错误首行。
- **记账**：证据ID `E-AC05-14`；证据文件 `install-rehearsal.json` + SHA-256。

### S5.2 凭据 fail-closed（离线组合不变量）

- **命令**：
  ```sh
  node scripts/probe/run-credentials-composition-probe.mjs
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，退出码 `0`）：
  ```text
  ok   disabled-local/keychain-first-no-plaintext-file
  ok   disabled-local/keychain-first-unavailable-backend-refuses-to-mount
  {
    "ok": true,
    "steps": 18,
    "scope": "local composition invariant; NOT process termination, IAM trust or a native OS store",
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`"ok": true`、`"steps": 18`，退出码 `0`。
- **退出码**：`0` 全部不变量成立；`1` 断言失败；`2` 环境不可运行。
- **失败分支**：`1` → `FAIL`，停止 S5（凭据回落明文属安全缺陷），归档完整 `steps` 列表；`2` → `NOT RUN`（原因类别 `权限`）。
- **边界**：该探针只证明**本地组合不变量**，不证明进程终止、IAM 信任或原生钥匙串；企业侧结论必须另取证（§9 N-4/N-5）。
- **记账**：证据ID `E-AC05-15`。

### S5.3 宿主探针两例（目标 rc.3 上必须执行而非 skip）

- **命令**：
  ```sh
  node --test tests/host-probe.test.mjs
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，DSH rc.5 ≠ 目标 rc.3，退出码 `0`）：
  ```text
  ﹣ host probe: target DSH honours the documented tool-pipeline semantics without DSH_HOME  # 宿主版本不匹配（K-1，PRD AC-13）：实际 0.2.1-rc.5，目标 0.2.1-rc.3（.dsh-version）；本机不是目标宿主，跳过这两例环境用例，设 DSH_HOST_PROBE_FORCE=1 可强制复跑
  ℹ tests 2
  ℹ pass 0
  ℹ skipped 2
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：两例 `✔`、`pass 2`、`skipped 0`，退出码 `0`。若目标机上仍 skip → `FAIL`（门控把 rc.3 也挡掉了，覆盖丢失），归档 skip 文案。
- **强制复跑**（只在非目标宿主上用于追踪 K-1，**不得**作为 rc.3 通过证据）：
  ```sh
  DSH_HOST_PROBE_FORCE=1 node --test tests/host-probe.test.mjs
  ```
  预期失败，失败明细与 `HOST-PROBE-DISPOSITION.md` §现象 一致（`Cannot read properties of undefined (reading '0')`）。
- **退出码**：`0`（skip 亦为 0）；`1` 有 fail。
- **失败分支**：目标机出现 `fail` → `FAIL`，停止 S5；归档完整 TAP 输出与探针 stdout（`probe: 0.2.1-rc.3 | node v24.15.0 | linux-arm64`）。
- **记账**：证据ID `E-AC13-01`；skip 与 pass 分两行记账，NOT RUN/FAIL 不得合并。

### S5.4 真实会话内的工具枚举与模型面（人工）

- **命令**：无 CLI 判据——在目标 profile 的 UI 内人工观察并截图（工具列表、企业 Skill 入口）；模型相关行为只在该 profile 已配置**企业 IAM 受控模型**时才有意义。
- **预期关键行**（取证环境：`E-NONE`，未执行）：命令级证据由 S5.1 的 Loader 计数（`install-real-loader-instantiates-members`、`install-services-queryable`）承担；本步**仅**作人工补充。
- **结果**：`NOT RUN`（原因类别 `企业依赖`：需企业 IAM 与受控模型提供方；最小 profile 无 LLM 提供方时 official-rows 运行时模型面无法取证，见 §9 N-4）。
- **失败分支**：若已具备企业模型却观察到企业工具不可见或官方行仍启用 → `FAIL`，停止 S5，归档截图与 `dump-installed.txt`。
- **记账**：证据ID `E-AC05-16`；明细块备注「人工观察，无命令退出码（填 `—`）」。

### S5.5 配置页保存/回读与 IAM 登录（人工）

- **命令**：无 CLI 判据——在 UI 配置页修改一项、保存、重启后回读，确认值持久且未越权写入。
- **预期关键行**（取证环境：`E-NONE`，未执行）：需可登录的浏览器会话 + 企业 IAM；本次无企业端点，记 `NOT RUN`（原因类别 `企业依赖`）。
- **失败分支**：若能登录但保存后回读丢失/被覆写 → `FAIL`，停止 S5，归档配置文件前后快照（脱敏）。
- **记账**：证据ID `E-AC05-17`。

---

## 6. 升级/回退（S6）

### S6.1 准备第二版本构建（由打包负责人提供，不在验机现场改仓库）

- **命令**（在独立工作树/分支完成版本号变更后执行；验收现场只消费产物）：
  ```sh
  pnpm build:enterprise <outdir>-v2
  ```
- **预期关键行**（取证环境：`E-NONE`，未执行）：产出 `heluo-forge-enterprise-0.1.1.tgz` + 两个 sidecar，`sha256` 与 0.1.0 不同。
- **结果**：`NOT RUN`（原因类别 `权限`：验收现场不得修改仓库版本号；本单只交付 0.1.0）。
- **失败分支**：第二版本产物缺失 → 跳过 S6.2–S6.4，仅执行 S6.5（Loader 级升级/回退演练），并在汇总表注明「真实 profile 升级/回退未取证」。
- **记账**：证据ID `E-AC01-06`。

### S6.2 升级安装

- **命令**：
  ```sh
  dsh plugin --profile <profile> add <outdir>-v2/heluo-forge-enterprise-0.1.1.tgz
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：安装器输出 `+ @heluo/forge-enterprise 0.1.1`，退出码 `0`。
- **退出码**：`0` / `1`（store、版本约束）/ `127`。
- **失败分支**：`1` → `FAIL`，停止 S6 并执行 S6.4 回退到 0.1.0，确认组合恢复后再记账。
- **记账**：证据ID `E-AC06-01`。

### S6.3 升级后组合不变

- **命令**：
  ```sh
  dsh --profile <profile> --dump-config > "$EVIDENCE_ROOT/dump-upgraded.txt" 2> "$EVIDENCE_ROOT/dump-upgraded.err" \
    && diff "$EVIDENCE_ROOT/dump-installed.txt" "$EVIDENCE_ROOT/dump-upgraded.txt"
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`diff` 无输出（或仅版本字段差异），退出码 `0`；S4.2/S4.3 两条计数命令复跑仍为 `6` / `7`。
- **退出码**：`0`。
- **失败分支**：出现挂载行增减或官方行恢复启用 → `FAIL`，停止 S6，按 S6.4 回退并归档两份 dump。
- **记账**：证据ID `E-AC06-02`。

### S6.4 回退到 0.1.0

- **命令**：
  ```sh
  dsh plugin --profile <profile> add <outdir>/heluo-forge-enterprise-0.1.0.tgz
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`+ @heluo/forge-enterprise 0.1.0`，退出码 `0`；随后 S4.2/S4.3 复跑结果与升级前一致。
- **退出码**：`0` / `1`。
- **失败分支**：`1` → `FAIL`，保留现场（不手删），记 `BLOCKED`（阻塞点：profile 依赖状态不可回退），转 S8 并回报。
- **记账**：证据ID `E-AC06-03`。

### S6.5 Loader 级升级/回退演练（离线，本机已实测）

- **命令**：同 S5.1：`node scripts/probe/run-bundle-install-rehearsal.mjs`
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测，退出码 `0`）：
  ```text
  ok   upgrade-to-0.1.1-keeps-composition-and-workspace
  ok   rollback-to-0.1.0-keeps-composition-and-workspace
  rehearsal: 33/33 steps ok
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：同上。
- **退出码**：`0` / `1` / `2`（同 S5.1）。
- **失败分支**：`1` → `FAIL`，归档失败 step；`2` → `NOT RUN`（`权限`）。
- **记账**：证据ID `E-AC06-04`（可与 S5.1 共用一次执行，但证据行必须按步骤号分列）。

---

## 7. 卸载/残留（S7）

### S7.1 卸载前快照

- **命令**：
  ```sh
  find "$DSH_HOME/profiles/<profile>" -type f | sort > "$EVIDENCE_ROOT/profile-files-before.txt" \
    && find "$DSH_HOME/profiles/<profile>" -type f | wc -l
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：输出文件数（整数），快照文件生成。
- **结果**：`NOT RUN`（原因类别 `权限`：本机不得操作真实 profile）。
- **失败分支**：目录不存在 → `BLOCKED`（阻塞点：profile 路径与 S0.6 不一致），先对齐 profile 名。
- **记账**：证据ID `E-AC05-18`；快照文件必须归档（脱敏后）。

### S7.2 移除企业组合包

- **命令**：
  ```sh
  dsh plugin --profile <profile> remove @heluo/forge-enterprise
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`- @heluo/forge-enterprise 0.1.0`，退出码 `0`；随后 S4.3 复跑，官方行恢复默认（不再 `disabled: true`）。
- **退出码**：`0` / `1`。
- **失败分支**：`ERR_PNPM_UNEXPECTED_STORE` → 改用安装时的同一 store 重试一次；仍 `1` → `FAIL`，保留现场并转 S8。`remove` **不接受**安装专用参数（历史实测 `--offline --ignore-scripts` → pnpm `Unknown options`，exit 1），不要加。
- **记账**：证据ID `E-AC05-19`；备注写“卸载后官方行恢复默认”的实际 dump 行。

### S7.3 逐个移除五个成员（按包名）

- **命令**：
  ```sh
  for pkg in @heluo/forge-credentials-keychain @heluo/forge-policy @heluo/forge-iam @heluo/forge-devops @heluo/forge-gitee; do dsh plugin --profile <profile> remove "$pkg"; done
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：五行 `- <pkg> 0.1.0`，整体退出码 `0`（若首个已不存在，pnpm 报 `not found` 但组合仍清空——按实际退出码记账，不掩盖）。
- **退出码**：`0` 全移除；非 0 → 逐条记录哪一行失败。
- **失败分支**：某包 `remove` 失败 → 记 `FAIL` 该行，继续其余包（**不停止**整段，避免半清状态扩大），最后统一按 S7.5 判定残留。
- **记账**：证据ID `E-AC05-20`；五个包名逐行记录退出码。

### S7.4 清理补丁层残留条目（`uninstall:devops` 语义，不手删）

- **命令**：
  ```sh
  pnpm uninstall:devops --profile <profile> --keep-plugin
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测 `--help` 退出码 `0`，确认入口存在与语义）：
  ```text
  用法：node scripts/uninstall-devops.mjs [--profile <名>] [--keep-plugin]
  --keep-plugin    只清理补丁层，不调用 dsh（打印下一步命令）
  退出码：0 = 已清理或本无残留；1 = profile 无法确定 / 补丁层不存在 / 写入失败
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：清理 `forge-devops` / `@heluo/forge-devops` 两个残留 id，退出码 `0`；`--keep-plugin` 时打印下一步 `dsh plugin --profile <profile> remove @heluo/forge-devops`。
- **退出码**：`0` 已清理或本无残留；`1` profile 未确定/补丁层不存在/写入失败。
- **失败分支**：`1` → 先确认 `<profile>` 名（命令不猜 profile），重试一次；仍 `1` → `FAIL`，保留 `cordis.patch.yml` 副本并转 S8。**禁止**手工编辑 profile 的 `cordis.patch.yml`（上游条目逐字保留是本脚本的契约）。
- **记账**：证据ID `E-AC05-21`。

### S7.5 残留对比

- **命令**：
  ```sh
  find "$DSH_HOME/profiles/<profile>" -type f | sort > "$EVIDENCE_ROOT/profile-files-after.txt" \
    && diff "$EVIDENCE_ROOT/profile-files-before.txt" "$EVIDENCE_ROOT/profile-files-after.txt"
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：差异仅限已知残留项，且必须**逐条列出**，不得写“无残留”。
  已知残留（历史实机记录 2026-10-24，DSH rc.2，见 `docs/design/plugins/forge-enterprise.md` §11）：`pnpm-lock.yaml`、`state.json`、`.plugin-manager/logs/*/pnpm.log`，以及 pnpm 元数据的哈希变化。
- **退出码**：`0` 无差异；`1` 有差异（**本步退出码 1 不等于失败**，须按内容判定）。
- **判定**：本插件行/包目录/`.bin` 软链已归零 + 其他条目逐字保留 → `PASS`（备注列残留清单）；出现本插件行或包目录残留 → `FAIL`；出现**其他条目被改动/删除** → `FAIL`（越权卸载）。
- **记账**：证据ID `E-AC05-22`；明细块粘贴 `diff` 全文（脱敏后）。

### S7.6 冷启动无悬空条目

- **命令**：
  ```sh
  dsh --profile <profile> --dump-config 2>&1 | grep -c 'entry .* not found'
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`0`。
- **退出码**：`0`（`grep` 命中 0 行时返回 `1`，本步以**输出数字**为准，退出码 `1` 且输出 `0` 记 `PASS` 并在备注说明）。
- **失败分支**：`>0` → `FAIL`（补丁层残留导致冷启动告警），回到 S7.4 复跑清理，仍残留则转 S8 并回报。
- **记账**：证据ID `E-AC05-23`。

---

## 8. 证据归档（S8）

### S8.1 建证据根并固化产物

- **命令**（在目标机本地目录，**不在仓库内**）：
  ```sh
  mkdir -p "$EVIDENCE_ROOT/r2" && cp <outdir>/heluo-forge-enterprise-0.1.0.tgz <outdir>/bundle-manifest.json <outdir>/SHA256SUMS "$EVIDENCE_ROOT/r2/" && shasum -a 256 "$EVIDENCE_ROOT/r2/"*
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测哈希值；目录为仓库内 `artifacts/release-a`，目标机应复制到证据根）：
  ```text
  c756e61e79a4f0ea62018d5c3eb87bb537d83a4623b15ab3069b478e9d153cc5  heluo-forge-enterprise-0.1.0.tgz
  689936caaeaf73e7cee2e9391cfd295130457eecb40ebfb8b7ff9c24332e40f6  bundle-manifest.json
  ```
- **退出码**：`0`。
- **失败分支**：`cp` 失败/磁盘满 → `BLOCKED`；哈希与 S1.1/S1.2 记录不一致 → `FAIL`（归档过程被改动），重新拷贝并复算一次。
- **记账**：证据ID `E-AC09-01`；**tarball 与两个 sidecar 必须同批归档**（避免只带走其一）。

### S8.2 环境快照

- **命令**：
  ```sh
  { uname -sm; node --version; npm --version; pnpm --version; dsh --version; date -u +%Y-%m-%dT%H:%M:%SZ; } | tee "$EVIDENCE_ROOT/r2/env.txt"
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测）：
  ```text
  Darwin arm64
  v24.13.0
  11.6.2
  11.28.5
  0.2.1-rc.5
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`Linux aarch64` / `v24.15.0` / `<npm>` / `<pnpm>` / `0.2.1-rc.3` / UTC 时间戳。
- **退出码**：`0`。
- **失败分支**：任一命令缺失 → 在 `env.txt` 写 `missing: <cmd>` 并记 `NOT RUN`（原因类别 `权限`），**不得**用出行前采集的旧版本号替代。
- **记账**：证据ID `E-AC09-02`；`env.txt` 是每条明细块的 OS/arch 与版本字段来源。

### S8.3 敏感信息自检（AC-9）

- **命令**（正则内的 `[]` 仅用于避免本手册自身命中；证据中不得出现这些字面量）：
  ```sh
  grep -nE '(gh[p]_|glpa[t]-|Beare[r] |/Use[r]s/|/hom[e]/|10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.)' "$EVIDENCE_ROOT/r2"/*.md "$EVIDENCE_ROOT/r2"/*.txt
  ```
- **预期关键行**（取证环境：`E-LOCAL`，2026-11-06 实测：对任务夹四份文档执行同义检查，**无输出**，`grep` 退出码 `1`）：
  ```text
  （无输出）
  ```
- **退出码**：`1` = 无命中（**本步以“无输出”为 PASS**）；`0` = 有命中 → `FAIL`。
- **失败分支**：有命中 → 按 `AC-EVIDENCE-TEMPLATE.md` §8.2 规则脱敏后重跑；脱敏不得删除退出码/关键行/错误类型（否则证据不可复核）。
- **记账**：证据ID `E-AC09-03`；备注写实际使用的正则（可读化）与“无输出”。

### S8.4 填写证据表

- **命令**（机械自检，命令见模板 §9；在证据表副本上执行）：
  ```sh
  awk -F'|' '/^\| 证据ID \|/{print NF-2; exit}' "$EVIDENCE_ROOT/AC-EVIDENCE.md"
  ```
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`10`（固定 10 列）；模板 §9 八项自检逐项通过。
- **退出码**：`0`。
- **失败分支**：列数 ≠10 或自检不过 → 回到明细块补真实值；**不得**为过检查改判定或删行。
- **记账**：证据ID `E-AC10-01`；顶部四态计数与总判定按模板 §3.1/§5 计算（任一 FAIL → 总判定 `FAIL`；实现类全 PASS 但目标项 NOT RUN → `PASS（受限）`）。

### S8.5 归档清单与复核

- **命令**：
  ```sh
  find "$EVIDENCE_ROOT/r2" -type f | sort | tee "$EVIDENCE_ROOT/r2/MANIFEST.txt" && shasum -a 256 "$EVIDENCE_ROOT/r2"/* | tee "$EVIDENCE_ROOT/r2/MANIFEST.sha256"
  ```
- **必须归档**：`heluo-forge-enterprise-0.1.0.tgz`、`bundle-manifest.json`、`SHA256SUMS`、`dump-installed.txt`、`dump-installed.err`、`dump-installed-2.txt`（如执行 S4.6）、`dump-upgraded.txt`/`dump-upgraded.err`（如执行 S6）、`profile-files-before.txt`/`profile-files-after.txt`（如执行 S7）、`install-rehearsal.json`（如执行 S5.1）、`env.txt`、证据表副本。
- **预期关键行**（取证环境：`E-TARGET`，未执行）：`MANIFEST.txt` 覆盖上述文件；`MANIFEST.sha256` 每行 64 位十六进制 + 文件名。
- **退出码**：`0`。
- **失败分支**：缺任一项 → `FAIL` 该段（缺 dump 则 S4/S6 无证据、缺快照则 S7 不可判），补齐后再签字；补齐不得凭记忆重建输出。
- **记账**：证据ID `E-AC09-04`；执行人/复核人/日期填在证据表 §3.1。

---

## 9. NOT RUN 预判清单

> **预判不是结论**。每条在目标机执行后必须回填实际结果（PASS/FAIL/NOT RUN + 原因），不得直接把预判抄进汇总表。

### 9.1 结构性必然 NOT RUN（与执行人努力无关）

| ID | 项 | 落点步骤 | 原因类别 | 原因与证据 |
|---|---|---|---|---|
| N-1 | `desktop` profile 的 dump/安装 | S0.6、S3.1–S3.3、S4.* | `平台` / `权限` | `desktop` profile 由 Electron 应用独占，CLI 实测报 `profile "desktop" is managed exclusively by the Electron application`（`docs/design/plugins/forge-enterprise.md` §11 未验段）。只能改用 `web`/`sdk` 类 profile；桌面独占面保留为未关闭项。 |
| N-2 | 本机（macOS arm64 / Node v24.13.0 / rc.5）上的目标机重建项 | S2.1–S2.3、S5.3、S6.2–S6.4 | `宿主版本` | 本机无 Node v24.15.0 与 DSH rc.3（PRD §1.1、§7）。AC-1 的目标机重建、AC-14 的 rc.3 执行结果只能记 `NOT RUN`；`E-TARGET` 标签的命令一律在目标机回填。 |
| N-3 | Windows / UOS / Kylin 平台项 | S0.1、S2.*、S3.*、S7.* | `平台` | 本单只覆盖实际目标机 Linux aarch64（PRD §9 取舍 4：平台范围 A 方案）。其他平台的安装/路径/权限语义未验，逐项记 `NOT RUN`，不得以 Linux 结果类比通过。 |
| N-4 | 最小 profile 无 LLM 提供方时的 official-rows 运行时模型面 | S5.4、S5.5 | `企业依赖` | 官方账户/模型行被禁用后，运行时模型面由企业 IAM 受控适配器提供；最小 profile 无 provider 时该面**无对象可测**，只能证明配置层禁用（S4.3）。运行时可观察性另需企业模型环境。 |
| N-5 | Teamflow `stateRoot` / `commitRoot` 相关项 | S5.*（运行时根目录核对） | `权限` | 这两个配置面由宿主/Teamflow 提供，当前宿主不暴露对应配置项（本单未新增该能力，见 `docs/teamflow/memory.md` 与 r1 任务夹的 journal-root 结论）。无配置面即无可核对对象，记 `NOT RUN`，不得用默认路径推断。 |

### 9.2 条件 NOT RUN（取决于企业侧是否具备条件）

| ID | 项 | 落点步骤 | 原因类别 | 原因与证据 |
|---|---|---|---|---|
| N-6 | 企业 IAM 登录、企业对象与受控模型联调 | S5.4、S5.5 | `企业依赖` | 需企业 IAM 端点与账号；本单不做真实联调（PRD §3.2 非目标）。只可证明“缺配置时 fail-closed”（S5.2），不得把夹具当企业证据。 |
| N-7 | Gitee / dop / AI 网关只读联调 | S5.*（人工） | `企业依赖` | 需 `GITEE_TOKEN`-类凭据与企业端点；缺凭据时工具面仍在但写动作应被拒绝。缺失即 `NOT RUN`。 |
| N-8 | 私有 registry / 企业制品源可达性 | S2.1（构建离线路径）、S3.2（安装拉取） | `企业依赖` | 构建以 `--offline` 运行，不依赖 registry；安装期的制品源行为只能在企业内网验证。目标机无制品源时安装步骤按实际错误记 `FAIL`，不得预判为 `NOT RUN`。 |
| N-9 | 目标 profile 目录写权限不足 | S1.* 之后的安装类步骤 | `权限` | 由目标机文件权限决定；S0.6 报 `profile` 相关错误即转 `BLOCKED`。属执行时判定，不是必然项。 |

---

## 10. 命令台账

> 状态取值：`PASS`（已实测）/ `NOT RUN`（未执行，原因见备注）。日期为实测日；目标机执行的命令在本机记 `NOT RUN` 并在目标机回填。

| 命令 | 状态 | 环境 | 日期 | 输出摘要 |
|---|---|---|---|---|
| `uname -sm` | PASS | E-LOCAL | 2026-11-06 | `Darwin arm64` |
| `node --version && npm --version && pnpm --version && dsh --version` | PASS | E-LOCAL | 2026-11-06 | `v24.13.0` / `11.6.2` / `11.28.5` / `0.2.1-rc.5` |
| `cat .node-version .dsh-version` | PASS | E-LOCAL | 2026-11-06 | `24.21.0` / `0.2.1-rc.3`（pin 未改） |
| `git rev-parse --abbrev-ref HEAD && git log --oneline -1` | PASS | E-LOCAL | 2026-11-06 | `feat/plugin-workflow-new` / `4033bdc` |
| `git status --short` | PASS | E-LOCAL | 2026-11-06 | 仅任务夹与新增脚本未跟踪；无 `?? artifacts/` |
| `df -h .` | PASS | E-LOCAL | 2026-11-06 | 可用 `49G`（要求 ≥2 GiB） |
| `dsh --profile sdk --dump-config \| head -3` | PASS | E-LOCAL | 2026-11-06 | `# == @deepseek-ai/dsh-base` / `- id: tool-plugin-manager` |
| `pnpm verify:bundle`（无参） | PASS | E-LOCAL | 2026-11-06 | exit 2，`bundle: usage: …` |
| `ls -l artifacts/release-a && cat artifacts/release-a/SHA256SUMS` | PASS | E-LOCAL | 2026-11-06 | tarball `517348` B、manifest `25757` B、SUMS `186` B；两行哈希 |
| `shasum -a 256 -c SHA256SUMS` | PASS | E-LOCAL | 2026-11-06 | 两行 `: OK`，exit 0 |
| `pnpm verify:bundle <tgz> --manifest <json>` | PASS | E-LOCAL | 2026-11-06 | `124 files` / `6 packages` / `bundle: ok`，exit 0 |
| `pnpm verify:bundle <tgz>`（无 manifest） | PASS | E-LOCAL | 2026-11-06 | `manifest not provided; structure rules only`，exit 0 |
| 篡改副本 1 字节后 `pnpm verify:bundle <tmp> --manifest <json>` | PASS | E-LOCAL | 2026-11-06 | exit 1，`failed with 3 error(s); first: …/client.js: sha256 mismatch` |
| `pnpm verify:bundle <tgz> --manifest <不存在>` | PASS | E-LOCAL | 2026-11-06 | exit 2，`bundle: ENOENT: …` |
| `node --test tests/bundle-verify.test.mjs` | PASS | E-LOCAL | 2026-11-06 | `tests 8 / pass 8 / fail 0`，exit 0 |
| `tar -tzf <outdir>/heluo-forge-enterprise-0.1.0.tgz \| grep 'vendor/' \| sort` | NOT RUN | E-TARGET | — | 原因：平台；目标机按 S1.6 记账 |
| `tar -tzf <outdir>/heluo-forge-enterprise-0.1.0.tgz \| grep -c 'vendor/.*keyring.node'` | NOT RUN | E-TARGET | — | 原因：平台；目标机按 S1.6 记账 |
| `node scripts/fetch-native-keyring.mjs --check` | NOT RUN | E-TARGET | — | 原因：平台；目标机构建前按 S2.0 记账 |
| `node scripts/fetch-native-keyring.mjs` | NOT RUN | E-TARGET | — | 原因：平台；需要暂存时按 S2.0 记账 |
| `pnpm build:enterprise artifacts/release-a` | PASS | E-LOCAL | 2026-11-06 | exit 0，`files: 124`，`sha256 c756e6…3cc5`，写出 manifest+sums |
| `pnpm build:enterprise artifacts/release-b` | PASS | E-LOCAL | 2026-11-06 | exit 0，`sha256` 与 release-a **相同** |
| `diff <a>/bundle-manifest.json <b>/bundle-manifest.json` | PASS | E-LOCAL | 2026-11-06 | 无输出，exit 0（两次构建逐字节相同） |
| `node -e "…differing files…"`（逐文件哈希比对） | PASS | E-LOCAL | 2026-11-06 | `differing files: 0 of 124` |
| `pnpm build:enterprise artifacts/release-a`（目录已存在） | PASS | E-LOCAL | 2026-11-06 | exit 1，`refusing to replace existing artifact …` |
| `git check-ignore -v artifacts/release-a/{*.tgz,bundle-manifest.json,SHA256SUMS}` | PASS | E-LOCAL | 2026-11-06 | 三条命中 `.gitignore:49:/artifacts/` |
| `git status --short packages/` | PASS | E-LOCAL | 2026-11-06 | 无输出（0 差异） |
| `dsh --profile sdk --patch packages/forge-enterprise/cordis.patch.yml --dump-config` | PASS | E-LOCAL | 2026-11-06 | exit 0；六行 insert；5/7 官方行 disabled；2 条 `not found` |
| `grep -cE '^- id: (…六行…)$' dump` | PASS | E-LOCAL | 2026-11-06 | `6` |
| `awk … /disabled: true/ … \| grep -Ex '…七行…' \| sort` | PASS | E-LOCAL | 2026-11-06 | 5 行（sdk 无 UI 行，另 2 行缺席） |
| `grep -c 'not found' dump.err` | PASS | E-LOCAL | 2026-11-06 | `2`（`ui-settings-account`、`ui-settings-models`） |
| `awk '/id: heluo-policy/,/id: heluo-iam/' dump \| grep -c 'action:'` | PASS | E-LOCAL | 2026-11-06 | `6` |
| `node scripts/probe/run-bundle-install-rehearsal.mjs` | PASS | E-LOCAL | 2026-11-06 | `rehearsal: 33/33 steps ok`，exit 0 |
| `node scripts/probe/run-credentials-composition-probe.mjs` | PASS | E-LOCAL | 2026-11-06 | `ok: true` / `steps: 18`，exit 0 |
| `node --test tests/host-probe.test.mjs` | PASS | E-LOCAL | 2026-11-06 | `tests 2 / pass 0 / skipped 2`（rc.5 门控），exit 0 |
| `DSH_HOST_PROBE_FORCE=1 node --test tests/host-probe.test.mjs` | FAIL | E-LOCAL | 2026-11-06 | K-1 取证：实测 `tests 2 / pass 0 / fail 2`、exit 1（预期失败，用于追踪 K-1；详见 `HOST-PROBE-DISPOSITION.md` §5） |
| `node scripts/uninstall-devops.mjs --help` | PASS | E-LOCAL | 2026-11-06 | 用法四段 + 退出码说明，exit 0 |
| `dsh plugin --profile <profile> list` | NOT RUN | E-TARGET | — | 原因：权限（本机不装真实 profile）；目标机回填 |
| `dsh plugin --profile <profile> add <outdir>/heluo-forge-enterprise-0.1.0.tgz` | NOT RUN | E-TARGET | — | 原因：权限；目标机回填 |
| `dsh plugin --profile <profile> remove @heluo/forge-enterprise` | NOT RUN | E-TARGET | — | 原因：权限；目标机回填 |
| `for pkg in …; do dsh plugin --profile <profile> remove "$pkg"; done` | NOT RUN | E-TARGET | — | 原因：权限；目标机回填 |
| `pnpm uninstall:devops --profile <profile> --keep-plugin` | NOT RUN | E-TARGET | — | 原因：权限；入口本机已验（`--help` exit 0） |
| `find "$DSH_HOME/profiles/<profile>" -type f \| sort` + `diff` 快照 | NOT RUN | E-TARGET | — | 原因：权限；目标机回填 |
| `dsh --profile <profile> --dump-config`（安装后） | NOT RUN | E-TARGET | — | 原因：权限；本机仅用显式 `--patch` 合成层验证口径 |
| `sha256sum -c SHA256SUMS`（GNU） | NOT RUN | E-TARGET | — | 原因：平台（本机为 BSD `shasum`，目标机 Linux 执行） |
| `pnpm build:enterprise <outdir>-a` / `-b`（目标机 v24.15.0） | NOT RUN | E-TARGET | — | 原因：宿主版本（本机 Node v24.13.0） |
| `grep -nE '…敏感模式…' "$EVIDENCE_ROOT/r2"/*` | PASS | E-LOCAL | 2026-11-06 | 无输出（0 命中） |
| `awk -F'\|' '/^\| 证据ID \|/{print NF-2}' <证据表>` | NOT RUN | E-TARGET | — | 原因：依赖目标机证据表；本机模板自检见模板 §9 |

---

## 11. 失败分支与回滚速查

| FAIL 位置 | 停止范围 | 立即动作 | 回滚/清理 | 重新进入条件 |
|---|---|---|---|---|
| S1 产物校验 | S1 之后全部 | 保留 tarball/manifest/SUMS 原件，归档首错行 | 不重打包、不重建 sidecar | 打包负责人交付新产物后从 S1.1 重跑 |
| S2 重建/比对 | S2 之后全部 | 归档两份 manifest | 删除本次新建的 `<outdir>-*`（仅本次新建） | 工具链固定后重跑 S2.1 |
| S3 安装 | S3–S7 | 归档安装器输出 | `dsh plugin --profile <p> remove @heluo/forge-enterprise`（同 store） | 依赖/权限修复后从 S3.1 重跑 |
| S4 装载 | S4–S7 | 归档 dump + err | 同上；补丁层残留按 S7.4 清理 | 安装修好后从 S4.1 重跑 |
| S5 功能 | S5–S7 | 归档探针输出/截图 | 无（只读抽查，不改状态） | 修复后重跑对应子步骤 |
| S6 升级/回退 | S6 | 归档两份 dump | 回退到 0.1.0（S6.4） | 组合恢复后重跑 S6.3 |
| S7 卸载 | S7 | 保留 profile 快照与实际退出码 | `pnpm uninstall:devops --profile <p> --keep-plugin` → 按包名 `remove` | 残留清单归零后重跑 S7.5/S7.6 |
| S8 归档 | S8 | 补齐缺失文件后重算哈希 | 不删除已归档证据 | 清单完整后签字 |

**铁律**：`FAIL` 只停“该分支”，但分支内的后续步骤不得继续取证；`NOT RUN` 可继续但不计入通过；任何“看起来通过”的空单元格一律视为未执行。

---

## 附录 A. 本机实测记录（E-LOCAL）

- **时间**：2026-11-06（Asia/Shanghai）。
- **环境**：macOS（Darwin）arm64 · Node `v24.13.0` · npm `11.6.2` · pnpm `11.28.5` · DSH `0.2.1-rc.5` · 仓库分支 `feat/plugin-workflow-new` · HEAD `4033bdc`。
- **产物**：`artifacts/release-a/heluo-forge-enterprise-0.1.0.tgz`（`517348` B，124 文件，解包载荷 `1694126` B）、`bundle-manifest.json`（`25757` B，formatVersion 1，6 包）、`SHA256SUMS`（`186` B）。
- **关键哈希**：tarball `c756e61e79a4f0ea62018d5c3eb87bb537d83a4623b15ab3069b478e9d153cc5`；manifest `689936caaeaf73e7cee2e9391cfd295130457eecb40ebfb8b7ff9c24332e40f6`。
- **未执行**：全部 `E-TARGET` 命令、真实 profile 安装/卸载（`权限`）、企业 IAM/Gitee/dop 联调（`企业依赖`）、Windows/UOS/Kylin（`平台`）。

## 附录 B. AC 覆盖映射

| AC | 本手册落点 | 判据 |
|---|---|---|
| AC-5 | §0–§8 九段 | 每段含逐字命令 + 预期关键行 + 取证环境标签 + 退出码 + 失败分支；无“见文档”式省略 |
| AC-6 | §0.0 四态与字段表 + 各段失败分支 + §11 | PASS/FAIL/NOT RUN/BLOCKED 判定、12 项记账字段、FAIL 停止并回滚、NOT RUN 不计通过 |
| AC-7 | §9.1（5 条必然）+ §9.2（4 条条件） | ≥5 条、两类分列、覆盖 `desktop` dump / 非目标平台 / 企业联调 / `stateRoot`/`commitRoot` / 无 LLM 的运行时模型面，每条给原因与证据 |
| AC-8 | §10 命令台账 | 每条命令二选一：`PASS`/`FAIL` 带日期与实测摘要，或 `NOT RUN` 带原因类别；不存在“写成预期但从未执行”的缺失状态 |
| AC-9 | §0.0 占位符表 + §8.3 + 附录 A | 无真实地址/IP/凭据/个人绝对路径；示例统一占位符；脱敏规则指向模板 §8.2 |
