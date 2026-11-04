# IAM 双端验收矩阵（Windows / 麒麟）

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-012 |
| 文档名称 | IAM 双端验收矩阵（Windows / 麒麟） |
| 版本 | V0.2.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-04 |
| 门禁 | 2026-11-04 已在远程 macbook 与 megacube 做过一次部署复验；完整验收仍待目标环境与 IAM 账号 |
| 文档层级 | L2 验收矩阵；能力证据引用 #120—#122 的记录，本文只做平台复验 |

> 编制依据：2026-11-04 对 #123 正文、PLAN-011 M5 与既有 `pnpm check`、组合探针结果的核对。矩阵中没有任何一项在 Windows 或麒麟上执行过，全部保持 NOT RUN / BLOCKED；文档存在不构成验收证据。
>
> 关联文档：[IAM 接入设计](<../design/plugins/forge-iam.md>)、[多端凭据存储方案](<2026-11-03-credential-multiplatform.md>)、[实施计划](<2026-11-04-iam-issues-implementation.md>)、[开发与验收约定](<../engineering/development-conventions.md>)。

## 1. 使用方式

1. 按 §2 填环境表，一行一台机器；版本、配置、责任人、账号权限都要写，敏感值脱敏。
2. 按 §3 逐条执行，只填四类结果：`PASS`、`FAIL`、`BLOCKED`、`NOT RUN`；每行在“证据”列写命令与产物路径（脱敏后）。
3. 失败项不跳过：写复现步骤与现象，回到对应子项修完再复验。
4. 执行前确认 `pnpm check` 通过，`git diff --check` 干净。

## 2. 环境登记表

| 项 | Windows | 麒麟 |
|---|---|---|
| 平台与版本 | 待填（如 Windows 11 23H2 x64） | 待填（发行版与内核版本） |
| DSH 版本 | 待填（目标 `0.2.1-rc.5`） | 待填 |
| Node / pnpm | 待填（按 `.node-version`） | 待填 |
| IAM 端点与 client_id | 待填（脱敏） | 待填 |
| 网关与模型 | 待填 | 待填 |
| 凭据后端 | 待填（DPAPI / libsecret） | 待填 |
| 测试账号与权限 | 待填 | 待填 |
| 执行人与日期 | 待填 | 待填 |

## 3. 用例矩阵

### 3.1 主路径

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| A-01 | 系统浏览器完成登录并回到应用 | 视图 `signedIn=true`，主体与 IAM 一致 | NOT RUN | |
| A-02 | 访问令牌到期前自动刷新 | 无人工操作，调用继续成功 | NOT RUN | |
| A-03 | 退出登录 | 本地立即停止企业调用，视图回到未登录 | NOT RUN | |
| A-04 | 重启应用后恢复会话 | 不要求重新登录，或按设计明确要求 | NOT RUN | |

### 3.2 故障路径

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| F-01 | 错误的 client secret | 拒绝进入就绪，错误可读，不落明文 | NOT RUN | |
| F-02 | 回调地址不精确匹配 | 拒绝，不换票 | NOT RUN | |
| F-03 | 授权码重放 | 第二次换票失败 | NOT RUN | |
| F-04 | 系统凭据库不可用或锁定 | 拒绝进入就绪，不自动降级到文件 | NOT RUN | |
| F-05 | 轮换后等待至少两分钟 | 新 secret 生效，旧值按 C2 窗口失效 | NOT RUN | |
| F-06 | 多进程竞争刷新 | 只有一方成功，另一方不重放旧刷新令牌 | NOT RUN | |
| F-07 | 断网后恢复 | 分类为网络故障，不误判为授权失效 | NOT RUN | |
| F-08 | 登录过程中取消 | 尝试结束，无残留 pending | NOT RUN | |

### 3.3 O3 禁用与组合行为（复用 #122 结论，本项复验一次）

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| O-01 | 官方登录入口不可用 | 无官方登录旁路 | NOT RUN | |
| O-02 | 官方模型与 API Key 不可用 | 不回落公网模型 | NOT RUN | |
| O-03 | 账户页显示企业身份 | 不显示官方账户 | NOT RUN | |
| O-04 | 缺凭据时 shell 仍可用 | 与 AC6 一致 | NOT RUN | |
| O-05 | 升级回灌后禁用仍生效 | 覆写层未被覆盖 | NOT RUN | |
| O-06 | 卸载与旧凭据迁移 | 按授权演练，失败保留原数据 | NOT RUN | |

### 3.4 服务端语义（引用 #120 记录，本项复验）

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| S-01 | 管理员停用后五分钟内按人拒绝 | IAM/网关联合证据 | BLOCKED | 依赖企业环境 |
| S-02 | 登出只断当前授权及后代 | 达不到则记 BLOCKED，不改需求 | BLOCKED | 无单令牌撤销接口 |
| S-03 | 其他设备与 SSO 不受影响 | 同上 | BLOCKED | |

