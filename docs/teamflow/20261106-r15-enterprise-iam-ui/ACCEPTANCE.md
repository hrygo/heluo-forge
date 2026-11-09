# 验收报告：r15 企业研发设置与 IAM 正式 UI 整合（可装载交付）

| 项 | 值 |
|---|---|
| 轮次 | r15（企业研发设置与 IAM 正式 UI 整合） |
| 日期 | 2026-11-06 |
| 分支 / 提交 | `feat/plugin-workflow` @ `0db3c65`（未提交、未推送） |
| 工作区 | clutch worktree `wt_622dc4710a35`；macOS arm64、Node v24.13.0、DSH `0.2.1-rc.5` |
| 输入 | `PRD.md`（AC-1～21）、`DESIGN.md`、`TECHNICAL.md`、`QA-REPORT.md`、dev 交付说明 |
| 结论 | **不通过（打回研发）**：1 个 P0（核心分区交付不完整）、1 个 P1（交付门禁红）、2 个 P2、1 个 P3；AC-16/19 的真实装载 GUI 证据 NOT RUN |

## 1. 判定口径与独立性

本轮验收以「证据复核 + 关键点独立复跑」进行，不重复 QA 已完成的全量套件（AGENTS.md §5：已有完整有效结果不重复运行）：

- **本轮直接复跑（只读）**
  - `node scripts/check-docs.mjs` → `docs: 14 error(s)`，其中本轮任务夹自身 2 条（`DESIGN.md:8` 非 Markdown 目标带 `#L` 片段、`PRD.md:22` 本机绝对路径），其余 12 条为 r14 任务夹既有。
  - `node --test tests/host-probe.test.mjs` → `tests 2 / pass 0 / fail 2`，exit 1；失败抛出点经读源码确认为 `scripts/probe/host-probe-plugin.mjs:90-91`（以 `{calls:[...]}` 调 `ctx.tools.execute` 并读 `batch.results[0]`）。
  - `git diff --check` → exit 0。
  - Demo 标识 `DEMO-CHG-0042` / `DEMO-WORK-18` / `demo-only-7c3a` 在 `packages/`、`tests/` grep → 0 命中。
- **本轮直接读源码核对 P0 缺口**（不采信转述）
  - `packages/forge-devops/client.js:99-107` `IAM_STATE_OF`：仅 signed-out/authenticating/ready/expired/unreachable/error，无独立「退出未知」，且注释「未列出的按退出未知处理」与实现（落到通用 `unknown`）不一致。
  - `packages/forge-devops/client.js:116` `READINESS_ROWS = ['identity','public','local','devops','gitee','write']`：无「Key 已配置但未验证」一行。
  - `packages/forge-devops/client.js:787-958` `ReadinessSection`：只渲染标题、介绍、固定声明、六行状态与「检查/刷新」两个按钮；无「前往企业账号」导航，无各行/各态的下一步操作，检查回执只显示状态+时间（`check.basis` 仅参与过期判定，不上屏）。
  - 渲染用例：`packages/forge-devops/test/client-shape.test.mjs:202-209` 仅断言注册 id/name/order/locale/component/label，`tests/ui-contract.test.mjs:26` 仅登记 id/order；全仓无 `ReadinessSection` 渲染/交互用例。
- **可装载层抽查（通过）**：两包 `cordis.patch.yml` 存在、`insert.name` 与 `package.json#name` 逐字相同（`@heluo/forge-devops` / `@heluo/forge-gitee`）；`dsh.client = {platform:'web', immediately:true, inject:['slots','locale']}` 与样本同键集；`files` 含 `client.js` 与 `cordis.patch.yml`；`peerDependencies.react >=18` 且 `peerDependenciesMeta.optional`；两段式 `slots.inject('settings.section') → register({name:'settings.section'})`，devops(60)/devops-readiness(29)/gitee(50) 三处一致。
- **采信 QA 实测的部分**在表中标注「QA 实测」；采信不等于放行：凡 P0 条文未满足、或 P0 证据缺失的，仍判 FAIL / NOT RUN。

## 2. AC 逐条对照（AC-1～AC-21）

状态口径：PASS＝有可复现实证且条文满足；PARTIAL＝部分子项成立、另有缺口；FAIL＝条文未满足；NOT RUN＝未执行或证据不足。

