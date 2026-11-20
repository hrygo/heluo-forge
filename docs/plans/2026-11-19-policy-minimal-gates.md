# 受控写最小门禁与确认通道重构实施计划

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-PLAN-024 |
| 文档名称 | 受控写最小门禁与确认通道重构实施计划 |
| 版本 | V0.1.0 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-11-19 |
| 门禁 | 设计已逐节裁决；代码未改、未提交，实机验收待做 |

> 编制依据：2026-11-19 与项目负责人逐节评审形成的裁决台账（D1–D85），以及隔离 DSH `0.2.1-rc.5` 上的确认卡片探针结果。当前只有源码核验与隔离实测，**没有**企业桌面实机结果，也不代表生产可用。
>
> 关联文档：[策略与审计设计](<../design/plugins/forge-policy.md>)、[策略判定模型](<../design/policy-model.md>)、[确认通道检查清单](<../operations/approval-channel-checklist.md>)、[DSH 插件高阶规范](<../engineering/dsh-plugin-conventions.md>)。

## 1. 背景与问题

企业 Gitee / DevOps 写动作依赖宿主人工确认。当会话审批策略为 `never` 时，`@deepseek-ai/dsh-user-approval` 的 `decide()` 在分发到应答端之前直接返回 `rejected`，确认卡片永远不会出现；"完全权限"预设恰好把 approval 固定为 `never`，于是所有受控写的确认请求都被静默拒绝。

2026-11-18 曾以"组合包覆写宿主 `permission` 表"修正（PR #363），评审结论为整表覆写会压过用户显式选择的只读与无人值守策略，判为需要收敛；该 PR 已关闭。

本计划改用宿主 `userQuestions` 服务作为确认通道：它与 approval 策略解耦，在 `danger-full-access` + `never` 会话里仍能把卡片送到用户；沙箱模式与会话审批策略交回 DSH 原生入口，组合包不再覆写。同时把既有门禁收敛为**默认全关、逐条启用**的最小规则集，凡 DSH 已能覆盖的判定不再重复实现。

## 2. 目标与验收口径

| 编号 | 目标 | 验收口径 |
|---|---|---|
| G1 | 需要确认的动作，确认必定到达用户 | 交互式会话中每次 `gitee.git.push`、`change.clarification.write` 都产生卡片；`danger-full-access` + `never` 会话同样产生。不含非交互场景 |
| G2 | 沙箱与会话审批交回原生 | 组合包补丁层无 `permission` 条目；`--dump-config` 中该行来自宿主默认 |
| G3 | 默认不拦截 | 代码默认七个开关全关、企业 bundle 不预置；装载时输出 observe-only 告警 |
| G4 | 每条规则独立开关、独立测试、独立回退 | 一个开关 = 一条配置 + 至少一条用例 + 可单独回退的提交 |
| G5 | 审计永远开启、可追溯 | 每次受控判定有审计记录；`sink: file` 重启后可用 `/policy-audit` 查询 |

非目标：不接管沙箱/命令执行/工具挂载；不做第二套权限档位与确认 UI；不在子代理内弹卡；不承诺内容正则发现全部凭据；不实现组织策略分发（`org-policy` 停用保留）。

## 3. 裁决台账

### 3.1 目标与原则

| 编号 | 决定 |
|---|---|
| D9 | 背景只记 PR #363 的事实，不复述评审措辞 |
| D10 | 代码默认全关，企业 bundle 也不预置，部署者显式开启 |
| D11 | G1 验收不含非交互场景 |
| D12 | 增加 G5「审计永远开启、可追溯」 |
| D13 | `org-policy` 停用保留代码，不接 |
| D14 | 彻底删除对 `approval` 的全部调用（含 `requestApproval` 与相关文案） |
| D15 | 每个开关必须有「DSH 为何覆盖不了」的准入说明，写不出来不许加 |
| D16 | 身份校验不设开关、永远开启（写动作） |
| D17 | 审计写入失败 → 中止本次调用 + 醒目告警 + 可操作建议，不暴露"审计"字样 |
| D18 | 写动作必须解析出已认证身份（IAM actor），解析不出来即拒；读动作不查 |
| D19 | 审计失败文案不能用通用报错敷衍，要给下一步动作 |

