# @heluo/forge-devops

状态：可用（只读 runner + 上下文卡 + 产物落盘 + 门禁骨架 + Web 配置页与 CLI 自动发现；#15 / D4，责任方 2026-10-24 决定；2026-11-03 用户确认 D 方案：只读面改为枚举式 runner；2026-11-04 起新增受控写回 `change update`，写动作默认不登记即拒绝）。"可用"指本包有清单、源码与离线可执行的用例；**企业 CLI 未联调**，`merge`/`close`/`change done` 不在命令白名单内，澄清回写没有 dop 命令面（不再保留恒失败工具，澄清单落本地产物）。

| 项 | 内容 |
|---|---|
| 形态 | 现有 CLI 接入：查询基线（单条 / 清单）+ 上下文卡与产物落盘；受控回写目标见详细设计（写面归 `@heluo/forge-gitee`，澄清回写无 dop 命令面） |
| 前置条件 | 装好即可用，不需要预先设置环境变量：装配期自动发现 dop；只有机器上确实找不到时才需要到配置页指定位置（见「配置」） |
| 配置入口 | `设置 → 企业 DevOps`（Web 配置页，页面上只设 2 项：dop 入口 / 超时）；三层来源「配置页 > 环境变量 > 自动发现」，环境变量只作 CI 与无界面 profile 的兜底 |
| 职责 | 复用 DevOps CLI，以固定 argv、凭据注入与策略门禁读取系统变更（单条 / 清单）及独立验收、所属故事背景；产出上下文卡；分析后回写标题/描述/验收标准（`change update`，默认关闭）；产物落盘（clarify / plan 由纯函数机检后生成正文） |
| 不负责 | 不碰仓库 / Issue / PR 的读写（这些事实由 `@heluo/forge-gitee` 唯一负责）、不内置平台凭据、不接入生产写工具、不替代平台权限 |
| 衔接点 | bash 工具、企业策略门禁、凭据注入与审计（均待接口核验） |
| 条件服务 | [services/devops-mcp](../../services/devops-mcp/README.md)；当前不建设 |
| 详细设计 | [DESIGN-009](../../docs/design/plugins/forge-devops.md)（草案，已建立） |
| 实现状态 | 已建立 `package.json`、只读端口（`src/read.mjs`，两条读动作）、门禁骨架、流程组合根（`src/flow.mjs`）、四个工具（只读 runner / 上下文卡 / 受控写回 / 产物落盘）与 `devops-change` 入口、Web 配置页（`client.js`）与四键 CLI 配置模块（自动发现 / 三层合并 / 宿主适配 / 同源路由）、离线测试（`node --test`）；**企业 CLI 联调未做** |

## 安装

```sh
# 安装（tarball 由构建步骤产出，自带策略闭包）
dsh plugin --profile web add <tarball>
# 复核补丁层是否进了组合树
dsh --profile web --dump-config | grep -A2 "id: forge-devops"
```

装好后重载 profile（或重启宿主）即可用：Windows 上只要 `dop` 的可执行入口在 PATH 或候选目录里，插件在装配期就能找到，**不需要任何环境变量**。入口按「存在且是普通文件」判定，不限扩展名——原生 `.exe`、npm 生成的无后缀 shim、`.cmd` / `.ps1` 同等对待，**能不能保存**与**能不能运行**是两件事（见「能保存 ≠ 一定能跑起来」）。安装单元、补丁层顺序与策略门禁要求见「安装单元与策略门禁」；`forge-devops` 层与 `@heluo/forge-enterprise` 的组合层可以同装：两层都插同一行策略（同 `id: heluo-policy`、目录逐字相同），loader 按 id 折叠为一个条目，不是重复挂载。

## 配置（配置页优先，环境变量兜底）

一句话：**插件自己找 dop；只有找不到时才需要你指定位置。** 四个配置项逐字段取第一个有值的层——**配置页 > 环境变量 > 自动发现**，页面对 dop 入口标出来源，覆盖关系也标出来（配置压过环境变量时挂「覆盖环境变量」），不静默替换。

### 配置页（`设置 → 企业 DevOps`）

进入路径两次点击：首页 → 左下「设置」→ 侧栏「企业 DevOps」。

页面上只有两项：`dop` 入口与超时。地址与事实来源不出现在页面上（怎么设见下一节）。

页面是**状态**而不是必填表单：命中自动发现时，两张入口卡默认只读，显示命中的可执行文件与来源（配置 / 环境变量 / 自动发现 / 未找到）；用户正常情况下只读不填，只有未命中时才落进「填入路径」。

