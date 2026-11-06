# 验收报告 · 20261106-r2 企业交付验收包

> 性质：验收阶段独立复核（不依赖 QA 结论自证）。本报告按 `AC-EVIDENCE-TEMPLATE.md` 的 10 列台账 + 明细口径书写，逐条核对 PRD `AC-1`～`AC-14`。
> 结论摘要：**核心功能链（构建 → sidecar → 离线核验 → 门控）在本机实测成立，架构与蓝图一致；但 AC-14 的 `pnpm check` 当前 exit 1（QA 报告内嵌 `/Users`、`/home` 字面量触发 check-docs），AC-8 有 1 行台账与实测不符，AC-12 §3 的“输出为空”命令在交付树上不可复现。三项均为任务夹文档的一行级整改，不涉及实现返工，故判「有条件通过」，整改后重验即可关闭。**

## 0. 四态计数与总判定

| PASS | FAIL | NOT RUN | BLOCKED | 未关闭 AC |
|---|---|---|---|---|
| 11 | 2 | 1 | 0 | AC-1（目标机）、AC-8、AC-14 |

- **总判定**：⚠️ 有条件通过（整改项 R1–R3 见 §5；目标机项 R4 按 RUNBOOK 回填）。
- **判定依据**：AC-2/3/4/5/6/7/9/10/11/12/13 PASS（本轮复跑）；AC-1 目标机未执行记 `NOT RUN`；AC-8、AC-14 FAIL（文档一致性，可一行修复后重跑）。

## 1. 环境与证据根

| 项 | 值 |
|---|---|
| 分支 / HEAD | `feat/plugin-workflow-new` / `4033bdc`；`origin/main` = `13b4b7d` |
| 本机环境 | macOS arm64；Node `v24.13.0`；npm `11.6.2`；pnpm `11.28.5`；DSH `0.2.1-rc.5` |
| 目标机环境 | Node `v24.15.0` + DSH `0.2.1-rc.3`（本机不可得，相关项 `NOT RUN`） |
| 工作区 | 未提交改动 13 项（7 改 + 6 新增，全部为本单交付）；`git diff --check` exit 0 |
| 证据根 | 本报告 §3 即本轮实测记录；任务夹 `docs/teamflow/20261106-r2/` 各文档为结构证据 |

## 2. 逐 AC 判定台账（10 列）

