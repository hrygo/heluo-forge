# DSH 宿主扩展点探针（A01 / #20）

在**目标 DSH 宿主进程内**跑一组拟定的行为断言，用来把设计里"待实测"的钩子语义
变成可复现证据。它不使用 mock：插件被真实挂载，工具调用走宿主自己的
`ctx.tools` 管线。

## 运行

```sh
node scripts/probe/run-host-probe.mjs
```

- 需要本机已安装目标 DSH，`dsh` 在 PATH 上（或用 `DSH_BIN` 指定可执行文件）。
- 默认在 `sdk` profile 上叠加一层临时 patch（`DSH_HOST_PROBE_PROFILE` 可改）；
  该 profile 是 stdio JSON-RPC 应用，stdin 关闭即退出，因此不需要模型，也不需要交互。
- 驱动为每次运行创建独立 `DSH_HOME`，避免读取用户 profile；正式组合补丁原样用于配置对照，运行时通过独立测试覆盖层替换为内存凭据夹具并关闭未安装的企业插件。该夹具不证明生产凭据能力。
- 驱动脚本用管道**保持 stdin 打开**，等探针写出拟定结果后再关闭 stdin。实测：stdin 立即 EOF 时
  宿主会在探针跑到一半开始卸载，晚到的注册与派发报 `cannot create effect on inactive context`，
  报告随机少项；保持 stdin 后同一份探针连续复跑稳定（本项为探针自身的生命周期修正，不是被测行为）。
- 探针把拟定结果写到临时目录，驱动脚本打印逐项结论并以退出码反映结果
  （0 全通过 / 1 有失败项 / 2 未产出结果）。
- 环境不具备时（无 `dsh`），`tests/host-probe.test.mjs` 会跳过而不是伪装通过。

## 断言

| 断言 | 含义 |
|---|---|
| `guard-deny-zero-side-effect` | guard 拒绝时工具体零调用，结果为错误且带拒绝理由 |
| `guard-monotonic-no-force-allow` | 先注册的宽松 guard 不能放行后面 guard 的拒绝 |
| `pre-execute-async-deny` | `tools/pre-execute` 的**异步**拒绝决策被采纳 |
| `pre-execute-async-allow` | 异步放行决策后工具体正常执行一次 |
| `pre-execute-ask-without-agent-denies` | `ask` 决策在无 agent 时按拒绝降级（fail closed） |
| `result-observer-throw-keeps-outcome` | `tools/result` 观察者抛错不影响已发生的结果与副作用 |
| `uninstall-cleanup` | 卸载后工具不可见、再调用报 unknown tool，无残留可调用入口 |
| `command-surface-separate-from-tools` | 命令面由独立服务派发，工具管线 guard 看不到该次调用 |
| `approval-never-policy-rejects` | `approval` 策略 `never` 时请求直接 `rejected` |
| `gate-registered-read-runs` | 挂载 `@heluo/forge-policy` 后，登记且开放的动作正常执行一次 |
| `gate-disabled-write-denied` | 未开放写被拒绝，工具体零调用 |
| `gate-unregistered-action-denied` | 映射到未登记动作的工具被拒绝 |
| `gate-missing-target-denied` | 目标缺失被拒绝 |
| `gate-self-reported-readonly-ignored` | 工具自报 `readOnly`/`mutating` 不改变判定 |
| `gate-audit-records-before-and-after-body` | 前置记录先于工具体、执行后由 `tools/post-execute` 补记，记录不含参数正文 |
| `gate-audit-failure-denies-with-zero-effects` | 前置审计不可写时拒绝且工具体零调用 |
| `gate-audit-settle-failure-keeps-outcome-and-limits` | 补记失败保留结果、记缺口、限制后续动作，显式确认后恢复 |
| `delegation-identity-not-model-supplied` | 工具参数里的 `agent`/`principal`/`approved`/`review_kind` 不会成为宿主身份 |
| `model-gate-denies-on-measured-host-state` | 用宿主实测的默认模型选择与可用提供方喂给模型门禁：未登录一律拒绝（官方 API Key 被忽略）；合成输入下验证「指向已禁用模型 → 切到企业模型」分支 |
| `skills-registry-discovery-and-load` | `ctx.skills` 的 provider 路径：目录摘要（名称/描述/何时使用/调用策略）可发现且正文不在摘要里，`get()` 才按需取正文；`invocation` 为 `modelInvocable:false`、`userInvocable:true`；加载不写文件 |
| `agent-scoped-restriction-is-per-scope` | 用 `agents.create` + `setup` 拿到该 agent 作用域，`restrict({deny:['bash']})` 后带 agent 的视图看不到该全局工具、全局视图不变，解除后恢复 |
| `protected-root-resolution` | 宿主进程里 `DSH_HOME` 是否可用、宿主 home 解析器能否在插件内导入（只记事实，不记字面路径） |
| `gate-protected-path-denied` | 受保护根内的直接路径被拒绝，工具体零调用 |
| `gate-protected-path-alias-denied` | 相对穿越与 symlink 别名同样被拒绝 |
| `gate-path-outside-root-allowed` | 受保护根之外的路径不受影响 |

