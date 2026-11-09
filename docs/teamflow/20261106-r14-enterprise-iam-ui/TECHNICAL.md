<!-- meta: summary="以现有 DevOps Client 承载企业研发总览，IAM 唯一身份源；补 Gitee 配置面与带基准的保存回执，公共维护缺权保持只读；列明接线准入与并行文件边界。" -->
# 企业研发设置与 IAM 整合技术方案

> Agent 代拟；2026-11-06；技术设计，不是实现或生产批准。依据 [PRD](<PRD.md>)、[设计](<DESIGN.md>)。本任务不修改历史基线、不取代历史 AC。

## 1. 架构判断与事实基线

沿用 Node 24.21.0、pnpm 11.28.5、ESM `.mjs`、宿主提供 React 的普通 `client.js`、`node --test`。不新增框架、独立网页、身份库或集中配置服务。**在已有 forge-devops Client 中增加“企业研发”设置分区，保留“企业 DevOps”；总览只是三个现有插件的安全投影，不成为新身份或配置真源。** Gitee 配置由 Gitee 自己拥有，不把它的字段塞回 DevOps。

### 1.1 已核验依据

| 依据 | 发现与设计影响 |
|---|---|
| [根清单](<../../../package.json>)、[开发约定](<../../engineering/development-conventions.md>)、[设计索引](<../../design/README.md>) | workspace 包间使用公开 exports，不跨包导入源码；本轮不增加包，减少装配及制品变化 |
| [DevOps 配置](<../../../packages/forge-devops/src/cli-config.mjs>) | 四键解析唯一真源；普通页面仅 `dopBin/timeoutMs`；隐藏键不进入新普通页面 |
| [DevOps 保存](<../../../packages/forge-devops/src/cli-access.mjs>) | 已有增量、revision、回读；现用写前计算的 `built.next` 回调，有并发窗口，必须在 editor 回调内再次核对基准并重新构造补丁 |
| [DevOps HTTP](<../../../packages/forge-devops/src/http.mjs>)、[装配](<../../../packages/forge-devops/src/index.mjs>) | 原 HTTP 直接调 access.save，不能据 service.saveCliConfig 的存在声称 HTTP 已完成同一重建；本轮统一注入 service 保存编排 |
| [Gitee 清单](<../../../packages/forge-gitee/package.json>)、[配置](<../../../packages/forge-gitee/src/runtime-config.mjs>) | 当前无 Client、无配置 HTTP；不新增 Gitee Client，新增自有 Host 配置面供总览消费 |
| [Gitee 执行器](<../../../packages/forge-gitee/src/gitee-cli.mjs>) | 唯一 execFile、有界执行；默认 persistentToken=warn，block 才拦截；保持真实现状，不能沿用旧摘要宣称默认 block |
| [IAM 视图](<../../../packages/forge-iam/src/state.mjs>)、[IAM 服务](<../../../packages/forge-iam/src/service.mjs>) | 现有视图含主体、网关地址与模型数据，不能整包转发至新总览；另做白名单状态投影 |
| [IAM 注册](<../../../packages/forge-iam/client.js>) | 已有 settings.section id=forge-iam；保留其登录、onboarding、凭据与模型界面 |

2026-11-06 Host Inspect 已取得真实 `configEditor.configuration()`、`configEditor.edit(entry, change)`、`connection.requestRejection(request)`、`webServer.register(route)` 合同。安装包 README 确认 config-editor 在 profile 锁内先调和外部变化，再计算候选，写入并完成 Loader 调和；失败恢复文档与旧补丁；只编辑根 Include 唯一条目，不编辑上层 home/命令行覆盖。**edit 接收完整 raw config，不是增量 patch**，适配器必须保留未知字段。

### 1.2 未闭合准入，不以推断补齐

- Client `Slots.listSubTree(settings.section)` 本轮返回：`Client inspect query Slots.listSubTree timed out after 10000ms. Open or reconnect the Harness page, then retry.` 未重试。正式分区注册有仓库先例，但跨分区导航 props/服务尚未核验；T0 是前端接线阻断门，禁止猜 URL、操作另一插件 DOM 或自造全局事件。
- Host 能证明本机 profile 编辑能力，**不能证明企业公共维护权限、集中版本或分发接口**。公共区字段编辑白名单当前为空；任何公共写请求 403、零调用 editor。AC-7 的拒绝分支可交付，维护能力仍未完成，不能整体报绿。
- 未发现可直接证明目标企业平台的通用自检命令。检查仅消费现有本地能力与经门禁的既有读动作；缺明确对象/平台证据保持 unknown。
- 本轮两个错误路径探查为 not found；另一次对安装包 asar 路径的 grep 返回 `Not a directory (os error 20)`。均未重试或绕过；宿主合同依据来自 Inspect 与可读 README，不依赖该失败搜索。

