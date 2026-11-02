# r9 QA 报告：运行期失败面 / 刷新重建读面 / 卸载清理补丁条目

- **结论：可验收**——未发现 P0/P1/P2 缺陷；3 条 P3 观察（不阻塞）；4 项实机/浏览器项标 NOT RUN 并列入人工补测清单。
- 任务夹：`docs/teamflow/20261102-r9-runner-refresh-uninstall/`（PRD 17 条 AC + 继承门禁 AC-18~25）。
- 分支：`feat/devops-change-flow`（工作区 31 项未提交改动，保持原样，未提交、未回退）。
- 环境：macOS Darwin arm64；Node v24.13.0；pnpm 11.28.5；执行时间 2026-11-02 10:08–10:21 CST。
- 环境限制：agent 沙箱无法启动真实浏览器（宿主 token 限制，非交付缺陷），页面侧回归改由 scripted 探针覆盖，浏览器项列人工补测。

## 1. 执行结果

| 检查项 | 命令 | 结果 |
|---|---|---|
| QA 独立探针（三修复 + 蓝图接口） | `node logs/teamflow/tf-mvykcipp-3eo1wi/scripts/qa-r9-three-fixes.mjs` | exit 0，**24/24 通过** |
| 全仓门禁 | `pnpm check` | exit 0：docs ok（78 files/629 tables/581 links/71 fragments/18 controlled）、repo ok（24 项/10 包/653 文件）、bundles ok（8 packed/180 files）、version ok；`node --test` **1510 例 / 1507 通过 / 0 失败 / 3 跳过**（上轮 1468 → +42） |
| 刷新与 HTTP 用例 | `cd packages/forge-devops && node --test test/flow.test.mjs test/cli-http.test.mjs` | exit 0，31/31 |
| 刷新具名用例 | `node --test --test-name-pattern="刷新" test/flow.test.mjs` | exit 0，2/2（改名后新路径 / 不可发现 NO_READER） |
| 卸载与块模型用例 | `node --test tests/plugin-patch-layers.test.mjs tests/patch-layer-blocks.test.mjs tests/uninstall-devops.test.mjs` | exit 0，31/31（AC-17 回归项仍绿） |
| 契约自检 | `node --test packages/forge-devops/test/delivery-selfcheck.test.mjs` | exit 0，33/33 |
| 根 tests 全量 | `node --test "tests/*.test.mjs"` | exit 0，141 通过 / 3 跳过（既有环境门）/ 0 失败 |
| 空白与冲突 | `git diff --check` | exit 0 |
| 旧口径 | `grep -rn "remove @heluo/forge-devops" packages docs README.md \| grep -v docs/teamflow/2026` | 仅 `packages/forge-devops/README.md:117` 的新卸载段；`docs/teamflow/memory.md:8` 同主题替换完成 |
| 单点/唯一出口 | `grep -rn "refresh: true\|rebuild: true" packages/forge-devops/src`；`grep -rnE "\bspawn\(\|\bexec\(\|\bexecFile\(" packages/forge-devops/src` | 刷新仅 `index.mjs:327` 一处；src 唯一子进程出口 `cli-runner.mjs:127 execFile`，其余为 `RegExp.exec` |
| 口令扫描 | `grep -rnE "ghp_[A-Za-z0-9]{20,}\|glpat-[A-Za-z0-9_-]{20,}\|BEGIN .*PRIVATE KEY" packages scripts services docs` | 零命中 |
| 提交面卫生 | `git status --porcelain` | 31 项，全部为源码/测试/文档；无 dist、*.tgz、node_modules、日志；`logs/` 由 `.gitignore:81` 忽略 |

## 2. AC 覆盖矩阵

