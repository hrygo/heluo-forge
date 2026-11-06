# HOST-PROBE 处置结论与根因取证（K-1）

- 需求：`docs/teamflow/20261106-r2/`（PRD AC-12 / AC-13 / AC-14）
- 关联：`tests/host-probe.test.mjs`、`scripts/probe/run-host-probe.mjs`、`scripts/probe/host-probe-plugin.mjs`、`scripts/lib/host-probe-gate.mjs`
- 结论：**采用版本门控（A 方案）**——非目标宿主（`.dsh-version`）上两例显式 skip，skip 文案含实际版本、目标版本与 K-1 原因；`DSH_HOST_PROBE_FORCE=1` 可强制复跑；断言、`node --test` 归属均不改变。
- 状态：K-1 在 rc.5 上仍开放（探针契约与 rc.5 返回值形状不符），目标 rc.3 的实测结果必须回填，见 §7。

## 1. 现象

本机宿主：DSH `0.2.1-rc.5`，Node `v24.13.0`，`darwin-arm64`；目标宿主（`.dsh-version`）：`0.2.1-rc.3`。

`node --test tests/host-probe.test.mjs`：**2 fail / 0 pass**（门控落地前的判据）。门控落地后同一命令为 **2 skip**（见 §5）。

探针输出（完整失败摘要）：

```text
probe: 0.2.1-rc.5 | node v24.13.0 | darwin-arm64
probe: forge-host-probe on 0.2.1-rc.5 (node v24.13.0, darwin-arm64)
probe: 12/32 checks passed, 1 blocked
```

异常文本（20 个失败项的 detail 同构）：

```json
{"result":{"threw":"Cannot read properties of undefined (reading '0')","cause":""}}
```

FAIL 清单（20 项，按报告顺序）：

```text
delegation-identity-not-model-supplied
guard-deny-zero-side-effect
guard-monotonic-no-force-allow
pre-execute-async-deny
pre-execute-async-allow
pre-execute-ask-without-agent-denies
result-observer-throw-keeps-outcome
uninstall-cleanup
gate-registered-read-runs
gate-disabled-write-denied
gate-unregistered-action-denied
gate-missing-target-denied
gate-self-reported-readonly-ignored
gate-protected-path-denied
gate-protected-path-alias-denied
gate-path-outside-root-allowed
gate-audit-records-before-and-after-body
gate-audit-failure-denies-with-zero-effects
gate-audit-settle-failure-keeps-outcome-and-limits
subagent-inherits-parent-guards-not-view-restrictions
```

通过的 12 项均为不依赖 `ctx.tools.execute()` 返回值的检查；`1 blocked` 为 `official-rows-runtime-model-surface`（本 profile 无 LLM 提供方，禁用前后均为 0，属既有环境阻断，与 K-1 无关）。

## 2. 复跑

```sh
# 直接复跑探针（打印 32 项明细、形状摘要与汇总；失败时 exit 1，探针未产出结果 exit 2）
node scripts/probe/run-host-probe.mjs

# 强制在非目标宿主跑两例测试（预期 2 fail，用于追踪 K-1）
DSH_HOST_PROBE_FORCE=1 node --test tests/host-probe.test.mjs

# 有 Git 远端写权限时登记 issue（命令见 §7，未在本单执行）
```

复跑关键行（逐行可 grep）：

```text
probe: ctx.tools.execute shape kind=object keys=[isError,error,content] resultsLength=n/a
probe: 12/32 checks passed, 1 blocked
probe: evidence kept at <临时目录>/probe-raw.json
```

## 3. 证据链：非本分支引入

基线：`origin/main` = `13b4b7d`；当前分支 `feat/plugin-workflow-new`（HEAD `4033bdc`）。

```sh
git diff --stat origin/main HEAD -- tests/host-probe.test.mjs scripts/probe/run-host-probe.mjs scripts/probe/host-probe-plugin.mjs
# 输出为空（按 HEAD 与 origin/main 的树对比；若省略 HEAD 则对比的是工作区，会带上本单改动）

git diff --name-only origin/main HEAD -- tests/host-probe.test.mjs scripts/probe/run-host-probe.mjs scripts/probe/host-probe-plugin.mjs
# 输出为空
```

逐文件 blob 对照（HEAD 与 `origin/main` 的同一路径内容哈希一致，说明改动前工作区三文件与基线逐字节相同）：

| 文件 | HEAD blob sha256 | origin/main blob sha256 |
| --- | --- | --- |
| `tests/host-probe.test.mjs` | `8ff6d6b217d9fe09640d4aa4e145931857f6ab7ceb624c56e978abc24d0cb867` | 同左 |
| `scripts/probe/run-host-probe.mjs` | `fc7f2550b395cb276bcc4a97f14dc21edf1b37e5e13ddd895161314cbc79ca24` | 同左 |
| `scripts/probe/host-probe-plugin.mjs` | `6c8f67ef2044e69686f834bd83751fbf219266032c29d6b366759beb3edacb3a` | 同左 |

改动前工作区的 `git status --short` 仅有一项未跟踪目录 `?? docs/teamflow/20261106-r2/`（任务夹），无源码改动；在同一棵树上复跑得到与基线一致的失败摘要。因此该失败**不是本分支引入**。

