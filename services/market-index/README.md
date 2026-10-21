# 市场目录与发布控制服务

状态：规划。已有可本地运行的 HTTP 参考实现与测试；无独立包清单、部署配置或企业联调。核对日期：2026-10-21。

一句话：目标是“受控白名单 → CI 自动检查 → 内网索引与授权”，**不是常驻审批后台**；当前 `server.mjs` 只是旧协议参考实现。

| 项 | 内容 |
|---|---|
| 当前形态 | 读取 JSON 的 HTTP 参考服务（目录、提交、内存评审、旧计数） |
| 目标形态 | 清单 + CI/定时任务 + 内网静态产物；无新常驻服务 |
| 不负责 | 不托管包体、不自研 registry/下载代理、不构建包、不执行安装 |
| 客户端 | [@heluo/forge-market](../../packages/forge-market/README.md) |
| 制品存储 | [deploy/registry](../../deploy/registry/README.md) |
| 契约 | [DESIGN-012](<../../docs/design/services/market-index.md>)（V1.1.2 评审稿，非企业生效或发行批准） |

## 现在能跑什么

```sh
node services/market-index/server.mjs --catalog ./catalog.json --counts ./counts.json --port 8080
```

从仓库根执行，先准备测试目录文件；默认只监听 `127.0.0.1`。`--counts` 指定计数文件，写入成功后可在重启时恢复；未指定则只在内存。去重集合不落盘，跨重启不保证按“机器/日”去重。

目录格式与插件的离线目录一致：数组或 `{ "entries": [...] }`，字段按 DESIGN-012 附录 A.3。

| 端点 | 当前行为 |
|---|---|
| `GET /api/plugins`、`GET /api/plugins/{name}` | 列表、关键词/排序、详情；`mine=1&submitter=` 过滤，缺标识返回 400 |
| `POST /api/plugins` | 校验必填字段与 tag 后加入内存待审队列，不代表通过完整包校验 |
| `POST /api/admin/review` | 共享令牌保护；通过、退回、整条或指定版本撤回 |
| `GET /api/plugins/{name}/versions/{v}/download` | 返回归档地址与可空摘要并计数；撤回版本返回 409 |
| `GET /api/metrics?plugin=` | 下载请求数与目录 star；附 `countsPersisted`、`starsSource`、`starsSyncedAt` |
| `GET /api/admin/unindexed` | 共享令牌保护，目前返回空列表 |
| `GET /api/discover/gitee` | 未实现，返回 404 |

`HELUO_MARKET_TOKEN` 由运行环境注入；未配置或不匹配时 `/api/admin/*` 返回 401。它只保护管理端点，普通查询与提交不做身份认证。

**不构成部署版本**：无限流、无 Gitee 扫描、无服务端完整包校验；目录变更、待审与审计都在内存，重启丢失，只有计数可选写盘。`submitter` 为自报字段，只过滤展示。

## 生成器（P1 起步，离线）

| 已实现 | 未实现 |
|---|---|
| 受控清单校验：`schemaVersion`、唯一 id 与规范化 URL、精确包名、悬空引用、未知字段；整份拒绝 | 基线/矩阵校验、自包含与双端检查、原生索引生成、发布流水线 |
| policy/evidence/current 组装与校验：七类检查决定 allow/deny、摘要互指、公共头一致、租约窗口、来源证据、同源地址 | 发布与续期、撤回注入 |
| 包内检查：结构/入口/patch、自包含运行依赖、生命周期脚本、peer 基线、显示资源（第三方可 fallback） | 真实 tarball 解包、matrix smoke、provenance 与 integrity（需外部环境补齐） |
| 原生 format-1 索引：字段校验、版本降序、icon/本地化/metadata 引用、未知成员丢弃 | 索引落盘与签名、双端 smoke 证据 |
| 离线生成流程：清单+包→索引+policy/evidence/current→落盘→读回复核（夹具，支持同包多版本） | 真实 tarball 解包、CI 单写与原子发布 |
| 本地发布控制：不可变 `generations/g{generation}`、`current` 原子 rename、base/代次防陈旧、轻量续期、拒绝快照 | 企业 CI 单写/取消、真实 HTTPS 托管与 5 分钟调度；本地 rename 与无跨进程锁不证明企业设施具备原子/互斥能力 |
| 更版状态机：预检→移除→再准入→精确安装、`old-removed/recovery-required`、失联对账、单飞 requestId | 真实 `removeBundle/installBundle`、HMR 与无 HMR 停机路径、恢复执行 |

