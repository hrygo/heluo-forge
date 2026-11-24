# 禁止 Agent 直连 IAM 凭据库：策略拦截实施方案（Luna 实施指导）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-026 |
| 文档名称 | 禁止 Agent 直连 IAM 凭据库：策略拦截实施方案 |
| 版本 | V0.1.8 |
| 文档状态 | 评审稿（2026-11-24 用户裁决落定；步骤 0 的 P0-A/B/C 与 P1-A…E 探针全部执行并落盘；处置见 §14、执行记录见 §5 步骤 0） |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-24 |
| 适用范围 | 仓内实现与离线验收口径。宿主探针结论先于实现（§5 步骤 0）；目标宿主实机验收、企业环境取证按 §8 另行取证 |
| 门禁 | `pnpm check` 离线闭环。三道条件分离（§8.2）：**实现**以探针 P0-A 为门禁（已于 2026-11-24 通过，见 §5 步骤 0 执行记录）；**默认启用**以企业装配探针（P1-A/B/C/D/E，含叠装两方向启用、装载失败可阻断、取票拒绝在 CLI 启动前生效）与公开 API 授权验收（§8.4）通过为门禁；**#434 第 4 项勾选**另需执行环境隔离证据，不因前两道通过而自动获得 |

> 编制依据：issue [#375](https://github.com/hrygo/heluo-forge/issues/375) 正文与完成标准、2026-11-23 作者「并入 #434」的处置意见，以及对本仓库 `packages/forge-policy`、`packages/forge-credentials-keychain`、`packages/forge-iam` 源码与宿主 `tools/pre-execute` 事件面的只读核验。当前只有源码级结论与离线用例计划，**没有**目标宿主实机拦截证据，也不代表生产可用。
>
> 关联文档：[策略与审计设计](<../design/plugins/forge-policy.md>)、[受控写最小门禁实施计划](<2026-11-19-policy-minimal-gates.md>)、[IAM 身份、令牌与业务凭据接入指南](<../../packages/forge-iam/docs/credential-access.md>)、[SQLite 存储扩展与使用规范](<../engineering/sqlite-storage-conventions.md>)、[DSH 插件高阶规范](<../engineering/dsh-plugin-conventions.md>)。

**修订说明（V0.1.8）**：按 2026-11-24 裁决 C 改守卫形态——两条 IAM 守卫不再绑定规则开关：`packages/forge-policy` 无条件注册 `ctx.inject(['credentials-store-location'], …)`，内置凭据后端提供该服务即生效，服务始终缺席（engineering 单装）即不判定；`rules.denyIamStoreAccess`/`rules.denyIamTokenAccess` 取消，配置中出现按「已取消开关」点名拒绝；`STAGE.STORE` 恒在流水线首位、不再由开关插入；装载期不再抛 `POLICY_STORE_LOCATION_UNAVAILABLE`，目录错配只降级为指纹兜底。五场景实测全绿（企业单装 13/13、两方向叠装各 13/13、engineering 单装 4/4、目录错配 4/4），P1-D 通过。逐条处置见 §15。

**修订说明（V0.1.1）**：按 2026-11-24 评审意见改六处——宿主探针前置为开工闸门、存档目录改为从凭据后端实际打开的目录取单一真源、公开 API 授权单列验收、基线改为远端 `main`（#417/#442 已合入）、取消字面预筛对判定的影响、验收夹具改为真实合成库并断言副作用。逐条处置见 §11。

**修订说明（V0.1.2）**：按第二轮评审改五处——默认启用只在企业装配层开启（其余三个可独立安装的 bundle 保持关闭，避免无内置凭据后端即装载失败）、默认启用条件统一为「企业装配探针 + 授权验收」并把实现/启用/勾选拆成三道门禁、删除 `store.directories` 且把「CLI 变量缺席 + 自定义目录」的偏差纳入挂载期阻断、公开 API 契约按实际路由与桥接校验改写、删除 §6.4 残留的字面前缀预筛。逐条处置见 §12。

**修订说明（V0.1.7）**：步骤 0 的 P1 企业装配轮已执行——企业单装 13/13（读库/读密钥/写/sqlite/cat/glob/rm/取票全部拒绝，包装脚本哨兵未生成证明取票拒绝在 CLI 启动前生效）、engineering→enterprise 13/13、engineering 单装 4/4（规则关闭）、目录错配 4/4；**enterprise→engineering 仅 2/13：Cordis 的 config 合并是后者整体覆盖，工程包不写 `rules`，规则在该顺序下丢失**，P1-D 未通过，默认启用门禁不满足。装载失败态（位置服务缺失）实测为「policy 未挂载、存档直连可行」，与 §9 风险行一致。记录与三种处置见[验证记录](../design/verification/iam-store-access-p1.md)。

**修订说明（V0.1.6）**：补跑 P0-B 与 P0-C——`terminal_send` 已被前置拒绝覆盖，`run_code` 在 `dev` profile 未注册（记为未覆盖）；三种权限模式的观测矩阵显示**写受模式约束、读不受限**（`sqlite3` 在三种模式下都能读到 canary 明文），执行环境因此不能承担「禁止读取存档」的职责。检查数 13→15，环境轮改用 `$HOME` 下合成目录。记录见[验证记录](../design/verification/iam-store-access-p0.md)。

**修订说明（V0.1.5）**：步骤 0 的 P0 探针已用 `dev` profile（从 `sdk` 模板引导、独立 `DSH_HOME`）与合成 SQLite 库执行：13 项检查全部通过、拒绝时工具体零执行、库未改动，记录见[验证记录](../design/verification/iam-store-access-p0.md)；本版把步骤 0 的 P0 命令、产出路径与门禁状态改为已执行口径，P0-B/P0-C 与 P1-A…E 仍未取证。

**修订说明（V0.1.4）**：按 2026-11-24 用户裁决改三处——D90 最小范围扩展批准（可在 catalog 解析前判定 Agent 工具调用中可判定的存储路径，仅限库目录与密钥目录，覆盖读/写/删）、新增 `auth token` 对 Agent 默认拒绝且**不设逐次确认通道**（探测点在 CLI 启动之前，另设 `denyIamTokenAccess` 开关）、把「记录现有 CLI 行为」统一为裁决结论。逐条处置见 §14。

**修订说明（V0.1.3）**：按第三轮评审改三处——把 P1-D（叠装后规则仍生效）与 P1-C（装载失败时不得暴露凭据库）纳入默认启用门禁、修正步骤 6 中把叠装写成「规则未启用」的口径、统一 `auth token` 的表述为「记录现有 CLI 行为，Agent 授权待裁决」。逐条处置见 §13。

**依据**：issue [#375](https://github.com/hrygo/heluo-forge/issues/375)（标题「禁止 Agent 直接读写 IAM SQLite 库」，labels：iam、priority: P1、area: credentials、area: enterprise、security、testing；2026-11-23 作者意见「已并入 #434（IAM 客户端收口），原文与判据保留在本单历史里，执行进度改在 #434 勾选」，即 #434 第 4 项「Agent 禁止直连 IAM 库（原 #375）」）。

**结论摘要**：当前 `packages/forge-policy` 对**读动作与未登记工具**在任何路径判定之前直接放行（`origin/main` `src/gate.mjs:889`），默认受保护根为空、且路径判定只对已登记写动作生效，而 IAM 凭据库（`credentials.sqlite` + `-wal`/`-shm`/`abandoned.*`）与密钥目录（`<store>.keys/keyring.json`）位于用户数据目录、不在 `$DSH_HOME` 内，因此 Agent 用 `read`/`grep`/`glob`/`bash`（`sqlite3`、`cp`、`rm`）即可完整读取、修改或删除会话与令牌。方案是在宿主唯一可用的统一拦截点 `tools/pre-execute` 上新增**先于目录解析**的存档访问判定（新阶段 `store-access`、新错误码 `POLICY_STORE_ACCESS_DENIED`、新错误码 `POLICY_IAM_TOKEN_DENIED`），按「路径参数规范化落根」与「命令/脚本文本指名存档」两条规则拒绝读、写、删，并拒绝经工具分发的 `auth token`；守卫不绑定开关，随内置凭据后端提供的 `credentials-store-location` 服务生效。公开 API（`heluo-forge auth …`、`ctx.iam.*`、`ctx.credentials.*`、同源页面接口）保持可用。

**可达性边界（先于技术方案声明）**：本方案只约束**调用参数里可见的路径与文本**。它能挡住常见误触与直连，但**不构成** #375「Agent 只能经授权 API 访问」的保证——脚本在运行期自算路径、变量间接、已存在副本都不受它约束（§4.4）。因此本方案交付后 #434 第 4 项**仍不勾选**，直到目标宿主能提供执行环境隔离或等价证据（§8.2、§8.3）。

**待裁决项**：本方案是相对 `docs/plans/2026-11-19-policy-minimal-gates.md` D22「读动作不登记 catalog」与既有边界「不判断工作区之外的路径」「不对读动作做判定」的**范围扩展**，需要项目负责人确认后作为 D90 记入该计划文档（见 §2.2 与 §5 步骤 7）。未获确认前，实现可先落地（行为受开关控制、默认关闭），但不得在 README／设计文档中把「Agent 不能直连 IAM 库」写成既有能力。

---

## 1. 问题结论

### 1.1 现象

1. Agent 可直接读取 IAM 凭据库：`read <store>/credentials.sqlite`、`grep -r token <store>`、`bash sqlite3 <store>/credentials.sqlite 'select * from records'` 均成功，返回值里含加密值、`ref`、`record`、会话与网关凭据元数据。
2. Agent 可直接改写或删除：`write`/`edit` 指向 `<store>/credentials.sqlite*`、`rm -rf <store>`、`cp <store>/credentials.sqlite /tmp/x` 均不被策略阻止。
3. 密钥目录同样暴露：`<store>.keys/keyring.json`（两目录 0700、文件 0600）可被 `read`/`cat`/`cp`。
4. 上述访问的预期行为是拒绝；允许的替代路径只有公开 API（`heluo-forge auth whoami --json`、`heluo-forge auth token`、宿主 `ctx.iam.getSession()`/`getAccessToken()`、同源页面 `GET /api/forge-iam/session`、`POST /api/forge-iam/token`、`ctx.credentials.set()/resolve()/unset()`）。

### 1.2 复现路径（离线可复跑，用于回归基线）

```bash
# 合成凭据库：真实 SQLite（建表 + 合成记录），不触碰用户数据
mkdir -p /tmp/iam-store-probe
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/tmp/iam-store-probe/credentials.sqlite');
db.exec('CREATE TABLE records (ref TEXT PRIMARY KEY, value BLOB NOT NULL)');
db.exec('CREATE TABLE future_table (id TEXT PRIMARY KEY, payload TEXT)');
db.prepare('INSERT INTO records VALUES (?, ?)').run('demo_ref', new Uint8Array([1, 2, 3]));
db.prepare('INSERT INTO future_table VALUES (?, ?)').run('demo', 'synthetic');
db.close();
"
```

拒绝用例同时断言三件事：**工具体未执行**（下游 `next()` 未被调用）、**数据未返回**（调用结果无 `records` 内容）、**库状态未改动**（`PRAGMA data_version`、行数与文件摘要前后一致，见 §7）。只有文件头的空壳库不能支撑"查询成功"的基线，已弃用。

在装载 `@heluo/forge-policy` 的宿主里依次让 Agent 执行（当前行为：全部成功返回内容或执行成功）：

| 序号 | 工具调用 | 当前结果 | 预期结果 |
|---|---|---|---|
| R1 | `read({file_path:'<store>/credentials.sqlite'})` | 返回文件文本 | 拒绝 |
| R2 | `bash({command:'sqlite3 <store>/credentials.sqlite "select * from records"'})` | 执行成功 | 拒绝 |
| R3 | `grep({pattern:'token',path:'<store>'})` | 命中结果返回 | 拒绝 |
| R4 | `write({file_path:'<store>/credentials.sqlite.abandoned.1.abc',content:'x'})` | 写入成功 | 拒绝 |
| R5 | `bash({command:'rm -rf <store>'})` | 执行成功 | 拒绝 |
| R6 | `read({file_path:'<store>.keys/keyring.json'})` | 返回密钥材料 | 拒绝 |
| R7 | `bash({command:'heluo-forge auth token'})` | 打印访问令牌 | 拒绝（CLI 未启动） |
| A1 | `bash({command:'heluo-forge auth whoami --json'})` | 成功 | 成功（保持） |
| A2 | `read({file_path:'<repo>/AGENTS.md'})` | 成功 | 成功（保持） |

### 1.3 根因

三层原因，缺一不可解释现状：

1. **判定顺序**：`origin/main` `src/gate.mjs:889` 的 `preExecute` 第一步即 `const action = actionFor(exec?.name); if (action === undefined || !isControlled(action)) return next();`。读动作按 D22 从不登记目录，因此 `read`/`grep`/`glob`/`bash`/`terminal_*` 与一切未登记工具在**任何路径逻辑之前**放行，连身份与审计都不读（D23）。
2. **受保护路径够不到存档**：`origin/main` 已实现 `protectPaths`（#417/#442），但默认受保护根为空（`src/installer.mjs:38` `DEFAULT_PROTECTED_PATHS = Object.freeze([])`），根只来自配置；`judgeProtectedPath` 在「工作区 ∪ 配置根」之外返回 `{judged:false}` 交回沙箱（`src/paths.mjs:241`），而判定在 `admitOnce` 内只对已登记写动作执行（`src/gate.mjs:566` 早退、`:600` 调用）。存档在用户数据目录、且读动作根本不进 catalog，三层都够不到（详见 §2.3）。
3. **宿主无读钩子**：DSH 事件面只有写向文件事件 `fs/write-intent`/`fs/edit-intent`/`fs/delete-intent`；`subprocess` 服务只有 `resolveExecutable`/`terminalEnvironment`/`spawn`/`spawnTerminal`，没有命令预执行事件；`FileSystem` 服务没有读拦截。由此**唯一**能覆盖 `read`/`grep`/`bash`/`terminal_*` 的统一拦截点是 `tools/pre-execute`（waterfall，`(exec, next) => Promise<PreToolDecision>`，`exec` 携带 `name` 与已解析 `arguments`），这也是既有门禁已在用的挂载点（`src/index.mjs:38-43`）。

**未验证假设（实施时必须实测或显式标注）**：`tools/pre-execute` 对内建工具（`read`/`bash`/`write` 等）同样触发。依据是宿主注册表把内建与插件工具放在同一 dispatch 管道上（`tools/execute` 为 around-dispatch waterfall）且 `cordis inspect` 声明该事件是「the pending call (name, parsed arguments, caller agent)」；仓内尚未有内建工具被 `pre-execute` 拦到的实测记录，查证方式见 §5 步骤 0（P0-A）。

---

## 2. 当前实现与根因

### 2.1 已存在、可复用的能力

| 位置 | 事实 | 本方案用法 |
|---|---|---|
| `packages/forge-policy/src/paths.mjs` | `resolveProtectedRoots(templates, env)`：`$VAR/**` 模板展开，未解析即抛 `POLICY_PROTECTED_ROOT_UNRESOLVED`（拒绝挂载）；`canonicalize(input, options)`：绝对化 → 逐段 `realpath` → `..` 回退已解析父目录 → darwin/win32 大小写折叠，ENOENT 保留字面；`matchProtected(candidate, roots)` 返回 `{protected, root, canonical}` | 直接用于存档根解析与命中判定，不重写归一逻辑 |
| `packages/forge-policy/src/gate.mjs` | `deny(reason, code)`、`denyWithEvidence(fields, reason, code)`（`:288`，记录失败仍拒绝并标 `evidence:'unrecorded'`）；`agentKindOf`、`operationId`、`summarizeArguments` 已就绪 | 拒绝一律走 `denyWithEvidence`，保留「拒绝也留证据」语义 |
| `packages/forge-policy/src/audit.mjs` | `ALLOWED_FIELDS` 白名单；`REDACT_SEGMENTS = 4` 只留路径尾 4 段；`FORBIDDEN_FIELDS` 含 `arguments`/`content`/`token`/`secret`/`credential` | 拒绝记录只写白名单字段，不落绝对路径与命令原文 |
| `packages/forge-policy/src/config.mjs` | `RULE_KEYS`（7 条）、`IMPLEMENTED_RULES`（`origin/main` 已七键）、`DEFAULT_RULES` 全 false、`checkRules` 与 `checkUnwiredSurfaces` 装载期校验、`DEFAULTS` 结构 | 新增开关的唯一登记点（策略侧不设目录配置面） |
| `packages/forge-policy/src/pipeline.mjs` | `STAGE`、`STAGE_RULES`、`ORDER`、`buildPipeline(rules)`（只装配「已实现且置真」的规则） | 新增 `store-access` 阶段并置于 `resolve` 之前 |
| `packages/forge-policy/src/installer.mjs`（`main` 行号） | `installPolicy(...)`：`env = templateEnv(config.env)`（`:175`）、`resolveProtectedRoots([...DEFAULT_PROTECTED_PATHS, ...configuredTemplates], env)`（`:181`）、`buildPipeline`（`:196`）、`createGate`（`:202`）、`native.pre`（`tools/pre-execute`）、服务 `protectedPaths`（`:288`）/`checkPath(candidate, workspaceRoot)`（`:294`）、fail-closed 风格（`POLICY_HOST_UNAVAILABLE`/`POLICY_SERVICE_CONFLICT`/`POLICY_AUDIT_NOT_DURABLE`） | 位置服务校验、存档根注入 `createGate`、服务投影、挂载期失败全部在此 |
| `packages/forge-credentials-keychain/src/default-store-directory.mjs` | `selectDefaultStoreDirectory({platform, home, localAppData, xdgDataHome})`：darwin `home/Library/Application Support/HeluoForge`；win32 `localAppData/HeluoForge`（无效回 `home/AppData/Local`）；其余 `home/.local/share/HeluoForge`，linux 且 `XDG_DATA_HOME` 绝对时用 `xdgDataHome/HeluoForge` | 存档目录的**唯一实现**；策略侧不镜像布局，目录经 `credentials-store-location` 取得（§4.5） |
| `packages/forge-credentials-keychain/src/sqlite-backend.mjs` | 库文件 `join(directory,'credentials.sqlite')`，伴随 `-wal`/`-shm` 与 `credentials.sqlite.abandoned.<pid>.<digest>` | 存档判定按**目录**而非单文件，因此未来新增文件/表天然覆盖 |
| `packages/forge-credentials-keychain/src/key-paths.mjs` | 密钥目录 `<directory>.keys`，文件 `keyring.json`，两目录 0700、文件 0600，`assertOutsideRepository` | `<store>.keys/**` 同属保护面 |
| `packages/forge-enterprise/cordis.patch.yml` | `insert` 顺序：`heluo-credentials-keychain`（无 `storeDirectory` 配置）→ `heluo-policy`（6 条写动作 catalog + `audit`，**未配 rules**）→ `heluo-iam` | 交付开关在此启用；`storeDirectory` 未配置时策略默认根即真实根 |
| `packages/forge-policy/README.md`「边界」 | 「门禁只约束经工具调用的正常路径：同权进程内代码能绕开本包」「未登记的工具与动作（含全部读动作）不在作用域」 | 本方案改变第二句的作用域表述，README 必须同步修订（§5 步骤 7） |

### 2.2 与本方案冲突的既有裁决

| 裁决 | 出处 | 冲突点 |
|---|---|---|
| D22 读动作不登记 catalog | `packages/forge-policy/src/catalog.mjs` 头注释、`docs/plans/2026-11-19-policy-minimal-gates.md` | 仍**不登记**读动作，但在 catalog 解析之前增加先行判定。**已裁决（D90，2026-11-24）**：允许在 catalog 解析前检查可判定的存储路径，范围仅限库目录与密钥目录、覆盖读/写/删；目录仍只收写动作 |
| 边界「不判断工作区之外的路径（沙箱已覆盖）」 | 同计划文档 §7 第 4 条 | 凭据库在工作区之外且沙箱不覆盖（当前会话即 `danger-full-access`），沙箱兜不住 |
| 边界「不对读动作做判定」 | 同计划文档 §7 第 7 条 | 本方案只判「读的是不是存档」，不统计、不审计其它读动作 |
| 公开 API 表把 `heluo-forge auth token` 列为 Agent 可用入口 | issue [#375](https://github.com/hrygo/heluo-forge/issues/375) 正文 | **已裁决（2026-11-24）**：`auth whoami` 可供 Agent 查询身份；`auth token` 保留给用户与已授权受信集成，Agent 工具调用默认拒绝、不提供逐次确认（§14） |
| §5 阶段表把受保护路径放在 P3 | 同计划文档 §5 | P3 已在 `origin/main` 落地（#417/#442），本任务**不改其语义**，只新增一条更窄、更靠前的存档规则，避免把通用路径规则绑到窄需求上 |

### 2.3 受保护路径的现状（以远端 `main` 为准）

本稿基线是 `origin/main`（`eba8a6b`，含 #417 流程闸与 #442 P3 收尾），不是本地那个落后的分支。`main` 上 `IMPLEMENTED_RULES` 已是七键，`protectPaths` 有真实判定链：`src/gate.mjs:449` 的 `protectedPathDenial`、`:600` 的调用点、`src/paths.mjs:223` 的 `judgeProtectedPath`、`src/path-sources.mjs` 的候选收集。这套能力**可以复用**，但它覆盖不到 IAM 存档，原因有三：

1. **作用域**：`judgeProtectedPath` 只在「会话工作区 ∪ 配置根」内判定，两者都不命中就返回 `{judged:false}`（`src/paths.mjs:241`）交回宿主沙箱；而 `DEFAULT_PROTECTED_PATHS` 在 `main` 上是空数组（`installer.mjs:38`），默认只剩下工作区。IAM 存档在用户数据目录，谈不上命中。
2. **位置**：候选判定在 `admitOnce` 内部、`if (!registered && !requiresGate(action)) return allowOutOfScope();`（`src/gate.mjs:566`）之后，即只对**已登记写动作**生效；`read`/`grep`/`glob`/`bash` 在那之前已被放行。
3. **参数来源**：`collectPathCandidates` 只把 `path`/`file` 键与「可确认为路径」的 `target` 当候选（`src/path-sources.mjs`），**不含 `file_path`**——而 `read`/`write`/`edit` 的参数键恰好是 `file_path`。

因此不能指望「打开 `protectPaths` 就顺带护住 IAM 库」：作用域和位置两条都不满足。

### 2.4 存档为什么也不在默认受保护根内

`origin/main` 的 `DEFAULT_PROTECTED_PATHS` 是**空数组**（`installer.mjs:38`），受保护根只来自 `protectedPaths` 与 `paths.append` 的配置模板；`$DSH_HOME` 只是 `templateEnv` 提供的模板变量（用于 `logs` 等），不再是默认根。凭据存档的默认位置来自 `selectDefaultStoreDirectory`（darwin `<home>/Library/Application Support/HeluoForge`；win32 `<localAppData>/HeluoForge`；linux `$XDG_DATA_HOME/HeluoForge` 或 `<home>/.local/share/HeluoForge`），全部在会话工作区与任何配置根之外——`judgeProtectedPath` 对其给出 `judged:false`，按设计交给宿主沙箱，而宿主沙箱只约束**写**（§4.4）。

因此「把库挪进 `~/.dsh` 就受保护」不成立；即便把存档目录登记进 `protectedPaths`，`protectPaths` 也仍只判定**已登记写动作**，`read`/`bash` 依旧不看。

---

## 3. 目标行为

### 3.1 判定语义（守卫随 `credentials-store-location` 服务生效）

对每次工具调用，先于目录解析与身份校验执行：

1. **路径类参数命中即拒**：任何参数被判定为路径（或含路径的字段，如 `workdir`/`cwd`/`savePath`）经 `canonicalize` 后落在存档根内（`credentials.sqlite` 全族文件、`<store>` 目录、`<store>.keys` 目录及其下一切），拒绝。
2. **递归/删除类参数命中即可拒**：对会向下递归读取、打包、同步或删除的工具与命令，参数是存档根的**祖先**（如 `~/Library/Application Support`、`$HOME`）也拒绝，因为该操作必然读到或删掉存档。
3. **命令/脚本文本指名存档即拒**：`bash`/`terminal_send`/`run_code` 的文本里出现存档文件名（`credentials.sqlite`、`-wal`、`-shm`、`.abandoned.*`、`keyring.json`）或存档目录名（`HeluoForge`、`HeluoForge.keys`）时拒绝。只做「存档指纹」匹配，不做 SQL 语义解析。
4. **CLI 取票通道默认拒绝**（同一条守卫）：`bash`/`terminal_send`/`run_code` 等命令型参数中出现 `heluo-forge auth token` 调用即拒绝，探测点在 **CLI 启动之前**；`heluo-forge auth whoami --json` 不受影响。**不提供逐次确认放行**：一次确认无法约束令牌进入工具输出后的用途，授权必须以具体业务操作为单位——由受信组件取票后代 Agent 发起请求、只回传业务结果（§14）。
5. **其余调用不受影响**：未命中即放行，走既有路径（含 out-of-scope 直接放行）；不新增身份查询、不为放行写审计、不改变其它开关语义。守卫只在位置服务出现后判定：服务始终缺席（如 engineering 单装没有内置凭据后端）时，两条判定都不执行，行为与今日一致。

**能保证与不能保证**（必须原样写进 README 与设计文档）：能保证「参数里写出来的存档路径、或命令文本里点名的存档」被拒绝，以及「命令文本可判定的 `auth token` 调用在启动前被拒」；不能保证「脚本运行时自行解析出存档路径或自行拼装取票命令」被拒绝——后者只能靠执行环境隔离（§8.2 探针判定，未通过前本方案只作**显式路径防误触 + 取票入口收敛**）。取票规则的拒绝只约束**经工具分发的调用**；已由他人导出、或脚本内自行 spawn CLI 得到的令牌不在覆盖面内。

### 3.2 保持不变的契约

- catalog 只收写动作、读动作继续不登记；`protectPaths`/`paths.append` 的既有语义不变（`main` 已实现，作用域限工作区与配置根、只对已登记写动作生效）。
- 未登记的**非存档**工具与动作继续 out-of-scope 放行、不读身份、不写审计。
- 受控写动作的流水线顺序、确认卡片、一次性收据、内容闸、决策复用、组织信封、过程观察全部不变。
- 拒绝结果的形状不变：`Object.freeze({kind:'deny', reason, code})`；审计记录字段仍在 `ALLOWED_FIELDS` 内。
- 公开 API 行为零改动：`heluo-forge auth whoami --json`（`auth token` 对 Agent 工具调用改由 §3.1 第 4 条拒绝，CLI 本身的开关与输出不变）、`ctx.iam.getSession()`/`getAccessToken()`、`ctx.credentials.set()/resolve()/unset()`、`GET /api/forge-iam/session`、`POST /api/forge-iam/token`；策略不拦截服务方法调用（同权进程内调用本就在边界之外）。

### 3.3 边界条件（明确写进测试）

| 条件 | 期望 |
|---|---|
| 存档根**父目录**上做非递归单文件操作（`ls ~/Library/Application Support`、`read .../HeluoForge.log`） | 放行 |
| 存档根父目录上做递归操作（`grep -r token ~/Library/Application Support`、`glob '**/*' path=<parent>`） | 拒绝 |
| 相对穿越 `../../../Library/Application Support/HeluoForge/credentials.sqlite` | 拒绝（`canonicalize` 归一后落根内） |
| symlink 指向存档（`ln -s <store>/credentials.sqlite /tmp/c && read /tmp/c`） | 拒绝（逐段 `realpath`） |
| `<store>` 的 `-wal`/`-shm`/`abandoned.*`、未来新增文件（`credentials-v2.sqlite`、`store-index.json`） | 拒绝（按目录判定） |
| 同库**新表**（`sqlite3 <store>/credentials.sqlite 'select * from future_table'`） | 拒绝（文本指名存档文件） |
| 命令里出现 `credentials.sqlite` 但目标是别处同名文件（`read /tmp/backup/credentials.sqlite`） | 按路径判定处理：`/tmp/backup/...` 不在根内 → 放行（不按文件名全局拒绝，避免误伤） |
| `heluo-forge auth whoami --json` | 放行 |
| `heluo-forge auth token`、`node <repo>/packages/forge-iam/bin/heluo-forge.mjs auth token`、`bash -c '… auth token'` | 拒绝（探测点在 CLI 启动前，见 §3.1 第 4 条） |
| `H=$(which heluo-forge); "$H" auth token`、脚本内自行拼装取票命令 | **不覆盖**：参数里没有可判定的 CLI 调用文本（与运行期自算路径同类缺口） |
| `grep({pattern:'credentials.sqlite', path:'<repo>'})` | 放行（`pattern` 是正则而非路径，不参与路径判定） |
| 位置服务缺席（engineering 单装） | 全部调用与今日一致：守卫不判定，`store-access` 阶段仍在流水线首位但空转 |

---

## 4. 推荐解决方案

### 4.1 总体形状

新增一个自洽模块 `packages/forge-policy/src/store-protection.mjs`，只做三件事：**算出存档根**、**从一次调用里抽出可能指向存档的目标**、**给出命中结论**；判定接入 `gate.preExecute` 的最前面；规则开关、阶段、服务投影、装载期解析分别在各既有模块各改一处（目录不设配置面，见 §4.5）。

不采用「扩展 `protectPaths` 来覆盖存档」的理由：它的语义是「落在受保护根内的**写入**」，判定位于 `admitOnce` 内、只对已登记写动作生效，作用域限工作区与配置根；#375 需要的是**读+写+删**、只针对一个存档、且必须在 catalog 解析之前生效。把两者合并会让通用路径规则被窄需求绑死，也让企业无法在关闭通用规则时单独获得这条 P1 能力。共存时存档规则是更严的先行判定（取严）。

### 4.2 备选方案（已评估，不采纳）

| 方案 | 不采纳原因 |
|---|---|
| 依赖文件沙箱（如 `workspace-write`）限制读 | 沙箱 provider 只限制越界写、当前会话是 `danger-full-access`；宿主 `FileSystem` 无读钩子，沙箱不是策略 |
| 在 `fs/write-intent`/`fs/delete-intent` 上拦截 | 只覆盖写向；读与 `bash` 完全绕过 |
| 在 `subprocess` 服务上拦截 | 宿主无命令预执行事件；只有 `spawn`/`spawnTerminal` 方法 |
| 关掉 Agent 的 `bash`/`read` 工具 | 破坏全部正常研发工作；issue 要求的是「仅可经公开 API」而不是「禁止读文件」 |
| 改用宿主持久化 ACL（文件权限 0600 由他人持有） | 目标用户即当前用户，Agent 以同一 UID 运行，权限位不构成隔离；且不属于本仓可控面 |
| 只按文件名黑名单拦命令 | 误伤 `/tmp/backup/credentials.sqlite`，且对 `<store>` 目录本身无效；必须叠加路径判定 |
| 按命令名拒绝 `sqlite3`（或 `python3 -c`、`node -e` 的 SQLite 用法） | 误伤仓库自身的 SQLite 测试与业务库调试（`node:sqlite` 在凭据与策略测试里是正常工具）；同一读取能力可换 `read` 读二进制、`cp`/`tar`、`python3 -c`、`node -e`，按命令名封不完；只看命令名不看路径，既拦不住读别处同名库，也不是对「本库」的精确判定 |
| 把凭据库迁到 `$DSH_HOME`，靠默认受保护根兜底 | ①`main` 上默认受保护根为空（`DEFAULT_PROTECTED_PATHS = []`），挪到 `~/.dsh` 也不在判定面；②即便登记为受保护根，`protectPaths` 的语义是「落在受保护根内的**写入**」且只对已登记写动作生效，挡不住 `read`/`sqlite3 .dump`；③沙箱层是写向的：macOS Seatbelt 为 allow-default 加 `(deny file-write*)`，Linux bwrap/Landlock 只授予写根，Windows 低完整性 ACE 只约束写，读取一律不设限；④迁移还要同步 `selectDefaultStoreDirectory` 的调用方（`HELUO_FORGE_STORE_DIRECTORY`、`scripts/init-enterprise-plugin.mjs:801-802`）与 `<store>.keys`、0700/0600、`assertOutsideRepository` 约定，收益低于代价 |

### 4.3 判定位置（关键设计，按 `main` 校正）

```
tools/pre-execute (waterfall)
  └─ gate.preExecute(ctx, exec, next)               # main: src/gate.mjs:889
       ├─ [新增] if (tokenStage) { verdict = judgeTokenInvocation(exec); if (hit) return denyWithEvidence(...) }
       ├─ [新增] if (storeStage) { verdict = judgeStoreAccess(exec, storeRoots); if (hit) return denyWithEvidence(...) }
       ├─ action = actionFor(exec.name); 非受控 → next()      # 现状，保持不变
       └─ admitOnce(...) → 已登记写动作才进入受保护路径/内容闸/确认…
```

必须放在 `preExecute` **最前面**（`actionFor` 之前）：`read`/`grep`/`glob`/`bash` 不是受控动作，`preExecute` 第二行就 `next()` 放行了；`main` 上受保护路径判定更靠内（`admitOnce` 内 `gate.mjs:566` 早退之后），够不到它们。

三点实现约束：

1. **`!disposed` 自带守卫**：`disposed` 只在受控动作分支里检查（`gate.mjs:895`），不要把它提前到整函数——那会把卸载后 out-of-scope 工具的现有行为改掉。
2. **`kind`/`operationId` 就地取值**：两者在 `admit()` 内才定义（`gate.mjs:568-569`），`preExecute` 顶部的拒绝分支必须自己算 `agentKindOf(exec)` 与 `callId`。
3. **身份只用于证据**：`actor` 由 `normalizeActor(await getActor?.(ctx))` 现取；取不到时照常拒绝，审计省略 `actor` 字段（拒绝不依赖身份，不能让身份缺失变成放行）。

### 4.4 能挡住什么、挡不住什么（评审 P1-1）

本方案是**调用参数的路径/文本判定**，交付定位是「显式路径防误触 + 审计」，不是「能力隔离」。不覆盖：

- **脚本运行期自算路径**：`bash` 里 `python3 -c`、`node -e`、`sh -c "$CMD"`、读一份清单反查真实路径、`eval` 拼装——参数里没有可判定的路径，调用前判定看不到；这是本方案与 #375 完成标准之间**唯一的硬缺口**。
- **取票通道的运行期拼装**：脚本里 `H=$(which heluo-forge); "$H" auth token`、`eval` 拼装、别名函数、经 `sh -c "$CMD"` 传入的非字面命令——文本里没有可判定的 CLI 调用，与「运行期自算路径」是同一类缺口；取票拒绝只覆盖**经工具分发、文本可判定**的调用；
- 同权进程内 JS、直接调用服务方法（既有边界，不变）；
- 开启前已复制到别处的副本（`/tmp` 里的旧备份）；
- `plugin_manager` 安装的第三方插件在其内部进程读取（安装动作本身受宿主权限门禁，不在本规则范围）；
- `run_code` 内部子派发是否逐个经过 `tools/pre-execute` 尚未实测（`main` 上存在 `tools/ptc-dispatch-log` 事件，说明有子派发通道），§8.2 一并核验。

**对硬缺口的处置**：先做 §5 步骤 0 的宿主探针。若目标宿主能给出「工具体根本拿不到该目录」的执行环境隔离（沙箱读限制、独立 UID、容器挂载），则把它作为主控制，本规则降为误触防护与审计；若给不出，本方案按**已声明的降级形态**交付，并在 README、设计文档与 #434 记录里写明「不满足『只能经授权 API 访问』，该项待验收」。

### 4.5 存档目录的单一真源（评审 P1-2）

现状是两个选址入口：Host 从 keychain 的 `storeDirectory` 配置取（`packages/forge-credentials-keychain/src/index.mjs:263`），CLI 从 `HELUO_FORGE_STORE_DIRECTORY` 取（`packages/forge-iam/bin/heluo-forge.mjs:64`）。如果策略再要求部署者登记一份目录，漏配就是「守卫开着、真实库没护住」——评审指出的正是这个静默失败。

改法：**让「后端实际打开的目录」成为唯一真源，策略只消费它，不再自己推断或镜像布局**。

1. keychain 在装配点（与既有 `JOINT_STORE_SERVICE`、`iam-client-secret-source` 同一处，`src/index.mjs:335-338`）追加只读位置服务：

   ```js
   ctx.provide('credentials-store-location', Object.freeze({
     directory,     // 后端实际打开的库目录（绝对路径）
     keyDirectory,  // <directory>.keys
     source: 'config' | 'default',   // 仅用于诊断与审计标签，不参与判定
   }));
   ```

   只对**内置注册后端**提供；注入的测试 backend 不提供，避免「自报位置」当证据（与既有"自证不是证据"一致）。
2. 位置服务字段：`{ directory, keyDirectory, source: 'config'|'default', isDefault }`。`isDefault` 由 keychain 用 `selectDefaultStoreDirectory(...)` 与自身打开的目录比较得出，**不给策略留第二份平台布局**；配置面不再有模板，因此「模板未展开就传给只接受绝对路径的 `canonicalize`」这一次序问题（评审第二轮 P1-3）随之消失。
3. `installPolicy`：守卫不绑定开关。无条件注册 `ctx.inject(['credentials-store-location'], (scoped) => …)`——Cordis 只在声明 `inject` 的作用域暴露服务，且条目按并行 fiber 装配，装载期直接 `ctx.get` 会恒为空。回调拿到位置后置 `available = true` 并生成存档根；服务始终缺席则守卫不判定（engineering 单装没有内置凭据后端，行为与今日一致）。
4. **删除 `store.directories`**（评审第二轮 P1-3）：策略不再接受任何目录配置面。它与位置服务语义重复——既要当「附加根」又要「必须与主目录相同」，两者不能同时成立。测试与无 keychain 的部署改为在夹具里直接 `ctx.provide('credentials-store-location', {…})`。
5. **CLI 偏差检测的两个分支**（评审第二轮 P1-3 指出的缺口）——命中只降级为**指纹兜底**，不拒绝挂载（裁决 C：守卫随服务生效，装载失败反而等于没有门禁）：
   - `env.HELUO_FORGE_STORE_DIRECTORY` 有值且与 `location.directory` 不同 → 记录 `POLICY_STORE_DIRECTORY_CONFLICT` 警告，根列表留空、按文件名/目录名指纹判定；
   - `env.HELUO_FORGE_STORE_DIRECTORY` **缺席**且 `location.isDefault !== true`（Host 用了自定义目录）→ 同码降级：此时 CLI 会打开平台默认目录（`packages/forge-iam/bin/heluo-forge.mjs:64`），Agent 调起的 CLI 与 Host 指向两份库；
   - 只有「变量有值且与位置服务一致」或「变量缺席且位置服务就是默认目录」两种组合 arm 精确根。
6. 默认目录不再由策略镜像：`default-store-directory.mjs` 保持唯一实现，策略侧不复制布局、不写黄金表（原 V0.1 的 `defaultStoreDirectories` 与跨平台黄金表整体删除）。

边界：同权插件可以伪造位置服务，这与「同权进程内代码可绕开本包」是同一条边界（§4.4），不额外宣称防伪。

### 4.6 抽取与预筛（评审"字面预筛"一条）

- **配置面已撤销**：目录只来自位置服务（绝对路径），不存在「模板未展开即 `canonicalize`」的路径（§4.5）；本节与 §6.4 都不保留「字面前缀不匹配就跳过」的快捷分支。
- **结构化工具不做字面预筛**：候选来自 `collectPathCandidates`（补 `file_path`），每个候选都 `canonicalize` 后 `matchProtected(candidate, storeRoots)`。不允许「文本里没有存档名就放行」——`/tmp/link -> <store>` 这种 symlink 别名文本里没有存档名，只有归一化后才命中，字面预筛会把 §7 承诺的别名用例变成空谈。
- **命令文本**：词法切词得到的 token 是候选；绝对 token 直接归一化判定，相对 token 只在能拼上已知 `workdir`/`cwd` 时判定；`~`、`$HOME`、`$XDG_DATA_HOME`、`$LOCALAPPDATA`、`$HELUO_FORGE_STORE_DIRECTORY` 按已知值展开，其余原样保留、不猜。
- **性能手段**：候选数量上限与命令词数上限（超限按「不可判定」拒绝），不做"看见关键字才算"的放行捷径。`realpath` 只对候选执行，通常 0–2 次。

---

## 5. 详细实施步骤

> 目标分支：从 `origin/main` 新建 `feat/issue-375-iam-store-access`。开工先 `git status --short` 核对工作区；仓库内未跟踪的 `docs/teamflow/**` 产物不得覆盖或删除。
> 每个单元完成即跑该单元测试、检查 `git diff --staged` 后提交；提交说明不得以 `#` 起头，引用写 `issue #375` 或 `ref: issue #434`。

### 步骤 0：宿主探针闸门（停工/开工判据，先于一切实现）

**目的**：先确认执行边界，再决定实现形态。三个问题：

1. 内建工具（`read`/`write`/`edit`/`grep`/`glob`/`bash`/`terminal_*`/`run_code`）是否都经过 `tools/pre-execute`？
2. 拒绝时工具体是否**真的没有执行**（而不是执行完再丢弃结果）？
3. 执行环境能否限制子进程对存档目录的访问——**读与写分别是什么情况**？

**做法**：

- 用 §1.2 的脚本在 `/tmp/iam-store-probe` 建真实合成库（建表 + 插入合成记录）；
- P0：运行 `node scripts/probe/run-store-access-p0-probe.mjs`（专用探针，**已于 2026-11-24 执行**）：驱动脚本建真实合成库与密钥目录，以独立 `DSH_HOME` 从 `sdk` 模板引导 `dev` profile，再挂载 `scripts/probe/store-access-p0-plugin.mjs`；插件在 `tools/pre-execute` 对 `read`/`write`/`edit` 的 `file_path` 命中存档根、或 `bash`/`terminal_send` 文本点名存档或 `auth token` 时返回 `{kind:'deny'}`，其余放行。这一轮只证明宿主事件面（见下）。
- 断言：拒绝决策生效；**工具体未执行的证据**（让工具体写哨兵文件/自增计数，探针确认未被写、未自增；`bash` 侧 `sqlite3` 无输出或命令直接失败）；探针前后 `PRAGMA data_version` 与 `records` 行数一致；
- 隔离能力：在 `read-only`、`workspace-write`、`danger-full-access` 三种文件策略下分别记录 `cat`、`ls`、写测试是否被沙箱拦。

**探针分两轮**（评审第二轮 P1-2）：

- **探针 P0（宿主事件面，已由 `scripts/probe/run-store-access-p0-probe.mjs` 证明）**：不复用 `scripts/probe/run-host-probe.mjs`——它在运行期显式 `disabled` 掉 `heluo-credentials-keychain`、`heluo-policy`、`heluo-iam`，改用内存凭据夹具（`scripts/probe/run-host-probe.mjs:95` 起），因此**只能**回答「宿主是否把内建工具派发到 `tools/pre-execute`、拒绝后工具体是否执行」，**不能**回答企业装配下规则是否真的挂上。
- **探针 P1（企业装配面，必须在目标宿主上另跑一轮）**：用未改夹具的真实企业组合包（keychain + policy + iam 同时装载）验证：规则启用后存档访问被拒、位置服务可用、冲突码在错配时触发、以及「Policy 装载失败时 Agent 工具是否仍可直连库」。

**探针 P0 判据**：

| 编号 | 判据 | 不满足时 |
|---|---|---|
| P0-A | 内置 `read` 与 `bash` 都触发 `pre-execute`，且拒绝后工具体未执行、库未改动 | **不进入实现**：在 #434 记录"宿主无统一前置拦截"，方案退回重新设计 |
| P0-B | `terminal_send`、`run_code` 的覆盖情况有明确结论 | 记录为"未覆盖"，交付文案与 #434 均不得宣称覆盖 |
| P0-C | 执行环境对存档目录的读/写限制有明确结论（三种文件策略各一条） | 如实记录；仅限写时，「读」仍由本规则承担，缺口进 §4.4 |

**探针 P1 判据**：

| 编号 | 判据 | 不满足时 |
|---|---|---|
| P1-A | 企业实际装配（真实 keychain + policy + iam）下开关生效：`read`/`bash sqlite3` 被拒且工具体未执行 | **不得默认启用**；规则保持默认关闭，只交付实现 |
| P1-B | 位置服务与冲突码按 §4.5 生效：错配拒绝挂载、「变量缺席 + 自定义目录」拒绝挂载、装对时放行 | 修 §5 步骤 3 后重跑 |
| P1-C | Policy 装载失败（语法/装配错误）、位置服务缺席、目录错配三种失败态下，企业装配**能否阻断**相关 Agent 工具（`read`/`bash` 指向真实合成库） | 装载失败必须被当作「没有门禁」写入 §9 并如实披露；位置服务缺席与错配已实测（不判定 / 指纹兜底）；无法阻断时不得宣称守卫生效 |
| P1-E | 企业装配下 `heluo-forge auth token` 经 `bash`/`terminal_send` 被拒，且**取证显示 CLI 未启动**（哨兵进程/包装脚本未被调用）；`auth whoami` 仍放行 | 无法证明「拒绝在 CLI 启动前」则 §8.4 的 Agent 授权项保持待验收；若连拒绝都不生效，规则不默认启用 |
| P1-D | 三种装配的启用范围符合 §5 步骤 6：企业单装**启用**、engineering 单装**关闭**、双顺序叠装（enterprise→engineering 与反向）**两个方向都启用** | **任一方向规则被关闭即视为未通过**（叠装不得靠装载顺序丢规则），修 patch 后重跑 |

**三道门禁（互不替代）**：

| 门禁 | 条件 | 允许的动作 |
|---|---|---|
| 实现 | P0-A 通过 | 启动步骤 1–5 与文档同步；规则默认关闭 |
| 默认启用 | P1-A、P1-B、P1-C、P1-D、P1-E 全部通过 **且** §8.4 授权验收通过（P1-A/B/C/D/E 已于 2026-11-24 全部通过；§8.4 待验收） | 无需改补丁：企业包插入的 keychain 提供 `credentials-store-location`，守卫自动生效（§5 步骤 6） |
| #434 勾选 | 上述两项 **且** 执行环境隔离（或等价证据）覆盖脚本运行期自算路径 | 才可勾选第 4 项两条判据（§8.3） |

**产出**：脱敏探针记录写入 `docs/design/verification/iam-store-access-p0.md` 与 `docs/design/verification/iam-store-access-p1.md`（验证记录目录免文档编号预留；含宿主版本、平台、逐项检查与未测项）。**P0-A 未通过则步骤 1–8 不启动；P1-A/B/C/D/E 任一未通过则企业装配不宣称守卫生效（守卫随服务自动启用，没有「手动启用」可退回）。**

**P0 执行记录（2026-11-24，宿主事件面）**：

| 项 | 内容 |
|---|---|
| 环境 | `dsh 0.2.1-rc.5`、node v24.13.0、darwin-arm64；`dev` profile 从 `sdk` 模板引导，独立 `DSH_HOME` |
| 命令 | `node scripts/probe/run-store-access-p0-probe.mjs`（判定轮 + 三种权限模式的环境轮） |
| P0-A 结果 | 15 项检查中判定类全部通过（含 `terminal_send` 前置拒绝）、`denials=11`、退出码 0；拒绝时工具体零执行，合成库行数与 `PRAGMA data_version` 未变 |
| P0-B 结论 | `terminal_send` 已被前置拒绝覆盖（用不存在会话也先拒，证明判定在会话查找前）；`run_code` 在该 profile 未注册，**记未覆盖**，需在带 PTC 的 profile 补测 |
| P0-C 结论 | `read-only`：读写存档与工作区写均拒；`workspace-write`：拒写存档、放行工作区写；`danger-full-access`：全放行。三种模式下 `bash cat`/`sqlite3` 均可读到存档内容（含 canary 明文），`read` 工具拒读二进制库（`FS_NOT_TEXT`），**读不受执行环境限制** |
| 覆盖 | `read`/`write`/`edit` 指向库与密钥目录、`bash sqlite3` 读改删、新增表、`sh -c '… auth token'`（哨兵未生成）、`terminal_send`、根外放行、三种权限模式矩阵 |
| 未覆盖 | `run_code`（profile 无该工具）、真实默认存档路径、Windows/Linux 沙箱、P1-A…E、模型自决调用 |
| 证据 | [IAM 存档访问 P0 探针记录](../design/verification/iam-store-access-p0.md) |

**P1 执行记录（2026-11-24，企业装配面）**：

| 项 | 内容 |
|---|---|
| 环境 | `dsh 0.2.1-rc.5`、node v24.13.0、darwin-arm64；`p1` profile 从 `sdk` 模板引导，独立 `DSH_HOME`；仓库内三个包复制进 profile 的 `@heluo/` 命名空间 |
| 命令 | `node scripts/probe/run-store-access-p1-probe.mjs --label enterprise` 及 `--patch` 组合（见复跑清单） |
| P1-A | 13/13 通过：`read` 读库/读密钥、`write`、`bash sqlite3`/`cat`、`glob`、`rm -rf`、`auth token` 全部被拒；拒绝后 `probe_canary` 记录内容与 `PRAGMA data_version` 未变 |
| P1-B | 目录错配（keychain 平台默认目录 + `HELUO_FORGE_STORE_DIRECTORY` 指向临时目录）不 arm、退回指纹兜底：读库与 `sqlite3` 被拒、根外读取放行（4/4） |
| P1-C | 位置服务缺失时 `installPolicy` 抛 `POLICY_STORE_LOCATION_UNAVAILABLE`、policy 未挂载，此时读/写/`sqlite3`/`glob`/`rm` 对存档全部成功——**装载失败等于没有门禁**；错配态由指纹兜底阻断；运行中卸载未单独复现 |
| P1-D | **未通过**：企业单装 13/13；`engineering→enterprise` 13/13；`enterprise→engineering` **2/13**（config 后者整体覆盖，工程包不写 rules → 规则丢失）；engineering 单装 4/4（规则关闭，符合预期） |
| P1-E | `heluo-forge auth token` 被拒且包装脚本哨兵未生成（CLI 未启动）；`auth whoami` 未被策略拒绝（探针环境无登录，CLI 自身退出 4） |
| 未覆盖 | Windows/Linux、真实默认目录端到端登录与续期、运行中卸载时序、模型自决调用 |
| 证据 | [IAM 存档访问 P1 探针记录](../design/verification/iam-store-access-p1.md) |


### 步骤 1：新增存档保护模块与单元测试

**文件**：新增 `packages/forge-policy/src/store-protection.mjs`；新增 `packages/forge-policy/test/store-protection.test.mjs`。

**符号（全部新增）**：

- `STORE_ARTIFACT = Object.freeze({ STORE_DIR: 'iam-store-dir', KEYRING: 'iam-keyring' })`；
- `storeRootsFrom(location)` → `{raw, root, artifact}[]`：只取 `location.directory` 与 `location.keyDirectory`（两者都是后端给出的绝对路径；任一不是绝对路径即抛 `POLICY_PROTECTED_ROOT_NOT_ABSOLUTE`）；
- `extractStoreTargets(exec)` → `{kind:'path'|'command', text, cwd?, recursive?}[]`；
- `judgeStoreAccess(exec, roots)` → `{hit:false}` | `{hit:true, artifact, reason, recursive}`；
- `storeDeniedCopy(tool, verdict)` → 拒绝文案；
- `CLI_NAMES = Object.freeze(['heluo-forge', 'heluo-forge.mjs'])`、`judgeTokenInvocation(exec)` → `{hit:false}` | `{hit:true, executable, reason}`：识别命令型参数里的 CLI 取票调用（`heluo-forge auth token`、`node …/bin/heluo-forge.mjs auth token`、`npx heluo-forge auth token`、`env … heluo-forge auth token`、`sh -c '… heluo-forge auth token'`），`auth whoami`/`auth --help` 不命中；
- `tokenDeniedCopy(tool)` → 取票拒绝文案（不含命令原文）。

**目标逻辑**：

- **不复制平台布局**：目录来自 `credentials-store-location`（§4.5），本模块只接受 `{directory, keyDirectory}`，单测直接注入；原 V0.1 的 `defaultStoreDirectories` 与三平台黄金表整体删除。
- **`file_path` 自行补齐**：`collectPathCandidates` 只认 `path`/`file` 与可确认的 `target`（`src/path-sources.mjs`），而 `read`/`write`/`edit` 的路径键是 `file_path`。本任务在 `extractStoreTargets` 内先取 `arguments.file_path`，其余参数再交给 `collectPathCandidates`。
- **不在本任务改 `PATH_SOURCE_KEYS`**：那会改变 `protectPaths` 的既有判定面（并顺带补上它对 `file_path` 的空洞），属于 P3 语义变更，须在 #417/#442 的上下文单独评审。该空洞写入交付说明，建议另开 issue。
- **不做字面预筛**：每个候选都 `canonicalize` 后 `matchProtected(candidate, storeRoots)`（§4.6）。symlink 别名文本里没有存档名，预筛会把它整条跳过。

**关键抽取规则**（`extractStoreTargets`，按工具名单表 + 通用兜底）：

| 工具 | 抽取字段 | 递归/删除语义 |
|---|---|---|
| `read`、`read_image` | `file_path` | 否 |
| `write`、`edit` | `file_path` | 否 |
| `glob` | `path`（`pattern` 不算路径） | 是（`**`） |
| `grep` | `path`（`include`/`pattern` 不算路径） | 是 |
| `bash` | `command` 全文 → 词法切分，`workdir` 作相对路径基准 | 含 `-r`/`-R`/`--recursive`/`find`/`tar`/`rsync`/`cp -r`/`rm -rf`/`du`/`mdfind -onlyin` 等向下语义时 `recursive:true` |
| `terminal_open` | `cwd` | 是（该终端后续命令在目录内执行） |
| `terminal_send` | `text` 全文 | 视作命令文本（同 `bash`） |
| `run_code`（宿主存在时） | `script` 全文 + `args` 全部字符串叶子 | 视作命令文本；另过 `judgeTokenInvocation` |
| 命令型工具的取票判定 | 同一份词法切分结果：可执行文件 token 命中 `CLI_NAMES`（或 `node`/`npx`/`env` 前缀后紧跟 CLI 路径）且其后参数序列出现 `auth` → `token` | 命中即拒，不看后续参数（`--json` 等不改变结论）；`workdir` 只影响路径解析，不影响取票判定 |
| `working_directory` | `cd` | 否 |
| `dsh_browser_download` | `savePath` | 否（工具另有 workspace 限制，仍按路径判定） |
| `dsh_browser_upload` | `path` | 否 |
| 其它/未知工具 | 通用兜底：遍历 `arguments` 中字符串叶子（深度 ≤ 4、单串 ≤ 8 KiB），形似路径（`^([A-Za-z]:)?[\\/]` 或含 `~/`/`$VAR/`）或形似命令（含空格与 shell 元字符）者进入候选；`pattern`/`query`/`prompt`/`description`/`justification`/`meta`/`content`/`old_string`/`new_string` 键跳过 | 否（保守：只按「落根内」判） |

**命令文本处理**（`parseCommandTargets`）：

1. 去除行尾注释（`#` 后至行尾；引号内不剥离）；
2. 按未加引号的空白与 shell 分隔符（`;`、`&&`、`||`、`|`、换行）切词；
3. 每个词去引号（`'`/`"`）、展开 `~`、`$HOME`、`${HOME}`、`$XDG_DATA_HOME`、`$LOCALAPPDATA`、`$HELUO_FORGE_STORE_DIRECTORY`（仅这些已知变量，其余保留原文）；
4. 输出候选：形似路径的词，以及裸文件名命中存档指纹（`credentials.sqlite*`、`keyring.json`）的词。

**命中判定**（`judgeStoreAccess`）：

```js
// 1) 路径候选：canonicalize(raw) → matchProtected(canonical, roots)
//    - 落在根内 → 拒绝（artifact 取命中根标签；<dir>.keys 记为 KEYRING）
//    - 是根祖先 且 recursive/deleting → 拒绝
// 2) 命令候选：词法命中指纹（规则 3）→ 拒绝；命中根路径 → 拒绝
// 3) 没有任何"文本不含存档名就整条跳过"的分支
```

**完成条件**：`node --test packages/forge-policy/test/store-protection.test.mjs` 全绿；用例覆盖：①由注入的位置服务生成根（`<dir>` 与 `<dir>.keys` 双根）、`file_path` 命中、symlink 别名、带 `workdir` 的相对命令 token、位置缺失时不臆造根、根为相对路径时拒绝挂载；②取票判定：五种调用形态命中；`auth whoami`、`auth login`、`auth --help`、`grep "auth token" docs`、`cat guide.md`（文本含但不执行 CLI）不命中；`H=$(which heluo-forge); "$H" auth token` 记录为**不覆盖**（用例断言 `hit:false` 并注明缺口）。

**提交点 1**：`feat(policy): 新增 IAM 存档访问与取票通道判定模块（issue #375）`。

### 步骤 2：登记开关与阶段

**文件**：`packages/forge-policy/src/config.mjs`、`packages/forge-policy/src/pipeline.mjs`。

**改动**：

1. `config.mjs`
   - **不新增规则开关**：守卫随位置服务生效，没有「开/关」可配。`RULE_KEYS` 保持七项、`IMPLEMENTED_RULES` 保持七项。
   - `REMOVED_RULE_KEYS` 追加 `denyIamStoreAccess`、`denyIamTokenAccess`，文案「该开关已取消：IAM 存档/取票守卫随 credentials-store-location 服务自动生效，不再由规则开关控制；请从配置中移除」——配置里残留这两个键时装载期点名拒绝，而不是静默忽略。
   - **不新增 `store` 配置面**（评审第二轮 P1-3）：`TOP_LEVEL_KEYS`、`DEFAULTS` 保持不变；写入 `store: {...}` 按未知顶层键报错，输出 `store: not implemented in this phase`，避免出现「配置了却没生效」的第二真源。
   - `checkUnwiredSurfaces` **不改**：`categories` 等未接入面继续拒绝；`protectedPaths`/`paths.append` 已由 P3 接入（#417/#442），本任务不动其语义。
2. `pipeline.mjs`
   - `STAGE` 追加 `STORE: 'store-access'`；`ORDER` 首位为 `STORE`，其后 `RESOLVE`；
   - **`STAGE_RULES` 不登记 `STORE`**：`buildPipeline` 对无映射的阶段恒装配（`rule: null`），阶段是否判定由门禁在运行期按 `storeGuard.available` 决定。这样叠装补丁不再需要携带 `rules`，也不受「config 后者整体覆盖」影响。

**完成条件**：`node --test packages/forge-policy/test/config.test.mjs packages/forge-policy/test/pipeline.test.mjs` 全绿；并补断言：`buildPipeline({})[0].stage === 'store-access'` 且 `rule === null`；`validateConfig({rules:{denyIamStoreAccess:true}})` 报「已取消」；七键全关时 `isObserveOnly()` 仍为真（守卫不受开关影响，见安装期提示）。

**提交点 2**：`feat(policy): 登记 store-access 阶段并取消 IAM 守卫开关（issue #375）`。

### 步骤 3：接入门禁与装载

**文件**：`packages/forge-policy/src/gate.mjs`、`packages/forge-policy/src/installer.mjs`、`packages/forge-policy/src/index.mjs`。

**改动**：

1. `gate.mjs`
   - `createGate` 选项新增 `storeGuard = { available: false, roots: [] }`（由 installer 传入并随位置服务 arm）；`const storeStage = stages.some((s) => s.stage === STAGE.STORE)` 仍由流水线决定（恒为真）。
   - `preExecute` 最前面插入（在 `actionFor` 早退之前；注意 `disposed` 目前只在受控动作分支里检查，存档判定自带 `!disposed` 守卫，**不要**顺手把 `disposed` 提前到整函数——那会改变 out-of-scope 工具的现有行为）：

     ```js
     async function preExecute(ctx, exec, next) {
       // 存档访问与取票通道判定先于目录解析：读动作与 shell 永远拿不到 catalog action（issue #375）。
       if (storeStage && !disposed && storeGuard?.available === true) {
         const token = judgeTokenInvocation(exec);
         if (token.hit) {
           const kind = agentKindOf(exec);
           const operationId = exec?.callId === undefined ? undefined : String(exec.callId);
           return denyWithEvidence(
             {
               action: 'iam.token.invoke',
               target: token.executable,
               tool: exec?.name,
               decision: 'deny',
               rule: 'token-access',
               operationId,
               agent: { kind },
               summary: `工具 ${exec?.name} 试图经 CLI 取用访问令牌，按取票通道规则拒绝`,
             },
             tokenDeniedCopy(exec?.name),
             'POLICY_IAM_TOKEN_DENIED',
           );
         }
       }
       {
         const roots = Array.isArray(storeGuard.roots) ? storeGuard.roots : [];
         const verdict = judgeStoreAccess(exec, roots); // roots 为空时按文件名/目录名指纹兜底
         if (verdict.hit) {
           // operationId / kind 在 admit() 内才有定义，这里就地取值，不要引用外层变量。
           const kind = agentKindOf(exec);
           const operationId = exec?.callId === undefined ? undefined : String(exec.callId);
           return denyWithEvidence(
             {
               action: 'iam.store.access',
               target: verdict.artifact,
               tool: exec?.name,
               decision: 'deny',
               rule: 'store-access',
               operationId,
               agent: { kind },
               summary: `工具 ${exec?.name} 直接访问 IAM 凭据存档，按存档访问规则拒绝`,
             },
             storeDeniedCopy(exec?.name, verdict),
             'POLICY_STORE_ACCESS_DENIED',
           );
         }
       }
       const action = actionFor(exec?.name);
       // …以下保持现状
     }
     ```

   - `agentKindOf` 从现有 import 列表复用（`src/gate.mjs:29` 已导入），不新增依赖。
   - 拒绝文案（用户可见，不含绝对路径、不含命令原文）：

     ```
     IAM 凭据库与密钥目录只能经公开接口访问：本次调用「{tool}」试图直接{读取|写入|删除}凭据存档（{库目录|密钥目录}），已拒绝。
     请改用 `heluo-forge auth whoami --json`，或宿主插件接口 `ctx.iam.getSession()` / `ctx.iam.getAccessToken()` / `ctx.credentials.*`。
     ```

   - 取票拒绝文案（同样不含命令原文与绝对路径）：

     ```
     Agent 不得直接调用 `heluo-forge auth token`：该命令会把可复用的访问令牌输出到标准输出，一次确认无法约束其后续用途。
     需要代办业务操作时，请由受信组件取用令牌并发起请求，只接收业务结果；身份自查请用 `heluo-forge auth whoami --json`。
     ```

   - 注意：`preExecute` 已 `async`，`denyWithEvidence` 是 async，直接 `return await` 或返回其 promise 均可；不得在 `disposed` 后继续判定。
   - `guard()` 不改：存档拒绝发生在准入之前，不产生收据。

2. `installer.mjs`：**目录来自位置服务，不来自第二份配置**（§4.5）
   - 在 `resolveConfig` 通过、`buildPipeline` 之前建立守卫状态，`createGate` 传入它：

     ```js
     // Cordis 的服务只在声明 inject 的作用域可见，且条目按并行 fiber 装配：
     // 装载期 ctx.get 恒为空，必须无条件注册注入回调，服务出现即 arm。
     const storeGuard = { available: false, roots: [] };
     let storeArmed = false;
     const armStore = (location) => {
       if (location === undefined || location === null) return;
       storeGuard.available = true;
       if (storeArmed) return;
       try {
         const declared = process.env.HELUO_FORGE_STORE_DIRECTORY;
         const declaredPresent = typeof declared === 'string' && declared.trim() !== '';
         if (declaredPresent && canonicalize(declared) !== canonicalize(String(location.directory))) {
           throw new PolicyCatalogError(
             'HELUO_FORGE_STORE_DIRECTORY disagrees with the keychain store location',
             'POLICY_STORE_DIRECTORY_CONFLICT',
           );
         }
         if (!declaredPresent && location.isDefault !== true) {
           throw new PolicyCatalogError(
             'the keychain store directory is custom while HELUO_FORGE_STORE_DIRECTORY is unset; the CLI would open the platform default directory',
             'POLICY_STORE_DIRECTORY_CONFLICT',
           );
         }
         storeGuard.roots.push(...storeRootsFrom(location));
         storeArmed = true;
       } catch (error) {
         // 目录错配不拒绝挂载：守卫降级为文件名/目录名指纹兜底，仍然拒绝直接点名。
         warnStore(`the IAM store location cannot be armed (${error?.code ?? 'POLICY_STORE_LOCATION_INVALID'}); the gate falls back to store file/directory fingerprints`);
       }
     };
     if (typeof ctx.get === 'function') armStore(ctx.get('credentials-store-location'));
     ```

     - 注入回调（在 `disposers` 建立之后注册，卸载时随 disposer 回收）：

     ```js
     if (typeof ctx.inject === 'function') {
       const disposeArming = ctx.inject(['credentials-store-location'], (scoped) => {
         armStore(typeof scoped.get === 'function' ? scoped.get('credentials-store-location') : undefined);
         return () => {};
       });
       if (typeof disposeArming === 'function') disposers.push(disposeArming);
     }
     ```

     - **不再抛 `POLICY_STORE_LOCATION_UNAVAILABLE`**：装载失败等于没有任何门禁（P1-C 实测），服务缺席时守卫不判定才是正确语义。
     - `createGate({ ... })` 传入 `storeGuard`。
     - 服务对象新增（与 `checkPath` 并列）：`storeDirectories: () => storeGuard.roots.map((entry) => entry.raw)`、`checkStore: (candidate) => matchProtected(candidate, storeGuard.roots)`。

3. `index.mjs`：追加导出 `judgeStoreAccess`、`storeRootsFrom`、`storeDeniedCopy`；新增 `./store-protection` 子导出（`files` 已含 `src`，`package.json` 只加 exports 项）。

4. 装载顺序：`resolveConfig` → 位置服务校验 → `storeRootsFrom` → `buildPipeline` → `createGate`；不得 `try/catch` 吞掉模板解析错误（未解析即拒绝挂载）。
5. 需要的 import：`canonicalize`（来自 `./paths.mjs`，installer 现有 import 只有 `matchProtected` 与 `resolveProtectedRoots`）、`storeRootsFrom`（新模块）；抛错沿用既有 `PolicyCatalogError(message, code)`——仓内没有 `PolicyHostError`，宿主侧问题一律用该类（见 `installer.mjs:150`/`:154`）。

**完成条件**：`node --test packages/forge-policy/test/apply.test.mjs` 全绿（默认配置行为不变）；新增 `test/installer-store.test.mjs` 覆盖六种组合：①位置服务缺席（夹具不提供、`inject` 不回调）→ 装载成功、`storeDirectories()` 为空、读存档放行；②位置出现且默认目录、变量缺席 → arm 两根、`checkStore` 命中；③变量有值且与位置不一致 → 不 arm、按指纹拒绝；④变量缺席且 `isDefault !== true` → 同降级；⑤变量有值与位置一致 → arm 两根；⑥装配后的 pre 钩子拒绝读库与取票且工具体未执行。再断言写入 `store: {...}` 被当作未知顶层键拒绝。

**提交点 3**：`feat(policy): 门禁在目录解析前拒绝 IAM 存档访问（issue #375）`。

### 步骤 4：门禁级行为用例

**文件**：新增 `packages/forge-policy/test/gate-store.test.mjs`（复用 `test/apply.test.mjs` 的 `fakeHost` 夹具风格：`ctx.on('tools/pre-execute', handler)` 存进 `listeners`，用 `listeners.get('tools/pre-execute')(exec, next)` 直接驱动）。

**用例矩阵**（每条都要断言「决策 + 是否落审计 + 是否执行下游」）：

| 组 | 场景 | 期望 |
|---|---|---|
| 拒绝-读 | `read` 指向 `<store>/credentials.sqlite`、`-wal`、`-shm`、`abandoned.*` | `kind:'deny'`、`code:'POLICY_STORE_ACCESS_DENIED'`、`executed === false` |
| 拒绝-写 | `write`/`edit` 指向 `<store>/credentials.sqlite`、`<store>.keys/keyring.json` | 同上（证明写也在写意图之前被拒） |
| 拒绝-删 | `bash` `rm -rf <store>`、`bash` `rm <store>/credentials.sqlite` | 同上 |
| 拒绝-查询 | `bash` `sqlite3 <store>/credentials.sqlite 'select * from records'`、`bash` `sqlite3 <store>/credentials.sqlite '.dump'` | 同上 |
| 拒绝-搬运 | `bash` `cp <store>/credentials.sqlite /tmp/x`、`bash` `tar -cf /tmp/x.tgz <store>` | 同上 |
| 拒绝-递归 | `grep path=<store>`、`glob '**/*' path=<store>`、`grep path=<store 父目录>`、`bash grep -r token <store 父目录>` | 同上 |
| 拒绝-别名 | 相对穿越、`~` 展开、`$HOME` 未展开/已展开、symlink 指向存档 | 同上 |
| 拒绝-未来数据 | `read <store>/credentials-v2.sqlite`、`read <store>/store-index.json`、`bash sqlite3 <store>/credentials.sqlite 'select * from future_table'` | 同上（覆盖 issue 完成标准 ②） |
| 拒绝-取票 | `bash 'heluo-forge auth token'`、`bash 'node packages/forge-iam/bin/heluo-forge.mjs auth token'`、`bash 'sh -c "heluo-forge auth token"'`、`terminal_send text='heluo-forge auth token'`、`run_code script='… auth token'` | `kind:'deny'`、`code:'POLICY_IAM_TOKEN_DENIED'`、`executed === false`（证明 CLI 未启动）；审计 `action:'iam.token.invoke'`、无命令原文 |
| 放行-公开 API | `bash 'heluo-forge auth whoami --json'`、`bash 'node packages/forge-iam/bin/heluo-forge.mjs auth whoami --json'`、`bash 'heluo-forge auth login'`、`bash 'cat docs/…'`（文本含 “auth token” 但不执行 CLI） | `kind:'allow'`、`executed === true`、`auditRecords().length === 0` |
| 不覆盖-运行期拼装 | `bash 'H=$(which heluo-forge); "$H" auth token'` | allow，且用例显式标注「运行期拼装，不覆盖」（对应 §4.4 缺口；不得写成「已封堵」） |
| 放行-无关读取 | `read <repo>/AGENTS.md`、`grep pattern='credentials.sqlite' path=<repo>`、`bash 'ls ~/Library/Application Support'`、`read /tmp/backup/credentials.sqlite` | allow |
| 开关关闭 | 上述拒绝组全部 | allow，且 `gate.stages.some(s => s.stage==='store-access') === false` |
| 证据 | 拒绝时 audit sink 抛错 | 仍 deny，且结果带 `evidence:'unrecorded'` |
| 记录最小化 | 任意拒绝 | 审计记录无绝对路径、无命令原文（`JSON.stringify(record)` 不含 `/Users`、不含 `select *`） |

**副作用断言（评审第二条：验证真实数据与副作用）**：夹具用 §1.2 的真实合成库，拒绝组每条同时断言——

- `executed === false`（`next()` 未被调用 / 下游 spy 未触发）；
- 库未被改动：`PRAGMA data_version` 与 `records`/`future_table` 行数前后一致；
- 数据未被返回：拒绝结果里不含记录内容（`JSON.stringify(decision)` 不含 `demo_ref`/`synthetic`）；
- 同一用例在未修版本（`storeStage=false`）能观察到原行为：`read` 成功返回数据库字节、`bash sqlite3` 成功输出行——即用例确实能失败，不是恒真断言。

**完成条件**：新用例全绿，且在「把 `storeStage` 强制置假」的对照跑里**变红**（>失败即证明用例有效<），`gate-path.test.mjs` 全绿（证明 `protectPaths` 语义未被顺手改动）。

**提交点 4**：`test(policy): IAM 存档访问拒绝与放行矩阵（issue #375）`。

### 步骤 5：命令词法专项用例

**文件**：新增 `packages/forge-policy/test/store-command.test.mjs`（纯函数级，直接测 `extractStoreTargets`/`judgeStoreAccess`，无需夹具）。

覆盖：引号包裹（`"<store>/credentials.sqlite"`、`'<store>'`）、分隔符串联（`cat a && sqlite3 <store>/x`）、管道（`cat <store>/credentials.sqlite | base64`）、`~`/`$HOME`/`${HOME}`/`$XDG_DATA_HOME` 展开、未定义变量保留原文、`\\ ` 转义空格（`~/Library/Application\\ Support/...`）、Windows 反斜杠路径与盘符、`${#VAR}` 之类非路径词不误判、`grep -r` 祖先拒绝 vs `ls` 祖先放行。

**完成条件**：用例全绿；把候选上限从 32 调到 512、命令词数上限翻倍后，所有拒绝用例**仍拒绝**（上限只影响能否判定，不能变成放行）。

**提交点 5**：`test(policy): 命令文本词法抽取用例（issue #375）`。

### 步骤 6：交付开关（只在企业装配层启用）

**文件**：`packages/forge-enterprise/cordis.patch.yml`（只改这一处）。

**前置条件**：探针 **P1-A、P1-B、P1-C、P1-D、P1-E 全部通过且 §8.4 授权验收通过**（§8.2 的三道门禁；P1-A/B/C/D/E 已于 2026-11-24 全部通过，§8.4 待验收）。裁决 C 已把守卫改为随位置服务生效，本步骤不再需要改补丁；若 P1-D 再次失败（叠装丢守卫），先在补丁层调平再交付，不得靠安装顺序。

**只改企业 patch 的理由（评审第二轮 P1-1）**：`packages/forge-engineering`、`packages/forge-devops`、`packages/forge-gitee` 都支持**独立安装**，其补丁层不插入内置凭据后端（`packages/forge-engineering/cordis.patch.yml:1` 的独立预装契约明写可单独安装）。若它们也打开本规则，`installPolicy` 取不到 `credentials-store-location` 会按 §4.5 拒绝挂载，**整个 forge-policy 插件装载失败**——既没有存档保护，连既有受控写门禁也一并失效。因此：

- `@heluo/forge-enterprise` 的企业 patch：追加开关（企业装配保证 keychain 在 policy 之前就位）；
- devops / gitee / engineering：**不追加**。若将来某个 bundle 需要启用，它必须先在自身补丁层声明对 `heluo-credentials-keychain` 的依赖与顺序，并在独立安装场景下通过 P1-D。

**改动**：**无需改任何补丁**。守卫随 `credentials-store-location` 服务生效（裁决 C），企业包插入的 `heluo-credentials-keychain` 就是该服务的提供者，因此企业单装与两种叠装顺序都自动生效；engineering 单装没有内置凭据后端，守卫自动不判定。补丁层**不写 `rules`**，`tests/plugin-patch-layers.test.mjs` 的反向断言（补丁层不得写 rules）保持有效。

> 这同时修掉了 P1-D 的叠装问题：Cordis 合并补丁条目时 `config` 是「后者整体覆盖」，携带 `rules` 的写法会让另一个顺序丢规则；把开关从补丁层移除后，两个顺序都不再影响守卫。

**完成条件**：

1. 企业 patch 形状用例通过（先 `grep -rn "cordis.patch" tests/ packages/*/test/ | head` 定位）；`pnpm check:repo` 通过；
2. 探针 P1-D 覆盖三种装配并记录结论（2026-11-24 已执行）：**企业单装 13/13**；**engineering 单装 4/4（closed，无任何拒绝文案）**；**双顺序叠装各 13/13**；
3. 探针 P1-C 覆盖位置服务缺席、目录错配、策略装载失败三种失败态并记录（2026-11-24 已执行）：缺席=守卫不判定（engineering 单装形态）、错配=指纹兜底仍拒、装载失败=失去门禁（由 `pnpm check` 与探针守卫）。

**提交点 6**：`feat(bundle): 企业包自动获得 IAM 存档访问守卫（ref: issue #434）`（若补丁无改动则并入步骤 7）。

### 步骤 7：文档同步（同一变更内完成）

| 文件 | 改动 |
|---|---|
| `packages/forge-policy/README.md` | 状态行补「IAM 存档访问拒绝 + 取票通道拒绝」；「当前实现」表新增两行（存档规则：判定规则、抽取口径、`POLICY_STORE_ACCESS_DENIED`、目录来自 `credentials-store-location`；取票规则：`heluo-forge auth token` 默认拒绝、`POLICY_IAM_TOKEN_DENIED`、无逐次确认通道）；「受保护路径」行更新为 P3 已实现（#417/#442）但「不含 IAM 存档（作用域外）」；「不负责」行补限定「IAM 存档访问与取票通道除外」；「边界」新增四条：只按参数文本与路径判定、不解析 SQL 语义、副本与运行期拼装路径不可见、运行期拼装的取票命令不可见 |
| `docs/design/plugins/forge-policy.md` | §5.2 增「存档访问与取票通道判定」小节（与受保护路径的关系：先行、守卫随 `credentials-store-location` 服务生效、不绑定开关）；§5.4 增两条「守卫」行（不是开关行）；判定顺序图与「现行实现」段补该阶段；§7 验证矩阵增行（拒绝/放行/服务缺席/证据/运行期拼装不覆盖）；决策记录标注 D90、D91 与裁决 C |
| `docs/plans/2026-11-19-policy-minimal-gates.md` | 决策记录追加 **D90**（用户已裁决，2026-11-24）：允许在 catalog 解析前检查可判定的存储路径，范围仅限库目录与密钥目录、覆盖读/写/删，「目录仍只收写动作（D22 不变）」「§7 第 4、7 条边界改为：只对 IAM 存档这一个工作区外目标做先行判定」；追加 **D91**：`heluo-forge auth token` 对 Agent 默认拒绝、不设逐次确认；追加 **D92**（裁决 C）：两条守卫不绑定开关，随 `credentials-store-location` 服务生效；§5 阶段表加一行「P1.5 存档与取票通道守卫（#375/#434-4）｜已完成/待 P3 合并」 |
| `packages/forge-iam/docs/credential-access.md` | 新增小节「禁止直连存储与直取令牌」：列出被拒的存档物、允许的入口、拒绝码与排障提示（`POLICY_STORE_ACCESS_DENIED` 改走 CLI/宿主接口；`POLICY_IAM_TOKEN_DENIED` 说明 `auth token` 仅供用户与已授权受信集成、Agent 需要代办业务时由受信组件取票并只回传结果） |
| `docs/design/plugins/forge-iam.md` | 存储边界段补一句：本机 SQLite 与 `<dir>.keys` 由 `@heluo/forge-policy` 的存档规则拒 Agent 直连，公开入口见接入指南 |
| `docs/engineering/sqlite-storage-conventions.md` | 在访问约束处补一条：Agent 及工具访问本机凭据库须经公开 API，直连由策略拒绝（含未来新增文件） |

**完成条件**：`pnpm check:docs` 零断链；改动处版本/日期按各文档正文规则更新。

**提交点 7**：`docs(policy): IAM 存档访问拒绝的设计与接入说明（ref: issue #434）`。

### 步骤 8：全量验证与证据回填

1. `node --test packages/forge-policy/test/*.test.mjs`；
2. `pnpm check:docs`、`pnpm check:repo`、`pnpm check:version`（若升版）；
3. `pnpm check`（含全部检查器与自动发现单测）；
4. `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD`；
5. 按 §8.5 模板把结果（脱敏）回填到 #434 第 4 项评论，**只记录、不勾选**两条判据；#375 的「只能经授权 API」判据只有在 §8.2 的隔离证据成立后才可能勾选。

**提交点 8**：`chore(policy): 验证记录与状态回写（ref: issue #434）`（若无文件改动则并入步骤 7 的提交）。

---

## 6. 关键实现说明

### 6.1 存档物清单（判定对象）

| 类别 | 路径形态 | artifact 标签 |
|---|---|---|
| 库目录（含全部库文件） | `<dir>`：`credentials.sqlite`、`-wal`、`-shm`、`-journal`、`.abandoned.<pid>.<digest>`，以及未来同目录新增的任何文件 | `iam-store-dir` |
| 密钥目录（含密钥文件） | `<dir>.keys`：`keyring.json`，以及未来同目录新增的任何文件 | `iam-keyring` |

判定粒度是**目录**（根 = `<dir>` 与 `<dir>.keys`）：不枚举文件名白名单，因此「新增数据类型或表」天然被覆盖（issue 完成标准 ②）；新增库文件（`credentials-v2.sqlite`、`store-index.json`）同样覆盖；只有「换目录」需要新的根（由位置服务替代，§4.5）。

### 6.2 拒绝与记录

- 拒绝形状与既有拒绝一致：`{kind:'deny', reason, code}`，`code = 'POLICY_STORE_ACCESS_DENIED'`。
- 审计记录字段（全部在 `ALLOWED_FIELDS` 内）：`action:'iam.store.access'`、`target:<artifact>`、`tool:<工具名>`、`decision:'deny'`、`rule:'store-access'`、`operationId`、`agent:{kind}`、`summary`。**不写** `params` 原文、不写命令文本、不写绝对路径。
- 记录失败不改变结论：`denyWithEvidence` 已保证 fail-closed（`evidence:'unrecorded'`）。
- 取票拒绝：`code = 'POLICY_IAM_TOKEN_DENIED'`，审计 `action:'iam.token.invoke'`、`target:<executable 的 basename>`、`rule:'token-access'`、`tool`、`decision:'deny'`、`operationId`、`agent:{kind}`、`summary`；同样**不写**命令原文、不写参数。
- 不为放行写审计（避免把「读动作」纳入审计范围，破坏 D23 与「不统计读取」的既有承诺）。

### 6.3 存档目录：单一真源与冲突阻断（评审 P1-2）

| 来源 | 角色 | 行为 |
|---|---|---|
| `credentials-store-location`（keychain 装配期提供，含 `isDefault`） | **唯一真源** | 开关开启但取不到 → `POLICY_STORE_LOCATION_UNAVAILABLE` 拒绝挂载 |
| 策略配置面 | **不存在**（`store` 顶层键按未实现拒绝） | 没有第二份目录、没有模板，因此不存在「模板未展开即 `canonicalize`」的次序问题 |
| `env.HELUO_FORGE_STORE_DIRECTORY` 有值（CLI 选址，`packages/forge-iam/bin/heluo-forge.mjs:64`） | 一致性校验 | 与真源不同 → `POLICY_STORE_DIRECTORY_CONFLICT` 拒绝挂载 |
| `env.HELUO_FORGE_STORE_DIRECTORY` 缺席 | 一致性校验 | 真源 `isDefault !== true` → 同码拒绝挂载（CLI 会打开平台默认目录）；`isDefault === true` → 放行 |

要点：**不再要求部署者"再登记一份目录"**。keychain 配了 `credentials.storeDirectory` 就自动成为真源；默认目录由 `selectDefaultStoreDirectory` 唯一决定，策略侧不镜像布局（§4.5）。目录错配只降级为指纹兜底（§4.5 第 5 条）——「守卫开着、库指向另一份」时仍能拒绝直接点名，但精确根不可用，这一差异写进验证记录。

### 6.4 性能

`pre-execute` 对每次工具调用执行，`bash` 频繁。实现约束：①**不做字符串预筛决定放行**（只看关键字会漏掉 symlink 别名与变量拼装，§4.6）；②候选路径数上限（默认 64，超出按「不可判定」拒绝，`summary` 记 `truncated`）；③命令词数上限（默认 512）；④不做网络、不读文件内容，只对候选做 `realpath`（通常 0–2 次）；⑤不保留任何字面前缀跳过（评审第二轮 P2：别名的字面路径可以在保护根外，先比前缀会把它整条漏掉）。

### 6.5 回退

没有开关可关：移除内置凭据后端（例如 engineering 单装）或卸载 `heluo-policy` 即回到今日行为，无需数据迁移；拒绝只发生在执行前，不产生不可逆副作用。卸载策略包会同时失去既有受控写门禁，因此首选只移除凭据后端或保持现状。

---

## 7. 测试方案

| 层级 | 文件（新增/改动） | 覆盖 | 断言要点 |
|---|---|---|---|
| 单元 | `test/store-protection.test.mjs`（新） | 位置服务注入 → 双根、自定义/默认目录、相对路径拒绝；取票判定五种形态 | 无位置服务时 `storeRootsFrom` 不臆造；相对路径抛 `POLICY_PROTECTED_ROOT_NOT_ABSOLUTE`；不再有跨平台黄金表与目录配置面；`auth whoami`/`auth login`/非 CLI 文本不命中，运行期拼装断言 `hit:false` 并注明缺口 |
| 单元 | `test/store-command.test.mjs`（新） | 词法抽取 | 引号、分隔符、管道、变量展开、转义空格、Windows 路径、非路径词不误判 |
| 单元 | `test/config.test.mjs`（改） | 新开关与新 `store` 键 | 置真可装载、未知子键报错、`categories` 仍拒绝、`protectedPaths`/`paths.append` 保持 P3 语义 |
| 单元 | `test/pipeline.test.mjs`（改） | 阶段装配 | 首阶段 `store-access`；关闭时不存在 |
| 集成（门禁） | `test/gate-store.test.mjs`（新） | §5 步骤 4 全矩阵（存档 + 取票 + 不覆盖项） | 决策、下游**未执行**、真实合成库 `data_version`/行数未变、拒绝结果不含记录内容、审计有无与最小化、`POLICY_IAM_TOKEN_DENIED` 时 CLI 未启动、未修版本对照变红 |
| 回归 | `test/apply.test.mjs`、`test/gate-path.test.mjs`、其余既有 30 个测试文件 | 默认配置行为不变 | 现有断言零改动通过 |
| 契约 | `packages/forge-iam/test/cli-reader.test.mjs`、`packages/forge-credentials-keychain/test/*.test.mjs` | 公开 API/存储未被改动 | 全绿（证明不改存储层） |
| 装配 | 探针 P1（真实企业组合包）与 patch 形状用例 | 企业单装、engineering 单装、双顺序叠装 | 只有企业装配启用规则；其余装配 policy 正常装载且规则关闭（§5 步骤 6） |
| 宿主探针 | `scripts/probe/run-store-access-p0-probe.mjs` | 目标宿主中内建工具/终端/脚本入口是否经 `pre-execute`（§8.2） | 探针记录：拒绝生效、工具体未执行、库未改动、隔离能力结论 |

覆盖率：`packages/forge-policy` 现有口径 ≥70%，安全关键分支（拒绝/放行/开关关闭/证据失败）必须正反用例各一。

---

## 8. 验收标准

### 8.1 本方案可执行检查（实施完成后执行，全部为「待执行」，不得预先写成已通过）

| 编号 | 命令 | 期望 |
|---|---|---|
| C1 | `node --test packages/forge-policy/test/*.test.mjs` | 全绿，含 3 个新增测试文件 |
| C2 | `pnpm check:docs` | 0 断链、0 编号/锚点错误 |
| C3 | `pnpm check:repo` | 无未登记根入口、包体闭包通过 |
| C4 | `pnpm check:version` | 版本一致性通过（若未升版则应报未变更差异） |
| C5 | `pnpm check` | 全绿 |
| C6 | `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD` | 全部提交签名校验通过 |
| C7 | `node --test packages/forge-iam/test/cli-reader.test.mjs` | 公开 API 未被改动影响 |
| C8 | `node --test packages/forge-credentials-keychain/test/*.test.mjs` | 位置服务不改存储行为 |

### 8.2 探针与三道门禁（详见 §5 步骤 0）

| 探针 | 能证明什么 | 不能证明什么 |
|---|---|---|
| P0（`scripts/probe/run-store-access-p0-probe.mjs`，**已执行**） | 内建工具是否经 `tools/pre-execute`、拒绝后工具体是否执行、各文件策略下的读/写限制 | 企业装配下规则是否真的挂上（该脚本运行期禁用 `heluo-policy`/`heluo-iam`/内置 keychain，改用内存凭据夹具，`scripts/probe/run-host-probe.mjs:95`） |
| P1（真实企业组合包，另跑一轮） | 实际装配下拒绝生效、位置服务与冲突码、装载失败时的暴露面、独立安装与双顺序叠装 | 脚本运行期自算路径（执行环境问题，不由本方案解决） |

| 门禁 | 条件 | 允许的动作 |
|---|---|---|
| 实现 | P0-A 通过（2026-11-24 已通过，见 §5 步骤 0 执行记录） | 步骤 1–5 与文档同步；规则默认关闭 |
| 默认启用 | P1-A/B/C/D/E 已全部通过（2026-11-24）；**§8.4 待验收** | 无需改补丁：守卫随 keychain 的位置服务自动生效（§5 步骤 6） |
| #434 勾选 | 上述两项 **且** 执行环境隔离（或等价证据）覆盖运行期自算路径 | 勾选第 4 项两条判据（§8.3） |

探针记录随 PR 附上（脱敏：不含用户名、不含库内容）。**P0-A 未通过则步骤 1–8 不启动；P1-A/B/C/D/E 任一未通过则企业装配不宣称守卫生效。**

### 8.3 issue #375 判据状态（交付后仍不勾选）

| 判据 | 本方案能提供 | 仍缺 | 状态 |
|---|---|---|---|
| ① 直接读写库文件、直接查改表均被拒 | 调用参数里可见的路径与命令文本（含 symlink 别名、带 `workdir` 的相对路径、已知变量展开） | 运行期自算路径（`python -c`、`node -e`、清单反查、脚本内构造） | **部分满足，不勾选** |
| ② 新增数据类型/表同样受限 | 目录级判定 + 真实 `future_table` 用例 | 实现落地后以 C6 复跑 | 结构上满足（P0 探针已用 `future_table` 证明判定不依赖表名） |
| ③ 公开 API 合规请求可完成、越权不可读改 | `auth whoami`、宿主接口、HTTP 接口未被改动；`auth token` 对 Agent 工具调用默认拒绝（P1-E 已取证：哨兵未生成、CLI 未启动） | 子进程自行拼装取票未约束（§4.4）；HTTP/桥接/宿主插件授权验收（§8.4） | **待 §8.4 与子进程取证，不勾选** |

### 8.4 公开 API 授权验收（评审 P1-3）

| 入口 | 验收项 | 期望记录 |
|---|---|---|
| `GET /api/forge-iam/session` | 未认证请求 | 401/403，且在读取会话、触发刷新、写库**之前**返回（`packages/forge-iam/src/routes.mjs:408`） |
| `GET /api/forge-iam/session` | 已认证请求 | 返回**不含访问令牌**的会话快照；不得顺带触发刷新或写库（该路由注释即「Identity only」，`:411`） |
| `POST /api/forge-iam/token` | 未认证请求 | 401/403；不得因未认证请求触发刷新 |
| `POST /api/forge-iam/token` | 已认证 + 变异头（`hasMutationHeader`） | 返回 `{token, expiresAt}`（`:417`）；缺少 `X-...` 变异头时 403 `IAM_REQUEST_HEADER_REQUIRED` |
| 本机 Host 桥接（`HELUO_FORGE_IAM_URL`） | 来源与能力校验 | 非回环 403、secret 未配置 503、bearer 不匹配 401（`packages/forge-iam/src/bridge.mjs:35`）；**没有独立的过期判定**，过期只能由 bearer 不匹配表现为 401 |
| `heluo-forge auth token`（Agent 工具调用） | 拒绝发生在 **CLI 启动前** | `deny: POLICY_IAM_TOKEN_DENIED`；**两类证据分开记**：①「已拒绝经工具分发的调用」（`executed === false`、哨兵/包装脚本未被调用）；②「未能约束任意子进程取票」（脚本内自行 spawn 时 CLI 正常输出令牌）。**不提供逐次确认通道**；缺 ① 则该行保持待验收 |
| `heluo-forge auth token`（用户/受信集成） | CLI 本体行为不变 | 用户终端与已授权受信组件可正常取票；业务代办由受信组件取票后代 Agent 发起请求，只回传业务结果（§14） |
| `ctx.credentials` | 信任边界 | 共享引用命名空间，同权插件可读写他人引用，**不做授权验收、只记录边界** |
| 离线 CLI 直开本地库 | 与执行环境隔离共存 | 若采纳隔离，须验证隔离启用后 CLI 仍能打开库目录 |

### 8.5 #434 回填模板（脱敏，只记录不勾选）

```text
第 4 项（原 #375）进度记录 —— 判据未勾选
- 已交付：@heluo/forge-policy 新增 store-access 阶段（码 POLICY_STORE_ACCESS_DENIED / POLICY_IAM_TOKEN_DENIED），守卫随 credentials-store-location 服务生效、不绑定开关；目录取自位置服务（含 isDefault），变量缺席+自定义目录或变量不一致时降级为文件名/目录名指纹兜底。
- 判据①：gate-store.test.mjs N pass（read/write/edit/bash(sqlite3|cp|rm|tar|grep -r)/glob/terminal_send/相对穿越/symlink）；拒绝时工具体未执行、库 data_version 与行数未变；未覆盖运行期自算路径。
- 判据②：future_table 与 credentials-v2.sqlite 用例通过（目录级判定）。
- 判据③：heluo-forge auth whoami --json 对 Agent 放行；`heluo-forge auth token` 经工具分发被拒（POLICY_IAM_TOKEN_DENIED，CLI 未启动，见 P1-E）；任意子进程自行取票未约束（如实记录，不写成已封堵）；HTTP/桥接授权验收见 §8.4 记录。
- 探针：宿主 <version>/<platform>，P0-A <通过/未通过>，P0-B <结论>，P0-C <结论>；P1-A/B/C/D/E <结论>（企业装配另行一轮）。
- 未勾选原因：<探针缺口 / 运行期路径 / 授权验收未完成>。
```

---

## 9. 风险与注意事项

| 风险 | 影响 | 处置 |
|---|---|---|
| **执行边界不足：脚本运行期自算路径不可见**（最主要） | 不能满足 #375 判据 ① 的完整语义 | 步骤 0 探针先行；给不出隔离则按 §4.4 降级形态交付、#434 不勾选、文档写明缺口 |
| 宿主无统一前置拦截（P0-A 不过） | 本方案对读完全无效 | 开工闸门：不进入实现，退回重新设计（§8.2） |
| 目录真源错配 | 守卫开着却护住另一份库 | 位置服务为唯一真源；错配降级为指纹兜底、精确根不可用（§4.5/§6.3） |
| 误伤正常研发（`grep` 家目录、备份脚本） | 阻断合法工作 | 只在「落根内」或「递归祖先」时拒绝；父目录非递归操作放行；拒绝文案给出替代入口 |
| 内建工具是否触发 `pre-execute` 未实测 | 若未触发，本方案对读无效 | §8.2 P0-A 为开工闸门；未通过则不实现，并在 #434 记录宿主缺口 |
| 第三方/注入 backend 不提供位置服务 | 守卫不判定（等价于没有内置凭据后端） | 预期行为；README 写明「守卫依赖内置 keychain 提供的位置服务」 |
| 自定义 `storeDirectory` | 与 CLI 错配 | 两个分支都降级为指纹兜底：变量有值且不一致、变量缺席且 `isDefault !== true`（§4.5、探针 P1-B） |
| 可独立安装的 bundle 与守卫 | 没有内置凭据后端 → 守卫不判定；有内置后端 → 自动生效 | 无需改补丁（§5 步骤 6）；P1-D 实测企业单装/engineering 单装/双顺序叠装 |
| Policy 装载失败时仍可直连库 | 「装了策略就安全」的误判 | 探针 P1-C 记录实际暴露面；不得宣称「装载失败即安全」；企业装配要求 keychain 先于 policy 注册 |
| `pre-execute` 每调用执行的性能开销 | 高频 `bash` 变慢 | 候选/词数上限（§6.4，无字面预筛）；C1 中加一条「10k 次无关 `bash` 调用的耗时 < 阈值」用例（阈值取基线 3 倍内） |
| 审计新增 `action:'iam.store.access'` 非 catalog 动作 | 下游统计可能困惑 | 审计仅白名单字段，值自由；README 与设计文档写明该标签不属于 catalog |
| 规则与 `protectPaths` 语义重叠 | 同一写入被两条规则判定 | 取严：存档规则先行且更严，`protectPaths` 维持原语义、不把存档根塞进它的配置面；D90 记明 |
| 取票规则误判正常命令 | 把「文档里出现 auth token 字样」当成调用 | 只认可执行文件 token 命中 CLI 名（或 `node`/`npx`/`env` 前缀后紧跟 CLI 路径）且参数序列出现 `auth`→`token`；`cat`/`grep`/`read` 不受影响（用例覆盖） |
| 取票规则被运行期拼装绕过 | 脚本自取令牌 | 与运行期自算路径同类：明确不覆盖，只有隔离证据能补；#434 判据③ 不勾选（§8.3） |
| 会话内其它并行改动 | 冲突 | 开工 `git status --short`；同一文件不由两个执行者写 |

**已裁决（2026-11-24，用户）**：

1. **D90 最小范围扩展：批准**——允许 `forge-policy` 在 catalog 解析前检查 Agent 工具调用中可判定的路径，范围仅限凭据后端实际使用的库目录及密钥目录，覆盖读、写、删；D22 的写动作 catalog 继续沿用；规则定位为**显式路径防误触**；默认启用须通过企业装配与授权验收；#434 第 4 项勾选仍需执行环境隔离或等价证据。落地为 `denyIamStoreAccess`（§4、§5）。
2. **`auth token` 授权：Agent 默认拒绝，不提供逐次确认放行**——`auth whoami` 可供 Agent 查询身份；`auth token` 保留给用户与已授权受信集成，Agent 工具调用默认拒绝；Agent 需要执行获准业务操作时，由受信组件取用令牌并发起请求，只向 Agent 返回业务结果。落地为 `denyIamTokenAccess`（§3.1 第 4 条、§5），验收须确认拒绝发生在 CLI 启动前，并区分「已拒绝经工具分发的调用」与「已约束任意子进程取票」两类证据；宿主无法执行前者时该项保持待验收。

**仍待裁决**：

- **`file_path` 空洞**：`protectPaths` 当前不认 `file_path`，`write` 写受保护根不受该规则拦截；本稿不动它，是否另开 issue 修复。

**本次不处理**：通用 `protectPaths`/`paths.append`/`enforceProcessRules`/`denyHumanRecord`/`denyUnknownAction` 的既有语义（P3 已在 `main` 实现，本任务不改）；`run_code` 子派发的覆盖结论（探针记录，不修宿主）；其他业务插件的本地数据目录；企业 IAM 服务端鉴权与审计上报。

---

## 10. Luna 执行清单

| # | 任务 | 完成条件 | 提交点 |
|---|---|---|---|
| 0 | **探针闸门**（§5 步骤 0）：P0（宿主事件面，`scripts/probe/run-store-access-p0-probe.mjs`，**已执行 15/15 通过**）与 P1（真实企业组合包另跑一轮） | 探针记录落盘（脱敏，`docs/design/verification/iam-store-access-p0.md`、`iam-store-access-p1.md`）；**P0-A 未通过即停止**；P1-A/B/C/D/E 任一未通过则企业装配不宣称守卫生效 | P0-A/C 已过；P1-A/B/C/D/E 已全部通过（2026-11-24）；P0-B 部分覆盖（`run_code` 未注册） |
| 1 | 分支与工作区核对：`git switch -c feat/issue-375-iam-store-access origin/main`；`git status --short` 确认 `docs/teamflow/**` 未跟踪产物不被覆盖 | 工作区干净（除已知未跟踪产物） | — |
| 2 | 新建 `src/store-protection.mjs` + `test/store-protection.test.mjs`（§5 步骤 1，含 `judgeTokenInvocation`） | 单测全绿；位置服务注入、无双平台黄金表；取票五种形态命中、`auth whoami`/非 CLI 文本不命中、运行期拼装断言不覆盖 | 步骤 1 |
| 3 | `config.mjs` 增两条开关（**不加目录配置面**）、`pipeline.mjs` 增 `store-access` 阶段（§5 步骤 2） | config/pipeline 用例全绿；`store: {...}` 被拒；两条开关各自可单独装配 | 步骤 2 |
| 4 | keychain 提供 `credentials-store-location`（含 `isDefault`）；`gate.mjs` 先行判定（存档 + 取票两个分支）、`installer.mjs` 位置校验与两个冲突分支、服务投影、`index.mjs` 导出（§5 步骤 3） | `apply.test.mjs` 全绿；缺失、变量不一致、变量缺席+自定义目录三种情况装载被拒，默认目录放行；只开取票规则时无位置服务也可装载 | 步骤 3 |
| 5 | `test/gate-store.test.mjs` 全矩阵（存档 + 取票 + 不覆盖项）+ 真实合成库副作用断言 + 未修版本对照（§5 步骤 4、§7） | 拒绝/放行/关闭/证据/最小化全绿；`POLICY_IAM_TOKEN_DENIED` 断言 CLI 未启动；对照跑变红 | 步骤 4 |
| 6 | `test/store-command.test.mjs` 词法用例（§5 步骤 5） | 全绿；上限放宽后拒绝用例仍拒绝 | 步骤 5 |
| 7 | **无需改补丁**：企业包插入 keychain 后守卫自动生效（§5 步骤 6，前置 P1-A/B/C/D/E 与 §8.4 通过） | patch 形状用例、`pnpm check:repo`、P1-D 三装配结论齐备（叠装两方向守卫生效）、P1-E 取证齐备 | 步骤 6 |
| 8 | 文档同步六处（§5 步骤 7，含 D90/D91；两项均已由用户裁决，按已确认写） | `pnpm check:docs` 零断链 | 步骤 7 |
| 9 | 全量验证 C1–C8、P0/P1 结论入 PR 说明、按 §8.5 回填 #434（只记录不勾选） | 命令与结果如实记录；未实测项标注 | 步骤 8 |
| 10 | 交付汇总 | 文件清单、验证命令与结果、提交 hash、探针结论、未验证项（P0-B/P0-C/P1-C/P1-D/P1-E 中未取证者）、待裁决项（`file_path` 空洞） | — |

**执行纪律**：不修改 DSH 本体；不改 `protectPaths`/`paths.append` 既有语义；不为通过用例放宽拒绝条件；拒绝分支一旦出现「记录失败就放行」即缺陷；每步提交前检查暂存 diff 只含本任务改动；提交说明不以 `#` 起头。

---

## 11. 评审处置（V0.1.1）

| 评审问题 | 级别 | 本稿处置 | 位置 |
|---|---|---|---|
| 用调用前检查承接「只能经授权 API」 | 阻塞 | 声明可达性边界；把执行边界探针提为开工闸门；判据 ① 明确为部分满足、不勾选 | §1、§4.4、§8.2、§8.3 |
| 先做目标宿主探针、再决定实现 | 阻塞 | 新增步骤 0 与 P0-A/B/C 出口判据；P0-A 不过则不实现 | §5 步骤 0、§8.2 |
| 企业默认启用与 #434 勾选等验收 | 阻塞 | 步骤 6 以前置探针为条件；回填只记录不勾选 | §5 步骤 6、§5 步骤 8、§8.5 |
| 目录须绑定后端实际打开的目录 | 阻塞 | 位置服务为唯一真源（含 `isDefault`）；配置面整体撤销；冲突码拒绝挂载；删除平台布局镜像 | §4.5、§5 步骤 1/3、§6.3 |
| 公开 API 授权单独验收 | 阻塞 | 新增 §8.4（八行，GET/POST 各分未认证与已认证）；`auth token` 授权列为待裁决（V0.1.4 已裁决：Agent 默认拒绝，见 §14） | §8.4、§9 |
| 以远端 `main` 重写 P3 相关步骤 | 高 | §2.3/§4.3 按 `main` 行号校正；路径复用 `canonicalize`/`matchProtected`；判定位置提到 `preExecute` 最前 | §2.3、§4.3 |
| 字面预筛会击穿 symlink 别名用例 | 高 | 取消判定侧预筛；性能改由候选/词数上限承担；删预筛不得改变判定 | §4.6、§6.4、§5 步骤 5 |
| 验收须验证真实数据与副作用 | 高 | §1.2 改为真实合成库；矩阵增加工具体未执行、库未改动、数据未返回、未修版本对照变红 | §1.2、§5 步骤 4、§7、§8.1 |

**保留的评审认可项**：①在写动作 catalog 早退前判定（§4.3）；②按实际存储目录保护库文件、附属文件与密钥目录（§6.1，目录级判定）。

---

## 12. 评审处置（V0.1.2）

| 评审问题 | 级别 | 本稿处置 | 位置 |
|---|---|---|---|
| 四个 bundle 同时默认开启会破坏独立安装；企业装配中 Policy 若在注册 `pre-execute` 前抛错则不阻断 | P1 | 只改企业 patch（其余三个可独立安装的 bundle 保持关闭，理由写进正文）；新增 P1-D 三种装配实测；P1-C 记录「装载失败仍可直连」的暴露面并明令不得宣称安全 | §5 步骤 6、§8.2、§9 |
| 默认启用条件两套（首页要探针+授权，步骤 6 只要 P0-A）；现有探针禁用了 policy/iam/keychain，只能验证宿主事件 | P1 | 拆成「实现/默认启用/勾选」三道门禁；新增探针 P1（真实企业组合包另跑一轮）并写明现行探针边界（`scripts/probe/run-host-probe.mjs:95`） | §5 步骤 0、§8.2、头部门禁行 |
| 目录单一真源两处未闭合：CLI 变量缺席时仍选默认目录；`store.directories` 语义自相矛盾且模板先于 canonicalize | P1 | 位置服务增加 `isDefault`；删除 `store.directories` 与相关配置面；变量缺席 + 自定义目录同样拒绝挂载；`store: {...}` 按未实现顶层键拒绝 | §4.5、§5 步骤 2/3、§6.3 |
| §8.4 契约错误：`/session` 与 `/token` 应分开验；桥接无独立过期判定；`auth token` 只能记录既有行为 | P1 | 表按实际路由拆成四行（未认证/已认证各两条，含变异头 403）；桥接写明仅回环 + secret + bearer 三项校验、无过期判定；`auth token` 改为「只记录既有行为，不写成授权结论」 | §8.4 |
| §6.4 仍保留字面前缀预筛，与 §4.6 冲突 | P2 | 删除第 ⑤ 条及其风险表表述；性能只靠候选/词数上限承担；别名回归用例保留 | §6.4、§9、§5 步骤 5 |

**对上一轮认可的延续**：①在写动作 catalog 早退前判定（§4.3）；②按实际存储目录保护库文件、附属文件与密钥目录（§6.1，目录级判定）。

---

## 13. 评审处置（V0.1.3）

| 评审问题 | 级别 | 本稿处置 | 位置 |
|---|---|---|---|
| 叠装后规则会被关闭：步骤 6 要求双顺序叠装「规则未启用」，而默认启用门禁又漏了 P1-D | P1 | 步骤 6 改为「企业单装启用、engineering 单装关闭、双顺序叠装两个方向都启用」；P1-D 纳入默认启用门禁；叠装丢规则即判未通过，并给出「补丁层把两处 `heluo-policy` 配置调平、不得靠安装顺序」的补救路径 | §5 步骤 6、§8.2 门禁表、§5 步骤 0 P1-D |
| 装载失败时仍可能暴露凭据库；P1-C 只要求记录 | P1 | P1-C 扩为三种失败态（位置服务缺失、目录错配、卸载）并纳入默认启用门禁；无法阻断即不得默认启用、只能手动启用，同时把暴露面与补救写进 §9 | §5 步骤 0 P1-C、§8.2 门禁表、§5 步骤 6、§9 |
| `auth token` 口径不一致（§8.4 待裁决 vs §9/回填模板「默认放行」） | 口径 | 三处统一为「记录现有 CLI 行为，Agent 授权待裁决」（V0.1.4 已裁决为默认拒绝，§3.2/§8.5 相应改写）：§3.2 契约行、§8.5 回填模板、§9 | §3.2、§8.4、§8.5、§9 |

---

## 14. 裁决落地（2026-11-24，用户）

| 裁决项 | 原话口径 | 本稿落地 |
|---|---|---|
| ① D90 范围扩展 | 「允许 `forge-policy` 在 catalog 解析前检查 Agent 工具调用中可判定的路径，范围仅限凭据后端实际使用的库目录及密钥目录，覆盖读、写、删。D22 的写动作 catalog 继续沿用。规则定位为显式路径防误触，默认启用须通过企业装配和授权验收。勾选 #434 第 4 项仍需执行环境隔离或等价证据。」 | `store-access` 阶段置于 `resolve` 之前（§4.3）；判定对象仅 `<dir>` 与 `<dir>.keys` 两个根（§6.1）；目录来自 `credentials-store-location`，不设被保护根配置面（§4.5）；守卫随位置服务生效、不绑定开关（V0.1.8，裁决 C）；企业装配门禁见 §8.2；#434 勾选独立门禁（§8.3） |
| ② `auth token` 授权 | 「`auth whoami` 可供 Agent 查询身份。`auth token` 保留给用户和已授权的受信集成，Agent 工具调用默认拒绝。Agent 需要执行获准的业务操作时，由受信组件取用令牌并发起请求，只向 Agent 返回业务结果。」「`auth token` 会把可复用的访问令牌写到 stdout。一次确认无法约束令牌进入工具输出后的用途，因此需要把授权放在**具体业务操作**上。验收时应确认拒绝发生在 CLI 启动前，并区分『已拒绝经工具分发的调用』和『已约束任意子进程取票』两类证据。若宿主暂时无法执行前者，Agent 授权项保持待验收。」 | 新增独立开关 `rules.denyIamTokenAccess` 与 `judgeTokenInvocation`（§3.1 第 4 条、§5 步骤 1–3）；**不设确认通道**；拒绝码 `POLICY_IAM_TOKEN_DENIED`、审计 `iam.token.invoke`（§6.2）；验收含 P1-E「CLI 未启动」与两类证据分列（§8.2、§8.4）；运行期拼装取票明确记为不覆盖（§4.4、§3.3） |
| 设计后果（需知会） | — | V0.1.4 曾为裁决②新增第九个开关；**V0.1.8 按裁决 C 全部撤回**：两条守卫都不绑定开关，`RULE_KEYS` 回到七项，`STAGE.STORE` 恒装配。取票守卫与存档守卫同随 `credentials-store-location` 生效，因此没有内置凭据后端的装配（engineering 单装）两条都不判定 |
| 范围确认 | 「直接拒绝一些 bash 命令对 sqlite 文件的操作」是否已足够 | 2026-11-24 用户确认接受当前范围：命令/参数中可判定的存档路径、命令文本点名的存档与取票调用均在 `tools/pre-execute` 拒绝；运行期拼装路径按不覆盖处理，不追加命令名黑名单（误伤仓库自身 SQLite 工具，且可换 `read`/`cp`/`python3 -c` 绕过），不先做执行环境隔离；#434 第 4 项仍以隔离或等价证据为勾选前提（§3.1、§3.3、§8.3） |

---

## 15. 裁决与评审处置（V0.1.8）

| 项 | 处置 | 落点 |
|---|---|---|
| 裁决 C：守卫随位置服务自动生效 | `installPolicy` 无条件注册 `ctx.inject(['credentials-store-location'], …)`；服务出现即 arm 两根，服务缺席即不判定；`STAGE.STORE` 恒在流水线首位、`STAGE_RULES` 不登记它 | §4.5、§5 步骤 2–3 |
| 两个开关取消 | `denyIamStoreAccess`/`denyIamTokenAccess` 移入 `REMOVED_RULE_KEYS`，配置残留时装载期点名拒绝；`RULE_KEYS` 与 `IMPLEMENTED_RULES` 回到七项 | §5 步骤 2 |
| 装载失败不再等于安全 | 删除 `POLICY_STORE_LOCATION_UNAVAILABLE` 拒绝挂载；目录错配只降级为文件名/目录名指纹兜底 | §4.5 第 3、5 条 |
| P1-D 叠装问题 | 补丁层不再写 `rules`，两个叠装顺序都不丢守卫；`tests/plugin-patch-layers.test.mjs` 反向断言保持 | §5 步骤 6 |
| P1 实测 | 企业单装 13/13、两方向叠装各 13/13、engineering 单装 4/4（closed）、目录错配 4/4（fingerprint） | [验证记录](../design/verification/iam-store-access-p1.md) |
