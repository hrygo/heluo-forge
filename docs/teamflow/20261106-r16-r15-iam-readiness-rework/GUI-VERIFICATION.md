# 企业研发总览 GUI 装载验证（r16 · AC-11）

> 对象：`docs/teamflow/20261106-r16-r15-iam-readiness-rework/`（PRD 12 条 AC）
> 交接依据：`DELIVERY-NOTES.md` §6 六条判据
> 执行：主 agent（非流水线阶段）；日期 2026-11-06；环境：本机 macOS + DSH `0.2.1-rc.5`，隔离 profile，未装日常 `desktop` profile
> 结论：**六条判据全部满足**；过程中发现并修复 1 条 **P0（GUI 无法启动）**，详见 §4

## 1. 环境与隔离

| 项 | 值 |
|---|---|
| DSH_HOME | 临时目录（一次性，验证后删除） |
| profile | `uat`（`dsh --profile uat --from-default-profile web` 建模板） |
| 端口 | `127.0.0.1:48490`（仅本机） |
| 安装物 | `heluo-forge-devops-0.1.0.tgz`、`heluo-forge-gitee-0.1.0.tgz`（`dist/` 下，已被 `.gitignore` 忽略） |
| 日常 profile | **未触碰**；未推送、未提交 |

`DELIVERY-NOTES.md` §6 的安装步骤按字面执行不通，需按 §3 修正。

## 2. 判据结果

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 出现「企业研发」（order 29）与「企业 Gitee」（order 50） | PASS | 设置侧栏依次为 通用设置 / 模型 / 内置插件 / Agent 预设 / **企业研发** / **企业 Gitee** / **企业 DevOps**，文案不混排 |
| 2 | 七行齐全 + 固定声明句 | PASS | 企业身份 / 公共参数 / 本机配置 / 网关 Key / DevOps / Gitee / 业务写权限；声明句「本页只汇总本机可见性，不代表业务授权。」在场 |
| 3 | 有 API 出按钮，无 API 只出文字、不出现死按钮 | PASS（降级） | 宿主未暴露 `settings` 服务，身份行只出文字「安装企业账号插件后再查看」，页面无点击无反应的导航按钮 |
| 4 | 「检查 DevOps」一次 `?refresh=1`；Gitee 禁用 | PASS | Network 该次点击只有 1 条 `GET /api/forge-devops/cli?refresh=1`（200，35ms）；「检查 Gitee」`disabled=true`，点击前后零请求 |
| 5 | 启动日志无 `entry not found` / `did not activate` | PASS（修复后） | 宿主 stdout 仅 `dsh web: http://127.0.0.1:48490/?token=…`；浏览器控制台零错误（修复前见 §4） |
| 6 | 回滚后 bundles 与补丁层零 `@heluo/*` | PASS | 移除两包后 `dsh.profile.bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`、`dependencies` 空、`cordis.patch.yml` 无 `@heluo/` 命中、`node_modules/@heluo` 目录不存在 |

检查结果本身在本环境**如实失败**：`检查：失败 · 来源类型无法判定 · 2026-11-06 21:53:07`，四层证据分别为「文件系统只读探测」「文件系统只读探测」「来源类型无法判定」「策略准入（未发起真实请求）」。这是没有真实企业端点时的预期诚实降级，不是缺陷。

## 3. 交接步骤的两处修正

1. **企业组合包不含 DevOps/Gitee**：`packages/forge-enterprise/package.json` 的 dependencies 只有 `@heluo/forge-credentials-keychain`、`@heluo/forge-policy`、`@heluo/forge-iam`，其 `cordis.patch.yml` 的 `insert:` 只挂这三行。按 §6 只装 `heluo-forge-enterprise` 不会出现判据 1 的两个分区。改为直接安装 `heluo-forge-devops` 与 `heluo-forge-gitee`（与 `scripts/uat-profile.mjs` 的 `UAT_ENTRIES` 一致）。
2. **启动命令与路径**：`dsh --profile uat add` 必须给 tarball 绝对路径（相对路径解析到 profile 目录，报 ENOENT）；启动不带 `web` 尾词（带则报 `too many arguments … got 1: web.`），即 `dsh --profile uat --host 127.0.0.1 --port 48490 --no-open`。另外 `dsh plugin add` 建出的空 profile 没有 web 模板，需先用 `--from-default-profile web --dump-config` 建模板，否则启动无监听、日志 0 字节。

## 4. 缺陷 P0-1：客户端读未声明服务导致整个 Web UI 拒绝启动

- **现象**：装包后打开宿主，页面只剩 `Failed to load plugins / @heluo/forge-devops / web boot: 1 entry did not activate / @heluo/forge-devops: failed`，Web UI 完全不加载；bundle 请求本身 200，`window.__DSH_BOOT__` 里两条 entry 都在。
- **定位**：临时在隔离 profile 的 `client.js` 包一层 try/catch 把栈写进 `document.title`，得到根因：
  ```
  Error: cannot get property "settings" without inject
    at sectionNavigatorOf (client.js:1990:15)
    at apply (client.js:2009:24)
  ```
- **根因**：`packages/forge-devops/client.js` 的 `sectionNavigatorOf` 里，`ctx.get('settings')` 在 try 内，但紧随其后的 `if (ctx.settings && typeof ctx.settings === 'object')` 落在 try **外**。Cordis 对**未在 `inject` 声明**的服务不是返回 `undefined` 而是直接抛错（该插件 `inject = ['slots','locale']`），异常逃出 `apply` → 条目判 failed → 宿主拒绝启动整个前端。静态用例此前用宽松 ctx 桩（普通对象，未声明属性返回 undefined），因此 19 条客户端用例全绿也没覆盖到。
- **修复**：把 `ctx.settings` 读取移入同一个 try，并注明原因；契约不变（探测不到就降级文字）。
- **回归**：新增 `packages/forge-devops/test/client-inject.test.mjs`，用 Proxy 复刻 Cordis 的 inject 守卫（未声明属性与 `ctx.get` 一律抛错），断言 `apply` 不抛、两个分区都注册、`navigate` 降级为 `null`。**先红后绿**：修复前报错与 GUI 完全一致（`cannot get property "settings" without inject`），修复后 2/2 通过；`packages/forge-devops` 全量 439/439 通过。
- **流程说明**：该修复由主 agent 直接写入，未再开一轮流水线（一行级缺陷；流水线单轮约 300k token，且仍会撞上产物路径误判）。修复属于本轮 AC-11 验证的连带返工，仍待验收复核；未提交。

## 5. 未验与边界

- 真实企业 IAM、真实 Key、企业 `dop` 只读实跑：**未验**（本环境无企业端点，检查结果如实显示失败）。
- Windows / 麒麟：本轮不做（用户已明确本轮排除）。
- 日常 `desktop` profile：未装、未改。
- 截图保留在会话内，未入库（避免把临时 profile 画面当作可复现证据）。
