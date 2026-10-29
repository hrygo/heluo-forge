# @heluo/forge-devops

状态：可用（只读查询 + 变更全流程工具面 + 门禁骨架 + Web 配置页与 CLI 自动发现；#15 / D4，责任方 2026-10-24 决定，设计准入见[能力面设计 §6.1](../../docs/design/plugins/forge-devops-lifecycle.md)）。"可用"指本包有清单、源码与离线可执行的用例；**企业 CLI 未联调**，写动作受策略门禁与人工确认约束，`merge`/`close`/`change done` 不在命令白名单内。

| 项 | 内容 |
|---|---|
| 形态 | 现有 CLI 接入：查询基线 + 受控写目标（规划，写待批/默认禁用） |
| 前置条件 | 装好即可用，不需要预先设置环境变量：装配期自动发现 dop 与 gh；只有机器上确实找不到时才需要到配置页指定位置（见「配置」） |
| 配置入口 | `设置 → DevOps 变更流程`（Web 配置页）；三层来源「配置页 > 环境变量 > 自动发现」，环境变量只作 CI 与无界面 profile 的兜底 |
| 职责 | 复用 DevOps CLI，以命令白名单、凭据注入与策略门禁读取系统变更及独立验收、所属故事背景；受控回写见详细设计 |
| 不负责 | 不内置平台凭据，不接入生产写工具，不替代平台权限 |
| 衔接点 | bash 工具、企业策略门禁、凭据注入与审计（均待接口核验） |
| 条件服务 | [services/devops-mcp](../../services/devops-mcp/README.md)；当前不建设 |
| 详细设计 | [DESIGN-009](../../docs/design/plugins/forge-devops.md)（草案，已建立） |
| 实现状态 | 已建立 `package.json`、只读端口、门禁骨架、流程组合根（`src/flow.mjs`）、九个工具与 `devops-change` 入口、Web 配置页（`client.js`）与四层 CLI 配置模块（自动发现 / 三层合并 / 宿主适配 / 同源路由）、离线测试（`node --test`）；**企业 CLI 联调未做** |

## 安装

```sh
# 安装（tarball 由构建步骤产出，自带策略闭包）
dsh plugin --profile web add <tarball>
# 复核补丁层是否进了组合树
dsh --profile web --dump-config | grep -A2 "id: forge-devops"
```

装好后重载 profile（或重启宿主）即可用：Windows 上只要 `dop.exe` / `gh.exe` 在 PATH 或候选目录里，插件在装配期就能找到，**不需要任何环境变量**。安装单元、补丁层顺序与策略门禁要求见「安装单元与策略门禁」；`forge-devops` 层不要与 `@heluo/forge-enterprise` 的组合层叠加。

## 配置（配置页优先，环境变量兜底）

一句话：**插件自己找 dop 与 gh；只有找不到时才需要你指定位置。** 六个配置项逐字段取第一个有值的层——**配置页 > 环境变量 > 自动发现**，页面对每个字段标出来源，覆盖关系也标出来（配置压过环境变量时挂「覆盖环境变量」），不静默替换。

### 配置页（`设置 → DevOps 变更流程`）

进入路径两次点击：首页 → 左下「设置」→ 侧栏「DevOps 变更流程」。

页面是**状态**而不是必填表单：命中自动发现时，两张入口卡默认只读，显示命中的可执行文件与来源（配置 / 环境变量 / 自动发现 / 未找到）；用户正常情况下只读不填，只有未命中时才落进「填入路径」。

| 想做的事 | 操作 | 结果 |
|---|---|---|
| 覆盖为手动指定 | 点「改为手动指定」，粘贴 `dop` / `gh` 可执行文件的完整地址（资源管理器里右键文件 →「复制文件地址」） | 保存时逐字段校验：文件存在、是普通文件、可直接执行、不是包装脚本（见「自动发现规则」） |
| 回落到自动发现 | 点「重置为自动发现」，或把输入框清空，再点「保存」 | 该键从配置里删除，回落下一层（环境变量 → 自动发现）；清空即回落，不必卸载重装 |
| 重新扫描 | 点「重新自动发现」 | 发现只在装配期跑一次；**只有**这个动作会重扫，工具调用永不触发扫描 |
| 保存 | 页脚「保存」 | 写入活动 profile 的补丁层（`forge-devops` 条目的 `config:` 段）；期间被别的窗口改过则提示「配置已被其它窗口改动 · 刷新后重试」，不覆盖对方改动 |
| 查看其它候选 | 展开「自动发现命中 · 另有 N 个候选」 | 多份安装时按 PATH 优先静默取首个，其余候选可展开查看，不自动选用 |

