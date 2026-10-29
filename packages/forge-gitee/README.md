# @heluo/forge-gitee

状态：可用（离线用例全绿；企业 Gitee CLI 未联调，实机与真实凭据见[未验（NOT RUN）](#未验not-run)）

| 项 | 内容 |
|---|---|
| 形态 | 独立单安装单元：`cordis.patch.yml` + Node ESM 源码，往宿主注入 8 个 `forge_gitee_*` 工具（3 读 + 5 受控写） |
| 职责 | `gitee.*` 只读查询（仓库 / Issue / PR）、受控写（Issue、PR、审查发布与记录、交付判定）、审查 `review.md` 与关闭条件判定 |
| 不负责 | 不重写 Gitee API，不自建 MCP，不做 arm64 交叉编译，不执行 `git` 动作、不合并/关闭/发版，不把个人凭据写入仓库或模型上下文 |
| 衔接点 | `tools` + `policy` 两个注入服务；策略目录与审计由 `@heluo/forge-policy` 提供；唯一子进程出口 `src/gitee-cli.mjs` |
| 详细设计 | [DESIGN-010](../../docs/design/plugins/forge-gitee.md) |
| 实现状态 | `package.json`、`src/`（11 模块）、`test/`（见[测试](#测试)）、`cordis.patch.yml` 已落地 |

`provider=gitee` 与本仓库的 GitHub 面（`@heluo/forge-devops`）**语义分流**：动作命名空间 `gitee.*`、字段表 `GITEE_*`（snake_case）；`mergedAt`/`statusCheckRollup`/`reviewDecision` 等 GitHub 语义字段列进 `GITEE_FORBIDDEN_FIELDS`，请求即拒绝、返回即整条降级 `unknown`。两个包不共享源码，只共享不变量与契约测试。

## 安装

```sh
# 1. 构建安装单元（构建期把 workspace: 依赖闭包成真版本，产物自带策略包）
node --input-type=module -e "import('./scripts/build-enterprise-bundle.mjs').then(m=>m.buildBundle({entry:'@heluo/forge-gitee',destination:'dist/r4'}))"
# → dist/r4/heluo-forge-gitee-0.1.0.tgz

# 2. 装进 profile（tarball 自带包内补丁层，宿主按 dsh.bundle.patch 自动挂载策略行 + 插件行）
dsh plugin --profile web add dist/r4/heluo-forge-gitee-0.1.0.tgz

# 3. 复核补丁层是否进了组合树（应看到 heluo-policy-gitee 与 heluo-gitee 两行，策略在前）
dsh --profile web --dump-config | grep -A2 "id: heluo-"
```

清单要点：`engines.dsh: >=0.2.1-rc.2`；`main`/`exports` 指向 `src/*.mjs`（无编译产物、无 `lib/`）；`files` 白名单只含 `src`、`cordis.patch.yml`、`README.md`；`dependencies` 只有 `@heluo/forge-policy`（源码 `workspace:*`，安装单元闭包成真版本并进 `bundledDependencies`）。

## 配置

四个扁平键，全部可选，来自补丁层的 `config:`（本轮不做配置页）。凭据**只**从环境变量取，配置里没有存令牌的字段。

| 键 | 默认 | 约束 | 说明 |
|---|---|---|---|
| `cliPath` | `gh` | 可执行文件名/路径；拒绝 `scheme://`、控制字符、`.cmd`/`.bat`/`.ps1`/`.com`/`.vbs` 包装脚本 | 企业已确认 CLI 名为 `gh`；配置值只决定"起哪个程序"，不改变命令面 |
| `host` | 无（未配置即缺） | 主机名（可带端口），拒绝协议前缀、路径与 userinfo | 缺 `host` 进 `missing`，适配器 `preflight()` 以 `AUTH_MISSING` 拒绝，**不猜主机、不起子进程** |
| `timeoutMs` | `20000` | `1000`–`600000` 的整数 | 单次 CLI 调用超时；超时按"可能已执行"降级 `unknown`，不重放 |
| `authEnv` | `GH_TOKEN` | 最多 8 个变量名（`[A-Za-z_][A-Za-z0-9_]*`） | 令牌变量名清单；按顺序取第一个有值的，全部无值即 `AUTH_MISSING` |

`describeGiteeConfig()` 只输出枚举、数字与环境变量**名**（路径只留文件名），返回值里不存在令牌值；`validateGiteeConfig()` 是补丁层、宿主 `ConfigStandard` 与 `resolve` 的唯一口径，未知键直接拒绝。

## 工具面（8 个，顺序与命名固定）

| 工具 | 参数 | 策略动作 | 默认 |
|---|---|---|---|
| `forge_gitee_repository_read` | `target` | `gitee.repository.read` | 放行（补丁层已登记） |
| `forge_gitee_issue_read` | `target`、`list`/`state`/`limit`/`json` | `gitee.issue.read` | 放行（补丁层已登记） |
| `forge_gitee_pr_read` | `target`、`list`/`state`/`limit`/`json` | `gitee.pr.read` | 放行（补丁层已登记） |
| `forge_gitee_issue_write` | `op`(create\|comment)、`target`、`changeId`、`body`、`confirm` | `gitee.issue.write` | `denied`（未登记） |
| `forge_gitee_pr_write` | `op`(create\|comment)、`target`、`changeId`、`body`、`confirm` | `gitee.pr.write` | `denied`（未登记） |
| `forge_gitee_review_publish` | `target`、`changeId`、`commit`、`body`、`confirm` | `gitee.review.publish` | `denied`（未登记） |
| `forge_gitee_review_record` | `repoRoot`、`changeId`、`commit`、`model`、`opinion`、`conclusion` | `gitee.review.record` | `denied`（未登记） |
| `forge_gitee_delivery_gate` | `changeId`、`message`、`criteria` | `gitee.delivery.judge` | `denied`（未登记） |

没有 `run`/`exec`/`shell`/`api` 这类泛化入口：动作是具名枚举，表里拼不出的动词在包里不存在（`pr merge`、`pr close`、`issue close`、`release`、`workflow`、`api`、`auth`、`config`、`gist` 属禁项，出现即拒绝且零子进程）。

结果契约：

- **读**：信封 `{provider:'gitee', action, status, source_revision, observed_at, target, result_refs, missing_fields, detail}`；状态 `succeeded`/`failed`/`partial`/`unknown`，准入拒绝另记 `denied`；失败降级为数据（`reason` 固定枚举），不抛二次错误。
- **写**：四状态 `done`/`failed`/`denied`/`unknown`。`done` 必须"CLI 成功 + 回读一致"；退出码 0 单凭算 `unknown`。写前有幂等台账（`sha256(changeId|objectType|title)` 前 16 位，进程内 6 小时），命中返回 `reused` 且远端 0 次调用；失败不重放。
- **审查**：`review.md` 四段（问题 / 风险 / 意见 / 结论）+ AI 与人工两栏物理分节；人工栏只能由 `recordHumanConfirmation` 写，模型自填即拒；`stale` 是派生结果不落盘。
- **交付**：只判定不执行——`[变更号]` 提交信息前缀、关闭四条件（验收、已合入、无未完成交付、针对当前 commit 的人工确认），`unknown` 不计入通过；包里没有 close/merge 入口。

## 策略门禁与凭据

- 策略是硬依赖：`policy` 服务缺失、或三个 `gitee.*` 只读动作未登记/未启用，`apply()` 直接抛可读错误（`GITEE_POLICY_UNAVAILABLE` / `GITEE_ACTION_UNREGISTERED`，`missing` 列全），**不降级成"无策略只读"**。
- 补丁层预置 3 条 `kind: read` 目录、**0 条 write**：五个受控动作靠"不登记"实现默认禁用，而不是运行期开关；要开写须由所属 profile 显式追加动作（写/确认类还需审批台账条目）。
- 审计舱用内存 sink（`allowNonDurable: true`），属**联调/试点级**证据，记录随进程退出丢失；生产须注入持久 sink 并去掉该开关。
- 凭据只在环境变量里：CLI 配置目录存在持久令牌时安全阻断（`GITEE_PERSISTENT_TOKEN`，`denied`，零子进程）；子进程环境走白名单，输出按令牌值脱敏后再返回。
- 唯一的子进程出口是 `src/gitee-cli.mjs`：`execFile` + `shell: false` + 超时 + 单流 1 MiB 上限；入参只接受 `{bin, args, purpose}` 三键，没有"把整条命令当字符串"的通道。

## 共存形态（与 `@heluo/forge-devops`）

| 形态 | 结果 | 建议 |
|---|---|---|
| 只装一个（GitHub 面或 Gitee 面） | 各自带自己的策略目录，互不干扰 | **推荐**；`prd` T4 的"按 provider 分流"就是这一形态 |
| 同 profile **叠加两个补丁层**（各装各的） | 本包的策略行 id 是 `heluo-policy-gitee`、两行都声明 `isolate: { policy: gitee }`：Gitee 的策略实例落在**自己的服务域**，GitHub 那条留在 root 域，两个插件各自看得见自己的目录，**不用改任何配置** | **默认可行**：`dsh plugin add` 两个 tgz 即可，17 个工具全枚举、0 行激活失败 |
| 同 profile **并层**（唯一一条策略行） | 把本包 3 条 `gitee.*` 目录并入既有 `heluo-policy` 行的 `config.catalog`，并**删掉本包插件行的 `isolate`**（插件改从同一实例取目录） | 想统一审计出口时用；改完仍是 7 条目录 / 17 个工具 |
| 保留 `isolate` 但删掉本包策略行 | 插件在自己的服务域里找不到 `policy` → 挂载期 `GITEE_POLICY_UNAVAILABLE` fail closed（不会静默装上一个没有目录的空壳） | 不要这样装 |

三种失败/成功形态都有离线用例（`test/coexistence.test.mjs`：A 单装、B 叠加、B- 去掉 `isolate` 的反证、C 并层），跨包的策略行 id 与 `isolate` 对齐由 `tests/plugin-patch-layers.test.mjs` 静态守住；真实 profile 的叠加由 `dsh plugin add` 两包实测。

> 2026-10-29 更正：本包此前靠"叠加即 `POLICY_SERVICE_CONFLICT`"来暴露冲突，实际后果是 loader 按同 id 覆盖 config、GitHub 插件静默掉线（QA 的 D-2）。现在改用 loader 的 `isolate` 服务域隔离，叠加不再互相覆盖。

## 回滚

装之前先读这一节：卸载步骤不需要动本包源码。

1. **停用写能力（不需要时）**：确认 profile 补丁层里 `heluo-policy-gitee` 的 `config.catalog` 只有 3 条 `kind: read`，没有 `gitee.*.write`/`gitee.review.*`/`gitee.delivery.judge`。
2. **手工回滚配置**：在活动 profile 的补丁文件里删掉 `heluo-gitee` 条目的 `config:` 段（保留注释与其它条目原样），保存后重载 profile。
3. **卸载**：`dsh plugin --profile web remove @heluo/forge-gitee`。
4. **复核**：`dsh --profile web --dump-config | grep -A2 "id: heluo-gitee"` 应无输出、`grep -A2 "id: heluo-policy-gitee"` 应无输出（与 GitHub 面的 `heluo-policy` 无关）；8 个工具从工具面消失；`git status --short` 不新增文件（插件不写缓存或临时文件，`review.md` 只在被调用时写 `docs/teamflow/<变更号>/review.md`）。

## 测试

```sh
node --test "packages/forge-gitee/test/*.test.mjs"
```

覆盖（条数以实跑为准）：`entry.test.mjs`（根名入口、装载安全、注入面、清单形状）、`patch-mount.test.mjs`（解析分发补丁层 → 真实装配策略 + 插件；空目录反向）、`coexistence.test.mjs`（单装 / 叠加服务域隔离 / 去掉 `isolate` 的反证冲突可见 / 并层全枚举）、`host-contract.test.mjs`（镜像宿主 `register()` 判据：8 个定义的 `output.render` 与参数 schema 子集，含"删掉 output 即报错"的反证）、`config.test.mjs`（4 键校验、未知键拒绝、描述脱敏）、`cli.test.mjs`（三键入参、`shell:false`、超时、1 MiB 截断、脱敏、持久令牌阻断）、`adapter.test.mjs`（字段分表、禁用字段、argv/`--json` 白名单、禁项、src 零 `GH_` 标识）、`read.test.mjs`（信封与四类降级）、`actions.test.mjs`（四状态矩阵、回读一致才 `done`、默认禁用五工具 `denied` 且 0 调用）、`session.test.mjs`（幂等键前 16 位、命中 `reused`、`unknown` 不重放）、`review.test.mjs`（四段与模型名、AI/人工分栏、`stale` 派生、人工自填拒绝、脱敏阻断、跨 provider 不覆盖）、`delivery.test.mjs`（提交信息 `[变更号]` 格式矩阵、关闭四项含 `unknown`、白名单无 close/merge）。安装单元侧在仓库根：`tests/bundle-gitee.test.mjs`（`buildBundle` 闭包、清单白名单、入口 sha256 与工作区逐字节一致）与 `tests/plugin-patch-layers.test.mjs`（跨包策略行 id 不撞名、`isolate` 对齐）。2026-10-29 实跑：包内 171 例、仓库根安装单元侧 8 例，全部通过、无跳过。

## 证据表（本轮，2026-10-29）

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

1. **企业 CLI 联调**：`gh` 在本企业环境的 argv 形状、`--json` 字段稳定性、鉴权与权限模型**全部未联调**。命令面与字段表按设计定稿，若实测不符只改 `src/gitee-adapter.mjs` 的两张表（命令表 + 字段表）并按可用子集收窄，不动其它模块。
2. **Windows 实机与麒麟 aarch64**：包装脚本拒绝、路径与主机校验由离线用例覆盖（注入平台与假环境），**不是实机证据**。
3. **真实 profile 装入与重启（AC-8）与回滚执行（AC-10）**：`dsh plugin add` 之后的重启、`--dump-config` 复核、装后回读 profile 清单与工具面在真实会话里可见，需工作区外写权限，归主流程执行。本包提供的是：AC-10 要求的**卸载步骤已在上面[回滚](#回滚)一节装之前写明**（含复核命令），AC-8 所需的补丁层解析与装配证据见 `test/patch-mount.test.mjs`；**执行与回读均未做**，不记为已验证。
4. **真实凭据与审计落账**：内存审计舱的联调级证据；持久 sink、审批台账与写动作开闸均属范围批准后才验证。
5. **宿主 rc.3**：本机为 rc.2，`engines.dsh` 声明 `>=0.2.1-rc.2`，rc.3 未复跑。

## 边界

- 查询以仓库 / Issue / PR 为主；CLI 版本、双端产物、凭据方式与 JSON 字段由提供方核验，不把 `gh` 兼容输入当作双端已可用证据。
- 凭据经环境注入，用户权限由 Gitee 服务端校验；不在 CLI 配置文件、仓库或模型上下文保存长期凭据。
- 查询基线与受控写分开核验；写在范围/C3 分类批准及接口验证前默认禁用，永不自动合并或关闭。
- CLI 前提不成立时关闭查询能力并提交替代形态评审，不自动恢复 MCP 或 arm64 交叉编译工作项。
