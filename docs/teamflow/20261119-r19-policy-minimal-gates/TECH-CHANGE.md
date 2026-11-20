# 技术变更单 · 受控写最小门禁 P0 骨架（CORP-DSH-PLAN-024）

> 编号：r19（run tf-mwniu67u-8knnv1）｜类型：技术驱动返工（仅 P0 阶段，单一独立 PR）
> 基线依赖：docs/plans/2026-11-19-policy-minimal-gates.md（CORP-DSH-PLAN-024，a0e2485 已合入 main）+ ADR-29（docs/architecture/platform-architecture.md:521）
> 契约与范围：本单是开发/QA/验收的唯一契约，不改写历史任务夹的 PRD/TECHNICAL/AC、不新增用户可见验收项（§4 只记录技术性行为变化）；只做 P0——P1 安全基线（userQuestions 卡片）、P2 内容闸、P3 收尾另开独立 PR，本 PR 不预置其代码路径。

## 1. 背景与目标

把 `@heluo/forge-policy` 从「默认拦截 + approval 确认」改造为「默认全关、逐条启用」的最小门禁骨架：P0 只落地配置模型、装载期校验、常开审计与 0–10 判定流水线骨架，并一次删净 approval/scope/委派/外发四个旧模块与组合包的 permission 覆写。

- 八开关全关时，受控写只多一条审计记录，判定结果与「没有这些规则」一致，不新增任何拦截。
- 目录只登记 6 条写动作；读动作不入目录，走 out-of-scope 放行（D22）。
- 任何未实现规则的开启在装载期 fail-closed 报键名，杜绝「开了却没效果」；`pnpm check` 全绿，单一独立 PR，可直接 revert。

## 2. 影响范围

| 动作 | 路径 | 说明 |
|---|---|---|
| 新增 | `packages/forge-policy/src/config.mjs`、`src/pipeline.mjs`、`test/{config,pipeline,audit-file}.test.mjs` | 六层校验、0–10 骨架、file sink 用例 |
| 修改 | `packages/forge-policy/src/installer.mjs` | 装配、observe-only 告警、审计 sink 选择；移除 4 模块与 approval 装配 |
| 修改 | `packages/forge-policy/src/catalog.mjs` | 条目字段收敛为 `action/target/category`，只收写动作，删 `enabled/revision/...` |
| 修改 | `packages/forge-policy/src/gate.mjs` | 收缩为宿主适配器：保留 `check/executeAction/postExecute/guard`，删 scope/确认/approval/egress 分支 |
| 修改 | `packages/forge-policy/src/audit.mjs` | memory 环形 1000；file sink 按天轮转保留 7 天；写失败中止本次调用 |
| 修改 | `packages/forge-policy/src/content-rules.mjs`、`src/iam-consumer.mjs` | `digestContent` 移入 content-rules（D76）并改引用 |
| 修改 | `packages/forge-policy/src/{prompts,index}.mjs`、`package.json` | 删 `approvalDisplayReason` 与 approval 文案；导出面与 `exports` 收敛 |
| 删除 | `src/{confirmations,delegation,egress,scope-ticket}.mjs` 及同名 4 个测试文件 | D85 一次删净，无兼容别名、无 deprecated 转发 |
| 修改 | `packages/forge-policy/test/{apply,catalog,command,gate-path,execution-*,package-shape}.test.mjs` | 适配新 API；包体闭包随删除收缩，不放宽类别 |
| 修改 | `packages/forge-devops/src/{index,policy-guard}.mjs`、`packages/forge-gitee/src/index.mjs` | 读动作挂载/准入不再要求目录登记与 `enabled`（D22：读=out-of-scope 放行） |
| 修改 | `packages/forge-devops/test/{policy-guard,policy-binding,patch-mount,tools,delivery-selfcheck}.test.mjs`、`packages/forge-gitee/test/{patch-mount,coexistence,actions,entry,git}.test.mjs` | 旧「未登记只读动作即拒挂载」断言按 D22 改为反向断言并注明被取代事实 |
| 修改 | `scripts/probe/host-probe-plugin.mjs` | 删除 `delegation.mjs` 探针段，避免悬空 import |
| 修改 | `packages/{forge-devops,forge-gitee,forge-enterprise,forge-engineering}/cordis.patch.yml` | catalog 12→6 写、去 `enabled`；audit 去 `allowNonDurable`；不写 `rules` |
| 修改 | `tests/plugin-patch-layers.test.mjs` | 6 条逐字一致；新增「补丁层零 permission」反向断言（G2） |
| 修改 | `docs/teamflow/memory.md` | 同主题行替换（目录/审计/确认/权限/开关口径） |

