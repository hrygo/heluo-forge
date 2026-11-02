# r9 验收报告：运行期失败面 / 刷新重建读面 / 卸载清理补丁条目

- 任务夹：`docs/teamflow/20261102-r9-runner-refresh-uninstall/`
- 分支：`feat/devops-change-flow`；HEAD `f2b631b`；工作区 31 项未提交改动（保持原样，未提交、未合并）
- 验收角色：产品经理（验收负责人）；验收时间：2026-11-02 10:22–10:30 CST
- 环境：macOS Darwin arm64；Node v24.13.0；pnpm 11.28.5
- 依据：`PRD.md`（17 条 AC、5 条反面目标、6 条待澄清默认值）、`TECHNICAL.md`（含 §3.4 词对照表）、`QA-REPORT.md`（结论「可验收」），以及本报告 §8 的独立复跑

## 1. 结论摘要

r9 三项修复（失败面脱敏与单点、刷新重建读面、卸载清理补丁条目）均按 PRD 与架构蓝图落地。17 条新 AC 与继承门禁 AC-18~25 中，除 AC-13 真机冷启动、AC-9 浏览器页面、AC-24 企业真机/真实凭据三项按 PRD 约定标 NOT RUN 外，其余均有本机实测证据。未发现 P0/P1/P2 缺陷；4 条 P3（蓝图接口命名漂移、卸载 help 缺少入口提示、已运行分支占位文本、PRD AC-4 措辞与实际四状态契约不一致）不阻塞交付。5 条反面目标均有对应用例覆盖。判定：**通过**。本报告只做关闭条件判定，不执行关闭或合并。

## 2. 验收方法与独立复核

- 未仅采信 QA 报告：独立重跑 `pnpm check`、QA 探针、刷新/HTTP 用例、卸载/块模型用例、包内与根用例，并逐条 grep 单点、旧口径与提交面。
- 架构核查：按蓝图逐模块核对导出、调用方与装配顺序；核对无重复实现、无适配器漂移、无既有结构破坏。
- 未使用浏览器：QA 已说明沙箱无法启动真实浏览器，任务夹无截图；页面侧视觉项保留在 §6 人工补测，不据此宣称已验证。

## 3. 逐条 AC 核对

### 3.1 r9 新增 AC（PRD 17 条）

