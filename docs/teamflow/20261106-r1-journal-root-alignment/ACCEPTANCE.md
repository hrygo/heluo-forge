<!-- meta: summary="r1 验收通过：新 AC-9/G0 全部满足并解除 G0（本 run journal aligned/0、r13 反例 mismatch/1、负测 8/8、pnpm check 0 fail），无缺陷、架构符合蓝图；G1～G5/AC-10～AC-14 仍 NOT RUN/阻断，不因本单解除。" -->
# r1 Teamflow journal 收口根判据对齐 · 验收报告

> 验收：产品经理（最终验收）；日期：2026-11-06；被验：worktree `wt_c1be52eb5da6` · 分支 `feat/plugin-workflow-new` · HEAD `55e964c`（dirty，36 项未提交，与进入时一致）。依据：本夹 `TECH-CHANGE.md`（技术变更单，取代 r13#AC-9 与 r13#G0）；本单无功能 PRD。

## 1. 结论概要

- 本单新 AC-9 的四个条件与 G0 全部满足，**G0 解除**；验收独立复跑证据见 §4。
- 无 P0～P3 缺陷；架构一致性符合注入蓝图（M3 质量门通过）。
- 上游 r13 的 G1～G5、AC-10～AC-14 仍为 `NOT RUN`/阻断，**不因本单解除**；本报告只判定本技术变更单，不等于 r13 交付关闭。

## 2. 验收范围

| 交付物 | 角色 | 本单验收点 |
|---|---|---|
| `scripts/probe/check-teamflow-journal-roots.mjs` | 判据核心（只读证据探针） | 只认 `workspacePath` 两态；观测字段不翻判定；退出码 0/1/2 |
| `tests/teamflow-evidence-tools.test.mjs` | 负测（六类 + 矩阵两条） | 正例可判真、负例可判伪；矩阵两条用例未改 |
| `scripts/probe/README.md` | 现行真相（journal 段落） | 两态 + 观测字段 + 0/1/2 码表与实现一致 |
| `docs/teamflow/memory.md` | 团队记忆（证据纪律一行） | 与判据同源；仅一行幂等替换，未动并行 gitee 改动 |
| 本夹 `TECH-CHANGE.md` / `QA-REPORT.md` | 契约与代测证据 | 引用于本报告核对项 |

## 3. AC 逐条核对

| 编号 | 要求（TECH-CHANGE §3.1/§8） | 判定 | 证据 |
|---|---|---|---|
| AC-9-a | 本 run journal 的 `workspacePath` 经真实路径比较落在授权隔离工作树内，检查器 `aligned`/退出 0 | 通过 | E1、E2（相对根/绝对根两种写法均 `aligned`/0） |
| AC-9-b | `workspacePath` 缺失或越界时 `mismatch`/退出 1，且有可判伪负测 | 通过 | E1（8/8 含缺字段与越界）、E3（r13 真实反例 `mismatch`/1） |
| AC-9-c | `stateRoot`/`commitRoot` 记 unknown/观测，不作失败项或阻断项 | 通过 | E2（宿主不提供→两条 unknown，仍 0）、负测观测例（越界仍 0）、E6（宿主源码 0 命中） |
| AC-9-d | 本轮 0 次 stash/commit/merge/push | 通过 | E7（stash 0、reflog 仍 `55e964c`、无 merge/rebase） |
| G0 | 以「本 run journal + 检查器 aligned」为解除条件 | **解除** | E2 |
| 基线 | r13 的 AC-1～AC-8 证据与代码不回退 | 保持 | 本轮未改 `packages/**`、宿主、r13 夹（E7：r13 夹今日 0 文件变更） |
| 阻断项 | G1～G5、AC-10～AC-14 | NOT RUN | 无新增证据；TECH-CHANGE 明确不因本单解除 |

## 4. 验收独立复跑（2026-11-06 09:00–09:02 CST，本 worktree）

