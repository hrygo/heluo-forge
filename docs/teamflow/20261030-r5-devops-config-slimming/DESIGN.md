<!-- meta: summary="把 forge-devops 配置页收敛成三行一列（dop 入口 / gh 入口 / 超时）：删「连接与身份」整组与段控件、改名「企业 DevOps」、用户可见文案去 .exe；入口卡交互与三态状态行零回退，新增 220px 超时单行与镜像三行骨架；度量按现有实现（非 r3 文档）重算为 501px。" -->
基线依赖：docs/teamflow/20261030-r5-devops-config-slimming/PRD.md（14 条 AC）、docs/teamflow/20261029-r3-cli-path-autodiscovery/DESIGN.md（页面形态、宿主 token、入口卡交互基线）
取代：docs/teamflow/20261029-r3-cli-path-autodiscovery/DESIGN.md §0.6 的 629px 算账表、§2.1 的「连接与身份（4 字段 2×2）」单元、§3.1 线框中的该两行——本文件 §0.6 与 §3.1 是新版唯一度量与线框；r3 其余条目（入口卡只读/覆盖/回落/候选、状态行三态、键盘与焦点）继续有效。

# DESIGN — 企业 DevOps 配置页瘦身（去 .exe 后缀 / 改名 / 移除连接与事实来源）

## 0. 视觉与观感意图（先读这一节）

**一句话意图**：这一页从「一张 6 项的表」变成「一张 3 行的清单」——**更安静、更短、更像宿主原生的第 N 个设置分区**。用户进来只该看到三件事：dop 在哪、gh 在哪、超时多少；正常情况下连这三行都不用碰，只看状态行那句结论就能关掉页面。删掉两段之后**不许用装饰填空**（不加插图、不加"开始配置"大按钮、不居中），留下的空白就是设计的一部分。

> 本节所有数值以 `packages/forge-devops/client.js` 的**现有实现**为准（r3 文档里 13/600 的分组标题、`min-height:28px` 的文本动作、外框式分组容器都未落地）；本轮不改这些既有观感，只按删减后的结构重算。下文凡与 r3 文档冲突处，以本文件与实现为准。

### 0.1 表面处理（组件类 → 可直接实现的规格）

| 组件类 | 规格 |
|---|---|
| 页面容器 | 无卡片、无外框、无背景色：直接坐在宿主设置面板 layer-2 上；内容宽 564px（§0.6）；本页不加水平内距 |
| 分组标题（唯一一个） | 12px / 500 / line-height 20，`--dsw-alias-label-secondary`，`margin: 10px 0 6px`；**不加下划线、不加背景、不加图标**（标题与首行之间靠 18px 间距表达层级：6px 外边距 + 12px 行内距） |
| 清单行（3 行：dop / gh / 超时） | `padding: 12px 0`；行间 **`.5px solid --dsw-alias-border-l2`** 上分隔线；**首行无分隔线**；三行左边界、上下内距、label→input 6px 间距完全一致 → 看起来是同一张列表；**无外层圆角框、无行 hover 底色** |
| 输入框（路径 / 超时同款） | 高 34px、`padding: 0 10px`、`border: 1px solid --dsw-alias-border-l4`、`border-radius: --dsw-radius-sm`、背景透明、13px / 400；只读态 `color: label-secondary` + `cursor:text`（可聚焦、可全选复制），**永不用 `disabled`** |
| 超时输入 | 同输入框度量 + `width: 220px; max-width: 100%`（左对齐短桩，明确"这是个标量不是路径"）+ `font-variant-numeric: tabular-nums` |
| 状态行 | 高 30px、`margin-top: 8px`、`padding: 0 12px`、`border-radius: --dsw-radius-md`、`background: --dsw-alias-interactive-bg-hover`、12px / 400；左侧 6px 状态点，右侧文本动作 |
| 徽标 Tag | 高 18px、11px / 400、`border-radius: --dsw-radius-sm`、底色 `--dsw-alias-interactive-bg-hover`；accent/warn/ok 用 `color-mix(... 12%~14%, transparent)`；`tone` 只用 neutral / quiet / info / danger |
| 文本动作 | 12px / 18px、`color: label-secondary`、无背景无边框；命中区 = 文本自身（与同行 hint 同一行，属 WCAG 2.5.8 行内例外）；若要 28px 命中区，须同时把 hint 行高改 28 并重算 §0.6（每行 108→118）——本轮不做 |
| 保存按钮 | 高 32px、`padding: 0 16px`、`border-radius: --dsw-radius-sm`、`background: --dsw-alias-state-business-primary`、文字 `--dsw-alias-label-primary-inverted`、12px / 500；disabled `opacity: .4` |
| 圆角体系 | 只用 `--dsw-radius-sm` / `--dsw-radius-md`；宿主已开 `corner-shape: superellipse(1.5)`，本页不覆盖、不自绘 |
| 阴影 / 渐变 / 发光 | **零**。全页唯一"有重量"的色块是保存按钮；唯一半透明底是状态行 / Tag / 骨架 |

### 0.2 状态反馈（数值固定）