| AC | 验收点（摘要） | 结论 | 证据 |
|---|---|---|---|
| AC-1（P0） | 三出口同口径失败面：读信封、写动作、变更卡片只含 reason/类别/next，无原始报错 | 通过 | 探针 24/24：读信封 `status:"unknown"`+`error_code:"COMMAND_FAILED"`+`detail.reason:"CLI_SPAWN_FAILED"`；工具信封 `next_action:"configure-reader"`；写动作 `status:"failed"`+「无副作用」；卡片行含类别与下一步。`failure-face.test.mjs`、`actions.test.mjs` 断言同一结构 |
| AC-2（P0） | 六种注入（EINVAL/ENOENT/EACCES/相对路径 bin/绝对路径与 UNC/URI）全文正则零命中 | 通过 | 探针六注入全量扫描：绝对路径、盘符、UNC、URI、`~/`、`spawn ` 前缀、errno token 零命中；相对路径入口（`bin/dop`）已纳入注入矩阵 |
| AC-3（P0） | 类别与 next 可行动；`.exe` 不套包装脚本；判定只依赖形态+exitCode | 通过 | 探针：`.cmd`/`.ps1`/无后缀 shim/原生入口四类措辞互异且都含 `设置 → 企业 DevOps`；`.exe` 走原生入口；同一 `.cmd` 有退出码时走「已运行」分支，证明只看形态与 `exitCode:null` |
| AC-4（P1） | fail-closed 不回归：只读与写动作状态语义不变、不重放、单次调用 | 通过（PRD 措辞差异见 P3-4） | 探针与 `dop/gh-adapter.test.mjs`：注入 runner 均只调用 1 次；写动作 `failed`、零重放；写门禁未通过时下游 operation 0 次；四状态语义未被本轮改动（`TECHNICAL.md` §3.4 有对照表） |
| AC-5（P1） | 脱敏渲染只一处实现并共用，适配器/动作层不得直传底层错误文本 | 通过 | 用户可见「未启动」文案仅出自 `packages/forge-devops/src/failure-face.mjs`；`describeSpawnFailure`/`redactPathLike` 在 `src/` 零命中；read/actions/tools/dop/gh/change-context 全部引用该模块 |
| AC-6（P0） | `?refresh=1` 在响应前完成发现+重合并+读面重建，与工具调用同源 | 通过 | `packages/forge-devops/src/http.mjs` 只调注入快照源；`index.mjs:324 refreshSnapshot()` 被 HTTP（:355）、`cliSnapshot`（:439）、`rediscover`（:448）共用；flow/HTTP 用例 31/31 |
| AC-7（P0） | 改名/移动后下一次调用用新路径；不可发现时 `NO_READER`，不按旧路径 spawn | 通过 | 具名用例 3/3：改名后 `argv[0]` 为新路径；移走后 `ready:false`+`NO_READER` 且 spawn 计数不增 |
| AC-8（P0） | 发现→重建→组装无中间态，响应后立即调用不出现卡面与读面不一致 | 通过 | `flow.test.mjs` 断言响应前协作者实例已换新；HTTP 探针断言响应体与重建快照同一对象；重建顺序即 `access.snapshot({refresh:true})`→`syncFaces({rebuild:true})`→`access.snapshot()` |
| AC-9（P1） | 刷新幂等无副作用：不写盘、不新增进程、发现 1 次/刷新、工具 0 次；steady 行为不变 | 通过（浏览器侧 NOT RUN） | 探针：刷新路径 spawn 0 次、无写盘调用；flow 用例：同内容再刷新 revision 不跳；见 §6 页面回归项 |
| AC-10（P1） | 重建失败可读降级：结构化失败、不留半重建状态、与下一次调用一致 | 通过 | 重建抛错用例：HTTP 500 + `detail:{reason:"CLI_REBUILD_FAILED",next}`，`error.message` 不进响应；读面降级 `no-reader`/`NO_READER`/`FLOW_UNAVAILABLE`，故障消失自动恢复 |
| AC-11（P0） | 卸载命令可用且幂等：先清补丁条目再移除；重复执行零改动；无 dsh 只清理并打印下一步 | 通过 | `pnpm uninstall:devops --profile web`（`package.json:20`）；探针覆盖正常/无 dsh/`--keep-plugin`/dsh 非零/重复执行/多 profile 不猜 6 路；重复执行字节不变、exit 0 |
| AC-12（P0） | 只删本插件条目及 config 子树；`id:`/`name:` 两种写法可识别；补丁层缺失明确报错不建文件 | 通过 | 22 行 fixture：仅删本插件块（含 config 子树）5 行；`id:` 与 `name:` 两种写法均命中；缺失时 exit 1 且不创建文件 |
| AC-13（P0） | 冷启动无警告零残留：本插件条目计数 0、无悬空条目 | 通过（库级）；真冷启动 NOT RUN | `countEntries`=0、无悬空条目；真实安装→卸载→冷启动需 Windows 实机与目标 DSH，按 PRD 约定由主 agent 在关闭前执行（§6） |
| AC-14（P0） | 回显 profile、条目 id、删除行区间、前后行数、是否移除；不回显绝对路径 | 通过 | 探针与编排用例：`行 2-6（共 5 行）`、前后行数差=删除行数、插件是否移除；全程绝对路径零命中 |
| AC-15（P1） | 兄弟插件/官方/手写注释逐字保留；禁止前缀或正则模糊匹配 | 通过 | 删除后与逐行期望逐字节相等；兄弟插件、前缀同名、深层 `- id:`（llm 模型表）、注释全部保留 |
| AC-16（P1） | README 卸载段改为「清理+移除」并说明上游不清理；旧口径零命中；memory 同主题替换 | 通过 | `packages/forge-devops/README.md:117` 新口径；`packages/forge-gitee/README.md:96` 补限定；`docs/teamflow/memory.md:8` 同主题替换；旧「remove 即完成」零命中（`docs/design/plugins/forge-gitee.md:217` 已限定为先删补丁条目、且指缓存/临时文件） |
| AC-17（P1） | `pnpm check` 全绿、用例只增不减、0 skip 新增、`git diff --check` 干净、patch-layer 门禁仍绿 | 通过（3 条既有 skip 见 P3 注） | `pnpm check` exit 0：1510 tests/1507 pass/0 fail/3 skip；与 r8 验收记录 1510 持平，devops 包 496→511（+15）；无测试文件删除；`git diff --check` 干净；`tests/plugin-patch-layers.test.mjs` 仍绿 |

### 3.2 继承门禁（产品级 AC-18~25）

