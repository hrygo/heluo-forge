<!-- meta: summary="为 forge-devops 设计宿主设置页内的「DevOps 变更流程」分区：入口卡只读显示自动发现结果 + 覆盖/回落、4 个可选字段、逐字段校验与保存即生效；全部复用宿主 token 与表单原语，仅新增 4 个小组件。" -->
基线依赖：docs/teamflow/20261029-r3-cli-path-autodiscovery/PRD.md（15 条 AC）、docs/teamflow/20261028-r1-devops-change-flow/PRD.md#AC-22（固定 argv / fail closed / 不硬编码三条不变）
取代：本需求 PRD §6 交互流程中「用户点"选择文件"」一句——宿主 Web 端拿不到文件级绝对路径（§2.3 列证据），改为「只读显示生效路径 + 改为手动指定 + 粘贴/手填 + 保存时逐字段校验」，与 AC-7「可覆盖为手填」一致；PRD §11 的 T2 待澄清项在此定为「Settings 侧栏新分区」。

# DESIGN — CLI 路径自动发现与插件配置页

## 0. 视觉与观感意图（先读这一节）

**一句话意图**：这一页必须像宿主的第 N 个原生设置分区（与「模型」「内置插件」同级），**安静、可信、零装饰**。信息层级只靠字号/字重与 0.5px 分隔线表达，不靠彩色卡片、阴影、图标墙。用户在正常情况下**什么都不用做**就能关掉这一页——页面要让人一眼看到"已经在用哪个程序"，而不是看到一张要填的表。

### 0.1 表面处理

| 元素 | 规格（可直接实现） |
|---|---|
| 页面容器 | 不加卡片、不加外框、不加背景色：直接坐在宿主设置面板 `.options` 的 layer-2 上，左右 24px 内边距由宿主提供（本页不再加水平内距） |
| 分组容器（命令行入口） | `border: .5px solid var(--dsw-alias-border-l4)`；`border-radius: var(--dsw-radius-lg)`（16px）；`padding: 4px 16px`；**不填背景**（与页面同色，只用描边圈组） |
| 区间分隔 | `.5px solid var(--dsw-alias-border-l2)`（宿主字段分隔线同款），只在同组内相邻字段之间出现 |
| 输入框 | 复用宿主度量：高 34px、`padding: 0 12px`、`border: .5px solid var(--dsw-alias-border-l4)`、`border-radius: var(--dsw-radius-md)`（12px）、`background: var(--dsw-alias-bg-layer-3)`、字号 13px |
| 状态行 | 高 36px、`padding: 0 12px`、`border-radius: var(--dsw-radius-md)`、`background: var(--dsw-alias-interactive-bg-hover)`（浅色 `#2631480f` / 深色 `#ffffff14`）；左侧 6px 状态点，右侧文本动作 |
| 徽标 | 宿主 `Tag` 原样，`tone` 只用 `neutral` / `quiet` / `info` / `danger`，不新增色板 |
| 按钮 | 保存 = 宿主 `_save_` 规格：13px、`padding: 5px 14px`、`radius-md`、`background: var(--dsw-alias-label-primary)`、文字 `var(--dsw-alias-bg-layer-3)`、disabled `opacity: .4` |
| 文本动作 | 12px、`color: var(--dsw-alias-label-secondary)`、无背景无边框、`min-height: 28px`（触屏可点）×(与 `margin: -6px -4px` 抵消视觉行高) |
| 圆角体系 | 只用宿主 token：`sm 8px` / `md 12px` / `lg 16px` / `panel 28px`；宿主已启用 `corner-shape: superellipse(1.5)`，本页不覆盖、不自绘圆角 |
| 阴影 / 渐变 / 发光 | **零**。全页不用 `box-shadow`、渐变、彩色底、半透明遮罩。唯一"有重量"的色块是保存按钮（`label-primary` 实心） |

### 0.2 状态反馈（数值固定）

