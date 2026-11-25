# IAM 存档访问 P0 探针记录（步骤 0）

本页记录 [IAM 存档访问防护方案](../../plans/2026-11-23-issue-375-iam-store-access-luna-guide.md) 步骤 0 的执行结果：在目标 DSH 宿主的 `tools/pre-execute` 上验证「拒绝存档访问」这一 seam 是否成立（P0-A），并补齐 `terminal_send`/`run_code` 覆盖（P0-B）与三种文件策略下的执行环境限制（P0-C）。设计背景见[策略与审计详细设计](../plugins/forge-policy.md)。

**实现边界**：探针注册的是**自己的**最小判定（路径落在合成存档根内、命令文本点名存档或取票即拒），不是 `packages/forge-policy` 的实现，也不装载企业组合包。P0-A/B 只回答宿主事件面：「内建工具是否走到 `tools/pre-execute`」与「拒绝时工具体是否真的没有执行」；P0-C 只回答执行环境面：「不装判定时，沙箱把存档目录的读与写怎么对待」。企业装配下的规则生效、位置服务与冲突码（P1-A 至 P1-E）**不在本页证据范围内**。

**探针与数据**：`scripts/probe/run-store-access-p0-probe.mjs` 在临时目录创建真实 SQLite 库 `iam-store/credentials.sqlite`（`records` 表含 canary 明文、`future_table` 模拟后续新增表）、密钥目录 `iam-store.keys/keyring.json` 与一份根外文件；以独立 `DSH_HOME` 从 `sdk` 模板引导 `dev` profile，再用临时 patch 挂载 `scripts/probe/store-access-p0-plugin.mjs`。

- **判定轮（A）**：装探针判定，权限模式 `workspace-write`，库放在 `$TMPDIR` 下。
- **环境轮（B/C/D）**：不装判定（`DSH_HOST_PROBE_NO_JUDGE=1`），分别以 `read-only`、`workspace-write`、`danger-full-access` 各跑一遍，库复制到 `$HOME/.forge-p0-sandbox-<rand>/iam-store` 后使用——`$TMPDIR` 可能被算进沙箱可写根，放主目录才能代表默认存档位置；该合成目录在运行结束时删除。

所有数据均为合成数据，不接触用户凭据。

## 轮次 A：判定轮（P0-A 与 P0-B）

| 检查 | 断言 | 结果 |
|---|---|---|
| `deny-read-store-db` | `read` 指向库文件被拒；返回文本不含 canary 明文 | 通过 |
| `deny-read-keyring` | `read` 指向 `keyring.json` 被拒 | 通过 |
| `deny-write-store-file` | `write` 指向 `credentials.sqlite.abandoned.*` 被拒，文件未创建 | 通过 |
| `deny-edit-store-file` | `edit` 指向库文件被拒 | 通过 |
| `deny-bash-sqlite-select` | `bash` 的 `sqlite3 … "select …"` 被拒 | 通过 |
| `deny-bash-sqlite-future-table` | 查询 `future_table` 同样被拒（按存档文件判定，不依赖表名） | 通过 |
| `deny-bash-sqlite-write-keeps-data` | `update` 语句被拒；前后 `records` 记录内容与 `PRAGMA data_version` 一致 | 通过 |
| `deny-bash-remove-store` | `rm -rf <store>` 被拒，库文件仍在 | 通过 |
| `deny-auth-token-before-cli` | `sh -c '… heluo-forge auth token'` 被拒；包装脚本的哨兵文件未生成 | 通过 |
| `deny-terminal-send-store` | `terminal_send` 指向不存在的会话也被前置拒绝（拒绝文本点名存档），证明判定发生在会话查找之前 | 通过 |
| `run-code-coverage` | `run_code` 在当前 `dev` profile 未注册：记为 `available: false`，不计为覆盖 | 通过（记未覆盖） |
| `deny-registered-tool-zero-execution` | 登记工具的工具体在拒绝时零执行（哨兵未写） | 通过 |
| `allow-read-outside-store` | 根外 `read` 放行 | 通过 |
| `allow-bash-outside-store` | 根外 `bash echo` 正常执行 | 通过 |
| `store-unchanged-after-denials` | 全部拒绝后行数、canary 值与 `data_version` 未变 | 通过 |

