<!-- meta: 本文件为 docs/teamflow/20261106-r2 需求的技术方案，随任务夹冻结，建后不改。 -->

# 企业交付验收包（r2）技术方案

**基线依赖**：本单 [PRD](PRD.md)（14 条 AC）、[AGENTS.md](../../../AGENTS.md)、[memory.md](../memory.md)
**编制**：技术方案（代拟） **日期**：2026-11-06 **依据**：PRD §3/§5/§8、现有 `scripts/` 与 `tests/` 代码
**目标环境**：企业目标机 Linux aarch64 + Node v24.15.0 + DSH 0.2.1-rc.3；本机 Node v24.13.0 + rc.5（目标专属项只能 `NOT RUN`）

## 1. 架构判断与取舍

现状：`scripts/build-enterprise-bundle.mjs` 已能产出确定性 tarball（`npm pack --ignore-scripts --offline`，原子 `rename`、已存在即 `refusing to replace`），`scripts/lib/bundle-rules.mjs` 的 `auditTarball` 只审计 **staging 清单**，`scripts/check-bundle-tarballs.mjs` 只跑 `npm pack --dry-run` 做闭包审计。也就是说：**产物存在，但“产物是否等于清单声明”没有独立、可离线、可复核的判据**；手册与证据模板缺位；`tests/host-probe.test.mjs` 只判 `dsh --version` 是否可执行，rc.5 上两例真实失败未归因。

本单不重构构建链，只在其上叠加三层薄能力，全部落在 `scripts/` 与 `tests/` 既有风格（ESM、`node:` 内置、零新增依赖、`node:test`）：

| 决策 | 取值 | 理由 |
| --- | --- | --- |
| 核验形态 | tarball + `SHA256SUMS` + `bundle-manifest.json` + `verify:bundle` | PRD §9 已确认 A；既有 `npm pack` 产物即可核验，不引入第二套打包器 |
| 清单来源 | **从已生成 tarball 反向生成** | 从 staging 目录生成会与 `npm pack` 的选择集/排序/模式产生漂移；反向生成保证“清单描述的就是字节” |
| tar 读取 | 自写 ustar 读取（仅读，不写） | 122 条目实测纯 ustar、无 pax；零依赖符合仓库纪律；`tests/bundle-gitee.test.mjs` 已有参考实现 |
| sidecar 写入位置 | 仅 CLI 写（`buildBundle()` 库契约不变） | 保持 `tests/bundle-build.test.mjs` 既有断言不动，把回归面压到最小 |
| 宿主门控 | 抽纯函数 `hostProbeGate()` + 单测 | 门控是纯判定，必须可单测；测试文件只负责“skip 或跑” |
| 根因取证 | 探针自身记录 `ctx.tools.execute` 返回形状（additive） | 不新建第 4 个探针脚本；复跑命令与 AC-12 要求的同一入口 |
| 前端 | **无改动（非目标）** | 本单全部可见面是 CLI stdout 与 Markdown 交付物，见 §4 |

## 2. 数据模型与存储

### 2.1 `bundle-manifest.json`（新增，构建产物之一）

```json
{
  "formatVersion": 1,
  "entry": { "name": "@heluo/forge-enterprise", "version": "0.1.0" },
  "members": { "@heluo/forge-credentials-keychain": "0.1.0", "@heluo/forge-devops": "0.1.0", "@heluo/forge-gitee": "0.1.0", "@heluo/forge-iam": "0.1.0", "@heluo/forge-policy": "0.1.0" },
  "toolchain": { "node": "v24.13.0", "npm": "11.6.2" },
  "tarball": { "name": "heluo-forge-enterprise-0.1.0.tgz", "sha256": "<64 hex>", "bytes": 517348 },
  "files": [{ "path": "package.json", "size": 1234, "sha256": "<64 hex>", "mode": "0644" }]
}
```

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `formatVersion` | number | 固定 `1`；未知版本核验器直接拒绝（不猜） |
| `entry` / `members` | object | `name`/`version` 取自 staging 包清单；`members` 键按包名升序 |
| `toolchain` | object | `node` = `process.version`（带 `v`），`npm` = `npm --version` 原文；**不含绝对路径与主机名** |
| `tarball` | object | `name` 为 basename；`sha256`/`bytes` 取自产物文件本身 |
| `files[]` | array | 覆盖 tarball 内全部常规文件，`path` 去掉 `package/` 前缀、以 `/` 分隔、按 **path 升序**；`mode` 归一为四位八进制（`0644`/`0755`）；无时间戳、无 uid/gid |

