# r10 验收报告：DevOps 平台与 Gitee 代码托管收敛

- 任务夹：`docs/teamflow/20261103-r10-devops-gitee-converge/`；分支 `main`，HEAD `3d7e832`；本轮交付仍以 **59 改 / 14 删 / 8 未跟踪**（其中 3 个新增源码、3 个任务夹文件、2 个场外文件）留在工作区，保持原样，未提交、未合并
- 验收角色：产品经理（验收负责人）；时间：2026-11-03 17:25–17:36 CST
- 环境：macOS 26.5.1 arm64；Node v24.13.0；pnpm 11.28.5；git 2.50.1；`dsh` 不在 PATH
- 依据：`TECH-CHANGE.md`（技术驱动需求，本轮无 PRD；判据取自 §3–§5 与 §4 用户可见影响）、`QA-REPORT.md`（round 2「可验收」）、`docs/teamflow/memory.md`、产品级 25 条 AC 索引

## 1. 结论摘要

r10 按变更单落地三条用户批注：①「不执行 git」改为新增 `forge_gitee_git_commit` / `forge_gitee_git_push`，执行复用唯一 `execFile` 出口（`gitee-cli.mjs` 新增 `runGit()`）；commit 为本地动作、不入策略目录，首行强制 `[变更号]`，push 为远端写、默认拒绝且需 `confirm`；② 取消 `GH_TOKEN` 前提，`authEnv`/`host` 改可选、持久令牌默认只告警，devops 删 `ghBin`/`ghOwner`（6→4 键、页面 3→2 项）；③ 按平台重排：devops 只留 dop 4 工具，仓库/Issue/PR/评审/判定唯一实现在 Gitee（8→10 工具），同装 17→14，provider 痕迹零活跃命中；三层补丁层共用同一 `heluo-policy` 行与逐字相同的 5 条并集目录，无 isolate、无第二策略实例。未发现 P0/P1/P2；唯一 P3（D-6）为场外未跟踪文件，非本单引入。判定：**通过**。

## 2. 验收方法与证据来源

- 独立复跑（本轮实跑）：接口一致性 51/51；gitee 主路径 14/14（真补丁层 + 真策略 + 真 `execFile` + 真 git + 本地 bare 仓）；devops 主路径 8/8（dop shim）；交付形态 38/38；三层补丁同装 7/7；装配自证 `{patchRows:2, catalog:5, tools:10, realms:0, ok:true}`；T7 交付门禁 PASSED；`plugin-patch-layers` 8/8；`git.test.mjs` 14/14；`coexistence` 5/5；`git diff --check` exit 0；`check-docs` → docs: ok（84 文件 / 674 表格 / 638 链接）。
- 同树复用：全量 `pnpm check` 1685 例 / 1681 通过 / 0 失败 / 4 跳过、exit 0，为 QA 本轮在**同一工作树**实跑；复核无源码文件晚于 `QA-REPORT.md`，未重复运行。
- 未只采信 QA：逐条 grep 单源、工具面、配置面、补丁层与文档口径；首轮缺陷 D-1~D-5 按原检测命令抽核（旧插件行 id 零命中、包描述已改、六个符号可导出、企业层目录完整、补丁注释已改）。
- 未使用浏览器：任务夹无截图；页面视觉项留在人工补测，不据此宣称已验证。

## 3. 变更单判据逐条核对

