# EGM 第 9 阶段 · 实施就绪度评审

代拟 · 2026-11-20 · [CORP-DSH-DESIGN-022 V1.0.0](../../../design/delegra-runtime-images.md) 第 186–403 行。三位评审者独立核对计划可执行性、当前源码及规格文字。参考目标为 Delegra `deploy/v2026.1106.0-r2`，提交 `25c86a283a9c787a01911c714618d78df7552af7`。

任务 1 可准备两份本地参考配方和冒烟测试。任务 2 处于目标 Runner 资格核验阶段。任务 3 须先核定真实接入契约和凭据边界。任务 4 可核验候选能力，任务 5 按实际项目补齐锁定输入后分批实施。

## 计划可执行性

| ID | 严重性 | 计划缺口与影响 | 修订与验收 |
| --- | --- | --- | --- |
| R9-01 | Blocker | 任务 3，L229–246。接入方案的可信提交、受限员工接口和范围裁决尚有前置工作。网关受管客户端、`/responses`、运行凭据私有交接均待实际契约。当前文件清单只覆盖链路的部分接缝。 | 先交付范围与协议证据，冻结用户、专家、请求、任务和运行代次的绑定及领取、撤销、异常、回收和回退语义。再列路由、派发、传输到 Runner 的逐文件改动。从正常入口覆盖排队过期、并发领取、启动后撤权、旧代次迟到及停用后的获权回查。 |
| R9-02 | Blocker | 任务 2，L217–227。两份文件只能记录结果，尚缺可选提供方、模式与执行环境配置。固定 `r2` 有 AMD64 fleet 及 Kubernetes override 限制，远端 Native 还可能选用外置 Runner 或 Codex。 | 拆为提供方资格核验与所选路径接入。列实际配置字段、ARM64 节点及试验制品源、合成 `/responses` 夹具与测试入口。核对原装可执行文件来源和摘要，禁止以回退制品取得通过。缺能力时记录 `BLOCKED` 及最小补齐范围。 |
| R9-03 | Major | 任务 1，L194–213、312–346。APT 签名快照、公共包集、精简候选 Bake 目标和独立标签、同压缩口径的 OCI 导出未具体化。`--load` 用于功能冒烟，体积判据依赖可读取的 OCI 清单。 | 固定本地参考路径和候选输出。标明构建节点判据、共同包集、导出命令、压缩方案、负例注入点、退出结果及清理结果。通过任务 2 后确定发布配方。 |
| R9-04 | Major | 任务 4，L248–257。文档写入范围适合能力核验。扣费、撤销与重放回执的验收依赖签发、实际运行绑定、双主体决策与用户账本接口。 | 有目标环境接口及允许的测试运行时再演练。接口缺失时记录 `BLOCKED`。若选用候选，形成契约、逐文件接线、实际账户映射、回执去重、撤权时限和切回的实施计划。 |
| R9-05 | Major | 任务 5，L259–276、363–395。部分语言工具链已有固定制品。uv、Node 工具、Newman、Playwright 与浏览器、kubectl、Helm、k6 和 OpenTofu 的输入仍有缺项，部分用例缺入口和预期输出。办公的 `USER node:node` 依赖用户名，Debian 候选只约定 `1000:1000`。 | 为拟启用目标列版本、ARM64 来源、校验值、直接依赖、分阶段 UID/GID、样例入口及通过结果。验证两种公共底座的用户和写入路径，再按目标分批构建、验收及回退。 |

## 固定版本源码对照

### B9-01 · Blocker · 远程冷启动的 Node 依赖

L320、346、364 允许原生 Codex 候选的公共层省去 Node。`server/src/services/native-runtime/native-session-executor.ts` L12018–12036、12438–12457、14257–14279 的启动和进程身份处理需要 Node。容器直跑 Codex stdio 可以通过，真实路径会在 daemon 启动前失败。`r2` 参考镜像应保留可从 Runner 执行环境 `PATH` 解析的 Node。任务 2 以实际启动确认进程身份，继续验证取消与回收。更换 launcher 属独立方案。

