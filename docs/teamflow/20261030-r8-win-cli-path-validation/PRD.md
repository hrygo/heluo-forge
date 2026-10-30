<!-- meta: summary="Windows 上 CLI 入口校验从「必须以 .exe 结尾」改为「存在且是普通文件」（自动发现同口径、原生 .exe 优先），执行层仍固定 argv + shell:false，启动失败时把原因归到运行时能力并给出可行动的下一步。" -->
基线依赖：docs/teamflow/20261030-r5-devops-config-slimming（该夹的 3 字段页面形态、保存只提交 3 键、隐藏键零丢失、服务端六键校验与回滚语义不回归；页面与三层解析形态继承自 docs/teamflow/20261029-r3-cli-path-autodiscovery）
取代：docs/teamflow/20261029-r3-cli-path-autodiscovery#AC-2：Windows 自动发现不再只认 `.exe`——无后缀、`.cmd`/`.ps1`/`.bat`/`.com`/`.vbs` 等真实存在的普通文件同样入选，原生 `.exe` 排在前面；「不得为执行包装脚本而切 `shell: true`」一条不变。
取代：docs/teamflow/20261029-r3-cli-path-autodiscovery#AC-9：手动填写的 Windows 路径不再因扩展名或包装脚本形态被拒；不存在、指向目录、POSIX 缺执行位仍逐字段拒绝并说明原因。
取代：docs/teamflow/20261030-r5-devops-config-slimming#AC-3：包装脚本拒收句与 `error.wrapperScript`（zh/en）一并移除，页面不再出现「请指向可直接执行的文件」这类按后缀拒收的文案。
取代：docs/teamflow/20261030-r5-devops-config-slimming#AC-6：页面入口路径的 blur 校验只剩长度（不再判包装脚本）；服务端路径类改按「存在且普通文件」，`dopEndpoint`/`ghOwner`/`sourceType`/`timeoutMs` 的拒绝语义不变。

# PRD — Windows CLI 入口不再按后缀拦截

## 1. 背景与目标

**实测报障**（企业内网 Windows x64，「设置 → 企业 DevOps」配置页）：dop 与 gh 由 npm 安装，位置是 `%APPDATA%\npm\dop` 与 `...\npm\gh`（npm 在 Windows 上生成的 shim，没有 `.exe`），两个字段下方都报红「不是可直接执行的文件（Windows 上请指向 .exe）」，页面无法保存。

**根因**（已定位，三处硬编码同一口径）：
- `packages/forge-devops/src/cli-config.mjs:180-185` `checkExecutableSuffix`：路径形态的值必须 `endsWith('.exe')`；
- `packages/forge-devops/src/cli-config.mjs:222-236` `checkFieldValue`：先用 `wrapperSuffixOf` 拒收包装脚本，再按后缀判定；
- `packages/forge-devops/src/cli-discovery.mjs:166-170` 候选名表、`:231-243` `isDirectlyExecutable`（win32 只认 `.exe`）、`:276` 把 `WRAPPER_SUFFIXES` 记为 `rejected`（`packages/forge-devops/src/cli-discovery.mjs:43` 定义 `.cmd`/`.bat`/`.ps1`/`.com`/`.vbs`）；
- `packages/forge-devops/client.js:59` `WRAPPER_PATTERN`、`:329` blur 直接拒收、`:223`/`:280` `error.wrapperScript` 文案。

**用户澄清（已问过）**：只放开拦截，不改启动方式——Windows 上无后缀、`.cmd`、`.ps1` 等真实存在的文件都允许保存；自动发现按同一口径（不再只找 `.exe`）；执行层保持 `execFile` + `shell:false`（`packages/forge-devops/src/cli-runner.mjs:204-212`），不引入 shell、不拼接命令字符串；真正调用不起来时给准确、可行动的报错，把原因归于运行时能力而不是路径格式；校验本身仍拒绝不存在的路径、目录等明显无效值。