| 交互 | 变化 | 时长 / 曲线 |
|---|---|---|
| 输入 focus | `border-color → --dsw-alias-state-business-primary`，**不加 outline**（与宿主字段一致） | 100ms `--ds-ease-in-out` |
| 输入 invalid | `border-color → --dsw-alias-state-error-primary` + 下方 12px 红字；不抖动、不加图标、不弹窗 | 100ms |
| 输入 readonly | 无 hover 变化；focus 同正常输入（可复制是主用途） | — |
| 按钮 hover / active | `opacity .92` / `opacity .86 + scale(.98)` | 100ms |
| 按钮 disabled | `opacity: .4`、`cursor: default`、无 hover 反馈 | — |
| focus-visible（按钮 / 文本动作） | `outline: var(--dsw-focus-ring-width,2px) solid --dsw-alias-state-business-primary`；按钮 `offset: 2px`、文本动作 `offset: 1px` | 100ms |
| 文本动作 hover | `label-secondary → label-primary` | 100ms |
| 状态点 | `background-color` 过渡：ready `--dsw-static-green-500` / 未找到 `--dsw-static-amber-500` / 不可用 `--dsw-static-red-600` | 160ms |
| 候选展开箭头 | `rotate(0 → 180deg)` | 100ms |
| 保存成功 | footer 左侧 12px「已保存」`label-secondary`，编辑任一字段后消失；**不做定时淡出** | — |
| 保存失败 / 409 | footer 左侧红字原因（`state-error-primary`）+ 可选「刷新」文本动作 | — |
| hit-flash | 本页无画布 / 游戏面，无命中闪光；"命中反馈"由状态行结论与 footer 文案承担 | — |

### 0.3 动效、加载态、空态、错误态

- **首次加载骨架（改）**：**三行镜像**，每行 108px（内部：20px 标签条 + 6px + 34px 输入条 + 6px + 18px 提示条），行间 `.5px` 分隔线，上方 36px 标题占位；总高 361px ≈ 实际内容 361px（§0.6）→ 加载完成**零跳动**。呼吸 `opacity 1 → .55 → 1`，1.2s `ease-in-out infinite`。**不再画 2×2 四格**（那会暗示 4 个字段，是 AC-14 的"孤立占位"）。
- **重新自动发现**：按钮文案变「检测中…」并 disabled；状态行换「正在检测命令行位置」；结果回来 160ms 内更新状态点与文案。**结论未变必须给反馈**：状态行追加「位置未变」。
- **多候选展开**：`animation: fdv-reveal 160ms cubic-bezier(.4,0,.2,1) both`（`opacity 0→1`、`translateY(-2px)→0`）；箭头 100ms。
- **空态 = 错误态**：未配置且未发现 → 同一行位置显示「未找到」+ 一行修复指引（help 句），不画插图、不给 CTA。
- **错误**：字段级只在该行 hint 位置显示 12px 红字；页面级只走状态行；「未找到」是 **amber 不是 red**（不是用户做错了什么）。
- **删除两段没有"收起动画"**：分组是构建期删除，运行期不存在切换，**不写 height 过渡、不做淡出**。
- **`prefers-reduced-motion: reduce`**：关掉骨架呼吸、候选展开、箭头旋转与状态点/输入/按钮过渡，只保留瞬时替换（关键帧 `fdv-breathe` / `fdv-reveal` 定义不变）。

### 0.4 字体角色与数字对齐

| 角色 | 规格 |
|---|---|
| 页面标题 | 16px / 500 / line-height 24，`label-primary`（与设置导航标题同级） |
| 引导句 | 12px / 400 / 18，`label-secondary`，`margin-top: 12px` |
| 分组标题 | 12px / 500 / 20，`label-secondary`（**不是** 13/600） |
| 行标签 | 13px / 500 / 20，`label-primary`；标签后接 origin `Tag` |
| 输入值 | 13px / 400，**文本字体**（路径含中文目录时等宽反而难读；且要与宿主输入视觉一致） |
| 说明 / 错误 | 12px / 400 / 18；说明 `label-tertiary`，错误 `state-error-primary` |
| 状态行 | 12px / 400；右侧动作 12px |
| Tag | 11px / 400，`white-space: nowrap` |
| 候选路径 | 12px `ui-monospace, SFMono-Regular, Consolas, monospace` + `word-break: break-all`（长 UNC / 中文目录换行，不横向滚动） |
| 数字 | `timeoutMs`、候选数一律 `font-variant-numeric: tabular-nums` |
| 强调 | 全页只有两处：保存按钮（实心）、状态行的状态词（500）。其余一律不加粗 |

### 0.5 本产品的反模式（明确禁止）

1. **页面上出现任何隐藏键的痕迹**：`dopEndpoint` / `ghOwner` / `sourceType` 的只读灰显、tooltip、`title`、aria、`<details>`「高级设置」折叠、空 `<input type="hidden">` 一律不允许——它们**不进 DOM**（PRD 非目标 + AC-2 + 反模式 1）。
2. **用装饰填空**：因为只剩三行就居中、加插图、加「开始配置」大按钮、加说明段落解释"为什么只有三项"。
3. **把发现结果 `disabled` 掉**：用户要能选中复制路径 → 只读用 `readonly`。
4. **origin 只给颜色或藏进 tooltip**：必须有可见文字 Tag（`自动发现` / `环境变量` / `配置` / `未找到`）。
5. **假成功**：footer 说「已保存」而状态行没变——保存后必须重读快照并 ≤1s 内更新。
6. **页面之外露路径**：本页是本机绝对路径的唯一显示处；toast、工具输出、日志、报告一律不出现。
7. **自造字体 / 自造颜色 / 渐变 / 投影 / 卡片阴影**：视觉上必须"看不出是插件"。
8. **给删减加动效**：为"顺滑"给三行加 `height` 过渡或进入淡入。
9. **`.exe` 处理过头**：改写真实路径值里的 `.exe`；或反过来在页面文案里保留 `.exe`（规则句除外，见 §6.3）。
10. **改名只改一半**：只改侧栏或只改标题；`CLI_PAGE_HINT` 还写旧名。
11. **给超时加第二个分组标题**：一个 28px 孤立标题 + 只有一行的组，是 AC-14 的"空白分组"。
12. **骨架仍画四格**：加载态与真实三行结构不一致 = 布局跳动。