`members` 记录 6 个包（entry 自身 + 5 个成员）。

### 2.2 `SHA256SUMS`（新增，GNU coreutils 两空格格式）

```
<sha256>  heluo-forge-enterprise-0.1.0.tgz
<sha256>  bundle-manifest.json
```

保证 `sha256sum -c SHA256SUMS` 可直接用；顺序固定（tarball 在前、manifest 在后）。核验器不读该文件（单一真源是 manifest），它服务于企业内网通用流程。

### 2.3 产物布局与忽略规则

- 发布产物只写 `artifacts/<dir>/`（例：`artifacts/release-a/`），或 OS 临时目录（测试用 `mkdtemp`）。
- `.gitignore` 追加 `/artifacts/`（`*.tgz` 已覆盖 tarball，但 `.json`/`SHA256SUMS` 需要目录级忽略）。
- 证据：`git check-ignore -v artifacts/release-a/heluo-forge-enterprise-0.1.0.tgz artifacts/release-a/bundle-manifest.json artifacts/release-a/SHA256SUMS` 三条命中 + `git status --short` 无 `?? artifacts/`。

### 2.4 验收证据数据模型（RUNBOOK / 模板共用）

单条证据（明细块）字段：`证据ID`、`AC`、`步骤号`、`命令`、`预期关键行`、`实际输出摘要`、`退出码`、`结果`（PASS/FAIL/NOT RUN/BLOCKED）、`来源类型`（本机实测 / 目标机实测 / 历史实机记录 / 未执行）、`执行时间`、`OS/arch`、`node`、`npm`、`pnpm`、`dsh`、`证据文件路径`、`证据 SHA-256`、`执行人`、`复核人`、`备注`。
汇总表固定 10 列：`证据ID | AC | 步骤/用例 | 结果 | 退出码 | 环境 | 来源类型 | 执行时间 | 证据文件 | 备注`；顶部四态计数 + 总判定（任一 FAIL→总判定 FAIL；全部 PASS 才 PASS；实现类全 PASS 但目标项 NOT RUN→`PASS（受限）`，PRD AC-6 口径）。
`NOT RUN` 必填原因类别：`宿主版本` / `平台` / `企业依赖` / `权限`；`BLOCKED` 必填阻塞点与解除条件。

## 3. API 设计与契约

### 3.1 新增模块（下游开发必须逐字使用这些签名）

**`scripts/lib/bundle-archive.mjs`** — 只读解析 tarball

```js
readBundleEntries(source) -> Array<{ path, size, sha256, mode }> // source: string 路径 | Buffer；按 path 升序
summarizeBundle(entries) -> { fileCount, totalBytes }
```

- `path` 去掉 `package/` 前缀；`mode` 为四位八进制字符串；`sha256` 为小写 hex。
- 抛错一律 `Error`，`message` 以 `bundle archive:` 开头（`unsupported type "<t>"`、`duplicate path ...`、`unsafe path ...`、`not a gzip stream`、`truncated tar`）。
- 安全：拒绝绝对路径、含 `..` 段、空 path、非 `package/` 前缀（`pax_global_header` 一并拒绝）；拒绝 typeflag 非 `0`/`\0`（目录 `5` 跳过，链接 `1`/`2` 报错）；支持 `x`/`g` pax 头只取 `path=`/`size=`。

**`scripts/lib/bundle-manifest.mjs`** — 清单构造/序列化/比对

```js
MANIFEST_FORMAT_VERSION // = 1
createBundleManifest({ entry, members, tarball, entries, toolchain }) -> object
serializeBundleManifest(manifest) -> string
parseBundleManifest(text) -> object
diffBundleManifest(expected, actual) -> string[]   // [] 表示一致；每项一条人话差异
serializeSha256Sums(list) -> string                // list: [{ sha256, name }]，两空格格式
```

