<!-- meta: summary="把 gitee.delivery.judge 从默认不登记改为随包登记的只读判定（目录 3→4，口径统一为「3 读 + 1 只读判定 + 4 受控写」，target 取 change），四个受控写仍默认 denied；同步测试、README/设计文档与 r4 任务夹四份（带「r7 修订」标注并保留原结论），并给出旧 tarball 的重打包、重装与回滚命令。" -->
基线依赖：docs/teamflow/20261029-r4-forge-gitee（该夹确立的补丁层两行形态、目录/审计/isolate 约束、8 工具面、门禁唯一准入点与四状态语义，未显式取代者一律不回归）
取代：docs/teamflow/20261029-r4-forge-gitee#AC-7：默认目录由「3 条只读、0 条其他」改为「3 条只读 + 1 条只读判定（gitee.delivery.judge）」，仍 0 条 write。
取代：docs/teamflow/20261029-r4-forge-gitee#AC-17：默认目录下不再「5 个受控动作全部 denied」——判定动作默认登记可用，其余 4 个写动作仍 denied 且零子进程。

# PRD — 判定动作默认登记（`gitee.delivery.judge`）

## 1. 背景与目标

真机装包验收时，`forge_gitee_delivery_gate`（动作 `gitee.delivery.judge`）一调就被拒：

```json
{"status":"denied","reason":"GUARD_ACTION_UNREGISTERED","rule":"unregistered-action","remote_calls":0}
```

它只回答「这单还差什么才能关」：不写平台、不起子进程（`remote_calls` 恒 0、判定结果 `executed` 恒 false），却和四个真正会产生远端副作用的写动作一起被「不登记」挡在门外。用户装完包拿到一个不可用的工具，还得自己去改 profile 的策略目录。

目标（按优先级）：

1. **判定开箱可用**：`gitee.delivery.judge` 随包登记为 `kind: read`（target 取 change 语义），默认目录 3→4 条，判定不再 `denied`。
2. **写门禁零放宽**：4 个受控写动作仍「不登记即 denied」；工具名/数量不变（仍 8 个）、不新增审批台账、不加 close/merge 通道。
3. **同一事实只有一处口径**：测试断言、README、设计文档、r7 TECHNICAL、r4 任务夹同步为「4 条（3 读 + 1 判定）/ 写仍 denied」，现行文档零残留旧口径。
4. **装上才生效**：给出旧 tarball 的重打包、重装与回滚命令，并写明「不重装 = 用户看到的还是旧行为」。
5. **证据不掺假**：缺事实仍 `unknown`，`criteria` 有 unknown 项时结论必须是 `unknown`，不得写成通过。

## 2. 用户故事

- US-1（企业内网验收人）：装完包就能问「这单还差什么才能关」，不用先改策略配置。
- US-2（安全/平台负责人）：判定默认可用没有顺带放开任何写动作，白名单里依然没有 close/merge。
- US-3（维护者/接续者）：只改一处口径不会留下矛盾副本；重装失败有可照做的回滚。

## 3. 范围与非目标

**范围内**：`packages/forge-gitee/cordis.patch.yml` 的策略目录；门禁/工具层为 «判定默认可用» 所需的最小适配（含确认裁决 rule 为 `registered-action` 所需的 `egress` 声明）；受影响测试（含新增回归断言与变异实验）；`packages/forge-gitee/README.md`、`docs/design/plugins/forge-gitee.md`、`docs/design/README.md`、r7 `TECHNICAL.md`；r4 任务夹四份（`PRD.md` / `QA-REPORT.md` / `ACCEPTANCE.md` / `TECHNICAL.md`）的「r7 修订」标注与口径同步（用户已授权覆盖 ADR-0008 的「任务夹不可变」约定）；构建、安装、回滚命令与证据。

**非目标**：不登记任何写动作；不改 `confirmation`/审批模型与 `needsApproval` 语义；不改工具名、数量、参数与四状态语义；不改判定算法与原因码词表（确需新增固定枚举时同批同步文档）；不新增配置项/配置页；不动 `@heluo/forge-devops`；不改写 r4 之外的历史任务夹；r4 原有结论原文与证据编号不删除（只就地加「r7 修订」标注并写明原结论）；本阶段不执行真实宿主重启（由主 agent 在验收后执行）。

## 4. anti-goals / 反面目标