保存成功后读面立即按新配置重建（无需重启）；写进 profile 补丁的值重启后仍然有效。**发现结果不回写配置**：换机器或改 PATH 后点「重新自动发现」即可跟随，页面不会把自动发现的等值写盘。当前 profile 没有挂载配置面（`settings` / `config-editor`）时，页面降级为只读并给出环境变量出口，而不是渲染一个存不进去的表单。

### 配置项（配置页 / 环境变量）

六个键名与代码同源（`CLI_FIELDS`，camelCase），页面标签、环境变量与工具失败文案指向同一句指引「设置 → DevOps 变更流程」。

| 配置项（camelCase） | 配置页 | 环境变量 | 缺省 | 说明 |
|---|---|---|---|---|
| `dopBin` | dop 可执行文件 | `FORGE_DEVOPS_DOP_BIN` | 自动发现；三层都没有则未就绪 | 完整地址，或已在 PATH 内的可执行文件名（如 `dop`）；Windows 上只接受 `.exe` |
| `dopEndpoint` | dop 服务地址 | `FORGE_DEVOPS_DOP_ENDPOINT` | 留空即不配置 | 绝对 http(s) 地址，地址里不能带用户名密码；凭据不进地址、不进配置页 |
| `ghBin` | gh 可执行文件 | `FORGE_DEVOPS_GH_BIN` | 自动发现，未命中按 `gh` | 仓库侧 CLI；同样只接受 `.exe` 或 PATH 名 |
| `ghOwner` | gh 组织 / 用户 | `FORGE_DEVOPS_GH_OWNER` | 留空即不限定 | 用于限定可见仓库范围；字母、数字与连字符，不以连字符开头 |
| `sourceType` | 事实来源 | `FORGE_DEVOPS_SOURCE_TYPE` | `mock` | `mock`（本地模拟）/ `enterprise`（企业实测），报告按此分记事实来源 |
| `timeoutMs` | 超时（毫秒） | `FORGE_DEVOPS_TIMEOUT_MS` | `20000` | 单次调用上限，取值 1000–600000 |

字段规则的唯一真源是 `src/runtime-config.mjs` 的 `validateConfigField`：环境变量层与宿主 loader 的配置校验直接调用它。**浏览器半（`client.js`）不能 import 服务端模块**，所以页面表单内联了一份等值副本（同一组取值边界；`ghOwner` 上界 39 两侧一致），两面的等值关系不是靠注释保证，而是由 `test/client-rule-parity.test.mjs` 的跨面矩阵用例守着——改任一侧的边界都会先红在那里（R2-1 就是副本少了上界、失焦放行、保存才 422）。路径类判定（存在性、目录、执行位、包装脚本）再由 `src/cli-config.mjs` 追加一层：页面只判包装脚本，其余（含 Win32 的 `.exe` 要求）在保存时由服务端返回逐字段 422。任一字段非法即整包未就绪（`CLI_CONFIG_INVALID`），**不回落下一层**——填错的意图若被静默换成别的路径，用户会以为"我配置的那个在生效"；页面逐字段报错（找不到这个文件 / 这是目录 / 不是可直接执行的文件 / 包装脚本 / 路径过长（>4096）/ 地址带用户名密码 / 超时越界 / 来源取值非法）。

### 自动发现规则

发现是只读的、有界的文件系统探测，**零子进程**，只在装配期与页面「重新自动发现」时跑：

