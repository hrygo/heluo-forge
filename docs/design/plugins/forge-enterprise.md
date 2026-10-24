# 企业组合包详细设计

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | CORP-DSH-DESIGN-004 |
| 文档名称 | 企业组合包详细设计 |
| 版本 | V1.3.2 |
| 文档状态 | 草案 |
| 密级 | — |
| 编制 | DSH 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-24 |
| 门禁 | G2 |
| 模块状态 | 可用（组合骨架：官方行默认禁用 + 按需技能/条款装配；企业接入待开通） |

> 编制依据：2026-10-20 依据 DSH 组合层公开语义核验——补丁层叠加在包入口列表之上；`insert` 追加行，带 `id` 的补丁覆盖既有行且 `config` 整体替换、不深合并；`group: true` 配 `name: cordis:group` 使 `config` 成为可再插入的嵌套列表；`cordis:include` 载入外部 YAML 或 JSON 入口列表；`disabled` 接受布尔、null 或按挂载时机求值的 `!!js` 表达式；`!!js` 仅在 `config` 内按插件上下文求值；`isolate` 按服务名划分实例域。2026-10-21 用户确认采用 O3「企业 IAM 独占登录」，官方登录在企业内网不可用；本包据此默认禁用官方账号、官方模型、官方 API Key 与官方账户 UI 行。**未核验**：`engines` 版本断言在挂载期的具体报错形态、`fiberPhase` 的取值集合、禁用四行后 shell/onboarding 是否完整。
>
> 关联文档：[总体架构](../../architecture/platform-architecture.md)、[设计索引](../README.md)、[IAM 接入](forge-iam.md)、[策略与审计](forge-policy.md)、[双模式凭据](../credential-modes.md)。

## 1. 结论

本包不写业务逻辑，只回答一个问题：企业版由哪些能力、以什么顺序、在什么前提下一起出现。

边界：它组合 `@heluo/forge-*` 与上游插件，不实现其中任何一个；它决定默认值与禁用项，不决定策略内容与契约字段。

O3 的组成之一是**默认禁用官方账号、官方模型、官方 API Key 与官方账户 UI 四行**，使企业 IAM 成为唯一登录。官方登录在企业内网不可用，保留它只会制造一个坏掉的入口，并留下公网模型旁路。

还缺四件事才能进实现：版本断言的报错形态实测、角色 preset 的粒度确认、禁用四行后 shell/onboarding 的实测、默认禁用清单的业务确认。

### 1.1 专用访问目标的组合约束

