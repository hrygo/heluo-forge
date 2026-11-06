<!-- meta: summary="r1 QA：journal 收口根判据收窄为只看 workspacePath 后，本 run journal 实测 aligned/0、r13 真实反例 mismatch/1，六类负测 8/8 通过，pnpm check 2727 pass/0 fail；stateRoot/commitRoot 仅观测不翻判定；本单 AC-9 与 G0 通过、无缺陷，G1～G5 与 AC-10～AC-14 仍 NOT RUN/阻断。" -->

# r1 Teamflow journal 收口根判据对齐 · QA 报告

> 执行者：QA（代测，非独立审查）。日期：2026-11-06。被检版本：worktree `wt_c1be52eb5da6`，分支 `feat/plugin-workflow-new`，HEAD `55e964c`（`dirty=true`，36 项未提交改动）。本报告只判定本技术变更单（TECH-CHANGE.md）的 AC-9/G0，不代表 r13 上游需求整体可通过。

## 1. 结论

**本单范围内通过 / 验收就绪。** 新 AC-9 与 G0 的四个条件均有可复跑证据：本 run journal 判 `aligned`/退出 0，r13 run 记录（真实反例）判 `mismatch`/退出 1，六类负测 8/8 通过，`pnpm check` 0 fail，且本轮 0 次 stash/commit/merge/push。

- **未发现缺陷**（P0/P1/P2/P3 均无，含架构与接口一致性核查）。
- 上游 r13 的 G1～G5 与 AC-10～AC-14 仍为 `NOT RUN`/阻断，**不因本单解除**，不得据此写成 r13 交付关闭。
- 判据已收窄为只认 `workspacePath`：本报告不写成「三个根都对齐」；`stateRoot`/`commitRoot` 只按 `unknown`/观测披露。

## 2. 范围与环境

| 项 | 值 | 来源类型 |
|---|---|---|
| 被检改动 | `scripts/probe/check-teamflow-journal-roots.mjs`（判据核心，新文件）、`tests/teamflow-evidence-tools.test.mjs`（负测，新文件）、`scripts/probe/README.md`（journal 段）、`docs/teamflow/memory.md:15`（证据纪律一行）、本任务夹 `TECH-CHANGE.md` | local-execution |
| 声明不改 | `packages/**`、宿主与 profile、`docs/teamflow/20261105-*` 历史夹；本轮核对 r12/r13 夹今日 0 个文件被修改 | local-execution |
| 宿主 | `dsh-plugin-teamflow` 0.3.3（`$DSH_HOME/profiles/desktop/node_modules/.../lib/host.mjs:3880` 的 `workspaceScopeOf` 取 `session.header.cwd`；`stateRoot`/`commitRoot` 各 0 命中） | host-execution（只读核验） |
| Node / pnpm | `v24.13.0` / `11.28.5`；仓库 `.node-version` 为 `24.21.0`，版本差异如实记录，未升级环境 | local-execution |
| 平台 | macOS 26.5.1（25F80），Asia/Shanghai；Windows/麒麟未实测 | local-execution / NOT RUN |
| 浏览器 | 交付为只读 CLI 探针 + 负测 + 文档，无可视 UI，未使用浏览器 | N/A |

数据样本：本 run journal `$DSH_HOME/teamflow/ws-wt_c1be52eb5da6-80d416d6/runs/tf-mw48lm9l-g7st52.json`（`workspacePath` = 授权工作树，另两字段不存在）；r13 run 记录 `$DSH_HOME/teamflow/ws-heluo-forge-eda4cf81/runs/tf-mw3hury1-cykbxm.json`（`workspacePath` = 主工作树 `<主工作树>`，本机绝对路径已脱敏）。

## 3. AC-9 / G0 判定

| 条件（TECH-CHANGE §3.1/§8） | 判定 | 证据 |
|---|---|---|
| 本 run journal 的 `workspacePath` 经真实路径比较落在授权隔离工作树内，检查器 `aligned`/退出 0 | 通过 | U2、U3（`--root .` 与 `--root "$PWD"` 同为 `aligned`/0） |
| `workspacePath` 缺失或越界时 `mismatch`/退出 1，且负测可判伪 | 通过 | U4（真实反例）、U5（缺失）、U1（负例断言字段名） |
| `stateRoot`/`commitRoot` 记 `unknown`/观测，不作失败项或阻断项 | 通过 | U2（宿主不提供→两条 unknown，仍 aligned/0）、U10（观测字段越界仍 aligned/0） |
| 本轮 0 次 stash/commit/merge/push | 通过 | U15（stash 0、无 MERGE_HEAD/rebase、reflog 无 2026-11-06 条目、HEAD 仍 55e964c） |
| **G0**（以「本 run journal + 检查器 aligned」为解除条件） | **解除** | U2、U3 |
| G1～G5、AC-10～AC-14 | NOT RUN / 阻断 | 本单明确不解除；无新增证据，不属本单范围 |

