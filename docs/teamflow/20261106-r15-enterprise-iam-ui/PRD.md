<!-- meta: summary="把已确认的 IAM 唯一身份 + 企业研发准备设置整合推进到可被宿主真实装入的可交付插件：界面只读汇总真实状态、本机差异可增量保存、诊断可证且脱敏，并以独立 profile 真装/GUI 可见/可回滚作为验收硬条件。" -->
基线依赖：docs/teamflow/20261029-r4-forge-gitee、docs/teamflow/20261030-r5-devops-config-slimming、docs/teamflow/20261102-r9-runner-refresh-uninstall（配置增量保存与来源解析、失败面脱敏、`?refresh=1` 响应前重建、精确卸载与默认拒绝行为不得回退）；docs/teamflow/20261106-r14-enterprise-iam-ui（同主题设计输入：唯一身份、配置分层、脱敏与只读检查结论沿用，但该夹 AC-14/15 未闭合，本轮重新定义可验收口径）
取代：docs/teamflow/20261106-r14-enterprise-iam-ui#AC-15：交付口径从“给出安装与回滚步骤”改为“主 agent 在独立 profile 真装、宿主启动日志出现该插件、设置页真实可见，失败即回滚”
取代：docs/teamflow/20261106-r14-enterprise-iam-ui#AC-14：验证口径改为同一轮内以真实装载的独立 profile 完成界面走查，且两项宿主组合探针失败必须给出文件:行级根因或环境判定，不得标全绿

# 企业研发设置与 IAM 正式 UI 整合（可装载交付）