| 想做的事 | 操作 | 结果 |
|---|---|---|
| 覆盖为手动指定 | 点「改为手动指定」，粘贴 `dop` 可执行文件的完整地址（资源管理器里右键文件 →「复制文件地址」） | 保存时逐字段校验：文件存在、是普通文件（POSIX 还要执行位）。Windows 上**不按扩展名拦截**：`.exe`、无后缀 shim、`.cmd` / `.ps1` 都能存（见「能保存 ≠ 一定能跑起来」） |
| 回落到自动发现 | 点「重置为自动发现」，或把输入框清空，再点「保存」 | 该键从配置里删除，回落下一层（入口：环境变量 → 自动发现；超时：环境变量 → 缺省 `20000`）；清空即回落，不必卸载重装 |
| 重新扫描 | 点「重新自动发现」 | 发现只在装配期跑一次；**只有**这个动作会重扫，工具调用永不触发扫描 |
| 保存 | 页脚「保存」 | 只提交页面上改动过的项；写入活动 profile 的补丁层（`forge-devops` 条目的 `config:` 段），页面没展示的键在补丁层里逐字保留；期间被别的窗口改过则提示「配置已被其它窗口改动 · 刷新后重试」，不覆盖对方改动 |
| 查看其它候选 | 展开「自动发现命中 · 另有 N 个候选」 | 多份安装时按 PATH 优先静默取首个，其余候选可展开查看，不自动选用 |

保存成功后读面立即按新配置重建（无需重启）；写进 profile 补丁的值重启后仍然有效。**发现结果不回写配置**：换机器或改 PATH 后点「重新自动发现」即可跟随，页面不会把自动发现的等值写盘。当前 profile 没有挂载配置面（`settings` / `config-editor`）时，页面降级为只读并给出环境变量出口，而不是渲染一个存不进去的表单。

### 企业研发（`设置 → 企业研发`，r15 新增）

本包在设置页还有第二个分区：id `devops-readiness`、order 29。它**只汇总本机可见性**，页面顶部固定声明「本页只汇总本机可见性，不代表业务授权」。六行各读各的源，一行失败只影响自己：

| 行 | 事实来源 | 状态 |
|---|---|---|
| 企业身份 | `GET /api/forge-iam/view` 的 `state` | 已登录 / 未登录 / 登录中 / 过期 / 不可达 / 未知；未装该插件即「未安装」 |
| 公共参数 | 无 | 恒「未知」——尚无可核验的公共维护权限与接口 |
| 本机配置 | devops 与 gitee 快照里 `origin === 'config'` 的**键名** | 列出键名，不列值 |
| DevOps | 本包快照的 `ready` 与 `dopBin` 的来源 | 已配置 / 未配置 / 未安装（不写"通过"） |
| Gitee | gitee 快照的 `ready` | 已配置 / 未配置 / 未安装 |
| 业务写权限 | 无 | 恒「未知」——本页不判断授权 |

只有 DevOps 行可以检查：「检查 DevOps」打 `GET /api/forge-devops/cli?refresh=1`（**唯一**会重新扫描的动作，`?refresh=1` 在客户端只拼一次）。检查态六种：未检查 / 检查中 / 通过 / 失败 / 未知 / 已过期，并带基准短号与时间；子原因是 `NO_CLI`（未配置）、`ENTRY_NOT_EXECUTABLE`（不可执行）、`ENDPOINT_UNREACHABLE`（目标不可达）、`POLICY_DENIED`（只读被拒）。Gitee 行恒「未执行」并写明未获批准的只读探测本页不发起请求。检查不写配置。

### 保存回执与来源页脚（r15）

`devops` 分区保存后显示三行互不覆盖的回执：**保存**（已保存 / 未保存）、**应用**（运行时已应用 / 未应用 / 未知）、**检查**（未检查 / 上次检查时间）。应用这一行读 POST 成功体里的 `applied`：`saveCliConfig` 写成功后重算读面，只有运行时合并态里真的出现了新值才回 `{ok:true}`；重建抛错或读面立不起来则降级并回 `{ok:false, reason:'CLI_REBUILD_FAILED'}`——此时"已保存"仍成立，但页面不会假装生效。页脚一行「分区由 @heluo/forge-devops <version> 提供 · 读取于 <时间>」，版本与时刻都来自服务端快照（`plugin` / `readAt`），浏览器半不读 `package.json`。

### 配置项（配置页 / 环境变量 / 后端推导）

四个键名与代码同源（`CLI_FIELDS`，camelCase），页面标签、环境变量与工具失败文案指向同一句指引「设置 → 企业 DevOps」。四项按**设置方式**分三档：

