# 企业 DSH 研发平台推广实施方案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-001 |
| 文档名称 | 企业 DSH 研发平台推广实施方案 |
| 版本 | V1.0 |
| 文档状态 | 评审稿 |
| 密级 | 内部 |
| 编制 | DSH 平台组 |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-20 |
| 文档层级 | L2 实施计划；字段级契约由子文档承担（见架构设计 §12） |

## 修订记录

| 版本 | 日期 | 修订人 | 修订说明 |
|---|---|---|---|
| V0.1 | 2026-10-20 | DSH 平台组 | 初稿 |
| V0.2 | 2026-10-20 | DSH 平台组 | 补充双维度额度、标准符合性与子文档分工 |
| V1.0 | 2026-10-20 | DSH 平台组 | 文档命名与内容正式化 |

> 编制依据：DSH `0.2.1-rc.2` 源码、npm registry 与 GitHub 发布资产，核验日期 2026-10-20；企业 IAM / 网关 / DevOps 接口与银河麒麟实机尚未验证。
>
> 关联文档：[企业 DSH 研发平台总体架构设计](platform-architecture.md)。

## 1. 背景与目标

结论：方案可行，且大部分工作不需要从零开始。企业侧已具备标准 OAuth IAM、Kong 网关和带 API/CLI 的自研 DevOps 平台，DSH 的凭据 seam、LLM 路由和插件机制足以承接；真正的约束来自三处——**DSH 是单用户产品**、**官方桌面端不构建 Linux**、**银河麒麟 aarch64 的沙箱与原生模块需要实机验证**。

因此一期按“每人一套 DSH”落地，不做多租户：Windows 用桌面 App，银河麒麟用 `dsh --profile web` + 浏览器（仅本机自用），macOS 不纳入一期。IAM 插件仅承担两项职责：**取得模型授权**与**提供可审计的用户身份**，不承担“打开 DSH 的准入”。

### 1.1 已确认的决策输入

| # | 决策 | 影响 |
|---|---|---|
| 1 | 企业自研 IAM，遵循 OAuth 标准，支持跳转登录与回调 | 走 Authorization Code + PKCE；需确认 OIDC 还是纯 OAuth2 |
| 2 | 基于 Kong 的自研 AI 网关，具备详细额度管理 | 走 token 直通，不向客户端发 API Key；计量与限额在网关侧，支持按人 / consumer 双维度 |
| 3 | 每人使用自己的 DSH；共享 Web 后续再议 | 多租户整块移出一期，省略 connection/session 的核心改造 |
| 4 | 自研 DevOps 平台，提供 API 与 CLI | 包一层精简 MCP + Skill，不等待厂商 MCP |
| 5 | 终端以 Windows 为主，银河麒麟为 ARM，浏览器版本达标 | Windows 走 App；麒麟走本机 Web；无 Electron on Linux 需求 |
| 6 | 本机 Web 不供他人使用 | 保留 launch token 门禁即可，不做入口 SSO |

### 1.2 不在本期范围

- 多人共享单实例的身份隔离、按用户分区 session / workspace。
- macOS 客户端。
- 白标发行；若开放问题 5 决定要做，另立一期并单独评估打包与更新流水线。
- 自建模型推理服务；模型仍由企业 AI 网关统一承接。
- 公网访问、跨网段暴露本机 Web。

## 2. 目标架构

```text
员工终端（每人一套 DSH）
├─ Windows：DSH Desktop
└─ 银河麒麟：dsh --profile web + 浏览器（仅本机）

  ├─ IAM 插件（fork dsh-oidc，改造后）
  │    系统浏览器 → 企业 IAM：Code + PKCE
  │    回调 127.0.0.1:<port>/oauth/callback
  │    登录/刷新后写入 CredentialRef: ENTERPRISE_ACCESS_TOKEN
  │
  ├─ LLM 路由（llm-pi-ai，apiKeyEnv=ENTERPRISE_ACCESS_TOKEN）
  │    Bearer <IAM access token> → Kong AI Gateway
  │      ├─ JWKS 验签
  │      ├─ consumer = sub
  │      ├─ 按人限额 / 模型白名单
  │      └─ 注入上游真 Key → 模型
  │
  ├─ DevOps MCP（本地 stdio，8–12 工具）→ 企业 DevOps API
  └─ Gitee MCP（本地 stdio）→ Gitee API
```

