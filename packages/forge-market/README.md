# @heluo/forge-market

状态：规划

| 项 | 内容 |
|---|---|
| 形态 | 配置 bundle |
| 职责 | 配置私有市场来源、安装策略与兼容校验 |
| 不负责 | 不实现目录服务，不自研 registry，不提供额外市场 UI |
| 衔接点 | `plugin-market`、`plugin-manager` |
| 服务实现 | [services/market-index](../../services/market-index/README.md) |
| 详细设计 | `docs/design/plugins/forge-market.md`（待编写，见[设计索引](../../docs/design/README.md)） |
| 实现状态 | 尚未建立 `package.json`、源码与测试 |

## 边界

- 只指向企业内部 index 与 registry，不配置公网源，也不做自动回退。
- 安装前校验包名白名单、checksum 与 `engines.dsh` 兼容性。
- 只读与受限角色禁用插件管理工具；开发者可从内部已审批源安装。
- 目录与制品由服务端和市场流程控制，客户端配置不是发布权限。