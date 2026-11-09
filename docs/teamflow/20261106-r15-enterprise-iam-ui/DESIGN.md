<!-- meta: summary="设置壳新增「企业研发」准备总览（order 29，读 IAM/DevOps/Gitee 非敏感摘要）与企业 Gitee 本机页（order 50）；编辑留在各插件自己的分区，沿用 fdv 度量与宿主 token，汇总与诊断不出现路径/凭据。" -->
# 企业研发正式 UI 整合设计（r15 · 可装载交付）

## 0. 视觉与观感意图（实施先读）

**意图：像宿主设置里多了一页“准备清单”，不像新增的企业管理门户。** 视觉重心只有三类：分项状态、一个可直接做的下一步、编辑控件。页面不加外框卡片、品牌色、插图或渐变；所有颜色取自 `--dsw-alias-*` / `--dsw-static-*` 宿主 token，新增色值 0 个。

新分区复用 `@heluo/forge-devops` 现有 [client.js 度量与样式](<../../../packages/forge-devops/client.js>) 的 `METRICS` 与 `.fdv-*` 类族（同包、同一份 CSS），不新增第二套视觉方言；`@heluo/forge-gitee` 的新页面按同一组数值自建 `fge-*` 类（仓库禁止跨包 import 源码），数值逐项相同并由视觉走查核对。以下规格只约束本轮新增/修订，不改 IAM 既有卡片。

### 0.1 表面与尺寸（可直接落成常量）

| 组件 | 规格 |
|---|---|
| 页面 | width:100%、min-width:0、`container-type:inline-size`；无整页卡片、无背景、无阴影、无圆角外框；区块间距 16px |
| 标题 / 引言 | 标题 16px/500/24px，`--dsw-alias-label-primary`；引言 12px/400/18px，secondary，上距 12px；页脚来源行 11px/16px，tertiary |
| 分项行 | padding 12px 0；行间 0.5px `--dsw-alias-border-l2`，首行无；行本身不是点击目标，只有行中按钮/链接可点；不设固定高度（见 §3.6） |
| 状态文字 | 6px 圆点（`--dsw-alias-state-*-primary`）+ 文字，gap 5px；文字 12px/18px；状态列 min-width 64px、右对齐，避免状态词切换时整行抖动 |
| 状态标签 | height 18px、padding 0 6px、11px/18px、radius-sm；底 `--dsw-alias-interactive-bg-hover`、字 secondary；成功/警告/错误用同色 10% 底 + 22% 边框；未知/过期用中性底，不借绿 |
| 输入 | height 34px、padding 0 10px、1px `--dsw-alias-border-l4`、radius-sm、透明底、13px/20px；只读用 readonly（可选中复制），不用 disabled；超时宽 220px、max-width:100% |
| 主 / 次按钮 | height 32px、padding 0 16px、12px/500/18px、radius-sm；主 = business-primary 底 + label-primary-inverted 字；次 = 透明底 + 1px border-l4；每页最多 1 个主按钮 |
| 说明 / 回执面 | padding 10px 12px、radius-md、底 interactive-bg-hover、无阴影；错误面加 1px `color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, transparent)`，同时必须有文字原因 |
| 折叠区 | 原生 `details/summary`（或等价 `aria-expanded`），summary 12px/18px secondary；展开内容与主体同左缘，不套缩进卡片 |

所有盒模型 `box-sizing:border-box`。几何自校验：标签 18px = 11px 字、行高 18px、无内距无边框，最长固定词“检查中…”按 4 字符 × 11px + 12px 内距 ≈ 56px < 64px（状态列/标签最小宽）；按钮 32px = 18px 行高居中；输入 34px = 20px 行高 + 上下 7px。若后续把标签改成带边框，须同时把高度改为 22px 并回改本节，不得两处并存。

### 0.2 状态反馈

- 按钮：hover `opacity:.92`（主）/ 底色 hover（次）；pressed `opacity:.86`，主按钮可 `scale(.98)`；100ms `var(--ds-ease-in-out)`；禁用 `opacity:.4`，并在按钮旁显示原因文字（原因不得只放在 title 里）。
- 输入：hover 边框 border-l3；focus 边框 business-primary、`outline:none`；invalid 边框 error-primary + `aria-invalid` + 关联原因文本。
- 所有可交互元素 `:focus-visible` 为 `var(--dsw-focus-ring-width,2px)` business-primary outline、offset 2px；焦点环预留 4px，容器不得 `overflow:hidden` 裁掉。
- 链接/文字按钮：secondary → hover label-primary，100ms；折叠箭头 rotate 180deg/100ms。
- 非交互行没有 hover 底色，避免让用户以为整行可点。