| 交互 | 变化 | 时长 / 曲线 |
|---|---|---|
| 输入 focus | `border-color → var(--dsw-alias-state-business-primary)`（浅色 `#4176e6`），**不加 outline**（与宿主字段规则一致） | `border-color` 100ms `var(--ds-ease-in-out)` |
| 输入 invalid | `border-color → var(--dsw-alias-state-error-primary)`（浅色 `#ec1313`）+ 下方 12px 红字；不抖动、不加图标、不弹窗 | 同上 100ms |
| 按钮 hover | `opacity: .92` | 100ms |
| 按钮 active | `opacity: .86` + `transform: scale(.98)` | 100ms |
| 按钮 disabled | `opacity: .4`、`cursor: default`，无 hover 反馈 | — |
| focus-visible（按钮/文本动作） | `outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary)`；`outline-offset: 1px` | 100ms |
| 文本动作 hover | `color: label-secondary → label-primary` | 100ms |
| 状态点 | `background-color` 过渡：`ready` = `--dsw-static-green-500`（`#22c55e`）/ `未找到` = `--dsw-static-amber-500`（`#f59e0b`）/ `不可用` = `--dsw-static-red-600`（`#ec1313`） | 160ms |
| 保存成功 | footer 左侧出现 12px「已保存」`label-secondary`，编辑任一字段后消失 | 不做定时淡出（淡出会让人以为没保存） |

### 0.3 动效、加载态、空态、错误态

- **首次加载**（配置面未就绪 / 首次发现未回）：入口区两行为 34px 高骨架条，背景 `--dsw-alias-interactive-bg-hover`，圆角 `md`；呼吸 `opacity: 1 → .55 → 1`，1.2s `ease-in-out infinite`。字段网格同高占位，避免页面跳动。
- **重新自动发现**：按钮文案变「检测中…」并 disabled；状态行换为「正在检测命令行位置」；结果回来 160ms 内更新状态点与文案。**结论未变时必须给反馈**：状态行追加「位置未变」（要么给反馈，要么完全不动，不允许"点了没反应"）。
- **多候选展开**：容器 `height 0 → auto`；内容 `opacity 0 → 1`、`translateY(-2px) → 0`，160ms `cubic-bezier(.4, 0, .2, 1)`；箭头 `rotate(0 → 180deg)`，100ms。
- **空态**：入口区不会空白——未配置且已发现 → 只读显示命中路径；未配置且未发现 → 同一位置显示「未找到」+ 一行修复指引。空态即错误态，不画插图、不给"开始配置"大按钮。
- **错误**：字段级错误只出现在该字段下方 12px 红字（`role` 由宿主 hint 承担）；页面级不可用（配置面缺失、只读面不可用）走顶部状态行。「未找到」是 **amber 不是 red**：它不是用户做错了什么。
- **`prefers-reduced-motion: reduce`**：关闭骨架呼吸与展开位移，只保留瞬时替换（无过渡）。

### 0.4 字体角色

| 角色 | 规格 |
|---|---|
| 页面标题 | 16px / 500 / line-height 24，`label-primary`（与设置导航标题同级） |
| 分组标题 | 13px / 600 / line-height 20，`label-primary`，下留 8px |
| 字段标签 | 13px / 500 / line-height 20（宿主规格） |
| 输入值 | 13px / 400，文本字体（**不用等宽**：路径含中文目录时等宽反而难读，且要与宿主输入视觉一致） |
| 说明 / 错误 | 12px / 400 / line-height 18；说明 `label-tertiary`，错误 `state-error-primary` |
| 状态行 | 主文 13px / 400；右侧动作 12px |
| 候选列表 | 12px / 400 / line-height 18，`word-break: break-all`（长 UNC / 中文目录必须换行而不是横向滚动） |
| 数字 | `timeoutMs`、已查类数、候选数用 `font-variant-numeric: tabular-nums` |
| 强调 | 全页只有两处：保存按钮（实心）、状态行的状态词（500 字重）。其余一律不加粗 |

### 0.5 本产品的反模式（明确禁止）

1. **首屏出现必填红星 / 「必填」标记**（AG-4）：本页没有必填标记；唯一必需的 dop 入口由状态行与入口卡 hint 表达。
2. **用 `disabled` 灰掉发现结果**：用户要能选中复制路径 → 只读用 `readonly`，永不用 `disabled`。
3. **把 origin 藏进 tooltip 或只给颜色**（AC-3/AC-7）：必须有可见文字 Tag（`自动发现`/`环境变量`/`配置`/`未找到`）。
4. **假成功**（AG-2）：footer 说「已保存」而状态行没变——保存后必须重读宿主状态并 ≤1s 内更新。
5. **页面之外露路径**（AC-10 / AG-5）：本页是本机绝对路径的唯一显示处；toast、工具输出、报告、日志一律不出现。
6. **主句写机器码**（AG-3）：`NO_READER`、`CONFIG_MISSING`、`FORGE_DEVOPS_DOP_BIN` 只能出现在「所以我需要手动设置」这类次级说明里，不能当主句。
7. **画一个 `<input type="file">`「选择文件」按钮**：Web 端拿不到绝对路径，它必然是个假按钮（证据见 §2.3）。
8. **同时出现两块彩色信息**：状态行 + 警告条 + toast 三选一，页面级提示只允许出现在状态行。
9. **转圈超过 300ms 没有文案**（AC-4 预算 300ms）。
10. **自造字体 / 自造颜色 / 加渐变与投影**：本页是宿主设置页的一部分，视觉上必须"看不出是插件"。

