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
| `skills-registry-discovery-and-load` | `ctx.skills` 的 provider 路径：目录摘要（名称/描述/何时使用/调用策略）可发现且正文不在摘要里，`get()` 才按需取正文；`invocation` 为 `modelInvocable:false`、`userInvocable:true`；加载不写文件 |
| `agent-scoped-restriction-is-per-scope` | 用 `agents.create` + `setup` 拿到该 agent 作用域，`restrict({deny:['bash']})` 后带 agent 的视图看不到该全局工具、全局视图不变，解除后恢复 |
| `protected-root-resolution` | 宿主进程里 `DSH_HOME` 是否可用、宿主 home 解析器能否在插件内导入（只记事实，不记字面路径） |
| `gate-protected-path-denied` | 受保护根内的直接路径被拒绝，工具体零调用 |
| `gate-protected-path-alias-denied` | 相对穿越与 symlink 别名同样被拒绝 |
| `gate-path-outside-root-allowed` | 受保护根之外的路径不受影响 |

## 边界

- 只证明**宿主钩子语义**。企业侧证据（真实 IAM、真实 Gitee/DevOps 权限、
  受控写批准）不在本探针范围，也不能用它替代。
- **已实测**：真实 agent 会话可在 `sdk` profile 创建（`agents.create({sessionId, meta, setup})`），
  且作用域限制只落在该 agent 视图（见 `agent-scoped-restriction-is-per-scope`）。
- **未跑通（报告里单列 `blocked`）**：**子** Agent 是否继承父作用域限制，需要一次真实委派
  （会触发模型调用），当前探针环境没有可用模型；已知的子 Agent provider 为 `spawn`
  （`inheritsParentContext: false`）与 `fork`（`true`），这是声明事实，不等于实测继承行为。
- 尚未覆盖：策略与沙箱的叠加顺序、审批 UI 的注册方式与超时语义、`$DSH_HOME` 确切范围。
  这些在对应设计的未决事项里保留并注明截止门禁。
- 探针插件只在探针 profile 内挂载，不写入任何用户 profile，也不改宿主代码。
