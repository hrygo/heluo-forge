# QA 报告 · 20261106-r2 企业交付验收包

> 结论：**未发现 P0/P1/P2 缺陷；2 条 P3 文档一致性问题（不阻断）**。核验链（构建 → sidecar → 离线核验）与宿主版本门控在本机实测可用，`pnpm check` 0 fail。AC-1 的目标机重建部分、AC-14 的 rc.3 执行部分按环境限制记 `NOT RUN`。

## 1. 范围与环境

| 项 | 值 |
|---|---|
| 分支 / HEAD | `feat/plugin-workflow-new` / `4033bdc`（工作区 14 项未提交改动，属本单交付） |
| 被测物 | T1 `scripts/lib/bundle-archive.mjs`、`scripts/lib/bundle-manifest.mjs`、`scripts/verify-enterprise-bundle.mjs`、`scripts/build-enterprise-bundle.mjs`（sidecar）、`tests/bundle-verify.test.mjs`；T2 `scripts/lib/host-probe-gate.mjs`、`tests/host-probe-gate.test.mjs`、`tests/host-probe.test.mjs`、probe 形状取证；T3/T4/T5 三份文档；T6 `docs/teamflow/memory.md` 验证基线 |
| 本机环境 | macOS arm64；Node `v24.13.0`；npm `11.6.2`；pnpm `11.28.5`；DSH `0.2.1-rc.5` |
| 仓库 pin | `.node-version` `24.21.0`、`.dsh-version` `0.2.1-rc.3`（均未被改动） |
| 目标机环境 | Node `v24.15.0` + DSH `0.2.1-rc.3`（本机不可得 → 相关项 `NOT RUN`） |

## 2. 功能用例与结果

| 编号 | 用例 / 命令 | 退出码 | 结果 | 关联 AC |
|---|---|---|---|---|
| F-01 | `node scripts/build-enterprise-bundle.mjs /tmp/qa-r2-a` | 0 | 124 files、tarball `517348` B、sha256 `c756e61e…153cc5`，同目录落 `bundle-manifest.json`(25757 B) + `SHA256SUMS`(186 B) | AC-2 |
| F-02 | 两次构建（/tmp/qa-r2-a、/tmp/qa-r2-b）比对 tarball sha256 | 0 | 唯一哈希数 = 1（两次逐字节相同） | AC-1（本机部分） |
| F-03 | `pnpm verify:bundle /tmp/qa-r2-a/heluo-forge-enterprise-0.1.0.tgz` | 0 | 三行：`124 files \| 1694126 bytes`、`manifest ok (formatVersion 1, 6 packages)`、`bundle: ok` | AC-2 |
| F-04 | `shasum -a 256 -c SHA256SUMS`（在产物目录） | 0 | tgz、manifest 两行 `OK`；GNU 两空格格式成立 | AC-2 |
| F-05 | 检查 manifest 结构（keys/时间戳/绝对路径/成员数） | 0 | 键序 `formatVersion,entry,members,toolchain,tarball,files`；`files` 124 条按 path 升序、mode 四位；无 `20xx-xx-xxT` 时间戳、无 `/Users\|/home\|/tmp` 绝对路径；members 6 个包 | AC-2 |
| F-06 | 真实产物篡改 1 字节后 `verify-enterprise-bundle.mjs <tgz> --manifest <json>` | 1 | 首错定位到具体文件：`package/node_modules/@heluo/forge-devops/client.js: size mismatch`，另有该文件 `sha256 mismatch`、tarball `sha256`/`bytes mismatch`，末行 `failed with 4 error(s); first: …client.js: size mismatch` | AC-3 ① |
| F-07 | 同目录重复构建 `node scripts/build-enterprise-bundle.mjs /tmp/qa-r2-c`（已存在产物） | 1 | `refusing to replace existing artifact`；三件套字节/mtime 未变，无 `.tmp` 残留 | AC-4 |
| F-08 | 不可达 registry + 空 cache：`npm_config_registry=http://127.0.0.1:9 npm_config_cache=/tmp/qa-empty-cache node scripts/build-enterprise-bundle.mjs /tmp/qa-r2-c` | 0 | 构建成功且 sha256 与 F-01 相同（离线可重建，不依赖 registry） | AC-4 |
| F-09 | `node --test tests/bundle-verify.test.mjs` | 0 | 8/8 pass（正例 + 六负测：篡改/未声明/删除/`workspace:*`/bin 644/打入 tests；含两次构建同哈希、拒覆盖、sidecar 失败回滚、CLI 0/1/2） | AC-3 |
| F-10 | `node --test tests/host-probe-gate.test.mjs tests/host-probe.test.mjs` | 0 | 7 pass / 0 fail / 2 skip；skip 文案含实际 `0.2.1-rc.5`、目标 `0.2.1-rc.3`、`K-1`、`FORCE=1` 提示 | AC-13 |
| F-11 | `DSH_HOST_PROBE_FORCE=1 node --test tests/host-probe.test.mjs` | 1 | 2 fail / 0 pass（强制运行按实际结果失败，符合“预期失败、用于追踪 K-1”） | AC-13 |
| F-12 | `node scripts/probe/run-host-probe.mjs`（K-1 复跑） | 1 | 打印 `probe: 0.2.1-rc.5 \| node v24.13.0 \| darwin-arm64`、`12/32 checks passed, 1 blocked`、`probe: ctx.tools.execute shape kind=object keys=[isError,error,content] resultsLength=n/a`；失败项 detail 为 `Cannot read properties of undefined (reading '0')` | AC-12 |
| F-13 | `pnpm check`（全量：docs/repo/tarballs/dsh-version/node --test） | 0 | 2809 tests / 2806 pass / **0 fail** / 3 skip | AC-14 |
| F-14 | 文档结构核查（RUNBOOK / 模板 / 处置文档） | 0 | RUNBOOK 九段 `## 0`–`## 8` 齐备 + §9 预判 9 条（必然 5 / 条件 4）+ §10 台账 43 行（28 PASS / 9 NOT RUN，无第三态）；模板汇总表恰 10 列、AC 索引 14 行、反例 8 条、脱敏示例 2 个；处置文档含现象/复跑/证据链/根因/结论/影响 | AC-5/6/7/8/10/11/12 |
| F-15 | AC-9 敏感扫描（`grep -nE '(gh[pousr]_…\|[/]Users/\|[/]home/\|10\.[0-9]+\.[0-9]+\.[0-9]+\|192\.168\.…)' docs/teamflow/20261106-r2/*.md docs/teamflow/memory.md`；模式中 `[/]` 为等价写法，避免在文档里出现完整宿主机路径前缀） | 1（无命中） | 唯一疑似命中为占位符说明行 `corp.example`/`registry.corp.example`，非真实地址；无凭据、无个人绝对路径 | AC-9 |
| F-16 | 工作区卫生：`git diff --check`、`git status --porcelain`、`git check-ignore -v artifacts` | 0 | 空白检查 0 错误；14 项改动全为本单源码/文档，无 `node_modules/`、`dist/`、`.env`、产物泄漏；`/artifacts/` 命中 `.gitignore:49` | 0c / AC-4 |

