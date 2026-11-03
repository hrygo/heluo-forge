# IAM 机密客户端隔离开发实施计划

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-006 |
| 文档名称 | IAM 机密客户端隔离开发实施计划 |
| 版本 | V0.2.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-02 |
| 门禁 | 用户已批准 source/mock 设计；真实来源与生产关闭 |

> 编制依据：用户于 2026-11-02 批准完整 [DESIGN-016](<../design/iam-confidential-isolated.md>) 与 [IAM-002](<../contracts/iam-client-auth-isolated.md>) 进入 source/mock 实施；独立建造审阅无重要剩余问题。批准不包含真实 secret、当前 profile、团队 G1/G2、安装或提交发布。
>
> 关联文档：[实现验收索引](<../design/README.md#221-iam-离线验收清单>)、[开发约定](<../engineering/development-conventions.md>)。

## 1. 目标与实施路径

**目标**：在真实 IAM 服务代码中实现可由隔离 fixture 验证的机密 code/refresh/revoke 闭环，真实 apply 仍无秘密来源。

**技术**：既有 Node 24.21.0、ESM、node:test、标准库和可注入 fetch；不加依赖、不改 DSH 核心。单个 source writer 按以下四项顺序 TDD，独立 reviewer 只读；root 维护文档并在所有 writer 停止后执行一次有效全仓检查。

**当前实现**：实际隔离服务已接入 Basic/Post、V2 生产与恢复、有效 AT、认证刷新与撤销、共享完成结果和 cleanup。public 保持 V1，全部模式强制 S256。新增54项实际服务用例，必要合并851/851通过；独立复核与本批完整检查状态见下表。真实 apply 不提供来源，既有41项 OAuth 脱敏保持。

### 分段交付安全边界

A/B 与 C 已按阶段接入。临时全拒绝只在实际服务 guard 和具体受信隔离来源完整连接后替换；缺失或非法来源仍拒绝，不回落无认证。公共服务不采用或返回 V2；真实 apply 无来源。buildGrant/grantFromToken、完整共享身份和 cleanup 已由实际服务测试覆盖，不以纯构造替代闭环。

### 全局约束

- 公共默认保持 V1；机密必须显式方法、逻辑 ref、具体受信来源、V2 上下文，缺失不回落。所有模式 mandatory S256。
- 私有 getter/verifier 名字和数据以 IAM-002 为准；source、credentials、scope 独立精确认可，literal true 同步，不看自报字段。真实 apply 不注入、不探测、不读本机秘密；不实现持久秘密格式/登记/管理员写工具。
- 模型严格只读、issuer 离线恢复、现有单记录/网关联合门禁、回调唯一消费与刷新 pending 协议全部保留；不新增锁、lease、第三键或自动迁移。
- secret 与 Basic 串不进入配置、URL、attempt、grant、pending、诊断、异常或日志；预置仅测试内存。失败不换 source、method、secret 重试，不把 post guard 说成撤回 HTTP。
- 保留全部既有未提交改动，不 stage/commit/push/install/publish，不跑真实 keychain spike 或当前 profile 业务。

## 2. 文件职责

- [配置](<../../packages/forge-iam/src/config.mjs>)：认证 tagged union、归一化可重验与拒绝组合；public 归一化不产生 secretRef。
- [认证 helper](<../../packages/forge-iam/src/client-auth.mjs>)：短小私有来源/非秘密 pin 与 HTTP 构造 helper；不创建 Cordis Service、公共工具或通用安全框架。最终函数拆分可由 builder 决定，但 IAM-002 私有签名不得偷改。
- [OIDC](<../../packages/forge-iam/src/oidc.mjs>)：三条 POST 共享认证构造与真正发送前同步 guard；现有白名单、成功体、redirect:error、安全端点、S256 保持。
- [codec](<../../packages/forge-iam/src/record.mjs>)、[store](<../../packages/forge-iam/src/store.mjs>)：V1/V2 与完整上下文比较；不把能解析当成能采用。
- [service](<../../packages/forge-iam/src/service.mjs>)：认证操作固定、双向格式/上下文准入、共享刷新和 cleanup；getter/verifier 不进入 [apply](<../../packages/forge-iam/src/index.mjs>) 的真实来源组合。
- 新认证 fixture 与测试仅本包 test/support、test；root 独占随包指南、设计/契约、登记/验收与本计划，避免与 source writer 重叠。

## 3. 按交付验收

### A. 配置、来源与传输构造

- [x] 先写 RED：默认 public 不读来源；public/confidential 合法与非法组合、部分配置/原文 secret/关闭 S256 拒绝、归一化可再次验证。
- [x] 测试具体 verifier 对 credentials/source/issuer-client-ref-method 的精确认可；缺失/异常/Promise/自报可信均不读 snapshot，拒绝不混入原文。
- [x] 实现只读 synthetic source 适配与私有 pin；原 snapshot 身份与独立副本一致，current 同步字面 true；无环境/文件后备。source/credentials getter 在初查、read 后、current 后及 dispatch 返回 Promise 时均收敛但不授权。
- [x] 实现三种纯请求构造；用冒号、空格、加号、非 ASCII 和中文验证双端 form 编码，紧贴 fetch 同步 guard、无双认证、无真实网络。
- [x] 最终定向 603/603 通过，包含旧 config/OIDC/41 项错误脱敏；新基础测试 167 项（配置32、来源52、传输25、记录58）。

### B. V1/V2 及存储身份

- [x] 先 RED：V2 严格 outer/authContext、禁止未知或原文秘密字段；V1 按认证标记存在拒绝。私有固定采样后校验与输出同一份数据，避免 getter 导致格式错态。
- [x] callback discard 比较 version 与完整 authContext；独立冻结认证上下文和刷新 marker，复用既有完整快照与墓碑规则，不触及秘密来源存储。
- [x] 公共服务不采用、返回、刷新/撤销或盲删 V2；缺少受信来源的机密工厂仍拒绝，合法隔离 fixture 的正向由 C 覆盖。旧 public、issuer、tombstone、ABA 与不确定提交回归通过；不把 V2 说成防旧 writer 回滚。
- [x] C 中实际机密服务按配置与当前 source 上下文执行双向 V1/V2 准入，无自动迁移；阶段关闭不替代这一正向闭环。
- [x] grantFromToken/buildGrant 产生 format2 并保留完整认证上下文；public 继续 V1。
- [x] 将 authContext 纳入 sync pending、refresh 三处手列 identity、等待者/完整 base/complete 检查；pending 不含 secret。

### C. 实际服务闭环与受控时序

- [x] 先 RED：Basic/Post 分别真实 code/refresh/revoke 与 callback cleanup；default apply 无来源时零 secret I/O、零带凭据 POST；公共旧路径不变。
- [x] start 固定非秘密 attempt pin；callback 重新读取同 revision；每个 POST 与 await 后验证当前 source/verifier/current 和现有 auth/provider/operation 代际。
- [x] 在真正 fetch 前、HTTP pending、响应后、commit 内、credentials/source 替换、cancel/signout/dispose 各处控制 Promise；旧成功/错误不采用、零重试，不将 local changed 误包装网络失败。
- [x] 验证有效 AT、hydrate/sync、单飞与共享刷新都校验相同 auth pin；claim 后变更保留 pending，不接管、重置、换 secret 或重发旧 RT。
- [x] 验证来源失效后本地精确退出与远端未确认分开；cleanup 不裸发或借新 secret，不盲删其他模式/主体。模型错误仍不进入登录清理，getView/getPrincipal 不做 secret I/O。
- [x] GREEN 定向验证所有新场景，沿用现有 timeout、唯一 callback、刷新未知结果与迟到 I/O 保护。

### D. 文档、审查与完整验收

- [x] 最终只读 peer 已关闭，无剩余必要源码修复项；代表性变异实际检出旧共享 token 错误获准，14文件指纹不变。
- [x] 随包指南、IAM-002、模块设计、推广状态与登记同步为实际隔离服务已接；归档快照保持当时事实。
- [x] 冻结七源码匹配后，完整检查1689项、1687通过、0失败、2项既有平台跳过、0取消，47.021s、exit0；输出已收集，不沿用A/B旧结果。
- [x] 只执行 source/mock；未读写真实 secret/profile，执行者未对当前仓库或真实profile执行 stage/commit/install；完整测试中的临时仓库与离线安装演练不属于当前环境变更。观察到外部 HEAD 变为2bdecea，冻结七源码一致，未回退其内容。

## 4. 当前冻结批次证据

| 验证 | 结果与边界 |
|---|---|
| 基础测试 | 配置32、来源52、传输25、记录58，共167项；helper自动发现不算业务用例 |
| 实际C服务 | [service](<../../packages/forge-iam/test/client-auth-service.test.mjs>)26、[lifecycle](<../../packages/forge-iam/test/client-auth-lifecycle.test.mjs>)14、[refresh](<../../packages/forge-iam/test/client-auth-refresh.test.mjs>)11、[routes](<../../packages/forge-iam/test/client-auth-routes.test.mjs>)3，共54项 |
| 必要合并 | 显式Node24、关闭keychain spike；851/851通过，0失败/跳过/取消，18.413s，exit0 |
| 代表性内存变异 | 仅移除共享刷新最终auth guard，原11项有2项因旧token错误获准而失败；9通过、2失败，exit1，非加载错误；正版11/11通过，exit0；14文件指纹前后一致 |
| 完整检查 | 有效完整检查1689项、1687通过、0失败、2项既有平台跳过、0取消，47.021s、exit0，输出已收集；七源码冻结一致。包内链接修复另有5/5定向通过 |
| 未验证边界 | 正式秘密来源、OS钥匙串、供应商端点和生产生命周期未开放；消费侧DESIGN-017/IAM-003已获source/mock批准，尚未实施 |
