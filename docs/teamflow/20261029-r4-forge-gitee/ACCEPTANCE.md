# ACCEPTANCE — r4 `@heluo/forge-gitee`（企业 Gitee 研发闭环插件）

- 需求夹：`docs/teamflow/20261029-r4-forge-gitee/`（PRD 25 条 AC / TECHNICAL 蓝图 / QA-REPORT 复核轮）
- 验收对象：`packages/forge-gitee`（独立单安装单元；3 读 + 5 受控写，8 个 `forge_gitee_*` 工具）
- 验收方式：独立复跑 QA 检查器 + 静态核对 + 架构一致性对照；不以“文件存在 / README 自称可用 / 历史记录”作证据
- 环境：Node 24.13.0；`dsh` 0.2.1-rc.2（PATH 内，隔离 `DSH_HOME` 下装入）；目标 `.dsh-version` 为 0.2.1-rc.3；分支 `feat/devops-change-flow`（改动未提交，符合 PRD §10.2）；复跑时间 2026-10-29 20:04–20:08（+08:00）

## 1. 逐条 AC 核对（25/25）

| AC | 判据要点 | 本轮证据（命令 → 结果） | 判定 |
|---|---|---|---|
| AC-1 | 补丁清单指向存在文件；insert 行 name 为包根名 | `package.json` 的 `dsh.bundle.patch=./cordis.patch.yml`；补丁解析出 2 行，name 均 `@heluo/forge-gitee`（根名）；`tests/plugin-patch-layers.test.mjs` 8/8 | 通过 |
| AC-2 | `files` 覆盖入口声明与 src，打包无 test/tgz | `npm pack --dry-run`（包目录）→ 14 文件：`cordis.patch.yml`+`src/`(11)+README+package.json；test、tgz 均不在 | 通过 |
| AC-3 | 安装单元依赖为真实 semver、零本地协议 | `tk1-bundle-closure.mjs` → `problems: []`，`@heluo/forge-policy` 闭包为 0.1.0；真实 `dsh plugin add` 安装成功（pnpm 解析通过） | 通过 |
| AC-4 | src 零宿主/React 导入，依赖仅策略包 | `qa-r4-shape.mjs` 23/23；`dependencies` 仅 `@heluo/forge-policy`；`@deepseek-ai/*`、`react` import 计数 0 | 通过 |
| AC-5 | 无 lib/dist；入口与工作区逐字节一致 | `tests/bundle-gitee.test.mjs` 断言入口 sha256 一致；包内无 `lib/`、`dist/`；`main`/`exports` 所指文件全在包内 | 通过 |
| AC-6 | 动态 import 安全、顶层不抛错 | `node --input-type=module -e "await import('./packages/forge-gitee/src/index.mjs')"` → exit 0；缺能力路径抛可读 `GiteeMountError`（entry 用例） | 通过 |
| AC-7 | 默认 catalog 3 条只读、0 写、显式 audit/config | 补丁 3 条 `kind:read`（repository/issue/pr），无 write；`audit: memory/allowNonDurable`；插件行 `config: {}`；空 catalog 即 denied（patch-mount 用例） | 通过 |
| AC-8 | 探测 profile 真实装入并回读清单 | `qa-r4-install-load.sh`：隔离 `DSH_HOME` 下 `dsh plugin --profile qa add <tgz>` → `dependencies` 与 `dsh.profile.bundles` 均出现包名；**用户真实 `web` profile 未装**（人工补测） | 通过（等价证据） |
| AC-9 | 重启后加载、工具可枚举、无静默跳过 | 隔离 profile 启动 0 行激活失败；`qa-r4-host-contract.mjs` 以真实 `@deepseek-ai/dsh-tools@0.2.1-rc.2` 的 `register()` 判据验 8/8 工具、契约问题 0；会话内枚举无宿主命令可查（人工补测） | 通过（间接证据） |
| AC-10 | 装前写卸载步骤、失败即回滚并回读 | README 回滚节含 `dsh plugin remove` + bundles 摘除；脚本 remove 后 `dependencies=null`、bundles 摘除；共存下单包回滚 0 残留 | 通过 |
| AC-11 | 信封/审计带 `provider:gitee`；非 gitee 拒绝且零子进程 | mainpath 42/42；adapter 用例断言非 gitee 请求 `denied` 且 `runner.calls===0` | 通过 |
| AC-12 | 不导入 gh-adapter/GH_* 语义；字段分表；缺字段 unknown | grep：`gh-adapter` 仅注释一处，`GH_*` 仅 `GH_TOKEN/GH_HOST` 凭据名；`GITEE_*` 表 6 张；`GITEE_FORBIDDEN_FIELDS` 拒 `mergedAt/statusCheckRollup`，降级 `unknown` | 通过 |
| AC-13 | 双包共存两插件在、冲突可见不消失 | `qa-r4-coexist.sh`：2 条策略行（`heluo-policy` / `heluo-policy-gitee`）、两插件行；正序与反序启动均 0 激活失败；摘除本包后 devops 行仍在、本包 0 残留 | 通过 |
| AC-14 | 只读命令/参数固定白名单，越界零子进程 | adapter 用例覆盖命令枚举、`--json` 子集、`--web/-f/字符串/argv 数组` 拒绝；mainpath 越界参数 0 子进程 | 通过 |
| AC-15 | 信封五项齐全、固定 reason、只读不重试 | read 用例断言 status/source_revision/observed_at/provider/result_refs；缺版本降 `unknown/MISSING_SOURCE_REVISION`；失败 reason 固定枚举、不重试 | 通过 |
| AC-16 | 四状态、done=回读一致、幂等 reused、unknown 不重放 | actions 用例 + mainpath：done→reused（0 新增）、unknown 不重放；幂等键 sha256 前 16 位 | 通过 |
| AC-17 | 默认无写 catalog；5 写工具 denied 且零调用 | patch-mount 用例逐个断言 `denied`+`rule`、门禁 0 次、适配器/execFile 0 调用；退出码 0 不计成功 | 通过 |
| AC-18 | 提交信息前缀+描述，不改写、不执行 git 写 | delivery 用例三类 reason（缺变更号/缺描述/前缀缺失）；`review-delivery-mainpath.mjs` 9/9；无 git 写调用 | 通过 |
| AC-19 | review.md 四段+AI 栏+模型名+sha、分栏、无敏感信息 | review 用例断言四段、实际模型名与降级明示、commit sha、AI/人工分栏、token/内网地址/本机路径零命中 | 通过 |
| AC-20 | 人工确认仅显式写入、模型自填拒绝、sha 变化 stale | review/delivery 用例：模型自填拒绝、sha 变化旧确认标 stale 且不作通过依据；平台发布默认禁用 | 通过 |
| AC-21 | 关闭条件四项逐条证据+来源类型、只判定不执行 | delivery 用例：四项条件、CI/UAT 取不到 unknown；动作白名单无 close/merge | 通过 |
| AC-22 | 令牌只经环境变量、零回显、持久令牌阻断 | `tk2-config-cli-mainpath.mjs` 全绿：落盘令牌 → `denied`、`spawned=0`、不回显值；交付文件令牌正则零命中 | 通过 |
| AC-23 | 唯一 execFile 出口、argv 白名单/超时/1MiB、无危险动作 | grep：唯一 `node:child_process` 导入为 `gitee-cli.mjs:25 execFile`，无 spawn/execSync/shell:true；adapter/actions 用例验白名单、超时、截断与禁项 | 通过 |
| AC-24 | 报告/README 证据五要素；未跑标 NOT RUN；mock 不称企业联调 | README 证据表含命令/时间/宿主版本/目标对象/来源类型；Windows/麒麟 aarch64/真实凭据/--json 标 NOT RUN；本报告 §4 按同口径复跑；运行期 `evidence.hostVersion` 恒 null（见 §5 D-4） | 通过（口径见 D-4） |
| AC-25 | 设计文档/索引/README 同步；`pnpm check`、`git diff --check` 为 0 | `pnpm check` → docs/repo/bundles/version 全 ok + 1391/1391；`git diff --check` exit 0；设计文档 V0.2.0（2026-10-29）、索引与包 README 已更新 | 通过 |