| AC | 结论 | 证据（实测） |
|---|---|---|
| AC-1 三出口同口径 | 通过 | 探针：读信封 `status:unknown`+`error_code:COMMAND_FAILED`+`detail.reason:CLI_SPAWN_FAILED`；工具信封 `next_action:configure-reader`；写动作 `status:failed`+「无副作用」；卡片行含类别/下一步 |
| AC-2 零泄漏（6 注入） | 通过 | 探针 EINVAL/ENOENT/EACCES/相对路径 `bin/dop`/绝对路径/UNC/URI endpoint 全量正则扫描零命中（路径、盘符、UNC、URI、`~/`、spawn 前缀、errno token） |
| AC-3 类别与下一步 | 通过 | `.cmd`/`.ps1`/无后缀 shim/原生四类措辞互异且都含 `设置 → 企业 DevOps`；`.exe` 不套包装脚本；同一 `.cmd` 有退出码时走「已运行」分支，证明判定只依赖形态+exitCode |
| AC-4 fail-closed 不回归 | 通过 | dop/gh 注入 runner 均只调用 1 次；写动作 `failed`、`calls:1`、不重放；gh `mayHaveSideEffect:true` 保留在 detail |
| AC-5 脱敏单点 | 通过 | 导出仅 `failure-face.mjs`；`未启动` 用户可见文案只在该文件（其余命中均为注释）；适配器/动作/读/卡片全部 import 同一实现 |
| AC-6 刷新重建读面 | 通过 | 路由探针：注入源被调用 1 次且 `refresh:true`，响应体即源返回、`access.snapshot` 零调用；flow 用例断言重建先于响应 |
| AC-7 改名/移动即时对齐 | 通过 | flow 用例 2/2：改名后下一次 spawn argv[0] 为新路径；不可发现时 `ready:false`+`NO_READER` 且 spawn 计数不增 |
| AC-8 无中间态 | 通过 | flow 用例断言响应前 `provided` 流程实例已换新；路由探针响应体与重建快照同一对象 |
| AC-9 刷新幂等 | 通过 | flow 用例：刷新本身 spawn 0 次、同内容再刷新 revision 不跳；刷新路径仅 `snapshot`+`syncFaces`，无写盘调用。浏览器侧 NOT RUN |
| AC-10 重建失败降级 | 通过 | 路由探针：500 + `detail:{reason:CLI_REBUILD_FAILED,next}`，`error.message`（含绝对路径）不进响应；flow 用例覆盖降级与自动恢复 |
| AC-11 卸载命令可用幂等 | 通过 | 探针：`--profile` 正常/无 dsh/`--keep-plugin`/dsh 非零/重复执行/多 profile 不猜 6 路；重复执行字节不变 exit 0，remove 参数精确 `plugin --profile web remove @heluo/forge-devops` |
| AC-12 只删自己那条 | 通过 | 22 行 fixture：仅删本插件块（含 `config` 子树）5 行，`id:` 与 `name:` 两种写法均可；补丁层缺失 exit 1 且不建文件 |
| AC-13 零残留+冷启动 | **部分（NOT RUN）** | 库级：删除后 `countEntries=0`、无悬空条目；真实安装→卸载→冷启动需 Windows 实机，标 NOT RUN |
| AC-14 回显可审计 | 通过 | 回显 profile 名、条目 id/name、行区间 `行 2-6（共 5 行）`、前后行数（差=删除行数）、插件是否移除；全程零绝对路径 |
| AC-15 别人的一条不少 | 通过 | fixture 删除后与「逐行期望」逐字节相等：兄弟插件、前缀同名、深层 `- id:`、手写注释全部保留 |
| AC-16 文档口径 | 通过 | `README.md:117` 改为「清理补丁层 + 移除插件」并说明上游不清理；memory:8 同主题替换；旧「remove 即完成」零命中 |
| AC-17 门禁与回归 | 通过 | `pnpm check` 全绿；用例 1468→1510 只增；`git diff --check` 干净；patch-layer 用例 31/31。3 个 skip 均为既有环境门（dsh/npm 不在 PATH、目标 DSH 未安装），本轮新增用例 0 skip |
| AC-18 门禁/安全扫描 | 通过 | 同上；`delivery-selfcheck` 33/33（含安全扫描与模块契约，未放宽） |
| AC-19 证据表 | 通过（真机部分 NOT RUN） | 见 §6；真实安装/真机标 NOT RUN |
| AC-20 提交面干净 | 通过 | 31 项变更无 dist/tgz/logs；`logs/` 已忽略 |
| AC-21 关闭判定 | 已判定不关闭 | 见 §8：验收通过；合并/CI/人工确认 unknown |
| AC-22 口令零命中 | 通过 | 口令正则扫描零命中；token 仅经环境变量（本交付未新增凭据路径） |
| AC-23 唯一 execFile 出口 | 通过 | src 仅 `cli-runner.mjs:127` execFile，零 `shell:true`，白名单未放宽（未触碰） |
| AC-24 证据来源类型 | 通过（实机 NOT RUN） | §6 逐条命令/时间/宿主/来源类型；mock/本机结果未写成企业联调 |
| AC-25 文档同步 | 通过 | README/memory/设计索引同主题更新；check-docs 与 check-repo 均 ok |