- **2 项可在配置页设置**：`dopBin`、`timeoutMs`。
- **1 项仅环境变量与配置文件**：`dopEndpoint`——页面不渲染它，要设就写环境变量或活动 profile 补丁层的 `config:` 段。
- **1 项由后端推导**：`sourceType`——`dopBin` 解析到可执行文件才推成 `enterprise`（裸命令名 `dop` 这类默认值不算就绪），否则 `mock`；显式配置或环境变量仍优先。

保存只写页面上的两项，其余键在补丁层里**逐字保留**（不展示的键不会被清空）。

| 配置项（camelCase） | 配置页 | 环境变量 | 缺省 | 说明 |
|---|---|---|---|---|
| `dopBin` | dop 可执行文件 | `FORGE_DEVOPS_DOP_BIN` | 自动发现；三层都没有则未就绪 | 完整地址，或已在 PATH 内的可执行文件名（如 `dop`）；判定只看「存在且是普通文件」，Windows 上**不限扩展名** |
| `dopEndpoint` | —（仅环境变量 / 配置文件） | `FORGE_DEVOPS_DOP_ENDPOINT` | 留空即不配置 | 绝对 http(s) 地址，地址里不能带用户名密码；凭据不进地址、不进配置页 |
| `sourceType` | —（后端推导） | `FORGE_DEVOPS_SOURCE_TYPE` | 推导 | `mock`（本地模拟）/ `enterprise`（企业实测）：`dopBin` 从配置 / 环境变量 / 自动发现解析到可执行文件才算 `enterprise`；报告按此分记事实来源 |
| `timeoutMs` | 超时（毫秒） | `FORGE_DEVOPS_TIMEOUT_MS` | `20000` | 单次调用上限，取值 1000–600000 |

字段规则的唯一真源是 `src/runtime-config.mjs` 的 `validateConfigField`：环境变量层与宿主 loader 的配置校验直接调用它。**浏览器半（`client.js`）不能 import 服务端模块**，所以页面只对两项可编辑字段内联了一份**子集**校验（入口路径只判长度上界 4096，超时只判区间；**不做任何后缀判断**），存在性、是否目录与 POSIX 执行位一律由服务端在保存时判定（形态判定全仓只有一份，在 `src/entry-form.mjs`）；两面的关系不是靠注释保证，而是由 `test/client-rule-parity.test.mjs` 的跨面矩阵用例守着——两项逐行对齐，页面没展示的两项断言"页面恒放过、服务端仍拒"（页面收窄不等于服务端放宽；R2-1 就是副本少了上界、失焦放行、保存才 422）。任一解析到的键非法即整包未就绪（`CLI_CONFIG_INVALID`），**不回落下一层**——填错的意图若被静默换成别的路径，用户会以为"我配置的那个在生效"；页面上两项逐字段报错（找不到这个文件 / 这是目录 / 不是可直接执行的文件 / 路径过长（>4096）/ 超时越界），服务端 422 若点到页面上没有的键，原因落在页脚，不会为一个不存在的输入框聚焦。

### 自动发现规则

发现是只读的、有界的文件系统探测，**零子进程**，只在装配期与页面「重新自动发现」时跑：

- 名字：Windows 上按优先级试 6 个候选名——`dop.exe` → `dop`（裸名）→ `dop.cmd` → `dop.ps1` → `dop.bat` → `dop.com`（大小写不敏感）；macOS / Linux 认无后缀的 `dop`，并要求执行位。名字表的下标就是优先级：同一位置或不同目录同时存在原生 `.exe` 与脚本形态时，`found[0]` 恒为 `.exe`。
- 位置：`PATH` 的每一项；再加少量候选目录（Windows：`%ProgramFiles%\{tool}`、`%ProgramFiles(x86)%\{tool}`、`%ProgramFiles%\heluo`、`%LOCALAPPDATA%\Programs\{tool}`、`%USERPROFILE%\.{tool}\bin`；POSIX：`/usr/local/bin`、`/opt/{tool}/bin`）。不递归遍历。
- 预算：最多 200 个目录、250ms 截止（是上限而不是目标，正常机器只碰几个目录）。
- 不按扩展名拒收：只要存在且是普通文件（POSIX 另需执行位）就进候选，`rejected` 恒为空数组。于是候选里可能出现 `dop.cmd` 这类**存得下但启动不了**的入口，能不能真正跑起来交给运行期提示（见下一节），发现阶段不替用户预先否掉。真实文件名与路径在候选里照原样显示，不从显示值里删后缀。
- 只读、只纳入真实存在的文件：不执行文件、不解析其内容、不写任何东西；发现结果也不回写配置。

### 能保存 ≠ 一定能跑起来（Windows 包装脚本）

