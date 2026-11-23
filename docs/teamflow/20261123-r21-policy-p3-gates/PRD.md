<!-- meta: summary="交付 protectPaths、denyHumanRecord、denyUnknownAction 三个规则开关与只读 /policy-audit [N] 命令，并同步四份文档，不触碰 #417 的流程规则代码。" -->
基线依赖：docs/teamflow/20261119-r19-policy-minimal-gates（P0 骨架、路径归一化、审计底座）、docs/teamflow/20261120-r20-policy-p1-write-gate（P1 三态写门禁、确认卡片与恒开审计）——既有行为不得回退。
取代：docs/teamflow/20261120-r20-policy-p1-write-gate#AC-16：其中「未实现开关置 true 仍在装载期拒绝」的清单，本任务收窄为仅 `enforceProcessRules`（由 #417 交付）；本任务三个开关转为可装载、可生效。

# 策略 P3 收尾：三个规则开关与只读审计命令

## 1. 背景与目标

### 1.1 现状

`forge-policy` 已按 P0/P1/P2 合入 main：配置与目录、恒开审计（memory/file 两种落点）、一次性收据、确认卡片、内容闸都已落地。当前七条规则开关里只有 `contentGate`、`confirmPush`、`confirmDopWrite` 三条能生效，其余四条置真仍在装载期被拒（`rules.<key>: this rule is not implemented in this phase`）。

这留下四个具体问题：

1. **配了等于没配**：`protectedPaths` 与 `paths.append` 一填就在装载期被拒，用户无法给工作区内的 `.env`、私钥、`.npmrc` 等敏感文件加一道硬拒绝。
2. **证据可信度**：`gitee.review.record`（人工评审结论）当前对 agent 是 out-of-scope 放行；agent 可以代写“人工评审”，这使评审证据失真。
3. **默认放行太宽**：工具映射命中、但 catalog 未登记的写动作按 out-of-scope 放行，没有可选的严格白名单。
4. **审计只能翻文件**：审计已落盘，但没有只读浏览入口，排障时要手工找 `$DSH_HOME/logs/forge-policy-<date>.jsonl`。

P3 的第一批「流程闸接入四条纯参数规则」在 PR #417（另一分支，尚未合入）。本任务在独立分支 `feat/policy-p3-gates`（已从 `origin/main` 3377d47 切出）完成剩余五项，不改动 #417 的 process-rules 代码。

### 1.2 目标

1. `protectPaths` 可装载、可关闭、可观察：默认保护工作区内九类敏感路径，配置只能追加不能缩减，命中即拒，归一化失败 fail closed，工作区外不重复判。
2. `denyHumanRecord` 打开后，人工记录类动作一律拒绝，文案说明“人工评审结论必须由人做出”；关闭时保持 out-of-scope 放行与审计。
3. `denyUnknownAction` 打开后，工具映射命中但 catalog 未登记的写动作拒绝；读动作与完全陌生的工具名仍 out-of-scope 放行且不写审计。
4. 新增只读命令 `/policy-audit [N]`：默认 20 条、上限 200 条，字段固定为时间、阶段、动作、目标、决策、规则、耗时、`agent.kind`，不显示正文与参数原文；memory 与 file 两种审计来源都可用。
5. 四份既有文档与实现同步；P3 状态只写本 PR 实际交付的四项，P3 总体验收明确标注“待 #417 合入”。

### 1.3 成功度量

- 本 PRD 的 18 条 AC 全部有可复跑证据；其中 P0 项不得以“文档已写”替代用例。
- pinned Node 24.21.0 下 `pnpm check` 全绿，用例只增不减、0 skip；`git diff --check` 干净。
- 独立 PR，base 为 `main`；改动范围不包含 #417 的 process-rules 代码。
- 四个文档中不出现“七开关全部可用”“P3 已完成”这类超前表述。

## 2. 用户故事与验收标准

三态口径统一如下：**关闭 = 动作放行，且审计只保留该动作原有的 begin/settle，不出现该规则的拒绝记录；开启 = 命中即拒；依赖缺失 = 拒绝（fail closed），不得降级为放行。** 每个新开关至少覆盖三态各一条用例。

### US-1 仓库维护者：给工作区敏感文件加一道硬拒绝

作为维护者，我打开 `protectPaths` 后，任何受控写只要声明了工作区内的 `.env`、私钥、`credentials*` 等路径，就必须在执行前被拒绝，而不是依赖 DSH 沙箱兜底；我追加的路径也必须真的生效。

