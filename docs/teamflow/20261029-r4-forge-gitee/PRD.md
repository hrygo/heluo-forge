<!-- meta: summary="@heluo/forge-gitee 独立插件包：以企业已有的 Gitee CLI（命令名 gh）为唯一通道，一轮内交付仓库/Issue/PR 只读查询与默认禁用的受控写，并按 provider 与 forge-devops 的 GitHub 语义彻底分流，可被 profile 真实装入与回滚。" -->
基线依赖：docs/teamflow/20261028-r1-devops-change-flow（AC-16~AC-23：写动作四状态/幂等回读、固定 argv 白名单与禁项、凭据只经环境注入、证据纪律，均不得回退）、docs/teamflow/20261029-r3-cli-path-autodiscovery（CLI 入口解析口径：不硬编码本机绝对路径、找不到即 fail closed 并给类别名与指引）

# PRD — @heluo/forge-gitee：企业 Gitee 研发闭环插件（查询 + 受控写）

## 1. 背景与目标

### 1.1 背景

企业研发事实（仓库、Issue、PR、评审记录）落在 Gitee 侧，而本仓库现有 `@heluo/forge-devops` 的仓库通道是 **GitHub 语义**：`packages/forge-devops/src/gh-adapter.mjs` 固定了 `GH_REPO_FIELDS`/`GH_ISSUE_FIELDS`/`GH_PR_FIELDS` 与 `-R <repo>` 参数形态，并用 `mergedAt`、`statusCheckRollup` 判定合入与检查状态。企业已有的 `gh` 是 **Gitee CLI**——命令名相同，字段与语义不同。若继续在同一个适配器里加分支，两套语义会共用同一张字段表，最终表现为"查得到、读错义"。

`packages/forge-gitee/` 目前只有 README（状态=规划），无清单、源码、测试；`docs/design/plugins/forge-gitee.md`（V0.2.0，草案）已给出形态结论（复用 CLI、不自建 MCP、不交叉编译）。本需求把该结论落成一个**可安装、可回滚、可验证**的插件包。

### 1.2 已定前提（用户已确认，不再讨论）

| # | 前提 | 影响本 PRD 的约束 |
|---|---|---|
| P1 | **企业内已有名为 `gh` 的 CLI**，前提成立，不再核验其存在性 | 不设"CLI 不存在"的兜底形态、不把存在性列为阻塞项或待澄清 |
| P2 | 只余事实层面待核验：CLI 版本、Windows / 麒麟 aarch64 双端产物、凭据注入方式、`--json` 字段稳定性 | 这四项按"待核验"处理：可设计、可测桩，但**不得写成已验证或已实现**（AC-24） |
| P3 | 形态为**新建独立包 `@heluo/forge-gitee`**，一轮内同时交付查询与受控写 | 不退化为"只读先行"；包边界、清单、补丁层独立于 forge-devops |
| P4 | 必须正面回答"同一个命令名两套语义"的冲突 | provider 维度分流、参数与字段表分表、拒绝跨语义回退（AC-11/AC-12） |
| P5 | 仓库既有纪律是基线：写动作默认禁用 + 范围与审批台账；不自动合并/关闭 Issue/触发 CI；凭据只经环境注入；只走 `execFile` + `shell:false` + 固定 argv 白名单 + 超时 + 输出上限；审计前置；单包自洽 | AC-16~AC-23 逐条承接，零回退 |
| P6 | 可复用 `cli-runner.mjs` / `policy-guard.mjs` / `artifacts.mjs` / `report.mjs` 的**做法**，但包边界与补丁层独立 | 复用纪律、不复用文件路径；不跨包导入源码 |
| P7 | 关联验收单为实现前置：#26 实证与只读、#30 Issue 创建维护、#31 Git 追溯与 PR、#34 AI 审查发布、#35 人工 review、#40 双端准入 | §4.3 把每张单映射到 AC；单的证据缺口不阻塞写代码，但阻塞"企业已联调"的结论 |
| P8 | 交付物：`package.json`（`engines.dsh`、`private`、真实测试入口）、`src/`、`test/`、`cordis.patch.yml`、README 状态更新；同步 `docs/design/plugins/forge-gitee.md` 与 `docs/design/README.md` 索引；`pnpm check` 通过 | AC-25；工程约束见 §10 |

### 1.3 目标

- **G1 装得上、起得来、能回滚**：包能被 profile 真实装入，重启后插件与工具可见；任一验证项失败可立即卸载恢复（AC-1~AC-10）。
- **G2 语义不串味**：Gitee 调用只走 Gitee 字段表与 `gitee.*` 策略命名空间，零跨语义回退，devops 的 GitHub 面零回归（AC-11/AC-12）。
- **G3 只读面可用且诚实**：仓库/Issue/PR 查询有固定命令面、固定信封，失败给固定 reason，取不到即 `unknown`（AC-14/AC-15）。
- **G4 受控写默认关着，但语义完整**：四状态、幂等、回读、不自动重放、禁项齐全；默认禁用时是**零执行**而非"看起来成功"（AC-16/AC-17/AC-23）。
- **G5 交付闭环可判定**：提交信息前缀、AI 审查记录、人工 review 记录与 stale、关闭条件判定——只判定、不越权执行（AC-18~AC-21）。
- **G6 证据可以说"没跑"**：未验项如实标 `NOT RUN`，mock 不写成企业联调（AC-22/AC-24/AC-25）。