| # | 命令（仓库根） | 实际 | 退出码 | 来源类型 |
|---|---|---|---|---|
| E1 | `node --test tests/teamflow-evidence-tools.test.mjs` | 8 pass / 0 fail | 0 | local-execution |
| E2 | `node scripts/probe/check-teamflow-journal-roots.mjs --journal $DSH_HOME/teamflow/ws-wt_c1be52eb5da6-80d416d6/runs/tf-mw48lm9l-g7st52.json --root "$PWD"` | `aligned`；stderr 两条 `unknown (host does not provide)` | 0 | local-execution |
| E3 | 同上，`--journal $DSH_HOME/teamflow/ws-heluo-forge-eda4cf81/runs/tf-mw3hury1-cykbxm.json` | `mismatch`；`workspacePath outside authorized root: <主工作树>` | 1 | local-execution |
| E4 | 无 `--journal` | `NOT RUN (no journal)`（缺证≠通过） | 0 | local-execution |
| E5 | `pnpm check` | 2728 用例 / 2727 pass / 1 skip（Windows 8.3）/ 0 fail，52.2 s | 0 | local-execution |
| E6 | 只读核验宿主 `dsh-plugin-teamflow@0.3.3`：`host.mjs:3880 workspaceScopeOf` 取 `session.header.cwd`；`stateRoot`/`commitRoot` 0 命中 | 与判据前提一致 | — | host-execution（只读） |
| E7 | `git diff --check`；`git status --porcelain`；`git stash list`；`git reflog -1`；r13 夹今日修改文件数 | 0；36 项（22 M + 14 ??，含本单 3 个新/改文件）；0 条；`55e964c`；0 | 0 | local-execution |

环境：macOS 26.5.1、Node v24.13.0、pnpm 11.28.5（仓库 `.node-version` 为 24.21.0，差异如实记录，未升级环境）。

## 5. 架构一致性（M3 强制）

- 符合注入蓝图：改动只落「只读证据探针 + 其负测 + 探针 README journal 段 + memory 一行」，未抽取新模块、未改产品/宿主代码、未新增目录或根级脚本。**无重复实现、无偏离蓝图、无该拆未拆、无破坏既有结构。**
- 判据单点：`DECIDING_FIELD = 'workspacePath'` 与 `OBSERVED_FIELDS` 为内部常量（探针 :23/:25，未导出）；`status` 只在 `classifyJournalRoots` 产生，status→退出码映射只在 `main` 一处；`unknown` 已非终态。
- 依赖单向：tests → probe；探针不依赖用例。矩阵探针与两条矩阵用例未改（9/9 夹具断言仍绿），符合「本轮只改 journal 部分」。
- 路径比较实现与既有两处同类代码并存，蓝图已定本轮不抽 `scripts/lib/path-scope.mjs`，理由成立（探针需零依赖只读、安全工具语义更严），未新增其它副本。
- 仓面卫生：`logs/` 被 `.gitignore:81` 覆盖；无构建/缓存/密钥进入提交面；历史任务夹字节不变。

## 6. 缺陷与观察

- 缺陷表：**无 P0/P1/P2/P3 缺陷**。
- 观察（不阻断）：`--journal` 带旗无值会被当作「无 journal」→ `NOT RUN`/0。不会造成假通过（NOT RUN≠aligned），建议后续单据收紧为退出 2。
- 观察（文档）：探针 README 小节标题仍写「（r13，只读）」，正文已按 r1 判据更新；矩阵段按契约原样保留，属预期。
- 观察（代码）：`realOf` 外层 `try/catch` 为防御性死代码，仅影响可读性。

## 7. 未验项与遗留（不因本单解除）

- G1～G5、AC-10～AC-14 仍 `NOT RUN`/阻断，无新增证据。
- Windows/麒麟实机路径语义（反斜杠、盘符大小写、8.3 短路径）未跑；仅 macOS 实测。
- 宿主升级后须重核 `workspaceScopeOf` 归属键（TECH-CHANGE R1）；本单以 0.3.3 事实为准。
- r13 历史夹的旧三态口径按 ADR-0008 保留不改写，只以本单「取代」声明为准；后续报告须按新码表读退出码。
- 本阶段 0 次 stash/commit/push/merge，提交与合并需另行授权。

## 8. 放行建议

本单交付通过验收，可进入提交/合并流程（待授权）；r13 基线与 G1～G5/AC-10～AC-14 保持阻断，不得据此写成 r13 交付关闭。

验收结论：✅ 通过