### 0.6 几何自洽（先算清楚再画）

宿主设置面板实测：`800 × min(800, 100vh − 48)`；左侧导航栏 188px；头部 54px；内容区 `padding: 0 24px 24px`。
→ **内容宽 = 800 − 188 − 48 = 564px**；**内容高 = 面板高 − 54 − 24**。

静态度量（px，含间距）：

| 区块 | 计算 | 高度 |
|---|---|---|
| 标题 + 引导句 | 24 +（18 + 12） | 54 |
| 状态行 | 18 + 12 | 30 |
| 分组标题「命令行入口」 | 20 + 8 | 28 |
| 入口卡 ×2 + 分隔 + 容器内距 | (12+20+6+34+6+18+12) × 2 + 0.5 + 8 | 225 |
| 分组标题「连接与身份」 | 20 + 8 | 28 |
| 字段网格 2×2 | (12+20+6+34+6+18+12) × 2 | 216 |
| 页脚 | 16 + 32 | 48 |
| **合计** | | **629** |

- 标准面板 800 → 内容高 722 → **余 93px**。
- 视口高 768（面板 720）→ 内容高 642 → **余 13px**：仍满足 AC-6「一屏可见全部 6 个字段」。
- 视口高 < 756 时允许纵向滚动，但**两个入口卡必须留在首屏**（`629 − 48` 页脚以上 ≤ 内容高即成立）。
- 约束：状态行文案 ≤ 40 个全角字符（564px ÷ 12px 字号 ≈ 47 字），超长一律截断并放进展开区——保证换行永不出现，629px 算账才成立。
- 字段网格单元宽 = (564 − 16) ÷ 2 = **274px**；路径输入在该宽度下可显示约 38 个半角字符，其余靠只读输入的横向滚动 + 全选复制（不换行，避免行高变化破坏算账）。

## 1. 设计基线与偏离

**复用（不重画）**：`settings.section` 槽位与设置面板外壳、`SettingsForm`（保存/保存中/失败/只读/不可用五态与 footer）、`SettingsValueField`（label + 输入 + hint/error + `aria-describedby` 全套）、`SettingsFormModel`（staged/distinct/invalid/save 语义）、`Tag`、`ctx.locale` 中英文案、主题 token（`--dsw-*`）。

**新增（4 个，全部按宿主度量复刻，看起来与原生字段同族）**：
1. `CliEntryField`：宿主 `SettingsValueField` 的结构 + 三处扩展——① `readonly` 态（origin ≠ `config` 时只读显示生效路径，可聚焦可选可复制）；② head 右侧 origin `Tag`；③ input 下方一行「hint（左）+ 文本动作（右）」。
2. `SegmentedField`：2 值枚举（`mock` / `enterprise`）的分段控件，替代自由文本输入，从源头消灭非法值（AC-9）。宿主无 select 原语，故新增；交互沿用宿主 tabs 的 roving tabindex + 左右箭头。
3. `StatusLine`：页面级唯一提示位（状态点 + 主文 + 文本动作），`role="status" aria-live="polite"`。
4. `CandidateList`：多候选展开区（AG-1「备选可见」）。

**补宿主未定义的状态反馈**：宿主保存按钮与文本动作没有 hover/active 定义，本页按 §0.2 补齐（只影响本页，不改宿主组件）。

**修正而非新增**：入口卡不是宿主字段原样——因为需要「只读显示 + 覆盖语义 + 来源徽标」，但 label 13/500、input 34px、hint 12/18、field padding 12px 0、相邻字段 `.5px border-l2` 五项度量与宿主逐项一致，所以同一页里看不出两套体系。

## 2. 页面与信息架构

### 2.1 页面清单

只有 **1 页**（不做二级导航、不做向导）：

