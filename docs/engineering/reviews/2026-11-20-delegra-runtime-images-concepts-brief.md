# Delegra 专家智能体运行时镜像概念简报

> 2026-11-20 · 作者 hrygo · Agent 代拟 · Goldfish 审查与本机镜像探针已完成

## 工作假设

**首期专家智能体 = 镜像 + skills + 工具集合 + 用户令牌。** Delegra 负责组装和调度。镜像提供 Codex Harness 和场景工具链。Delegra 为专家配置镜像、skills 和工具集合，运行时绑定发起用户的授权。接入 AIGS 后，每次调用同时具备用户身份和 Agent 身份，按两者权限的交集执行。

构建目标是让专家启动时就具备相应工具链，并能按镜像版本复验同一个任务。首轮以固定版本的最小 Codex 镜像和一个 Java 派生镜像验证共用基础层。镜像制品继续通过 Delegra 现有的执行环境配置选用。

同一份镜像可支撑多个专家。同一专家可服务多个用户。工具集合决定专家可调用哪些工具和动作，目标服务依据此次调用的有效身份判定访问权限。专家配置引用镜像摘要、skills 版本和工具集合版本，令牌按运行提供。工作区、Codex 会话和凭据缓存按实际任务归属隔离。

| 组成 | 职责 | 例子 |
| --- | --- | --- |
| 镜像 | 提供可启动的 Codex 和运行环境 | `codex-java-21` 提供 JDK 21 与 Maven |
| skills | 定义专家的任务方法和交付约定 | Java 构建失败诊断、中文文档排版 |
| 工具集合 | 声明本专家可调用的工具及动作 | 读取获权仓库、查询流水线 |
| 用户令牌 | 代表本次调用的发起用户 | 专家直接向目标服务出示该服务接受的用户令牌 |

## 用户令牌与企业工具

用户令牌让专家在 Delegra 的调度下代表发起用户访问 AI 网关、邮箱、OA、DevOps、Gitee 等企业服务。镜像中的 `git`、`javac` 等程序提供本地能力，目标服务核验远端资源的实际访问权限。

| 阶段 | 调用身份 | 权限判定 |
| --- | --- | --- |
| 首期 | 用户令牌 | 专家直接使用发起用户的令牌代表用户调用目标服务，目标服务按该用户的实际权限和令牌范围执行 |
| 接入 AIGS 后 | 用户身份与独立 Agent 身份，持有用户令牌及 Agent 令牌 | 对同一资源和动作，**有效权限 = 用户权限 ∩ Agent 权限**。两种身份都获授权时才放行 |

令牌在运行时使用。镜像、构建缓存和任务日志均排除令牌。各目标服务接受的令牌、签发、受众、续期、到期与撤销以实际契约为准。AIGS 阶段的双身份传递形式与权限决策接口待联调。2026-10-27 的 AIGS 预研将双标识委派列为候选能力。 [IAM 向 AIGS 演进预研](../../plans/dsh-plugin-tools/iam-to-aigs-evolution.md)

工具执行入口按专家已配置的动作及目标服务传递用户原令牌。凭据的可用范围限于该入口，须实测通用 Shell、其他服务和其他任务无法使用该凭据。目标服务继续按用户的实际权限判定。令牌缺失、到期、撤销或动作未获准时，停止受影响的调用并报告授权状态。

| 目标服务 | 候选验收动作 | 必须核对的服务端结果 |
| --- | --- | --- |
| AI 网关 | Codex 发起一次测试推理 | 网关按获准的专家接入路径校验调用并记录正确归属，实际模型与额度符合授权 |
| 邮箱 | 在用户获准邮箱中检索测试邮件 | 邮箱按实际用户限制邮件夹与消息范围 |
| OA | 读取一项测试待办 | OA 返回该用户可见的流程或记录 |
| DevOps | 查询一条获权需求或流水线 | DevOps 按用户限制项目与动作 |
| Gitee | 读取获权仓库的指定修订 | Gitee 按用户限制仓库与动作，读取结果可追溯至实际修订 |