## 2. 数据模型、字段与存储

### 2.1 真源与作用域

| 对象 | 本页可写 | 真源、继承与限制 |
|---|---|---|
| IAM | 无 | `ctx.iam.getView()` 缓存视图；原 IAM 管理路由处理真实操作；不读取 grant/token/凭据草稿，不新增持久记录 |
| DevOps | dopBin、timeoutMs | 原配置 > 环境 > 发现/默认解析；调用既有 validator 和 discovery；保留隐藏 dopEndpoint/sourceType |
| Gitee | cliPath、timeoutMs | 自有 runtime-config 解析；继承 profile 下层及默认值；不发明 DevOps 式发现层；保留 host/authEnv/persistentToken 与未知键 |
| 公共参数 | 无 | 仅显示真实来源类别、可取得的版本、作用域；无法证明均为 unknown；不把本机 revision 称为公共版本 |

只落盘当前 profile 对应插件覆盖，复用 configEditor；无第二个配置文件、localStorage 身份缓存、诊断数据库。草稿和检查证据仅组件内存，卸载清空；本页不改 IAM 已有 onboarding/model 缓存键。

### 2.2 契约类型（下文新增接口统一使用）

- `ConfigSnapshot = { revision, inheritedRevision, effectiveRevision, writable:{ok,reason}, fields:{<允许键>:{value,origin,overridden}}, scope:'current-profile'|'unknown', publicSource:{name,version}, applied:{state,revision} }`。三个 revision 为不同命名空间的不透明安全标识；禁止携带路径或 endpoint。value 仅配置编辑端点存在。
- `ConfigMutation = {revision:string, inheritedRevision:string, fields:Record<string,string|number|null>}`。省略=不动，null=只移除这个键的本机覆盖；空串仍服从既有验证规则，不用作删除整段的别名。
- `SaveReceipt = {ok:boolean, saved:{state:'saved'|'unchanged'|'failed'|'unknown',revision:string|null}, applied:{state:'applied'|'failed'|'unknown',revision:string|null}, snapshot?:ConfigSnapshot, code?:string, errors?:Record<string,string>}`。失败状态不得靠 HTTP 200 或 ok 单字段推导。
- `PreparationView = {identity:{state,next}, credential:{state,next}, model:{state,next}, contextRevision:string, devops:SafeProviderView, gitee:SafeProviderView, publicConfig:{writable:false,reason,scope,source,version}, businessAuthorization:'not-provided'}`。白名单映射未知枚举为 unknown；不发主体、授权链接、模型列表、原错误或地址。
- `CheckRequest = {provider:'devops'|'gitee', effectiveRevision:string, contextRevision:string, target?:string}`。target 是既有读动作允许的对象，非 bin/argv/URL；不放入诊断复制内容。
- `CheckResult = {provider,state,reason,next,checkedAt,effectiveRevision,contextRevision,objectAlias,sourceType,layers:{file,start,target,read}}`。层值均为 `{state,reason}`，状态含 unchecked/checking/passed/failed/unknown/stale。不取得某层证据就 unknown；不能由 file 推导 start。

版本实现：继续兼容 DevOps 既有 revision；新增基准对 inherited 和 override 做稳定递归排序与类型保真摘要，未知嵌套键纳入冲突检测，不修改其内容。effectiveRevision 包括环境/发现结果的安全指纹及运行实例代次，不回传原输入。身份 contextRevision 由服务器随机密钥 HMAC 加本进程代次形成，使用 IAM 已有 `getModelAccessEpoch()` 及安全状态，客户端无法反推主体；进程或 provider 变化即失效。不得把裸 token/主体哈希作为公开标识。

## 3. API 与权限边界

新增路由使用既有 webServer Node 适配模式；所有读写先 `connection.requestRejection({headers:req.headers})`，仅严格 undefined 放行，缺服务、异常或异常返回一律拒绝且业务调用为零。自定义头不是认证。全响应 no-store、nosniff、无 CORS，错误使用固定原因码与固定下一步，不回显任意字段名/异常串。

