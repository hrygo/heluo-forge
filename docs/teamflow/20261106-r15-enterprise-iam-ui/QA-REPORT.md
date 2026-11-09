# QA 报告：r15 企业研发设置与 IAM 正式 UI 整合

| 项 | 值 |
|---|---|
| 轮次 | r15（企业研发设置与 IAM 正式 UI 整合） |
| 日期 | 2026-11-06 |
| 分支 / 提交 | `feat/plugin-workflow` @ `0db3c65`（未提交、未推送） |
| 工作区 | 会话工作区（clutch worktree `wt_622dc4710a35`） |
| 环境 | macOS Darwin arm64、Node v24.13.0、DSH `0.2.1-rc.5` |
| 输入 | `PRD.md`（AC-1～21）、`DESIGN.md`、`TECHNICAL.md`、dev 交付说明 |
| 结论 | **不通过（打回研发）**：1 个 P0、1 个 P1、2 个 P2 缺陷；可装载层静态与独立 profile 安装成立，GUI 走查 NOT RUN |

## 1. 结论与判定口径

本轮 P0 验收集中在「装得上、看得见、状态真、配置不丢、诊断不泄密」。实测结论：

- **可装载层基本成立**：两包 `cordis.patch.yml`、`dsh.bundle.patch`、`files`、`insert.name`、两段式 `settings.section` 挂载、peer 声明、tarball 闭包与 `workspace:` 清理均通过；独立 profile `heluo-r15-uat` 真装 `dsh plugin add` exit 0，`--dump-config` 出现两个条目。
- **GUI 可见性未取得证据**：独立 profile 启动 `dsh web` 时进程停在打开 `~/.dsh/.credentials.yaml` 之后，日志 0 字节、无监听端口（非交互子代理无法完成凭据交互）。按 PRD AC-16/19 口径标 **NOT RUN**，不以单测替代。
- **「企业研发」分区交付不完整**：`ReadinessSection`（`packages/forge-devops/client.js:787`）没有 AC-1 要求的「前往企业账号」导航，没有 AC-2 第③组「Key 已配置但未验证」的独立呈现，也没有 AC-3 六态各自的「下一步」；且该组件除注册断言外**零渲染/交互用例**（TECHNICAL §293 自己列出的六行汇总、四组反例、迟到回包、固定声明四项断言均未落地）。这是本轮的核心 P0 缺陷。
- **交付门禁红**：`pnpm check` 在第一步 `check-docs` 退出 1，共 14 条错误，其中 2 条由本轮任务夹文档自身引入（DESIGN 的非 Markdown 片段链接、PRD 的本机绝对路径），其余 12 条为 r14 任务夹既有。
- **宿主探针失败已定位为探针缺陷**：20 条 `Cannot read properties of undefined (reading '0')` 的抛出点在探针自身 `scripts/probe/host-probe-plugin.mjs:91`（把单次 `execute` 的返回值当 `{results}` 批式结果读），不在宿主管线；把副本改为单次 `ctx.tools.execute({callId,name,arguments,signal})` 后复跑 31/32 通过、1 blocked。按 AC-20 判「探针缺陷（先补失败用例再修）」。

判定：**打回（rework）**。修复 D-1、D-2 后重跑本轮验收；D-3、D-4 可随修复一并处理。

## 2. 验收对照（AC-1～21）

状态口径：PASS＝有可复现实证且满足条文；PARTIAL＝部分子项成立、另有缺口；FAIL＝条文未满足；NOT RUN＝未执行或证据不足。