2026-10-23 需求方已确认[需求基线 §4.6](../../requirements/requirements-baseline.md#46-模型访问身份与专用凭证要求)。组合包只挂载经过核验的个人认证路线（A 纯令牌 / B Key＋令牌待选），不能因模型插件能解析 Key 就跳过人员、用途或生命周期要求。关键依赖不满足则停止相应企业调用，不自动切换到裸 Key 或应用 Agent 凭证。

IAM 接入与模型接入分别核验网关目标授权、双凭据承载（若 B）、轻量 DSH 标识及当前授权退出。本包不管理应用凭证、IP 或审批，相关操作在网关控制台。配置示意不代表本轮能力已实现；选路及契约冻结后再调整真实配置。本轮不改 bundle 或源码。

## 2. 目标与非目标

**目标**

- 一处声明企业版包含的全部能力，避免用户自行拼装。
- 企业版只保留企业 IAM 登录与企业模型路由；官方登录、官方模型、官方 API Key 与官方账户 UI 默认禁用。
- 安全依赖（身份、策略）缺失时整体拒绝挂载，而不是静默降级。
- 每项能力可单独禁用，禁用后果写在包里而不是靠口头约定。
- 支持按角色下发差异化 preset，不复制多套安装包。

**非目标**

- 不实现身份、策略、网关接入等成员能力。
- 不接管配置分发与更新通道（见市场与分发）。
- 不替代组织级策略，只提供默认值。

## 3. 需求与依赖

| 需求/验收 | 关系 | 说明 |
|---|---|---|
| REQ-01 / A1、A14 | 支撑 | 企业 IAM 独占登录；未登录时企业模型不可用 |
| REQ-17 / A12 | 支撑 | 安全依赖缺失时拒绝企业调用，不保留原权限 |
| REQ-14 / A9 | 支撑 | 企业包只从企业源安装，不保留公网入口 |

| 依赖 | 类型 | 版本约束 | 缺失时的行为 |
|---|---|---|---|
| `@heluo/forge-iam` | 包 | 同批次版本 | 拒绝挂载，报明确错误 |
| `@heluo/forge-policy` | 包 | 同批次版本 | 拒绝挂载；**不提供只读降级**，策略缺失即企业入口关闭 |
| `@heluo/forge-gateway` | 包 | 同批次版本 | 允许挂载，模型能力不可用并提示 |
| `dsh-credentials` | 上游包 | 随目标 DSH | 拒绝挂载 |
| `dsh-deepseek-account-platform`、`dsh-llm-deepseek-account`、`dsh-llm-deepseek-api-key`、`dsh-client-ui-settings-account` | 上游包 | 随目标 DSH | 作为默认禁用目标；目标缺失时警告并跳过，不能当作已禁用 |

## 4. 扩展形态与边界

| 项 | 内容 |
|---|---|
| 形态 | 配置 bundle：`cordis.patch.yml` + 若干 preset |
| 运行位置 | 本机 Host（与profile 组合层同处） |
| 目标 DSH 与 SDK | `0.2.1-rc.2`；组合语义按上文核验项 |
| 使用的 seam 或服务 | 补丁层、`cordis:group`、`cordis:include`、`disabled`、`isolate` |
| 不修改的核心 | 组合层实现、成员包的内部逻辑 |

取舍：用一个包加开关，而不是每角色一个包。理由是补丁层的 `disabled` 已能表达差异，多包会让"企业版到底包含什么"出现多个副本。

## 5. 接口与配置

| 配置项 | 类型 | 默认值 | 必填 | 说明 |
|---|---|---|---|---|
| `enterprise.profile` | `full` \| `pilot` | `full` | 否 | 试点档默认关闭市场与 SDD |
| `enterprise.disable` | string[] | `[]` | 否 | 能力标识列表，映射到 `disabled: true` |
| `enterprise.rolePreset` | string | 空 | 否 | 角色 preset 名，决定默认禁用集 |

策略是硬依赖：没有 `policyRequired` 一类开关，也不存在"关闭策略后仅允许只读"的档位。策略未挂载或不可用时，依赖它的动作入口保持关闭且无可调用残留。

```yaml title="组合顺序（示意；§5.1.2 为当前实际挂载）"
insert:
  - id: enterprise-credentials
    name: '@heluo/forge-credentials-keychain'   # 已实现，§5.1.2 已挂
  - id: enterprise-policy
    name: '@heluo/forge-policy'                  # 已实现，§5.1.2 已挂
  - id: enterprise-iam
    name: '@heluo/forge-iam'                     # 已实现，§5.1.2 已挂
  - id: enterprise-sdd
    name: '@heluo/forge-sdd'                     # 已实现，§5.1.2 已挂
  - id: enterprise-gateway
    name: '@heluo/forge-gateway'                 # 仅 README，不预建入口
  - id: enterprise-tools
    name: cordis:group
    group: true
    config:
      - id: enterprise-devops
        name: '@heluo/forge-devops'              # 仅 README，不预建入口
      - id: enterprise-gitee
        name: '@heluo/forge-gitee'               # 仅 README，不预建入口
# 市场不插入插件行：目标形态是 DSH 原生索引源 + AIHUB 托管 format-1 索引，
# `@heluo/forge-market` 为历史参考（ADR-11／13）。企业索引源按原生索引源配置，
# 键名以目标版本核验为准；试点档关闭市场走原生配置，不靠禁用本包某一行。
```

### 5.1 官方行默认禁用

O3 要求企业 IAM 是唯一登录，因此本包在补丁层默认关闭以下行；企业包用独立的 `insert:` 行挂载（§5.1.2），不复用被禁用的官方行 id，也不覆盖成员的 `config`：

```yaml title="默认禁用官方登录/模型（示意）"
- id: deepseek-account
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: llm-deepseek
  disabled: true
- id: ui-settings-account
  disabled: true
```

- `id` 以目标 profile 实际行为准；desktop 与 web 可能不同，G0 各核验一次。
- 目标不存在时 Loader 会警告并跳过；跳过不等于已禁用，必须由 `@heluo/forge-iam` 的独占断言兜底。
- 禁用官方 UI 后，onboarding、侧栏入口、默认模型由 IAM 包接管；本包不复制这些 UI。
- 升级 DSH 后重新应用补丁，并跑“官方行是否回灌”用例：检测器见 `packages/forge-enterprise/src/reflow.mjs`（判定依据是**实际生效配置**，不是“补丁文件还在不在”）。

配置字段以本设计为准；网关字段仍见[网关契约](../../contracts/gateway-contract.md)。

#### 5.1.1 禁用实验（本机实测 2026-10-24）

补丁层落在 [packages/forge-enterprise/cordis.patch.yml](../../../packages/forge-enterprise/cordis.patch.yml)：禁用四个官方行，并挂载四个已实现的企业包（`insert:` 段见 §5.1.2）；指向未实现包的入口仍不预建。

| 步骤 | 命令 | 结果 |
|---|---|---|
| 组合树核对（web） | `dsh --profile web --dump-config` | 四行都在：`deepseek-account`、`llm-deepseek`（`dsh-llm-deepseek-api-key`）、`llm-deepseek-account`、`ui-settings-account`（`dsh-client-ui-settings-account`） |
| 组合树核对（sdk） | `dsh --profile sdk --dump-config` | 只有前三行；无 `ui-settings-account` |
| 应用禁用层 | `dsh --profile web --patch <补丁> --dump-config` | 与基线逐行 diff：四行各多出 `disabled: true`，并带 `patched by <补丁>` 标记 |
| 命中不到的行 | `dsh --profile sdk --patch <补丁> --dump-config` | `dsh: [<补丁>] patch: entry "ui-settings-account" not found`，跳过且**不算已禁用** |
| 自动化对照 | `node scripts/probe/run-host-probe.mjs` | 报告 `composition` 段逐行给出"已落地 / 警告已出现"；去掉补丁层（`DSH_HOST_PROBE_DISABLE_OFFICIAL=0`）时该段整体 FAIL 且退出码 1（负向对照） |
| 升级回灌 | `--dump-config` 文本喂给 `detectOfficialRowReflow()` | 未应用补丁时认出启用中的官方行（`deepseek-account, llm-deepseek-account, llm-deepseek`）→ 报回灌；应用后回灌 0 行、缺席 `ui-settings-account` 单独记录（跳过 ≠ 已禁用）。驱动段：`probe: 回灌检测 ok`。**真实 DSH 升级后的重新应用未验** |

#### 5.1.2 `insert:` 最小挂载（本机实测 2026-10-24）

`insert:` 段挂四个已实现且有清单的包：`@heluo/forge-credentials-keychain`、`@heluo/forge-policy`、`@heluo/forge-iam`、`@heluo/forge-sdd`。历史市场包 `@heluo/forge-market` 按 AC5 不挂；网关、DevOps、Gitee、品牌四包仍只有 README，不预建入口。

本机实测（DSH `0.2.1-rc.2`，临时 `DSH_HOME`，profile 由 `--from-default-profile web` 建出，四个包以本地目录放进该 profile 的 `node_modules/@heluo/`）：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 挂载行出现 | `dsh --profile compose --patch <补丁> --dump-config` | dump 末尾出现四行：`heluo-credentials-keychain` / `heluo-policy` / `heluo-iam` / `heluo-sdd`，`name` 与包清单一致 |
| 官方行仍禁用 | 同上 | 四行均为 `disabled: true`（`deepseek-account` 的 `disabled` 在其 `config` 之后） |
| 确定性 | 同上跑两次 `cmp` | 两次输出逐字节相同 |
| 警告 | 同上 stderr | web 模板下**无** `patch: entry ... not found`；headless 模板下会出现 `entry "ui-settings-account" not found`（该行只存在于 web/desktop 组合） |

**边界**：这是**配置组合（dump）级**证据——四行确实进了组合树，但"插件实例化成功、服务可用"没有验证：本机没有企业 IAM 端点，`forge-policy` 需要动作目录、keychain 在无 OS 后端时按设计 fail closed。`insert` 本身的行为（行进入组合树）已由远端任务 `20261024T131000Z-linux-offline-bundle` 在 Linux aarch64 / Node 24 上以独立探针单独验证。

**未验**：`desktop` profile 本机不存在同名 profile，其行 id 未核验；运行时"官方模型不可选、`DEEPSEEK_API_KEY` 不构成旁路"需要接了官方模型行的 desktop/web 运行时——探针 profile 的 LLM 提供方在禁用前后都是 0 个（基线对照同样为 0），因此该项在探针里以 `blocked` 记录，不用"0 个提供方"冒充已证明；当前正在使用的 GUI profile 未用补丁重启（会打断会话）。**禁用实验失败即暂停 O3**，不 patch 内核。

### 5.2 按需企业 Skill 与规范条款加载

企业入口负责**装配**按需技能与规范条款，不重复实现成员包逻辑，也不把全部条款一次性注入上下文。宿主技能服务（`ctx.skills`）已核验：注册进去的是"只读运行时技能"，`list()` 只给调用无关的摘要，正文由 `get(name)` 按需加载。

| 规则 | 要求 |
|---|---|
| 发现与描述 | 技能必须给出准确的 `name` / `description` / `whenToUse`；描述与正文一致，不用空泛标题占位 |
| 用户入口 | 企业技能默认 `modelInvocable: false`、`userInvocable: true`：只有用户显式触发才承接，模型不能自动冒用企业流程入口 |
| 加载不写 | 加载只读资源与正文，不产生写动作，也不在加载时创建 Issue、分支或提交 |
| 条款适用性 | 条款索引标明适用系统与版本区间；两个系统/规范版本合成任务时**只加载适用条款**，其余按原因归档（版本不符、已过期、系统不符） |
| 硬要求与建议 | `level: hard \| advice` 分开呈现；硬要求必须在该动作被执行前可见 |
| 冲突与过期 | 过期条款移出选择集并指向维护者；同一主题的活跃硬条款冲突时**同时呈现双方与各自责任人**，不允许模型自行废止其一 |
| 上下文预算 | 不重复全量注入；每次选择都要给出条款数、正文字节数与估算 token，并受预算上限约束，超限即拒绝整体注入而不是静默截断 |
| 加载记录 | 记录本次加载了哪些条款、来自哪个版本、跳过哪些及原因，供追溯 |
| 自证边界 | 加载器只报告条款与引用，不做"合规通过"结论；确定性要求引用 [S01 (#27)](forge-sdd.md) 的交付清单与 CI 校验，不由模型自报合规 |
| 不做的事 | 不规定规划/编码/修复方法，不按阶段自动建 Issue |

## 6. 权限、凭据与数据

| 项 | 处理方式 | 生命周期 | 失败时 |
|---|---|---|---|
| 身份与令牌 | 由 IAM 包持有，本包不读写 | 随会话 | 拒绝挂载 |
| 策略配置 | 只读引入，不覆盖用户策略 | 随包版本 | 拒绝挂载 |
| 本包配置 | 用户级，不含敏感值 | 随profile | 回退默认值 |
| 组合日志 | 记录了哪些行、哪些被禁用 | 本机日志 | 不影响挂载 |

## 7. 流程

```mermaid
flowchart TD
  A[读取企业配置] --> B{身份与策略在位}
  B -->|否| C[拒绝挂载并报错]
  B -->|是| D[禁用官方账号/模型/API Key 行]
  D --> E{目标行存在且已禁用?}
  E -->|否| F[记录独占冲突, 不标记企业能力可用]
  E -->|是| G[按顺序插入成员行]
  G --> H{版本断言通过}
  H -->|否| C
  H -->|是| I[应用角色禁用集]
  I --> J[挂载完成]
```

**独占断言**：官方行被跳过或禁用失败时，`@heluo/forge-iam` 启动检查 `ctx.get('deepseekAccount')`，不进入 `ready`、不写企业令牌，并记录 `exclusive-violation`。组合层与 IAM 包各自兜底，避免“补丁没生效但看起来登录了”。

**并发**：挂载只发生一次，无共享状态；重复挂载请求按幂等处理。

**超时**：成员初始化超时视为挂载失败，不做部分挂载。

**禁用与退出**：整体禁用回到无企业能力状态，必须在包说明中写明后果，禁止用"可禁用"掩盖策略缺失。

## 8. 失败模式

| 场景 | 行为 | 用户可见结果 | 是否可重试 |
|---|---|---|---|
| 身份包缺失 | 拒绝挂载 | 明确提示缺少身份能力 | 修后重试 |
| 策略包缺失 | 拒绝挂载或转只读 | 提示策略不可用 | 修后重试 |
| 版本不匹配 | 拒绝挂载 | 列出期望与实际的版本 | 升级后重试 |
| 某能力行插错位置 | 启动失败 | 指出冲突行 id | 修正补丁 |
| 官方行缺失/禁用被跳过 | 记录独占冲突，不标记企业能力可用 | 提示企业组合不完整 | 修正 row id 后重试 |
| 禁用官方 UI 后 shell/onboarding 缺失 | 暂停 O3，提交组合层替代方案评审 | 指出缺失能力 | 评审后重试；不改内核 |
| 升级后官方行回灌 | 重新应用禁用并告警（`detectOfficialRowReflow()` 给出逐行结论） | 提示企业组合被恢复 | 重启/修正补丁 |
| 配置字段被整体替换 | 覆盖后行为异常 | 指出被替换的配置键 | 修正后重试 |

最后一行是本组合层最容易踩的坑：`config` 不深合并，覆盖时必须重述全部字段。

## 9. 可观测性

| 事件 | 字段 | 去向 | 保留 |
|---|---|---|---|
| 挂载完成 | 档位、启用行、禁用行、版本 | 本机日志 | 30 天 |
| 拒绝挂载 | 缺失依赖、断言失败项 | 本机日志 | 30 天 |
| 配置覆盖 | 被覆盖的 id 与键 | 本机日志 | 30 天 |

## 5.3 组合与包体闭包（E01 / #37）

组合补丁只声明行与配置，不写业务逻辑；包体要能在构建内闭合。五类开关**分别控制**，写默认禁用：

| 开关 | 控制 | 默认 |
|---|---|---|
| 只读 | 只读查询与审查入口 | 关（随策略挂载后按目录开放） |
| 普通研发写 | 分支/文件等常规写动作 | **禁用** |
| AI 发布 | 自动发布类动作 | **禁用** |
| 人工 review | 需人工确认的放行 | **禁用**（分类批准前不生效） |
| 观察 | 指标/投影类出口 | 关（可独立降级） |

主/子 Agent 与 scoped 工具的角色差异由补丁层的 `disabled` 与配置表达，不用多个包复制"企业版包含什么"；可见性不等于服务端授权。

**五类开关的声明与判定（`packages/forge-enterprise/src/switches.mjs`，2026-10-24）**：本模块只做声明与判定，不写业务逻辑、不注册任何东西。判定顺序固定：① `policy` 未就绪 → 五类全 `blocked`；② 企业身份（`iam`）未就绪 → 五类全 `blocked`；③ 必要审计未就绪 → 四类动作 `blocked`（**不降级为无审计只读**），`observe` 因无出口为 `off`；④ `human-review` 在 C3 分类未批准前一律 `blocked`；⑤ 能力行不存在 → `blocked`（不预建虚构入口）；⑥ 未被组织批准 → `off`；⑦ 角色 preset 只收窄（`observer`/`reviewer`/`developer`/`publisher`/`approver`），角色**不能**把未批准的能力打开。返回项带 `serverAuthorization: 'required'`，明确"入口可见 ≠ 服务端授权"。

**实测（两次独立来源）**：

| 证据 | 结果 |
|---|---|
| 离线用例 `packages/forge-enterprise/test/switches.test.mjs`（8 项） | 空输入全 `blocked`；policy/iam/audit 缺失各自的全关与"无审计只读"否定；能力缺失 `blocked`；C3 未批准 review 关闭；**逐类开关关闭时其余四类状态不变**；角色只收窄且不能放大 |
| 宿主探针 `combination-switches-fail-closed-on-measured-host`（`dsh 0.2.1-rc.2`，profile `sdk`） | 把实测事实（policy 由同一次探针的 guard/pre 行为断言证明就绪；`ctx.get('iam')` 不存在；审计落点为 `memory` + `allowNonDurable` 的开发落点，按未就绪计）喂入判定 → **`on` 为空**，全部 `blocked`/`off`；另附合成输入验证"全就绪即全开"与"关一类不影响其他类"（合成部分不代表企业能力就绪） |
| 宿主探针 `行级独立性`（`--dump-config` 对照） | 补丁命中 3 行、自行新增 2 行；**被意外改动的既有行为 0**——行级禁用是独立机制，不牵连其他行 |

`ai-publish` 与 `human-review` 目前没有对应业务行（DevOps/Gitee 发布与人工 review 未落地），因此实测结论是 `blocked`；这不是缺陷，而是"不预建虚构入口"的应有状态。

**包体闭包规则**（由 `scripts/lib/bundle-rules.mjs` 接入 `checkRepo`，2026-10-24 起生效）：

| 规则 | 目的 |
|---|---|
| 名称＝`@heluo/forge-*` 且与目录同名 | 一个包一个身份，避免副本 |
| `engines.dsh` 必须具体、不得为 `*` | AC1 的版本不兼容拒绝有声明依据 |
| 不得声明 install 期构建脚本（`prepare`/`install`/`postinstall`/`preinstall`） | AC4「不现场编译」 |
| 不得依赖 DSH 内核 `@deepseek-ai/dsh` | AC4「不补未批 runtime 依赖」、不 fork |
| `files` 非空、相对、存在 | AC4「tarball 含全部入口」 |
| `main`/`bin`/`exports` 目标存在（支持 `*` 通配只看目录） | 入口不悬空 |
| `@heluo/*` 依赖必须 `workspace:` 且能解析到本仓库包 | AC4「workspace 依赖构建内闭合」 |
| 不得跨包导入源码路径（`@heluo/forge-*/src/` 或 `../…/forge-*/src/`） | AGENTS.md §4 |
| 有 `cordis.patch.yml` 就必须列入 `files` 且声明 `dsh.bundle.patch` | AC4「patch 随包发行」 |
| `insert:` 的 `name` 必须是本仓库已有包 | AC4/AC5「不预建虚构入口」 |
| 除历史市场包自身外，任何补丁不得挂 `@heluo/forge-market` | AC5「不挂历史市场」 |
| 有 `locale/en.json` 就必须同时有 `zh.json` 且 `locale` 随包发行 | AC4「en/zh 说明」 |

**真实 tarball 核验**（`scripts/check-bundle-tarballs.mjs`，对每个有清单的包跑 `npm pack --dry-run --json`，只看实际打出来的文件与模式位）：声明的 `files` 条目必须真的进包；`package.json`/`README.md`/`main`/`exports`/`bin` 目标必须在包内；`bin` 目标必须带执行位；`locale/en.json` 与 `zh.json` 必须成对；`test/`、`coverage/`、`*.test.mjs`、`pnpm-lock.yaml` 不得混进包体。用 npm 而非 pnpm 是因为 CI 只装 Node：`.github/workflows/check.yml` 不安装 pnpm，而 pack 的文件选择与模式位正是 npm 的实现语义。

**本机实测（2026-10-24，本仓库工作副本）**：规则接入后立即发现三个真实缺陷——① `@heluo/forge-enterprise` 的补丁层既未列入 `files`、也未声明 `dsh.bundle.patch`，即**包体不会带上禁用四行的补丁**；② 同包 `files` 缺少 `cordis.patch.yml` 的发行声明；③ `@heluo/forge-sdd` 的 `bin` 目标 `src/cli.mjs` 在仓库与 tarball 中都是 `644`（安装后 shim 无法执行）。三项已修复：`files` 增加补丁、新增 `dsh.bundle.patch`、`chmod +x src/cli.mjs`（`git` 记录 `100755`，`npm pack` 实测模式位由 `644` 变 `755`）。证据：`node scripts/check-repo.mjs`（修复前 2 项 + 修复后 1 项 → `repo: ok`）、`node scripts/check-bundle-tarballs.mjs`（6 个包、64 个文件 → `bundles: ok`）。

**官方行回灌检测（#13 AC8，`src/reflow.mjs`，2026-10-24）**：判定输入是实际生效配置里的行状态（`rowsFromDump()` 解析 `dsh --dump-config`），输出 `reflowed`（仍启用 = 回灌）、`absent`（profile 里不存在，Loader 警告跳过，**跳过 ≠ 已禁用**）、`disabled`；状态无法解析时按回灌处理（宁可当启用）。`requireAll` 可选把缺席行也判失败。

| 证据 | 结果 |
|---|---|
| 离线用例 `packages/forge-enterprise/test/reflow.test.mjs`（7 项） | 四行全禁用 → 通过；重新启用 → 逐行报回灌并单列缺席；状态未知按回灌；无关行不影响；非法输入报错而非默默通过；dump 解析只认行级（2 空格缩进）的 `disabled:` 字段与 `#` 注释边界；行 `config:` 内嵌套的 `disabled: true` **不算**该行被禁用（2026-10-24 独立审查发现此处会伪造 `ok:true`，已收紧并加回归用例） |
| 宿主探针（`dsh 0.2.1-rc.2`，profile `sdk`） | 基线 dump（= 升级后未重新应用补丁的形态）：认出 3 行启用 → 报回灌；打补丁后：回灌 0 行、缺席 1 行。驱动段 `probe: 回灌检测 ok`，探针 28/28 通过、2 blocked |

**组合层序与整体替换实测（#37 AC1，2026-10-24，远程 MacBook，公有 DSH `0.2.1-rc.2`，profile `probe-custom`）**：同一行 id 在四层写不同值时，优先级从低到高是**组合包 patch → profile 级 `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → 启动参数 `--patch`（多个按参数顺序）**，后层覆盖前层，dump 用 `patched by …` 注释保留来源链且无覆盖警告。`config` 是**整个对象替换、不是按字段深合并**：profile 层一旦写 `config`，组合包里该行的其余字段在最终配置中不再存在。`--dump-default-config` 与 `--patch` 互斥（`error: --dump-default-config prints the bundle layers and takes no --patch`）。

`dsh --profile <name> --from-default-profile <模板> --dump-config` 的**整体替换**语义（无需启动应用）：模板的四个文件逐字节恢复、profile 的 `cordis.patch.yml` 重建为模板空补丁、自定义普通文件与子目录被删除；若 profile 里已装插件，整体替换会一并删除 `node_modules/`、`pnpm-lock.yaml` 与 `.plugin-manager/`，只剩模板文件。**恢复边界是 profile**：home 级覆盖不会被这条命令删除，仍继续生效。

模板里确实存在角色/权限配置（`agent-preset-registry.config.default`、`preset-standard/ptc/minimal/cordis` 及其 persona、`permission.config.presets` 三档）：profile 内对它们的修改会被整体替换重置；普通依赖安装不改动它们（安装器给"plain dependency, not a profile layer"警告），声明 `dsh.bundle.patch` 的角色/权限补丁包会改动它们，卸载后整份 dump 回到模板。这是 agent/persona/permission preset 层面的实证，**不等于**企业 IAM 角色/RBAC。

**未验**：角色 preset 粒度（§12）、`desktop` profile 行 id（CLI 被 Electron 独占，已实测 `profile "desktop" is managed exclusively by the Electron application`）。真实 DSH 升级动作与 `dsh plugin` 的 profile 级安装/卸载路径已由真机安装实测覆盖，见 §11。

## 10. 测试矩阵

| 层级 | 覆盖 | 命令 |
|---|---|---|
| 单元 | 禁用集映射、顺序、版本断言 | `node --test` |
| 契约 | 补丁字段符合组合语义 | 契约用例 |
| 集成 | 缺身份/缺策略/版本不符三种拒绝 | 本地夹具 |
| 组合 | 禁用四行后 shell/settings/onboarding/模型选择可用；官方入口不可见；`DEEPSEEK_API_KEY` 不构成旁路；升级回灌 | 组合夹具 |
| 端到端 | 双端各完成一次挂载、官方入口不可见与整体禁用 | 手工 + 脚本 |

## 11. 打包、升级与回退

包名 `@heluo/forge-enterprise`，`private: true`，声明 `engines.dsh` 与成员包的同批次版本。产物只有补丁文件与 preset，不含运行时代码。

升级：整包升级，成员版本必须同批次；不允许单包漂移。

回退：保留上一版补丁即可回到旧组合；禁用项与用户配置不回退，避免丢失用户选择。

**安装语义实测（2026-10-24，DSH `0.2.1-rc.2`，darwin-arm64，node v26.11.1，profile `sdk`）**：`scripts/probe/run-bundle-install-rehearsal.mjs` 全程只在临时目录内做真实 tarball 的装/升/退/卸，10/10 步通过。

| 步骤 | 结果 |
|---|---|
| 前置 | `dsh --version` = `0.2.1-rc.2`；两个包都不声明任何 install 期生命周期脚本 |
| 打包安装 | `npm pack` → 装进临时项目；装到的版本与清单一致，`cordis.patch.yml` 随包在装好的位置可用 |
| 组合（用**装好的**补丁层） | 无补丁时四条官方行都不是 `disabled`；套上装好的补丁后 `deepseek-account`、`llm-deepseek-account`、`llm-deepseek` 三条为 `disabled: true`；`ui-settings-account` 在 `sdk` profile **不存在**，按 `--patch` 语义跳过（跳过 ≠ 已禁用，与 §5.1.1 一致） |
| 可执行入口 | 装好的 `.bin/forge-sdd` 能启动并以文档化的退出码 2 打印用法；目标文件模式位 `755` |
| 升级 | 升到 `0.1.1` 后组合结论不变、用户文件未被改动 |
| 回退 | 退回 `0.1.0` 后组合结论不变、用户文件未被改动 |
| 卸载 | 两个包目录与 `.bin` 软链都被移除，用户文件未被改动 |
| 工作区保护 | 演练前后 `git status --porcelain` 完全一致（按快照对比，不要求仓库本来就干净） |

**无自动重放**：全程 `npm` 带 `--ignore-scripts`，两个包也没有可执行的安装期脚本；卸载后不保留任何自动重建动作。演练不接触任何真实 profile。

**真机安装 / 升级 / 回退实测（#37 AC1/AC6，2026-10-24，远程 MacBook `Darwin arm64` / macOS 26.5.1 / 16 GB，任务级隔离）**：委派远端 Codex（Codex CLI `0.164.0`）在任务目录内装 Node `24.21.0`（`SHASUMS256.txt` 校验）与**公有 npm 包** `@deepseek-ai/dsh@0.2.1-rc.2`，把六个真实 tarball 装进任务本地 `web` profile；全程 `DSH_HOME`/`HOME`/`XDG_*` 指向任务目录，本机复核未写 `~/.dsh`（远端 `~/.dsh` 仍不存在、无全局 dsh、共享 pnpm store mtime 未变）。

| 阶段 | 命令要点 | 实测结果 |
|---|---|---|
| 清装基线 | `dsh --profile web --dump-config` | 四条官方行都未禁用；无我们的行 |
| 安装 | `dsh plugin --profile web add ./artifacts/tarballs/<pkg>-0.1.0.tgz` ×6 | 首次 **exit 127**：`dsh plugin` 把参数**转发给 profile 目录里的 pnpm**，缺 pnpm 即失败；任务内装 `pnpm@11.28.5` 后六次均 exit 0 |
| 组合落地 | 安装后 dump + 重复 dump | 四条官方行 `disabled: true`，重复 dump **无回灌**；`@heluo/forge-market` 的补丁层插入 `forge-market` 行；**其余四包（policy/iam/sdd/credentials-keychain）只是普通依赖、不进配置树**（只有声明 `dsh.bundle.patch` 的包才注册补丁层）——**安装 ≠ 挂载** |
| 版本不兼容 | `add` 一个 `engines.dsh: >=99.0.0` 的对照包 | rc.2 与 rc.3 都 **exit 1** 拒绝；安装器随后恢复清单、锁文件与原六包内容 |
| 升级 | `npm install --prefix runtime/dsh @deepseek-ai/dsh@0.2.1-rc.3 --save-exact` → `dsh --version` = `0.2.1-rc.3` | 组合差异**只有上游新增一行** `entry-customization`；四条禁用自己的行 id 仍匹配、补丁继续生效、重复 dump 无回灌 |
| 回退 | 同前缀装回 `0.2.1-rc.2` | 六包与四条禁用状态都保留（版本回退不动 profile 组合） |
| 卸载 | `dsh plugin --profile web remove @heluo/forge-enterprise`，再 remove 其余五包（**按包名**） | 卸企业包后四条官方行**恢复默认**；再卸五包后 `forge-market` 行消失；最终 dump 与清装基线一致 |
| 卸载参数 | `remove <包名>` 不接受安装专用参数（`--offline --ignore-scripts` → pnpm `Unknown options`，exit 1），且**必须沿用安装时的 store**（否则 `ERR_PNPM_UNEXPECTED_STORE`，exit 1） | 第二个真机任务实测；这些失败不作为卸载成功证据 |
| 残留核查 | 前后快照逐文件对比 | 组合恢复（`package.json` 只少一个空 `dependencies: {}`，profile 的 `cordis.patch.yml` 逐字节一致）；**仍留下** `pnpm-lock.yaml`、`state.json`、`.plugin-manager/logs/*/pnpm.log` 及两处 pnpm 元数据哈希变化——**不能声称无残留回滚**，与"不宣称原子升级/自动回滚"一致 |

复跑入口：远端任务目录（任务 ID `20261024T023419Z-dsh-install-c8c2`）里的 `artifacts/command-index.md`、`artifacts/config-summary.md` 与编号证据（每条命令留 argv / 清洁环境 / 退出码 / 原始输出）。本轮**未验**：在真实模型环境下禁用四行后 shell/onboarding 是否完整（§12）、角色 preset 粒度、`desktop` profile。

## 12. 未决事项

| 问题 | 需要谁回答 | 影响 |
|---|---|---|
| 挂载期版本断言的报错形态 | 平台组（实测） | 第 8 节失败语义 |
| `fiberPhase` 的取值与用途 | 平台组（实测） | 观测字段 |
| 角色 preset 的粒度（按职能还是按部门） | 平台组、PMO | 第 5 节 `rolePreset` |
| 官方四行 row id 在 desktop/web 的一致性 | 平台组（实测） | 第 5.1 节禁用补丁 |
| 禁用四行后 shell/onboarding 是否完整 | 平台组（实测） | O3 是否可在不修改核心的前提下成立 |
| 若禁用破坏 shell，是否接受最小核心补丁 | 用户、平台组 | 与“不 fork”非目标冲突 |
| 默认禁用清单是否还有未识别的官方旁路 | 安全、平台组 | 第 5.1 节默认值 |
| 旧官方 grant 与旧默认模型的迁移/清理 | 平台组、安全 | 升级体验与残留身份 |
| 试点档是否禁用市场 | 平台组、IT | `profile` 语义 |

### 需用户确认的设计选项（增益不明确，暂不采用，保留待定）

| 选项 | 可能的增益 | 代价 | 当前处理 |
|---|---|---|---|
| 每个角色一个独立 bundle | 安装即正确 | 组合副本增多，版本对齐成本上升 | 不采用，单一包加 `rolePreset` |
| 把私有市场配置写进本包 | 少一次配置 | 市场策略与市场包耦合 | 不采用，留在市场包 |
| 内置成员包版本自检脚本 | 升级期早发现问题 | 与 `engines` 断言重复 | 不采用 |
| 提供图形化组合编辑器 | 降低维护门槛 | 组合层已声明式，收益不确定 | 不采用 |
| 把策略内容也放进本包 | 一处配置 | 与策略包职责重叠，审计边界模糊 | 不采用 |

以上五项都不影响主链路；若后续确认增益，再单独评估并更新本设计。