- 名字：Windows 只认 `dop.exe` / `gh.exe`（大小写不敏感）；macOS / Linux 认无后缀的 `dop` / `gh`，并要求执行位。
- 位置：`PATH` 的每一项；再加少量候选目录（Windows：`%ProgramFiles%\{tool}`、`%ProgramFiles(x86)%\{tool}`、`%ProgramFiles%\heluo`、`%LOCALAPPDATA%\Programs\{tool}`、`%USERPROFILE%\.{tool}\bin`；POSIX：`/usr/local/bin`、`/opt/{tool}/bin`）。不递归遍历。
- 预算：最多 200 个目录、250ms 截止（是上限而不是目标，正常机器只碰几个目录）。
- 拒收包装脚本：`.cmd` / `.bat` / `.ps1` / `.com` / `.vbs` 一律不当作可直接执行——`execFile(shell: false)` 在 Windows 上起不了这类脚本，硬起还会把参数拼进命令行。页面提示「请指向 .exe」。

### 找不到时

fail closed 语义不变，但文案改成人话：只读工具仍以 `NO_READER` 失败（原因码不加码），`detail.reason` 给细因（`CLI_NOT_FOUND` / `CLI_CONFIG_INVALID`）、`detail.searched` 给已查类别（配置 / 环境变量 / PATH / 候选目录）、`detail.next` 给页面入口；流程面仍可达，但只产出 `blocked` 卡且零子进程调用。整条信封不含盘符、绝对路径与平台地址——它要进工具输出与日志。

## 环境变量兜底（CI / 无界面 profile）

无界面的 CI、或 profile 没挂载配置面时，用环境变量配置；语义与环境变量层一致：仍低于配置页、高于自动发现。六个键全部可选，不设也能用（自动发现兜底）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `FORGE_DEVOPS_DOP_BIN` | 无（走自动发现） | dop 可执行文件（PATH 名或完整地址） |
| `FORGE_DEVOPS_DOP_ENDPOINT` | 无 | 只接受绝对 http(s)，不接受内嵌凭据 |
| `FORGE_DEVOPS_GH_BIN` | `gh` | 仓库侧 CLI |
| `FORGE_DEVOPS_GH_OWNER` | 无 | 组织/用户名，用于限定可见仓库范围 |
| `FORGE_DEVOPS_SOURCE_TYPE` | `mock` | `mock`（本地模拟）/ `enterprise`（企业实测） |
| `FORGE_DEVOPS_TIMEOUT_MS` | `20000` | 单次调用上限，取值 1000–600000 |

`resolveRuntimeConfig(env)` 只认显式传入的环境（不读进程环境）：缺 `FORGE_DEVOPS_DOP_BIN` 返回 `CONFIG_MISSING` 并点名变量，格式不合法返回 `CONFIG_INVALID`——两者都不给出可用配置，调用方必须拒绝启动流程，不猜默认值。这里只表示"环境变量层没给出可用值"，装配层会继续看自动发现；三层都没有才未就绪。`describeRuntimeConfig()` 只给「已配/未配」布尔位与两个非机密枚举，页面上的脱敏状态（`service.cliStatus()`）同理，**从不回显路径与地址**。

环境变量的值同样走字段校验：某项非法即整包未就绪并在页面按字段报错，不会因为它"看起来能用"就被放行。

## 回滚

1. **页面回滚（推荐）**：在「设置 → DevOps 变更流程」里对改过的字段点「重置为自动发现」，再点「保存」。六个字段全部重置后，该条目的整段 `config:` 会被删掉，回到"未配置即自动发现"。
2. **手工回滚**：在活动 profile 的补丁文件里删掉 `forge-devops` 条目下的 `config:` 段（保留注释与其它条目原样），保存后重载 profile。
3. **卸载**：`dsh plugin --profile web remove @heluo/forge-devops`。
4. **复核**：`dsh --profile web --dump-config | grep -A2 "id: forge-devops"` 里不应再有 `config:`；页面回到「自动发现 / 未找到」；`git status --short` 不应新增文件（插件不写缓存或临时文件）。

## 安装单元与策略门禁（20261028-r1）

单个包就是完整安装单元：清单声明 `dsh.bundle.patch: ./cordis.patch.yml`、`files` 带补丁层与 `client.js`，并把 `@heluo/forge-policy` 声明为包依赖（`workspace:*`），使"只装 devops"也能挂载。补丁层**先插策略、后插 devops**，两行都用包根名——策略先行是硬依赖，顺序错了按 fail-closed 拒绝挂载。若同一 profile 已 apply `@heluo/forge-enterprise` 的补丁层（其中已插策略），不要再叠加本层，否则同一个 id 会被重复挂载。

