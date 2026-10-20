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
| 实现状态 | 策略、格式校验、目录、服务客户端、安装规划与三个市场工具已实现并有测试；bundle 挂载待实机核验 |

## 边界

- 企业市场与官方市场并存：内部渠道管精选与分发，官方入口默认保留。
- 上架与安装前校验包名范围、固定版本、安装脚本与 `engines.dsh` 兼容性。
- 只读与受限角色禁用插件管理工具；开发者可从内部已审批源安装。
- 目录与制品由服务端和市场流程控制，客户端配置不是发布权限。

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
```

| 工具 | 作用 | 写入 |
|---|---|---|
| `market_search` | 按关键词检索，按 star、下载量排序 | 否 |
| `market_detail` | 条目详情、版本、`engines.dsh`、仓库地址 | 否 |
| `market_submit` | 提交插件，校验标签格式与仓库域名 | 是（提交待审） |
| `market_install` | 解析标签、下载归档、校验摘要、解包、必要时落盘 | 是（仅落盘） |

`market_install` 只有在配置了 `targetDir` 时才会写文件；不配置则只做校验并返回文件清单，便于先验证再安装。

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

## 测试

```sh
node --test
```

覆盖策略、格式校验、目录、客户端、规划、安装、解包、落盘与工具面；不接触真实服务与企业系统。