### 2.1 令牌与身份传递

IAM 插件在 fork 中增加一步：登录与刷新成功后，把模型网关的 access token 写入 `ENTERPRISE_ACCESS_TOKEN` 这个 CredentialRef（原插件只把会话保存在凭据记录里），并作为 MCP 的 token broker 按 `resource` 取 token。DSH 的凭据 seam 按操作重新解析引用，因此：

- 模型请求由 `llm-pi-ai` 的 `apiKeyEnv` 直接取得当前 token，**不需要写新的 LLM adapter**。
- MCP 由 broker 按 `resource` 换取 token，缓存键为 `(resource, scope)`，与模型网关共用同一会话，但一资源一 token。
- 刷新后下一次请求即生效，无需重启进程。

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      corp-gateway:
        displayName: 企业 AI 网关
        api: openai-completions
        baseURL: https://ai-gateway.corp.example/v1
        apiKeyEnv: ENTERPRISE_ACCESS_TOKEN
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
| DevOps / Gitee | 本地 stdio MCP，按请求从 CredentialRef 取 header | 需要给 `dsh-mcp-client` 增加按请求解析 header 的能力 |

Kong 侧建议：用自研插件或 Enterprise 的 `openid-connect` 做 JWKS 验签（Kong OSS 的 `jwt` 插件只支持按 consumer 配静态密钥，不适合多用户）；`key_claim_name` 设为 `sub`，把用户映射为 consumer；模型路由用 `ai-proxy`（或普通 `proxy`）指向 OpenAI 兼容上游；过期返回 401，DSH 下一次请求重新解析凭据即可恢复。

## 3. 关键技术事实与依据

以下事实均于 2026-10-20 核对 DSH `0.2.1-rc.2` 源码与公开仓库；未标注者为源码或官方文档事实，工期为推断。

| # | 事实 | 证据 | 对方案的影响 |
|---|---|---|---|
| 1 | 浏览器连接共享单一 owner Peer，cookie 负载只有 authority，没有用户主体 | `packages/client/connection/src/rpc-host.ts`（`browserPeer`）、`browser-auth.ts`（cookie payload v1/v2） | 共享实例等于共享身份；一期按每人一套规避 |
| 2 | 凭据 seam 分 `CredentialRef` 与 `CredentialKey` 两个空间，消费者按操作重新解析 | `packages/credentials/credentials`、`docs/subsystems/credentials.md` | 令牌轮换即时生效，不需要重启 |
| 3 | `llm-pi-ai` 支持自定义 OpenAI 兼容网关，`apiKeyEnv` 按请求解析 | `packages/llm/llm-pi-ai/README.md` | 模型链路几乎纯配置 |
| 4 | MCP client 的 `env` / `headers` 在加载时求值，没有按请求解析或 OAuth 客户端 | `packages/mcp/mcp-client/README.md` | 需约 50 行改造，否则 token 过期要重启 MCP 进程 |
| 5 | 官方桌面端只构建 macOS 与 Windows，发布 feed 目标为 `mac-arm64`、`mac-x64`、`win-x64` | `apps/desktop/scripts/electron-builder-config.mjs`、`apps/desktop/publishing/README.md` | 银河麒麟没有官方 Electron 客户端，只能走本机 Web |
| 6 | Linux 沙箱链为 `bwrap → Landlock → fail closed`，无可用后端时拒绝执行而非降级 | `packages/sandbox/sandbox-local/README.md` | 麒麟首要验证项；加固内核可能直接不可用 |
| 7 | Web 前端构建目标为 `es2022` | `apps/web/vite.config.ts` | 浏览器版本已确认达标，不再作为风险 |
| 8 | 插件市场为 format-1 index，私有 registry 优先且不回落公网，自带 index 生成器 | `packages/boot/plugin-market/README.md`、`packages/boot/plugin-manager/README.md`、`apps/plugin-market-generator/README.md` | 企业市场只差治理与流水线 |
| 9 | 凭据文件为 0600 的 `$DSH_HOME/.credentials.yaml`，agent 以同一 OS 用户运行，可读取 | `packages/credentials/credentials-local/README.md` | 令牌必须短 TTL、最小 scope、网关侧可撤销 |
| 10 | 公开部署的 launch URL 即进程凭据，文档要求只分享给预期用户 | `docs/user/guide/public-deployments.md` | 本机 Web 仅供本人使用，保持现状 |
| 11 | npm 上 `@deepseek-ai/dsh` 共 36 个版本，全部为预发布，最近 30 天 14 个版本，最新 `0.2.1-rc.2` | npm registry 实测 | 必须锁版本、内部镜像、兼容性门禁 |
| 12 | `sharp`、`koffi`、`node-addon-system` 均有 linux-arm64 预编译；`node-pty` 无预编译，安装时回退 `node-gyp rebuild` | npm registry 元数据、`packages/subprocess/subprocess-local/package.json` | 麒麟需在 arm64 构建机预构建 profile，避免用户端编译 |
| 13 | `mcp-gitee` 最新发布资产含 `linux-amd64` / `linux-arm`，但没有 `linux-arm64` | GitHub Releases API（v1.0.0） | 麒麟上需自行交叉编译或改用 Node 实现 |

