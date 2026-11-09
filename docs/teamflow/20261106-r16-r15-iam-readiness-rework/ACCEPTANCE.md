# 验收报告：r16 r15 企业研发就绪页返工

| 项 | 值 |
|---|---|
| 轮次 | r16（r15 验收 D-1～D-5 打回项返工） |
| 日期 | 2026-11-06 |
| 基线 | `docs/teamflow/20261106-r15-enterprise-iam-ui/`（r14 → r15 → r16 链） |
| 分支 / 提交 | `feat/plugin-workflow` @ `0db3c65`（未提交、未推送、未切分支） |
| 工作区 | clutch worktree `wt_622dc4710a35`；macOS arm64、Node v24.13.0、DSH `0.2.1-rc.5` |
| 输入 | `PRD.md`（AC-1～12）、`TECHNICAL.md`、`QA-REPORT.md`、交付说明 `DELIVERY-NOTES.md` |
| 结论 | **通过**：12 条 AC 逐条实测成立；2 条 P3 非阻断文案/入口偏差、1 条数字口径差异，均已记录并给出改法 |

> §0 文档说明：dev 阶段的交付说明原写在 `ACCEPTANCE.md`（sha256 `39a8f1aa…9069d1`），本阶段须以 `ACCEPTANCE.md` 承载验收结论，故把该文件逐字节保留为 `DELIVERY-NOTES.md`（复制前后 sha256 一致）。`TECHNICAL.md` 与本报告中对「交付说明 §x」的引用均指 `DELIVERY-NOTES.md`。

## 1. 判定口径

- 本报告不采信交付自述，逐条 AC 以**本机亲自实跑的门禁**、**源码事实**与**QA 独立探针**（`logs/teamflow/tf-mw4y10xm-5q3dff/scripts/qa-r16-readiness-probe.mjs`，44 passed / 0 failed / 1 deviation）交叉验证；QA 只解不验，凡我复跑结果与 QA 不一致处按**我的实测**记录（见 D-3）。
- 状态口径：PASS＝有可复现实证且满足条文；PASS（有偏差）＝主体成立、个别子项未逐字满足（记偏差，不阻断）；FAIL＝条文未满足；NOT RUN＝本轮不执行。
- 三条偏差均不改变用户可感知的安全语义（不把「已配置·未验证」涂绿、不把「退出未确认」画成未登录、不把 offline 绿灯写成企业已验证），故不构成打回。

## 2. AC 逐条对照