| AC | 优先级 | 结论 | 证据与说明 |
|---|---|---|---|
| AC-1 | P0 | **FAIL** | Demo 标识 `DEMO-CHG-0042` / `DEMO-WORK-18` / `demo-only-7c3a` 在 `packages/`、`tests/` 与两包 tarball 解包全文命中 0；新增身份/凭据存储写入点 0（`GITEE_PAGE_FIELDS`、`CLI_EDITABLE_FIELDS` 均不含凭据键）。但「企业研发」分区内**没有到既有企业账号入口的导航**：`client.js:787-960` 只渲染 6 行状态 + 检查/刷新两个按钮，无「前往企业账号」按钮或链接（DESIGN §3.1 明确画了该入口）。 |
| AC-2 | P0 | **FAIL** | 四组反例未各有独立呈现：`READINESS_ROWS = ['identity','public','local','devops','gitee','write']`（`client.js:116`）没有「Key 已配置但未验证」这一组，仅靠固定声明句「四项互不推导…Key 已验证…」（`client.js:315`）提及，未呈现真实状态；全仓无「四组反例逐组断言」用例（`grep -rn "四组\|互不推导" packages/*/test tests/*.test.mjs` 零命中）。 |
| AC-3 | P0 | **FAIL** | 身份六态映射缺「退出未知」：`IAM_STATE_OF`（`client.js:99-107`）只有 ready/signed-out/unconfigured/authenticating/expired/unreachable/error，未知值一律落到通用 `unknown`，无独立状态词与下一步；六态也**都没有各自的「下一步」操作**（页面只有检查/刷新）。「旧 session 响应延迟到退出之后」无用例（`grep "迟到\|旧请求后到"` 零命中）。 |
| AC-4 | P0 | **PARTIAL** | 分项页有三层来源（`snapshot.entries` 的 inherited/override/value，随包用例通过）；汇总页「本机配置」只列本机覆盖键名（`client.js` `localKeys()`），未按 DESIGN 展示两个插件各自的生效来源；公共参数只有「未知 + 阻塞原因」一行，无展开来源/版本/作用域。无企业接口时显示 unknown 符合风险 1，但汇总三层展示未按 AC-4 字面交付。 |
| AC-5 | P0 | **PASS** | 可写字段仅 `cliPath/timeoutMs`（`config-access.mjs:43`）与 `dopBin/timeoutMs`（`index.mjs:61`）；`host/authEnv/persistentToken` 只读，`authEnv` 只显示变量名；两 `client.js` 无凭据值、无 `data-*` 泄漏（仅 `dataset.plugin/pluginCss`）；脱敏与页面静态用例 71 pass / 0 fail。DOM/网络层未做浏览器断言（见人工清单）。 |
| AC-6 | P0 | **PASS** | 增量保存、隐藏键/未知嵌套键/兄弟条目/注释逐字保留、恢复继承只删对应键、过期 revision 冲突不半写：`cli-access.test.mjs`、`config-access.test.mjs` 随包套件全绿（devops 404、gitee 259）。 |
| AC-7 | P0 | **PASS（仅拒绝分支）** | 无可核验公共维护接口，页面整区只读并显示「尚无可核验的公共维护权限与接口」；仓库不存在公共参数写接口，故「直接请求写接口返回 403」无测试对象（PRD 风险 1 已预告）。未出现 Demo「维护者」开关，无「已向企业分发」文案（页面文案用例通过）。 |
| AC-8 | P0 | **PASS** | `packages/forge-devops/test/save-applied.test.mjs`：写成功 `applied:{ok:true}`、重建失败降级 `CLI_REBUILD_FAILED` + `no-reader`、POST 原样透传；`packages/forge-gitee/test/faces-rebuild.test.mjs:101/150` 同口径。保存/应用/检查互不置位由既有回执行用例覆盖。 |
| AC-9 | P0 | **PARTIAL** | 过期判定有实现（`checkStateOf`，`client.js:880`，基准 revision 不一致→stale），但**无用例**；检查结果只展示状态与时间，未展示配置基准、检查对象、来源类型（AC-9 要求每条结果关联四项）；「迟到旧检查不得覆盖」无用例（TECHNICAL §293 要求）。`?refresh=1` 仅 devops、响应前重建由 r9 用例与 `ui-contract` 守住。 |
| AC-10 | P0 | **PARTIAL** | 检查子原因只认四码 `NO_CLI/ENTRY_NOT_EXECUTABLE/ENDPOINT_UNREACHABLE/POLICY_DENIED`（`client.js:108-113`），Gitee 行恒显「未执行 · 未获批准的只读探测」；但「未检查/检查中/通过/失败/未知/已过期」六态与四层证据（文件存在/可启动/目标可识别/只读可访问）在汇总页无逐层展示，且全部无 UI 用例。 |
| AC-11 | P0 | **PASS** | 两包 `src` 零 `spawn(`/`exec(`/`shell:true`；唯一 `execFile` 出口分别在 `gitee-cli.mjs:414` 与 `cli-runner.mjs:116`；超时与 1MiB 上限未放宽（随包用例覆盖）。业务写调用 0、策略写 0、token 注入 0 由既有拒绝/成功夹具覆盖。 |
| AC-12 | P0 | **PASS** | 六类注入（EINVAL/ENOENT/EACCES、相对 bin、绝对路径/UNC、URI）全文扫描零命中：`failure-face.test.mjs`、`read.test.mjs` 与两 `client-shape` 共 71 pass / 0 fail；页面文案零环境变量名、零目录路径（`client-shape` 用例）。复制诊断入口本轮未新增，无对应出口。 |
| AC-13 | P1 | **PASS（静态）** | 入口在既有 `settings.section` 壳内，id `devops-readiness`/order 29，不新开网页；两段式 `slots.inject`；`role=status` + `aria-live=polite` 存在于回执行；zh/en 键集与占位符一致（随包用例）。键盘全路径与 320px/200% 走查未执行，列入人工清单。 |
| AC-14 | P0 | **PARTIAL** | `cordis.patch.yml` 存在且 `dsh.bundle.patch` 指向它，`insert.name` 与包名逐字相同（`@heluo/forge-gitee` / `@heluo/forge-devops`），`--dump-config` 条目出现（exit 0）。**启动日志未取得**（启动阻塞），「无 entry not found / 无 did not activate」子项 NOT RUN。 |
| AC-15 | P0 | **PASS** | 两包 `dsh.client` 字段集合与样本一致（platform/immediately/inject），client 产物非空且含本包 id；Gitee UI 由 `packages/forge-gitee/client.js` 自注册 `settings.section`（id gitee/order 50），未跨包导入。`check-client-module` failed 0。 |
| AC-16 | P0 | **NOT RUN** | 静态判据全部成立（两段式、`inject` 参数与 `register.name` 逐字相同、id 为插件标识、order 29/50/60），但 AC-16 明确「装进独立 profile 并启动宿主后设置页真实出现该分区（截图或 aria 快照）」，本轮 GUI 不可达，故不得判 PASS。 |
| AC-17 | P0 | **PASS** | `npm pack --dry-run --json`：gitee 19 文件、devops 23 文件，均含 client.js/patch/README/src，无 test；闭包 tarball 36/40 文件，解包 `package.json` 全文 `workspace:` 命中 0，`dependencies` 仅 `@heluo/forge-policy` 且已 bundled。 |
| AC-18 | P0 | **PASS** | `peerDependencies.react >=18` + `peerDependenciesMeta.react.optional=true`；宿主入口 `await import` exit 0；client 产物经 `check-client-module`（假 Loader/React 真跑 apply）failed 0。 |
| AC-19 | P0 | **PARTIAL** | 独立 profile `heluo-r15-uat`：`dsh plugin add` 两个 tarball 均 exit 0，profile `dsh.profile.bundles` 含两包，`--dump-config` 条目出现；GUI 可见性与启动日志 NOT RUN。日常 `desktop` 的 `package.json` sha256 前后一致；其 `cordis.patch.yml` 哈希在窗口内由 `06e1abc2…` 变为 `f9fa3cd3…`（mtime 19:54:14），文件零 `@heluo` 条目，判为运行中实例自写、与本轮操作无因果，记为观察 O-1，不据此判 AC-19 通过或失败。已按 §7.4 删除 UAT profile 回滚。 |
| AC-20 | P0 | **PASS（如实记录）** | `pnpm check` exit 1、14 条文档错误（见 D-1）；`node --test` 2783 / 2780 pass / 2 fail / 1 skipped（skip 为既有 Windows 8.3 平台门控，未新增 skip）；`git diff --check` exit 0；探针失败定位到 `host-probe-plugin.mjs:91` 并判定探针缺陷（见 D-4），未改跟踪断言、未声称全绿。用例数 2783 ≥ 起点 2726。 |
| AC-21 | P1 | **PARTIAL** | 两包 README 均有「安装」「回滚」（gitee README:123 起、devops README:128 起，含配置回滚/精确卸载/复核命令）；设计索引、登记表与两份插件设计文档已随 diff 同步；包体与工作区无 profile/凭据/缓存/日志。`.gitignore` 有 `logs/`、`*.tgz`、`dist/`，**无显式 `artifacts/`、`tarballs/` 条目**（构建默认写系统临时目录），审计项未完全闭合（D-5）。 |

