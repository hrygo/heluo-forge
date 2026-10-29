# @heluo/forge-devops

状态：可用（只读查询 + 变更全流程工具面 + 门禁骨架；#15 / D4，责任方 2026-10-24 决定，设计准入见[能力面设计 §6.1](../../docs/design/plugins/forge-devops-lifecycle.md)）。"可用"指本包有清单、源码与离线测试可跑；**企业 CLI 未联调**，写动作受策略门禁与人工确认约束，`merge`/`close`/`change done` 不在命令白名单内。

| 项 | 内容 |
|---|---|
| 形态 | 现有 CLI 接入：查询基线 + 受控写目标（规划，写待批/默认禁用） |
| 职责 | 复用 DevOps CLI，以命令白名单、凭据注入与策略门禁读取系统变更及独立验收、所属故事背景；受控回写见详细设计 |
| 不负责 | 不内置平台凭据，不接入生产写工具，不替代平台权限 |
| 衔接点 | bash 工具、企业策略门禁、凭据注入与审计（均待接口核验） |
| 条件服务 | [services/devops-mcp](../../services/devops-mcp/README.md)；当前不建设 |
| 详细设计 | [DESIGN-009](../../docs/design/plugins/forge-devops.md)（草案，已建立） |
| 实现状态 | 已建立 `package.json`、只读端口、门禁骨架、流程组合根（`src/flow.mjs`）、九个工具与 `devops-change` 入口、离线测试（`node --test`）；**企业 CLI 联调未做** |

## 骨架内容（已落地）

只做两件事：

1. **限定只读面**：`change.read`、`repository.read`、`issue.read`、`pr.read`（动作标识与[工程工具契约 §3](../../docs/contracts/engineering-tools.md) 同源）。
2. **把"退出码"与"事实"分开**：适配器只给退出码、没有结构化状态或缺来源版本时，结果降级为 `unknown` 并给出原因，**不报成功**。

宿主接线（`src/index.mjs` 是唯一装配点）：`apply()` 按「运行时配置 → 子进程出口 → dop/gh 适配器 → 门禁适配 → 流程协作者 → 工具与入口注册」装配。配置取自环境与显式 `config`（`resolveRuntimeConfig`，fail closed）；子进程只有一个出口 `createCliRunner`；适配器用 `createDopAdapter`/`createGhAdapter`；门禁用 `createPolicyGuard` 包住 `policy.executeAction`；流程协作者由 `createDevopsFlow` 生产，并以服务键 `devopsFlow` 提供（只读端口另以 `devopsReader` 提供，未配置运行时环境时不提供）。宿主注入同名协作者时以注入为准（离线测试或网关替换用），不注入即包内自建——两条路都由本包保证可达。

策略服务是硬依赖，拿不到或没有 admission 入口就不挂载（入口关闭），不提供"无策略只读"降级；挂载时校验策略目录覆盖四个读动作且已开放（空目录/漏映射/未开放一律拒绝挂载，`POLICY_ACTION_UNREGISTERED`）；每次读取与写入都经同一门禁（`POLICY_DENIED` 时零下游调用），调用方自带 `role` 等参数不进入 admission 身份（不扩权）；卸载移除服务与全部工具注册、无残留。

模型可见面注册九个工具：四个只读（`forge_devops_change_read` / `forge_devops_repository_read` / `forge_devops_issue_read` / `forge_devops_pr_read`）、聚合读（`forge_devops_change_context` 产出上下文卡）、三个写（`forge_devops_issue_write` / `forge_devops_pr_write` / `forge_devops_clarify_write`，需 `confirm{repo,object}` 且目标必须是已判定的承建仓库）与产物落盘（`forge_devops_artifact_write`）。参数名统一用 `target`：策略门禁只读 `exec.arguments.target`，用 `command`/`path` 之类名字会让 `target-required` 永远无法满足（2026-10-24 实测的目录缺口）。未配置运行时环境时流程面仍可达，但只产出 `blocked` 卡（未知项点名 `CONFIG_MISSING`）且零子进程调用；写动作在子进程之前按「门禁 → 变更号 → 运行时配置」三段拒绝。

```sh
node --test "packages/forge-devops/test/*.test.mjs"
```

覆盖（`node --test` 全量，条数以实跑为准）：未登记动作拒绝且不触碰适配器、缺目标拒绝、无适配器 fail closed、只给退出码不算成功、缺来源版本降级、事实齐全时的规整结果、策略缺失不挂载、卸载无残留、配置校验；工具侧另有：只注册九个工具、参数用 `target` 且必填、正常路径返回契约结果、无适配器时可见拒绝、退出码不算成功、卸载移除工具注册；组合根侧（`flow.test.mjs`）：配置齐全时产出 `ready` 卡（dop/gh 各一次固定 argv）、未配置时 `blocked` 卡 + `CONFIG_MISSING` + 零调用、写动作三段前置拒绝、非法变更号早退；目录绑定侧（`policy-binding.test.mjs`）：空目录/漏映射/未开放/无目录/无 admission 入口拒绝挂载、承认时恰好一次适配器调用、策略拒绝时适配器零调用且工具面可见拒绝、调用方自带 `role` 不进入 admission 身份。