### 1.4 一句话形态判定

一个**独立安装单元**：`@heluo/forge-gitee` 自带 `package.json` + `cordis.patch.yml` + 构建期闭包，往宿主注入 8 个 `forge_gitee_*` 工具（3 读 + 5 写），写动作默认不登记、不执行，全程单出口 `execFile`。

## 2. 用户故事与验收要点

### US-1 作为研发/审查者，我要在企业 Gitee 仓库上查到真实事实
给 `owner/repo`，查仓库概览、Issue 列表/详情、PR 列表/详情；结果带 `provider: gitee`、`source_revision`、`observed_at`，字段缺失时如实 `unknown`。
验收要点：AC-14、AC-15、AC-11、AC-12。

### US-2 作为研发负责人，我要能受控地在企业 Gitee 上建 Issue、发评论、建 PR
写动作**默认禁用**；启用后返回 `done|failed|denied|unknown`，创建前查同名 open 对象复用、执行后回读确认；`unknown` 不自动重放；退出码 0 不算成功。
验收要点：AC-16、AC-17、AC-23。

### US-3 作为审查者，我要 AI 意见与人工确认在同一份记录里分栏留痕
`review.md` 含问题/风险/意见/结论、实际模型名、commit sha；AI 栏与人工确认栏分开；sha 变化后旧确认标 `stale`。
验收要点：AC-19、AC-20。

### US-4 作为交付负责人，我要知道"能不能关 Issue、能不能结项"，而不是被自动关掉
提交信息必须以 `[变更号]` 开头（违规拒绝并给期望格式）；关闭条件四项逐条给证据；CI/UAT 取不到标 `unknown`；插件不执行关闭、不合并。
验收要点：AC-18、AC-21、AC-23。

### US-5 作为插件维护者/运维，我要装完能确认它真的在跑，坏了能退回去
安装单元无本地协议、产物与源码一致、顶层无副作用；装后 profile 与插件列表可验证；失败即按写好的步骤卸载并回读确认。
验收要点：AC-1~AC-10。

### US-6 作为安全/合规，我要确认凭据没落盘、子进程只有一个出口
token 只从环境注入、输出零回显；所有子进程经唯一 `execFile` 出口、固定 argv 白名单、超时与输出上限；禁项（合并/关闭/发版/触发流水线/`change done`）不在白名单。
验收要点：AC-22、AC-23。

### US-7 作为本仓评审者，我要能一眼看出哪些是真跑过、哪些没跑
证据表逐条写命令/时间/宿主版本/目标对象 + 来源类型；Windows 与麒麟 aarch64、真实企业凭据、`--json` 字段稳定性标 `NOT RUN`。
验收要点：AC-24、AC-25。

## 3. 验收标准

> 编号仅在本文件夹内有效。判据为"客观可核对"，验证方式为 QA/验收执行时的具体动作。全部 AC 默认 P0；仅 AC-13 为 P1（理由见 §7、F4）。

### 3.0 交付形态契约对照（host 必填九项）

| 契约项 | 落成 AC |
|---|---|
| 1 宿主半加载入口声明（入口 `name` 用包根名） | AC-1 |
| 2 声明文件进分发白名单 | AC-2 |
| 3 依赖协议为 profile 可解析形态 | AC-3 |
| 4 宿主依赖按 peer 声明 | AC-4 |
| 5 构建产物与源码同步 | AC-5 |
| 6 装载安全（顶层不抛错） | AC-6 |
| 7 能被 profile 真实装入（本机探测入口） | AC-8（+AC-7 补丁自洽） |
| 8 装载后宿主真实加载该插件 | AC-9 |
| 9 安装必须带回滚 | AC-10 |

### 3.1 AC 表

