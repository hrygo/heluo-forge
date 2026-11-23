# QA 报告 · r21 · 策略 P3 三项语义开关与 `/policy-audit`

- 阶段：QA（功能验收 + 架构核对 + 接口一致性）
- 任务夹：`docs/teamflow/20261123-r21-policy-p3-gates/`
- 结论：**不可直接验收 —— 1 项 P2 缺陷（D-1）待修复**；其余 AC 全部通过，修复后按 D-1 检测命令复验即可转可验收。
- 缺陷统计：P0 = 0，P1 = 0，P2 = 1，P3 = 0。

## 1. 范围与环境

- 交付范围：`protectPaths`、`denyHumanRecord`、`denyUnknownAction` 三开关接线与三态、只读命令 `/policy-audit [N]`、四份文档同步（`docs/design/plugins/forge-policy.md`、`docs/design/policy-model.md`、`packages/forge-policy/README.md`、`docs/plans/2026-11-19-policy-minimal-gates.md`）。
- 分支 `feat/policy-p3-gates`，HEAD `3377d47`（= `origin/main`），交付改动**未提交**：11 个源码 `M` + 4 份文档 `M` + 10 个既有用例 `M` + 3 个新源码 + 6 个新用例 + 任务夹（`git status --porcelain` 共 32 项）。
- 环境：macOS darwin arm64；Node **24.21.0**（`.node-version`，`$NVM_DIR` 下的 24.21.0 `node` 二进制；默认 v24.13.0 会触发 forge-iam 的 SQLite 实验性告警用例失败，故全部命令固定 24.21.0）；pnpm 11.28.5；从 worktree 根执行。
- 方法：只经公开入口（`packages/forge-policy/src/index.mjs` 再导出 + `apply` 假宿主）驱动，独立探针与被测代码分离；夹具全部落系统临时目录（`mkdtemp`），不触真实凭据与企业地址。

## 2. 执行证据（命令 / 退出码 / 断言）

| 编号 | 命令 | 退出码 | 关键结果 |
|---|---|---|---|
| E1 | `node logs/teamflow/tf-mwsy841k-d5zxvq/scripts/qa-p3-ac.mjs` | 0 | **PASS 50/50** 独立断言，覆盖 AC-1~AC-15 全部行为面（九类逐类、三态、fail-closed、路径来源、顺序、命令有记录/边界/无记录/file sink、四份文档正则） |
| E2 | `node logs/teamflow/tf-mwsy841k-d5zxvq/scripts/qa-p3-defect-config-keypath.mjs` | **1** | 3 条断言全 FAIL：L2 展开失败消息缺 `protectedPaths[0]/[1]`、`paths.append[0]` 键路径 → 缺陷 D-1 |
| E3 | `node logs/teamflow/tf-mwsy841k-d5zxvq/scripts/p3-e2e.mjs` | 0 | `E2E: PASS`：`POLICY_PROTECTED_PATH` / `POLICY_UNREGISTERED_ACTION` / `POLICY_HUMAN_RECORD` 三拒 → 登记写 allow → guard 放行 → settle `executed` → `/policy-audit` 输出 5 行八列 |
| E4 | `pnpm check`（Node 24.21.0） | 0 | tests 4810 / pass 4807 / fail **0** / skipped 3 / 119316ms；含 `check:docs`、`check:repo`、`check:version` 与全量单测 |
| E5 | `git diff --check` | 0 | 无空白错误 |
| E6 | `git status --porcelain` | 0 | 32 项均为预期交付物与任务夹；无 `*.tgz`、`dist/`、`logs/`（`logs/` 被 `.gitignore:86` 覆盖） |
| E7 | `git diff --name-status --diff-filter=DR HEAD` / `git diff -U0 HEAD -- '*.test.mjs' \| grep '^\+.*skip'` | 0 / 1（无命中） | 无删除/改名；**无新增 skip 标记**（3 skip 为既有条件跳过） |
| E8 | `grep -rn "child_process\|spawn(" packages/forge-policy/src` | 1（无命中） | 未新增子进程（AC-12「读取不新增进程」） |
| E9 | 单一真源 grep | 0 | `PROTECTED_NAME_PATTERNS` 仅 `src/paths.mjs`（index 再导出）；`ALLOWED_FIELDS`/`FORBIDDEN_FIELDS` 仅 `src/audit.mjs:25/59`；gate 不复制 |
| E10 | 探针内「审计零泄漏」断言 | 0 | allow+settle 的 `params` 折叠为 `{"body":"[content]","path":"tmp/x.txt"}`，记录与命令输出均不含正文/令牌/工具输出；输出固定八列 |
| E11 | 探针内 `apply` 假宿主：`service.checkPath/protectedPaths/decide/authorize` | 0 | 返回形态与文档一致：`{judged,protected,category?}`、追加模板数组、`policy-audit` 命令注册与 `{kind,text}` 结果 |