**AC-1 默认九类逐类命中（P0）**
- 开启开关，对 `.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc`、`.netrc`、`credentials*`、`*.p12` 九类各构造一个工作区内路径，作为受控写动作的 `path` 或 `file` 参数：九类全部在工具执行前被拒。
- 拒绝结果包含可读 `reason` 与下一步；不含底层 Node 错误、绝对路径、盘符、UNC 或 errno。
- 关闭开关：同一动作在其余门禁允许时执行，审计不出现 `protectPaths` 的拒绝记录。
- 工作区内普通文件（如 `notes.txt`）不命中。

**AC-2 配置只追加、不缩减（P0）**
- `protectedPaths` 与 `paths.append` 都不再因“未接入”在装载期被拒；任一面给出合法追加项时服务可装载。
- 追加项覆盖的路径在判定中被拒；两个面同时给值按并集处理，默认九类与默认根不因任何配置消失。
- 即使配置为空数组、缺省或只列一项，默认九类仍全部生效；不存在“配置越短保护越少”。
- 非法项（非数组、空串、相对模板、未解析变量）在装载期报错，错误含键路径并一次列出全部问题，不静默忽略。

**AC-3 归一化、边界与 fail closed（P0）**
- `../` 相对穿越、工作区内 symlink 指向受保护文件、已存在目录的 `..` 穿越，按物理路径归一后命中即拒。
- 目标尚不存在但父目录存在时仍按最深已存在祖先归一判定，命中即拒。
- 符号链接环（ELOOP）、权限不足或路径解析抛错：拒绝，不放行。
- 工作区外的路径（如系统目录、`$DSH_HOME` 内路径）不由本规则判定，交给 DSH 沙箱；既不因“越界”拒绝，也不计为命中。
- 工作区根不可获得或受保护根无法解析：拒绝（依赖缺失 fail closed）。

**AC-4 路径来源与动作作用面（P1）**
- 参数中的 `path`、`file` 字段是必查来源；数组或嵌套对象中明确是路径的同名字段也要覆盖。
- `target` 仅在能确认为路径时检查（绝对路径、`./`/`../` 前缀、工作区内已存在的相对路径）；无法确认是路径时跳过，不能把分支名、仓库名、issue 号误判成路径。
- 未声明路径字段的动作不受影响；当前内置写动作是否携带路径由各自工具参数决定。验收以夹具动作/夹具参数覆盖判定，不把夹具命中写成真实工具已经拦截。
- 审计记录 `rule: "protectPaths"`、命中的受保护根或类别标识；不记录命中的绝对路径。

### US-2 评审负责人：人工评审结论必须由人做出

作为评审负责人，我需要 agent 不能以“人工评审”名义写结论；即使它绕到命令面，也必须被同一门禁拒绝。

**AC-5 `denyHumanRecord` 三态（P0）**
- 开启：`gitee.review.record`（含 `forge_gitee_review_record` 工具）被拒，文案包含“人工评审结论必须由人做出”，给出人工操作的下一步指引；工具不执行、不弹确认卡。
- 开启：写审计一条 `decision: deny`、`rule: "denyHumanRecord"`；审计不含评审正文。
- 关闭：保持现状的 out-of-scope 放行并留一条审计；不因关闭而多拒或少记。
- 依赖缺失（catalog 或动作类别不可判定）：拒绝，不按“无法分类”放行。
- 命令面注册人工记录动作仍被既有保留规则拒绝，不因本开关而放开。

### US-3 安全负责人：可选严格白名单

作为安全负责人，我可以在不改变默认体验的前提下打开严格模式：工具映射到写动作、但目录没有登记，就必须拒绝；读动作和完全陌生的工具不受影响。

**AC-6 `denyUnknownAction` 命中范围（P1）**
- 开启：工具映射命中、动作分类为写、但 catalog 未登记 → 拒绝，reason 为 `unregistered-action`，工具不执行；写一条 `rule: "denyUnknownAction"` 的审计。
- 开启：映射命中且分类为读、但未登记 → 仍 out-of-scope 放行，不写审计。
- 开启：工具名完全不在映射表 → 仍 out-of-scope 放行，不写审计。
- 开启：映射命中但动作无法分类 → 按未登记写处理（拒绝），不按读放行。
- 已登记写动作的行为不变；本开关不改变它们已有的内容闸、确认与流程结论。