| 单元 | 作用 | 对应 AC |
|---|---|---|
| 标题 + 引导句 | 身份（「DevOps 变更流程」）+ 一句话告诉用户「正常情况下你不用填」 | AC-6、AG-4 |
| 状态行 | 只读面是否可用 + 当前由哪几层提供入口 + 「重新自动发现」 | AC-3、AC-5、AC-7、AG-2 |
| 命令行入口（2 张入口卡） | dop / gh 的生效路径、origin、覆盖、回落、候选展开 | AC-1、AC-2、AC-3、AC-7、AG-1 |
| 连接与身份（4 字段 2×2） | `dopEndpoint` / `ghOwner` / `sourceType` / `timeoutMs`，全部可留空（除已由宿主决定默认值） | AC-6、AC-9 |
| 页脚 | 保存 / 保存中 / 失败 / 已保存 | AC-8、AC-9、AG-2 |

### 2.2 进入路径与点击预算（AC-6 ≤2 次）

`首页 → 左下「设置」（第 1 次）→ 设置侧栏「DevOps 变更流程」（第 2 次）`

- 注册：`ctx.slots.register({ name: "settings.section", id: "devops", order: 60, label: () => t("nav") }, DevopsSection)`，插在「内置插件」之后。
- 导航文案「DevOps 变更流程」必须与插件身份一致（AC-6「页面标题与插件身份一致」，二者用同一 i18n 键的不同字段：`nav` / `title`）。
- 设置面板内是常驻左侧导航（188px），故第 2 次点击必然命中，不存在二级页。

### 2.3 被否决的方案（附证据，避免下次重议）

| 方案 | 否决理由 |
|---|---|
| 放在插件管理页（`plugins.item`） | 该槽位由插件管理页渲染为**卡片 → 点开才进入详情**，实际路径为「设置 → 内置插件 → 插件卡片」= 3 次点击，超 AC-6；且语义是"管理插件"而非"配置变更流程" |
| 独立全屏路由（如 `/devops/settings`） | 需新增 Web 路由与鉴权面，超出 PRD「配置页只写配置、不新增命令面」范围 |
| 让人手改 profile YAML | PRD 明确反对；且注释保留/陈旧写入冲突需宿主 `config-editor` 才安全 |
| 「选择文件」按钮 / 原生文件选择 | 宿主目录选择 seam **只选目录**（浏览后端的列举"只返回目录"；Windows 原生后端返回目录路径），插件也未持有该客户端服务；浏览器 `<input type="file">` 不暴露绝对路径。→ 修复动作定为「粘贴/手填 + 保存时校验」，并把「在资源管理器里复制文件地址」写进 hint 一句话 |
| 把发现结果回写成显式配置（PRD T4 选项 B） | 会让 origin 恒为 `config`，换机/换目录不再自动跟随，且违反 AC-7「未改动时不得写入等值噪声」 |

## 3. 关键页面线框

### 3.1 默认态（自动发现双双命中，用户零操作）

```
设置 · DevOps 变更流程                                 内容宽 564px
────────────────────────────────────────────────────────────────────
DevOps 变更流程                                            16/500
插件会自己找 dop 与 gh；只有找不到时才需要你指定位置。      12/18
                                                                   54
● 只读面 ready · dop、gh 均由自动发现命中      [重新自动发现]     30
                                                                   
命令行入口                                                        28
┌──────────────────────────────────────────────────────────────────┐
│ dop 可执行文件              [自动发现]                          20
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ %ProgramFiles%\Corp\dop\dop.exe            （只读，可复制）    │ │34
│ └──────────────────────────────────────────────────────────────┘ │
│ 自动发现命中 · 另有 1 个候选           [改为手动指定]      12/18 │
├──────────────────────────────────────────────────────────────────┤
│ gh 可执行文件               [环境变量]                          │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ %ProgramFiles%\Git\cmd\gh.exe                                 │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ 来自环境变量 · 在此保存将覆盖它        [改为手动指定]            │
└──────────────────────────────────────────────────────────────────┘
                                                              225
连接与身份                                                        28
┌─ dop 服务地址 ─────────────────┬─ gh 组织 / 用户 ────────────────┐
│ [                                    ] │ [                          ] │
│ http 或 https 地址，不含凭据           │ 字母/数字/连字符，首字符非连字符 │
├──────────────────────────────────┼─────────────────────────────────┤
│ 事实来源  [ mock │ enterprise ]    │ 超时（毫秒）  [ 20000 ]         │
│ 默认 mock                          │ 1000–600000，默认 20000         │
└──────────────────────────────────┴─────────────────────────────────┘
                                                              216
                                                      [ 保存 ]
                                                                   48
```

要点：
- **首屏没有任何输入框是空的必填项**（AG-4）；两张入口卡是只读展示，用户"只需看"。
- 状态行给出唯一结论；`[重新自动发现]` 是唯一全局动作。
- 保存按钮初始 `disabled`（未改动，宿主 `SettingsForm` 行为）。

