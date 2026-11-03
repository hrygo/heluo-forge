# QA 报告 · r10「devops 与 gitee 按平台收敛」（复验轮）

- 需求：`docs/teamflow/20261103-r10-devops-gitee-converge/TECH-CHANGE.md`（技术变更单，无 PRD）
- 轮次：**round 2（复验）** —— 先重跑首轮全部探针，再补首轮未覆盖表面（三层补丁同装、工艺 0d），最后按缺陷行原命令逐条复核
- 结论：**可验收** —— P0/P1/P2 = **0**；首轮 D-1（P2）与 D-2~D-5（P3）全部修复并经原检测命令复核；仅 D-6（P3，另一工具的在途未跟踪文件）仍 OPEN，不影响本交付功能面
- 环境：macOS 26.5.1 / arm64；node v24.13.0；pnpm 11.28.5；git 2.50.1；`dsh` 不在 PATH（实测入口 `<HOME>/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh`）；全部用例离线，网络零依赖
- 证据放行：探针与报告均为**本轮实跑**，非沿用首轮数字

## 1. 用例与结果

| 组 | 内容 | 命令 | 结果 |
|---|---|---|---|
| G1 全仓门禁 | 文档/仓库/产物/版本 + 全量 `node --test` | `pnpm check` | exit 0，tests **1685** / pass **1681** / fail **0** / skipped **4**（首轮 1681/1677/0/4，用例 +4 只增不减；4 条 skip 为既有平台条件跳过） |
| G1b 空白与用例增量 | 空白检查 | `git diff --check` | exit 0 |
| G2 接口一致性（静态） | 蓝图 `api` 导出 vs 实际导出；src/test 全部 import 具名符号真实存在；运行时对象形状 | `node logs/teamflow/tf-mw0c3ibz-30h6dd/scripts/qa-r10-interface.mjs` | **51 PASS / 0 FAIL** |
| G3 gitee 主路径（真实执行） | 真补丁层 + 真 `@heluo/forge-policy` + 真 `apply()` + 真 `execFile`；CLI 走 shim、git 走真二进制 + 临时仓 + 本地 bare 仓 | `node …/scripts/qa-r10-mainpath.mjs` | **14 PASS / 0 FAIL** |
| G4 devops 主路径（真实执行） | 真补丁层 + 真策略 + 真 `apply()` + dop shim | `node …/scripts/qa-r10-devops-mainpath.mjs` | **8 PASS / 0 FAIL** |
| G5 交付形态（含 bundle 构建/解包） | 9 条形态契约 + 分发产物 | `node …/scripts/qa-r10-shape.mjs` | **38 PASS / 0 FAIL** |
| G6 装配自证 | 真两层补丁挂载、单实例、卸载归零 | `node …/scripts/t3-assembly-proof.mjs` | PASS（`{patchRows:2, catalog:5, tools:10, realms:0, ok:true}`） |
| G7 交付静态门禁 | 六 token 零活跃命中、14 工具 ↔ 5 条目录对账 | `node …/scripts/t7-delivery-gate.mjs` | T7 gate **PASSED** |
| G8 **新表面：三层补丁同装** | 企业层 + devops + gitee 三层真实 `dsh --dump-config`（隔离 `DSH_HOME`） | `node …/scripts/qa-r10-three-layer-compose.mjs` | **7 PASS / 0 FAIL** |
| G9 补丁层静态门禁 | 同 id、目录逐字、无 isolate、门禁有牙（变异用例） | `node --test tests/plugin-patch-layers.test.mjs` | **8/8 PASS** |
| G10 客户端规则/形态 | 页面两行一列、规则与服务端同源 | `node --test packages/forge-devops/test/client-shape.test.mjs packages/forge-devops/test/client-rule-parity.test.mjs` | **35/35 PASS** |

### 1.1 首轮未覆盖的表面与本轮补法

| 漏点 | 为什么首轮没覆盖 | 本轮补法 |
|---|---|---|
| 企业层 `packages/forge-enterprise/cordis.patch.yml` 也插 `heluo-policy` | 首轮只合成 devops + gitee 两层（D-5 正是这个盲区暴露出来的） | G8 隔离 `DSH_HOME` 三层同装：`dump-config` exit 0（98 行）、策略行 3、三行 catalog 逐条同为 5 条并集、无 `isolate`、无 `heluo-policy-gitee`、插件行 `forge-devops`/`heluo-gitee`/`heluo-iam` 俱在 |
| 工艺（0d） | 首轮只测功能 | `packages/forge-devops/client.js` 静态核对：常驻 status 行（`role=status aria-live=polite`、ready/missing/unavailable 三态）、skeleton 载入骨架、hover/focus-visible/disabled、`aria-invalid` + `aria-describedby`、i18n 双语；**未发现工艺缺口**（不记 P3） |