**目标**
1. 普通用户把 npm 装的 dop / gh 位置填进配置页即可保存成功，不再被 `.exe` 后缀（或任何后缀）挡住。
2. 自动发现不再漏掉这类入口；同一目录/PATH 中若同时存在原生 `.exe`，优先选它。
3. 入口在 `shell:false` 下无法启动时，报错说明「这是包装脚本 / 无后缀 shim，固定 argv 不经 shell 时不能直接启动」，并给出下一步；失败仍是 fail-closed、不重放。
4. 安全边界一条不松：唯一子进程出口、固定 argv、不经 shell、无命令字符串拼接、写动作门禁不变。
5. 回归不退化：配置页仍是 3 项、保存仍只提交 3 键、隐藏键零丢失、POSIX 判定不变。

## 2. 用户故事与验收点

1. **内网 Windows 普通用户（本次报障者）**：我把 npm 装的 `...\npm\dop` 粘贴进去，不再出现红字，点保存成功，页面显示这个值已生效（AC-1、AC-7）。
2. **同样的用户换一个安装方式**：我填 `dop.cmd`、`.ps1`、或干脆没有后缀的 `dop`，都能保存；我不会被迫「先猜后缀再回来改」（AC-1、AC-7）。
3. **填错的人**：我填了不存在的路径或一个目录，仍然当场被拒，并明确告诉我是「找不到这个文件」还是「这是目录」，不要用后缀问题掩盖真实错误（AC-2）。
4. **零配置用户**：PATH 里只有 npm 生成的 `dop.cmd` / 无后缀 `dop`，自动发现也能找到它（不再显示"未找到"）；如果机器上同时有 `dop.exe`，选的是那个能直接跑的（AC-3、AC-4）。
5. **真正跑不起来的用户**：我保存成功后调用工具失败，提示告诉我「这个入口是包装脚本 / npm shim，固定 argv 且不经 shell 时启动不了，请指向该 CLI 的原生可执行文件」，而不是让我去改后缀（AC-5）。
6. **安全与审计视角**：放开的是「能不能保存」，不是「怎么执行」——仓库里仍只有一处 `execFile` + `shell:false`，没有 `cmd.exe /c`、没有 `shell:true`、没有把参数拼成一条命令（AC-6）。
7. **老用户回归**：页面还是三项、保存还是只提交 `dopBin`/`ghBin`/`timeoutMs`，我原来的 `dopEndpoint`/`ghOwner`/`sourceType` 不会被清掉（AC-10 回归、AC-1 保存断言）。

## 3. 验收标准

