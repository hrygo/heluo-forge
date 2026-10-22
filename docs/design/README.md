# 逐模块设计索引

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-002 |
| 文档名称 | 逐模块设计索引 |
| 版本 | V0.6.0 |
| 文档状态 | 生效 |
| 密级 | — |
| 编制 | DSH 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-10-22 |
| 门禁 | — |

## 1. 结论

本索引管八个 DSH 扩展包、原生插件市场与两个独立服务入口。市场已切换为轻量模式：DSH 原生索引源 + AIHUB 托管 format-1 JSON，不再要求自定义市场插件；`forge-market` 与旧 HTTP 服务为历史参考，`market-index` 只保留只读索引校验器。其余设计仍为草案；设计状态、代码实现与上线准入分别判断。

详细设计使用[模块设计模板](../templates/design-template.md)，外部字段级契约仍以[契约目录](../contracts/gateway-contract.md)为唯一真源，设计只引用不复制。

## 2. 安装包设计

| 包 | 形态 | 设计文档 | 设计状态 | 主要待确认 |
|---|---|---|---|---|
| `@heluo/forge-iam` | Host + Client 插件 | [plugins/forge-iam.md](plugins/forge-iam.md) | 草案（O3 独占） | 官方四行禁用实验、IAM `resource`/轮换/撤销、0600 存储风险、最小 UI 范围 |
| `@heluo/forge-policy` | Host 插件 | [plugins/forge-policy.md](plugins/forge-policy.md) | 草案 | 拦截钩子实测、策略与沙箱叠加顺序、审批注册、`$DSH_HOME` 范围 |
| `@heluo/forge-enterprise` | umbrella bundle | [plugins/forge-enterprise.md](plugins/forge-enterprise.md) | 草案 | 版本断言报错形态、`fiberPhase`、角色 preset 粒度、官方四行禁用实验 |
| `@heluo/forge-gateway` | 配置 bundle | [plugins/forge-gateway.md](plugins/forge-gateway.md) | 草案 | 重试插件边界实测、流式取消、错误体一致性、设备标识上报 |
| `@heluo/forge-brand` | 配置 bundle | [plugins/forge-brand.md](plugins/forge-brand.md) | 草案 | token 清单实测、双端资源路径、子品牌与合规页脚 |
| `@heluo/forge-devops` | CLI 接入（工具面） | [plugins/forge-devops.md](plugins/forge-devops.md) | 草案 | aarch64 产物、凭据注入、结构化输出、只读命令面 |
| `@heluo/forge-gitee` | CLI 接入（工具面） | [plugins/forge-gitee.md](plugins/forge-gitee.md) | 草案 | aarch64 产物、环境变量鉴权、JSON 稳定性、命令面 |
| `@heluo/forge-sdd` | Skill pack + CLI | [plugins/forge-sdd.md](plugins/forge-sdd.md) | 草案 | CI 触发方式、原子提交边界、产物与需求编号联动 |
| 原生插件市场 | DSH 内置 + AIHUB 索引 | [plugins/forge-market.md](plugins/forge-market.md) | 评审稿（轻量模式） | AIHUB 托管 format-1 索引、原生添加 URL、官方 manager 安装；三目标安装与索引交付待验；`@heluo/forge-market` 为历史参考 |

设计文档路径相对本目录；正文均已落盘，不表示对应包或市场已实现。

### 2.1 跨模块设计

网关凭据双模式横跨身份插件与网关配置，不属于单个包，单独成文：[网关凭据双模式支持设计](credential-modes.md)（CORP-DSH-DESIGN-001，V0.1 草案）。

市场的社区/官方源码调研与选型依据见[企业插件市场调研与落地建议](<../architecture/plugin-market-research.md>)；Gitee 侧能力澄清见[专题问询函](<../collaboration/gitee-market-clarification.md>)。原研究为历史证据，来源方向由 [ADR-11](<../architecture/plugin-registry-source-decision.md>)，轻量索引模式由 ADR-13 替代；契约与真实接入仍需分别验证。

[企业研发全流程能力面](plugins/forge-devops-lifecycle.md)（草案，DESIGN-013）统一六阶段地图、形态判定、人机双面、工程追溯、观察指标及开放决策。工具字段与事件字段分别见[工程工具契约](../contracts/engineering-tools.md)、[观察事件契约](../contracts/metrics-events.md)；不新增安装包，不代表内网接口或受控写已准入。

### 2.2 实现与验证入口

| 模块 | 当前实现 | 验证边界 |
|---|---|---|
| [forge-market](../../packages/forge-market/README.md) | 历史参考包：十个工具、Host 路由、面板、归档安装链路；不属轻量模式目标 | 离线测试保留；不得作为原生索引链路的实现证据 |
| [market-index](../../services/market-index/README.md) | 只读 format-1 索引校验器；无服务、无生成器 | 13 项离线测试通过；未验证 AIHUB 真实索引或企业安装 |
| 其余八包与 DevOps MCP | 规划入口，无清单、源码或测试 | 对应设计中的测试矩阵为目标，不是执行结果 |

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
