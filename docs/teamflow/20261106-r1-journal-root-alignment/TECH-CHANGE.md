<!-- meta: summary="技术变更单：Teamflow journal 收口根判据由三根收窄为只看 workspacePath，stateRoot/commitRoot 宿主不提供、记 unknown 不作失败项；同步检查器、负测、探针说明与本需求 AC-9/G0，并用本 run journal 复跑取证。" -->
基线依赖：docs/teamflow/20261105-r13-r12-issue-rework/（AC-1～AC-8 及其证据为本轮不回归基线；历史夹按 ADR-0008 不改写，判据变更以本单声明）
取代：docs/teamflow/20261105-r13-r12-issue-rework/#AC-9（判定口径）
取代：docs/teamflow/20261105-r13-r12-issue-rework/#G0（§5 首行解除条件）

# 技术变更单：Teamflow journal 收口根判据对齐

> 编制：技术负责人（代拟）；日期：2026-11-06；类型：技术判据修正（tech-driven rework），不新增用户可见功能，不出功能 PRD。

## 1. 背景与目标

一句话：宿主 Teamflow 的运行归属只由会话 cwd 决定、journal 中不存在 `stateRoot`/`commitRoot`，故 G0/AC-9 的通过条件应为「journal 的 `workspacePath` 落在授权隔离工作树内」，并按此用本 run 复跑取证。

### 1.1 已核验事实（2026-11-06，本机）

- `dsh-plugin-teamflow` 0.3.3 `lib/host.mjs:3880` 的 `workspaceScopeOf(agent)` 取 `agent.session.header.cwd`（经 workspace 注册表归一）作为 run 的 `workspacePath`；`productRoot` 只是产品线标识/相对子目录（同文件 2215–2221 有注释说明），`working_directory` 不改变归属。
- `stateRoot`、`commitRoot` 在 0.3.2 与 0.3.3 的 `lib/host.mjs` 中均 0 命中：宿主不提供这两个字段。
- 本 run 的 journal（`$DSH_HOME/teamflow/ws-wt_c1be52eb5da6-80d416d6/runs/tf-mw48lm9l-g7st52.json`）`workspacePath` 等于授权工作树；`stateRoot`/`commitRoot` 不存在。
- 现行检查器对同一 journal 实跑输出 `journal-roots: unknown`、退出码 2（两条 `missing`），把「宿主不提供」误判成「未对齐」，证伪了旧三根判据。
- r13 的 run 记录 `workspacePath` 指向主工作树，是真实反例：新判据下仍必须判 `mismatch`/退出 1。

## 2. 影响范围

| 文件 | 改动 |
|---|---|
| `scripts/probe/check-teamflow-journal-roots.mjs` | 判据核心：只以 `workspacePath` 定 `aligned`/`mismatch`；`stateRoot`/`commitRoot` 降为观测字段 |
| `tests/teamflow-evidence-tools.test.mjs` | 正例、三个负例（越界/缺失/观测字段越界不失败）、CLI 退出码与 NOT RUN |
| `scripts/probe/README.md` | 三态说明改为两态 + 观测字段，更新用法与退出码 |
| `docs/teamflow/memory.md` | 「证据纪律」同主题行追加 journal 归属判据（一行，幂等替换） |
| 本任务夹 `QA-REPORT.md`/`ACCEPTANCE.md` | 后续阶段按本单 AC-9/G0 取证与判定 |
| 不改 | `packages/**`、宿主与 profile、`docs/teamflow/20261105-*` 历史夹、既有能力实现 |

非目标：不新增 `--json` 输出、不引入新依赖、不改宿主、不把观测字段做成门禁、不顺带修复其它检查器问题。

## 3. 技术方案（要点）

### 3.1 判据（唯一通过条件）

- `aligned`：`journal.workspacePath` 存在、非空，且经 `realpath` 归一后等于授权根或在其下；退出 0。
- `mismatch`：`workspacePath` 缺失/空/不可解析，或越界（主工作树、别的 worktree）；逐条给原因，退出 1。
- `stateRoot`/`commitRoot`：**仅观测，不参与判定**。缺失记 `unknown`（宿主不提供，不是失败、不是阻断）；存在则记 `within`/`outside` 并打印，同样不改 status 与退出码。报告中禁止据此写成「三个根都对齐」。
- 退出码：`0` aligned 或无 `--journal`（打印 `NOT RUN`）；`1` mismatch；`2` 用法/IO 错误（缺 `--root`、文件不存在、JSON 不可读）。`unknown` 不再作为终态。

### 3.2 接口与实现

- 保留纯函数签名 `classifyJournalRoots({ authorizedRoot, journal })`，返回 `{ status, reasons, fields, optional }`：`fields.workspacePath` 为归一后路径；`optional` 形如 `{ stateRoot: 'missing'|'within'|'outside', commitRoot: … }`；`reasons` 只放影响判定或值得披露的句子，负例断言可匹配到字段名。
- 保留 `realOf`/`within` 的别名与「路径尚不存在」处理（`/var` 与 `/private/var` 之类别名不回归）。
- CLI 只读 journal 顶层字段，不调用宿主 API、不回写 journal；观测字段输出到 stderr（`journal-roots: stateRoot unknown (host does not provide)`），stdout 只留结论行。
- 判据常量只保留 `workspacePath` 与观测字段两处，避免代码/文档两套真相。

