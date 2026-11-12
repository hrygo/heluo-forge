# 逐模块设计索引

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DOC-002 |
| 文档名称 | 逐模块设计索引 |
| 版本 | V0.41.1 |
| 文档状态 | 生效 |
| 密级 | — |
| 编制 | DSH 平台组 |
| 审核 | DSH 平台组 |
| 批准 | DSH 平台组 |
| 最后更新 | 2026-11-12 |
| 门禁 | — |

## 1. 结论

本索引管八个 DSH 产品扩展包、一个凭据支撑包、原生插件市场与两个独立服务入口（SDD 已于 2026-11-03 退役删除，保留历史记录）。市场的模式与当前状态见[索引契约 §1](<services/market-index.md#1-一页速览>)。除市场为评审稿外，其余设计仍为草案；设计状态、代码实现与上线准入分别判断。2026-10-23 ADR-16 将个人访问目标调整为当前人员与 DSH 用途校验，个人访问路线 B（Key＋令牌）已选定，路线 A 保留为比较背景；应用访问受控开通，五分钟撤权与当前授权退出待核验。原 Key-only 实现状态不因此改写为新能力已完成。 2026-10-28 IAM 回函复核曾记录厂商不支持公共客户端/PKCE；2026-11-10 项目负责人确认企业 IAM 支持公开客户端 + PKCE S256，企业交付基线改为 `authMode=public`，机密客户端仅保留为可选隔离路径，真实行为按 #123 核验。 2026-11-03 IAM 团队书面答复 C1—C11：单 client_id、secret 人工轮换且旧 AT 不随轮换作废、登出作用于浏览器会话、刷新后旧 AT 实时作废、重用仅拒绝本次刷新。2026-11-04 D1—D3 答复：按访问令牌撤销接口（仅 AT、令牌自证、幂等、实时）、轮换窗口内仅旧值有效、刷新令牌滑动续期且无绝对期限；默认退出改为撤销 AT + 本地删除、不调用全局登出，真实联调未开始。

详细设计使用[模块设计模板](../templates/design-template.md)，外部字段级契约仍以[契约目录](../contracts/gateway-contract.md)为唯一真源，设计只引用不复制。

## 2. 安装包设计

| 包 | 形态 | 设计文档 | 设计状态 | 主要待确认 |
|---|---|---|---|---|
| `@heluo/forge-iam` | Host + Client 插件 | [plugins/forge-iam.md](plugins/forge-iam.md) | 草案（O3 独占；Host+Client 骨架、OIDC mock 流程、网关凭据录入/清除/状态、模型门禁与默认模型判定、默认模型写入接线（写前独立复查、绝不覆盖显式企业选择）、禁用插件/独占冲突 fail closed 实测已落地；新对话默认模型在可证明不可用时对齐为企业默认模型（离线测试覆盖，未实机）；[受控模型运行时](../../packages/forge-iam/src/managed-models.mjs)（企业账号页地址与 Key、`${baseURL}/models` 动态目录、七行禁用与回灌检查）本地实现，见 §2.2.1；Remote/watch 未实现） | IAM 回函、可选机密客户端隔离路径、目标平台存储验证、官方行运行时模型面、真实联调、UAG 凭据探测 |
| `@heluo/forge-policy` | Host 插件 | [plugins/forge-policy.md](plugins/forge-policy.md) | 草案（guard、异步确认、必要审计与命令共用屏障已实测；既有 32 项宿主探针中的辅助函数调用不等于真实恢复、分叉、子 Agent 的授权承接；确认/委托纯 API 与可信运行时接线分开验收） | 审批注册与超时、`$DSH_HOME` 范围（子 Agent 模型自决调用与策略×沙箱叠加顺序已实测，见下方证据） |
| `@heluo/forge-enterprise` | umbrella bundle | [plugins/forge-enterprise.md](plugins/forge-enterprise.md) | 草案（策略为硬依赖，无只读降级；市场不插入历史插件行；按需技能/条款装配、包体闭包检查、五类开关声明与判定、官方行回灌检测已实现；官方行禁用（2026-10-24 实测四个登录/模型行加明文凭据行；2026-11-04 扩至六个官方行加明文凭据行，扩行后组合层未复测）与装/升/退/卸演练已实测；真机 `dsh plugin` profile 级安装、rc.2→rc.3 升级循环与回退/卸载残留、四层组合层序与 `--from-default-profile` 整体替换已实测；企业能力行按最小挂载挂凭据/策略/IAM 三插件（SDD 已于 2026-11-03 退役，补丁 `insert:` 段仅三插件行） | 版本断言报错形态、`fiberPhase`、双端、企业索引源键名、`ai-publish`/`human-review` 业务行（未落地故 `blocked`）、角色 preset 粒度、`desktop` profile |
| `@heluo/forge-gateway` | 配置 bundle | [plugins/forge-gateway.md](plugins/forge-gateway.md) | 草案（路线 B 已选定） | 当前身份/用途、B 双因子承载、应用/IP、五分钟及单授权退出、C4 策略与容量联调；模块仍为规划入口，无清单、源码或测试 |
| `@heluo/forge-brand` | 配置 bundle | [plugins/forge-brand.md](plugins/forge-brand.md) | 草案 | token 清单实测、双端资源路径、子品牌与合规页脚 |
| `@heluo/forge-devops` | CLI 接入（工具面 + 设置页） | [plugins/forge-devops.md](plugins/forge-devops.md) | 草案（2026-11-06 r15：设置页两分区——`devops-readiness`/order 29 汇总六行本机可见性、`devops`/order 60 保留既有字段面并加三行保存回执与来源页脚；保存成功后重建读面并回 `applied`，端点原样透传；2026-11-04 基线：只讲 dop 变更流程，四个工具、配置四键；仓库/Issue/PR 事实由 `forge-gitee` 唯一负责） | 系统变更/独立验收映射、aarch64 产物、凭据/输出；受控写范围、C3 分类与回查待批待验；`heluo-r15-uat` 装入与回滚未执行 |
| `@heluo/forge-gitee` | CLI 接入（工具面 + 设置页） | [plugins/forge-gitee.md](plugins/forge-gitee.md) | 草案（2026-11-06 r15：设置页「企业 Gitee」分区（id `gitee`、order 50）+ 配置端点 `GET/POST /api/forge-gitee/config`（`config-access.mjs` 三层读面与 revision 栅栏、`http.mjs` 预检头/413/`applied` 透传、`index.mjs` faces 单点换页），浏览器半 `client.js` 与 `dsh.client`/peer react 一并落地；2026-11-03 r10 基线：10 个 `forge_gitee_*` 工具、13 个源模块与离线用例） | aarch64 产物、鉴权注入与 `--json` 字段稳定性（企业 CLI 未联调）；常规研发/评审写范围、C3 分类、可信来源与版本绑定待批待验；设置页实机渲染未验证 |
| `@heluo/forge-sdd` | 已退役（包与 CLI 已删除；非 Host） | [plugins/forge-sdd.md](plugins/forge-sdd.md) | 已废止（2026-11-03 按用户决定全量退役；历史兼容语义与实施记录见正文） | 无在库交付；企业组合包依赖与 bin 已移除，已安装 profile／发布制品不动，外部 caller 未验 |
| 原生插件市场 | DSH 内置 + AIHUB 索引 | [plugins/forge-market.md](plugins/forge-market.md) | 评审稿；`dsh plugin` 转发 pnpm 的安装/卸载参数已真机实测 | AIHUB 托管 format-1 索引、原生添加 URL、官方 manager 安装；模式与当前状态见[索引契约 §1](<services/market-index.md#1-一页速览>) |

设计文档路径相对本目录；正文均已落盘，不表示对应包或市场已实现。

### 2.1 跨模块设计

网关凭据设计横跨身份插件与网关配置，不属于单个包，单独成文：[网关凭据双模式支持设计](credential-modes.md)（CORP-DSH-DESIGN-001，V2.0.0 评审稿；采用路线 B 双因子协同，与应用凭据构成两类运行态，非运行时二选一回落；适配层 V1 由 `forge-iam` 受控模型运行时承载，`forge-gateway` 保留配置与抽离目标；上游规范未冻结）。

DSH 客户端标识（UA）同属跨模块，单独成文：[DSH 客户端标识（UA）方案设计](client-identification.md)（CORP-DSH-DESIGN-015，V0.2.0 草案；需求方决定使用 DSH 默认 UA，由网关按关键字匹配，不改写 UA；候选关键字、网关能力和代理链路待确认）。

市场的社区/官方源码调研与选型依据见[企业插件市场调研与落地建议](<../architecture/plugin-market-research.md>)；Gitee 侧能力澄清见[专题问询函](<../collaboration/gitee-market-clarification.md>)。原研究为历史证据，来源方向由 [ADR-11](<../architecture/plugin-registry-source-decision.md>)，轻量索引模式由 ADR-13 替代；契约与真实接入仍需分别验证；市场模式与当前状态见[索引契约 §1](<services/market-index.md#1-一页速览>)。

[企业研发全流程能力面](plugins/forge-devops-lifecycle.md)（草案，DESIGN-013）统一六阶段地图、形态判定、人机双面、工程追溯、观察指标及开放决策。工具字段与事件字段分别见[工程工具契约](../contracts/engineering-tools.md)、[观察事件契约](../contracts/metrics-events.md)；不新增安装包，不代表内网接口或受控写已准入。

专用访问的完整决策比较及验收细化见[评审稿](../architecture/gateway-identity-review.md)，提供方问题见[网关新函](../collaboration/gateway-confirmation-letter.md)与[IAM 原函覆盖评估](../collaboration/iam-confirmation-letter.md#8-本轮需求覆盖评估与补充确认清单平台内部)。

### 2.2 实现与验证入口

以下记录各模块的实现和验证边界；已有记录不证明 ADR-16 的目标令牌、归属一致、用途及单授权生命周期已经实现。

| 模块 | 当前实现 | 验证边界 |
|---|---|---|
| [forge-iam](../../packages/forge-iam/README.md) | Host + Client 开发骨架；内置 SQLite 组合绑定单记录信任与网关联合 adapter，刷新和退出以 pending 状态及条件提交处理；旧网关 V1 不被采用，凭据保留且不覆盖，异常记录不自动修复 | 本机合成测试不证明目标平台耐久提交、企业 IAM/UAG、真实授权或工具入口；未知 provider 不获写入信任，退出及远端撤销未知不报告成功。墓碑不等于物理删除；Client 走 interim route |
| [forge-credentials-keychain](../../packages/forge-credentials-keychain/README.md) | SQLite 值级 AES-256-GCM、版本化 keyring、跨进程逻辑锁与单记录/双键条件提交；内存后端仅供测试；旧布局及未绑定旧库保留且拒绝访问 | 2026-11-12 在 macOS arm64、Node 24.21.0 使用临时合成数据通过凭据包离线测试、CLI 重开与子进程中断测试；Windows、麒麟、Electron 及企业环境未实机验证，不代表生产准入 |
| [forge-market](../../packages/forge-market/README.md) | 历史参考包：十个工具、Host 路由、面板、归档安装链路；不属轻量模式目标 | 离线测试保留；不得作为原生索引链路的实现证据 |
| [market-index](../../services/market-index/README.md) | 只读 format-1 索引校验器；无服务、无生成器 | 13 项离线测试通过；未验证 AIHUB 真实索引或企业安装 |
| [forge-policy](../../packages/forge-policy/README.md) | Host 策略门禁骨架：受控动作目录、`tools.guard` 单调硬拒绝、`tools/pre-execute` 待确认动作、受保护路径与 `$DSH_HOME` 硬拒绝、命令面同一判定、决策审计前置；10 个源文件 | 2026-10-26 `node --test packages/forge-policy/test/*.test.mjs` 141 例通过、无跳过；10 源文件原生覆盖率（行/分支/函数）96.01%/90.70%/94.44%；必要审计另有 65 例聚焦测试及 rc.2 实际组件独立复核 6 项通过；目标 rc.3 尚未复跑（D1 写动作登记负测：12 条登记动作默认全部被拒、执行体零调用；批准台账负测：`enabled` 的写/确认动作没有有效台账条目就拒绝挂载、过期条目不足以开放、台账动作不匹配不算批准、只读不受约束，见设计 §5.1.2）；宿主探针（`scripts/probe/run-host-probe.mjs`）已实测 guard 拒绝零副作用、异步 pre-execute、子 Agent 作用域 guard 继承与父视图 `restrict` 不继承、门禁合成查询与受保护路径拒绝。模型门禁探针（`scripts/probe/model-guard-probe.mjs`）已实测**模型自决调用不会绕开门禁**：`unregistered-action`/`action-disabled`/`target-required` 三种模式各以会话记录中的 `tool/call`+`tool/result` 为据、副作用为零，并以不挂策略的正向对照证明模型确实会调用；同时暴露目录只认调用参数 `target`、真实工具（`bash` 的 `command`、`fs` 的 `path`）无法放行的缺口（见设计 §9.2.2）。沙箱叠加顺序探针（`scripts/probe/sandbox-order-probe.mjs`）已实测**策略门禁先于沙箱执行器判定**（策略拒绝归因不带沙箱信号、目标在沙箱允许区内也不产生副作用；越界写由操作系统级拒绝），见设计 §9.2.3。委托路径面（`delegate` 模式：父模型调用 `subagent`、子 Agent 的 9 次 bash 调用全部被拦、零副作用）亦已实测，**委托不能绕开门禁**。**未完成/未测**：默认企业工具自动绑定、运行时批准范围复验、可信 principal/真实会话恢复与分叉承接仍须单独整改验收；企业环境、双端实机及目标 rc.3 未验，不以纯函数或旧探针泛化 |
| [forge-enterprise](../../packages/forge-enterprise/README.md) | 企业组合 bundle：七个官方行禁用补丁（六个登录/模型行：`deepseek-account`、`ui-settings-account`、`llm-deepseek-account`、`llm-deepseek`、`llm-pi-ai`、`ui-settings-models`，加明文凭据提供方 `credentials`，即 `reflow.mjs` 的 `OFFICIAL_ROWS`）、配置整体替换、回灌检测（未知状态按 fail-closed 处理）、角色配置恢复、自包含构建与三插件挂载（SDD 已于 2026-11-03 移除）；5 个源文件 | `node --test packages/forge-enterprise/test/*.test.mjs` 33 例通过（2026-11-03 复测）；`tests/bundle-build`/`bundle-closure` 51 例通过，自包含构建 + 安装/升级/回退/卸载演练通过（2026-10-26）；真机安装/升级/回滚/卸载与残留、四层补丁层序与 `--from-default-profile` 已实测（任务 `20261024T023419Z-dsh-install-c8c2`、`20261024T025338Z-dsh-profile-replace-eb4e`）。2026-10-24 五行口径（四个登录/模型行加明文凭据行）下的**组合层完整性**已实测（`scripts/probe/official-rows-blanking-probe.mjs`：`web` 上五行均落 `disabled: true`，基线 58 个界面/设置/模型选择相关行全部保留且未禁用、无激活告警；设计 §5.2.1）；2026-11-04 扩至七行后只由 `bundle-patch.test.mjs` 断言补丁内容，组合层与回灌未复测。**未验**：界面功能（设置页/模型选择真的可用）与角色 preset 粒度；`desktop` profile 在本机不可 dump（应用独占管理），按 NOT RUN 记账 |
| forge-sdd（已删除） | 历史 SDD 库与 CLI：freeze/verify 规则、清单校验；**非默认 Issue 交付要求**；4 个源文件；2026-11-03 按用户决定全量退役，包已删除 | 删除前 2026-10-26 单测 27 例通过、覆盖率（行/分支/函数）99.53%/93.06%/100%；**未联调**企业 CI；删除后无在库实现可复跑，历史结论不认证企业 CI |
| [DSH 客户端标识](client-identification.md) | 使用宿主默认 UA，由网关匹配关键字；未实现网关规则，也不通过插件改写 UA | 2026-10-28 在本机 DSH `0.2.1-rc.3` 用 [`issue100-user-agent-probe.mjs`](../../scripts/probe/issue100-user-agent-probe.mjs) 测试 pi-ai 的 OpenAI-compatible 流式请求：宿主覆盖配置中的 UA，默认 UA 与可选合成诊断头到达本地模拟服务；探针退出成功只表示取证成功，不代表网关验收。真实网关及代理、Windows/麒麟、其他协议和 Coding Plan 均未验 |
| [forge-gitee](../../packages/forge-gitee/README.md) | 独立 CLI 接入包（单安装单元）：11 个 `forge_gitee_*` 工具（3 读 + 4 受控写 + 1 只读判定 + 1 版本快照 + 2 git；判定随包默认登记可用、写与 push 默认不登记即拒绝）、`gitee.*` 动作命名空间、`GITEE_*` 白名单字段子集（`GITEE_PLATFORM`）、唯一 `execFile` 出口（`run()`/`runGit()` 共用）、幂等台账、`review.md` 渲染与关闭条件判定；14 个源模块 + `cordis.patch.yml`（策略行 `heluo-policy` + 插件行 `forge-gitee`，与 devops 补丁层同 id、目录逐字相同、无 `isolate`） | 2026-10-29 `node --test "packages/forge-gitee/test/*.test.mjs"` 171 例、`node --test tests/bundle-gitee.test.mjs tests/plugin-patch-layers.test.mjs` 8 例离线通过（覆盖只读信封降级、写动作四状态与回读、默认禁用零调用、宿主 `register()` 判据、真实补丁层装载、共存形态与跨包策略行一致性、`buildBundle` 闭包与产物逐字节一致）；**未验**企业 Gitee CLI 联调、aarch64 产物、真实 profile 装入与 `--json` 字段稳定性；r10 增删模块后的条数与结果以本需求 QA 实测为准，明细见包 README 证据表与 NOT RUN 清单 |
| 其余四包与 DevOps MCP | `forge-devops` 的"只读查询 + 门禁骨架"**已落地**（D4，2026-10-24）：清单、只读端口（2026-11-03 起 `change.read` + `change.list` 两条）、门禁骨架、四个工具（`query`/`change_context`/`change_update`/`artifact_write`，参数用门禁认识的 `target`；写回按 `change.clarification.write` 登记，默认不登记即拒绝）、离线测试（2026-10-26：空目录/漏映射/未开放拒绝挂载，读取走同一 `executeAction` admission，拒绝时适配器零调用）、**宿主探针两模式通过**（`with-reader`：模型自决调用经门禁到达适配器恰好一次；`no-reader`：可见地报 `NO_READER`；并借此发现并修复"缺 `inject` 导致工具静默不注册/整项不激活"），**企业 CLI 联调未做**，写动作全部关闭；r10 起仓库/Issue/PR 的读写改由 `forge-gitee` 唯一负责，devops 的 gh 侧七个模块已删除；`forge-brand` / `forge-gateway` 与 `services/devops-mcp` 仍为规划入口，无清单、源码或测试；`forge-gitee` 已另起独立单安装单元（见 §2.2 与包 README）。准入手册见[能力面设计 §6.1](plugins/forge-devops-lifecycle.md) | 对应设计中的测试矩阵为目标，不是执行结果 |

### 2.2.1 IAM 离线验收清单

账户操作见[用户指南](<../../packages/forge-iam/docs/user-guide.md>)，代码接口和验证方法见[开发指南](<../../packages/forge-iam/docs/developer-guide.md>)。下表区分可重复验证的当前行为、尚未闭合的本地缺口与外部证据，不用 mock 结果代替生产准入。

| 能力 | 验收入口 | 当前边界或待闭合项 |
|---|---|---|
| 配置与 OIDC 登录 | `config`、`login`、`oidc`、`security-matrix` 及 [错误字段脱敏](<../../packages/forge-iam/test/oidc-error-redaction.test.mjs>) | 普通apply仍为public + 强制S256；实际私有测试工厂已支持机密Basic/Post，见下行。HTTP error只保留精确标准码，不带任意error原文；合法invalid_grant及成功业务数据保持。生产secret来源/生命周期仍未接 |
| 回环回调监听 | [callback-port](<../../packages/forge-iam/test/callback-port.test.mjs>) | 插件自建回环监听，端口由系统分配（也可固定），只在登录尝试期间存在；`redirect_uri` 逐字节相等，Host 与路径精确，端口占用记 `IAM_CALLBACK_PORT_UNAVAILABLE` 并拒登录。mock 下完成授权→回调→换票；IPv6 回环在 Ubuntu/Windows CI 均实测可绑定，IAM 是否接受 `[::1]` 未验 |
| 机密认证基础与隔离服务 | [配置](<../../packages/forge-iam/test/client-auth-config.test.mjs>)、[来源](<../../packages/forge-iam/test/client-auth-source.test.mjs>)、[HTTP](<../../packages/forge-iam/test/client-auth-transport.test.mjs>)及[格式/跨模式](<../../packages/forge-iam/test/client-auth-record.test.mjs>)、[实际服务](<../../packages/forge-iam/test/client-auth-service.test.mjs>)、[生命周期](<../../packages/forge-iam/test/client-auth-lifecycle.test.mjs>)、[刷新](<../../packages/forge-iam/test/client-auth-refresh.test.mjs>) | 独立认可的具体来源驱动实际Basic/Post code/refresh/revoke、V2恢复与清理；V1/V2和完整authContext严格隔离，来源/代际变化拒绝旧操作，未知不重发。public不采用或盲删V2；普通apply没有生产secret adapter，隔离闭环不等于正式能力 |
| 管理 API 认证 | `routes` 测试 | 仅 Connection 同步返回 undefined 时放行；异常结果拒绝且 service 零调用 |
| 会话同步与 provider 归属 | `provider-replacement-read`、`sync-provider-replacement` 测试 | 同步前后复查 provider，以本地采纳版本和身份快照保护结果；旧读取/错误不覆盖新会话或新确认的空状态，替换仅清本次仍持有的旧身份。`getView/getPrincipal` 只读缓存，不提供即时撤权检查 |
| 刷新与重启恢复 | `dual-process-refresh`、`refresh-complete-validation`、`service-singleflight-regression` 测试 | pending/complete 协议依赖受信原子后端；内置 SQLite 组合已接入，本机离线验证不代表目标平台与企业联调通过 |
| 条件退出及远端撤销结果 | `signout-pending`、`signout-replacement`、`routes` 及 [RP 行为保护](<../../packages/forge-iam/test/rp-logout-issuer-context.test.mjs>) | 清理未知不等于退出成功；墓碑不是物理删除，成功撤销响应不证明后代授权已终结。合法 RP 配置要求显式退出地址且优先于 discovery；迟到 metadata 不替换该地址，六项内存回归保护现有行为，不是漏洞修复 |
| 账户恢复、取消及退出交错 | `client-signout-behavior` 测试 | 真实 Client 源码的模拟渲染与受控交付；不证明跨入口/跨进程排序 |
| 网关凭据读写与归属 | [未受信拒绝](<../../packages/forge-iam/test/gateway-atomic-policy.test.mjs>)、[联合条件提交](<../../packages/forge-iam/test/gateway-atomic-transactions.test.mjs>)、[服务集成](<../../packages/forge-iam/test/gateway-atomic-service.test.mjs>)、[SQLite 存储](<../../packages/forge-credentials-keychain/test/sqlite-store.test.mjs>)及 `gateway-provider-context`、`store`、`service` | 内置 SQLite adapter 提供双键条件提交；门禁不满足时保存/清除拒绝，旧网关 V1 不被采用，凭据保留且不覆盖；orphan 和不一致 pair 保留且不自动迁移。离线测试覆盖快照 CAS、guard、墓碑和失败回滚；不证明跨进程 grant 授权、目标机耐久提交或真实调用 |
| discovery-only 的旧会话绑定 | [issuer-context-policy](<../../packages/forge-iam/test/issuer-context-policy.test.mjs>)、[discovery-issuer-outbound](<../../packages/forge-iam/test/discovery-issuer-outbound.test.mjs>) | 不为恢复补齐未知 issuer 而启动探测；无明确 pin 或本实例已验证上下文时拒绝采用旧身份、AT 及主体，保留记录。带 `sessionInstanceId` 且与显式 pin 匹配的公共 V1 可读；缺少该标识的会话拒绝采用；异步操作与共享刷新固定 issuer，错误出口不发送旧 RT |
| 用户自助信息 | [client-clipboard-behavior](<../../packages/forge-iam/test/client-clipboard-behavior.test.mjs>)、Client 与随包指南测试 | 账户页可主动复制已取得的登录链接和最小白名单诊断；不额外联网、不导出身份或凭据。异步结果受页面代际/链接身份/生命周期保护；不代替真实浏览器权限或原生剪贴板验收 |
| 模型只读编排与隔离适配 | [实际 Host 编排](<../../packages/forge-iam/test/model-selection-host.test.mjs>)、`model-gate`、`model-selection` 及 [outcome 回归](<../../packages/forge-iam/test/model-selection-outcome.test.mjs>) | 真实 apply/服务加模拟 SDK 验证严格只读、保存 getter 零访问、原选择不变、单飞与解绑、异步旧结果失效及模型错误不清 OIDC grant。只复用纯判定，不应用切换；记录式 sink 写入保持独立，异常用 written:null 标示未知。SDK无明确空态/条件保存；另有隔离执行组合证据见下表，真实人员/用途授权仍未接线 |
| 企业模型运行时与动态目录 | [managed-models](<../../packages/forge-iam/test/managed-models.test.mjs>)、[组合探针](<../../scripts/probe/run-iam-managed-models-probe.mjs>) | 企业账号页配置网关地址与个人 Key，`${baseURL}/models` 动态目录接入公开适配器和执行门禁；七行禁用与回灌检查覆盖通用模型与自由配置页。探针只用模拟 IAM／UAG 与合成内存存储：生产认证与存储、真实企业授权、工具入口和双端 GUI 未验 |
| 包说明与制品 | `package-shape`、仓库包体检查 | 用户/开发指南随包，检查本地链接、锚点与表格；不代替 GUI 或生产操作验收 |

#### 本阶段关闭项与剩余可模拟项

下表区分已按策略关闭的真实自动保存与尚未闭合的本地功能，后者不应笼统归为“仅缺真实环境”。前置决定未定时保留现状，不虚构生产协议或用 fixture 自动批准。

| 事项 | 可在隔离环境验证的部分 | 决定与剩余边界 |
|---|---|---|
| 真实默认模型自动保存（本阶段关闭） | 实际 Host 严格只读编排已接线并模拟验证；[实施计划](<../plans/2026-11-02-iam-default-model-readonly.md>)不包含真实写入 | 已选择真实 Host 不自动写；SDK 未提供的空态与条件提交不得由 fixture 补足，真实写待可靠能力与另行授权，不是尚待补做的模拟放行分支。 |
| 机密客户端与 secret 生命周期 | 已确认管理员预置隔离基线；[设计](<iam-confidential-isolated.md>)与[字段契约](<../contracts/iam-client-auth-isolated.md>)定义 code/refresh/revoke 与来源失效边界；实际隔离服务已接入 | 独立建造审阅无重要剩余问题，用户已批准完整 source/mock 设计，[实施计划](<../plans/2026-11-02-iam-confidential-isolated.md>)已登记，实际 Basic/Post、V2 生产/恢复、共享刷新 pin 与 cleanup 已接入，54项新服务用例和851项必要合并通过，最终冻结验收见计划。真实来源不开启；供应商 Basic/Post、存储与生产生命周期仍待 G1，不能把 fixture 写成正式能力。2026-11-03 IAM 对机密客户端的历史答复涉及单 client_id、人工轮换与缓存两分钟生效，以及刷新携带 secret；当前 public 交付不使用 secret。撤销/登出按现行 IAM 接入材料核验。 |
| 模型与工具执行入口 | SDK 形状接缝的本地必要条件拒绝、下游零调用与失效交错；[DESIGN-017](<iam-consumer-isolated.md>)与[IAM-003](<../contracts/iam-consumer-isolated.md>)为已批准的私有source/mock设计 | 用户已批准完整“假账号、假模型、假工具、不动真实环境” source/mock 设计。实际工厂会话见证A已实现并通过57新例/760项必要合并，peer与代表性变异已关闭；按[PLAN-007](<../plans/2026-11-02-iam-consumer-isolated.md>)已验收B局部许可算法（62新例/210项policy回归及独立变异），C合成工具/命令已验收（31新例/241回归及独立变异），D合成模型已验收（29新例/270项policy回归，含最终错误桥修复与独立复核）；E根16项实际IAM联合已验收（含不同issuer/person整体替换），分段/联合独立审阅已关闭；Root最终完整检查1889总项、1887通过、0失败/取消、2平台跳过、exit0。首次discovery ready不补见证票，不开放真实调用。不能随 IAM 卸载撤闸，也不能以缓存 ready 代替人员/用途授权；真实 provider/action 与授权契约独立待核。 |

Remote/watch 和 tokenFor 的目标接口、凭据探测及企业授权路线仍按模块准入单独处理。网关路线 B 与既有 P0 原生 Key 路线的能力差距按[网关契约 §4.1.2](../contracts/gateway-contract.md#412-阶段能力矩阵)的阶段判据收口，不由本清单替责任方裁决生产授权。

2026-11-02 的剩余边界盘点将“能够模拟”与“协议已经决定”分开：

| 事项 | 当前证据与下一最小动作 |
|---|---|
| Client Remote/watch | Host watch已实现，Client仍HTTP两秒轮询。[私有只读订阅接缝](<../contracts/iam-view-observer-isolated.md>)已按source/mock实现：共享单飞读、独立管理面校验、代际取消，18项定向用例通过；真实Client未接线，真实上下文/资源策略与生产准入未开放 |
| tokenFor(resource) | 当前只有resolveToken；资源/audience信任与实际消费者未定。不把旧AT加标签当资源换票，也不以fixture新增提供方能力 |
| 网关凭据probe | 当前只保存/读取，无探测。无副作用端点、owner/用途依据与错误分类须由网关协议确认，不把configured或假成功当有效授权 |

这些待定接口不混入已批准的PLAN-007，也不因本批完成就自动删除或宣称全目标关闭；后续隔离设计与批准须另行收口。正式secret投递、OS保护、实时人员用途与五分钟撤权依赖提供方证据；本地模拟不替其背书。

后续按[PLAN-008收尾计划](<../plans/2026-11-03-iam-mock-closeout.md>)推进。[只读订阅私有接缝](<plugins/forge-iam.md#523-最小只读订阅接缝sourcemock-已实现>)已按批准范围实现并验收：白名单投影、Host 单飞同步、独立管理校验与代际取消。真实注册、真实 Host 上下文与资源策略仍待准入；旧 SDK 入口文字证据不能替代生命周期兼容。probe 缺正式契约保持未启用；模拟验收不写成真实接通。


执行入口的只读核验（2026-11-02）还确认以下限度，不是已接 IAM 门禁的声明：

- SDK 的 tools.guard 是同步、单调拒绝，llm/stream 则是可短路的 waterfall；后者不能被写成任意监听顺序下的硬闸。注册均有所属上下文，卸载会移除。
- [policy 当前注册](<../../packages/forge-policy/src/index.mjs>)只覆盖登记范围，卸载撤销 guard 和服务，没有读取 IAM；[DevOps 硬依赖](<../../packages/forge-devops/src/index.mjs>)确实声明 policy，但不因此获得实时 IAM 身份或用途授权。[模型纯判定](<../../packages/forge-iam/src/model-gate.mjs>)也不是执行拦截。
- 受保护对象、独立于 IAM 的门禁所有者及可信授权来源仍是下一阶段的关键边界。缺来源拒绝、失效交错、下游零调用和解绑可由 mock 验证；真实人员/用途授权与五分钟撤权不能由 fixture 承诺。

五条跨模块冲突（policy fail-open、无 policy 降只读、审计失败是否阻断、SDD 本地／CI 双路径、历史市场行与 SDD 挂载口径）的定位与结论见[跨模块冲突收口](conflict-resolution.md)（DESIGN-014）；**五条已由责任方 2026-10-24 逐条确认**——确认的是组织做法，不等于企业能力已联调（C4 的 CI 侧、C5 的安装与依赖事实仍待证据），也不放开任何受控写。

## 3. 独立服务设计

| 服务 | 代码位置 | 设计文档 | 状态 | 主要待确认 |
|---|---|---|---|---|
| DevOps MCP 服务 | `services/devops-mcp/` | [services/devops-mcp.md](services/devops-mcp.md) | 条件建设，当前不建设 | CLI 前提不成立时先评审形态变更、范围与成本，批准后才启动 |
| 索引契约与校验 | `services/market-index/` | [services/market-index.md](services/market-index.md) | 评审稿；只读校验器可用 | AIHUB 索引 URL/JSON/更新 SLA、Artifactory 终端认证与三目标安装待验 |

[ADR-11/13](<../architecture/plugin-registry-source-decision.md>)已确认企业 npm 为唯一 npm 源与 AIHUB 原生索引；企业私版也可经内部文件交付；007/012 为评审稿，不以文档定版代表准入。本项目不建生成器、服务、写前授权或全通道强制；市场模式与当前状态见[索引契约 §1](<services/market-index.md#1-一页速览>)。部署与运维边界见[部署说明](../../deploy/README.md)。

## 4. 设计顺序

依赖方向决定顺序：身份与策略先定，组合包最后收敛。

```text
forge-iam → forge-policy → forge-enterprise
forge-gateway → forge-brand → forge-market
forge-devops → CLI 前提核验 → 形态评审获准后才建设 devops-mcp
forge-gitee → 历史 SDD 兼容（已删除）
AIHUB 索引 JSON → DSH 原生市场的目录来源
```

- 身份与策略改变工具管线行为，先设计，避免其他包按错误假设返工。
- 组合包依赖各成员包的入口与禁用语义，最后设计。
- 市场不再自建目录服务或接入包；索引契约与 AIHUB 交付单独验收。

## 5. 完成判据

一份模块设计可进入实现，需要同时满足：

1. 目标 DSH 版本、SDK 与真实接口已核验，并记录核验方式与日期。
2. 权限、凭据、数据生命周期与失败模式写明可判定行为。
3. 配置 schema、导出面与兼容策略明确，未定项列入待确认。
4. 测试矩阵覆盖正常、异常、并发与退出路径。
5. 关联需求与验收条目可追溯，不新增未批准范围。

未满足时不创建 `package.json`，也不把目录状态改为“可用”。

## 6. 维护约定

- 设计变更同步更新本表状态；实现与设计不一致时，先改设计再改代码。
- 模块设计不复制网关、IAM 等外部契约字段，使用相对链接引用。
- 模块设计编号复用对应域编号；无域编号的组合包使用 `DESIGN` 系列。
- 设计优先复用企业既有资产（CLI、制品库、审批单、身份能力）；确需自建时写明既有资产为何不适用。
- 设计实现前必须核验目标接口；无法核验的接口形状标注"待实测"。
- 增益不明确、需用户确认的选项单列保留，不阻塞主链路实现。
- 新增模块先在本表登记，再创建目录与设计文档。
