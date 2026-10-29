# QA-REPORT · r4 `@heluo/forge-gitee`（企业 Gitee 研发闭环插件）· 复核轮（round-2）

- 需求夹：`docs/teamflow/20261029-r4-forge-gitee/`；被测对象：新增独立包 `packages/forge-gitee`（3 读 + 5 受控写，25 条 AC）
- 本轮性质：**上轮 4 条缺陷的复核**（D-1 P0 / D-2 P1 声明已修，D-3 / D-4 声明未动），并补测上轮未覆盖的共存轴
- 结论：**可验收**。无 P0/P1/P2 未闭；D-1 与 D-2 在**真实宿主**（真 CLI + 真 loader + 真 profile）上复核通过，未复现；余 3 条 P3 观察项见 §5，其中 D-4 涉及 AC-24「宿主版本」一项的口径缺口，需验收方在签收时明确是否接受 `null` 降级

## 1. 范围与环境

| 项 | 值 |
|---|---|
| 工作区 | 本仓库根目录（下文相对路径以仓库根为基准），分支 `feat/devops-change-flow` |
| 运行时 | Node 24.13.0；`dsh` 0.2.1-rc.2（PATH 内，实测 `/…/.bin/dsh --version`）；`.dsh-version` 目标 0.2.1-rc.3，`node scripts/dsh-version.mjs check` exit 0 |
| 被测改动 | `packages/forge-gitee/{package.json,cordis.patch.yml,src/(11),test/(12+helpers)}`、`tests/bundle-gitee.test.mjs`、`tests/plugin-patch-layers.test.mjs`、`packages/forge-gitee/README.md`、`docs/design/{README.md,plugins/forge-gitee.md}`、`pnpm-lock.yaml`（含 `packages/forge-gitee:` importer） |
| 真实装载手法 | **隔离 `DSH_HOME`**（不触碰用户 profile）：`build-enterprise-bundle.mjs` 出 tgz → `dsh plugin --profile qa add <tgz>` → `dsh --profile qa --help` 起宿主读激活日志 → `dsh plugin --profile qa remove`（包名从产物 `package.json` 读取，不写死） |
| 复查器 | 全部在 `logs/teamflow/tf-mvtbtu9r-wyr782/scripts/`（上轮留下，本轮原样复跑；仅 1 个接口检查器因修复后挂载形状变化做了适配，见 §6） |
| 环境限制 | 真实浏览器不可用（宿主沙箱 token 限制，与本交付无关）；本交付无 UI 面，不涉及 |

## 2. 用例与结果（本轮实跑 16 组：通过 15 组、失败 1 组）

| # | 用例组 | 命令 | 结果 |
|---|---|---|---|
| 1 | 包内单测 12 文件（入口/补丁层/共存/配置/CLI/适配器/只读/会话/动作/守卫/审查/交付/宿主契约） | `node --test "packages/forge-gitee/test/*.test.mjs"` | PASS 171/171，exit 0 |
| 2 | 全仓门禁 | `pnpm check` | PASS 1391/1391，0 fail |
| 3 | 主路径端到端（真子进程：preflight→3 读→越界零子进程→5 写暂扣→done/reused） | `node logs/.../qa-r4-mainpath.mjs` | PASS 42/42（`TERMINAL ok`） |
| 4 | 跨模块接口一致性（import 符号/成员/参数形状/蓝图 api） | `node logs/.../qa-r4-interface-consistency.mjs` | PASS 55/55（imports 30 / port 成员 15 / 工具 8） |
| 5 | 交付形态 9 条静态面 + 凭据/文档纪律 | `node logs/.../qa-r4-shape.mjs` | PASS 23/23 |
| 6 | 审查与交付判定主路径（AC-18/19/20/21） | `node logs/.../review-delivery-mainpath.mjs` | PASS 9/9 |
| 7 | 配置与唯一出口（AC-22 落盘令牌阻断零子进程） | `node logs/.../tk2-config-cli-mainpath.mjs` | PASS 8/8 |
| 8 | 分发闭包（workspace 闭包、25 文件入包） | `node logs/.../tk1-bundle-closure.mjs` | PASS（`problems: []`） |
| 9 | **宿主工具契约**（按真实 `@deepseek-ai/dsh-tools@0.2.1-rc.2` 的 `register()` 判据） | `node logs/.../qa-r4-host-contract.mjs` | PASS：8/8 工具通过，契约问题 0（**D-1 已闭**） |
| 10 | 双门禁保真（假宿主须拒无 `output` 的工具） | `node logs/.../qa-r4-double-fidelity.mjs` | PASS |
| 11 | 同类缺陷全量扫描（两包全部工具定义的 output/schema 形状） | `node logs/.../dev-r4-class-sweep.mjs` | PASS `{"packages":2,"tools":17,"violations":0,"missingOutput":0,"schemaViolations":0}` |
| 12 | **真实 profile 装入 → 启动 → 卸载回滚** | `bash logs/.../qa-r4-install-load.sh` | PASS 5 步（0 行激活失败；回滚后 `dependencies` 归 null、`bundles` 已摘除） |
| 13 | **双包共存**（正/反安装顺序 + 共存下单包回滚） | `bash logs/.../qa-r4-coexist.sh` | PASS：2 条策略行不同 id、两插件均激活（0 行失败）、反向顺序同样 0 失败、摘除本包后 devops 行仍在且本包 0 残留（**D-2 已闭**） |
| 14 | 真实 web profile 的 `--patch` 覆盖层组合 | `dsh --profile web --patch packages/forge-gitee/cordis.patch.yml --dump-config` | PASS exit 0：`heluo-policy-gitee`（`isolate: {policy: gitee}`）与 `heluo-gitee`（`config: {}`）落在 devops 行之后 |
| 15 | 装载安全（模块顶层不抛错，ESM 用动态 import 判） | `node -e "import('./packages/forge-gitee/src/index.mjs').then(m=>console.log(m.name,m.inject,typeof m.apply,m.GITEE_TOOLS.length))"` | PASS exit 0：`forge-gitee ["tools","policy"] function 8` |
| 16 | 跨 provider 失败契约一致性 | `node logs/.../qa-r4-parity.mjs` | **FAIL**：判定漂移 0 / 失败契约漂移 3（D-3 未闭，P3） |