## 3. 技术方案要点

### 3.1 配置模型与装载期校验

```yaml
catalog:  # 6 条，字段仅 action/target/category
  - { action: 'gitee.issue.write',          target: 'issue',         category: 'dev-write' }
  - { action: 'gitee.pr.write',             target: 'pr',            category: 'dev-write' }
  - { action: 'gitee.review.publish',       target: 'review',        category: 'review-write' }
  - { action: 'change.clarification.write', target: 'clarification', category: 'dev-write' }
  - { action: 'gitee.git.push',             target: 'git',           category: 'remote-write' }
  - { action: 'gitee.review.record',        target: 'review',        category: 'human-record' }
rules:            # 八个开关全默认 false，代码内禁止任何 true 默认
  denyDelegatedWrites: false   # 1 子代理
  denyUnknownAction: false     # 3 未知动作
  denyHumanRecord: false       # 4 人工记录
  protectPaths: false          # 5 路径
  enforceProcessRules: false   # 6 流程
  contentGate: false           # 7 内容
  confirmPush: false           # 8 确认（push）
  confirmDopWrite: false       # 8 确认（dop 写）
confirmation: { timeoutMs: 120000 }
content: { maxBytes: 262144 }
paths: { append: [] }
audit: { sink: 'memory', buffer: 1000, keepDays: 7 }
```

- `catalog` 与 `classify.mjs` 的写动作一一对应：`target` 等于内置 target，`category` 等于内置写类（dev-write/review-write/remote-write/human-record）；重复 action、读动作入目录、未知字段一律拒绝。
- 校验一次性完成并定位键路径（如 `catalog[3].category`、`rules.confirmPush`）：catalog 形状/动作/重复/分类不符；rules 未知键或非布尔；`confirmation.timeoutMs`、`content.maxBytes`、`audit.buffer`、`audit.keepDays` 非正整数；`audit.sink ∉ {memory,file}`；`paths.append` 非字符串数组。任一失败 → 拒绝挂载并列全部错误，不静默降级。
- 八开关在 P0 均无实现：任一为 `true` 按「该规则尚未在本阶段可用」拒绝启用并报键名（fail-closed；P1–P3 逐个放开）。
- 八开关全关 → 装载成功后输出一条 observe-only 告警（只读诊断，不拦截、不写盘）。顶层未知键仍拒绝（沿用现状）；`tools/categories/observation/env/onDecision/protectedPaths` 暂保留受理（见 §7-3）。

### 3.2 审计（恒开）

- 与规则开关解耦：`begin` 先落、执行后 `finish` 补 `durationMs`/`decision`；memory sink 用进程内环形缓冲 `audit.buffer`（默认 1000，超出覆盖最旧）。
- file sink：`$DSH_HOME/logs/forge-policy-<YYYY-MM-DD>.jsonl`，一天一文件、UTF-8 JSONL 追加；启动与每次写入前按 `keepDays` 清理同前缀过期文件；目录缺失则创建。
- 写失败（权限/磁盘/路径不可写）：中止本次受控调用，返回可操作建议（sink 类型、脱敏后的目标形态、检查项）；用户可见文案不出现「审计」二字；不静默落回 memory。
- 字段按计划 §4.4：`subject/action/target/tool/decision/rule/operationId/observedAt/durationMs/phase/agent.kind/actor/summary/params/contentDigest/truncated`；`params`/`contentDigest` 只存摘要不落原文。

### 3.3 判定流水线骨架

| 阶段 | 规则 | P0 行为 |
|---|---|---|
| 0 动作解析 | — | 由 catalog 判定是否受控；未登记 → out-of-scope 放行且不写审计（D23） |
| 1 子代理 | `denyDelegatedWrites` | 无实现，置 true 装载拒绝 |
| 2 身份 | 恒开（非开关） | 写动作取 `ctx.get('iam')` 视图，解析不出 actor 即拒（D16/D18，不可关） |
| 3–7 | `denyUnknownAction`/`denyHumanRecord`/`protectPaths`/`enforceProcessRules`/`contentGate` | 均无实现，置 true 装载拒绝；`paths.append` 仅校验保存 |
| 8 确认 | `confirmPush`/`confirmDopWrite` | 无实现；P1 才接 `ctx.userQuestions`，P0 不调用 approval |
| 9–10 审计/收据 | 恒开 | 一次受控调用恰好一条审计；保留一次性收据与执行后复验（复验失败按失败处理） |