| AC | 优先级 | 验收标准（可测、可量化） | 判定方式 |
|---|---|---|---|
| AC-1 | P0 | **Windows 保存不再按后缀拦截**：win32 下，路径形态的值只要**存在且是普通文件**即通过校验，覆盖 6 种形态——无后缀 `dop`、`.cmd`、`.ps1`、`.bat`、`.exe`、大写 `.EXE`；`validateCliField` 与保存路径 `buildCliPatch` 结论一致（均 ok）；保存成功后补丁层写入**原值逐字**（不补后缀、不改大小写、不把 `/` 换成 `\`、不 trim 出别的形态）；保存响应的该字段 origin 仍为 `config`。 | `node --test packages/forge-devops/test/cli-config.test.mjs` 表驱动 + HTTP 保存用例 + 补丁层回读 |
| AC-2 | P0 | **仍拒绝明显无效值，且原因指向真问题**：不存在路径 →「找不到这个文件」；目录 →「这是目录，需要指向 dop 的可执行文件本体」（文案**不再点名 `.exe`**，gh 同理）；空值/纯空白仍表示「清除该层」并回落下一层；POSIX 一侧继续要求执行位（缺执行位文案不变）；六键契约中非路径字段（endpoint/owner/sourceType/timeoutMs）的拒绝语义与文案零变化；任一字段非法仍整包 422、逐字段原因、其余字段不丢。 | 表驱动单测（12 条非法值按新口径改写）+ 保存 422 用例 |
| AC-3 | P0 | **自动发现同口径**：win32 候选名集合至少含 `dop.exe`、`dop`（裸名）、`dop.cmd`、`dop.ps1`、`dop.bat`（gh 同理），只纳入真实存在的普通文件；不再产出 `rejected[].why = "wrapper-script"`；结果排序固定为**原生 `.exe` 优先**，其后裸名、`.cmd`、`.ps1`、`.bat`、`.com`；同目录/同 PATH 同时存在 `.exe` 与脚本形态时，`found[0]` 是 `.exe`；文件名大小写不敏感、去重、候选预算（≤200 项）与时限不变；发现仍零子进程、零写入。 | `node --test packages/forge-devops/test/cli-discovery.test.mjs`（名字表、入选/rejected、排序、预算用例重写） |
| AC-4 | P1 | **形态判定单点**：win32「可直接启动」的判定只剩一处实现（`isDirectlyExecutable` 与保存侧 `probeFile` 共用同一 helper 或同一导出常量），不允许校验侧与发现侧各写一份后缀规则；除运行期提示外，仓库内不再有「`endsWith('.exe')` 即通过」类判定。 | 源码 grep + 静态断言用例（唯一实现处） |
| AC-5 | P0 | **运行期失败要准确、可行动**：当生效入口是包装脚本形态（后缀 ∈ `WRAPPER_SUFFIXES`）或无后缀入口、且子进程**未启动**（`exitCode === null`）时，工具结论仍 fail-closed（只读 `failed`、写动作 `unknown` 且不重放），message 必须同时含：①入口形态判断（包装脚本 / npm 生成的无后缀 shim）；②原因归属运行时能力（固定 argv + `shell:false` 不能启动脚本，与路径写法无关）；③下一步（指向该 CLI 原生可执行文件，或改用提供原生二进制的安装方式）；④不含绝对路径、不含 endpoint。`.exe` 入口启动失败时**不得**套用包装脚本解释；提示判定不依赖具体 errno（EINVAL/ENOENT 兼容），只依赖形态 + `exitCode === null`。 | 适配器注入桩（`spawn EINVAL` / `spawn ENOENT`）+ 脱敏正则 + `detail.spawnFailed` 断言 |
| AC-6 | P0 | **执行与安全边界零放宽**：仍只有 `src/cli-runner.mjs` 一处 `execFile`，`shell: false`、固定 argv 白名单、超时与 1 MiB 上限；`src/` 内无 `spawn`/`exec`/`execSync`/`shell:true`/`cmd.exe`/`/c` 拼接、无「为启动包装脚本而调用解释器」的分支；既有安全扫描与静态断言用例只增不减、判据不放松。 | 全仓 grep + `cli-runner`/`cli-discovery` 静态断言用例 + 安全扫描用例 |
| AC-7 | P0 | **页面双面口径一致**：`client.js` 的 `WRAPPER_PATTERN`、blur 拒收分支、`error.wrapperScript`（zh/en 成对）移除，无悬空 i18n 键；入口路径 blur 只剩长度上界（4096）；`dop`/`dop.cmd` 粘贴后无红字、可提交；页面帮助句与占位符保持现状、仍不写 `.exe`；跨面矩阵用例（`test/client-rule-parity.test.mjs`）按新口径改写后仍逐行对齐页面 3 键与服务端 6 键。 | `client-shape` + `client-rule-parity` 用例 |
| AC-8 | P1 | **文档口径同步**：`packages/forge-devops/README.md` 配置表与自动发现段落删除「Windows 上只接受/只认 `.exe`」；新增一段说明「npm 生成的 `.cmd`/无后缀 shim 可以保存并被发现，但在 `shell:false` 下通常无法直接启动，运行期会给提示，建议指向原生可执行文件」；`docs/teamflow/memory.md` 同主题约定行按新口径**替换**（幂等，不追加变更日志）；全库（历史任务夹除外）对「只接受 `.exe`」「只认 `.exe`」「请指向 .exe」零命中；`CLI_PAGE_HINT` 与其他指引不变。 | grep（含排除路径）+ diff 复核 |
| AC-9 | P1 | **ready 语义不撒谎**：`ready` 只表示「入口已解析」，不编码「已验证可运行」；保存成功后快照不得新增「可直接执行 / 已验证」类断言字段，也不得把包装脚本静默描述成原生入口；启动失败时 `detail.spawnFailed: true` 保留，便于区分「起不来」与「业务失败」。 | 快照字段断言 + 失败用例断言 |
| AC-10 | P0 | **回归基线 + 用例改写纪律**：`pnpm check` 与 `git diff --check` 全绿；`node --test` 自动发现范围用例数只增不减、零 `skip`/`todo`；下列既有断言**按新口径改写而非整段删除**——`test/cli-config.test.mjs`（12 条非法值里的 `.exe` 两条与包装脚本拒收）、`test/cli-discovery.test.mjs`（名字表、`isDirectlyExecutable`、`rejected` 用例）、`test/client-shape.test.mjs`（`.cmd` 失焦拒收断言）、`test/client-rule-parity.test.mjs`（双面矩阵与 `.exe` 路径构造）；变异实验：把 win32 校验临时改回「必须 `.exe`」→ 新增/改写用例必须转红，还原后文件 hash 一致。 | 全量跑 + 用例计数 + 变异两轮 |
| AC-11 | P1 | **证据纪律**：每条「已实测」写命令、时间、宿主版本、目标对象与来源类型；本轮实测只到离线桩与组件渲染；企业内部 Windows 实机保存（原截图场景）、真实 npm shim 的启动失败提示、真实浏览器走查一律标 `NOT RUN`，mock 结论不得写成企业已联调。 | 证据表复核 |
| AC-12 | P1 | **仓库卫生**：分支保持 `feat/devops-change-flow`；不改动工作区既有 2 处未跟踪任务夹（r7/r8）与他人改动；仓库内不出现本机绝对路径与真实用户名（截图路径在文档、测试、日志里一律写成 `%APPDATA%\npm\dop`）；`.gitignore` 审计确认 `dist/`、`*.tgz`、`logs/`、`node_modules/`、`.pnpm-store/` 已覆盖，本需求不新增入库产物。 | `git status --short` + 正则扫描 + `.gitignore` 复核 |

## 4. 范围与非目标

**范围内**
- Windows 保存校验口径（存在且普通文件）与对应文案；POSIX 保持不变。
- 自动发现的候选名、入选判定、排序与 `rejected` 语义。
- 页面侧 blur 判据、i18n 键、双面矩阵用例。
- 运行期「未启动 + 脚本形态」的提示文案与失败归类（不改判定、不改重放策略）。
- README、`docs/teamflow/memory.md` 约定行、受影响的既有用例。

**非目标（本轮不做）**
- 不改启动方式：不引入 `shell: true`、不调 `cmd.exe`/`powershell`/`bash`、不把参数拼成命令串、不新增解释器通道。
- 不改契约面：六键名、HTTP 端点/状态码、工具名与参数、策略门禁、写动作四状态与幂等、审计舱、回滚流程一律不动。
- 不改 POSIX 判定（执行位仍要求），不把 Windows 口径套到 POSIX。
- 不做「保存时试跑一次 CLI」这类执行探测，不新增进程调用。
- 不新增受支持后缀白名单/黑名单（把后缀判断换个姿势保留同样不做）。
- 不做配置页 UI 改版、不改字段集（仍 3 项）、不改自动发现预算与时限。

## 5. anti-goals / 反面目标

即使测试全绿、保存也能成功，出现以下任一情况都算这次做失败：

1. **保存变绿了，但一次调用都起不来，用户不知道下一步**：错误只说「未启动」或原样回显 `spawn EINVAL`，不指出这是包装脚本/N shim、也不说该换成原生可执行文件。检查方法：拿一个 npm shim 桩调用工具，读错误句，看是否同时给出形态、原因归属与下一步。
2. **为了「真能跑」偷偷走 shell**：出现 `shell: true`、`cmd.exe /c dop.cmd`、或把整条命令拼成字符串的分支。检查方法：全仓 grep + 子进程出口静态断言。
3. **后缀判断换个姿势回来**：保存时列出「支持的后缀清单」、或在页面上对 `.cmd` 弹黄字/红字要求确认。检查方法：粘贴 `dop.cmd` 保存，页面无任何后缀相关提示。
4. **机器上明明有能跑的原生 exe，自动发现却选了会失败的 shim**：`found[0]` 是 `dop.cmd` 而同目录存在 `dop.exe`（或 npm 目录的 `dop` 排在 `dop.exe` 之前）。检查方法：构造两形态并存的目录，断言首个命中。
5. **文档还写着「Windows 只接受 .exe」**：用户照着 README 不敢填 npm 路径，或照着旧文去改名后缀。检查方法：全库 grep 旧口径，排除历史任务夹后零命中。
6. **放开后出现「谁都能过关」**：不存在的路径、目录也保存成功，或保存成功后页面显示的值与磁盘上的值不一致。检查方法：空值/目录/不存在三态用例 + 补丁层回读逐字比对。

## 6. 交互流程摘要

**保存**：用户粘贴路径 → blur 只判长度（>4096 红字）→ 提交 3 键增量 → 服务端校验（存在 → 普通文件 → POSIX 执行位）→ 写活动 profile 补丁层 → 回读一致 → 字段显示 origin=`config`、状态行 `ready`。任一步失败：逐字段 422，既有配置与隐藏键零改动。

**自动发现**：装配期与「重新自动发现」时，按 PATH → 固定候选目录逐目录扫描 → 对每个工具按候选名顺序（`.exe`、裸名、`.cmd`、`.ps1`、`.bat`、`.com`）stat，取第一个存在的普通文件 → `origin=discovered`；找不到即 `CLI_NOT_FOUND`（指引仍指向配置页）。

**调用**：任一工具 → 策略门禁 → 适配器 → `execFile(bin, argv, { shell:false, timeout, maxBuffer })`。成功按原语义归一；未启动（`exitCode === null`）时：若入口形态为脚本/shim，附上 AC-5 的三段提示；否则按原失败文案。任何情况下不重放写动作。

## 7. 优先级

- **P0（缺一不可）**：AC-1、AC-2、AC-3、AC-5、AC-6、AC-7、AC-10。
- **P1**：AC-4、AC-8、AC-9、AC-11、AC-12。
- 建议先落 AC-1/AC-2（保存口径与文案），再 AC-3/AC-4（发现问题），再 AC-7（页面），AC-5/AC-6 与测试改写同批，最后 AC-8/AC-9/AC-11/AC-12 收口。

## 8. 依赖与风险

- **依赖（事实待澄清）**：npm 安装的 dop/gh 在 Windows 上是否随包提供原生 `.exe`。若不提供，运行期提示里「改用原生可执行文件」的具体做法取决于企业分发方式（Q1）。
- **运行期错误码差异**：Node 版本对 `.cmd` 的失败可能是 `EINVAL`、对无后缀 shim 可能是 `ENOENT`/其它。**提示不得依赖 errno**，只按「形态 + `exitCode === null`」归类，避免新老 Node 行为漂移。
- **最大产品风险**：放开保存后页面变绿、调用仍失败。缓解=AC-5 的可行动提示 + AC-8 的 README 说明 + AC-9 的 ready 语义边界；是否再加页面级非阻塞提示留给用户定（Q2），默认不加，避免"又变成后缀判断"。
- **测试面广**：至少 4 个测试文件里的既有断言编码了旧口径，必须逐条改写并加变异证明有牙（AC-10）；否则改完看似全绿，实际判据已失效。
- **范围外诱惑**：为实现"真能跑"而引入 shell 是最直觉的解法，也是本需求明确否决的方向；评审按 AC-6 检查。
- **无新增依赖**：不新增 npm 包，不改 `package.json` 依赖与 `engines`。

## 9. 假设与待澄清

**（a）未定事实（kind: fact）**
- Q1｜npm 的 dop/gh 包是否随附原生 Windows 可执行文件（`.exe`）？——若随附，运行期提示与 README 可直接指向该文件；若不随附（按当前证据更像如此），提示改为「使用提供原生二进制的安装方式 / 由运维提供 exe」。默认按「不随附」写文案。
- 假设：`.ps1`/`.bat`/`.com`/`.vbs` 与无后缀文件一样**保存放行**（用户原话是「不要加这个后缀判断」，未限定只放开某几种）；运行期提示覆盖 `WRAPPER_SUFFIXES` 全集，无后缀入口按「可能是 Git Bash 版 shim」措辞。
- 假设：裸命令名（不含分隔符、如 `dop`）仍交给 PATH 解析，不在此处读盘；Windows 上它能否启动由运行期结论决定，本轮不改。
- 假设：`ready` 语义维持「入口已解析」，不因本轮新增可执行探测（AC-9）。

**（b）用户取舍（kind: taste）**
- Q2｜发现到"只有包装脚本形态入口"时，页面除了 `ready` 要不要额外给非阻塞提示？——A 不加，只在运行期失败时说清楚（推荐：最贴合"不要加后缀判断"）；B 状态行加一行灰字「该入口可能在运行时无法直接启动」；C 新增独立状态「已找到但不可直接启动」。选 B/C 会牵动状态行、i18n 与快照，需另加 AC。
- Q3｜同目录/PATH 多形态并存时选谁？——A 原生 `.exe` 优先（推荐：机器上明明有能跑的 exe 就不该选 shim）；B 严格按 PATH/目录顺序取第一个（更"无后缀偏见"，但可能选中必然失败的入口）；C 把候选全列出、由用户选。选 B/C 需改 AC-3 的排序断言与候选展示。

## 10. 工程约束

- **分支**：当前在 `feat/devops-change-flow`，本需求**保持该分支**，不新建、不切换、不 rebase。
- **提交与推送**：本阶段不执行 `git commit`/`git push`/`git tag`，由后续阶段与主 agent 按流程处理；完成报告不得把未提交改动写成已提交。
- **既有未提交改动**：工作区现有 2 处未跟踪任务夹（`docs/teamflow/20261030-r7-judge-default-catalog/`、`docs/teamflow/20261030-r8-win-cli-path-validation/`），属他人/前序产物，**不得修改、删除或纳入本次功能改动**；发现并行改动与本次目标文件冲突时暂停并核实来源。
- **脱敏**：仓库内（源码、测试、文档、日志）不写本机绝对路径与真实用户名；报障截图路径一律写 `%APPDATA%\npm\dop`，示例用 `corp.example`。
- **`.gitignore` 审计（dev 阶段动作）**：核对本仓库 pnpm monorepo 的忽略项——`dist/`、`*.tgz`、`logs/`、`node_modules/`、`.pnpm-store/`、`.DS_Store`、`.env*`、`coverage/` 已覆盖；本需求不新增构建产物/日志/打包件入库；`logs/teamflow/` 属宿主临时区，不入库。若发现缺口（例如某个新的构建目录）在 dev 阶段补进 `.gitignore`，作为独立一行，不夹带其它改动。
- **文档落点**：只改 `packages/forge-devops/README.md` 与 `docs/teamflow/memory.md` 的同主题约定行；历史任务夹不改，取代声明只写在本夹 PRD 头部。
- **验证命令**：`pnpm check`、`git diff --check`（仓库根执行）；定向用 `node --test packages/forge-devops/test/`；不自动升级/修改全局环境。
- **依赖**：不新增依赖；新增用例进入 `node --test` 自动发现范围，不建零用例入口。

## 11. 里程碑建议

- **M1（P0）保存口径与文案**：win32 改「存在且普通文件」、去后缀判定、目录文案去 `.exe`（AC-1、AC-2），单点形态判定（AC-4）。
- **M2（P0）自动发现同口径**：候选名、入选、排序、`rejected` 语义（AC-3）。
- **M3（P0）页面与双面**：删 `WRAPPER_PATTERN`/`error.wrapperScript` 与 blur 分支，改写双面矩阵（AC-7）。
- **M4（P0）运行期提示与安全守门**：未启动时的形态提示（AC-5）、安全边界静态断言（AC-6）。
- **M5（P0/P1）测试与文档收口**：改写 4 个测试文件、变异实验、README 与 memory 同步、`pnpm check` + `git diff --check`（AC-8、AC-10、AC-11、AC-12）。
- **M6（验收后，人工）**：企业内网 Windows 实机按截图场景复测（保存成功）、真实 npm shim 调用失败提示、真实浏览器走查；未跑前一律 `NOT RUN`。