**AC-7 `denyUnknownAction` 关闭与依赖缺失（P1）**
- 关闭：映射命中但未登记的写动作按现状 out-of-scope 放行，不读身份、不写审计。
- catalog 不可用或无法判定是否登记：拒绝（fail closed），不按 out-of-scope 放行。
- 文案统一为“默认放行，开启后未登记即拒”；关闭态不得出现“已阻止”的措辞。

### US-4 排障者：一条命令看清最近审计

作为排障者，我不需要知道审计落在内存还是文件，只要执行 `/policy-audit`，就能看到最近 N 条判定摘要；没有记录时它要告诉我下一步，而不是打印空表。

**AC-8 开关顺序与组合（P2）**
- 流水线顺序固定为：`resolve → identity → unknown-action → human-record → protected-paths → process-rules → content-gate → confirmation → audit → receipt`；本分支的 `process-rules` 段不装配（#417 交付），其余已开启段按此顺序短路。
- 关闭的开关不生成阶段；同一调用只产生一条该规则的拒绝记录，不重复记。
- 三个开关同时开启时，先命中的规则单独归因；未命中的规则不得留下拒绝记录。
- 开启 `denyHumanRecord` 后，`gitee.review.record` 不再进入内容闸与确认阶段；开启 `protectPaths` 的拒绝发生在确认之前，不可被已批准卡片翻转。

**AC-9 `/policy-audit` 有记录（P1）**
- 输出最近 N 条（默认 20），按时间从新到旧；每条固定八个字段：时间、阶段（begin/settle/asked/answered 等）、动作、目标、决策、规则、耗时、`agent.kind`。
- 空值用 `-`；`agent.kind` 缺失时显示 `unknown`，不省略字段。
- 不显示参数正文、评审正文、令牌、绝对路径；目标只保留可读标识（如仓库 `org/repo`、分支名），超长截断。
- memory 与 file 两种 sink 输出同构；命令本身不写审计、不改变任何策略状态。

**AC-10 `/policy-audit` 参数边界（P1）**
- `/policy-audit` = 20 条；`/policy-audit 5` = 5 条；`/policy-audit 200` = 200 条。
- `N > 200` 截到 200 并提示已截断；`N <= 0`、非数字：回退默认 20 并提示合法范围，不抛栈、不静默给 0 条。
- 记录少于 N 时按实际条数输出，不补空行。

**AC-11 `/policy-audit` 无记录（P1）**
- 无任何记录时输出可操作提示，例如“暂无审计记录：先执行一次受控写，或开启任一规则后重试”；不打印表头空壳，不返回成功态的“0 条”了事。
- 提示不包含文件路径或内部错误。

**AC-12 `/policy-audit` file sink（P1）**
- `audit.sink: file` 时命令可读到与 memory sink 同构的记录；跨天轮转的文件按保留期合并取最新 N 条。
- 审计目录不存在且无记录：走 AC-11 的无记录提示；目录存在但不可读：明确报“审计源不可读”，不伪造空结果。
- 读取不修改文件、不新增进程、不写审计。

### US-5 文档读者与评审者：文档不超前、不滞后

作为评审者，我需要四份文档与代码同口径，尤其不能把“本 PR 交付四项”写成“P3 已完成”。

**AC-13 `docs/design/plugins/forge-policy.md`（P2）**
- 开关表新增/更新 `protectPaths`、`denyHumanRecord`、`denyUnknownAction` 三行，分别写明默认关闭、命中条件、依赖与 fail-closed 行为。
- 新增 `/policy-audit [N]` 小节：语法、默认 20/上限 200、八个字段、两种 sink、无记录提示、不显示正文与参数。
- 判定流水线顺序与本 PRD AC-8 一致，并注明 `process-rules` 段由 #417 交付、当前分支不装配。
- 删除“`protectedPaths` 固定为 `$DSH_HOME/**`、自定义值装载期拒绝”“`paths.append` 未接入”的表述；`categories` 仍拒绝；同一段落里已过时的 `confirmation`/`content` 拒绝句一并校正。
- 不出现“P3 已完成”“七开关全部可用”的表述。