## 2. 交付形态 9 条

| # | 判据 | 实测 |
|---|---|---|
| 1 | 有 profile 层加载入口、name 为包根名 | `cordis.patch.yml` 两行均 `name: '@heluo/forge-gitee'`（根名，非子路径） |
| 2 | 入口声明进分发白名单 | `files` 含 `cordis.patch.yml`；tgz 清单 14 文件含该文件与 `src/index.mjs` |
| 3 | 依赖协议可解析（无 workspace:/file:/link:） | 安装单元闭包后 `@heluo/forge-policy=0.1.0`，真实 `dsh plugin add` 成功；`tk1` `problems: []` |
| 4 | 宿主依赖按 peer/可选声明 | 包内 `dependencies` 仅策略包；`@deepseek-ai/*` 零出现（shape 23/23） |
| 5 | 构建产物与源码同步 | 纯 ESM 直发 `src`，无 lib/dist；`bundle-gitee.test.mjs` 断言入口 sha256 与工作区逐字节一致 |
| 6 | 装载安全（顶层不抛错） | 动态 import exit 0（ESM，`require` 不适用） |
| 7 | 能被 profile 真实装入 | 隔离 `DSH_HOME` + `--profile qa`：`dependencies`/`bundles` 均出现包名 |
| 8 | 装载后宿主真实加载 | 启动日志 0 行激活失败；dump-config 出现插件行；8 工具按真实 `register()` 判据通过 |
| 9 | 安装带回滚 | 装前 README 写出 remove + bundles 摘除；装后验证通过；共存下单包回滚实测干净 |

