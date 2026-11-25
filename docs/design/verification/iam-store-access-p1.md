# IAM 存档访问 P1 探针记录（步骤 0，企业装配）

本页记录 [IAM 存档访问防护方案](../../plans/2026-11-23-issue-375-iam-store-access-luna-guide.md) 步骤 0 的企业装配轮（P1-A 至 P1-E）执行结果：在真实装配下装载 `packages/forge-policy`、`packages/forge-credentials-keychain` 与 `packages/forge-iam`，验证守卫是否生效、位置服务与目录一致性如何处理、叠装是否丢守卫、取票是否在 CLI 启动前被拒。设计背景见[策略与审计详细设计](../plugins/forge-policy.md)。宿主事件面（P0-A/B）与执行环境面（P0-C）的证据见[P0 探针记录](iam-store-access-p0.md)。

**守卫形态（2026-11-24 裁决 C）**：两条 IAM 守卫不绑定规则开关。`packages/forge-policy` 无条件注入 `credentials-store-location`，该服务由内置凭据后端（keychain）提供；服务出现即生效，服务始终缺席（例如 engineering 单装、没有内置凭据后端）即不判定。`rules.denyIamStoreAccess`/`rules.denyIamTokenAccess` 已取消，配置中出现按「已取消开关」点名拒绝。

**探针与数据**：`scripts/probe/run-store-access-p1-probe.mjs` 在临时目录创建真实 SQLite 库 `store/credentials.sqlite`（探针建 `probe_canary` 表并写入 canary 明文）与密钥目录 `store.keys/`；以独立 `DSH_HOME` 从 `sdk` 模板引导 `p1` profile，把仓库内的 `forge-policy`/`forge-credentials-keychain`/`forge-iam` 复制进 profile 的 `@heluo/` 命名空间，再以 `--patch` 依次应用被测补丁与一份 overlay 补丁。overlay 让 keychain 使用同一临时目录，并挂载 `scripts/probe/store-access-p1-plugin.mjs`（`inject = ['tools', 'policy']`，只派发真实工具、不实现任何判定）。

**环境**：darwin-arm64、DSH `0.2.1-rc.5`、Node `v24.13.0`；`HELUO_FORGE_STORE_DIRECTORY` 指向同一临时目录。所有数据均为合成数据，不接触用户凭据。

## 判定轮（P1-A）

| 检查 | 断言 | 结果 |
|---|---|---|
| `assembly-policy-mounted` | policy 服务已挂载且 `storeDirectories()` 为两条（库目录、密钥目录） | 通过 |
| `deny-read-store-db` | `read` 指向 `credentials.sqlite` 被拒（`POLICY_STORE_ACCESS_DENIED`），文本无 canary | 通过 |
| `deny-read-keyring` | `read` 指向 `store.keys/keyring.json` 被拒 | 通过 |
| `deny-write-store-file` | `write` 指向存档目录内新文件被拒，文件未创建 | 通过 |
| `deny-bash-sqlite-select` | `bash` 的 `sqlite3 … select` 被拒 | 通过 |
| `deny-bash-cat-store` | `bash` 的 `cat <db>` 被拒 | 通过 |
| `deny-glob-store` | `glob` 指向存档目录被拒 | 通过 |
| `deny-bash-remove-store` | `rm -rf <store>` 被拒，库文件仍在 | 通过 |
| `deny-auth-token` | `bash` 的 `heluo-forge auth token` 被拒，输出无令牌 | 通过 |
| `deny-auth-token-before-cli` | 包装脚本 `sh -c 'touch <sentinel>; heluo-forge auth token'` 被拒，**哨兵未生成**（CLI 未启动） | 通过 |
| `allow-whoami` | `node …/heluo-forge.mjs auth whoami --json` 未被策略拒绝（探针环境无登录，CLI 自身退出 4） | 通过 |
| `allow-read-outside` | 根外 `read` 放行 | 通过 |
| `store-unchanged-after-denials` | 全部拒绝后 `probe_canary` 记录内容与 `PRAGMA data_version` 未变 | 通过 |

## 装配矩阵（P1-B、P1-D）

| 场景 | 装配 | 期望 | 结果 |
|---|---|---|---|
| `enterprise` | 企业补丁单装 | 守卫生效、位置服务一致 | 13/13 通过 |
| `stack-engineering-first` | engineering → enterprise | 叠装后守卫仍生效 | 13/13 通过 |
| `stack-enterprise-first` | enterprise → engineering | 同上（反方向） | 13/13 通过 |
| `engineering-only` | engineering 单装 | 无内置凭据后端 → 守卫不生效、policy 正常装载、存档读写放行 | 4/4 通过（`DSH_HOST_PROBE_EXPECT=closed`） |
| `mismatch` | 企业补丁 + keychain 用平台默认目录 + `HELUO_FORGE_STORE_DIRECTORY` 指向临时目录 | 目录错配：不 arm 根，退回指纹兜底 | 4/4 通过（`--keychain-default`） |

- `closed` 模式断言：`closed-policy-mounted`、`closed-store-read-allowed`、`closed-bash-store-allowed`、`closed-token-allowed`（即 engineering 单装下没有任何拒绝文案）。
- 指纹模式断言：`fingerprint-read-store-db`、`fingerprint-bash-sqlite`、`fingerprint-read-outside-allowed`、`fingerprint-no-store-created`。

