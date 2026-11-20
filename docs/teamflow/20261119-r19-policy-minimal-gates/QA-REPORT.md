# QA-REPORT · r19 受控写最小门禁 P0

- 任务夹：`docs/teamflow/20261119-r19-policy-minimal-gates/`；唯一契约：`TECH-CHANGE.md`
- 判定：**可验收（acceptance-ready）**。P0/P1/P2 缺陷 0；P3 观察 3 条；无阻断项。
- 基线：分支 `main`，HEAD `a0e2485`；工作区未提交、未推送（59 项改动，仅本报告为 QA 新增）。
- 说明：本报告只写文档，未修改任何交付代码；状态块写入 `logs/teamflow/tf-mwniu67u-8knnv1/state/qa.json`（宿主读取，不进交付）。

## 1. 范围与对象

被测交付：r19「受控写最小门禁 P0」——`forge-policy` 配置模型与装载期校验（`src/config.mjs`）、阶段生成（`src/pipeline.mjs`）、审计恒开与 file sink、gate/installer 收缩、删除 `confirmations/delegation/egress/scope-ticket` 四模块及同名用例、`forge-devops`/`forge-gitee` 消费面与自检适配、四层 `cordis.patch.yml`、根门禁与探针同步。

变更规模（`git status --porcelain --untracked-files=all`）：59 项 = 45 修改 / 8 删除 / 6 新增（任务夹文档 + `src/config.mjs`、`src/pipeline.mjs` + 3 个新测试）。本次状态切片未注入「交付形态契约」，按 `TECH-CHANGE.md` §5 验证计划执行。

## 2. 测试环境

| 项 | 值 |
|---|---|
| 平台 | macOS Darwin arm64 |
| Node | 默认 `v24.13.0`；仓库 `.node-version` 为 `v24.21.0`（全量回归使用 pinned 版本） |
| pnpm | 11.28.5 |
| 仓库 | `heluo-forge` 工作树，HEAD `a0e2485`，分支 `main` |
| DSH 宿主 | CLI 可用（`/opt/homebrew/bin/dsh`，运行版本 0.2.1-rc.5）；仓库 `.dsh-version` 为 0.2.1-rc.3 |
| UI | 本交付无 `client.js`/`tsx`/`vue`/`css` 改动 → 无 UI 交付；沙箱内浏览器不可启动，且本交付不需要 |

默认 Node 24.13 与 pinned 24.21 的差异只影响既有 `packages/forge-iam/test/bridge-real-provider.test.mjs`（详见 §3.4），与本交付无关。本机 `~/.dsh/profiles/web` 存在 2026-10-28 手工 UAT 段（`docs/teamflow/memory.md:22`），真实冷启动前必须清理，见 §7。

## 3. 用例与结果

### 3.1 汇总表

| 编号 | 检查项 | 命令（摘要，完整命令见附录 A） | 结果 |
|---|---|---|---|
| E-01 | 全量回归 | `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm check` | **exit 0**：4358 tests / 4355 pass / **0 fail** / 3 skipped / 65.1s（含 link-workspace、check-docs、check-repo、check-skills、check-bundle-tarballs、dsh-version check） |
| E-02 | policy 套件 | `cd packages/forge-policy && node --test "test/*.test.mjs"` | exit 0：261 pass / 0 fail / 0 skip |
| E-03 | devops 套件 | `cd packages/forge-devops && node --test "test/*.test.mjs"` | exit 0：565 pass / 0 fail / 0 skip |
| E-04 | gitee 套件 | `cd packages/forge-gitee && node --test "test/*.test.mjs"` | exit 0：356 pass / 0 fail / 0 skip |
| E-05 | 补丁层 + IAM 消费 | `node --test tests/plugin-patch-layers.test.mjs tests/iam-consumption.test.mjs` | exit 0：25 pass / 0 fail / 0 skip |
| E-06 | 安装/升级/回滚/卸载排练 | `node scripts/probe/run-bundle-install-rehearsal.mjs` | exit 0：36/36 步骤；真实 Cordis/Loader 装入、升级、回滚、卸载走到终态，仓库工作树未被改动 |
| E-07 | 主路径执行证明（0a2） | `node logs/teamflow/tf-mwniu67u-8knnv1/scripts/qa-r19-mainpath.mjs` | exit 0：6/6（明细见 §3.2） |
| E-08 | 接口一致性（0a） | `node logs/teamflow/tf-mwniu67u-8knnv1/scripts/qa-r19-interface.mjs` | exit 0：19 个交付源文件、172 个具名导入命中；service 17 成员、消费方 22 处调用、0 悬空 |
| E-09 | 用例只增不减地板 | `node logs/teamflow/tf-mwniu67u-8knnv1/scripts/qa-r19-test-floor.mjs` | exit 0：修改 18 个测试文件、新增 3 个（18 个顶层用例块）、删除 4 个契约允许的旧模块用例；净 -40 块全部来自这 4 个删除文件；新增行 0 skip |
| E-10 | 六层配置校验正反向 | 附录 A-1 的 `Config['~standard'].validate` 探针 | exit 0：一次返回恰 6 条 issue，全部带键路径（catalog[1].action、rules.confirmPush、rules.unknownRule、paths.append、audit.sink、audit.buffer） |
| E-11 | 契约 grep | 附录 A-2 | approval 0、child_process/spawn 0、permission/sandbox 0、catalog enabled 0、已删模块/导出引用 0、digestContent 定义 1 |
| E-12 | 补丁层真实组合 | `dsh --profile web --patch packages/forge-devops/cordis.patch.yml --patch packages/forge-gitee/cordis.patch.yml --dump-config` | exit 0：两层 `heluo-policy` 均携带新 6 条 `action/target/category` 目录（无 `enabled`/`permission`/`sandbox`/`rules`） |
| E-13 | 提交面卫生（0c） | `git status --porcelain --untracked-files=all` + `git diff --check` | 59 项中无 dist/node_modules/.tgz/logs/.idea/.env（logs/ 被 `.gitignore:86` 忽略）；`git diff --check` exit 0 |
| E-14 | 探针脚本语法 | `node --check scripts/probe/host-probe-plugin.mjs` 等 3 个文件 | 3/3 OK |
| E-15 | skip 归因 | 复跑 TAP 明细（见 §3.3） | 3 条全部为未改动文件中的既有条件跳过；新增用例 0 skip |