保存与发现都不再按扩展名拦截，但**启动方式一点没松**：唯一出口仍是 `execFile` + `shell: false` + 固定 argv（`src/cli-runner.mjs`），不引入 shell、不拼接命令行字符串。于是 Windows 上有两类「存得下、跑不起来」的入口：

- **npm 生成的无后缀 shim**（npm 的全局安装目录，Windows 上通常是 `%APPDATA%\npm\dop`；也可能是 Git Bash 版本）：启动通常报 `ENOENT`；
- **`.cmd` / `.ps1` / `.bat` 包装脚本**：启动通常报 `EINVAL`。

两者原因相同：这份调用方式要求直接 exec 一个可执行体，而脚本本身要靠 `cmd.exe` / PowerShell 解释——这是**启动方式的限制，与路径写法无关**，改后缀、补引号、换目录都不解决。所以第一次真正调用这条 CLI 时，失败信封里给的是可行动的提示：把配置**改指该 CLI 的原生可执行文件**（Windows 上即 `.exe`），或改用提供原生二进制的安装方式。该提示不含盘符、绝对路径与 endpoint（它要进工具输出与日志）；贴地址前建议先在资源管理器里看一眼后缀。

`ready` 只表示「入口已解析」，不编码「已验证可运行」：页面上两项都绿的时候，仍可能在第一次调用时起不来。区分方法看失败信封——`detail.spawnFailed: true` 表示进程根本没起来（不是业务失败），读调用按失败记录且**不重放**。

### 找不到时

fail closed 语义不变，但文案改成人话：只读工具仍以 `NO_READER` 失败（原因码不加码），`detail.reason` 给细因（`CLI_NOT_FOUND` / `CLI_CONFIG_INVALID`）、`detail.searched` 给已查类别（配置 / 环境变量 / PATH / 候选目录）、`detail.next` 给页面入口；流程面仍可达，但只产出 `blocked` 卡且零子进程调用。整条信封不含盘符、绝对路径与平台地址——它要进工具输出与日志。

## 环境变量兜底（CI / 无界面 profile）

无界面的 CI、或 profile 没挂载配置面时，用环境变量配置；语义与环境变量层一致：仍低于配置页、高于自动发现。四个键全部可选，不设也能用（自动发现兜底）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `FORGE_DEVOPS_DOP_BIN` | 无（走自动发现） | dop 可执行文件（PATH 名或完整地址） |
| `FORGE_DEVOPS_DOP_ENDPOINT` | 无 | 只接受绝对 http(s)，不接受内嵌凭据 |
| `FORGE_DEVOPS_SOURCE_TYPE` | 推导 | `mock`（本地模拟）/ `enterprise`（企业实测）；设了就以它为准，覆盖后端推导结果 |
| `FORGE_DEVOPS_TIMEOUT_MS` | `20000` | 单次调用上限，取值 1000–600000 |

`resolveRuntimeConfig(env)` 只认显式传入的环境（不读进程环境）：缺 `FORGE_DEVOPS_DOP_BIN` 返回 `CONFIG_MISSING` 并点名变量，格式不合法返回 `CONFIG_INVALID`——两者都不给出可用配置，调用方必须拒绝启动流程，不猜默认值。这里只表示"环境变量层没给出可用值"，装配层会继续看自动发现；三层都没有才未就绪。`describeRuntimeConfig()` 只给「已配/未配」布尔位与两个非机密枚举，页面上的脱敏状态（`service.cliStatus()`）同理，**从不回显路径与地址**。

环境变量的值同样走字段校验：某项非法即整包未就绪（`CLI_CONFIG_INVALID`，页面进入不可用态并给出原因码），不会因为它"看起来能用"就被放行。

## 回滚

1. **页面回滚（推荐）**：在「设置 → 企业 DevOps」里对改过的入口点「重置为自动发现」、把超时输入框清空，再点「保存」。这两项会从补丁层里删除，各自回落（环境变量 → 自动发现 / 缺省 `20000`）；`dopEndpoint` / `sourceType` 页面不展示、保存时逐字保留，要一并回滚就按第 2 步手工删掉整段 `config:`。
2. **手工回滚**：在活动 profile 的补丁文件里删掉 `forge-devops` 条目下的 `config:` 段（保留注释与其它条目原样），保存后重载 profile。
3. **卸载**：`pnpm uninstall:devops --profile web`——先按精确条目（`forge-devops` / `@heluo/forge-devops`）删掉 profile 补丁层里本插件写入的那一条并回显删除区间（其它条目逐字不动），再调 `dsh plugin --profile web remove @heluo/forge-devops` 移除插件。**不能只跑 `dsh plugin remove`**：上游 `remove_bundle` 只移除依赖并重载，不清理 profile 补丁层，残留的 `- id: forge-devops` 行会让每次冷启动打印「entry not found」。只需清理、稍后自行移除插件时加 `--keep-plugin`（不调用任何子进程，打印下一步）。
4. **复核**：整包卸载后 `dsh --profile web --dump-config | grep "id: forge-devops"` 应无输出；只做第 1/2 步配置回滚时，`grep -A2 "id: forge-devops"` 里不应再有 `config:`。页面回到「自动发现 / 未找到」；`git status --short` 不应新增文件（插件不写缓存或临时文件）。