### 0.6 几何自洽（先算清楚再画）

宿主设置面板实测（r3）：`800 × min(800, 100vh − 48)`；左侧导航 188px；头部 54px；内容区 `padding: 0 24px 24px`。
→ **内容宽 = 800 − 188 − 48 = 564px**；**内容高 = 面板高 − 54 − 24 = min(800, 100vh − 48) − 78**。

新版静态度量（px，含间距，按 `client.js` 的 `METRICS` 实算）：

| 区块 | 计算 | 高度 |
|---|---|---|
| 标题 + 引导句 | 24 +（12 + 18） | 54 |
| 状态行 | 8 + 30 | 38 |
| 分组标题「命令行入口与超时」 | 10 + 20 + 6 | 36 |
| 入口卡 ×2（dop / gh） | (12+20+6+34+6+18+12) × 2 + 0.5 分隔线 | 216.5 |
| 超时行 | 0.5 + 12+20+6+34+6+18+12 | 108.5 |
| 页脚 | 16 + 32 | 48 |
| **合计** | | **501** |

- 视口高 ≥ **627px** 时整页（含保存按钮）一屏可见：501 ≤ 100vh − 126。
- 视口 768 → 内容高 642 → **余 141px**；视口 800 → 内容高 722 → **余 221px**。页脚以下留白 ≥141px 是设计的一部分，**不填任何东西**。
- 首屏必含三行：`501 − 48 = 453` ≤ 内容高（视口 ≥ 579 即成立）。
- 视口 < 627 允许纵向滚动；**两张入口卡必须留在首屏**（`453 − 108.5 = 344.5` ≤ 内容高，视口 ≥ 470 即成立）。
- 宽度核算（564px）：超时输入 220px，最长值 `600000`（6 位 ×≈7.3px + 20px 内距 ≈ 64px）→ 余 156px；行标签 `超时（毫秒）` ≈ 90px；hint `1000–600000，默认 20000` ≈ 146px；错误句 ≈ 200px，均 < 564px。
- 行头核算：label `dop 可执行文件` ≈ 91 + Tag `自动发现` ≈ 56 + Tag `覆盖环境变量` ≈ 78 + 动作 `改为手动指定` ≈ 72 + 3×8 gap = **321 < 564** ✓；容器 <520px 时该行换行（§3.4）。
- 状态行文案 ≤ **40 个全角字符**（564 ÷ 12 ≈ 47，留余量），超长 `text-overflow: ellipsis` 单行截断——保证换行永不出现，上面的算账才成立。
- 候选展开区 `max-height: 176px`（≈7 行 18px）超出滚动；路径行 `break-all`，不改变行高。
- 垂直节律：三行同为「12 上下内距 + 6 label/input + 6 input/hint」，任意一行增删都不改变其它行基线——这是三行能读成一张列表的原因。

## 1. 设计基线与偏离（本轮改了什么、没改什么）

**复用（不重画）**：`settings.section` 槽位与设置面板外壳、`SettingsForm` 五态（保存/保存中/失败/只读/不可用）与 footer、`CliEntryField` 全部交互（只读展示 / origin Tag / 覆盖环境变量 / 改为手动指定 / 重置为自动发现 / 候选展开 / 三态状态行 / 路径可复制）、`StatusLine`、`CandidateList`、`FieldFoot`、`Tag`、`TextField` 度量、`ctx.locale` 中英文案机制、主题 token、`ensureStyle()` 的单例注入与 disposer 返回。

**删除（AC-2 / AC-11）**：

| 对象 | 位置 |
|---|---|
| `SegmentedField` 组件、`SOURCE_TYPES`、`SEGMENT_FIELDS`、`error.source` | `packages/forge-devops/client.js` |
| `.fdv-track` / `.fdv-segment` / `.fdv-segment:hover` / `.fdv-segment-on` / `.fdv-segment:focus-visible` | `client.js` 的 `CSS` |
| `dopEndpoint` / `ghOwner` 的 `TextField` 渲染与 `textField()` 分支 | `client.js` 的 `DevopsSection` 渲染段 |
| i18n 键 `field.dopEndpoint`、`field.dopEndpoint.hint`、`field.ghOwner`、`field.ghOwner.hint`、`field.sourceType`、`field.sourceType.hint`、`error.endpoint`、`error.owner`、`section.connection` | `client.js` 的 `zh` / `en` |
| `.fdv-grid`、`.fdv-skeleton-grid` 及 `@container`/`@media` 里的 grid 列规则 | `client.js` 的 `CSS` |
| `METRICS.trackHeight` / `trackPad` / `segmentHeight` / `segmentPadX` / `gridGap`（无引用后） | `client.js` |
| 模块返回值里的 `SegmentedField` 导出 | `client.js` 末尾 |

**新增（1 个）**：**超时单行** `.fdv-scalar`——`padding: 12px 0` + 上方 `.5px border-l2` + 输入 220px + hint；结构 = label 行 → 输入 → hint/错误（与入口卡同节律，无 Tag、无文本动作）。

**修订（4 处，均需在实现里显式标注）**：

