# 验收报告 · r8 Windows CLI 入口不再按后缀拦截（能保存 ≠ 能跑起来）

- 需求：`docs/teamflow/20261030-r8-win-cli-path-validation/PRD.md`（AC-1…AC-12）；架构：同夹 `TECHNICAL.md`；测试证据：同夹 `QA-REPORT.md`
- 被测交付：`feat/devops-change-flow` 工作区未提交改动，16 个修改文件 + 4 个新增路径（`src/entry-form.mjs`、`test/entry-form.test.mjs`、r7/r8 任务夹）；产品线 `packages/forge-devops`
- 验收环境：Darwin arm64，Node v24.13.0；验收时段 2026-10-30 20:08–20:11 (+08:00)；来源类型＝本地实跑 + 静态审计 + 变异实验 + 历史记录（r6 基线，仅作对照）
- 结论：**通过**，无阻塞项；4 条 P3 观察 + 1 条跨包遗留（已登记为独立后续需求）见 §4。

## 1. 本轮独立复验（不依赖 QA 自述，全部亲手执行）

| # | 目的 | 命令 | 结果 |
|---|---|---|---|
| A1 | AC-1…AC-9 契约 | `node logs/teamflow/tf-mvuuvtsy-z0qvk7/scripts/qa-r8-contract.mjs` | exit 0：**26 passed / 0 failed** |
| A2 | AC-10 回归基线 | `pnpm check` | exit 0：docs 71 files/581 表/580 链接 ok；repo 24 entries/641 tracked ok；bundles 8 包/179 文件 ok；version ok；`node --test` **1510 tests / 1507 pass / 0 fail / 3 skip / 0 todo**（11.1s） |
| A3 | AC-10 空白卫生 | `git diff --check` | exit 0 |
| A4 | AC-10 包内用例 | `cd packages/forge-devops && node --test` | exit 0：**496 pass / 0 fail / 0 skip**（r6 基线 477，只增不减） |
| A5 | AC-10 变异实验（本轮重做） | 备份 → 把 `src/entry-form.mjs:138` win32 分支改为 `/\.exe$/iu.test(name)` → `node --test test/cli-config.test.mjs test/entry-form.test.mjs` → 还原 | 变异版 exit 1：**2 条转红**（「AC-1 六形态放行」「isDirectlyExecutable：win32 六形态全 true」）；还原后 sha256 `a6c9b76f…d7afad5` 与备份**逐字节一致**，重跑 33/33 绿 |
| A6 | AC-4 / AC-6 静态审计 | grep 定义点与子进程出口 | `WRAPPER_SUFFIXES`/`isDirectlyExecutable`/`describeSpawnFailure` 在 `src/` **各仅 1 处定义**（`entry-form.mjs:39/:129/:210`）；4 个消费者 import；`cli-discovery.mjs:47` 再导出；唯一 `execFile` 在 `cli-runner.mjs:28`，`shell:false` 未放宽 |
| A7 | AC-7 页面后缀残留 | `grep -n "WRAPPER_PATTERN\|wrapperScript\|\.exe" packages/forge-devops/client.js` | **零命中** |
| A8 | AC-8 旧口径 | 全库 grep（排除 `docs/teamflow/2026*`、logs、node_modules） | 唯一命中为 `test/cli-config.test.mjs:536` 守门注释自身（「不许再出现」），用户可见面零命中 |
| A9 | AC-8 memory 口径 | `git diff docs/teamflow/memory.md` | 同主题行**替换**（1 行，无追加日志）；`sourceType` 措辞随 AC-9 改为「入口均已解析」 |
| A10 | AC-12 卫生 | `git status --porcelain` + `git diff` 正则扫描 | 16 M + 4 ??（r7/r8 任务夹、entry-form 源码+测试）；无 tgz/logs/dist/node_modules/.DS_Store；diff 与新增文件对本机绝对路径/真实用户名**零命中** |
| A11 | AC-12 skip 归属 | `node --test`（全仓）提取 skip 说明 | 3 条均为**环境门**（2 条 bundle install rehearsal 需 dsh+npm、1 条宿主探针缺目标 dsh），r6 基线即有，非本需求引入 |

## 2. 逐条 AC 判定