### 0.3 动效与加载

- 展开内容：opacity 0→1 + translateY(-2px)→0，160ms；不做高度动画（既有 `fdv-reveal`）。
- 加载骨架：3 组静态条（身份 / 本机配置 / 分项检查），组高 20px、行占位 108px（沿用 `skeletonRow`），1.2s opacity 1↔.55 呼吸；骨架旁必须有“正在读取…”文字，不以骨架替代状态文字。
- 检查中：该行按钮变“检查中…”并禁用，行中说明检查对象；不锁其他行。
- 回执（保存/应用/检查）就地保留到下次操作；唯一证据不得是自动消失的 toast。
- `prefers-reduced-motion: reduce` 关闭呼吸、旋转与过渡，瞬时替换。
- 无画布/游戏对象：hit-flash、轨迹、辉光规格不适用，也不得因此新增装饰性动效。

### 0.4 字体与数字

- 正文 12px/18px；字段标签 13px/500/20px；标题 16px/500/24px；不用 10px 以下字号。
- 超时毫秒、检查时间、配置基准短号用 `font-variant-numeric:tabular-nums`；版本标识与基准短号可 `ui-monospace` 12px。
- 中文为主，英文资源同键同语义；状态列右对齐且 `min-width:64px`。

### 0.5 空、错误、未知

- 三源独立读取，任一失败只影响自己的行：失败行显示“读取失败 / 不可达”+ 脱敏原因 + 重试；其余行照常。
- 未知 ≠ 未配置：未知用中性色 + “未知：<缺口>”；未配置用警告色；未安装单独一档。
- 首屏不得出现任何合并的“准备就绪/全部通过”结论；最坏情况是一页中性灰。

### 0.6 本产品明确禁止

1. 大号总绿灯、百分比准备分数、“企业联调已通过”。
2. 汇总页出现路径、endpoint、账号主体、授权 URL、原始 CLI 报错（这些只允许在各自配置页的编辑控件值里）。
3. 用前端隐藏元素或“维护者开关”冒充权限；公共参数区本轮只读。
4. 把“保存成功”渲染成“检查通过”，或把三件事合成一个“连接成功”。
5. 第二套登录/凭据入口、独立网页、Demo 入口、`file://` 安装段。
6. 新增品牌色、字体、龙纹背景、插图、庆祝动效。
7. 状态变化导致整行或状态列跳动；用截断隐藏“未知/已过期/失败原因”。

## 1. 依据、取代与未核验

### 1.1 文档信息

| 项 | 内容 |
|---|---|
| 编号/版本 | CORP-DSH-UI-R15 / V0.1 |
| 状态 | 草案；Agent 代拟；审核、批准待定 |
| 日期 | 2026-11-06 |
| 需求依据 | [本轮 PRD](<PRD.md>)，AC-1～21 |
| 设计基线 | [r14 DESIGN](<../20261106-r14-enterprise-iam-ui/DESIGN.md>) 的六态身份、四层证据、三行回执与脱敏原则；[r5 DESIGN](<../20261030-r5-devops-config-slimming/DESIGN.md>) 的宿主设置原生风格 |

### 1.2 已核对源码（2026-11-06，只读）