## 3. AC 逐条结果

| AC | 判据要点 | 结果 | 证据 |
|---|---|---|---|
| AC-1 默认九类逐类命中（P0） | 九类 `.env`/`.env.*`/`*.pem`/`*.key`/`id_rsa*`/`.npmrc`/`.netrc`/`credentials*`/`*.p12` 在工作区内逐类拒绝；reason 含类别与下一步、不含路径/errno；关闭放行；`notes.txt` 不命中 | 通过 | E1 A 组；E3 |
| AC-2 配置只追加（P0） | 两面装载；并集去重且 `protectedPaths` 在前；默认九类不因配置消失；非法项装载期报错并**含键路径**、一次列全 | **部分通过** | E1（并集/默认/一次列全通过）；**D-1**：L2 展开失败消息缺 item 键路径 |
| AC-3 归一化与 fail closed（P0） | `..` 穿越、工作区 symlink、缺失父目录按最深祖先归一；ELOOP/解析失败拒绝；工作区外不判；工作区根不可得、追加根不可解析即拒 | 通过 | E1 B 组；E2 配套 |
| AC-4 路径来源与作用面（P1） | `path`/`file` 任意深度、嵌套数组、键名大小写；`target` 仅明确路径形态；`release/2026.11`、`acme/demo!1`、`#364`、`main` 不误判；33 候选超限 fail closed；深度 4 判、5 不判；证据只记 `name:`/`root:` | 通过 | E1 C 组 |
| AC-5 `denyHumanRecord` 三态（P0） | 开启拒 `gitee.review.record`（含 `forge_gitee_review_record`），文案含「人工评审结论必须由人做出」，不弹卡、记录无正文；关闭 out-of-scope 放行；依赖缺失拒绝；命令面人工记录仍被保留规则拒 | 通过 | E1 D 组；`test/command.test.mjs:66` |
| AC-6 `denyUnknownAction` 命中范围（P1） | 未登记写拒绝（`unregistered-action`）；未登记读、未映射工具 out-of-scope 且不写审计；映射命中无法分类按写拒；已登记写不变 | 通过 | E1 D 组 |
| AC-7 关闭与依赖缺失（P1） | 关闭放行、不读身份、不写审计；catalog 不可用拒绝；文案统一「默认放行，开启后未登记即拒」，关闭态无「已阻止」 | 通过 | E1 D 组；`gate.mjs:67` |
| AC-8 顺序与组合（P2） | `resolve→identity→unknown-action→human-record→protected-paths→#417 未装配→content-gate→confirmation→audit→receipt`；关闭开关不生成阶段；同调用每规则至多 1 条拒记录；人工记录拒不进内容闸/确认，已批准不可翻转 | 通过 | E1 E 组；`pipeline.mjs` ORDER 与 `buildPipeline` |
| AC-9 命令有记录（P1） | 默认 20、上限 200、新→旧、固定八列、空值 `-`、`agent.kind` 缺省 `unknown`、目标只留末段、不显示正文/参数/令牌 | 通过 | E1 F 组；E10 |
| AC-10 参数边界（P1） | `>200` 截断并提示；`<=0`/非数字回退 20 并提示；记录不足按实际 | 通过 | E1 F 组 |
| AC-11 无记录（P1） | 空审计与目录不存在走可操作空态；目录存在不可读报「审计源不可读」，不伪造空结果 | 通过 | E1 F 组 |
| AC-12 file sink（P1） | 跨天 JSONL 合并、坏行计 corrupt 不伪造、memory/file 输出同构；读取不建目录、不轮转、不写盘、不开进程 | 通过 | E1 F 组；E8 |
| AC-13 forge-policy.md | 开关语义、`/policy-audit`、流水线顺序、旧口径清除、`enforceProcessRules` 单列待 #417、无「P3 已完成/七开关全部可用」 | 通过 | E1 G 组；E12 旧口径扫描 |
| AC-14 policy-model.md | 判定顺序同源、三语义开关只收紧、schema 仅剩 `categories` 未接入 | 通过 | E1 G 组 |
| AC-15 README + 实施计划 | 三态与失败关闭、命令入口、受保护路径口径；计划 P3 状态「进行中 / 待 #417」，P0 历史保留 | 通过 | E1 G 组 |
| AC-16 工程门禁（P0） | Node 24.21.0 `pnpm check` 全绿、用例只增不减且无新增 skip、`git diff --check` 干净、检查器/白名单未放宽、新用例覆盖三态+命令三类+顺序 | 通过 | E4/E5/E7；新用例 6 文件全部入库（`git status` 未跟踪新 test） |
| AC-17 边界与零新增依赖（P0） | 不改 DSH 本体、无新运行时依赖（`package.json` 依赖零变化）、无子进程、补丁层未写 `rules`、未改 #417 process-rules、夹具无真实邮箱/内网地址 | 通过 | E8；`git diff -- packages/forge-policy/package.json` 空 |
| AC-18 交付形态（P0） | 独立分支 `feat/policy-p3-gates`、base main；`git status` 无 tgz/logs/dist；`.gitignore` 未放宽 | 部分通过（提交说明待提交时核验） | E6；当前未提交，「提交说明不以 # 开头」**NOT RUN** |