1. **源码全绿、现场没变**：验收人重启后调判定仍收到 `GUARD_ACTION_UNREGISTERED`——因为 profile 里装的还是旧 tarball。
2. **把 unknown 写成通过**：缺凭据/缺事实时判定给出 `status: done` 或「通过」，只为让「默认可用」看起来有效。
3. **顺手放开写**：为了让判定跑通，把任一写动作也登记，或给判定套上 confirm/审批台账。
4. **一处改、多处仍冲突**：只改 README，`docs/design/` 与 r4 TECHNICAL 仍写「五个受控动作全部不登记/denied」，验收人不知道信哪个。
5. **装坏后回不去**：重装失败时没有可照做的回滚，本机 `web` profile 停在半装（依赖指向不存在的 tarball、宿主起不来），只能人工手术。
6. **判定做成执行**：输出里出现「已关闭/已合入」或任何 close/merge 调用。

## 5. 交互流程摘要

模型调用 `forge_gitee_delivery_gate{changeId, message, criteria}` → 门禁（action `gitee.delivery.judge`，`egress: platform-write`）→ 策略 `decide`：条目存在、`enabled`、`kind: read`、target 非空 → `allow`（`registered-action`）→ `executeAction` 审计准入/结算 → 判定体：`message` 必须以 `[变更号]` 开头；`acceptance / merged / pendingDelivery / humanConfirmed` 四项逐项判 → 全 passed 且无 unknown：`done`（`rule: ready`）；有 unknown：`unknown`（不计通过，列出未就绪项）；有 failed/缺项：`failed`（列出还差什么）。全程 `remote_calls: 0`、`executed: false`。写工具路径不变：`denied` + `unregistered-action` + 门禁 operation 0 次。

## 6. 验收标准