| AC | 结论 | 本机实证 |
|---|---|---|
| AC-1 导航唯一 | PASS | `client.js:1145` 仅从 `props.navigate` 取导航能力；`sectionNavigatorOf`（`:1989-2005`）在 apply 期按 `NAV_METHODS`（`:117`=`openSection`/`selectSection`）、目标 `SECTION_FORGE_IAM`（`:116`=`forge-iam`）逐方法探测，命中才返回导航器；`:1464-1471` 有导航器时渲染**唯一**按钮（`readiness.action.openAccount`），无则渲染 `span`「…· 设置 → 企业账号」（`:1471`），无死按钮。就绪分区无表单/凭据输入（`input` 仅样式类名）。zh/en 键集等值由 `readiness-section` 键集断言与 `ui-contract` 9 条覆盖，均实跑通过。 |
| AC-2 Key 五态 | PASS | `keyStateOf`（`:981`）三条件 `configured && matchesAccount===true && modelAccess.state==='ready'` 才 `keyVerified`；文案键 `:385-386`（已配置·未验证 / 已验证）+ `readiness.key.reason.*` 6 条（`:396-401`）；未配置 / 未验证 / 已验证 / 未知 / 未安装 五态各有独立词与下一步。四组反例独立用例在 `readiness-section.test.mjs`，断言其余四行逐字不变、Key 单独断言（边界见 §4 的 E-4）。修 bug 的 `client.js` 全文「企业联调已通过 / 已向企业分发 / 企业已验证」0 命中；全仓唯一命中是 `src/readiness.mjs:21` 的反面目标注释。 |
| AC-3 身份六态 | PASS（1 处子项偏差 D-2） | `IAM_STATE_OF`（`:106-113`）把 `error` 归 `signedOutUnknown`；`:977` 未列出的 state 也归 `signedOutUnknown`，不回落 unknown/未登录；`:85` 状态词表独立。六态下一步见 `:1228-1236`：未登录/已登录/过期→账号页导航，登录中→返回账号页等待，不可达→重试（`button`，`:1233`），退出未确认→「请到企业账号页核对是否已退出」。迟到回包由 `readSeq` 代次与 `checkSeq` 丢弃，QA 探针以「旧 ready 最后到达」复现；IAM 不可达时本机快照仍可读、零写请求。偏差 D-2：不可达态未同时给出 AC-3 所列的「前往账号页」入口。 |
| AC-4 检查四项 + 四层证据 | PASS（1 处词面偏差 D-1） | 四项键 `:416-423`（基准/时间/对象/来源类型，来源类型枚举 本地诊断·夹具·企业真实证据·未知）；四层证据 `evidenceNode`（`:1361-1371`）逐层渲染 通过/未通过/未执行 + 原因 + 依据，六层皆来自服务端 `src/readiness.mjs` 的 `EVIDENCE_LAYERS`/`EVIDENCE_STATES`/`EVIDENCE_REASONS`（`ui-contract` 逐字钉住）。`?refresh=1` 唯一拼法 `refreshUrl()`（`:725`），只被「检查 DevOps」调用；页脚「刷新」走 `load()` 不带参数。基准变更标「已过期」并保留旧证据；Gitee 按钮 `disabled:true`（`:1494-1496`）且无 handler，零请求由用例断言。偏差 D-1：未检查态渲染 `check.unchecked`「未执行」，与证据层同词，`readiness.state.unchecked` 不可达。 |
| AC-5 先红后绿 | PASS（证据性质受限） | 本机复跑：`FORGE_DEVOPS_CLIENT=logs/teamflow/tf-mw4y10xm-5q3dff/probe/head/client.js node --test packages/forge-devops/test/readiness-section.test.mjs` → **exit 1，tests 19 / pass 3 / fail 16 / skipped 0**（失败点 `TypeError: Section is not a function`）；当前源码同用例 **19/19 pass**。HEAD 无 `ReadinessSection`，红跑是事后用 HEAD 副本重建，**「实现前红」不可证**（记 E-3）。既有 `client-shape`（devops 29→32、gitee 0→10）与 `ui-contract`（6→9）断言只增不减，本轮新增 skip 0。 |
| AC-6 三层来源 | PASS | 服务端单点：`projectLayers`（`src/readiness.mjs:102`，只投影键名）、`rowForReadiness`（`src/cli-access.mjs`）返回原始两层不合并；客户端 `layersNode`（`:1413`）按「生效来源 / 公共参数（inherited）/ 本机覆盖（override）/ 最终生效（value）」+ 缺层原因渲染，来源枚举 `:454-459` 四枚举 + `default`/`unset`/`unknown`。检查四项与 AC-4 同源，不另建副本（`ui-contract` 断言三层键名两侧同源，实跑通过）。 |
| AC-7 探针单次契约 | PASS | `scripts/probe/host-probe-plugin.mjs:41` 统一 `dispatchTool`（单次 `ctx.tools.execute`，`arguments` 传对象），三处派发 `:116` / `:1067` / `:1077` 均走它，无 `calls:[…]`/`batch.results[0]` 形状。`tests/host-probe-shape.test.mjs` 4/4、`tests/host-probe.test.mjs` 2/2（我实跑 15 pass 合计）。实跑 `node scripts/probe/run-host-probe.mjs` → exit 0，`32/32 checks passed, 1 blocked`（`official-rows-runtime-model-surface`：本 profile 无 LLM 提供方；blocked 不计通过）。 |
| AC-8 文档门禁 | PASS | 我实跑 `node scripts/check-docs.mjs` → `docs: ok`（119 files / 840 tables / 995 links / 136 fragments / 36 controlled），exit 0；清理前 15 条的逐条处置见 `DELIVERY-NOTES.md §10`（r14 DESIGN 4 条、r14 TECHNICAL 8 条去 `#L…` 片段；r15 DESIGN 1 条；r15 PRD:22 与 ACCEPTANCE:70 的本机路径换占位）。`git diff --check` exit 0。 |
| AC-9 死键与 .gitignore | PASS（含 D-1 同源） | `.gitignore:47-48` 为 `artifacts/`、`tarballs/`，既有条目未动；三键接入真实状态：`readiness.public.readonly`（`:1246` 公共参数行下一步）、`readiness.loading`（`:1458` loading 骨架）、`readiness.failed`（`:1507` 读失败横幅）；`draftWarning` 全文 0 命中（zh/en 同删）。未引用 readiness 键计数用例实跑通过（动态前缀 `state.` 等豁免），但 `readiness.state.unchecked` 实际不可达（同 D-1）。`git status --short` 无 `*.tgz`/`dist/`/`logs/`/`artifacts/`/`tarballs/`。 |
| AC-10 交付门禁 | PASS（数字口径见 D-3） | 我实跑 `pnpm check` → **exit 0，tests 2824 / pass 2823 / fail 0 / skipped 1**（唯一 skip 为既有 Windows 8.3 用例，本轮新增 0，≥2783）；`check-docs` 0 error；`host-probe` 2/2；`git diff --check` 干净；forge-devops 437 pass、forge-gitee 259 pass、ui-contract 9 pass、client-shape devops 32 + gitee 10。AC 文中「client-shape ≥71」不成立（D-3），按 AC 自身要求「按实际记录」不宣称该数。 |
| AC-11 证据边界 | PASS（边界成立） | 页面/文档 0 处「企业联调已通过 / 已向企业分发」类结论（仅 PRD/TECHNICAL 条文与 `src/readiness.mjs:21` 注释）；`DEMO-CHG-0042`、`DEMO-WORK-18`、`demo-only-7c3a` 在 `packages/`、`tests/` **0 命中**；七项 NOT RUN 逐项给命令/期望证据/原因（`DELIVERY-NOTES.md §5`），GUI 装载未执行、交主 agent 在隔离 profile `heluo-r16-uat` 按六条判据执行（`§6`）。本轮不据此宣称已装载。 |
| AC-12 范围与保留 | PASS | 13 个未提交修正文件 sha256 **13/13 与我现场复算逐字一致**；两包 `src` 仍零 `spawn(`、零 `shell:true`，`execFile` 仅 `cli-runner.mjs:127`、`gitee-cli.mjs:425`；无新增身份/凭据存储、无 token 注入、写策略默认拒绝不变。代码改动在 `packages/forge-devops`、`packages/forge-gitee`、相关测试、`scripts/probe/host-probe-plugin.mjs`、`tests/host-probe*.test.mjs`、`.gitignore` 与本任务夹内；历史夹只做 AC-8 的最小字面清理。 |