## 4. 缺陷表

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| D-1 | P2 | 配置装载（`packages/forge-policy/src/config.mjs` · `checkTemplateExpansion`） | 在仓库根执行末列命令：以未解析变量构造 `protectedPaths`/`paths.append` 后调 `resolveConfig`，观察装载期报错文本 | 报错带键路径并分面定位，如 `protectedPaths[0] …`、`protectedPaths[1] …`、`paths.append[0] …`（TECHNICAL §4.1「L2 报 protectedPaths[0]/paths.append[0]」与 PRD AC-2「错误含键路径」） | 统一输出 `protectedPaths/paths.append: 模板 $QA_P3_MISSING_A/** 无法展开（POLICY_PROTECTED_ROOT_UNRESOLVED）`：无 item 下标、两面共用同一标签；多条并列时分不清来源，与 L1 的 `label[i]` 口径不一致 | AC-2 | `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" node logs/teamflow/tf-mwsy841k-d5zxvq/scripts/qa-p3-defect-config-keypath.mjs`（当前 exit 1，3 条断言 FAIL） | 同一命令 exit 0，输出 3 条 PASS：报错含 `protectedPaths[0]`、`protectedPaths[1]`、`paths.append[0]` 键路径且不混键 |

修复提示（非强制）：`checkTemplateExpansion` 逐面/逐项调用 `resolveProtectedRoots([template])` 并传 `label=protectedPaths[i]` / `paths.append[i]`；错误 code 保留 `POLICY_PROTECTED_ROOT_UNRESOLVED`。

## 5. 架构与接口一致性核对