### 3.2 判定流水线与动作目录

| 编号 | 决定 |
|---|---|
| D20 | 身份解析放第 1 步 |
| D21 | 受控动作 = catalog 登记才算，未登记一律 out-of-scope 直接放行 |
| D22 | 读动作不登记 catalog |
| D23 | out-of-scope 不写审计 |
| D24 | 多规则命中收集全部原因、合并返回 |
| D25 | 内容软命中与 push 确认同时成立时用分步（第一步/第二步）提问，合并提交 |
| D26 | 保留执行后复验（同一 exec 未变、一次性收据） |
| D27 | 已受理过的重试不再弹卡，直接复用上次用户选择 |
| D28 | 身份不缓存，每次查 |
| D29 | `change.clarification.write` 只被 DOP `change update` 使用，不需要新增 `dop.change.update` |
| D30 | 目录字段只留 `action`/`target`/`category`/`rules`；最终 6 条写动作：`gitee.issue.write`、`gitee.pr.write`、`gitee.review.publish`、`change.clarification.write`（弹卡）、`gitee.git.push`（弹卡）、`gitee.review.record`；6 条读动作删出目录 |
| D31 | 内容扫描按动作声明 `contentFields`，全局白名单兜底 |

### 3.3 开关与确认通道

| 编号 | 决定 |
|---|---|
| D33 | 七个开关：`denyUnknownAction`、`denyHumanRecord`、`protectPaths`、`enforceProcessRules`、`contentGate`、`confirmPush`、`confirmDopWrite`（全部默认 false）；子代理发起受控写恒拒（D42），不设开关 |
| D34 | `protectPaths` 默认 9 类敏感文件，不允许缩减、只能追加 |
| D35 | 推荐配置模板放包 README，不生效 |
| D36 | `contentGate` 开、确认开关关时软命中放行 + 审计；有卡片通道才升级为分步确认 |
| D37 | 热更依赖 DSH 插件重载，卸载时取消挂起确认，插件内不做 watch |
| D38 | 卡片只显示目标与定位信息（repo/branch/changeId），不显示正文 |
| D39 | 多张卡可并存，各自独立超时与记账 |
| D40 | 全局默认 120s（`confirmation.timeoutMs`），不做按动作配置 |
| D41 | `asked` 与 `answered` 各记一条审计 |
| D42 | 子代理发起的受控写一律拒绝，不弹卡 |

### 3.4 内容闸

| 编号 | 决定 |
|---|---|
| D43 | 删除 H5 口令赋值规则（误报太高） |
| D44 | H3 带凭据连接串、H4 常见令牌改为可确认后放行；H1 私钥块、H2 云长期密钥不可确认 |
| D45 | S5 只匹配文本里的 `.env` 文件路径引用 |
| D46 | 删除 `BUILTIN-FORCE-PUSH` |
| D47 | 字段映射：issue.write→title/body；pr.write→title/body；review.publish→body/comment；clarification.write→summary/description/aiAc；git.push→commits[].message+diff；review.record→无 |
| D48 | 内容读不到 → 放行 + 审计告警 |
| D49 | v1 不做自定义规则 |
| D50 | 超 256 KiB 只扫前 256 KiB、标 `truncated`、按结果判定、放行并记"未完整扫描" |
| D51 | H3/H4 可确认，但无卡片通道时拒绝 |
| D86 | Gitee 推送正文在公共 CLI 出口按类别脱敏（`token`、`credential-url`）；读取层把类别交给内容闸映射回 `BUILTIN-TOKEN`/`BUILTIN-CREDENTIAL-URL`，可确认命中照常进分步卡；无法分类的脱敏才记 `字段:原因`（如 `commits[0]:redaction-unknown`）后放行。`contentSkipped` 与 `truncated` 在 asked/answered/begin 三处保持一致 |
| D87 | 正文与最终执行绑定：普通对象正文在 `recheck` 与宿主同步 `guard` 都按同一摘要复验，确认或下游等待期间被改写即拒绝并零执行 |
| D88 | 正文扫描器自身抛错时按不可确认拒绝（`POLICY_CONTENT_SCAN_FAILED`）：异常不等价于"没有命中"，不得因扫描失败而放行 H1/H2 |
| D89 | 正文读不到时（`content:unreadable`）不查也不写决策复用缓存：占位摘要无法区分不同正文，复用会让重试绕过重新确认；其余结论复用规则不变 |