| AC | 验收点（摘要） | 结论 | 证据 |
|---|---|---|---|
| AC-18 | `pnpm check` 全绿、用例不减、`git diff --check` 干净、安全扫描未放宽 | 通过 | 同 AC-17；`delivery-selfcheck.test.mjs` 33/33；仅对新增合成路径测试夹具加单行 `// security-scan: allow`，扫描规则未改 |
| AC-19 | 证据表含命令/时间/宿主版本/来源类型；真实安装与真机标 NOT RUN | 通过（真机 NOT RUN） | 见 §8；真实安装/冷启动/真机均标 NOT RUN |
| AC-20 | 提交面卫生：无 tgz/logs/dist，构建产物被既有 gitignore 覆盖 | 通过 | 31 项变更均为源码/测试/文档；无 `dist/`、`*.tgz`、`node_modules`、日志；`logs/` 由既有 `.gitignore` 忽略；`TEAM-FULL-INSTALL.md` 为既有未跟踪文件，按约定保持原样、不纳入交付 |
| AC-21 | 关闭四项逐条给证据与来源类型；CI/UAT 取不到标 unknown；只判定不关闭；白名单无 close/merge | 通过（判定不关闭） | 见 §7：验收通过=是，其余三项 unknown；未调用任何关闭/合并动作 |
| AC-22 | token 只经环境变量注入；输出/报告/日志/文档正则零命中；持久令牌阻断 | 通过 | 口令正则（`ghp_`/`glpat-`/私钥头）全仓扫描零命中（仅测试内 pattern 定义）；本轮未新增凭据路径 |
| AC-23 | 唯一 execFile 出口；src 零 spawn/exec/shell:true；argv 白名单/超时/1MiB 未放宽；禁项不含 merge/close/release/workflow/change done | 通过 | `packages/forge-devops/src/cli-runner.mjs:127` 为唯一 `execFile`；`spawn(`/`exec(`/`shell: true` 零命中（其余为 `RegExp.exec`）；本轮未触碰白名单与超时配置 |
| AC-24 | 证据逐条写命令/时间/宿主版本/目标对象+来源类型；Windows/麒麟 aarch64/真实凭据/`--json` 稳定性标 NOT RUN；mock 不写成企业联调 | 通过（报告面；真机 NOT RUN） | 见 §8 来源类型列；本机结果均标「本机执行」，未写成企业联调 |
| AC-25 | 设计文档与索引同步、README 状态更新、`pnpm check` 与 `git diff --check` 通过 | 通过 | `forge-devops` README 与 memory 同主题更新；设计索引无 devops 卸载旧口径；`check-docs`/`check-repo` 均 ok；`git diff --check` exit 0 |

**反面目标核对**：①不重放写操作——`actions.test.mjs` 断言单次调用；②不按旧路径 spawn——AC-7 用例；③补丁层缺失不建文件——AC-12 用例；④不模糊匹配条目——AC-15 逐字节断言；⑤不把 mock/本机结果写成企业证据——§8 来源类型列。五项均有对应用例或报告约束。

## 4. 架构与代码质量核查（M3 门禁）

| 蓝图模块 | 实际落地 | 结论 |
|---|---|---|
| `src/failure-face.mjs` 失败面唯一渲染点 | 存在；导出 `SPAWN_FAILURE_REASON`、`SPAWN_CATEGORIES`、`spawnFailureFace`、`failureFaceOf`、`redactFailureText`、`failureMessageOf`、`toolFailureOf`、`writeFailureOf`（另导出 `FAILURE_CODE`）；被 read/actions/tools/dop/gh/change-context 共用 | 符合 |
| `src/entry-form.mjs` 收窄为纯判定 | 仅 `node:path`；导出 `ENTRY_FORMS`/`WRAPPER_SUFFIXES`/`entryFormOf`/`isDirectlyExecutable`/`wrapperSuffixOf`；无文案与脱敏 | 符合 |
| dop/gh 适配器共用失败面 | 只判「是否启动失败」（exitCode null）后调 `failureFaceOf`；旧 `describeSpawnFailure`/`redactPathLike` 零命中 | 符合，无复制文案 |
| tools/actions/read/change-context 共用单点 | 工具信封 `failureOf` 分流；写动作 `writeFailureOf`；读信封 `failureMessageOf`；卡片只读结构化 detail 的 category/next，非 spawn 行逐字不变 | 符合 |
| `http.mjs` 注入快照源 | `createCliApi({snapshot})` 只调注入源；500 带结构化 `detail`，不拼 `error.message` | 符合 |
| `index.mjs` 刷新单点与事务化 | `refreshSnapshot()` 顺序为 `access.snapshot({refresh:true})`→`syncFaces({rebuild:true})`→`access.snapshot()`；`computeFaces`/`commitFaces`/`degradeFaces` 先算后提交；`refresh:true` 全仓仅 `index.mjs:327` | 符合 |
| 卸载分层 | `scripts/lib/patch-layer-blocks.mjs` 纯文件模型（parse/remove/count/resolveProfile）；`scripts/lib/uninstall-devops.mjs` 编排（runner 可注入）；`scripts/uninstall-devops.mjs` 薄 CLI；无第二份删除实现 | 符合 |
| 前端 | 零改动（仅配置页错误文案来源变化） | 符合 |

