<!-- meta: summary="补齐企业研发准备总览的真实状态、下一步与检查证据，并修复文档门禁、探针执行形状与仓库卫生，使 r15 打回项闭环。" -->

基线依赖：docs/teamflow/20261106-r15-enterprise-iam-ui/（其 AC-1～AC-21 已确立的行为不得回退；该夹自身基线为 docs/teamflow/20261106-r14-enterprise-iam-ui/）。

# 企业研发准备总览补齐与交付门禁修复（r16 返工）

## 1. 背景与目标

### 1.1 为什么返工

r15（`docs/teamflow/20261106-r15-enterprise-iam-ui/`）的验收结论为不通过，见 [r15 验收报告](../20261106-r15-enterprise-iam-ui/ACCEPTANCE.md)。打回项如下，本轮按条闭环，不重写 r15 的方案：

- **P0 D-2（AC-1/2/3/9/10/13）**：`packages/forge-devops/client.js` 的 `ReadinessSection` 未按 r15 DESIGN §3.1 落表——缺「前往企业账号」导航、缺「Key 已配置但未验证」独立行、身份「退出未知」落到通用 unknown、六态无各自下一步、检查结果未上屏基准/对象/来源/四层证据，且该组件零渲染交互用例。
- **P1 D-1**：`node scripts/check-docs.mjs` 报 14 errors（本轮复测 15 条，见 1.2），其中含本任务夹自身的非 Markdown 片段与本机绝对路径。
- **P2 D-3（AC-4/9）**：汇总页只列本机覆盖键名，未上屏三层来源与检查四项。
- **P2 D-4（AC-20）**：`tests/host-probe.test.mjs` 两项失败，根因在 `scripts/probe/host-probe-plugin.mjs:90-91` 以 `{calls:[...]}` 调用 `ctx.tools.execute` 后读 `batch.results[0]`，与宿主单次执行契约不符。
- **P3 D-5**：`.gitignore` 未显式覆盖 `artifacts/`、`tarballs/`；四个 readiness 文案键无人引用。

### 1.2 本轮起点实测（不复用旧绿灯）

- `node scripts/check-docs.mjs`：`docs: 15 error(s)`。分布为 r14 任务夹 12 条（均为非 Markdown 目标上的片段），r15 任务夹 3 条（`DESIGN.md:8` 片段、`PRD.md:22` 本机绝对路径、`ACCEPTANCE.md:70` 复述同一路径）。比验收报告的 14 条多出的 1 条来自 r15 验收报告成文后的复述行，AC-8 的 0 error 必须一并覆盖。
- `node --test tests/host-probe.test.mjs`：2 项失败，抛点指向探针执行形状。
- r15 QA 记录的其余数字：`pnpm check` 2783 总数 / 2780 pass / 2 fail / 1 skipped；forge-devops 404 pass、forge-gitee 259 pass、client-shape 71 pass、ui-contract 6 pass。本轮以复跑为准。

### 1.3 目标

- **G1 互不推导**：七行总览中每一行只反映自己的来源与状态；任何一行不得用另一行的绿灯、固定声明句或默认值冒充。
- **G2 状态可行动**：身份六态、Key 五态、检查六态各有独立文案与下一步；未知与退出未确认不得被画成未配置。
- **G3 检查可核对**：每次检查带基准、时间、对象、来源类型与四层证据，过期与迟到可判别。
- **G4 门禁真实全绿**：文档 0 error、探针 2/2 与 31/32 + 1 blocked、`pnpm check` 全绿且用例只增不减。
- **G5 证据不越界**：真实企业联调与 GUI 装载明确 NOT RUN，交接给主 agent，不写进本轮已验证。

### 1.4 产品语义（一句话）

「企业研发」是只读的接入体检页：每一行回答“这一项现在是什么状态、依据是什么、下一步去哪”，页面不写配置、不代持凭据、不把离线夹具说成企业证据。