### 3.5 审计与子代理

| 编号 | 决定 |
|---|---|
| D52 | `agent.kind`（root/child）单列；审计加人类可读 `summary` 与脱敏定位信息 |
| D53 | 加 `sink: file` → `$DSH_HOME/logs/forge-policy-<date>.jsonl`，按天轮转、保留 7 天 |
| D54 | 内存环形缓冲 1000 条 |
| D55 | 失败文案指出具体文件路径与检查项 |
| D56 | 提供 `/policy-audit [N]` 只读命令 |
| D57 | 参数摘要保留定位字段；正文只进 digest；路径保留目录、文件名后 4 位打码 |
| D58 | 身份失败单一文案，带动作名，指向「设置 → 账号」 |
| D60 | 不对子代理单独查身份（子代理继承父代理身份） |
| D61 | 子代理拒绝文案：受控写必须在主会话发起，子代理无法获得人工确认 |
| D62 | 审计 `summary` 体现"子代理发起" |

### 3.6 配置、边界与删改

| 编号 | 决定 |
|---|---|
| D63–D68 | 保留 `rules` 层；`confirmation` 独立一层；校验失败插件不启用并报具体键；bundle 补丁层完全不写 `rules`；模板放包 README；不做环境变量覆盖 |
| D69 | DSH 边界表作固定章节，新增规则前必须过这张表 |
| D70 | 不写"已知失效场景"专章 |
| D71–D73 | `observe` 保留不参与判定；`forge-gateway` 不动；不新增"不是安全边界"专门声明 |
| D74 | `classify` 与 `catalog` 不合并 |
| D75 | 新增 `decisions.mjs`（决策复用） |
| D76 | `digestContent` 移入 `content-rules.mjs` |
| D77 | 删文件后同步更新 `package-shape.test.mjs`，不放宽包体闭包 |
| D78 | PR #363 关闭，新实现另开 PR |

### 3.7 测试与阶段

| 编号 | 决定 |
|---|---|
| D79 | 不设覆盖率门禁，用变异用例替代 |
| D80 | 实机验收由负责人亲自跑，不作硬性交付条件 |
| D81 | 性能预算：单次判定 p95 < 10 ms，file sink 写盘 < 5 ms，超标只记录 |
| D82 | 不加审计快照测试 |
| D83 | 阶段顺序 P0 骨架 → P1 安全基线 → P2 内容闸 → P3 收尾 |
| D84 | 每阶段一个 PR |
| D85 | P0 一次删干净（`confirmations.mjs`/`delegation.mjs`/`egress.mjs`/`scope-ticket.mjs`） |

## 4. 设计要点

### 4.1 判定流水线

```
0  动作解析：工具名 → action；未登记 → out-of-scope（denyUnknownAction 开则拒，否则放行）
1  子代理（开关开）→ 拒绝，不弹卡
2  身份解析（仅主代理的写动作）→ 失败即拒
3  denyUnknownAction：未在分类表出现 → 拒
4  denyHumanRecord：category === human-record → 拒
5  protectPaths：命中保护路径 → 拒
6  enforceProcessRules：流程规则不满足 → 拒
7  contentGate：hard → 拒；soft → 记待确认
8  确认判定：confirmPush（`gitee.git.push`）/ confirmDopWrite（`change.clarification.write`）/ 内容软命中 → 弹卡；多条原因合并为同一请求
9  审计 begin（失败 → 中止并给出可操作建议）
10 一次性收据 + 执行后复验
```

