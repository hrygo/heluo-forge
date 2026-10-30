# r7 · Gitee 交付判定默认登记（read-only judge）· 验收报告

- 需求夹：`docs/teamflow/20261030-r7-judge-default-catalog/`
- 验收对象：把 `gitee.delivery.judge` 随包登记为**默认可用的只读判定**（补丁层目录 3→4 条），四个受控写仍默认 `denied`，工具面 8 个、名字与顺序不变
- 分支：`feat/devops-change-flow`（未提交：17 个已改文件 + 2 个未跟踪项，未做任何提交/推送/合并）
- 验收时间：2026-10-30 22:05–22:12 CST
- 角色边界：只判定，不关闭、不合并、不发布；真实装入 / 宿主重启（AC-13/15）按 PRD 由主 agent 在验收后执行，本报告标 **NOT RUN**

## 1. 环境与证据口径

| 项 | 值 | 来源类型 |
|---|---|---|
| 平台 / 架构 | darwin arm64，macOS 26.5.1 | 实测 `sw_vers` / `uname` |
| Node | v24.13.0 | 实测 `node -v` |
| 宿主 DSH | 0.2.1-rc.2；`dsh` **不在 PATH** ⇒ 装入/重启步骤只能由主 agent 手动执行 | 实测 `command -v dsh`（QA-REPORT §1 同结论） |
| 证据来源 | 本轮**独立复跑**全部关键命令（不只采信 QA 结论），命令 + 结果逐条列在 §2 | 实测 |
| 标 `NOT RUN` | AC-13 真实装入、AC-14 回滚执行、AC-15 重启加载；企业 Gitee CLI、Windows/麒麟实机 | — |

## 2. 逐条验收（PRD 共 AC-1 … AC-20）

