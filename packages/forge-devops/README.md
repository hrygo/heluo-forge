# @heluo/forge-devops

状态：规划

| 项 | 内容 |
|---|---|
| 形态 | MCP 接入 bundle（目标为 HTTP，P1 可先用本地 stdio 验证工具面） |
| 职责 | 接入 DevOps MCP 工具面、按请求取得目标资源令牌、声明工具可见性 |
| 不负责 | 不内置平台凭据，不接入生产写工具，不替代平台权限 |
| 衔接点 | `mcp-client` |
| 服务实现 | [services/devops-mcp](../../services/devops-mcp/README.md) |
| 详细设计 | `docs/design/plugins/forge-devops.md`（待编写，见[设计索引](../../docs/design/README.md)） |
| 实现状态 | 尚未建立 `package.json`、源码与测试 |

## 边界

- 只读查询工具面，以用户故事/需求读取为主；具体清单、字段与数量以 DevOps 提供方澄清为准，不预设；不接入生产写工具。
- HTTP server 按 MCP 规范暴露受保护资源元数据，并校验令牌受众。
- 用户故事/需求是规格生成的主要输入，字段范围以提供方确认为准。
- 超时、断流或无法确认未执行时不盲目重放，按冻结规则处理。