# @heluo/forge-market

状态：可用

| 项 | 内容 |
|---|---|
| 形态 | 配置 bundle |
| 职责 | 接入企业精选市场：目录地址、内部源与上架/安装策略 |
| 不负责 | 不实现目录服务，不自研 registry，不提供额外市场 UI |
| 衔接点 | `plugin-market`、`plugin-manager` |
| 服务实现 | 企业插件目录，见 [DESIGN-012](../../docs/design/services/market-index.md) |
| 详细设计 | [DESIGN-007](../../docs/design/plugins/forge-market.md) |
| 实现状态 | 宿主侧：策略、校验、目录、客户端、安装、缓存、路由与九个工具，均有测试；客户端面板已写但**未实机核验**（slot 归属与注入方式待装到 profile 后确认），因此「可用」指宿主侧与安装链路，不含面板视觉验收 |

## 用途

让 DSH 里的 agent 与开发者从企业 Gitee 的专门 group 发现、校验并安装插件，并把未收录原因说清楚。

## 维护人

平台组。变更走仓库评审，包版本随设计文档同步。

## 边界

- 企业市场与官方市场并存：内部渠道管精选与分发，官方入口默认保留。
- 上架与安装前校验包名范围、固定版本、安装脚本与 `engines.dsh` 兼容性。
- 只读与受限角色禁用插件管理工具；开发者可从内部已审批源安装。
- 目录与制品由服务端和市场流程控制，客户端配置不是发布权限。

## 令牌

管理端点（如 `/api/admin/unindexed`）需要令牌。只从环境变量读取，不写进配置或 patch：

```sh
export HELUO_MARKET_TOKEN=...
```

## 用法

挂载补丁声明服务地址与允许的仓库域名；插件向当前 agent 注册四个工具。

```yaml
insert:
  - id: forge-market
    name: '@heluo/forge-market'
    inject: [tools]
    config:
      serviceUrl: https://plugins.corp.example
      allowedHosts: [gitee.corp.example]
      cachePath: ~/.dsh/cache/forge-market.json
      targetDir: ~/.dsh/plugins
```

| 工具 | 作用 | 写入 |
|---|---|---|
| `market_search` | 按关键词检索，按 star、下载量排序 | 否 |
| `market_detail` | 条目详情、版本、`engines.dsh`、仓库地址 | 否 |
| `market_submit` | 提交前先自检归档（拉取、解包、按格式规则判定），通过才提交 | 是（提交待审） |
| `market_verify` | 拉取指定仓库归档，逐步报告能否通过格式校验 | 否 |
| `market_diagnostics` | 列出被索引拒绝的仓库与原因码 | 否 |
| `market_check_update` | 比较已装版本与最近可用的未撤回版本；省略 `installedVersion` 时读 `targetDir` 下的清单 | 否 |
| `market_registration` | 给出登记到 profile 的 loader 行与两种登记路径 | 否 |
| `market_plan_install` | 只解析标签与仓库，不下载 | 否 |
| `market_install` | 下载归档、校验摘要、解包、必要时落盘，并返回登记行；`mode` 为 `installed` 或 `verify-only` | 是（仅落盘） |

宿主侧同时注册 `/api/forge-market` 前缀路由（`catalog`、`detail/<name>`），客户端面板从该路由取数，避免把服务地址暴露到浏览器。

`market_search` 在服务不可达时回退到本地缓存，并返回 `source: "cache"` 与 `stale` 标记；配置项 `cachePath` 指向缓存文件，未配置则不做缓存。

`market_install` 只有在配置了 `targetDir` 时才会写文件，此时返回 `mode: installed` 与 `persisted`；不配置则返回 `mode: verify-only`，表示只校验未落盘。

## 离线目录

没有服务时可用 `catalogFile` 指向一个 JSON 目录，条目格式与服务返回一致：

```yaml
config:
  catalogFile: ./catalog.json
```

该模式只读：检索、详情、安装照常，提交返回 `read-only`。用于演示、隔离网与 CI，不替代市场服务。

## 面板位置

客户端面板注册在 `plugins.bundle.config`，也就是本插件在「插件」页面里的配置区，用于展示市场条目与服务连通状态。它不是完整的市场界面：详情、提交、诊断仍在工具里，尚未做界面。

## 目录结构

```text
src/policy.mjs        安装策略：范围、固定版本、脚本拦截、engines
src/validate.mjs      包格式与 cordis.patch.yml 内容安全
src/catalog.mjs       条目归一化、排序、过滤
src/client.mjs        服务客户端：超时与错误码映射
src/installer.mjs     版本规划、域名白名单、摘要、路径白名单
src/install.mjs       安装流水线：下载、摘要、解包、清单比对
src/tarball.mjs       tar.gz 解包（大小上限、路径校验）
src/persist.mjs       落盘（目标目录约束）
src/market-tools.mjs  四个工具的定义与执行
src/index.mjs         插件入口：注册工具、读取配置
```

## 真实仓库验收

上线前对一个真实 Gitee 仓库跑一次只读检查：

```sh
node scripts/live-check.mjs --repo https://gitee.corp.example/g/demo --tag v0.1.0
```

它拉取 tag 归档，算摘要，解包并按包格式规则判定，逐步输出 `ok` / `FAIL`。不写仓库、不改 profile，**不进 CI**（需要网络与内网权限）。

## 测试

```sh
node --test
```

覆盖策略、格式校验、目录、客户端、规划、安装、解包、落盘与工具面；不接触真实服务与企业系统。

`test/integration.test.mjs` 起一个本地假服务，跑「检索 → 详情 → 下载 → 摘要校验 → 解包 → 落盘 → 读回」全链路，用真实 HTTP 与本机临时目录。