| AC | 判据（摘要） | 验收实测命令与结果 | 结论 |
|---|---|---|---|
| AC-1 | 补丁层 `config.catalog` 恰 4 条：3 读 + 1 判定；判定 `kind: read`、`target` 逐字 `change`、`egress: allow`、`enabled: true`；0 条 write | `grep -nE "^\s*-\s*\{ action:" packages/forge-gitee/cordis.patch.yml` ⇒ 4 行（`:56`–`:59`）；`:59` 为 `{ action: 'gitee.delivery.judge', kind: 'read', target: 'change', enabled: true, egress: 'allow' }`；无 write 行 | ✅ |
| AC-2 | 真补丁层 + 真策略装配下判定默认可用：`done`/`rule: ready`/`readback_ok`/`executed: false`/`remote_calls: 0` | `node logs/teamflow/tf-mvutl9xh-fjab7l/scripts/t1-judge-default-envelope.mjs` ⇒ exit 0；`judgeDecision{allow, registered-action}`、`judgeEnvelope{status: done, rule: ready, ok: true, executed: false, remote_calls: 0, readback_ok: true}` | ✅ |
| AC-3 | 4 个写工具仍 `denied` + `unregistered-action`；门禁 operation 只含判定 | 同上探针 ⇒ `writeStatuses` 4 项全 `denied`，`gateOperations: 1`、`gateActions: ["gitee.delivery.judge"]`；四封信封无 `executed` 键 | ✅ |
| AC-4 | 断言名含「默认登记判定、不默认登记写」；删 judge 行变异必红、还原 sha256 一致、复跑绿 | `packages/forge-gitee/test/patch-mount.test.mjs:243` 断言名逐字命中；`node logs/teamflow/tf-mvutl9xh-fjab7l/scripts/mutation-judge-default.mjs` ⇒ exit 0，两腿均 `baselineExitCode 0 → mutatedExitCode 1 → restoredExitCode 0`、`restoredIdenticalToBackup: true`、`afterHashStable: true` | ✅ |
| AC-5 | `criteria` 含 unknown → `status: unknown`、固定 reason、不计通过 | `node --test packages/forge-gitee/test/actions.test.mjs` ⇒ 22/22 pass，含 `AC-5: criteria 含 unknown → status unknown、固定 reason、不计通过` | ✅ |
| AC-6 | 缺参 / 非法入参 fail closed，零策略、零子进程、零平台调用 | 同上 ⇒ 含 `AC-6: 判定缺参/非法入参 fail closed——零策略、零子进程、零平台调用`，0 失败 | ✅ |
| AC-7 | 判定零副作用：适配器 0 次、`remote_calls 0`、`executed false`、无 close/merge 通道 | 探针 `executed: false` + `remote_calls: 0`；`grep -rn "child_process" packages/forge-gitee/src` ⇒ 仅 `gitee-cli.mjs`（唯一 execFile 出口）与 `gitee-adapter.mjs` 注释（适配器自身不 import）；判定路径未触达适配器 | ✅ |
| AC-8 | 挂载 fail-closed 仍只要求 3 读；缺 judge 时挂载成功、判定降级 `denied` | 探针 `ac8` 段 ⇒ `{mounted: true, catalogSize: 3, judgeStatus: denied, judgeRule: unregistered-action, gateOperations: 0}` | ✅ |
| AC-9 | `dsh.bundle.patch` 指向补丁层；两行 `name` 用包根名；`files` 含 `cordis.patch.yml` | 产物 `package.json` 解包：`dsh.bundle.patch = ./cordis.patch.yml`；`files = ["src","cordis.patch.yml","README.md"]`；补丁层 `name` 为 `@heluo/forge-policy` / `@heluo/forge-gitee`（无子路径） | ✅ |
| AC-10 | 产物无 `workspace:`；依赖真版本且随包闭包 | 产物 `package.json`：`/workspace:/` = false；`bundledDependencies = ["@heluo/forge-policy"]` | ✅ |
| AC-11 | 重建 `dist/r7`；产物含 judge 条目；源文件 sha256 逐字节一致 | `dist/r7/heluo-forge-gitee-0.1.0.tgz`（121694 B，21:59 重建）；`tar -xzOf … package/cordis.patch.yml` ⇒ 含 `:59` judge 行（`target: 'change'`、`egress: 'allow'`）；5 个文件 sha256 与工作区一致：`gitee-actions.mjs 035d23d7…`、`gitee-delivery.mjs 62f8721a…`、`gitee-tools.mjs 774f510f…`、`index.mjs d57788a1…`、`cordis.patch.yml 8a58d702…` | ✅ |
| AC-12 | 产物入口可导入（exit 0），顶层不碰未注入 ctx | 解包到 `/tmp/acc-gitee` 后 `node -e "import('/tmp/acc-gitee/package/src/index.mjs')"` ⇒ `entry ok forge-gitee 8`（`GITEE_TOOLS` 8） | ✅ |
| AC-13 | 真实装入 profile（主 agent 执行） | **NOT RUN**；步骤见 PRD AC-13 ①–⑤ 与 §5 #1 | NOT RUN |
| AC-14 | 回滚先行且可执行（旧 tarball sha256 `a0a506f3…92092c`） | **NOT RUN**（依赖 AC-13 同环境）；命令与判据见 §5 #2 | NOT RUN |
| AC-15 | 宿主重启后 8 工具出现、判定不再 `unregistered` | **NOT RUN**（PRD 明示本轮不写「已加载」）；步骤见 §5 #3 | NOT RUN |
| AC-16 | README / design / 设计索引 / r7 TECHNICAL 统一「3 读 + 1 只读判定 + 4 受控写」；旧口径零命中 | 正向：该短语命中 `packages/forge-gitee/README.md`×2、`docs/design/plugins/forge-gitee.md`×1、`docs/design/README.md`×1、r7 `TECHNICAL.md`×2；反向：`grep -rn "5 个受控写\|5 受控写\|五个受控动作\|5 个写工具\|3 条只读"` 在上述四份 + 补丁层 + `src/` ⇒ **0 行** | ✅ |
| AC-17 | r4 四份就地修订、每处带「r7 修订」、原文与证据编号不删 | `node logs/teamflow/tf-mvutl9xh-fjab7l/scripts/check-r4-r7-annotations.mjs` ⇒ exit 0，标注数 `PRD.md=4 / QA-REPORT.md=4 / ACCEPTANCE.md=3 / TECHNICAL.md=13`，旧口径行 100% 同行或随后两行之内有「r7 修订」，冲突口径 0 | ✅ |
| AC-18 | `pnpm check` 全绿、用例只增不减、`git diff --check` 干净、安全扫描未放宽 | `pnpm check` ⇒ exit 0（docs ok / repo ok / bundles 8 packed 179 files ok / version ok / tests **1468，pass 1465，fail 0，skipped 3**）；本轮基线 1467 ⇒ +1 只增；`git diff --check` ⇒ 无输出、exit 0 | ✅（3 条为既有环境 skip，见 §5 #4） |
| AC-19 | 证据写命令/时间/宿主版本/来源类型；真实安装与真机标 NOT RUN | 本报告 §1/§2 与 QA-REPORT 证据表逐条满足；AC-13/14/15 与企业实机均标 NOT RUN | ✅ |
| AC-20 | `git status` 不含 tgz / logs / dist / node_modules；产物被既有 `.gitignore` 覆盖 | `git status --porcelain` ⇒ 17 modified + 2 untracked，噪声 grep（`\.tgz$\|logs/\|dist/\|node_modules`）**0 行**；`git check-ignore -v` ⇒ `dist/` 命中 `.gitignore:41`、`logs/` 命中 `.gitignore:81` | ✅ |

