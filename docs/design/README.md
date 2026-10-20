# 逐模块设计索引

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-002 |
| 文档名称 | 逐模块设计索引 |
| 版本 | V0.1.19 |
| 文档状态 | 生效 |
| 密级 | 内部 |
| 编制 | DSH 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-10-20 |
| 门禁 | — |

## 1. 结论

本索引管九个安装进 DSH 的包与两个独立运行的服务。每个模块先完成详细设计，再建立包清单与源码；设计未完成或接口未核验时，`packages/` 与 `services/` 中对应目录只保留职责说明。

详细设计使用[模块设计模板](../templates/design-template.md)，外部字段级契约仍以[契约目录](../contracts/gateway-contract.md)为唯一真源，设计只引用不复制。

## 2. 安装包设计

| 包 | 形态 | 设计文档 | 状态 | 主要待确认 |
|---|---|---|---|---|
| `@heluo/forge-iam` | Host + Client 插件 | [plugins/forge-iam.md](plugins/forge-iam.md) | 草案 | 提供者 API 实测、账户页 slot、IAM 的 `resource` 与轮换能力 |
| `@heluo/forge-policy` | Host 插件 | [plugins/forge-policy.md](plugins/forge-policy.md) | 草案 | 拦截钩子实测、策略与沙箱叠加顺序、审批注册、`$DSH_HOME` 范围 |
| `@heluo/forge-enterprise` | umbrella bundle | [plugins/forge-enterprise.md](plugins/forge-enterprise.md) | 草案 | 版本断言报错形态、`fiberPhase`、角色 preset 粒度、默认禁用清单 |
| `@heluo/forge-gateway` | 配置 bundle | [plugins/forge-gateway.md](plugins/forge-gateway.md) | 草案 | 重试插件边界实测、流式取消、错误体一致性、设备标识上报 |
| `@heluo/forge-brand` | 配置 bundle | [plugins/forge-brand.md](plugins/forge-brand.md) | 草案 | token 清单实测、双端资源路径、子品牌与合规页脚 |
| `@heluo/forge-devops` | CLI 接入（工具面） | [plugins/forge-devops.md](plugins/forge-devops.md) | 草案 | aarch64 产物、凭据注入、结构化输出、只读命令面 |
| `@heluo/forge-gitee` | CLI 接入（工具面） | [plugins/forge-gitee.md](plugins/forge-gitee.md) | 草案 | aarch64 产物、环境变量鉴权、JSON 稳定性、命令面 |
| `@heluo/forge-sdd` | Skill pack + CLI | [plugins/forge-sdd.md](plugins/forge-sdd.md) | 草案 | CI 触发方式、原子提交边界、产物与需求编号联动 |
| `@heluo/forge-market` | 客户端插件（fork 改造） | [plugins/forge-market.md](plugins/forge-market.md) | 草案 | 面板注册方式、卡片可复用范围、归档可直接安装、镜像策略 |

设计文档路径相对本目录。详细设计落盘时才创建 `plugins/` 目录与对应文件，不预建空文件。

### 2.1 跨模块设计

网关凭据双模式横跨身份插件与网关配置，不属于单个包，单独成文：[网关凭据双模式支持设计](credential-modes.md)（CORP-DSH-DESIGN-001，V0.1 草案）。

## 3. 独立服务设计

| 服务 | 代码位置 | 设计文档 | 状态 | 主要待确认 |
|---|---|---|---|---|
| DevOps MCP 服务 | `services/devops-mcp/` | [services/devops-mcp.md](services/devops-mcp.md) | 条件建设 | 取决于 CLI 三项前提；满足任一才启动 |
| 插件市场服务 | `services/market-index/` | [services/market-index.md](services/market-index.md) | 规划 | Gitee 检索字段、发现范围、评审归属、部署方式 |

私有 npm 制品仓库不是自研服务，优先复用企业现有 registry，部署与运维边界见[部署说明](../../deploy/README.md)。

## 4. 设计顺序

依赖方向决定顺序：身份与策略先定，组合包最后收敛。

```text
forge-iam → forge-policy → forge-enterprise
forge-gateway → forge-brand → forge-market
forge-devops → devops-mcp 服务
forge-gitee → forge-sdd
market-index 服务 → forge-market 的目录来源
```

- 身份与策略改变工具管线行为，先设计，避免其他包按错误假设返工。
- 组合包依赖各成员包的入口与禁用语义，最后设计。
- 市场目录服务与市场接入包分别设计后再对接协议。

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