## 4. 工作分解

工期为推断，按 2–3 名 DSH 工程师计，不含企业 IAM / 网关 / DevOps 团队的排期等待。字段级契约与接口清单由各团队子文档承担（见架构设计 §12）。P1 的 4 周含 MCP token broker；若网关验签需自研插件，P1 再增加 2 周。

### 4.1 P0 前置验证（1 周）

| 项 | 内容 | 完成判据 |
|---|---|---|
| P0-1 | 麒麟 aarch64 兼容性：Node 24、glibc、bwrap / Landlock、`node-pty` 加载、浏览器 | 产出“可用 / 需装 bwrap / 需自定义 runner”三选一结论 |
| P0-2 | IAM 协议联调：discovery（或端点清单）、PKCE、loopback 回调、刷新、撤销 | 本机拿到可用的 access / refresh token |
| P0-3 | Kong 验签联调：JWKS、`sub` → consumer、401 行为 | 一个真实 token 能完成一次模型调用 |
| P0-4 | 刷新并发验证：两个进程共用一份凭据文件 | 无 `invalid_grant` 互相踢出 |
| P0-5 | 网关联调：JWKS / introspection 验签、consumer 生命周期、额度维度与 429 语义 | 一个真实 token 完成一次调用，并触发一次额度提示 |

### 4.2 P1 概念验证（4 周）

| 项 | 内容 | 交付物 |
|---|---|---|
| P1-1 | fork `@eduwork/dsh-oidc`：接企业 IdP、模型令牌镜像、MCP token broker（按 `resource`）、品牌最小化 | 可安装的企业 bundle |
| P1-2 | Windows `desktopServices` 适配层：用 `subprocess` 调系统浏览器打开登录页 | 约 30 行 Host 插件 |
| P1-3 | 刷新串行化：把“检查有效期 + 刷新 + 写回”放进 `modifyRecord` | 双进程不互相踢出 |
| P1-4 | Gitee 只读 MCP：仓库 / Issue / PR 查询 | 一个可用的 MCP 包 |
| P1-5 | DevOps 只读 MCP：3 个工具（流水线、构建日志、部署状态） | 最小闭环 |

### 4.3 P2 试点（4 周）

| 项 | 内容 | 交付物 |
|---|---|---|
| P2-1 | DevOps MCP 扩到 8–12 个工具，写操作走审批 | 工具清单与权限矩阵 |
| P2-2 | `dsh-mcp-client` 按请求解析 header | 补丁 + 上游 PR |
| P2-3 | 打包：Windows MSI / MDM 预置 profile；麒麟 deb + 内部 apt 源 + 桌面启动器（systemd user service 或 .desktop） | 两条安装通道 |
| P2-4 | 企业插件市场：私有 registry + CI 生成 index + 兼容性门禁 | 可搜索、可安装的内部市场 |
| P2-5 | 权限与审计：permission preset、审批策略、OTel 导出 | 安全评审材料 |
| P2-6 | 灰度 50–100 人，收集故障与登录成功率 | 试点报告 |
| P2-7 | 轻量 SDD Skill 包（可选）：1 skill + 1 CLI + 1 份 hook 规则 + 1 个 CI job | 在 1–2 个团队试点 |

