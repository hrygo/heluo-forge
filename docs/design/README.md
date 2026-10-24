# 逐模块设计索引

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-002 |
| 文档名称 | 逐模块设计索引 |
| 版本 | V0.9.9 |
| 文档状态 | 生效 |
| 密级 | — |
| 编制 | DSH 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-10-24 |
| 门禁 | — |

## 1. 结论

本索引管九个 DSH 产品扩展包、一个凭据支撑包、原生插件市场与两个独立服务入口。市场已切换为轻量模式：DSH 原生索引源 + AIHUB 托管 format-1 JSON，不再要求自定义市场插件；`forge-market` 与旧 HTTP 服务为历史参考，`market-index` 只保留只读索引校验器。其余设计仍为草案；设计状态、代码实现与上线准入分别判断。2026-10-23 ADR-16 将个人访问目标调整为当前人员与 DSH 用途校验，A 纯令牌 / B Key＋令牌待选；应用访问受控开通，五分钟撤权与当前授权退出待核验。原 Key-only 实现状态不因此改写为新能力已完成。

详细设计使用[模块设计模板](../templates/design-template.md)，外部字段级契约仍以[契约目录](../contracts/gateway-contract.md)为唯一真源，设计只引用不复制。

## 2. 安装包设计

| 包 | 形态 | 设计文档 | 设计状态 | 主要待确认 |
|---|---|---|---|---|
| `@heluo/forge-iam` | Host + Client 插件 | [plugins/forge-iam.md](plugins/forge-iam.md) | 草案（O3 独占；Host+Client 骨架、OIDC mock 流程、网关凭据录入/清除/状态、模型门禁与默认模型判定、默认模型写入接线（写前独立复查、绝不覆盖显式企业选择）、禁用插件/独占冲突 fail closed 实测已落地；对真实 `saveSelection` 的受控写与 Remote/watch 未实现） | IAM 回函、OS keychain adapter、官方四行运行时模型面、真实联调、UAG 凭据探测 |
| `@heluo/forge-policy` | Host 插件 | [plugins/forge-policy.md](plugins/forge-policy.md) | 草案（接口契约已按 live Host 核验；宿主探针 32/32 覆盖 guard/pre-execute/result/命令面/审批/卸载/五类开关/委托承接/真实委派继承；委托与确认生命周期含恢复·分叉·子 Agent 复验已实现） | 有模型提供方的环境里子 Agent“模型自决调用”实测、策略与沙箱叠加顺序、审批注册与超时、`$DSH_HOME` 范围 |
| `@heluo/forge-enterprise` | umbrella bundle | [plugins/forge-enterprise.md](plugins/forge-enterprise.md) | 草案（策略为硬依赖，无只读降级；市场不插入历史插件行；按需技能/条款装配、包体闭包检查、五类开关声明与判定、官方行回灌检测已实现；官方四行禁用与装/升/退/卸演练已实测；真机 `dsh plugin` profile 级安装、rc.2→rc.3 升级循环与回退/卸载残留、四层组合层序与 `--from-default-profile` 整体替换已实测；企业能力行仍不挂载（补丁无 `insert:` 段）） | 版本断言报错形态、`fiberPhase`、双端、企业索引源键名、`ai-publish`/`human-review` 业务行（未落地故 `blocked`）、角色 preset 粒度、`desktop` profile |
| `@heluo/forge-gateway` | 配置 bundle | [plugins/forge-gateway.md](plugins/forge-gateway.md) | 草案（目标路线待选） | 当前身份/用途、A/B 承载、应用/IP、五分钟及单授权退出、C4 等效策略与容量联调 |
| `@heluo/forge-brand` | 配置 bundle | [plugins/forge-brand.md](plugins/forge-brand.md) | 草案 | token 清单实测、双端资源路径、子品牌与合规页脚 |
| `@heluo/forge-devops` | CLI 接入（工具面） | [plugins/forge-devops.md](plugins/forge-devops.md) | 草案 | 系统变更/独立验收映射、aarch64 产物、凭据/输出；受控写范围、C3 分类与回查待批待验 |
| `@heluo/forge-gitee` | CLI 接入（工具面） | [plugins/forge-gitee.md](plugins/forge-gitee.md) | 草案 | aarch64 产物、鉴权/JSON；常规研发/评审写范围、C3 分类、可信来源与版本绑定待批待验 |
| `@heluo/forge-sdd` | 最小企业指引 + 必要 CLI/CI 校验 | [plugins/forge-sdd.md](plugins/forge-sdd.md) | 草案（单一规则集：本地前置校验 + CI 权威结论；交付清单 freeze/verify 骨架已实现） | 企业 CI 接入与权威结论、归档联动；不固定工具数量 |
| 原生插件市场 | DSH 内置 + AIHUB 索引 | [plugins/forge-market.md](plugins/forge-market.md) | 评审稿（轻量模式；`dsh plugin` 转发 pnpm 的安装/卸载参数已真机实测） | AIHUB 托管 format-1 索引、原生添加 URL、官方 manager 安装；三目标安装与索引交付待验；`@heluo/forge-market` 为历史参考 |