## 3. 本轮亲自实跑（验收侧，全部本机 macOS arm64）

| 命令 | 结果 |
|---|---|
| `pnpm check` | exit 0；tests 2824 / pass 2823 / fail 0 / skipped 1 |
| `node scripts/check-docs.mjs` | `docs: ok`，exit 0 |
| `git diff --check` | exit 0 |
| `node scripts/probe/run-host-probe.mjs` | exit 0；32/32 + 1 blocked |
| `node --test tests/host-probe.test.mjs tests/host-probe-shape.test.mjs tests/ui-contract.test.mjs` | 15 pass / 0 fail（2+4+9） |
| `cd packages/forge-devops && node --test "test/*.test.mjs"` | 437 pass / 0 fail |
| `cd packages/forge-gitee && node --test "test/*.test.mjs"` | 259 pass / 0 fail |
| `node --test packages/forge-devops/test/readiness-section.test.mjs` | 19/19（绿） |
| 同上，`FORGE_DEVOPS_CLIENT=…/probe/head/client.js` | exit 1；19 / 3 pass / 16 fail（红） |
| `node --test packages/forge-devops/test/{readiness,client-shape}.test.mjs` | 12 + 32 pass |
| `node --test packages/forge-gitee/test/client-shape.test.mjs` | 10 pass |
| `sha256sum` 13 个保留文件 | 13/13 与交付记录一致 |

