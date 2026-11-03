# 技术变更单：DevOps 平台与 Gitee 代码托管收敛（r10）

- **任务夹**：`docs/teamflow/20261103-r10-devops-gitee-converge/`（技术驱动需求，本轮无 PRD）
- **基线依赖**：`docs/teamflow/20261029-r4-forge-gitee/`、`docs/teamflow/20261028-r1-devops-change-flow/`、`docs/teamflow/20261030-r5-devops-config-slimming/`
- **取代**（语义取代，历史任务夹一律不修改、只在新单登记）：`20261029-r4-forge-gitee` 的 provider 分流建模与共存四形态；`20261030-r5-devops-config-slimming` 的 `ghBin`/`ghOwner` 配置面；`20261028-r1-devops-change-flow` 的承建仓库自动解析段

## 1. 背景与目标

企业内只有一个 Gitee 承担代码资产管理，`gh` 是为它写的兼容 CLI（语法与 GitHub 版一致），不存在 GitHub 面。现有「两个 provider 按面分流」的建模把同一闭环割成两份，本单按 **DevOps 平台（dop） vs Gitee 代码托管（gh）** 重排：devops 只留 dop 能力，仓库/Issue/PR/评审/交付判定只在 Gitee 侧实现一份，并补上本地 `git commit`/`git push` 的归属。

## 2. 影响范围（文件/模块）

| 区域 | 变更 | 主要文件 |
|---|---|---|
| devops 工具面 | 9 → 4，删 gh 读写工具 | `packages/forge-devops/src/tools.mjs`、`read.mjs`、`flow.mjs` |
| devops gh 侧 | 整模块删除 | `src/gh-adapter.mjs`、`src/actions.mjs`、`src/repository-resolver.mjs`、`src/repo-ref.mjs`、`src/review.mjs`、`src/commit-message.mjs` 及对应用例 |
| devops 配置面 | 6 键 → 4 键，删 `ghBin`/`ghOwner` | `src/cli-config.mjs`、`src/runtime-config.mjs`、`client.js`、`src/http.mjs` |
| gitee 工具面 | 8 → 10（新增 git 两工具） | `src/gitee-tools.mjs`、新增 `src/gitee-git.mjs`、`src/git-message.mjs` |
| gitee provider 痕迹 | 删常量/黑名单/字段互斥 | `src/gitee-adapter.mjs`、`src/gitee-read.mjs`、`src/gitee-guard.mjs` |
| gitee 凭据 | `authEnv` 可选、`host` 可选、持久令牌告警 | `src/runtime-config.mjs`、`src/index.mjs` |
| git 出口 | 复用唯一 `execFile` | `src/gitee-cli.mjs`（新增 `runGit()`，仍只有一处 `execFile`） |
| 补丁层 | 单策略行、单目录、无 isolate | `packages/forge-devops/cordis.patch.yml`、`packages/forge-gitee/cordis.patch.yml` |
| 静态门禁 | 共存断言改写 | `tests/plugin-patch-layers.test.mjs`、`packages/forge-gitee/test/coexistence.test.mjs` |
| 文档 | 口径重写 + 取代登记 | `docs/design/plugins/forge-gitee.md`、`forge-devops.md`、`docs/design/README.md:33-34,66`、两份包 README、`docs/contracts/engineering-tools.md`、`docs/teamflow/memory.md` |

## 3. 技术方案

### 3.1 工具面：每个能力只出现一次（同装 17 → 14）

| 现有（devops） | 处理 |
|---|---|
| `forge_devops_repository_read` | 删，改调 `forge_gitee_repository_read` |
| `forge_devops_issue_read` | 删，改调 `forge_gitee_issue_read` |
| `forge_devops_pr_read` | 删，改调 `forge_gitee_pr_read` |
| `forge_devops_issue_write` | 删，改调 `forge_gitee_issue_write` |
| `forge_devops_pr_write` | 删，改调 `forge_gitee_pr_write` |

devops 保留 4 个：`change_read`、`change_context`、`clarify_write`、`artifact_write`。gitee 8 + 新增 `forge_gitee_git_commit`、`forge_gitee_git_push` 共 10 个。参数与返回契约不变（仍 snake_case、四状态、`confirm{repo,object}`），迁移只改工具名与归属包。

### 3.2 删除 provider 化痕迹