| AC | 优先级 | 判定 | 依据 |
|---|---|---|---|
| AC-1 Windows 保存不按后缀拦截 | P0 | **通过** | 六形态（无后缀/`.cmd`/`.ps1`/`.bat`/`.exe`/`.EXE`）校验与补丁一致 ok；补丁原值逐字（不补后缀、不改大小写、`C:/tools/dop.cmd` 不转反斜杠）；`origin=config`（A1 + `cli-config.test.mjs` 24 例，A5 变异可证） |
| AC-2 仍拒明显无效值且文案指向真问题 | P0 | **通过** | 不存在→「找不到这个文件」；目录→「这是目录…可执行文件本体」（实测不含 `.exe`/`.cmd`）；非普通文件、POSIX 执行位、空值清层、非路径四字段拒绝语义未变；一字段非法整包 422 且其余字段不丢（A1） |
| AC-3 自动发现同口径 + 原生 `.exe` 优先 | P0 | **通过** | win32 候选名六项顺序即优先级；跨目录 `C:\a\dop.cmd` 先扫仍让位 `C:\b\dop.exe`（`found[0]`）；`rejected` 恒 `[]`；预算 200 目录/250ms 不变（A1） |
| AC-4 形态判定单点 | P1 | **通过** | 定义各 1 处（A6）；`cli-discovery` 与 `entry-form` 同一引用；`.exe` 字样只余形态分类一行；保存侧/发现侧无第二份后缀规则 |
| AC-5 运行期失败准确可行动 | P0 | **通过**（口径差 1 处，Q-1） | `describeSpawnFailure` 三段齐全（形态判断 / 归因运行时能力「与路径写法无关」/ 下一步指向原生可执行文件）；脱敏不含绝对路径与 endpoint；只依赖形态 + `exitCode===null`，EINVAL/ENOENT 均覆盖；写动作 fail-closed、不重放（`actions.mjs:321-322` 记 `failed` 并注「命令未启动（无副作用）」） |
| AC-6 执行与安全边界零放宽 | P0 | **通过** | 唯一 `execFile` + `shell:false` + 超时 + 1 MiB；`src/` 无 `spawn`/`execSync`/`cmd.exe /c`/`shell:true`；`cli-runner.mjs`/`actions.mjs` 零 diff（A6） |
| AC-7 页面双面口径一致 | P0 | **通过** | `client.js` 零后缀残留（A7）；blur 只剩 4096 长度；`error.wrapperScript` 中英成对删除；vm 装载真实 `client.js` 通过；跨面矩阵 12 条与页面 3 键/服务端 6 键逐行对齐（A1、A4 内 34 例） |
| AC-8 文档口径同步 | P1 | **通过** | README 新增「能保存 ≠ 一定能跑起来」并给原生二进制建议；memory 同主题替换；旧口径用户可见面零命中（A8/A9） |
| AC-9 ready 语义不撒谎 | P1 | **通过** | `Access` 仍 7 键、`entries` 仍 6 字段，无「已验证/可直接执行」新字段；`detail.spawnFailed:true` 保留；memory 措辞同步为「入口均已解析」 |
| AC-10 回归基线 + 用例改写纪律 | P0 | **通过**（skip 字面见 Q-4） | `pnpm check` + `git diff --check` 全绿（A2/A3）；包内 496 例只增（A4）；4 个测试文件按新口径改写而非整段删除；变异 2 红 + 逐字节还原（A5） |
| AC-11 证据纪律 | P1 | **通过** | QA 报告每条含命令/时间窗/宿主版本/目标对象/来源类型；实机与真实 shim 标 NOT RUN（§5） |
| AC-12 仓库卫生 | P1 | **通过** | 分支 `feat/devops-change-flow` 未变；r7 夹 PRD（mtime 19:04）内容为 r7 自身判定目录需求、零处涉及 r8，本轮未改；交付面无本机路径/用户名；`.gitignore` 覆盖 node_modules:39/.pnpm-store:40/dist:41/coverage:43/\*.tgz:57/logs:81（A10/A11） |

## 3. 架构一致性核查（M3 质量门）