1. **分组标题文案**：「命令行入口」→「命令行入口与超时」（决策 D-1，理由与回退见 §2.3）。
2. **`.fdv-head` 窄窗换行**：`flex-wrap: wrap; row-gap: 4px`，动作仍 `margin-left: auto`（AC-14 窄窗不溢出）。
3. **骨架改三行镜像**（§0.3），替换 2+4 格结构。
4. **`entry.hint.help` 参数化 `{tool}`**：现有实现把 `dop.exe` 写死在共用键里，gh 卡也显示「右键 dop.exe」——这是 r3 遗留的错位文案，本轮随去后缀一并修正（dop 卡渲染结果与 AC-3 的逐字句完全一致）。

**明确不改**：`intro` / `status.*` / `action.*` / `origin.*` / `candidates.*` 文案；保存与 409/422/「已保存」反馈；Tag 语义与 tone 词表；焦点环；`prefers-reduced-motion` 关键帧；路径只读可复制；`inputMode="numeric"`；`nav`/`title` 之外的注册参数（`id: 'devops'`、`order: 60`、槽位名）。

## 2. 页面与信息架构

### 2.1 页面清单与单元（仍只有 1 页，不做二级导航 / 向导）

| 单元 | 作用 | 高度 | 对应 AC |
|---|---|---|---|
| 标题「企业 DevOps」+ 引导句 | 身份 + 一句话告诉用户「正常情况下你不用填」 | 54 | AC-1、AC-2 |
| 状态行 | 只读面是否可用 + 两个入口各由哪层提供 + 「重新自动发现」 | 38 | AC-4、AC-7 |
| 分组标题「命令行入口与超时」+ 3 行 | dop 入口、gh 入口、超时；前两行只读展示生效路径 / origin / 覆盖 / 回落 / 候选 | 36 + 325 | AC-2、AC-3、AC-4、AC-14 |
| 页脚 | 保存 / 保存中 / 失败 / 已保存（未改动时 disabled） | 48 | AC-5 |

- 三行顺序固定：`dopBin` → `ghBin` → `timeoutMs`，即 `CLI_FIELDS` 过滤掉三个隐藏键后的原序（**不在页面重排**，AC-11 的"渲染表 ⊂ 契约表"靠这条成立）。
- 隐藏三键（`dopEndpoint` / `ghOwner` / `sourceType`）**不进 DOM**；快照里带值只用于路径/超时的解析与排障，页面不渲染、不 staged、不发送。

### 2.2 改名影响面（一句话四处引用，必须同源）

| 位置 | 现值 | 新值 |
|---|---|---|
| `packages/forge-devops/client.js:195` `nav` (zh) | `DevOps 变更流程` | `企业 DevOps` |
| `packages/forge-devops/client.js:196` `title` (zh) | `DevOps 变更流程` | `企业 DevOps` |
| `packages/forge-devops/client.js:262` `nav` (en) | `DevOps change flow` | `Enterprise DevOps` |
| `packages/forge-devops/client.js:263` `title` (en) | `DevOps change flow` | `Enterprise DevOps` |
| `packages/forge-devops/client.js:2` 文件头注释 | `settings.section「DevOps 变更流程」` | 同步新名（注释也属"改名全链路"，AC-1 的旧名 grep 会扫到） |
| `packages/forge-devops/src/cli-config.mjs:95` `CLI_PAGE_HINT` | `设置 → DevOps 变更流程` | `设置 → 企业 DevOps` |
| `packages/forge-devops/README.md:9,32,34,50,95` | 旧名 | 新名（AC-10） |
| `packages/forge-devops/test/cli-config.test.mjs:118,356,456,461`、`test/cli-access.test.mjs:158` | 旧名断言 | 改写为新名（**改写不删除**，AC-12） |

- 不变：包名 `@heluo/forge-devops`、分区 id `devops`、`order: 60`、HTTP 端点 `/api/forge-devops/cli`、9 个工具名、环境变量名。
- 宽度：侧栏 188px，`企业 DevOps` 13px ≈ 98px（4 全角 + 空格 + 6 半角）→ 不截断、不换行。

### 2.3 决策与被否决的方案

**D-1 分组标题改为「命令行入口与超时」**（偏离 PRD §10 的"保留原标题"缺省）：
理由——三行里有一行是超时，若标题只写「命令行入口」，用户会问"超时为什么挂在入口下"；改标题不新增分组（仍是 1 个标题 + 3 行），AC-2 / AC-14 的结构断言（1 个分组标题、无第二组、无空白组）完全不受影响，成本是 2 个字符串（zh/en）。
回退——若团队坚持原句，只改 `section.commandline` 一个键值，结构与度量不变。

| 被否决 | 理由 |
|---|---|
| 保留「连接与身份」但灰显/折叠 | 违反 AC-2 与反模式 1：页面仍在问用户判断不了的事 |
| 用一行只读小字回显 `sourceType` | PRD 非目标明令禁止；且与"移除事实来源"直接冲突 |
| 给超时单独一个分组标题（如「查询」） | 28px 孤立标题 + 只有一行的组 = AC-14 的空白分组 |
| 三字段重排成 2 列网格 | 220px 的超时输入塞进 274px 格子里没有信息增益，窄窗还要再退列 |
| 用 `<details>`「高级设置」收纳隐藏键 | 等于把术语搬回页面（PRD 风险 4 的"解释段落"变体） |

## 3. 关键页面线框

### 3.1 默认态（自动发现双双命中，用户零操作）