## 2. 用户故事与验收标准

AC 只属于本需求，从 AC-1 编号；每条均可在离线 fixture 下自动验证，真实企业证据按 AC-11 单列 NOT RUN。

### 故事 A：研发者看到完整且互不推导的准备总览（P0）

作为企业研发者，我打开「设置 → 企业研发」时想看到身份、参数、本机配置、Key、DevOps、Gitee、写权限各自真实的状态与下一步，而不是一段固定声明；这样我不用猜是哪一项拖住了接入。

| 编号 | 优先级 | 验收标准（可测） |
|---|---|---|
| AC-1 | P0 | 「企业身份」行有且仅有一个「前往企业账号」动作：宿主 `ctx.settings` 公开分区切换能力可用时，点击切到既有 `settings.section` `forge-iam`（label「企业账号」），断言目标 id、同页切换、不新开窗口、不写会话；能力不可用时渲染「设置 → 企业账号」可见文字指引，且不渲染点击无响应的按钮。除导航外，本分区复制登录、退出、onboarding、网关凭据、模型设置入口的数量为 0。zh/en 文案键集逐字等值。 |
| AC-2 | P0 | Key（个人网关凭据）独立成行，状态只取 `/api/forge-iam/view` 的非敏感字段（`gatewayCredential.state`、`matchesAccount`、`modelAccess.state`），至少五态：未配置 / 已配置·未验证 / 已验证 / 未知 / 未安装（404），每态有独立文案与下一步。`gatewayCredential.state` 为已配置而 `matchesAccount` 非 true 时必须显示「已配置·未验证」，不得显示「已验证」。固定声明句仍须存在，但与 Key 行状态分开断言，不得互相替代。四组反例各有独立用例并断言其余行不变：①身份已登录、CLI 未配置；②CLI 可读、身份未登录；③Key 已配置未验证；④检查通过、写门禁关闭。页面与文档出现「企业联调已通过」类结论 0 处。 |
| AC-3 | P0 | 身份覆盖六态：未登录（`unconfigured`/`signed-out`）、登录中（`authenticating`）、已登录（`ready`）、过期（`expired`）、不可达（`unreachable`）、退出未确认（`error` 及未列出的 state）；「退出未确认」是独立状态词，不得落回通用 unknown，也不得渲染成未登录或未配置。六态各有可见下一步：未登录→前往企业账号；登录中→返回账号页；已登录→前往企业账号；过期→前往企业账号；不可达→重试与前往账号页；退出未确认→前往账号页核对。迟到回包用例：先 ready，再 signed-out，旧 ready 最后到达，最终只显示未登录，且不清空既有记录、不改写 Key/CLI/写权限行。IAM 不可达时本机配置仍可读，IAM 写请求计数 0。 |
| AC-4 | P0 | 检查结果上屏四项：配置基准短号（revision 前 8 位）、检查时间、检查对象（DevOps）、来源类型（本地诊断/夹具/企业真实证据，取不到显示未知）；同时逐层显示四层证据：文件存在 / 可启动 / 目标可识别 / 只读可访问，每层为通过/未通过/未执行 + 原因，不得用单一 ready 或固定声明句替代。检查状态六态（未检查/检查中/通过/失败/未知/已过期）均有可见文案；基准 revision 与当前快照不一致时标「已过期」并保留旧结果；旧检查回包晚于新检查到达时被丢弃。Gitee 行不发请求，检查按钮禁用并显示「未执行·未获批准的只读探测」。检查写配置 0 次；`?refresh=1` 只由「检查 DevOps」发出，「刷新」不带。 |
| AC-5 | P0 | 先失败后实现：新增 `packages/forge-devops/test/readiness-section.test.mjs`，至少覆盖四组反例逐组（含其余行不变）、六态与各自下一步、迟到 IAM 回包与迟到检查回包丢弃、导航存在与降级、固定声明文案、Key 五态映射、检查四项与四层证据上屏、过期标记、Gitee 检查禁用。用例在实现前运行必须失败，交付说明记录红→绿两次运行（命令、时间、失败/通过摘要）或等价的两次提交；既有 `client-shape`/`ui-contract` 断言只增不减，本轮新增 skip 0。 |

