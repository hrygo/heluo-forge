# QA-REPORT · r20 P1 受控写安全基线（身份 / 子代理 / 确认卡片 / 决策复用）

- 需求夹：`docs/teamflow/20261120-r20-policy-p1-write-gate/`（PRD 21 条 AC、TECHNICAL §5 API 契约）
- 测试对象：`packages/forge-policy` P1 交付 + `packages/forge-devops`、`packages/forge-gitee` 的 `callId` 透传
- 结论：**可验收**。P0/P1/P2 缺陷 0；1 条 P3 加固观察；未完成项均为环境受限的实机核验（见 §6）

## 1. 范围与环境

| 项 | 事实 |
|---|---|
| 分支 / HEAD | `main` @ `8c68d41`（P0 骨架），工作区 34 项未提交改动（本交付 + 任务夹） |
| 运行时 | pinned Node **24.21.0**（`.node-version`）；本机默认 `node` v24.13.0 仅用于单包测试 |
| 平台 | macOS（host sandbox），无浏览器（沙箱限制，非交付缺陷） |
| 交付面 | 3 新模块 `confirm.mjs`/`delegation.mjs`/`reuse.mjs`；改 `gate.mjs`/`audit.mjs`/`config.mjs`/`installer.mjs`/`prompts.mjs`/`index.mjs` + `package.json` exports；跨包 callId 4 处；6 新测试 + 7 既有测试扩展；4 份文档同步 |

## 2. 用例与结果（全部实际执行）

| # | 检查 | 命令（仓库根） | 结果 |
|---|---|---|---|
| E1 | 全量门禁（AC-19） | `PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH pnpm check` | **exit 0**：tests 4409 / pass 4406 / fail 0 / cancelled 0 / skipped 3（3 skip 为既有环境门控） |
| E2 | policy 单包（AC-1~17 用例面） | `cd packages/forge-policy && node --test` | exit 0：**315/315 pass**，0 fail，0 skip |
| E3 | 主路径 E2E 探针（独立于单测） | `node logs/teamflow/tf-mwo9owz2-ov2any/scripts/qa-r20-mainpath.mjs` | exit 0：**26/26 checks pass** |
| E4 | 接口一致性（0a/0a2） | `node logs/teamflow/tf-mwo9owz2-ov2any/scripts/qa-r20-interface.mjs` | exit 0：**21/21 checks pass** |
| E5 | 空白/产物门禁 | `git diff --check` | exit 0 |
| E6 | 提交面卫生（0c） | `git status --porcelain --untracked-files=all` | 34 项；`node_modules/`、`dist/`、`*.tgz`、`logs/`、`.env` **0 命中**（`.gitignore:85` 覆盖 `logs/`） |
| E7 | 无新增依赖（AC-19） | `git diff -- packages/forge-policy/package.json` | 仅 `./confirm`/`./delegation`/`./reuse` 三个 exports，**依赖 0 变更** |
| E8 | 文档口径（AC-18） | `grep -rn "八开关全部可用\|所有受控写都会弹卡" README.md packages docs --include=*.md \| grep -v docs/teamflow` | 0 命中；README/DETAIL/设计文档均为「三开关已实现、其余五个装载期报错 / 只 push 与 DOP 弹卡 / 120000 ms / 32 条 LRU」 |

### 2.1 E3 主路径探针覆盖（host 事件面 `tools/pre-execute → guard → 操作体 → tools/post-execute` 真实顺序驱动）