## 3. 缺陷表

| ID | 严重度 | 关联 AC | 现象与可复现证据 | 影响 | 修复建议 | 状态 |
|---|---|---|---|---|---|---|
| D-1 | P1 | AC-20、AC-21 | `pnpm check` exit 1，卡在 `check-docs`：共 14 errors。本轮自身 2 条：`docs/teamflow/20261106-r15-enterprise-iam-ui/DESIGN.md:8` 指向 `packages/forge-devops/client.js#L72-L178` 的「fragment on a non-Markdown target」；`docs/teamflow/20261106-r15-enterprise-iam-ui/PRD.md:22` 含 `DSH_HOME=<本机 .dsh 绝对路径>`。其余 12 条为 r14 任务夹既有（DESIGN 4 + TECHNICAL 8）。复现：仓库根执行 `pnpm check`。 | 交付门禁红，文档检查无法通过；任务夹作为本轮产物不可用。 | 把非 Markdown 链接改为不带 `#L` 的纯路径或正文行号描述；PRD 的绝对路径改为 `$DSH_HOME` 占位；r14 12 条同型问题一并清理（属他轮产物，需授权）。 | 打开 |
| D-2 | **P0** | AC-1、AC-2、AC-3、AC-9、AC-13 | 「企业研发」`ReadinessSection`（`packages/forge-devops/client.js:787`）交付不完整：① 无「前往企业账号」导航（`787-960` 无该按钮/链接，DESIGN §3.1 有）；② 无 AC-2 第③组「Key 已配置但未验证」独立行（`READINESS_ROWS`，`client.js:116`），仅固定声明句提及；③ 六态无「退出未知」独立状态（`IAM_STATE_OF`，`client.js:99-107`），且六态均无「下一步」操作；④ 该组件**零渲染/交互用例**：`client-shape.test.mjs:202-209` 只断言 id/name/order/locale/component/label，`tests/ui-contract.test.mjs:26` 只列 id/order，全仓 `grep -rn "ReadinessSection"` 仅这两处注册断言；TECHNICAL §293 要求的「六行汇总 / 四组反例互不推导 / 迟到回包丢弃 / 固定声明文案存在」四项断言均未交付。 | 核心 P0 验收（AC-1/2/3）条文未满足；AC-9/10/13 的 UI 行为无自动化证据，dev 交付说明中「离线用假 Loader/假 React/假 fetch 覆盖」对该组件不成立。 | 先补失败用例（四组反例逐组断言、六态与下一步、迟到回包、导航存在性、声明文案），再补实现；若产品口径调整（如 Key 状态不纳入本页），先改 PRD/DESIGN 再改实现，不得以声明句替代真实状态。 | 打开 |
| D-3 | P2 | AC-4、AC-9 | 汇总页信息不全：本机配置行只列覆盖键名，未展示两插件各自的生效来源（DESIGN §3.1 示例为「DevOps：生效来源 配置 · 覆盖 dopBin；Gitee：全部继承 · 生效来源 自动发现」）；检查结果只显示状态+时间，未显示配置基准 revision、检查对象、来源类型（AC-9 要求四项）；公共参数无展开的来源/版本/作用域（仅一行 unknown）。 | 用户无法从汇总页核对「为什么是这个值」，与 AC-4 三层展示、AC-9 结果可核对性有差距。 | 汇总行读取 `snapshot.entries` 三列展示；检查回执展示 `basis`、对象（devops/gitee）、来源类型（config/env/discovery）；补对应用例。 | 打开 |
| D-4 | P2 | AC-20 | 宿主组合探针 20 条失败是**探针缺陷**：`scripts/probe/host-probe-plugin.mjs:90-91` 以 `{calls:[...]}` 调 `ctx.tools.execute` 并读 `batch.results[0]`，而安装的 `@deepseek-ai/dsh-tools@0.2.1-rc.5` 的 `execute(exec)` 接收单次 `exec`（dsh 安装目录下 `@deepseek-ai/dsh-tools/lib/index.js:3212`），返回单个 materialized result。栈实测抛点 `host-probe-plugin.mjs:91:39`（副本带栈复跑，20/20 同点），不在宿主；子派发 `:1043`、`:1053` 同型。反证：副本改为 `ctx.tools.execute({callId,name,arguments,signal})` 后 31/32 checks passed、1 blocked（blocked 为 `official-rows-runtime-model-surface`，本 profile LLM 提供方 0 个）。 | `node --test` 恒红 2 例，且 TECHNICAL F4 的「宿主版本差异」归因不准确；会持续误导后续轮次。 | 先补「调用形状」失败用例，再改探针为单次 exec（含子派发两处），重跑至 31/32；blocked 项按环境记录。 | 打开 |
| D-5 | P3 | AC-21 | 卫生细节：`.gitignore` 无显式 `artifacts/`、`tarballs/` 条目（当前靠 `*.tgz` 与系统临时目录兜底）；`packages/forge-devops/client.js` 中 `readiness.public.readonly`（:341）、`readiness.loading`（:346）、`readiness.failed`（:347）、`readiness.draftWarning`（:351）四个文案键未被引用（中英各一份）。 | 审计项不闭合；死文案易与实现漂移。 | 补 `.gitignore` 显式条目；删除未用键或接入对应状态（若接入，先补用例）。 | 打开 |