### 故事 B：维护者能核对“为什么生效、检查凭什么”（P2）

作为维护者，我想知道某个参数为什么生效、最近一次检查基于哪个基准、用了什么来源与哪几层证据，这样我能判断页面上的绿灯是否可信。

| 编号 | 优先级 | 验收标准（可测） |
|---|---|---|
| AC-6 | P2 | 汇总页不止列本机覆盖键名：DevOps 与 Gitee 各显示生效来源枚举（配置/环境变量/自动发现/未知）与被本机覆盖的键名；展开后按「公共参数（inherited）→ 本机覆盖（override）→ 最终生效（value）」展示来源名称与版本标识，缺层显示「未知 + 阻塞原因」，不得用默认值冒充。每条检查结果同屏显示四项：配置基准 revision、检查时间、检查对象、来源类型（与 AC-4 同源，不另建副本）。 |

### 故事 C：探针在真实工具契约下可信（P2）

作为宿主升级后的维护者，我想让探针按真实工具契约跑通并如实报告 blocked，这样回归红绿灯不再长期失真。

| 编号 | 优先级 | 验收标准（可测） |
|---|---|---|
| AC-7 | P2 | 探针执行形状修复：先补失败用例，断言探针按宿主 `ctx.tools.execute` 当前单次调用契约执行并消费单个结果（当前 `{calls:[...]}` 加 `batch.results[0]` 形状应使用例失败）；再改 `scripts/probe/host-probe-plugin.mjs` 及同型派发点为单次调用、一次一结果。完成后 `node --test tests/host-probe.test.mjs` 2/2 pass；探针运行 ≥31/32 checks passed、0 FAIL、1 blocked（`official-rows-runtime-model-surface`，原因：本 profile 无 LLM 提供方），blocked 须写明名称与原因，不得计为通过；既有 exit 0、摘要正则、无 FAIL 断言不得删除或放宽，skip 仅限既有 PATH 门控。 |

### 故事 D：交付门禁真实变绿（P1）

作为交付者，我想让文档门禁、测试与仓库卫生真实全绿，这样验收不会因 15 条文档错误或 2 条探针失败被打回。

| 编号 | 优先级 | 验收标准（可测） |
|---|---|---|
| AC-8 | P1 | `node scripts/check-docs.mjs` 输出 `docs: 0 error(s)`、exit 0。按本轮实测共 15 条处置：r14 任务夹 12 条、r15 任务夹 3 条（`DESIGN.md:8` 非 Markdown 目标片段、`PRD.md:22` 本机绝对路径、`ACCEPTANCE.md:70` 复述同一路径），r16 新写文档 0 条。历史夹只做最小字面清理（去掉非 Markdown 目标上的片段，或把绝对路径换成占位），不改结论、证据与链接语义，并在交付说明逐条列文件、行与改法。`git diff --check` exit 0，除上述字面修改外无链接或表格数量意外减少。 |
| AC-9 | P2 | `.gitignore` 增加 `artifacts/`、`tarballs/`，保留既有 `node_modules/`、`.pnpm-store/`、`dist/`、`build/`、`coverage/`、`output/`、`*.tgz`、`logs/`；`git status --short` 不出现 `*.tgz`、`dist/`、`logs/`、`artifacts/`。四个未引用文案键逐个处置：`readiness.public.readonly`、`readiness.loading`、`readiness.failed` 接入真实状态，`readiness.draftWarning` 在无草稿提示时 zh/en 同步删除；处理后 zh/en 键集逐字等值、未引用 readiness 键计数 0。 |
| AC-10 | P0 | 交付门禁实跑：`pnpm check` exit 0，`node --test` 总数 ≥2783、失败 0、新增 skip 0；`node scripts/check-docs.mjs` 0 error；`node --test tests/host-probe.test.mjs` 2/2；`git diff --check` 干净。r15 已 PASS 项不回退：forge-devops ≥404 pass、forge-gitee ≥259 pass、client-shape ≥71 pass、ui-contract ≥6 pass、形态/补丁层/构建用例全绿。任一数字不达标按实际记录，不得宣称全绿。 |