## 安装单元与运行时配置（20261028-r1）

单个包就是完整安装单元：清单声明 `dsh.bundle.patch: ./cordis.patch.yml`、`files` 带补丁层，并把 `@heluo/forge-policy` 声明为包依赖（`workspace:*`），使"只装 devops"也能挂载。补丁层**先插策略、后插 devops**，两行都用包根名——策略先行是硬依赖，顺序错了按 fail-closed 拒绝挂载。若同一 profile 已 apply `@heluo/forge-enterprise` 的补丁层（其中已插策略），不要再叠加本层，否则同一个 id 会被重复挂载。

策略行必须自带非空的 `config.catalog` 才会挂载成功：策略缺省目录是空表，devops 校验"四个读动作已登记且 `enabled`"随即以 `POLICY_ACTION_UNREGISTERED` 拒绝挂载（2026-10-28 第 2 轮 QA 的 N-1：包能装进 profile，但宿主启动时报 `1 entry did not activate`，加载路径挂住）。补丁层因此预置四条只读动作（`change.read` / `repository.read` / `issue.read` / `pr.read`，`target` 分别为 `change` / `repository` / `issue` / `pull-request`）；写动作不预置，因为策略要求 enabled 的写/确认动作带审批台账条目，属单独的范围批准。同时必须显式配置 `config.audit`：策略无可用审计舱时对每个动作都拒绝（`POLICY_AUDIT_UNAVAILABLE`；内存舱未声明 `allowNonDurable` 时是 `POLICY_AUDIT_NOT_DURABLE`），只补目录不补审计仍是"装上不可用"。补丁层给的是内存审计舱，属**联调/试点级**证据，生产须在 profile 注入持久 sink 并去掉 `allowNonDurable`。补丁层也不写 `tools` 映射：devops 自己每次读/写都调 `policy.executeAction`，宿主层再映射会重复准入与重复审计，未映射的宿主工具按策略自身的 out-of-scope 语义放行。以上配置由 `test/patch-mount.test.mjs` 固化为门禁：解析分发出去的补丁层，用其中配置真实装配策略 + devops（9 个工具、读经门禁放行、审计记录落账），并全仓扫描任何插入 `@heluo/forge-devops` 的补丁层。

企业工具路径与平台地址一律由环境注入，**不硬编码、不写进文档、不落状态**：

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `FORGE_DEVOPS_DOP_BIN` | 是 | 无 | dop 可执行文件（PATH 名或环境提供的绝对路径） |
| `FORGE_DEVOPS_DOP_ENDPOINT` | 否 | 无 | dop 平台地址；只接受绝对 http(s)，不接受内嵌凭据 |
| `FORGE_DEVOPS_GH_BIN` | 否 | `gh` | 仓库侧 CLI |
| `FORGE_DEVOPS_GH_OWNER` | 否 | 无 | 组织/用户名，用于限定可见仓库范围 |
| `FORGE_DEVOPS_SOURCE_TYPE` | 否 | `mock` | `mock`（本地模拟）/ `enterprise`（企业实测），报告按此分记事实来源 |
| `FORGE_DEVOPS_TIMEOUT_MS` | 否 | `20000` | 单次调用上限，取值 1000–600000 |

`resolveRuntimeConfig(env)` 只认显式传入的环境：缺 `FORGE_DEVOPS_DOP_BIN` 返回 `CONFIG_MISSING` 并点名变量，格式不合法返回 `CONFIG_INVALID`——两者都**不给出可用配置**，调用方必须拒绝启动流程，不猜默认值。`describeRuntimeConfig()` 只给「已配/未配」布尔位与两个非机密枚举，**从不回显路径与地址**，可安全写进状态与报告。

子进程只有一个出口（`src/cli-runner.mjs`）：`execFile` + `shell: false` + 超时 + 单流输出上限；入参只接受 `{ bin, args, purpose }`，程序名与参数分开传，没有"把整条命令当字符串"的通道；`execFile` 可注入，离线测试用假实现，不 spawn 真实 CLI。失败是数据不是异常：非零退出、超时、起不来分别落到 `exitCode`、`timedOut`、`exitCode: null`，由适配器映射为 `failed`/`unknown`，不重放。

```sh
# 安装（tarball 由构建步骤产出，自带策略闭包）
dsh plugin --profile web add <tarball>
# 复核补丁层是否进了组合树
dsh --profile web --dump-config | grep -A2 "id: forge-devops"
# 回滚
dsh plugin --profile web remove @heluo/forge-devops
```

## 边界

- 查询以系统变更及独立验收为主、故事作背景；命令、字段、结构化输出与退出码由 DevOps 提供方确认，不预设工具数量，不接入生产写工具。
- 双端产物、环境变量凭据注入与用户权限须验证；未获准或验证失败时关闭对应命令。
- 系统变更是规格生成的主输入；经确认的澄清/研发进展回写是待批目标，范围/C3分类及接口验证前禁用，不主动最终结项；字段以提供方确认为准。
- 超时、断流或无法确认未执行时不盲目重放，按冻结规则处理。
- CLI 无法满足必要前提时提交替代形态评审；不自动启用 MCP 服务、PRM 或 REQ-12 核心补丁。