```text
设置 · 企业 DevOps                                     内容宽 564px
──────────────────────────────────────────────────────────────────────
企业 DevOps                                                   16/500   24
插件会自己找 dop 与 gh；只有找不到时才需要你指定位置。         12/18    30
● 只读面 ready · dop 自动发现 · gh 自动发现     [重新自动发现]  12/18    38
命令行入口与超时                                               12/500   36
──────────────────────────────────────────────────────────────────────
dop 可执行文件                              [自动发现]                  20
[ %ProgramFiles%\Corp\dop\dop.exe ]                    （只读，可复制）34
自动发现命中 · 另有 1 个候选                [改为手动指定]             18
──────────────────────────────────────────────────────────────────────
gh 可执行文件                               [自动发现]                  20
[ %ProgramFiles%\Git\cmd\gh.exe ]
自动发现命中                                [改为手动指定]             18
──────────────────────────────────────────────────────────────────────
超时（毫秒）                                                            20
[ 20000 ]                                                      34
1000–600000，默认 20000                                                18
──────────────────────────────────────────────────────────────────────
                                                            [ 保存 ]    48
```

要点：
- **首屏没有任何空的必填项**（AG-4）；两行入口是只读展示，用户"只需看"；状态行给唯一结论，`[重新自动发现]` 是唯一全局动作。
- 保存按钮初始 `disabled`（未改动，`SettingsForm` 行为）；三行之间只有两条 `.5px` 分隔线，**没有外框**。
- 超时行的 `[ 20000 ]` 是**占位符**（`label-tertiary`），不是已保存值——这是 r3 的既有语义（避免"没改过"被算成 dirty），本轮不改；hint 已写明默认值。

### 3.2 未找到态 / 编辑态（修复路径的起点）

```text
● 未找到 dop · 已查 PATH、候选目录、环境变量        [重新自动发现]   ← amber
命令行入口与超时
──────────────────────────────────────────────────────────────────────
dop 可执行文件                                  [未找到]                20
[ 粘贴 dop 的完整路径 ]                                  （可输入）     34
在资源管理器里选中 dop 文件右键 →「复制文件地址」，粘贴到这里    18
──────────────────────────────────────────────────────────────────────
gh 可执行文件                                   [自动发现]
[ %ProgramFiles%\Git\cmd\gh.exe ]
自动发现命中                                    [改为手动指定]
```

- 未找到时输入框 `placeholder` = 「粘贴 dop 的完整路径」（**无 `.exe`**），hint = help 句（**无 `.exe`**），**不给"选择文件"按钮**（宿主拿不到文件级绝对路径，r3 已证）。
- 编辑态只有两处入口：入口卡「改为手动指定」、直接改超时；两者都会让保存按钮转为可用。
- 已覆盖态（origin = `config`）：行头追加 `[覆盖环境变量]` 静默 Tag，右侧动作变「重置为自动发现」；hint = 「已手动指定 · 清空即回落自动发现」。

### 3.3 保存失败 / 409 / 422

```text
──────────────────────────────────────────────────────────────────────
超时（毫秒）
[ abc ]
请输入 1000–600000 之间的整数（毫秒）        ← 12px 红字，border 转红
──────────────────────────────────────────────────────────────────────
配置已被其它窗口改动 · 刷新后重试 [刷新]              [ 保存 ]
```

- 409：footer 左侧红字「配置已被其它窗口改动 · 刷新后重试」+「刷新」文本动作；三行内容不动。
- 422：**只把 3 个可见键渲染成字段错误**并把焦点移到首个非法可见字段；服务端若返回隐藏键的原因，一律折叠进 footer（`保存失败：<reason>`），**不创建幽灵字段/不可见红字**（§4.4）。

### 3.4 窄窗（容器 < 700px / < 520px）

```text
<700px：三行本来就是一列，无变化（不再有需要退列的网格）
<520px：行头换行，动作落到第二行右端；超时输入撑满可用宽
dop 可执行文件  [自动发现]
                     [改为手动指定]
[ %ProgramFiles%\Corp\dop\dop.exe ]
```

- `<700px`：入口卡与超时行单列、不溢出（AC-14）；候选展开 `max-height: 176px` 滚动不变。
- `<520px`：`.fdv-head { flex-wrap: wrap; row-gap: 4px }`，动作保持 `margin-left: auto`；超时输入 `width: 220px; max-width: 100%` 自然收缩到 100%。

### 3.5 加载骨架（三行镜像，不跳动）

```text
命令行入口与超时                          ← 36px 标题占位
─────────────────────────────────────────
[ 34px 输入条 ]  + 18px 提示条             ← 108px
─────────────────────────────────────────
[ 34px 输入条 ]  + 18px 提示条             ← 108px
─────────────────────────────────────────
[ 34px × 220px ]  + 18px 提示条            ← 108px
```

总高 36 + 3×108 + 2×0.5 = **361px**，与实际内容 361px 对齐（§0.6：36+216.5+108.5）。

## 4. 交互与状态机

### 4.1 状态行（三态，语义不变）

| 态 | 触发 | 点色 | 文案 | 右侧 |
|---|---|---|---|---|
| ready | `snapshot.ready === true` | 绿 | `只读面 ready · dop {origin} · gh {origin}`（结论未变时追加「位置未变」） | 重新自动发现 |
| missing | 快照就绪但任一入口 origin = `missing` | amber | `未找到 {cli} · 已查 PATH、候选目录、环境变量` | 重新自动发现 |
| unavailable | 读面失败 / `ready !== true` | red | `只读面不可用 · {reason}` | 重新自动发现 |

- 检测中：点色 idle、文案「正在检测命令行位置」、按钮 disabled + 「检测中…」。
- `role="status" aria-live="polite"`；单行截断（≤40 全角，§0.6）。