### 故事 E：证据与范围边界守得住（P1）

作为安全与范围负责人，我想看到未验证项被明确标 NOT RUN、范围外文件未被顺手改，这样离线绿灯不会被误读成企业已验证。

| 编号 | 优先级 | 验收标准（可测） |
|---|---|---|
| AC-11 | P1 | 证据边界：真实 IAM 企业联调、生产凭据存储、企业 Gitee/DevOps CLI 只读探测、Windows 与麒麟 aarch64 双端、真实浏览器 DOM/Network 安全扫描本轮均不执行，逐项标 NOT RUN 并给命令、期望证据与未执行原因；Mock/夹具结果不得写成企业已验证，页面、文档、交付说明出现「企业联调已通过」「已向企业分发」类结论 0 处；`DEMO-CHG-0042`、`DEMO-WORK-18`、`demo-only-7c3a` 在 `packages/`、`tests/` 与两包 tarball 解包全文 0 命中。GUI 装载证据本轮不执行，改为与主 agent 交接：在隔离 profile（建议 `heluo-r16-uat`）装两个 tarball、启动宿主、截图或 aria 证明「企业研发」「企业 Gitee」出现、启动日志无 `entry not found` 或 `did not activate`、随后回滚；交接文档写清命令与判据，本轮不装日常 desktop profile、不伪造截图。 |
| AC-12 | P1 | 范围与保留：代码改动只落在 `packages/forge-devops`、`packages/forge-gitee`、相关测试与本任务夹；D-4/D-5 指定的 `scripts/probe/host-probe-plugin.mjs`、`tests/host-probe.test.mjs`、`.gitignore` 除外，不扩大到其他包。历史任务夹仅 AC-8 的最小字面清理。`demos/`、`scripts/probe/iam-review-memory-credentials.mjs`、`scripts/lib/dsh-version.mjs`、`tests/dsh-version.test.mjs` 的未提交修正原样保留（前后 sha256 一致）。不新建身份或凭据存储、不自动向 CLI 注入 IAM token、不放开真实写；两包 `src` 仍零 `spawn(`/`exec(`/`shell:true`，唯一 `execFile` 出口、固定 argv 白名单、超时与 1MiB 上限、策略默认拒绝均不变。 |

## 3. 范围与非目标

### 3.1 范围

- `packages/forge-devops/client.js`：`ReadinessSection` 的导航、Key 行、六态下一步、检查四项与四层证据、过期与迟到处理、zh/en 文案。
- `packages/forge-devops` 的检查结果与快照投影（如需补字段），以及读取 `/api/forge-iam/view` 的非敏感字段映射。
- `packages/forge-gitee` 汇总侧的三层来源展示（若其快照字段不足以支撑 inherited 层，只补投影，不改 CLI 行为）。
- 新增 `packages/forge-devops/test/readiness-section.test.mjs`；扩展现有 `client-shape`、`ui-contract` 断言；新增/调整 `tests/host-probe.test.mjs` 与探针实现。
- `.gitignore`；r16 任务夹文档；r14/r15 历史任务夹按 AC-8 的最小字面清理。

### 3.2 非目标