## 3. AC 覆盖矩阵（25 条：证据来自本轮实跑，不来自文件存在性）

| AC | 证据（命令 → 结果） | 判定 |
|---|---|---|
| AC-1~AC-7（装载清单、files、依赖协议、无宿主硬依赖、无 dist、catalog 与审计、入口命名） | `qa-r4-shape.mjs` 23/23 + `tk1-bundle-closure.mjs`（25 文件、`cordis.patch.yml` 与 src 全入包、`bundledDependencies` 闭包为 0.1.0） | 通过 |
| AC-8/9/10（真实 profile 装入、重启后加载、卸载回滚） | `qa-r4-install-load.sh`（隔离 DSH_HOME：add → boot → dump-config → remove → 回读清单） | 通过（工具枚举见 §7-2） |
| AC-11/12/14/15（provider 分流、字段分表、命令枚举、信封五项） | `mainpath` 42/42（含越界参数零子进程、`MISSING_SOURCE_REVISION` 降级）+ `adapter/read` 用例 + `qa-r4-interface-consistency.mjs` | 通过 |
| AC-13（双包共存不消失、冲突可见） | `qa-r4-coexist.sh`（正序/反序/回滚/0 激活失败）+ `coexistence.test.mjs` 四形态 | 通过 |
| AC-16/17（写动作四状态、幂等、默认 denied 零调用） | `mainpath`（done→reused）+ `actions/session` 用例 + `patch-mount.test.mjs`（5 个写工具逐个 denied、门禁 0 次、反向标定） | 通过 |
| AC-18~AC-21（提交信息门禁、review.md 四段、人工确认、关闭条件） | `review-delivery-mainpath.mjs` 9/9 + `review/delivery` 用例 | 通过 |
| AC-22（凭据纪律） | `tk2-config-cli-mainpath.mjs` 8/8（真实落盘令牌 → `denied`/0 子进程）+ `cli.test.mjs` | 通过 |
| AC-23（唯一 execFile 出口） | `actions.test.mjs` 内静态不变量（`child_process`/`spawn`/`exec(` 零命中）+ `adapter.test.mjs` argv 白名单 | 通过 |
| AC-24（证据含宿主版本） | `grep -n hostVersion packages/forge-gitee/src/gitee-actions.mjs` → 0 命中；`mainpath` 证据 `"hostVersion":null` | **部分**：字段在、值恒 null（D-4，P3） |
| AC-25（设计/索引/README 同步、`pnpm check`、`git diff --check`） | `pnpm check` 1391/1391；`git diff --check` exit 0；`check-docs`/`check-repo` 均已并入 `pnpm check` 且全绿 | 通过 |

## 4. 交付形态契约 9 条逐条

