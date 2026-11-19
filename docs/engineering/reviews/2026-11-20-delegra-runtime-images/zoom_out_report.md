# EGM 第 5 阶段 · 初步全局评审

代拟 · 2026-11-20 · 评审目标为 [CORP-DSH-DESIGN-022 V1.0.0](https://github.com/hrygo/heluo-forge/blob/5d6fef75c8ce5d58ac0f5fc0080001f59cb0fb1c/docs/design/delegra-runtime-images.md) 第 1–403 行。架构评审者与备选方案评审者独立读完整目标和关联材料。

## 架构评审

| ID | 严重性 | 发现与证据 | 修订与判据 |
| --- | --- | --- | --- |
| Z5-01 | Blocker | §8.1、§9.2.2、§9.3.1（L202、211–213、318–321、346）允许原生 Codex 包验收后从公共层去掉 Node。固定 `r2` 的远端启动与子进程身份登记需要 `node -e`。直跑 `app-server` 和 Java 样例可以通过，实际远端启动仍会失败。见 `native-session-executor.ts` L12030–12033、12438–12462、12820–12825、14257–14275。 | 把 Node 列为该 Runner 启动路径的公共依赖，按场景确定 npm 的层归属。验收使用真实冷启动，核对进程身份、取消及回收。 |
| Z5-02 | Major | §6.3、§8.1–8.2（L112–120、188–190、224–227）先编制 Native 配方，再在任务 2 核定目标提供方。`r2` Daytona 有 `image` 和 `snapshot` 入口，实际 ARM64 支持待取证。Kubernetes 领用传入 `imageOverride: null`，Job 指定 `paperclip-agent-shim`。Native 遇到预装 Runner 与控制端制品摘要不符，可转入替代制品路径。 | 明确目标提供方、模式和正常入口，区分参考配方和部署制品。用同一调度入口启动两个摘要，核对实际镜像或快照、Runner 和 Codex 版本及制品来源。已有配置能力不足时记录最小缺口。 |
| Z5-03 | Major | §3–5、§6.4、§8.3（L46–47、53、67、128、231、245–246）将真实网关接入列为首批验收。需求基线限定个人研发通过 DSH，网关草案有受管客户端与来源要求，个人 IAM 令牌受众及 `/responses` 支持仍待目标网关核实。本机探针记录的是合成服务。 | 真实凭据交接前建立范围、员工入口和网关准入证据表。验收目标客户端及来源，以及错属主、未准入客户端或来源的拒绝。合成镜像和 Runner 验证独立进行。 |
| Z5-04 | Major | §6.4–6.5、§8.3（L124–127、138–143、233、237–245）规定启动前领取和回收原则。Forge 已有 `withDispatchAccessToken()` 回调消费和模型会话绑定，现有两个公开读取入口各自独立。`r2` Native 支持特定条件下的热进程恢复，换权、运行过期及取消对旧进程的影响缺少判据。 | 复用 Host 已有绑定和临发送检查，要求消费授权与有效期同源。以冷启动验证任务凭据边界，跨授权复用须有隔离判据。验收同人同任务再次授权、旧运行存活以及运行中到期或取消。 |
| Z5-05 | Major | §4、§7.2–7.4、§8.4（L55、155–184、188、248–257）同时要求通用的双主体权限交集，并将 Agent 令牌取证和个人直连并列在网关实施段。当前应用凭据归属服务，AIGS 双主体为后续预研。 | 首版明确 Delegra 的专家配置和当次授权检查，以及网关对当前用户模型权限及预算的判定。将 Agent 独立认证、双主体授权与调用者计量的取证列为候选路线选型条件。 |
| Z5-06 | Major | §6.2、§8.5、§9.1（L96–104、188、259–276、284–297、403）保留按需求增补的候选，任务 5 的 18 目标构建验收又可被理解为一次性发布承诺。概念简报要求首批两份，后续镜像按场景开放。 | 区分配方目录、已构建制品与已启用专家。明确项目触发条件、代表性用例和实际启用范围，公共层更新按已发布和已锁定的目标计算影响。 |
| Z5-07 | Nit | §8.3（L241、244）的 `cargo test … codex_provider` 可能只按测试名过滤，遗漏固定标签 `tests/codex_provider.rs` 的非同名集成用例。`codex_local` 对 Provider 配置的临时写入与环境约定也需核对。 | 用 `cargo test --locked -p paperclip-runner-core --test codex_provider` 选定该集成套件并核对实际运行断言。复用相关夹具与非秘密配置逻辑。 |

## 备选方案评审

| ID | 严重性 | 发现与证据 | 取舍和验收 |
| --- | --- | --- | --- |
| I5-01 | Major | §6.4–6.5、§8.3（L124–141、233–246）在长寿命 `app-server` 启动时交付双凭据。派发和引用复验约束初次取用，取消失联、回收失败、到期后的新模型请求缺少可信执行点。 | 优先核验任务租约与出站限制能否满足授权失效时限。若需中转，量化额外网络跳、流式透传、故障态和可用性成本。合成验收覆盖取消信号未达、超时和回收失败后的请求阻断。 |
| I5-02 | Major | §4、§6.4、§7.2（L53–55、128、155–173）把双主体当前权限写成通用要求，个人双凭据只证明当前用户。专家配置可以约束 Delegra 内动作，Agent 的独立当前权限需要证据。 | 按阶段列判定点和输入。首版在受控模型入口校验专家及任务许可，网关判定用户模型权限和计费。若要提前启用双主体，增加签发、运行绑定、服务端授权和结算验收。 |
| I5-03 | Nit | §9.2.1、§9.3.2–9.3.3（L312、364、375–376）让 API 和 Web 测试继承开发型 `codex-node` 的 pnpm 和 TypeScript，相关测试判据只需 Node/npm 和各自的测试工具。 | 保留共用的内部 Node 构建阶段，开发与测试各加自己的工具。多一个内部构建依赖节点和兼容复验，按压缩层增量与重建成本衡量收益。 |

## 证据边界

Delegra 源码核对基线为 `deploy/v2026.1106.0-r2`，提交 `25c86a283a9c787a01911c714618d78df7552af7`。关键定位包括 `packages/plugins/sandbox-providers/kubernetes/src/{plugin.ts,pod-spec-builder.ts,image-allowlist.ts}`、`packages/plugins/sandbox-providers/daytona/src/plugin.ts`、`server/src/services/native-runtime/native-session-executor.ts` 与 `packages/paperclip-runner/runner/crates/runner-core/tests/codex_provider.rs`。图谱用于定位，版本判定以固定标签源码为准。网关、运行中撤权与原生 ARM64 启动均为待实机核验项。

关联材料包含 [需求基线](../../../requirements/requirements-baseline.md)、[专家 PRD](../../../requirements/delegra-experts-prd.md)、[接入方案](../../../plans/2026-11-18-forge-experts-integration-proposal.md)、[网关契约](../../../contracts/gateway-contract.md)、[凭据接入](../../../../packages/forge-iam/docs/credential-access.md)、[AIGS 预研](../../../plans/dsh-plugin-tools/iam-to-aigs-evolution.md)、[概念简报](../2026-11-20-delegra-runtime-images-concepts-brief.md)与[本机探针](../../spikes/2026-11-20-delegra-runtime-images/README.md)。