## 4. 用例与结果

| 编号 | 用例 | 命令（仓库根） | 期望 | 实际 | 结论 |
|---|---|---|---|---|---|
| U1 | 负测全集 | `node --test tests/teamflow-evidence-tools.test.mjs` | 8/8 通过 | 8 pass / 0 fail，退出 0 | 通过 |
| U2 | 本 run journal（相对根） | `node scripts/probe/check-teamflow-journal-roots.mjs --journal <本 run> --root .` | `aligned`/0，stderr 两条 unknown | stdout `journal-roots: aligned`，退出 0 | 通过 |
| U3 | 本 run journal（绝对根） | 同上，`--root "$PWD"` | `aligned`/0 | 同 U2，退出 0 | 通过 |
| U4 | r13 真实反例 | 同上，`--journal <r13 run> --root .` | `mismatch`/1，原因点名 `workspacePath` | stdout `mismatch`，stderr `workspacePath outside authorized root: <主工作树>`，退出 1 | 通过 |
| U5 | 缺字段 journal | `{}` 写入临时文件后跑 CLI | `mismatch`/1，原因 `workspacePath missing` | 命中，退出 1（旧 `unknown`/2 已消失） | 通过 |
| U6 | 无 journal | `node ... check-teamflow-journal-roots.mjs` | `NOT RUN (no journal)`/0 | 命中，退出 0 | 通过 |
| U7 | 有 journal 无 root | `--journal <valid>` | 退出 2 | `--root is required with --journal`，退出 2 | 通过 |
| U8 | journal 不存在 | `--journal <missing> --root <dir>` | 退出 2 | `journal not found`，退出 2 | 通过 |
| U9 | journal 不可解析 | 写入 `{bad` 后跑 CLI | 退出 2 | `unreadable journal: ...`，退出 2 | 通过 |
| U10 | 观测字段越界 | journal 仅 `stateRoot` 越界、`workspacePath` 在根内 | `aligned`/0，标注 outside | `aligned`/0，stderr `stateRoot outside ... (observational, not a failure)` | 通过 |
| U11 | 符号链接逃逸 | 根内 symlink 指向根外作 `workspacePath` | `mismatch`/1 | 真实路径解析到根外，`mismatch`/1 | 通过 |
| U12 | 前缀/穿越 | 兄弟目录 `<root>-evil`、`<root>/../<root>-evil` | 均 `mismatch` | 均 `mismatch`（`within` 用 `root+sep` 前缀，不强匹配） | 通过 |
| U13 | 全量门禁 | `pnpm check` | 0 fail | 2728 用例：2727 pass / 1 skip（Windows 8.3）/ 0 fail，退出 0 | 通过 |
| U14 | 空白/差异卫生 | `git diff --check` | 退出 0 | 退出 0 | 通过 |
| U15 | 仓面与写动作 | `git status --porcelain`、`git stash list`、`git reflog -1`、`git rev-parse --git-path MERGE_HEAD` | 无依赖/构建/缓存/密钥；0 次写动作 | 36 项（22 M + 14 ??: 产品改动与任务夹/探针）；stash 0；无 merge/rebase；reflog 最后一条为 2026-11-05 15:55 | 通过 |
| U16 | 宿主前提核验 | 只读查看 0.3.3 `lib/host.mjs:3880` 并统计字段 | 归属取 cwd、两字段不提供 | `workspaceScopeOf` 取 `session.header.cwd`；两字段 0 命中 | 通过 |

## 5. 架构与接口一致性（强制项）

