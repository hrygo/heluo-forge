# @heluo/forge-market

状态：可用

“可用”表示已有包清单、实现与测试，可用于开发验证；不表示企业市场已上线或 G2 已通过。现状核对日期：2026-10-21。

| 项 | 内容 |
|---|---|
| 形态 | Host + Web Client 插件，附配置 bundle |
| 职责 | 接入企业精选市场：目录地址、内部源与上架/安装策略 |
| 不负责 | 不实现目录服务或 registry，不判定发布审批；当前 UI 仅为列表面板 |
| 衔接点 | Host `tools`、可选 `webServer`；Client `slots` 的 `plugins.bundle.config` |
| 服务实现 | 企业插件目录，见 [DESIGN-012](../../docs/design/services/market-index.md) |
| 详细设计 | [DESIGN-007](../../docs/design/plugins/forge-market.md) |
| 实现状态 | 已有私有包清单（`0.1.0`、`engines.dsh: >=0.2.0`）、十个工具、宿主路由、客户端列表面板与本地集成测试；策略接线与验证边界见下文 |

[DESIGN-007](../../docs/design/plugins/forge-market.md)记载 2026-10-20 在测试 profile 中激活插件、注册路由并观察列表、缓存回退与不可达三种面板状态；占位服务地址返回 503。验证后已卸载并恢复 profile。本次仅核对仓库源码和离线用例，未重新运行该实机验证。

## 用途

让 DSH 里的 agent 与开发者从企业 Gitee 的专门 group 发现、校验并安装插件，并把未收录原因说清楚。

## 维护人

平台组。变更走仓库评审；包版本按发布行为维护，设计文档按文档治理规则独立升版。

## 边界

- 企业目标是仅允许从企业 Gitee 的专门 group 安装；本插件不提供公网安装入口，也尚未接管或关闭宿主官方市场。
- 提交自检与安装分别有格式和内容校验；完整策略并未全部接线，见“当前实现限制”。
- 目标要求只读与受限角色禁用插件管理工具；角色控制依赖尚未实现的 IAM/policy，当前工具注册本身不执行角色判断。
- 目录与制品由服务端和市场流程控制，客户端配置不是发布权限。

## 令牌

管理端点（`/api/admin/*`）一律要求令牌；服务端未配置令牌时全部拒绝，不回退成开放。令牌只从环境变量读取，不写进配置或 patch：

```sh
export HELUO_MARKET_TOKEN='<由运行环境注入>'
```

「我的提交」需要 `submitter`（配置项或 `HELUO_MARKET_SUBMITTER`）。它由调用方自报，只用于过滤展示，不构成权限；未配置时 `market_mine` 返回 `identity-unavailable`。

## 用法

挂载补丁声明服务地址与允许的仓库域名；插件向当前 agent 注册十个工具（搜索、详情、提交、我的提交、校验、诊断、检查更新、登记、安装、安装规划）。

```yaml
- insert:
    - id: forge-market
      name: '@heluo/forge-market'
      inject: [tools]
      config:
        serviceUrl: https://plugins.corp.example
        allowedHosts: [gitee.corp.example]
        cachePath: ./market-cache.json
        targetDir: ./plugins
```

`cordis.patch.yml` 顶层必须是数组，见[随包补丁](cordis.patch.yml)。路径按宿主进程的工作目录解析，当前实现不自动展开 `~`；需按测试环境配置，令牌不进入补丁或仓库。

| 工具 | 作用 | 写入 |
|---|---|---|
| `market_search` | 按关键词检索，按目录 star 值或下载请求数排序 | 目录只读；配置时写本地缓存 |
| `market_detail` | 条目详情、版本、`engines.dsh`、仓库地址 | 否 |
| `market_submit` | 提交前先自检归档（拉取、解包、按格式规则判定），通过才提交 | 是（提交待审） |
| `market_verify` | 拉取指定仓库归档，逐步报告能否通过格式校验 | 否（会联网下载） |
| `market_mine` | 按自报 `submitter` 列出条目与待审记录；退回理由尚未完整返回 | 否 |
| `market_diagnostics` | 列出被索引拒绝的仓库与原因码 | 否 |
| `market_check_update` | 比较指定已装版本与最近可用的未撤回版本 | 否 |
| `market_registration` | 给出登记到 profile 的 loader 行与两种登记路径 | 否 |
| `market_plan_install` | 只解析标签与仓库，不下载 | 否 |
| `market_install` | 下载归档、有期望摘要时比对、解包、必要时落盘，并返回登记行；`mode` 为 `installed` 或 `verify-only` | 是（配置目标目录时落盘；服务可计下载请求） |