## 3. 架构核查

- **模块按蓝图抽出**：`failure-face.mjs`（338 行）为唯一渲染点；`entry-form.mjs` 收窄为 128 行纯判定（仅 `node:path`，无文案/脱敏）；`dop-adapter.mjs:167`、`gh-adapter.mjs:425` 只判「是否失败」后调 `failureFaceOf`，旧 `describeSpawnFailure`/`redactPathLike` 零命中。
- **刷新单点成立**：`index.mjs:327` 是唯一 `snapshot({refresh:true})` 调用，`syncFaces({rebuild:true})` 紧随；`rediscover`/`cliSnapshot`/HTTP 注入源共用；http 无刷新实现，只调注入源（未注入时才有 fallback）。
- **卸载分层**：`patch-layer-blocks.mjs` 纯文件模型（parse/remove/count），`uninstall-devops.mjs` 编排（runner 可注入），薄 CLI 仅解析参数与打印；无第二份补丁层删除实现。
- **无重复实现**：`未启动` 文案单点、`CLI_PAGE_HINT` 单一来源（`cli-config.mjs:105`）、spawn 失败判定两适配器各自只有 exitCode 判断（本职），无两份文案。
- **蓝图偏差（P3，见缺陷表）**：`tools.mjs` 实际导出 `buildDevopsTools`（蓝图写 `registerTools`），`failureOf` 为私有；`change-context.mjs` 导出 `renderContextCard`（蓝图写 `renderChangeContext`），`toUnknown` 私有。属文档命名漂移，调用关系自洽，无功能影响。

## 4. 缺陷表

未发现 P0/P1/P2 缺陷。以下 P3 观察不阻塞验收：

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| OBS-1 | P3 | 架构/技术文档 | 对比 TECHNICAL 蓝图接口表与 `tools.mjs`/`change-context.mjs` 实际导出 | 蓝图接口名与实现导出一致，或注明以实现为准 | 蓝图写 `registerTools`/`failureOf`/`renderChangeContext`，实现为 `buildDevopsTools`/私有 `failureOf`/`renderContextCard` | AC-5/AC-25 | `node --input-type=module -e "import('./packages/forge-devops/src/tools.mjs').then(m=>console.log(Object.keys(m).join(',')))"` | 输出包含蓝图名称，或 TECHNICAL 已更正为实际导出名 |
| OBS-2 | P3 | 卸载命令帮助 | `node scripts/uninstall-devops.mjs --help` | 帮助里给出 README 推荐的 `pnpm uninstall:devops` 入口 | 仅显示 `node scripts/uninstall-devops.mjs` 用法 | AC-11 | `node scripts/uninstall-devops.mjs --help \| grep "uninstall:devops"` | 命令 exit 0 且输出含 `pnpm uninstall:devops` |
| OBS-3 | P3 | 失败面脱敏（非注入场景） | 已运行但失败（exitCode≠null）时证据行脱敏结果 | 路径/errno 零命中，栈帧占位文本可按需保留 | 脱敏后仍可见 `at ChildProcess.spawn <路径>` 字样（无真实路径、无 errno；spawn 注入面不经过该分支） | AC-2 | `node logs/teamflow/tf-mvykcipp-3eo1wi/scripts/qa-r9-three-fixes.mjs` | 探针 24/24 通过且 AC-2 扫描对 spawn 面零命中；建议后续统一占位词 |