| 证据ID | AC | 步骤/用例 | 结果 | 退出码 | 环境 | 来源类型 | 执行时间 | 证据文件 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| E-AC01-01 | AC-1 | `node scripts/build-enterprise-bundle.mjs` ×2（`/tmp/acc-r2-a`、`-b`）比对 tarball SHA-256 | NOT RUN | — | E-TARGET | 未执行 | — | RUNBOOK S2 | 目标机 v24.15.0 未执行；本机 v24.13.0 两次构建同哈希，仅作确定性旁证，不计目标机通过 |
| E-AC02-01 | AC-2 | 构建落 `SHA256SUMS` + `bundle-manifest.json`；`pnpm verify:bundle <tgz>` | PASS | 0 | E-LOCAL | 本机实测 | 2026-11-06 | 本报告 §3.1 | 124 文件 / 1694126 B / 6 包；`shasum -a 256 -c` 两行 OK；manifest 无时间戳、无绝对路径，`files` 按 path 升序 |
| E-AC03-01 | AC-3 | `node --test tests/bundle-verify.test.mjs`；`pnpm check:tarballs` | PASS | 0 | E-LOCAL | 本机实测 | 2026-11-06 | 本报告 §3.2 | 8/8（正例 + 六负测）；tarballs 7 packed / 295 files ok，既有规则不回退 |
| E-AC04-01 | AC-4 | 不可达 registry + 空 cache 构建；同目录重复构建 | PASS | 0 / 1 | E-LOCAL | 本机实测 | 2026-11-06 | 本报告 §3.3 | 离线构建 sha256 与在线一致；重复目标目录 `refusing to replace` exit 1，无半成品 |
| E-AC05-01 | AC-5 | RUNBOOK 九段结构核对 | PASS | 0 | E-LOCAL | 本机实测 | 2026-11-06 | RUNBOOK.md:12-798 | `## 0`～`## 8` 齐备（另含 §9 预判、§10 台账、§11 失败分支），每段含逐字命令/预期行/退出码 |
| E-AC06-01 | AC-6 | 四态判定与记账字段核对 | PASS | 0 | E-LOCAL | 本机实测 | 2026-11-06 | RUNBOOK.md:25-27 | 10 项必填字段 + NOT RUN 原因四类 + FAIL 回滚规则齐备 |
| E-AC07-01 | AC-7 | NOT RUN 预判清单条数与分类 | PASS | 0 | E-LOCAL | 本机实测 | 2026-11-06 | RUNBOOK.md §9 | 9 条（N-/C- 两类），覆盖 desktop profile、Windows/UOS/Kylin、企业依赖、stateRoot/commitRoot、最小 profile 模型面 |
| E-AC08-01 | AC-8 | §10 台账逐行与实测比对 | FAIL | — | E-LOCAL | 本机实测 | 2026-11-06 | RUNBOOK.md:859 | `DSH_HOST_PROBE_FORCE=1 node --test tests/host-probe.test.mjs` 记 `NOT RUN`，但本轮实测 2 fail / exit 1 且已写入处置文档 §5，应记 `FAIL`（缺陷 QA-r2-02，未修） |
| E-AC09-01 | AC-9 | 任务夹手册/模板/处置/PRD/TECHNICAL 敏感模式扫描 | PASS | 0 | E-LOCAL | 本机实测 | 2026-11-06 | 本报告 §3.6 | 无真实地址、内网 IP、凭据、个人绝对路径；`corp.example` 为占位符 |
| E-AC10-01 | AC-10 | 模板汇总表列数与明细字段 | PASS | 0 | E-LOCAL | 本机实测 | 2026-11-06 | AC-EVIDENCE-TEMPLATE.md:98 | 汇总表恰 10 列；明细块含命令/输出/OS/版本/哈希/执行人；顶部四态口径与 AC 索引 14 行 |
| E-AC11-01 | AC-11 | 模板填写规则、反例与脱敏示例 | PASS | 0 | E-LOCAL | 本机实测 | 2026-11-06 | AC-EVIDENCE-TEMPLATE.md §5-§7 | 15 条规则（空单元格/NOT RUN/mock/旧证据）、8 类反例、1 PASS + 1 NOT RUN 脱敏示例 |
| E-AC12-01 | AC-12 | 处置文档四要素 + 非本分支引入证据复核 | PASS | 0 | E-LOCAL | 本机实测 | 2026-11-06 | HOST-PROBE-DISPOSITION.md §1-§7 | 复跑命令与失败摘要、形状根因（`kind=object keys=[isError,error,content]`）、影响与结论 A 齐备；issue 按规范“待登记”。**P3**：§3 的 `git diff --stat origin/main -- …` 在交付树上输出 3 files changed（42+/6-），须改用 `origin/main HEAD` 才复现“空” |
| E-AC13-01 | AC-13 | 门控单测 + 两例 skip + FORCE 强跑 | PASS | 0 / 1 | E-LOCAL | 本机实测 | 2026-11-06 | 本报告 §3.4 | 17 例 15 pass / 2 skip；skip 文案含实际 `0.2.1-rc.5`、目标 `0.2.1-rc.3`、`K-1`；`FORCE=1` 2 fail exit 1；断言与自动发现未变 |
| E-AC14-01 | AC-14 | `pnpm check`（含 check-docs） | FAIL | 1 | E-LOCAL | 本机实测 | 2026-11-06 | 本报告 §3.5 | `docs/teamflow/20261106-r2/QA-REPORT.md: host-specific absolute path` → check-docs 1 error，全链在 docs 段中止，测试套件未运行。QA 报告的“0 fail”为写报告前的旧结果，已失效 |