关闭的规则不经过对应代码路径，只留一条 `allow / rule: disabled` 审计；七个全关时装载输出 observe-only 告警。

### 4.2 配置模型

```yaml
catalog:            # 6 条写动作，字段 action/target/category/rules
  - { action: 'gitee.git.push', target: 'repository', category: 'remote-write', rules: [] }
rules:              # 七个布尔开关，默认全 false
  denyUnknownAction: false
  denyHumanRecord: false
  protectPaths: false
  enforceProcessRules: false
  contentGate: false
  confirmPush: false
  confirmDopWrite: false
confirmation:
  timeoutMs: 120000
content:
  maxBytes: 262144
paths:
  append: []
audit:
  sink: memory        # memory | file
  buffer: 1000
  keepDays: 7
```

未知键、类型错误、取值越界 → 插件不启用并报出具体键；bundle 补丁层不写 `rules`。

### 4.3 确认卡片

一次 `userQuestions.ask` 携带一条或多条 question：内容软命中与动作确认同时成立时，第一条为动作确认、第二条为内容风险确认，客户端按"下一步/提交"分步呈现，提交时合并结果。判定只认 `selected` 恰为允许标签且不含拒绝标签；拒绝、超时、无应答端、子代理调用一律视为拒绝，并给出可读原因。

### 4.4 审计记录

字段：`subject`、`action`、`target`、`tool`、`decision`、`rule`、`operationId`、`observedAt`、`durationMs`、`phase`、`agent.kind`、`actor`、`summary`、`params`、`contentDigest`、`truncated`。正文、参数原文、令牌与路径文件名不进记录（路径保留目录，文件名后 4 位打码）。

## 5. 分阶段实施

| 阶段 | 交付 | 验收 | PR |
|---|---|---|---|
| P0 骨架 | 配置模型、八开关（全关）、observe-only 告警、审计（memory/file/轮转）、流水线骨架、删除四个模块、撤回组合包 `permission` 覆写与 D-6 门禁 | 全关时行为与现状等价；`check:docs`/`check:repo`/包测试通过 | 独立 PR |
| P1 安全基线 | 身份校验（永远开）、子代理写拒绝、卡片通道（`confirmPush`/`confirmDopWrite`）、决策复用 | 隔离 profile 实测：`never` 会话弹卡、允许后执行、拒绝后零写入 | 独立 PR |
| P2 内容闸 | 9 条规则、两步卡片、截断语义、`contentFields` 映射 | 每条规则正反例；改写 push 场景 | 独立 PR |
| P3 收尾 | `protectPaths`、`enforceProcessRules`、`denyHumanRecord`、`denyUnknownAction`、`/policy-audit`、文档同步 | 八开关全开时全量用例；文档与注册表一致 | 独立 PR |

## 6. 测试计划

| 层 | 内容 | 位置 |
|---|---|---|
| 单元 | 每开关三态（关/开/依赖缺失）；9 条内容规则正反例；决策复用与 LRU；审计摘要与 file sink 轮转；配置校验 | `packages/forge-policy/test/` |
| 组合 | 四个补丁层 catalog 逐字一致、`permission` 条目已撤回、`composeEntries` 仿真无告警 | `tests/plugin-patch-layers.test.mjs` |
| 契约 | 卡片请求/应答结构、错误码、`/policy-audit` 输出 | 单元级，假 `userQuestions` |
| 实机 | 桌面端弹卡、允许执行、拒绝零写入、审计落盘 | 隔离 profile 手工，不进 CI |

判据：每条规则配一条会失败的反向用例；覆盖率为替代品，不设百分比门禁。

## 7. 与 DSH 的边界（不做清单）