观察项（不计缺陷）：

| ID | 现象 | 处置 |
|---|---|---|
| O-1 | 日常 `desktop` profile 的 `cordis.patch.yml` 在验收窗口内哈希变化（`06e1abc2…` → `f9fa3cd3…`，mtime 19:54:14），内容零 `@heluo` 条目；同窗口 `package.json` sha256 不变（`8daaadaf…`）。 | 疑为运行中的 desktop 实例自写模型目录，与本轮独立 profile 操作无因果；AC-19 只按 `package.json` 不变断言，补丁层变化记 unknown，建议关闭实例后复测。 |
| O-2 | 独立 profile `dsh web` 启动阻塞在 `~/.dsh/.credentials.yaml`，日志 0 字节、无监听端口。 | 环境限制（非交互子代理无法完成凭据交互），非产品缺陷；AC-16/19 GUI 子项 NOT RUN。 |

## 4. 人工补测清单（本轮 NOT RUN）

1. **独立 profile GUI 可见性（AC-16/19，P0）**：`dsh plugin --profile heluo-r15-uat add` 两个 tarball → `dsh --profile heluo-r15-uat web --port 59215` 启动 → 截图或 aria 快照证明「企业研发」「企业 Gitee」分区出现；启动日志 grep 无 `entry not found`、无 `did not activate`；随后按 README 回滚并 `--dump-config | grep` 复核为空。
2. **真实企业 CLI 只读探测（AC-10/11）**：装好 `dop`/`gh` 的企业机器上点「检查 DevOps」，核对文件存在/可启动/目标可识别/只读业务四层证据与失败子原因；确认业务写调用 0、token 注入 0。
3. **公共参数维护权限（AC-7）**：若拿到企业维护接口，验证无权限时 403、editor 0 次、文件哈希不变；当前只有拒绝分支。
4. **双端路径形态（AC-10/11）**：Windows 的 `.exe`/`.cmd`/`.ps1`/无后缀、麒麟 aarch64 执行位；真实 `gh` 企业 host 与 `persistentToken` 策略。
5. **浏览器安全扫描（AC-5/12）**：真实页面 Network/DOM 断言凭据值、endpoint、本机绝对路径零命中；`authEnv` 只出现变量名。
6. **键盘与响应式（AC-13）**：Tab 全路径、aria-live 播报、320px/200%、200% 缩放、浅/深主题、reduced-motion。
7. **冷启动与并存（AC-19）**：关闭 desktop 实例后复测补丁层哈希；独立 profile 与桌面实例并存的端口/单实例行为。
8. **企业组合包（AC-17）**：`heluo-forge-enterprise` tarball 装入独立 profile，确认与单包同装时 `heluo-policy` 按 id 折叠、无重复挂载。

