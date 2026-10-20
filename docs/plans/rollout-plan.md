# 企业 DSH 研发平台推广实施方案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-001 |
| 文档名称 | 企业 DSH 研发平台推广实施方案 |
| 版本 | V1.2.1 |
| 文档状态 | 评审稿 |
| 密级 | 内部 |
| 编制 | DSH 平台组（代拟，责任人待确认） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-20 |
| 门禁 | G0 |
| 文档层级 | L2 实施计划；字段级契约由子文档承担（见架构设计 §12） |

## 修订记录

| 版本 | 日期 | 修订人 | 修订说明 |
|---|---|---|---|
| V0.1 | 2026-10-20 | DSH 平台组 | 初稿 |
| V0.2 | 2026-10-20 | DSH 平台组 | 补充双维度额度、标准符合性与子文档分工 |
| V1.0 | 2026-10-20 | DSH 平台组 | 文档命名与内容正式化 |
| V1.1 | 2026-10-20 | DSH 平台组 | 同步需求基线（3 部门 800 人、50% 麒麟、7 类角色、自助安装）；统一 DevOps MCP 协议、P1/P2 补丁排期、SDD 策略插件口径与 A1–A14 完整验收表 |
| V1.2 | 2026-10-20 | DSH 平台组（代拟） | 补充项目级关键路径、15 周条件基准、门禁证据与拟签署角色、分批试点计时建议和运行退出；强化 A1–A14 安全负向验收及跨团队确认引用，区分历史依据与本次文档核对 |
| V1.2.1 | 2026-10-20 | DSH 平台组（代拟） | 仅迁移至 docs/plans/ 并重建相对链接；验收、门禁与条件排期不变 |

> 编制依据：原文历史依据为 DSH `0.2.1-rc.2` 源码、npm registry 与 GitHub 发布资产（原记载核验日期 2026-10-20），§3 保留该历史依据，不表示本次重新核验源码或发布状态。本次 V1.2 仅于 2026-10-20 对照项目协作规范、需求基线、总体架构、AI 网关契约及文档清单进行文档核对；未新增源码、网络接口或实机测试证据。企业 IAM / 网关 / DevOps / Gitee 接口、Windows 与银河麒麟实机、性能与恢复演练均未验，接口、保留期、编制责任人与签署人仍待团队确认。
>
> 关联文档：[企业 DSH 研发平台总体架构设计](../architecture/platform-architecture.md)、[企业 DSH 研发平台需求与场景基线](../requirements/requirements-baseline.md)、[AI 网关契约](../contracts/gateway-contract.md)、[文档清单](../DOCUMENT-REGISTER.md)。

## 1. 背景与目标

结论：方案在文档设计层面具备可实施路径，且大部分工作不需要从零开始；企业接口与双端实测通过门禁前，不代表已经可上线。企业侧已具备标准 OAuth IAM、自研 Kong AI 网关（对接机构内私有化模型）和带 API/CLI 的自研 DevOps 平台，拟用 DSH 的凭据 seam、LLM 路由和插件机制承接；真正的约束来自三处——**DSH 是单用户产品**、**官方桌面端不构建 Linux**、**银河麒麟 aarch64（占试点终端 50%，约 400 台）的沙箱与原生模块需要实机先验**。

因此一期面向 3 个部门共 800 人，按“每人一套 DSH”落地，不做多租户：Windows（约 400 人）用桌面 App，银河麒麟（约 400 台）用 `dsh --profile web` + 浏览器（仅本机自用），macOS 不纳入一期。IAM 插件仅承担两项职责：**取得模型与工具授权**与**提供可审计的用户身份**，不承担“打开 DSH 的准入”。

### 1.1 已确认的决策输入

| # | 决策 | 影响 |
|---|---|---|
| 1 | 企业自研 IAM，遵循 OAuth 标准，支持跳转登录与回调 | 走 Authorization Code + PKCE；需确认 OIDC 还是纯 OAuth2 |
| 2 | 基于 Kong 的自研 AI 网关 + 机构内私有化模型，具备详细额度管理 | 走 token 直通，不向客户端发 API Key；数据不出机构边界（C1）；计量与限额在网关侧，支持按人 / consumer 双维度 |
| 3 | 每人使用自己的 DSH；共享 Web 后续再议 | 多租户整块移出一期，省略 connection/session 的核心改造 |
| 4 | 自研 DevOps 平台，提供 API 与 CLI | 包一层精简 MCP（8–12 工具）+ Skill，不等待厂商 MCP |
| 5 | 试点 3 部门 800 人，Windows 与银河麒麟（ARM）各占 50%，用户有本机管理员权限可自助安装 | Windows 走官方 App + MSI 自助安装（MDM 可选）；麒麟走本机 Web，麒麟实机验证前置为 P0 准入项 |
| 6 | 本机 Web 不供他人使用 | 严格绑定 `127.0.0.1`，保留 launch token 门禁并由 `.desktop` 启动脚本自动读取拉起，不做入口 SSO |

### 1.2 不在本期范围

一期不做事项以 [需求与场景基线](../requirements/requirements-baseline.md) §2.2（`N1–N8`）为唯一真源，涵盖：多人共享单实例（多租户）、macOS 客户端、白标发行、自建模型推理服务、公网访问或跨网段暴露本机 Web、替换 DevOps/Gitee 平台、修改 DSH 核心（除唯一 MCP 凭据补丁外）、客户端二次计量。默认采用官方 App，不白标；§9 的询问不能直接翻转非目标，确需白标须先走范围变更并单独立项。

## 2. 目标架构

```text
员工终端（每人一套 DSH，3 部门 800 人）
├─ Windows（50%）：DSH Desktop（MSI 自助安装 / MDM 可选）
└─ 银河麒麟 aarch64（50%）：dsh --profile web（绑定 127.0.0.1）+ dsh-web-open + 浏览器

  ├─ IAM 插件（fork dsh-oidc，改造后）
  │    系统浏览器 → 企业 IAM：Code + PKCE
  │    回调 127.0.0.1:<port>/oauth/callback
  │    登录/刷新后写入 CredentialRef: ENTERPRISE_ACCESS_TOKEN
  │    充当 MCP token broker：按 resource 申请并缓存 token
  │
  ├─ 策略插件（@corp/dsh-policy，tools/pre-execute + tools.guard）
  │    ├─ $DSH_HOME/** 硬拒绝（防 Agent 读取 .credentials.yaml）
  │    ├─ 生产写操作与客户数据外发（C3）转本机 ask 二次确认
  │    ├─ SDD 阶段路径保护规则
  │    └─ 决策审计上报 OTel Collector
  │
  ├─ LLM 路由（llm-pi-ai，apiKeyEnv=ENTERPRISE_ACCESS_TOKEN）
  │    Bearer <IAM access token> → Kong AI Gateway → 机构内私有化模型
  │      ├─ JWKS / Introspection 验签
  │      ├─ consumer 映射 + 人 / consumer 双维度限额
  │      └─ 默认关闭请求正文日志（C4）
  │
  ├─ DevOps MCP（目标 streamable-http，P1 可先用本地 stdio，8–12 工具）→ 企业 DevOps API
  └─ Gitee MCP（本地 stdio，arm64 自编译）→ Gitee API
```