### 4.2 入口字段（dop / gh，行为零回退）

| origin | 输入框 | hint | 右侧动作 |
|---|---|---|---|
| `missing` + 可编辑 | 可输入，placeholder「粘贴 {tool} 的完整路径」 | help 句（`{tool}`） | — |
| `missing` + 只读（写面缺失） | 只读 | `未找到 · 已查 PATH、候选目录、环境变量` | — |
| `discovered`（另有 N 候选） | 只读 | `自动发现命中 · 另有 N 个候选` | hint 整体变按钮（含箭头）展开候选 |
| `discovered`（单候选） | 只读 | `自动发现命中` | 改为手动指定 |
| `env` | 只读 | `来自环境变量 · 在此保存将覆盖它` | 改为手动指定 |
| `config` | 可输入 | `已手动指定 · 清空即回落自动发现` | 重置为自动发现 |
| 已重置（staged = null） | 可输入，placeholder「保存后自动发现」 | `已重置为自动发现 · 保存后生效` | 改为手动指定 |
| 其它（override） | 只读 | `已指定 · 保存后覆盖下一层来源` | 改为手动指定 |

- 行头：label + origin Tag（`自动发现` / `环境变量` / `配置` / `未找到`），`config` 且压过环境变量时追加静默 Tag「覆盖环境变量」。
- 候选展开：列表首项「当前生效」，其余行显示真实文件名/路径与层级词；`break-all` 换行，不做横向滚动。
- 只读输入可聚焦、可全选复制；`aria-describedby` 指向该行 hint/error。

### 4.3 超时字段（唯一新增字段）

- 语义：`timeoutMs`，1000–600000 的整数；空字符串 = 清除该键（回落默认 20000）。
- 展示：`value` = 用户 staged 值；`placeholder` = 生效值或 `20000`；`inputMode="numeric"`；`tabular-nums`。
- 校验：blur 即校验（区间 + 整数），错误落该行 hint 位置；提交时若仍非法，焦点回到该输入。
- dirty：只有 staged 且与生效值不同才计入（与 r3 `isChanged` 同义）；隐藏键**永远不计入**。

### 4.4 校验与 422 映射

- 页面侧只剩 3 键：路径类（空 / 不存在 / 是目录 / 包装脚本 `.cmd|.bat|.ps1|.com|.vbs` / 长度 >4096）+ `timeoutMs`（1000–600000 整数）。`dopEndpoint`（http(s)、无凭据）、`ghOwner`（1–39、首字符非连字符）、`sourceType`（mock/enterprise）的页面校验分支随字段一起删除——**服务端语义一个字都不放宽**（AC-6）。
- 422 映射规则：`fields` 中命中的**可见键** → 该行红字 + `aria-invalid` + 焦点；命中的**隐藏键** → 一律降级为 footer `保存失败：{reason}`，不渲染任何不可见错误位（防御性：页面只发 3 键，正常流程不会出现）。
- 其余状态码不变：400（缺预检头）/ 409（revision 栅栏）/ 503（读面不可用）。

### 4.5 保存增量与隐藏键零丢失

- `changed = PAGE_FIELDS.filter(f => staged[f] 存在且 isChanged)`；`dirty = changed.length > 0`。
- POST `{ revision, fields }`，`fields` **只含 3 键**；`null` = 清除该键（仅路径/超时可清除）。
- 隐藏三键：读快照时有值 → 页面只读不渲染、不 staged、不发送、不置空；保存成功后补丁层里这三键**逐字保持**（AC-5 / 反模式 4）。
- 成功：重读快照（状态行更新）→ 清 `staged`/`errors`/`notice` → footer「已保存」；409 保留用户输入并给「刷新」。

### 4.6 键盘与焦点顺序（段控件删除后更简单）

`[重新自动发现]` → dop 输入（只读也进 Tab，可复制）→ dop hint 动作 / 候选展开 → gh 输入 → gh hint 动作 → 超时输入 → `[保存]`。

- 页面**不再有 roving tabindex / 方向键控件**（段控件已删）；只保留原生输入编辑键。
- 无 `form` 提交语义：`[保存]` 是 `type="button"`，Enter 在输入框内不触发保存；无弹层，Esc 无行为。
- `focus-visible` 环：按钮 2px offset 2px，文本动作 2px offset 1px；输入只改 `border-color`。

## 5. 视觉规格

### 5.1 Token（只引用，不新增、不覆盖）

`--dsw-alias-label-primary` / `-secondary` / `-tertiary`、`--dsw-alias-label-primary-inverted`、`--dsw-alias-border-l2`（行分隔线）/ `-l4`（输入描边）、`--dsw-alias-bg-layer-3`、`--dsw-alias-interactive-bg-hover`（状态行 / Tag / 骨架底）、`--dsw-alias-state-business-primary`（focus / 主按钮）、`--dsw-alias-state-error-primary`、`--dsw-alias-state-warn-primary`、`--dsw-alias-state-success-primary`、`--dsw-alias-state-idle-primary`、`--dsw-static-green-500` / `amber-500` / `red-600`（状态点）、`--dsw-radius-sm` / `-md`、`--dsw-focus-ring-width`、`--ds-ease-in-out`。

### 5.2 组件规格表

