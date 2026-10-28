# @heluo/forge-devops

状态：可用（只读查询 + 门禁骨架；#15 / D4，责任方 2026-10-24 决定，设计准入见[能力面设计 §6.1](../../docs/design/plugins/forge-devops-lifecycle.md)）。"可用"指本包有清单、源码与离线测试可跑；**企业 CLI 未联调，写动作全部关闭**。

| 项 | 内容 |
|---|---|
| 形态 | 现有 CLI 接入：查询基线 + 受控写目标（规划，写待批/默认禁用） |
| 职责 | 复用 DevOps CLI，以命令白名单、凭据注入与策略门禁读取系统变更及独立验收、所属故事背景；受控回写见详细设计 |
| 不负责 | 不内置平台凭据，不接入生产写工具，不替代平台权限 |
| 衔接点 | bash 工具、企业策略门禁、凭据注入与审计（均待接口核验） |
| 条件服务 | [services/devops-mcp](../../services/devops-mcp/README.md)；当前不建设 |
| 详细设计 | [DESIGN-009](../../docs/design/plugins/forge-devops.md)（草案，已建立） |
| 实现状态 | 已建立清单、只读端口、门禁骨架、四个只读工具、DOP 只读子进程适配器和用户简报 CLI；本地证据见[设计索引](../../docs/design/README.md)；**企业 CLI 联调未做** |

## 用户可见入口

```sh
pnpm demo:change
node packages/forge-devops/src/change-cli.mjs demo --out ./change-demo.html
```

新增 `heluo-change demo` / `view` 端到端只读简报：显式变更号 → 固定 DOP argv → 真实子进程 → 字段/目标校验 → 需求与独立验收/故事/排期 → 终端或自包含 HTML。demo 无网络、无真实凭据；只读实源必须显式选 CLI 与新审计文件，拒绝覆盖、超时/权限/坏 JSON 不重试。命令依据 `oh-my-sdd` 的用户企业实测确认；本方本地仿 CLI 回归不冒充本次企业联调。

该入口是人类直接运行的诊断 CLI，复用 policy 判定与必要审计核心，**不等于已接入当前 DSH profile 的 IAM/角色/组织开关**。导出的 `createDopReader` 仅实现 `change.read`；其他三种读动作没有借此自动开放真实提供方。需求版本/仓库映射未核定时，只读结果仍是 `unknown`，保留已校验 `facts` 供阅读，不作冻结或自动承接依据。

宿主只读适配器与闭环判定（#25/#26，2026-10-27 本地实测）：

- `gh-process.mjs`：只执行三种固定 `view --json`（repo/issue/pr），生产路径要求绝对可执行文件，`shell:false`、输出/超时有界、POSIX 进程组与 Windows `taskkill /T /F` 清理、错误码固定脱敏。PR 读取含 `commits`（用于 `[变更号]` 前缀核对）。
- `host-readers.mjs`：`createHostReader` 把 `change.read` 路由到 DOP、其余三读路由到 gh；显式 host 绑定、跨仓关闭引用拒绝，结果一律 `unknown` + 已校验 `facts`；提交列表缺失记 `null`，不当成"无提交"。
- `trace-loop.mjs`：`assessIssueClosure` 按四项可核对事实（变更关联行、同仓关闭 PR、每个提交标题以 `[变更号]` 开头、人工验收记录）给出 `closable`/`not-closable`；`buildWriteSteps` 只产出写动作计划（`plan-only`，从不执行）。判定只读，不代替人工验收或关闭 Issue。

`node scripts/probe/run-trace-loop.mjs --cli-dir <含dop/gh目录> --repo <HOST/OWNER/REPO> --targets <变更号>:<Issue号> --out <新目录> [--acceptance <验收记录.json>]` 输出 `loop.json`/`index.html`/`plan.json`/`audit.jsonl`。

[试用步骤与最小测试输入](../../docs/operations/change-briefing.md)。发行物自包含 policy，不需终端联网解析 workspace 依赖或安装进真实 profile。

## 骨架内容（已落地）

原有端口继续保持两条约束：

1. **限定只读面**：`change.read`、`repository.read`、`issue.read`、`pr.read`（动作标识与[工程工具契约 §3](../../docs/contracts/engineering-tools.md) 同源）。
2. **把"退出码"与"事实"分开**：适配器只给退出码、没有结构化状态或缺来源版本时，结果降级为 `unknown` 并给出原因，**不报成功**。

宿主接线：只读适配器经服务键 `devopsReader` 注入（真实 DOP reader 由 `./dop-reader` 导出，宿主仍须显式接线；不自挂不明来源）；策略服务是硬依赖，拿不到或没有 admission 入口就不挂载（入口关闭），不提供“无策略只读”降级；挂载时校验策略目录覆盖四个读动作且已开放（空目录/漏映射/未开放一律拒绝挂载，`POLICY_ACTION_UNREGISTERED`）；每次读取经 `policy.executeAction` 走同一门禁与必要审计，策略拒绝时适配器零调用（`POLICY_DENIED`，可见拒绝）；调用方自带 `role` 等参数不进入 admission 身份（不扩权）；卸载移除服务与全部工具注册、无残留。

模型可见面只注册四个只读工具（`forge_devops_change_read` / `forge_devops_repository_read` / `forge_devops_issue_read` / `forge_devops_pr_read`），**没有任何写工具**。它们的参数名刻意用 `target`：策略门禁只读 `exec.arguments.target`，用 `command`/`path` 之类名字会让 `target-required` 永远无法满足（2026-10-24 实测的目录缺口）。

```sh
node --test packages/forge-devops/test/
```

覆盖（29 例，2026-10-26）：未登记动作拒绝且不触碰适配器、缺目标拒绝、无适配器 fail closed、只给退出码不算成功、缺来源版本降级、事实齐全时的规整结果、策略缺失不挂载、卸载无残留、配置校验；工具侧另有：只注册四个读工具、参数用 `target` 且必填、正常路径返回契约结果、无适配器时可见拒绝、退出码不算成功、卸载移除工具注册；目录绑定侧（`policy-binding.test.mjs` 10 例）：空目录/漏映射/未开放/无目录/无 admission 入口拒绝挂载、承认时恰好一次适配器调用、策略拒绝时适配器零调用且工具面可见拒绝、调用方自带 `role` 不进入 admission 身份。

## 边界

- 查询以系统变更及独立验收为主、故事作背景；命令、字段、结构化输出与退出码由 DevOps 提供方确认，不预设工具数量，不接入生产写工具。
- 双端产物、环境变量凭据注入与用户权限须验证；未获准或验证失败时关闭对应命令。
- 系统变更是规格生成的主输入；经确认的澄清/研发进展回写是待批目标，范围/C3分类及接口验证前禁用，不主动最终结项；字段以提供方确认为准。
- 超时、断流或无法确认未执行时不盲目重放，按冻结规则处理。
- CLI 无法满足必要前提时提交替代形态评审；不自动启用 MCP 服务、PRM 或 REQ-12 核心补丁。