## 3. 架构一致性核对（M3 强制项）

- **模块划分**：`src` 11 个模块与 TECHNICAL §3 模块表 1–11 一一对应——出口 `gitee-cli.mjs`(533) → 适配器 `gitee-adapter.mjs`(866) → 语义 `gitee-read.mjs`(732)/`gitee-actions.mjs`(1300)/`gitee-review.mjs`(696)/`gitee-delivery.mjs`(520) → 门禁 `gitee-guard.mjs`(344) → 注册 `gitee-tools.mjs`(204) → 装配 `index.mjs`(355)；横切 `runtime-config.mjs`(288)、`gitee-session.mjs`(177)。无缺模块、无计划外新增。
- **装配顺序**：`index.mjs` 的 `apply` 为 config 校验→宿主能力→策略服务→只读目录→runner→adapter→guard→session→service→tools→`provide`→`register`→`ctx.effect` 卸载；注册失败逐个反向撤销已注册工具与已 `provide` 服务并抛 `GiteeMountError`，无半挂载。
- **隔离与漂移**：`src` 对 `@deepseek-ai/*`、`react` import 为 0；`gitee-adapter` 不导入 `gh-adapter`（仅注释提及）；`GITEE_*` 字段表独立且与 JSON 子集同对象；`GH_*` 仅作默认凭据 env 名（`GH_TOKEN`/`GH_HOST`），无 GitHub 语义常量。无适配器漂移。
- **受控重复**：唯一 `execFile` 出口、幂等台账、review 渲染、交付判定与 `forge-devops` 存在重复；TECHNICAL 决策 D-3 以“PRD 不改既有包 + 静态不变量测试”替代抽公共包。验收认为该取舍成立（抽包会扩大既有 provider 回归面与范围），无需返工。
- **结论**：结构符合技术蓝图，无“应抽取未抽取”、无破坏既有结构。唯一偏差点为证据字段 `hostVersion` 运行期恒 null（D-4，P3 口径问题，非架构返工）。
- **既有风险（非本需求引入）**：`packages/forge-enterprise/cordis.patch.yml:33` 与 `packages/forge-devops/cordis.patch.yml:42` 同为 `- id: heluo-policy`，同装会覆盖；AC-13 仅定义 devops×gitee 对，本需求未触碰这两个文件，列为产品级另案（D-5）。

## 4. 证据表（AC-24 口径：命令/时间/宿主版本/目标对象/来源类型）