- **无重复实现**：`src/` 唯一子进程出口 `cli-runner.mjs:127`（`execFile`），零 `spawn`/`exec`/`shell:true`；失败面文案单点。
- **偏差（P3-1）**：蓝图接口名与实际导出一致性有漂移——`tools.mjs` 实际导出 `buildDevopsTools`（`failureOf` 私有）、`change-context.mjs` 实际导出 `renderContextCard`（`toUnknown` 私有）。调用关系自洽、语义符合蓝图，属技术文档接口表笔误；与 r8 验收的 Q-2（蓝图 api 笔误）同性质，按 P3 处理，不构成返工。

## 5. 缺陷与观察

未发现 P0/P1/P2 缺陷。以下 P3 不阻塞验收：

| 编号 | 级别 | 模块 | 描述 | 影响 | 建议 | 关联 AC |
|---|---|---|---|---|---|---|
| P3-1 | P3 | 技术文档 | 蓝图接口表写 `registerTools`/`failureOf`/`renderChangeContext`，实际导出 `buildDevopsTools`/`renderContextCard`（`failureOf`、`toUnknown` 私有） | 文档与代码名不一致，读者可能找不到入口；运行期与测试无影响 | 在 `TECHNICAL.md` §3.1 接口表标注「以实现导出名为准」或改为实际名 | AC-5/AC-25 |
| P3-2 | P3 | 卸载命令帮助 | `--help` 仅显示 `node scripts/uninstall-devops.mjs` 用法，未提示 README 推荐的 `pnpm uninstall:devops` | 用户可能绕过 pnpm 脚本直接调用；功能等价 | 下一轮在帮助文本补一行推荐入口 | AC-11 |
| P3-3 | P3 | 失败面脱敏（已运行但失败分支） | 脱敏后仍可见 `at ChildProcess.spawn` 占位文本（无真实路径、无 errno） | 不泄露信息、不影响 spawn 注入面；措辞可更干净 | 后续统一占位词为固定短语 | AC-2 |
| P3-4 | P3 | PRD 措辞 | PRD AC-4 写「只读 `status: failed`、写动作 `unknown`」；实际契约为读信封 `status:"unknown"`（工具信封 `ok:false`）、spawn 写动作 `failed`（确定无副作用） | 按字面对表会误判；`TECHNICAL.md` §3.4 已登记对照并说明四状态语义不变 | 下一轮 PRD 按 §3.4 修正措辞（与 r8 Q-1 同类）；本轮验收按 §3.4 执行 | AC-4 |

说明：3 个测试 skip 为既有环境门（`dsh`/`npm` 不在 PATH、目标 DSH 未安装），自 r6 起存在，非本轮新增；本轮新增用例 0 skip。安全扫描对新增合成路径夹具的 `// security-scan: allow` 仅限该测试夹具单行，扫描规则与覆盖面未放宽。`docs/design/plugins/forge-gitee.md:217` 的「卸载后无残留」已明确「先移除补丁层条目 → 重载 → remove」且指缓存/临时文件，属已限定口径，无需改动。

## 6. NOT RUN 与残余风险

| 项 | 状态 | 原因 | 关闭前动作 |
|---|---|---|---|
| AC-13 真实安装→卸载→冷启动零残留 | NOT RUN | 需 Windows 实机与目标 DSH，沙箱不可执行 `dsh plugin` 真装 | 主 agent 按 README 步骤安装→启动→`pnpm uninstall:devops --profile web`→冷启动抓日志，确认无 `entry not found`、补丁层条目计数 0 |
| AC-9 浏览器 `?refresh=1` 页面回归 | NOT RUN | 沙箱无法启动真实浏览器（QA 已披露） | Chrome/Edge 网络面板确认响应即新入口；下一次工具调用 spawn 新路径 |
| AC-24 Windows/麒麟 aarch64/真实凭据联调 | NOT RUN | 无企业内网机器与真实 dop/gh 凭据 | 企业环境补测；结论按来源类型 real 记录 |
| 页面失败提示视觉核对（换行/截断/指引可点） | NOT RUN | 同上 | 人工目检截图 |
| AC-20 合并后干净工作区 | 待合并 | 交付未提交、未合并（按授权边界） | 用户确认后提交/合并，再复核工作区与远端状态 |