| AC | 优先级 | 结论 | 验收依据 |
|---|---|---|---|
| AC-1 | P0 | **FAIL** | 唯一身份复用（新增身份/凭据写入点 0、Demo 标识 0 命中）成立；但「企业研发」分区**没有到既有企业账号入口的导航**（`client.js:891-958` 无按钮/链接），DESIGN §3.1（:146）要求的行中「前往企业账号」未实现。 |
| AC-2 | P0 | **FAIL** | 四组反例未各有独立呈现：`READINESS_ROWS` 无「Key 已配置但未验证」组，仅有固定声明句（`:315`）提及；全仓无四组逐组断言用例；固定声明「不代表业务授权」存在（`:314`）。 |
| AC-3 | P0 | **FAIL** | 身份六态缺「退出未知」独立状态（`IAM_STATE_OF` 未知值落 `unknown`，与注释不符）；六态均无各自「下一步」；「旧 session 迟到回包」无用例（QA 实测 grep 0 命中）；「不可达时本机配置可读、不触发 IAM 写」无专门断言。 |
| AC-4 | P0 | **PARTIAL** | 分项页三层来源（`snapshot.entries` 的 inherited/override/value）随包用例通过；汇总页「本机配置」只列本机覆盖键名，未展示两插件各自生效来源；公共参数仅一行 unknown，无来源/版本/作用域展开。 |
| AC-5 | P0 | **PASS（静态）** | 可写字段仅 `cliPath/timeoutMs`、`dopBin/timeoutMs`；`host/authEnv/persistentToken` 只读，`authEnv` 只出变量名；两 client 无凭据值、无 `data-*` 泄漏（QA 实测 71 pass）。真实页面 DOM/Network 扫描 NOT RUN（见人工清单）。 |
| AC-6 | P0 | **PASS** | 增量保存、隐藏键/未知嵌套键/兄弟条目/注释逐字保留、恢复继承只删对应键、过期 revision 冲突不半写：`cli-access.test.mjs`、`config-access.test.mjs`（devops 404、gitee 259 全绿，QA 实测）。 |
| AC-7 | P0 | **PARTIAL** | 无可核验维护权限时整区只读并显示原因，无 Demo「维护者」开关、无「已向企业分发」文案（文案用例通过）；仓库不存在公共参数写接口，「直接请求写接口 403」无测试对象，按 PRD 风险 1 记 unknown，不据此判全绿。 |
| AC-8 | P0 | **PASS** | 保存/应用/检查互不置位；`save-applied.test.mjs` 覆盖写成功 `applied.ok`、重建失败 `CLI_REBUILD_FAILED` + `no-reader`、POST 原样透传；gitee `faces-rebuild.test.mjs:101/150` 同口径（QA 实测）。 |
| AC-9 | P0 | **PARTIAL** | 过期判定有实现（`checkStateOf`：基准 revision 不一致→stale），但无用例；检查结果未展示配置基准/检查对象/来源类型；迟到旧检查覆盖无用例；`?refresh=1` 仅 devops、响应前重建由 r9 用例与 `ui-contract` 守住。 |
| AC-10 | P0 | **PARTIAL** | 子原因四码 `NO_CLI/ENTRY_NOT_EXECUTABLE/ENDPOINT_UNREACHABLE/POLICY_DENIED` 存在，Gitee 行恒「未执行·未获批准的只读探测」；但六态与四层证据（文件存在/可启动/目标可识别/只读可访问）在汇总页无逐层展示，且无 UI 用例。 |
| AC-11 | P0 | **PASS** | 两包 `src` 零 `spawn(`/`exec(`/`shell:true`；唯一 `execFile` 出口在 `gitee-cli.mjs:414`、`cli-runner.mjs:116`；超时与 1MiB 上限未放宽；写调用 0/token 注入 0 由既有夹具覆盖（QA 实测）。 |
| AC-12 | P0 | **PASS（静态）** | 六类注入全文扫描零命中（`failure-face.test.mjs`、`read.test.mjs`、两 `client-shape` 71 pass）；页面文案零环境变量名、零目录路径；复制诊断入口本轮未新增。真实浏览器 Network/DOM 断言 NOT RUN。 |
| AC-13 | P1 | **PASS（静态）** | 入口在既有 `settings.section` 壳内，id `devops-readiness`/order 29，不新开网页；两段式挂载；回执行有 `role=status` + `aria-live=polite`；zh/en 键集一致。键盘全路径与响应式未执行。 |
| AC-14 | P0 | **PARTIAL** | `cordis.patch.yml` 存在且 `dsh.bundle.patch` 指向；`insert.name` 与包名逐字相同；`--dump-config` 条目出现（QA 实测 exit 0）。**启动日志子项 NOT RUN**（独立 profile 启动阻塞）。 |
| AC-15 | P0 | **PASS** | 两包 `dsh.client` 键集与样本一致；client 产物非空且含本包 id；Gitee UI 由 `packages/forge-gitee/client.js` 自注册（id `gitee`/order 50），未跨包导入；`check-client-module` failed 0（QA 实测）。 |
| AC-16 | P0 | **NOT RUN** | 静态判据全成立（两处 `inject`/`register.name` 逐字 `settings.section`，插件标识在 `id`，order 29/50/60），但条文要求的「装进独立 profile 启动宿主后设置页真实出现该分区（截图/aria）」本轮未取得，不得判 PASS。 |
| AC-17 | P0 | **PASS** | `npm pack --dry-run --json`：gitee 19 文件、devops 23 文件，均含 client.js/patch/README/src，无 test；闭包 tarball 36/40 文件，解包 `package.json` `workspace:` 0 命中，`dependencies` 仅 `@heluo/forge-policy` 且已 bundled（QA 实测）。 |
| AC-18 | P0 | **PASS** | `peerDependencies.react >=18` + `peerDependenciesMeta.react.optional=true`；宿主入口 `await import` exit 0；client 产物经假 Loader/React 真跑 `apply`，failed 0（QA 实测）。 |
| AC-19 | P0 | **PARTIAL** | 独立 profile `heluo-r15-uat` 两个 tarball `dsh plugin add` 均 exit 0，`dsh.profile.bundles` 含两包，`--dump-config` 条目出现；日常 `desktop` 的 `package.json` sha256 前后一致；**启动日志与 GUI 可见性 NOT RUN**；补丁层哈希在窗口内变化（O-1），按 unknown 记。已删除 UAT profile 回滚。 |
| AC-20 | P0 | **PASS（如实记录）** | `pnpm check` exit 1、check-docs 14 errors（本轮复跑确认，2 条本轮自身）；`node --test` 2783 / 2780 pass / 2 fail / 1 skipped（skip 为既有平台门控）；`git diff --check` exit 0（本轮复跑确认）；两项宿主组合探针失败定位到 `host-probe-plugin.mjs:90-91` 并判定探针缺陷（本轮复跑 2 fail 确认）；未改跟踪断言、未声称全绿。 |
| AC-21 | P1 | **PARTIAL** | 两包 README 均有安装/回滚段；设计索引、登记表、两份插件设计文档随 diff 同步；工作区无 profile/凭据/缓存/日志（`logs/teamflow/` 为宿主管理的瞬态区，不属交付）；`.gitignore` 有 `logs/`、`*.tgz`、`dist/`，**无显式 `artifacts/`、`tarballs/`**。 |