| 事实 | 位置 |
|---|---|
| 新分区可复用同包度量与样式 | `packages/forge-devops/client.js:72-178`（`METRICS` + `.fdv-*`） |
| 挂载必须是两段式 | `packages/forge-devops/client.js:992-1013`：`slots.inject('settings.section', () => slots.register({ name:'settings.section', id:'devops', order:60, ... }))` |
| 既有分区 id / order | `packages/forge-iam/client.js:4031-4047`（`forge-iam` / 30）、`packages/forge-devops/client.js:1000-1010`（`devops` / 60） |
| 身份非敏感视图端点 | `packages/forge-iam/src/routes.mjs:434-441`：GET `/api/forge-iam/view` → `service.getView()` |
| 身份状态取值 | `packages/forge-iam/src/state.mjs:6-10`：signed-out / authenticating / ready / expired / unreachable |
| DevOps 同源端点 | `packages/forge-devops/src/http.mjs:6,24`：前缀 `/api/forge-devops`，端点 `/cli` |
| Gitee 五键与默认值 | `packages/forge-gitee/src/runtime-config.mjs:35-57`：`cliPath`/`host`/`timeoutMs`/`authEnv`/`persistentToken`，默认 `gh` / 20s / warn |
| Gitee 目前没有 client 半 | `packages/forge-gitee/package.json` 无 `dsh.client`，`files` 不含 `client.js` |
| 样本 client 声明 | `packages/forge-devops/package.json` 的 `dsh.client`（web / immediately / inject `slots`,`locale`） |

### 1.3 对 r14 设计的取代与修订（本轮按此执行）

- **取代 r14 §3.2**：本机差异的编辑不再放进总览，改由**各插件自己的分区**承载（DevOps 既有页、Gitee 新页）。理由：AC-15 要求 Gitee 的 UI 由 Gitee 自己的 client 半承载，总览代管会变成第二套编辑器与第二份校验规则。
- **取代 r14 §3.1 的“本机差异”区**：总览只保留“本机覆盖项数 + 生效来源 + 跳转”，字段值不进入总览 DOM。
- **修订 r14 §0.1 的标签高度**：r14 写 22px + 1px 边框，与仓库真实样式（`tagHeight:18`、无边框，`client.js:122-178`）不一致；本轮按代码对齐为 18px。
- **沿用**：六态身份、四层证据、保存/应用/检查三行回执、基准与过期、复制诊断安全投影、零泄漏与“互不推导”。

### 1.4 未核验（技术阶段阻断项，设计不冒充完成）

1. 独立 profile 的 GUI 能否与本机桌面实例并存（PRD 风险 2）；不可达时 AC-16/19 只能 NOT RUN。
2. `/api/forge-iam/view` 在“只装 forge-devops 的独立 profile”里不存在——总览身份行必须显示“未安装企业账号插件”，这是设计接受的降级，不是错误。
3. Gitee 同源只读/写入端点的最终命名与形状（建议与 `/api/forge-devops/cli` 同形：GET 快照、POST `{revision, fields}`）、以及其 `configEditor` 落点；技术阶段核验后回填。
4. 设置壳是否提供 section 切换的公开通道；不存在时退化为文字指引（“设置 → 企业账号”），不猜路由。

## 2. 页面与信息架构

### 2.1 分区清单（id / order 本轮固定，技术阶段照抄）

| 分区 | 承载包 | slot 名 / id / order / label | 说明 |
|---|---|---|---|
| 企业研发 | `@heluo/forge-devops`（现有 client 半新增一个 section） | `settings.section` / `devops-readiness` / 29 / 企业研发 | 新增：准备总览，只读汇总 + 导航 + 分项检查 |
| 企业账号 | `@heluo/forge-iam` | `settings.section` / `forge-iam` / 30 / 企业账号 | 不改；唯一登录/退出/onboarding/网关凭据/模型入口 |
| 企业 Gitee | `@heluo/forge-gitee`（新增 client 半） | `settings.section` / `gitee` / 50 / 企业 Gitee | 新增：`cliPath`、`timeoutMs` 的本机差异与保存 |
| 企业 DevOps | `@heluo/forge-devops` | `settings.section` / `devops` / 60 / 企业 DevOps | 最小修订：保存回执补“已应用”、页脚来源 |

写法固定为 `slots.inject('settings.section', () => slots.register({ name:'settings.section', id, order, label }, Component))`：`inject` 参数与 `name` 逐字等于槽位名，插件标识只进 `id`（AC-16）。两个 DevOps 分区同包、共用同一份 CSS 与 `METRICS`，但 id 必须不同。

### 2.2 数据通道

