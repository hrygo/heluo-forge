# QA 报告：r16 r15 企业研发就绪页返工

| 项 | 值 |
|---|---|
| 轮次 | r16（r15 返工：企业研发就绪页七行 + 四层证据 + Key 行） |
| 日期 | 2026-11-06 |
| 分支 / 提交 | `feat/plugin-workflow` @ `0db3c65`（未提交、未推送） |
| 工作区 | clutch worktree `wt_622dc4710a35` |
| 环境 | macOS Darwin arm64、Node v24.13.0、DSH `0.2.1-rc.5` |
| 输入 | `PRD.md`（AC-1～12）、`ACCEPTANCE.md`、`TECHNICAL.md`、dev 交付说明 |
| 结论 | **通过（有 1 条非阻断偏差）**：12 条 AC 全部实测成立；`GUI 装载`按交接口径 NOT RUN，留给主 agent |

## 1. 结论与判定口径

本轮判定以「页面呈现出的事实」为准，不以交付文档自述为准。审核方**自建了独立探针**（自有 hook 运行时与断言，不复用交付用例），并对交付用例做交叉复核：

- **功能层 12/12 通过**：七行顺序、身份六态与各自下一步、Key 五态（三条件齐才「已验证」）、检查四项 + 四层证据 + 六态、过期保留旧结果、迟到回包丢弃、Gitee 零请求、`?refresh=1` 单点、三层来源、导航能力探测与文字降级、死键接线与 zh/en 键集等值，均有可复现实证。
- **唯一偏差（非阻断）**：AC-4 字面要求六态「均有可见文案」，实际「未检查」态渲染为 `检查：未执行`（与证据层的「未执行」同词），`readiness.state.unchecked`（"未检查"）在渲染路径上不可达。其余五态都有独立可见词。页面语义仍可读（未执行 ≠ 未检查 的歧义仅存在于既有词），故记为 D-1 建议修，不作为打回理由。
- **红跑证据为事后重建**：HEAD 里没有 `ReadinessSection`（`git show HEAD:packages/forge-devops/client.js` 共 1021 行、`ReadinessSection` 0 次出现），用 HEAD 物化副本红跑 19 条用例得 `pass 3 / fail 16`，16 条失败点是 `TypeError: Section is not a function`，而不是「旧面板缺行」。失败数与 ACCEPTANCE §3 一致，但这是事后重建而非实现前留痕，**红跑的历史真实性不可证实**（无对应的 r15 提交可对照）。
- **GUI 装载 NOT RUN**：按 AC-11 交回主 agent，用隔离 profile `heluo-r16-uat` 执行；本报告不据此宣称「已装载」。

## 2. 验收对照（AC-1～12）

状态口径：PASS＝有可复现实证且满足条文；PARTIAL＝部分子项成立；FAIL＝条文未满足；NOT RUN＝本轮未执行或证据不足。