- **蓝图落地**：`src/path-sources.mjs`、`src/audit-query.mjs`、`src/audit-command.mjs` 按 blueprint 抽出且职责单一；依赖方向 `gate → paths/path-sources/catalog/audit`、`installer → paths/config/pipeline/audit/audit-command`，无跨轴互导。
- **无重复实现**：九类模式只在 `paths.mjs`；审计允许字段/禁用字段只在 `audit.mjs`；判定顺序表只在 `pipeline.mjs`（gate 内为分段代码 + #417 注释，无第二份数组），符合 blueprint 三条 duplications 约定。
- **接口一致性（静态 + 实跑）**：新增导出（`judgeProtectedPath`、`matchProtected`、`collectPathTemplates`、`collectPathCandidates`、`targetAsPath`、`parseAuditCount`、`formatAuditReport/Row/Time`、`registerAuditCommand`、`PROTECTED_NAME_PATTERNS`、`DEFAULT_AUDIT_LIMIT`/`MAX_AUDIT_LIMIT`、`AUDIT_COLUMNS`）均在 `index.mjs` 真实导出并被探针实际调用；服务方法 `protectedPaths()`/`checkPath()`/`decide()`/`authorize()` 形态与文档一致；无「调用成员不存在」或参数形状错配。
- **观察（非缺陷、记 P3）**：`gate.mjs` 的 admitOnce 分段顺序与 `pipeline.mjs` 的 `ORDER` 需人工同步；现有 `pipeline.test.mjs` 与 #417 注释已覆盖，未见第二份顺序清单。另：`target` 为对象形态（如 `{path:{...}}`）时按设计不判，宿主工具 schema 会先拒非字符串，非本次缺陷。
- 无 UI 面，craft 评分 **N/A**（命令输出按固定八列规范，已用脚本断言）。

## 6. 人工补测清单（环境限制，非交付缺陷）

| # | 项 | 方法 / 工具 |
|---|---|---|
| 1 | 真实 DSH 宿主 profile 安装与重启加载 | 将 `@heluo/forge-policy` 装入 profile → 重启 `dsh --profile …` → 触发一次受控写，确认 `tools/pre-execute` 生效；回滚：从 profile 依赖移除并重启（安装前先记录卸载命令） |
| 2 | P3 总体验收（#417） | `enforceProcessRules` 合入后跑全量顺序与独立验收 |
| 3 | 企业 IAM 真实身份通道 | 内网环境登录后验证 `denyHumanRecord`/写门禁的身份解析路径 |
| 4 | Windows / 麒麟 aarch64 路径语义 | 大小写折叠、驱动器、UNC、symlink 归一实机复核 |
| 5 | 真实内置写动作声明 `path`/`file` 后的端到端拦截 | 当前内置写动作未声明路径字段，PRD 已如实说明「潜在保护」，需真实工具声明后复测 |
| 6 | `/policy-audit` 宿主命令面板渲染与真实 N 输入 | 在宿主命令面板输入 `/policy-audit 5`、`0`、`abc`、`201` 观察文案 |
| 7 | file sink 长期轮转（跨天/`keepDays`） | 多日真实运行后复核 `/policy-audit` 合并与坏行计数 |

## 7. 未验证 / NOT RUN

- AC-18「提交说明不以 # 开头、独立 PR 描述」：本交付**未提交**，提交时核验（当前仅核到分支、base 与工作区形态）。
- 真实宿主加载（清单 #1）、企业 IAM（#3）、双端实机（#4）、真实工具路径声明（#5）：环境限制，NOT RUN。
- 平台限定排序/挂载用例中 3 个既有 skip 为条件跳过，非本交付引入（E7）。

## 8. 结论

- **不通过（待修复 1 项 P2）**：AC-2 的「装载期报错含键路径」未兑现（D-1），其余 17 条 AC 通过（含四份文档口径与工程门禁）。
- 修复 D-1 后重跑 `qa-p3-defect-config-keypath.mjs`（期望 exit 0）与 `qa-p3-ac.mjs`（期望 50/50），即可转「可验收」；`pnpm check` 与 `git diff --check` 维持 E4/E5 结果。