## 轮次 B/C/D：执行环境（P0-C）

`read` 指内建文件工具，其余用 `bash` 发起，以便区分「工具层策略」与「执行环境限制」。

| 观测 | `read-only` | `workspace-write` | `danger-full-access` |
|---|---|---|---|
| 存档文本文件（`bash cat index-state.json`） | 允许 | 允许 | 允许 |
| 存档库文件（`read`） | 拒（`FS_NOT_TEXT`，非沙箱） | 拒（同左） | 拒（同左） |
| 存档库内容（`bash sqlite3 … select`） | **允许，返回 canary 明文** | **允许，返回 canary 明文** | **允许，返回 canary 明文** |
| 写存档目录（`bash printf > <store>/…`） | 拒（`Operation not permitted`） | 拒（`file access denied under workspace-write`） | 允许并创建 |
| 写工作区（`bash printf > <workspace>/…`） | 拒 | 允许并创建 | 允许并创建 |
| 读工作区 | 允许 | 允许 | 允许 |
| 读根外文件 | 允许 | 允许 | 允许 |

判定口径：`bash` 工具在沙箱拒绝写入时 `isError` 仍为 `false`，拒绝只出现在 stderr 文本（`[sandbox: file access denied under <mode> mode]`）；因此上表按文本与文件是否创建判定，不按 `isError`。

## 结论

- **P0-A 成立**：内建 `read`/`write`/`edit`/`bash`/`terminal_send` 都经过 `tools/pre-execute`；拒绝决策生效且工具体零执行，合成库在拒绝前后未被改动；根外访问不受影响。
- **P0-B**：`terminal_send` 已被前置拒绝覆盖；`run_code` 在该 profile 未注册，本轮**没有覆盖证据**——宿主存在 PTC 子派发通道，需在注册了 `run_code` 的 profile 上补测，交付文案与 #434 不得据此宣称覆盖。
- **P0-C**：**写受模式约束，读不受限**。`read-only` 连工作区写都拒；`workspace-write` 只放行工作区写、拒写存档目录；`danger-full-access` 全放行。但三种模式下 `cat` 与 `sqlite3` 都能读到存档内容（含 canary 明文），`read` 工具拒读只因二进制格式（`FS_NOT_TEXT`），不是读权限限制。
- **对方案的含义**：执行环境不能承担「禁止 Agent 读取存档」的职责，读只能靠 `tools/pre-execute` 的工具层判定；运行期拼装路径的缺口因此保持原状。企业默认启用后仍不能据此勾选 #434 第 4 项（要求执行环境隔离或等价证据）。

## 未测项

- `run_code` 覆盖：当前 `dev` profile 未注册该工具；需在带 PTC 的 profile 上补测。
- 真实默认存档路径（darwin `~/Library/Application Support/HeluoForge`）：环境轮用 `$HOME` 下合成目录代替，二者沙箱归类未逐一比对。
- Windows 与 Linux 的沙箱实现：本轮只在 darwin-arm64 上取证。
- 拒绝后宿主的界面与审计表现（探针只记录工具结果）。
- P1-A 至 P1-E：企业实际装配（真实 keychain + policy + iam）下的规则生效、位置服务、冲突码、装载失败阻断与叠装范围均未取证。
- 模型自决调用：本轮无 LLM 提供方，全部派发由探针直接调用 `ctx.tools.execute()`；这不等于「模型不会用别的方式绕开」。

## 复跑

```sh
node scripts/probe/run-store-access-p0-probe.mjs
```

预期输出：轮次 A `15/15 checks passed`、`denials=11`；轮次 B/C/D 打印七行观测矩阵；退出码 0。证据为运行临时目录下的 `probe-raw-<tag>.json` 与 `probe-evidence`，不随仓库保存。环境不具备（`dsh` 不在 PATH）时退出码 2 并说明原因；`DSH_BIN` 可指定目标可执行文件，`DSH_HOST_PROBE_PROFILE` 可改 profile（默认 `dev`，从 `sdk` 模板引导）。