## 安装单元与策略门禁（20261028-r1）

单个包就是完整安装单元：清单声明 `dsh.bundle.patch: ./cordis.patch.yml`、`files` 带补丁层与 `client.js`、`dsh.client = {platform:'web', immediately:true, inject:['slots','locale']}`，并把 `@heluo/forge-policy` 声明为包依赖（`workspace:*`），使"只装 devops"也能挂载。r15 起清单另带 `peerDependencies = {react:'>=18'}` 与 `peerDependenciesMeta.react.optional = true`：react 由宿主 Web 外壳提供，构建期的 `HOST_PEERS` 规则允许它留在清单里但不进闭包、不进 `bundledDependencies`、不出现在 tarball 的 `node_modules/` 里。补丁层**先插策略、后插 devops**，两行都用包根名——策略先行是硬依赖，顺序错了按 fail-closed 拒绝挂载。若同一 profile 已 apply `@heluo/forge-enterprise` 的补丁层（其中已插策略），仍可叠加本层：两层策略行同 `id`、目录逐字相同，loader 按 id 折叠为一个条目（后写入的 `config` 覆盖先前的，不是重复挂载两份策略实例），幸存目录不取决于装配顺序。

策略行必须自带非空的 `config.catalog` 才会挂载成功：策略缺省目录是空表，devops 校验"两条读动作已登记且 `enabled`"随即以 `POLICY_ACTION_UNREGISTERED` 拒绝挂载（2026-10-28 第 2 轮 QA 的 N-1：包能装进 profile，但宿主启动时报 `1 entry did not activate`，加载路径挂住）。补丁层因此预置**6 条只读动作的并集**——本包的两条（`change.read` `target: change`、`change.list` `target: changes`）加 `@heluo/forge-gitee` 的四条（`gitee.repository.read` / `gitee.issue.read` / `gitee.pr.read` / `gitee.delivery.judge`，`target` 分别为 `repository` / `issue` / `pull-request` / `change`）；这条策略行与 gitee 补丁层的那条 **id 相同、目录逐字相同**，同装时 loader 按 id 覆盖、只留一个实例（r10 起不再写 `isolate`）。写动作不预置，因为策略要求 enabled 的写/确认动作带审批台账条目，属单独的范围批准。同时必须显式配置 `config.audit`：策略无可用审计舱时对每个动作都拒绝（`POLICY_AUDIT_UNAVAILABLE`；内存舱未声明 `allowNonDurable` 时是 `POLICY_AUDIT_NOT_DURABLE`），只补目录不补审计仍是"装上不可用"。补丁层给的是内存审计舱，属**联调/试点级**证据，生产须在 profile 注入持久 sink 并去掉 `allowNonDurable`。补丁层也不写 `tools` 映射：devops 自己每次读/写都调 `policy.executeAction`，宿主层再映射会重复准入与重复审计，未映射的宿主工具按策略自身的 out-of-scope 语义放行。以上配置由 `test/patch-mount.test.mjs` 固化为门禁：解析分发出去的补丁层，用其中配置真实装配策略 + devops（4 个工具、读经门禁放行、审计记录落账），并全仓扫描任何插入 `@heluo/forge-devops` 的补丁层。

子进程只有一个出口（`src/cli-runner.mjs`）：`execFile` + `shell: false` + 超时 + 单流输出上限；入参只接受 `{ bin, args, purpose }`，程序名与参数分开传，没有"把整条命令当字符串"的通道；`execFile` 可注入，离线测试用假实现，不 spawn 真实 CLI。失败是数据不是异常：非零退出、超时、起不来分别落到 `exitCode`、`timedOut`、`exitCode: null`，由适配器映射为 `failed`/`unknown`，不重放。子进程环境沿用宿主进程环境，覆盖项只放非机密开关。

## 骨架内容（已落地）

只做两件事：