## 3. 架构一致性（M3 质量门禁）

| 复核点 | 结论 |
|---|---|
| 蓝图「权限事实只改补丁层」 | 遵守。唯一权限事实是 `packages/forge-gitee/cordis.patch.yml:59`，装配期由 `compileCatalog` 编译；源码无开关；`assertReadCatalog` 仍只要求 3 条只读动作（探针 `ac8` 证明缺 judge 不阻塞挂载） |
| 常量拆分（模块口径） | 与蓝图一致：`GITEE_WRITE_TOOLS` 4 项、`GITEE_JUDGE_TOOLS = ["forge_gitee_delivery_gate"]`、`GITEE_TOOLS` 8 项且顺序 = 3 读 → 4 写 → 1 判定（实测导入）；`service.writeTools()` 返回 4 项（`src/index.mjs:240`） |
| 信封边界 | 判定信封只在声明 `produced.executed` 时输出该键，四封写信封无 `executed`（探针逐个核对），未扩散成写契约变更 |
| 重复实现 / 适配器漂移 | 无。目录真源唯一（补丁层），判定与写在常量层各成一集合；未发现第二份目录副本或第二套工具清单 |
| 既有结构未被破坏 | 8 个工具名与顺序、四个门禁状态、四个写动作默认 `denied`、唯一 `execFile` 出口均不变；`gitee-guard.mjs` / 策略包零改动 |
| 返修（DEF-1）是否越界 | 未越界：只动 `src/gitee-delivery.mjs`（`conclusionOf` 归一 + 递归）与 `src/gitee-actions.mjs` 的描述文本，用于让模型面描述与实现接受面一致；门禁与放行语义零变化 |
| 蓝图措辞偏差（OBS-2） | `buildGiteeTools` 实际返回 8 条数组（蓝图写 `Record`），调用方按数组迭代、无功能影响；属文档措辞，非实现偏离 |
| 架构门禁结论 | **通过**：无「偏离蓝图 / 重复实现 / 该抽未抽 / 破结构」需要返工的项 |

## 4. 交付形态契约（9 条）

| # | 判据 | 实测 | 结果 |
|---|---|---|---|
| 1 | profile 层加载入口声明，入口 `name` 用包根名 | 补丁层两行：`@heluo/forge-policy`、`@heluo/forge-gitee`（无子路径） | ✅ |
| 2 | 入口声明文件进分发白名单 | 产物 `files` 含 `cordis.patch.yml`，产物内实测存在 | ✅ |
| 3 | 依赖协议可解析（无 `workspace:`） | 产物 `package.json` 正则 false | ✅ |
| 4 | 宿主运行期依赖按 peer/可选 peer | `src/` 无 `@deepseek-ai/*` 引用 ⇒ 无需 peer；`@heluo/forge-policy` 走 bundled | ✅ |
| 5 | 构建产物与源码同步 | 21:59 重建，5 个文件 sha256 逐字节一致（AC-11 同证据）；旧包改名 `.stale-before-def1-fix` 留证 | ✅ |
| 6 | 装载安全（顶层不抛错） | 产物入口 `import` exit 0 | ✅ |
| 7 | 能被真实 profile 装入 | 主 agent 执行 | NOT RUN |
| 8 | 装载后宿主真实加载 | 重启后核对 | NOT RUN |
| 9 | 安装必须带回滚 | 回滚命令在 README 与 PRD AC-14 写明（`remove` → `add` 旧 tarball，包名与 sha256 均从产物读） | ✅（文档面；执行 NOT RUN） |