| 数据 | 读取 | 写 | 读不到时 |
|---|---|---|---|
| 身份摘要 | GET `/api/forge-iam/view`（既有）→ 只投影白名单字段 | 无（只导航） | 404 → 未安装；超时 → 不可达；解析失败 → 未知 |
| DevOps 摘要 | GET `/api/forge-devops/cli`（既有快照） | 总览不写 | 未安装 / 读取失败 |
| Gitee 摘要 | 新增同源只读端点（与 DevOps 同形，技术阶段定名） | 总览不写 | 未安装 / 读取失败 |
| DevOps 检查 | GET `/api/forge-devops/cli?refresh=1`（既有，唯一重扫动作） | 不写配置 | 失败原因脱敏后显示 |
| Gitee 检查 | 本 profile 无已批准只读探测 → 不发起请求 | — | “未检查：未提供只读探测” |
| 诊断复制 | 前端本地构造安全 JSON | — | 复制失败就地提示 |

**身份投影白名单**（其余不渲染）：`state`、`accessExpiresAt`（仅相对时间文本）、`gatewayCredential.state`、`modelAccess.state`、`error.code`。禁止读取/渲染：`principal`、`baseURL`、`gatewayConsoleUrl`、token、authorizationUrl、邮箱/工号。

**DevOps / Gitee 摘要投影**：只取“生效来源枚举（配置 / 环境变量 / 自动发现 / 未知）”与“被本机覆盖的键名列表”（`dopBin`、`timeoutMs` / `cliPath`、`timeoutMs`）；数值与路径在解析后立即丢弃，页面只保留布尔与枚举。

### 2.3 导航与返回

- 总览 → 企业账号 / 企业 Gitee / 企业 DevOps：优先用设置壳的 section 切换；不可用时退化为文字指引，不做假按钮。
- 不复制身份上下文、不缓存会话；从账号页返回时重新读身份摘要，并把旧检查标“已过期”。

## 3. 关键页线框

### 3.1 企业研发（总览，首屏）

```text
企业研发
查看身份、公共参数与本机工具准备情况。本页不代表业务授权。
────────────────────────────────────────────
企业身份          [已登录]                [前往企业账号]
  身份与工具准备互不推导；不显示账号主体。
公共参数          [未知：无公共维护接口]
  ▸ 展开：来源名称 / 版本标识 / 作用域 / 权限说明
本机配置          [本机覆盖 1 项]          [管理本机配置]
  DevOps：生效来源 配置 · 覆盖 dopBin；Gitee：全部继承 · 生效来源 自动发现
DevOps            [未检查]                 [检查 DevOps]
  ▸ 展开：文件存在 / 可启动 / 目标可识别 / 只读业务；基准 k7f2 · 18:20:11 · 本地诊断
Gitee             [未知：无只读探测]        [检查 Gitee]（禁用）
  ▸ 展开：同上四层；缺证据层显示“未执行 + 原因”
业务写权限        [本页不提供业务授权；沿用原写门禁]
────────────────────────────────────────────
[刷新]                          [复制诊断]
页脚 11px：分区由 @heluo/forge-devops 0.1.0 提供 · 宿主 <版本> · 读取于 18:20:11
```

规则：
- “本机配置”行两行子摘要可各自折叠；窄屏换行，不出现横向滚动。
- 分项展开用 `details/summary`，展开不改变其它行状态。
- 首屏不出现合并结论；“业务写权限”行恒定存在且恒不说“已授权”。
- 版本取不到显示“版本未知”；页脚不显示路径。页脚来源行同时是 AC-16/19 的可见性证据（分区出现 = 已装载）。

### 3.2 身份六态与四组反例

| 状态（源） | 文案 | 摘要 | 下一步 |
|---|---|---|---|
| signed-out / 未配置 | 未登录 | 未在本机登录企业账号 | 前往企业账号 |
| authenticating | 登录中… | 在既有 IAM 流程完成或取消 | 返回账号页 |
| ready | 已登录 | 会话有效至 <相对时间> | 前往企业账号 |
| expired | 已过期 | 凭据过期，需重新登录 | 前往企业账号 |
| unreachable | 不可达 | 账号服务无法连接（脱敏原因） | 重试 / 前往账号页 |
| 退出结果未知（本地回执） | 退出未确认 | 退出请求结果未知，请到账号页核对 | 前往企业账号核对 |

四组反例由互不推导的分项自然呈现；页面底部固定一句：“四项互不推导：身份已登录 ≠ CLI 可用 ≠ Key 已验证 ≠ 已获业务授权。”该文案不得替代真实状态，也不得把未知涂成绿。