**AC-14 `docs/design/policy-model.md`（P2）**
- 判定顺序与流水线同源：能力域 → 未登记动作 → 人工记录 → 受保护路径 → 内容域 → 流程域 → 决策 → 确认 → 审计。
- 开关严格性段落写明：本任务三条开关只能收紧；`enforceProcessRules` 仍未实现，开启会在装载期被拒（#417）。
- P0 schema 注记中只保留 `categories` 的装载期拒绝；`protectedPaths`、`paths.append`、`confirmation`、`content` 不再列为“未接入拒绝”。
- 不复制字段表，与 `forge-policy.md` 交叉引用。

**AC-15 `packages/forge-policy/README.md` 与实施计划（P2）**
- README 删除“未实现的开关置真一律装载期拒绝”的全局表述；三条新开关分别说明默认关闭、三态与失败关闭；受保护路径段改为“工作区九类 + 追加式配置 + 工作区外交沙箱”。
- README 增加 `/policy-audit [N]` 一句话入口；`enforceProcessRules` 单列为“待 #417”，不与本 PR 的四项混写。
- `docs/plans/2026-11-19-policy-minimal-gates.md` 的 P3 交付行写“本 PR 交付四项（三个开关 + 只读命令）；P3 总体验收待 #417 合入”，验收列由“八开关全开”改为“七开关全开”；状态行写“进行中”，不得写“已完成”或“未开始”。
- 该文档中描述当前验收/当前实现的“八开关”表述一并更正；描述 P0 历史里程碑的“八开关（全关）”保留历史事实，不追溯改写。

### US-6 交付者：可独立合入、不破坏并行工作

作为交付者，我需要这个 PR 能独立 review、独立合入，不把 #417 的代码卷进来，也不放宽仓库门禁。

**AC-16 工程门禁（P0）**
- pinned Node 24.21.0 下 `pnpm check` 全绿；用例只增不减、0 skip；`git diff --check` 干净。
- `check:repo` 与包体闭包断言未放宽；没有为通过检查而修改白名单或断言。
- 新增用例覆盖三个开关的三态、`/policy-audit` 的有记录/无记录/file sink 三类，以及 AC-8 的顺序断言。

**AC-17 边界与零新增依赖（P0）**
- 不修改 DSH 本体或私有 API；不新增运行时依赖；bundle 补丁层不写 `rules`；不做环境变量覆盖。
- 不修改 #417 的 process-rules 代码；本 PR 对 `config.mjs`/`pipeline.mjs` 的改动只做本任务所需的接线，不改写流程规则语义。
- 夹具不写真实邮箱、内网地址或主机绝对路径；路径用数组 `join` 或临时目录构造。

**AC-18 交付形态（P0）**
- 独立 PR，base 为 `main`；分支为 `feat/policy-p3-gates`。
- 提交说明不以 `#` 开头，引用 issue #364 用正文引用；`git status --short` 无 tgz、logs、dist、测试临时产物。
- `.gitignore` 已覆盖本栈的依赖/构建/缓存/环境机密产物；若新增了未覆盖的产物类型先补规则，不放宽既有规则（见工程约束）。

## 3. 范围与非目标

### 3.1 范围内

1. `protectPaths` 开关接线、默认九类、`protectedPaths`/`paths.append` 装载校验与追加语义、工作区范围与 fail closed。
2. `denyHumanRecord` 对 `gitee.review.record` 的拒绝与关闭态保持。
3. `denyUnknownAction` 对“映射命中、catalog 未登记”写动作的严格拒绝与关闭态保持。
4. `/policy-audit [N]` 只读命令，memory/file 两种来源。
5. 四个既有文档的同步，以及任务夹 PRD/后续 TECHNICAL/QA-REPORT/ACCEPTANCE。
6. 工程门禁、独立 PR 与 `.gitignore` 复核。

### 3.2 非目标

- 不实现 `enforceProcessRules`，不接入 #417 的四条纯参数规则，不做 P3 总体验收。
- 不改变七个开关的默认值（全部保持 false），不改变 P0/P1/P2 已合入的判定语义。
- 不新增第八个开关，不新增规则类型，不做组织层策略编辑器或 UI 设置页。
- 不把 `categories` 接线；它继续在装载期拒绝。
- 不为真实写动作新增 `path`/`file` 参数声明（见 7.3 的作用面限制）。
- 不做审计导出、过滤、持久化或 `/policy-audit` 的写操作。
- 不修改历史任务夹（r19/r20 等），不为本需求归档或升版。
- 不做真实企业环境、真实 IAM、真实 Gitee/DevOps 联调取证。