| 编号 | 判据（可测） | 优先级 | 验证方式 |
|---|---|---|---|
| AC-1 | `packages/forge-gitee/package.json` 的 `dsh.bundle.patch` 指向存在的 `./cordis.patch.yml`；该文件 insert 行的 `name` **精确等于** `@heluo/forge-gitee`（包根名，不得写子路径）；两份声明均可被解析 | P0 | `node --test` 用例：解析清单 + 解析补丁 + 断言包名等值；断言文件存在 |
| AC-2 | `files` 覆盖 `src`、`cordis.patch.yml`、`README.md`；打包 dry-run 清单含 `package/cordis.patch.yml` 与 `package/src/index.mjs`，不含 `test/`、`node_modules/`、`*.tgz` | P0 | `npm pack --dry-run --json` 清单断言 + `node scripts/check-bundle-tarballs.mjs` |
| AC-3 | 安装单元（`buildBundle({entry:'@heluo/forge-gitee'})` 产物）内 `package.json`：`dependencies` 全为真实 semver、`bundledDependencies` 覆盖 `@heluo/forge-policy`，`workspace:\|file:\|link:` 正则**零命中**；源码清单沿用仓库约定 `workspace:*`，不得直接作为安装单元；宿主给的 `readFileSync('package.json')` 检查在**仓库根**退出码 0 | P0 | 构建命令 + `tar -xOf <tgz> package/package.json` + 正则 grep 退出码 |
| AC-4 | `src/` 对 `@deepseek-ai/*` 与 `react` 的 import 数 = 0（宿主能力经 ctx 注入）；`dependencies` 仅 `@heluo/forge-policy`；若引入宿主包，只允许出现在 `peerDependencies` 且每项在 `peerDependenciesMeta` 标 `optional` | P0 | `grep -rn "@deepseek-ai/\|from 'react'" packages/forge-gitee/src` 计数为 0 + 清单断言 |
| AC-5 | 包内无 `lib/`、`dist/` 或其他生成目录；安装单元内 `package/src/index.mjs` 的 sha256 与工作区同名文件逐字节一致；`main`/`exports` 指向的文件在产物中全部存在 | P0 | 解包后 `shasum -a 256` 双向比对；产物文件清单核对 |
| AC-6 | `node --input-type=module -e "await import('./packages/forge-gitee/src/index.mjs')"` 退出码 0；模块顶层不访问未注入的 `ctx.settings`/`ctx.tools`、不发起子进程与网络；`apply()` 遇缺能力返回可读错误（`POLICY_HOST_UNAVAILABLE` 语义）而非顶层未捕获异常 | P0 | 命令退出码 + 用例：import 后断言无副作用、且不依赖宿主 |
| AC-7 | `cordis.patch.yml` 自带非空 `config.catalog`：3 条只读 `gitee.repository.read` / `gitee.issue.read` / `gitee.pr.read`（`kind: read`、`enabled: true`），**0 条 write**；显式 `config.audit`（`sink: memory`、`allowNonDurable: true`）；插件 entry 带显式 `config: {}`；离线 `compileCatalog` 后 3 条可用；catalog 为空时工具必须 `denied` 而非静默放行 | P0 | 解析补丁 + 直接调 `compileCatalog` 断言条数与 kind；空 catalog 反向用例 |
| AC-8 | 由**主 agent** 在探测到的 profile 目录（`$DSH_HOME/profiles/web`）执行 §10.3 安装；装后 profile `dependencies` 出现 `@heluo/forge-gitee`、`dsh.profile.bundles` 含包名；证据写明 dsh 版本（本机 0.2.1-rc.2，仓库目标 0.2.1-rc.3）、命令与时间 | P0 | 读 profile 清单 + 安装日志（不写死路径以外的东西；探测失败则问用户） |
| AC-9 | 重启宿主后，启动日志/插件列表出现 `@heluo/forge-gitee`，其工具在工具列表中可枚举；不出现"无 client 声明而静默跳过"；仅有源码或 tarball 不算 | P0 | 加载后的工具列表证据（日志行/截图），与 dsh 版本同框 |
| AC-10 | 安装前已在 §10.3 写明卸载步骤（`dsh plugin --profile web remove @heluo/forge-gitee` + 从 `dsh.profile.bundles` 摘除 + 恢复 profile 清单）；装后任一验证项失败即执行卸载，并**回读** profile 清单确认已移除；包名从产物 `package.json` 读取，不写死 | P0 | 卸载前后 profile 清单 diff（或"未触发回滚"的显式记录 + 步骤可用性核对） |
| AC-11 | 每条读/写结果的信封带 `provider: "gitee"`，审计记录带同一 provider；不存在"按调用点推断 provider"的分支；显式传入 `provider !== 'gitee'` 的请求直接拒且零子进程 | P0 | 单测：信封字段断言 + 注入 `provider:'github'` 断言拒绝与 0 次 runner 调用 |
| AC-12 | gitee 适配器**不导入** `gh-adapter.mjs` 及其 `GH_*` 字段常量；字段表/参数表独立（`GITEE_*`）；CLI 返回字段缺失或不符合预期时结果为 `unknown` + reason，**不得**用 GitHub 特有字段（`mergedAt`、`statusCheckRollup` 等）推断状态；gitee action id 统一 `gitee.` 前缀，devops 的策略行不能放行 gitee 调用（反之亦然） | P0 | 单测：import 图断言 + 字段缺失用例 + 交叉装配下断言 `POLICY_ACTION_UNREGISTERED` |
| AC-13 | 同一 profile 先装 `@heluo/forge-devops` 再装本包（或反之）：宿主启动后两插件都在列表中、工具都可枚举；策略服务冲突（`POLICY_SERVICE_CONFLICT`）必须以**可见**错误/`denied` 呈现，不得导致宿主启动失败或工具静默消失；README 与补丁注释写明推荐安装形态（共存或二选一） | P1 | 离线双装配 ctx 模拟；若主 agent 执行真实二次装载，补 profile 清单与启动日志 |
| AC-14 | 只读子命令为固定枚举 `repo view\|list`、`issue view\|list`、`pr view\|list`；每项只接受声明过的 `--json` 字段子集与有限参数（`--repo`/`-R`、`--state`、`--limit`，`--limit` 有固化上限）；`--web`、`--template`、任意 `-f/--raw-field` 透传、命令行字符串或 argv 数组入参一律拒绝且零子进程 | P0 | 表驱动单测：合法参数放行、越界参数断言 0 次 runner 调用 |
| AC-15 | 信封含 `status` / `source_revision` / `observed_at` / `provider` / `result_refs`；取不到版本置 `null` 并降级 `unknown`；失败 reason 为固定枚举（CLI 未找到 / 主机非企业 / 输出非 JSON / 令牌缺失 / 退出码非 0 / 输出截断）；只读失败不重试、不触发任何写 | P0 | 桩 CLI 注入六种失败，断言 reason 且写通道 0 调用 |
| AC-16 | 写工具返回 `done\|failed\|denied\|unknown`；`done` 仅等于"命令成功 + 回读一致"；幂等键 = `sha256(变更号\|对象类型\|归一化标题)` 前 16 位，执行前查同名 open 对象，命中即 `reused: true` 且 0 次创建；`unknown` 不自动重放 | P0 | 桩测试：回读不一致→`unknown`；同名已存在→`reused` 且 0 次创建；再次调用断言不重放 |
| AC-17 | 默认补丁层 catalog 不含任何写动作；此时 5 个写工具逐个返回 `denied` + `rule`，且适配器与 `execFile` 出口**均为 0 次调用**；退出码 0 不算成功；无"空成功"返回 | P0 | 负测：五写工具逐个断言 `denied` + 桩 0 调用 + 返回体无 `done` |
| AC-18 | 提交信息校验：首行须 `[<本变更号>] ` + 非空描述，违规拒绝并返回期望格式与 reason（缺变更号 / 缺描述 / 前缀缺失）；不改写 message；只读取"分支—提交—PR"关联（PR 的 head/base 与 commit sha），**不执行 git 写** | P0 | 纯函数单测（三类 reason + 正例）+ 关闭条件联动用例 |
| AC-19 | `review.md` 含问题/风险/意见/结论四段 + AI 意见栏 + **实际模型名**（更强档；降级须明示）+ commit sha；AI 意见与人工确认分栏不混写；正文不含 token、内网地址与本机绝对路径 | P0 | 夹具生成后断言四段、模型名、sha、分栏；脱敏正则零命中 |
| AC-20 | 人工确认栏只能由显式人工输入写入，模型自填路径必须拒绝；commit sha 变化后旧确认标 `stale`，且 `stale` 不得作为通过依据；平台侧发布（PR 评论）走门禁，默认禁用 | P0 | 单测：sha 变更前后断言 `stale`；模型自填断言拒绝；默认禁用断言 `denied` |
| AC-21 | 关闭条件判定输出四项（验收通过 / PR 已合入 / 无未完成交付 / 人工确认），每项带证据与来源类型；CI 与 UAT 取不到标 `unknown`；插件**只判定、不执行关闭**，命令白名单无 close/merge | P0 | 四项矩阵单测（含 unknown 分支）+ 白名单断言无 `issue close`/`pr merge` |
| AC-22 | token 只从环境变量读取（默认 `GH_TOKEN`，可配），不写 CLI 配置目录、不落仓库、不进模型上下文；工具输出/报告/日志/文档对 token 正则**零命中**；检测到 CLI 配置目录存在持久令牌时阻断并提示，不静默继续 | P0 | 含凭据样例全链路扫描 0 命中 + 持久令牌夹具断言阻断 |
| AC-23 | 所有子进程只经本包唯一 `execFile` 出口（`spawn`/`exec`/`execSync`/`shell: true` 在 `src/` 零命中）；入参只接受 `{bin,args,purpose}`；固定 argv 白名单；超时与 1 MiB 输出上限；禁项不含 `pr merge`/`pr close`/`issue close`/`release`/`workflow`/`change done`；无通用 `run`/`exec` 工具 | P0 | grep 计数 + 参数白名单单测 + 禁项用例断言拒绝且 0 子进程 |
| AC-24 | 报告与 README 逐条写明命令/时间/宿主版本/目标对象 + 来源类型（mock 实测 / 企业实测）；Windows、麒麟 aarch64、真实企业凭据、`--json` 字段稳定性未跑标 `NOT RUN`；mock 结果不得写成企业已联调 | P0 | 证据表字段核对 + 人工逐条比对 |
| AC-25 | `docs/design/plugins/forge-gitee.md` 同步模块状态与命令面/配置/失败模式/未决事项，版本与"最后更新"同步；`docs/design/README.md` 索引行状态与摘要同步；包 README 从"规划"改为实际状态；根 `pnpm check` 与 `git diff --check` 均退出码 0 | P0 | 两条命令 + 文档 diff 核对（含相对链接与表格列数） |

