# Forge 专家智能体接入方案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-023 |
| 文档名称 | Forge 专家智能体接入方案 |
| 版本 | V0.2.1 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-18 |
| 门禁 | 范围裁决、目标版本与企业契约取证、详细设计准入 |

> 编制依据为 2026-11-18 的项目工作区与双侧版本源码核对、Delegra 本机隔离测试。实测范围、缺口及待实测项见 §2.1 和 §6.1。
>
> 关联文档包括[专家智能体 PRD](../requirements/delegra-experts-prd.md)和[需求与场景基线](../requirements/requirements-baseline.md)。工作由 [issue #243](https://github.com/hrygo/heluo-forge/issues/243) 跟踪。

## 1. 建议与推进状态

**暂缓实施。** 建议由 DSH 的公开插件接缝承接专家目录、`@` 选择、主助手调用及回复，由 Delegra 在现有任务、权限和运行服务之上提供受限员工 API。服务端以当前员工的授权创建私有任务，并把可验证的运行结果返回原 DSH 会话。

[需求基线 §2](../requirements/requirements-baseline.md#2-范围边界唯一真源)当前将跨系统 Agent 调度列为不做。恢复排期时，由项目负责人裁决是否纳入受限的专家委派，按决定同步基线及受影响文档。随后确认宿主接缝和云端契约，完成[详细设计登记](../design/README.md)与[插件准入](../engineering/dsh-plugin-conventions.md)。DSH 核心、MCP 和生产变更继续适用现行边界。

首轮建议在一个获准组织内，以两个不同职责和只读工具集合的专家覆盖完整闭环。每次显式选择一位专家，发送员工确认的文本，验证状态查询、结果、追问、取消及显式上下文复用。文件附件随资料传递、自动选人、多专家编排和目标系统写动作留作单独取舍。专家自身配置仍由 Delegra 管理。

## 2. 源码证据与路线取舍

| 基准 | 2026-11-18 已核对的证据 | 对接入的约束 |
|---|---|---|
| HeLuoForge `15f425e2` | [宿主版本](../../.dsh-version)为 `0.2.1-rc.3`。现有 Forge IAM 提供当前会话信息，Forge Policy 承接动作与内容策略 | 复用既有身份和策略边界，独立核验 Delegra 目标凭据的发放、续期和撤销 |
| DSH 官方 `dsh-v0.2.1-rc.3`（`1f81c047fc48`） | [输入触发及引用序列化](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/client/ui-input-trigger/src/types.ts)、[原生消息提交](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/client/ui-conversation/src/client/service.ts)与 [`agent/pre-step`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/core/agent/src/runtime-types.ts)提供候选、提交及首步处理接缝。引用先展平为文本，原生提交随后生成请求标识 | 端到端关联、草稿恢复、结果入模和重启后的会话定位均需实测 |
| DSH 官方 `dsh-v0.2.2-rc.3`（`38a6a5c965aa`） | 本机 CLI 版本与该候选一致。候选版改善提交接受后的清空时序，仍需建立员工、选择、实际提交和轮次的绑定 | 研究比较版本。项目兼容基线与验收目标仍为 `0.2.1-rc.3` |
| Delegra `deploy/v2026.1106.0-r2`（`25c86a283a9c`） | `server/src/services/public-mcp/capabilities.ts`、`server/src/routes/issues.ts`、`server/src/services/authorization.ts`、`packages/db/src/schema/issues.ts` 与 `doc/ISSUE-PRIVACY.md` 提供只读源码证据 | 确认用到的调度和权限能力后才定义目标契约。企业部署的实际版本、配置、运行器与权限仍待验证 |

### 2.1 Delegra 本机验证

2026-11-18 在 Delegra 工作树 `a5f8f5a386` 运行现有测试，测试辅助文件含既有工作区改动。环境为 Node.js `24.21.0`、Vitest `5.0.3`、隔离的临时 PostgreSQL、合成账号和模拟执行，出站网络限于本机，私有访问控制为 `enforce`。第一轮选择 13 项，18.39 秒。第二轮选择 6 项，16.14 秒。**选中的 19 项全部通过**。证据适用于该工作树和测试夹具，目标部署版本、企业凭据、真实运行器及 DSH 端到端验收见 §6.1。

复跑使用下文的[两轮筛选命令](#211-复跑命令)及套件自建数据库。各轮的命中文件、通过和跳过数见[筛选结果](#212-筛选结果)。

| 验证面 | 本机结果 | Delegra 测试套件 |
|---|---|---|
| 员工与任务权限 | 人员 OAuth 的只读范围拒绝写入，跨组织、撤权或失去成员资格时拒绝后续调用。私有任务允许负责员工与获权主体访问 | `authorization-service.test.ts`、`public-mcp.test.ts` |
| 私有运行与通用列表 | 私有运行的详情、事件和日志对未获权代理返回 `404`，获权读取及撤权重查通过。通用运行历史和实时列表仍可返回脱敏运行条目，其中保留标识、耗时、费用或用量。专家记录的默认可见性须覆盖这些列表条目 | `heartbeat-run-privacy-routes.test.ts` |
| Agent Chat 会话与可见性 | 同组织、同员工、同专家的重复打开返回同一任务 ID。同组织同事的个人聊天列表为空，其经通用任务入口读取默认聊天记录得到 `200`。独立 DSH 会话须分别关联执行上下文，专家记录须在创建时赋予私有可见性 | `agent-conversations.test.ts` |
| 普通任务的会话记录 | 同一专家的不同任务可分别保留会话记录，重置一条时保留另一条。模拟适配器验证服务端移除过期继续上下文并排除跨组织评论。真实模型线程、工作区和工具权限仍待实测 | `heartbeat-task-session-reset.test.ts`、`heartbeat-task-context.test.ts` |
| 回执与结果 | 现有公共 MCP 路径的同键同内容重试只创建一条任务，同键异内容被拒绝。模拟回执丢失时保持未知，重复请求未再次调用下游。新建执行器可读回测试保存的结果，模拟运行还验证了 `paperclip.run_result.v1` 结果形态 | `public-mcp.test.ts` |

第二轮的断言通过。测试收尾时，后台队列和工具审核投递访问已关闭的临时数据库，日志记录 `CONNECTION_ENDED` 与 `CONNECTION_DESTROYED`。真实运行器收尾与跨进程恢复保留为待实测。

#### 2.1.1 复跑命令

在上述 Delegra 工作树的 `server/` 目录执行。先安装该工作树的依赖，并确保 `node --version` 为 `v24.21.0`。以下为原取证使用的 macOS 本机隔离方式。每轮使用独立临时目录，清空继承的进程环境，关闭遥测，并仅允许本机出站连接。

```sh
node_bin="$(command -v node)"

run_probe() (
  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/delegra-expert-local.XXXXXXXX")" || exit 1
  mkdir -p "$probe_dir/home" "$probe_dir/tmp" || exit 1
  trap 'rmdir "$probe_dir/home" "$probe_dir/tmp" "$probe_dir" 2>/dev/null || true' EXIT
  time sandbox-exec -p '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))' \
    env -i PATH="${node_bin%/*}:/usr/bin:/bin" TMPDIR="$probe_dir/tmp" \
    PAPERCLIP_HOME="$probe_dir/home" PAPERCLIP_TEST_HOST_HOME="$probe_dir/home" \
    PAPERCLIP_TELEMETRY_DISABLED=1 PAPERCLIP_ISSUE_PRIVACY_MODE=enforce \
    "$node_bin" ../node_modules/vitest/vitest.mjs run --config vitest.config.ts "$@"
)

run_probe --reporter=verbose \
  src/__tests__/authorization-service.test.ts \
  src/__tests__/heartbeat-run-privacy-routes.test.ts \
  src/__tests__/heartbeat-task-session-reset.test.ts \
  src/__tests__/public-mcp.test.ts \
  -t "explicit target-agent allowlist|limits viewer members to read-only|enforces private issue implicit principals|returns 404 for direct private-run content|returns full private-run content|rechecks a revoked grant on the next history request|clears only the selected task's UUID and identifier sessions|replays completed writes|uses real task/document routes|hides private tasks from assistant search|Dot prototype"

run_probe --reporter=default --silent=true \
  src/__tests__/agent-conversations.test.ts \
  src/__tests__/heartbeat-task-context.test.ts \
  src/__tests__/public-mcp.test.ts \
  -t "atomically resolves one task per person and agent|resolves through authenticated company routes|rejects token expiry, revocation and membership loss on the next call|rejects cross-company calls, missing write scope|clears stale wake comments and continuation data|excludes a wake comment from another company"
```

#### 2.1.2 筛选结果

原始 Vitest 输出摘要如下。第一轮会话重置用例分别命中 `uuid`、`identifier` 和 `lowercase_identifier` 三个参数。第二轮各文件各命中两个用例。

| 轮次 | 命中文件与通过数 | Vitest 汇总 |
|---|---|---|
| 第一轮 | `authorization-service.test.ts` 3 项，`heartbeat-run-privacy-routes.test.ts` 3 项，`heartbeat-task-session-reset.test.ts` 3 项，`public-mcp.test.ts` 4 项 | `4 passed` 文件，`13 passed / 168 skipped` 用例 |
| 第二轮 | `agent-conversations.test.ts` 2 项，`heartbeat-task-context.test.ts` 2 项，`public-mcp.test.ts` 2 项 | `3 passed` 文件，`6 passed / 122 skipped` 用例 |

### 2.2 路线取舍

| 路线 | 取舍 |
|---|---|
| 人员 OAuth 公共 MCP | 可作为目录和任务语义的对照。`paperclip_create_task` 未暴露显式私有可见性契约，`paperclip_read_task` 的评论与历史投影缺少权威的最终结果语义。DSH 基线的 Streamable HTTP transport 未接入 OAuth `authProvider`。[既有探针](../requirements/delegra-experts-prd.md#72-paperclip-用户连接按任务交办)仅读过一个人员连接的目录 |
| 原生 Agent Chat | 实验开关默认关闭。会话粒度与通用任务入口的本机结果见 §2.1。默认私有与会话隔离由专家接入的服务端契约明确约束 |
| 受限员工 API | 建议路线。复用 Delegra 私有任务、队列、运行及事件查询。新增边界集中于逐员工及逐专家授权、私有创建、DSH 会话绑定、通用读取范围及权威回执和结果契约 |

## 3. DSH 选择与委派绑定

1. **目录与草稿。** 使用当前员工身份读取服务端获准展示的专家和能力摘要，分别提示可查看和可调用。按稳定 `expertId` 区分同名专家。员工从 `@` 候选显式选择，插件保留目标、当前会话、草稿版本、任务文本和所选资料的关联。
2. **提交与轮次。** 在可信 Host 内以签发者和主体、当前授权代际、DSH 会话、稳定专家标识、规范化任务摘要及所选资料或复用范围建立短期一次性记录。引用序列化和鉴权 Remote 只携带关联标识，授权记录留在 Host。用 `agent/pre-step` 核对原生用户提交、调用来源、会话及文本摘要，将匹配记录原子消费到本轮，验证关联标识消除时机和实际日志、持久化路径。该设计依赖可信宿主与插件运行环境。
3. **工具执行。** 向主助手提供可引用的选择信息及工具入口。工具在发送前通过可信轮次取得原始任务，复核授权和 Forge Policy，拒绝模型改变目标、任务、资料或复用范围。基线缺少可强制指定本次工具的模型参数。主助手未调用工具、参数不匹配或目标失效时，展示未委派，员工可重新选择后显式重试。
4. **提交失败与恢复。** 基线原生提交的接受回执早于 `pre-step` 的业务判断，提交后拒绝可能无法利用原生草稿回退。按员工和会话保留可恢复草稿，恢复前重新验证选择，保护更新的输入。验收须覆盖普通文本、粘贴引用、重放、草稿改动、会话或账号切换、目录失效和原生提交失败，确认均不会发生错误委派。无法证明绑定及安全恢复时关闭该入口。

## 4. Delegra 权限、隔离与数据

- **身份。** 后端验证面向 Delegra 的当前员工凭据，经可信映射确定员工与组织。对目录、调用、状态、结果、续问、取消、复用逐项执行业务授权。刷新、撤销、身份切换和运行中授权变化需留证。凭据留在允许的 Host 或服务端边界，调用主体由服务端认证取得。
- **可见性。** 在创建事务中写入 `visibility=private`、负责员工和任务归属，目标环境验证私有访问控制处于 `enforce`。执行只授权绑定的专家运行。以相同的访问规则约束专用接口、通用任务列表和搜索、运行历史及实时列表、分享与改派、直接读取、事件、评论及产物。专家运行的存在及单条脱敏元数据也按记录可见规则控制。管理与审计访问按实际授权验证。
- **执行上下文。** 以组织、员工、稳定专家标识和原 DSH 会话为默认隔离维度。核验运行器的线程、工作区、可变记忆、工具缓存与凭据都遵循该边界，同一专家的服务级知识仍按业务授权提供。显式复用只取员工选定且当前获准的内容快照，带来源导入独立会话。所选运行器必须证明在员工数据权限、专家工具权限和本次授权的交集内工作。
- **数据。** 传递最小且获准的内容，两侧推理路径及日志按[需求基线 §4.4](../requirements/requirements-baseline.md#44-数据与合规约束)核验 C1–C4。受 C3 约束的外发等操作，在终端通过本机人工确认后才提交。记录授权、状态与回执关联所需的元数据。任何关键数据路径、执行权限或隔离能力缺证时，关闭受影响的入口。

## 5. 回执、结果与恢复

| 操作 | 拟议语义 |
|---|---|
| 目录、提交与查询 | 阅读目录、委派、按原请求读取受理回执和状态，分别授权。DSH 为每次已绑定的委派固定一个 `requestId`，与属主会话在首次发送前持久化。Delegra 按组织、员工、操作和 `requestId` 作幂等判定，固定请求摘要，原子记录任务与可恢复的排队意图。同键同内容取回原回执，同键异内容产生冲突 |
| 状态与取消 | 区分受理、排队、运行、待用户、完成、失败和已取消。客户端无法确认提交时显示结果未知。断网、超时、重启后以同一标识查询，未查清前冻结该委派的重复提交。取消请求与服务端已确认取消分别显示 |
| 结果与综合 | 定义可按专家、任务、运行和结果版本追溯的权威结果，明确不完整、追问和终态。收到经当前授权验证的摘要后，仅向原员工的原会话交还主助手，验证恢复或继续入口。原始结果默认折叠，展开、读产物或继续使用时重新授权。检查 DSH 工具返回、展示元数据、主助手回复和后续模型上下文的持久化，限制为获准留存的数据 |
| 续问与重开 | 续问绑定原员工、专家与任务并作独立授权和幂等控制。重开凭最少的本地状态及引用，从服务端查询实际状态。活动会话通知只用于提示更新，权威查询负责掉线与重启恢复 |

拟议语义供详细设计与契约验证。身份失效、操作未授权、记录不可见、幂等冲突和流转冲突需有可区分的错误及处置。终端与服务端分别具备独立关闭入口的能力，停用时停止新委派，已存在任务仍按当前授权提供状态和结果查询。恢复开关前核对未决请求及终态。

## 6. 恢复后的阶段与验收

| 阶段 | 跟踪 | 交付门槛 | 估算 |
|---|---|---|---|
| 范围与取证 | [#245](https://github.com/hrygo/heluo-forge/issues/245)、[#244](https://github.com/hrygo/heluo-forge/issues/244) 可并行 | 决定范围；指定宿主、Delegra 及运行器版本；取得真实网络、员工授权和私有任务证据；详细设计准入 | 4–6 人日 |
| 云端窄接口 | [#244](https://github.com/hrygo/heluo-forge/issues/244) 的契约为前置，交付拆分由 [#243](https://github.com/hrygo/heluo-forge/issues/243) 跟踪 | 授权、私有创建、独立上下文、同键重试、权威结果和状态查询在获准的隔离环境通过 | 5–9 人日 |
| DSH 交互与异步闭环 | [#246](https://github.com/hrygo/heluo-forge/issues/246)、[#247](https://github.com/hrygo/heluo-forge/issues/247) | 目标绑定、草稿及跨进程恢复、追问、取消、结果综合和权限变化通过 | 7–11 人日 |
| 目标环境验收 | [#243](https://github.com/hrygo/heluo-forge/issues/243) | 实际授权环境和已确定终端留证，门禁满足后再决定试点 | 3–5 人日 |

合计粗估 **19–31 人日**。估算基于身份链可落实、基线宿主接缝成立且现有任务与运行设施可复用。等待、宿主接缝缺口或新增企业能力的工作量待取证后另估。

### 6.1 待实测项

以下为目标方案的验收项，均处于 `NOT RUN`。§2.1 记录 Delegra 现有能力的本机取证。

| 验收面 | 待实测及通过判据 |
|---|---|
| 身份和隐私 | 在目标 Delegra 版本验证企业员工与组织映射、逐专家及逐动作授权。发起员工、仅获目录查看权员工、同组织普通员工、其他组织账号和获准审计人员各走专用及通用入口。撤权和身份切换符合约定的收敛时限，未获权方无法读取专家的任务、结果、产物和事件，或从运行历史及实时列表获知单条运行元数据 |
| 可信提交 | 区分同名专家。注入目标错选、内容变化、关联标识重放或模型跳过工具等异常时，远端没有新任务，界面显示真实结果，原草稿可恢复 |
| 隔离与授权复用 | 同一员工在两条 DSH 会话调用同一专家，另以不同职责专家核对工具权限。使用合成标记数据实测真实运行器的线程、工作区、记忆、工具与凭据。默认上下文互不可见，显式复用仅带入选定且仍获准的内容 |
| 幂等与真实结果 | 用员工专用接口验证回执丢失、重复点击、服务重启、客户端重开、长任务收尾、追问和取消。一次委派至多创建一条任务，队列可恢复，回读权威结果时核验当前授权并恢复到原会话 |
| 数据与终端 | 按获准目标在 Windows 桌面、银河麒麟本地 Web 和 macOS 桌面验证企业网络、身份和数据链。分别记录实际版本、时间、环境、复现和 PASS、FAIL、BLOCKED 或 NOT RUN |

## 7. 待确认事项

| 事项 | 责任方 | 截止门槛 |
|---|---|---|
| 是否恢复排期、纳入范围及首轮专家与目标终端 | 项目负责人 | 范围同步与排期 |
| 云端部署边界、Delegra 目标凭据、授权和运行器隔离 | 企业环境及服务的实际提供方、接入方 | 契约和数据路径验收 |
| 原生提交绑定、授权信息持久化风险、结果恢复与留存 | DSH 插件接入方 | 详细设计准入 |
