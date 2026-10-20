# 市场目录与发布控制服务

状态：规划

| 项 | 内容 |
|---|---|
| 形态 | 目录生成、校验与发布状态管理；优先产出可审计静态目录 |
| 职责 | 校验包白名单、兼容性、checksum 与通道，生成市场目录并记录发布状态 |
| 不负责 | 不存储制品、不自研 registry、不执行客户端安装 |
| 客户端 | [@heluo/forge-market](../../packages/forge-market/README.md) |
| 制品存储 | [deploy/registry](../../deploy/registry/README.md) |
| 详细设计 | `docs/design/services/market-index.md`（待编写，见[设计索引](../../docs/design/README.md)） |
| 实现状态 | 只读参考实现已建立：`server.mjs` 与 3 个用例，覆盖目录查询、提交入队与 404；无 Gitee 扫描、鉴权、评审流与持久化，未部署核验 |

## 参考实现的用法

```sh
node services/market-index/server.mjs --catalog ./catalog.json --port 8080
```

目录格式与 [@heluo/forge-market](../../packages/forge-market/README.md) 的离线目录一致：数组或 `{ "entries": [...] }`，条目字段按 DESIGN-012 的字段级约定。

参考实现**不构成部署版本**：没有鉴权、限流、Gitee 扫描、评审流与持久化，只能用于联调、演示与契约验证。生产部署仍按 DESIGN-012 的容器与网关要求。

## 边界

- 目录只引用已存在于私有 registry 的不可变版本；制品不可获取时不得发布目录条目。
- 兼容性依据 `engines.dsh` 与包清单校验，不靠人工口述。
- 发布与撤回通过通道切换完成，不修改已发布版本的元数据。
- 目录 schema 须按目标 DSH 版本核验，未核验前不定义字段或签名协议。
- 是否常驻服务、静态托管或对象存储由部署方案确认，本目录不预设。