## 5. 回归与证据表

宿主版本均为 `dsh 0.2.1-rc.5`；时间为 2026-11-06 本地时间（约值）。

| # | 命令 / 操作 | 时间 | 目标 | 来源类型 | 结果 |
|---|---|---|---|---|---|
| 1 | `pnpm check` | 19:55 | 仓库 | 源码+文档 | **exit 1**；`check-docs` 14 errors（D-1）；docs 113 files/806 tables/994 links |
| 2 | `node --test`（全量） | 19:56 | 仓库 | 源码 | 2783 tests / 2780 pass / **2 fail** / 1 skipped；失败均 `tests/host-probe.test.mjs:19,29` |
| 3 | `cd packages/forge-gitee && node --test "test/*.test.mjs"` | 19:52 | forge-gitee | 源码 | 259 pass / 0 fail / 0 skip |
| 4 | `cd packages/forge-devops && node --test "test/*.test.mjs"` | 19:53 | forge-devops | 源码 | 404 pass / 0 fail / 0 skip |
| 5 | `node --test tests/ui-contract.test.mjs tests/bundle-build.test.mjs tests/bundle-gitee.test.mjs tests/plugin-patch-layers.test.mjs` | 19:52 | 仓库 | 源码 | 38 pass / 0 fail |
| 6 | `node --test tests/ui-contract.test.mjs` | 19:52 | 仓库 | 源码 | 6 pass / 0 fail |
| 7 | `node scripts/check-client-module.mjs packages/forge-gitee/client.js packages/forge-devops/client.js` | 19:53 | 两包 | 源码（假 Loader/React） | failed 0；sections gitee/50、devops/60、devops-readiness/29 |
| 8 | `npm pack --dry-run --json`（两包） | 19:53 | 两包 | 源码清单 | gitee 19 文件、devops 23 文件；无 test/coverage/node_modules |
| 9 | `buildBundle({entry:'@heluo/forge-gitee'\|'@heluo/forge-devops'})` + 解包审计 | 19:54 | 两包 | 构建产物 | 36 / 40 文件；`workspace:` 0 命中；policy 已 bundled；peer react optional |
| 10 | `build-enterprise-bundle` | 19:54 | 企业组合包 | 构建产物 | 67 文件，members keychain/iam/policy |
| 11 | `dsh --profile web --patch <两份补丁> --dump-config` | 19:54 | 宿主组合树 | 宿主 | exit 0；`id heluo-gitee` / `id forge-devops` 与 `@heluo/forge-policy` 出现 |
| 12 | `dsh plugin --profile heluo-r15-uat add <两个 tarball>` | 19:54 | 独立 profile | 宿主安装 | 两次 exit 0；bundles 含两包；`--dump-config` 条目出现 |
| 13 | `dsh --profile heluo-r15-uat web --port 59215` | 19:54–19:55 | 独立 profile | 宿主启动 | 日志 0 字节、无监听；阻塞于 `~/.dsh/.credentials.yaml` → NOT RUN |
| 14 | `node scripts/probe/run-host-probe.mjs`（原样） | 19:57 | 宿主探针 | 宿主+源码 | 12/32 passed、1 blocked、20 FAIL（`Cannot read properties of undefined (reading '0')`） |
| 15 | 副本带 `error.stack` 复跑 | 20:04 | 探针副本 | 源码 | 20/20 栈指向 `host-probe-plugin.mjs:91:39`，无宿主帧 |
| 16 | 副本改单次 `execute` 复跑 | 20:06 | 探针副本 | 源码 | 31/32 passed、1 blocked（无 LLM 提供方） |
| 17 | `git diff --check` | 19:51 | 仓库 | 源码 | exit 0 |
| 18 | 静态安全扫描（spawn/exec/shell:true、凭据键、`data-*`、demo 标识） | 20:08 | 两包源码 | 源码 | 全部 0 命中（详见 AC-1/5/11/12 行） |
| 19 | `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD` | — | 仓库 | 源码 | 未执行（本轮未推送；按 AC-20 条件项） |