设计文档路径相对本目录；正文均已落盘，不表示对应包或市场已实现。

### 2.1 跨模块设计

网关凭据设计横跨身份插件与网关配置，不属于单个包，单独成文：[网关凭据双模式支持设计](credential-modes.md)（CORP-DSH-DESIGN-001，V0.3.0 评审稿；A/B 候选均待核验，不是运行时二选一回落）。

市场的社区/官方源码调研与选型依据见[企业插件市场调研与落地建议](<../architecture/plugin-market-research.md>)；Gitee 侧能力澄清见[专题问询函](<../collaboration/gitee-market-clarification.md>)。原研究为历史证据，来源方向由 [ADR-11](<../architecture/plugin-registry-source-decision.md>)，轻量索引模式由 ADR-13 替代；契约与真实接入仍需分别验证。

[企业研发全流程能力面](plugins/forge-devops-lifecycle.md)（草案，DESIGN-013）统一六阶段地图、形态判定、人机双面、工程追溯、观察指标及开放决策。工具字段与事件字段分别见[工程工具契约](../contracts/engineering-tools.md)、[观察事件契约](../contracts/metrics-events.md)；不新增安装包，不代表内网接口或受控写已准入。

专用访问的完整决策比较及验收细化见[评审稿](../architecture/gateway-identity-review.md)，提供方问题见[网关新函](../collaboration/gateway-confirmation-letter.md)与[IAM 原函覆盖评估](../collaboration/iam-confirmation-letter.md#8-本轮需求覆盖评估与补充确认清单平台内部)。

### 2.2 实现与验证入口

以下保留既有实现/实测记录，未因本轮文档调整重新实机核验；不能证明 ADR-16 的目标令牌、归属一致、用途及单授权生命周期已经实现。

| 模块 | 当前实现 | 验证边界 |
|---|---|---|
| [forge-iam](../../packages/forge-iam/README.md) | Host + Client 开发骨架：状态机、凭据记录、独占断言、OIDC 登录/回调/刷新/撤销、账户页/onboarding/横幅、网关凭据录入/清除/状态；探测未实现 | 本地 mock OIDC 端到端测试与全仓离线检查通过；真实 IAM 未联调，Client 走 interim route；无 UAG 联调 |
| [forge-credentials-keychain](../../packages/forge-credentials-keychain/README.md) | keychain provider 开发骨架：backend 契约、内存/不可用/显式 0600 file backend、records/refs、旧 0600 → 钥匙串迁移协调器 | 离线测试通过；macOS Security CLI spike 与迁移演练（仅副本）9/9 通过；Windows/UOS/麒麟 adapter 与真实凭据迁移未实现 |
| [forge-market](../../packages/forge-market/README.md) | 历史参考包：十个工具、Host 路由、面板、归档安装链路；不属轻量模式目标 | 离线测试保留；不得作为原生索引链路的实现证据 |
| [market-index](../../services/market-index/README.md) | 只读 format-1 索引校验器；无服务、无生成器 | 13 项离线测试通过；未验证 AIHUB 真实索引或企业安装 |
| [forge-policy](../../packages/forge-policy/README.md) | Host 策略门禁骨架：受控动作目录、`tools.guard` 单调硬拒绝、`tools/pre-execute` 待确认动作、受保护路径与 `$DSH_HOME` 硬拒绝、命令面同一判定、决策审计前置；8 个源文件 | `node --test packages/forge-policy/test/` 94 例通过；宿主探针（`scripts/probe/run-host-probe.mjs`）已实测 guard 拒绝零副作用、异步 pre-execute、子 Agent 作用域 guard 继承与父视图 `restrict` 不继承、门禁合成查询与受保护路径拒绝。模型门禁探针（`scripts/probe/model-guard-probe.mjs`）已实测**模型自决调用不会绕开门禁**：`unregistered-action`/`action-disabled`/`target-required` 三种模式各以会话记录中的 `tool/call`+`tool/result` 为据、副作用为零，并以不挂策略的正向对照证明模型确实会调用；同时暴露目录只认调用参数 `target`、真实工具（`bash` 的 `command`、`fs` 的 `path`）无法放行的缺口（见设计 §9.2.2）。沙箱叠加顺序探针（`scripts/probe/sandbox-order-probe.mjs`）已实测**策略门禁先于沙箱执行器判定**（策略拒绝归因不带沙箱信号、目标在沙箱允许区内也不产生副作用；越界写由操作系统级拒绝），见设计 §9.2.3。**未测**：经委托（子 Agent）发起的模型自决调用；未接企业环境、无双端实机 |
| [forge-enterprise](../../packages/forge-enterprise/README.md) | 企业组合 bundle：官方四行禁用补丁、配置整体替换、回灌检测（未知状态按 fail-closed 处理）、角色配置恢复；4 个源文件 | `node --test packages/forge-enterprise/test/` 25 例通过；真机安装/升级/回滚/卸载与残留、四层补丁层序与 `--from-default-profile` 已实测（任务 `20261024T023419Z-dsh-install-c8c2`、`20261024T025338Z-dsh-profile-replace-eb4e`）。**未验**：禁用四行后 shell/settings/onboarding/模型选择是否完整、角色 preset 粒度、`desktop` profile（应用独占管理） |
| [forge-sdd](../../packages/forge-sdd/README.md) | SDD 规则集与本地前置校验：规则版本、结果归因、与 CI 同一规则集；4 个源文件 | `node --test packages/forge-sdd/test/` 20 例通过；**未联调**企业 CI，本地结论只作前置校验、不替代 CI 权威结论 |
| 其余四包与 DevOps MCP（forge-brand / forge-devops / forge-gateway / forge-gitee、`services/devops-mcp`） | 规划入口，无清单、源码或测试 | 对应设计中的测试矩阵为目标，不是执行结果 |

五条跨模块冲突（policy fail-open、无 policy 降只读、审计坏是否影响执行、SDD 双路径、历史市场行）的定位与代拟结论见[跨模块冲突收口](conflict-resolution.md)（DESIGN-014）；结论待责任方确认，确认前不按已批准引用。

## 3. 独立服务设计

| 服务 | 代码位置 | 设计文档 | 状态 | 主要待确认 |
|---|---|---|---|---|
| DevOps MCP 服务 | `services/devops-mcp/` | [services/devops-mcp.md](services/devops-mcp.md) | 条件建设，当前不建设 | CLI 前提不成立时先评审形态变更、范围与成本，批准后才启动 |
| 索引契约与校验 | `services/market-index/` | [services/market-index.md](services/market-index.md) | 评审稿；只读校验器可用 | AIHUB 索引 URL/JSON/更新 SLA、Artifactory 终端认证与三目标安装待验 |

[ADR-11/13](<../architecture/plugin-registry-source-decision.md>)已确认企业 npm 唯一源与 AIHUB 原生索引；007/012 为评审稿，企业审核/批准待定，不以文档定版代表准入。本项目不建生成器、服务、写前授权或全通道强制；旧插件/HTTP 服务仅历史参考。部署与运维边界见[部署说明](../../deploy/README.md)。

## 4. 设计顺序

依赖方向决定顺序：身份与策略先定，组合包最后收敛。

```text
forge-iam → forge-policy → forge-enterprise
forge-gateway → forge-brand → forge-market
forge-devops → CLI 前提核验 → 形态评审获准后才建设 devops-mcp
forge-gitee → forge-sdd
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

- 设计变更同步更新本表状态；实现与设计不一致时，先改设计再改代码。
- 模块设计不复制网关、IAM 等外部契约字段，使用相对链接引用。
- 模块设计编号复用对应域编号；无域编号的组合包使用 `DESIGN` 系列。
- 设计优先复用企业既有资产（CLI、制品库、审批单、身份能力）；确需自建时写明既有资产为何不适用。
- 设计实现前必须核验目标接口；无法核验的接口形状标注"待实测"。
- 增益不明确、需用户确认的选项单列保留，不阻塞主链路实现。
- 新增模块先在本表登记，再创建目录与设计文档。
