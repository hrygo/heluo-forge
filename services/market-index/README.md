# 市场目录与发布控制服务

状态：规划

| 项 | 内容 |
|---|---|
| 形态 | 目录生成、校验与发布状态管理；优先产出可审计静态目录 |
| 职责 | 校验包白名单、兼容性、checksum 与通道，生成市场目录并记录发布状态 |
| 不负责 | 不存储制品、不自研 registry、不执行客户端安装 |
| 客户端 | [@corp/dsh-market](../../packages/dsh-market/README.md) |
| 制品存储 | [deploy/registry](../../deploy/registry/README.md) |
| 详细设计 | `docs/design/services/market-index.md`（待编写，见[设计索引](../../docs/design/README.md)） |
| 实现状态 | 尚未建立服务清单、源码、测试或部署配置 |

## 边界

- 目录只引用已存在于私有 registry 的不可变版本；制品不可获取时不得发布目录条目。
- 兼容性依据 `engines.dsh` 与包清单校验，不靠人工口述。
- 发布与撤回通过通道切换完成，不修改已发布版本的元数据。
- 目录 schema 须按目标 DSH 版本核验，未核验前不定义字段或签名协议。
- 是否常驻服务、静态托管或对象存储由部署方案确认，本目录不预设。