> Agent 代拟。需求范围与结合方向依据本轮用户澄清及[结合核验记录](<../../../demos/enterprise-settings/verification/README.md>)；真实企业接口、生产准入与最终验收仍待验证。本文件只细化本任务，不替代[产品范围唯一真源](<../../requirements/requirements-baseline.md#2-范围边界唯一真源>)。

## 1. 背景与目标

企业研发环境准备不应是又一个模拟账号体验，也不应停留在“设计完整、装不进宿主”。正式 IAM 已承担唯一企业账号入口、登录/退出、onboarding、个人网关凭据与模型设置；企业研发设置要回答四件事：公共参数来自哪里、本机哪里不同、DevOps/Gitee 检查到哪一步、下一步做什么。身份已登录、Key 已配置、本机工具可用、业务获权是四件不同的事，任何一项都不能推导其余三项。

本轮目标不是重写方案，而是把 r14 已确认的结合方案推进到可交付状态：**交付物必须能被宿主以 profile 包形态真实装入并加载，设置页里真的出现该分区**；在此基础上实现只读状态汇总、本机差异增量保存、保存/应用/检查三态可辨、诊断可证且零泄漏。技术正确但装不上、看不见，本轮即判失败。

### 1.1 上一轮同主题进展与未闭合项（2026-11-06）

r14 夹已产出 PRD/DESIGN/TECHNICAL/QA-REPORT/ACCEPTANCE。其验收记录结论：AC-14 阻断（`pnpm check` 退出码 1，两项宿主组合探针报 `Cannot read properties of undefined (reading '0')`；独立 profile 浏览器验证未执行），AC-15 阻断（独立 profile 安装/回滚、正式使用说明、索引未交付）。全程未安装插件、未改日常 profile、未提交推送。本轮沿用其设计结论，但把“装得进、看得见、验得了”写成 P0 验收条件，不再以“步骤已写在文档里”代替执行。

### 1.2 本轮现状自查（2026-11-06，只读核验）

- 本机：`DSH_HOME=<profile 根目录>`，日常 profile 为 `desktop`；`dsh` 在 PATH（`dsh --help`：`dsh [--profile] <name>` 启动、`dsh plugin --profile <name> <pnpm-args>` 管理插件，转发到 profile 目录的 pnpm）；`desktop` 的 `dsh.profile.bundles` 共 18 项，**不含任何 `@heluo/*`**，即日常 profile 尚未装过本仓插件。安装发生在工作区之外，流水线子代理权限被钉死在会话工作区，**只能由主 agent 执行**。
- 仓库已有正确挂载样本：[forge-devops client](<../../../packages/forge-devops/client.js>) `:1000-1013` 使用两段式 `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'devops', order: 60, ... }))`；[forge-iam client](<../../../packages/forge-iam/client.js>) `:4031-4047` 同法注册 `settings.launcher` / `settings.section` / `shell.overlay`。`register.name` 必须是槽位名本身，插件标识放 `id`。
- [forge-gitee 清单](<../../../packages/forge-gitee/package.json>) 当前无 `client.js`、无 `dsh.client`、`files` 不含客户端产物 → Gitee 的本机差异配置页若要做，必须新增 client 半；`packages/*/package.json` 目前**全部没有** `peerDependencies`；两个 client 通过 `window.__ModuleLoader__.load({ id, factory(require) })` 与 `require('react')` 取宿主模块。
- [forge-enterprise](<../../../packages/forge-enterprise/package.json>) 是默认安装单元（企业组合包，无 client 半）；[构建脚本](<../../../scripts/build-enterprise-bundle.mjs>) 在构建期闭包 workspace 依赖（ADR-12/#37），产物为 `artifacts/tarballs/*.tgz`，源码清单保留 `workspace:*` 是仓库约定。
- 证据界限：[Demo](<../../../demos/enterprise-settings/README.md>) 的三账号、维护者开关、公共版本计数与“应用清空个人连接”均为内存 fixture，不得进入正式实现；[核验记录](<../../../demos/enterprise-settings/verification/README.md>) 的历史 `2726/2723/2/1` 只作对照，本轮必须复跑并给真实数字；旧记录中的宿主版本不得当作当前环境版本。
- 工作区：分支 `feat/plugin-workflow`，HEAD `0db3c65`（已同步 main `a1d7263`）；未提交改动包含原 Demo、版本检查器修正与探查脚本（见 §7.1），必须原样保留。

## 2. 用户故事与验收标准

AC 编号仅在本任务夹内有效。P0 项未达成即不可验收。

### 故事 A：研发人员只管理一个企业身份

| 编号 | 优先级 | 可测试验收标准 |
|---|---|---|
| AC-1 | P0 | 新分区只展示 IAM 非敏感状态摘要，并提供到既有企业账号入口的导航；登录/退出/onboarding/个人网关凭据/模型设置全部复用现有 IAM 实现（不新增第二套路由与状态存储）。新增身份/凭据存储写入点 0；三个 Demo 模拟登录标识在正式包源码与产物中命中 0；取消、退出、未知、安全拒绝沿用 IAM 既有语义。 |
| AC-2 | P0 | 四组反例各有独立呈现且互不推导：①IAM 已登录但 CLI 未配置；②CLI 可读但 IAM 未登录；③Key 已配置但未验证；④检查通过但写门禁关闭。逐组断言：改变其中一项不影响其余三项判定；汇总固定包含“不代表业务授权”；真实企业联调字段保持 unknown/NOT RUN，界面与文档不得出现“企业联调已通过”类结论。 |
| AC-3 | P0 | 身份状态覆盖未登录/登录中/已登录/过期/不可达/退出未知六态并各有下一步；未知不得渲染成“未配置”，也不得清空既有记录；用例“旧 session 响应延迟到退出之后返回”断言最终 `signed-out`、模型目录为空、准备汇总不恢复旧绿灯；IAM 不可达时本机配置区仍可读，且不触发 IAM 写请求。 |

### 故事 B：研发人员只处理本机差异

| 编号 | 优先级 | 可测试验收标准 |
|---|---|---|
| AC-4 | P0 | 汇总按“公共参数来源名与版本标识 / 本机覆盖 / 最终生效来源”三层展示；任一来源或版本取不到时显示“未知”并给出阻塞原因，不得以默认值冒充。字段映射只取自现有定义（DevOps `dopBin/timeoutMs/dopEndpoint/sourceType`；Gitee `cliPath/host/timeoutMs/authEnv/persistentToken`；IAM 既有非敏感摘要），不引入 Demo 的地址校验与版本计数规则。普通流程不要求重复填写已预置公共参数（已预置字段只读或预填）。 |
| AC-5 | P0 | 本机差异只覆盖既有非敏感入口与超时；自动发现、手动覆盖、恢复继承三项分别写明作用对象与生效时机；凭据值不出现在 DOM 文本、URL、`data-*`、网络请求体与日志（断言扫描 0 命中）；`authEnv` 最多显示允许的变量名列表，`persistentToken` 策略不因整合放宽；修改 DevOps 后 Gitee 与 IAM 配置字节不变，反之亦然。 |
| AC-6 | P0 | 保存只提交用户实际修改过的已知字段增量；夹具含隐藏键、未知嵌套键、兄弟插件条目与注释，保存后这些字节逐字不变；恢复继承只删除对应本机覆盖键，不删整段；非法值返回逐字段原因且写入 0 次；基于过期 revision 的保存返回冲突、editor 调用 0 次、文件哈希不变（不产生半写）。 |

### 故事 C：维护者看不到企业化错觉

| 编号 | 优先级 | 可测试验收标准 |
|---|---|---|
| AC-7 | P0 | 公共参数区接入真实配置读写与权限校验：无可核验维护权限时整区只读并显示原因；直接请求写接口返回 403、editor 调用 0 次、文件哈希不变；不得用 Demo 的“维护者”开关或前端隐藏元素充当授权；单机 profile 保存不得表述为“已向企业分发/已下发”（文案断言 0 命中）。 |

### 故事 D：保存、应用、检查各不相同

| 编号 | 优先级 | 可测试验收标准 |
|---|---|---|
| AC-8 | P0 | 三个动作的文案与数据独立：保存成功不置应用成功、应用成功不置检查通过（三组交错用例各断言另外两项仍为“未执行”）；既有接口若保存即重建，则明确显示“已应用”而不伪造待应用草稿；应用失败/未知保留保存基准与生效基准可核对，不自动重放；运行检查不写配置（保存调用 0 次）；公共参数更新不清空 IAM 会话、个人 Key 与 onboarding 标记（夹具前后逐项断言）。 |
| AC-9 | P0 | 保存/应用或身份上下文变化后，先前检查结果标记“已过期”且保留其基准；每条结果关联配置基准、检查时间、检查对象与来源类型；迟到的旧检查结果不得覆盖当前状态（用例：旧请求后到，界面仍显示新基准）；DevOps `?refresh=1` 保持响应前完成发现与读面重建（沿用 r9，不新增第二次发现）；应用后下一次工具调用或读取与本页生效状态一致；重建失败显示降级与原因，不留半重建。 |

### 故事 E：能据证排错而不泄密

| 编号 | 优先级 | 可测试验收标准 |
|---|---|---|
| AC-10 | P0 | DevOps 与 Gitee 分项显示 未检查/检查中/通过/失败/未知/已过期 与下一步；子原因区分未配置、不可执行、目标不可达、只读访问被拒；文件存在、可启动、目标服务可识别、只读业务可访问分别按实际证据显示；无目标平台证据时不得仅凭 CLI 名（gh/dop）判为企业就绪；没有已批准的只读探测命令的项目保持未知，不临时发明命令，不执行写探测。 |
| AC-11 | P0 | 主动检查只调用既有白名单只读/本地诊断能力；拒绝与成功两套夹具均断言业务写调用 0（建 Issue、评论、push、merge、close、发布、流水线触发）、策略写动作执行 0、IAM token 注入 CLI 次数 0；唯一 `execFile` 出口、超时上限、1MiB 输出上限不放宽（源码断言 `src` 零 `spawn`/`exec`/`shell:true`）。 |
| AC-12 | P0 | 汇总、工具结果、错误、复制诊断、日志、报告六个出口均不含令牌、Key、授权 URL、原始 CLI 错误与本机绝对路径；沿用 r9 六类注入（EINVAL/ENOENT/EACCES、相对路径 bin、绝对路径与 UNC、URI）全文扫描零命中；路径与 endpoint 仅在配置编辑控件值内可见，不进入 `data-*` 与请求体。 |

### 故事 F：交付物是能被宿主装载的插件

| 编号 | 优先级 | 可测试验收标准 |
|---|---|---|
| AC-13 | P1 | 入口位于既有设置壳（`settings.section`），不以独立网页或 Demo 入口交付；新分区 `id` 与 `order` 固定并在技术阶段记录；键盘可达全部操作，异步状态经 aria-live 播报；中英文键语义一致；旧“设置 → 企业 DevOps”入口保持可用，不出现死链，不出现第二套身份入口。 |
| AC-14 | P0 | 宿主半加载入口：承载包目录下存在 `cordis.patch.yml` 且 `dsh.bundle.patch` 指向它，该文件列入 `files`；`insert:` 行 `name` 与 `package.json#name` 逐字相同（`@heluo/forge-devops`，Gitee 若新增 UI 则为 `@heluo/forge-gitee`），不得写子路径；`dsh --profile <独立> --dump-config` 中该条目出现，且启动日志无 `entry not found`、无 `did not activate`。 |
| AC-15 | P0 | client 半：`package.json#dsh.client` 的字段集合与同仓样本 [forge-devops 清单](<../../../packages/forge-devops/package.json>) 逐字段一致（`platform`/`immediately`/`inject` 等键名集合一致，`inject` 列表可按实际模块不同）；交付的 client 产物非空且含本包 id 特征串；Gitee 的 UI 必须由 Gitee 自己的 client 半承载，不得跨包导入源码或仅由 DevOps 分区代管。 |
| AC-16 | P0 | UI 挂载点写法必须是 `ctx.slots.inject('<slot>', () => ctx.slots.register({ name: '<同一 slot 字串>', id: '<本插件标识>', order: N }, Component))`：`inject` 参数与 `register.name` 逐字相同且取自宿主槽位名（本轮为 `settings.section`），插件自身标识只放 `id`。端到端判据：装进独立 profile 并启动宿主后，设置页真实出现该分区（截图或 aria 快照为证）；单测、静态检查通过不能替代该证据。 |
| AC-17 | P0 | 分发闭包：`files` 数组覆盖 `main` 入口、client 产物、`cordis.patch.yml`、locale 与 README；`npm pack --dry-run --json` 实测每个声明项进包，`test/`、`coverage/`、`node_modules/`、`*.test.mjs` 不进包。安装单元（`build-enterprise-bundle` 产物及 tarball 内 `package.json`）全文 `grep workspace:` 零命中（源码清单的 `workspace:*` 由构建期闭包，属 ADR-12/#37 约定，不要求源码放弃）；装进独立 profile 时 pnpm 不报本地协议错误。 |
| AC-18 | P0 | 宿主运行期依赖：产物若通过 `require('react')` 或 `@deepseek-ai/*` 取宿主模块，须在 `peerDependencies` + `peerDependenciesMeta.optional` 声明，或给出“宿主模块表不要求声明”的实测依据（写明宿主版本与来源）；不得把宿主模块写成普通 `dependencies`。装载安全：宿主入口与 client 产物各做一次模块加载检查（ESM 用 `node --input-type=module -e "await import('<路径>')"`，client 产物按其实际加载方式检查），退出码 0、顶层不抛错；宿主入口依赖注入时以宿主内启动日志无异常为补充证据。 |
| AC-19 | P0 | 独立 profile 真装与回滚：由主 agent 按 §7.3 在独立 profile（默认 `heluo-r15-uat`）执行 `dsh plugin --profile <独立> add <tarball>`，exit 0；`--dump-config` 与启动日志确认条目存在且激活；GUI 设置页可见分区（AC-16）。操作前后日常 profile `desktop` 的 `package.json` 与补丁层哈希不变。失败立即按 §7.4 回滚并记录命令与结果。未执行、或 GUI 不可达又无等价证据时标 NOT RUN，不得以“步骤已写进文档”代替。 |
| AC-20 | P0 | 回归与既有失败如实：复跑 `pnpm check`、`git diff --check`（推送前另跑 `node scripts/sensitive-scan/verify.mjs`）并记录真实数字；用例数不少于本轮起点（当前对照 2726 项），不删测、不 skip、不放宽断言。两项宿主组合探针（[tests/host-probe.test.mjs](<../../../tests/host-probe.test.mjs>)，经 [run-host-probe.mjs](<../../../scripts/probe/run-host-probe.mjs>) 执行）若仍报 `Cannot read properties of undefined (reading '0')`，必须定位到文件:行与输入形状，并判定为“探针缺陷（先补失败用例再修）”或“宿主版本差异（记 unknown、保留失败）”；不得改写断言绕过，不得声称全绿。证据表逐条含命令/操作、时间、宿主版本、目标与来源类型（源码/fixture/独立 profile UI/真实企业）。 |
| AC-21 | P1 | 交付说明与包体卫生：包 README（或本任务夹 USAGE）写正式使用说明与安装/回滚；受影响设计索引与 README 状态同步；包体与工作区不含 profile、凭据、缓存、日志、测试 profile；`.gitignore` 审计覆盖 `artifacts/tarballs/`、`logs/`、构建临时目录；如实报告未推送、未改日常 profile、未做双端、源码提交状态。 |

## 3. 范围与非目标

范围：设置壳内的“企业研发”准备分区（状态汇总、本机差异、诊断分项、公共参数只读视图）；DevOps/Gitee 既有配置面的接线与增量保存；承载 UI 的包的宿主半与 client 半交付形态；独立 profile 安装、启动、回滚与证据。

非目标：不新建身份系统、凭据存储、企业集中分发或管理后台；不放开真实写权限，不自动向 CLI 注入 IAM token；不替换 IAM 现有页面，不迁移其状态；不做双端（Windows/麒麟 aarch64）验证；不接真实企业 IAM 网关与生产 Keychain；不把 Demo 的三个模拟登录、维护者开关、内存版本计数搬进正式实现；不做移动端与视觉改版。

## 4. 反面目标 / anti-goals

以下任一项发生，即使测试全绿也应拒收：

1. **装上了但看不见**：`dsh plugin add` 成功、单测与 tarball 审计全绿，用户打开设置却找不到“企业研发”分区（AC-16、AC-19）。
2. **假绿灯**：首屏显示“准备就绪”，展开后各项却是“未检查/未知”，用户据此以为已可写企业业务（AC-2、AC-8、AC-10）。
3. **保存了却没生效**：点“保存”提示成功，重启后仍是旧值；或保存把未知键、兄弟插件条目、注释清掉（AC-6、AC-8、AC-9）。
4. **诊断即泄密**：复制一份诊断给同事，里面带本机绝对路径、endpoint 或凭据（AC-12）。
5. **装上后宿主起不来**：启动即崩，用户只能另开 agent 手工删 profile 才能恢复（AC-18、AC-19）。

## 5. 交互流程摘要

1. 用户从设置进入“企业研发”：首屏是按故事 A/B/E 组织的状态摘要（身份、公共参数来源、本机差异要点、DevOps/Gitee 分项、阻塞与下一步），细节按需展开。
2. 需要账号操作时跳到既有 IAM 入口，返回后准备区按新身份上下文刷新并作废旧检查。
3. 修正本机入口 → 保存（只说保存结果）→ 若接口即重建则显示“已应用” → 主动检查（只读）→ 结果带基准与时间；基准变化后旧结果显示“已过期”。
4. 排错时查看分项证据与下一步；复制诊断只含结构化摘要，不含路径与凭据。

## 6. 优先级

P0：AC-1～12、14～20（唯一身份、状态真实、配置可写可留、诊断脱敏、可装载与回滚、回归如实）。P1：AC-13、AC-21（入口可用性与交付说明）。不设装饰性 P2。

## 7. 工程约束（原样执行，不得静默改写）

### 7.1 分支、基线与未提交改动

- 分支：沿用当前工作区分支 `feat/plugin-workflow`（已同步 main `a1d7263`，本地文档提交 `0db3c65`）；**不切换**到主工作区 `docs/devops-stage-handoff`，不新开分支，不改工作区路径。
- 保留既有未提交改动，不得删除、覆盖或顺带提交：`demos/`（原 Demo 全部）；`scripts/lib/dsh-version.mjs` 与 `tests/dsh-version.test.mjs`（版本检查器修正）；`scripts/probe/iam-review-memory-credentials.mjs`（临时装配，仅用于复现未配置/安全拒绝，不装日常 profile）。本轮实现与这些改动并存，冲突时暂停并核实来源，不使用 `git reset --hard` / `git checkout --` 清除他人改动。
- 提交与推送：推送明确禁止；本地提交须经当次单独授权，未授权不提交，报告如实写“已改未提交”。

### 7.2 验证环境与边界

- 一律使用**独立 profile** 验证，不改日常 profile `desktop`（操作前后比对其 `package.json` 与补丁层哈希不变）。
- 用户本轮明确不做双端验证；Windows、麒麟 aarch64、真实企业 Gitee CLI、真实 Keychain/生产凭据、真实 IAM 网关一律 NOT RUN，不以 Mock 结果替代。
- 版本控制卫生：审计根 `.gitignore`，针对本工程真实工具链补齐 `artifacts/`（含 `artifacts/tarballs/*.tgz`）、`logs/`、构建临时目录、profile 备份/导出目录；不得用泛化忽略掩盖源码、Demo、测试与设计文档。

### 7.3 安装（由主 agent 执行；子代理无法写工作区之外）

1. 构建安装单元：`node scripts/build-enterprise-bundle.mjs`（默认企业组合包）与承载 UI 的包（`@heluo/forge-devops`，Gitee 若新增 client 则为 `@heluo/forge-gitee`）各自的闭包产物；记录 tarball 路径、版本、字节数与包内文件清单。禁止手工改 tarball。
2. 装入独立 profile（首次使用自动初始化）：`dsh plugin --profile heluo-r15-uat add ./artifacts/tarballs/<pkg>-<version>.tgz`（相对路径，不加 `file:`），期望 exit 0；随后 `dsh --profile heluo-r15-uat --dump-config | grep -A2 "id: heluo-"` 确认条目存在。
3. 启动并检查：`dsh --profile heluo-r15-uat`（app 参数以 `dsh web --help` 实测为准，端口避开日常实例 58260）→ 启动日志出现该插件、无 `entry not found`/`did not activate`；设置页真实出现“企业研发”分区。

### 7.4 回滚（装之前先可读；失败立即执行）

1. `dsh plugin --profile heluo-r15-uat remove @heluo/forge-devops`（包名从产物 `package.json` 读，不写死；Gitee 同理逐包 remove）。
2. 清理补丁层残留：`node scripts/uninstall-devops.mjs --profile heluo-r15-uat`（只删本插件写入的条目，其余逐字保留）；若该命令不覆盖新增条目，则按精确 `id` 手工删除并回显删除区间。
3. 终极恢复：独立 profile 为一次性环境，可直接删除 `$DSH_HOME/profiles/heluo-r15-uat`；日常 profile `desktop` 不在操作范围。回滚命令与结果写入交付说明。

## 8. 依赖与风险

- 依赖：IAM 非敏感视图与既有页面、DevOps/Gitee 真实配置入口（`configEditor.configuration()` / `edit(entry, change)`）、宿主设置槽位与 `window.__ModuleLoader__` 合同、既有只读命令白名单、独立 profile 启动能力。设计/技术阶段按运行时实际接口核验，不把 Inspect 观察方法当业务服务调用。
- 风险 1：公共参数的真实维护接口与权限尚未取得（r14 核验仅证明当前 profile 的编辑能力），AC-7 可能只能交付拒绝分支 → 明确标 unknown，不造管理开关。
- 风险 2：独立 profile 与桌面日常实例的 GUI 并存可能受端口/单实例限制 → GUI 不可达时 AC-16/19 标 NOT RUN 并给出启动日志/HTTP 探针证据，不伪造可见性。
- 风险 3：Gitee 新增 client 半需同步 bundle 字段、`files`、产物与宿主扫描 → 交付形态 AC 必须对每个承载包逐一验证，不能只验 DevOps。
- 风险 4：两项宿主组合探针失败可能属本仓探针脚本在 DSH 0.2.1-rc.5 上的输出形状问题 → 先定位再决定修或记环境阻塞，禁止调断言。
- 风险 5：`workspace:*` 与“安装清单零本地协议”的张力 → 以构建期闭包产物为准，源码约定不动。

## 9. 里程碑建议

1. **M1 装载骨架打通**（AC-14～19）：补丁入口、client 声明、slot 名、files/tarball 审计、独立 profile 空分区真装可见 + 回滚跑通。先打通这一层，避免 UI 做完才发现装不上。
2. **M2 只读准备汇总**（AC-1～4、AC-10 只读部分）：唯一身份导航、状态机、公共参数来源三层、分项诊断骨架。
3. **M3 配置写入与三态**（AC-5、6、8、9）：本机差异、增量保存、恢复继承、保存/应用/检查差异、过期与重建。
4. **M4 公共维护拒绝面、脱敏、浏览器走查与全量回归**（AC-7、11、12、13、20、21）：六出口扫描、六类注入、独立 profile 走查、既有失败定位、证据表与交付说明。

## 10. 假设与待澄清

- **事实：公共参数的作用域与维护授权来源。** 现有能力只证明“当前 profile 可编辑”，没有企业集中分发接口；Demo 的维护者视角不是真实权限。推荐默认：公共区只读并显示来源与阻塞原因，本机可维护部分照常，AC-7 只交付拒绝分支并标 unknown。若用户要求企业级集中分发或新管理角色，需另立范围并调整 AC-4、7、8 与 M2。
- **事实：独立 profile 的 Web GUI 能否与本机日常实例并存。** 单实例/端口策略未核验。推荐默认：独立 profile 用 `dsh --profile heluo-r15-uat` 启动，以启动日志 + `--dump-config` + HTTP 探测为证据；GUI 不可达则 AC-16/19 标 NOT RUN，不用日志替代可见性。
- **事实：两项宿主组合探针失败的归属。** 需定位到文件:行；属本仓探针缺陷则先补失败用例再修，属宿主版本差异则保留失败并记 unknown。推荐默认即此顺序，不先改断言。
- **口味：正式入口的信息架构。** 推荐默认：在设置壳新增“企业研发”分区（`settings.section`，order 29），保留旧“企业 DevOps”页与 IAM 账号页不动；理由是聚合准备状态又不打断现有操作习惯，单分区失败可回滚。若用户希望并入 IAM 或直接替换旧页，需调整 AC-13 与导航验收。
- **口味：首屏信息密度。** 推荐默认：首屏只显示分项状态、阻塞原因、下一步与来源/版本摘要，参数与原始技术细节按需展开；理由是避免把普通研发页做成维护控制台。若希望全量表格常显，调整 AC-4、10、13 的布局验证，不动脱敏与授权边界。
- **口味：独立验证 profile 的命名与留存。** 推荐默认：一次性 `heluo-r15-uat`，验证后删除并保留回滚指令，避免第二个长期 profile 漂移。若用户希望常驻 `heluo-uat` 作为日常联调环境，需补清理与升级约定。