## 3. 阻断项（修复后必须重新验收）

1. **P0 · D-2：「企业研发」分区交付不完整（AC-1/2/3，连带 AC-9/10/13 无 UI 证据）**
   - 缺「前往企业账号」导航（DESIGN §3.1 :146 明确有动作列）。
   - 缺 AC-2 第③组「Key 已配置但未验证」独立行——当前只用固定声明句替代真实状态，正是 AC-2 要防的「互相推导」。
   - 身份六态缺「退出未知」独立状态（`IAM_STATE_OF` 与注释矛盾），六态无各自「下一步」。
   - `ReadinessSection` 零渲染/交互用例；TECHNICAL §203 自己写的「六行汇总 / 四组反例互不推导 / 迟到回包 / 固定声明」四项断言均未交付。TECHNICAL §293（QA 引用处）同类要求亦未落地。
   - 修复路径：先补失败用例（四组反例逐组、六态+下一步、迟到回包丢弃、导航存在性、声明文案），再补实现；若产品口径要变，先改 PRD/DESIGN，不得以声明句替代状态。
2. **P0 证据缺口：AC-16 / AC-19 的真实装载与 GUI 可见性 NOT RUN。**
   - 独立 profile `dsh web` 停在打开 `~/.dsh/.credentials.yaml` 之后：日志 0 字节、无监听端口（QA 实测，非交互子代理无法完成凭据交互）。
   - 按 PRD AC-16/19 条文，单测与静态检查不能替代该证据；该项只能由主 agent 在本机 GUI 走查后补证，或由用户确认接受该项延后。
3. **P1 · D-1：交付门禁红。** `check-docs` 14 errors，其中本轮任务夹自身 2 条：
   - `DESIGN.md:8` 指向 `packages/forge-devops/client.js#L72-L178`：非 Markdown 目标带片段。
   - `PRD.md:22` `DSH_HOME=<profile 根目录>`：原文写本机绝对路径，违反仓库「不写本机绝对路径」约定，已脱敏为占位。
   - r14 的 12 条为历史产物同型问题，需产出方或主流程授权清理；本轮交付不能以「他轮产物」为由长期保留红灯。

## 4. 架构一致性检查（M3 质量门）