## 4. 范围与非目标

### 4.1 在范围内

1. **包骨架与装载面**：`packages/forge-gitee/{package.json,cordis.patch.yml,src/,test/,README.md}`；`dsh.bundle.patch` 声明；构建期闭包（`@heluo/forge-policy`）；离线测试进入 `node --test` 自动发现。
2. **工具面 8 个**（命名与 devops 对齐，provider 前缀 `forge_gitee_`）：
   - 读：`forge_gitee_repository_read`、`forge_gitee_issue_read`、`forge_gitee_pr_read`
   - 写（默认禁用）：`forge_gitee_issue_write`（创建/评论）、`forge_gitee_pr_write`（建 PR：head/base；评论）、`forge_gitee_review_publish`（AI 意见发布/评论；受门禁）、`forge_gitee_review_record`（本地 `review.md` 记录）、`forge_gitee_delivery_gate`（提交信息校验 + 关闭条件判定，只读）
3. **provider 分流**：独立 `src/gitee-adapter.mjs`（`GITEE_*` 字段表/参数表）、策略 action 前缀 `gitee.`、信封与审计带 `provider`。
4. **受控写语义**：四状态、幂等键与复用、回读确认、`unknown` 不重放、禁项。
5. **审查与交付**：`review.md`（AI/人工分栏 + 模型名 + sha + stale）、提交信息前缀校验、关闭条件判定。
6. **安全与证据**：唯一 `execFile` 出口、固定 argv 白名单、超时与输出上限、凭据只经环境注入、持久令牌检测、证据来源类型。
7. **文档同步**：设计文档、设计索引、包 README（AC-25）。