### 2.1 令牌与身份传递

IAM 插件在 fork 中增加两项能力：登录与刷新成功后，把模型网关的 access token 写入 `ENTERPRISE_ACCESS_TOKEN` 这个 CredentialRef（原插件只把会话保存在凭据记录里），并作为 MCP 的 token broker 按 `resource` 取 token。DSH 的凭据 seam 按操作重新解析引用，因此：

- 模型请求由 `llm-pi-ai` 的 `apiKeyEnv` 直接取得当前 token，**不需要写新的 LLM adapter**。
- DevOps MCP（HTTP）由 `dsh-mcp-client` 的 auth provider 回调向 broker 按 `resource` 获取 token，缓存键为 `(resource, scope)`；Gitee MCP（`stdio`）在凭据更新时由客户端重新解析 `env` 并重连子进程。
- 刷新后下一次请求即生效，无需手动重启 DSH 进程（目标行为，须经 A2 / A14 验证）。

以下 YAML 沿用历史概念组合，不是可直接投产的配置：`retryPolicy.maxRetries=2` 不能证明 429 禁重试、401 后刷新或生产写操作安全重放。P1 须验证实际行为；未知配置字段不得猜写，生产写操作结果未知时按 A7 / A14 先查单或使用服务端幂等机制，不盲目重放。

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      corp:
        displayName: 企业 AI 网关
        api: openai-completions
        baseURL: https://ai-gateway.corp.example/v1
        apiKeyEnv: ENTERPRISE_ACCESS_TOKEN
        retryPolicy: { mode: normal, maxRetries: 2 }
        models:
          - id: corp-chat
            name: 企业对话模型
            contextWindow: 131072