## anti-goals / 反面目标

以下不是“不做的功能”，而是**即使测试全绿、也应该被人拒绝的结果**。每条都可以在评审时直接观察。

1. **开关敢开、研发没法干活**：开启 `protectPaths` 后，`target` 里的 `release/2026.11`、`org/repo`、`#364` 之类被当成路径拒绝，正常推送/评审被迫关掉开关。观察方式：用真实形态的分支名、仓库名、issue 号各跑一次，不能被拒。
2. **配了等于没配**：`protectedPaths`/`paths.append` 填了合法值，装载期仍报“未接入”；或装载成功但判定中从不生效，用户以为 `.env` 已被保护。观察方式：追加一个夹具路径，必须看到拒绝；去掉追加项，必须回到放行。
3. **审计浏览变成泄密或刷屏**：`/policy-audit` 把参数正文、评审正文、令牌或绝对路径打到终端；或用超宽表格/200 行把窄终端刷满，无法核对。观察方式：注入带敏感值的审计记录，全文扫描零命中；80 列终端下每条仍可读。
4. **默认关闭不再“无感”**：关掉开关后行为漂移——多拒一次、多写一条该规则的审计，或 `/policy-audit` 自己产生审计记录。观察方式：关闭前后对比审计条数与执行结果，只允许既有 begin/settle 存在。
5. **把“四项”吹成“P3 完成”**：文档写“七开关全部可用”或状态写“已完成”，而 `enforceProcessRules` 开启仍装载失败（#417 未合）。观察方式：按文档把七个开关全开，不能出现装载错误；若做不到，文档必须写明待 #417。
6. **为了绿灯放宽门禁**：改 `check:repo` 白名单、包体闭包断言或删既有用例来通过检查；或顺手改了 #417 的 process-rules 代码，制造并行冲突。观察方式：diff 中不出现检查器规则放宽，不出现 process-rules 语义改动。

## 4. 交互与判定流程

### 4.1 受控写判定（本 PR 后）

```text
resolve → identity → unknown-action? → human-record? → protected-paths?
        → [process-rules: #417，本分支不装配] → content-gate? → confirmation?
        → audit → receipt
```

- 带 `?` 的段落只有对应开关为 true 且规则已实现时才装配；关闭时该段不存在，不产生“进入后放行”的记录。
- 任一段拒绝即短路：不执行工具、不弹后续卡片、不再进入内容闸/确认；只留一条该规则的拒绝审计。
- `unknown-action` 在 `denyUnknownAction` 开启时只拦“映射命中、分类为写、catalog 未登记”；读动作、未知工具名直接 out-of-scope，不读身份、不写审计。
- `human-record` 在 `denyHumanRecord` 开启时拦人工记录类动作；关闭时保持 out-of-scope 放行 + 审计。
- `protected-paths` 在 `protectPaths` 开启时按 AC-1~AC-4 判定；命中即硬拒绝，发生在确认之前，已批准的卡片不能翻转。

### 4.2 `/policy-audit [N]`

```text
/policy-audit [N]
  → 解析 N（默认 20，夹到 1..200；非法回退 20 并提示）
  → 按 config.audit.sink 选择来源：memory 环形缓冲 或 file 当日/保留期 JSONL
  → 取最新 N 条，按固定八字段渲染（一行一条）
  → 输出；不写审计、不改状态
```

示例（字段示意，非真实数据）：

```text
2026-11-23T15:20:11+08:00  begin   gitee.git.push        org/demo   allow     -                 12ms   root
2026-11-23T15:20:12+08:00  settle  gitee.git.push        org/demo   executed  -                 840ms  root
2026-11-23T15:21:03+08:00  begin   gitee.review.record   org/demo   deny      denyHumanRecord   3ms    root
```

- 一行一条、字段顺序固定，避免表格在窄终端折行；`target` 超长截断，空值 `-`。
- 不输出 `params`、正文、令牌、绝对路径；`agent.kind` 只输出 kind，不输出 agent 名称或会话 id。

## 5. 优先级

| 优先级 | AC | 说明 |
|---|---|---|
| P0 | AC-1、AC-2、AC-3、AC-5、AC-16、AC-17、AC-18 | 安全语义、证据可信度与交付门禁；任一不满足不得合入 |
| P1 | AC-4、AC-6、AC-7、AC-9、AC-10、AC-11、AC-12 | 严格白名单与只读命令的核心交互 |
| P2 | AC-8、AC-13、AC-14、AC-15 | 组合顺序与文档一致性；可与 P1 并行，但合入前必须完成 |