## 3. 本轮实测明细

### 3.1 构建与核验（AC-2）
```text
$ node scripts/build-enterprise-bundle.mjs /tmp/acc-r2-a   # 与 -b
  "files": 124, "sha256": "c756e61e79a4f0ea62018d5c3eb87bb537d83a4623b15ab3069b478e9d153cc5"
$ shasum -a 256 /tmp/acc-r2-{a,b}/*.tgz
c756e61e79a4f0ea62018d5c3eb87bb537d83a4623b15ab3069b478e9d153cc5  (两行相同)
$ pnpm verify:bundle /tmp/acc-r2-a/heluo-forge-enterprise-0.1.0.tgz
bundle: heluo-forge-enterprise-0.1.0.tgz | 124 files | 1694126 bytes | sha256 c756e61e…
bundle: manifest ok (formatVersion 1, 6 packages)
bundle: ok   # exit 0
$ (cd /tmp/acc-r2-a && shasum -a 256 -c SHA256SUMS)   # 两行 OK
```
manifest 结构实测：键序 `formatVersion,entry,members,toolchain,tarball,files`；`members` 6 包；`toolchain {node:v24.13.0,npm:11.6.2}`；`files` 124 条升序；无 `20xx-…T` 时间戳、无 `/Users|/home`。

### 3.2 测试与既有审计（AC-3）
```text
$ node --test tests/bundle-verify.test.mjs tests/host-probe-gate.test.mjs tests/host-probe.test.mjs
ℹ tests 17 | pass 15 | fail 0 | skipped 2
$ pnpm check:tarballs   # bundles: 7 packed, 295 files; bundles: ok
```

### 3.3 构建边界（AC-4）
```text
$ node scripts/build-enterprise-bundle.mjs /tmp/acc-r2-a   # 已存在
bundle build: refusing to replace existing artifact heluo-forge-enterprise-0.1.0.tgz   # exit 1
$ npm_config_registry=http://127.0.0.1:9 npm_config_cache=/tmp/acc-empty-cache node scripts/build-enterprise-bundle.mjs /tmp/acc-r2-c
# exit 0，sha256 与在线构建一致
```

### 3.4 宿主门控（AC-12/AC-13）
```text
$ DSH_HOST_PROBE_FORCE=1 node --test tests/host-probe.test.mjs   # tests 2 | pass 0 | fail 2; exit 1
$ node scripts/probe/run-host-probe.mjs
probe: 0.2.1-rc.5 | node v24.13.0 | darwin-arm64
probe: ctx.tools.execute shape kind=object keys=[isError,error,content] resultsLength=n/a
probe: 12/32 checks passed, 1 blocked   # exit 1
```
非本分支引入：`git diff --stat origin/main HEAD -- <三文件>` 输出为空；HEAD blob 与 `origin/main` 逐一相同；工作区差异（42+/6-）为本单 T2 additive 改动。

### 3.5 AC-14 失败证据
```text
$ pnpm check
docs: 123 files, 880 tables, … 37 controlled documents
- docs/teamflow/20261106-r2/QA-REPORT.md: host-specific absolute path
docs: 1 error(s)   # exit 1，&& 链在 docs 段中止
```
根因：QA-REPORT.md 第 33 行把敏感扫描正则原样写入（含 `/Users`、`/home` 字面量），命中 `scripts/lib/doc-rules.mjs:226` 的 host-specific 规则。改为 `[/]Users[/]` 一类写法即可消除，不需要改规则。
skip 清单（3 条）：① `tests/host-probe.test.mjs` 两例（本单门控，AC-13 要求）；② `tests/sensitive-scan-windows-paths.test.mjs` 1 例（既有平台跳过，文件本轮未改动）。除 2 个门控外 0 新增 skip。

