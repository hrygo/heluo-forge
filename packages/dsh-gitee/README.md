# @corp/dsh-gitee

状态：规划

| 项 | 内容 |
|---|---|
| 形态 | MCP 接入 bundle（stdio） |
| 职责 | 复用上游 Gitee MCP 实现，提供 arm64 构建与凭据接入 |
| 不负责 | 不无理由重写上游工具，不把个人 PAT 写入仓库或模型上下文 |
| 衔接点 | `mcp-client` |
| 详细设计 | `docs/design/plugins/dsh-gitee.md`（待编写，见[设计索引](../../docs/design/README.md)） |
| 实现状态 | 尚未建立 `package.json`、源码与测试 |

## 边界

- 上游版本、构建方式与校验和在设计中固定，升级需回归工具面。
- arm64 自行交叉编译并校验 checksum，不使用来源不明的二进制。
- 凭据来源二选一：企业统一身份映射，或用户级 OAuth/PAT 引用；轮换时重连子进程。
- 默认只读，建分支、评论、提 PR 等写操作单独开启。