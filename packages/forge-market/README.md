# @heluo/forge-market

状态：可用（仅开发验证）。企业市场未上线，G2 未通过。核对日期：2026-10-21。

一句话：一个 Host + Web Client 插件，向 agent 提供市场工具与一个只读列表面板；**当前只接自有 JSON 服务与 Gitee tag 归档**。

## 用途

给 agent 一个可治理的插件入口：从受控来源发现、校验并安装插件。当前只覆盖 Gitee 归档参考链路，npm 目标是后续实现。

## 现在是什么，不是什么

| | |
|---|---|
| 现在是 | Gitee 归档参考链路：搜索、详情、提交、自检、安装（下载→解包→可选落盘）、生成登记行 |
| 不是 | npm 目标实现：不能从企业 registry 安装，没有在线准入、更版或撤回控制 |
| 目标 | 管理员双层白名单 + 自动索引 + 写前授权 + 官方 manager；见 [DESIGN-007](../../docs/design/plugins/forge-market.md) |
| 版本 | 私有包 `0.1.0`，`engines.dsh: >=0.2.0`；npm 目标未实现，企业准入未验 |

目标方案的字段、发布与授权契约不在本文件重复，统一见 [DESIGN-012](../../docs/design/services/market-index.md)；来源决策见 [ADR-11／12](../../docs/architecture/plugin-registry-source-decision.md)。

## 快速开始

在 profile 补丁中声明服务地址与允许的仓库域名：

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

`cordis.patch.yml` 顶层必须是数组，见[随包补丁](cordis.patch.yml)。路径按宿主进程工作目录解析，不自动展开 `~`；令牌不写进补丁或仓库。

没有服务时可改用离线目录：

```yaml
config:
  catalogFile: ./catalog.json
```

目录只读，提交返回 `read-only`；检索与详情读文件，安装仍访问条目指向的归档。**本地 JSON 目录不等于离线制品分发。**

## 工具

| 工具 | 作用 | 写入 |
|---|---|---|
| `market_search` | 按关键词检索，按目录 star 值或下载请求数排序 | 目录只读；配置时写本地缓存 |
| `market_detail` | 条目详情、版本、`engines.dsh`、仓库地址 | 否 |
| `market_submit` | 提交前先自检归档，通过才提交 | 是（提交待审） |
| `market_verify` | 拉取归档并逐步报告能否通过格式校验 | 否（会联网下载） |
| `market_mine` | 按自报 `submitter` 列出条目与待审记录 | 否 |
| `market_diagnostics` | 列出被索引拒绝的仓库与原因码 | 否 |
| `market_check_update` | 比较已装版本与最近可用的未撤回版本 | 否 |
| `market_registration` | 给出登记到 profile 的 loader 行与两种登记路径 | 否 |
| `market_plan_install` | 只解析标签与仓库，不下载 | 否 |
| `market_install` | 下载、比对摘要、解包、必要时落盘，返回登记行 | 是（配置 `targetDir` 时落盘） |

`market_search` 在服务不可达时回退本地缓存，返回 `source: "cache"` 与 `stale`。`market_install` 的 `mode` 为 `installed`（已落盘）或 `verify-only`（只校验）。

宿主侧另注册 `/api/forge-market` 前缀路由（`catalog`、`detail/<name>`），客户端面板从该路由取数，避免把服务地址暴露给浏览器。工具返回登记行与操作说明，**不自动修改 profile**；另行登记后才由 DSH 加载。

## 面板

面板注册在 `plugins.bundle.config`（「插件」页里本插件的配置区），只读展示条目与服务状态。详情、提交、诊断仍在工具里，没有对应界面。

## 令牌与身份

**只适用于当前参考协议**，不是 npm 安装前置。

```sh
export HELUO_MARKET_TOKEN='<由运行环境注入>'
```

`/api/admin/*` 要求 Bearer 令牌；未配置时全部 401，不回退开放。令牌只从环境读取，不写配置或 patch。

「我的提交」需要 `submitter`（配置项或 `HELUO_MARKET_SUBMITTER`），由调用方自报，只用于过滤展示，不构成权限；未配置时 `market_mine` 返回 `identity-unavailable`。

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

## 维护人

平台组。变更走仓库评审；包版本按发布行为维护，设计文档按文档治理规则独立升版。

## 已知限制

- 无双层白名单生成器、format-1/npm 适配或官方 manager 安装链；以下工具与测试不证明目标已支持。
- 旧 `downloadInfo` 除 `version-revoked` 外失败时回退到按 repo/tag 推导的 Gitee 直连（含 401/403/网络错误），这是待迁移旁路，不是获准降级。
- `allowedHosts` 只校验主机与端口，不验证同一主机下的 group 归属；服务端扫描与授权未接入。
- 有期望摘要才比对，缺摘要仍可能继续；只有宿主版本与包声明都可得时才检查 `engines.dsh`，版本解析不是完整 semver。
- `policy.mjs` 的 `checkInstall` 未接入安装主链；包作用域、版本钉住与角色治理不能凭函数存在视为生效。
- `persistFiles` 逐文件写入，无原子替换或失败回滚，中途失败可能留下部分文件。
- 更新检查支持从 `targetDir` 读版本，但工具 schema 仍把 `installedVersion` 声明为必填。
- 共享管理令牌无 IAM 会话或角色映射；`submitter` 只过滤展示。
- 客户端只有列表面板，诊断服务返回空列表，服务与本地目录模式的面板来源标注未完全统一。

## 测试

```sh
node --test packages/forge-market/test/*.test.mjs
```

覆盖策略、格式校验、目录、客户端、规划、安装、解包、落盘与工具面，不接触真实企业系统；根 `pnpm check` 自动发现。`test/integration.test.mjs` 用本地假服务跑「检索→详情→下载→摘要→解包→落盘→读回」。

## 真实仓库验收（旧链路）

仅用于旧 Gitee 归档参考，不是 npm 上线前置。当前 `scripts/live-check.mjs` 未向 `checkRemote` 传 `allowedHosts`，直接执行会失败；参数接线前可从仓库根显式调用：

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

示例为占位，需替换为已获准测试仓库。脚本不写仓库或 profile，不进 CI；本次未访问真实 Gitee，本地 HTTP 归档测试不能替代。