| 命令 | 时间（2026-10-29） | 宿主版本 | 目标对象 | 来源类型 | 结果 |
|---|---|---|---|---|---|
| `pnpm check` | 20:04 | 0.2.1-rc.2 | 仓库根（docs/repo/bundles/version + 全量用例） | 本机离线 | exit 0；1391/1391 pass |
| `node --test "packages/forge-gitee/test/*.test.mjs"` | 20:08 | 同上 | `packages/forge-gitee` | 离线桩（真实子进程/真策略） | 171/171 pass |
| `node --test tests/bundle-gitee.test.mjs tests/plugin-patch-layers.test.mjs` | 20:08 | 同上 | 仓库级分发/补丁门禁 | 离线静态 | 8/8 pass |
| `node logs/.../qa-r4-mainpath.mjs` | 20:05 | 同上 | 8 工具主路径（读/写/越界/幂等） | 离线桩 | 42/42，`TERMINAL ok` |
| `node logs/.../qa-r4-host-contract.mjs` | 20:05 | `dsh-tools@0.2.1-rc.2` | 8 个工具定义 | 真实 `register()` 判据 | 8/8，契约问题 0 |
| `node logs/.../qa-r4-shape.mjs` / `qa-r4-interface-consistency.mjs` | 20:05 | 0.2.1-rc.2 | 交付形态 / 跨模块接口 | 离线静态 | 23/23；55/55 |
| `node logs/.../review-delivery-mainpath.mjs` / `tk2-config-cli-mainpath.mjs` | 20:06 | 同上 | 审查交付判定 / 配置与唯一出口 | 离线桩（真子进程） | 9/9；全绿（落盘令牌 `denied`、`spawned=0`） |
| `bash logs/.../qa-r4-install-load.sh` | 20:06 | 0.2.1-rc.2 | 临时 `DSH_HOME` 的 `qa` profile | 真宿主隔离 profile | PASS 5/5（add→启动→dump→remove） |
| `bash logs/.../qa-r4-coexist.sh` | 20:07 | 0.2.1-rc.2 | 同 profile 双包（devops×gitee） | 真宿主隔离 profile | PASS（正/反序、单包回滚） |
| `npm pack --dry-run` + 动态 import | 20:05 | 0.2.1-rc.2 | 包分发清单 / 入口模块 | 本机离线 | 14 文件；import exit 0 |
| `git diff --check` | 20:06 | 0.2.1-rc.2 | 工作区 | 本机离线 | exit 0 |

## 5. 遗留与人工补测（P3，不阻断验收）

- **D-3（P3）跨 provider 失败 reason 词表**：同违规 gitee 报 `PREFIX_MISSING`，devops 报 `COMMIT_PREFIX_MISSING`/`COMMIT_DESCRIPTION_MISSING`，且一侧返回对象一侧抛错。AC-15 只要求 provider 自有固定枚举，不构成 AC 未达（QA 的 `qa-r4-parity.mjs` 仍报漂移 3，属检查器期望跨 provider 统一，本轮未复跑）；建议在 README/设计记录该差异或后续统一词表。
- **D-4（P3）运行期证据 `hostVersion` 恒 null**：`gitee-session.mjs` 的 `buildEvidence` 支持该字段（默认 null），四处动作调用未传值；README 证据表已写宿主 0.2.1-rc.2。验收口径：**接受 null 作为“取不到即不伪造”的诚实降级**；建议在 TECHNICAL §4.4/README 明写降级规则，或后续接入宿主版本来源。不阻断。
- **D-5（P3）既有 enterprise×devops 同 id `heluo-policy`**：非本需求文件、非本次引入；本需求新增门禁已覆盖 devops×gitee 与本层唯一；建议产品级另案。
- **AC-8/AC-9 人工补测**：真实 `web` profile 按 PRD §10.3 装入（回读 `dependencies`/`bundles`）与真实会话内 8 个 `forge_gitee_*` 工具枚举。本轮以隔离 `DSH_HOME` 的**真实装入/启动/卸载**（5/5）与真实 `register()` 判据（8/8）作等价证据，未触碰用户日常 profile；`dsh` 无列举工具子命令，会话内枚举仍需人工。
- **NOT RUN**（README/QA-REPORT 均已标注，本报告不补写成实测）：Windows 实机、麒麟 aarch64、真实企业凭据/企业 Gitee CLI 联调、`--json` 字段稳定性。mock 结果未写成企业已联调。
- **文档口径**：包 README 的 NOT RUN 第 3 条仍写“AC-8/AC-10 执行与回读均未做”，与本轮隔离 profile 实装/回滚证据不符（方向保守）；建议下次文档修订改为“隔离 profile 已验、真实 web profile 未装”。

## 6. 验收结论

25 条 AC（24 条 P0 + AC-13 P1）逐条有可复现证据；交付形态 9 条实测满足；11 模块与装配顺序符合 TECHNICAL 蓝图，无适配器漂移、无应抽未抽；D-3/D-4/D-5 三条 P3 与 AC-8/AC-9 的等价证据、人工补测项均不构成 P0/P1/P2 缺陷。本轮独立复跑全绿（`pnpm check` 1391/1391、包内 171/171、mainpath 42/42、host-contract 8/8、install-load 5/5、coexist 正反序+回滚、`npm pack` 14 文件、import exit 0、`git diff --check` 0）。准予验收。

验收结论：✅ 通过