## 组合层对照（官方四行禁用，#13 本地区块）

驱动在探针跑完后，用**同一条 patch 栈**再跑一次 `--dump-config`，与不带企业补丁层的基线逐行对照，
逐行给出"profile 中存在的行已落 `disabled: true`"或"profile 中不存在的行出现了 Loader 的
`patch: entry "<id>" not found` 警告"：

```sh
node scripts/probe/run-host-probe.mjs                                 # 应用 packages/forge-enterprise/cordis.patch.yml
DSH_HOST_PROBE_DISABLE_OFFICIAL=0 node scripts/probe/run-host-probe.mjs  # 负向对照：应为 composition FAIL、退出码 1
```

- 禁用层来自企业组合包自身的补丁文件，不是探针里的副本；探针只把它当作第二个 `--patch` 层挂上。
- **运行时模型面未验**：探针 profile 的 `llm` 提供方在禁用前后都是 0 个（基线对照同样为 0），
  因此"官方模型不可选、`DEEPSEEK_API_KEY` 不构成旁路"只按 `blocked` 记录，不用 0 个提供方冒充已证明。

## 组合包安装/升级/回退演练（#37 E01）

```sh
node scripts/probe/run-bundle-install-rehearsal.mjs
```

在临时目录里对真实 tarball 做 装 → 用**装好的**补丁层做组合 A/B → 升级 → 回退 → 卸载，
每步核对用户自建文件未被改动，并对比演练前后的 `git status --porcelain` 快照。
环境变量：`DSH_BIN`（默认 `dsh`）、`DSH_HOST_PROBE_PROFILE`（默认 `sdk`）、
`DSH_INSTALL_REHEARSAL=0` 可让用例跳过。退出码 0/1/2 与探针一致；证据写临时目录的
`install-rehearsal.json`（只含布尔、版本号与退出码）。不联网、不安装 pnpm、不触碰真实 profile。

## 真实委派与继承实验（#20 AC3，宿主探针内）

宿主探针里的 `subagent-inherits-parent-guards-not-view-restrictions`、`delegation-initiator-scope-is-causal-only`、
`delegation-service-start-activation` 三项用宿主自己的 agent 工厂与委派服务跑真实子 Agent：父 agent 按
`parentAgent`/`origin=subagent`/`delegationDepth=1` 创建子 agent，再用**子作用域自己的工具管线**派发调用。
实测：作用域 guard 会约束子 Agent（拒绝生效、工具体零调用），父 agent 视图的 `restrict` 不继承，
作用域内注册的工具不进子视图、子注册不上浮，`dispose` 后都清理；`subagents.startActivation({provider:'fork'})`
接受并建出子会话；`currentInitiator()` 只在显式边界内可读。探针会把会话/存储根覆盖到本次临时目录
（`session-persistence-jsonl` 与 `storage-json` 的 `root`），不在用户 `DSH_HOME` 下留下会话。
证据与复跑：上述三项即探针步 `subagent-inherits-parent-guards-not-view-restrictions`、
`delegation-initiator-scope-is-causal-only`、`delegation-service-start-activation`，运行
`node scripts/probe/run-host-probe.mjs`（目标 DSH；无 `dsh` 时跳过）。实测记录见
[forge-policy 的编制依据](../../docs/design/plugins/forge-policy.md)中「2026-10-24 委派继承实验
（探针 32/32 通过、1 blocked）」。

