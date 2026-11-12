# 凭据存储整洁架构执行细案

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-017A |
| 文档名称 | 凭据存储整洁架构执行细案 |
| 版本 | V0.1.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-12 |
| 门禁 | 源码与离线验证；企业环境和目标宿主另行取证 |

> 编制依据：[凭据存储整洁架构实施方案](<2026-11-12-credential-storage-clean-arch.md>)（`CORP-DSH-PLAN-017`）、PR #237 固定提交 `48136a7`、IAM 存储实现及其离线测试。本文是具体执行记录；与现行设计、契约冲突时，先同步设计与契约。新部署不读取、删除或覆盖旧数据。
>
> 关联文档：[IAM 接入详细设计](../design/plugins/forge-iam.md)、[凭据包说明](../../packages/forge-credentials-keychain/README.md)、[总体架构](../architecture/platform-architecture.md)。

## 实施边界与决策

- 存储只面向同一 PID namespace 的单机本地文件系统和全新部署。发现旧存储、缺失密钥或未知格式时拒绝并保留原物；不得把不兼容解释为授权清除数据。
- `secret.id` 使用包含 service 和 accountPrefix 的完整存储键，`kind` 为 `ref` 或 `record`；记录属主在写入时确定并写入 `owner` 列，读取时以该列构造 AAD。`ref` 属主允许为空。
- `meta.active` 是建库后唯一活动密钥真源。轮换先安全落盘新密钥与 keyring 的活动标记，再在短事务中切换 `meta.active`；两者短暂不一致时以数据库为准。崩溃时旧密钥始终保留，不在读取时重封。
- `modifyRecord` 支持异步回调，数据库写事务不能跨 `await`。所有写操作以 SQLite 中持久化的逻辑锁串行，网络调用不持有数据库写事务。锁由进程 ID 和随机 token 的摘要标识；取得排他写事务后一次执行同步提交，将凭据写入和逻辑锁释放共同提交，不重放业务回调。操作已结束但释放被阻时发布私有完成标记，后续写入须在事务内复核进程 ID 和原 token 与锁摘要的对应关系后才可回收；`ESRCH` 明确确认进程不存在时也可回收。操作活跃、状态未知或 PID 复用而无完成证明时超时拒绝，不依赖租约超时接管。读写争用异步有界等待；只读路径不持逻辑锁，联合快照使用同一短读事务。
- 首次建库用初始化标记协调并发，确认数据库结构及活动密钥完整后才可绕过遗留标记；中断且完整性未知时保留文件、拒绝写入。POSIX 平台密钥切换前要求文件和目录同步成功，Windows 目录持久性另行实测。
- 退出先持久化 `signOutOperation` pending，再在锁外调用远端撤销；只有确认撤销后才条件提交墓碑。远端撤销成功后、本地墓碑提交前崩溃时保留 pending，拒绝读取旧令牌和重发；跳过远端撤销时只完成本地退出。
- 现有 IAM 单记录可信门禁及网关双键联合门禁保持独立。只有由组合根登记并完成契约测试的实现参与信任注入；自报能力不能构成信任。拒绝、异常与未知提交结果均不得分步补偿或自动重发。
- CLI、插件及 HTTP 共用会话和令牌用例与错误语义；CLI 保持脚本可消费的令牌输出，HTTP 保持各自传输封装和鉴权。仅 Host 持有刷新权；桥接继续要求 loopback 与能力值，同源接口继续要求 Connection 守卫。
- Windows 的 POSIX mode 不等于 NTFS ACL，目标机账户隔离与实际权限待实证；不可用时关闭能力。内置 SQLite、Electron、企业 IAM 与网关的实测结果分别记录。

## 执行顺序

1. **设计与契约**：对齐 IAM 设计、存储边界和受控文档；定义持久锁、密钥真源、所有者与错误码，不把方案描述成已取证的生产能力。
2. **值级密封**：新增 `src/cipher.mjs` 与 `test/cipher.test.mjs`。覆盖任意非空字节往返、随机 IV、AAD 的 kind/key/owner 错位、截断、篡改、未知 `kid` 与短标签拒绝；先运行失败的测试，再实现信封。
3. **密钥来源**：新增 `src/keyring.mjs` 与 `test/keyring.test.mjs`。覆盖严格的版本、密钥长度和权限检查，多密钥、密钥持久化、丢失拒绝、原子更新及旧 `kid` 的可读与移除后不可读。建库不得覆盖已有 keyring。
4. **后端与装饰器**：实现 SQLite 与内存后端及值级加密装饰器。契约套件覆盖读写、单记录异步事务、两键联合提交、回滚、并发、死进程恢复、存储对象与 WAL/SHM 明文扫描；对不支持联合提交的后端拒绝。测试进程和数据库使用临时目录。
5. **组合与访问面**：插件装配注册受测的 SQLite 后端与同一用例；CLI 经包导出 reader 打开相同存储，不自行解析 provider。保留四种访问面的鉴权、令牌与错误边界，删除旧文档后端和迁移代码，更新包闭包与调用方。
6. **完整验证**：在 Node 24.21.0 下先跑新契约和 IAM 原子、退出、刷新、网关、CLI 与路由回归，再运行 `pnpm check`、`git diff --check`、`git status --short`。分别记录 macOS 实测、缺失的 Windows/麒麟/Electron 及外部联调证据。

## 实施接口

- `createAesGcmCipher(keyProvider)` 返回 `seal({kind,id,owner,kid,plaintext})` 和 `open({kind,id,owner,kid,envelope})`；输入及输出明文均为非空字节，信封为字节。`kind` 为 `ref` 或 `record`，`id` 是完整存储键；AAD 为 `HFSE|1|kind|id|owner|kid`。`kid` 缺失抛 `CRED_KEY_UNAVAILABLE`，认证、编码、截断或上下文错误抛 `CRED_DECRYPT_FAILED`。
- `createFileKeyProvider({path})` 返回同步 `initialize(kid)`、`active()`、`byId(kid)`、`add(kid)` 和 `activate(kid)`。`active()` 返回 keyring 标记对应的 `{kid,key}`，`byId` 返回 32 字节密钥或 `undefined`。读取不创建文件；创建、添加与标记切换由组合方协调，添加已有 `kid` 必须拒绝。运行期使用数据库的 `meta.active` 选择活动密钥。
- 后端组合保持现有 credentials seam：`get/set/delete/list/listEntries`、支持异步 mutator 的单键 `transaction`、两键 `snapshot/compareAndSwap`。后两种写操作与普通写入共享锁域；比较、一次同步 guard、两键提交及锁 token 校验必须在同一短数据库事务中完成。

## 失败模式审阅

- 密钥文件或活动 `kid` 缺失：拒绝读取，不生成替代密钥。
- 条目位置、属主、密文或标签被改动：统一 `CRED_DECRYPT_FAILED`，不得返回旧值。
- 双键第二次写入失败或进程崩溃：两个键共同回滚，重开后不出现半次提交。
- 异步退出持锁期间其他进程写入：等待或超时拒绝；不得撤销新会话或覆盖新记录。
- 读取时数据库或 keyring 不存在：只读 reader 不创建、重建、迁移或更改任何存储文件。
