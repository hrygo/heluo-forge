# @heluo/forge-engineering

`heluo-forge` 企业研发工具套件预装包（[详细设计](../../docs/design/plugins/forge-engineering.md)）。

| 项 | 值 |
|---|---|
| 包名 | `@heluo/forge-engineering` |
| 设计文档 | [CORP-DSH-DESIGN-019](../../docs/design/plugins/forge-engineering.md)（独立研发预装包） |
| 兼容 DSH | `>=0.2.1-rc.2`（`engines.dsh`） |
| 定位 | 独立预装研发组合包，与通用底座 `@heluo/forge-enterprise` 解耦并存；不禁用任何官方账号/模型/凭据行 |
| 状态 | 条款包加载、适用性选择、预算约束、五类开关判定、UI 工作台容器与补丁层已有离线单元测试验证；DevOps（DOP）与 Gitee 成员各自携带离线测试与本地探针证据；企业生产服务端、真实 `dop`/`gh` 密钥链与双端宿主 GUI 联调仍待实机验证 |

## 组合与能力

- [cordis.patch.yml](cordis.patch.yml) 插入 5 个运行时条目，**不含**官方行禁用且**不设** `isolate`：
  - `heluo-policy`（`@heluo/forge-policy`）：携带与 `@heluo/forge-enterprise`、`@heluo/forge-devops`、`@heluo/forge-gitee` 逐字一致的 6 条动作目录与内存审计配置，与底座并存时由 Cordis Loader 合并为单一 `policy` 实例。
  - `heluo-engineering-ui`（`@heluo/forge-engineering`）：由 [client.js](client.js) 提供 `设置 → 企业研发工具` 分区（`order: 30`）、导航图标及 `heluo.engineering.tab` 子槽位。
  - `heluo-issue-delivery-skill`（`@heluo/forge-engineering/issue-delivery-skill`）：注册用户显式触发的 [skills/issue-delivery/SKILL.md](skills/issue-delivery/SKILL.md)（资源与索引见 [skills/clauses.json](skills/clauses.json)）。
  - `forge-devops`（`@heluo/forge-devops`，`config: {}`）：提供 DevOps（DOP）工作流能力及内嵌在工具面板中的 `DEVOPS_API_KEY` 凭据条目。
  - `heluo-gitee`（`@heluo/forge-gitee`，`config: {}`）：提供 Gitee 代码托管与评审工作流能力及内嵌在工具面板中的 `GITEE_TOKEN` 凭据条目。

## 验证与已知限制

```sh
pnpm --filter @heluo/forge-engineering test
```

- 策略目录默认以 `sink: memory` + `allowNonDurable: true` 满足本地与离线试点核验；生产或合规审计场景须在运行配置注入持久 sink。
- 单独安装本包（未安装 `@heluo/forge-enterprise` / `@heluo/forge-iam`）时，`DevOps` 与 `Gitee` 面板的独立 Token 接口返回 `404`/`501` 会安静降级为本机环境提示，不阻塞配置与检查。
- 本包不含企业登录账号、AI 网关或通用模型管理；真实企业 DevOps/Gitee 环境凭据注入与双端交互体验尚待企业环境联调。