## 5. 遗留与人工补测清单（验收后由主 agent 执行）

1. **AC-13 真实装入**（同版本重装必须 `remove` 后 `add`）：① `shasum -a 256 ~/.dsh/artifacts/heluo-forge-gitee/heluo-forge-gitee-0.1.0.tgz` 应为 `a0a506f3ee300030b7bc94f4e04e1c1d4e173e30749299f6a01b58843d92092c`（回滚点）；② `cd ~/.dsh/profiles/web && pnpm remove @heluo/forge-gitee`；③ `pnpm add file:<仓库根>/dist/r7/heluo-forge-gitee-0.1.0.tgz`；④ 复核 profile `dependencies` 指向新路径、`dsh.profile.bundles` 仍含包名、`node_modules/@heluo/forge-gitee/cordis.patch.yml` 含 `gitee.delivery.judge`、包内 `src/gitee-actions.mjs` sha256 = `035d23d7…`、pnpm 退出码 0；⑤ 任一步失败立即执行第 2 项。
2. **AC-14 回滚**：`pnpm remove @heluo/forge-gitee && pnpm add file:~/.dsh/artifacts/heluo-forge-gitee/heluo-forge-gitee-0.1.0.tgz`；复核 `dependencies` 回到旧路径、`bundles` 含包名、`cordis.patch.yml` **不含** `gitee.delivery.judge`、重启后判定重回 `denied`、8 个工具仍在、宿主可启动。
3. **AC-15 重启加载**：重启宿主后新会话工具列表出现 8 个 `forge_gitee_*`；`forge_gitee_delivery_gate` 不再返回 `unregistered-action`；启动日志无该包加载错误。仅在此之后才可对外声称「判定开箱可用」。
4. **AC-18 的 3 条 skip（P3，非本次引入）**：`bundle install/upgrade/uninstall/rollback rehearsal` ×2 与 `host probe` ×1 需要 `dsh` 在 PATH，本机取不到；用例总数 1467→1468 只增不减、0 失败。要在 CI/装有 DSH 的环境复跑才算「0 skip」。
5. **文档卫生（P3）**：`packages/forge-gitee/test/host-contract.test.mjs:6`、`test/helpers/fake-host.mjs:209` 的注释仍写「5 个写工具」（r4 期 D-1 事故的说明），不在 AC-16 覆盖面，仅注释、无契约影响；r7 任务夹内 10 处引述被取代措辞属 PRD 明示例外。
6. **工作区边界（P3）**：`?? TEAM-FULL-INSTALL.md` 是既有团队分发包说明，非本次交付产物；提交前由主 agent 确认是否纳入，本次未改动。

## 6. 验收意见

- 可运行的 17 条验收项（AC-1…AC-12、AC-16…AC-20）**逐条独立复核通过**，与 QA 第 2 轮结论一致；未发现 P0/P1/P2 缺陷，返修项 DEF-1 已由「描述取值整表 → `ready`」与 `actions.test.mjs` 回归用例双向闭合。
- 架构门禁通过：权限事实只在补丁层、判定与写在常量层各成集合、8 工具与门禁语义零改动，无需返工。
- 未闭合项只有 PRD 已明确划归验收后人工执行的 AC-13/14/15（NOT RUN）与 4 条 P3 观察项；它们不构成返工条件，但**在 AC-13/15 补证前，不得对外宣称「已装入企业 profile、判定开箱可用」**。
- 本次只做验收判定：未创建提交、未推送、未安装、未关闭任何 Issue/PR、未执行合并或发布。

验收结论：✅ 通过