策略行必须自带非空的 `config.catalog` 才会挂载成功：策略缺省目录是空表，devops 校验"四个读动作已登记且 `enabled`"随即以 `POLICY_ACTION_UNREGISTERED` 拒绝挂载（2026-10-28 第 2 轮 QA 的 N-1：包能装进 profile，但宿主启动时报 `1 entry did not activate`，加载路径挂住）。补丁层因此预置四条只读动作（`change.read` / `repository.read` / `issue.read` / `pr.read`，`target` 分别为 `change` / `repository` / `issue` / `pull-request`）；写动作不预置，因为策略要求 enabled 的写/确认动作带审批台账条目，属单独的范围批准。同时必须显式配置 `config.audit`：策略无可用审计舱时对每个动作都拒绝（`POLICY_AUDIT_UNAVAILABLE`；内存舱未声明 `allowNonDurable` 时是 `POLICY_AUDIT_NOT_DURABLE`），只补目录不补审计仍是"装上不可用"。补丁层给的是内存审计舱，属**联调/试点级**证据，生产须在 profile 注入持久 sink 并去掉 `allowNonDurable`。补丁层也不写 `tools` 映射：devops 自己每次读/写都调 `policy.executeAction`，宿主层再映射会重复准入与重复审计，未映射的宿主工具按策略自身的 out-of-scope 语义放行。以上配置由 `test/patch-mount.test.mjs` 固化为门禁：解析分发出去的补丁层，用其中配置真实装配策略 + devops（9 个工具、读经门禁放行、审计记录落账），并全仓扫描任何插入 `@heluo/forge-devops` 的补丁层。

子进程只有一个出口（`src/cli-runner.mjs`）：`execFile` + `shell: false` + 超时 + 单流输出上限；入参只接受 `{ bin, args, purpose }`，程序名与参数分开传，没有"把整条命令当字符串"的通道；`execFile` 可注入，离线测试用假实现，不 spawn 真实 CLI。失败是数据不是异常：非零退出、超时、起不来分别落到 `exitCode`、`timedOut`、`exitCode: null`，由适配器映射为 `failed`/`unknown`，不重放。子进程环境沿用宿主进程环境，覆盖项只放非机密开关。

## 骨架内容（已落地）

只做两件事：

1. **限定只读面**：`change.read`、`repository.read`、`issue.read`、`pr.read`（动作标识与[工程工具契约 §3](../../docs/contracts/engineering-tools.md) 同源）。
2. **把"退出码"与"事实"分开**：适配器只给退出码、没有结构化状态或缺来源版本时，结果降级为 `unknown` 并给出原因，**不报成功**。

宿主接线（`src/index.mjs` 是唯一装配点）：`apply()` 按「配置（三层合并）→ 子进程出口 → dop/gh 适配器 → 门禁适配 → 流程协作者 → 工具与入口注册」装配。配置由 `createCliAccess` 在装配期做一次三层合并（配置页 > 环境变量 > 自动发现；页面「重新自动发现」是唯一重扫入口），合并结果只以**显式配置**的形式交给流程，流程侧不再自己读一次进程环境；子进程只有一个出口 `createCliRunner`；适配器用 `createDopAdapter`/`createGhAdapter`；门禁用 `createPolicyGuard` 包住 `policy.executeAction`；流程协作者由 `createDevopsFlow` 生产，并以服务键 `devopsFlow` 提供（只读端口另以 `devopsReader` 提供，未就绪时不提供）。宿主注入同名协作者时以注入为准（离线测试或网关替换用），不注入即包内自建——两条路都由本包保证可达。

策略服务是硬依赖，拿不到或没有 admission 入口就不挂载（入口关闭），不提供"无策略只读"降级；挂载时校验策略目录覆盖四个读动作且已开放（空目录/漏映射/未开放一律拒绝挂载，`POLICY_ACTION_UNREGISTERED`）；每次读取与写入都经同一门禁（`POLICY_DENIED` 时零下游调用），调用方自带 `role` 等参数不进入 admission 身份（不扩权）；卸载移除服务与全部工具注册、无残留。