1. **限定只读面**：`change.read` / `change.list` 两条（动作标识与[工程工具契约 §3](../../docs/contracts/engineering-tools.md) 同源），由一个枚举式只读 runner 分发——清单读取是原 CLI 已有、旧工具面缺失的能力；`action` 只能是枚举值，清单 `target` 只接受 `@me`，**不提供自由 argv / 通用 `run`**。仓库 / Issue / PR 的读与写由 `@heluo/forge-gitee` 唯一负责——devops 不再持有第二套事实来源，`change_context` 的承建仓库段因此降级为外部指引（`REPO_FACTS_EXTERNAL` → `forge_gitee_repository_read` / `forge_gitee_issue_read`）。
2. **把"退出码"与"事实"分开**：适配器只给退出码、没有结构化状态或缺来源版本时，结果降级为 `unknown` 并给出原因，**不报成功**。

宿主接线（`src/index.mjs` 是唯一装配点）：`apply()` 按「配置（三层合并）→ 子进程出口 → dop 适配器 → 门禁适配 → 流程协作者 → 工具与入口注册」装配。配置由 `createCliAccess` 在装配期做一次三层合并（配置页 > 环境变量 > 自动发现；页面「重新自动发现」是唯一重扫入口），合并结果只以**显式配置**的形式交给流程，流程侧不再自己读一次进程环境；子进程只有一个出口 `createCliRunner`；适配器只有 `createDopAdapter`（gh 侧适配器已随模块删除）；门禁用 `createPolicyGuard` 包住 `policy.executeAction`；流程协作者由 `createDevopsFlow` 生产，并以服务键 `devopsFlow` 提供（只读端口另以 `devopsReader` 提供，未就绪时不提供）。宿主注入同名协作者时以注入为准（离线测试或网关替换用），不注入即包内自建——两条路都由本包保证可达。