## 6. 依赖与风险

### 6.1 依赖

- P0/P1/P2 已合入的配置、catalog、审计、确认、内容闸与路径归一化能力；本任务不重建这些底座。
- 宿主提供的工作区根、工具参数、命令注册与 `userQuestions` 通道；缺少任一项时按 fail closed 处理，不降级。
- Node 24.21.0（`.node-version`）与仓库既有 pnpm 脚本；不新增运行时依赖。
- #417 只影响 P3 总体验收，不作为本 PR 的代码依赖；两 PR 可独立合入。

### 6.2 风险

1. **与 #417 的文件重叠**：两个 PR 都可能改 `config.mjs` 的 `IMPLEMENTED_RULES`、`pipeline.mjs` 的装配、以及同一批文档/用例。缓解：本 PR 只增加本任务接线，不改流程规则语义；无论谁先合，后合者 rebase 后以 main 为准复核并集，冲突处不静默取一侧。
2. **工作区根来源不唯一**：插件拿不到可靠工作区根时，`protectPaths` 无法判定“工作区内/外”。缓解：根不可得即拒绝（AC-3），不按“没有根=没有保护”放行。
3. **`protectPaths` 的作用面是潜在的**：当前内置写动作未声明 `path`/`file` 参数，规则要等出现声明路径的写动作才在真实工具上触发；`denyUnknownAction` 也只在“映射命中但 catalog 未登记”时触发，而现有已映射写动作均已登记。缓解：PRD/文档如实写明作用面，验收用夹具覆盖判定，不把夹具命中宣称为真实工具已拦截；后续新增写动作时自然获得保护。
4. **平台差异**：symlink/realpath/大小写在 darwin、Linux、Windows 行为不同；用例不得依赖开发机绝对路径。缓解：临时目录 + `path.join` 构造夹具，平台差异用分支夹具覆盖，不为过用例放宽断言。
5. **file sink 读取**：按天轮转、JSONL 可能跨文件；读坏行或目录不可读时容易伪造“无记录”。缓解：AC-12 要求不可读明确报错，坏行跳过但不伪造记录，读取不写盘。
6. **文档漂移**：`forge-policy.md`、`policy-model.md`、README、计划中已有“未接入/装载期拒绝”的旧句，容易只改一处。缓解：AC-13~AC-15 逐文件列明要删/要改的表述，合入前用关键词扫描复核。
7. **P3 状态误报**：把本 PR 四项写成 P3 完成，会让 #417 的验收被跳过。缓解：AC-15 固定措辞，状态只写“进行中 / 待 #417”。

## 7. 工程约束

### 7.1 分支、提交与 PR

- 在 `feat/policy-p3-gates` 分支实施；该分支已从 `origin/main` 3377d47 切出。**独立 PR，base 为 `main`**。
- 不修改 #417 的 process-rules 代码；不改写、rebase 或覆盖另一分支的提交。
- 提交说明**不得以 `#` 开头**（`sensitive-scan` 会把整段当注释删除）；引用 issue 用正文引用，如 `ref: issue #364`。
- 推送前运行 `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD`；提交前 `git diff --check` 干净。
- 工作区已有未提交改动时先核实归属，不覆盖他人改动；本任务只提交自己的文件。

### 7.2 实现与检查边界

- 不修改 DSH 本体与私有 API；不新增运行时依赖；bundle 补丁层不写 `rules`；不做环境变量覆盖。
- 不放宽 `check:repo`、包体闭包断言或任何既有检查规则；用例只增不减、0 skip。
- 工具链固定 Node 24.21.0；验收命令：`pnpm check`、`git diff --check`、`git status --short`。
- 不修改历史任务夹；本需求全部产物写在 `docs/teamflow/20261123-r21-policy-p3-gates/`。
- 产品文档只改 AC-13~AC-15 列出的四份；不写宿主 `docs/<role>/`，不在仓库根新增文件或散落日志。
- `memory.md` 仅在本需求引入新的团队约定/技术栈决策时按同主题替换；本需求预期不新增约定，不动它。

### 7.3 夹具与敏感数据