### 3.3 企业 Gitee（新增）

```text
企业 Gitee
配置本机的 gh 命令行与超时；凭据沿用既有全局配置。
[状态行：只读面可用 / 未配置 / 不可用 + 原因]
命令行入口                    [未配置 / 已手动指定]
  [输入框：当前生效值]  [改为手动指定] / [恢复继承]
  提示：保存后生效；本页不判后缀，运行期失败会说明原因。
超时（毫秒）                  [20000]            [保存]
  保存：未改动 / 已保存；运行时已应用 / 冲突 / 失败（逐字段原因）
主机            [未配置]        （值不在本页显示）
凭据变量名      [未配置]        （只显示允许的变量名，不显示值）
持久化策略      [warn · 沿用默认，不在本页修改]
▸ 检查详情（无探测能力时：未执行 + 原因）
```

- 只有 `cliPath` / `timeoutMs` 可编辑；`host`、`authEnv`、`persistentToken` 只读呈现“未配置/已配置”与变量名。
- 无自动发现能力，不渲染“重新自动发现”；“恢复继承”先说明“保存后只删除本键的本机覆盖”。
- 保存只提交 dirty 的已知键 + revision；冲突保留草稿并要求重新读取，不自动覆盖。

### 3.4 企业 DevOps（最小修订）

保留现有字段面、状态行与请求契约，只加两项：
1. 保存回执区分“已保存；运行时已应用”与“已保存；未应用”（按接口实际语义，不伪造）。
2. 页脚 11px 来源行：`分区由 @heluo/forge-devops <版本> 提供 · 读取于 <时间>`。

不改 id / order / 字段 / 隐藏键策略，不新增第二个保存按钮。

### 3.5 公共参数（只读）

展开顺序：作用域 → 来源名称 / 版本基准 → 已核验字段名（只读） → 权限说明 → 回执。
- 默认文案：“只读：尚无可核验的公共维护权限/接口。本机配置仍可维护。”
- 不渲染任何可编辑控件；不搬 Demo 的维护者开关；不显示 endpoint / path 原值。
- 若技术阶段证实存在获权维护通道，须另立 AC 并更新本节，不在实现里偷偷放开。

### 3.6 几何与响应式

- 参考内容宽 564px（沿用 r5 历史测试点，不宣称宿主实测）；`@container (max-width:519px)` 与既有页一致。
- 宽 ≥520px：标题行 flex，标题 `flex:1;min-width:0`，状态列 `min-width:64px` 右对齐，操作列不收缩，gap 8px。
- 宽 <520px：状态与操作换到下一行；行高由内容决定（宽屏约 78px，窄屏约 106px），**不设固定高**；骨架占位 108px。
- 宽 320px + 200% 缩放：无页面横向滚动；版本号、时间 `overflow-wrap:anywhere`；按钮换行保持 8px 间距。
- 焦点轮廓、展开内容与最后一行操作不得被容器裁切；操作区不 fixed。

## 4. 交互、失败与并发语义

1. **进入**：并行读三源；任一失败只影响自身行；超时按“不可达”呈现（预算沿用既有端点常量，技术阶段引用，不新造数字）。
2. **刷新**：显式按钮重读三源；不自动重扫——`?refresh=1` 只由“检查 DevOps”触发。
3. **检查**：状态机 未检查 → 检查中 → 通过 / 失败 / 未知；结果带 基准短号 + 时间 + 来源类型（本地诊断 / 夹具 / 企业真实证据）。检查不写配置；检查使用当前生效配置，有未保存草稿时先提示。
4. **过期与迟到**：身份上下文变化、配置基准变化或从其它分区保存返回后，旧结果标“已过期”并保留旧基准；回包按代次丢弃（代次 = 读取序号 + 身份 epoch + 配置 revision），迟到结果不得覆盖当前状态。
5. **保存**（DevOps / Gitee 页）：仅提交 dirty 已知键；无改动或保存中禁用；逐字段失败聚焦首个错误且写入 0 次；冲突保留草稿。
6. **应用**：接口保存即重建时写“已保存；运行时已应用”，否则单独“应用”动作；失败/未知显示已保存基准与生效基准，不自动重放。
7. **复制诊断**：只含插件名、状态词、原因码、时间、基准短号、来源类型；不含值、路径、endpoint、主体、token、URL；构造失败则禁用并显示原因。
8. **键盘**：Tab 顺序 = 视觉顺序；展开/收起用 Enter / Space；复制成功与失败都有 `role=status` 文案，不只变色。