- 不重写 r15 的 DESIGN/TECHNICAL；Key 独立行以设计增补记录，不改 r15 六行结论。
- 不新建身份、凭据或会话存储；不新增路由、登录流程或 IAM 写接口。
- 不做真实 IAM 企业联调、生产凭据注入、企业 CLI 只读探测、Windows/麒麟双端验证。
- 不放开任何真实写能力（merge、close、release、workflow、change done 等仍禁）。
- 不向 CLI 注入 IAM token；不在页面展示配置值、endpoint、凭据或本机路径。
- 不装或修改日常 desktop profile；本轮不做真实 GUI 装载取证，只交接给主 agent。
- 不做视觉改版或信息架构重构，除 Key 独立行与检查四项/四层证据上屏所必需。
- 不新增第三方依赖，不升级 Node、DSH 或 pnpm。

## 4. 反面目标

以下任一情况发生，即使 `pnpm check` 全绿，也应判本需求不通过：

1. **用固定声明句盖住真实状态**：Key 行或身份行的状态文字与声明句相同、检查结果区只剩一段“本页只读”的说明，而四层证据一行都没渲染；人工打开页面无法从行中判断“Key 到底验没验”。
2. **把「已配置·未验证」并进「已验证」的绿点**：只看 `gatewayCredential.state` 是否已配置就显示已验证，或把 `matchesAccount` 不明的情况默认成已验证；用户据此以为模型可用。
3. **把「退出未确认」画成未登录**：本地退出回执丢失时显示“未登录”，用户以为账号已退出，实际会话可能仍有效；或把该态落回通用 unknown，下一步不可见。
4. **旧回包复活绿灯**：退出后旧的 ready 响应、或换基准后旧的检查回包到达，页面重新显示已登录/已通过；当前基准与展示结论不一致且没有过期标记。
5. **为让门禁变绿而削弱证据**：删断言、加 skip、把 31/32 + 1 blocked 写成“32/32 通过”，或把 15 条文档错误降级为 warning；数字好看但回归网破了。

## 5. 交互流程摘要

1. 打开「设置 → 企业研发」，并行读取三源：IAM `/api/forge-iam/view`、DevOps CLI 快照、Gitee `/api/forge-gitee/config`。任一源失败只改该行，不把整页回退成“未配置”。
2. 渲染七行：企业身份、公共参数、本机配置、Key、DevOps、Gitee、业务写权限。Key 独立行建议紧随本机配置，最终位置以设计增补为准。
3. 每行显示状态词 + 一句依据 + 下一步动作；非正常态必须有可见下一步，正常态可只保留导航。
4. 身份行：状态、下一步、「前往企业账号」。点击按 AC-1 切换或降级为文字指引。
5. 本机配置行：两插件生效来源枚举与被覆盖键名；展开显示三层来源。公共参数与检查四项同屏可读。
6. Key 行：五态 + 下一步（配置、验证、前往账号页核对）。状态只来自 IAM view 的非敏感字段，不读凭据值。
7. DevOps 行：检查状态 + 「检查 DevOps」。检查中显示进度；完成后显示基准短号、时间、对象、来源类型与四层证据；基准变化时旧结果标已过期。
8. Gitee 行：状态 + 禁用的检查按钮 + 「未执行·未获批准的只读探测」原因；不发请求。
9. 业务写权限行：默认关闭 + 原因；无“开启”入口。
10. 顶部固定声明句保留，仅作页面性质说明，不承担任何行状态。
11. 底部「刷新」重读三源，不触发 `?refresh=1`；只有「检查 DevOps」触发重扫。
12. 任一读失败：该行显示类别与下一步，不显示原始 message、errno、退出码、路径或 endpoint。

## 6. 优先级

| 级别 | 覆盖 | 判定理由 |
|---|---|---|
| P0 | AC-1～AC-5、AC-10 | r15 P0 打回项 D-2 的正面条文；门禁不绿则本轮不可交付。 |
| P1 | AC-8、AC-11、AC-12 | 文档 0 error、证据边界与范围保全是验收打回项，缺失即不可验收。 |
| P2 | AC-6、AC-7、AC-9 | r15 P2/P3 项，影响可信度与仓库卫生；可在 P0/P1 之后完成，但不得遗留为未说明。 |

