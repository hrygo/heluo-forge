# IAM 下一阶段收尾计划

---

| 字段 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-008 |
| 文档名称 | IAM 下一阶段收尾计划 |
| 版本 | V0.6.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-03 |
| 门禁 | 用户已选择最小订阅 source/mock；接缝已实现并完成定向验收；真实注册与 probe 不开放 |

> 编制依据：用户要求“总结进展，继往开来，然后规划下一阶段工作，尽快收尾”。沿用 Node 24.21.0、ESM 与离线测试工程；不改变[需求基线的范围](<../requirements/requirements-baseline.md#2-范围边界唯一真源>)，也不代替提供方接口确认或设计批准。
>
> 关联文档：[已验收的隔离消费计划](<2026-11-02-iam-consumer-isolated.md>)、[设计索引](<../design/README.md>)、[网关契约](<../contracts/gateway-contract.md>)、[文档清单](<../DOCUMENT-REGISTER.md>)。
>
> 执行安排：一个 writer、一个独立审阅者，按顺序推进。新增行为遵循 test-driven-development；未核验接口先完成准入，不以模拟适配器自证 SDK 兼容。

## 1. 结论与承接

隔离消费 A—E 已验收。PLAN-007 记录当时完整检查为 1889 项、1887 通过、0 失败、2 项平台跳过；分段、联合与跳过原因见[PLAN-007 验收记录](<2026-11-02-iam-consumer-isolated.md#4-当前证据>)。

本批在 A—E 之外只做了一个最小执行项：IAM 只读状态订阅的私有 source/mock 接缝。最终完整检查为 2599 项中 2597 通过、0 失败、0 取消、2 项平台跳过，记录见 §8。实现状态以[设计索引 §2.2](<../design/README.md#22-实现与验证入口>)为准。

本批没有关闭整个 IAM 目标。真实 Remote 注册、真实 Host 上下文与资源策略、真实 Client 接线、probe 与 `tokenFor(resource)` 仍未实施；范围批准不等于能力接通，模拟验收不等于生产准入。

## 2. 阶段、原定交付与结果

| 阶段 | 原定交付 | 结果 |
|---|---|---|
| 第一步：冻结接口与文件表 | 核验 Client 公开 Remote 挂载、流返回、取消与卸载 | 完成，结论见 §6；仅类型与公开制品层，未联调 |
| 第一步 | 对照 Host `watch(signal)` 与现行 HTTP 读取链 | 完成，差异见 §6.1；watch 不承担同步与刷新 |
| 第一步 | 明确只读 DTO、宿主访问控制与 HTTP 共存 | 未做：超出本批。真实调用上下文与资源策略没有公开合同，不用测试校验器代替 |
| 第一步 | 最小设计获准后再改源码 | 完成：用户批准最小 source/mock 私有接缝，执行见 §7 |
| 第二步 | 失败用例先行，再最小接线 | 完成，范围为测试传输，不是真实 Client 迁移 |
| 第二步 | 首帧与更新、旧代际、卸载取消、权限拒绝 | 完成。断线重连未实现：本批没有产品级重连语义，只提供 `restart()` |
| 第二步 | 保留 HTTP，不降级重试，不重复订阅或泄漏任务 | 完成：`apply`、`client.js`、HTTP 路由未改 |
| 第二步 | 冻结后独立审阅一次 | 审阅已执行并提出五类问题，均已修复；审阅方对最终快照的二次确认未返回（§8.2） |
| 第三步 | probe 仅核对现有能力与缺证 | 完成核对；无正式契约，保持未启用 |
| 第三步 | 用户与开发指南使用终态语句 | 完成：分别写明已验收、未接线、契约待定与真实环境待验 |
| 第三步 | 有源码变动时冻结并运行一次完整检查 | 完成：每个冻结快照各一次；最终为 2599 项（§8） |
| 第三步 | 交付验收表与剩余事项 | 完成：见 §8；本批不关闭整个 IAM 或生产准入 |

未做的两项不是遗漏，而是本批边界：真实 DTO、宿主访问控制与 HTTP 共存需要真实调用上下文；产品级断线重连需要真实传输生命周期。两者都不能用模拟结果替代，也不写成已完成。

## 3. 必守边界

真实 IAM、网关、Keychain、profile 与默认模型不改；不安装、发布、推送或修改 DSH 核心。真实 Host 继续严格只读，不用 fixture 补造保存或回退能力。个人身份、用途、额度与五分钟撤权仍需真实提供方证据。

`tokenFor(resource)`、MCP Token Broker、原生执行入口全面接线及新授权框架不混入本批。若需求确需扩展，先走现有范围与契约门禁，不在收尾时顺带实现。

## 4. 待确认与停止条件

| 事项 | 负责方（待确认） | 截止门禁／停止条件 |
|---|---|---|
| Client 公开 Remote 完整签名与生命周期 | 平台组、SDK 维护方 | rc.2/rc.3 公开类型 ABI 已核；真实注册前仍以 HTTP 为准，不假称 Remote 已接 |
| 只读 DTO、访问控制与旧 HTTP 共存 | 平台组、安全 | 私有接缝已按白名单实现；真实上下文与资源策略未批，权限拒绝不降级 |
| probe 无副作用端点及 owner/用途、错误语义 | 网关团队、安全 | probe 设计批准前；缺任一关键项则本批不启用 |
| 本批是否纳入只读订阅 source/mock | 用户已确认 | 已选继续最小订阅隔离实现；按 §7 执行，未改真实 Host/profile/SDK |

验收结束后停止本批：不追加非必要模糊测试、不重新设计 A—E、不持续扩张架构。只允许修复已定位、可复现且影响本批验收的必要问题。

## 5. 执行检查命令

工具链沿用仓库固定版本，不自动升级。实施者按最终文件表选定向测试，不预报测试数量或通过结果。

```sh
# 仅文档变更
mise exec node@24.21.0 -- pnpm check:docs
git diff --check

# 源码冻结快照：每个快照执行一次；冻结后再改源码则重跑
DSH_KEYCHAIN_SPIKE=0 mise exec node@24.21.0 -- pnpm check
```

本批因审阅修复经历多次源码冻结，每个快照各执行一次：合并 main 前为 1908 项，合并后的最终快照为 2599 项（§8）。文档补记不重跑完整检查。

## 6. 只读核验结论

2026-11-03 完成一轮核验，没有注册 Remote、挂载贡献、发起业务 RPC 或修改源码。事实来源为当前安装包的公开导出与浏览器制品、Inspect 只读契约，以及下列本仓库代码。

| 核验点 | 事实与影响 |
|---|---|
| 版本范围 | 安装的 `@deepseek-ai/dsh-api-gateway` 为 0.2.1-rc.5；[PLAN-007 验收](<2026-11-02-iam-consumer-isolated.md#4-当前证据>)记载仓库基线 rc.3；[IAM 清单](<../../packages/forge-iam/package.json>)仍声明下限 rc.2。不能用 rc.5 源码替 rc.2/rc.3 作兼容保证；本轮未调整 SDK、清单下限或仓库基线 |
| Host 贡献 | Inspect 确认 `typert.register(contribution)` 原子注册并归属调用 fiber，返回异步 disposer。Host 贡献使用 invocations；不能把它当成 Client 挂载对象 |
| Client 挂载 | 公开 `./client` 浏览器制品的 `$mount(contribution)` 为 async，等待挂载完成后才取得异步卸载函数；Client 按贡献的 descriptors 安装命名空间方法。该事实不是新增 IAM 端点合同 |
| 流与取消 | 生成的 stream 方法同步返回句柄并启动逻辑流，不返回 Promise。句柄只允许一个消费者；dispose 或提前结束迭代会取消。只有声明 cancellation 的描述符才允许可选末位 AbortSignal，并与挂载生命周期合并 |
| 错误与生命周期 | unary 返回 RemoteResult，传输失败通常折入失败分支；本地装配错误仍可能 reject。Client 卸载先使方法 token 失效并 abort；不能只清 React 监听而遗漏流和贡献卸载 |
| Inspect 限制 | 本次 Client 查询 remote 返回“no catalogued Service”；随后 Builtin 查询成功。不能把前者概括为 Client 断线，也不能据目录缺项断言 SDK 没有 Remote。实际签名以本轮公开制品阅读为据，未验证企业业务往返 |

### 6.1 不能直接移走现有轮询

[Client 轮询](<../../packages/forge-iam/client.js>)每两秒读取状态，并用 live、单飞及操作 epoch 抑制迟到结果。[HTTP 读取链](<../../packages/forge-iam/src/routes.mjs>)先调用 `syncFromStore`、`loadGatewayCredential`，再返回 `getView`。

[Host watch](<../../packages/forge-iam/src/service.mjs>)只给出初始 view 并监听 notify，没有主动承担上述同步。[hydrate](<../../packages/forge-iam/src/service.mjs>)执行初始化及强制凭据读取，不等于持续同步。`syncFromStore` 在过期、可刷新且满足 30 秒退避时会后台调用 `resolveToken`；迁移不能丢掉该条件，也不能每帧强制刷新。直接移走轮询会遗漏职责，观察取消不证明已经撤回已发请求。

### 6.2 本轮准入结论

已核清挂载、流、取消及同步职责；[模块最小接缝](<../design/plugins/forge-iam.md#523-最小只读订阅接缝sourcemock-已实现>)提出复用当前视图、Host 单飞同步与显式传输共存。精确字段契约、可信调用上下文、资源声明、旧 SDK 生命周期兼容及设计批准当时仍待准入，因此保留 HTTP。

随后用户批准最小 source/mock 私有接缝，按 §7 以测试传输实现并验收；真实 Host 上下文、资源策略与真实 Client 接线仍未接。

### 6.3 旧 SDK 的公开证据与限制

官方 npm 精确元数据证实 [rc.2](https://registry.npmjs.org/@deepseek-ai%2fdsh-api-gateway/0.2.1-rc.2) 与 [rc.3](https://registry.npmjs.org/@deepseek-ai%2fdsh-api-gateway/0.2.1-rc.3) 均存在，且均声明公开 Client 入口。对应公开类型入口 [rc.2](https://unpkg.com/@deepseek-ai/dsh-api-gateway@0.2.1-rc.2/lib/types/client/index.d.ts) 与 [rc.3](https://unpkg.com/@deepseek-ai/dsh-api-gateway@0.2.1-rc.3/lib/types/client/index.d.ts) 相同，明确 `$stream` 独立可取消、可重连且单消费者。

gateway 入口继承同版本 dsh-typert-protocol 的 TypertClientRemote。[rc.2](https://unpkg.com/@deepseek-ai/dsh-typert-protocol@0.2.1-rc.2/lib/types/types.d.ts) 与 [rc.3](https://unpkg.com/@deepseek-ai/dsh-typert-protocol@0.2.1-rc.3/lib/types/types.d.ts) 协议声明确认：`$mount` 返回 `Promise<TypertDisposer>`、disposer 异步、生成 stream 同步返回 `RemoteStreamHandle` 且 `dispose` 取消；`Context.invocation` 与 `Peer` 由 Host 固定，不能由 wire 自设。

这些精确版本的类型 ABI 足以作为私有模拟接缝依据，不等于运行实现、全部 `>=rc.2` 兼容或真实联调。详见 [IAM-004 §2](<../contracts/iam-view-observer-isolated.md#2-已核-sdk-形状与私有上下文>)；未下载解包、安装或执行旧 SDK。

## 7. 获批 source/mock 实施任务

**状态：** 已完成，范围限于私有测试接缝。

**目标：** 由实际 IAM 状态驱动共享 Host 观察组、纯 Client 消费者及 SDK-shaped 挂载传输，完成最小隔离订阅接缝。

**架构：** 新模块仅经既有 isolated-testing 出口提供；真实 `apply` 与 Client 入口不接线。管理调用由独立测试传输签发并逐次校验，IAM 登录仍来自实际工厂。字段及接口以 [IAM-004](<../contracts/iam-view-observer-isolated.md>) 为准。

**技术栈与执行：** Node 24.21.0、ESM、node:test；无新依赖。一个 writer 与一个独立审阅者；不提交、安装或运行真实接口。

**审阅重点：** 伪造或恢复旧 context；watch 积压旧帧；等待中撤权或换绑；多订阅共享与末订阅卸载；旧物理代际迟到结果。各项由下列行为用例钉住，突变证据见 §8.1。

### 任务一：Host 观察组及安全投影

- 新建 `packages/forge-iam/src/iam-view-observer.mjs` 与 `packages/forge-iam/test/iam-view-observer.test.mjs`；测试支架放 `packages/forge-iam/test/support/iam-view-runtime.mjs`。
- 修改 [isolated-testing 出口](<../../packages/forge-iam/src/isolated-testing.mjs>)，再导出 `createIamViewObserver`；不改实际 service 工厂及普通 apply。
- 消费实际 `createIamService` 的 sync/load/getView/watch；接口采用 [IAM-004 §3](<../contracts/iam-view-observer-isolated.md#3-私有工厂>)，周期固定 2000ms。
- [x] 实际签出工厂首帧、投影与访问拒绝用例先行；初版因等待队列缺陷全部挂起，修复后转绿，语义缺口另由 §8.1 的突变证明。
- [x] 获准管理 context 在 IAM 未登录时可读；伪造、副本、跨传输、异步校验均零 service 调用；snapshot 冻结且不含令牌、ref、attempt 或 probe 字段。
- [x] 两订阅共享一个读周期且不并发读；末订阅退出清 timer/watch；watch 积压值只唤醒当前 getView，不倒灌旧快照。
- [x] 撤权、方法重绑或取消穿越 sync/load 等待时，后续 load/getView 与发布为零；旧 context 不能复活，新签发 context 可开新调用。
- [x] 定向命令通过后冻结本任务，不重复 A—E 或全仓。

```sh
mise exec node@24.21.0 -- node --test packages/forge-iam/test/iam-view-observer.test.mjs
```

### 任务二：Client 代际与 SDK-shaped 联合

- 新建 `packages/forge-iam/src/iam-view-consumer.mjs` 与 `packages/forge-iam/test/iam-view-consumer.test.mjs`；同一 runtime 支架提供已核异步 `$mount` 及同步 stream handle，不提供虚构 cancel 方法。
- 再导出 `createIamViewConsumer`；不修改真实 [Client 入口](<../../packages/forge-iam/client.js>)，没有 HTTP 降级支路。open/accept/onError 及生命周期采用 [IAM-004 §3](<../contracts/iam-view-observer-isolated.md#3-私有工厂>)。
- [x] 旧句柄迟到帧不得进入 accept；代际守卫由受控突变单独钉住。
- [x] start 幂等；异步 open 按非法 handle 拒绝；restart 先取消旧句柄并忽略旧错误；dispose 结束自有循环。
- [x] 异步挂载 → 实际观察组 → 实际 IAM + mock IdP → accept 联合通过；挂载未完成不调用，拒绝或未知不降级，不建第二登录状态。
- [x] 卸载只释放拥有的调用；最后订阅退出后无自有 timer/watch 残留。

```sh
mise exec node@24.21.0 -- node --test packages/forge-iam/test/iam-view-observer.test.mjs packages/forge-iam/test/iam-view-consumer.test.mjs
```

### 任务三：终态文档与最终检查

- [x] 开发指南写明隔离订阅已验收、真实 Client 仍 HTTP，并说明取消、拒绝与后台刷新条件。
- [x] 模块、私有契约与索引更新实际证据；普通入口未注册模拟工厂，HTTP 管理面与清单下限未变。
- [x] 审阅后每个源码冻结快照各跑一次完整检查；保留平台跳过，不降低门禁；最终快照为 2599 项。
- [x] 汇总本批验收与剩余契约待项；不据最小订阅完成自动关闭整个长期目标。

## 8. 验收记录

| 项 | 结果 |
|---|---|
| 私有实现 | [观察组](<../../packages/forge-iam/src/iam-view-observer.mjs>)、[消费者](<../../packages/forge-iam/src/iam-view-consumer.mjs>)，仅经测试入口导出 |
| 定向用例 | 18 项通过：观察组 12、消费者 6 |
| 完整检查（源码与测试冻结时） | 2599 项中 2597 通过、0 失败、0 取消、2 项平台跳过；`DSH_KEYCHAIN_SPIKE=0 mise exec node@24.21.0 -- pnpm check` 退出 0 |
| 四段结果 | 文档检查 `ok`；仓库 765 跟踪文件；打包 8 个 / 216 文件；版本基线 rc.3、位置 2 处、下限 8 个断言 |
| 跳过原因 | macOS 系统钥匙串 spike（未设 `DSH_KEYCHAIN_SPIKE=1`）与 Windows 8.3 别名；均为既有平台跳过 |
| 未改内容 | 真实 `apply`、[Client 入口](<../../packages/forge-iam/client.js>)、HTTP 路由、SDK 依赖与清单下限；`src` 内仅测试入口引用新模块 |
| 验收面调整 | A—E 的两个导出面断言各改一行，把测试入口的精确键集从 1 个扩为 3 个；其余 A—E 用例未改 |
| 真实边界 | 未注册 Remote、未接真实 Gateway 上下文或资源策略、未发企业请求、未升级或安装 |

### 8.1 十三处受控突变

每处守卫单独删除时，只有对应用例失败；还原后 18 项全绿。

| 组 | 守卫 | 钉住的用例 |
|---|---|---|
| 复验 | sync 后复验 | 撤权穿越 sync 等待 |
| 复验 | load 后复验 | 撤权穿越 load 等待 |
| 复验 | 发布前逐订阅复验 | getView 内撤权 |
| 复验 | 读周期前权限 | 撤权后不再启动读取 |
| 复验 | 帧交付前权限 | 积压帧不得交付 |
| 队列与并发 | 失败清队列 | 失败后旧帧不得交付 |
| 队列与并发 | 取消清队列 | 取消后旧帧不得交付 |
| 队列与并发 | 跨组串行 | 重启组不与上一组并发 |
| 输入与句柄 | missing 描述符校验 | 被覆写的 `some` 不得绕过 |
| 输入与句柄 | thenable 观察 | 晚到句柄必须释放 |
| 输入与句柄 | Proxy 拒绝 | trap 执行前拒绝 |
| 消费者 | 代际守卫 | 旧代际迟到帧不得 accept |
| 模拟传输 | 密封绑定 | 撤销后不可复活、原件不可替换 |

### 8.2 审阅状态

独立审阅提出五类必要问题并给出可复现 trace：读周期与帧交付前复验、跨组串行、Proxy 拒绝、thenable 观察与释放、密封绑定与永久撤销。五类均已修复，并由 §8.1 的突变与 18 项定向用例覆盖。

审阅方对最终冻结快照的二次复核请求在本次会话未返回，因此本表不写“审阅已通过”，只记录问题已处理与该确认尚未取得。

---

*本计划依据当前仓库与已登记验收记录编制；新的接口事实以实际核验和正式契约为准。*