表内动作是企业试点的验收建议。其他服务沿用各自的用户凭据与权限契约。发信、审批、推送等写动作按所属系统实际授权另行定义验收。现行模型访问基线将个人研发入口限定于 DSH，网关个人访问采用双因子凭据。企业试点依赖 Delegra 获准的网关入口，并须核对所需凭据、网络来源、用户及团队计量归属和撤权。 [模型访问身份与专用凭证要求](../../requirements/requirements-baseline.md#46-模型访问身份与专用凭证要求) · [AI 网关契约](../../contracts/gateway-contract.md)

### 首版 DSH 网关授权

用户在 DSH 发起任务时，授权所选专家的 Harness 使用该用户的网关连接。DSH Host 取得网关 `baseURL`、个人网关 Key 和当前 IAM access token，将这次授权绑定到用户、专家、任务和有效期。IAM Host 的 `resolveGatewayConnection()` 提供同属主的地址和个人 Key，`getAccessToken()` 提供当前访问令牌。授权交接前须验证两项凭据对应同一会话和当前有效授权。IAM 的刷新令牌由 DSH Host 管理。 [IAM 凭据接入指南](../../../packages/forge-iam/docs/credential-access.md#33-dsh-host-插件宿主服务)

Delegra 按已获授权的任务调度专家，将网关地址与该用户的两项凭据交给本次运行的 Harness。Codex 配置以 `base_url` 指定地址，通过 `env_key` 和 `env_http_headers` 取用运行时凭据，分别生成 `Authorization: Bearer …` 和 `X-IAM-Token`。固定部署标签 `deploy/v2026.1106.0-r2` 的 `codex_local` 适配器源码包含 `PAPERCLIP_CODEX_PROVIDERS` 配置入口。实际交接和目标 Runner 的注入隔离须联调。 [Codex Provider 配置](https://developers.openai.com/codex/config-reference)

现有 DSH 模型路径使用 `${baseURL}/chat/completions`，本机 Codex 探针实际调用 `${baseURL}/responses`。网关目标契约列出 `/responses`，Delegra 的实际网络来源、受管客户端准入、模型权限、用户计量和到期撤权取决于目标网关验收。 [网关服务端点契约](../../contracts/gateway-contract.md#44-服务端点契约与流式协议) · [本机镜像与模拟网关探针](../spikes/2026-11-20-delegra-runtime-images/README.md)

## 候选镜像矩阵

| 候选镜像 | 在公共 Codex 层上增加 | 验收样例 |
| --- | --- | --- |
| `codex-min` | 公共层含固定版本 Codex、Runner 所需依赖、`sh`、`tar`、Git、`rg` 和 CA 证书 | 非 root 启动 Codex，验证版本、可写工作区与退出状态 |
| `codex-java-8`、`codex-java-11`、`codex-java-17`、`codex-java-21`、`codex-java-25` | 每个镜像一个 Temurin JDK 主版本和与之兼容的构建工具，支持项目自带 Wrapper | 检查 `java`、`javac` 主版本并编译运行对应样例 |
| 开发 · Python、Node、Go、SQL、.NET 镜像 | Python/uv、Node/pnpm、Go、数据库客户端和 .NET 10 SDK 分别构建 | 按场景执行合成数据处理、语言构建或 SQL 查询 |
| 测试 · API、Web、容量镜像 | Newman、Playwright/Chromium、k6 | 用回环或获准测试服务验收接口、浏览器和容量样例 |
| 运维 · 诊断、Kubernetes、IaC 镜像 | 网络与证书工具、kubectl/Helm、OpenTofu | 核对诊断输出、离线渲染集群清单和验证基础设施配置 |
| `codex-office-zh` | UTF-8 中文环境、可再分发的 CJK 字体、LibreOffice headless、Pandoc 和 PDF 检查工具 | 生成或处理中文 `.docx`、`.xlsx`、`.pptx`，将样张导出为 PDF 并核对文字、字体和分页 |

Java 候选矩阵采用仍受支持的五条 LTS 线，每个主版本独立构建与验收。受监管机构案例、目录优先级与每份 Dockerfile 的构建内容见[镜像与 Dockerfile 构建规格](../../design/delegra-runtime-images.md#9-镜像与-dockerfile-构建规格)。 [Adoptium Temurin 支持路线图](https://adoptium.net/support)

## 接入取舍

1. **复用目标 Delegra 版本的 Runner 构建输入。** `deploy/v2026.1106.0-r2` 的 `docker/daytona-runner/Dockerfile` 定义了按 `Cargo.lock` 构建 `paperclip-runnerd` 的输入，`runner-binary.ts` 可识别 Linux ARM64 可执行文件。该标签的 Daytona fleet 配方固定为 `linux/amd64`。ARM64 首批镜像采用已核对 ARM64 清单的基础镜像及工具链，按 Runner 源码配装 Codex 和 `paperclip-runnerd`。部署验收固定 Delegra 版本、Runner 模式和能提供原生 ARM64 沙箱的提供方。Native Runner 使用 Linux glibc 2.39 或更新版本。 [Paperclip Runner 官方文档](https://docs.paperclip.ing/reference/adapters/paperclip-runner/)
2. **固定构建输入和部署版本。** `r2` 的示例依赖浮动基础镜像标签和 `@openai/codex@latest`，可作为装配参考。实际交付固定基础镜像摘要、Codex 精确版本与包完整性、场景工具版本，并记录成品 digest。镜像交付侧集中维护构建矩阵和公共层版本，沿用现有构建入口。全工具单镜像增加拉取体积并耦合各工具的更新。任务启动时安装工具则增加网络和版本解析依赖。 [Docker 镜像构建指南](https://docs.docker.com/build/building/best-practices/)
3. **统一使用原生 ARM64。** 构建、启动验收和交付均采用 `linux/arm64`。首批镜像包含 ARM64 Codex 和 Native Runner，Java 变体包含 ARM64 JDK。先测两份镜像的构建时间、成品体积与冷启动耗时，再按项目需要安排其余目标。公共层升级重新验收受影响的目标。 [Docker 多平台构建指南](https://docs.docker.com/build/building/multi-platform/)
4. 共享层集中装配 Codex、Runner 和常用任务工具。各场景继承同一启动与工作区约定，构建阶段的工具和缓存与运行文件分层。以中文文件、Git、Shell 和 Codex 会话验收保全能力，在通过同一套功能验证的候选中按实际拉取体积择优。 [镜像构建原则](../../design/delegra-runtime-images.md#92-镜像构建原则)

## 分阶段验收

### 本机镜像探针

首轮使用本机 Docker 的 `linux/arm64`，以 `codex-min` 和 `codex-java-21` 验证 Codex 启动、非 root 工作区和 Java 样例编译。两镜像已加载至本机 Docker。模拟网关验证了 Codex 按所配地址发送用户双凭据，并在缺失 IAM 令牌时收到 `401`。 [配方与实测记录](../spikes/2026-11-20-delegra-runtime-images/README.md)

### Delegra Runner

1. 用 `codex-min` 和 `codex-java-21` 验证共用层和独立 JDK。确认目标 Runner 可拉取配置的 `linux/arm64` 镜像，在原生 ARM64 节点实际启动 Codex，运行合成样例并回收工作区产物。Runner 或提供方记录实际运行的 digest、架构、执行模式及回收结果。使用快照时核验可追溯到同一 ARM64 镜像的快照身份。镜像版本与工作区产物用于验证工具功能。
2. 模拟镜像不可拉取和运行中取消，核对启动失败、取消及回收状态。目标镜像未启动时任务失败，回收结果未确认时保留待核对状态。按接入方案关联请求、任务和运行代次，复用目标版本的运行事件定位失败阶段和可采取的操作。未决结果依原回执对账。 [专家接入方案 §5](../../plans/2026-11-18-forge-experts-integration-proposal.md#5-回执结果与恢复)
3. 发布记录关联镜像名及 digest、工具链、适用 Runner、架构与实测结果。建议受理时固定镜像、skills 和工具集合版本，升级与回滚影响随后受理的任务。用排队和运行中的任务验证版本归属和旧运行结果隔离，远端服务调用仍检查当前授权。

### 企业试点

1. 研发专家经 AI 网关推理，查询 DevOps 测试需求和 Gitee 测试仓库，在 Java 镜像中执行样例构建。办公专家经同一网关推理，读取测试邮件和 OA 待办，在中文办公镜像中生成可核对的文档。确认网关及目标服务的测试准入后验收两个场景。
2. 以两个合成用户运行同一专家，核对各目标服务识别的发起人、获准资源及会话和工作区隔离。测试未配置动作、越界资源、跨服务凭据以及过期或撤销的令牌。受权诊断区分运行环境故障、Delegra 工具拒绝和目标服务拒绝，并关联相应运行及服务端可核对的记录。

### AIGS 接入

同一资源和动作验证三种权限组合。用户和 Agent 均有权时放行，仅用户有权或仅 Agent 有权时均拒绝。任一身份失效或权限决策无法确认时，停止受影响的调用，按当前权限保留状态、结果查询、取消与对账。审计关联发起用户、Agent、资源及动作。切换演练须证明取不到 Agent 授权时也维持双身份要求。

## Goldfish 审查处置

七个独立视角均读取同一份工作稿。输入 SHA-256 为 `630af7c34372f226412efd33e8918f70007c7b94b895a8953edb217c28d0d689`。

| 评审关注 | 处置与待验项 |
| --- | --- |
| 架构与成本 | AI 网关准入是企业试点前置。镜像与 Runner 先独立核验，测得构建、存储和启动成本后扩展矩阵。以实际任务的请求和 token 用量评估试点并发 |
| 源码与可观测性 | 区分 Bake 展开与运行证据，绑定实际镜像、执行模式与运行结果，复用已有请求和运行标识定位失败 |
| 复杂度与复用 | 优先复用所选 Runner 对应的 Codex 构建。以两镜像验证派生，保留其他工具链为后续构建目标 |
| 易用性 | 发布记录可核对 Runner、架构和工具链。失败信息显示故障环节、授权状态及恢复操作 |
| 迁移与回滚 | 固定任务版本并演练回退。AIGS 切换后凭据或授权不可用时停止受影响的调用，维持双身份判定 |
| 维护 | 由镜像交付侧集中维护公共层和构建矩阵。交付仓库、版本维护责任及实际 Runner 组合在详细设计中确定 |
| 技术取舍 | 保留共享基础层、独立变体及固定 digest 的路线 |

## 当前依据与待定事项

- **已明确。** 项目负责人于 2026-11-20 确认专家由 Delegra 组装和调度，镜像默认包含 Codex。专家首期直接代表发起用户访问 AI 网关、邮箱、OA、DevOps、Gitee 等服务，AIGS 阶段以用户与 Agent 双身份的权限交集执行。本条确认覆盖本议题的专家组成和身份分期。 [Forge 专家智能体 PRD](../../requirements/delegra-experts-prd.md#1-产品结论与文档效力)
- **已核验。** 2026-11-20 本机 Docker Engine 为 `29.9.3`，架构为 `linux/aarch64`。在 Delegra `a5f8f5a386` 工作区运行 `docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --print codex`，展开了 `base → codex` 的 `linux/amd64` 构建定义。相关接入依据也已核对固定部署标签。该证据覆盖源码和本机构建配置。 [Forge 专家智能体接入方案](../../plans/2026-11-18-forge-experts-integration-proposal.md#2-源码证据与路线取舍)
- **已明确。** 项目负责人于 2026-11-20 确认先在本机 Docker 验证镜像。首版由用户授权 Delegra 为本次专家任务使用 DSH IAM 获取的网关地址与用户凭据。
- **已明确。** 项目负责人于 2026-11-20 确认专家镜像统一使用 `linux/arm64`。
- **待确定。** 部署验收使用的 Delegra 版本、Runner 模式、提供原生 ARM64 沙箱的提供方与镜像制品源。
- **待实测。** Delegra Runner 拉取并启动已配置镜像、任务和产物回收、DSH 到 Delegra 的授权交接，以及各服务认可的凭据、动作范围与撤权行为。 [云端连接与员工授权取证](https://github.com/hrygo/heluo-forge/issues/244)