| AC | 优先级 | 验收标准（可测） | 判据/命令 |
|---|---|---|---|
| AC-1 | P0 | 默认目录 = 3 只读 + 1 判定：补丁层策略行 `config.catalog` 恰 4 条；3 条为既有 `kind: read` 只读动作；第 4 条 `action: gitee.delivery.judge`、`kind: read`、`enabled: true`、`target` 逐字为 `change`（非等价串）；`kind: write` 条数为 0；`compileCatalog` 编译通过 | `node --test packages/forge-gitee/test/entry.test.mjs`；断言条数/动作/kind |
| AC-2 | P0 | 判定默认可用：用分发补丁层真实装配（策略 + 插件），以合法入参（`changeId: "CHG-2026-001"`、`commit` 为 7–40 位十六进制、`message: "[CHG-2026-001] 判定默认登记"`、四项条件均 passed/`pendingDelivery.count: 0`）调用 → `status === "done"`、`rule === "ready"`、`readback.ok === true`、`executed === false`、`remote_calls === 0`；不得出现 `denied`/`unregistered-action` | 新增 patch-mount 用例（见 AC-4） |
| AC-3 | P0 | 写类仍 denied：同一装配下 4 个写工具（`forge_gitee_issue_write`/`forge_gitee_pr_write`/`forge_gitee_review_publish`/`forge_gitee_review_record`）逐个 `status === "denied"`、`rule === "unregistered-action"`、有固定 `reason`、无 `evidence`、无 `status: "done"`，门禁 operation 0 次；判定工具不得混入该集合 | `node --test packages/forge-gitee/test/patch-mount.test.mjs` |
| AC-4 | P0 | 回归断言有牙：新增一条用例，名字含「默认登记判定、不默认登记写」，同时断言 AC-1/AC-2/AC-3 三件事；变异实验——临时从补丁层删除 judge 条目后该用例必须失败（判定回 denied），从备份还原后文件 hash 一致，QA-REPORT 记录两轮输出 | 变异两轮 + `shasum -a 256` |
| AC-5 | P0 | unknown 不计通过：`criteria` 含 `unknown` 项（如 `acceptance: {status: "unknown"}` 或 `humanConfirmed` 未绑定 commit）→ `status === "unknown"`、`readback.ok === false`、未就绪项列表含该项、`reason` 为固定枚举；响应任何位置不得出现 `status: "done"` 或「通过」 | `node --test packages/forge-gitee/test/actions.test.mjs` 类用例 |
| AC-6 | P0 | 缺参 fail closed：缺 `changeId`/`message`/`criteria`、非法变更号 → `denied` 或 `failed` + 既有固定原因码（`MISSING_ARGUMENT`/`INVALID_ARGUMENT`/`INVALID_TARGET`/`COMMIT_*`），零子进程、零平台调用 | 同上 |
| AC-7 | P0 | 判定零副作用：判定路径适配器调用 0 次、`execFile` 0 次、`remote_calls === 0`、`executed === false`；静/动两态禁项仍含 close/merge（`DELIVERY_FORBIDDEN_VERBS`），包内无 close/merge 通道，策略白名单无 close/merge；判定不在 `CONFIRM_REQUIRED_ACTIONS` 内，`needsApproval` 对 read 为 false（不产生审批台账） | 包内用例 + `grep -rn` 禁项 + repo-rules 扫描 |
| AC-8 | P0 | 登记不放宽挂载语义：`apply()` 的 fail-closed 仍只要求 3 个只读动作；目录缺 judge（其余 3 条在）时插件仍能挂载，判定降级 `denied`（`unregistered-action`）而非挂载失败；`missing` 列表与错误码不变 | entry/patch-mount 用例（保留原「3 条只读」断言） |
| AC-9 | P0 | 宿主加载入口与分发白名单：`package.json.dsh.bundle.patch === "./cordis.patch.yml"` 且文件存在；补丁两行 `name` 逐字等于 `@heluo/forge-policy` / `@heluo/forge-gitee`（包根名，非子路径）；`files === ["src","cordis.patch.yml","README.md"]`，`npm pack --dry-run` 清单含 `cordis.patch.yml` | `npm pack --dry-run --json` + `tests/bundle-gitee.test.mjs` |
| AC-10 | P0 | 依赖协议与产物闭包：解出的产物 `package/package.json` 无 `workspace:`（`node -e "const s=require('fs').readFileSync('package/package.json','utf8');process.exit(/workspace:/.test(s)?1:0)"` 退出码 0）、`dependencies["@heluo/forge-policy"]` 为真版本且 `bundledDependencies` 含它、该成员真实进包；不新增 `@deepseek-ai/*`/`react` 真实依赖（无 peer 或仅 peer + optional）；源清单 `workspace:*` 只存在于工作区（ADR-12） | `tests/bundle-gitee.test.mjs` + tar 内 package.json |
| AC-11 | P0 | 构建产物与源码同步：`buildBundle({entry:"@heluo/forge-gitee", destination:"dist/r7"})` 成功（构建器拒绝覆盖既有产物，故用新目录、不删旧 tarball）；产物 `package/cordis.patch.yml` 含 `gitee.delivery.judge`；`package/src/index.mjs`、`package/src/gitee-actions.mjs` 与工作区 sha256 逐字节一致；产物不含 test/lib/dist | `node --test tests/bundle-gitee.test.mjs` + sha256 + `tar -tf` |
| AC-12 | P0 | 装载安全：未注入宿主服务的环境下可导入产物入口（`node --input-type=module -e "await import('file:///<staged>/src/index.mjs')"` 退出码 0），顶层不访问未注入的 `ctx.settings`/`ctx.get`；缺 `ctx.get("policy")` 时 `apply()` 抛可读错误而非进程崩溃 | 退出码 0 断言 |
| AC-13 | P0 | 真实装入（**安装由主 agent 执行**；本机探测：DSH_HOME=`~/.dsh`，profile `web` = `~/.dsh/profiles/web`，`dsh` 不在 PATH → 手动步骤）：① 旧包预检 `shasum -a 256 ~/.dsh/artifacts/heluo-forge-gitee/heluo-forge-gitee-0.1.0.tgz` = `a0a506f3ee300030b7bc94f4e04e1c1d4e173e30749299f6a01b58843d92092c`（回滚点，勿删）；② `cd ~/.dsh/profiles/web && pnpm remove @heluo/forge-gitee`；③ `pnpm add file:<仓库根>/dist/r7/heluo-forge-gitee-0.1.0.tgz`（`<仓库根>` 由验收人按 `pwd` 回填；PRD 不写死宿主路径）；④ 复核：profile `package.json.dependencies["@heluo/forge-gitee"]` 指向新路径、`dsh.profile.bundles` 仍含 `@heluo/forge-gitee`、`node_modules/@heluo/forge-gitee/cordis.patch.yml` 含 `gitee.delivery.judge`、包内 `src/gitee-actions.mjs` sha256 = 工作区、pnpm 退出码 0；⑤ 任一步失败 → 立即执行 AC-14 | 上述命令 + 输出留档 |
| AC-14 | P0 | 回滚先行且可执行（步骤在 AC-13 执行前写明）：`pnpm remove @heluo/forge-gitee && pnpm add file:~/.dsh/artifacts/heluo-forge-gitee/heluo-forge-gitee-0.1.0.tgz`；复核 `dependencies` 回到旧路径、`bundles` 含包名、`node_modules/@heluo/forge-gitee/cordis.patch.yml` 不含 `gitee.delivery.judge`；重启后判定重新 `denied`（旧行为）、8 个工具仍在、宿主可启动 | 同 AC-13 |
| AC-15 | P0 | 宿主真实加载（**NOT RUN**，验收后由主 agent 补证）：重启宿主后新会话工具列表出现 8 个 `forge_gitee_*`；判定工具不再返回 `unregistered-action`；启动日志无该包加载错误。本轮 QA 只给步骤与判据，不写「已加载」 | 工具列表 + 启动日志 |
| AC-16 | P1 | 文档同口径：`packages/forge-gitee/README.md`（形态表、工具表默认列、策略目录段、共存并层、回滚段、测试覆盖句）、`docs/design/plugins/forge-gitee.md`（§1 边界、§6 策略目录、§11 打包/共存、§12 未决）、`docs/design/README.md` 状态行、r7 `TECHNICAL.md` 全改为「目录 4 条（3 读 + 1 只读判定 + 4 受控写）；判定默认登记、写仍 denied」；并层形态 7→8 条目录、17 个工具不变；`grep -rn "3 条 kind: read\|3 条只读\|五个受控动作.*不登记\|5 个写工具逐个 denied\|5 受控写\|5 个受控写" README.md docs/design packages/forge-gitee/README.md docs/teamflow/20261030-r7-judge-default-catalog` 零命中（r4 之外的历史任务夹、r4 的「r7 修订」标注行除外） | grep 零命中 + check-docs |
| AC-17 | P1 | r4 任务夹四份全部同步：`docs/teamflow/20261029-r4-forge-gitee/` 下 `PRD.md`、`QA-REPORT.md`、`ACCEPTANCE.md`、`TECHNICAL.md` 中「默认 catalog 3 条只读 / 5 个受控动作全部 denied」类表述改为「3 读 + 1 默认可用判定 + 4 个受控写仍 denied」；每处改动旁保留「r7 修订」标注并写明原文当时的结论（如「r7 修订：原文结论为 3 条只读、5 个受控动作全部 denied」）；原结论原文与证据编号不得删除，改后不得残留冲突口径；r7 PRD 头已声明取代 r4#AC-7/#AC-17，并记录用户已接受覆盖 ADR-0008 | grep r4 夹旧口径零命中（「r7 修订」引用行除外）+ diff 审阅 + 链接可达 |
| AC-18 | P0 | 门禁不降：`pnpm check` 全绿（docs/repo/tarball/dsh 版本、`node --test` 全通过；用例数 ≥ 本轮基线且只增不减、0 skip）；`git diff --check` 无输出；包级 `node --test "packages/forge-gitee/test/*.test.mjs"` 全通过；repo-rules 安全扫描（唯一 `execFile` 出口、src 零 `spawn`/`exec`/`shell:true`、禁项表）未放宽 | 命令输出逐条留档 |
| AC-19 | P0 | 证据纪律：QA-REPORT 每条证据写命令/时间/宿主版本（本机 dsh 0.2.1-rc.2、`dsh` 不在 PATH）/目标对象/来源类型；真实 install+重启（AC-13/15）、真实企业 Gitee CLI、Windows/麒麟标 `NOT RUN`；mock/离线不写成企业已验 | 证据表审阅 |
| AC-20 | P1 | 交付面干净：`git status --short` 只含预期改动（r7 任务夹、包源码/测试/文档、必要夹具），不出现 tgz、node_modules、`logs/`、`dist/`；构建产物落 `dist/r7` 且被既有 `.gitignore`（`dist/`、`*.tgz`）覆盖；若确需新产物路径，先补 `.gitignore` 再加产物 | `git status --short` + `git check-ignore` |