| # | 判据 | 实测 |
|---|---|---|
| 1 | profile 层加载入口声明且 `name` 为包根名 | `cordis.patch.yml` 两行均 `name: '@heluo/forge-gitee'`（根名，非子路径） |
| 2 | 入口声明文件在分发白名单内 | `package.json` `files` 含 `cordis.patch.yml`；tgz 解包清单见 `tk1-bundle-closure.mjs` |
| 3 | 依赖协议可解析（无 `workspace:`/`file:`/`link:`） | 源码清单 1 处 `workspace:*` 由 `buildBundle` 闭包成 `0.1.0`（`tk1-bundle-closure.mjs` `problems: []`） |
| 4 | 宿主依赖按 peer/可选声明 | 包内 `dependencies` 仅 `@heluo/forge-policy`；`@deepseek-ai/*` 零出现（`qa-r4-shape.mjs`） |
| 5 | 构建产物与源码同步 | 本包无 `lib/dist`（纯 ESM 直发 src），安装单元入口 sha256 与工作区逐字节一致（`tests/bundle-gitee.test.mjs`） |
| 6 | 装载安全（顶层不抛错） | 动态 import exit 0（§2-15） |
| 7 | 能被 profile 真实装入 | `dsh plugin --profile qa add` → `dependencies`/`bundles` 均出现 `@heluo/forge-gitee`（`qa-r4-install-load.sh`） |
| 8 | 装载后宿主真实加载 | 启动日志 0 行激活失败、dump-config 出现插件行；真实会话内枚举见 §7-2 |
| 9 | 安装带回滚 | 脚本先输出卸载命令（`dsh plugin remove` + 从 `bundles` 摘除），装后验证通过；共存的单包回滚亦实测干净（§2-13） |

## 5. 缺陷表（仅列本轮复核后仍开放项）

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| D-3 | P3 | 跨 provider 契约 | 跑 `qa-r4-parity.mjs` 对比 devops 与 gitee 的提交信息门禁 | 两 provider 对同一违规给同一 reason 词表，或差异在文档中明写 | 判定漂移 0 但失败契约漂移 3：`PREFIX_MISSING` vs `COMMIT_PREFIX_MISSING`/`COMMIT_DESCRIPTION_MISSING`，且一侧返回对象、一侧抛错 | AC-15（只要求 provider 自有固定枚举，未要求跨 provider 统一） | `node logs/teamflow/tf-mvtbtu9r-wyr782/scripts/qa-r4-parity.mjs` | 输出「失败契约漂移 0」且 exit 0（或设计文档记录该差异并同步改检查器期望） |
| D-4 | P3 | 证据面 | 看任一条写动作/读动作 evidence | evidence 的 `host_version` 为宿主可读版本（如 `0.2.1-rc.2`） | `hostVersion` 仅在 `gitee-session.mjs:38/158/173` 存在且默认 null；`gitee-actions.mjs` 零命中，运行时恒为 null | AC-24 | `grep -n hostVersion packages/forge-gitee/src/gitee-actions.mjs; node logs/teamflow/tf-mvtbtu9r-wyr782/scripts/qa-r4-mainpath.mjs` | grep 命中取值逻辑，且 mainpath 证据出现非 null 的宿主版本 |
| D-5 | P3 | 架构（跨包装载） | 全仓检查补丁层策略行 id | 不同包的同名策略行不得同 id 静默覆盖（D-2 机制） | `forge-enterprise/cordis.patch.yml:33` 与 `forge-devops/cordis.patch.yml:42` 同为 `- id: heluo-policy` 且均无 `isolate`；二者同装时后装方 config 覆盖先装方（与 D-2 同机制）。**属既有包、非本需求文件，AC-13 只定义 gitee×devops 对** | AC-13（范围外，类同风险） | `grep -rn "^ *- id: heluo-policy$" packages/*/cordis.patch.yml` | 输出 ≤1 行（或其中一包改唯一 id / 声明 `isolate`），且 `node --test tests/plugin-patch-layers.test.mjs` 保持全绿 |

## 6. 上轮缺陷复核对照（对照表专用表头，不参与缺陷计数）