## 4. 偏差与遗留

| ID | 级别 | 位置 | 现象 | 建议 |
|---|---|---|---|---|
| D-1 | P3 非阻断 | `packages/forge-devops/client.js:1351`（`checkDetailOf`） | 未检查态返回 `t('check.unchecked')`「未执行」，与四层证据的「未执行」同词；`readiness.state.unchecked`（"未检查"）永不渲染 | 一行改为 `t('readiness.state.unchecked')` 或「尚未检查」，并在 `readiness-section` 补一条六态词面断言 |
| D-2 | P3 非阻断 | `client.js:1233` / `:1464-1471` | AC-3 要求不可达态「重试与前往账号页」，实际只有重试文案与「刷新」按钮，无账号页入口 | `button` 分支同时渲染 `readiness.nav.guide` 文字（无需新增导航 API） |
| D-3 | 口径 | `PRD.md:77` AC-10 / r15 报告 | 「client-shape ≥71 pass」不可复现：实测 devops 32 + gitee 10 = 42；「71」实为 `git diff --stat` 的 71 行（61+/10−）被沿袭成用例数；HEAD devops 为 29、gitee 无该文件，只增不减成立 | 后续在 r17 PRD 或 memory 更正该数字口径，不再引用 71 |
| E-3 | 证据性质 | AC-5 红跑 | 红跑为 HEAD 副本事后重建（HEAD 无 `ReadinessSection`），失败数/形态与声明一致，但「实现前红」不可证 | 后续轮次把红跑输出当场落盘留痕 |
| E-4 | 已知边界 | `client.js` Key 行 | IAM 不可达时 Key 只能显示「未知」，「四组反例其余行不变」对 Key 行不成立；用例改为其余四行逐字不变 + Key 单独断言（`DELIVERY-NOTES.md §7.1`） | 保持现状：不拿旧值冒充当前状态；若产品要求，改由服务端缓存 last-known 并显式标「过期」 |
| E-5 | 说明 | 文档路径 | 交付说明原占 `ACCEPTANCE.md`，已保留为 `DELIVERY-NOTES.md`（sha256 不变） | 后续轮次 dev 交付说明直接用 `DELIVERY-NOTES.md`，把 `ACCEPTANCE.md` 留给验收阶段 |

## 5. 架构一致性检查（M3）

- **蓝图符合**：`TECHNICAL.md §55` 规定「四层证据放服务端算，客户端只渲染」——落点为 `src/readiness.mjs`（318 行纯函数：`EVIDENCE_LAYERS`/`EVIDENCE_STATES`/`EVIDENCE_REASONS`/`verdictOf`/`buildReadiness`/`projectLayers`），零 IO、零子进程、不读 env/token；`§347` 规定客户端在「三者与证据不一致时按证据重算」——`client.js` 的 `verdictOfEvidence` 属**蓝图规定的防御性重算**，不是私增副本，且 `ui-contract` 已把四层/来源类型/原因/三层键名与 `readiness.mjs` 常量逐字对齐（实跑 9/9）。
- **装配单点**：`index.mjs:387` 的 `withReadiness()` 包住四个快照出口（`:456` GET、`:527` cliSnapshot、`:544`/`:549` 保存成功与失败回读），Gitee 服务端零改动；`?refresh=1` 仍走注入的 `refreshSnapshot()`，发现→重建→同源响应链路未被绕开。
- **无重复实现/适配漂移**：探针三处派发统一 `dispatchTool`；客户端未新增文件系统或进程能力；无新增依赖、路由、身份/凭据存储。未发现「应抽未抽」或破坏既有结构的改动；`client-shape` 旧文案断言收窄（`DELIVERY-NOTES.md §7.2`）是必要的正名，且新增了「enterprise 只许出现在契约名词位」的反向断言。
- **结论**：无结构性返工项，不触发「有条件通过」。