| 组件 | 关键度量 |
|---|---|
| `.fdv-root` | `display:flex; flex-direction:column`；`container-type:inline-size`（容器查询按 564px 判定） |
| `.fdv-title` / `.fdv-intro` | 16/500/24；12/400/18 + `margin-top:12px` |
| `.fdv-status` | 30px 高、`margin-top:8px`、`padding:0 12px`、`radius-md`、`interactive-bg-hover`；点 6px |
| `.fdv-group` | 12/500/20、`label-secondary`、`margin:10px 0 6px`（全页仅 1 个） |
| `.fdv-cards` | 纵向列表；`.fdv-card{padding:12px 0;border-top:.5px border-l2}`；首行 `border-top:0` |
| `.fdv-head` | `flex; align-items:center; gap:8px; line-height:20px`；动作 `margin-left:auto`；**窄窗 `flex-wrap:wrap; row-gap:4px`** |
| `.fdv-input` | 34px、`padding:0 10px`、`border:1px border-l4`、`radius-sm`、透明底、13px |
| `.fdv-scalar`（新） | `padding:12px 0; border-top:.5px border-l2`；输入 `width:220px; max-width:100%`、`tabular-nums` |
| `.fdv-foot` | `margin-top:6px`、12/18、`label-tertiary`；错误转 `state-error-primary` |
| `.fdv-tag` | 18px 高、11px、`radius-sm`、`interactive-bg-hover` |
| `.fdv-link` | 12/18、`label-secondary`、无边框；hover → `label-primary` |
| `.fdv-primary` | 32px 高、`padding:0 16px`、`radius-sm`、`state-business-primary` 实心 |
| `.fdv-footer` | `padding-top:16px`；note 左、按钮右 |
| `.fdv-skeleton`（改） | 标题占位 36px + 三行各 108px、行间 `.5px` 分隔线；呼吸 1.2s |

### 5.3 CSS 增删清单（精确到类名）

- **删**：`.fdv-grid`、`.fdv-skeleton-grid`、`.fdv-skeleton-cell`（四格）、`.fdv-track`、`.fdv-segment`、`.fdv-segment:hover`、`.fdv-segment-on`、`.fdv-segment:focus-visible`；`@container (max-width:519px)` 与 `@media (max-width:700px)` 里所有 `grid-template-columns` 声明（保留 `.fdv-candidates{max-height:176px;overflow-y:auto}` 与窄窗换行规则）。
- **改**：`.fdv-head` 加 `flex-wrap:wrap; row-gap:4px`；`@media (prefers-reduced-motion:reduce)` 去掉已删除的 `.fdv-segment` 选择器；`.fdv-skeleton` 结构改三行。
- **增**：`.fdv-scalar`、`.fdv-scalar .fdv-input{width:220px;max-width:100%;font-variant-numeric:tabular-nums}`、`.fdv-skeleton-row{height:108px}`。
- **不得新增**：任何 `box-shadow`、`linear-gradient`、彩色底、新 token、新字体。

## 6. 文案表（zh 为准，en 同键镜像）

### 6.1 变更行

| 键 | zh | en |
|---|---|---|
| `nav` | 企业 DevOps | Enterprise DevOps |
| `title` | 企业 DevOps | Enterprise DevOps |
| `entry.placeholder` | 粘贴 {tool} 的完整路径 | Paste the full path to {tool} |
| `entry.hint.help` | 在资源管理器里选中 {tool} 文件右键 →「复制文件地址」，粘贴到这里 | In Explorer, select the {tool} file, right-click → "Copy as path", then paste it here |
| `error.wrapperScript` | .cmd / .bat 包装脚本不能直接执行，请指向可直接执行的文件 | .cmd / .bat wrappers cannot be executed; point at a directly executable file |
| `section.commandline`（D-1） | 命令行入口与超时 | Command-line entries and timeout |

- `{tool}` 取值由 `dop` / `gh` 传入（现实现传的是 `dop.exe` / `gh.exe`，是 `.exe` 进入文案的唯一来源）；dop 分支渲染结果与 AC-3 逐字句一致，gh 分支同时修掉 r3「gh 卡也显示 dop.exe」的错位。
- 保留不变：`intro`、`status.*`、`action.*`、`origin.*`、`candidates.*`、`entry.dop`、`entry.gh`、`entry.placeholder.reset`、`entry.hint.discovered(.single)` / `.env` / `.config` / `.missing` / `.reset` / `.override`、`error.notFound`、`error.pathLength`、`error.timeout`、`error.load`、`load`、`save` / `saving` / `saved`、`saveFailed`、`saveFailedStale`、`unavailable.*`。

### 6.2 删除键（页面不再有落点）

`field.dopEndpoint`、`field.dopEndpoint.hint`、`field.ghOwner`、`field.ghOwner.hint`、`field.sourceType`、`field.sourceType.hint`、`error.endpoint`、`error.owner`、`error.source`、`section.connection`（zh/en 各 10 个）。

### 6.3 服务端与文档同句（跨文件，必须同轮）

| 位置 | 处理 | 理由 |
|---|---|---|
| `packages/forge-devops/src/cli-config.mjs:104` `WRAPPER_MESSAGE` | 改为「.cmd / .bat 包装脚本不能直接执行，请指向可直接执行的文件」 | AC-3 给了这句话的完整新文本，且它出现在 422 reason 与工具失败文案里；只改页面 i18n 会让同一句出现两个版本 |
| `packages/forge-devops/src/cli-config.mjs:183` Windows 非 `.exe` 后缀句 | **保留** | 这是"Windows 上必须是 `.exe` 形态"的**规则事实**，不是对工具的称呼（PRD §10 的 `.exe` 范围口径） |
| `packages/forge-devops/src/cli-config.mjs:95` `CLI_PAGE_HINT` | 「设置 → 企业 DevOps」 | 与 `nav`/`title` 逐字同源（AC-1） |
| `packages/forge-devops/README.md:70` 引用的页面提示 | 同步新句 | 文档在引页面文案，不是规则本身 |
| `packages/forge-devops/README.md:26,54,56,67` 的 `.exe` 规则说明 | **保留** | 规则事实 |
| `packages/forge-devops/README.md` 配置项表 | 标注「3 项可在配置页设置 / 2 项仅环境变量与配置文件 / 1 项由后端推导」 | AC-10 |