G8 附注：`dsh --dump-config` 在 profile 目录不存在时报 `Error: dsh: profile "<name>" does not exist`（用法错误，非缺陷）；探针已在隔离 `DSH_HOME` 下建最小 profile 后再跑。

## 2. 首轮缺陷复验对比（round-1 级）

> 表头用「round-1 级」而非「严重级」，避免被缺陷追踪器当成新一轮 OPEN 缺陷。

| 编号 | round-1 级 | 模块 | 首轮检测命令 | 本轮结果 | 状态 |
|---|---|---|---|---|---|
| D-1 | P2 | 文档/卸载回滚 | `grep -rn "forge-gitee 条目\|id: forge-gitee" packages/forge-gitee/README.md docs/design/plugins/forge-gitee.md` | exit 1，**0 行**；README:98-100 与 design:237 三处均改为 `heluo-gitee` | **已修复** |
| D-2 | P3 | 架构/文档 | `sed -n '48,54p' packages/forge-devops/cordis.patch.yml` | 注释现为「loader 按 id 折叠成**一个**条目（后写 config 覆盖先前，不重复挂载两个实例）…三层逐字相同的并集目录…`tests/plugin-patch-layers.test.mjs` 静态守三份一致」 | **已修复** |
| D-3 | P3 | 包元数据 | `grep -n "GitHub (forge-devops)" packages/forge-gitee/package.json` | 0 命中；description 改为 Gitee 单一平台 + 同一门禁下的本地 commit/push | **已修复** |
| D-4 | P3 | 架构 | `node …/scripts/qa-r10-interface.mjs`（A 段） | 六个蓝图符号全部可 import：`createReviewRecord`/`createDeliveryGate`（gitee-actions）、`failureEnvelope`/`isReadEnvelope`（gitee-read）、`createPorts`（devops flow）、`normalizeBuilding`（change-context）；0 missing | **已修复** |
| D-5 | P3 | 架构/装配 | `grep -n "id: heluo-policy" -A3 packages/forge-enterprise/cordis.patch.yml` | 企业层 36-47 行现含完整 catalog（`change.read` + 3 条 `gitee.*` 读 + `gitee.delivery.judge`）与 audit 双写；G8 三层实跑目录逐字一致 | **已修复** |
| D-6 | P3 | 版本控制 | `git status --porcelain --untracked-files=all \| grep TEAM-FULL-INSTALL` | 仍输出 `?? TEAM-FULL-INSTALL.md` | **仍 OPEN**（非本交付引入，见 §3） |

缺陷类命中数重算（与修复摘要对账）：**D-1 类（文档引用不存在的插件行 id）0 处**（修复摘要称 3 处，与实际 README 3 处一致）；**D-4 类（蓝图符号私有）0/6**（修复摘要称 6 处，一致）；**D-5 类（缺目录的策略行）0/1**（修复摘要称 1 处，一致）。三类计数无分歧。

## 3. 缺陷表（仅仍 OPEN）

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| D-6 | P3 | 版本控制 | 仓库根执行 `git status --porcelain --untracked-files=all` | 收口提交前明确排除或纳管该文件（另一工具「团队敏感扫描」安装说明，含密钥分发口径，早于 r10） | `?? TEAM-FULL-INSTALL.md` 未跟踪且不在 `.gitignore`，整树提交会带进历史 | 形态 7 / AC-20 | `git status --porcelain --untracked-files=all \| grep TEAM-FULL-INSTALL` | 提交前该文件被排除或已评审纳管（当前仍输出，故 OPEN） |

功能面**未发现缺陷**（P0/P1/P2 = 0）。

## 4. 架构核对（蓝图 vs 实现）