**新增 skip 清单（AC-14）**：3 条 = ① `tests/host-probe.test.mjs` 两例（本单新增的宿主版本门控，AC-13 要求）；② `tests/sensitive-scan-windows-paths.test.mjs`「Windows volume does not expose a distinct directory 8.3 alias」1 条（该文件本轮未改动，属既有平台跳过）。**除 2 个门控外 0 新增 skip。**

## 3. 架构核查（轻量）

- **蓝图符合性**：架构蓝图列出的 6 个新增/改动模块全部落地，导出逐一对齐——`readBundleEntries`/`summarizeBundle`、`MANIFEST_FORMAT_VERSION`/`createBundleManifest`/`serializeBundleManifest`/`parseBundleManifest`/`diffBundleManifest`/`serializeSha256Sums`、`verifyBundle`、`buildBundle`/`buildEnterpriseBundle`/`writeBundleArtifacts`、`normalizeDshVersion`/`hostProbeGate`；`package.json` 暴露 `verify:bundle`，`.gitignore` 忽略 `/artifacts/`。
- **抽取到位**：门控逻辑集中在纯函数 `scripts/lib/host-probe-gate.mjs`，测试文件只做“skip 或运行”；manifest 序列化/解析/比对单点实现，构建 CLI 与核验器共用，无两处漂移。
- **跨模块调用**（静态核对，无需运行时）：`scripts/verify-enterprise-bundle.mjs:13-14`、`tests/bundle-verify.test.mjs:11-12`、`scripts/build-enterprise-bundle.mjs:9-10`、`tests/host-probe.test.mjs:9-10` 共 12 个被导入符号，全部在目标模块的 `export` 列表中（`grep -nE '^export ' scripts/lib/*.mjs`）；`readDshVersion(root)` 签名与调用一致；`createBundleManifest({entry,members,tarball,entries,toolchain})` 等入参形状与 TECHNICAL §3.1 一致。
- **重复实现评估**：`scripts/lib/bundle-rules.mjs#auditTarball`（基于 `npm pack` 清单的既有审计）与核验器的结构规则有部分重叠（`workspace:*`、tests、bin 模式）。TECHNICAL §1 已显式决定**不合并**以避免回归既有 `check:tarballs` 语义，核验器改从 tarball 字节推导，属刻意取舍而非漂移；`tests/bundle-gitee.test.mjs` 的测试内 tar 读取器与新 lib 相邻，已登记为后续抽 `tests/tar-fixture.mjs`。均不构成架构缺陷。
- **观察（非缺陷）**：`readBundleEntries(source, { withContent })` 比 TECHNICAL §3.1 记录的多一个可选参数（核验器读取嵌套 `package.json` 所需，向后兼容）。建议下次触碰 TECHNICAL 时补记签名，不影响兼容性。