Craft 评分：本交付无新增可见 UI 组件（仅配置页错误文案与刷新路径），页面侧视觉回归列人工补测，craft 记 N/A。

## 5. 人工补测清单

| 项 | 验收标准 | 方法/工具 | 说明 |
|---|---|---|---|
| AC-13 真实安装→卸载→冷启动零残留 | 冷启动无 `entry not found`，补丁层本插件条目计数 0 | Windows 11 + 目标 DSH：`dsh plugin add` → 启动一次 → `pnpm uninstall:devops --profile web` → 冷启动抓日志并 grep 补丁层 | 环境限制，非交付缺陷；库级等价验证已通过 |
| AC-9 浏览器 `?refresh=1` 页面回归 | 点刷新后响应即新入口，下一次工具调用 spawn 新路径 | Chrome/Edge DevTools 网络面板 + 工具调用日志；真实 web profile | 沙箱无法启动浏览器（宿主 token 限制）；路由/装配层已用探针覆盖 |
| AC-24 企业 Windows/麒麟 aarch64 真机 + 真实凭据 | 只读/写动作与失败面与 mock 一致，证据标 real | 企业内网机器 + 真实 dop/gh | NOT RUN；本报告所有结果均为本机执行 |
| 配置页失败提示视觉核对 | 文案换行/截断正常，next 指引可点 | 截图比对 | 人工目检 |

## 6. 证据与来源类型（AC-19/AC-24）

| 命令 | 时间 | 宿主 | 来源类型 | 结果 |
|---|---|---|---|---|
| `node logs/.../scripts/qa-r9-three-fixes.mjs` | 2026-11-02 10:16–10:21 | Darwin arm64 / Node 24.13.0 | 本机执行 | 24/24 |
| `pnpm check` | 2026-11-02 10:08–10:10 | 同上 | 本机执行 | 1510/1507/0/3，四 checker ok |
| `cd packages/forge-devops && node --test test/flow.test.mjs test/cli-http.test.mjs` | 2026-11-02 10:18 | 同上 | 本机执行 | 31/31 |
| `node --test tests/plugin-patch-layers.test.mjs tests/patch-layer-blocks.test.mjs tests/uninstall-devops.test.mjs` | 2026-11-02 10:18 | 同上 | 本机执行 | 31/31 |
| `node --test packages/forge-devops/test/delivery-selfcheck.test.mjs` | 2026-11-02 10:20 | 同上 | 本机执行 | 33/33 |
| `git diff --check` / `git status --porcelain` | 2026-11-02 10:20 | 同上 | 本机执行 | 干净 / 31 项无产物 |
| 真实安装、冷启动、真机、浏览器页面 | — | — | **NOT RUN** | 见 §5 |

## 7. NOT RUN / 未验

1. AC-13 真实 `dsh plugin` 安装→卸载→冷启动（需 Windows 实机与目标 DSH）。
2. AC-9 浏览器页面侧 `?refresh=1` 回归（沙箱无法启动浏览器）。
3. AC-24 Windows / 麒麟 aarch64 / 真实凭据联调。
4. 3 个测试 skip 为环境门（`dsh`/`npm` 不在 PATH、目标 DSH 未安装），非本轮新增；若需严格 0 skip 需在装有 dsh 的环境复跑。

## 8. 关闭判定（只判定，不关闭）

| 关闭条件 | 结论 | 证据 | 来源类型 |
|---|---|---|---|
| 验收通过 | 是 | 本报告 §2（P0 项均有实测）；QA 探针 24/24；`pnpm check` 全绿 | 本机执行 |
| 已合并 | unknown | 分支 `feat/devops-change-flow` 工作区未提交，无合并记录 | — |
| 待交付完成 | unknown | CI 与企业 UAT 未运行 | — |
| 人工确认 | unknown | 无人工签字 | — |

判定动作只输出上述结论，不执行关闭/合并。