### B9-02 · Major · 镜像身份与实际制品身份需要同时验收

L197、202、211、224–227 要求锁定镜像和版本。`server/src/services/native-runtime/native-codex-runner.ts` L211–237 在控制端先解析目标架构的 Runner。`native-session-executor.ts` L15040–15062、15097–15321 校验预装件并可能使用控制端制品或显式 Codex 路径、npm 安装。`codex-runtime-compatibility.ts` L8–11、31–42 校验兼容区间。选用镜像预装模式时，核对控制端与镜像同一 ARM64 Runner 制品的 SHA-256、实际执行文件和 Codex `0.160.0` 的来源，确认无替代安装。用镜像内 Runner 哈希不符、Codex 缺失和兼容区间内的非固定版本做拒绝验收。

### B9-03 · Blocker · 普通远程执行通道缺少双凭据私有交接边界

L231–245 点名 Host、Native executor 与 Rust Provider。`packages/paperclip-runner/src/live/runnerd-codex-transport.ts` L3444–3458 以及 `packages/paperclip-runner/runner/crates/runner-core/src/codex_provider.rs` L966–983、1096–1126 未提供拟用的 IAM 访问令牌私有交接。正常远程执行将环境送给提供方。`packages/plugins/sandbox-providers/daytona/src/plugin.ts` L928–968、1849–1867 会将环境值编入提交给 SDK 的命令文本。`packages/paperclip-runner/src/drivers/codex/codex-security-config.ts` L265–279、333–360 将选定任务环境投影到工具继承规则，外部沙箱模式依赖提供方实施隔离。

任务 3 先验证选定部署的私有投递与权限执行点，明确从运行引用到控制端 transport 和 Runner 消费的路径，个人凭据仅经该路径使用。用合成凭据验证网关请求，核对提供方命令参数、普通工具环境、诊断与恢复产物不持有秘密，并覆盖运行中撤权。

### B9-04 · Major · 令牌和有效期须从同一记录消费

L233、237–238 需要受控回调消费双凭据及有效期。Forge `service-gateway.mjs` L265–309 返回 `{ key, baseURL, generation, subject }`，`service-token.mjs` L1046–1048、1162–1177、1266–1269 当前读取及发送回调提供令牌字符串，`session-read.mjs` L25–36 的到期时间来自独立会话投影。分别读取可能在刷新交错时配错令牌及其到期时间。将 Host 消费契约和 `service-token.mjs` 纳入明确改动范围，从同一持久授权记录取令牌及有效期，复用 `managed-models.mjs` L625–635 的地址与 Key 代次复验。测试刷新、换 Key 和切换用户三类交错，核对回调所见的同源值或零发送。

## 规格文字

| ID | 原报级别 | 复核位置与处理 |
| --- | --- | --- |
| S9-01 | Major | L231 已使用“受限员工入口”。将 L190 的“受限员工接入”改为指向 Delegra 受限入口的接入及身份契约。 |
| S9-02 | Major | L248 改为“核验 Agent 令牌与调用者计费”，标题准确覆盖能力核验。 |
| S9-03 | Major | L226 改为“按摘要拉取镜像失败”，明确失败对象。 |
| S9-04 | Nit | L227 明确回退后续任务默认的环境引用，同时核对已受理任务的原始版本和回执。 |
| S9-05 | Nit | L278 改为“计划和契约交付前执行 `pnpm check` 与 `git diff --check`”。 |

证据包括 [需求基线](../../../requirements/requirements-baseline.md)、[接入方案](../../../plans/2026-11-18-forge-experts-integration-proposal.md)、[网关契约](../../../contracts/gateway-contract.md)、[凭据指南](../../../../packages/forge-iam/docs/credential-access.md)和[本机探针](../../spikes/2026-11-20-delegra-runtime-images/README.md)。图谱用于结构定位，源码以固定标签与 Forge 当前文件为准。已核对引用路径的覆盖信号，Daytona Dockerfile 和 Native 测试标出的不完整范围回读标签源码。部署配方、真实启动、运行凭据及企业账本均待实测。