### 4.2 非目标

- **不自动合并、不关闭 Issue、不触发 CI/流水线、不发版**（承 r1 AC-19）。
- **不实现 Gitee OpenAPI 客户端、不自建 MCP、不交叉编译**（沿用设计文档 V0.2.0 结论）。
- **不批量跨仓抓取、不做缓存层**（设计文档"需用户确认的设计选项"表已定：暂不）。
- **不改写 forge-devops 的 GitHub 适配器与命令面**，也不把两个 provider 合并进一个可切换的工具。
- **不复制 r3 的 Web 配置页**：本轮配置走补丁层 `config`（`gitee.cliPath`、`gitee.host`、`gitee.timeoutMs`、`gitee.authEnv`），可视化留待 T5 决定。
- **不执行 git 写**（建分支、提交、推送）：提交信息只校验，PR 只创建与读取（T1 待确认）。

### 4.3 关联验收单映射（实现前置）

| 单 | 主题 | 对应 AC |
|---|---|---|
| #26 | Gitee CLI 实证与只读 | AC-11、AC-12、AC-14、AC-15、AC-22、AC-24 |
| #30 | Issue 创建维护 | AC-16、AC-17、AC-23 |
| #31 | Git 追溯与 PR | AC-16、AC-18、AC-21 |
| #34 | AI 审查发布 | AC-19、AC-20 |
| #35 | 人工 review | AC-19、AC-20、AC-21 |
| #40 | 双端准入 | AC-9、AC-24（Windows/麒麟 aarch64 按 `NOT RUN` 记账） |

## 5. 反面目标（anti-goals）

> "就算技术上都跑绿了，人也会拒绝的结局"。

- **AG-1 两套语义悄悄换位**：对企业 Gitee 仓库查询，结果实际按 GitHub 字段表解读——把 `mergedAt` 当合入依据，报告写"已合入"而 Gitee 侧仍是 open；或 devops 工具被 gitee 参数喂进去却返回 `done`。
  可核对方式：离线注入 Gitee / GitHub 两种 CLI 桩并交叉调用，断言字段值来自对应 provider、零串味；任一报告字段能追到 provider 与命令。
- **AG-2 装上但宿主静默跳过**：安装步骤"成功"，插件列表里却没有 `@heluo/forge-gitee`，且没有任何报错；或补丁 entry 因 `name` 写成子路径、catalog 为空而不激活，页面一片安静。
  可核对方式：装载后必须给出"工具列表含 8 个 `forge_gitee_*`"的证据；没有该证据时文档不得写"已加载"（AC-9/AC-24）。
- **AG-3 写动作"看起来能用"**：默认禁用状态下写工具返回成功样式或空结果，用户以为 Issue 已建；或反过来，在未审批时真的打到了远端。
  可核对方式：负测断言远端桩 **0 次调用** + 返回 `denied` 且带 `rule` + 返回体不含 `done`（AC-17）。