## 4. 人工补测清单（环境限制，非交付缺陷）

| 项 | 验收判断 | 方法 / 工具 |
|---|---|---|
| 目标机 Node `v24.15.0` 下 `pnpm build:enterprise` ×2 同 SHA-256 | AC-1 | 按 RUNBOOK S2.1–S2.3 在目标 Linux aarch64 执行，比对 tarball sha256 与逐文件哈希 |
| 目标宿主 `0.2.1-rc.3` 上 `node scripts/probe/run-host-probe.mjs` 与两例 host-probe | AC-13 / AC-14 | RUNBOOK S2/S5.3；`DSH_BIN=<rc.3 dsh>` 下 `node --test tests/host-probe.test.mjs` |
| 真实 profile 安装 / 装载 / 卸载残留 | AC-5 S3–S7 | `dsh plugin --profile <profile> add/remove`；按 RUNBOOK 回填四态 |
| 企业 IAM / Gitee / dop / 私有 registry 联调 | AC-7 条件项 | 企业内网环境，按 RUNBOOK §9.2 |
| `desktop` profile 面 | AC-7 N-1 | 需 Electron 应用独占 profile，CLI 不可及 |

## 5. 缺陷表

| 编号 | 严重级 | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| QA-r2-01 | P3 | 文档·K-1 处置（AC-12 证据可复跑性） | 1. 打开 `docs/teamflow/20261106-r2/HOST-PROBE-DISPOSITION.md` §3；2. 原样执行其中 `git diff --stat origin/main -- tests/host-probe.test.mjs scripts/probe/run-host-probe.mjs scripts/probe/host-probe-plugin.mjs` | 文档声称该命令“输出为空”，即交付时按文档可复跑得到空输出 | 交付工作区含 T2 的 additive 改动，该命令实际输出 `3 files changed, 42 insertions(+), 6 deletions(-)`，与文档“输出为空”矛盾（HEAD 未改，改用 `origin/main HEAD` 即为空，证据本身成立） | AC-12 ② | `git diff --stat origin/main -- tests/host-probe.test.mjs scripts/probe/run-host-probe.mjs scripts/probe/host-probe-plugin.mjs` | 修好后文档给出的命令在其标注的执行时点可复现“空输出”（例如改用 `git diff --stat origin/main HEAD -- …` 或注明“改动前工作区”），且 blob 对照表仍成立 |
| QA-r2-02 | P3 | 文档·RUNBOOK 命令台账（AC-8 记账一致性） | 1. 打开 `docs/teamflow/20261106-r2/RUNBOOK.md` 第 859 行；2. 与 `HOST-PROBE-DISPOSITION.md` §5 对照 | 台账中每条命令要么有实测输出，要么 `NOT RUN` 且确实未执行 | `DSH_HOST_PROBE_FORCE=1 node --test tests/host-probe.test.mjs` 记为 `NOT RUN`，但该命令已在本机实测（2 fail / 0 pass，exit 1）并写在处置文档 §5，状态与事实不符 | AC-8 / AC-13 | `DSH_HOST_PROBE_FORCE=1 node --test tests/host-probe.test.mjs` → exit 1，`2 failed`；`grep -n 'DSH_HOST_PROBE_FORCE=1 node --test' docs/teamflow/20261106-r2/RUNBOOK.md` → 状态列 `NOT RUN` | 台账该行改记为 `FAIL`（预期失败，K-1 取证，exit 1 / 2 fail）或明确指向处置文档 §5 的实测记录，与实测一致 |

## 6. 结论

- **功能与接口**：T1 核验链（构建 → `bundle-manifest.json` + `SHA256SUMS` → `pnpm verify:bundle`）在真实 124 文件产物上端到端跑通；六负测逐条 exit≠0 且定位到文件；T2 门控把 rc.5 上的 K-1 红测隔离为 skip，`FORCE=1` 仍可取证；`pnpm check` 2809 例 0 fail。接口一致性静态核对全部命中。
- **可验收性**：本单无 P0/P1/P2，2 条 P3 属文档一致性，**不阻断**；建议在关闭本单前一并修好（均为 1 行级改动）。
- **阻断/未关闭**：AC-1 目标机 v24.15.0 重建、AC-14 目标 rc.3 执行结果、S3–S7 真实 profile、企业 IAM/Gitee/registry 联调均 `NOT RUN`，需按 RUNBOOK 在目标机回填，不得以本机 rc.5 结果代替。