模型可见面注册九个工具：四个只读（`forge_devops_change_read` / `forge_devops_repository_read` / `forge_devops_issue_read` / `forge_devops_pr_read`）、聚合读（`forge_devops_change_context` 产出上下文卡）、三个写（`forge_devops_issue_write` / `forge_devops_pr_write` / `forge_devops_clarify_write`，需 `confirm{repo,object}` 且目标必须是已判定的承建仓库）与产物落盘（`forge_devops_artifact_write`）。参数名统一用 `target`：策略门禁只读 `exec.arguments.target`，用 `command`/`path` 之类名字会让 `target-required` 永远无法满足（2026-10-24 实测的目录缺口）。未就绪时流程面仍可达，但只产出 `blocked` 卡（零子进程调用），只读工具按 `NO_READER` 失败并给出配置页指引；写动作在子进程之前按「门禁 → 变更号 → 运行时配置」三段拒绝。配置页的读写端点在同源 `/api/forge-devops` 下（`GET` 快照、`POST` 保存；写请求要求自定义请求头，响应一律 `no-store`），`webServer` 缺失或前缀冲突时只降级，不影响工具面与流程面。

## 测试

```sh
node --test "packages/forge-devops/test/*.test.mjs"
```

覆盖（`node --test` 全量，条数以实跑为准）：未登记动作拒绝且不触碰适配器、缺目标拒绝、无适配器 fail closed、只给退出码不算成功、缺来源版本降级、事实齐全时的规整结果、策略缺失不挂载、卸载无残留、配置校验；工具侧另有：只注册九个工具、参数用 `target` 且必填、正常路径返回契约结果、无适配器时可见拒绝、退出码不算成功、卸载移除工具注册；组合根侧（`flow.test.mjs`）：配置齐全时产出 `ready` 卡（dop/gh 各一次固定 argv）、未配置时 `blocked` 卡 + 零调用、写动作三段前置拒绝、非法变更号早退；目录绑定侧（`policy-binding.test.mjs`）：空目录/漏映射/未开放/无目录/无 admission 入口拒绝挂载、承认时恰好一次适配器调用、策略拒绝时适配器零调用且工具面可见拒绝、调用方自带 `role` 不进入 admission 身份。CLI 配置面另有：`cli-discovery.test.mjs`（名字表、包装脚本拒绝、执行位、PATH 去重与展开、目录上限、假时钟截止；Windows 规则靠注入平台与假文件系统覆盖，真机属未验）、`cli-config.test.mjs`（三层优先级矩阵、来源语义、脱敏零命中、逐字段报错）、`cli-access.test.mjs`（快照/刷新/revision 栅栏/保存四路径）、`cli-http.test.mjs`（GET/POST 状态码、请求头、`no-store`、错误体形状）、`client-shape.test.mjs`（页面骨架的静态契约）、`delivery-selfcheck.test.mjs`（全仓安全扫描：发现层零子进程、客户端不打印路径）。

## 边界

- 查询以系统变更及独立验收为主、故事作背景；命令、字段、结构化输出与退出码由 DevOps 提供方确认，不预设工具数量，不接入生产写工具。
- 双端产物、凭据注入与用户权限须验证；未获准或验证失败时关闭对应命令。
- 系统变更是规格生成的主输入；经确认的澄清/研发进展回写是待批目标，范围/C3分类及接口验证前禁用，不主动最终结项；字段以提供方确认为准。
- 超时、断流或无法确认未执行时不盲目重放，按冻结规则处理。
- CLI 无法满足必要前提时提交替代形态评审；不自动启用 MCP 服务、PRM 或 REQ-12 核心补丁。

## 未验（NOT RUN）

- **Windows 实机**：自动发现与配置页在真实 Windows 上的行为（中文目录、含空格路径、UNC 与长路径、768 高度视口）未跑；上述规则与页面行为由离线用例覆盖（注入平台、假文件系统与假时钟），**不是实机证据**。
- **宿主组合**：当前插件在目标宿主版本下的 `configEditor` 写面与写后热调和未联调；配置页未走宿主表单面，改由同源路由 + profile 补丁写入。
- **企业前提**：dop 是否提供离线身份探针、真实安装目录分布未知。发现规则不依赖前两项；未命中时页面显示已查类别与全部候选，由用户指定位置。