## 7. 依赖与风险

- **策略目录语义**（依赖 `@heluo/forge-policy`）：`kind ∈ {read,write,confirm}`、target 非空、`egress ∈ {allow,confirm,deny}` 默认 `confirm`；门禁统一以 `platform-write` 发起裁决 → 判定条目必须显式 `egress: "allow"`，否则裁决为 `confirm/egress-confirm`，不满足 AC-2 的 `rule === "registered-action"`。这是本需求唯一的策略层适配点。
- **审计舱**：`executeAction` 的 `prepare` 需要审计 provider；默认 memory sink 满足，判定同样留审计（只读也审计），不因此放宽或新增台账。
- **同版本重装**：新旧 tarball 都是 `0.1.0`，pnpm 可能视为未变 → 必须 `remove` 后 `add`（AC-13），不要试图靠 `add` 覆盖。
- **重启打断会话**：重启宿主会中断当前流水线 → 留到验收后由主 agent 在独立窗口执行（AC-15 NOT RUN）。
- **r4 历史夹**：用户已裁决四份全改并接受覆盖 ADR-0008 的「任务夹不可变」；做法是就地修订 + 每处「r7 修订」标注并保留原结论。风险在于标注不清会让读者把修订当原验收结论 → 判据见 AC-17，标注必须同时写明原结论。
- **部分目录**：并层若只带 3 条（手工配置漏 judge），判定回落 `denied`，属预期 fail-closed，文档需写明而不是当缺陷。