- **蓝图对照（符合）**：改动只落在「只读证据探针 + 其负测 + 探针 README」，未抽取新模块、未改产品/宿主代码；探针仅依赖 `node:fs`/`node:path`/`node:url`，零业务依赖，只读取 journal 顶层字段，可在裸 checkout 与不同 worktree 复跑。
- **判据单点**：`DECIDING_FIELD`（check-teamflow-journal-roots.mjs:23）与 `OBSERVED_FIELDS`（:25）为内部常量、未导出；`status` 只在 `classifyJournalRoots` 产生，`status→退出码` 映射只在 `main` 一处（:166），`reasons` 不重复推导；`unknown` 已不是终态。
- **重复实现（蓝图明确接受）**：`realOf`/`within` 与 `scripts/sensitive-scan/team-full-install.mjs`、`scripts/lib/bundle-rules.mjs` 的同类路径比较并存；蓝图已定「本轮不抽取 `scripts/lib/path-scope.mjs`」，理由（探针零依赖只读、安全工具语义更严）成立，未新增其它副本。
- **接口一致性（静态核验通过）**：负测导入的 `classifyJournalRoots` 在探针 :69 `export`；`SCENARIOS`（矩阵探针 :32）、`runFixtures`（:127）、`validateReport`（:183）均在目标模块导出。调用参数形状与签名一致（`{authorizedRoot, journal}`、`{root}`、`(text)`）；矩阵探针两条既有用例未改且通过。依赖单向（tests → probe），探针不反向依赖用例。
- **现有结构**：无新增目录/根级脚本；`logs/teamflow/` 仍被 `.gitignore:81` 覆盖，未污染提交面。
- **工艺（craft）**：无 UI，N/A。

## 6. 交付形态与仓面卫生

- 本阶段未注入「交付形态契约」；交付形态为「可执行 CLI + 纯函数库 + 负测 + 文档」，已按可执行路径验证（U1～U12），无需安装/装载类检查。
- 提交面：`git status --porcelain` 36 项中无 `node_modules/`、`.pnpm-store/`、`__pycache__/`、`target/`、`dist/`、`.idea/`、`.env`、`coverage`；`logs/` 与 tarball 均被忽略。r12/r13 历史任务夹今日结论未改动（ADR-0008 不变式成立），仅为通过团队 sensitive-scan 做了 4 处等价措辞替换（3 个文件，语义、AC 与判定不变）。

## 7. 缺陷表

未发现缺陷。

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|

## 8. 人工补测清单

| 项 | 验收标准 | 方法 / 工具 | 说明 |
|---|---|---|---|
| Windows 实机路径语义 | `node --test tests/teamflow-evidence-tools.test.mjs` 8/8；两条真实 journal 命令退出码与 macOS 一致 | Windows 11 + Node 24 实机复跑 U1～U4；关注反斜杠、盘符大小写、8.3 短路径 | 环境限制（本轮 macOS 26.5.1），非交付缺陷；`pnpm check` 已含 Windows 8.3 跳过的既有用例 |
| 宿主升级后重核 | 新宿主版本仍以 `session.header.cwd` 写 `workspacePath`；两观测字段若出现需如实披露 | 升级 Teamflow 后重读 `workspaceScopeOf` 并复跑 U2/U4 | 判据收窄风险 R1（TECH-CHANGE §6）；非本单缺陷 |

## 9. 观察与风险（非缺陷，不阻断）

- `--journal` 带旗无值（如命令以 `--journal` 结尾）会被当作「无 journal」→ `NOT RUN`/0，而非用法错误/2。`NOT RUN` 不等于 `aligned`，不会让 AC-9 假通过，但建议后续单据将其收紧为退出 2。
- `realOf` 自身不抛错，调用处的外层 `try/catch` 为防御性死代码，仅影响可读性。
- 判据收窄后仅盯 `workspacePath`：宿主若更换归属键需重核（R1）；报告中不得把观测字段写成「已对齐」。

## 10. 证据时间线（本机 CST）

| 时间 | 命令 | 结果 |
|---|---|---|
| 2026-11-06 08:53:22 | `... check-teamflow-journal-roots.mjs --journal <本 run> --root "$PWD"` | `aligned`，退出 0 |
| 2026-11-06 08:53:22 | `... check-teamflow-journal-roots.mjs --journal <r13 run> --root "$PWD"` | `mismatch`，退出 1 |
| 2026-11-06 08:54:57 | `node --test tests/teamflow-evidence-tools.test.mjs` | 8 pass / 0 fail，退出 0 |
| 2026-11-06 08:54:57 | `git diff --check`；`git stash list`；`git reflog -1` | 退出 0；0 条；最后一条 2026-11-05 |
| 2026-11-06 08:50–08:51 | `pnpm check` | 2728 用例 / 2727 pass / 1 skip / 0 fail，51.4 s，退出 0 |
| 2026-11-06 08:49–08:56 | U5～U12 负例、符号链接、前缀/穿越、空 journal、无 journal、用法/IO | 退出码 1/2/0 均与契约一致 |
