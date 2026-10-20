# 市场目录与发布控制服务

状态：规划

生产服务仍在规划；已有可本地运行的 HTTP 参考实现和测试，尚无独立包清单、部署配置或企业联调。现状核对日期：2026-10-21。

| 项 | 内容 |
|---|---|
| 形态 | 当前为读取 JSON 目录的 HTTP 参考服务；目标为目录、版本与发布控制服务 |
| 职责 | 当前提供目录查询、提交入队、内存态评审与计数；目标增加 Gitee 发现、校验、身份授权与持久化 |
| 不负责 | 不存储制品、不自研 registry、不执行客户端安装 |
| 客户端 | [@heluo/forge-market](../../packages/forge-market/README.md) |
| 制品存储 | [deploy/registry](../../deploy/registry/README.md) |
| 详细设计 | [DESIGN-012](../../docs/design/services/market-index.md)（草案，已建立） |
| 下载计数 | `GET /api/plugins/{name}/versions/{v}/download` 返回归档地址与摘要，并按（条目, 机器哈希, 日）去重计数 |
| 评审 | `POST /api/admin/review`：`approve`、`reject`、`revoke`，内存态，重启丢失 |
| 实现状态 | `server.mjs` 与服务测试已建立；支持列表/详情、提交、评审/撤回、计数与提交方过滤；管理接口校验共享令牌，生产身份与运行能力未闭环 |

## 参考实现的用法

```sh
node services/market-index/server.mjs --catalog ./catalog.json --counts ./counts.json --port 8080
```

从仓库根目录执行，需先准备测试目录文件；默认只监听 `127.0.0.1`。`--counts` 指定下载计数文件，写入成功后可在重启时恢复；未指定时只存内存。去重集合没有落盘，不能保证跨重启仍按“机器/日”去重。

目录格式与 [@heluo/forge-market](../../packages/forge-market/README.md) 的离线目录一致：数组或 `{ "entries": [...] }`，条目字段按 DESIGN-012 的字段级约定。

`HELUO_MARKET_TOKEN` 由运行环境注入，管理端点要求匹配的 Bearer 令牌；未配置或不匹配时返回 401。它只保护 `/api/admin/*`，尚未接入 IAM、成员或角色校验；普通目录查询和提交不执行身份认证。

参考实现**不构成部署版本**：没有限流、Gitee 扫描与服务端完整包校验；目录变更、待审记录及审计只在内存中，重启丢失，只有计数可选写文件。`submitter` 为调用方自报字段，仅过滤展示；退回理由目前写入内存审计，未完整暴露给“我的提交”。生产方案仍按 DESIGN-012 评审和建设。

## 端点状态

| 端点 | 当前行为 |
|---|---|
| `GET /api/plugins`、`GET /api/plugins/{name}` | 列表、关键词/排序、详情；`mine=1&submitter=` 过滤提交方，缺标识时返回 400 |
| `POST /api/plugins` | 校验必填字段与 tag 后加入内存待审队列，不代表通过完整包校验 |
| `POST /api/admin/review` | 共享令牌保护；通过、退回、整条撤回或指定版本撤回 |
| `GET /api/plugins/{name}/versions/{v}/download` | 返回归档地址和摘要（可为空），记录下载请求；被撤回版本返回 409 |
| `GET /api/metrics?plugin=` | 下载请求数与目录中的 star 值；同时返回 `countsPersisted`、`starsSource`、`starsSyncedAt` 说明口径 |
| `GET /api/admin/unindexed` | 共享令牌保护，目前只返回空列表 |
| `GET /api/discover/gitee` | 尚未实现，返回 404 |

下载请求数不等于安装成功数，参考服务不存储或代理归档字节。

## 指标口径

| 指标 | 含义 | 持久化 | 展示要求 |
|---|---|---|---|
| `downloads` | 发放归档地址的次数 | 仅 `--counts` 时写盘；去重集合在内存，重启后可能重复计数 | 写「下载请求数」，不写「安装量」 |
| `stars` | 目录文件里的值 | 不写入、不同步 | 标注来源与时间；`starsSyncedAt` 为空时不得称「热门」 |

接口已返回 `countsPersisted`（是否写盘）、`starsSource`（`catalog`）、`starsSyncedAt`（恒 `null`）。消费方按这三个字段决定措辞：未持久化时不展示累计值，未同步时不把排序说成热度。存储与同步的后续工作见仓库 issue。

## 测试

在仓库根目录执行 `node --test services/market-index/test/*.test.mjs tests/integration/*.test.mjs`。根 `pnpm check` 也包含这些用例，覆盖管理令牌拒绝、提交/评审/撤回、计数恢复与本地安装链路；不验证真实 Gitee 或生产部署。

## 边界

- 当前目录指向 Gitee tag 归档；registry 接入或镜像仍待 IT、安全确认，不作为当前启动前置。
- 企业目标要求制品不可变、兼容性和来源可核验，发布审批与上传权限分离；参考服务尚未实现完整校验、发布通道和持久审计。
- 当前 JSON API 是 DESIGN-012 的自有协议，经市场插件转换使用，不声称兼容上游官方市场 index schema。
- 本地监听不构成企业部署；生产数据库、容器、网关与恢复演练仍需独立验证。