| 编号 | round-1 级 | 模块 | 复核命令（按上轮原文） | 本轮结果 | 处置 |
|---|---|---|---|---|---|
| D-1（写工具缺 `output` 致插件不激活） | P0 | 工具契约/装载 | `node logs/.../qa-r4-host-contract.mjs`、`bash logs/.../qa-r4-install-load.sh` | 8/8 工具通过真实 `register()` 判据；真实 profile 激活失败 0 行；`dev-r4-class-sweep.mjs` 17 工具 0 违规 | **已闭** |
| D-2（两补丁层同 id `heluo-policy` 覆盖致 devops 静默掉线） | P1 | 共存/装载 | `bash logs/.../qa-r4-coexist.sh` | 策略行 id `heluo-policy-gitee` + 两行 `isolate`；正/反安装顺序两插件均激活；共存下单包回滚干净 | **已闭** |
| D-3（提交信息门禁契约漂移） | P3 | 跨 provider 契约 | `node logs/.../qa-r4-parity.mjs` | 失败契约漂移仍为 3，修复轮未改动 | 未闭 → 见 §5 D-3 |
| D-4（evidence 无宿主版本） | P3 | 证据面 | `grep -n hostVersion packages/forge-gitee/src/gitee-actions.mjs`、`qa-r4-mainpath.mjs` | 仍为 0 命中 / null | 未闭 → 见 §5 D-4 |

## 7. 本轮新增覆盖面与检查器调整

| 项 | 说明 |
|---|---|
| 新增：共存轴 | 上轮只测了 `devops→gitee` 单一安装方向，未测**反向顺序**与**共存状态下只回滚一个包**——而 D-2 的失败轴恰是"后装者覆盖先装者"，单方向复测不足以证明已闭。本轮给 `qa-r4-coexist.sh` 追加两段：(d) 反向安装 `gitee→devops`（0 激活失败）、(e) 摘除本包后 devops 行仍在、本包策略/插件行 0 残留、宿主 0 激活失败 |
| 新增：真实 profile 覆盖层 | `dsh --profile web --patch … --dump-config`（README 记录的使用形态）在**真实用户 profile 组合**上 exit 0，且与既有 devops 行并存不冲突 |
| 检查器适配 | `qa-r4-interface-consistency.mjs` 在修复后一度 `TypeError`：它按旧形状找 `id: heluo-policy` 并把策略服务从 root 域取——修复后策略行改名并进 `isolate: {policy: gitee}` 域。已改为按 `name` 定位行、按 `isolate` 挂载并从 `gitee` 域取服务，随后 55/55 通过。**这是检查器跟随实现形状，不是产品缺陷**；若沿用旧检查器会得到假绿 |
| 未新增（无收益） | 浏览器面（本交付无 UI）、性能面（工具面为一次性调用） |

## 8. 人工补测清单（环境限制，非交付缺陷）

| # | 项目 | 方法与工具 | 验收判据 |
|---|---|---|---|
| 1 | Windows 实机与麒麟 aarch64 | 按包 README「安装」节在目标机装 tgz，跑 `dsh --profile <p> --dump-config` 与一次只读调用 | 插件行出现、启动无激活失败、只读命令退出码 0；路径含空格/非 ASCII 亦可用 |
| 2 | 真实 web profile 内**工具枚举** | `dsh plugin --profile web add <tgz>` 后重启宿主，在会话里确认 8 个 `forge_gitee_*` 工具可见 | 8 个工具可枚举且无静默跳过（`dsh` 无"列工具"子命令，本轮只能以启动日志 0 激活失败 + 真实 `register()` 判据为间接证据） |
| 3 | 企业 Gitee CLI 联调 | 真实企业 `gh` 客户端 + `GITEE_TOKEN`：`repo/issue/pr` 的 `view\|list`、`--json` 字段实测（F1） | 字段表与实机一致或按可用子集收窄；鉴权失败给固定 reason 且不重试 |
| 4 | 真实凭据持久化检测 | 在本机 `hosts.yml` 写入令牌后发起调用 | `denied` + 0 子进程（离线已验，需企业侧复核 `hosts.yml` 真实路径） |
| 5 | 并层形态（唯一策略行）人工装配 | 按 README §共存 第三行把 3 条目录并入 `heluo-policy` 并删 `isolate` | 7 目录/17 工具，写动作仍 denied |

## 9. 结论

- **可验收**：D-1（P0）与 D-2（P1）在真实宿主上复核通过且未复现；包内 171/171、全仓 1391/1391、主路径 42/42、接口 55/55、形态 23/23、审查交付 9/9、配置出口 8/8、宿主契约 8/8、双包共存正反顺序与回滚全绿、真实 profile 装入与卸载干净。
- **3 条 P3 观察项**：D-3（跨 provider reason 词表不一致，AC-15 未要求统一）、D-4（AC-24 宿主版本恒 null，需验收方确认是否接受降级）、D-5（既有 enterprise×devops 补丁层同 id 覆盖机制，范围外）。
- **不可自动验证项**全部进 §8，未把离线/桩证据写成企业联调；本报告不含真实凭据、内网地址与本机绝对路径。
