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

## 旧 0600 迁移阻断探针（#107，离线）

```sh
node scripts/probe/run-keychain-migration-rehearsal.mjs
```

当前探针只创建临时合成文件，验证迁移入口不调用目标、读取器或删除器且不改变副本；
探针退出 0 只表示阻断路径符合预期，实际迁移与目标平台验收仍为 BLOCKED，不访问系统钥匙串。
旧版 2026-10-24 的真实钥匙串迁移演练是历史结果，不代表当前入口支持迁移。

## 系统钥匙串 spike（#13 本地区块，仅 darwin）

```sh
node scripts/probe/run-keychain-spike.mjs
```

用 `@heluo/forge-credentials-keychain` 的 macOS Security CLI 适配器（非生产、需显式 opt-in）
在真实系统钥匙串上跑 建/读/改/删、argv 传输拒绝、未命中语义、幂等删除、枚举拒绝与**无明文落盘**，
结束时删除自己创建的测试条目并复核无残留。证据写临时目录的 `keychain-spike.json`（只有布尔与退出码）。
`tests/keychain-spike.test.mjs` 在非 darwin 或 `DSH_KEYCHAIN_SPIKE=0` 时跳过。

- 实测要点：未命中退出码 44；`add-generic-password -U` 覆盖同名条目；口令经 stdin 双次输入写入而不进 argv；
  `list()` 报 `KEYCHAIN_LIST_UNSUPPORTED` 而不是返回空表。
- **不代表生产**：Windows 凭据管理器与 UOS/麒麟 Secret Service 适配器、`@napi-rs/keyring` 产物仍待目标平台核验。

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
- **未跑通（报告里单列 `blocked`）**：官方行的**运行时**模型面（本 profile 无 LLM 提供方，见上），
  以及**子** Agent 是否继承父作用域限制，后者需要一次真实委派
  （会触发模型调用），当前探针环境没有可用模型；已知的子 Agent provider 为 `spawn`
  （`inheritsParentContext: false`）与 `fork`（`true`），这是声明事实，不等于实测继承行为。
- 尚未覆盖：策略与沙箱的叠加顺序、审批 UI 的注册方式与超时语义、`$DSH_HOME` 确切范围。
  这些在对应设计的未决事项里保留并注明截止门禁。
- 探针插件只在探针 profile 内挂载，不写入任何用户 profile，也不改宿主代码。

## 原生凭据存储探针（issue #182）

```sh
node scripts/probe/native-keyring-store-probe.mjs [--service <名>] [--package <目录>] [--platform] [--enumeration] [--json]
```

在目标机上直接对 OS 存储执行读、写、覆盖、跨进程读、删除与幂等删除，输出 JSON 供
issue #182 归档。它不挂载 DSH profile、不联网、不打印存储值；探针键每次随机，跑完自行
删除。`--enumeration` 通过 backend 枚举该探针前缀并报告命中数量。Windows 会先按 key
前缀查找候选，再回读当前 service 的新目标；候选中的旧格式记录会阻断枚举。

重启后的持久性用三段式：首次 `--keep` 留下键并记录 `key`，重启后用
`--key <该键> --expect-present` 复读，再用 `--key <该键> --cleanup` 清除。换一个 OS
用户跑 `--expect-present` 应当是“读不到”（退出码 1），这正是隔离性的期望结果。

只装了制品、没有仓库检出时，用 `--package` 指向安装目录里的包（如
`.../node_modules/@heluo/forge-credentials-keychain`），探针与它的子进程都从该目录加载。

`--platform` 改为使用宿主的平台后端，而不是 addon 映射：macOS 上即应用层加密文档后端
（AES-256-GCM + 0600 密钥），因此 macOS 不要求签名、不要求图形会话，SSH 会话也能直接跑。
不带 `--platform` 且宿主没有 addon 映射（macOS、未列入的平台）时以 `stage: environment`
退出码 2 结束，这是预期行为。

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
