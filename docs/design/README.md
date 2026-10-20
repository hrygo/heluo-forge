# 逐模块设计索引

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-002 |
| 文档名称 | 逐模块设计索引 |
| 版本 | V0.1 |
| 文档状态 | 生效 |
| 密级 | 内部 |
| 编制 | DSH 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-10-20 |
| 门禁 | — |

## 修订记录

| 版本 | 日期 | 修订人 | 修订说明 |
|---|---|---|---|
| V0.1 | 2026-10-20 | DSH 平台组 | 建立九个安装包与两个独立服务的详细设计索引、依赖顺序与完成判据；详细设计尚未开始 |

## 1. 结论

本索引管九个安装进 DSH 的包与两个独立运行的服务。每个模块先完成详细设计，再建立包清单与源码；设计未完成或接口未核验时，`packages/` 与 `services/` 中对应目录只保留职责说明。

详细设计使用[模块设计模板](../templates/design-template.md)，外部字段级契约仍以[契约目录](../contracts/gateway-contract.md)为唯一真源，设计只引用不复制。

## 2. 安装包设计

| 包 | 形态 | 设计文档 | 状态 | 主要待确认 |
|---|---|---|---|---|
| `@corp/dsh-iam` | Host + Client 插件 | `plugins/dsh-iam.md` | 待设计 | 授权流程与 OIDC 能力、令牌 broker、凭据存储、账户 UI |
| `@corp/dsh-policy` | Host 插件 | `plugins/dsh-policy.md` | 待设计 | 门禁挂点、`$DSH_HOME` 硬拒绝、外发确认、审计字段 |
| `@corp/dsh-enterprise` | umbrella bundle | `plugins/dsh-enterprise.md` | 待设计 | 组合顺序、依赖检查、角色 preset 与默认禁用项 |
| `@corp/dsh-gateway` | 配置 bundle | `plugins/dsh-gateway.md` | 待设计 | 模型白名单、错误与重试配置、流式行为 |
| `@corp/dsh-brand` | 配置 bundle | `plugins/dsh-brand.md` | 待设计 | 品牌 token 覆盖范围、白标边界 |
| `@corp/dsh-devops` | MCP 接入 bundle | `plugins/dsh-devops.md` | 待设计 | 工具面、服务端授权、按请求取 token |
| `@corp/dsh-gitee` | MCP 接入 bundle | `plugins/dsh-gitee.md` | 待设计 | 上游复用、arm64 构建、凭据来源 |
| `@corp/dsh-sdd` | Skill pack + CLI | `plugins/dsh-sdd.md` | 待设计 | 产物契约、freeze 与指纹、路径规则 |
| `@corp/dsh-market` | 配置 bundle | `plugins/dsh-market.md` | 待设计 | 私有源配置、安装策略、兼容校验 |

设计文档路径相对本目录。详细设计落盘时才创建 `plugins/` 目录与对应文件，不预建空文件。

## 3. 独立服务设计

| 服务 | 代码位置 | 设计文档 | 状态 | 主要待确认 |
|---|---|---|---|---|
| DevOps MCP 服务 | `services/devops-mcp/` | `services/devops-mcp.md` | 待设计 | 传输协议、PRM 元数据、平台审批单、幂等与查单 |
| 市场目录与发布控制 | `services/market-index/` | `services/market-index.md` | 待设计 | 目录 schema、校验规则、发布状态与回退通道 |

私有 npm 制品仓库不是自研服务，优先复用企业现有 registry，部署与运维边界见[部署说明](../../deploy/README.md)。

## 4. 设计顺序

依赖方向决定顺序：身份与策略先定，组合包最后收敛。

```text
dsh-iam → dsh-policy → dsh-enterprise
dsh-gateway → dsh-brand → dsh-market
dsh-devops → devops-mcp 服务
dsh-gitee → dsh-sdd
market-index 服务 → dsh-market 的目录来源
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
- 新增模块先在本表登记，再创建目录与设计文档。