- 测试夹具不得写真实邮箱、内网地址或主机绝对路径；路径用数组 `join` 或临时目录构造（如 `['fixtures', '.env'].join('/')`）。
- 拒绝文案、审计、命令输出全文扫描：不得出现绝对路径、盘符、UNC、URI、`~/.`、原始 `Error` 文本或 errno token。
- `protectPaths` 的验收用夹具动作/夹具参数，不修改真实工具的公开参数以“制造”命中；真实验收未覆盖的部分如实标注。

### 7.4 `.gitignore` 复核（开发阶段动作）

- 当前 `.gitignore` 已覆盖本栈常见产物：`node_modules/`、`.pnpm-store/`、`dist/`、`build/`、`coverage/`、`.turbo/`、`*.tsbuildinfo`、`output/`、`artifacts/`、`tarballs/`、`*.tgz`、`*.log`、`.env`/`.env.*`、`*.pem`/`*.key`/`*.p12`、`id_rsa*`、`secrets/`、IDE 目录。
- 开发阶段确认本任务不引入新的未忽略产物（如审计样例 JSONL、临时夹具目录、排查脚本）；确有新增产物时先补对应规则，再提交。
- 不得为了“提交干净”放宽或删除既有忽略规则；`git status --short` 中不得出现 tgz、logs、dist 或测试临时文件。

## 8. 里程碑建议

| 里程碑 | 内容 | 对应 AC | 完成判据 |
|---|---|---|---|
| M1 路径保护 | 配置面恢复、默认九类、归一化/边界、路径来源、流水线插段 | AC-1~AC-4、AC-8 | 包内用例全绿；三态与 fail closed 各有证据 |
| M2 语义开关 | `denyHumanRecord`、`denyUnknownAction` 及关闭态 | AC-5~AC-7 | 三态用例；真实 `gitee.review.record` 拒绝生效 |
| M3 审计命令 | `/policy-audit [N]`、两种 sink、边界与空态 | AC-9~AC-12 | 命令输出快照；无写盘、无新审计 |
| M4 文档与交付 | 四份文档、门禁、独立 PR | AC-13~AC-18 | `pnpm check` 全绿；文档关键词扫描；PR 描述含 NOT RUN 项 |

## 9. 验收与证据口径

- **本地证据**：pinned Node 24.21.0 下 `pnpm check` 的退出码与用例统计；包内新增用例逐条对应 AC；`git diff --check`、`git status --short` 输出。
- **命令证据**：`/policy-audit` 在 memory/file/无记录三种场景的输出；不截图代替文本，不把手工观察写成自动化用例。
- **负面证据**：关闭态不多拒、不多审计；工作区外路径不被本规则判；文档关键词扫描零命中旧口径。
- **如实标注**：真实企业 IAM、真实 Gitee/DevOps、Windows/麒麟实机、真实 profile 装载未在本任务验证，标 NOT RUN；本地 mock/夹具结论不写成企业联调。
- **不宣称**：P3 总体验收、七开关全部可用、`enforceProcessRules` 已交付。

## 假设与待澄清

- **(a) 事实：`protectedPaths` 与 `paths.append` 的取值形态和关系未在现有文档中定义。** P0 只写了两层“未接入”，`paths.append` 没有示例；现有 `resolveProtectedRoots` 只接受绝对路径或 `$VAR` 根模板。**我的默认假设**：两者都接受同一套路径模板，取并集，作为默认九类之外的追加保护；名称模式（九类）固定在代码里，不进配置。若实际应是“根列表 + 名称模式”分工，AC-2 的夹具与文档示例需改写。 (`kind: "fact"`)
- **(b) 口味：`protectPaths` 对 `target` 的路径识别严格度。** 偏保守会漏掉“看起来像路径但不是绝对/相对前缀”的 target；偏激进会把 `release/1.0`、`org/repo` 误判成路径，逼用户关开关。**推荐**：只认绝对路径、`./`/`../` 前缀或工作区内已存在的相对路径；`path`/`file` 字段仍全查。 (`kind: "taste"`)
- **(b) 口味：`/policy-audit` 的输出形态。** 一行一条固定字段（推荐，窄终端可读、便于 grep）与对齐表格（列对齐更直观，但 200 条或长 target 时会折行/刷屏）都成立。**推荐默认**：一行一条，字段顺序固定，空值 `-`，超长截断，超过 200 条提示已截断。 (`kind: "taste"`)