## 6. 未执行（NOT RUN）与交接

1. 真实企业 IAM 联调、生产网关 Key、企业 `dop` 只读探测：NOT RUN（无企业环境与凭据）。
2. 真实浏览器 DOM/Network 安全扫描：NOT RUN（本轮证据来自 hook 运行时与源码/用例）。
3. Windows 与麒麟 aarch64 双端：NOT RUN（平台分支只有单测与静态覆盖）。
4. 两包 tarball 的真实 GUI 装载与回滚：NOT RUN，交主 agent 在隔离 profile `heluo-r16-uat` 执行，判据与命令见 `DELIVERY-NOTES.md §6`（六条：两分区出现、七行齐全、导航或文字降级、`?refresh=1` 仅一次、日志无 `entry not found`/`did not activate`、回滚零残留）。
5. 红跑历史真实性：见 E-3，仅能证明「当前用例对旧组件失败、对新组件通过」。

## 7. 边界与仓库状态

- 未提交、未推送，仍在 `feat/plugin-workflow` @ `0db3c65`；本阶段只新增/改写任务夹内文档（`ACCEPTANCE.md`、`DELIVERY-NOTES.md`）与 `logs/teamflow/tf-mw4y10xm-5q3dff/state/acceptance.json`，未改跟踪文件。
- 13 个保留项 sha256 13/13 未变；`git status` 无构建产物、tarball、日志泄漏。
- `docs/teamflow/memory.md` 本轮不更新：未产生新约定或技术栈决策；已知待办无变化（D-1/D-2/D-3 属本需求后续项，不升格为产品级约定）。

## 8. 给下一轮的最小行动项

1. D-1：`checkDetailOf` 的 unchecked 分支换成独立词 + 一条断言（1 行）。
2. D-2：不可达态补「设置 → 企业账号」文字（1 行，无需新 API）。
3. D-3：更正 client-shape 计数口径，不再引用 71。
4. 按 §6 完成 GUI 装载后，才可对外写「已装载」。

验收结论：✅ 通过

## 9. GUI 装载回填（主 agent，2026-11-06）

§8 第 4 条已执行：在隔离 profile（临时 `DSH_HOME`、`127.0.0.1:48490`、未装日常 `desktop`）按 `DELIVERY-NOTES.md` §6 六条判据实测，**六条全部满足**，记录见同目录 `GUI-VERIFICATION.md`。

- 装载过程中暴露 **P0**：`packages/forge-devops/client.js` 的 `sectionNavigatorOf` 在 try 外读取未声明的 `ctx.settings`，Cordis 直接抛 `cannot get property "settings" without inject`，导致该客户端 entry 判 failed、整个 Web UI 拒绝启动。已修（读入 try）并补 `packages/forge-devops/test/client-inject.test.mjs`（先红后绿，2/2；该包全量 439/439）。
- 交接步骤两处不可行已记录并修正：`@heluo/forge-enterprise` 组合包不含 DevOps/Gitee（判据 1 需直装两包）；`dsh plugin add` 需绝对路径、启动不带 `web` 尾词、空 profile 需先用 `--from-default-profile web` 建模板。
- 该 P0 修复未再走一轮流水线，由主 agent 直接写入并自测，属本轮 AC-11 验证的连带返工，**仍需验收复核**；未提交、未推送。

## 10. P3 收口（主 agent，2026-11-06）

§4 的两条 P3 已修，均先红后绿（红跑用同一份用例指向「只回退本次两行」的副本，`FORGE_DEVOPS_CLIENT` 切换，不改工作区）：