残余风险：①Windows 真实 `.exe`/`.cmd` 与 UNC 行为仅靠注入平台覆盖，真机未跑；②`dsh plugin remove` 上游行为若变化，卸载命令的「移除」段可能需适配（清理段独立、不受影响）；③`TEAM-FULL-INSTALL.md` 为既有未跟踪文件，若误提交会进入交付面，需在提交时排除。

## 7. 关闭条件判定（只判定，不关闭）

| 关闭条件 | 结论 | 证据 | 来源类型 |
|---|---|---|---|
| 验收通过 | 是 | 本报告 §3：AC-1~17 与继承门禁均有实测/对表结论；P0 项（1/2/3/6/7/8/11/12/13/14）除 AC-13 真机部分外全部实测 | 本机执行 |
| 已合并 | unknown | 分支 `feat/devops-change-flow` 工作区 31 项未提交，无合并记录 | — |
| 待交付完成 | unknown | CI 与企业 UAT 未运行；真机/浏览器项 NOT RUN | — |
| 人工确认 | unknown | 无人工签字；本报告为 agent 代拟验收结论 | — |

判定动作只输出结论，不执行关闭、合并或发布；工具白名单未新增 close/merge。是否合并、合并到哪个分支由用户决定。

## 8. 证据表（AC-19/AC-24）

| # | 命令/检查 | 时间（CST） | 宿主/版本 | 来源类型 | 结果 |
|---|---|---|---|---|---|
| 1 | `pnpm check` | 2026-11-02 10:08–10:10（QA）/10:23（验收复核） | Darwin arm64 / Node v24.13.0 / pnpm 11.28.5 | 本机执行 | exit 0；docs/repo/bundles/version 全 ok；1510 tests / 1507 pass / 0 fail / 3 skip |
| 2 | `node logs/teamflow/tf-mvykcipp-3eo1wi/scripts/qa-r9-three-fixes.mjs` | 2026-11-02 10:16–10:21（QA）/10:24（验收复核） | 同上 | 本机执行 | 24/24 通过（三修复 + 蓝图接口） |
| 3 | `cd packages/forge-devops && node --test test/flow.test.mjs test/cli-http.test.mjs` | 2026-11-02 10:24 | 同上 | 本机执行 | 31/31 |
| 4 | `node --test --test-name-pattern="刷新\|改名\|不可发现\|重建" test/flow.test.mjs` | 2026-11-02 10:25 | 同上 | 本机执行 | 3/3（改名新路径、不可发现 NO_READER、重建 500+恢复） |
| 5 | `node --test tests/plugin-patch-layers.test.mjs tests/patch-layer-blocks.test.mjs tests/uninstall-devops.test.mjs` | 2026-11-02 10:25 | 同上 | 本机执行 | 27/27（AC-17 回归项仍绿） |
| 6 | `cd packages/forge-devops && node --test` | 2026-11-02 10:26 | 同上 | 本机执行 | 511/511 |
| 7 | `node --test "tests/*.test.mjs"` | 2026-11-02 10:26 | 同上 | 本机执行 | 141 pass / 3 skip / 0 fail |
| 8 | `node scripts/uninstall-devops.mjs --help` | 2026-11-02 10:27 | 同上 | 本机执行 | exit 0，输出用法（P3-2） |
| 9 | 单点/旧口径/口令/卫生 grep 与 `git diff --check`、`git status --porcelain` | 2026-11-02 10:27–10:29 | 同上 | 本机执行 | 单点成立；旧口径零命中；口令零命中；无构建产物；diff --check 干净 |
| 10 | 真实安装/卸载/冷启动、浏览器刷新、Windows/麒麟真机 | — | — | **NOT RUN** | 见 §6 |

## 9. 后续动作（主 agent）

1. 关闭前执行 AC-13 真机冷启动与 AC-9 页面回归，证据补入关闭记录（本任务夹不升版）。
2. 由用户决定是否提交/合并 `feat/devops-change-flow`，并复核合并后工作区与远端状态；提交时排除 `TEAM-FULL-INSTALL.md`。
3. 下一轮处理 P3-1~P3-4（文档名、help 提示、占位词、PRD 措辞）；均不阻塞本次交付。
4. 企业环境补测 AC-24 后，再复核关闭四项。

验收结论：✅ 通过