- `serializeBundleManifest`：键序固定 `formatVersion, entry, members, toolchain, tarball, files`，2 空格缩进、末尾换行、`files` 按 path 升序；同一输入字节级稳定。
- `parseBundleManifest` 校验：JSON 可解析、`formatVersion === 1`、`files` 非空数组、`path`/`sha256`(64 hex)/`mode`(`/^0[0-7]{3}$/`)/`size` 合法、`path` 严格升序且无重复。
- `diffBundleManifest` 比较 `entry`、`members`、`tarball.name`、`tarball.sha256`、`tarball.bytes`、`files` 全量（缺/多/内容/模式）；**不比 `toolchain`**（跨机差异，如实记录不判失败）。

**`scripts/lib/host-probe-gate.mjs`** — 宿主版本门控（纯函数）

```js
normalizeDshVersion(raw) -> string           // 取 "0.2.1-rc.5" 形态；无法解析返回 ''
hostProbeGate({ actual, target, force, error }) -> { skip, reason }
```

- `error` 存在（`dsh` 不可执行）→ `skip: true`，`reason` 含实际错误与目标版本。
- `force` 为真 → `skip: false`，`reason` 说明“强制运行（非目标宿主）”。
- `actual` 归一后为空或不等于 `target` → `skip: true`，`reason` 含实际版本、目标版本、`K-1` 与 PRD AC-13 引用。
- 相等 → `skip: false, reason: ''`。

**`scripts/verify-enterprise-bundle.mjs`** — 核验器（库 + CLI）

```js
verifyBundle(tarballPath, { manifestPath } = {}) -> { ok, errors, manifest, entries, summary }
// summary: { fileCount, totalBytes, memberCount, entryName, entryVersion, sha256 }
```

CLI：`node scripts/verify-enterprise-bundle.mjs <tarball> [--manifest <file>]`，亦通过 `pnpm verify:bundle` 暴露。退出码 `0` 一致 / `1` 存在差异或结构违规 / `2` 用法或读取错误。stdout 契约（RUNBOOK 按行 grep）：

```
bundle: <tarball basename> | <n> files | <bytes> bytes | sha256 <hex>
bundle: manifest ok (formatVersion 1, <m> packages)
bundle: ok
```

失败时每条错误一行 `bundle: <path>: <reason>`，末行 `bundle: failed with <N> error(s); first: <path>: <reason>`，stderr 不写冗余栈。

**`scripts/build-enterprise-bundle.mjs`**（改动，保持向后兼容）

```js
buildBundle(options) -> { tarball, manifest, packed, members, relativeResources }  // 契约不变
buildEnterpriseBundle(options) -> 同上
writeBundleArtifacts({ destination, tarballPath, entry, members, entries }) -> { manifestPath, sumsPath }
```

CLI 在 tarball 落盘后：读回条目 → `createBundleManifest` → 原子写 `bundle-manifest.json` → 原子写 `SHA256SUMS`；任一步失败则删除本次新建的 tarball 与已写 sidecar（不留半成品），exit 1。CLI stdout JSON 追加 `manifest`、`sums`、`sha256` 三个键（既有键不变）。

**`package.json`** 新增 `"verify:bundle": "node scripts/verify-enterprise-bundle.mjs"`；`check` 串不动（核验不进入全量 check，避免需要真实构建）。

### 3.2 host-probe 测试的 skip 文本契约（AC-13）

`tests/host-probe.test.mjs`：保留 `DSH_BIN` 指定；用 `readDshVersion()` 读 `.dsh-version` 作 target，用 `spawnSync(dsh, ['--version'])` 取 actual，`const gate = hostProbeGate({ actual, target, force: process.env.DSH_HOST_PROBE_FORCE === '1', error })`；`gate.skip` 时两例各自 `t.skip(gate.reason)`，不删除断言、不改 `node --test` 归属、不写 `todo`。

## 4. 前端组件与页面拆分

**无前端改动（非目标）**。本单全部“用户可见面”是：

1. `pnpm build:enterprise <dir>` 的 JSON stdout（新增 `manifest`/`sums`/`sha256` 键）；
2. `pnpm verify:bundle <tgz> [--manifest <json>]` 的三行成功输出 / 逐条差异输出与退出码；
3. 三份 Markdown 交付物（RUNBOOK、AC-EVIDENCE-TEMPLATE、HOST-PROBE-DISPOSITION）的表格结构。