| 判据 | 实测 | 结论 |
|---|---|---|
| 模块抽取 | `git-message.mjs` 为提交信息唯一实现（5 原因码、抛错形态），`gitee-delivery.mjs:18` 反向 re-export；`gitee-git.mjs` 不做子进程（零 `child_process` import），runner 注入 | 符合蓝图 |
| 唯一子进程出口 | gitee 侧唯一 `execFile` 站点 `packages/forge-gitee/src/gitee-cli.mjs:29`（`run`/`runGit` 共用）；devops 侧 `packages/forge-devops/src/cli-runner.mjs:28`；全仓零 `shell:true`/`spawn`/`execSync` | 符合 AC-23 |
| 去重 | devops 19 模块，7 个 gh 侧模块已删（`gh-adapter`/`actions`/`repo-ref`/`repository-resolver`/`commit-message`/`report`/`review`）；`judgeCloseReadiness` 唯一定义 `gitee-delivery.mjs:339`；`GITEE_PROVIDER`/`GITEE_FORBIDDEN_FIELDS`/`MIXED_PROVIDER_FIELDS` 零活跃命中 | 符合「按平台切库」 |
| 受控重复（蓝图声明不合并） | `failure-face.mjs` 与 gitee adapter 脱敏、`policy-guard.mjs` 与 `gitee-guard.mjs` 保留各自语义、包间零源码导入 | 与蓝图一致，非漂移 |
| 抽象未抽取 | 未发现该抽未抽的第二份实现；工具名/读面/动作名均单一枚举 | 无发现 |
| 配置面收敛 | `CLI_FIELDS` 4 键、`CLI_PAGE_FIELDS` 2 项、`ENV_KEYS` 4 键（无 GH_*） | 符合 AC-3/AC-10 类要求 |

## 5. 交付形态契约（9 条，本轮复核）

| # | 判据 | 命令/方法 | 结果 |
|---|---|---|---|
| 1 | 补丁层入口声明、`name` 用包根名 | 形态探针解析 `cordis.patch.yml`：`heluo-policy` + `heluo-gitee` / `forge-devops` | PASS |
| 2 | 入口文件进 `files` 白名单 | `files` 含 `cordis.patch.yml`（devops 另含 `client.js`），`dsh.bundle.patch` 指向它 | PASS |
| 3 | 依赖协议可解析（无 `workspace:`） | 解包 tgz 后扫 `workspace:` | PASS（产物已闭环为 `0.1.0`） |
| 4 | 宿主模块按 peer 声明 | src 零 `@deepseek-ai/*` import | N/A（能力全走 ctx，理由成立） |
| 5 | 产物与源码同步 | 重新构建解包：含 `git-message.mjs`/`gitee-git.mjs`，不含已删 gh 模块与测试 | PASS |
| 6 | 装载安全（顶层不抛错） | `node --input-type=module -e "await import('./packages/forge-*/src/index.mjs')"` | PASS（两包 exit 0） |
| 7 | 能被 profile 装入 | 真 tgz 构建（134338B/156738B）+ 隔离 `DSH_HOME` 两层/三层 `--dump-config` exit 0 | PASS（解析层）；真实 `dsh plugin add` NOT RUN（§7） |
| 8 | 宿主真实加载 | 无观测手段（注入非法动作后 `--help` 同样 exit 0 零报错） | **NOT RUN** → §7 |
| 9 | 安装带回滚 | `node scripts/uninstall-devops.mjs --help` exit 0 + `tests/uninstall-devops.test.mjs` 绿；README/设计回滚段引用 `heluo-gitee` | PASS（D-1 修复后） |

## 6. 未跟踪项与提交面（0c）

`git status --porcelain --untracked-files=all` 未跟踪 8 项：`TEAM-FULL-INSTALL.md`（D-6）、`docs/requirements/issue-delivery-adjustment-proposal.md`（他项在途）、本任务夹 3 文件（含本报告）、r10 新增源码 3 个（`git-message.mjs`/`gitee-git.mjs`/`git.test.mjs`，属正常未跟踪）。卫生扫描 0 命中（无 `node_modules/`、`dist/`、`*.tgz`、`.env`、`logs/`）；构建产物落 `/tmp`；`.gitignore` 已覆盖依赖/产物/日志。

## 7. 人工补测清单（环境限制，非交付缺陷）

