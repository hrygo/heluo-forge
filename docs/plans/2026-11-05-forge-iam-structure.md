# forge-iam 结构整改实施计划（issue #161）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-014 |
| 文档名称 | forge-iam 结构整改实施计划 |
| 版本 | V0.19.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-05 |
| 门禁 | 待负责人评审；只拆改变耦合的边界，不拆文件的部分按 DRY/SOLID 整改，不引入新工具链 |

> 编制依据：2026-11-05 以 `origin/main` = `2684cb8` 为基准只读核对 [issue #161](https://github.com/hrygo/heluo-forge/issues/161) 正文、[client.js](<../../packages/forge-iam/client.js>) 与 [service.mjs](<../../packages/forge-iam/src/service.mjs>) 的行数、分节、组件内部状态与重复实现统计，`git log` 的变更热力，本机已安装的 `@deepseek-ai/dsh-client-modules`（0.2.1-rc.2，即各包 `engines.dsh` 下限所在发布线）的 `lib/client.js`、`lib/index.js`、`README.zh.md`，以及 [check.yml](<../../.github/workflows/check.yml>) 的「不安装依赖」约束。同日在干净 worktree（无 `node_modules`，仅 `scripts/link-workspace.mjs` 离线链接）实跑 `node --run check`：2724 个顶层用例、2723 通过、1 跳过、0 失败；`packages/forge-iam/test` 单独 1210 个用例全绿。换基后 §1.4 与 §2.1 的数字均按该提交重测。未安装测试插件，**装载器多文件能力为源码与文档依据，非运行时实测**。

> 关联文档：[IAM 接入详细设计](<../design/plugins/forge-iam.md>)、[模块 README](<../../packages/forge-iam/README.md>)、[开发指南](<../../packages/forge-iam/docs/developer-guide.md>)、[开发约定](<../engineering/development-conventions.md>)、[文档清单](<../DOCUMENT-REGISTER.md>)。

> **版本说明**：V0.1 把「文件行数达标」当目标，于是出现为凑边界而生的模块与装配器。V0.2 改为先定判据再让边界自证，删掉行数门槛。V0.3 记录 D-1、D-3 的确认。V0.4 按 ROI 重排。V0.5 补上「不拆文件的部分也必须守 DRY/SOLID」：客户端从「只加导航」升级为四段结构与契约整改，`Panel` 的职责拆分改为同文件内按 hook 实施，并新增可执行的标记区守卫。V0.6 更名：文档职责已从「拆文件」扩为「结构整改」，标题与登记同步。V0.7 换基到 `origin/main` 2684cb8 后重测：基线 2723 通过，热力升至 14/20，并补入「客户端错误文案表与宿主 `MESSAGES` 靠约定同步」这一实测缺口。

## 1. 判据

### 1.1 边界判据（M1–M4）

「易于维护」指未来每次改动的成本更低。一个**文件边界**至少命中一条才值得存在：

| 判据 | 含义 | 可检验形式 |
|---|---|---|
| M1 改动局部性 | 改一个职责只打开一个文件 | 改动落点表：职责 → 唯一位置 |
| M2 显式所有权 | 每份可变状态只有一个写者 | 静态检查：`ctx` 字段的赋值只出现在所属模块 |
| M3 失效模型隔离 | 一类失败只有一个落点 | 按失败类别可直接定位 |
| M4 可测试性 | 该部分能被单独驱动 | 新模块可被独立 import 测试 |

### 1.2 反判据

行数、文件个数、目录整齐度**不是目标**，只作诊断信号。为满足数字而增设的文件、包装层或构建步骤都属于「为分割而分割」。行数超标时在评审里解释「为什么仍是一个职责」，而不是拆开它。

### 1.3 自证规则

落地的模块若既不拥有状态、也不隔离失效模型（只剩几个转发方法），**合并回调用方**；若某模块同时长出第二个职责，**继续拆**。这条规则优先于本文的模块清单。

### 1.4 变更热力与爆炸半径

| 文件 | 最近 20 个提交中占比 | 近期单次改动规模 | 爆炸半径 | 结论 |
|---|---|---|---|---|
| `packages/forge-iam/client.js` | 14 / 20（70%） | 近 15 次 13–396 行，典型 40–150 行 | 界面（可见但不泄密） | 全仓最热，改动集中在模型卡、面板、引导 |
| `packages/forge-iam/src/service.mjs` | 6 / 20（30%） | 近 10 次 2–82 行，多为个位数 | 凭据与会话（最高） | 改动并不罕见（近 20 次里 6 次，都是 IAM 修复），但每次都要在 45 个状态里定位 |

### 1.5 ROI 口径

排序看**收益除以成本**，收益 = 改动频率 × 改动难度 × 爆炸半径。频率见 §1.4；难度是「改对一处要读多少代码」；爆炸半径是改错的代价——会话状态错判可能违反 fail-closed，界面错判只是显示不对。频率不是全部：宿主的改动并不罕见（30%），难度与爆炸半径又最高；客户端最高频，代价主要在阅读。两者都值得改，区别只在先付哪一笔成本：先做成本低、收益立即兑现的项。§4.6 给出据此排出的顺序与停点。

### 1.6 内部质量判据（DRY / SOLID）

边界解决「改哪读哪」，解决不了「同一个决策被实现了几遍」。**不拆文件的代码同样要满足下列判据**：

| 原则 | 在本仓库的可检验含义 | 检查手段 |
|---|---|---|
| DRY | 同一决策只有一份实现：状态→展示、错误码→文案、存储键、轮询节奏 | 标记区内唯一出现 + 计数守卫 |
| SRP | 一个函数只有一个变化理由：渲染不取数、取数不渲染 | `render*` 不触 IO，hook 不返回元素 |
| OCP | 新增状态或档位不改调用点 | 状态字面量比较只出现在映射函数 |
| ISP | 组件只收到它真正用的契约 | `render*` 入参按簇分组，≤ 4 个 |
| DIP | 组件不直接依赖全局 IO | `fetch`/`localStorage` 只出现在 IO 段 |
| LSP | 无继承层次，不适用 | — |

判据不写成口号：每条都对应 §6.3 的一条静态守卫，违规会让 `node --test` 失败。

## 2. 现状与真实痛点

### 2.1 客户端：耦合在组件内部，重复散在全文

`client.js` 4061 行、单一 `factory(require)` 闭包。分节实测（以 2684cb8 为基准，行号仅作定位）：

| 区间 | 行数 | 内容 |
|---|---|---|
| 1–24 | 24 | 包装头、`React`/`h`、`ONBOARDING_KEY`、`REQUEST_HEADERS`、共享样式对象 |
| 25–1278 | 1254 | `interactionStyles` 模板字符串（全部 CSS） |
| 1279–1463 | 185 | `interactionStyle()`、图标、`getLauncherStatus`、容量与思考档位工具 |
| 1464–1579 | 116 | HTTP 封装、状态徽章、登录窗口、引导标记与模型选项读写 |
| 1580–1658 | 79 | 错误文案（40 个分支）、诊断快照 |
| 1659–1717 | 59 | `useSessionPoll` |
| 1718–2301 | 584 | 账户卡、网关卡、模型条目、旅程条 |
| 2302–2628 | 327 | 模型卡、模型缓存 |
| 2629–3222 | 594 | `Panel` |
| 3223–3519 | 297 | `IamLauncherMenu`、`IamLauncher` |
| 3520–4036 | 517 | `SignedOutBanner`、引导步骤与 `Onboarding` |
| 4037–4061 | 25 | `return { … }` 出口（`inject`/`apply`） |

**违规实测（可复核）**：

| 症状 | 实测 | 违反 | 影响 |
|---|---|---|---|
| 状态判定散落 | `view.state`/`view?.state` 比较 39 行、43 处，涉及 6 个状态字面量（`ready` 15、`authenticating` 15、`error` 5、`unreachable` 3、`unconfigured` 3、`expired` 2） | DRY、OCP | 新增或改名一个状态要翻遍全文；同一状态在不同组件的判定口径可能已经不一致 |
| 错误映射重复 | `errorNotice(result.body?.error?.code …)` 12 处、`if (!result.ok)` 11 处近似分支 | DRY | 默认兜底码、文案选择有 12 份副本，改口径必漏 |
| 文案决策表写成控制流 | `errorNotice` 有 40 个 `if (code === …)` 分支；宿主 [managed-models.mjs](<../../packages/forge-iam/src/managed-models.mjs>) 的 `MESSAGES` 有 14 条，两边靠注释「逐字重复」加一个手挑 11 个码的用例对齐；`IAM_GATEWAY_CREDENTIAL_REQUIRED` 在客户端没有分支，也未登记为宿主专用 | DRY、OCP | 新增错误码要改两处，漏一处只有人工比对能发现 |
| 存储访问分散 | `window.localStorage` 12 处，其中 3 处直接写 `forge-iam.model-options.v1`、2 处清旧缓存 | DRY、DIP | 键名与序列化逻辑分散；组件直接依赖全局存储 |
| 入参膨胀 | `renderModelsCard` 34 个键、`renderAccountCard` 26、`renderModelItem` 21、`renderGatewayCard` 16 | ISP | 每个组件都拿到大量自己不用字段，调用点与实现同时难改 |
| 单函数四职责 | `Panel` 594 行，占 10 个 `useState`、10 个 `useRef`、6 个 `useEffect`、2 个 `useCallback`，同时管视图轮询、目录缓存、筛选、展开、吸顶滚动、凭据表单 | SRP | 改任一类状态都要在 26 个状态单元里判断影响面 |
| 内嵌函数重复创建 | `renderHelpTip` 定义在 `renderModelItem` 内，每个模型项重建一次 | DRY/放置 | 无法复用，也无处测试 |

**已经做对的部分**（说明本文件已有 DRY 习惯，整改是延续而非另起）：`useSessionPoll` 被 5 处复用；`GATEWAY_STATUS` 已是「状态 → 文案」映射表的先例；HTTP 已收敛到 `getJson`/`postJson`；样式常量 `inputStyle`/`fieldLabel`/`primaryButton` 已共享；上游 906e6bd 已用「面板必须重复宿主文案」的对齐用例守住模型访问错误，本计划把这份做法扩成双向清单。

### 2.2 宿主：耦合在闭包里，物理拆分才有效

`service.mjs` 2047 行、一个 `createIamService()` 闭包：61–205 行是 45 个闭包状态声明（35 个可变 + 10 个常量/容器），61–866 行 33 个内部函数，867–2047 行是 `service` 对象的 28 个方法。状态靠隐式闭包读写（`state` 110 次、`lastGrant` 69 次、`error` 58 次、`disposed` 53 次、`exclusive` 20 次），同时违反 M2（一份状态多处可写）、M3（凭据失效与竞赛判定散落在 store/grant/token 分支）、M4（行为测试只能装配整条链路）。

宿主侧的 DRY/SOLID 不需要额外章节：`src/` 已有 20 个模块承担协议、存储、视图、路由（`oidc.mjs` 475 行、`store.mjs` 588、`state.mjs` 130、`client-auth.mjs` 171…），DIP 已由 `options` 注入（`fetch`、`now`、存储 provider、`getManagedModelRuntime`）实现；缺的只是把状态编排按轴分开，即 §4.2 的 9 个轴。

### 2.3 装载器事实（决定客户端形态的硬约束）

依据 `@deepseek-ai/dsh-client-modules@0.2.1-rc.2` 源码与 README，非运行时实测：

1. **同包不能有多个静态入口。** 宿主按包扫描 `dsh.client`，每包只取 `exports["./client"]` 一个路径组成 boot row；浏览器侧 `require` 只查平台 seed 表、已物化记录与已注册 factory。
2. **支持的是编译器产出的包内 chunk。** `require.async('./client.<name>.js')` 按 `?rev=` 拼路径，宿主只服务 `client.<name>.js` 形态且 chunk 必须自注册；README 明确它由源码 `import()` 拆分，**只支持自包含 chunk**。
3. **`dsh.client.external` 不是同包多文件开关**，它声明基座之外的跨包模块请求。

推论：客户端只能「一个文件 + 内部边界」。内部边界不靠物理文件，而靠**函数契约与可执行的标记区守卫**，这正是 §1.6 与 §4.7 要落的东西。

## 3. 目标与非目标

**目标**：

- 宿主：`service.mjs` 只保留装配与生命周期，业务判定进入按轴模块；每份可变状态只有一个写者；模块间无横向 `import`；28 项导出面、错误码与时序不变。
- 客户端：单文件内形成四段结构与契约（§6.2）；消除 §2.1 表中六类重复与职责混杂；`Panel` 降为装配外壳。
- 全程：既有 2723 个通过用例断言不改，`node --run check` 全绿。

**导出面 28 项**（逐项保持）：`getView`、`getModelAccessEpoch`、`getSession`、`notifyView`、`hydrate`、`syncFromStore`、`loadGatewayCredential`、`reconcileDefaultModel`、`resolveGatewayCredential`、`refreshGatewayModels`、`updateModelOptions`、`getModelOptions`、`readModelSelection`、`saveModelSelection`、`resolveGatewayConnection`、`saveGatewayCredential`、`clearGatewayCredential`、`getPrincipal`、`getIdentityProfile`、`startSignIn`、`handleCallback`、`cancelSignIn`、`signOut`、`bridgeCapability`、`getAccessToken`、`resolveToken`、`watch`、`dispose`。

**非目标**：

- 不为达行数而拆文件；不引入 bundler 或自研装配器（条件见附录 A）。
- 不修缺陷、不改文案与视觉、不动依赖与 `engines.dsh`、不与功能改动同批合入。
- 不改变 `client.js` 的对外形态：仍是单一 `__ModuleLoader__.load` 模块，`inject`/`apply` 的注册顺序与 id 不变。

## 4. 方案取舍

### 4.1 候选与判定

| 候选 | 命中判据 | 新机制 | 结论 |
|---|---|---|---|
| 宿主按轴拆 ESM 模块 | M2、M3、M4 | 无 | **采用** |
| 客户端四段结构 + 契约 + 标记区守卫 | DRY、SRP、OCP、ISP、DIP | 无（注释标记 + 静态守卫） | **采用** |
| 客户端拆片段 + 拼接生成 | 仅 M1，闭包共享未变 | 自研装配器、生成物、顺序耦合 | 不采用（附录 A） |
| 客户端改原生 chunk | 无，且改变交互时序 | 依赖内部协议与缓存 | 不采用（附录 B） |
| 拆 `Panel` 为子组件（切法 B） | M1、SRP | 无，但现有 vm 测试失效 | 不采用（附录 C），改用同文件 hook |

### 4.2 宿主：9 个轴，每个都要自证

| 模块 | 拥有的状态 | 隔离的失效模型 | 为什么值得 |
|---|---|---|---|
| `service-state.mjs` | `state`、`error`、`exclusive`、`lastGrant`、`sessionAuthentication`、`sessionEpoch`、`authEpoch`、`syncPublications`、`observedPending`、`listeners`、`stopWaiters`、`disposed` | 状态迁移非法、互斥冲突、订阅者抛错 | 视图与迁移的唯一真源，其余模块只读 |
| `service-store.mjs` | `store`、`storeCredentials`、`storeError`、`gatewayStore`、`modelSelectionStore`、`gatewaySummary`、`gatewayLoadedAt`、`gatewayLoading`、`gatewayEpoch` | provider 被撤销、原子写入失败 | 凭据落盘与清理只有一处 |
| `service-grant.mjs` | `grantOwners`、`metadataCache`、`jwksCache`、`identityProfile` | 签名/元数据校验失败、身份解析降级 | 协议缓存与身份归一处，可单测 |
| `service-reconcile.mjs` | 勘定退避与待定语义 | 会话恢复失败、后台勘定限流 | `syncFromStore` 160 行是状态机还原入口 |
| `service-signin.mjs` | `signInPromise`、`attempt` | 并发发起、回调过期、条件墓碑 | 登录与回调的锁内复查只有一个落点 |
| `service-signout.mjs` | `signOutPromise`、`signingOut` | 清理未知是否等于退出成功 | 独立失败模型，且受 `fail()`/`dispose()` 影响 |
| `service-token.mjs` | `refreshPromise` 及四个随行字段 | 刷新并发、过期边界、共享刷新 | 单飞刷新是最易出竞赛处 |
| `service-gateway.mjs` | 无（缓存归 store） | 网关凭据缺失、属主不匹配、不可用 | 凭据读写与校验有独立失败语义 |
| `service-model-selection.mjs` | `modelSelectionFlight`、`modelSelectionQueued`、`modelSelectionGeneration` | 选型并发、默认模型失效、目录过期 | 选型单飞与勘定调度互相牵制 |

单独设 `service-session.mjs`（只放 `getSession`/`watch`）既不拥有状态也不隔离失效模型，按 §1.3 并入 `service-state.mjs`。`service.mjs` 保留装配、`ctx` 构造、协作函数晚绑定、`dispose()` 与导出聚合。

### 4.3 客户端：不拆文件，但边界必须真实存在

文件不拆的代价是「边界只能靠纪律」，因此把纪律变成三样可执行的东西：

1. **四段结构**（§6.2）：纯函数与常量 / IO 边界 / hook（状态所有权）/ 视图与出口。段间单向依赖，每段有开始与结束标记。
2. **函数契约**：`render*` 只收 `{ h, ui, model, actions }`（≤ 4 个键），不读模块级可变状态、不直接触 `fetch`/`localStorage`；hook 只返回状态与动作，不返回元素。
3. **标记区守卫**（§6.3）：状态字面量比较、存储访问、错误码解包只允许出现在各自标记区内，越界即测试失败。

`Panel` 的 594 行按职责拆成三个 hook 与一个 `renderShell`（附录 C 的切法 A）：`useSessionView`（轮询、唤醒刷新、视图屏障）、`useModelCatalogue`（目录、筛选、展开、就地保存）、`useCredentialForm`（凭据草稿与保存）。元素树形状不变，因此现有 5 个行为测试的断言不用改。

### 4.4 范围

| 项 | 处置 | 依据 |
|---|---|---|
| 宿主 9 轴拆分 | 做 | 唯一真正改变耦合（M2/M3/M4），零新机制 |
| 客户端四段结构与契约 | 做 | 单文件内可执行的 DRY/SOLID 落地 |
| `Panel` 三 hook + render 分组 | 做（U3/U4） | SRP/ISP 的欠账在这一处最重 |
| 客户端拆片段 | 条件触发，见附录 A | 共享闭包未变，收益仅导航，代价是永久生成物成本 |
| `Panel` 拆子组件 | 不做，见附录 C | 现有 vm 测试会失效，收益不抵改造面 |

### 4.5 完成标准（已定 D-1）

issue 原标准是「拆分后 `client.js`（或其对等生成物）≤ 1200 行」。在「单入口 + 零构建」约束下该标准只能靠自研装配器或 chunk 异步化达成，两者都不满足性价比。负责人 2026-11-05 确认改判为：

- 宿主按 §4.2 落地，M1–M4 由守卫测试与落点表体现；
- 客户端不拆文件，单文件内满足 §1.6 的六条判据，由标记区守卫与契约守卫体现；
- 不再以行数作为验收口径；超过 600 行的模块需在评审说明为何仍是一个职责（不作为失败条件）。

### 4.6 ROI 排序与停点

| 顺序 | 单元 | 一次性成本 | 持续收益 | 风险 | ROI | 处置 |
|---|---|---|---|---|---|---|
| 1 | U1 客户端标记区、锚点、落点表与钩子守卫 | 1–1.5 小时 | 后续所有客户端整改的守卫骨架与定位 | 近零 | 最高 | 先做 |
| 2 | U2 客户端 DRY：状态映射、IO 边界、错误映射 | 3–5 小时 | 43 处状态判定 → 2 个映射；12 处存储 → 1 个边界；12 处错误解包 → 1 个入口 | 低（新增函数 + 机械替换） | 高 | 做 |
| 3 | U3 客户端 SRP：`Panel` 三 hook + `renderShell` | 4–6 小时 | 26 个状态单元归入三个职责；最热处可单独推理 | 中高（hook 顺序） | 中高 | 做 |
| 4 | U4 客户端 ISP：render 入参分簇 + models 区拆工具栏/列表 | 3–4 小时 | 34/26/21/16 个入参 → ≤ 4 组 | 中 | 中高 | 做 |
| 5 | U5 宿主状态轴（`ctx`） | 2–4 小时 | 45 个状态显式化；后续每轴机械搬运 | 中（310 处改名） | 中高 | 做 |
| 6–8 | U6 store、U7 grant、U8 网关 + 选型 | 各 2–3 小时 | 每类失败一个落点 | 中低 | 中 | 做 |
| 9 | U9 令牌刷新 | 2–3 小时 | 单飞刷新独立成文件 | 中高 | 中高 | 靠后 |
| 10–11 | U10 勘定、U11 登录退出 | 各 2–3 小时 | 四个最敏感函数获得文件级评审隔离 | 高 | 中 | 最后 |
| 12 | U12 文档与登记 | 0.5 小时 | 后来者知道去哪改 | 近零 | 高 | 做 |
| — | 客户端片段装配器（附录 A） | 1–2 天 + 永久成本 | 仅导航 | 低但长期 | 低 | 不做 |

**合计估算** 26–42 小时（不含实机冒烟与评审往返）。**最小可用组合**：U1 + U2 约 4–6 小时，做完后客户端已满足 DRY、IO 与错误映射的单点，宿主与 `Panel` 结构尚未改动，仓库仍处一致状态。

**停点**：U1、U2、U4、U12 以及 U5–U11 的每个单元结束后都可直接停。U3 内部不可中断（hook 抽取要么完成要么回退）；U5 是宿主侧不可中断点（改名必须一次做完）。

**为什么客户端整改排在宿主之前**：客户端是热文件（60% 提交），U2 的收益按周兑现；且 U2 的产出（状态映射、IO 边界）正是 U3 hook 抽取的前置，顺序颠倒会让 U3 返工。

### 4.7 客户端 DRY/SOLID 整改清单

| # | 问题 | 整改动作 | 守卫 |
|---|---|---|---|
| 1 | 43 处状态字面量比较、6 个状态名散落 | 新增 `deriveSessionUi(view)` 与 `deriveModelUi(view, options)`，返回具名布尔/档位（`signedIn`、`busy`、`needsSignIn`、`blocked`、`stale`、`tone`…）；组件只读派生结果 | 状态字面量比较只允许出现在映射标记区 |
| 2 | 12 处 `errorNotice(result.body?.error?.code …)` | 新增 `expectOk(result)`：成功返回 `body`，失败抛出带 `code` 的 `ClientApiError`；另留 `noticeFor(error)` 供表单展示 | 该解包表达式只允许出现在 IO 标记区 |
| 3 | 12 处 `window.localStorage`，3 处直接写 options 键 | 新增 `createClientStore()`：`marker`、`modelOptions`、`modelCache` 三个命名空间；键名与序列化各一份 | `window.localStorage` 只允许出现在 IO 标记区 |
| 4 | 单次调用 34/26/21/16 个入参 | `render*` 入参改成 `{ h, ui, model, actions }` 四组；`renderModelsCard` 拆为 `renderModelToolbar` + `renderModelList` | 定义处解构键 ≤ 4 且 ⊆ 允许集合 |
| 5 | `Panel` 四职责混在一个函数 | 三个 hook + `renderShell`；`Panel` 只做装配 | hook 序列跨渲染一致（harness 守卫） |
| 6 | `renderHelpTip` 内嵌在 `renderModelItem` | 提到文件级纯函数，模型项按参数调用 | 纯函数段不得引用 hook 段符号 |
| 7 | 派生值在 `Panel` 内就地计算约 60 行 | 移入 `deriveSessionUi`/`deriveModelUi`，`Panel` 只取结果 | 同 #1 |
| 8 | `errorNotice` 的 40 个分支与宿主 14 条 `MESSAGES` 靠注释同步 | 改为冻结对象表 `ERROR_NOTICE`（码 → 文案，含 `DEFAULT`）；新增双向用例：宿主每个码要么在客户端有文案，要么在「仅宿主」清单里注明原因 | 表存在性 + 双向覆盖用例 |

第 1、3、7 条属同一处：把「view 状态 → 界面语义」集中到映射函数，是本轮最高性价比的改动。

## 5. 实施步骤

顺序即 §4.6。每单元结束都应满足：`node --test packages/forge-iam/test` 全绿 → `node --run check` 全绿 → `git diff --check` 无输出。每单元一个提交；本仓提交由敏感扫描钩子签名，签名后不改写历史。

### U0 基线与分支

- 在干净 worktree 跑 `node scripts/link-workspace.mjs && node --run check`，确认 2723 通过 + 1 跳过 + 0 失败；与 §1.4、§2.1 的实测数字一并写入交付说明。
- 建分支 `refactor/161-iam-structure`；`git status --short` 为空或改动归本方所有。

### U1 客户端：标记区、锚点、落点表与钩子守卫

- 在 `client.js` 按职责插入锚点注释（`// §<序号> <职责>`，共 17 个，含 12.1–12.4、13.1、16.2–16.3 等子锚点），文件头加不带行号的分区索引；此步只加注释，不动代码。四段结构的开始/结束标记随 U2 的 IO 收口一起落——现状里纯函数与 IO 交错，先立标记只会写错位置。
- 在模块 README 增加「改动落点」一节：按职责列出客户端锚点与宿主文件，写明「用锚点而不是行号定位」。
- 在 `test/support/client-panel.mjs` 记录每次 render 的 hook 调用序列并断言跨 render 一致，让「条件调用 hook」在测试期失败。
- 新增 `test/client-structure.test.mjs` 与 `test/support/client-source.mjs`：把状态判定、存储访问、错误解包、渲染入参四类现状按「所属函数」冻结成基线（键为函数名，插入行不影响），新出现即失败；U2–U4 逐项下调到 0 或 4。同一文件再守三条形态不变量：单一 `__ModuleLoader__.load`、无静态 `import`/`export`、四个插槽注册仍在。
- 完成条件：全部测试绿；`git diff --stat` 只出现注释、文档与新增测试。

### U2 客户端 DRY：状态映射、IO 边界、错误映射

- 新增 `deriveSessionUi` / `deriveModelUi` / `deriveGatewayUi`：会话状态、模型目录状态、凭据状态各自只在一个派生函数里读，其余组件用布尔量组合；`deriveGatewayUi(credential, fallback)` 的 fallback 由调用点决定，不合并「未确认」与「待配置」。
- 新增 `createClientStore()`：`marker`、`modelOptions`、`models`（读/写/删/按前缀清理）三个命名空间，替换 12 处 `window.localStorage`。
- 新增 `resultCode` / `resultNotice`：12 处 `errorNotice(result.body?.error?.code ?? …)` 收成一句。`if (!result.ok)` 属于控制流，保留原地——用抛错式的 `expectOk` 会把 11 个处理器的状态更新改写成 try/catch，超出 DRY 的范围。
- `errorNotice` 的 45 个分支改为 `ERROR_NOTICE` 冻结表（无原型对象），并补齐宿主有、客户端缺的 `IAM_GATEWAY_CREDENTIAL_REQUIRED`；面板文案用例遍历宿主 `MESSAGES` 全量比对。
- 关键约束：映射函数只表达「已存在的判定」，不得合并语义或改变分支顺序；`view.state === 'authenticating'` 与 `state.phase === 'loading'` 是两件事，不得并成一个标志。
- 完成条件：行为测试与契约测试断言未改且全绿（仅两处跟随改写的源码断言）；结构守卫把「`view.state` / `modelAccess.state` / `gateway.state` 读取」分别压到各自的派生函数、「存储访问」压到 `createClientStore`、「响应错误码解包」压到 `resultCode`、「错误文案只有表」；`client.js` 行数不作为判据（本单元净增约 130 行）。

### U3 客户端 SRP：`Panel` 三 hook + `renderShell`

- 三个 hook 按数据归属切：`useModelCatalogue({ view, viewBarrier, setView })`（缓存键、参数覆盖、筛选、展开、就地保存）、`useCredentialForm({ view, viewBarrier, setView, catalogue })`（草稿、保存、清除、目录刷新）、`useSessionView({ state, setState, viewBarrier, catalogue, form })`（加载、轮询、唤醒限流、登录/取消、退出、复制通道）。
- 调用顺序即依赖方向：`catalogue` → `form` → `session`。会话视图由 `Panel` 持有并传入（单一写者），所以后两个 hook 只出动作与状态，不回写别人的状态。
- 跨簇写入只用两种显式端口：`setView`（回写视图）、以及 hook 参数里点名的合作者（`catalogue` / `form`）。不再有隐式的闭包共享。
- 两个跨簇耦合按原样保留：保存成功回写视图（`setView`）、退出时清目录与展开态（`catalogue.actions.reset`）。
- `renderShell` 不再单独抽：hook 抽完后 `Panel` 只剩装配（137 行），再拆一层只增加调用跳转，不减少耦合。
- 完成条件：`Panel` 降至约 150–200 行（实测 137）；hook 序列守卫通过；行为与契约测试全绿。

### U4 客户端 ISP：render 入参分簇

- 四个 render 函数改为 `{ h, ui, model, actions }`：按数据来源分簇——`ui` 是视图与派生展示值、`model` 是目录数据、`actions` 是回调与新意图；界面常量改为模块级引用，不再作为入参。
- 条目渲染同步改为 `{ h, item, actions }`；`renderHelpTip` 提到文件级，只定义一次。
- `renderModelsCard` 不再拆工具栏/列表：卡片体是一个 `h('section', …)` 表达式树，拆开等于让两个新函数各自重新解构二十多个局部名，接口反而变宽——这与「不为分割而分割」冲突，故不实施。
- 关键约束：元素树形状与节点属性不变（`aria-label`、`className`、文案逐字保持），否则行为测试的查找会失效——这正是本步的自动校验。
- 完成条件：四个入口的入参键 ≤ 4（实测 3/3/3/4，条目 3）；`node --test packages/forge-iam/test` 全绿；`git diff` 中不含文案或 class 变化。

### U5 宿主：状态与视图发布轴

- 新增 `service-state.mjs`：`createServiceState(env)` 持有 §4.2 首行状态，提供 `view`、`notify`、`publish`、`fail`、`recheckExclusive`、`assertExclusive`、`knownIssuer`、`setGrant`、`setAuthentication`、`getSession`、`watch`。
- 改写 `service.mjs`：删去对应声明与函数，改为 `ctx` 装配；`state`/`error`/`lastGrant`/`disposed`/`exclusive` 改为 `ctx.*`（这五个名字现有 310 处出现）。
- 改名纪律：不要全局正则替换——`state` 同时出现在 `result.state`、`transition(state, next)`、注释与文案里；按函数段落逐处改，`git diff -U0` 逐屏核对。
- 关键约束：`view()` 读取 `gatewaySummary` 与 `options.getManagedModelRuntime()` 的顺序、`notify()` 之后调用 `scheduleDefaultModelReconciliation()` 的顺序、`fail()` 的分支顺序与 `notify()` 次数都不变。
- 实现记录：`service.mjs` 2047 → 1961 行（−86），新增 `service-state.mjs` 163 行；`ctx` 以读写访问器暴露五个值，调用点保留原有赋值时序。
- 结构守卫 `test/service-state-structure.test.mjs` 固定三条：`service.mjs` 不得再声明这五个名字、不得裸写、监听器只能经 `ctx` 收放。
- 完成条件：测试全绿；`service.mjs` 只经 `ctx` 读写状态；此后每单元皆可单独停止。

### U6 宿主：store 轴

- 新增 `service-store.mjs`，接管 §4.2 的 store 状态与 `ensure`、`require`、`atomicVerified`、`assertAtomic`、`beginConsumption`、`adoptConsumption`、`consumeWitness`；`ensureStore()` 的 22 处调用改为 `store.ensure()`。
- 关键约束：`ensureStore()` 在「provider 被撤销」分支里对 `gatewaySummary`/`gatewayEpoch` 的清理与 `storeError` 赋值逐句保留。
- 实现记录：`service.mjs` 1961 → 1880 行，新增 `service-store.mjs` 129 行；`provider.ensure/require/atomicVerified/assertAtomic` 保持原实现与调用顺序，撤销分支的 `gatewayEpoch += 1` 三处（撤销、重建、失败）逐句保留。
- 守卫扩展：`service-state-structure.test.mjs` 追加两条——`service.mjs` 不得再声明九个 provider 字段、`service-store.mjs` 必须独占四个入口。
- 完成条件：`atomic-gate`、`gateway-atomic-*`、`service-races`、`dual-process-*` 全绿。

### U7 宿主：grant 轴

- 新增 `service-grant.mjs`：`grantOwners`、`metadataCache`、`jwksCache`、`identityProfile` 与 `prepareAuthentication`、`rememberAuthentication`、`metadata`、`jwks`、`verifyWithJwks`、`grantFromToken`、`buildGrant`、`assertGrantBinding`、`assertGrantContext`、`redirectUri`、`loadIdentityProfile`、`clearProfile`。
- 实现记录：`service.mjs` 1880 → 1690 行，新增 `service-grant.mjs` 249 行。`sessionAuthentication` 按 §4.2 并入 `service-state.mjs`；`grantOwners` 以 `own`/`ownerOf`/`had` 三个方法对外，service 不再持有弱映射；`ID_TOKEN_CLOCK_SKEW_SECONDS` 移入 `service-helpers.mjs` 由两处共用。
- 两个 `metadataCache?.value ?? await metadata()` 调用点保留「先读缓存、再取新」的语义，不改成无条件 `metadata()`，否则离线路由（退出、回调）会多一次网络请求。
- 完成条件：`login`、`oidc`、`security-matrix`、`client-auth-*`、`userinfo`、`revoke-access-token` 全绿。

### U8 宿主：网关与选型轴

- 新增 `service-gateway.mjs`（网关凭据读写与校验）与 `service-model-selection.mjs`（`selectionOwner`、`modelSelectionFlight`/`Queued`/`Generation`、`scheduleDefaultModelReconciliation`、`reconcileDefaultModel`、选型读写与 `getModelAccessEpoch`）。
- 实现记录：`service.mjs` 1690 → 1540 行，新增 `service-gateway.mjs` 85 行、`service-model-selection.mjs` 124 行。依赖单向：gateway → selection（`selection.schedule()` 与 `selection.inFlight`），selection 反向只经注入的 `getLoadGateway` 端口，故两模块不互相 import。
- `service.mjs` 保留 `readGatewayCredential`/`loadGatewayCredential` 的服务出口，指向 `gateway.read`/`gateway.load`。
- 完成条件：`gateway-atomic-*`、`credential-*`、`model-selection-*`、`host-default-model`、`cli-session` 全绿。

### U9 宿主：令牌刷新轴

- 新增 `service-token.mjs`：`refreshPromise` 单飞及四个随行字段、`lastBackgroundRefreshAt`、`resolveToken`（375 行整段搬运）、`getAccessToken`。
- 关键约束：`resolveToken` 的 `useSharedRefresh`/`checkProvider` 闭包与 `finally` 里 `refreshPromise` 的复位条件不能拆散，判断顺序不改。
- 实现记录：`service.mjs` 1540 → 1216 行，新增 `service-token.mjs` 370 行。`resolveToken` 325 行整段搬运，`getAccessToken` 改为调用模块内 `resolveToken`；服务出口保留 `resolveToken: token.resolveToken` / `getAccessToken: token.getAccessToken`。
- 端口：`isSigningOut`、`getSessionEpoch`、`getAuthEpoch`、`clearObservation`、`beginConsumption`、`adoptConsumption`、`fetchImpl`。单飞记录的四个随行字段随模块走；`lastBackgroundRefreshAt` 以读写访问器对外，供 `syncFromStore` 的退避判定使用。
- 完成条件：`refresh-complete-validation`、`dual-process-refresh`、`service-singleflight-regression` 全绿。

### U10 宿主：勘定轴

- 新增 `service-reconcile.mjs`：`syncFromStore`（160 行整段搬运，不重排）、`hydrate`、30 秒后台退避与待定语义。
- 实现记录：`service.mjs` 1216 → 1068 行，新增 `service-reconcile.mjs` 195 行。`syncFromStore`（160 行）与 `hydrate` 整段搬运。
- 端口分两类：只读环境（`ctx`/`provider`/`grants`/`gateway`/`token`/`now`/`configured`）与状态端口（`getAuthEpoch`/`getObservation`/`setObservation`/`getPublications`/`bumpPublications`/`hasSignInAttempt`/`isSigningOut`/`beginConsumption`/`adoptConsumption`/`resolveToken`）。`observedPending` 与 `syncPublications` 的变量仍归 `service.mjs`，模块只经访问器读写，单一归属不变。
- 搬运中把 `observation.authEpoch` 误改成 `observation.getAuthEpoch()`（字段访问被当成裸标识符替换），由 `dual-process-refresh` 的 pending 用例暴露；守卫补了这条断言。
- 完成条件：`sync-provider-replacement`、`dual-process-refresh`、`lifecycle` 全绿。

### U11 宿主：登录、回调与退出轴

- 新增 `service-signin.mjs`（`startSignIn`、`_startSignInOnce`、`cancelSignIn`、`handleCallback`、`clearAttempt`）与 `service-signout.mjs`（`signOut`、`_signOutOnce`、`bridgeCapability`）；收敛 `service.mjs` 为装配入口。
- 实现记录（登录半轴）：`service.mjs` 1068 → 759 行，新增 `service-signin.mjs` 374 行。`attempt` 对象与 `clearAttempt` 随模块走，`service.mjs` 的 `clearAttempt()` 改为转发；`signInPromise`、`authEpoch`、`observedPending`、消费票据仍由 `service.mjs` 持有，经 `getSignInPromise`/`setSignInPromise`/`bumpAuthEpoch`/`clearObservation`/`invalidateConsumption`/`beginConsumption`/`adoptConsumption` 端口读写。
- 关键约束：只做搬运与前缀改写，不改判断顺序——`handleCallback` 的锁内复查（attempt、epoch、到期、store 身份、`sessionInstanceId`）与条件墓碑、`_signOutOnce` 的清理顺序与「清理未知不等于退出成功」。
- 实现记录（退出半轴）：`service.mjs` 759 → 604 行，新增 `service-signout.mjs` 196 行。`signOutPromise`、`signingOut` 与 `bridgeCapability` 随模块走；令牌、选型、勘定、登录四处原先读取 `signingOut` 的端口改指 `signout.signingOut`，端口名不变。
- `BRIDGE_REF` 常量随之迁入退出模块，`service.mjs` 不再引用 `randomBytes`。
- 完成条件：`signout-*`、`rp-logout-issuer-context`、`issuer-context-policy`、`lifecycle` 全绿；28 项导出面逐项一致。

### U12 文档、登记与最终验收

- 模块 README：模块表按轴分列；补「客户端四段与契约」「改动落点表」。
- [开发约定](<../engineering/development-conventions.md>) 与根 [README](<../../README.md#3-本地检查>) 补一段「宿主按轴拆模块、客户端单文件四段 + 标记区守卫」的约定，`pnpm check` 定义不变。
- 核对 [IAM 接入详细设计](<../design/plugins/forge-iam.md>) 与 [开发指南](<../../packages/forge-iam/docs/developer-guide.md>) 中指向 `service.mjs`/`client.js` 的表述：两者仍是入口，只补一句「内部按轴/四段组织，落点见模块 README」。
- 实现记录：模块 README 新增「Host 分轴模块」表（10 行，含各轴拥有的状态与职责边界）与客户端四段 ↔ 锚点区间表；改动落点表补齐 9 行宿主轴。开发约定新增 §4.1「宿主按轴、客户端按段」。IAM 详细设计与开发指南各补一句指向模块 README。
- 与计划的偏差：根 README 不加结构约定——[AGENTS.md §1](<../../AGENTS.md>) 规定根 README 是产品宣传页，禁止写入检查器规则与开发手册内容；该约定改放[开发约定 §4.1](<../engineering/development-conventions.md#41-结构约定宿主按轴客户端按段>)。
- 完成条件：`node --run check` 全绿；`git diff --check` 无输出。

### U13 宿主：网关与选型的写入口（评审第 3 轮发现）

`service.mjs` 仍留有六个薄壳方法直接做存储工作：`readModelSelection`、`saveModelSelection`（`provider.ensure()` + 选型 store）、`resolveGatewayConnection`、`saveGatewayCredential`、`clearGatewayCredential`、`refreshGatewayModels`（`provider.require()` + 锁内复查）。共约 200 行、8 处 `provider.ensure()/require()`、6 处 `ctx.assertExclusive()`。

这违反 §6.3 守卫 3 的本意（聚合入口不做业务判定），也是 M1 的最后一块：改网关凭据写入要横跨 `service.mjs` 与 `service-gateway.mjs` 两处。

- 落点：`readModelSelection`/`saveModelSelection` → `service-model-selection.mjs`；其余四个 → `service-gateway.mjs`。两者已持有对应 store 与 epoch，方法搬过去不需要新端口，只需把 `provider` 与 `ctx` 已注入的端口用上。
- 完成后 `service.mjs` 只保留转发与 `watch`/`dispose`/`getView` 等出口，再补守卫 3 的静态断言（`transition(`、`publish(`、`ensure(`、`require(`、`assertExclusive(` 均不得出现在 `service.mjs`）。
- 完成条件：`gateway-credential-*`、`model-selection-*`、`service-races` 全绿；`node --run check` 全绿。

## 6. 关键实现说明

### 6.1 宿主上下文与所有权

`ctx` 由 `service.mjs` 构造，含 `env`（`config`、`options`、`configured`、`now`、`fetchImpl`、`profileFields`）、状态簇与协作模块引用。约定：模块只写自己拥有的字段；共享标量经写入口收口（`setGrant`、`setAuthentication`、`clearProfile`）；跨模块调用走 `ctx.<模块>.<函数>`，由 `service.mjs` 晚绑定以避免循环 `import`。

### 6.2 客户端四段结构与契约

```
// §1 纯函数与常量     样式表、文案表、deriveSessionUi/deriveModelUi、格式化、图标、renderHelpTip
// §2 IO 边界          createClientStore()、getJson/postJson/putJson/deleteJson、expectOk/noticeFor
// §3 hook             useSessionPoll（既有）、useSessionView、useModelCatalogue、useCredentialForm
// §4 视图             renderJourneyBar/renderAccountCard/renderGatewayCard/renderModelToolbar/renderModelList/renderModelItem/renderOnboardingStepDetail + 组件外壳
// §5 出口             inject / apply
```

段间**单向依赖**：§4 可调 §3/§2/§1；§3 可调 §2/§1；§2 只调 §1；§1 不引用任何人的符号。契约三条：

- `render*` 只收 `{ h, ui, model, actions }`（≤ 4 键），不读模块级可变状态，不直接调 `fetch`/`localStorage`。
- hook 只返回 `{ state, actions }`，不返回元素、不写 DOM。
- 组件外壳只做装配：取值 → 调 render → 返回元素树。

### 6.3 守卫（把判据变成失败）

宿主（`service-modules.test.mjs`）：

1. `src/service-*.mjs` 只 import 叶子模块与 `node:` 内置；`service.mjs` 是唯一聚合点。
2. `ctx.<field> =` 只出现在该字段所属模块（映射表与 §4.2 一致）。
3. `service.mjs` 不得出现 `transition(`、`assertExclusive(`、`ensureStore(`、`publish(` 等业务调用。
4. 任何 `src/service-*.mjs` 超 600 行时打印提示，不失败。

客户端（`client-structure.test.mjs`）：

1. **标记区守卫**：状态字面量比较只允许出现在 §1 的映射函数内；`window.localStorage` 只允许出现在 §2；`errorNotice(result.body?.error?.code` 只允许出现在 §2。实现方式：定位段标记行号，逐个匹配检查所在区间。
2. **入参守卫**：`function render*(…)` 的解构键 ≤ 4 且 ⊆ `{h, ui, model, actions}`。
3. **依赖方向**：§1 段内不得出现 `getJson`/`use[A-Z]`/`h(` 之外的段外符号（允许 `h` 由参数传入）。
4. **hook 序列**（harness）：同一次渲染内 hook 调用序列跨渲染一致；新引入 `useMemo` 等未实现的 hook 会直接报错，需同步扩展 harness。

### 6.4 标记与锚点约定

- 段标记固定 5 行（`// §1 pure …`），锚点 `// §4.3 模型卡` 只描述职责、不写行号。
- 新代码必须落在既有段的既有锚点内；确需新段或新锚点时同步更新文件头索引，索引与正文由守卫的标记定位间接校验（标记缺失即失败）。
- 标记与锚点对运行时零影响：`client.js` 仍是同一模块、同一 `factory`，注释不改变装载与执行顺序。

## 7. 测试方案

| 层次 | 用例 | 作用 |
|---|---|---|
| 既有回归 | `packages/forge-iam/test` 全部（1210 个） | 每单元必跑；宿主的四个敏感函数与客户端的行为路径都在其中 |
| 既有契约 | [client-shape.test.mjs](<../../packages/forge-iam/test/client-shape.test.mjs>)、[client-managed-models.test.mjs](<../../packages/forge-iam/test/client-managed-models.test.mjs>)、[client-launcher.test.mjs](<../../packages/forge-iam/test/client-launcher.test.mjs>)、`client-signout-behavior` | 继续读 `client.js`，断言不改；证明文案、路由、CSRF 头、插槽 id 未变 |
| 既有行为 | 5 个使用 [client-panel.mjs](<../../packages/forge-iam/test/support/client-panel.mjs>) 在 `node:vm` 里执行 `client.js` 的测试文件 | 证明挂载、轮询、剪贴板、退出流程未变；U3/U4 的元素树不变由它们守 |
| 新增 | `client-structure.test.mjs`：标记区、入参、依赖方向 | 把 §1.6 的 DRY/SRP/OCP/ISP/DIP 变成回归门 |
| 新增 | `service-modules.test.mjs`：无横向 import、唯一写者、聚合入口无业务判定 | 把 M2/M3 变成回归门 |
| 新增 | `client-panel.mjs` 的 hook 序列守卫 | 条件调用 hook 在测试期失败，而不是等实机白屏 |
| 全库 | `node --run check` | 文档、仓库结构、tarball 闭包、DSH 版本与全部测试 |
| 手工冒烟（未执行） | 装入 DSH、重启，走一遍：设置页「企业账号」→ 切换账号/网关 → 展开模型 → 搜索筛选 → 就地保存 → 断网重连 → 退出再登录；启动器、未登录横幅、四步引导；控制台无报错；浅色/深色各一次 | U3/U4 改变的是状态归属与入参形状，只有实机能证明交互未变 |

## 8. 验收标准

| 项 | 命令/方式 | 预期 |
|---|---|---|
| 全量检查 | `node scripts/link-workspace.mjs && node --run check` | exit 0；2723 通过 + 1 跳过 + 新增守卫用例通过 |
| IAM 单独 | `node --test packages/forge-iam/test` | exit 0 |
| DRY：状态映射 | `grep -cE "view(\?)?\.state ===" packages/forge-iam/client.js` 与标记区比对 | 全部落在 §1 映射区，或总数降至 ≤ 6（映射函数内的一处 switch） |
| DRY：存储 | `grep -n "window.localStorage" packages/forge-iam/client.js` | 全部落在 §2 IO 区 |
| DRY：错误映射 | `grep -c "errorNotice(result.body?.error?.code" packages/forge-iam/client.js` | 0（已被 `expectOk` 取代）或仅 §2 内 1 处 |
| ISP | `client-structure.test.mjs` 的入参断言 | 四个 render 入口键数 ≤ 4 |
| SRP | `Panel` 行数与 hook 归属 | `Panel` 约 150–200 行，只做装配 |
| 宿主结构 | `service-modules.test.mjs` | 无横向 import、每字段单写者、装配入口无业务判定 |
| 导出面 | 对照 §3 的 28 项 | 与拆分前一致 |
| 客户端形态 | `node -e` 读取 `client.js` 首尾 | 仍是单一 `__ModuleLoader__.load`，`inject`/`apply` 注册不变 |
| 空白与差异 | `git diff --check` | 无输出 |
| 敏感扫描（推送前） | `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD` | 全部 verified |
| 行为抽查 | §7 末行的冒烟清单 | 控制台无报错、交互与拆分前一致；结果写进交付说明 |

未执行项须单列：本文只完成分析与计划；未安装测试插件、未实机验收、未推送。

## 9. 风险与注意事项

| 风险 | 影响 | 处置 |
|---|---|---|
| 状态映射合并过度 | 把语义不同的两个判定并成一个 flag，界面进入错误分支 | 映射只表达已存在的判定；逐处替换 + 行为测试；`authenticating` 与 `phase==='loading'` 明确分开 |
| 机械改名遗漏 | 宿主的竞态判定失效而测试仍可能绿 | 一轴一提交；`git diff -U0` 逐屏核对；四个敏感函数只搬运 |
| hook 抽取改变顺序或引入条件调用 | 实机白屏、面板崩溃 | harness 钩子序列守卫 + 实机冒烟；`useMemo` 等未支持 hook 需先扩 harness |
| render 入参改写动了 class/文案 | 行为测试按 `aria-label` 找不到节点，或视觉变化 | 元素树形状保持是 U4 的硬约束；diff 中不得出现文案与 class 变化 |
| 标记区被绕过（新代码写在标记区外） | 守卫失效，DRY 重新退化 | 守卫按行号区间判断，越界即失败；新增段必须同步索引 |
| `Panel` 仍可能重新长胖 | 半年后回到 600 行 | 落点表 + §1.6 判据；膨胀到必须处理时按 §1.3 重新评估 |
| 提交签名被改写 | PR 的 `sensitive-attestation-verify` 变红 | 签名后不 amend/rebase/reset；确需改历史按 AGENTS.md §4 逐条重建重签 |

回退：全部改动是函数搬迁、契约收口与注释，逐单元 `git revert` 即可回到当前形态；不涉及数据迁移，也不触碰已保存的凭据与 grant 记录。

## 10. Luna 执行清单

1. 读 §1 判据、§2.1 违规实测与 §4.6 排序，按 U0 记录基线；数字与本文不符先报告差异。
2. U1 标记区、锚点、落点表与守卫骨架，确认全部测试绿，提交（示例：`refactor(iam): 为 client 建立四段标记区与结构守卫`）。
3. U2 状态映射、IO 边界、错误映射；每替换一处即跑行为测试，提交（示例：`refactor(iam): 收敛 client 的状态映射、存储与错误解包`）。
4. U3 `Panel` 三 hook + `renderShell`；整段完成后再提交，确认 hook 序列守卫与行为测试全绿。
5. U4 render 入参分簇与 models 区拆分；diff 中不得出现文案/class 变化，提交。
6. U5–U11 宿主 9 轴，按 §4.6 顺序推进，每单元跑对应用例后提交；`handleCallback`、`_signOutOnce`、`syncFromStore`、`resolveToken` 只搬运不改判断顺序。
7. U12 文档与登记同步，跑 `node --run check` 与 `git diff --check`，提交。
8. 按 §8 逐项取证；任一单元出现「必须改行为才能通过」的情况，停止并报告，不在纯重构里夹带修复。
9. 交付说明列出未执行项（实机冒烟、远端 CI），并按 §4.5 口径验收：不以行数自证，以守卫与落点表自证。

## 决定记录

| 项 | 结论 | 适用范围 |
|---|---|---|
| D-1 完成标准改判 | 负责人 2026-11-05 确认：接受 §4.5 口径 | 验收不再以行数判定；客户端不拆文件 |
| D-2 `Panel` 分解 | 已定：不另立议题，按切法 A 在同文件内并入 U3 | 理由见附录 C；`Panel` 只做装配 |
| D-3 宿主拆分范围 | 负责人 2026-11-05 确认：一次做完 §4.2 的全部 9 个轴 | U5–U11；不保留双模型中间态 |
| D-4 实施顺序 | 负责人 2026-11-05 指示按最高 ROI 排序 | 客户端低成本项前置，最敏感的三个宿主轴后置（§4.6） |
| D-5 内部质量判据 | 负责人 2026-11-05 要求：不拆文件也要符合 DRY/SOLID | 落为 §1.6 判据、§4.7 整改清单与 U1–U4；由标记区与契约守卫强制执行 |
| D-6 `Panel` 的切法落地 | 实施时改为三步：先目录、再凭据、最后会话；`renderShell` 并入 `Panel` | 会话视图归 `Panel` 持有，避免 hook 之间用可变端口互相引用；`Panel` 从 600 行降到 137 行 |
| D-8 状态用访问器暴露而非状态机 API | `ctx` 提供 `get/set state` 等五个读写访问器，不把 22 个赋值点改写成方法调用 | 这些赋值依赖「先赋值、后统一 `notify()`」的时序，改成方法会重排 22 处时序，风险大于收益；单写者的约束由结构守卫保证 |
| D-7 模型卡不再拆工具栏/列表 | 实施时撤回该拆分 | 卡片体是单一元素树，拆出的两个函数要各自重新解构二十多个局部名，接口变宽而非变窄；条目已单独成函数，剩余部分是控件与列表状态，属同一职责 |
| D-9 客户端不做行号段标记 | §6.2/§6.3 原计划用 5 个段标记行 + 按行号区间定位的守卫，改为锚点区间 + 按符号归属的守卫 | 行号会随编辑漂移，守卫要么频繁失效、要么被随手放宽；按符号归属判（状态字面量只在 `deriveSessionUi`、`localStorage` 只在 `createClientStore`、错误码解包只在 `resultNotice`/`resultCode`、`render*` 解构键 ≤4）同样满足三条 DRY/SRP 判据，且改代码不会让判据失真 |

## 附录 A 客户端片段装配器（仅当触发条件成立）

触发条件（任一）：仓库因其他原因引入构建步骤；客户端出现第二个消费方（例如模型卡被复用到别处）；单次改动频繁横跨三个以上职责块；负责人明确接受生成物的维护成本。

形态：源片段放 `src/client/`，`scripts/build-client.mjs`（零依赖，约 70 行）按 `MANIFEST.json` 顺序拼进同一 `factory` 闭包，生成包根 `client.js` 并入库；`node --test` 内加一致性用例。

已知代价：生成物入库后其 `git blame` 失去出处价值；每次改动需重新生成；MANIFEST 顺序成为隐式初始化依赖。**不采用 bundler**：本仓 CI 明确不安装依赖（[check.yml](<../../.github/workflows/check.yml>) 注释「All checks currently use Node built-ins; avoid dependency installation」），任何需要安装包的构建步骤都无法在 CI 强制校验。

## 附录 B 为什么不用原生 chunk

复核三处代码事实：`lib/client.js` 的 `makeRequire`（`require` 只查 seed/已物化/factory 表）、同文件的 `importChunk`（chunk 必须自注册 `<pkg>/client.<name>.js`）、`lib/index.js` 的 `chunkRequest` 与 `artifactRevision`（chunk URL 的 revision 取自入口文件 stat，响应带一年期 `immutable`）。三者共同决定：chunk 只能异步到达（五个插槽注册随之变成异步或需要挂起态），且必须自包含（共享的 `React`/`h`/CSS/HTTP 工具要么各带一份，要么逐层异步初始化），只改 chunk 不改入口时已缓存 revision 的浏览器还会取到旧字节。三项都与「零交互变化」冲突。

## 附录 C 为什么用同文件 hook（切法 A）而不是子组件

`Panel` 的 26 个状态单元分属四簇：会话视图（`state` 五字段、`viewRef`、`wakeRef`、`viewBarrier`、`linkIdentity`、唤醒限流）、模型目录（`cachedModels`、`cacheKeyRef`、`modelOptions`、`lastSyncedOptions`、`expandedModels`、`modelQuery`、`modelFilter`、`modelSaving`、`modelNotice`、`toolbarRef`）、凭据表单（`credential` 四字段）、布局拼装。两处真耦合：身份变化作废目录、保存回写视图。

| 切法 | 形态 | 对现有测试 | 结论 |
|---|---|---|---|
| A 抽 hook + render 函数 | 三个自定义 hook + 纯函数渲染 | 无影响：元素树仍是扁平对象，5 个行为测试按 `aria-label`/文案找节点、直接调 `props.onChange` 的写法继续可用 | 采用（U3/U4） |
| B 拆子组件 | `<ModelSection/>` 等各自持有 hook | 全部失效：元素树出现 `{type: 组件函数}` 节点，假 React 不进入子组件，必须把 harness 改成递归渲染 | 不采用 |

现有 5 个行为测试走 `node:vm` 与假 React（按调用顺序分配 hook cell、按 `children` 展开元素树），**不做 hook 顺序校验**。这也是 U1 要加钩子序列守卫的原因：切法 A 最容易犯的错是把 hook 放进条件分支，那种错误在旧测试里不会报错，只在真实 React 抛 `Rendered more hooks than during the previous render`。

若日后确需切法 B（例如模型卡要被复用），前置条件是先把 harness 改成递归渲染并补齐 `useMemo`/`useContext`，再单独评估——不在本计划范围内。