## Teamflow 证据探针（r13，只读）

两件互不依赖的小事：九类场景矩阵的**夹具断言**与 journal 的**工作区归属**。两者都不调用模型、
不创建 run、不连宿主；所有结论都写进报告表格或退出码，供 QA 复跑。

```sh
node scripts/probe/run-teamflow-scenario-matrix.mjs            # 9 行表骨架，真实宿主列固定 NOT RUN
node scripts/probe/run-teamflow-scenario-matrix.mjs --report <qa-report.md>
node scripts/probe/check-teamflow-journal-roots.mjs --journal <journal.json> --root <授权 worktree>
```

- 矩阵：默认对 `packages/forge-enterprise/skills/**` 与既有团队流用例做静态断言，逐条核对
  9 类场景应当存在的守则；任一守则缺失即非零退出（证明表不是恒绿）。`--report` 校验 QA 报告里的
  同一张表：列齐、`来源类型` 合法（`local-execution`/`host-execution`/`fixture`/`NOT RUN`），
  真实宿主列不是 `NOT RUN` 时必须带命令与时间。真实列只能写 `NOT RUN` 或带证据的实测，不能与夹具列混写。
- journal 根一致性：`classifyJournalRoots({authorizedRoot, journal})` 的**唯一判据是 `workspacePath`**
  （真实路径归一后须位于授权 worktree 内），结果只有 `aligned`/`mismatch` 两态：`workspacePath` 越界
  或缺失即 `mismatch`（退出码 1）；没有 journal 时打印 `journal-roots: NOT RUN (no journal)` 并退出 0——
  缺证不等于失败，也不等于通过。`stateRoot`/`commitRoot` **只作观测**：0.3.2/0.3.3 宿主不提供这两个字段，
  取值按 `missing`/`within`/`outside` 披露到 stderr（缺失打 `journal-roots: stateRoot unknown (host does not
  provide)`），**任何情况下都不翻状态、不改退出码**；`unknown` 不再是终态。
- 退出码：`0` = `aligned`（或无 `--journal` 的 `NOT RUN`）；`1` = `mismatch`；`2` = 用法错误或 journal
  不可读。journal 里的字段假定为绝对路径，相对路径按当前 cwd 解析，探针不额外裁决。
- `tests/teamflow-evidence-tools.test.mjs` 对 journal 部分覆盖六类用例：`workspacePath` 落在授权
  worktree 内 → `aligned`；仅观测字段越界 → 仍旧 `aligned` 且退出 0；`workspacePath` 指向主工作目录 →
  `mismatch`；`workspacePath` 缺失 → `mismatch` 且退出 1；无 journal → CLI 打印 `NOT RUN` 并退出 0；
  用法与 IO 错误 → 退出 2。矩阵部分仍是表格纪律的正反例，与 journal 用例互不共用代码。

## 边界

- 只证明**宿主钩子语义**。企业侧证据（真实 IAM、真实 Gitee/DevOps 权限、
  受控写批准）不在本探针范围，也不能用它替代。
- **已实测**：真实 agent 会话可在 `sdk` profile 创建（`agents.create({sessionId, meta, setup})`），
  且作用域限制只落在该 agent 视图（见 `agent-scoped-restriction-is-per-scope`）。