## 5. 状态词、文案与可访问性

| 状态 | 文案 | 颜色 | 下一步 |
|---|---|---|---|
| 未检查 | 未检查 | 中性 | 检查（若有能力） |
| 检查中 | 检查中… | 信息 | 等待 |
| 通过 | 本项检查通过（不写“企业就绪”） | 绿 | 查看证据 |
| 失败 | 检查失败 + 脱敏原因 | 红 | 修正本机配置 |
| 未知 | 未知：<缺口> | 中性 | 查看能力限制 |
| 已过期 | 已过期（旧时间） | 中性 | 重新检查 |
| 未配置 | 未配置 | 警告 | 前往该插件分区 |
| 未安装 | 未安装 | 中性 | 由管理员安装该插件 |
| 未执行 | 未执行：无已批准探测 | 中性 | 说明限制 |

- 每行状态 `role="status"` + `aria-live="polite"`；加载容器 `aria-busy`；表单错误 `aria-describedby` + `aria-invalid`；折叠 `aria-expanded`。
- 状态始终有文字，不只靠色点；正文对比度 ≥4.5:1，控件边界/焦点 ≥3:1；浅色与深色主题都验证。
- 命中区 ≥24×24px，主按钮 32px 高；页面滚动后所有操作可达。
- 中文为主；en 资源同键同语义（unknown ≠ not configured，applied ≠ saved）。

## 6. 设计验收对照

| PRD | 必须可观察 |
|---|---|
| AC-1～3 | 唯一 IAM 跳转；九种状态词按 §5；四组反例同屏且互不推导；迟到响应不复活绿灯 |
| AC-4 | 公共参数 / 本机覆盖 / 生效来源三层同屏；未知带原因，不用默认值冒充 |
| AC-5～6 | 两页各自增量保存；恢复继承只删键；冲突不覆盖、草稿不丢；凭据值 0 呈现 |
| AC-7 | 公共区只读 + 作用域 + 权限说明；无维护开关 |
| AC-8～9 | 保存/应用/检查三行回执；基准 + 时间 + 过期；`?refresh=1` 只出现在检查动作 |
| AC-10～12 | 四层证据分项；无探测保持未知；复制诊断无路径与凭据 |
| AC-13 | 既有设置壳、id/order 固定、键盘与读屏、320px / 200%、浅深主题 |
| AC-14～16、19 | 分区在 GUI 中真实出现（label + 页脚来源行即证据）；技术阶段以截图或 aria 快照留证，设计不代替证据 |
| AC-17～18、21 | 不影响视觉；页脚版本来自真实包；装不上时不出现、也不伪造 |

**独立 profile 走查清单**：四组反例一起看；三源部分失败；检查失败/未知/过期；保存冲突；Gitee 未安装；320px 与 200% 缩放；键盘全路径；reduced-motion；浅/深主题；复制诊断后粘贴检查内容。

## 7. 技术交接

1. **挂载**：两个新 section 一律两段式 `inject → register`；`name` 必须是 `settings.section`；id/order 见 §2.1，实现里不得改。槽位未声明时等待声明，禁止直接 `register`（否则静默消失、单测全绿也看不到）。
2. **Gitee 包形态**：新增 `client.js`、`dsh.client`（platform web / immediately / inject slots,locale）、`files` 收录、`exports` 增 `./client`；宿主模块（react、`@deepseek-ai/*`）只进 `peerDependencies` + `peerDependenciesMeta.optional`，不进 dependencies（AC-15/17/18）。
3. **样式**：DevOps 包内复用 `.fdv-*` 与 `METRICS`，新行用 `fdv-` 前缀扩展；Gitee 包内自建 `fge-*`，数值照抄 §0，不 import 对方源码。
4. **读取预算**：沿用既有端点常量；新增 Gitee 端点须有与既有端点等价的超时、输出上限与脱敏约束。
5. **证据**：技术阶段回填端点定名、revision 形状、section 切换能力、独立 profile GUI 结果；本设计不声称已安装、未改日常 profile、未联调。
