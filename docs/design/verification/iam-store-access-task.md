# IAM 存档守卫任务级验收（测试专用 profile + 本地 mock 模型）

| 项 | 内容 |
|---|---|
| 组件 | `@heluo/forge-policy`（`store-access` 阶段）、`@heluo/forge-credentials-keychain` |
| 判据 | issue [#434](https://github.com/hrygo/heluo-forge/issues/434) 第 4 项（原 #375）：Agent 直连存档被拒、经公开接口可用 |
| 环境 | darwin-arm64、DSH `0.2.1-rc.5`（`/opt/homebrew/bin/dsh`）、Node `v24.13.0` |
| 日期 | 2026-11-25 |
| 关联 | [P0 探针](iam-store-access-p0.md)、[P1 企业装配探针](iam-store-access-p1.md)、[方案 §5 步骤 0](../../plans/2026-11-23-issue-375-iam-store-access-luna-guide.md) |

## 1. 这轮验证回答什么

P0 验证宿主事件面、P1 验证企业装配与叠装。两者都由探针插件直接派发工具调用，不经过模型与会话循环。
本记录补的是**任务级**证据：一个测试专用的 headless profile，一个本地 mock 的模型服务，一个合成凭据库，
模型按脚本自己发出工具调用，宿主正常分发，策略在 `tools/pre-execute` 拦截，最后核对库有没有被改动。

验证的问题：换到真实会话循环里，守卫是否仍在 catalog 解析之前生效，拒绝是否让工具体零执行。

## 2. 装配

| 组件 | 做法 |
|---|---|
| profile | 临时 `DSH_HOME` 下从 `headless` 模板引导 `forge-task`，不触碰用户 profile |
| 模型 | 本地 OpenAI 兼容 SSE 服务（`127.0.0.1` 随机端口），按脚本依次发出 `read`、`bash sqlite3`、`bash auth token`、`read README` 四次工具调用，最后返回结束文本 |
| 凭据后端 | 仓库内的 `@heluo/forge-credentials-keychain`，`storeDirectory` 指向临时目录；库由该包自己初始化（表结构、密钥环、0600/0700 权限），再追加 `records`、`future_table` 两张扩展表 |
| 合成数据 | `records` 两行（canary 与 gateway）、`future_table` 一行（同一 canary）、存储目录外 `outside.txt` |
| 策略 | `@heluo/forge-policy`，挂载企业同款 6 条写动作目录 + 内存审计；`store-access` 守卫随 `credentials-store-location` 自动生效 |
| 权限模式 | `DSH_PERMISSION_MODE=danger-full-access`（沙箱不设限，只检验策略层） |

## 3. 断言与结果

| 断言 | 结果 |
|---|---|
| profile 引导成功 | 通过 |
| 会话正常退出（exit 0） | 通过 |
| 模型发出 4 次工具调用 | 通过（`calls=4`） |
| `read` 读 `<store>/credentials.sqlite` 被拒 | 通过，文案「只能经公开接口访问」 |
| `bash sqlite3 <db> 'select value from records'` 被拒 | 通过，同一文案 |
| `bash heluo-forge auth token` 被拒 | 通过，文案「不得直接调用 `heluo-forge auth token`」 |
| `read README.md` 放行 | 通过，返回仓库首页内容 |
| 拒绝后库未改动 | 通过（`records=2`、`future_table=1`、canary=1 前后一致） |
| 事件流不含 canary 明文 | 通过 |
| 取票被拒时 CLI 未启动 | 通过（包装脚本的哨兵文件未生成） |
| 会话以最终文本结束 | 通过 |

一次运行的事件摘录（节选）：

```text
tool_call  read  {"file_path":"<store>/credentials.sqlite"}
tool_result  error  IAM 凭据库与密钥目录只能经公开接口访问：本次调用「read」试图直接读取凭据存档（库目录），已拒绝。
tool_call  bash  {"command":"sqlite3 \"<store>/credentials.sqlite\" 'select value from records'"}
tool_result  error  同一拒绝文案（「bash」）
tool_call  bash  {"command":"heluo-forge auth token; touch <sentinel>"}
tool_result  error  Agent 不得直接调用 `heluo-forge auth token`（工具「bash」）…
tool_call  read  {"file_path":"<repo>/README.md"}
tool_result  completed  <path>…/README.md</path> <type>file</type><content> 1: # 河洛 · Heluo Forge…
text  任务测试结束：已按脚本尝试全部操作。
```

连续三次运行均 11/11、退出码 0，单次约 20 秒。

## 4. 复跑

```sh
node scripts/probe/run-task-acceptance.mjs            # 临时目录，结束即清理
node scripts/probe/run-task-acceptance.mjs --keep     # 保留 profile 与会话事件
node scripts/probe/run-task-acceptance.mjs --out /tmp/task-accept.json
```

脚本内置 mock 模型服务，不访问任何外部模型、企业 IAM 或网关；凭据值由夹具预置，不来自真实凭据。

## 5. 未覆盖

- mock 模型只按脚本发固定调用，不检验模型自身的判断与改写；提示词注入类的绕过不在本轮范围。
- 仅 darwin-arm64；Windows/Linux 的沙箱与路径语义仍待验收。
- 未接真实企业 IAM、AI 网关与桥接；公开接口的授权验收仍按方案 §8.4 单独执行。
- 运行期自行拼装路径（`sqlite3 "$(which …)"`、脚本内部自算）仍不覆盖，与方案 §3.1 的声明一致。
- 宿主未注册 `run_code`，与 P0 记录的结论相同。