- **已实测（目标 DSH）**：子 Agent 的限制继承——作用域 guard 会约束子 Agent（拒绝生效、工具体零调用），
  父 agent 视图的 `restrict` **不**继承（子视图仍看得见被父视图拒绝的全局工具）；作用域内注册的工具
  不进子视图，`dispose` 后限制与子注册都清理。子 Agent 由宿主工厂按 `parentAgent`/`origin=subagent`/
  `delegationDepth=1` 创建，该实验不需要模型参与。复跑 `node scripts/probe/run-host-probe.mjs`
  （步 `subagent-inherits-parent-guards-not-view-restrictions`），记录见 forge-policy 编制依据
  「2026-10-24 委派继承实验（探针 32/32 通过、1 blocked）」。
- **未跑通（报告里单列 `blocked`）**：官方行的**运行时**模型面（本 profile 无 LLM 提供方）；
  「模型自决调用」是否绕开门禁由模型门禁探针另行覆盖（见 forge-policy §9.2.2/§9.3），不属本探针。
- 已知子 Agent provider 为 `spawn`（`inheritsParentContext: false`）与 `fork`（`true`），这是声明事实，
  不等于继承行为；上面的继承结论来自作用域工具管线的真实派发实测，不依赖该声明。
- 尚未覆盖：策略与沙箱的叠加顺序、审批 UI 的注册方式与超时语义、`$DSH_HOME` 确切范围。
  这些在对应设计的未决事项里保留并注明截止门禁。
- 探针插件只在探针 profile 内挂载，不写入任何用户 profile，也不改宿主代码。

## SSE 心跳与空闲看门狗（#203）

```sh
node scripts/probe/sse-heartbeat-probe.mjs --heartbeat-ms 15000 --first-token-ms 70000
```

本地起一个只回 SSE 的 HTTP 服务：按 `--heartbeat-ms` 下发 `: ping` 注释行，按
`--first-token-ms` 才发第一个 `data:` 增量，然后把这条流交给宿主同款 pi-ai 解析器。
输出 JSON 列出每个解析事件的到达时间、首字之前的全部事件，以及 `leakedContent`
（首字之前出现的内容增量数，应为 0）。

用途是回答“心跳是否给空闲看门狗续命”。实测结论：注释行不产生解析事件，只有首个
响应字节会产生一次 `start`；因此宿主的 `streamIdleTimeoutMs` 不能把心跳当作存活信号。
`--pi-ai` 或 `PI_AI_DIR` 可指向宿主安装的 `@earendil-works/pi-ai`，默认取
`$DSH_HOME/profiles/node_modules/...`。

## 模拟 IAM 与模型网关（交付包目标机验证）

```sh
node scripts/probe/mock-iam-gateway.mjs
```

单文件、只依赖 Node 标准库的模拟 IdP + 网关：Discovery、授权码 + PKCE S256、RS256
ID Token 与 JWKS、刷新轮换、撤销（POST 表单与 D1 的 `GET ?access_token=` 两种形态），
以及 `/v1/models` 与流式对话。默认 `http://127.0.0.1:5599`（issuer）与
`http://127.0.0.1:5600/v1`（网关），可用 `MOCK_IAM_PORT`、`MOCK_GATEWAY_PORT`、
`MOCK_CLIENT_ID`、`MOCK_SUBJECT` 覆盖。

用途是在没有企业 IAM 的机器（含 Windows 虚拟机）验证**已按同一 issuer 打包**的交付包：
浏览器登录、回调、凭据保存、模型列表与对话都能走完。它不产生真实令牌，也不校验真实
主体与权限；企业联调仍需真实 IAM 与网关。

## 专家智能体插件建包前宿主预检（#246）

```sh
DSH_BIN=/path/to/dsh FORGE_EXPERTS_TARGET=web node scripts/probe/run-forge-experts-host-preflight.mjs
```

在独立临时工作区生成仅供取证的 `@heluo/forge-experts` Host + Client 夹具，调用
`scripts/build-enterprise-bundle.mjs --root <tmp> --entry @heluo/forge-experts` 走真实构建器
产出独立 tarball（含 `bundle-manifest.json` 与 `SHA256SUMS`），再在隔离的 `DSH_HOME` 中完成：

