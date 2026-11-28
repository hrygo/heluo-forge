# 逐模块设计索引

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-002 |
| 文档名称 | 逐模块设计索引 |
| 版本 | V0.52.0 |
| 文档状态 | 生效 |
| 密级 | — |
| 编制 | DSH 平台组 |
| 负责 | 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-11-28 |
| 门禁 | — |

## 1. 结论

本索引覆盖 DSH 产品扩展包、凭据支撑包、原生插件市场与独立服务。市场状态见[索引契约 §1](<services/market-index.md#1-一页速览>)。文档状态见各设计正文的文档信息，也可用 `pnpm docs:catalog` 查询。实现与验证证据见 §2.2。个人网关访问采用 Key 加 IAM 令牌并核验当前人员与 DSH 用途，应用访问受控开通，五分钟撤权与当前授权退出待核验。企业 IAM 配置、终端预置与计划续期见下文跨模块设计和模块验证记录。

详细设计使用[模块设计模板](../templates/design-template.md)，外部字段级契约仍以[契约目录](../contracts/gateway-contract.md)为唯一真源，设计只引用不复制。

## 2. 安装包设计

| 包 | 形态 | 设计文档 |
|---|---|---|
| `@heluo/forge-iam` | Host + Client 插件 | [plugins/forge-iam.md](plugins/forge-iam.md) |
| `@heluo/forge-policy` | Host 插件 | [plugins/forge-policy.md](plugins/forge-policy.md) |
| `@heluo/forge-skills-manager` | Host + Client 插件 | [plugins/forge-skills-manager.md](plugins/forge-skills-manager.md) |
| `@heluo/forge-enterprise` | umbrella bundle（通用底座：企业账号与模型） | [plugins/forge-enterprise.md](plugins/forge-enterprise.md) |
| `@heluo/forge-engineering` | umbrella bundle（企业研发工具套件） | [plugins/forge-engineering.md](plugins/forge-engineering.md) |
| `@heluo/forge-gateway` | 配置 bundle | [plugins/forge-gateway.md](plugins/forge-gateway.md) |
| `@heluo/forge-hindsight` | Host + Client 插件 | [plugins/forge-hindsight.md](plugins/forge-hindsight.md) |
| `@heluo/forge-brand` | 配置 bundle | [plugins/forge-brand.md](plugins/forge-brand.md) |
| `@heluo/forge-devops` | CLI 接入（工具面 + 设置页 + 新会话变更选择器） | [plugins/forge-devops.md](plugins/forge-devops.md) |
| `@heluo/forge-devops-workbench` | Host + Client 插件 | [plugins/forge-devops-workbench.md](plugins/forge-devops-workbench.md) |
| `@heluo/forge-gitee` | CLI 接入（工具面 + 设置页） | [plugins/forge-gitee.md](plugins/forge-gitee.md) |
| `@heluo/forge-experts` | Host + Client 插件（规划） | [专家智能体管理插件详细设计](plugins/forge-experts.md) |
| `@heluo/forge-sdd` | 已退役（包与 CLI 已删除；非 Host） | [plugins/forge-sdd.md](plugins/forge-sdd.md) |
| 原生插件市场 | DSH 内置 + AIHUB 索引 | [plugins/forge-market.md](plugins/forge-market.md) |

本表登记模块与装载形态，不重复正文的生命周期和待确认项。模块准入读对应设计；实现与验证读 §2.2 的模块记录。设计文档落盘不表示模块已实现。

### 2.1 跨模块设计

[IAM 机密客户端认证设计](iam-confidential-isolated.md)覆盖 Host 受信来源、终端密钥预置和授权隔离；[机密认证契约](../contracts/iam-client-auth-isolated.md)定义配置与接口，[官方宿主集成方案](../architecture/public-enterprise-bundle.md#6-iam个人-key-与升级)定义私版配置边界。目标企业部署使用机密认证，实际登记、计划续期与目标终端安装仍须分别验收。

网关凭据设计横跨身份插件与网关配置，不属于单个包，单独成文：[网关凭据双模式支持设计](credential-modes.md)（CORP-DSH-DESIGN-001；采用路线 B 双因子协同，与应用凭据构成两类运行态，非运行时二选一回落；适配层 V1 由 `forge-iam` 受控模型运行时承载，`forge-gateway` 保留配置与抽离目标；上游规范未冻结）。


策略判定横跨策略引擎、内容规则与组织策略分发，单独成文：[策略判定模型设计](policy-model.md)（CORP-DSH-DESIGN-020；动作分类 + 内容规则 + 流程规则 + 身份与证据五轴，目录只登记六条写动作、读动作出闸，内容/流程/路径/确认各由独立开关控制且默认全关，`gitee.git.push` 与 DOP 状态流转在开关开启后经问答卡片确认，`gitee.review.record` 不由 Agent 发起；内容规则 ≤30 条正则、不做语义分析；流程事实源不可用时跳过并记 `unevaluated`）。组织策略以包内 `policy/` 数据目录的签名信封随包下发（[策略与审计详细设计 §5.1.4](plugins/forge-policy.md#514-组织策略数据目录2026-11-16)）：ed25519 验签、不设有效期、随补丁版本更新，不单独成数据包（签发权与发版权同在平台组，拆包的生命周期成本高于收益）。需求基线口径已按本文同步修订（V3.3.0，2026-11-20）：写动作按分类默认开放，拦截由八条独立开关逐条开启；范围票据已取消，确认走宿主问答卡片。
DSH 客户端标识（UA）同属跨模块，单独成文：[DSH 客户端标识（UA）方案设计](client-identification.md)（CORP-DSH-DESIGN-015；需求方决定使用 DSH 默认 UA，由网关按关键字匹配，不改写 UA；候选关键字、网关能力和代理链路待确认）。

企业设置菜单收敛与凭据统一跨多个插件与配置层，单独成文：[企业设置菜单统一与 Token 收敛详细设计](enterprise-menu-and-token-unification.md)（CORP-DSH-DESIGN-018；面向「智能个人助理 × 智能研发平台」一体双定位解耦架构，拆分为 `@heluo/forge-enterprise`（**企业账号与模型**）与 `@heluo/forge-engineering`（**企业研发工具套件**）两个独立可预装包：`设置 → 企业账号` 保持零研发耦合（无 `heluo.iam.credential-item` 研发条），DevOps 与 Gitee 的 Token 设置条目内置于各自研发面板中并在无 IAM 时静默降级；严格不修改 DSH 宿主；四包代码、UI 契约与合成宿主探针离线闭环；容器级状态/诊断聚合属后续项，企业网关、工具侧凭据库、GUI 和联邦换票专项证据待补充）。

市场的社区/官方源码调研与选型依据见[企业插件市场调研与落地建议](<../architecture/plugin-market-research.md>)；Gitee 侧能力澄清见[专题问询函](<../collaboration/gitee-market-clarification.md>)。原研究为历史证据，来源方向由 [ADR-11](<../architecture/plugin-registry-source-decision.md>)，轻量索引模式由 ADR-13 替代；契约与真实接入仍需分别验证；市场模式与当前状态见[索引契约 §1](<services/market-index.md#1-一页速览>)。

[企业研发全流程能力面](plugins/forge-devops-lifecycle.md)（DESIGN-013）统一六阶段地图、形态判定、人机双面、工程追溯、观察指标及开放决策。工具字段与事件字段分别见[工程工具契约](../contracts/engineering-tools.md)、[观察事件契约](../contracts/metrics-events.md)；不新增安装包，不代表内网接口或受控写已准入。

专用访问的完整决策比较及验收细化见[评审稿](../architecture/gateway-identity-review.md)，提供方问题见[网关新函](../collaboration/gateway-confirmation-letter.md)与[IAM 原函覆盖评估](../collaboration/iam-confirmation-letter.md#8-本轮需求覆盖评估与补充确认清单平台内部)。

[企业产物发布与分享设计](enterprise-artifact-publishing.md)（CORP-DSH-DESIGN-021）定义通用 HTML 发布、企业 IM 分享、DSH 收件及实施取证。 [金鱼审查证据](../engineering/reviews/enterprise-artifact-publishing-egm.md)

Delegra 侧的专家执行面横跨运行时镜像与 Kubernetes 沙箱，同属跨模块设计：[运行时镜像设计](delegra-runtime-images.md)（CORP-DSH-DESIGN-022）定义 17 个 `linux/arm64` 制品与按摘要选用；[Kubernetes 智能调度设计](delegra-k8s-scheduling.md)（CORP-DSH-DESIGN-024，V2.0.0）及其五份独立落地详设（[模块 1 路由与 ARM64](delegra-k8s-scheduling/01-profile-routing-arm64.md) CORP-DSH-DESIGN-024A、[模块 2 单向预热池](delegra-k8s-scheduling/02-warm-pool-sandbox-claim.md) CORP-DSH-DESIGN-024B、[模块 3 集群级零信任代理](delegra-k8s-scheduling/03-cluster-gateway-proxy-authz.md) CORP-DSH-DESIGN-024C、[模块 4 Cilium 与 Kata-FC](delegra-k8s-scheduling/04-cilium-isolation-kata-fc.md) CORP-DSH-DESIGN-024D、[模块 5 SSA 与弹性反压](delegra-k8s-scheduling/05-ssa-quota-backpressure.md) CORP-DSH-DESIGN-024E）定义按专家画像路由、`agent-sandbox v1beta1` 单向预热池、集群级零信任代理与逐请求撤权、Cilium/Kata-FC 硬隔离及 SSA 配额反压，三阶段分别由 `hrygo/Delegra` 的 #72、#73 与 #74、#75 与 #76 承接，本仓库按 [issue #420](https://github.com/hrygo/heluo-forge/issues/420) 跟踪并以 #394、#395、#397 验收。

### 2.2 实现与验证入口

按模块查阅当前实现与验证边界。模块记录区分本地离线用例、本机探针、历史实机和未验环境；任何一类证据都不能直接代替其他层级或生产准入。

| 模块 | 实现与验证记录 |
|---|---|
| `forge-iam` | [IAM 实现与验证记录](verification/forge-iam.md) |
| `forge-skills-manager` | [技能管理器实现与验证记录](verification/forge-skills-manager.md) |
| `forge-credentials-keychain` | [凭据存储实测边界](verification/forge-credentials-keychain.md) |
| `forge-policy` | [策略与审计实测边界](verification/forge-policy.md) |
| `forge-experts` | [专家智能体实现与验证记录](verification/forge-experts.md) |
| `forge-enterprise` | [企业账号与模型组合](plugins/forge-enterprise.md#实现与验证记录) |
| `forge-brand` | [品牌与外观实现与验证记录](plugins/forge-brand.md#实现与验证记录) |
| `forge-engineering` | [研发工具组合](plugins/forge-engineering.md#实现与验证记录) |
| `forge-devops` | [DevOps 接入](plugins/forge-devops.md#实现与验证记录) |
| `forge-devops-workbench` | [DOP 工作台实现与验证记录](plugins/forge-devops-workbench.md#实现与验证记录) |
| `forge-gitee` | [Gitee 接入](plugins/forge-gitee.md#实现与验证记录) |
| `forge-market`（历史参考包） | [历史实现及证据边界](plugins/forge-market.md#11-历史参考实现不属目标) |
| `market-index` | [只读索引校验器](services/market-index.md#实现与验证记录) |
| `forge-sdd`（已退役） | [历史验证与开放项](plugins/forge-sdd.md#8-验证与开放项) |
| DSH 客户端标识 | [UA 实现落点与验证](client-identification.md#9-实现落点与验证) |

### 2.2.1 IAM 离线验收清单

见 [IAM 离线验收清单](verification/forge-iam.md#iam-离线验收清单)。

#### 按策略关闭项与剩余可模拟项

见 [IAM 决定与剩余边界](verification/forge-iam.md#按策略关闭项与剩余可模拟项)。

五条跨模块冲突（policy fail-open、无 policy 降只读、审计失败是否阻断、SDD 本地／CI 双路径、历史市场行与 SDD 挂载口径）的定位与结论见[跨模块冲突收口](conflict-resolution.md)（DESIGN-014）；**五条已由责任方 2026-10-24 逐条确认**——确认的是组织做法，不等于企业能力已联调（C4 的 CI 侧、C5 的安装与依赖事实仍待证据），也不放开任何受控写。

## 3. 独立服务设计

| 服务 | 代码位置 | 设计文档 | 状态 | 主要待确认 |
|---|---|---|---|---|
| DevOps MCP 服务 | `services/devops-mcp/` | [services/devops-mcp.md](services/devops-mcp.md) | 条件建设，当前不建设 | CLI 前提不成立时先评审形态变更、范围与成本，批准后才启动 |
| 索引契约与校验 | `services/market-index/` | [services/market-index.md](services/market-index.md) | 评审稿；只读校验器可用 | AIHUB 索引 URL/JSON/更新 SLA、Artifactory 终端认证与三目标安装待验 |
| 河洛 Forge 企业版桌面壳 | `services/forge-desktop/` | [services/desktop-shell.md](services/desktop-shell.md) | 草案；模块、用例与清单已具备（状态：可用），Electron 运行与打包链未验证 | 锁定版 launch URL 形态、Electron 内嵌 Node 下的凭据存储、独占 profile `heluo-desktop` 与固定端口的真机冒烟、三平台打包链以计划 CORP-DSH-PLAN-026 的 P0 探针为准 |

[ADR-11/13](<../architecture/plugin-registry-source-decision.md>)已确认企业 npm 为唯一 npm 源与 AIHUB 原生索引；企业私版也可经内部文件交付；007/012 为评审稿，不以文档定版代表准入。本项目不建生成器、服务、写前授权或全通道强制；市场模式与当前状态见[索引契约 §1](<services/market-index.md#1-一页速览>)。部署与运维边界见[部署说明](../../deploy/README.md)。

## 4. 设计顺序

依赖方向决定顺序：身份与策略先定，组合包最后收敛。

```text
forge-iam → forge-policy → forge-enterprise
forge-policy + forge-devops + forge-gitee → forge-engineering
forge-gateway → forge-brand → forge-market
forge-devops → CLI 前提核验 → 形态评审获准后才建设 devops-mcp
forge-gitee → 历史 SDD 兼容（已删除）
AIHUB 索引 JSON → DSH 原生市场的目录来源
```

- 身份与策略改变工具管线行为，先设计，避免其他包按错误假设返工。
- 组合包依赖各成员包的入口与禁用语义，最后设计。
- 市场不再自建目录服务或接入包；索引契约与 AIHUB 交付单独验收。

## 5. 完成判据

一份模块设计可进入实现，需要同时满足：

1. 目标 DSH 版本、SDK 与真实接口已核验，并记录核验方式与日期。
2. 权限、凭据、数据生命周期与失败模式写明可判定行为。
3. 配置 schema、导出面与兼容策略明确，未定项列入待确认。
4. 测试矩阵覆盖正常、异常、并发与退出路径。
5. 关联需求与验收条目可追溯，不新增未批准范围。

未满足时不创建 `package.json`，也不把目录状态改为“可用”。

## 6. 维护约定

- 模块新增、装载形态和跨模块设计变化更新索引；单模块实现、验证和未验项维护在 §2.2 链接指向的模块记录，不在索引复写。实现与设计不一致时，先核对并更新设计。
- 模块设计不复制网关、IAM 等外部契约字段，使用相对链接引用。
- 模块设计编号复用对应域编号；无域编号的组合包使用 `DESIGN` 系列。
- 设计优先复用企业既有资产（CLI、制品库、审批单、身份能力）；确需自建时写明既有资产为何不适用。
- 设计实现前必须核验目标接口；无法核验的接口形状标注"待实测"。
- 增益不明确、需用户确认的选项单列保留，不阻塞主链路实现。
- 新增模块先在本表登记，再创建目录与设计文档。