- **蓝图逐项落地**：`src/entry-form.mjs`（230 行、仅 `import path from 'node:path'`、无 IO）导出 7 个符号，与蓝图接口逐字对应（`WRAPPER_SUFFIXES`/`ENTRY_FORMS`/`wrapperSuffixOf`/`entryFormOf`/`isDirectlyExecutable`/`describeSpawnFailure`/`redactPathLike`）。
- **消费面正确**：保存侧 `cli-config.mjs:41`、发现侧 `cli-discovery.mjs:44`（`:47` 再导出同一引用）、两适配器 `dop-adapter.mjs:26`/`gh-adapter.mjs:28` 共用 `describeSpawnFailure`；`platform` 为可选注入（`dop-adapter.mjs:127/135`、`gh-adapter.mjs:394/402`），现有调用零改动——蓝图「保存/发现/运行期共用一套判定」达成。
- **排序表达正确**：`.exe` 优先由候选名下标（`rankByName`）表达而非 PATH 先后，符合蓝图「候选名扩到 6 项后优先级必须由下标表达」。
- **契约面与执行出口零 diff**：`http.mjs`、`index.mjs`、`flow.mjs`、`actions.mjs`、`cli-runner.mjs` 均不在改动清单；六键、端点/状态码、工具名与参数、门禁、四状态与幂等未动。
- **无适配漂移**：`flow.mjs` 的 `ports.gh.{readRepository,readIssue,readPr}` 与 `actions.mjs` 4 处调用点在适配器上均真实存在（`readPr`，非蓝图笔误的 `readPull`，见 Q-2）；两适配器失败分类已收敛，无「一头改一头漏」。
- **判定：无重工项**。唯一「重复实现」是 `packages/forge-gitee/src/runtime-config.mjs:66-100` 自带的 `WRAPPER_SUFFIXES` 与包装脚本拒收——蓝图与 `TECHNICAL.md:204`（R1）明确本轮不改、登记为独立后续需求，故不构成对蓝图的偏离；本轮已把它写入 `docs/teamflow/memory.md` 的待办，避免只留在本任务夹。

## 4. 意见、观察与遗留

| 编号 | 级别 | 内容 | 处置 |
|---|---|---|---|
| Q-1 | P3（文档口径） | PRD AC-5 写「写动作 `unknown`」，实现与 TECHNICAL 一致为**写动作记 `failed`（无副作用）**（`gh-adapter.mjs:424` 注释亦明确「failed 而非 unknown」） | 实现更严格（未启动⇒确定无副作用），fail-closed 与不重放不变；仅建议后续 PRD 措辞同步，非功能缺陷 |
| Q-2 | P3（蓝图笔误） | 蓝图 `dop-adapter` api 写 `readIssue/readPull/readRepository`，真实成员为 `readChange/listChanges/capabilities`，PR 只读在 gh 侧 `readPr`（r8 前既有） | 真实调用点全部可解析，无断线；文档侧待后续把 api 字段改为 `readPr` |
| Q-3 | P3（跨包副本，**独立后续需求**） | `forge-gitee/src/runtime-config.mjs:66-100` 仍拒 `.cmd`/无后缀，Windows 配置 gitee 侧仍沿用旧口径 | 已登记 `TECHNICAL.md` R1 + `memory.md` 待办；跨包 import 源码被仓库约定禁止，须单独开需求 |
| Q-4 | P3（AC 字面） | AC-10「零 skip/todo」字面 vs `pnpm check` 汇总 `skipped 3` | 3 条均为 r6 基线既有的环境门（dsh/npm/目标宿主缺失），本需求未新增；包内 0 skip |

- **人工补测（NOT RUN，环境限制非交付缺陷）**：①企业 Windows 实机保存复测（`.cmd`/无后缀 shim、目录/不存在文案）；②真实 npm shim 的运行期提示（三段 + 无盘符/endpoint）；③真实浏览器走查（沙箱内 Chromium 无法启动，QA 用 node:vm 装载真实 `client.js` 顶替）；④宿主装载后 `/api/forge-devops/cli` 发现顺序与页面标题；⑤真实企业 dop/gh 联调与 `--json` 稳定性。
- **工作区说明**：交付保持**未提交**（符合 PRD 工程约束，无 commit/push）；根级未跟踪只读文件 `TEAM-FULL-INSTALL.md` 属另一工作流（团队敏感扫描工具分发包说明），非本次交付面，未纳入亦未删除（他人产物）。
- **文档落点**：本阶段新增本文件；`memory.md` 仅「同主题约定行」替换（dev 已做）+ 1 条 r8 遗留待办；未触碰 `AGENTS.md` 与其他文档。

## 5. 证据纪律

本轮全部实测为**本地离线**：假 fs / 假 clock / 注入 `execFile` 桩、`node:vm` 装载页面源码；企业内网 Windows 实机保存（原报障截图场景）、真实 npm shim 启动失败提示、真实浏览器走查、宿主装载与快照、真实企业 dop/gh 联调一律 **NOT RUN**，不得写作已联调。NAP（无新增依赖、未改 `package.json`/`engines`）已由 A10 的改动清单确认。

验收结论：✅ 通过