- 离线安装与 `auditReleaseClosure` 包体闭包核验；
- 浏览器侧单 bundle 契约校验（`window.__ModuleLoader__.load`、`settings.section` 与 `inputTriggers.registerSource` 注册及注销，注销走 `ctx.effect`）；
- 目标 profile 的 `--dump-config` 补丁层装配检查：要求 `webServer`、`connection`、`storageDomain`、`ui-settings`、`ui-input-trigger` 五行均可见，缺项记 `BLOCKED`；`forge-iam` 属兄弟包，仅记录不要求；
- 真实宿主运行时激活（Cordis 4 + Loader + 真实 `storage`／`storage-json`／`storage-domain`）：同源路由鉴权（`401` / `403`）、SSE `ready` 帧、PUT 落盘与 `revision`、卸载后路由注销与服务消失，以及跨 Host 重启的偏好回读。

环境与版本纪律：

- 宿主接缝与独立 profile 的行为**不锁定宿主版本**：`--version` 与 `.dsh-version` 不一致时仍继续取证，并把「目标版本一致性」单列为 `target-version-pin`（不符记 `NOT RUN`）——其它版本的 `PASS` 只证明同构接缝，不冒充目标版本证据；
- `FORGE_EXPERTS_TARGET=desktop` 目前只校验 `DSH_APP` 存在性并记 `BLOCKED`（`dsh --profile desktop` 被 CLI 拒绝，桌面激活未实现），不伪装为 `FAIL`；
- Linux/macOS 桌面发行物的 SDK 位于 ASAR 内时，脚本会在做任何检查之前用对应 Electron 运行时重入一次，父进程只转发子进程结果，不重复取证。

证据边界：`storageDomain` 由宿主自带的 `@deepseek-ai/dsh-storage`、`dsh-storage-json`、`dsh-storage-domain` 原样装配，
`DomainSpec` 校验、`Domain.table`／`KvTable` 语义与重启回读都走真实实现；`host-storage-domain-restart-readback` 若发现
宿主未提供 `storageDomain`（或装配失败）仍记 `NOT RUN` 并注明 `storageKind`。夹具只 `provide` `webServer` 与 `connection`
两项按真实签名实现的替身，因此 `host-runtime-routes-sse-and-unload` 证明的是夹具在真实 Cordis 下的装配、鉴权与卸载，
不替代目标宿主自带 webserver/connection 的端到端验收。

在非目标宿主版本上取证时，`target-version-pin` 记 `NOT RUN`，退出码因此为 `2`；这是预期结果——宿主项
`PASS` 仍然有效，只是不能据此宣称 §5.2 的目标版本要求已满足。

每项结果按 `PASS`、`FAIL`、`BLOCKED`、`NOT RUN` 逐项记录并写入 `$TMPDIR/forge-experts-host-preflight-<pid>-<ts>.json`
（临时工作区在退出时删除；不触碰真实 `DSH_HOME` 与仓库工作区，并在 `finally` 中核对工作区未变）。退出码：`0` 全部
`PASS`，`1` 存在 `FAIL`，`2` 缺少目标启动器、发行物或前置证据（`BLOCKED` / `NOT RUN`）。

## IAM 存档访问拦截（步骤 0 P0 探针）

```sh
node scripts/probe/run-store-access-p0-probe.mjs
```

驱动脚本在临时目录建**真实合成库**（`credentials.sqlite` 含 `records` 与模拟新增的
`future_table`）、密钥目录与一份根外文件；用独立 `DSH_HOME` 从 `sdk` 模板引导 `dev`
profile，再以临时 patch 挂载 `store-access-p0-plugin.mjs`（`DSH_BIN` 可换目标可执行
文件，`DSH_HOST_PROBE_PROFILE` 可换 profile）。探针插件在 `tools/pre-execute` 上按
「路径落在合成存档根内」「命令文本点名存档或 `auth token`」判定拒绝，并直接调用
`ctx.tools.execute()` 派发内建工具，断言拒绝后工具体零执行、库内容与
`PRAGMA data_version` 未变、根外访问不受影响。