- **AG-4 凭据可被一次 grep 命中**：token 出现在工具输出、`review.md`、报告或日志里，或被写进 CLI 自己的配置目录；持久令牌检测只在文档里存在、运行期不阻断。
  可核对方式：用带 token 的样例跑全链路，对输出/产物/日志做正则扫描零命中；构造持久令牌夹具，断言阻断而非继续（AC-22）。
- **AG-5 拿 mock 冒充企业证据**：报告或 README 写"企业 Gitee 已联调"，实际证据是本地仿 CLI；麒麟 aarch64 与 Windows 未跑却写成支持。
  可核对方式：证据表每行带来源类型与命令/时间/目标对象；`NOT RUN` 项与已验项在同一张表里可区分（AC-24）。

## 6. 交互流程摘要

**6.1 只读查询（US-1）**：工具入参（`owner/repo`、可选 `state`/`limit`）→ provider 固定为 `gitee` → 策略 `gitee.<area>.read`（补丁层默认启用）→ `gitee-adapter` 组装 `GITEE_*` 字段子集 → 唯一 `execFile` 出口执行 `gh … --json <子集>` → 按 Gitee 字段表解析 → 信封（`status`/`source_revision`/`observed_at`/`provider`/`result_refs`）。失败即固定 reason；字段缺失或 CLI 输出非 JSON 一律 `unknown`，不用 GitHub 字段补猜。

**6.2 受控写（US-2）**：写工具 → 策略门禁（默认 catalog 无写动作 → `denied` + `rule`，**不进入**适配器）→ 启用后：提交信息/目标对象校验 → 幂等查重（同名 open 对象 → `reused`，0 次创建）→ 执行一次 `create`/`comment` → 回读确认 → `done`；回读不一致 `unknown`，不自动重放；退出码 0 不等于 `done`。

**6.3 审查留痕（US-3）**：`forge_gitee_review_publish` 生成/追加 `review.md`（问题/风险/意见/结论 + AI 栏 + 实际模型名 + commit sha），平台发布为可选二次动作（受门禁、默认禁用）；`forge_gitee_review_record` 写入显式人工确认（模型不得自填）；sha 变化 → 旧确认 `stale`，不再作为通过依据。

**6.4 交付判定（US-4）**：`forge_gitee_delivery_gate` 校验提交信息 `[<变更号>] ` 前缀 → 读 PR 的 head/base 与 commit 关联 → 读取检查状态（取不到 `unknown`）→ 输出四项关闭条件与证据 → 结束。**不关闭 Issue、不合并 PR**。

## 7. 优先级

- **P0（缺一不可，24 条）**：AC-1~AC-12、AC-14~AC-25。理由是宿主九项交付契约（AC-1~AC-10）、provider 隔离（AC-11/12）、只读面（AC-14/15）、写语义（AC-16/17）、安全与证据（AC-22~AC-24）、文档门禁（AC-25）任缺一项都不能算交付。
- **P1（1 条）**：AC-13（双包共存的装载后果）。企业是否需要同一 profile 内同时用 GitHub 与 Gitee 取决于部署形态（F4）；若 F4 判定为"必须共存"，AC-13 升 P0，并要求在真实 profile 上完成二次装载验证。

## 8. 依赖与风险

**依赖**

- `@heluo/forge-policy`（workspace 协议，构建期闭包进安装单元）：策略目录编译、`executeAction`、审计。
- 宿主 `dsh >= 0.2.1-rc.2`；本机已装 **0.2.1-rc.2**，仓库目标 `.dsh-version` 为 0.2.1-rc.3——装载证据必须注明宿主版本，不得跨版本外推。
- `scripts/build-enterprise-bundle.mjs#buildBundle` 与 `scripts/check-bundle-tarballs.mjs`：安装单元与 tarball 审计的唯一路径。
- 安装发生在工作区之外（`$DSH_HOME/profiles/web`），**子代理写不了**，必须由主 agent 执行（§10.3）。
- 关联验收单 #26/#30/#31/#34/#35/#40 的证据（§4.3）。

**风险**

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 企业 `gh` 的 `--json` 字段名/支持集合与设计文档示意不一致 | 字段表集中一处、按可用子集探测；取不到即 `unknown`；字段稳定性标 `NOT RUN`（AC-12/AC-24） |
| R2 | 麒麟 aarch64 / Windows 产物未验 | 不写"已支持双端"；#40 证据到位前一律 `NOT RUN`；不做交叉编译（非目标） |
| R3 | 凭据注入方式未验（变量名、双端差异） | 只按环境变量约定实现，缺令牌 fail closed；持久令牌检测阻断（AC-22） |
| R4 | 与 forge-devops 同时装入时的策略服务冲突（`POLICY_SERVICE_CONFLICT`） | AC-13 离线双装配 + README 写明推荐形态；补丁层不制造第二个同名 id 的隐式叠加 |
| R5 | 本轮无企业写授权 | 写动作默认禁用 + 负测证明（AC-17）；绝不指向真实远端（工程约束 §10.1） |
| R6 | 宿主 rc.2 / rc.3 差分导致装载行为不一致 | 证据注明版本；设计文档记录差异影响 |