| 路由 | 入参 | 返回/副作用 |
|---|---|---|
| GET `/api/forge-devops/preparation` | 无 | PreparationView；读取三个独立来源，一项不可用不拖垮其他项；不跑模型或 CLI |
| GET `/api/forge-devops/local-config` | 无 | DevOps 两键 ConfigSnapshot；新页不请求四键老快照后再隐藏敏感字段 |
| POST `/api/forge-devops/local-config` | ConfigMutation；`x-forge-devops-request:1` | SaveReceipt；仅两键；保存即真实重建，不提供虚构 apply 按钮 |
| POST `/api/forge-devops/preparation/check` | CheckRequest；同上自定义头 | CheckResult；只读/本地诊断，缺白名单或对象返回 unknown、不执行任意命令 |
| POST `/api/forge-devops/public-config` | 任意 | 403 PUBLIC_CONFIG_READ_ONLY；在解析字段前拒绝，零 editor/CLI 调用 |
| GET `/api/forge-gitee/local-config` | 无 | Gitee 两键 ConfigSnapshot；无自动发现按钮 |
| POST `/api/forge-gitee/local-config` | ConfigMutation；`x-forge-gitee-request:1` | 自有服务保存与 Loader 调和后回读，SaveReceipt |
| 原 `/api/forge-devops/cli` | 兼容原 revision/fields | 保留原调用方形状，成功追加 receipt；原刷新仍响应前完成发现→重建→快照 |

共用状态码：400 请求形状/多余顶层键，401/403 宿主拒绝，409 基准或条目变化，422 逐字段验证、零写入，413 超限，503 服务不可用；保存或应用回执不确定返回明确 unknown，不自动重放。请求体上限 64 KiB；只允许相应方法，其他 405。新 local-config 不允许隐藏字段；旧 CLI 端点不静默改变其四键兼容契约。

IAM 不新增登录/凭据/模型 HTTP。聚合层直接使用可选 ctx.iam，不在服务器内部 HTTP 回环，不调用 signIn/tokenFor/bridgeCapability。前端只通过 T0 核验的设置导航进入原 IAM；分区内滚动定位需由 IAM 自己提供，不跨 DOM 操作。若宿主无程序化跳转，保留文字路径但不得称“账号跳转 AC 已通过”，必须回报阻断。

## 4. 保存、应用与检查的实施关键点

### 4.1 一次写事务与回执

1. GET 读取唯一根条目与上下层、解析来源；路径仅编辑输入可见，不写 title、data-*、错误或总览。
2. POST 验证已知增量；进入 editor.edit 的 change 回调后，使用回调提供的 current/inherited **再次**核验双基准，并基于最新对象重建增量，禁止直接返回写前 built.next。冲突抛受控内部哨兵，翻译为 409。
3. 适配器返回完整 raw config，保留未知嵌套对象；删除覆盖键恢复继承时若 editor 会重新 pin 继承值，必须在真实 editor 夹具核验其回写语义，不能仅以最终值相等冒充恢复继承。无法证明目标 override 已移除则拒绝宣称完成。
4. editor fulfilment 表示其 Loader 调和结束，不代表业务读面可用。DevOps HTTP 和 service 统一走保存编排→syncFaces(rebuild)；Gitee 普通字段触发 Loader 重挂载后，重新从 ctx.get('gitee') 取服务，绝不回读旧闭包。服务替换/卸载过程中写响应丢失视为 unknown，重新 GET 核对，不重发 POST。
5. 写后分别核对目标覆盖、运行实例有效基准与读面状态；成功才标 saved/applied。重建失败清空自有失效面，禁止旧路径继续启动；保存成功应用失败保留两个回执。宿主回滚且可证明时 saved=failed，否则 unknown。
6. 旧入口与新入口共享同一服务、同一 editor 事务；写后任一入口再读一致。注释、兄弟行逐字节不变由真实 editor 临时 profile 夹具验证，不靠纯对象测试下结论。

### 4.2 只读检查与零泄漏

新 `preparation.mjs` 只编排，不直接 import child_process、不接收 argv。使用 DevOps 已有 cliStatus/现有读能力、Gitee describe/preflight/read；preflight 仅能贡献其实际证据，不能自动证明文件存在或目标平台。只有显式指定合法目标且相应现有读动作经策略准入才访问业务；无目标不自动选仓库、不读取工作区文件猜对象。Gitee host 当前只是诊断配置，实际 CLI 目标还取决于其自身配置；不得凭 host 或 gh 名称判定目标服务通过。