| 断言 | 含义 |
|---|---|
| `deny-read-store-db` / `deny-read-keyring` | `read` 指向库文件或密钥文件被拒，返回文本不含 canary |
| `deny-write-store-file` / `deny-edit-store-file` | 写入/编辑存档被拒，附属文件未创建 |
| `deny-bash-sqlite-select` / `deny-bash-sqlite-future-table` | `sqlite3` 查询库或新增表都被拒（按文件判定，不依赖表名） |
| `deny-bash-sqlite-write-keeps-data` / `deny-bash-remove-store` | 改写与删除被拒，库文件、记录内容与 `data_version` 不变 |
| `deny-auth-token-before-cli` | `sh -c '… auth token'` 被拒，包装脚本哨兵未生成 |
| `deny-terminal-send-store` | `terminal_send` 指向不存在的会话也被前置拒绝，证明判定在会话查找之前 |
| `run-code-coverage` | `run_code` 未注册时记为 `available: false`，不计为覆盖 |
| `deny-registered-tool-zero-execution` | 登记工具的工具体在拒绝时零调用 |
| `allow-read-outside-store` / `allow-bash-outside-store` | 根外读写放行，判定范围收窄在存档根 |
| `store-unchanged-after-denials` | 全部拒绝后库行数、canary 与 `data_version` 一致 |

判定轮之后，驱动还会**不装判定**跑 `read-only`、`workspace-write`、`danger-full-access`
三种权限模式（环境轮），把合成库复制到 `$HOME/.forge-p0-sandbox-<rand>/iam-store` 后观察
沙箱对存档目录与工作区的读/写；用 `bash` 发起是为了区分工具层策略与执行环境限制。
注意 `bash` 在沙箱拒绝写入时 `isError` 仍为 `false`，拒绝只出现在 stderr 文本里，判定要
按文本与文件是否创建来做，不能只看 `isError`。

2026-11-24 实测（`0.2.1-rc.5`，node v24.13.0，darwin-arm64）：判定轮 15/15 通过、
`denials=11`、退出码 0；环境轮显示写受模式约束、**读不受限**（三种模式下 `sqlite3` 都能
读到 canary 明文）。记录见
[docs/design/verification/iam-store-access-p0.md](../../docs/design/verification/iam-store-access-p0.md)。
它只证明宿主事件面与拒绝的零执行，不代表企业装配下规则已挂上（P1-A…E 另行取证），
也不证明执行环境能阻止读取存档。

## `run-store-access-p1-probe.mjs`（P1：企业装配）

P0 探针验证宿主事件面；P1 探针验证**真实装配**：把仓库内的 `forge-policy`、
`forge-credentials-keychain`、`forge-iam` 复制进 profile 的 `@heluo/` 命名空间，以 `--patch`
依次应用被测补丁，再用 overlay 让 keychain 使用同一临时目录并挂载
`store-access-p1-plugin.mjs`（只派发真实工具，不实现判定）。

```sh
node scripts/probe/run-store-access-p1-probe.mjs --label enterprise
node scripts/probe/run-store-access-p1-probe.mjs --label stack-engineering-first \
  --patch packages/forge-engineering/cordis.patch.yml --patch packages/forge-enterprise/cordis.patch.yml
node scripts/probe/run-store-access-p1-probe.mjs --label stack-enterprise-first \
  --patch packages/forge-enterprise/cordis.patch.yml --patch packages/forge-engineering/cordis.patch.yml
DSH_HOST_PROBE_EXPECT=closed node scripts/probe/run-store-access-p1-probe.mjs \
  --label engineering-only --patch packages/forge-engineering/cordis.patch.yml
DSH_HOST_PROBE_EXPECT=fingerprint node scripts/probe/run-store-access-p1-probe.mjs \
  --label mismatch --keychain-default
```