### 3.2 未找到态（修复路径的起点）

```
● 未找到 dop · 已查 PATH、候选目录、环境变量    [重新自动发现]     ← amber
命令行入口
┌──────────────────────────────────────────────────────────────────┐
│ dop 可执行文件              [未找到]                             │
│ [ 粘贴 dop.exe 的完整路径 ]                          （可输入）  │
│ 未找到 · 已查 PATH、候选目录、环境变量   [粘贴后保存即生效]      │
└──────────────────────────────────────────────────────────────────┘
```

- 该入口卡自动进入 **editing**（输入可用、不预先填值），光标不自动抢焦点（避免页面打开就跳）。
- `gh` 卡若已命中则保持只读展示。
- 文案不含环境变量名做主句；「只用环境变量也可以」这句话放在展开的次级说明里。
- 页面仍是 amber 不是 red：状态点 `#f59e0b`。

### 3.3 覆盖态（origin = config，且配置压过环境变量）

```
│ dop 可执行文件     [配置] [覆盖环境变量]        [重置为自动发现]  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ %ProgramFiles%\Corp\dop\dop.exe                     （可编辑） │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ 已手动指定 · 清空即回落自动发现                                  │
```

- **AC-3 的来源差异必须可见**：同时存在环境变量时 head 右侧加 `Tag`「覆盖环境变量」（`tone="quiet"`），不允许静默覆盖。
- 输入可直接编辑；清空后保存 = 回落下一层（AC-7 末句），不需要卸载重装。

### 3.4 不可写 / 不可用（R1 降级，不假装能填）

```
DevOps 变更流程
当前 profile 没有挂载配置面（settings / config-editor），这里无法保存。
可以改用环境变量：
  FORGE_DEVOPS_DOP_BIN        dop 可执行文件
  FORGE_DEVOPS_GH_BIN         gh 可执行文件
详见 packages/forge-devops/README.zh.md
```

- 此时**不渲染表单**（不出现禁用输入 + 灰保存按钮的"看起来能填"），只给解释与出口。
- 只读面若仍 `no-reader`，状态行显示「只读面不可用 · 缺少 dop 入口」这类**类别名**，不出现任何路径或 endpoint。

### 3.5 保存中 / 保存失败

| 状态 | 表现 |
|---|---|
| 有改动 | 保存按钮启用；footer 无提示 |
| 保存中 | 按钮文案「保存中…」+ disabled；字段保持可读 |
| 成功 | footer 左侧「已保存」（12px）；状态行 ≤1s 内刷新（AG-2） |
| 失败（校验） | 逐字段红边 + 红字；焦点移到第一个非法字段；footer 不出现"保存失败"总述（避免一处错误两条信息） |
| 失败（陈旧写入 / 并发，AC-9） | footer 红字「配置已被其它窗口改动」+ 文本动作「刷新」，不静默覆盖 |

### 3.6 多候选展开（AG-1：选择过程可见）

```
│ 自动发现命中 · 另有 1 个候选 ⌄         [改为手动指定]            │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ %LOCALAPPDATA%\Programs\corp-dop\dop.exe      （备选 1）      │ │
│ │ %ProgramFiles%\Corp\dop\dop.exe               [当前生效]      │ │
│ └──────────────────────────────────────────────────────────────┘ │
```

- 默认收起，只在 hint 行显示「另有 N 个候选」（不占高度）；展开后逐行显示全部候选，当前生效项带 `Tag`「当前生效」。
- **静默取首个并在页面明示**（PRD T1 的推荐项）：不因多候选就判未找到——否则"零配置可用"在装了多份的企业机器上直接失效。

## 4. 交互与状态机

### 4.1 发现（页面级）

`idle → checking → found(1..n) | missing`，触发点**只有两个**：页面挂载、点「重新自动发现」（AC-4：任何一次工具调用都不触发扫描）。结论未变时状态行补「位置未变」。

### 4.2 入口字段（dopBin / ghBin）

```
resolved(origin ≠ config，只读)
   └─[改为手动指定]→ editing(预填当前生效值，staged)
          └─[保存]→ origin = config（可编辑）
                 └─[重置为自动发现 / 清空后保存]→ resolved
```

- `resolved` 态输入为 `readonly`：可聚焦、可全选、可复制；`Tab` 可达；不响应编辑。
- `editing` 态直接可编辑；`blur` 时校验一次（不存在/是目录/`.cmd` 等），此后该字段边输边复验（**只有已经出错的字段才实时报错**，避免打字就飘红）。
- 空值 = 「清除该层」，回落下一层：`config → env → discovered`，三级互不排斥（AC-3 / AC-11）。