因此无组件拆分、无路由、无状态库；`docs/teamflow/` 为纯文档目录，不引入任何页面。

## 5. 状态管理

### 5.1 构建状态机（CLI）

`resolve destination` → 校验目标目录与同名产物（存在即 `refusing to replace existing artifact`）→ staging 副本 + `npm pack`（`--offline --ignore-scripts`）→ 原子 `rename` 为 `<name>-<version>.tgz` → **读回归档生成 manifest** → 原子写 `bundle-manifest.json` → 原子写 `SHA256SUMS` → 打印 JSON。
失败路径：`pack` 失败清理 tmp；sidecar 写失败删除本次 tarball 与已写 sidecar；`finally` 清理 staging 与 OS 临时目录。

### 5.2 核验状态机（verify）

读 tarball（gzip→ustar）→ 结构规则（路径安全、typeflag、重复、空清单、根 `package.json` 可解析）→ 有 manifest 时 `diffBundleManifest` → 聚合 `errors` → 打印首错 + 计数 → exit `0/1/2`。**首个差异即失败**（PRD AC-2），不做“尽力修复”。

### 5.3 手册执行状态机（RUNBOOK）

`NOT RUN`/`BLOCKED` 不阻断后续步骤；`FAIL` 立即停止当前段、执行该段“失败分支”（回滚/清理），记录后进入证据归档；`PASS` 需附实测输出摘要与退出码。总判定取四态加权（见 §2.4）。

### 5.4 host-probe 门控状态机

`dsh` 不可执行 → skip；`DSH_HOST_PROBE_FORCE=1` → 运行；`actual === target` → 运行；否则 skip 并给出 K-1 原因。门控只影响“是否运行”，不影响断言内容。

## 6. 关键实现点与边界

- **ustar 解析**：512 字节头；`name`(0,100)、`mode`(100,8)、`size`(124,12)、`typeflag`(156,1)、`prefix`(345,155)；`size`/`mode` 去 `\0` 与空格后按八进制解析；数据区按 `size` 向上取整 512 跳过；文件体哈希用 `createHash('sha256')`；以全零块结束。截断、非 gzip、`size` 溢出（>64MiB 单文件）显式报错。
- **pax**：`x`/`g` 头按 `"<len> path=<v>\n"` 记录序列解析，仅覆盖下一条目的 `path`/`size`；出现未知记录忽略。
- **路径归一**：`path.posix` 处理；拒绝 `..`、绝对路径、`//`、尾部 `/`（目录除外）；tarball 内一律 `/`，不转换 Windows 分隔符。
- **mode**：`(mode & 0o7777).toString(8).padStart(4, '0')`；bin 项要求 `mode & 0o111 !== 0`，普通文件默认 `0644`。
- **结构规则（verify 内）**：`workspace:` 出现在任何内嵌 `package.json` 依赖即失败；`*.test.mjs`/`tests/` 文件存在即失败；根 `package.json` 必须可解析且 `name`/`version` 非空；`bin` 声明的文件必须在清单内且具可执行位。
- **确定性与脱敏**：manifest 不含时间戳、uid/gid、主机名、绝对路径；`toolchain.node` 带 `v` 前缀但只含版本；错误信息只打相对路径。
- **边界用例**：空 tarball / 仅目录 → exit 1；manifest 版本 2 → 明确拒绝；tarball basename 与 manifest `tarball.name` 不一致 → 差异项；重复 path → 解析期报错；`--manifest` 指向不存在文件 → exit 2；同名产物已存在 → exit 1 且目录保持原样（不新增 sidecar）。
- **性能**：124 文件 / 1.79MB 解压 + 哈希 < 100ms，无需流式；但按流式结构（逐条目）实现，便于将来大体量。
- **PRD §8 纪律**：`.node-version`/`.dsh-version` 不动；不安装进真实 profile；演练只用临时 `DSH_HOME`；不 commit/push（工作区保持 `?? docs/teamflow/20261106-r2/` 与源码改动，由用户裁决提交）。

## 7. 测试策略

全部离线、`node:test`、零新增依赖、自动并入 `node --test`。