| 断言 | 含义 |
|---|---|
| `assembly-policy-mounted` | policy 已挂载且 `storeDirectories()` 为两条（叠装时最多等 5 秒，等 keychain 注入回调 arm） |
| `deny-read-store-db` / `deny-read-keyring` | `read` 指向库或密钥被拒，文本不含 canary |
| `deny-write-store-file` / `deny-bash-sqlite-select` / `deny-bash-cat-store` / `deny-glob-store` / `deny-bash-remove-store` | 写、查询、搬运、遍历、删除存档都被拒 |
| `deny-auth-token` / `deny-auth-token-before-cli` | 取票被拒；包装脚本哨兵未生成，证明 CLI 未启动 |
| `allow-whoami` / `allow-read-outside` | `auth whoami` 与根外读取不被策略拒绝 |
| `store-unchanged-after-denials` | 全部拒绝后 canary 行与 `data_version` 未变 |

`--keychain-default` 让 keychain 保持平台默认目录、`HELUO_FORGE_STORE_DIRECTORY` 仍指向临时
目录，用来制造目录错配；`DSH_HOST_PROBE_EXPECT=fingerprint` 切换为指纹兜底断言，
`DSH_HOST_PROBE_EXPECT=closed` 断言 engineering 单装下守卫不判定（没有任何拒绝文案）。

守卫不绑定规则开关（2026-11-24 裁决 C）：`forge-policy` 无条件注入 `credentials-store-location`，
keychain 提供该服务即生效，服务始终缺席即不判定。补丁层因此不写 `rules`，五个场景都不需要
额外开关，也不受 Cordis「config 后者整体覆盖」影响。

2026-11-24 实测：企业单装 13/13、engineering→enterprise 13/13、enterprise→engineering 13/13、
engineering 单装 4/4（closed）、目录错配 4/4（fingerprint）。
记录见 [docs/design/verification/iam-store-access-p1.md](../../docs/design/verification/iam-store-access-p1.md)。

## `run-task-acceptance.mjs`（任务级：测试专用 profile + mock 模型）

P0/P1 由探针插件直接派发工具调用。本脚本再往前一步：起一个临时的 headless profile，
用本地 OpenAI 兼容 SSE 服务冒充模型，让模型按脚本自己发出四次工具调用，跑完真实会话循环。

```sh
node scripts/probe/run-task-acceptance.mjs            # 临时目录，结束即清理
node scripts/probe/run-task-acceptance.mjs --keep     # 保留 profile 与会话事件
node scripts/probe/run-task-acceptance.mjs --out /tmp/task-accept.json
```

装配：`DSH_HOME` 指向临时目录，从 `headless` 模板引导 `forge-task`；复制仓库内的
`forge-policy`、`forge-credentials-keychain` 到 profile；overlay 禁用官方 `credentials`、
插入 keychain（合成目录）与 policy（企业同款写动作目录 + 内存审计）、把默认模型指向
`mock-local`。凭据库由 keychain 包自己初始化，再追加 `records`、`future_table` 两张扩展表。

| 断言 | 含义 |
|---|---|
| `tool-calls-dispatched` | 模型真的发出 4 次调用，而不是脚本直派 |
| `deny-read-store-db` / `deny-bash-sqlite` | `read` 与 `bash sqlite3` 都得到「只能经公开接口访问」 |
| `deny-bash-auth-token` | 取票命令得到「不得直接调用」 |
| `allow-benign-read` | 仓库内普通读取不受影响 |
| `store-unchanged` | 拒绝后 `records`、`future_table` 与 canary 均未变 |
| `no-canary-in-events` | 事件流不含 canary 明文 |
| `cli-never-started` | 取票被拒时哨兵文件未生成，CLI 未启动 |
| `final-message` | 会话以最终文本结束 |

2026-11-25 实测：连续三次 11/11，退出码 0，单次约 20 秒。
记录见 [docs/design/verification/iam-store-access-task.md](../../docs/design/verification/iam-store-access-task.md)。

## `run-primary-runtime-probe.mjs`（内置运行时：`web` profile 里的到达性）