| # | 判据（TECH-CHANGE） | 结论 | 证据 |
|---|---|---|---|
| 1 | 工具面 devops 4 / gitee 10 / 同装 14 | 通过 | `DEVOPS_TOOLS` 4 条；`GITEE_TOOLS` 10 条（3 读→4 写→1 判定→2 git）；T7 门禁 14 工具 ↔ 5 条目录对账；G3/G4 实跑 |
| 2 | provider 痕迹清零、单平台语义 | 通过 | 三常量 src 零命中；`GITEE_PLATFORM='gitee'`（值不变）；`PUBLIC_SAAS_HOSTS` 仅 gitee 三域；guard 拒非 `gitee.*` 动作 |
| 3 | 策略单实例、一份目录 | 通过 | 企业/devops/gitee 三层均 `id: heluo-policy`，5 条并集目录逐字相同（sha 536×3）、零 `isolate`、零 `heluo-policy-gitee`；门禁 8/8 含变异反证；`realms:0` |
| 4 | 凭据与配置面放松 | 通过 | gitee `CONFIG_KEYS` 5 键（`authEnv`/`host` 可选，`persistentToken` 默认 warn），缺令牌 preflight `ok:true, tokenSource:'none'`（`gitee-adapter.mjs:640-670`、`adapter.test.mjs:482`）；devops `CLI_FIELDS` 4 / `CLI_PAGE_FIELDS` 2 / `ENV_KEYS` 4；`RETIRED_KEYS=['ghBin','ghOwner']` 静默忽略（`runtime-config.mjs:47`） |
| 5 | 本地 git 归属与门禁 | 通过 | commit 本地动作、不入 catalog，首行 `[变更号]` 由 `git-message.mjs` 单源校验、`gitee-delivery.mjs:18-23` 反向 re-export；push 动作 `gitee.git.push` 在 `CONFIRM_REQUIRED_ACTIONS`，默认未登记即 denied；`git.test.mjs` 14/14（离线 e2e：commit→push→bare 仓 sha/subject 一致） |
| 6 | 唯一子进程出口 | 通过 | gitee `gitee-cli.mjs:376` 唯一 `execFile`（`run`/`runGit` 共用，shell:false、固定 argv、超时、1 MiB、`GIT_TERMINAL_PROMPT=0`）；devops `cli-runner.mjs:127`；`gitee-git.mjs` 零 `child_process`/spawn |
| 7 | devops 去 gh 化、`change_context` 降级 | 通过 | src 19 模块，gh-adapter/actions/repository-resolver/repo-ref/review/report/commit-message 7 个已删；零 GH_*/github.com 调用；`REPO_FACTS_EXTERNAL` + 下一步两条 gitee 工具 |
| 8 | 用户可见兼容性与文档 | 通过 | 5 工具改名换包、配置页少一项、上下文卡少仓库段、凭证门槛消失、策略实例 2→1 均按 §4 落地；设计「非目标」已改为不合并/关闭/发版/流水线（`forge-gitee.md:50-54`）；设计/README/契约/memory 同步，`check-docs` ok |
| 9 | 回归底线 | 通过 | `pnpm check` 1685/1681/0/4；用例 1681→1685 只增不减；gh 侧用例随模块删除并在 `delivery-selfcheck.test.mjs:49-50` 登记理由；4 条 skip 全为既有平台条件（dsh 不在 PATH×3 + Windows 专属×1），本单 git e2e 未跳过 |
| 10 | 交付形态 9 条 | 通过 | 形态探针 38/38：`files` 含 `cordis.patch.yml`、`dsh.bundle.patch` 指向它、入口用包根名、产物依赖已闭包（无 `workspace:`）、产物含新模块不含已删 gh 模块、两包顶层 import exit 0、隔离 `DSH_HOME` 两层/三层 `--dump-config` exit 0、装前写明回滚 |
| 11 | 判定只判定、不关闭 | 通过 | G3 #6/#7：`executed=false`、`remote_calls=0`；白名单无 close/merge/release |

## 4. 产品级 25 条 AC 回归（QA §8 + 抽核）

| AC | 结论 | 证据 |
|---|---|---|
| AC-1~5 失败面/零泄漏/类别/fail-closed/单点脱敏 | 通过（回归） | 用例全绿；G4 未配置 dop 分支无本机路径且含 `CLI_PAGE_HINT`；脱敏仍单点（受控重复：devops failure-face 与 gitee-cli scrub） |
| AC-6~10 刷新/即时对齐/无中间态/幂等/降级 | 通过（回归） | `flow.test.mjs` 刷新与降级用例、`cli-http.test.mjs` 主路径（GET→POST→GET→409） |
| AC-11/12/14/15 卸载/只删自己/回显/别人条目 | 通过（回归） | `uninstall-devops`、`patch-layer-blocks`、`plugin-patch-layers`（8/8） |
| AC-13 真实冷启动零残留 | NOT RUN | 宿主启动无观测手段（`dsh` 不在 PATH）；列入 §6 |
| AC-16 文档口径 | 通过 | 六份文档同步；README:98-100 与 design:237 引用 `heluo-gitee`，旧 token 零命中 |
| AC-17/18 门禁与回归 | 通过 | `pnpm check` 1685/1681/0/4；`git diff --check` 0；安全扫描未放宽 |
| AC-19/24 证据表 | 通过（标注完整） | 本报告 §2 与 QA §1/§5 给命令/时间/环境/来源类型；真实安装与真机 NOT RUN |
| AC-20 提交面 | 通过（卫生面） | 工作区无 tgz/logs/dist/依赖/密钥；未提交内容见 §6，D-6 需收口时排除 |
| AC-21 关闭四项只判定 | 通过 | 见 §7：仅「验收通过」有证据，其余 unknown，不关闭 |
| AC-22 令牌只经环境变量 | 通过 | `ENV_ALLOWLIST` 过滤自定义变量；`credentialStatus().enforced` |
| AC-23 唯一 execFile | 通过 | 零 spawn/exec/shell:true；两包各一处；固定 argv/超时/1 MiB |
| AC-25 文档与索引同步 | 通过 | `DOCUMENT-REGISTER`/design/README/contracts/memory 已同步；`check-docs` ok |