## 7. 依赖与风险

- **依赖 r15 DESIGN §3.1/§3.2/§3.3 与 TECHNICAL 的字段口径**：六态、四层证据、基准与过期、来源类型均以既有设计为准；Key 独立行是 AC-2 第③组的落地，设计阶段以增补记录，不改六行结论。
- **依赖 IAM view 的非敏感字段**：`gatewayCredential.state`、`matchesAccount`、`modelAccess.state` 当前由 observer/service 投影；实现前先核对 `packages/forge-iam/src/routes.mjs` 的实际字段，语义不符则先改设计再实现，不得从 CLI 状态反推 Key 已验证。
- **检查四项与四层证据可能缺数据**：现有检查结果只有 state/at/basis/reason，四层证据与来源类型需投影补齐；缺项一律显示「未知/未执行 + 原因」，不得用默认通过或检查时间冒充。
- **三层来源在 DevOps 侧可能不全**：Gitee 快照已有 origin/value/overrides/inherited；DevOps 快照可能没有 inherited 层。缺层显示「未知 + 阻塞原因」，不为凑三层伪造默认值。
- **探针 blocked 项是环境结果**：`official-rows-runtime-model-surface` 因本 profile 无 LLM 提供方而 blocked；如实记录名称与原因，不重试到“通过”，也不删除该检查。
- **文档 0 error 需触碰历史任务夹**：r14 12 条与 r15 3 条只做字面清理；若“任务夹不可变”被严格执行，0 error 将不可达，需按待澄清第 1 条降级并书面说明。
- **工作区与宿主状态块不一致**：宿主记录主仓分支与 6 处未提交改动，当前 worktree 为 `feat/plugin-workflow` 且改动更多；默认在当前 worktree 交付，落点错误会导致主 agent 找不到产物，见待澄清第 2 条。
- **UI 用例是假 Loader/假 React/假 fetch**：只能证明组件状态机与渲染输出，不能证明真实浏览器 DOM/Network；真实浏览器证据标 NOT RUN，不以单测代替。
- **Key 行可能带出敏感信息**：只允许枚举、布尔与状态词；测试断言页面、复制诊断、快照中不出现值、token、endpoint、路径。

## 8. 里程碑建议

| 里程碑 | 内容 | 退出条件 |
|---|---|---|
| M1 红 | 写 `readiness-section.test.mjs` 与 host-probe 形状用例，覆盖 AC-1～AC-5、AC-7 | 用例因缺实现/形状不符而失败，记录红跑命令与摘要；无新增 skip |
| M2 总览 | 实现导航、七行、六态下一步、Key 五态、迟到与不可达处理 | AC-1～AC-4 绿；AC-5 红→绿证据齐 |
| M3 核对 | 三层来源、检查四项与四层证据、过期标记 | AC-6 绿；缺层显示未知且有用例 |
| M4 门禁 | 探针形状、15 条文档清理、`.gitignore` 与死键、全量门禁 | AC-7～AC-10 全绿；红→绿证据与逐条文档清单入交付说明 |
| M5 收口 | NOT RUN 清单、GUI 交接、范围与保留校验、最终 diff 审阅 | AC-11/AC-12 绿；交接文档含命令与判据；未提交修正哈希未变 |

## 9. 工程约束