回答 [CORP-DSH-PLAN-026 §3 #9](../../docs/plans/2026-11-19-desktop-bundle-packaging.md)：桌面壳随包携带的
运行时，能否在不修改上游的前提下到达 `web` profile 的 agent。在临时 `DSH_HOME` 里引导 `web` profile，
把探针插件挂在末尾，在宿主进程内用宿主自己的工具管线核对；再跑一组不带解锁的基线作对照。
不接真实模型或网关。

```sh
# 先按发布流水线的顺序暂存：dsh 闭包，再是内置运行时（它的布局取自暂存好的 dsh）。
node scripts/stage-desktop-payload.mjs --output <staged> --dsh-tgz <dsh.tgz> --pnpm-tgz <pnpm.tgz>
node scripts/stage-primary-runtime.mjs --target <mac-arm64|win-x64> --output <staged>/resources \
  --pnpm-tgz <pnpm.tgz> --dsh-modules <staged>/resources/dsh/node_modules

node scripts/probe/run-primary-runtime-probe.mjs --resources <staged>/resources
node scripts/probe/run-primary-runtime-probe.mjs --resources <staged>/resources --electron <应用二进制>
node scripts/probe/run-primary-runtime-probe.mjs --resources <staged>/resources \
  --bundle <heluo-forge-enterprise-*.tgz> --keep --out /tmp/primary-runtime-probe.json

# 以打出来的应用包为准：包内的 dsh 闭包与载荷，应用自己的 Electron 与 app.asar 里的壳入口（目前只认 macOS 的 .app）。
node scripts/probe/run-primary-runtime-probe.mjs --app <staged 以外打出来的 .app> \
  --bundle <heluo-forge-enterprise-*.tgz>
```

解锁的两种交付方式都要成立：默认由 `--patch` 覆盖层携带两行（原文取自
`packages/forge-enterprise/cordis.patch.yml`）；给出 `--bundle` 时改为安装该企业底座包，由它的补丁层
交付这两行。`--electron` 让 dsh 以 Electron 的 Node 模式运行，与桌面壳一致。给出 `--app` 时以打出来的应用包为准，
与桌面壳的启动方式一致。退出码：0 全部通过；
1 有失败项；2 前置条件不具备。

| 断言 | 含义 |
|---|---|
| `探针在宿主内运行` | 探针插件在真实 `web` profile 进程内跑完并写出结果 |
| `应用二进制可作为 Node 运行`（仅 `--app`） | 应用自己的 Electron 能以 Node 模式启动，壳的入口与 dsh 都靠它 |
| `建出带默认 preset 的真实 agent 会话` | 按 web 会话控制器的方式组装：解析默认 preset，在 agent 的 setup 里挂载 |
| `Loader 对这两行没有告警` | 两行按 id 命中，没有 `not found` 或 `name` 不匹配 |
| `工具在宿主层注册`、`工具对 agent 可见` | `ctx.tools.get` 在宿主层与 agent 作用域都取得到 |
| `agent 的调用成功`、`首次调用把载荷安装到 Harness home` | 返回绝对路径，路径在 `$DSH_HOME/dsh-runtimes/` 之下 |
| `安装后的 runtime.json 与暂存的一致` 等四条 | 清单相同、别名是相对链接、报出 node / pnpm 与各发行包版本、再次调用路径不变 |
| `Office 技能把模型指向内置依赖` | 技能正文让模型调用 `load_workspace_dependencies`，而不是找 PATH 上的 Python |
| `agent 的 shell 用内置 Python 跑起 Office 库` | 在 agent 作用域里派发 `bash`，跑通 numpy、pandas 与三个 Office 库 |
| `之后的会话复用已安装的载荷` | 第二个进程再调用时，安装目录没有被重建 |
| `基线：…` 四条 | 不带解锁时工具未注册、调用被拒、技能指向用户自己的 Python、没有安装任何东西 |
| `暂存的载荷没有被写入，也没有变大` | 工具运行期间暂存目录的文件数不变 |

2026-11-26 实测（macOS arm64，DSH 0.2.2-rc.5 的闭包与 mac-arm64 载荷）：`--patch` 配 Electron 44.7.0
运行器 23/23；企业底座包配 Node 24.21.0 运行器 27/27；`--app` 配企业底座包 28/28；单次约 60 秒。
记录见 [docs/design/verification/desktop-primary-runtime.md](../../docs/design/verification/desktop-primary-runtime.md)。