## 5. 架构一致性（M3 门禁）

| 蓝图判据 | 实测 | 结论 |
|---|---|---|
| 按平台切库，不抽新抽象 | 新增仅 `git-message.mjs`（提交信息单源）与 `gitee-git.mjs`（git 命令面）；其余为删重复/收配置/改补丁层 | 符合 |
| 提交信息单源 | `git-message.mjs` 5 原因码 + 抛错；`gitee-delivery.mjs:18-23` 反向 re-export；devops 旧件已删 | 符合 |
| 唯一出口与固定 argv | `runGit` 复用同一出口；argv 表 `commit/head/branch/push`，禁 force/tags/all；无第二子进程站点 | 符合 |
| 装配顺序 | `index.mjs`：配置→两适配器→guard→session→service→10 工具；git 适配器平级注入 | 符合 |
| 重复实现与抽象 | 仅保留蓝图声明的受控重复（failure-face/scrub、policy-guard/gitee-guard）；包间零源码导入；`judgeCloseReadiness`、`verifyCommitMessage`、工具名、读面、动作名单点 | 符合，未发现应抽未抽 |
| 既有结构 | gitee 既有读/写/判定工具参数与返回契约不变；devops dop 流程与本地写/落盘不变 | 符合 |
| 门禁 | `plugin-patch-layers` 8/8（含单边漂移反证）；`coexistence` 5/5；`delivery-selfcheck` 就地扩展未重建 | 符合 |

## 6. 遗留与人工补测

- D-6（P3，场外）：根目录未跟踪 `TEAM-FULL-INSTALL.md`（团队敏感扫描工具安装说明，含密钥分发口径，早于 r10）；不是本交付产物，收口提交前必须排除或评审纳管，禁止随 r10 提交。
- 未提交：本单全部改动（59 改 / 14 删 / 3 新增源码）仍在工作区，未提交、未合并、未推送；提交/合并由用户授权后执行。
- NOT RUN（环境限制，非交付缺陷）：真实 `dsh plugin add` 与宿主冷启动加载、真实 web profile 装入/卸载/回滚、同 id 升级路径、企业 Gitee CLI `--json` 联调、`persistentToken: block`、Windows/麒麟 aarch64、浏览器配置页实机走查。
- 记忆：`memory.md` 已在技术阶段同主题替换（单 `heluo-policy` 行、平台分工、10 工具人工补测项），本阶段无新增约定，未改。

## 7. 关闭条件四项（只判定，不执行关闭/合并）

| 项 | 结论 | 证据 |
|---|---|---|
| 验收通过 | pass | 本报告 §3–§5 |
| 已合并 | unknown | `main` 上未提交、未合并；无合并授权 |
| 无未完成交付 | unknown | 交付仍在工作区；真实安装/企业联调 NOT RUN |
| 人工确认 | unknown | 未取得人工确认记录 |

## 8. 后续动作

1. 用户授权后提交本单改动：提交前排除 `TEAM-FULL-INSTALL.md` 与场外 `docs/requirements/issue-delivery-adjustment-proposal.md`，按 `[变更号]` 规范写提交信息，不夹带 `logs/`。
2. 真实 web profile 装入两包 → 重启宿主 → 复核 10+4 工具与冷启动零 `entry not found` → 按 README 回滚段反向卸载。
3. 企业环境补测 Gitee CLI 与 `persistentToken: block`，补 AC-13/AC-24 证据后再复核关闭四项。

验收结论：✅ 通过