`generator/upgrade.mjs` 导出 `runUpgrade()`、`reconcileUpgrade()`、`planRecovery()`、`OperationGate`；`generator/publish.mjs` 导出 `publishSnapshot()`、`renewCurrent()`、`readCurrent()`、`readPublished()`、`buildRejection()`；`generator/generate.mjs` 导出 `generateSnapshot()`、`writeSnapshot()`、`readSnapshot()`；`generator/manifest.mjs` 导出 `validateManifest(input)`（返回 `{ ok, errors, manifest }`）与 `canonicalizeRegistryUrl(url)`（不合法返回 `null`）；`generator/artifacts.mjs` 导出 `buildSnapshot(input)`、`validateSnapshot(input)` 与 `CHECK_IDS`；`generator/package-check.mjs` 导出 `inspectPackage({ manifest, files, peerBaseline, origin })` 与 `tarballIntegrity(bytes)`。当前不读企业源、不写产物，只用清单与夹具验证契约。

```sh
node --test services/market-index/test/manifest.test.mjs
```

## 指标口径

| 指标 | 含义 | 持久化 | 展示要求 |
|---|---|---|---|
| `downloads` | 发放归档地址的次数 | 仅 `--counts` 时写盘；去重集合在内存，重启后可能重复计数 | 写「下载请求数」，不写「安装量」 |
| `stars` | 目录文件里的值 | 不写入、不同步 | 标注来源与时间；`starsSyncedAt` 为空时不得称「热门」 |

`countsPersisted` 只表示保存回调存在，写入失败被吞，`true` 不证明保存成功。这些都是旧归档地址发放指标，不覆盖 npm 安装；pnpm 缓存也不是下载计数。

## 目标（未实现）

- **名单**：管理员维护 `schemaVersion`、`registries[{id,url}]`、`packages[{name,registryId,origin}]`；精确包名、唯一映射、规范 HTTPS。
- **基线**：每 profile 一个 `registryId` 与 `matrixId`；`fallbackRegistries: []`，不跨源。
- **准入**：首版只收自包含、Windows/麒麟全目标交集、稳定 SemVer 的包；不自动补 peer，不跑终端脚本/编译。
- **产物**：原生 format-1 索引 + policy/evidence sidecar + `current`；原生无 integrity/OS/policy 字段。
- **发布**：可调度单写 owner、不可变快照、原子切 current、5 分钟续期、最长 15 分钟租约。
- **授权**：每次写前 `no-store` 读 current，决定 ≤ 60 秒，过期/不可达即只读。

字段、校验与流程统一见 [DESIGN-012 §3 契约](<../../docs/design/services/market-index.md#3-目标契约>)、[§4 发布与授权](<../../docs/design/services/market-index.md#4-发布授权与撤回>)；验收见 [§8](<../../docs/design/services/market-index.md#8-验收>)。升级与恢复见 [DESIGN-007 §7](<../../docs/design/plugins/forge-market.md#7-安装更版与恢复目标>)。

企业授权薄 Host 是企业索引槽位的唯一同步 owner：验证 current 后，用公开 `listIndexes/setIndexes` 只轮换授权槽位，保留其他来源；纯续期且 URL 未变不改源。

## 边界

- 当前 JSON 目录仍指向 Gitee tag 归档；目标企业 npm 方向已确认，产品/URL/ACL/同步与出口未验。
- 顶层名单不等于任何版本获准；普通/optional/bundled 运行依赖非空的包首版排除，但不是“DSH 非法”。
- 稳定版规则针对插件根版本，宿主 rc 按核定矩阵；统一目录必须全目标通过。
- 旧 JSON API/提交评审/校验码/计数属 DESIGN-012 附录 A，不兼容原生 format-1。
- 本地监听不构成企业部署；最小目标不新建 PG/IAM/代理。

## 测试

在仓库根执行 `node --test services/market-index/test/*.test.mjs tests/integration/*.test.mjs`。根 `pnpm check` 也包含这些用例，覆盖清单校验、令牌拒绝、提交/评审/撤回、计数恢复与本地安装链路；不验证真实 Gitee、企业 registry 或生产部署。