证据文件：

- 探针带栈原始证据：`<TMPDIR>/forge-host-probe-HmkrN9/probe-raw.json`（19:57:38，无栈）；带栈与修正版：`<TMPDIR>/forge-host-probe-3xIX4r/probe-raw.json`（20:06:53）。
- 一次性探针副本（不改跟踪文件）：`logs/teamflow/tf-mw4uahb4-30ckym/scripts/probe-stack/`（`run-host-probe.mjs`、`host-probe-plugin.mjs`；runner 4 处相对路径改绝对、plugin catch 记栈、dispatch 改单次 exec）。
- 本轮未修改任何跟踪文件；QA 只新增本报告、`state/qa.json` 与上述 `logs/` 下证据副本。

## 6. 未执行与限制

- **GUI 走查**：独立 profile 启动被凭据交互阻塞（见 O-2），AC-16、AC-19 的 GUI/启动日志子项 NOT RUN；未用单测或静态检查替代。
- **真实企业联调**：无企业 `dop`/`gh`、无公共维护接口，AC-7 写拒绝分支与 AC-10 真实四层证据未验；界面与文档未出现「企业联调已通过」结论。
- **双端实机**：Windows、麒麟 aarch64 未执行（r10 起既有未验项）。
- **推送/签名**：本轮未提交、未推送；`sensitive-scan` 未跑属条件未触发。
- **既有失败**：`tests/host-probe.test.mjs` 2 例按 D-4 记录，未改写断言；1 例 skip 为既有 Windows 8.3 平台门控。
- 工作区含 dev 阶段未提交改动（`git status` 可见），与本报告结论无关。

## 7. 建议的下一步

1. 研发先修 D-2：补「前往企业账号」导航、Key 第③组呈现、六态「退出未知」与每态下一步；按 TECHNICAL §293 先写失败用例再实现，并补四组反例、迟到回包、声明文案断言。
2. 修 D-1：清掉本轮 DESIGN/PRD 两条文档错误（r14 12 条需授权一并清理），使 `pnpm check` 转绿。
3. 修 D-4：探针改单次 `execute` 调用形状（含子派发两处），补调用形状用例后复跑至 31/32。
4. 修复后由主 agent 在交互环境完成第 4 节第 1、2 项，取得 GUI 截图/aria 与启动日志证据，再复验 AC-16/19。
5. D-3、D-5 随本轮一并处理，重跑 `pnpm check`、全量 `node --test`、`git diff --check`。