### 4.3 校验与保存（AC-9）

- 时机：字段 `blur`、保存前全量校验（表驱动，一处定义）。
- 任一项非法 → 拒存，磁盘既有配置保持原样，焦点移到第一个非法字段。
- 未改动（`dirty=false`）时保存 disabled；**从不提交等值或空值噪声**（AC-7）。
- `Enter` 在输入框内**不触发保存**（避免误存）；保存只认按钮。

### 4.4 键盘与焦点顺序

`重新自动发现 → dop 卡（只读输入 / 文本动作 / 候选展开）→ gh 卡 → dopEndpoint → ghOwner → sourceType（左右箭头切段）→ timeoutMs → 保存`。不做焦点陷阱；`Esc` 关闭面板由宿主负责。

## 5. 视觉规格

### 5.1 Token 取值（来自宿主 `ui-theme` 基础样式，本页只引用不覆盖）

| token | 值 |
|---|---|
| `--dsw-radius-sm / md / lg / panel` | 8px / 12px / 16px / 28px |
| `--dsw-focus-ring-width` | 2px（颜色取 `--dsw-alias-state-business-primary`） |
| `--ds-ease-in-out` / `--ds-transition-duration(-fast)` | `cubic-bezier(.4,0,.2,1)` / `.2s`（`.1s`） |
| `--dsw-alias-label-primary / secondary / tertiary` | `#0f1115` / `#61666b` / `#81858c`（浅色） |
| `--dsw-alias-border-l2 / l4` | `#0000001a` / `#00000029`（浅色；深色 `#ffffff1f` / `#ffffff33`） |
| `--dsw-alias-interactive-bg-hover` | `#2631480f`（深色 `#ffffff14`） |
| `--dsw-alias-state-business / success / warn / error-primary` | `#4176e6` / `#22c55e` / `#f59e0b` / `#ec1313` |
| 字体 | 文本 `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", …`（Windows 上即 Segoe UI + 微软雅黑）；代码字体仅用于展开区的路径行 |

### 5.2 组件规格表

| 组件 | 结构与度量 | 状态 |
|---|---|---|
| `StatusLine` | 高 36、`padding: 0 12px`、`radius-md`、`background: interactive-bg-hover`、点 6px、文字 13/400、右侧动作 12px、`gap: 8` | ready / checking / missing(amber) / unavailable(red) |
| `CliEntryField` | `padding: 12px 0`；head 20px（label 13/500 + `Tag` gap 8 + 文本动作）；input 34px；action 行 18px（左 hint 12/18 `label-tertiary`，右动作 12px，`gap: 8`，hint `text-overflow: ellipsis; white-space: nowrap`） | resolved / editing / invalid / saving / disabled（仅不可写时禁用） |
| `SegmentedField` | 轨道 34px、`padding: 3px`、`radius-md`、`background: interactive-bg-hover`；段高 28、`padding: 0 12px`、12/500、`radius-sm`；选中段 `background: bg-layer-3` + `.5px border-l4` + `label-primary`；未选 `label-secondary` | hover / selected / focus-visible（roving tabindex） |
| `CandidateList` | 展开区在 action 行下方；每项 `padding: 6px 0`，相邻 `.5px border-l2`；路径 12px `word-break: break-all`；当前项带 `Tag` | collapsed / expanded |
| 字段网格 | `display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px`；每格 `padding: 12px 0`；第二行两格加 `.5px border-l2` 上边线 | — |
| 页脚 | `padding-top: 16`；保存按钮右对齐；成功文案在左（12px，`label-secondary`），失败文案在左（12px，`state-error-primary`） | idle / saving / saved / failed |

响应式：内容宽 < 520px（窄视口）时字段网格降为单列、`CandidateList` 允许滚动；不出现横向滚动条。

## 6. 文案表（zh 为准，en 同键镜像）

i18n 命名空间 `forge-devops`；`t("nav")` = 「DevOps 变更流程」。