| AC | 结论 | 证据与说明 |
|---|---|---|
| AC-1 导航唯一 | **PASS** | 探针以 `ctx.settings.openSection/selectSection` 注入分区切换能力时，页面只有唯一「前往企业账号」按钮，apply 期导航探测命中并 `navigate('forge-iam')`；能力缺失时降级为「设置 → 企业账号」文字，无死按钮。`client.js` 全文无复制登录/退出/onboarding/网关凭据/模型设置入口（`grep` 仅命中就绪页文案键与导航 handler，无表单与凭据输入）。zh/en 键集探针比对 100+ 键逐字等值，`draftWarning` 死键已删。 |
| AC-2 Key 行五态 | **PASS** | `keyStateOf`（`client.js:981`）三条件 `configured && matchesAccount===true && modelAccess.state==='ready'` 才「已验证」；四组反例用例独立存在。「未配置 / 已配置·未验证 / 已验证 / 未知（无法判定）/ 未安装（404）」五态齐全；四组反例中出资质缺失时其余六行逐字不变（探针反例③复验）。已知偏差：IAM 服务不可达时 Key 显示「未知」，此时「其余行不变」对 Key 不成立（ACCEPTANCE §7 已声明，属根因已定位的边界）。 |
| AC-3 身份六态 | **PASS** | `IAM_STATE_OF`（`client.js:107-113`）把未列出 state 与 `error` 一律映射「退出未确认」（`signedOutUnknown`），不回落「未登录/未知」；六态各有下一步文案（前往企业账号登录 / 返回账号页等待 / 已就绪 / 已过期重登 / 稍后重试 / 核对是否已退出）。迟到 IAM 回包由 `readSeq` 代次丢弃：探针构造两轮并发刷新、旧 ready 最后到达，最终仍只显示「未登录」。 |
| AC-4 检查四层证据 | **PASS（含 D-1）** | 四项（基准 `rev-abcd` 前 8 位 / 时间 / 对象 `DevOps` / 来源类型「本地诊断」）与四层证据（文件存在：通过·文件系统只读探测；可启动：未通过·入口不可执行；目标可识别：通过·配置形状；只读可访问：未执行·需要确认·策略准入（未发起真实请求））同屏可见。换基准后「已过期」并保留旧四项与旧证据；迟到检查（快速双击、旧检查后到）由 `checkSeq` 丢弃，结论取自后发基准。Gitee 按钮 `disabled:true` 且无 handler，探针确认零请求；`?refresh=1` 仅由「检查 DevOps」发出（一次）。六态见 D-1。 |
| AC-5 先红后绿 | **PASS（重建）** | `readiness-section.test.mjs` 19 条。对 HEAD 物化副本：`tests 19 / pass 3 / fail 16 / skipped 0`；当前源码：`19 / 19 / 0 / 0`。红跑为事后重建，见 §1 与 §6 的诚实边界。 |
| AC-6 三层来源 | **PASS** | 三层折叠区（生效来源 / 公共参数 / 本机覆盖 / 最终生效 + 插件名版本与缺层原因）与探针观察一致；`projectLayers` 为服务端单点投影，`rowForReadiness`（`cli-access.mjs:281`）只返回原始两层、不缓存不合并。 |
| AC-7 探针单次契约 | **PASS** | `scripts/probe/host-probe-plugin.mjs` 三处派发均走 `dispatchTool(ctx, name, args, {signal, callId})`（对象形参）；`tests/host-probe.test.mjs` 2/2；`tests/host-probe-shape.test.mjs` 通过；实跑 `node scripts/probe/run-host-probe.mjs` → exit 0，`32/32 checks passed, 1 blocked`（`official-rows-runtime-model-surface`：本 profile 无可用 LLM 提供方，阻塞项与 ACCEPTANCE 一致）。 |
| AC-8 文档门禁 | **PASS** | `node scripts/check-docs.mjs` → `docs: ok`（118 files / 835 tables / 995 links），exit 0；15 条历史清理抽样确认（r14 DESIGN 非 Markdown 片段链接已去掉、r14 TECHNICAL 链接改为 `<路径>`、r15 PRD:22 改为 `DSH_HOME=<profile 根目录>`、r15 ACCEPTANCE:70 改占位）。 |
| AC-9 死键与 .gitignore | **PASS** | `.gitignore:47-48` 为 `artifacts/`、`tarballs/`；四个 readiness 死键三接一删：`public.readonly`、`loading`、`failed` 均有可见文案（探针分别验证），`draftWarning` 两字典均不存在；`git status` 无 `.tgz`/`dist/`/`logs/`/`artifacts/`/`tarballs/` 泄漏。 |
| AC-10 门禁 | **PASS** | `pnpm check` → exit 0，`tests 2824 / pass 2823 / fail 0 / skipped 1`（skip 为既有的 1 条，非本轮新增）；`git diff --check` exit 0。 |
| AC-11 NOT RUN 边界 | **PASS（边界成立）** | 页面与文档中「企业联调已通过 / 已向企业分发 / 企业已验证」只出现在反面目标、注释与「0 次」守卫用例里，`client.js` 0 处；`DEMO-CHG-0042`/`DEMO-WORK-18`/`demo-only-7c3a` 在 `packages/`、`tests/` 0 命中。七项 NOT RUN 逐项有命令与原因；GUI 装载未执行、已写交接判据。 |
| AC-12 范围锁定 | **PASS** | ACCEPTANCE §8 的 13 个未提交修正文件 sha256 **13/13 逐一复核一致**；用 mtime 做时间分离，r16 写入集中在 11-06 **20:52–21:17**，与 dev 报告的 `extra.touched` 逐项对应，窗口内**没有声明之外的写入**（18:42–19:45 为 r13/r14/r15 早轮未提交改动，11-04/11-05 为保留项）。两包 `src` 无 `child_process` 的 `spawn/exec/shell:true`（仅有 `String.prototype.exec` 正则），`execFile` 唯一出口 `cli-runner.mjs:28`。 |

## 3. 偏差与缺陷

| ID | 级别 | 位置 | 现象 | 影响与建议 |
|---|---|---|---|---|
| D-1 | P3（非阻断） | `packages/forge-devops/client.js`（`checkDetailOf` 的 `unchecked` 分支） | AC-4 要求六态均有可见文案；「未检查」渲染为「检查：未执行」，`readiness.state.unchecked`（"未检查"）不进入渲染路径 | 语义上「未执行」可读，但与证据层同词，用户可能把「检查没跑」与「层未执行」混淆。建议 `unchecked` 分支改用 `readiness.state.unchecked` 或给出「尚未检查」独立词，并补一条断言 |
| D-2 | 提示（非缺陷） | `client.js` `verdictOfEvidence` 与服务端 `src/readiness.mjs` `verdictOf` | 两端各实现一次结论算法（浏览器不能 import 服务端 src） | 当前等价（fail→fail、not-run→incomplete、全 pass→pass）；`tests/ui-contract` 只钉常量不钉算法。若后续改判定优先级，两处需同步，建议在 ui-contract 增加一组「同一证据两端同结论」的固定表 |
| D-3 | 提示（证据性质） | AC-5 红跑 | 红跑用 HEAD 物化副本重建，失败点为 `TypeError: Section is not a function`（HEAD 无该组件），非「旧面板缺行」 | 交付声明未夸大；但「实现前红」不可考。建议后续轮次把红跑输出当场留存为日志文件，避免只能事后重建 |