宿主侧同时注册 `/api/forge-market` 前缀路由（`catalog`、`detail/<name>`），客户端面板从该路由取数，避免把服务地址暴露到浏览器。

`market_search` 在服务不可达时回退到本地缓存，并返回 `source: "cache"` 与 `stale` 标记；配置项 `cachePath` 指向缓存文件，未配置则不做缓存。

`market_install` 只有在配置了 `targetDir` 时才会写文件，此时返回 `mode: installed` 与 `persisted`；不配置则返回 `mode: verify-only`，表示只校验未落盘。

工具返回登记行和操作说明，不自动修改 profile 或激活新插件。另行登记后才由 DSH 加载。

## 离线目录

没有服务时可用 `catalogFile` 指向一个 JSON 目录，条目格式与服务返回一致：

```yaml
config:
  catalogFile: ./catalog.json
```

“只读”指目录不会被提交修改，提交返回 `read-only`；检索与详情可从文件读取，安装仍需访问条目指向的归档，并可写入 `targetDir`。本地 JSON 目录不等于完全离线制品分发。

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
src/market-tools.mjs  十个工具的定义与执行
src/routes.mjs        宿主目录/详情路由与缓存回退
src/config.mjs        standard-schema 配置校验
src/registration.mjs  profile 登记行与说明
src/local-catalog.mjs 本地 JSON 目录来源
src/live-check.mjs    归档格式自检
src/index.mjs         插件入口：注册工具与可选路由
client.js             bundle 详情页中的列表面板
```

## 当前实现限制

- `allowedHosts` 校验主机与端口，尚不验证同一主机下的专门 group 归属；服务端扫描与授权也未接入。
- 有期望摘要才比对摘要；缺摘要时仍可能继续安装。只有宿主版本与包声明都可得时才运行安装期 `engines.dsh` 检查，版本解析也不是完整 semver 实现。
- `policy.mjs` 的 `checkInstall` 未接入安装主链，包作用域、版本钉住与角色治理不能凭该函数的存在视为生效。安装脚本拦截及 patch/路径校验已有独立接线。
- `persistFiles` 逐文件写入，尚无原子替换或失败自动回滚；中途写入失败可能留下部分文件。
- 更新检查的处理函数支持从 `targetDir` 读取版本，但工具 schema 仍将 `installedVersion` 声明为必填，当前工具调用应显式提供该参数。
- 共享管理令牌从 `HELUO_MARKET_TOKEN` 读取，尚无 IAM 会话或角色映射。`submitter` 只过滤“我的提交”，不能证明身份或权限。
- 客户端只有列表面板，详情、提交与诊断仍走工具；诊断服务当前返回空列表。服务与本地目录模式的面板来源标注还未完全统一。

## 真实仓库验收

上线前需对获准访问的真实 Gitee 仓库做只读归档检查。当前脚本 `scripts/live-check.mjs` 未向 `checkRemote` 传入必需的 `allowedHosts`，直接执行会失败；在脚本参数接线完成前，可从仓库根目录显式传入白名单调用已测试的 API：

```sh
node --input-type=module <<'JS'
import { checkRemote } from './packages/forge-market/src/live-check.mjs';
const result = await checkRemote({
  repo: 'https://gitee.corp.example/g/demo',
  tag: 'v0.1.0',
  allowedHosts: ['gitee.corp.example'],
});
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
JS
```

示例为占位，需替换为已获准的测试仓库。它拉取 tag 归档、计算摘要、解包并给出各步骤结果，不写仓库或 profile，**不进 CI**。本次未访问真实 Gitee；本地 HTTP 归档测试不能替代这一验收。

## 测试

```sh
node --test packages/forge-market/test/*.test.mjs
```

从仓库根目录执行。覆盖策略、格式校验、目录、客户端、规划、安装、解包、落盘与工具面；不接触真实企业系统。根 `pnpm check` 已自动发现这些用例与跨模块集成测试。

`test/integration.test.mjs` 起一个本地假服务，跑「检索 → 详情 → 下载 → 摘要校验 → 解包 → 落盘 → 读回」全链路，用真实 HTTP 与本机临时目录。