### 3.2 主路径执行明细（E-07，6/6）

1. **全关装配**：恰好一条 observe-only 告警、目录 6 条受控写、零审计——「全关只多一条审计、不新增拦截」。
2. **受控写全链**：`pre → guard → post` 一次放行，恰好一条 begin + 一条 settle，`actor=user-a`、`rule=registered-write`，调用正文不入审计；读工具按 out-of-scope 放行且不写审计（D22/D23）。
3. **身份缺失**：无 IAM actor 的受控写被拒绝（reason 含 IAM/身份）且零审计；只读调用仍放行。
4. **八开关 fail-closed**：逐个置 `true` 均装载期拒绝，报 `rules.<key>` 与 “not implemented”，且不残留 guard。
5. **file sink**：在 `$DSH_HOME/logs/forge-policy-<date>.jsonl` 落 begin/settle 两行，memory 为空、未降级。
6. **sink 写失败**：受控写中止，文案不含「审计」二字与绝对路径，符合「失败面零泄漏」。

### 3.3 3 条 skip 归因（非交付缺陷）

| skip 用例 | 文件是否被本交付改动 | 原因 |
|---|---|---|
| host-probe 两例（`target DSH honours...`） | 否（仅 `scripts/probe/*` 被改） | 宿主运行版本 0.2.1-rc.5 ≠ `.dsh-version` 0.2.1-rc.3，属 K-1 既有条件跳过；可用 `DSH_HOST_PROBE_FORCE=1` 强制 |
| `Windows 8.3 aliases...` | 否 | 平台条件（非 win32）跳过 |

### 3.4 默认 Node 版本差异（环境说明，非缺陷）

默认 Node v24.13.0 运行 `pnpm check` 时，`packages/forge-iam/test/bridge-real-provider.test.mjs` 的 stderr 空断言命中 Node 自带的 `(node:NNN) ExperimentalWarning: SQLite is an experimental feature...`。该文件未被本交付改动；用仓库 `.node-version` 的 v24.21.0 单跑该文件 15/15 通过，且 pinned 版本全量回归 0 fail。仓库已固定 24.21.0，故不构成本交付缺陷。

## 4. 接口一致性检查（0a，静态 + 动态导入）