| 文件 | 覆盖 | 要点 |
| --- | --- | --- |
| `tests/bundle-verify.test.mjs`（新） | AC-1/2/3/4 | ① CLI 真实构建 → `verifyBundle` 正例（124 文件、≥6 包、`ok: true`）；② 六负测（改 1 字节内容、追加未声明文件、`workspace:*` 回归、删声明文件、bin 模式 644、打入 `tests/*.test.mjs`）逐项 `ok: false` 且 `errors[0]` 含预期片段；③ 两次构建 SHA-256 相同（复用 `buildBundle`）；④ 已存在同名产物时 CLI exit 1 且不新增 sidecar；⑤ manifest 篡改/版本 2/路径穿越/重复 path 拒绝；⑥ 无 manifest 时仅结构规则 |
| `tests/host-probe-gate.test.mjs`（新） | AC-13 | 四分支（不可执行、force、版本不等含 rc.5 实际文案、相等）与 `normalizeDshVersion` 的 `dsh 0.2.1-rc.3`/裸版本/垃圾输入 |
| `tests/host-probe.test.mjs`（改） | AC-13/14 | 接入 `readDshVersion` + `hostProbeGate`；skip 文案含实际/目标版本与 K-1；断言与两例结构不动 |
| `tests/bundle-build.test.mjs`（不改） | AC-1/4 回归 | 现有确定性、拒绝覆盖、离线安装断言必须继续通过（sidecar 仅 CLI 写，库断言不受影响） |
| `tests/bundle-install-rehearsal.test.mjs`（不改） | AC-5/6 证据 | `node scripts/probe/run-bundle-install-rehearsal.mjs` 输出 `rehearsal: N/M steps ok`，作为 RUNBOOK 步骤 3–8 本机实测证据 |

负测夹具：`tests/bundle-verify.test.mjs` 内置最小 ustar 写入器（约 60 行，`gzipSync` 打包），按“合法基线 + 单点突变”构造，避免依赖 1.79MB 真实产物的字节偏移。

验证命令（最终交付自检）：`pnpm check`（含 `dsh-version check`、`check:tarballs`）、`node --test tests/bundle-verify.test.mjs tests/host-probe-gate.test.mjs`、真实产物 `node scripts/verify-enterprise-bundle.mjs artifacts/release-a/heluo-forge-enterprise-0.1.0.tgz`、`git diff --check`、`git status --short`。

## 8. 任务拆分（文件边界、并行与契约）

均遵守：分支 `feat/plugin-workflow-new`、HEAD `4033bdc`；**不 commit/push/tag/stash/reset**；不改 `.node-version`/`.dsh-version`；不写 `docs/<role>/`；不改历史任务夹与 `AGENTS.md`；测试离线。

| 任务 | 文件（ownership） | 依赖（reads） | 验收要点 |
| --- | --- | --- | --- |
| **T1 打包产物核验** | `scripts/lib/bundle-archive.mjs`、`scripts/lib/bundle-manifest.mjs`、`scripts/verify-enterprise-bundle.mjs`、`scripts/build-enterprise-bundle.mjs`、`package.json`、`.gitignore`、`tests/bundle-verify.test.mjs` | 现有 build 脚本、`bundle-rules.mjs`、`tests/bundle-build.test.mjs`、`tests/bundle-gitee.test.mjs` 的 tar 读取 | AC-1..4 全绿；真实构建 + verify 正例；六负测；现有 `bundle-build` 测试不改即过；sidecar 原子写与回滚 |
| **T2 host-probe 门控** | `tests/host-probe.test.mjs`、`scripts/lib/host-probe-gate.mjs`、`tests/host-probe-gate.test.mjs` | `scripts/lib/dsh-version.mjs`、`.dsh-version`、`scripts/probe/run-host-probe.mjs` 输出契约 | AC-13；rc.5 上两例 skip 文案含实际/目标版本 + K-1；`DSH_HOST_PROBE_FORCE=1` 可强制；断言未弱化 |
| **T3 验收运行手册** | `docs/teamflow/20261106-r2/RUNBOOK.md` | T1 的 verify 输出契约与真实构建结果、`scripts/probe/run-bundle-install-rehearsal.mjs` 输出、PRD AC-5..9 | 九段（0–8）齐全；每条命令逐字 + 预期关键行 + 退出码 + 失败分支；每条标“实测输出 / NOT RUN”；0–2、3–6、7 段本机实测（rc.5），目标机专属项 NOT RUN |
| **T4 AC 证据模板** | `docs/teamflow/20261106-r2/AC-EVIDENCE-TEMPLATE.md` | PRD AC-6/10/11、T3 的步骤编号 | 10 列汇总表 + 明细块 + 四态计数与总判定；填写规则、≥4 类反例、2 个脱敏示例（1 PASS/1 NOT RUN）；无真实地址/凭据/个人绝对路径 |
| **T5 host-probe 处置与根因取证** | `docs/teamflow/20261106-r2/HOST-PROBE-DISPOSITION.md`、`scripts/probe/host-probe-plugin.mjs`、`scripts/probe/run-host-probe.mjs` | T2 门控代码、`tests/host-probe.test.mjs`、PRD AC-12/13、`origin/main`（只读 `git log`/`git diff --stat`） | 复跑命令、完整失败摘要、非本分支引入证据（`git diff --stat origin/main -- 三文件` 为空 + 干净核对）、“根因证据”给最小复现命令与 `ctx.tools.execute` 形状差异、影响/结论/后续 issue 待登记命令（禁止虚报编号）；探针形状记录为 additive，不改断言 |
| **T6 交付自检与记忆行** | `docs/teamflow/memory.md`（仅“验证基线”一行同主题替换）、自检中发现的缺陷文件 | 全部 T1–T5 产物 | 跑 `pnpm check`、`git diff --check`、`git status --short`、真实产物 verify、`.gitignore` 证据；发现问题当场修；只记结论，不写 QA-REPORT/ACCEPTANCE |