```

### 2.2 认证与调用链路

| 链路 | 做法 | 备注 |
|---|---|---|
| IAM 登录 | Authorization Code + PKCE（S256），public client，loopback 回调 | 桌面走系统浏览器，不把 IAM 登录页嵌进 WebView |
| 模型请求 | DSH 以 IAM access token 作 Bearer 调用 Kong；Kong 验签并映射 consumer | 客户端不持有网关 API Key |
| DevOps MCP | `streamable-http`（P1 可先以本地 `stdio` 验证），按请求经 auth callback 向 IAM broker 取 token | 服务端暴露 RFC 9728 PRM 并校验 `aud`；生产写操作结合本机 `ask` 与平台异步审批单 |
| Gitee MCP | 本地 `stdio`，启动时从环境取凭据，轮换时重连子进程 | 需在 `CORP-DSH-GITEE-001` 明确复用 IAM token 还是用户级 Gitee OAuth/PAT |

Kong 侧保留历史选型建议：用自研插件或 Enterprise 的 `openid-connect` 做 JWKS 验签（Kong OSS 的 `jwt` 插件只支持按 consumer 配静态密钥，不适合多用户）；`key_claim_name` 与 `sub` 映射能否适用，须由网关团队确认，不是本次核实的企业实现。模型路由仅指向机构内私有化推理上游；401 后的刷新、错误分类与重试边界按 [AI 网关契约](../contracts/gateway-contract.md) 及 A2 / A3 / A14 联调，不以“重新解析凭据”代替刷新与恢复证据。

企业授权由 IAM、网关、DevOps / Gitee 服务端校验身份、scope、资源与审批状态兜底。用户有本机管理员权限，preset、本机配置与插件开关只是客户端治理措施，不是不可绕过的企业授权边界；`approval=never` 也不代表已经完成企业要求的人工确认。

## 3. 关键技术事实与依据

以下表格保留原文于 2026-10-20 记载的 DSH `0.2.1-rc.2` 源码、官方文档与公开仓库历史核验结论，引用路径指向上游资料，并非本项目已有代码或本次重新核验结果。企业部署适用性仍须门禁实测；“硬拒绝”“纯配置打通”等是待验证方案目标，50–80 行补丁、约 30 行适配层为规模估算，5 秒刷新/锁行为为测试目标，不是已证实能力或工期保证。

| # | 事实 | 证据 | 对方案的影响 |
|---|---|---|---|
| 1 | 浏览器连接共享单一 owner Peer，cookie 负载只有 authority，没有用户主体 | `packages/client/connection/src/rpc-host.ts`（`browserPeer`）、`browser-auth.ts`（cookie payload v1/v2） | 共享实例等于共享身份；一期按每人一套规避 |
| 2 | 凭据 seam 分 `CredentialRef` 与 `CredentialKey` 两个空间，消费者按操作重新解析 | `packages/credentials/credentials`、`docs/subsystems/credentials.md` | 令牌轮换即时生效，不需要重启 |
| 3 | `llm-pi-ai` 支持自定义 OpenAI 兼容网关，`apiKeyEnv` 按请求解析 | `packages/llm/llm-pi-ai/README.md` | 模型链路纯配置即可打通 |
| 4 | MCP client 的 `env` / `headers` 在加载时求值，没有按请求解析或 OAuth 客户端 | `packages/mcp/mcp-client/README.md` | 需约 50–80 行补丁（HTTP 回调取 token + `stdio` 凭据重连），否则 token 过期要重启进程 |
| 5 | 官方桌面端只构建 macOS 与 Windows，发布 feed 目标为 `mac-arm64`、`mac-x64`、`win-x64` | `apps/desktop/scripts/electron-builder-config.mjs`、`apps/desktop/publishing/README.md` | 银河麒麟没有官方 Electron 客户端，只能走本机 Web |
| 6 | Linux 沙箱链为 `bwrap → Landlock → fail closed`，无可用后端时拒绝执行而非降级 | `packages/sandbox/sandbox-local/README.md` | 约 400 台麒麟的首要准入验证项；加固内核可能直接不可用 |
| 7 | Web 前端构建目标为 `es2022` | `apps/web/vite.config.ts` | 浏览器版本已确认达标，不再作为风险 |
| 8 | 插件市场为 format-1 index，私有 registry 优先且不回落公网，自带 index 生成器 | `packages/boot/plugin-market/README.md`、`packages/boot/plugin-manager/README.md`、`apps/plugin-market-generator/README.md` | 企业市场只差治理与流水线 |
| 9 | 凭据文件为 0600 的 `$DSH_HOME/.credentials.yaml`，agent 以同一 OS 用户运行，可读取 | `packages/credentials/credentials-local/README.md` | 必须用 `@corp/dsh-policy` 硬拒绝访问 `$DSH_HOME/**` 并配合沙箱遮蔽挂载 + 短 TTL |
| 10 | 公开部署的 launch URL 即进程凭据，文档要求只分享给预期用户 | `docs/user/guide/public-deployments.md` | 麒麟本机 Web 强制绑定 `127.0.0.1`，由 `dsh-web-open` 脚本读取本机 launch URL 拉起 |
| 11 | npm 上 `@deepseek-ai/dsh` 共 36 个版本，全部为预发布，最近 30 天 14 个版本，最新 `0.2.1-rc.2` | npm registry 实测 | 必须锁版本、内部镜像、兼容性门禁 |
| 12 | `sharp`、`koffi`、`node-addon-system` 均有 linux-arm64 预编译；`node-pty` 无预编译，安装时回退 `node-gyp rebuild` | npm registry 元数据、`packages/subprocess/subprocess-local/package.json` | 麒麟需在 arm64 构建机预构建 profile，避免用户端编译 |
| 13 | `mcp-gitee` 最新发布资产含 `linux-amd64` / `linux-arm`，但没有 `linux-arm64` | GitHub Releases API（v1.0.0） | 麒麟上需自行交叉编译或改用 Node 实现 |

## 4. 工作分解

工期为推断，按 2–3 名 DSH 工程师计，不含企业 IAM / 网关 / DevOps 等团队的排期等待。以下是同一项目的条件基准，不是四份可独立承诺的日程；完整范围、优先级与指标以 [需求与场景基线](../requirements/requirements-baseline.md) 为真源。全周期分为四个阶段与四道门禁：
- **P0 前置验证（1 周，过 G0 门禁）**
- **P1 概念验证（4 周，过 G1 门禁）**
- **P2 试点工程与运行（工程准备 4 周过 G2 门禁 + 3 部门 800 人试点运行 6 周过 G3 门禁）**
- **P3 持续推广（G3 后持续）**

原“若网关验签需自研 Kong 插件，P1 再增加 2 周”为条件增量估算；是否触发、能否并行及对关键路径的净影响按 §4.5 重估，不能直接叠加为总日期承诺。

### 4.1 P0 前置验证（1 周，准入 G0）

| 项 | 内容 | 完成判据 |
|---|---|---|
| P0-1 | 麒麟 aarch64 兼容性（50% 终端准入项）：Node 24、glibc、bwrap / Landlock、`node-pty` 加载、浏览器 | 产出“可用 / 需装 bwrap / 需自定义 runner”候选路径与实测证据；未完成隔离验证不得记为安全通过，Windows 同步纳入 A4 回归矩阵（落入 `CORP-DSH-KYLIN-001`） |
| P0-2 | IAM 协议联调：discovery（或端点清单）、PKCE、loopback 回调、`resource` 参数支持、刷新、撤销 | 本机拿到可用的 access / refresh token（落入 `CORP-DSH-IAM-001`） |
| P0-3 | Kong 验签联调：JWKS、`sub` → consumer、401 行为 | 一个真实 token 能完成一次模型调用 |
| P0-4 | 刷新并发与锁超时验证：两个进程共用一份凭据文件，`modifyRecord` 内的网络刷新设 ≤5 秒超时目标 | 注入 IAM 慢响应、断网与刷新失败，记录锁等待、持锁、释放和下一请求恢复；不互相触发 `invalid_grant`，不得把网络超时值直接当作已证实锁等待上界 |
| P0-5 | 网关额度与日志契约联调：双维度额度、429 problem+json（含 `quotas`）、关闭正文日志（C4）、按人首调用/日活统计 | 一个真实 token 完成调用并触发一次 429 额度提示（落入 `CORP-DSH-GW-001`） |

### 4.2 P1 概念验证（4 周，准入 G1）

| 项 | 内容 | 交付物 |
|---|---|---|
| P1-1 | fork `@eduwork/dsh-oidc`：接企业 IdP、模型令牌镜像、MCP token broker（按 `resource`）、品牌最小化 | 可安装的企业 IAM 插件包 |
| P1-2 | Windows `desktopServices` 适配层 + `dsh-mcp-client` 基础补丁（按请求回调取 token 与 `stdio` 凭据重连） | 约 30 行 Host 插件 + 50–80 行 `mcp-client` 补丁（均为规模估算，接口与测试范围未定，不构成交付上限） |
| P1-3 | 刷新串行化：把“检查有效期 + 刷新（≤5s 超时）+ 写回”放进 `modifyRecord` | 双进程不互相踢出 |
| P1-4 | Gitee 只读 MCP（arm64 交叉编译）：仓库 / Issue / PR 查询与身份隔离验证 | 可用的 `@corp/dsh-gitee` 包（落入 `CORP-DSH-GITEE-001`） |
| P1-5 | DevOps 只读 MCP：3 个工具（流水线、构建日志、部署状态）最小闭环与 10 人内测 | 可用的 `@corp/dsh-devops` 包（落入 `CORP-DSH-DEVOPS-001`） |

### 4.3 P2 试点工程准备（4 周，准入 G2）与试点运行（6 周，准入 G3）

| 项 | 内容 | 交付物 |
|---|---|---|
| P2-1 | DevOps MCP 扩到 8–12 个工具，切换 `streamable-http` 并暴露 PRM；生产写操作打通本机 `ask` + 平台异步审批单 | 工具清单、PRM 端点与权限矩阵 |
| P2-2 | `dsh-mcp-client` 补丁完善：401 刷新与安全重试分类、兼容性回归套件及向上游提 PR（内部 registry 同步发包兜底） | 补丁包 + 上游 PR + 兼容性测试；生产写操作在 401 / 超时 / 断流后结果未知时不得盲目重放，依赖服务端幂等或查单 |
| P2-3 | 终端打包：Windows MSI 自助安装（MDM 可选）+ 配置预置；麒麟 deb + 内部 apt 源 + `systemd --user`（绑定 `127.0.0.1`）+ `dsh-web-open` 启动脚本 | 两条自助安装通道与安装校验指引（落入 `CORP-DSH-PKG-001`） |
| P2-4 | 企业插件市场：私有 registry + CI 生成 index + 兼容性门禁 + 按角色控制 `plugin_manager` | 可搜索、可安装的内部市场（落入 `CORP-DSH-DIST-001`） |
| P2-5 | 策略与审计（`@corp/dsh-policy`）：7 类角色 preset、`$DSH_HOME/**` 硬拒绝、客户数据外发确认（C3）、OTel 决策审计 | 安全评审材料与策略包（落入 `CORP-DSH-POLICY-001`） |
| P2-6 | 3 部门 800 人试点运行（6 周）：建议按支持人力（1:300）分两批各 400 人进场，第 4 周中期检查、第 6 周判定 M1–M6 | 试点评估报告（落入 `CORP-DSH-PILOT-001`） |
| P2-7 | 轻量 SDD Skill 包（推广前交付）：1 skill + 1 CLI + `@corp/dsh-policy` 阶段路径规则 + 1 个 CI job | SDD 软件包与试点验证（落入 `CORP-DSH-SDD-001`） |

### 4.4 P3 推广（持续）

过 G3 后按更多部门扩量、沉淀培训材料、内部 Skill 库与插件开发脚手架；出现跨人协作同一会话需求时再评估多租户。

### 4.5 项目级关键路径与资源假设

结论：**15 周 = 1 周前置验证 + 4 周概念验证 + 4 周工程准备 + 6 周试点观察**，仅为依赖按时到位、资源无冲突且门禁一次通过时的工作周基准，不是开工或上线日期承诺。阶段、需求优先级与 WBS 的 `P0/P1/P2` 含义不同，映射仍以 [需求与场景基线](../requirements/requirements-baseline.md) §5 为准。

| 基准窗口 | 关键依赖与合流点 | 未满足时的处置 |
|---|---|---|
| 第 1 周，G0 | P0-1 双端验证计划及麒麟候选环境；P0-2 / P0-4 IAM 协议、刷新；P0-3 / P0-5 网关验签、额度、日志边界；责任团队认领接口和排期 | 阻断相关前置结论，不以回函、脚本输出或日历到期代替实测 |
| 第 2–5 周，G1 | IAM broker + MCP 基础补丁、Windows 登录适配与 Gitee arm64 构建可并行；以 DevOps / Gitee 只读闭环、刷新与 10 人内测合流 | 身份、资源授权或构建未通过，不把下游打包完成算作核心路径完成 |
| 第 6–9 周，G2 | DevOps HTTP / PRM、生产审批与未知结果处置；策略与最小审计；双端安装、私有市场；C1–C4 与安全负向用例合流 | 任何准入安全缺口先关闭相关能力、暂停相关批次；不得关沙箱、放宽令牌或绕过审批赶进场 |
| 第 10–15 周，G3 | G2 签署后试点运行；按基线第 4 / 6 周观察与 M1–M6 复核，完成 A10–A13 的推广完整性验收 | 观察不足、数据不可判定或指标未通过则延期 / 复测，不视为已获扩量批准 |

资源与估算口径：

- **资源假设**：2–3 名 DSH 工程师承担客户端、插件、集成、打包与支持；IAM、网关、DevOps、Gitee、安全、IT、PMO 各自指定接口人与评审人（均待确认）。开发与 800 人试点支持争用同一人力，约 1:300 只是既有粗估，不代表已具备值班或响应承诺；支持占用增加时须重排工程任务。
- **依赖等待**：企业团队的受理、环境开通、接口确认、审批与修复等待未计入 15 周。PMO 按责任方记录“请求 / 承诺 / 实到 / 阻塞门禁”；只把阻塞关键路径且不能并行消化的净等待计入重排，不能把所有团队等待机械相加。
- **条件增量**：历史估算包括自研 Kong 验签插件约 +2 周、纯 OAuth2 适配约 +3–5 人日；其他文档中的按 audience 注册多个 client、introspection、PRM 或 MCP broker 增量须在同一 WBS 下去重。PRM / MCP broker 已在本版 P1 / P2 范围内，不能再次无条件相加；人日不直接换算成项目周数，先评估负责人、并行度和测试合流影响，再由 PMO 确认新基准。
- **容量与性能**：800 是一期试点人数，不是 800 并发承诺。P1 测量模型调用时延（含 P95）、错误率、令牌刷新、并发连接与限流等基线；负载模型、峰值假设及 G2 通过阈值由 `CONF-GW-*` / `CONF-PMO-*` 回函确认，未拍板前不编造吞吐、并发或时延数值。阈值未定或测试未通过，不能以“容量 800”替代准入证据。

### 4.6 G0–G3 门禁证据与负责 / 签署角色

结论：门禁是依据证据作出的批准决定，不因周数到期、材料齐套或询问函已发出而自动通过。下表为**拟分工**；具体负责人、授权签署角色及代理机制由 PMO 在 G0 确认，当前“审核”“批准”仍为待定。

| 门禁 | 必须提交的证据包 | 证据负责 / 协作 | 拟签署角色（待确认） |
|---|---|---|---|
| G0 方案与前置验证 | L1/L2/需求版本与范围快照；P0-1–P0-5 原始结果和未通过项；IAM / 网关接口方向、麒麟处置路径；依赖到位计划、批次与支持资源建议、G1/G2 证据计划 | 平台组汇总；IAM、网关、IT、安全提供本域证据；PMO 维护依赖台账 | 项目 / 业务负责人、平台负责人、PMO；IAM / 网关 / IT / 安全确认本域结论 |
| G1 概念验证 | IAM 登录 / 刷新 / 撤销与错误 audience 样本；MCP 基础补丁和 `stdio` 重连记录；DevOps ≥3 只读工具、Gitee 查询与用户隔离；10 人内测记录；P1 性能基线 | 平台组负责集成；IAM、网关、DevOps、Gitee 维护方与 IT 配合 | 平台技术负责人；相关接口维护方确认本域联调，安全复核风险处置 |
| G2 试点准入 | A1–A9、A14 的正向与负向用例证据；C1 路由边界、C2 正文不上报、C3 风险确认、C4 网关与模型正文日志默认关闭；可归因的最小决策 / 调用审计；关键安全插件关闭 / 故障拒绝、双端 A4/A6、安装支持与基础回退 / 恢复演练；经确认的容量阈值与实测结果 | 平台组总装；安全负责边界与审计复核；IAM / 网关 / DevOps / Gitee 提供服务端拒绝证据；IT / PMO 确认支持和批次 | 试点业务负责人、平台负责人、安全负责人、IT / PMO；各服务维护方签署本域结论 |
| G3 推广判定 | 完整试点观察、M1–M6 原始聚合与分母、A10–A13 完整性结果、故障与退出 / 恢复演练记录；遗留项和基线 §6.2 的判定处置 | PMO 形成评估报告；平台组、业务、安全、IT 与各服务方提交佐证 | 项目 / 业务负责人、PMO、平台负责人；安全和相关运行维护方确认风险及承接能力 |

每份证据至少关联：基线 / 契约版本、包与补丁版本、操作系统 / 内核 / runner、测试步骤、预期与实际、正反例结果、脱敏日志或工单、复核人、未通过项及复测门禁。证据不带真实 token、客户正文或未脱敏个人标识；尚未创建的 L3 文档按 [文档清单](../DOCUMENT-REGISTER.md) 补齐，不把文档编号当作已存在成果。

**G2 安全底线不后移**：A13 / REQ-16 的 P1 指的是推广阶段的完整性目标，不允许前期零审计或默认留存正文就进场。C1 / C4、生产写操作的身份 / 变更 / 决定最小归因及必要安全控制须在 G2 已验证；关键身份、策略或审计链路关闭 / 故障时，依赖它们的企业调用或生产写动作拒绝。可选插件隔离只保证无安全依赖的能力不受牵连，不豁免安全前置。

### 4.7 试点运行、止损、退出与恢复

结论：一期仍为 3 部门 800 人；分两批各 400 人只是资源建议，不改变总范围、M1–M6 数值或既定分母。完整需求与判定以 [需求与场景基线](../requirements/requirements-baseline.md) §6 / §8 为准，PMO 未批准前不另立计量口径。

**计时与批次（待 PMO 在 G0 批准并回写基线）**：记录每批实际进场时点 `T_b`、名单版本、终端与角色构成；M1 / M2 仍按基线的 24 小时窗口，第 4 / 6 周仍按基线口径采集。建议另附各批相对 `T_b` 的第 4 / 6 周结果检查可比性，不能把第二批观察不足冒充完整 6 周，也不能混用“已进场”与“全量 800”分母美化结果。若错峰、暂停或数据缺失导致观察窗口不足，G3 延后；末批覆盖窗口超出第 15 周属于条件基准延长，不自动压缩观察期。各批独立观察是否作为正式口径，须经 `CONF-PMO-*` 确认，不能由本计划自行生效。

| 运行事项 | 执行动作与归属 | 未满足时的处置 |
|---|---|---|
| 进场与支持 | IT / 部门联络人统一受理安装与自检问题；平台组二线定位客户端、插件、MCP 集成；IAM / 网关 / DevOps / Gitee 维护方处理本域服务；支持时段、升级时限、值班人与备份待回函 | G2 前未公布渠道、负责人或升级路径，不启动相关批次；不默认 2–3 名工程师具备 7×24 支持 |
| 事件归属 | 工单为故障统计唯一入口；记录批次、受影响用户分母、持续时间、服务 / 客户端版本和脱敏关联标识。跨域由平台组牵引定位，服务方确认根因；安全事件由安全团队牵头处置，PMO 记录范围与门禁影响 | 不因根因未明拒绝受理；不把同一事件跨团队重复计数，争议由 PMO 协调，M5 沿用基线定义 |
| 周检查与中期干预 | PMO 汇总安装、登录、活跃、审计、故障及问卷；第 4 周按基线检查 M3 并组织指引 / 培训等干预；分母、缺数和退出样本留痕 | 指标不可计算不得声称达标；缩范围、延时或变更计量方式均按基线和批准流程办理 |
| 安全止损 | 凭据暴露、C1/C4 失守、确认或服务端审批被绕过、关键审计不可用、无法分类的风险工具出现时，先拒绝相关动作、停用相关企业能力 / 暂停相关批次并保全最小证据；生产操作结果未知先查单 | 不等待月底 M5 或第 6 周再处理，不以关闭 IAM / policy / 审计 / 沙箱换取可用性；无法兜底的能力不开放 |
| G3 去留 | 严格按基线 §6.2 全部组合判定；M1–M6 数值不变。“有条件通过”的延长 2 周或单部门复测是待复核状态，不是已通过 G3，更不是扩大范围的授权 | 不通过 / 待复测时停止扩量；M1 或 M4 不达标按基线回到概念验证修复，未覆盖或不可判定组合不得自行批准 |
| 用户退出与试点结束 | PMO / 业务确认退出范围；IT / 平台组停止相关进程与自动启动、撤销授权 / 清理受管凭据、回收企业插件访问；保留用户工作区与业务数据，证据和日志仅按已批准保留期处理 | 不把退出当作批量删用户数据或擦审计授权；留存、删除与撤销责任待安全 / IAM / IT 确认 |
| 回退与恢复演练 | G2 前演练基础能力关闭、回退和恢复；G3 按 A10 / A12 验证完整版本回退与 bundle 回滚 ≤10 分钟目标。记录从批准回退触发到目标版本、身份、策略、审计与只读探针恢复的耗时；生产能力另用审批拒绝 / 查单路径验证 | 故障注入仅在获准测试环境、用合成数据；恢复后重新验收受影响 A 项。未明生产任务先查状态，禁止盲目重放；演练失败不恢复相关能力 |

恢复不仅是“进程启动”：还须检查错误 / 过期令牌仍拒绝、权限未放大、C1/C4 未改变、审计可归因、已有平台审批单状态一致。变更版本、策略或接口后须重测受影响门禁，不能复用失效证据；退出、恢复和事件留存的具体步骤及保留期由对应 L3 运行手册与 `CONF-IT-*` / `CONF-SEC-*` / 服务方回函确认。

## 5. 复用与 Fork 选型

| 目标 | 项目 | 数据（2026-10-20） | 复用方式 | fork 深度 |
|---|---|---|---|---|
| IAM + 模型授权 | [@eduwork/dsh-oidc](https://github.com/ECNU/EduWork/tree/main/packages/dsh-oidc) | MIT；v0.3.0；★190；peer 对齐 `0.2.1-rc.2`；有 CI | 直接 fork，替换 IdP、增加 broker 与品牌最小化 | 中 |
| 多租户参考（暂不实施） | [@monotykamary/dsh-web-identity](https://www.npmjs.com/package/@monotykamary/dsh-web-identity) | MIT；0.1.9 | 仅参考 identity seam 与 session 分区 | 深 |
| 登录门兜底 | [dsh-auth-gate](https://www.npmjs.com/package/dsh-auth-gate) | MIT；0.17.4 | 密码 / 共享令牌 / TOTP，不替代 SSO | 浅 |
| Gitee | [oschina/mcp-gitee](https://github.com/oschina/mcp-gitee) | ★66；Go；MIT | 直接使用；arm64 自行交叉编译 | 浅 |
| GitLab（如有） | [zereight/gitlab-mcp](https://github.com/zereight/gitlab-mcp) | ★2053；TS；MIT | 现成 MCP | 浅 |
| Jenkins（如有） | [lanbaoshen/mcp-jenkins](https://github.com/lanbaoshen/mcp-jenkins) | ★154；Python；MIT | 现成 MCP | 浅 |
| ArgoCD（如有） | [argoproj-labs/mcp-for-argocd](https://github.com/argoproj-labs/mcp-for-argocd) | ★590；TS；Apache-2.0 | 现成 MCP | 浅 |
| Kubernetes（如有） | [containers/kubernetes-mcp-server](https://github.com/containers/kubernetes-mcp-server) | ★2169；Go；Apache-2.0 | 现成 MCP | 浅 |
| 网关 | [BerriAI/litellm](https://github.com/BerriAI/litellm) | ★61.6k | 仅作 Kong 的对照参考，不部署 | — |
| 市场索引 | DSH 自带 `apps/plugin-market-generator` | 同版本 | 直接用于内部 index | — |

取舍：真正需要修改或 fork 的只有 `dsh-oidc`、`dsh-mcp-client`（唯一核心补丁）和 Gitee 的 arm64 打包封装；其余用现成 MCP 或配置 bundle。

## 6. 研发流程层：轻量 SDD

结论：oh-my-sdd 的工程细节值得借鉴，但产品形态不适合引入 DSH。Harness 会吸收注入、委托、拦截、遥测与身份；SDD 仅需维护 Harness 未覆盖的三项内容：**产物契约、门禁规则、归档与交付不变量**。

### 6.1 工具链归属

| 边 | 文中做法 | DSH 归属 | 处置 |
|---|---|---|---|
| 宿主注入 | wrapper / rules 目录 / AGENTS / TS 插件 | AGENTS.md + skills + bundle | 删适配层，收敛为一条注入路径 |
| 环 → skill | 固定委托 brainstorming → writing-plans、executing-plans / subagent | 同名 skills + subagent | 保留为 skill 内部步骤，删 dispatcher |
| 环 → 校验 | `openspec new/validate/archive` | 无对应能力 | **保留**，唯一不可替代 |
| 环 → 平台 | `gh`、DOP、`iam auth status` | bash/MCP + IAM 插件 + OTel | 改为插件/MCP，SDD 不直连 |
| 环 → git | commit-msg / pre-commit / pre-push / prepare 四件套 | `@corp/dsh-policy` + CI | 只留 commit-msg 或并入 CI |
| 环 → 遥测 | DOP 全生命周期埋点 | OTel 决策审计与 session-log | 移出 SDD，归企业遥测 |

文中大量“固定委托链”在补偿宿主缺少产物契约——必须经 brainstorming、必须传路径约束、必须纠正 commit 格式。这些约束在 DSH 里应由**一个 skill 的模板 + 一个校验器**承担，而不是靠调用顺序。

### 6.2 治理层次收敛

| 原层 | 本质 | DSH 对应 | 结论 |
|---|---|---|---|
| L1 Data | 内容 | AGENTS.md / skill 文件 | 保留，瘦身 |
| L2 Injection | 分发 | 原生加载 | 删除 |
| L3 Plan gate | 流程约束 | plan mode 是软约束（工具仍全开），需靠 skill + policy | 降为 skill 的一步 + 阶段路径规则 |
| L4 Analyze | 审查 | review skill + subagent | 保留，简化 |
| L5 Policy Gate | 强制 | `@corp/dsh-policy`（`tools/pre-execute` + `tools.guard`）+ sandbox | 规则并入原生策略插件，不维护每宿主 hooks（见 ADR-4） |
| L6 Amendment | 变更控制 | PR + CI | 保留模板，删 8 步命令 |
| L7 CI | 变更控制 | 仓库 CI | 保留 1 个 job |

压成三层：**契约层**（产物与格式）、**门禁层**（`@corp/dsh-policy` 运行时拦截）、**交付层**（归档与 PR）。前两层是 DSH 的强项，第三层才是 SDD 的真正价值。

### 6.3 轻量形态

- 1 个 skill `sdd`：组合现有的 brainstorming / writing-plans / executing-plans / code-review-and-quality / test-driven-development / verification-before-completion，产出 proposal / spec / design / tasks。
- 1 个 CLI `sdd`（约 300 行）：封装 `openspec` 的 new / validate / freeze / stale / archive / pr-body。
- 1 组 `@corp/dsh-policy` 规则：HARD 规则（禁读 `$DSH_HOME/**`、禁密钥硬编码、禁 force push、禁 `rm -rf`、禁直编 `.env`）+ 阶段路径规则（`spec` 阶段只写 `openspec/changes/<id>/**`；`apply` 阶段 canonical spec 只读；`review` 阶段不写源码）。
- 1 个 CI job：validate + 指纹 + baseline lint。
- 0 宿主适配、0 五级保护控制面、0 自研遥测、0 独立 hook 引擎。

### 6.4 保留与删除

保留（Harness 没有）：change-id 贯穿 branch / commit / PR / tracker；产物集与落点；freeze + SHA-256 指纹 + stale 传播；原子 PR（实现 + canonical spec + archive）；OVERRIDE 理由审计；按阶段限定的写保护。

删除（Harness 已吸收或不属于流程）：HostAdapter 注册表与四个宿主适配；五级保护状态机；`/sdd-constitution` 8 步；DOP 埋点与 queue；双阶段 Constitution 扫描；与流程无关的参考 skill（按需另立知识包）。

### 6.5 三条不变量

1. **一致性**：canonical spec 与代码不漂移（freeze / 指纹 / stale / archive）。
2. **原子性**：一次交付的 PR 同时包含实现、spec、归档。
3. **可追溯**：change-id 从需求到 PR 不断链。

环是过程，不变量是结果。Harness 可以随时优化过程，但不变量必须由契约守住。SDD 在 P2 并行推进，不阻塞 P0/P1 的 IAM / Kong / DevOps 关键路径。

## 7. 验收标准

本表包含全部 `A1–A14` 验收项，不新增 A 编号；`A1–A9`、`A14` 为 G2 的 P0 准入项，`A10–A13` 为 G3 的 P1 完整性项。C1/C4、最小审计和必要安全控制仍须在 G2 验证（见 §4.6），不能由 P1 标签推导“前期零审计可进场”。下列均为待实施的验收目标，不是本次已通过结果。

| # | 验收项 | 判据 |
|---|---|---|
| A1 | Windows 首次登录 | MSI 自助安装后，登录 30 秒内可完成一次对话；未登录、取消 / 失败登录时企业模型与未授权企业工具不可用，bundle 不保留其他模型路由，不因失败回落公网 |
| A2 | 令牌刷新 | 过期后刷新成功无需手动重启；双进程不相互触发 `invalid_grant`；锁内网络刷新超时 ≤5 秒为待实测目标，分别记录锁等待 / 持锁 / 释放，不能以 5 秒配置推定锁等待上界；慢响应、断网、`invalid_grant` 时释放锁并按错误分类退避或重登，不循环重试、不扩大权限 |
| A3 | 网关鉴权与额度 | 有效 token 成功；错误 `iss` / `aud`、撤销 / 过期 token 拒绝；consumer 可归因到 `sub`；个人、consumer 与双层耗尽均验证 429 problem+json 的 `quota_scope` / `quotas` 和恢复提示；429 不自动重试，403 不误当过期，依赖不可用不绕过校验；G2 提供 C1 路由仅机构内、C4 网关及模型正文日志默认关闭的配置与脱敏观测证据 |
| A4 | 客户端无网关 Key 且凭据受保护 | 客户端仅持有授权 IAM token，不含网关上游 Key；Windows 与麒麟均实测文件工具和命令 / 编码变体 / 符号链接或路径别名 / 子进程间接访问 `$DSH_HOME/**` 的拒绝结果，并核对工作区正常访问不误拒绝；未证实覆盖路径不得承诺安全硬隔离，无法兜底的对应能力不开放，不得关沙箱绕过 |
| A5 | 麒麟离线安装与本机启动 | deb 安装后无需现场编译、无需公网即可启动（OAuth / 企业调用仍需企业服务可达）；仅监听 `127.0.0.1`，非本机访问拒绝；`.desktop` / `dsh-web-open` 拉起浏览器完成 OAuth，不将 launch token 泄露到共享日志 |
| A6 | 麒麟沙箱 | 在目标内核 / runner 实测允许与禁止路径、子进程、必要网络边界；结论为 bwrap / Landlock / 自定义 runner 经验证可用或未通过，组件存在不等于隔离成立；无可用隔离时 fail closed，不开放相应执行能力，所谓显式降级仅指经评审关闭能力，不是关闭沙箱继续执行；Windows 保护同按 A4 验证 |
| A7 | DevOps 工具闭环与生产审批 | 至少 3 个只读工具返回真实正确结果；风险分类依据经维护方确认的工具 / 目标环境权限清单及服务端校验，不把工具自报 `mutating` 当可信授权源，未知 / 无法分类风险工具拒绝；生产写须本机 `ask` 确认并满足平台所需审批，本机 `approval=never`、无 UI、拒绝、取消或超时均不得执行；平台拒绝 / 待审批 / 单据失效不得落为成功；401 / 超时 / 断流后结果未知不得盲目重放，以服务端幂等或查单确认；保留人、变更、决定最小审计 |
| A8 | Gitee 工具闭环 | 仓库 / Issue / PR 查询可用；跨用户、错误 scope / 资源与撤销凭据的越权访问被服务端拒绝；写操作默认关闭、开关可独立控制，未启用时拒绝写；可选写能力不因验收而扩大一期必做范围 |
| A9 | 内部市场与安装权限 | 公网 registry 不可达时开发者仍能从内部源搜索、安装已审批插件，无公网回落；只读与受限角色禁用 `plugin_manager`，未审批包、校验失败或不兼容包不得在受管通道安装；本机管理员能改 preset / 配置，不将其当不可绕过授权，须验证绕过客户端档位后服务端仍拒绝越权企业调用 |
| A10 | 版本可控 | 客户端与插件版本固定；升级前执行登录 / 模型 / MCP / 策略 / 市场兼容性门禁，失败不得放量，按批准步骤可回滚并复测，不因回退丢弃用户工作区 |
| A11 | 轻量 SDD | change-id 贯穿 branch/commit/PR；freeze 后改动标记 stale；评审阶段写源码被拒绝；PR 原子包含实现+spec+archive；无宿主适配与自研遥测；无阶段元数据时仍执行 HARD 安全规则，不误阻塞普通开发 |
| A12 | 可选插件隔离与安全回滚 | 无安全依赖的可选插件单独禁用时其余能力正常；IAM / policy / 必要审计等关键安全插件关闭或故障时，依赖它们的企业调用或生产写动作拒绝，不能保留原权限继续执行；bundle 回滚 ≤10 分钟为待演练目标，记录起止点及恢复后的身份、策略、审计验证，不以进程启动代替恢复 |
| A13 | 审计完整性 | 按基线 REQ-16，模型事件按 `sub` + 调用关联标识归因，有研发变更时关联 `change-id`，普通问答不伪造；生产写强制 `sub` / `change-id` / `decision`，必需字段缺失为0、M4仍100%。以DevOps独立操作台账核对审计，整条漏记也计为不完整，不能以同一审计流自算分母；去重/关联及零真实样本规则在G2前由DevOps/安全/PMO冻结，不为验收制造生产动作，不将0/0自动计100%。核对拒绝/失败/待审批/最终结果，不把已提审批记为执行成功；C4默认无正文日志，保留期经批准；G2已具最小审计，G3验证完整性 |
| A14 | 标准符合性 | PKCE + loopback IP，错误 `state` / 回调 / 身份校验失败拒绝；MCP HTTP 按资源绑定令牌、`aud` 匹配（`resource` 或经确认的 audience-client 替代，仍一资源一 token），错误资源 / scope 拒绝；DevOps HTTP MCP 暴露 PRM 并与 canonical URI 一致；401 刷新只对可安全重试请求验证，生产写操作结果未知时先查单或走服务端幂等，不泛化自动重放 |

验收记录须包含至少一个拒绝反例及其可观察结果；仅存在规则、配置键、`mutating` 标记或审批 UI 不构成通过。当前会话若出现 `approval changed` 仅表示 runtime 状态变化，不是企业需求变更或本机确认完成证据；企业风险确认要求只能按正式范围 / 策略变更流程调整。

## 8. 风险与应对

| 风险 | 等级 | 处置 |
|---|---|---|
| 麒麟沙箱 fail closed，影响 50%（约 400 台）终端 | 高 | P0 先验并作为准入项；经 IT / 安全批准后验证 bwrap、userns 或企业 `runnerCommand`；探针成功不等于隔离通过，未验证的能力不开放，不得关闭沙箱赶排期 |
| `node-pty` 在 aarch64 需现场编译，安装失败 | 高 | 在 arm64 构建机预构建 profile，deb 内直接带 `node_modules` |
| 上游预发布节奏快，插件随版本失效 | 高 | 锁版本、内部镜像、`engines.dsh` 门禁、升级前回归 |
| 800 人自助安装与 2–3 名工程师支持比过高（约 1:300） | 高 | G0 复核支持人力；建议拆分为两批各 400 人进场，安装包内置环境自检脚本 |
| 凭据文件（含 `refresh_token`）可被同用户 agent 进程读取 | 高 | 路径拒绝与沙箱遮蔽为待验证控制，必须覆盖 A4 的双端文件 / 命令 / 编码 / 链接 / 子进程路径；短 TTL、最小 scope 与服务端撤销仅减灾，不替代隔离证据；本机管理员能改配置，企业授权仍靠服务端 |
| IAM 为纯 OAuth2 无 OIDC | 中 | 用 userinfo / introspection 替代 ID Token 校验，约 +3–5 人日 |
| 网关额度语义与 DSH 展示不一致 | 中 | 对齐 429 / `Retry-After` / `quotas` 与额度查询接口；客户端不自动重试 429 |
| 网关 JWT 验签方式待确认 | 中 | P0 用真实 token 联调；不支持 JWKS 则改为 introspection |
| 白标发行与官方更新策略冲突 | 中 | 一期用官方 App；确需白标时单独立项 |
| MCP 工具过多挤占上下文 | 中 | 按 7 类角色 preset 裁剪、只读优先、Skill 承载流程 |
| 依赖等待 / 试点支持挤占关键路径 | 高 | PMO 按净关键路径重排；条件增量不机械相加，15 周不作为日期承诺；支持资源与升级时限由团队确认 |
| 工具标签失真、确认不可达或生产结果未知 | 高 | 不信任工具自报 `mutating` 作为授权；未知风险拒绝；`approval=never` / 无 UI / 超时不执行风险动作；服务端审批、幂等或查单兜底，不盲目重放 |
| 800 人被误作 800 并发且性能阈值未定 | 高 | P1 先测基线，`CONF-GW-*` / `CONF-PMO-*` 在 G2 确认负载与通过阈值；未测 / 未批准不能视为容量通过 |

## 9. 待确认事项与回函门禁

结论：以下为待确认事项的责任与门禁归类；问题采用 `CONF-<域>-*` 域前缀，不复制字段级契约。回函中的接口、保留期、排期与负责人须由对应团队确认后才能成为执行依据。G0 的认领与方向回函不能替代 P0 实测，G1/G2 未关闭事项按下表阻断，不因“已发函”自动通过。

| 原事项 / 补充归类 | 待确认内容与责任边界 | CONF 域前缀 | 截止门禁与未关闭后果 |
|---|---|---|---|
| 1 IAM 协议 | OIDC 或纯 OAuth2；discovery / JWKS / userinfo / introspection 的实际端点、claims、TTL、刷新与撤销、对接人及服务归属 | `CONF-IAM-*` | G0 明确协议与负责人、完成前置联调；G1 提交登录 / 刷新反例证据，否则核心链路不通过 |
| 2 本机回调 | loopback IP、动态 / 固定端口、Windows 浏览器拉起与麒麟启动脚本、终端网络 / 安全软件约束 | `CONF-IAM-*`、`CONF-IT-*` | G0 方向与样机清单；G1/G2 双端联调 / 安装验证，否则相关终端不得进场 |
| 3 网关与观测 | JWKS 或 introspection、consumer 生命周期与多团队归属、双维度额度与 429、首调用 / 日活数据、C1/C4、实际负载模型及容量阈值 | `CONF-GW-*`、`CONF-IAM-*`、`CONF-SEC-*`、`CONF-PMO-*` | G0 契约方向和数据责任；G1 基线测量；G2 阈值批准与实测、路由 / 日志证据，缺失则不能以 800 人容量推定准入 |
| 4 DevOps / Gitee 接口 | DevOps canonical URI / PRM、服务端 scope / 角色授权、可信工具与环境清单、异步审批单、幂等 / 查单、运行维护责任；Gitee IAM 映射或独立凭据、arm64 构建与撤销 | `CONF-DEVOPS-*`、`CONF-GITEE-*`、`CONF-IAM-*`、`CONF-SEC-*` | G0 认领与依赖排期；G1 只读闭环和资源授权；G2 生产写安全证据，否则只读或相应写能力不开放 |
| 5 官方发行与范围变更 | 默认不白标、采用官方 App；仅确认签名 / 分发边界、范围变更批准角色。白标等非目标如确需调整，单独提交范围变更与立项，不由询问答复直接启用 | `CONF-IT-*`、`CONF-PMO-*` | G0 明确范围与批准链；未经正式变更继续按需求基线 N1–N8 执行 |
| 6 终端安全矩阵 | 麒麟版本 / 内核 / `uname -a`、runner 与原生模块；Windows 文件 / 命令 / 编码 / 符号链接 / 子进程保护；A4/A6 例外与禁用能力清单 | `CONF-IT-*`、`CONF-SEC-*` | G0 样机与候选结论；G2 双端隔离实测，无法兜底则相应能力不开放，不以关沙箱替代 |
| 7 按资源令牌 | RFC 8707 `resource` 支持；若不支持，按 audience 预注册 client 的替代、缓存键、scope 与一资源一 token 的服务端校验 | `CONF-IAM-*`、`CONF-DEVOPS-*`、`CONF-GW-*` | G0 确认方案；G1/G2 验证资源隔离与 A14，不能用宽 audience 令牌掩盖依赖缺口 |
| 8 批次、数据与人力 | 800 人一次进场或建议两批各 400 人、观察起点 / 可比性、指标分母、支持时段 / 资源；C3 外发确认与附加扫描规则；C2/C4 正文采样、元数据和证据保留期 | `CONF-PMO-*`、`CONF-IT-*`、`CONF-SEC-*`、`CONF-GW-*` | G0 批次和保留规则方向、编制 / 批准角色；G2 支持、采集与安全参数签署。网关草案中的 7 天 / 180 天仅为待确认值，不构成企业既定保留期 |
| 运行支持与去留 | 各服务事件负责人、跨域升级 / 安全指挥、退出时的授权撤销与数据保全、回退 / 恢复步骤和演练环境；G3 评估与复测签署角色 | `CONF-IAM-*`、`CONF-GW-*`、`CONF-DEVOPS-*`、`CONF-GITEE-*`、`CONF-IT-*`、`CONF-SEC-*`、`CONF-PMO-*` | G0 认领；G2 运行承接与基础演练；G3 按基线签署去留。无负责人、无可判定证据或观察不足不得自动过门禁 |

## 附录 A 银河麒麟兼容性验证脚本

以下为历史只读候选探针，不安装组件或改变系统配置；本次未执行。由获准人员在目标麒麟机器执行并保留脱敏输出，仅用于环境初筛，不能代替 A4 / A6 的真实隔离测试或证明命令 / 子进程已受保护。

```sh
uname -a
uname -m
getconf GNU_LIBC_VERSION
node -v 2>/dev/null || echo "node missing"
command -v bwrap && bwrap --version
bwrap --unshare-user --dev-bind / / true && echo bwrap-ok || echo bwrap-fail
cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo "userns knob absent"
cat /sys/kernel/security/lsm 2>/dev/null || echo "lsm unavailable"
```

判读：

- `aarch64` + glibc ≥ 2.28 + Node 24 可运行：仅形成基础环境候选结论，还需验证原生模块与实际安装包。
- `bwrap-ok`：只说明该最小命令成功，未证明 DSH runner 配置下凭据遮蔽、文件 / 命令 / 链接 / 子进程隔离成立；须完成 A4 / A6 正反例后才能判定可用。
- `bwrap-fail` 且 `lsm` 含 `landlock`：仅列 Landlock 为候选，仍需核验内核实际支持、权限与 runner 行为，不能凭字符串决定已可用。
- 两者都不可用：由 IT / 安全确认装 bwrap / 开 userns / 自定义 runner 的处置路径并验证后再推进相应能力；不得用关闭沙箱代替通过。
- Windows 不适用上述 Linux 探针，必须另按 A4 建立实机负向回归；本附录不提供 Windows 安全隔离已经成立的结论。

## 附录 B 参考资料

- [DSH 凭据子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/credentials.md)
- [公开部署与反向代理](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.md)
- [LiteLLM JWT → Virtual Key](https://docs.litellm.ai/docs/proxy/jwt_key_mapping)
- [oauth2-proxy 请求头集成](https://oauth2-proxy.github.io/oauth2-proxy/7.8.x/configuration/integration/)
- [EduWork dsh-oidc 文档](https://github.com/ECNU/EduWork/tree/main/packages/dsh-oidc/docs)

> 本文件为 Plan，不替代实施与验证证据；运行态、本机配置与批准的企业需求须分开记录。只有实际完成并复核的测试、联调和演练记录才能作为过门禁依据，当前文档不表示相应能力已经实现或安全隔离已经成立。