1. **工作区**：在当前 worktree `wt_622dc4710a35`、分支 `feat/plugin-workflow`（HEAD `0db3c65`）上实施；不切换分支、不新建分支、不合并、不推送远端、不打标签。若主 agent 判定以主仓为准，先迁移任务夹与改动再重跑验证（见待澄清第 2 条）。
2. **提交**：本轮无显式 commit/tag 指令；不自行提交、不改写历史；产物与验证证据由主流程收口。
3. **未提交改动**：`demos/`、`scripts/probe/iam-review-memory-credentials.mjs`、`scripts/lib/dsh-version.mjs`、`tests/dsh-version.test.mjs` 的现有修正原样保留；开始与结束各记一次 sha256，不在其上叠加无关修改。
4. **profile 边界**：不改日常 desktop profile、不向其安装任何插件；上一轮“装进日常 profile”的待办作废。GUI 装载证据由主 agent 在隔离 profile 内补，建议名 `heluo-r16-uat`；本流水线只交交接文档，不伪造截图。
5. **工具链**：Node 按 `.node-version` 与 `package.json`，不升级全局环境；不新增依赖；`pnpm check` 从仓库根执行。
6. **`.gitignore` 审计（pnpm monorepo）**：保留 `node_modules/`、`.pnpm-store/`、`dist/`、`build/`、`coverage/`、`output/`、`*.tgz`、`logs/`；新增 `artifacts/`、`tarballs/`；确认本地环境文件与编辑器目录已被既有规则覆盖，不把真实凭据、日志、tarball 纳入版本库。
7. **文档落点**：只写 `docs/teamflow/20261106-r16-r15-iam-readiness-rework/`；不改 `AGENTS.md`；不写宿主 `docs/<role>/`；不在项目根散落日志。历史任务夹只做 AC-8 的最小字面清理。
8. **安全**：零真实凭据与真实用户数据；示例用占位；复制诊断只含插件名、状态词、原因码、时间、基准短号、来源类型；tarball 解包全文扫描 demo 标识与路径。
9. **验证记录**：每条门禁写命令、时间、结果与未验项；失败如实记录，不以“环境问题”跳过；`git diff --check` 与敏感扫描按仓库约定执行。

## 10. 假设与待澄清

- **待澄清 1（事实）**：r15 验收报告自身复述了 `PRD.md:22` 的本机绝对路径，使 check-docs 多出第 15 条错误；历史任务夹“不可变”与 AC-8 的 0 error 目标冲突。建议默认：允许对该复述行做脱敏最小改写（只把绝对路径换占位，不改结论与证据），与 r14/r15 其余 14 条同法清理；若不允许，AC-8 只能到 1 error，需把目标改为“15 条中 14 条修复 + 1 条例外记录”，并由验收方书面接受。
- **待澄清 2（事实）**：宿主状态块写主仓分支 `docs/devops-stage-handoff`、6 处未提交改动并已建 r16 空夹；当前 worktree 是 `feat/plugin-workflow`、38 处改动且 r16 夹需新建。建议默认：以当前 worktree 为准交付，不切换、不合并，状态块视为跨 worktree 的旧快照；若主 agent 要求产物落主仓，需迁移任务夹并在主仓重跑全部门禁，当前 worktree 只保留历史输入。
- **待澄清 3（口味）**：Key 行「已验证」的门槛。建议默认从严：`gatewayCredential.state` 为已配置、`matchesAccount === true`、`modelAccess.state` 为可用态，三者同时满足才显示「已验证」，否则显示「已配置·未验证」或「未知」；理由是 AC-2 第③组正是防止“配了 Key 就涂绿”。若选择从宽（只看 `matchesAccount`），需把“已验证”文案限定为“账号匹配”，不得暗示模型可用，并同步改用例与文案。

## 11. 交付判定

- P0 全部满足且门禁实跑通过，P1 全部满足或经用户书面降级，P2 完成或逐条说明遗留；任一 P0 失败、门禁红灯、证据造假（把 NOT RUN 写成已验证、把 blocked 写成 pass）即判不通过。
- 交付说明必须包含：红→绿两次运行记录、15 条文档清理清单、探针 31/32 + 1 blocked 的名称与原因、NOT RUN 清单与命令、GUI 交接步骤与判据、未提交修正的哈希对比、最终 `git diff --stat` 与范围核对。