## 4. 根因：`ctx.tools.execute()` 返回形状与探针契约不符

探针统一经 `dispatch()` 派发工具，取值方式为：

```js
const batch = await ctx.tools.execute({ calls: [{ id, name, arguments }], signal });
const result = batch.results[0]?.result;   // 期望 { results: [...] }
```

本机 rc.5 的实测返回形状（探针 additive 记录，见 §6）：

```text
probe: ctx.tools.execute shape kind=object keys=[isError,error,content] resultsLength=n/a
```

即 `execute()` 直接返回**单个结果对象** `{ isError, error, content }`，没有 `results` 数组。于是 `batch.results` 为 `undefined`，`batch.results[0]` 抛出 `Cannot read properties of undefined (reading '0')`，`dispatch()` 捕获后记为 `{ threw: ... }`。20 个失败项全部经由 `dispatch()`，12 个通过项均不依赖该返回值——数量与失败集合完全吻合，排除其他解释。

最小复现：`node scripts/probe/run-host-probe.mjs`（一次运行即打印上述形状行与 20 项 FAIL）；或读 `probe-raw.json` 的 `dispatchShape` 字段。

边界说明：本次只证明 rc.5 的返回形状；目标 rc.3 的实际形状需在目标机复跑后回填（§7）。本单不修改 `dispatch()` 的取值逻辑——那会改变探针行为与断言基线，应随 K-1 修复单独评审。

## 5. 结论：版本门控（A 方案）

判定收在纯函数 `scripts/lib/host-probe-gate.mjs`（`normalizeDshVersion` / `hostProbeGate`），`tests/host-probe.test.mjs` 只负责“skip 或运行”：

| 条件 | 行为 |
| --- | --- |
| `dsh` 不可执行（`spawnSync.error`） | skip；文案含实际错误与目标版本 |
| `DSH_HOST_PROBE_FORCE=1` | 运行（预期失败，用于追踪 K-1） |
| `dsh --version` 归一后为空或 ≠ `.dsh-version` | skip；文案含实际版本、目标版本、`K-1`、`PRD AC-13` |
| 相等 | 运行；无 skip 文案 |

- 本机 rc.5 上 `node --test tests/host-probe.test.mjs` → **2 skip / 0 pass / 0 fail**，两例 skip 文案均为：`宿主版本不匹配（K-1，PRD AC-13）：实际 0.2.1-rc.5，目标 0.2.1-rc.3（.dsh-version）；…设 DSH_HOST_PROBE_FORCE=1 可强制复跑`。
- 断言未删除、未弱化；两例仍在 `node --test` 自动发现路径内；未改为 `todo` 或静默通过。
- `DSH_BIN` 仍可指定目标宿主二进制；`DSH_HOST_PROBE_FORCE=1` 强制时两例按实际结果 fail（本机实测 2 fail，exit 1），符合“预期失败、用于追踪 K-1”。
- 门控只影响“是否运行”，不影响断言内容；门控单测覆盖四分支与归一化负例（`tests/host-probe-gate.test.mjs`）。

## 6. 取证能力（additive）

`scripts/probe/host-probe-plugin.mjs` 在 `dispatch()` 处只读记录首次 `ctx.tools.execute()` 返回形状到报告 `dispatchShape = { kind, keys, resultsLength, threw }`；`scripts/probe/run-host-probe.mjs` 打印一行 `probe: ctx.tools.execute shape …`。该记录**不改变任何检查的通过判据**，失败计数、断言与退出码均与改动前一致（12/32、1 blocked、exit 1）。

## 7. 影响与后续

影响面：

- 本机 rc.5 上探针 20/32 失败，`node --test tests/host-probe.test.mjs` 变红并可能掩盖目标 rc.3 的真实回归；门控后以 skip 隔离，`pnpm check` 恢复可通过。
- 目标 rc.3 的探针结论仍为空，必须在目标机执行 `node scripts/probe/run-host-probe.mjs` 后回填；**不得用本机 rc.5 结果代替**。
- 组成层（`composition`）、回灌检测、行级独立性不受 K-1 影响，本次复跑均为 `ok`。

后续（本单无远端写权限，未执行登记）：

```sh
gh issue create \
  --title "K-1: host-probe 在 DSH 0.2.1-rc.5 上 ctx.tools.execute 返回单结果对象而非 { results: [...] }" \
  --body-file <K-1 正文文件>
```

K-1 正文须含：rc.5 实测摘要（`12/32 checks passed, 1 blocked`、`Cannot read properties of undefined (reading '0')`）、形状行 `kind=object keys=[isError,error,content] resultsLength=n/a`、复跑命令、非本分支引入证据（§3）、目标 rc.3 的回填占位。

回填规则：

1. 编号未确认前，本文与 RUNBOOK 一律写“待登记”，**禁止虚报 issue 编号或链接**。
2. issue 登记后，只在本文 §7 与 RUNBOOK 对应行替换为真实编号/链接，并记录登记日期与执行人。
3. 修复 `dispatch()` 时须同时兼容 `{ results: [...] }` 与单结果对象两种形状，并在 rc.3 与 rc.5 各复跑一次；修复前不得删除本门控。
4. 目标 rc.3 的探针结果回填后，若两例通过，可在 PRD 证据表标注 PASS；若失败，按新缺陷另行登记，不得直接改断言。