### 4.4 P3 推广（持续）

按部门灰度、培训材料、内部 Skill 库、插件开发脚手架；多人共享需求出现时再评估多租户。

## 5. 复用与 Fork 选型

| 目标 | 项目 | 数据（2026-10-20） | 复用方式 | fork 深度 |
|---|---|---|---|---|
| IAM + 模型授权 | [@eduwork/dsh-oidc](https://github.com/ECNU/EduWork/tree/main/packages/dsh-oidc) | MIT；v0.3.0；★190；peer 对齐 `0.2.1-rc.2`；有 CI | 直接 fork，替换 IdP 与品牌 | 中 |
| 多租户参考（暂不实施） | [@monotykamary/dsh-web-identity](https://www.npmjs.com/package/@monotykamary/dsh-web-identity) | MIT；0.1.9 | 仅参考 identity seam 与 session 分区 | 深 |
| 登录门兜底 | [dsh-auth-gate](https://www.npmjs.com/package/dsh-auth-gate) | MIT；0.17.4 | 密码 / 共享令牌 / TOTP，不替代 SSO | 浅 |
| Gitee | [oschina/mcp-gitee](https://github.com/oschina/mcp-gitee) | ★66；Go；MIT | 直接使用；arm64 自行交叉编译 | 浅 |
| GitLab（如有） | [zereight/gitlab-mcp](https://github.com/zereight/gitlab-mcp) | ★2053；TS；MIT | 现成 MCP | 浅 |
| Jenkins（如有） | [lanbaoshen/mcp-jenkins](https://github.com/lanbaoshen/mcp-jenkins) | ★154；Python；MIT | 现成 MCP | 浅 |
| ArgoCD（如有） | [argoproj-labs/mcp-for-argocd](https://github.com/argoproj-labs/mcp-for-argocd) | ★590；TS；Apache-2.0 | 现成 MCP | 浅 |
| Kubernetes（如有） | [containers/kubernetes-mcp-server](https://github.com/containers/kubernetes-mcp-server) | ★2169；Go；Apache-2.0 | 现成 MCP | 浅 |
| 网关 | [BerriAI/litellm](https://github.com/BerriAI/litellm) | ★61.6k | 仅作 Kong 的对照参考，不部署 | — |
| 市场索引 | DSH 自带 `apps/plugin-market-generator` | 同版本 | 直接用于内部 index | — |

取舍：真正需要 fork 的只有 `dsh-oidc`、`dsh-mcp-client`（补丁）和 Gitee 的打包封装；其余用现成 MCP 或配置 bundle。

## 6. 研发流程层：轻量 SDD

结论：oh-my-sdd 的工程细节值得借鉴，但产品形态不适合引入 DSH。Harness 会吸收注入、委托、拦截、遥测与身份；SDD 仅需维护 Harness 未覆盖的三项内容：**产物契约、门禁规则、归档与交付不变量**。

### 6.1 工具链归属

| 边 | 文中做法 | DSH 归属 | 处置 |
|---|---|---|---|
| 宿主注入 | wrapper / rules 目录 / AGENTS / TS 插件 | AGENTS.md + skills + bundle | 删适配层，收敛为一条注入路径 |
| 环 → skill | 固定委托 brainstorming → writing-plans、executing-plans / subagent | 同名 skills + subagent | 保留为 skill 内部步骤，删 dispatcher |
| 环 → 校验 | `openspec new/validate/archive` | 无对应能力 | **保留**，唯一不可替代 |
| 环 → 平台 | `gh`、DOP、`iam auth status` | bash/MCP + IAM 插件 + OTel | 改为插件/MCP，SDD 不直连 |
| 环 → git | commit-msg / pre-commit / pre-push / prepare 四件套 | DSH hooks + CI | 只留 commit-msg 或并入 CI |
| 环 → 遥测 | DOP 全生命周期埋点 | OTel session-log | 移出 SDD，归企业遥测 |

文中大量“固定委托链”在补偿宿主缺少产物契约——必须经 brainstorming、必须传路径约束、必须纠正 commit 格式。这些约束在 DSH 里应由**一个 skill 的模板 + 一个校验器**承担，而不是靠调用顺序。

### 6.2 治理层次收敛

| 原层 | 本质 | DSH 对应 | 结论 |
|---|---|---|---|
| L1 Data | 内容 | AGENTS.md / skill 文件 | 保留，瘦身 |
| L2 Injection | 分发 | 原生加载 | 删除 |
| L3 Plan gate | 流程约束 | plan mode 是软约束（工具仍全开），需靠 skill | 降为 skill 的一步 |
| L4 Analyze | 审查 | review skill + subagent | 保留，简化 |
| L5 Hooks | 强制 | hook bridge（PreToolUse exit 2 阻断/询问）+ permission + sandbox | 保留规则，删自研引擎 |
| L6 Amendment | 变更控制 | PR + CI | 保留模板，删 8 步命令 |
| L7 CI | 变更控制 | 仓库 CI | 保留 1 个 job |

压成三层：**契约层**（产物与格式）、**门禁层**（运行时拦截）、**交付层**（归档与 PR）。前两层是 DSH 的强项，第三层才是 SDD 的真正价值。

### 6.3 轻量形态

- 1 个 skill `sdd`：组合现有的 brainstorming / writing-plans / executing-plans / code-review-and-quality / test-driven-development / verification-before-completion，产出 proposal / spec / design / tasks。
- 1 个 CLI `sdd`（约 300 行）：封装 `openspec` 的 new / validate / freeze / stale / archive / pr-body。
- 1 份 hook 规则：5 条 HARD（密钥、force push、`rm -rf`、直编 `.env`）+ 6 条路径规则（各阶段只写允许的产物）。
- 1 个 CI job：validate + 指纹 + baseline lint。
- 0 宿主适配、0 五级保护控制面、0 遥测、0 git hooks 四件套。

### 6.4 保留与删除

保留（Harness 没有）：change-id 贯穿 branch / commit / PR / tracker；产物集与落点；freeze + SHA-256 指纹 + stale 传播；原子 PR（实现 + canonical spec + archive）；OVERRIDE 理由审计；按阶段限定的写保护。

删除（Harness 已吸收或不属于流程）：HostAdapter 注册表与四个宿主适配；五级保护状态机；`/sdd-constitution` 8 步；DOP 埋点与 queue；双阶段 Constitution 扫描；与流程无关的参考 skill（按需另立知识包）。

### 6.5 三条不变量

1. **一致性**：canonical spec 与代码不漂移（freeze / 指纹 / stale / archive）。
2. **原子性**：一次交付的 PR 同时包含实现、spec、归档。
3. **可追溯**：change-id 从需求到 PR 不断链。

环是过程，不变量是结果。Harness 可以随时优化过程，但不变量必须由契约守住。SDD 作为可选 Skill 包在 P2 并行推进，不进入 IAM / Kong / DevOps 关键路径。

## 7. 验收标准

| # | 验收项 | 判据 |
|---|---|---|
| A1 | Windows 首次登录 | 未登录时企业模型不可用（bundle 不保留其他模型路由）；登录后 30 秒内可完成一次对话 |
| A2 | 令牌刷新 | 过期后无需重启，下一次请求成功；两个进程同时运行不互相踢出 |
| A3 | 网关鉴权与额度 | 401 过期；consumer 可归因到 `sub`；人与 consumer 两个维度都能触发 429；body 为 problem+json 且 `quota_scope` 正确；DSH 不自动重试 |
| A4 | 客户端无网关 Key | 客户端仅持有 IAM token，网关上游 Key 不出现在任何客户端配置或日志 |
| A5 | 麒麟离线安装 | deb 安装后无需编译、无需外网即可启动并完成 OAuth |
| A6 | 麒麟沙箱 | 明确结论：bwrap 可用 / Landlock 可用 / 需自定义 runner；若不可用，必须显式选择降级模式并记录，不能靠静默放行 |
| A7 | DevOps 只读闭环 | 3 个只读工具对真实平台返回正确结果；写操作触发审批 |
| A8 | Gitee 只读闭环 | 仓库 / Issue / PR 查询可用，令牌按用户隔离 |
| A9 | 内部市场 | 公网 registry 不可达时仍能从内部源搜索、安装企业 bundle |
| A10 | 版本可控 | 客户端与插件版本固定；升级前跑兼容性门禁，失败可回滚 |
| A11 | 轻量 SDD | change-id 贯穿 branch/commit/PR；freeze 后改动标记 stale；PR 原子包含实现+spec+archive；无宿主适配与自研遥测 |
| A14 | 标准符合性 | PKCE + loopback IP；MCP token 带 `resource` 且 `aud` 匹配；HTTP server 暴露 PRM；401 可触发刷新重试 |

## 8. 风险与应对

| 风险 | 等级 | 处置 |
|---|---|---|
| 麒麟沙箱 fail closed，命令无法执行 | 高 | P0 先验；预装并验证 bwrap，或申请 userns，或提供企业 `runnerCommand` |
| `node-pty` 在 aarch64 需现场编译，安装失败 | 高 | 在 arm64 构建机预构建 profile，deb 内直接带 `node_modules` |
| 上游预发布节奏快，插件随版本失效 | 高 | 锁版本、内部镜像、`engines.dsh` 门禁、升级前回归 |
| IAM 为纯 OAuth2 无 OIDC | 中 | 用 userinfo / introspection 替代 ID Token 校验，约 +3–5 人日 |
| 网关额度语义与 DSH 展示不一致 | 中 | 对齐 429 / `Retry-After` 与额度查询接口；客户端不自动重试 429 |
| 网关 JWT 验签方式待确认 | 中 | P0 用真实 token 联调；不支持 JWKS 则改为 introspection |
| 凭据文件可被 agent 读取 | 中 | 短 TTL、最小 scope、网关侧撤销、终端出口管控 |
| 白标发行与官方更新策略冲突 | 中 | 一期用官方 App；确需白标时单独立项 |
| MCP 工具过多挤占上下文 | 中 | 按角色裁剪、只读优先、Skill 承载流程 |

## 9. 待确认事项

1. 企业 IAM 是 OIDC 还是纯 OAuth2？是否提供 discovery、JWKS、userinfo / introspection？
2. 是否允许 `http://127.0.0.1:<port>/oauth/callback` 这类 loopback 回调？端口是否必须固定？
3. 网关验 JWT 用 JWKS 还是 introspection？consumer 是按 `sub` 预置（IAM 同步）还是首次请求自动创建？
4. DevOps API 接受哪个 `aud` 的 token？是否需要 RFC 8693 token exchange？
5. 是否要求白标（换名 / 换 logo / 自建更新源）？这决定 Windows 走官方 App 还是自建 MSI。
6. 银河麒麟的具体版本、内核与 `uname -a` 输出（见附录 A）。
7. IAM 是否支持 RFC 8707 的 `resource` 参数？不支持时能否按 audience 预注册多个 client？
8. DevOps MCP 的 canonical URI 与 Protected Resource Metadata（RFC 9728）由谁实现与运维？
9. 人与 consumer 两个维度同时生效时的优先级与响应头（是否同时返回两侧剩余）？是否提供额度查询端点？

## 附录 A 银河麒麟兼容性验证脚本

只读，不修改系统。在目标麒麟机器上执行并保留完整输出。

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

- `aarch64` + glibc ≥ 2.28 + Node 24 可运行：基础通过。
- `bwrap-ok`：沙箱可用，按默认配置推进。
- `bwrap-fail` 且 `lsm` 含 `landlock`：走 Landlock runner。
- 两者都不可用：先定处置路径（装 bwrap / 开 userns / 自定义 runner），再进入 P1。

## 附录 B 参考资料

- [DSH 凭据子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/credentials.md)
- [公开部署与反向代理](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.md)
- [LiteLLM JWT → Virtual Key](https://docs.litellm.ai/docs/proxy/jwt_key_mapping)
- [oauth2-proxy 请求头集成](https://oauth2-proxy.github.io/oauth2-proxy/7.8.x/configuration/integration/)
- [EduWork dsh-oidc 文档](https://github.com/ECNU/EduWork/tree/main/packages/dsh-oidc/docs)

> 本文件为 Plan，实施完成后转为证据；当前 DSH 运行态与本机配置以仓库 SSOT 为准。