- 方法：`qa-r19-interface.mjs` 对本次交付改动涉及的 19 个 `src`/`scripts` 源文件做具名 import/export 解析，逐个 `import()` 目标模块后校验符号真实存在；再从 `installer.mjs` 抽取冻结 service 成员，扫描 `forge-devops`/`forge-gitee` 源码中的 `policy.<member>`。
- 结果（exit 0）：172 个具名导入命中；service 17 个成员（catalog/actions/decide/authorize/protectedPaths/checkPath/orgPolicy/policyVersion/mode/contentRuleIds/setAuditSink/auditRecords/auditGaps/acknowledgeAuditGaps/auditDegraded/executeAction/registerCommand/observations）；消费方 22 处调用全部命中，**0 悬空**。
- 参数形状：`gate.mjs:267` 的 `executeAction(ctx, action, exec, operation)` 与 `installer.mjs:253` 的转发签名一致；消费方 `devops/src/index.mjs`（读、`change update`）、`gitee/src/index.mjs`（读）、`gitee/src/gitee-guard.mjs` 均按该四参调用；`policy.decide({action,target,egress})` 与 `installer.mjs:238` 的 `decideAction({catalog, rules, ...request})` 兼容。运行时由 E-03/E-04 实际执行覆盖。
- 结论：不存在「文件存在但调用面已死」的问题。

## 5. 架构检查（M3 质量门，轻量）

- **契约要求的抽象已落地**：配置模型与装载期校验集中在 `packages/forge-policy/src/config.mjs`；阶段装配集中在 `src/pipeline.mjs`；`gate.mjs` 收缩为宿主适配器（准入/审计/收据），`installer.mjs` 只做 resolveConfig → sink → pipeline → gate → provide。与 `TECH-CHANGE.md` §7 假设 4 的模块边界一致，无该抽未抽。
- **无重复实现**：`digestContent` 唯一定义于 `content-rules.mjs:39`（`gate.mjs:11/38`、`iam-consumer.mjs:1/92/123` 引用，`index.mjs:19` 再导出）；审计字段白名单/路径脱敏集中在 `audit.mjs`；拒绝文案集中在 `gate.mjs`。未发现多处安全包装/适配器漂移。
- **结构无破坏**：删除四模块后 `packages`/`tests`/`scripts` 无残留引用（E-11）；四个包均可被动态 import；无跨包相对源码导入。
- **有意取舍**：`org-policy` 停用保留、gate 不再应用 org ceiling（计划 D13 明确「停用保留代码，不接」），installer 仍按组织信封的 `require_durable_audit` 强制 file sink——与计划一致，非偏差；`docs/design` 未同步，见 P3-2。
- 结论：架构检查通过，无需返工项。

## 6. 缺陷表

**未发现 P0/P1/P2 缺陷。** 以下 3 条为 P3 观察（不阻断验收）：

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| P3-1 | P3 | 文档（契约示例） | 打开 `TECH-CHANGE.md` §3.1 示例，与 `classify.mjs` 内置动作逐条对比 | 示例 target 与内置值逐字一致，部署者可直接抄用 | 示例写作 `pr`/`review`/`clarification`/`git`/`review`，内置值为 `pull-request`/`change`/`repository`；照抄示例会在装载期被 catalog 校验拒绝（实际四层补丁与实现正确） | TECH-CHANGE §3.1、§5「catalog 6 条逐字一致」 | `grep -n "target: 'pr'" docs/teamflow/20261119-r19-policy-minimal-gates/TECH-CHANGE.md` | 修好后该命令无输出，示例 target 全部等于 `packages/forge-policy/src/classify.mjs` 内置值 |
| P3-2 | P3 | 文档（设计索引） | 在 `docs/design` 检索已删除的 delegation/confirmations | 设计文档不再引用已删除模块，或已注明「r19 删除」 | `docs/design/plugins/forge-policy.md` 仍有 delegation 章节与 `delegation.mjs` 覆盖率引用（约 :304-320）；`docs/design/policy-model.md:178-179` 仍指向 `delegation.mjs`/`confirmations.mjs`；不在 TECH-CHANGE §2 影响表内，计划第 263-270 行列后续文档工作 | TECH-CHANGE §2（范围外追赶项） | `grep -rn -e "delegation" -e "confirmations" docs/design/plugins/forge-policy.md docs/design/policy-model.md` | 修好后该命令 0 输出，或命中行均带「r19 已删除」说明 |
| P3-3 | P3 | 代码注释（devops） | 读 `packages/forge-devops/src/policy-guard.mjs:15` | 注释与新 gate 行为一致（读动作 out-of-scope 经 `executeAction` 也不审计） | 注释仍称「绕过 executeAction 就等于开了一条没有审计的旁路」，对读动作已不成立；代码行为正确 | TECH-CHANGE §4（行为兼容性说明） | `sed -n '15p' packages/forge-devops/src/policy-guard.mjs` | 修好后注释不再把 `executeAction` 描述为对所有动作都产生审计 |

补充说明（非缺陷）：