| 项 | 判据 | 方法/工具 |
|---|---|---|
| AC-13 真实宿主冷启动 | 本插件条目计数正确、无 `entry not found`、冷启动零警告、工具面 10/4 条 | 真实 web profile 安装 tgz 后重启宿主看启动日志与插件列表（`--help` 不暴露挂载结果） |
| 真实 profile 装入/卸载回滚 | `dependencies` 出现两包、`bundles` 含包名；卸载后归零；失败即回滚 | `dsh plugin --profile web add <tgz>` → 重启 → 验证 → 按 README「回滚」反向卸载 |
| 同 id 策略行升级路径 | 旧 r7 层（`heluo-policy-gitee`/`isolate`）残留时重装后消失 | 真实 profile 重装两包后 `dsh --profile web --dump-config`，确认无 `isolate`/`heluo-policy-gitee` |
| 企业层与 gitee 同装顺序 | 任一层排最后都不丢目录（G8 已在隔离环境覆盖，实机仍建议复核） | 实机重载两序，检查工具有无 `GITEE_ACTION_UNREGISTERED` |
| 企业 Gitee CLI 联调 | 真实 `--json` 字段与信封一致 | 企业环境只读三条命令实跑，记录宿主/CLI 版本 |
| 持久令牌 `block` 策略 | 检出持久令牌时起进程前拒绝 | 构造 `~/.git-credentials` 后设 `persistentToken: block` |
| Windows / 麒麟 aarch64 | 路径、编码、权限用例 | 目标平台跑 `pnpm check` + 形态探针 |
| 浏览器配置页（devops） | 两行一列、无 gh 字段 | 真实 Web UI 打开「设置 → 企业 DevOps」 |

## 8. AC 证据索引

| 验收项 | 证据 | 结论 |
|---|---|---|
| AC-1~AC-5 失败面/脱敏/类别/fail-closed/单点脱敏 | `test/failure-face.test.mjs`、`test/flow.test.mjs`、`test/entry-form.test.mjs`（`pnpm check` 内全绿）；G4 未配置 dop 分支实测无本机路径 + `CLI_PAGE_HINT` | PASS（回归） |
| AC-6~AC-10 刷新重建读面/即时对齐/无中间态/幂等/降级 | `test/flow.test.mjs` 刷新与降级用例 + `test/cli-http.test.mjs` 主路径（GET→POST→GET→409） | PASS（回归） |
| AC-11、AC-12、AC-14、AC-15 卸载/只删自己/回显/别人条目 | `tests/uninstall-devops.test.mjs`、`tests/patch-layer-blocks.test.mjs`、`tests/plugin-patch-layers.test.mjs`（8/8） | PASS（回归） |
| AC-13 冷启动无警告零残留 | 真实宿主启动**无观测手段**（形态 8） | NOT RUN → §7 |
| AC-16 文档口径 | 六份文档同步；D-1 修复后回滚段引用 `heluo-gitee`（grep 0 行）；门禁用例守文档 id | PASS |
| AC-17、AC-18 门禁与回归 | `pnpm check` 1685/1681/0/4（首轮 1681）；`git diff --check` exit 0；`tests/plugin-patch-layers.test.mjs` 8/8 | PASS |
| AC-19、AC-24 证据表（命令/时间/宿主版本/来源类型） | 本报告 §1、§5 逐条给命令与环境；真实安装/真机标 NOT RUN | PASS（标注完整） |
| AC-20 提交面干净 | `git status` 无依赖/产物/缓存/密钥；产物落 `/tmp`；D-6 一项待处置 | PASS 除 D-6 |
| AC-21 关闭条件四项只判定 | G3 #6/#7：`executed=false`、`remote_calls=0`、四项三态、白名单无 close/merge | PASS |
| AC-22 令牌只经环境变量 | `gitee-cli.mjs` `ENV_ALLOWLIST` 实测过滤自定义变量；`credentialStatus().enforced` | PASS |
| AC-23 唯一 execFile 出口 | 零 `spawn`/`exec`/`shell:true`；gitee `gitee-cli.mjs:29`、devops `cli-runner.mjs:28`；git 复用 `runGit`；固定 argv + 超时 + 1 MiB | PASS |
| AC-25 文档与索引同步 | `docs/design`、两包 README、`docs/contracts`、`memory.md`、`DOCUMENT-REGISTER.md` 已同步；`check-docs` 绿（`pnpm check` 内） | PASS |

## 9. 结论

r10 的落地面与变更单一致：单一策略实例 + 三层逐字并集目录、gitee 10 工具（含真实 commit/push）、devops 4 工具、提交信息单源、凭据门槛消失、`REPO_FACTS_EXTERNAL` 降级，均经**真实执行**验证（G2/G3/G4/G5/G8 合计 118 项断言，全部本轮实跑）。首轮 D-1（P2）与 D-2~D-5（P3）已修复并经原检测命令逐条复核，缺陷类计数与修复摘要无分歧；功能面 **P0/P1/P2 = 0**。唯一 OPEN 为 D-6（P3，另一工具的在途未跟踪文件，建议收口提交前排除或纳管），不阻断本交付验收。AC-13 真实冷启动、真实装入/卸载、企业 CLI 联调、`persistentToken: block` 与双平台实机仍为环境所限，列入 §7。