## 9. 里程碑建议

| 里程碑 | 内容 | 出口 |
|---|---|---|
| M1 骨架与装载 | 清单、补丁层、构建闭包、离线测试骨架（AC-1~AC-7） | `pnpm check` 绿；`import` 退出码 0 |
| M2 真机装载与回滚 | 主 agent 安装、重启验证、回滚步骤可用（AC-8~AC-10） | 工具列表证据 + profile 清单 diff |
| M3 只读与隔离 | `gitee-adapter` 字段/参数表、信封、provider 隔离（AC-11~AC-15） | 交叉装配与桩测试全绿 |
| M4 受控写与审查交付 | 四状态/幂等/回读、默认禁用负测、`review.md`、关闭条件（AC-16~AC-21） | 负测与矩阵用例全绿 |
| M5 安全、证据与文档 | 凭据与出口审计、证据表、设计文档与索引同步（AC-22~AC-25） | `pnpm check` + `git diff --check` 绿；未验项 `NOT RUN` 入表 |

## 10. 工程约束

### 10.1 用户工程指令（原文照录）

- 「新建**独立包** `@heluo/forge-gitee`，一轮内**同时交付查询与受控写**——仓库/Issue/PR 查询，以及 Issue 创建维护、分支提交与 PR 关联、AI 审查意见发布、人工 review 记录、交付关闭条件判定。不要退化成"只读先行"。」
- 「交付物：`package.json`（`engines.dsh`、`private`、真实测试入口）、`src/`、`test/`、`cordis.patch.yml`、README 状态更新；同步 `docs/design/plugins/forge-gitee.md` 与 `docs/design/README.md` 设计索引登记；`pnpm check` 通过。」
- 「本轮无企业平台写授权，不得对真实远端执行写操作，受控写以默认禁用 + 负测证明。」
- 「未验项如实记录：企业 `gh` 在麒麟 aarch64 的产物、凭据方式、`--json` 字段稳定性属**待核验**，不得写成已验证或已实现。」
- 「不要再核验它是否存在，也不要把它当假设或阻塞项；需要核验的只剩事实层面：CLI 版本、Windows / 麒麟 aarch64 双端产物、凭据注入方式、`--json` 输出字段稳定性。」
- 「仓库既有纪律（基线，不是待定项）：写动作默认禁用、需范围与审批台账；不自动合并、不自动关闭 Issue、不触发 CI；凭据只经环境注入，不落仓库/CLI 配置/模型上下文；只走 `execFile` + `shell:false` + 固定 argv 白名单 + 超时 + 输出上限；必要审计前置。安装单元保持单包自洽（`package.json` + `cordis.patch.yml` + `bundledDependencies` 闭包）。」

### 10.2 分支与工作区

- 当前分支 `feat/devops-change-flow`；未提交改动仅 `docs/teamflow/20261029-r4-forge-gitee/`（本任务夹）。**不新建分支、不切换分支**；本轮产生的代码与文档改动留在该分支工作区。
- 提交、推送、合并均需用户当次明确授权，本次未授权：**不提交、不推送**。worktree 中他人未提交改动一律不覆盖、不回退（不得 `git reset --hard` / `git checkout --`）。
- 目录边界：代码与文档只写 `packages/forge-gitee/`、`docs/design/plugins/forge-gitee.md`、`docs/design/README.md`、本任务夹；不写宿主 `docs/<role>/`，不在项目根堆放日志。

### 10.3 安装与回滚（**由主 agent 执行**，子代理无工作区外写权限）

探测结果（起跑时确认，禁止改动）：`DSH_HOME` 已设置（本机绝对路径不在文档中复写），profile=`web`，`dsh` 在 PATH（`0.2.1-rc.2`）。下文命令一律用 `$DSH_HOME/profiles/web` 表示 profile 目录。

安装（开发/验证阶段，先构建安装单元再装本地 tgz）：

```sh
# 1) 构建安装单元（workspace 协议在该步闭包为真实版本）
node --input-type=module -e "import('./scripts/build-enterprise-bundle.mjs').then(m=>m.buildBundle({entry:'@heluo/forge-gitee',destination:'dist/r4'}))"
# 2) 装入 profile（参数原样转发给 profile 目录里的 pnpm）
dsh plugin --profile web add "$(ls dist/r4/heluo-forge-gitee-*.tgz | head -1)"
# 3) 确认 bundles 含包名（该字段需手工维护，不由 dsh plugin 自动添加）
grep -n '"@heluo/forge-gitee"' "$DSH_HOME/profiles/web/package.json"
```

回滚（安装前已备好，任一验证项失败立即执行）：