- 审计落盘为一次受控调用的 begin/settle 两条 phase 记录（用例与 mainpath 均断言「恰好一条 begin + 一条 settle」），与 §3.2 的 begin/finish 两阶段定义一致；「一条审计」按一次审计事务理解，建议后续契约措辞统一（仅观察）。
- 3 条 skip 均为未改动文件的既有条件跳过，非本交付引入（§3.3）。

## 7. 人工补测清单（环境限制，非交付缺陷）

| 编号 | 项目 | 方法 / 工具 | 说明 |
|---|---|---|---|
| H-1 | 真实宿主冷启动 + profile 装入 | 先按 `docs/teamflow/memory.md:22` 清理 `~/.dsh/profiles/web` 的 2026-10-28 手工 UAT 段，再以 `dsh --profile <新 profile> --patch packages/*/cordis.patch.yml` 装入并启动，观察日志中 observe-only 告警与零拦截 | 本沙箱只能做 dump-config 与隔离 loader 排练；真实进程冷启动未执行 |
| H-2 | 真实 profile 安装 / 卸载 / 回滚 | `dsh plugin --profile <p> add <tarball>` + 仓库卸载命令 `pnpm uninstall:devops --profile <p>`；验证补丁层只删本插件条目、旧格式段不被误删 | rehearsal 在隔离 `DSH_HOME` 覆盖了装/升/回滚/卸载，真实用户 profile 未跑 |
| H-3 | 企业 IAM 实机联调 | 企业 IAM 授权后执行受控写，确认 actor 解析与拒绝文案 | 本机仅有合成 fixture，未做企业联调 |
| H-4 | file sink 失败面实机 | 只读目录 / 磁盘满场景下执行受控写，确认中止且文案无「审计」与绝对路径 | 脚本已用内存/临时目录模拟，真实文件系统异常未跑 |
| H-5 | P1 确认卡与交互 E2E | 宿主 `ctx.userQuestions` 卡片 | TECH-CHANGE §3.3 阶段 8 明确本 PR 未实现，**NOT RUN by design** |
| H-6 | 浏览器 / 视觉验收 | 截图、设置页目视检查 | 本交付无 UI 文件改动，**N/A**；且沙箱内浏览器不可启动（环境限制） |

## 8. 结论

**可验收。** 无 P0/P1/P2 缺陷、无阻断；交付在可执行层面已证明主路径工作：全量 `pnpm check`（pinned Node 24.21.0）0 fail、定向三包 1182 条用例全绿、安装排练 36/36、主路径 6/6、接口一致性 0 悬空、契约 grep 全 0、`git diff --check` 干净、提交面无构建/依赖/日志污染。

残余风险与未验证项：真实宿主冷启动与真实 profile 装/卸（H-1/H-2）、企业 IAM 与 file sink 实机失败面（H-3/H-4）、P1 确认卡（H-5，本 PR 范围外）；本机 `web` profile 的旧 UAT 段需在真实冷启动前清理。3 条 P3 为文档/注释观察，可在后续文档同步中一并处理，不影响验收。

## 附录 A：完整命令

A-1 六层配置校验探针（E-10）：

```bash
node --input-type=module -e "import {Config} from './packages/forge-policy/src/config.mjs'; const r=Config['~standard'].validate({catalog:[{action:'gitee.issue.write',target:'issue',category:'dev-write'},{action:'gitee.issue.write',target:'issue',category:'dev-write'}],rules:{confirmPush:true,unknownRule:true},paths:{append:'x'},audit:{sink:'disk',buffer:0}}); console.log(r.issues.length); r.issues.forEach((i)=>console.log(i)); process.exit(r.issues.length===6?0:1)"
```

A-2 契约 grep（E-11）：

```bash
grep -rn 'approval' packages/forge-policy/src
grep -rnE 'child_process|spawn\(' packages/forge-policy/src
grep -rnE 'permission:|sandbox:' packages/*/cordis.patch.yml
grep -rn 'enabled:' packages/*/cordis.patch.yml
grep -rnE 'src/(confirmations|delegation|egress|scope-ticket)' packages tests scripts
grep -rnE 'forge-policy/(confirmations|delegation|egress|scope-ticket)' packages tests scripts
grep -rn 'export function digestContent' packages
```

A-3 接口 / 主路径 / 地板检查器：`node logs/teamflow/tf-mwniu67u-8knnv1/scripts/qa-r19-interface.mjs`、`qa-r19-mainpath.mjs`、`qa-r19-test-floor.mjs`（本次新增，运行完留存于运行日志目录，由宿主归档）。

A-4 全量回归：`PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" pnpm check`（仓库 `.node-version` = 24.21.0；默认 24.13.0 的差异见 §3.4）。