### 6.4 零命中校验（范围要写清，避免 QA 按错口径判红）

- 页面自有文案（zh/en 全表）：`/dop 服务地址|gh 组织|事实来源|mock|enterprise|\.exe/` **零命中**；en 侧对应 `/service endpoint|gh owner|Fact source|mock|enterprise|\.exe/i`。`{tool}` 占位符本身不含 `.exe`。
- 页面 DOM 文本：默认态零命中；**边界**——用户提交非法路径时，服务端 Windows 规则句可能带 `.exe`（§6.3 保留项），因此"DOM 级 `.exe` 零命中"不作为本轮的验收口径，AC-3 的口径是 i18n 全表 + 路径逐字回显。
- 旧名：全库用户可见文档与运行期字符串对「DevOps 变更流程」/「DevOps change flow」零命中（历史任务夹 `docs/teamflow/20261029-*` 与 `docs/teamflow/20261028-*` 除外，AC-10）。

## 7. 无障碍要点

- 每行 `label` 用 `htmlFor` 绑定输入 id；`aria-describedby` 指向该行 hint/error 容器；非法时 `aria-invalid="true"`。
- 状态行与 footer note 均为 `role="status" aria-live="polite"`：检测结果、保存结果、409 都能被播报，且**不打断**输入。
- 隐藏三键**不进 DOM**：屏幕阅读器不会播报用户不该看到、也无法判断的设置项。
- 只读输入用 `readOnly` 而非 `disabled`：可聚焦、可全选复制（`cursor:text`）。
- 不靠颜色单独传达：origin 有文字 Tag，状态行有文字结论 + 点色双通道。
- 焦点可见：输入只改 `border-color`（宿主规则）；按钮/文本动作有 2px 焦点环。
- 命中区：文本动作与其相邻 hint 同行，按 WCAG 2.5.8 行内例外；若日后改 28px，需同改 hint 行高并重算 §0.6。
- 数字 `tabular-nums`；长路径 `break-all` 换行而非横向滚动（键盘用户不需要横向滚动容器）。
- `prefers-reduced-motion` 生效时无呼吸、无位移、无旋转。

## 8. AC → 设计映射

| AC | 设计落点 |
|---|---|
| AC-1 改名全链路 | §2.2 影响面表（nav/title/头注释/`CLI_PAGE_HINT`/README/测试），§6.1 |
| AC-2 字段收敛到 3 项 | §2.1 单元表、§3.1 线框、§5.3 删除清单、§6.2 删除键、§0.5-1 |
| AC-3 去 `.exe` 文案 | §6.1（`{tool}` 参数化）、§6.3（服务端同句）、§6.4 零命中口径 |
| AC-4 路径区交互零回退 | §4.2 分支表、§4.1 状态行、§0.3 候选展开、§4.6 键盘 |
| AC-5 保存增量 / 隐藏键零丢失 | §4.5 |
| AC-6 页面校验收敛、服务端不放宽 | §4.4 |
| AC-7 事实来源后端推导 | 页面无落点（§0.5-1、§2.1「不进 DOM」）；设计侧只保证"页面永不发送该键" |
| AC-8 不伪造企业证据 | 同上：页面不出现 mock/enterprise 字样（§6.4），推导值不可见 |
| AC-9 快照与 HTTP 契约不变 | §4.5（GET 6 键只读不渲染、POST 白名单 3 键） |
| AC-10 文档与指引同步 | §2.2、§6.3 |
| AC-11 死代码与词表清理 | §1 删除表、§5.3 删除清单（`PAGE_FIELDS` ⊂ `CLI_FIELDS` 且同序） |
| AC-12 回归基线 | §1「明确不改」清单 + §9 |
| AC-13 证据纪律 | §9 |
| AC-14 渲染自检 | §0.3 骨架三行、§0.6 算账、§3.4 窄窗、§5.3（无重复分隔线/无空白分组） |

## 9. 证据边界与未验项

- 本文件是**设计交付**，不含实现与实测结论；`client.js` 未改。
- **NOT RUN**：真实浏览器走查（改名可见、两段消失、`.exe` 文案、保存不回退、隐藏键仍在 patch）、窄窗截图（<700 / <520）、真实 `web` profile 重启。
- 已核验依据：`packages/forge-devops/client.js` 的 `METRICS` / `CSS` / `zh` / `en` / `DevopsSection` 渲染段、`packages/forge-devops/src/cli-config.mjs:95,104,183`、`packages/forge-devops/README.md` 相关行、`docs/teamflow/memory.md` 的同主题约定。
- 待实测：宿主设置面板宽度 564px 来自 r3 实测值，若宿主版本变更导致面板宽度变化，§0.6 的 501px 与"视口 ≥627 一屏"需重算（组件级断言只能覆盖结构，不能覆盖真实视口）。
- 组件级断言（字段数=3、无段控件节点、页面文本正则、骨架行数、窄窗不溢出）由 dev/QA 在实现轮执行；本轮设计不产生测试结果。