四层证据独立映射；企业目标证据不足时总体最多 unknown，即使本地启动成功。现有 CLI 输出不直接出网；原始 stdout/stderr 只在原适配器归一内部消费。既有 DevOps failure-face 保持单源；Gitee 新页只允许枚举原因与固定指引，不将 describe 的文件名直接放总览。复制诊断由安全字段正向构造，拒绝任意对象序列化。保持超时、1 MiB、shell:false、持久凭据策略、默认写门禁；IAM token 注入为零。工具层只复用既有读工具，不新建能从模型修改配置/权限的旁路；新增设置保存仍是经过宿主 owner 认证的配置管理操作，不代表企业授权。

### 4.3 并发与状态管理

React 局部 reducer，无全局身份 store。每插件独立 `{snapshot,draft,dirty,saveReceipt,check,requestSeq}`；只读 IAM 摘要另一路，失败不把其他表单归零。请求捕获 `(mountEpoch,requestSeq,effectiveRevision,contextRevision)`，回包四项全匹配才采纳；AbortController 只是资源取消，不替代基准比较。

进入页、从 IAM 返回、窗口重新获得焦点、每次检查前重读安全摘要；检查完成前服务器再核验 IAM 代次与配置基准，变化返回 stale。页面当前不可证明身份未变化时不保留绿色当前检查，标 stale/正在核对；不新增高频轮询。配置保存、发现、身份变化立即让相关检查过期。没有现成可信身份事件可用时，不假称实时全局同步，T0 必须明确可观察失效边界。

## 5. 前端组件与文件归属

在 [DevOps Client](<../../../packages/forge-devops/client.js>) 内增加 `EnterprisePreparationPanel(props)`，不引入动态 import 的第二套构建链。内部拆分 `PreparationOverview`、`LocalConfigSection`、`OperationReceipt`、`CheckDetails`、`PublicConfigSection` 纯组件；旧 `CliPanel` 继续存在。两个分区使用同一 Host 接口而非复制解析器。新增 section id=`forge-enterprise-preparation`，建议 order=29，原 IAM=30 不动；注册前 T0 核验实际 Slots 合同。

采用设计 §0 的尺寸/theme token/响应式，不复制 IAM 表单。新组件字符串走原 locale 命名空间，保持中英文状态语义对应。原生 details/button/label，分插件 aria-live、aria-busy、错误聚焦；320/564px、200%缩放、深浅主题及 reduced-motion 在 QA 阶段验收。只读 public 区无可编辑字段；未知来源不画空白可保存表单。导航有脏草稿先确认，默认不丢弃；卸载清理请求和监听。

## 6. 实施任务与并行图

没有预派发任务。本表是唯一任务拆分；机器蓝图沿用相同任务名及所有权。所有任务保留 feat/plugin-workflow，不切主工作区、不新分支、不动原 Demo/版本检查器改动、不取消其他流水线、不改日常 profile、不推送/合并/发布、不做双端；提交未经本轮单独授权不执行。文档仅在本任务夹和 docs/teamflow 约定区域写，不改 AGENTS。下表文件是修改所有权，reads 不占锁；同文件发现并行修改即暂停。

| 任务 | 修改所有权 | 依赖与验收 |
|---|---|---|
| T0 接线准入与证据 | 本任务夹 `INTEGRATION-NOTES.md` | 实施前用连接的独立 profile 核验 Slots 注册/导航/身份失效、editor 移除覆盖及注释保留、Gitee 重挂载；记录当前宿主版本与来源。公共维护仍无权则明确 AC-7 未完成，禁止造管理开关；前端导航不可核验则阻断接线 |
| T1 DevOps 事务及路由统一 | `packages/forge-devops/src/cli-access.mjs`、`src/http.mjs`、`src/index.mjs`、`test/cli-access.test.mjs`、`test/cli-http.test.mjs`、`test/flow.test.mjs` | T0 后；回调内 CAS、未知嵌套保留、恢复继承、原 HTTP/服务重建同源、应用回执及认证；原刷新保证不退化 |
| T2 Gitee 自有配置面 | `packages/forge-gitee/src/settings.mjs`、`src/index.mjs`、`test/settings.test.mjs`、`test/host-contract.test.mjs` | T0 后，可与 T1 并行；仅两键，复用五键校验，root profile 编辑与重挂载后回读；保留现有 read/execute/preflight 签名与全部工具 |
| T3 安全准备编排 | `packages/forge-devops/src/preparation.mjs`、`test/preparation.test.mjs` | 可与 T1/T2 并行按合同开发，集成依赖两者；IAM 白名单状态投影、双基准检查、四层证据、零写/零 token、迟到拒收及复制白名单 |
| T4 正式 UI | `packages/forge-devops/client.js`、`test/preparation-client.test.mjs`、`test/client-shape.test.mjs`、`test/client-rule-parity.test.mjs` | T0 后按 API 可并行开发；联调依赖 T1～3；双入口有效、分插件草稿、三回执、未知与 stale、账号导航、主题与无障碍 |
| T5 交付自检 | `tests/enterprise-preparation.test.mjs`、`.gitignore`、本任务夹 `USAGE.md`、`DELIVERY-NOTES.md` | T1～4 后；修复自己发现的问题，跨所有权修复串行交回原 owner；只记录结论，不写 QA-REPORT/ACCEPTANCE，不预跑 QA 全矩阵。审计真实独立 profile/构建路径并补精确忽略，原有文件不得被泛化忽略 |