- 删 `GITEE_PROVIDER`、`GITEE_FORBIDDEN_FIELDS`、`MIXED_PROVIDER_FIELDS` 及对应原因码；`PUBLIC_SAAS_HOSTS` 收敛为 Gitee 自有主机判断，`github.com`/`gitlab.com`/`bitbucket.org` 黑名单删除。
- 字段表只留一份：Gitee 侧 `--json` 子集为唯一语义表；devops 的 `GH_*` 表随 gh 侧一并删除，不再维护两套。
- devops 侧 `github.com/` 启发式随 `gh-adapter.mjs` 消失（原 `parseCreatedRef`/`parseCommentRef` 对裸 `gitee.com/...` 识别不出的缺陷不再存在）。
- `gitee.` 前缀保留，但语义从「provider 隔离」改为「平台命名空间」；契约动作目录到 `gitee.*` 的映射表补进 `docs/contracts/engineering-tools.md`，不重命名动作（重命名会改审计 id，另单评估）。

### 3.3 策略面：一个实例、一份目录

- 两个补丁层都插入 **同一个行 id `heluo-policy`**，配置为**逐字相同的并集目录**，两处都不写 `isolate`：同装时 loader 按 id 覆盖为同一份配置，最终只有一个 `policy` 实例、一个服务域。`heluo-policy-gitee` 与两条 `isolate: { policy: gitee }` 全部删除。
- 并集目录（5 条只读，0 条写）：`change.read`、`gitee.repository.read`、`gitee.issue.read`、`gitee.pr.read`、`gitee.delivery.judge`（`target: change`、`egress: allow`）。
- 写动作（含 `gitee.git.push`）仍不登记，默认 `denied`；profile 需要写能力时显式追加动作并补 `approvals` 台账。
- `tests/plugin-patch-layers.test.mjs` 改为三条断言：任一补丁层不得出现 `isolate`；两个 `heluo-policy` 的 `catalog`/`audit` 逐字一致；各包工具声明的动作 ⊆ 该目录（写动作除外）。

### 3.4 凭据与配置面

- gitee：`authEnv` 改为**可选覆盖**（默认空，直接用 CLI 全局凭据/SSH；`AUTH_MISSING` 不再因缺变量拒绝）；`host` 可选，仅配置后做防误连；`persistentToken: warn|block` 默认 `warn`（新增第 5 键，`block` 保留给合规场景）；`cliPath` 默认 `gh`。
- devops：删 `ghBin`/`ghOwner`，契约键 6 → 4（`dopBin`/`dopEndpoint`/`sourceType`/`timeoutMs`），配置页 3 项 → 2 项（`dopBin`/`timeoutMs`），`sourceType` 由 dop 单侧推导（不再因 gh 缺失降级 mock）。
- 文档与页面文案同口径：**不再要求单独配 `GH_TOKEN`**，前提是本地 SSH/凭据已就绪。

### 3.5 本地 git 的归属

- 归属 `@heluo/forge-gitee`（代码托管侧）；执行仍走唯一 `execFile` 出口：`gitee-cli.mjs` 增加 `runGit()`，复用同一 `invoke()`，`shell:false`、固定 argv、超时、1 MiB 上限、`GIT_TERMINAL_PROMPT=0`。
- `forge_gitee_git_commit`：**本地动作，不入策略目录**——策略包无法表达「启用但免审批的写」（`needsApproval` 对 enabled 的写恒为真），若入目录就只能默认拒绝，与「提交必须做」冲突。参数 `{changeId, message}`，首行必须 `[变更号]`（校验实现由 devops `commit-message.mjs` 迁入 `git-message.mjs`，全局一份）；argv 固定 `commit -m <message>`，禁 `-a/--amend/--no-verify/--author`；cwd 为进程工作目录（不新增仓库路径参数）；返回 `{sha, subject, branch, evidence}`。
- `forge_gitee_git_push`：**远端写**，动作 `gitee.git.push`（`kind: write`、`egress: platform-write`），加入 `CONFIRM_REQUIRED_ACTIONS`，默认不登记即 `denied`，登记后仍须审批台账 + `confirm{repo,object}`；argv 固定 `push <remote> <branch>`，禁 force/delete/tags/all。
- `docs/design/plugins/forge-gitee.md` 非目标「不执行 git 动作」删除，改为「不做 PR 合并 / Issue 关闭 / 发版 / 流水线触发」。