**P1-D 结论（通过）**：叠装两个方向都生效。此前依赖 `rules` 时，Cordis 按 id 合并补丁条目是「后者整体覆盖 config」，engineering 在 enterprise 之后应用会丢掉 `rules`（实测 2/13）。改为守卫随位置服务生效后，补丁层不再携带这两个开关，两个顺序都不影响守卫。

## 失败态观测（P1-C）

| 失败态 | 观测 | 结论 |
|---|---|---|
| 位置服务始终缺席 | 守卫不判定；`read`/`write`/`sqlite3`/`glob`/`rm` 对存档全部成功 | 等价于没有内置凭据后端（engineering 单装）；企业装配由 keychain 提供该服务 |
| 目录错配 | 服务出现但不 arm 根，按文件名/目录名指纹兜底：读库、`sqlite3` 被拒，根外读取放行 | 冲突不静默放行；指纹兜底覆盖直接点名 |
| 策略装载失败（语法/装配错误） | `tools/pre-execute` 不再被策略占用，工具恢复直连 | 任何挂载失败都失去保护；由 `pnpm check` 与探针守卫 |
| 策略卸载 | 同「装载失败」：守卫随插件卸载消失 | 属于预期，不属于本方案范围 |

> 说明：本轮未单独复现「策略运行中被卸载」的时序，卸载行为按 Cordis 生命周期推断，记为未实测。

## 关键实现事实（供后续实现与评审参考）

- **Cordis 服务可见性由 `inject` 决定**：同级插件未声明 `inject` 时，`ctx.get('credentials-store-location')` 恒为 `undefined`；静态 `export const inject = [...]` 或 `ctx.inject([...], (scoped) => …)` 才可见，且后者会在服务就绪时回调。policy 因此无条件注册注入回调，而不是在装载期直接读服务。
- **叠装时 arming 可能晚于插件装载**：`stack-engineering-first` 下 policy 先于 keychain 的 `provide` 装载，`storeDirectories()` 在插件 `apply` 期间为空，注入回调随后才 arm。探针因此等待最多 5 秒再断言。
- **拒绝码不透传**：`denyWithEvidence` 的 `code` 不进入 `ToolExecutionResult.error`，断言必须匹配拒绝文案。
- **`bash` 参数校验**：宿主 schema 要求 `description`，缺失时报 `missing required property "description"`。

## 未测项

- Windows 与 Linux 的默认目录、密钥目录与沙箱模式。
- 真实登录后的 `auth whoami`/`auth token` 业务语义（探针只验证策略拒绝，不验证 IAM 刷新）。
- 企业真实网关、真实 IAM 环境。
- 策略运行中卸载的时序。

## 复跑命令

```sh
cd packages/forge-policy && node --test test/*.test.mjs
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

## 本地校验

| 命令 | 结果 |
|---|---|
| `node --test packages/forge-policy/test/*.test.mjs` | 457/457 通过 |
| `node --test packages/forge-credentials-keychain/test/*.test.mjs` | 236/236 通过 |
| `pnpm test:unit` | 4850 通过、5 失败：其中 4 条是 `packages/forge-iam/test/bridge-real-provider.test.mjs` 的 CLI stderr 断言在 Node 24.13 下收到 `ExperimentalWarning: SQLite is an experimental feature`（同一文件在干净 `eba8a6b` 上同样 4 失败，已用 `git stash -u` 复核）；另 1 条是 `packages/forge-iam/test/preflight-retry-lifecycle.test.mjs` 在全量并行下的文件级超时，单独重跑 10/10 通过，重跑 `packages/forge-iam/test/*.test.mjs` 亦通过（2092 通过、4 失败） |
| `pnpm check:docs` / `check:repo` / `check:version` | 均通过；`git diff --check` 干净 |

> 补丁层不携带 `rules`：守卫由位置服务驱动，企业补丁与工程补丁都无需写开关；`tests/plugin-patch-layers.test.mjs` 的反向断言（补丁层不得写 rules）保持有效。


## 评审修复复验

PR #457 评审修复版在 darwin-arm64、DSH `0.2.1-rc.5`、Node `v24.13.0` 上以隔离 profile 和合成数据复跑 P1，全部退出码 0：

| 场景 | 命令 | 结果 |
|---|---|---|
| 企业单装 | `node scripts/probe/run-store-access-p1-probe.mjs --label enterprise` | 13/13 |
| engineering → enterprise | 同上加 `--patch packages/forge-engineering/cordis.patch.yml --patch packages/forge-enterprise/cordis.patch.yml` | 13/13 |
| enterprise → engineering | 同上，两个 `--patch` 顺序对调 | 13/13 |
| engineering 单装 | `DSH_HOST_PROBE_EXPECT=closed … --label engineering-only --patch packages/forge-engineering/cordis.patch.yml` | 4/4（不判定） |
| 目录错配 | `DSH_HOST_PROBE_EXPECT=fingerprint … --label mismatch --keychain-default` | 4/4（指纹兜底） |

修复项的离线回归：位置服务缺席/出现/移除/替换（`test/installer-store.test.mjs`，含 pre 钩子在每种状态下的放行与拒绝断言）、命令文本 `cd` 跟踪与同名文件放行（`test/store-protection.test.mjs`）、只输出命令里的取票字样放行。`node --test packages/forge-policy/test/*.test.mjs` 459/459。真实企业 IAM、Windows/Linux 宿主和执行环境隔离仍待验收。