- **符合技术方案**：`packages/forge-gitee/src/config-access.mjs`（三层读面与 revision 栅栏）、`http.mjs`（读写端点与大小/错误映射）按 TECHNICAL 抽出；`packages/forge-gitee/src/index.mjs` 以 `faces.*` 单点换页（build/rebuild/degrade），service 不再各自持引用；`forge-devops` 继续复用既有 `cli-access`/`http`；两包仍只有唯一 `execFile` 出口，未新增 `spawn`/`shell:true`。
- **未见重复实现或适配器漂移**：Gitee UI 由本包 client 承载，未跨包导入源码；保存回执的 `applied` 判据（运行时合并态里出现新值）集中在服务层，http 原样透传。
- **偏差**：UI 层相对 DESIGN §3.1 的「准备清单」表结构（动作列、四组反例、六态下一步）未落地——这是本轮 P0 功能缺口，不是额外架构返工项；修复时按 DESIGN 落表即可，不新增模块。
- **结论**：架构层无需单独返工；不通过的原因是功能条文未满足 + 装载可见性证据缺失。

## 5. 缺陷与遗留（沿用 QA 编号，验收侧确认）

| ID | 严重度 | 关联 AC | 状态 | 验收侧确认 |
|---|---|---|---|---|
| D-1 | P1 | AC-20、AC-21 | 打开 | 本轮复跑 `check-docs`：14 errors（2 条本轮自身），确认 |
| D-2 | **P0** | AC-1、2、3、9、13 | 打开 | 本轮直接读 `client.js:99-107/116/787-958` 与用例清单确认，非转述 |
| D-3 | P2 | AC-4、AC-9 | 打开 | 汇总三层与检查四项未上屏，确认 |
| D-4 | P2 | AC-20 | 打开 | 本轮复跑 2 fail/0 pass，抛点 `host-probe-plugin.mjs:90-91` 确认；属探针缺陷，应先补失败用例再改单次 `execute` 形状。 |
| D-5 | P3 | AC-21 | 打开 | `.gitignore` 无显式 `artifacts/`、`tarballs/`；四个 readiness 文案键未被引用（`readiness.public.readonly`/`loading`/`failed`/`draftWarning`）。 |

观察项：**O-1** 日常 `desktop` 的 `cordis.patch.yml` 哈希窗口内变化、内容零 `@heluo` 条目（判运行中实例自写，记 unknown）；**O-2** 独立 profile `dsh web` 凭据交互阻塞（环境限制，非产品缺陷）。

## 6. 修复后的复验入口

```sh
node scripts/check-docs.mjs            # 期望 0 error（含 r15 自身 2 条与 r14 12 条处置）
node --test tests/host-probe.test.mjs  # 期望 32/32（或按 D-4 修复后 31/32 + 1 blocked 说明）
pnpm check                             # 期望 exit 0，用例数 ≥ 2783、0 skip 新增
git diff --check
# 新增：ReadinessSection 渲染用例（四组反例/六态+下一步/迟到回包/导航/声明）
# 新增：主 agent 独立 profile 真装 + 启动日志 + GUI 截图/aria 快照（AC-16/19）
```

## 7. 人工补测清单（本轮 NOT RUN，继承 QA）

1. 独立 profile GUI 可见性（AC-16/19，P0）：主 agent 装两个 tarball → `dsh --profile heluo-r15-uat web` → 截图/aria 证明「企业研发」「企业 Gitee」出现；启动日志无 `entry not found`/`did not activate`；随后回滚复核为空。
2. 真实企业 CLI 只读探测（AC-10/11）：文件存在/可启动/目标可识别/只读业务四层证据；业务写 0、token 注入 0。
3. 公共参数维护权限（AC-7）：若取得企业接口，验证无权限 403、editor 0 次、文件哈希不变。
4. 双端形态：Windows `.exe/.cmd/.ps1/无后缀`、麒麟 aarch64 执行位；真实 `gh` 企业 host 与 `persistentToken` 策略。
5. 浏览器安全扫描（AC-5/12）：真实页面 Network/DOM 断言凭据值、endpoint、本机绝对路径零命中。
6. 键盘与响应式（AC-13）：Tab 全路径、aria-live、320px/200%、主题、reduced-motion。
7. 冷启动与并存（AC-19）：关闭 desktop 后复测补丁层哈希；独立 profile 与桌面实例并存行为。
8. 企业组合包（AC-17）：`heluo-forge-enterprise` tarball 装入独立 profile，确认 `heluo-policy` 按 id 折叠、无重复挂载。

## 8. 工作区与提交状态

未提交、未推送，仍在 `feat/plugin-workflow`；本轮验收未改动任何跟踪文件，仅新增本报告与 `logs/teamflow/tf-mw4uahb4-30ckym/state/acceptance.json`。`docs/teamflow/memory.md` 无需更新（本轮未产生新约定，PRD 阶段已做同主题替换）。

验收结论：❌ 不通过