### 3.6 devops 裁剪与 `change_context` 降级

- `flow.mjs` 的聚合只保留 dop 事实；`change_context` 的仓库候选与关联 Issue/PR 段不再由 devops 直连 gh，改为 `unknown` + `reason: REPO_FACTS_EXTERNAL` + 下一步（`forge_gitee_repository_read`/`issue_read`），**不猜仓库**。
- 仅服务 gh 的渲染（PR 评审段、交付报告中的远端证据段）一并删除或改为「由 Gitee 工具提供」，具体到引用由 dev 阶段按引用图确认，原则：`packages/forge-devops/src/` 不留任何 gh 调用点。

## 4. 行为兼容性影响（用户可见）

1. 5 个工具改名并换包：旧名不再注册，调用方（含提示词）须改；参数/返回契约不变。
2. 配置页少一项 `ghBin`，`ghOwner` 删除；已保存的 `ghBin` 被忽略且不报错。
3. `change_context` 输出少仓库候选与关联对象，新增 `REPO_FACTS_EXTERNAL` 提示；需要时另调 Gitee 工具。
4. 不再因缺 `GH_TOKEN` 拒绝挂载；持久令牌默认只告警（可用 `persistentToken: block` 恢复阻断）。
5. 同装时策略实例从 2 个变为 1 个，审计仍按 `subject` 区分来源；两包单独安装行为不变。
6. 新增 `git commit`/`git push` 两个工具；`push` 默认拒绝且必须确认。

## 5. 回归与验证计划

| 命令 | 覆盖 |
|---|---|
| `node --test packages/forge-gitee/test/` | 10 工具、目录、git 动作、凭据降级 |
| `node --test packages/forge-devops/test/` | 4 工具、配置面 4 键、`change_context` 降级 |
| `node --test tests/` | 补丁层单实例单目录、bundle 闭包、文档口径 |
| `pnpm check` / `git diff --check` | 全量门禁 + 空白错误 |
| `grep -rn "GITEE_PROVIDER\|MIXED_PROVIDER_FIELDS\|isolate" packages docs/design` | provider 痕迹零命中 |
| `git diff --stat` + 用例计数 | 用例只增不减、0 skip |

回归底线：既有离线用例一条不删（除随模块删除的 gh 侧用例，须在同单登记理由）；git 动作须用临时仓库 + 本地 bare 仓做离线 e2e（真实 `git` 二进制、零网络）。真实 web profile 装入/卸载/回滚、企业 Gitee CLI 联调、Windows/麒麟 aarch64 标 `NOT RUN`。

## 6. 风险与回滚

- **风险 1**：同 id 覆盖依赖 loader 行为（D-2 已实测「按 id 覆盖 config」）；两包目录若漂移会静默丢动作——用逐字一致静态门禁兜底。
- **风险 2**：`change_context` 能力下降（仓库自动判定消失），若验收要求保留须另行扩范围。
- **风险 3**：删 devops gh 侧涉及大量用例，易误删仍被 dop 路径引用的模块；按引用图逐个确认。
- **回滚**：本变更集中在单次提交，`git revert <sha>` 即可恢复；补丁层回滚为装回上一版 tgz；不涉及数据迁移与外部写。

## 7. 假设与待澄清

1. **策略行合并方式**：选「同 id + 逐字相同并集目录」。若 loader 改为合并 catalog 或禁止同 id 覆盖，则回退为包内 `isolate`（改动限于两个 `cordis.patch.yml` 与 `tests/plugin-patch-layers.test.mjs`）。
2. **`change_context` 降级**：选「只给 dop 事实 + 外部指引」。若要求保留自动承建仓库判定，需 dop 提供仓库清单（新依赖）或允许 devops 只读调用 Gitee（破坏单实现），二者都要另批范围。
3. **工具命名**：保留 `forge_<平台>_` 前缀（gitee 现有 8 个不改名）。若要求统一前缀，则再加一轮 rename 与调用方迁移。
4. **`git commit` 不走策略**：因为策略包表达不了「免审批的写」。若要求 commit 也走门禁，则它默认不可用，需接受「提交前先登记」。
5. **git 工作目录 = 进程 cwd**：不新增 `repoRoot` 配置；若需在任意仓库执行，另加配置键与路径校验。