| key | zh |
|---|---|
| `title` | DevOps 变更流程 |
| `intro` | 插件会自己找 dop 与 gh；只有找不到时才需要你指定位置。 |
| `status.ready` | 只读面 ready · {summary} |
| `status.checking` | 正在检测命令行位置 |
| `status.unchanged` | 位置未变 |
| `status.missing` | 未找到 {cli} · 已查 PATH、候选目录、环境变量 |
| `status.unavailable` | 只读面不可用 · {reason} |
| `action.rediscover` / `.busy` | 重新自动发现 / 检测中… |
| `entry.dop` / `entry.gh` | dop 可执行文件 / gh 可执行文件 |
| `origin.config` / `.env` / `.discovered` / `.missing` | 配置 / 环境变量 / 自动发现 / 未找到 |
| `origin.overridesEnv` | 覆盖环境变量 |
| `entry.hint.discovered` | 自动发现命中 · 另有 {n} 个候选 |
| `entry.hint.env` | 来自环境变量 · 在此保存将覆盖它 |
| `entry.hint.config` | 已手动指定 · 清空即回落自动发现 |
| `entry.hint.missing` | 未找到 · 已查 PATH、候选目录、环境变量 |
| `entry.hint.help` | 在资源管理器里右键 dop.exe →「复制文件地址」，粘贴到这里 |
| `action.takeOver` / `.reset` / `.fillPath` | 改为手动指定 / 重置为自动发现 / 填入路径 |
| `candidates.summary` / `.current` | 另有 {n} 个候选 / 当前生效 |
| `field.dopEndpoint` | dop 服务地址 |
| `field.dopEndpoint.hint` | http 或 https 地址，不含凭据；留空则不配置 |
| `field.ghOwner` / `.hint` | gh 组织 / 用户 · 字母、数字与连字符，首字符不能是连字符 |
| `field.sourceType` / `.hint` | 事实来源 · mock = 本地模拟，enterprise = 企业实测；默认 mock |
| `field.timeoutMs` / `.hint` | 超时（毫秒） · 1000–600000，默认 20000 |
| `error.notFound` | 找不到这个文件 |
| `error.isDirectory` | 这是目录，需要指向 dop.exe 本体 |
| `error.wrapperScript` | .cmd / .bat 包装脚本不能直接执行，请指向 .exe |
| `error.endpoint` | 需要 http 或 https 地址，且地址里不能带用户名密码 |
| `error.owner` | 只能是字母、数字和连字符，且不能以连字符开头 |
| `error.timeout` | 请输入 1000–600000 之间的整数（毫秒） |
| `save` / `saving` / `saved` / `saveFailed` | 保存 / 保存中… / 已保存 / 保存失败：{reason} |
| `saveFailedStale` | 配置已被其它窗口改动 · 刷新后重试 |
| `unavailable.title` / `.body` | 这里暂时不能保存 / 当前 profile 没有挂载配置面（settings / config-editor）。可以改用环境变量：FORGE_DEVOPS_DOP_BIN、FORGE_DEVOPS_GH_BIN。 |

**文案铁律**：
- 页面文案里不出现任何盘符、绝对路径或真实 endpoint；路径一律来自运行时值（AC-10），示例统一用 `corp.example`。
- 工具侧失败文案与页面共用同一套**类别词**：`PATH`、`候选目录`、`环境变量`、`配置`（AG-3 的"同一门语言"）。
- 主句人话；机器码（reason 枚举、环境变量名）只出现在次级说明里。

## 7. 无障碍要点

- 结构：`<h2>` 页面标题 + 两个 `<h3>` 分组；每组 `aria-labelledby` 指向标题。
- 状态行 `role="status" aria-live="polite"`；只有状态行播报，字段错误靠 `aria-describedby`（宿主已实现）+ `aria-invalid`。
- 只读输入：`readonly` 而非 `disabled` —— 保持 Tab 可达、可全选复制；`aria-labelledby` 关联 label。
- `Tag` 不只承载颜色语义：四种 origin 各有文字；状态点旁必有文字。
- 对比度：正文 `label-primary` on layer-2 远超 7:1；12px 说明用 `label-tertiary`（4.5:1 以上）且不缩到 11px 以下。
- 命中区：文本动作 `min-height: 28px`（视觉行高不变，用负 margin 抵消）。
- 键盘：完整 Tab 序（§4.4）；`SegmentedField` 用 roving tabindex + ←/→/Home/End；候选展开按钮带 `aria-expanded` 与 `aria-controls`。
- 动效：`prefers-reduced-motion: reduce` 时关闭骨架呼吸与展开位移。
- 离线：页面零外部资源（无 CDN 字体/图标/图片），图标只用宿主 primitives 的内联 SVG（AC-6）。

## 8. AC → 设计映射