1. 不接管沙箱与命令执行；
2. 不接管工具挂载与 `disabled` 判定；
3. 不实现第二套权限档位；
4. 不实现确认 UI（复用 `ui-user-questions`）；
5. 不在子代理内弹卡；
6. 不判断工作区之外的路径（沙箱已覆盖）；
7. 不对读动作做判定；
8. 不做组织策略分发与签名信封；
9. 不做 revision 一致性机制；
10. 不做自动重试与自动降级；
11. 不做跨会话授权；
12. 不承诺内容正则的完备性；
13. 不修改 DSH 本体。

## 8. 风险与未决

| 风险 | 影响 | 处理 |
|---|---|---|
| 内容读不到或超限时放行 | 可能夹带敏感内容 | 已裁决接受，审计留痕（D48/D50） |
| 无客户端（headless）时确认动作必拒 | 无人值守不可用 | 设计意图 |
| 文件 sink 写盘失败 | 操作中止 | 文案给路径与检查项（D55） |
| 每次写动作查 IAM | 延迟 | 不缓存，按 D81 记录 |
| 企业桌面未实机 | 交互可能不符预期 | 负责人手工验收（D80） |

未决（实现前先核）：

| 编号 | 未决 | 核对方式 |
|---|---|---|
| U1 | 子代理身份继承 | **已核（2026-11-19）**：子代理拥有自己的 session（`childSessionMeta.parentSession` 指向父 session），但门禁的身份取自插件上下文的 IAM 视图（`ctx.get('iam').getView()`），与会话无关，因此 D60 成立；P1 仍需补一条单测锚定 |
| U2 | 企业侧 `user-questions` API 与本机是否一致 | **已核（2026-11-19）**：企业侧同为 `0.2.1-rc.5`，无版本差异，无需 diff |
| U3 | `$DSH_HOME/logs` 可写性 | 实现时探测 + 失败文案 |
| U4 | 多问分步卡片在企业桌面的表现 | 负责人手工验收 |
| U5 | 审计 `summary` 的中文措辞 | 落地时给一版，负责人确认 |

## 9. 文档同步清单

| 文档 | 处置 |
|---|---|
| [策略与审计设计](<../design/plugins/forge-policy.md>) | 大改，版本升 V2.0.0（语义破坏性变更） |
| [策略判定模型](<../design/policy-model.md>) | 同步改判定流、动作目录、确认通道 |
| [企业账号与模型组合包设计](<../design/plugins/forge-enterprise.md>) | 撤回 `permission` 覆写章节，同步 §6/§10 |
| [研发工具套件设计](<../design/plugins/forge-engineering.md>) | 删除研发层覆写段落 |
| [确认通道检查清单](<../operations/approval-channel-checklist.md>) | 改为确认卡片路径，保留 approval 排查作为历史 |
| [工程工具契约](<../contracts/engineering-tools.md>) | 动作目录 12 → 6 写，澄清写入需确认 |
| `packages/forge-policy/README.md` | 大改 + 推荐配置模板 |
| `packages/forge-{gitee,devops,enterprise,engineering}/README.md` | 动作目录与确认语义同步 |
| [逐模块设计索引](<../design/README.md>) | 实现与验证入口更新 |
| [文档清单](<../DOCUMENT-REGISTER.md>) | 各行版本同步 |

## 10. 实施状态

| 阶段 | 状态 | 落地 |
|---|---|---|
| P0 骨架 | 已合并 | PR #400（`60e5cf6`） |
| P1 安全基线 | 已合并 | PR #401（`09e4bdb`） |
| P2 内容闸 | 已实现，待评审 | 9 条内置规则、按动作字段映射、跨字段 256 KiB 预算、截断与读不到语义、HARD/可确认/SOFT 三档与分步卡片合并 |
| P3 收尾 | 未开始 | `protectPaths`、`enforceProcessRules`、`denyHumanRecord`、`denyUnknownAction`、`/policy-audit`、文档同步 |

草案已按裁决台账完成。U1（子代理继承父会话身份）已核对；U2（企业侧 `user-questions` API）仍待企业环境核验。