- 关闭的规则在装配期不生成阶段（不是进入后 `return allow`），不产生额外审计；`decision/rule` 反映实际生效项；多规则命中按阶段顺序短路，reason 合并口径沿用现有 gate 实现。

### 3.4 删除与撤回

- 四个旧模块及其导出、用例、探针段一次删净；`grep -rn "approval" packages/forge-policy/src` 零命中（文案层同步）。
- permission 覆写：当前 main 四层补丁均无 `permission` 键（PR #363 已关闭未合入）、tests 也无 D-6 门禁，故 P0 落为反向断言——任一补丁层出现 `permission`/`sandbox` 键即测试失败，并删除历史 D-6 残留（如有）。
- 不改 DSH 本体与私有 API；不新增第三方依赖；不做环境变量覆盖；不动已关闭的 PR #363 与 PR #372 的文档。

## 4. 行为兼容性影响（用户可见）

- 有变化且属有意撤销：全关默认下不再有内容/流程/路径/确认四类拦截；`gitee.git.push` 不再弹宿主 approval 卡片（旧通道删除，P0 内无替代，P1 接 userQuestions）。
- 不变量与口径：受控写仍须解析出 IAM actor（解析不出即拒）；未登记动作直接放行；每次受控动作恰好一条审计且恒开。「全关与现状等价」指与「未启用这些规则」等价（只多一条审计），不是与 r18 默认拦截逐字等价；验收按本单口径，不回写历史 PRD 的 AC。
- 只读面：devops/gitee 不再因只读动作未登记而拒绝挂载。

## 5. 回归与验证计划

- 全量（仓库根）：`pnpm check`（link-workspace + check:docs + check:repo + check:skills + check-bundle-tarballs + check:version + `node --test --test-timeout=120000`）；`git diff --check`；`git status --short` 不得出现 dist/tgz/logs。
- 定向：`node --test packages/forge-policy/test/`；`node --test packages/forge-devops/test/`；`node --test packages/forge-gitee/test/`；`node --test tests/plugin-patch-layers.test.mjs`。
- 契约断言：forge-policy/src 内 approval 调用点 0；四个补丁层无 `permission`/`sandbox` 键、catalog 6 条逐字一致且无 `enabled`；src 零新增 `child_process`/`spawn`（唯一 execFile 出口不变）。
- 回归地板：删除随实现消失的 4 个用例文件与旧「只读动作必须登记」断言（逐条注明被取代事实）；除此之外用例只增不减、0 skip；新增用例覆盖六层校验正反向、全关单条告警、关闭阶段不注册且单条审计、file sink 轮转/保留/写失败中止。不得以放宽断言换绿。
- 不做的验证：真实确认卡片与端到端交互（P1）、企业环境真实 IAM 联调，标 NOT RUN。

## 6. 风险与回滚

- 风险1：全关默认放行，部署者忘记开启 → observe-only 告警 + 文档明确「默认全关」；不引入隐式默认拦截。
- 风险2：file sink 写失败会阻断受控写 → 有意 fail-closed；文案给可操作建议，避免「写了但没记」。
- 风险3：读动作出目录后，依赖「目录登记」判断可用性的第三方消费方失配 → 本 PR 同步改造仓库内两个消费方并在 memory 记录口径。
- 回滚：单一独立 PR，revert 即回滚；无数据迁移、无配置升级步骤；`$DSH_HOME/logs` 下审计文件可保留。
## 7. 假设与待澄清

1. 「与现状等价」按「不新增拦截、审计恒开」口径（§4）；若要求与 r18 默认拦截逐字等价，P0 不能撤下内容/流程/确认默认值，范围需重审。
2. P0 无实现的开关置 `true` 选「装载期拒绝」（fail-closed）；若改为「接受但记录未实现」，则「开了却没效果」的风险转由部署方承担。
3. 既有键 `tools/categories/observation/env/onDecision/protectedPaths` 在 P0 暂保留受理；若一并收敛为未知键，需同步迁移 devops/gitee 用法与用例。
4. 模块边界选新增 `config.mjs` + `pipeline.mjs`；若并入 installer/gate，行为不变，仅评审粒度不同。
5. `paths.append` 与九类敏感文件判定归 P3；若 P0 即需生效，需追加 paths 判定实现与用例。
6. main 上四层补丁本无 permission 覆写、无 D-6 门禁，P0 以反向断言固化；若 #363 后续重新合入，本断言会先失败并在 PR 内删覆写。