### 3.6 敏感扫描（AC-9）
`RUNBOOK.md`、`AC-EVIDENCE-TEMPLATE.md`、`HOST-PROBE-DISPOSITION.md`、`PRD.md`、`TECHNICAL.md` 对 `/Users`、`/home`、内网 IP、凭据模式均 0 命中；唯一命中在 QA-REPORT.md 的扫描命令文本（见 §3.5），非真实地址。

## 4. 架构一致性核查（蓝图对照）

- **蓝图落地**：`scripts/lib/bundle-archive.mjs`（`readBundleEntries`/`summarizeBundle`）、`scripts/lib/bundle-manifest.mjs`（`MANIFEST_FORMAT_VERSION`/`createBundleManifest`/`serialize…`/`parse…`/`diff…`/`serializeSha256Sums`）、`scripts/verify-enterprise-bundle.mjs`（`verifyBundle`）、`scripts/build-enterprise-bundle.mjs`（`buildBundle`/`buildEnterpriseBundle`/`writeBundleArtifacts`）、`scripts/lib/host-probe-gate.mjs`（`normalizeDshVersion`/`hostProbeGate`）、`package.json#verify:bundle`、`.gitignore#/artifacts/` 全部按蓝图落位，导出符号与调用点（核验器、构建 CLI、两处测试、探针）逐一对应，未见装配顺序或抽象缺失问题。
- **差异登记**：`readBundleEntries(source, { withContent })` 比 TECHNICAL §3.1 多一个可选参数（核验嵌套 `package.json` 所需，向后兼容），属文档滞后而非接口漂移，下次触碰 TECHNICAL 时补记。
- **重复实现评估**：`scripts/lib/bundle-rules.mjs#auditTarball` 与核验器结构规则确有部分重叠（`workspace:*`、tests、bin 模式），TECHNICAL §1 已明确“不合并以免回归 `check:tarballs` 语义”，核验器从 tarball 字节重新推导，属刻意取舍；`tests/bundle-gitee.test.mjs` 的 tar 读取器与新 lib 相邻，已登记后续抽 `tests/tar-fixture.mjs`。两者均不构成结构破坏。
- **结论**：无「偏离蓝图 / 重复实现 / 应抽未抽」导致的返工项；本轮不因架构判条件通过。

## 5. 未关闭项与整改要求（阻断关闭）

| 编号 | 位置 | 问题 | 整改 | 重验 |
|---|---|---|---|---|
| R1 | `docs/teamflow/20261106-r2/QA-REPORT.md:33` | 写入含 `/Users`、`/home` 字面量的扫描正则，check-docs 判 host-specific absolute path，`pnpm check` exit 1（AC-14） | 改写为 `[/]Users[/]`、`[/]home[/]` 等等价形式，或改引模板 §7 的脱敏规则；不改扫描器规则 | `pnpm check` exit 0、0 fail |
| R2 | `docs/teamflow/20261106-r2/RUNBOOK.md:859` | `DSH_HOST_PROBE_FORCE=1 …` 记 `NOT RUN`，实际已执行且 2 fail / exit 1（AC-8） | 改记 `FAIL`（K-1 取证，exit 1 / 2 fail），并指向 `HOST-PROBE-DISPOSITION.md §5` 的实测记录 | 台账与实测一致 |
| R3 | `docs/teamflow/20261106-r2/HOST-PROBE-DISPOSITION.md §3` | `git diff --stat origin/main -- …` 声称“输出为空”，交付树上为 3 files changed（AC-12② 复跑性，P3） | 改为 `git diff --stat origin/main HEAD -- …`（或注明“改动前工作区”并保留 blob 对照表） | 按文档命令复跑得到空输出 |
| R4 | 目标机项 | AC-1 重建、AC-14 的 rc.3 结果、S3–S7 profile、企业 IAM/Gitee/dop/私有 registry 联调、桌面 profile 面 | 在目标机按 RUNBOOK S2–S8 执行并回填四态，不得以本机 rc.5 结果代替 | 目标机证据归档 |

