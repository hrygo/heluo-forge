# Forge 专家智能体接入方案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-023 |
| 文档名称 | Forge 专家智能体接入方案 |
| 版本 | V0.3.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | Agent（代拟） |
| 负责 | Agent（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-18 |
| 门禁 | 范围裁决、目标版本与企业契约取证、详细设计准入 |
| 交付门禁 | 暂缓实施。固定版本本机取证见 §2，可信提交、企业授权、运行器隔离和原子受理待准入 |

> 编制依据为 2026-11-18 的项目源码核对、固定版本隔离测试及合成探针。现有组件证据见 §2，接入验收见 §6.1。
>
> 关联文档包括[专家智能体 PRD](../requirements/delegra-experts-prd.md)和[需求与场景基线](../requirements/requirements-baseline.md)。工作由 [issue #243](https://github.com/hrygo/heluo-forge/issues/243) 跟踪。

## 1. 建议与推进状态

**暂缓实施。** 建议由 DSH 的公开插件接缝承接专家目录、`@` 选择、主助手调用及回复，由 Delegra 在现有任务、权限和运行服务之上提供受限员工 API。服务端以当前员工的授权创建私有任务，并把可验证的运行结果返回原 DSH 会话。

本机证据支持复用 DSH 引用、首步钩子及同一会话的继续运行，以及 Delegra 私有任务、授权判断、持久派发和运行状态设施。开工前有三项关键取证。DSH 原生提交先持久化后进入首步钩子，需证明受信提交绑定及完整模型载荷受控。Delegra 须统一专家任务的详细记录与列表、实时投影的可见性，并证明实际运行器隔离。现有 MCP 的操作和回执分两次提交，员工 API 须证明任务及可恢复派发意图能一并受理。

[需求基线 §2](../requirements/requirements-baseline.md#2-范围边界唯一真源)当前将跨系统 Agent 调度列为不做。恢复排期时，由项目负责人裁决是否纳入受限的专家委派，按决定同步基线及受影响文档。随后确认宿主接缝和云端契约，完成[详细设计登记](../design/README.md)与[插件准入](../engineering/dsh-plugin-conventions.md)。DSH 核心、MCP 和生产变更继续适用现行边界。

首轮建议在一个获准组织内，以两个不同职责和只读工具集合的专家覆盖完整闭环。每次显式选择一位专家，发送员工确认的文本，验证状态查询、结果、追问、取消及显式上下文复用。文件附件随资料传递、自动选人、多专家编排和目标系统写动作留作单独取舍。专家自身配置仍由 Delegra 管理。

## 2. 源码证据与路线取舍

| 基准 | 2026-11-18 已核对的证据 | 对接入的约束 |
|---|---|---|
| HeLuoForge `e3c95d5609` | [宿主版本](../../.dsh-version)为 `0.2.1-rc.3`。Forge IAM 有身份及有效性投影，Forge Policy 有动作、目标和内容确认的判定。定向证明见 §2.4 | 取证 Delegra 专用凭据与真实执行边界，沿用现有 IAM 和 Policy 职责 |
| DSH 官方 `dsh-v0.2.1-rc.3`（`1f81c047fc48`） | [输入引用](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/client/ui-input-trigger/src/types.ts)、[原生消息提交](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/client/ui-conversation/src/client/service.ts)与 [`agent/pre-step`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/core/agent/src/runtime-types.ts)提供候选、提交及首步处理接缝。固定源码与发行 CLI 实测见 §2.3 和 §2.4 | 引用先展平为文本，提交随后生成请求标识。真实选择到已接收消息的可信绑定、终端恢复与结果的留存边界分别取证 |
| DSH 研究对照版本 | `0.2.2-rc.3` 源码改善了接受后的草稿清空时序。本机安装的 CLI 已为 `0.2.2-rc.5`，Forge 既有宿主探针在 `subagents.list` 接口处中止 | 独立记录对照结果，项目兼容基线与验收目标为 `0.2.1-rc.3` |
| Delegra `deploy/v2026.1106.0-r2`（`25c86a283a9c`） | 核对了任务、授权、运行和公共 MCP 源码，固定版本隔离实测见 §2.1 | 复用的组件按套件和断言评估。企业部署的实际版本、配置、运行器与权限仍待验证 |

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

#### 2.1.3 部署标签隔离复核

以 `git archive` 解出 `deploy/v2026.1106.0-r2` 的提交 `25c86a283a9c787a01911c714618d78df7552af7`，在独立临时目录运行 Node.js `24.21.0`、Vitest `5.0.3`、临时嵌入式 PostgreSQL 和合成账号。第三方依赖取自本机缓存，`postgres`、`acpx`、`claude-agent-acp` 的本机补丁与标签锁文件有差异；shared 和插件 SDK 从标签源码编译。启用 `enforce`，仅允许环回网络。六组执行共 **129 条既有断言、2 条临时故障探针通过**。命令、筛选结果和复现判据见[§8.1](#81-delegra-部署标签复跑)。

| 验证面 | 标签源码和本机断言 | 对接入的约束 |
|---|---|---|
| 角色与实时授权 | 私有任务授权撤销后，同一已连接 WebSocket 的后续任务事件被阻断；恢复授权后可见。通用 `heartbeat-runs`、`live-runs` 仍给同公司未获权代理返回含运行 ID、耗时、费用或用量的脱敏条目 | 私有任务详情和实时事件已有可复用检查。专家任务在通用列表、统计、实时推送都必须按记录权限过滤 |
| 任务与上下文 | 同一员工及专家的六次并发打开归并为一个 Agent Chat 任务。普通列表过滤该聊天，服务层按标识精确搜索能找到。有普通读取权的同事个人聊天列表为空，通用任务详情仍可读。普通 `taskKey` 单任务重置、过时代次拒收和排除跨组织输入的断言通过；另有实际 `process` 适配器和子进程返回合成回复的证据 | 采用专用私有任务及 DSH 会话到上下文的映射。存储分离和代次围栏仅覆盖各自路径，目标运行器的模型线程、工作区、记忆和工具凭据相互隔离仍待实测 |
| 持久运行派发 | 真实测试库验证事务提交前不领取、回滚无后继、替换 worker 后重建过期重试、并发只领取一次。启动恢复能区分派发前后的中断；暂无法回收的原生工作区保留待清理。固定标签的 `server/src/routes/issues.ts` 中，`createAcceptedIssue` 对符合条件的人员创建会一并提交任务和 `enqueueFastResponse` | 优先复用其事务接缝、持久队列和启动恢复。员工受理还须在同一事务包含私有范围及幂等回执，并确保一个请求只有一项可领取的派发意图 |
| 执行副作用与回执 | 实际 Runner API 路由和测试库验证响应丢失后结果未知、按已保存回执对账、旧运行请求被拒。MCP 故障探针在任务写入后模拟完成回执更新失败，分别保留 `unknown` 或 `reserved`。换数据库连接和执行器再用同键仍未知，任务仅一条，异体拒绝 | 现有 MCP 回执与动作分段落盘。专用员工接口须以同一个受理事务提交私有任务、回执和队列意图，异步执行按运行结果对账 |
| 权限桥与运行结果 | 既有 MCP 断言覆盖人员令牌到期、撤销、成员变化、受众与作用域限定、真实任务路由及审计。测试库中的持久回执和受权结果可回查 | 企业 IAM 到 Delegra 的凭据、完整员工授权及实际专家结果契约仍待实测 |

### 2.2 路线取舍

| 路线 | 取舍 |
|---|---|
| 人员 OAuth 公共 MCP | 可作为目录和任务语义的对照。`paperclip_create_task` 未暴露显式私有可见性契约，`paperclip_read_task` 的评论与历史投影缺少权威的最终结果语义。DSH 基线的 Streamable HTTP transport 未接入 OAuth `authProvider`。[既有探针](../requirements/delegra-experts-prd.md#72-paperclip-用户连接按任务交办)仅读过一个人员连接的目录 |
| 原生 Agent Chat | 实验开关默认关闭。会话粒度与通用任务入口的本机结果见 §2.1。默认私有与会话隔离由专家接入的服务端契约明确约束 |
| 受限员工 API | 建议路线。复用 Delegra 私有任务、持久工作队列、运行及事件查询。新增边界集中于逐员工及逐专家授权、私有创建与投影、按 DSH 会话绑定的执行上下文、原子受理及权威结果 |

### 2.3 DSH 基线隔离验证

对 `dsh-v0.2.1-rc.3`（`1f81c047fc48fa190a683e469daa699857e9afe8`）的归档源码，在临时目录构建 arm64 Host 原生扩展并运行定向测试。Node.js `26.12.1`、Vitest `4.1.11`，使用合成输入及替代模型网络。pi-ai `1.1.0` 和 pi-telemetry `1.1.0` 的包按标签锁文件校验，pi-ai 应用标签自带补丁，相关适配器直接依赖版本已核对；其余工作区依赖复用本机缓存。最终合并执行 **19 个套件、452 项通过**（5.32 秒），其中 446 项为既有用例，6 项为临时合成探针。环境和复跑入口见[§8.2](#82-dsh-基线源码复跑)。

| 验证面 | 本机结果 | 对接入的约束 |
|---|---|---|
| 原生候选与草稿 | 既有断言覆盖引用候选注册、选择、序列化、草稿保留与原生提交。实际基线先将引用展平为文本，再产生原生提交标识 | 复用原生选择 UI 具备组件证据。仅用原生字符串关联尚未证明真实选择与实际提交的唯一绑定 |
| 物理日志和首步 | 合成测试走实际 `SessionController.prompt`、`AgentLoop` 和 JSONL。阻塞在 `pre-step` 时已收到 `accepted: true`，原始 `agent/inbox/spliced` 已写入文件，尚无 `user/message`。改写后的用户消息及模型消息不含标记，拒绝时无模型请求，两种情况的原入箱事件均保留。见 [Prompt 命令](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/api/session-controller/src/commands.ts)和[运行首步](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/core/agent-loop/src/agent.ts) | Host 权限留在 Host。落盘原始文本的关联号不得承载权限、凭据或身份数据。验收时同时读取入箱事件、用户投影及模型请求 |
| 实际模型适配器载荷 | 用实际 DeepSeek Messages 适配器并替换 `fetch`。默认启用的扩展可将原入箱标记放入 `dsh_session_log`，此时 `messages` 中已无该标记；禁用扩展后整个请求无标记。标签锁定的 pi-ai `1.1.0` 也已实测，OpenAI Completions 请求无该字段或标记。见[会话日志扩展](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/session/session-log-deepseek/src/index.ts) | 验收目标的模型适配器和完整 HTTP 载荷，包含历史重开及扩展配置变化。仅允许通过数据路径核验的组合 |
| Cold resume 与交回 | 同一会话冷恢复后，`inject` 入箱保持休眠，`followup` 唤醒并由模型看到恢复后的上下文。原生批准与交互面板的套件通过；公开 `approval.request` 要求有开放轮次，可用回答器决定结果 | 可验证地定位原会话并回查权威结果。自动交还及跨登录隔离另测。备选确认须核实确有人工回答、取消和超时事件，避免通用批准结果直接成为外发授权。见[公开批准契约](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/subsystems/approval.md) |

### 2.4 Forge IAM / Policy 定向复核

项目基线使用 Node.js `24.21.0`，临时 Host 目录及只允许本机出站的合成环境。六个套件的 **148 项全部通过**（1.55 秒）。`getSession()` 只提供身份及有效性，定向用例验证退出态无主体和凭据、登录态不返回令牌。现有隔离消费和委托夹具验证代次变化或撤权拒发、每次执行仅派发一次、恢复只能保留或收紧权限。C3 判定按动作、目标和内容摘要精确约束确认。现有生产装配与实际 Delegra 凭据、外发授权和 Host 请求尚未接线取证。命令见[§8.3](#83-forge-iam-与-policy-复跑)。

在 macOS arm64 临时安装 `@deepseek-ai/dsh@0.2.1-rc.3`，核对发行包版本及 npm 完整性。使用实际 `sdk` profile 和 Forge 既有 Host 探针，**21 项运行断言通过、1 项受阻**（2.03 秒）。通过项包含硬拒绝零副作用、异步 pre-execute、无 Agent 确认失败、委托恢复所需 Host 事实及 IAM 缺席时拒绝。组合对照通过。SDK profile 缺少可比较的 LLM provider，桌面及 Web 运行模型面的组合验证留在目标环境。

## 3. DSH 选择与委派绑定

1. **目录与草稿。** Client 单 bundle 使用 `inputTriggers.registerSource` 展示当前员工可见的专家，分别提示可查看和可调用。同名项由职责及稳定 `expertId` 区分。目录缓存随登录会话变化失效。待发送的选择关联当前会话和草稿版本，授权由 Host 重新判定。
2. **提交预备。** Host 由当前可信身份取得签发者、主体和授权代次，短期记住该选择、实际 DSH 会话、规范化任务摘要及显式复用范围。若采用原生序列化，只有无授权信息的关联号可以进入消息。账号、草稿、会话或权限变化时使记录失效。引用和 Host 的准备记录本身只表示待匹配选择。
3. **轮次绑定。** `agent/pre-step` 只接受恰好对应的原生用户提交，核对刚领取的消息、服务端可观察的会话和原生请求标识，在 Host 内把记录一次性归属到当前轮次。需实证同一会话的复制／重放和并发同内容提交中，只有真实 UI 选择所对应的提交能完成绑定。当前字符串序列化接缝尚缺该实证。若公开 API 无法提供可信绑定，保留入口关闭。备选为带原任务和专家预览的独立 Host 确认动作，员工显式确认后才建立授权，交互取舍由项目负责人裁决。
4. **工具与本机策略。** 主助手获得轮次内的引用。工具以实际执行对象和已绑定的轮次读取唯一目的地、已批准的内容及复用范围。Host 在请求发出前复验 IAM 与策略。需人工确认时，动作、目标及内容摘要绑定到当次确认。基线缺少强制本次工具调用的配置。主助手跳过工具、选择失效或策略拒绝时显示未委派，受理状态由实际服务端回执推动。
5. **草稿恢复。** 原生提交的接受回执早于专家绑定和授权判断。先使用原生草稿恢复覆盖发送前失败；提交后拒绝时在原会话提供显式取回。额外快照限于属主会话允许的存储，恢复须确认草稿版本并保留后续输入。账号、会话和授权代次变化时要求重新选择。测试持久事件与实际模型适配器的完整出站载荷，覆盖额外字段及旧历史。

此绑定依赖一人一套的可信 Host 和受管插件装配。依照[插件高阶规范 P4](../engineering/dsh-plugin-conventions.md#34-p4-自证不是证据同权不是边界)，进程内匹配只用于提交授权和数据最小化，Delegra 服务端与工具各自执行实际访问控制。

## 4. Delegra 权限、隔离与数据

- **身份。** Delegra 验证专用凭据的签发方、受众、有效期及撤销语义，由可信映射得到员工与组织。Forge IAM 的本地会话投影只用于身份就绪判断；凭据取得委托 Host 端专用通道，准入须有企业契约。后端分别授权目录、调用、状态、结果、续问、取消、复用，并在排队转运行、工具访问、结果或产物读取时重验所需授权。授权变化后停止受影响的后续访问，返回已确认的实际状态。
- **可见性。** 创建事务写入 `visibility=private`、`responsibleUserId` 和归属。在目标环境核验 `enforce`，只给绑定专家发放执行需要的权限。按相同 ACL 过滤专用接口、通用详情、列表与搜索、运行历史和实时列表、评论、事件、产物、用量及审计。通用分享与改派须拒绝扩大专家任务可见范围或变更归属。列表在分页、聚合及推送前过滤，未获权方连单条脱敏运行元数据也不可见。长连接每次投递与重新订阅重验授权。管理、审计角色按实际授予的记录范围验收。
- **执行上下文。** 每次新的委派分配一项私有任务及独立上下文，同一 DSH 会话内再次委派也遵循此规则。服务端按组织、员工、专家、原 DSH 会话和任务记录归属。同任务追问经重新授权，以独立请求标识沿用任务上下文并按该任务串行受理。不同任务可独立推进及取消。一次运行携带实际适配器、任务或上下文标识及运行代次，旧代次不得更新新代次的结果、确认或工具权限。验证真实模型线程、工作区、可变记忆、工具缓存与凭据均按该边界生效。同一专家的通用知识仍按业务授权提供。显式复用只读取员工选定且当前获准的数据版本，带来源导入新上下文，避免共享可写历史。运行器按员工数据权限、专家工具权限与本次授权的交集工作。
- **会话归属。** Delegra 对每次读取和变更检查员工及任务 ACL，并校验操作与已登记上下文相符。DSH Host 核对当前本地会话与原会话的关系。员工获得某条结果的查阅权，也须通过原会话归属检查后才能将其用于自动续跑。会话标识仅供关联。
- **数据。** 传递最小且获准的内容，两侧推理路径及日志按[需求基线 §4.4](../requirements/requirements-baseline.md#44-数据与合规约束)核验 C1–C4。受 C3 约束的外发等操作，在终端通过本机人工确认后才提交。记录授权、状态与回执关联所需的元数据。任何关键数据路径、执行权限或隔离能力缺证时，关闭受影响的入口。

## 5. 回执、结果与恢复

| 操作 | 拟议语义 |
|---|---|
| 受理与对账 | DSH 在首次发送前持久化当前员工、原 DSH 会话和稳定 `requestId` 的最小关联。Delegra 在同一事务写入私有任务、幂等回执与可恢复派发意图，事务提交后才确认受理。幂等域为组织、员工、操作及请求标识，摘要覆盖实际委派内容与复用范围。同键同内容在当前授权下查回原回执，同键异内容产生冲突 |
| 排队与执行 | 复用现有持久工作队列及 worker 领取。按任务及运行代次领取、续租和确认，重启恢复未处理意图。超过派发边界的未知结果先对账；对账依据包含运行和已落盘副作用回执。旧运行迟到的更新须通过当前代次检查 |
| 状态与取消 | 服务端区分受理、排队、运行、待用户、完成、失败和已取消。无法确认受理时显示未知，断网、超时、重启后先按原标识查询。查无、不可见或过期均不单独证明未受理。原标识重试限于权威回执规则确认安全且可重建相同内容与授权的情况；其余保留未决状态或提示核对。取消请求、已取消及已完成分别展示；收到并发终态时以服务端事实为准 |
| 结果与综合 | 以明确归属到任务、实际运行和结果版本的受权结果为准，区分部分结果、追问与终态。通知只提示状态变化。Host 回查当前授权后，将允许入模和留存的摘要交还原员工原会话，按 `sessionId` 与结果版本对账及去重。原始输出和产物用引用按需回读。只有已验证的会话留存、重开及再入模路径可接收摘要；其余需要原会话显式回读。检查持久历史、导出、回放及网关完整载荷 |
| 续问与重开 | 续问绑定原员工、专家与上下文并作独立授权及幂等控制。重开后由持久引用查询权威状态，逐条核对归属和当前登录。自动继续需验证从休眠或冷恢复唤醒、重复通知及用户同时输入的行为，未通过时由原会话内的显式回查与继续动作承接 |

详细设计须区分身份失效、动作未授权、记录不可见、幂等冲突、不可确认和状态冲突，按可见规则决定错误的对外粒度。两侧单独控制新委派入口，停用时保留当前授权下的状态、结果和取消。回退须维持通用查询、历史及推送对存量的相同 ACL。旧版本无法做到时，保留具备权限控制的版本或停用受影响的投影，再继续对账及回退演练。

## 6. 恢复后的阶段与验收

| 顺序与跟踪 | 文件与服务职责 | 结束条件 | 估算 |
|---|---|---|---|
| 0. 范围裁决与基线 | [需求基线 §2](../requirements/requirements-baseline.md#2-范围边界唯一真源)及 [#243](https://github.com/hrygo/heluo-forge/issues/243)。确定首轮业务、企业环境、运行器及目标终端 | 项目负责人完成范围裁决。被选版本、试验账号和允许处理的数据明确 | 计入取证 |
| 1A. 宿主接缝取证 [#245](https://github.com/hrygo/heluo-forge/issues/245) | 固定 DSH 发行物和测试 profile。以原生提交、工具及会话钩子采集预备、原生请求、实际用户消息、发送载荷和恢复证据 | §3 的绑定反例、持久历史及完整模型载荷通过。失败则评审显式确认路线，当前入口保持关闭 | 1A、1B 合计 4–6 人日 |
| 1B. 云端契约取证 [#244](https://github.com/hrygo/heluo-forge/issues/244) | 核验员工身份到组织及权限映射、运行器及数据边界。由目标 Delegra 维护方确认受限接口的开发与发布版本线。双方在 `docs/contracts/` 明确逻辑操作、错误、保留期、授权、负向用例与回退契约，在 `docs/design/` 登记模块详细设计 | 与 1A 并行。确认云端交付职责与部署路径；真实身份、专用凭据、独立上下文及受理事务有可判定的验收条件后完成设计准入 | 同上 |
| 2A. 云端私有路径 [#244](https://github.com/hrygo/heluo-forge/issues/244) | Delegra `server/src/routes/` 放受限入口，服务层复用任务和授权。独立检查历史、实时及产物投影。以 schema 与运行器接缝承接会话归属 | 先以多身份矩阵验证私有创建、列表及事件、实际运行器 A／B 隔离与选定复用；权限变化反例通过 | 2A、2B 合计 5–9 人日 |
| 2B. 云端受理与结果 [#243](https://github.com/hrygo/heluo-forge/issues/243) | Delegra 服务层固定回执、事务、持久派发及运行代次。受限查询、结果和取消通过同一授权规则 | 在真实 PostgreSQL 夹具对未到达、事务回滚、丢响应、回执过期、并发领取、重启和迟到结果做故障注入，查数据库及队列，而后验收获权结果回读 | 同上 |
| 3A. DSH 发现和提交 [#246](https://github.com/hrygo/heluo-forge/issues/246) | 详细设计确认接缝后，在建议的 `packages/forge-experts/` 分 Client 单 bundle、Host 装配、可信选择和发送策略。复用 IAM 与 Policy 契约 | 可按已定契约与 2A、2B 并行验证 Client。真实委派须等云端私有路径与受理通过；错误委派和越界发送均为零 | 3A、3B 合计 7–11 人日 |
| 3B. DSH 状态和结果 [#247](https://github.com/hrygo/heluo-forge/issues/247) | 同一包独立管理请求归属、权威回查、结果视图及同一会话的继续入口。测试走正式工具、会话与 Remote 入口 | 接 2B 与 3A。追问、取消、重复事件、进程重开、权限变化及旧登录结果隔离通过 | 同上 |
| 4. 目标环境验收 [#243](https://github.com/hrygo/heluo-forge/issues/243) | 在获准组织及已确定终端以两名不同职责的专家联调，保存版本、独立角色、网络与数据链、实测输出 | 按 §6.1 逐项留证。带存量记录与未决任务演练停用、对账和回退，验证未获权方在通用列表和实时入口仍不可见，再决定试点 | 3–5 人日 |

合计粗估 **19–31 人日**，作为已证明复用条件成立时的规划区间。1A、1B 后按认证、宿主交互及运行器改造面重估。实施任务各自先落负向验收，再作最小改动，最后用实际入口验证，分别提交评审。上述路径均处于方案阶段。

### 6.1 待实测项

以下为拟议接入链路的验收项，当前均为 `NOT RUN`。§2 记录已有组件及探针证据。

| 验收面 | 待实测及通过判据 |
|---|---|
| 身份和隐私 | 在目标 Delegra 版本验证企业员工与组织映射、逐专家及逐动作授权。发起员工、仅获目录查看权员工、同组织普通员工、其他组织账号和获准审计人员各走专用及通用入口。仅可查看专家的员工直接提交也被拒绝。撤权和切换符合约定收敛时限，未获权方无法读取任务、结果、产物、事件和运行元数据 |
| 可信提交 | 区分同名专家。以两条原生提交并发、同会话复制与重放、账号切换、跨工作区草稿移动、选择或外发内容变化、模型跳过工具覆盖绑定。仅有效提交创建任务。失败如实显示，原草稿可恢复，新输入保留 |
| 隔离与授权复用 | 同一员工在两条 DSH 会话调用同一专家，同会话发起两条新委派及对单任务追问。用两个专家核对工具权限和取消互不影响。使用合成标记实测真实运行器的线程、工作区、记忆、工具与凭据。默认上下文互不可见，显式复用仅带入选定且仍获准的版本。新运行拒绝旧代次结果和工具答复 |
| 幂等与取消 | 员工接口逐个验证事务失败、提交后丢回执、worker 重启、同键异体、重复点击及取消和完成并发。核对任务、回执、持久派发意图和运行代次，确认一次委派至多创建一条任务，同次派发可对账 |
| 结果与恢复 | 验证长任务、会话切换及关闭、宿主和 Delegra 重启、错会话追问、重复或乱序通知及迟到结果。结果到达前和摘要已写入后都测试撤权和账号切换，核查 Remote、导出、冷恢复历史及模型载荷。状态与权威回执一致，已获权结果只交回原会话 |
| 数据与终端 | 按获准目标在 Windows 桌面、银河麒麟本地 Web 和 macOS 桌面验证企业网络、身份和数据链。分别记录实际版本、时间、环境、复现和 PASS、FAIL、BLOCKED 或 NOT RUN |

## 7. 待确认事项

| 事项 | 责任方 | 截止门槛 |
|---|---|---|
| 是否恢复排期、纳入范围及首轮专家与目标终端 | 项目负责人 | 范围同步与排期 |
| 云端部署范围、接口维护与目标版本线、Delegra 凭据、授权及运行器隔离 | 企业环境及服务的实际提供方、接入方 | 契约和数据路径验收 |
| 原生提交能否绑定真实选择，入口关闭时是否采用显式确认动作 | DSH 插件接入方、项目负责人 | 宿主取证与交互裁决 |
| 专家结果入模、留存、撤权后的历史处理与恢复交互 | DSH 插件及 Delegra 接入方 | 详细设计准入 |

## 8. 固定版本复跑与筛选结果

已有套件可直接按命令复跑。临时探针按本节的夹具及断言重建，表格保留本机原始汇总和耗时。

### 8.1 Delegra 部署标签复跑

用标签归档独立准备工作区依赖，在根目录执行以下命令。测试时使用独立 `TMPDIR`、`PAPERCLIP_HOME`、`PAPERCLIP_TEST_HOST_HOME`，清除继承环境，关闭遥测，开启 `PAPERCLIP_ISSUE_PRIVACY_MODE=enforce`，仅允许环回访问，保留测试数据库需要的临时 socket。结果为原隔离执行摘要，过滤跳过表示本轮未选择的测试。

```sh
node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/plugins/sdk/tsconfig.json

deleg_test() {
  node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
    --maxWorkers=1 --no-cache --reporter=verbose "$@"
}

deleg_test server/src/__tests__/heartbeat-run-privacy-routes.test.ts \
  server/src/__tests__/live-events-run-read.test.ts

deleg_test server/src/__tests__/heartbeat-run-dispatch-work.test.ts \
  server/src/__tests__/heartbeat-orphaned-active-lease-sweep.test.ts \
  server/src/__tests__/heartbeat-queued-run-claim-isolation.test.ts \
  server/src/__tests__/heartbeat-task-session-reset.test.ts

deleg_test server/src/__tests__/public-mcp.test.ts \
  -t 'uses the configured origin|keeps public MCP|rejects token expiry|rejects cross-company calls|does not accept MCP bearer|replays completed writes|uses real task/document routes|shares named/API receipts|revokes existing assistant'

deleg_test server/src/services/native-runtime/runner-api.integration.test.ts \
  server/src/__tests__/heartbeat-process-recovery.test.ts \
  -t 'counts committed effects|keeps saved API responses|allows task image reads|scope after a task|reuses the completed effect|revalidates the active run|scope bound to another actual run|stale source-run question|recovers legacy startup before adapter.invoke|retries a legacy run that a restart stopped|orphaned legacy run that reached adapter dispatch|releases active environment leases|promotes a scheduled plan-approval continuation retry'

deleg_test server/src/__tests__/agent-conversations.test.ts \
  server/src/__tests__/heartbeat-task-context.test.ts \
  server/src/__tests__/heartbeat-session-preparation.test.ts \
  -t 'atomically resolves one task per person and agent|resolves through authenticated company routes|deduplicates concurrent message retries|resets only this task|separate ordered queue entries|runs real process turns|rejects late replies|excludes a wake comment|clears stale wake comments|reuses unchanged task sessions|starts fresh when effective model configuration changes|rotates a session at the configured run threshold'
```

临时回执探针以 `public-mcp.test.ts` 的真实 issue 路由夹具为底稿，替换分派队列为计数 stub。在测试数据库更新回执至 `completed` 时抛出合成异常，第二例加测更新至 `unknown` 也失败。断言实际任务只创建一条，回执分别停在 `unknown` 与 `reserved`，重建数据库连接和执行器后的同键请求仍未知且不重派，同键不同内容拒绝。这组仍使用上述 Vitest 参数，运行临时副本的 `-t 'PLAN-023 receipt finalization'`。

| 分组 | 套件 | Vitest 通过 / 过滤 | 墙钟耗时 |
|---|---:|---:|---:|
| 隐私与实时投影 | 2 | 38 / 0 | 22.05 秒 |
| 持久派发与普通会话 | 4 | 52 / 0 | 64.46 秒 |
| 公共 MCP | 1 | 9 / 75 | 15.58 秒 |
| Runner API 与启动恢复 | 2 | 17 / 451 | 24.92 秒 |
| Agent Chat 与上下文 | 3 | 13 / 45 | 22.20 秒 |
| 临时故障探针 | 1 | 2 / 84 | 13.74 秒 |

### 8.2 DSH 基线源码复跑

在独立 `dsh-v0.2.1-rc.3` 源码目录准备工作区依赖和该标签的 pi-ai 补丁。使用临时缓存和合成模型配置执行下列已有套件。命令分别列出 392 个原有断言和 54 个原有审批断言。合成 JSONL 及 HTTP 探针单独准备。

```sh
node native/system/scripts/build.ts --host-addon-only
node node_modules/vitest/vitest.mjs run --reporter=default --silent=false --maxWorkers 4 \
  packages/client/ui-input-trigger/tests/service.client.spec.ts \
  packages/client/ui-reference/tests/browser-plugin.client.spec.ts \
  packages/client/ui-conversation/tests/input-reference-submit.client.spec.ts \
  packages/client/ui-conversation/tests/draft-hub.client.spec.ts \
  packages/client/ui-conversation/tests/draft-document.client.spec.ts \
  packages/core/agent-loop/tests/inbox.spec.ts \
  packages/core/agent-loop/tests/interception.spec.ts \
  packages/core/agent-loop/tests/resume.spec.ts \
  packages/api/session-controller/tests/commands-queue-attachment.host.spec.ts \
  packages/api/session-controller/tests/session-cold.host.spec.ts \
  packages/experimental/hooks-codex/tests/coverage-prompt.spec.ts \
  packages/experimental/hooks-claude-code/tests/bridge.spec.ts \
  packages/session/session-log-deepseek/tests/upload.spec.ts \
  packages/llm/llm-deepseek/tests/extensions.spec.ts \
  packages/llm/llm-pi-ai/tests/sdk-options.spec.ts

node node_modules/vitest/vitest.mjs run --reporter=default --silent=false --maxWorkers 2 \
  packages/interaction/user-approval/tests/approval.spec.ts \
  packages/client/ui-approval/tests/ui-approval.client.spec.tsx
```

临时测试 `forge-intent.local.spec.ts` 在 `packages/core/agent-loop/tests/` 复用 `MockAdapter`，挂真实 JSONL、会话命令及空附件夹具。阻塞首步钩子时读物理文件，放行／拒绝后检查持久事件、模型请求数量与正文，再冷恢复同一会话对比 `inject`／`followup`。`forge-wire.local.spec.ts` 在 `packages/llm/llm-deepseek/tests/` 用合成会话事件和响应替换 `fetch`，分别检查实际 Messages 适配器扩展打开／关闭时的请求及实际 pi-ai OpenAI Completions 请求。最终将上述路径及两份合成测试路径合并，用 `--maxWorkers 4` 执行，原始汇总为 `19 passed` 文件和 `452 passed` 用例。

### 8.3 Forge IAM 与 Policy 复跑

在项目基线的根目录，以 Node.js `24.21.0` 和临时应用目录运行。

```sh
node --test --test-reporter=spec \
  packages/forge-iam/test/session-read.test.mjs \
  packages/forge-iam/test/consumption-witness.test.mjs \
  packages/forge-policy/test/egress.test.mjs \
  packages/forge-policy/test/scope-ticket.test.mjs \
  packages/forge-policy/test/delegation.test.mjs \
  packages/forge-policy/test/iam-consumer.test.mjs
```

原始汇总为 `148 tests / 148 pass / 0 fail / 0 skipped`。发行 CLI 使用临时目录安装 `@deepseek-ai/dsh@0.2.1-rc.3`。在仓库根目录将 `DSH_BIN` 指定为该目录的 `node_modules/.bin/dsh`，清除继承环境并限制网络后执行 `node scripts/probe/run-host-probe.mjs`。原始汇总为 `21/21 checks passed, 1 blocked`。对照用的本机 `0.2.2-rc.5` 执行同一脚本，组合对照完成，运行探针在 `subagents.list is not a function` 处中止（1.02 秒）。