| ID | 修复 | 用例 | 结果 |
|---|---|---|---|
| D-1 | `checkDetailOf` 未检查态改用 `readiness.state.unchecked`（「检查：未检查」），四层证据的 not-run 仍是「未执行」 | `readiness-section.test.mjs`「D-1 未检查态用自己的词」 | 红 1 / 绿 1 |
| D-2 | 身份不可达行在「重新检查」旁同时给出「设置 → 企业账号」文字（不新增导航 API，仍不渲染无响应按钮） | 同文件「D-2 身份不可达：重试之外同时给出账号页文字入口」 | 红 1 / 绿 1 |

- `packages/forge-devops` 全量 441/441 通过（r16 交付时 439，新增 2 条）。
- D-3（client-shape 计数口径，71 系 `git diff --stat` 行数被沿袭）属文档口径，未在本轮改；下次引用改按实测 42（devops 32 + gitee 10）。
- 仍未提交、未推送。

### 10.1 P3 修复上屏复验（真实浏览器，2026-11-09）

环境同 §9（新建一次性 `DSH_HOME`、`127.0.0.1:48491`、隔离 profile，装 `forge-devops` / `forge-gitee` + 补丁层挂 `forge-iam`；日常 `desktop` 未动）。为触发不可达态，按 F12 等价手段在页面内临时让 `/api/forge-iam/view` 请求失败（`window.fetch` 覆盖，读完后立即还原并重载），其余路径全部走真实接口。

| 项 | 屏上文本 | 结论 |
|---|---|---|
| D-1 | `检查：未检查`（同时全文 0 处 `检查：未执行`；四层证据的 not-run 仍为「未执行」） | 与用例一致 |
| D-2 | 不可达时身份行为 `账号服务不可达，请稍后重试 · 设置 → 企业账号` + 「刷新」按钮；恢复后为 `前往企业账号登录 · 设置 → 企业账号` | 与用例一致 |

- 启动日志只有一行 `dsh web: http://127.0.0.1:48491/?token=…`；浏览器控制台零错误；侧栏出现「企业研发 / 企业账号 / 企业 Gitee / 企业 DevOps」四个分区，文案不混排。
- 截图仅留会话内，未入库；不可达态由页内临时故障注入触发，属 UI 复验手段，不能当作企业侧不可达的实测证据。

### 11. 空状态标签修复（真实浏览器反馈，2026-11-09）

用户看屏时指出「所有页面都显示错误」。复现后确认不是错误态，而是一个渲染缺陷：每行状态只画出一个空白灰块，读者只能看到后面的说明文字。

- 根因：`packages/forge-devops/client.js` 的 `Tag` 只读 `props.text`，而就绪表与四层证据用 `h(Tag, …, 状态词)` 以 children 传值。真实 React 里 children 落在 `props.children`，`props.text` 为 undefined，于是 `<span class="fdv-tag">` 永远为空。数据、状态映射与文案都是对的，丢的是标签文字本身。
- 影响面：`readiness` 面板的七行状态与四层证据状态（同文件 1366/1482 两处调用）。早期设置页（786/855）用 `text:` 传值，所以没暴露——这也是既有单测没发现的原因：夹具的 `page.text()` 会拼接 children，看不出真实 React 的丢弃。
- 修复：`Tag` 取 `props.text ?? props.children`，两种写法都认。
- 回归用例：`packages/forge-devops/test/readiness-section.test.mjs` 新增「状态标签必须有字：所有 .fdv-tag 的屏上文本非空」。**必须先红**：把修复回退到 `/tmp` 副本，`FORGE_DEVOPS_CLIENT=… node --test --test-name-pattern='状态标签必须有字'` → fail；修复后 442/442。
- 上屏复验：重建 tarball、一次性 `DSH_HOME`、端口 48492（装 devops/gitee/iam）。四个分区文本逐页读取，标签依次为 `未登录 / 未知 / 未配置 / 未知 / 已配置 / 未执行×4 / 未配置 / 未知`；`企业账号`、`企业 Gitee`、`企业 DevOps` 三页无报错文案，均为「待配置/未配置/自动发现命中」一类真实状态。
- 边界：该修复随工作区未提交；用户日常 profile 里的同款插件需重装新 tarball 才会生效，本轮未动其 profile。