| 组 | 断言要点 | 结果 |
|---|---|---|
| A 主路径 | ask 恰 1 次、执行恰 1 次、审计 `asked→answered→begin→settle`、卡片固定标签对、身份每次重读 | 4/4 |
| B 复用 | 同 callId+同参不再 ask 且只留 1 条 `reused-decision`；改参重新弹卡；teardown 清缓存并摘挂事件面 | 3/3 |
| C 拒绝/超时/无通道/畸形应答 | 执行 0 次；`DENIED/TIMEOUT/UNAVAILABLE/INVALID_ANSWER` 语义文案互不冒充（超时不含「取消本次写入」） | 4/4 |
| D 来源与身份 | 子代理规则开 → `deny-delegated-writes`；规则关 → `confirm-delegated-refused` 且 ask 0；无 IAM → 拒绝且审计 0 条；admission→guard 间换身份被 guard 拦下并撤缓存；执行后换身份 → `identity-changed` 失败 | 5/5 |
| E 范围 | 未登记工具直通 0 卡 0 审计；**6 动作 × 4 开关组合 24 格**：仅 `gitee.git.push`×confirmPush、`change.clarification.write`×confirmDopWrite 弹卡 | 2/2 |
| F 泄漏 | 六类失败文案 + 审计 summary 9 类正则（绝对路径/盘符/UNC/URI/令牌/errno/spawn/退出码/堆栈）零命中；恶意卡片目标被「目标（已隐藏）」替换 | 3/3 |
| G 配置门禁 | 5 个未实现开关置 true → 装载期报 `rules.<key>` 不挂载；`timeoutMs` 0/1.5 → 装载期报错 | 2/2 |
| H/ I 边界 | LRU 32 条、touch 刷新、第 33 条淘汰最久；八开关全关与 P0 等价（`begin/settle`、`registered-write`、0 卡） | 2/2 |

### 2.2 E4 接口一致性（0a）关键结论

- `index.mjs` 再导出与 TECHNICAL §5.7 逐项一致（多导出 `agentKindOf`/`CONFIRM_REASONS` 属超集，无缺口）。
- `gate.mjs` 调用的成员全部存在：`confirmations.ask`、`decisionCache.peek/set/touch/delete`、`audit.begin/settle/record/sinks/isDegraded`。
- `createGate({...})` 的 10 个实参键全部在 gate 解构签名内，无未知键；`ask({ctx,agent,action,questions,timeoutMs})` 与网关签名一致，`agent` 传的是带 session 的 `exec.agent`。
- 跨包：devops `changeUpdate` 形参含 `callId` 且保留 `devops-write-<seq>` 兜底；gitee push 透传 `exec.callId`，guard 保留合成兜底。
- installer 装配网关/缓存，并按 `confirmations.dispose() → decisionCache.clear() → gate.dispose()` 逆序卸载。

### 2.3 架构检查（0 号要求，轻量）

- 蓝图一致性：3 个待抽取模块按 TECHNICAL §5 抽成独立文件（`confirm/delegation/reuse`），依赖方向 `confirm → delegation/prompts`、`gate → confirm/delegation/reuse`、`installer → gate + confirm + reuse`，**无环、无反向依赖**。
- 单一真源：`rule='reused-decision'`、`deny-delegated-writes`、`confirm-delegated-refused` 仅在 `gate.mjs` 出现；`userQuestions` 只在 `confirm/installer`；`origin === 'subagent'` 只在 `delegation.mjs`。**未发现重复实现**（无第二套脱敏、无第二套 LRU、无第二套子代理判定）。
- 唯一放行点：`admit/admitOnce` 保持唯一准入，`preExecute/guard/executeAction` 三入口共用；无旁路实现。
- 未抽取/结构破坏：无。跨轴 import 仅出现在 `confirm → prompts`（渲染文案），符合蓝图。

## 3. 缺陷表

| 编号 | 严重级 | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| D-1 | P3 | forge-policy / 审计 | 以路径形 target（形如 `<工作区>/secret-repo`）发起 `gitee.git.push` 并允许，查 `phase=begin` 收据 | 成功路径 summary 与卡片同口径，路径定位被隐藏或 summary 不复述 target（target 字段本身已记录业务目标） | `begin.summary` 原文拼入 `（目标 <工作区>/secret-repo）`，绕过 `prompts.sanitizeLocator`；不影响六类失败面（AC-17 已过） | AC-11 的「绝对路径 0 出现」在成功收据上的加固面（非 AC-17 六类失败面） | `node logs/teamflow/tf-mwo9owz2-ov2any/scripts/qa-r20-mainpath.mjs`（F4 断言原始路径存在） | F4 改为断言 `sanitizeLocator(target)` 结果（路径形 target 显示为隐藏占位），探针仍 26/26 通过 |