## 4. 独立探针

| 项 | 值 |
|---|---|
| 路径 | `logs/teamflow/tf-mw4y10xm-5q3dff/scripts/qa-r16-readiness-probe.mjs` |
| 方式 | 自有 mini React hook 运行时 + 自写断言；`loadClient` 以宿主 `__ModuleLoader__` 形状装载 `client.js`，注入 `settings` 服务、locale 收集器与可编排 fetch |
| 结果 | `44 passed, 0 failed, 1 deviation`，exit 0 |
| 覆盖 | 七行顺序与固定声明、身份八例、Key 五态与三条件、导航能力/降级与 apply 期探测、检查四项 + 四层证据、六态可见词、过期保留、迟到 IAM/迟到检查丢弃、Gitee 零请求、`?refresh=1` 单点、三层来源、脱敏（无路径/URL/token/邮箱）、zh/en 键集、三源全失败降级 |
| 说明 | 探针开发中修掉的三处均为探针自身问题（裸 body 未归一 200、行定位 `startsWith`、deferred 检查态），不是产品缺陷 |

## 5. 门禁实跑（本 QA 亲自执行）

| 命令 | 结果 |
|---|---|
| `node scripts/check-docs.mjs` | docs: ok，118 files / 835 tables / 995 links，exit 0 |
| `git diff --check` | exit 0 |
| `cd packages/forge-devops && node --test "test/*.test.mjs"` | 437 pass / 0 fail |
| `cd packages/forge-gitee && node --test "test/*.test.mjs"` | 259 pass / 0 fail |
| `node --test tests/host-probe.test.mjs` | 2/2 pass |
| `node --test tests/host-probe-shape.test.mjs tests/ui-contract.test.mjs` | 13 pass（ui-contract 9） |
| `node scripts/probe/run-host-probe.mjs` | exit 0，32/32 + 1 blocked |
| `pnpm check` | exit 0，tests 2824 / pass 2823 / fail 0 / skipped 1 |
| `node --test packages/forge-devops/test/{readiness,readiness-section,client-shape}.test.mjs` | 63 pass |
| `FORGE_DEVOPS_CLIENT=…/probe/head/client.js node --test …/readiness-section.test.mjs` | 19 tests / 3 pass / 16 fail（红） |
| `node --test …/readiness-section.test.mjs`（当前源码） | 19/19（绿） |
| `node logs/teamflow/tf-mw4y10xm-5q3dff/scripts/qa-r16-readiness-probe.mjs` | 44 passed / 0 failed / 1 deviation |

## 6. 未执行与限制

1. **真实企业 IAM 联调、生产网关 Key、企业 DevOps/Gitee 只读探测**：NOT RUN，本轮只用夹具与契约形状。
2. **真实浏览器 DOM/Network 扫描**：NOT RUN，页面证据来自自建 hook 运行时；宿主 `settings.section` 切换的公开 API 只在注入替身上验证。
3. **Windows / 麒麟 aarch64 双端**：NOT RUN，平台分支仅由 `platform` 注入用例覆盖。
4. **tarball 装载与宿主 GUI 出现**：NOT RUN，见 §7 交接。
5. **红跑历史真实性**：见 D-3；不接受「实现前红跑」的推断性表述。

## 7. 交接：GUI 装载（主 agent 执行）

在隔离 profile `heluo-r16-uat` 中：装 `packages/forge-devops`、`packages/forge-gitee` 两个 tarball → 启动宿主 → 判据：

- 「企业研发」「企业 Gitee」两个分区出现（`order` 29 与 50）；
- 就绪页七行齐全，身份行有按钮或「设置 → 企业账号」文字降级；
- 点「检查 DevOps」恰好一次 `?refresh=1`，Gitee 无请求；
- 启动日志无 `entry not found` / `did not activate`；
- 回滚后零残留（`logs/`、`artifacts/` 不进入仓库）。

## 8. 建议

1. 修 D-1（一行 + 一条断言），或在 ACCEPTANCE 中显式接受「未执行」作为六态之一的可读词。
2. 给 ui-contract 增加两端 `verdict` 固定表（D-2）。
3. 下一轮把红跑输出落盘留证（D-3），避免只能重建。
4. 按 §7 完成 GUI 交接后再写「已装载」；本轮不据此宣布 GUI 通过。