### 3.3 测试矩阵（正反例都必须可判伪）

| 用例 | 输入 | 期望 |
|---|---|---|
| 正例 | 仅 `workspacePath` 在授权根内 | `aligned`，退出 0，stderr 提示 unknown 但无失败语义 |
| 负例 A | `workspacePath` 指主工作树 | `mismatch`，退出 1，原因含 `workspacePath outside authorized root` |
| 负例 B | 无 `workspacePath`（有其它字段） | `mismatch`，退出 1，原因含 `workspacePath missing`（不再 unknown） |
| 观测例 | `stateRoot`/`commitRoot` 存在但越界 | 仍 `aligned`/退出 0，输出标注 `outside` |
| 缺证 | 无 `--journal` | `NOT RUN (no journal)`，退出 0 |
| 用法错 | 有 `--journal` 无 `--root` / 文件不存在 | 退出 2 |

真实样本复跑：本 run journal → `aligned`/0；r13 run 记录 → `mismatch`/1。两者都必须在 QA 报告中带命令、时间与退出码。

## 4. 行为兼容性影响

- 用户可见行为：**无**。只改证据探针、负测、探针说明与团队记忆，不改插件运行时、配置面或宿主。
- 对 QA/验收可见：同一 journal 由 `unknown`/2 变为 `aligned`/0；缺 `workspacePath` 由 `unknown`/2 变为 `mismatch`/1。旧判读须同步（README 写明新码表）。
- 硬门从「三根」收窄为 `workspacePath`：失去另两字段兜底，由「观测值必须出现在输出与报告」补偿；这是用户已确认的口径，不是遗漏。
- AC-1～AC-8 的已通过证据与代码不回退，r13 基线不因本单关闭。

## 5. 回归与验证方案

在仓库根（授权工作树）逐条实跑，记录命令、时间、退出码、来源类型：

```sh
node --test tests/teamflow-evidence-tools.test.mjs
node scripts/probe/check-teamflow-journal-roots.mjs \
  --journal "$DSH_HOME/teamflow/ws-wt_c1be52eb5da6-80d416d6/runs/tf-mw48lm9l-g7st52.json" \
  --root "$PWD"          # 期望 aligned，退出 0
node scripts/probe/check-teamflow-journal-roots.mjs --journal <r13 run 记录> --root "$PWD"   # 期望 mismatch，退出 1
pnpm check
git diff --check
```

回归底线：`pnpm check` 全绿（docs/repo/tarballs/`node --test` 0 fail）；不新增检查器豁免、不放宽 sensitive-scan；`packages/**` 与宿主零改动；0 次 stash/commit/push/merge/`reset --hard`/`checkout --`；历史任务夹字节不变（`git status` 不出现 r13 夹）；现有未提交改动完整保留。

## 6. 风险与回滚

- R1 判据收窄后，若宿主未来更换归属键，只盯 `workspacePath` 会漏判：观测字段与负测留痕，升级 Teamflow 后重核 `workspaceScopeOf`。
- R2 退出码 2→1 的语义变化可能被旧脚本误读为「越界」：README 与本单注明，QA 报告按新码表判定。
- R3 文档与实现漂移（README/本单/报告三处）：判据常量单点、负例断言输出文本。
- 回滚：只涉及检查器/负测/README/memory 一行，纯离线、无迁移、无依赖变更；按文件恢复旧版本即回到三态判据，不影响交付物。

## 7. 假设与待澄清

- 假设：本环境实际生效的 Teamflow 为 0.3.x（0.3.2/0.3.3 已核）；升级到其它版本须重取 `workspaceScopeOf` 与字段证据，不沿用本单 1.1。
- 选择：`stateRoot`/`commitRoot` 即使存在且越界也不判失败（用户明确「不得作为失败项」）；若要求「存在即校验」，把观测分支改为失败分支并加一条负测即可。
- 选择：`workspacePath` 缺失判 `mismatch` 而非 `unknown`（用户口径）；若要保留「未取证」语义，改回 `unknown`/2 并同步 README 与报告。
- 边界：历史任务夹按 ADR-0008 不改写，只以「取代」声明；如需回改 r13 夹正文，须单独授权。

## 8. 下游接口（dev / QA / 验收）

- dev：按 §3 改三个文件 + memory 一行；自检 §5 前两条命令，交本 run 实跑输出与退出码。
- QA：复跑 §5 全部命令，正反例与真实样本都给出退出码；AC-9 判定只看 journal-roots 结论 + 0 次 stash/commit/merge/push。
- 新 AC-9（取代 r13#AC-9）：P0 — 本 run journal 的 `workspacePath` 落在授权隔离工作树内（真实路径比较），检查器 `aligned`/退出 0；缺失或越界时 `mismatch`/1 且有可判伪负测；`stateRoot`/`commitRoot` 记 unknown/观测，不作失败项；本轮 0 次 stash/commit/merge/push。
- G0（取代 r13#G0）：以「本 run journal + 检查器 aligned」为解除条件；G1～G5 与 AC-10～AC-14 不因本单解除，仍为 `NOT RUN`/阻断。