| AC | 设计落点 | 可核对方式 |
|---|---|---|
| AC-1 零配置可用 | 默认态即显示两条「自动发现」+ 状态行 ready，无任何输入动作 | 干净 profile 打开页面截图 |
| AC-2 只认可直接执行 | origin=`自动发现` 只可能来自 `.exe`/具执行位文件；hint 明示「包装脚本不能执行」错误 | 造一个只有 `.cmd` 的目录 → 页面显示未找到 + `.wrapperScript` 文案 |
| AC-3 三层优先级与来源 | `Tag` 四态 + 覆盖环境变量时额外 `Tag`「覆盖环境变量」；清空即回落 | 三种环境组合各打开一次页面 |
| AC-4 发现成本有界 | 只在挂载与「重新自动发现」时检测；按钮 loading 态 | 连点工具后页面结论不变 |
| AC-5 找不到即如实失败 | 状态行 amber + 类别词（PATH/候选目录/环境变量）+ 指向页面的指引 | 未命中时读状态行文案 |
| AC-6 可达性与一屏 | §2.2 两次点击；§0.6 629 ≤ 642 | 点击计数 + 768 高视口截图 |
| AC-7 页面即状态 | 入口卡默认只读展示；「改为手动指定」覆盖；「重置为自动发现」回落；未改动保存 disabled | 页面断言 4 条 |
| AC-8 保存即持久 | 页脚「已保存」+ 状态行 ≤1s 刷新；写入走宿主 `SettingsFormModel` | 保存 → 重启 → 再看页面 |
| AC-9 非法值被拒 | 6 条字段错误文案，其中 `dopEndpoint`/`ghOwner`/`timeoutMs` 为纯文本校验，`sourceType` 由分段控件消灭非法输入 | 逐项填错截图 |
| AC-10 回显边界 | 路径/endpoint 只在本页出现；文案铁律禁止文档示例带盘符 | 对页面源码与产物跑正则 |
| AC-11 环境变量仍可用 | origin=`环境变量` 只读展示；不打开页面也能用 | CI 形态（无 UI）复核 |
| AC-12 文档口径 | 页面「进入路径」与工具页指引共用「设置 → DevOps 变更流程」这一句 | 文档 diff |
| AC-13 证据纪律 | 本文 §9 已标注已核对项与 NOT RUN 项 | 复核 §9 |
| AC-14 零回退 | 页面只写配置，不新增工具/命令；无命令输入口 | 工具面 9 个不变 |
| AC-15 可回滚 | 「重置为自动发现」= 页面内回滚；文档写清删除 profile 补丁步骤 | 重置后 origin 变回 discovered |

## 9. 证据边界与未验项

**已核对（读源码 / 官方 README，本机 node_modules）**：
- 设置面板几何（800 / 188 / 54 / `padding 0 24 24`）与字段度量（34px 输入、12px 内距、13px 字、`.5px` 分隔）：`@deepseek-ai/dsh-client-ui-settings-general`。
- `SettingsForm` / `SettingsValueField` / `SettingsFormModel` 五态与 `aria-*`：宿主前端 bundle 中的 `form`（`_form_*` / `_field_*`）实现。
- `settings.section` 注册形状与 `plugins.item` 的层级（后者是插件管理页里的**卡片 → 详情**，共 3 次点击）：`dsh-client-ui-settings-models` / `dsh-client-ui-settings-plugins` / `dsh-client-ui-plugin-manager`。
- token 取值：`@deepseek-ai/dsh-client-ui-theme`（`base.css` + static ramp）。
- 「没有文件选择」：`dsh-host-directory-picker` / `-browse`（列举只返回目录）/ `-native`（返回目录路径）的 README 与代码。

**NOT RUN（不得写成已验证）**：
- 宿主 `0.2.1-rc.3`：本机实测为 `0.2.1-rc.2`，rc.3 未跑（R4）。
- Windows 实机：本页未在 Windows 上打开过；Segoe UI/微软雅黑下的行高与 `%ProgramFiles%` 路径宽度需实机复核（中文目录、空格、UNC 三种情况各一次）。
- 企业 `dop.exe` 身份探针（PRD F1 未决）：页面文案与 `自动发现` 语义不依赖探针，但若企业版本无 `--version`，AG-1 只能靠「候选可见 + 命中路径可见」兜底。
- 企业安装位置分布（PRD F2 未决）：影响固定候选目录清单覆盖率，不影响本页布局。

**留给技术阶段定形（设计只约束边界）**：页面读取发现结果的数据通道（页面内可显示路径、工具面 9 个工具与输出不含路径），以及 `dsh.client` 客户端入口与 locale 目录的文件落点。