策略服务是硬依赖，拿不到或没有 admission 入口就不挂载（入口关闭），不提供"无策略只读"降级；挂载时校验策略目录覆盖两条读动作且已开放（空目录/漏映射/未开放一律拒绝挂载，`POLICY_ACTION_UNREGISTERED`）；`change_read` / `change_list` 每次调用都经同一门禁（`POLICY_DENIED` 时零下游调用），调用方自带 `role` 等参数不进入 admission 身份（不扩权）。**已知边界**：上下文卡（`change_context`）的 dop 读取在挂载期目录校验后直连适配器，运行期不重复准入，也不产生第二条审计；若要求它与查询同口径，需单独接线（未在本轮范围）。卸载后插件服务与全部工具注册一并移除、无残留（此处指插件自身；profile 补丁层里的条目由 `pnpm uninstall:devops` 清理，见[回滚](#回滚)）。

模型可见面注册四个工具：`forge_devops_query`（只读 runner，动作为枚举的 `change.read` / `change.list`；单条读取返回读信封 + `facts`（平台记录与归一结果），清单返回 `user` / `total` / `count` / `items` / `filter`；归一失败只记 `normalize_error`，raw 仍返回）、`forge_devops_change_context`（聚合读，产出上下文卡；承建仓库段为外部指引 `REPO_FACTS_EXTERNAL`）、`forge_devops_change_update`（受控写回：`summary` 标题 / `description` 描述 / `aiAc` 验收标准，动作 `change.clarification.write`，默认不登记即拒绝，需 `confirm{object}` 且目标必须是会话已读到的变更）、`forge_devops_artifact_write`（产物落盘，唯一落盘出口；`clarify` 需 `data.findings`、`plan` 需 `data.items` 且必须过机检，`body` 与 `data` 互斥）。参数名统一用 `target`：策略门禁只读 `exec.arguments.target`，用 `command`/`path` 之类名字会让 `target-required` 永远无法满足（2026-10-24 实测的目录缺口）。未就绪时流程面仍可达，但只产出 `blocked` 卡（零子进程调用），只读工具按 `NO_READER` 失败并给出配置页指引；产物落盘在写文件之前按「变更号绑定 → kind/参数（body 与 data 互斥）→ meta 证据」三段校验，clarify/plan 机检失败零落盘。配置页的读写端点在同源 `/api/forge-devops` 下（`GET` 快照、`POST` 保存；写请求要求自定义请求头，响应一律 `no-store`），`webServer` 缺失或前缀冲突时只降级，不影响工具面与流程面。

### 写回变更内容（`change update`，默认关闭）

`dop change update <变更号> --summary "标题" --description "描述" --ai-ac "验收标准"`（用户 2026-11-04 提供，dop 1.x 新参数）用于 Agent 分析完变更内容后回写标题、描述与验收标准。

- **只有三个字段**：`summary`（标题）、`description`（描述）、`aiAc`（`--ai-ac`，验收标准）；至少给一个，空字段不拼 flag，不做通用 argv 透传。
- **三层前置**：`confirm{object}` 与目标逐字一致 → 目标必须等于本次会话已读到的变更号（先读再写）→ 策略门禁 `change.clarification.write`（默认未登记即拒绝、零子进程）。
- **写后回读**：`change view --json` 核对三个字段（`summary` / `description` / `userStory.storyAC`，平台可能 HTML 包裹），结果只有 `done` / `failed` / `unknown`；退出码 0 不单独算成功，`unknown` 不重放。
- **默认关闭**：分发补丁层不登记写动作；要启用，在活动 profile 的补丁层给 `heluo-policy` 加目录条目与**有效审批台账**（登记 ≠ 批准，缺台账挂载即拒绝）：

```yaml
catalog:
  - { action: 'change.clarification.write', kind: 'write', target: 'change', enabled: true }
approvals:
  - approval_id: 'APR-DEVOPS-UPDATE-001'
    action: 'change.clarification.write'
    resource: 'ARD123456'          # 只批准这一条变更；'*' 表示该动作全部资源
    approved_by: '<批准人>'
    approved_at: '2026-11-04T10:00:00+08:00'
    revision_range: []             # 空 = 不绑定版本；有范围时不匹配无版本调用
    expires_at: '2027-11-04T10:00:00+08:00'
```

写回的 `--help` 与输出样例仍无企业样本；`--ai-ac` 的落点在 mock CLI 1.0.4 上实测为变更级 `aiAcceptanceCriteria`（企业侧未验，回读因此两处都认，见「未验」）；审批台账由你自己填写，工具不代替审批。

## 测试

```sh
node --test "packages/forge-devops/test/*.test.mjs"
```

覆盖（`node --test` 全量，条数以实跑为准）：未登记动作拒绝且不触碰适配器、缺目标拒绝、无适配器 fail closed、只给退出码不算成功、未启动（`exitCode: null`）按入口形态归因并保留 `detail.spawnFailed`、缺来源版本降级、事实齐全时的规整结果、策略缺失不挂载、卸载（插件服务与工具注册）无残留、配置校验；工具侧另有：只注册四个工具、参数用 `target` 且必填、写回的 confirm/字段/未知三态、两条读动作各自路由、清单 `@me` 之外拒绝且零下游调用、`facts` 与 `command` 透传、clarify 零选项与 plan 缺验证方式被拒且不落盘、`body`/`data` 互斥、无适配器时可见拒绝、退出码不算成功、卸载移除工具注册；组合根侧（`flow.test.mjs`）：配置齐全时产出 `ready` 卡（dop 一次固定 argv）、未配置时 `blocked` 卡 + 零调用、无写端口、非法变更号早退；目录绑定侧（`policy-binding.test.mjs`）：空目录/漏映射/未开放/无目录/无 admission 入口拒绝挂载、承认时恰好一次适配器调用、策略拒绝时适配器零调用且工具面可见拒绝、调用方自带 `role` 不进入 admission 身份。CLI 配置面另有：`entry-form.test.mjs`（入口形态单点：win32 的 `.exe` / 无后缀 / `.cmd` / `.ps1` / `.bat` / `.com` 六形态都能直接执行，POSIX 仍要执行位、仍不选包装脚本）、`failure-face.test.mjs`（spawn 失败面单点：读信封、写动作结果与变更卡片三出口同口径，只给 `reason` / 失败类别 / `next`，零路径、零 errno、零原始报错）、`cli-discovery.test.mjs`（名字表 6 项、`.exe` 优先排序、`rejected` 恒空、执行位、PATH 去重与展开、目录上限、假时钟截止；Windows 规则靠注入平台与假文件系统覆盖，真机属未验）、`cli-config.test.mjs`（三层优先级矩阵、事实来源推导四态、来源语义、脱敏零命中、逐字段报错）、`cli-access.test.mjs`（快照/刷新/revision 栅栏/保存四路径）、`cli-http.test.mjs`（GET/POST 状态码、请求头、`no-store`、错误体形状、`?refresh=1` 在响应前完成发现→重合并→重建读面）、`client-shape.test.mjs`（页面骨架的静态契约：两个分区 id/order、两键渲染与文案零命中、r15 的 `devops-readiness` 槽）、`save-applied.test.mjs`（r15：写成功后 `applied:{ok:true}` + 快照 `plugin`/`editable`；重建失败降级为 `{ok:false,reason:'CLI_REBUILD_FAILED'}` 且 `status()==='no-reader'`；端点 GET 带投影、POST 原样透传 `applied`）、`delivery-selfcheck.test.mjs`（全仓安全扫描：发现层零子进程、客户端不打印路径，以及 4 个工具 / 4 个配置键 / 无 gh 残留的清单自检）。

仓库根另有卸载命令的离线用例：`node --test tests/patch-layer-blocks.test.mjs tests/uninstall-devops.test.mjs`——补丁层按缩进块精确删条目（缩进更深的同名 `- id:` 不命中）、重复执行幂等、无 `dsh` 时只清理并打印下一步、stdout 零绝对路径。

r15 的设置页另有仓库根级校验：`node scripts/check-client-module.mjs packages/forge-devops/client.js`（用假 Loader / 假 React 真跑 `apply`，检查导出面、两个分区与 effect 返回值）、`node --test tests/ui-contract.test.mjs`（四个分区 id/order 唯一、两客户端都走两段式挂载、端点常量与 `src/http.mjs` 逐字一致、`?refresh=1` 只出现一次）、`node --test tests/bundle-build.test.mjs tests/bundle-gitee.test.mjs`（`HOST_PEERS` 放行 react 但不进包，四条拒绝路径）；实机装入与回滚的计划、证据核对用 `node scripts/uat-profile.mjs --plan|--verify`。

## 边界

- 2026-11-03 当前用户最终确认[Issue 交付模型](../../docs/requirements/requirements-baseline.md#23-issue-交付模型与受控研发目标需求已确认)：变更组织目标与总体约束，1:N Issue；每 Issue 恰一变更及一仓库，跨仓库拆独立交付验收 Issue。变更／Issue 双入口须读真实关联，run 只是执行记录。
- dop 读取变更（单条 / 清单）、总体约束与关联线索，以故事作背景；仓库／Issue／PR 事实仍由 Gitee 唯一负责，不以 `change_context` 指引冒充权威关联。四工具与四配置键不因此增加接口；只读 runner 的扩展参数必须逐个取证后进枚举，写回只经固定三个 flag，不把 argv 交给模型。
- 双端产物、凭据注入、真实关联和用户权限须验证；未获准或验证失败时关闭对应命令。需求不再等平台／安全／PMO 代批，但真实强制控制不可绕过。
- 充分 Issue 不另写规格，Agent 按需设计，Skill 提供企业语义，Teamflow 唯一执行；内部 PRD／技术蓝图不是第二需求真源。澄清按归属写回变更或 Issue，仍需动作授权、C3 分类、版本与回查；现有默认禁用及未验状态不变，不主动最终结项。
- 超时、断流或无法确认未执行时不盲目重放，按冻结规则处理。
- CLI 无法满足必要前提时提交替代形态评审；不自动启用 MCP 服务、PRM 或 REQ-12 核心补丁。

## 未验（NOT RUN）

- **Windows 实机**：自动发现与配置页在真实 Windows 上的行为（中文目录、含空格路径、UNC 与长路径、768 高度视口）未跑；上述规则与页面行为由离线用例覆盖（注入平台、假文件系统与假时钟），**不是实机证据**。企业内网 Windows 上按报障场景复测「保存 npm 全局目录下那个无后缀的 `dop`」（保存即通过）同样**未跑**。
- **包装脚本与 shim 的真实启动失败**：未启动提示由 `src/failure-face.mjs` 单点按入口形态归因，结构化 detail 带 `reason` / 失败类别 / `next`，不含路径与 errno；这一面由注入 `EINVAL` / `ENOENT` 桩在离线用例里覆盖，**没有在真实 npm shim 上跑过**；真实 Windows 上 `dop.cmd`、无后缀 shim 的启动失败仍属未验。
- **宿主组合**：当前插件在目标宿主版本下的 `configEditor` 写面与写后热调和未联调；配置页未走宿主表单面，改由同源路由 + profile 补丁写入。
- **企业前提**：dop 是否随附原生 Windows 可执行文件、是否提供离线身份探针、真实安装目录分布均未知。发现规则不依赖这些；未命中时页面显示已查类别与全部候选，由用户指定位置。
- **`change list` 扩展参数**：清单读取的主路径（`change list --json`）有适配器与离线用例；`--state` 已按 2026-11-04 的 spec 修正（`--status` 不存在），分页/搜索/team 未接入；真实输出样例仍待企业实测。
- **`change update` 写回**：`--summary/--description/--ai-ac` 三个 flag 由用户 2026-11-04 口头给出，`--help` 与输出样例仍无**企业**样本（mock CLI 1.0.4 的 `--help` 与写后回读已实测）。
  `--ai-ac` 的落点在 mock 上实测为变更级 `aiAcceptanceCriteria`，而 UAT 形状是故事 `userStory.storyAC`；回读按「变更级优先、故事兜底」两处都认，并用 `readback.aiAc_source` 说明本次按哪一处判定。
  企业环境真实落点仍属未验：若真实平台两处都不写，回读会判 `absent` → `unknown`（不重放），这是期望的保守行为。
