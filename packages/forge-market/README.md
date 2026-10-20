# @heluo/forge-market

状态：可用

| 项 | 内容 |
|---|---|
| 形态 | 配置 bundle |
| 职责 | 配置私有市场来源、安装策略与兼容校验 |
| 不负责 | 不实现目录服务，不自研 registry，不提供额外市场 UI |
| 衔接点 | `plugin-market`、`plugin-manager` |
| 服务实现 | 不建设：企业已有制品库，见 [DESIGN-012](../../docs/design/services/market-index.md) |
| 详细设计 | [DESIGN-007](../../docs/design/plugins/forge-market.md) |
| 实现状态 | 安装策略逻辑与单元测试已建立；bundle 接线待上游配置项核验 |

## 边界

- 只指向企业内部 index 与 registry，不配置公网源，也不做自动回退。
- 安装前校验包名白名单、checksum 与 `engines.dsh` 兼容性。
- 只读与受限角色禁用插件管理工具；开发者可从内部已审批源安装。
- 目录与制品由服务端和市场流程控制，客户端配置不是发布权限。