接口装配顺序：配置事务→provider 服务→prepare 编排→HTTP 适配→Client。T1 负责唯一跨模块装配，把 T3 工厂接入 index 并注入 HTTP；T3 不修改 index，避免并行争用。T2 提供 `gitee.settingsSnapshot()`/`gitee.saveSettings()`；跨包仅 ctx 服务，不新增 DevOps→Gitee 源码依赖。IAM 源码不修改，其缓存 view 不是即时撤权授权证明。

## 7. 测试策略与交付门禁

| 层 | 断言与 AC |
|---|---|
| 事务单元 | 两个插件 set/null/无变化/非法零写、双基准冲突、回调内二次竞争、未知深层键及兄弟行、注释逐字保留；AC-4～8 |
| 接口契约 | 无 Connection/异常/401/403、缺头、超限、未知字段、方法错误、public POST 403；旧 CLI 向后兼容且 HTTP 真重建；AC-6～9、12 |
| 编排及状态 | 四个独立反例、IAM 七态及退出未知、identity/provider 替换、配置/检查交错、ABA/迟到/卸载、saved成功 applied失败、旧服务不可用；AC-1～3、8～10 |
| 安全反例 | EINVAL/ENOENT/EACCES、相对 bin、绝对路径/UNC/URI，扫描汇总/错误/复制/工具/日志；IAM token 注入=0、业务写=0、未经准入读=0；AC-11～12 |
| Client 行为 | 真 Client 源码模拟渲染，不另造 Demo；脏草稿不丢、逐项错误、来源未知、禁用原因、回包代次、旧入口有效；AC-13 |
| 交付 | 包体不含 profile/凭据/缓存/日志；独立 profile 安装与回滚步骤，标明安装管理操作需要当次授权；AC-14～15 |

开发交付自检执行 `node --test packages/forge-devops/test/ packages/forge-gitee/test/ packages/forge-iam/test/`、`pnpm check`、`git diff --check`；记录真实结果，包括既有失败和 skip，不删除或放宽规则。全量通过不得替代真实浏览器。独立 profile 浏览器由后续 QA 验证账号导航、保存/应用/检查差异、未知恢复及恢复继承；不改日常 profile、不输入真实 Key、不调用收费模型。跨浏览器/真实企业/双端不在开发自检中预跑；用户本轮禁止双端，统一 NOT RUN。

证据每项写操作/命令、时间、当前 Node/pnpm/宿主版本、目标别名、来源类型（源码/fixture/独立 profile UI/真实企业）。当前技术阶段仅阅读与 Inspect，未运行实现测试、未安装、未改 profile、未提交/推送，公共维护及浏览器导航未闭合。历史 2726 项结果不继承为本轮结论。发现相同环境错误不反复重试或换命令绕过。

回滚设计：仅在获准的独立 profile 使用保存前的安全备份恢复目标条目，保留兄弟行；未知写结果先 GET 核对不补偿重放；卸载 UI 不删除 IAM、Key 或 onboarding。回滚命令须在 T5 依据实际安装方式核验后写入使用说明，不能用猜测的 profile CLI 语法充数。

## 8. 完成判定与剩余风险

本技术方案交付不等于需求验收。AC-1～6、8～15 依赖实现与证据；AC-7 公共维护能力因缺真实授权/接口仍是明确阻断。不能用“只读设计完成”替代维护功能。导航、身份跨入口失效和恢复继承在 T0 未证明前不得启动相应上线声明。当前分支与原有改动已盘点保留，不操作其他流水线；不扩大 IAM 安全存储、生产授权、CLI 目标配置或集中分发范围。