**P0/P1/P2 缺陷：未发现。**

> 观察（不计缺陷）：首次 `pnpm check`（pinned 24.21.0，负载下）出现 1 例 cancelled —— `packages/forge-iam/test/model-transport-sqlite.test.mjs:430` 10s 超时；该包未被本交付改动，单跑 17/17 pass 3.4s。第二次全量 **exit 0 / 0 cancelled**，与 dev 证据一致，判定为负载偶发；记录以供 CI 抖动排查。

## 4. 验收项映射（PRD AC-1~21）

| AC | 证据 | 判定 |
|---|---|---|
| AC-1/2 判定链、身份常开 | E3-A/D3、E2 | 通过 |
| AC-3/4 子代理拒绝与规则关闭语义 | E3-D1/D2、E2（delegation 用例） | 通过 |
| AC-5 弹卡范围 | E3-E2（24 格矩阵） | 通过 |
| AC-6/7 卡片内容、应答 fail-closed | E3-A3/F1/F3、E2（`confirmation-card.test.mjs` 8 种畸形输入） | 通过 |
| AC-8/9 超时与通道异常 | E3-C2/C3/C4、E2（`confirmation-channel.test.mjs` 宿主错误码映射） | 通过 |
| AC-10 六码唯一 | E3-C1/C2/C3/C4/D1 + E2（`confirmation-audit.test.mjs:201` ERROR 路径） | 通过 |
| AC-11/17/18 审计与失败面、文档口径 | E3-A2/F2、E8 | 通过（D-1 为成功收据加固观察） |
| AC-12/13/14 复用、LRU、越界 | E3-B1/B2/H1、E2（`decision-reuse`/`identity-recheck`） | 通过 |
| AC-15 恰好一次 | E3-A1、E2（`execution-audit.test.mjs:119` 并发准入） | 通过 |
| AC-16 三态与依赖缺失 | E3-G1/G2/D2、E2（`config.test.mjs` 三态） | 通过 |
| AC-19 工程门禁 | E1/E5/E7 | 通过（本地；远端 CI 未跑） |
| AC-20 独立 PR | 工作区未提交、未建 PR | **NOT RUN**（人工） |
| AC-21 隔离 profile 实机 | 无桌面会话与隔离 profile | **NOT RUN**（人工） |

## 5. 人工补测清单（环境限制，非交付缺陷）

| # | 项 | 验收标准 | 方法 / 工具 |
|---|---|---|---|
| M1 | 隔离 profile 实机安装/卸载 + 桌面端真实卡片 | 装后 `confirmationAvailable=true`；推送弹 1 张卡、固定标签；120s 无应答自动取消且不写 | 隔离 `dsh --profile` + DSH 桌面端 |
| M2 | 历史普通 fork（无 `session.header.origin`）来源判定 | 按 PRD 假设当主会话处理（不误拒、不弹给子代理）；需产品确认边界 | 桌面端父子会话实测 |
| M3 | Windows / 麒麟 aarch64 | 路径形 target、host 错误码、计时器行为与本地一致 | 双端实机 |
| M4 | 远端 CI | pinned Node 24.21.0 下全绿；i-M 超时抖动是否复现 | GitHub Actions |

## 6. 结论

- 功能面：AC-1~19 的离线/静态/集成证据齐备，主路径、拒绝、超时、子代理、复用、范围矩阵、泄漏扫描全部实测通过；**P0/P1/P2 = 0**。
- 工程面：全量 `pnpm check` exit 0、`git diff --check` 干净、无新增依赖、提交面 0 产物、文档口径无禁用表述。
- 架构面：模块抽取与蓝图一致，无重复实现与旁路；接口 21 项全部真实存在且调用形状匹配。
- 遗留：D-1（P3 加固观察，不阻塞）；AC-20/21 与 M1~M4 为实机/人工项，标 **NOT RUN**。
- **判定：可验收**（需用户在实机项上终验）。