### 3.5 审计与诊断

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| D-01 | 审计与诊断无 token / secret / Key | 扫描输出与样本 | NOT RUN | |
| D-02 | 取消流不推断上游停止或零计费 | 文案与日志如实标注 | NOT RUN | |

### 3.6 仓库与产物

| ID | 用例 | 判定依据 | 结果 | 证据 |
|---|---|---|---|---|
| R-01 | `pnpm check` 全绿 | 命令输出 | NOT RUN | |
| R-02 | `git diff --check` 干净 | 命令输出 | NOT RUN | |
| R-03 | 包体可安装到目标 profile | 安装日志与版本 | NOT RUN | |

## 4. 首次实机部署复验（2026-11-04）

环境：远程 macbook（macOS 26.5.1 arm64，Node 26.4.0）、megacube（Linux aarch64，Node 24.21.0，DSH 0.2.1-rc.3）；macbook 用新装 DSH 0.2.1-rc.5。两台都从 `main@730f76e` 的 bundle 克隆，`pnpm install --frozen-lockfile`，再装同一份企业制品。

| 项 | macbook（macOS） | megacube（Linux） | 结论 |
|---|---|---|---|
| `pnpm check` | 2514 项 / 2508 通过 / 6 跳过 / 0 失败 | 同左 | PASS |
| 制品安装 | `dsh plugin add` 成功 | 同 | PASS |
| 组合树 | 3 条企业行、官方四行 `disabled: true` | 同 | PASS |
| 缺失条目告警 | `ui-settings-account` not found | 同 | 最小 profile 无该客户端插件；跳过 ≠ 已禁用 |
| 启动 | `KEYCHAIN_UNAVAILABLE`，`authorization` 等待 `credentials`，无明文凭据文件 | 同 | PASS（按设计 fail closed） |
| 系统钥匙串 | 未接入，需开发覆盖层 | 未接入 | AC4 仍 BLOCKED |

实机暴露并已修的三处环境假设：

1. `team-full-install.mjs` 只接受 Node 24，macOS 的 Node 26 被拒；改为要求 24 及以上。
2. 密钥链测试用 `os.tmpdir()` 当“仓库外目录”，而 megacube 的 `/tmp` 本身是 git 仓库；改为挑选可证明在仓库外的临时根。
3. 安装器测试夹具继承用户全局 gitignore，`device-key.pem` 被忽略导致 `git add` 失败；夹具隔离 `GIT_CONFIG_GLOBAL`。

Linux 以 `umask 002` 克隆时文件为 664，安装器曾只回一句 `unsafe package script`。按评审结论改为：报错带路径、实际权限位与修复命令，另加 `--allow-group-writable` 显式开关（只接受属主仍是当前用户的副本，目标端仍写 0600/0700）。见 PR #143。

### 4.1 开发覆盖层实机尝试（macbook，2026-11-04）

默认组合在 macOS 与 Linux 都停在 `KEYCHAIN_UNAVAILABLE`，因此试一次文档里的逃生门。

- 生效位置：`--patch` 传入同一行会被 bundle 层覆盖，必须写进 profile 的 `cordis.patch.yml`（“applied after every bundle layer”）。
- 组合证据：`--dump-config` 中该行带上了 `filePath` 与 `allowInsecureFile: true`。
- 启动观察：不再出现 `KEYCHAIN_UNAVAILABLE`，也不再出现 `warning: 2 entries did not activate`，日志为空。
- 最小 profile 没有 HTTP 监听（150 秒无响应），无法判定就绪，改用 `--from-default-profile web` 新建的完整 web profile 重试。

完整 web profile 的结果（2026-11-04，macbook）：

| 项 | 结果 |
|---|---|
| 启动 | `dsh web: http://127.0.0.1:47930/?token=…`，带 token 访问首页 303（就绪） |
| 鉴权 | `/api/forge-iam/view` 返回 401，连接守卫在位 |
| 未激活条目 | 只剩 `account-controller` 等 `deepseekAccount`；该依赖已被补丁禁用，属组合残留告警 |
| 凭据文档 | 首次使用后生成 `~/forge-pilot/credentials.json`，0600，键只有 `entries`、`version` |
| 非生产告警 | 日志里未见“明文文件已启用”提示，插件用 `ctx.logger.warn` 输出，未进 stderr，诊断可见性待查 |
| 清理 | 停进程、删 profile 与目录；补丁改动未写入仓库 |

结论：覆盖层在完整 web profile 上可用且能到就绪；但“非生产”提示不可见、`account-controller` 残留两处需要处理。

## 5. 当前状态

- 全部用例 `NOT RUN`；服务端语义三项 `BLOCKED`。
- 阻塞原因：没有 Windows 与麒麟实机，也没有对应的测试账号权限。
- 机器与权限到位后按 §1 执行；执行结果回写本表与 #123，不新建平行记录。