并行：Phase 1 = T1 / T2 / T4（文件不相交）；Phase 2 = T3 / T5（依赖 T1、T2 的产物与文案）；Phase 3 = T6 收尾。

## 9. 验证命令与预期结果

| 命令 | 预期 |
| --- | --- |
| `node scripts/build-enterprise-bundle.mjs /tmp/r2-a`（本机） | exit 0，JSON 含 `tarball`/`files: 124`/`sha256`/`manifest`/`sums` |
| `node scripts/verify-enterprise-bundle.mjs /tmp/r2-a/heluo-forge-enterprise-0.1.0.tgz` | exit 0，三行 `bundle: …`，末行 `bundle: ok` |
| 篡改副本后同上 | exit 1，`bundle: package/…: sha256 mismatch` |
| `node scripts/probe/run-bundle-install-rehearsal.mjs` | exit 0，`rehearsal: N/M steps ok` |
| `node --test tests/host-probe.test.mjs`（本机 rc.5） | exit 0，两例 skip，文案含 `0.2.1-rc.5` / `0.2.1-rc.3` / `K-1` |
| `DSH_HOST_PROBE_FORCE=1 node --test tests/host-probe.test.mjs` | 两例执行并按实际结果 fail/skip（不得改断言） |
| `pnpm check` | exit 0，0 fail；除 2 个门控 skip 外无新增 skip；`dsh-version check` 与 `check:tarballs` 通过 |
| `git check-ignore -v artifacts/…` | 三条命中 `.gitignore`；`git status --short` 无 `artifacts/` |

## 10. 风险与未验证项

1. **目标机未实测**：本机 Node v24.13.0 / DSH rc.5，目标机 v24.15.0 / rc.3 → AC-1 目标机重建、AC-14 的 rc.3 结果、RUNBOOK 目标机段落一律 `NOT RUN`，禁止用本机结果冒充（PRD AC-8）。
2. **pnpm 版本差异**：目标机 pnpm 若 != 11.28.5，只记实测版本，以退出码与逐文件哈希为准（PRD 已列风险）。
3. **rc.3 门控后行为未知**：rc.3 上两例在门控下会正常运行，其结果只能在目标机取证，本单不预判 PASS。
4. **K-1 issue 未登记**：本单无远端写权限，处置文档只给 `gh issue create` 待登记命令与回填规则；编号未确认前不得写入正文。
5. **pax 与非常规 tar**：当前 npm pack 产物无 pax；解析器对 pax 只做最小支持，遇到未知扩展头明确报错而非静默跳过，避免“核验通过但内容不全”。
6. **manifest 与 tarball 的时间差**：TODO 在 RUNBOOK 中要求 sidecar 与 tarball 同批归档并核对 `SHA256SUMS`，避免只带走其一。
