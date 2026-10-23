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

## 边界

- 只证明**宿主钩子语义**。企业侧证据（真实 IAM、真实 Gitee/DevOps 权限、
  受控写批准）不在本探针范围，也不能用它替代。
- 尚未覆盖：子 Agent 是否继承限制（需要真实 agent 会话），策略与沙箱的叠加顺序，
  审批 UI 的注册方式与超时语义。这些在对应设计的未决事项里保留并注明截止门禁。
- 探针插件只在探针 profile 内挂载，不写入任何用户 profile，也不改宿主代码。