## 6. 意见与遗留

- 交付实质完整：四件套（可核验产物、RUNBOOK、证据模板、K-1 处置）均已落地，本机链路口径一致；`build → manifest/SHA256SUMS → verify:bundle` 可在离线目标目录独立复核，满足“交付的字节可核验”的核心目标。
- 环境阻断如实披露：目标机 v24.15.0 / rc.3、真实 profile 安装卸载、企业侧联调均 `NOT RUN`，且文档禁止用本机结果冒充，符合 PRD AC-1/AC-14 的取证纪律。
- K-1 issue 未登记（本单无远端写权限）：处置文档按“待登记 + 回填规则”处理，未虚报编号；登记后只需替换 §7 与 RUNBOOK 对应行。
- 本轮未发现 P0/P1/P2 实现缺陷；R1–R3 均为任务夹文档一行级修正，修完重跑 `pnpm check` 与对应复跑命令即可转 ✅。

验收结论：⚠️ 有条件通过

## 7. 整改复核（Lead 复跑，2026-11-06）

本节是验收结论之后的整改复核记录，不改写 §0–§6 的历史判定。

| 整改项 | 处理 | 复核命令与结果 | 状态 |
|---|---|---|---|
| R1 | `QA-REPORT.md:33` 的扫描正则改为 `[/]Users/`、`[/]home/` 等价写法（未改扫描器规则） | `node scripts/check-docs.mjs` → `docs: 124 files … 37 controlled documents`、`docs: ok`，exit 0 | 已关闭 |
| R2 | `RUNBOOK.md:859` 台账由 `NOT RUN` 改记 `FAIL`（`tests 2 / pass 0 / fail 2`，exit 1），§11 的 AC-8 口径同步补入 `FAIL` | `node --test tests/host-probe.test.mjs` → 2 skipped / exit 0；`DSH_HOST_PROBE_FORCE=1 …` → 2 fail / exit 1 | 已关闭 |
| R3 | `HOST-PROBE-DISPOSITION.md §3` 两条命令改为 `git diff … origin/main HEAD -- …` | 新写法复跑输出为空；旧写法（省略 `HEAD`，对比工作区）输出 `3 files changed, 42 insertions(+), 6 deletions(-)` | 已关闭 |
| R4 | 目标机项 | 未执行 | 仍 `NOT RUN` |

复跑汇总（本机 macOS arm64 / Node v24.13.0 / pnpm 11.28.5 / DSH 0.2.1-rc.5）：

- `check-docs` ok、`check-repo` ok（24 必填项 / 847 tracked files）、`check-bundle-tarballs` ok（7 packed / 295 files）、`dsh-version check` ok。
- `node --test`：`tests 2809 / pass 2805 / fail 1 / skipped 3`。
- 唯一失败为 `tests/keychain-spike.test.mjs`，报 `KEYCHAIN_BACKEND_FAILED: security add-generic-password failed (51)`。在干净 `origin/main` 的临时 worktree 复跑**同样失败**，且本分支未改动 `packages/forge-credentials-keychain/`、`scripts/probe/run-keychain-spike.mjs`、`tests/keychain-spike.test.mjs` ⇒ 属本机钥匙串环境状态，非本分支引入。

据此更新：AC-8 由 `FAIL` 转 `PASS`（台账与实测已一致）；AC-14 仍为 `FAIL`——docs 段已转绿，但整链 `pnpm check` 因上述钥匙串环境失败仍 exit 1，解锁钥匙串后复跑可望转绿。未关闭项收窄为 **AC-1（目标机）** 与 **AC-14（本机钥匙串环境 + 目标机 rc.3）**。
