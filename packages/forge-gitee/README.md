# @heluo/forge-gitee

状态：可用（离线用例全绿；只读面的字段名与响应形状已按 2026-11-03 企业实测反写，argv 形状、`--state` 词表、空结果解包与凭据路径按实测规格 `docs/contracts/gh-cli-spec.md` 对齐；实机与真实凭据见[未验（NOT RUN）](#未验not-run)）

| 项 | 内容 |
|---|---|
| 形态 | 独立单安装单元：`cordis.patch.yml` + Node ESM 源码，往宿主注入 11 个 `forge_gitee_*` 工具（3 读 + 1 只读判定 + 1 版本快照 + 4 受控写 + 2 git） |
| 职责 | `gitee.*` 只读查询（仓库 / Issue / PR）、只读交付判定、只读代码版本快照、受控写（Issue、PR、审查发布与记录）、本地 `git commit` 与 `git push`、审查 `review.md` 与关闭条件判定 |
| 不负责 | 不重写 Gitee API，不自建 MCP，不做 arm64 交叉编译，不执行 `checkout`/`merge`/`rebase`/`tag`/`revert`，不合并/关闭/发版，不把个人凭据写入仓库或模型上下文 |
| 衔接点 | `tools` + `policy` 两个注入服务；策略目录与审计由 `@heluo/forge-policy` 提供；唯一子进程出口 `src/gitee-cli.mjs`（gitee CLI 与本机 git 共用） |
| 详细设计 | [DESIGN-010](../../docs/design/plugins/forge-gitee.md) |
| 实现状态 | `package.json`、`src/`（15 模块）、`client.js`（设置页「Gitee」）、`test/`（见[测试](#测试)）、`cordis.patch.yml` 已落地；r15 新增三层读面（`src/config-access.mjs`）与配置端点（`src/http.mjs`），**设置页实机渲染未验** |

`GITEE_PLATFORM='gitee'` 是本包唯一的平台声明，落在每个信封与返回体上。仓库 / Issue / PR 的事实只有这一份实现：`@heluo/forge-devops` 退回 dop 变更流程四工具，`change_context` 的承建仓库段改为外部指引（`REPO_FACTS_EXTERNAL` → `forge_gitee_repository_read` / `forge_gitee_issue_read`）。字段只有白名单一套（`GITEE_FIELD_PROJECTIONS`），而且名字是**实测来的**：2026-11-03 在企业机器上取到 `repo view`/`issue list`/`pr list` 三段真实输出，据此把 gh 风格的猜测全部换掉（仓库没有 `url`/`private`/`updated_at`，PR 编号是 `iid`、Issue 是 `id`，链接是 `web_url`），`mergedAt`/`statusCheckRollup`/`reviewDecision` 这类 GitHub 语义名字与实测不存在的旧名一律不在表里，请求即拒绝、返回不进对象。同时实测确认 `--json` 是**无值开关**（`--json name,path` 与裸 `--json` 输出逐字相同），所以字段清单只做**本地投影**、不进 argv；响应按 `{data:{list:[…]}}`/`{data:[…]}`/扁平对象剥壳，`pr list` 空结果的 `{"message":"No pull requests found."}` 解成 0 条、不报畸形。没有独立的黑名单，也没有「结果来自别的 provider」这类原因码——本包只服务 Gitee 一个平台，那类事实不存在。两个包不共享源码，只共享不变量与契约测试。

## 安装

```sh
# 1. 构建安装单元（构建期把 workspace: 依赖闭包成真版本，产物自带策略包）
node --input-type=module -e "import('./scripts/build-enterprise-bundle.mjs').then(m=>m.buildBundle({entry:'@heluo/forge-gitee',destination:'dist/r7'}))"
# → dist/r7/heluo-forge-gitee-0.1.0.tgz

# 2. 装进 profile（tarball 自带包内补丁层，宿主按 dsh.bundle.patch 自动挂载策略行 + 插件行）
dsh plugin --profile web add dist/r7/heluo-forge-gitee-0.1.0.tgz

# 3. 复核补丁层是否进了组合树（应看到 heluo-policy 与 heluo-gitee 两行，策略在前、两行都没有 isolate）
dsh --profile web --dump-config | grep -E "id: (heluo-policy|heluo-gitee)"
```

清单要点：`engines.dsh: >=0.2.1-rc.2`；`main`/`exports` 指向 `src/*.mjs`（无编译产物、无 `lib/`），另有 `exports['./client'] = './client.js'` 供宿主 Web 外壳装载；`files` 白名单只含 `src`、`client.js`、`cordis.patch.yml`、`README.md`；`dependencies` 只有 `@heluo/forge-policy`（源码 `workspace:*`，安装单元闭包成真版本并进 `bundledDependencies`）；`dsh.client = {platform:'web', immediately:true, inject:['slots','locale']}`；`peerDependencies = {react:'>=18'}` 且 `peerDependenciesMeta.react.optional = true`——react 由宿主提供，构建期 `HOST_PEERS` 规则允许它留在清单里但不进闭包、不进 tarball。

## 配置

五个扁平键，全部可选，来自补丁层的 `config:`（r15 起也可在设置页改其中两项，见[设置页](#设置页企业-giteer15)）。配置里没有存令牌的字段——凭据主路径是 `gh` 自己的系统凭据库（服务名 `gitee-cli-go`），先在终端运行一次 `gh auth login`；`authEnv` 只是无桌面凭据库或 CI 的兜底注入通道。**空配置也是合法状态**。

| 键 | 默认 | 约束 | 说明 |
|---|---|---|---|
| `cliPath` | `gh` | 可执行文件名/路径；拒绝 `scheme://`、控制字符、`.cmd`/`.bat`/`.ps1`/`.com`/`.vbs` 包装脚本 | 企业已确认 CLI 名为 `gh`；配置值只决定"起哪个程序"，不改变命令面 |
| `host` | 空（无默认） | 主机名（可带端口），拒绝协议前缀、路径与 userinfo | r10 起**不必填**：不配即不做企业域断言；配了非企业主机仍以 `HOST_NOT_ENTERPRISE` 拒绝。**只用于诊断与企业域校验**：它不是 CLI 参数也不是环境变量，CLI 的主机来自它自己的 `~/.gitee-cli/config.json` 的 `base_url`（规格 §1.1/§1.5） |
| `timeoutMs` | `20000` | `1000`–`600000` 的整数 | 单次 CLI 调用超时；超时按"可能已执行"降级 `unknown`，不重放 |
| `authEnv` | `[]` | 最多 8 个变量名（`[A-Za-z_][A-Za-z0-9_]*`） | 兜底凭据变量名清单。不点名时 `preflight()` 返回 `tokenSource: 'none'`，这**不代表未认证**：`gh` 仍会查系统凭据库；`GITEE_TOKEN` 是子进程白名单里的唯一凭据例外、不点名也会继承，其它凭据变量仍只经这里显式注入。服务端 401/403 时如实降级 `AUTH_MISSING`（有子进程），不阻断装配 |
| `persistentToken` | `'warn'` | `'warn'` \| `'block'` | CLI 配置目录含持久令牌时的策略：候选含 `~/.gitee-cli/config.json`（JSON 里 `token` 非空即命中）与 `gh` 兼容的 `hosts.yml` 等；`warn` 只提示，`block` 才拒绝执行（合规场景保留） |

`describeGiteeConfig()` 只输出枚举、数字与环境变量**名**（路径只留文件名），返回值里不存在令牌值；`validateGiteeConfig()` 是补丁层、宿主 `ConfigStandard` 与 `resolve` 的唯一口径，未知键直接拒绝，`missing` 只收"提供了但非法"的键。

## 设置页（Gitee，r15）

进入路径两次点击：首页 → 左下「设置」→ 侧栏「Gitee」。分区 id `gitee`、order 50，由本包 `client.js` 提供（`settings.section` 槽，`ctx.slots.inject` 两段式挂载；`ensureStyle` 返回 disposer）。

同一 profile 装了研发容器（`@heluo/forge-enterprise` 的 `forge-engineering` 分区）时，本面板改为挂进容器的子槽位 `heluo.engineering.tab`（order 20）并撤掉独立分区：`client.js` 先等子槽位声明，出现后释放已注册的独立分区再注册容器条目；容器缺席（单包安装）时保持上面的独立分区。

页面是**一张五行三列的表**：每行一个配置键，三列分别是「公共参数」（补丁层/企业下发的值）、「本机覆盖」（这台机器在页面上改过的值）、「最终生效」。只有两项可编辑：

| 行 | 可编辑 | 说明 |
|---|---|---|
| 命令行入口（`cliPath`） | 是 | 输入框里是**当前生效值**；「改为手动指定」把草稿变成覆盖，「恢复继承」在保存时删除本键的本机覆盖（先说明这一后果）。本页不判后缀，运行期失败会说明原因 |
| 超时（`timeoutMs`） | 是 | 毫秒，`1000`–`600000`；留空提交 `null` 即删键回落到默认 |
| 主机（`host`） | 否 | 只显示来源；值不在本页显示（它会进企业域校验，但不是凭据） |
| 凭据变量名（`authEnv`） | 否 | 只显示**允许的变量名**，不显示值 |
| 持久化策略（`persistentToken`） | 否 | 显示 `warn`/`block`，本页不修改 |

交互要点：保存只提交**改过的**已知键 + 服务端快照里的 `revision`；`revision` 过期回 409 并**保留草稿**（不静默丢弃）；字段非法回 422 时逐字段聚焦、写盘 0 次；保存成功但运行时没应用上，回执写「已保存；未应用」并给出原因，不假装生效。页面**没有**「检查」按钮——本包没有获批的只读探测，披露块里恒显示「未执行」，也不发 `?refresh=1`（该参数只属于 devops 分区的 DevOps 行）。写入面不可用（profile 没挂配置面）时整页降级为只读并给环境变量出口，而不是渲染一个存不进去的表单。

服务端契约：`GET /api/forge-gitee/config` 返回 `{revision, plugin, writable, ready, reason, guidance, editable, missing, entries, host, readAt}`；`POST` 同路径要求 `x-forge-gitee-request: 1`、体只认 `{revision, fields}`、超 64 KiB 回 413，状态码映射 409 冲突 / 422 非法 / 503 不可用，成功体带 `applied`。写成功后单点重建读面（`rebuildFaces()`），页面配的 `cliPath` 立刻用于运行期，不需要重启。

## 工具面（10 个，顺序与命名固定）

| 工具 | 参数 | 策略动作 | 默认 |
|---|---|---|---|
| `forge_gitee_repository_read` | `target` | `gitee.repository.read` | 放行（补丁层已登记） |
| `forge_gitee_issue_read` | `target`、`list`/`state`(created\|processing\|rejected\|finished\|all)/`limit`/`json` | `gitee.issue.read` | 放行（补丁层已登记） |
| `forge_gitee_pr_read` | `target`、`list`/`state`(opened\|closed\|merged\|all)/`limit`/`json` | `gitee.pr.read` | 放行（补丁层已登记） |
| `forge_gitee_issue_write` | `op`(create\|comment)、`target`、`changeId`、`body`、`confirm` | `gitee.issue.write` | `denied`（未登记） |
| `forge_gitee_pr_write` | `op`(create\|comment)、`target`、`changeId`、`body`、`confirm` | `gitee.pr.write` | `denied`（未登记） |
| `forge_gitee_review_publish` | `target`、`changeId`、`commit`、`body`、`confirm` | `gitee.review.publish` | `denied`（未登记） |
| `forge_gitee_review_record` | `repoRoot`、`changeId`、`commit`、`model`、`opinion`、`conclusion` | `gitee.review.record` | `denied`（未登记） |
| `forge_gitee_delivery_gate` | `changeId`、`message`、`criteria` | `gitee.delivery.judge` | 放行（补丁层已登记为只读判定：`kind: read`、`target: change`、`egress: allow`） |
| `forge_gitee_delivery_snapshot` | 无参 | 无（本地只读动作） | 可直接调用；只读当前工作区版本，不在策略目录、不起写命令 |
| `forge_gitee_git_commit` | `changeId`、`message` | 无（本地动作） | 可直接调用；`message` 先过 `assertCommitMessage()`，不合规即 `COMMIT_MESSAGE_INVALID`、零子进程 |
| `forge_gitee_git_push` | `target`、`remote`（默认 `origin`）、`branch`、`confirm` | `gitee.git.push` | `denied`（未登记）；远端写，进 `CONFIRM_REQUIRED_ACTIONS` |

11 个工具按能力分五类：**3 读 + 1 只读判定 + 1 版本快照 + 4 受控写 + 2 git**。版本快照同样只读：它把「这次交付验的是哪一份代码」落成 `contentId`（覆盖暂存、未暂存、删除、重命名与未跟踪内容），不接受调用方传目录，截断、超时、未支持形态或采样期间有写入者时一律 `unknown`。判定与写的区别是结构性的，不是放行程度不同：判定只读仓库/提交状态并比对提交信息与关闭四条件，不产生远端写，返回体 `executed` 恒为 `false`、`remote_calls` 恒为 `0`；受控写各有 `done`/`failed`/`denied`/`unknown` 四状态与幂等台账。`git commit` 是唯一"必须发生"的动作，因此按本地动作处理（任何 enabled 的非读动作恒需审批，见 `packages/forge-policy/src/approvals.mjs:102`，把 commit 放进目录只会让它永远等审批）；`git push` 是远端写，必须登记 + 审批 + `confirm` 逐字匹配。工具名与注册顺序不因放行策略变化。

没有 `run`/`exec`/`shell`/`api` 这类泛化入口：动作是具名枚举，表里拼不出的动词在包里不存在（`pr merge`、`pr close`、`issue close`、`release`、`workflow`、`api`、`auth`、`config`、`gist` 属禁项，出现即拒绝且零子进程）。

## CLI 调用形状

argv 按 2026-11-03 实测的规格 `docs/contracts/gh-cli-spec.md` 逐条对齐（不是按 gh 直觉拼的）：

| 命令 | argv 形状 | 说明 |
|---|---|---|
| `issue view` / `pr view` / `issue comment` / `pr comment` | `['issue','view','12','-R','owner/repo','--json']` | 位置参数**只有一个数字号**，仓库由全局 `-R` 给（规格 §2.4/§2.5）；把 `owner/repo#12` 整串当编号传必然失败。纯数字 target（`['issue','view','12']`）**有意不发 `-R`**：此时按 CLI 的 git remote 规则解析仓库（规格 §1.2） |
| `repo list` | `['repo','list','--json','--limit','20']` | **不是仓库作用域命令**（Usage：`gh repo list [flags]`）：它列的是令牌可见的仓库，`target` 只做形状校验、不进 argv，不存在"按仓库过滤" |
| `issue list` | `['issue','list','-R','owner/repo','--json','--state',…,'--limit',…]` | `--state` ∈ `created`/`processing`/`rejected`/`finished`/`all`；**不传就不发**，默认 `created` 归 CLI |
| `pr list` | 同上（动词换成 `pr`） | `--state` ∈ `opened`/`closed`/`merged`/`all`；不传就不发，默认 `opened` 归 CLI |
| 全部命令 | 全局 flag 只有 `-R/--repo`、`--json`、`--debug`、`-h/--help`、`-v/--version` | 没有 `--host`（传了按未声明参数拒绝）；主机来自 CLI 自己的 `~/.gitee-cli/config.json` 的 `base_url`，既不是参数也不是环境变量（规格 §1.1/§1.5） |

结果契约：

- **读**：信封 `{provider:'gitee', action, status, source_revision, observed_at, target, result_refs, missing_fields, detail}`；状态 `succeeded`/`failed`/`partial`/`unknown`，准入拒绝另记 `denied`；失败降级为数据（`reason` 固定枚举），不抛二次错误。载荷另带 `object`（对象读）或 `items`/`count`/`total_count`（清单读，`total_count` 来自 CLI 的 `meta.total_count`；取不到时输出 `null` 表示未知，不伪造 0）。清单读的 `source_revision` 恒为 `null`：列表不承诺单对象修订号，对象读才要求事实版本。`json` 参数是**本地投影选择器**（默认完整声明集，越界名字按 `JSON_FIELD_NOT_DECLARED` 拒绝），不改变 argv；清单投影按实测载荷：`issue list` 元素恰好 `description`/`id`/`labels`/`title`/`updated_at`（没有 `state`/`web_url`）。剥壳认得 `{data:{list:[…]}}`、`{data:[…]}`、扁平对象，以及 `pr list` 空结果的 `{"message":"No pull requests found."}`——后者解成 0 条，不报畸形。事实版本：Issue 取 `created_at`、PR 取 `updated_at`、仓库取 `last_activity_at`（实测无 `updated_at`）；取不到即 `unknown`，不编版本。
- **写**：四状态 `done`/`failed`/`denied`/`unknown`。`done` 必须"CLI 成功 + 回读一致"；退出码 0 单凭算 `unknown`。写前有幂等台账（`sha256(变更号|动作|对象类型|规范化目标|归一化标题)` 前 16 位，进程内 6 小时），命中返回 `reused` 且远端 0 次调用；失败不重放。键同时含**动作**与**目标**：`review.publish`（远端 PR 评论）与 `review.record`（本地 `review.md`）即使变更号、提交与标题相同也落不同的键，不会把一次写的结果复用到另一份对象上。被拒/失败/不确定信封另带 `next_action`（固定动词，如 `register-policy-action`、`confirm-object`、`configure-credentials`、`verify-remote-state`），`done` 不带"下一步"；交付判定未通过属"确定失败但无错误原因码"，给 `complete-delivery-criteria`，避免调用方把"关闭条件未满足"误判成参数错误。写动作返回体**不出现 `executed` 键**（该键只由判定体的 `produced` 声明产生）。
- **审查**：`review.md` 四段（问题 / 风险 / 意见 / 结论）+ AI 与人工两栏物理分节；人工栏只能由 `recordHumanConfirmation` 写，模型自填即拒；`stale` 是派生结果不落盘。
- **对象不存在 vs 服务故障**：读/写失败原因新增 `ITEM_NOT_FOUND`。仅当子进程已启动、非零退出、诊断文本明确表达 404 / 未找到 / Not Found / does not exist / no such（并排除 `command not found` 这类环境错误）时归类，`message` 保留服务端原文（脱敏 + 截断 160 字符），`detail.mayHaveSideEffect: false`——改正目标后可安全重试；真实 5xx 服务故障仍是 `NONZERO_EXIT`。判定是诊断文本启发式：服务端对不存在对象返回 200 或换一套文案时会落回 `NONZERO_EXIT`/畸形，不冒充确定结论。

- **快照的“不是仓库”提示**：`forge_gitee_delivery_snapshot` 在 `GIT_SNAPSHOT_NOT_A_REPOSITORY` 时只读探测一层直接子目录（固定 `git rev-parse --show-toplevel` + `rev-parse HEAD`，最多 8 个候选，跳过隐藏目录与依赖/产物目录，不跟随软链），若某个子目录自身就是仓库根，`message` 给出「子目录 <相对名>/ 是仓库根（HEAD=<7 位>）」并建议切换工作目录；不命中保持原文案。探测只补充提示，不改变 `status`/`reason`，不输出绝对路径或 stderr 原文。

- **变更号真实性不在判定范围**：`forge_gitee_delivery_gate` 只校验提交信息首行是否带 `[变更号]`、关闭四项是否成立，**不校验该变更号在工单/需求系统里是否存在、是否属于本次交付**——变更号只作提交信息与台账的组织坐标。`ready: true` 表示"这四项条件成立"，不构成平台对变更真实性的背书；这是设计如此，不是校验缺口。真实性由提交人、评审人与远端 Issue/PR 记录共同承担。

- **现有关闭条件判定**：只判定不执行——`[变更号]` 提交信息前缀、关闭四条件（验收、已合入、无未完成交付、针对当前 commit 的人工确认），`unknown` 不计入通过；返回体带 `executed: false` 与 `remote_calls: 0` 作为"只判定"的运行时证据；包里没有 close/merge 入口。此处如实描述现有判定器，不是所有用户验收的统一门槛：2026-11-03 已确认本地验证与独立 AI 审查后可形成待验收候选，由用户对实际代码版本验收；CI／合入／Issue 关闭／验收／业务结束分记，必要 CI 与分支保护仍须守，判定器未在本轮改造。

## Windows + DSH 沙箱下的 git 凭据传输

Windows 主机在 DSH 沙箱内执行 `forge_gitee_git_push` 时，git 的 credential helper 由 `sh -c` 包装执行；沙箱禁止命名管道，sh 在启动阶段即退出，git 取不到用户名，原始输出常以 `could not read Username` 结尾。该文本是**症状**，不是"用户名没配"的结论。

- 归类：仅当 push 的非零退出命中 MSYS/sh/命名管道崩溃特征（`cannot fork`、`CreateFileMapping*`、`\.\pipe\`、管道创建失败、行首 `sh:`/`bash:` 诊断，或 `msys`/`cygwin`/`mingw` 运行时名与凭据症状同现）时，信封返回 `status: failed`、`reason: AUTH_TRANSPORT_UNAVAILABLE`、`rule: auth-transport-unavailable`、`next_action: use-native-http-credential`；本地 `commit`/`head`/`branch` 从不归入此类。
- 不归类：普通 401/403、`Authentication failed`、`permission denied`、孤立的 `could not read Username`、HTTP 断链仍按 `COMMAND_FAILED` 处理（可重试），不会被误报成传输故障。
- 绕行：用系统钥匙串保存的令牌与内嵌凭据的远端 URL（形如 `https://<access-token>@corp.example/<owner>/<repo>.git`）走 HTTP 原生传输，credential helper 与 `sh -c` 不在链路上；令牌只保留在本机会话配置与钥匙串，不写入仓库、不进入日志或错误体。

## 策略门禁与凭据

- 策略是硬依赖：`policy` 服务缺失、或三个 `gitee.*` 只读动作未登记/未启用，`apply()` 直接抛可读错误（`GITEE_POLICY_UNAVAILABLE` / `GITEE_ACTION_UNREGISTERED`，`missing` 列全），**不降级成"无策略只读"**。判定与 git push 不在这一断言内：缺 `gitee.delivery.judge`/`gitee.git.push` 时挂载照常成功，只有对应工具降级为 `denied`（读动作的 fail-closed 不因它们放宽）。
- 补丁层预置 **6 条 `kind: read` 目录（本包 3 读 + 1 只读判定 + 2 条 devops 的变更读 `change.read`/`change.list`，与 devops 补丁层逐字相同）、0 条 write**：`gitee.delivery.judge` 随包登记，`target` 逐字 `change`，`egress: 'allow'` 是**必需项**而非风格——门禁统一以 `platform-write` 发起裁决，条目缺席 `egress` 会被编译成默认 `confirm`，无审批台账时判定永远拿不到 `done`。五个受控写（`gitee.issue.write`/`gitee.pr.write`/`gitee.review.publish`/`gitee.review.record`/`gitee.git.push`）靠"不登记"实现默认禁用，而不是运行期开关；要开写须由所属 profile 显式追加动作（写/确认类还需审批台账条目）。`gitee.git.push` 进 `CONFIRM_REQUIRED_ACTIONS`：登记后还要 `confirm{repo,object}` 逐字匹配。第 5、6 条 `change.read`/`change.list` 写进本包目录不是越界，而是为了让两份补丁层**逐字相同**——目录是并集，装谁都不缺自己那条。
- 审计舱用内存 sink（`allowNonDurable: true`），属**联调/试点级**证据，记录随进程退出丢失；生产须注入持久 sink 并去掉该开关。
- 凭据主路径是 `gh` 的系统凭据库（keyring service `gitee-cli-go`，规格 §1.3）：用户在终端运行一次 `gh auth login`，插件不代跑、不代填 `-t`（会进 `ps` 与命令审计）。`GITEE_TOKEN` 是子进程环境白名单里的**唯一**凭据例外、不点名 `authEnv` 也会继承；其它凭据变量仍只经 `authEnv` 显式注入，配置里没有存令牌的字段。`authEnv` 只用于无桌面凭据库或 CI。CLI 配置目录存在持久令牌时默认**告警**（`persistentToken: 'block'` 才以 `GITEE_PERSISTENT_TOKEN` 拒绝、零子进程），自检覆盖 `~/.gitee-cli/config.json` 与 `gh` 兼容的 `hosts.yml` 等布局，结果只回文件名与下一步、不回显令牌值；子进程输出按令牌值脱敏后再返回。
- 唯一的子进程出口是 `src/gitee-cli.mjs`：`execFile` + `shell: false` + 超时 + 单流 1 MiB 上限；`run()` 发 gitee CLI，`runGit()` 发本机 git（只叠加 `GIT_TERMINAL_PROMPT=0` 与 `cwd`），共用同一套白名单/超时/截断/脱敏，入参只接受 `{bin|args, purpose, cwd}` 这几键，没有"把整条命令当字符串"的通道。

## 共存形态（与 `@heluo/forge-devops`）

| 形态 | 结果 | 建议 |
|---|---|---|
| 只装一个（Gitee 面或 devops 面） | 6 条并集目录 + 自己的插件行；本包工具 11 个，目录里另有两条 devops 的变更读（多几条读不会放行任何写） | **推荐** |
| 同 profile **叠加两个补丁层**（各装各的，默认） | 两个策略行同 `id: heluo-policy`、目录逐字相同、都不写 `isolate`：loader 按 id 覆盖 config，留下**唯一**一个策略实例；两处内容相同，幸存者不取决于装配顺序；14 个工具全枚举、0 行激活失败，**不用改任何配置** | **默认可行**：`dsh plugin add` 两个 tgz 即可 |
| **单边改过目录**再叠加（反证） | 幸存配置取决于装配顺序：后装的那份若缺条目，本包插件按 `GITEE_ACTION_UNREGISTERED` fail closed（`missing` 列全），先挂载方的工具仍在 | 不采用（`tests/plugin-patch-layers.test.mjs` 会红） |
| 想回到 r4 的服务域隔离形态 | 需要 `isolate` + 另一个策略行 id，等于重新引入两份策略实例与两套读面事实 | 不采用（r10 已收敛） |

五种形态都有离线用例（`test/coexistence.test.mjs`：A 单装本包、A' 单装 devops、B 双向叠加唯一实例、B- 目录单边漂移的反证、C 并层与卸载归零），跨包策略行 id / 目录逐字一致 / 无 `isolate` 由 `tests/plugin-patch-layers.test.mjs` 静态守住；真实 profile 的叠加由 `dsh plugin add` 两包实测。

> 2026-11-03（r10）：此前用 `isolate: { policy: gitee }` + 独立策略行 id 做服务域隔离，代价是同装后两份策略实例、两套读面事实。现在两个补丁层写同一个 `id: heluo-policy` 与逐字相同的并集目录、都不写 `isolate`——loader 按 id 覆盖 `config`，内容相同则幸存者不取决于装配顺序。

## 回滚

装之前先读这一节：卸载步骤不需要动本包源码。

1. **停用写能力（不需要时）**：确认 profile 补丁层里 `heluo-policy` 的 `config.catalog` 只有 6 条 `kind: read`（本包 3 读 + 1 只读判定 + devops 的 `change.read`/`change.list`），没有 `gitee.*.write`/`gitee.review.*`/`gitee.git.push`。判定是只读能力、默认登记，**不需要也不应该**为了"停用写"把它删掉。
2. **手工回滚配置**：在活动 profile 的补丁文件里把 `heluo-gitee` 条目的 `config:` 恢复为 `config: {}`——删掉手工加的 `cliPath`/`host`/`timeoutMs`/`authEnv`/`persistentToken`，保留注释与其它条目原样，保存后重载 profile。**不要把 `config: {}` 整段删掉**：缺席的 `config:` 会被当成 `undefined` 交给校验器，整条 entry 不激活（`heluo-gitee` 行上方的注释说明了这一点）。
3. **卸载**：`dsh plugin --profile web remove @heluo/forge-gitee`。这条命令只移除依赖并重载，**不清理 profile 补丁层**：`heluo-gitee` 条目会残留，冷启动因找不到对应包而打印 `entry not found`；卸载前先在补丁文件里按整条 `- id: heluo-gitee` 删掉它（保留注释与其它条目原样），再执行 `remove`。**策略行 `heluo-policy` 与 devops 共用**：devops 仍装着时不要删它（删了会让 devops 也失去目录），只有两个包都卸载后才可整条移除。
4. **复核**：整包卸载后 `dsh --profile web --dump-config | grep "id: heluo-gitee"` 应无输出；`heluo-policy` 是否仍在取决于 devops 是否还装着。11 个工具从工具面消失；`git status --short` 不新增文件（插件不写缓存或临时文件，`review.md` 只在被调用时写 `docs/teamflow/<变更号>/review.md`）。

## 测试

```sh
node --test "packages/forge-gitee/test/*.test.mjs"
```

覆盖（条数以实跑为准）：`entry.test.mjs`（根名入口、装载安全、注入面、清单形状，含 r15 的 `dsh.client`/`exports['./client']`/peer react）、`config-access.test.mjs`（三层读面：`origin` 口径、`inherited`/`override`/`value` 三列、409 栅栏 editor 0 次、422 写盘 0 次、未知键拒绝、等值保存不写、`null` 删键只动本键、写后回读不一致降级、`describe()` 不含值）、`http.test.mjs`（端点常量逐字、`no-store`/`nosniff`/`x-forge-gitee-at`、无 CORS、预检头与体形状 400、超 64 KiB 413、`applied` 透传、409/422/503 映射、`toNodeRoute` 404/405/HEAD/尾斜杠）、`faces-rebuild.test.mjs`（保存即生效、`?refresh=1` 是唯一重建入口、路由挂载与 `applied`、无 webServer 降级、卸载撤路由）、`client-shape.test.mjs`（浏览器半真执行：Loader 装载、effect 标签、分区 id/order、真渲染三列同屏、主机与凭据值不出现在文本里、只发 1 次 GET）、`patch-mount.test.mjs`（解析分发补丁层 → 真实装配策略 + 插件；3 读 + 1 判定可用、四个写与 push denied；空目录反向）、`coexistence.test.mjs`（单装本包 / 单装 devops / 双向叠加唯一实例 14 工具 / 目录单边漂移反证 / 并层与卸载归零）、`host-contract.test.mjs`（镜像宿主 `register()` 判据：10 个定义的 `output.render` 与参数 schema 子集，含"删掉 output 即报错"的反证）、`config.test.mjs`（5 键校验、未知键拒绝、空配置合法、描述脱敏）、`cli.test.mjs`（三键入参、`shell:false`、超时、1 MiB 截断、脱敏、`GITEE_TOKEN` 白名单唯一例外、持久令牌 warn/block 与 `~/.gitee-cli/config.json` 检出、`runGit` 的 `GIT_TERMINAL_PROMPT=0` 与 `cwd`）、`adapter.test.mjs`（三段真实载荷当夹具：字段投影、`--json` 无值开关、argv 形状（单对象命令的编号 + `-R`、纯数字 target、`repo list` 无位置参数）、`--state` 按命令分表、空 PR 列表解包、`iid`/`id`、`opened` 归一、`meta.total_count`；禁项、src 零 `GH_` 标识）、`read.test.mjs`（信封、四类降级与两个读工具的 state enum）、`actions.test.mjs`（四状态矩阵、回读一致才 `done`、四个受控写默认 `denied` 且 0 调用、判定随包可用且 `executed` 恒 `false`）、`git-message.test.mjs`（首行 `[变更号]` 格式矩阵与五个原因码）、`gitee-git.test.mjs`（固定 argv 表、非法动词/参数拒绝、commit 本地执行、push 未登记即 `denied`）、`session.test.mjs`（幂等键前 16 位、命中 `reused`、`unknown` 不重放）、`review.test.mjs`（四段与模型名、AI/人工分栏、`stale` 派生、人工自填拒绝、脱敏阻断）、`delivery.test.mjs`（提交信息 `[变更号]` 格式矩阵、关闭四项含 `unknown`、白名单无 close/merge）。安装单元侧在仓库根：`tests/bundle-gitee.test.mjs`（`buildBundle` 闭包、清单白名单、入口 sha256 与工作区逐字节一致、产物补丁层含判定条目）与 `tests/plugin-patch-layers.test.mjs`（两处策略行同 id、目录逐字相同、无 `isolate`、无派生的策略行 id 残留）。2026-10-29 实跑：包内 171 例、仓库根安装单元侧 8 例，全部通过、无跳过（该数字为 r4 轮实测；r10 增删模块后的条数与结果以本需求 QA 实测为准）。

## 证据表（r4 轮，2026-10-29）

来源类型沿用 `buildEvidence()` 的词表：`none` = 未调用任何 CLI（纯离线），`policy-only` = 只经策略门禁未触达远端。宿主版本 `0.2.1-rc.2`；目标对象为**本仓库离线工程**，不含企业实例。

| # | 命令 | 时间 | 宿主版本 | 目标对象 | 来源类型 | 结论 |
|---|---|---|---|---|---|---|
| 1 | `pnpm check`（文档 + 仓库 + `node --test` 全量） | 2026-10-29 | 0.2.1-rc.2 | 本仓库离线 | none | 通过（1391 例，0 失败、0 跳过；`docs: ok`、`repo: ok` 在链内） |
| 2 | `node --test "packages/forge-gitee/test/*.test.mjs"` | 2026-10-29 | 0.2.1-rc.2 | 本仓库离线 | policy-only | 171 例通过，无跳过 |
| 3 | `node scripts/check-docs.mjs` / `node scripts/check-repo.mjs` | 2026-10-29 | — | 本仓库 | none | 通过 |
| 4 | `buildBundle({entry:'@heluo/forge-gitee'})` → `dist/r4/heluo-forge-gitee-0.1.0.tgz` | 2026-10-29 | — | 构建产物 | none | 26 个打包条目，依赖闭包成真版本 |
| 5 | `node --test "tests/bundle-gitee.test.mjs"` | 2026-10-29 | — | 安装单元 | none | 4 例通过（闭包 / 白名单 / 入口 sha256 逐字节一致 / 登记） |
| 6 | `dsh --profile web --patch packages/forge-gitee/cordis.patch.yml --dump-config` | 2026-10-29 | 0.2.1-rc.2 | 本机 profile | none | 见下方 NOT RUN 第 3 条（写入面归主流程） |

## 未验（NOT RUN）

1. **企业 CLI 联调**：三段只读载荷已于 2026-11-03 实测（`repo view --json` 扁平对象、`issue list --limit 1 --json` 的 `{data:{list:[…]}, meta:{…}}`、`pr list --limit 1 --json` 的 `{data:[…], meta:{…}}`），字段名与剥壳按实测反写，载荷进了 `test/adapter.test.mjs` 当夹具（域名/人名换成占位，字段名逐字保留）。argv 形状、`--state` 词表、`pr list` 空结果解包与凭据路径已按实测规格 `docs/contracts/gh-cli-spec.md` 对齐（见上文「CLI 调用形状」），但**仍未在本机实机跑过**。**已知与规格不符、本轮未改的字段投影**：`issue view --json`（规格实测 8 字段 `author`/`created_at`/`description`/`id`/`labels`/`priority`/`state`/`title`，本包表里是 `id`/`title`/`description`/`state`/`labels`/`updated_at`/`web_url`，于是版本字段取不到会降级 `unknown`、链接也取不到）与 `repo list --json`（规格实测元素 9 字段里没有 `visibility`/`web_url`/`archived`/`path`）；写命令的 argv、鉴权与权限模型、CLI 版本号同样未验。若实测再有不符，只改 `src/gitee-adapter.mjs` 的投影表与剥壳，不动其它模块。
2. **Windows 实机与麒麟 aarch64**：包装脚本拒绝、路径与主机校验由离线用例覆盖（注入平台与假环境），**不是实机证据**。
3. **真实 profile 装入与重启（AC-8）与回滚执行（AC-10）**：`dsh plugin add` 之后的重启、`--dump-config` 复核、装后回读 profile 清单与工具面在真实会话里可见，需工作区外写权限，归主流程执行。本包提供的是：AC-10 要求的**卸载步骤已在上面[回滚](#回滚)一节装之前写明**（含复核命令），AC-8 所需的补丁层解析与装配证据见 `test/patch-mount.test.mjs`；**执行与回读均未做**，不记为已验证。
4. **真实凭据与审计落账**：内存审计舱的联调级证据；持久 sink、审批台账与写动作开闸均属范围批准后才验证。
5. **宿主 rc.3**：本机为 rc.2，`engines.dsh` 声明 `>=0.2.1-rc.2`，rc.3 未复跑。
6. **设置页实机（r15）**：`client.js` 的装载、分区注册、渲染与三层读面由 `test/client-shape.test.mjs`、`scripts/check-client-module.mjs` 与 `tests/ui-contract.test.mjs` 离线覆盖（假 Loader / 假 React / 假 fetch），**没有在真实 Web 外壳里点开过**；`heluo-r15-uat` 独立 profile 的装入、`--dump-config` 复核与回滚未执行（计划与证据核对用 `node scripts/uat-profile.mjs --plan|--verify`，执行归主流程）。

## 边界

- 查询以仓库 / Issue / PR 为主；CLI 版本、双端产物、凭据方式与 JSON 字段由提供方核验，不把 `gh` 兼容输入当作双端已可用证据。
- 凭据经环境注入，用户权限由 Gitee 服务端校验；不在 CLI 配置文件、仓库或模型上下文保存长期凭据。
- 当前用户于 2026-11-03 最终确认[Issue 交付模型](../../docs/requirements/requirements-baseline.md#23-issue-交付模型与受控研发目标需求已确认)：变更 1:N Issue，每 Issue 恰一变更及一仓库，跨仓库拆可独立交付验收 Issue；支持双入口，run 为执行记录。`changeId` 入参本身不证明权威关联，真实关系及权限仍待核验。
- 提交保留 `[变更号]`、PR 关联 Issue，不强制新分支语法；本地提交工具不进策略目录不等于可自动暂存他人改动。Skill 提供企业语义、Teamflow 唯一执行，充分 Issue 不另写规格，SDD 不作默认交付前提。
- 查询与受控写分开核验；需求已确认不再等平台／安全／PMO 代批，真实动作开关、审批台账、C3 分类、可信确认、权限与接口验证仍必须满足；本轮不改默认禁用、源码或配置，永不自动合并或关闭。
- CLI 前提不成立时关闭查询能力并提交替代形态评审，不自动恢复 MCP 或 arm64 交叉编译工作项。