## 8. 工程约束

- 交付说明必须写清：本机 `web` profile 当前装的是旧 tarball（`heluo-forge-gitee-0.1.0.tgz`，sha256 `a0a506f3ee300030b7bc94f4e04e1c1d4e173e30749299f6a01b58843d92092c`），验收后需要重新打包（`buildBundle({entry:'@heluo/forge-gitee'})`）并重装才能生效；给出重装与回滚命令。
- 分支与工作区：当前 `feat/devops-change-flow`；未提交改动仅 `?? docs/teamflow/20261030-r7-judge-default-catalog/`。本阶段不新建/切换分支，不提交、不推送；保留他人未提交改动，不用 `git reset --hard`/`git checkout --` 清除。
- 文档边界：只写 `docs/teamflow/20261030-r7-judge-default-catalog/`；不写宿主 `docs/<role>/`；`logs/teamflow/<runId>/` 只放检查器/笔记，不落命令输出；`AGENTS.md` 除托管区外不动，不追加 changelog（约定/待办进 `docs/teamflow/memory.md`）。**例外（用户明确授权）**：r4 任务夹四份可就地修订，必须带「r7 修订」标注并保留原结论，覆盖 ADR-0008 的不可变约定。
- `.gitignore` 审计：现有规则已覆盖 `dist/`、`*.tgz`、`node_modules/`、`.pnpm-store/`、`coverage/`、`logs/`、`.env*`、`*.log`；本轮构建产物落 `dist/r7`（已忽略），不提交 tgz；若引入新产物/缓存路径，同批补 `.gitignore`。
- 验证：仓库根 `pnpm check` + `git diff --check`；包级 `node --test "packages/forge-gitee/test/*.test.mjs"`；不得降低、跳过或缩小任何既有门禁（含 repo-rules 安全扫描）。
- 安装不归流水线子代理：`~/.dsh`（DSH_HOME）在工作区外，由主 agent 按 AC-13/14 执行，失败立即回滚；子代理只产出命令、判据与证据表。

## 9. 里程碑建议

M1（P0）目录 + 判定可用 + 写仍 denied（AC-1/2/3/7/8）；M2（P0）测试与变异（AC-4/5/6）；M3（P1）文档与 r4 标注（AC-16/17）；M4（P0）构建命令与证据（AC-9–14、18–20）；M5（验收后）主 agent 装入 + 重启 + 补证（AC-15）。

## 10. 假设与待澄清

三项原待澄清已由用户裁决，现为固定约束，不再作为问题：
- （已裁决·事实）判定条目 `target` 逐字取 **`change`**：写入补丁层目录、README 工具表与解释文档，不写 `delivery` 或其他等价串。
- （已裁决·主观）r4 任务夹四份全部改：`PRD.md`、`QA-REPORT.md`、`ACCEPTANCE.md`、`TECHNICAL.md` 都与改造后事实一致；每处保留「r7 修订」标注并写明原结论；用户已知悉并接受覆盖 ADR-0008 的「任务夹不可变」约定。
- （已裁决·主观）工具面措辞统一为「3 读 + 1 只读判定 + 4 受控写」，不再用「5 受控写」把判定也叫写。

本节无未决项。

## 11. 原 openQuestions（已全部关闭）

三条均已由用户裁决，内容见 §10；state `extra.openQuestions` 为空数组。