```sh
cp "$DSH_HOME/profiles/web/package.json" "$DSH_HOME/profiles/web/package.json.bak-r4-install"
dsh plugin --profile web remove @heluo/forge-gitee
# 从 dsh.profile.bundles 数组中摘除 "@heluo/forge-gitee"，并回读确认
node -e "const p=process.env.DSH_HOME+'/profiles/web/package.json';const j=require(p);console.log(JSON.stringify({deps:j.dependencies?.['@heluo/forge-gitee']??null,bundles:j.dsh?.profile?.bundles?.includes('@heluo/forge-gitee')??null}))"
```

约束：包名从产物 `package.json` 读取，不写死；不新增、不改动 profile 里的其他条目；安装证据写 dsh 版本与时间。

### 10.4 版本控制卫生

开发阶段核对并补全根 `.gitignore`（本栈实际产物）：`node_modules/`、`.pnpm-store/`、`dist/`、`coverage/`、`*.tgz`、`*.log`、`.env`/`.env.*`、`.DS_Store`、`logs/`。已覆盖项不重复添加；新增项须与真实工具链一致（纯 ESM 包无编译产物，故不引入 `lib/`、`build/` 之类空目录规则）。收尾提交前 `git status --short` 不得出现 tgz、日志、凭据样例。

### 10.5 门禁

根目录执行 `pnpm check`（文档 → 仓库 → tarball → 版本 → `node --test` 自动发现）与 `git diff --check`；新包测试必须被 `node --test` 自动发现并为离线用例（不联网、不装包、不触真实远端）。

## 11. 假设与待澄清

**（a）未定事实（`kind: fact`）**

- **F1 企业 `gh` 的 `--json` 字段集合与命名**。假定：与设计文档 §5 示意的 GitHub 兼容形态（`name`、`defaultBranchRef`、`number`、`title`、`state`、`author`、`files` 等）基本一致，但**按未验处理**。为何留空：需要企业侧实跑一次 `gh … --json` 才能确定。若判定不一致：字段表按实测收缩，缺失字段一律 `unknown`，命令面相应收窄。
- **F2 企业 `gh` 的凭据注入方式**（变量名、Windows 与麒麟是否一致）。假定：`GH_TOKEN` 环境变量，插件只读不写、缺令牌 fail closed。若实际是别的变量或设备码/SSO：`gitee.authEnv` 需支持多名并调整 fail closed 提示文案。
- **F3 企业开发机的 OS/架构分布**（是否真的有麒麟 aarch64）。假定：以 Windows 为主，麒麟 aarch64 存在但未验。若只有 Windows：#40 的 aarch64 证据可降级为记录不阻塞；若 aarch64 强制，则"不做交叉编译"的结论（非目标）需要重审。
- **F4 forge-devops（GitHub）与本包是否需要同一 profile 共存**。假定：**二选一安装为主**，共存仅作为可验证场景。会影响 AC-13 优先级（见 §7）与 README 的安装说明；若必须共存，策略服务只能有一个实例这一约束要在设计阶段正面解决。

**（b）用户口味（`kind: taste`，各带推荐项）**

- **T1 本包是否执行 git 写操作**（建分支、提交、推送）。推荐：**不执行**——只校验 `[变更号]` 前缀、读取分支/提交/PR 关联，写动作仍由开发者或主 agent 执行。理由：写动作默认禁用与"无写授权"是本轮硬约束，且 git 写与"平台写"的审计边界不同，混在一起会让授权面变大。若选"要执行"：需新增 `git` 出口（另一套白名单与回滚语义），本轮范围显著扩大。
- **T2 Issue 维护的范围**。推荐：**创建 + 评论**为默认面，编辑标题/正文/标签与关闭另列（关闭永不自动）。理由：与 r1 AC-19 的"不关闭 Issue"一致，且编辑的幂等与回读语义更复杂。若选"含编辑"：幂等键需扩展到编辑对象版本，AC-16 判据要补一条。
- **T3 审查结论的落盘形态**。推荐：**本地 `review.md` 为主证据，PR 评论为可选二次发布**（受门禁、默认禁用）。理由：本轮无平台写授权，本地留痕才能验收；PR 评论一旦发出去不可撤回。若选"只发 PR 评论"：本轮无法交付可验收的审查证据。
- **T4 工具面粒度**。推荐：**8 个固定工具**，命名与 devops 对齐（`repository_read`/`issue_read`/`pr_read`/`issue_write`/`pr_write`/`review_publish`/`review_record`/`delivery_gate`）。理由：与既有工具面同构，使用者迁移成本最低；不提供"一个工具 + `action` 参数"的泛化面（那会重新长出一个通用 `run`）。若希望更少：可合并两个 review 工具，但需重设 AC-19/AC-20。
- **T5 配置面形态**。推荐：**只做补丁层 `config`**（`gitee.cliPath` 默认 `gh`、`gitee.host`、`gitee.timeoutMs`、`gitee.authEnv`），不复制 r3 的 Web 配置页。理由：CLI 名已确认、无需自动发现编排，配置页的收益主要在"找路径"，此处不存在该问题。若企业要求可视化：另开需求，避免本轮把 r3 的六键配置页复制一份。
