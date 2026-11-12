# r17 DSH 轻量集成 · QA 验收报告

> 需求：issue #222 —— 把「完整 DSH 安装包」收窄为「官方宿主原样 + 企业私版插件 + 一次初始化脚本」。
> 契约单：[TECH-CHANGE.md](TECH-CHANGE.md)（本夹当次唯一契约来源；无 PRD/DESIGN/TECHNICAL）。
> 结论：**可验收**（P0/P1/P2 = 0；P3 观察 2 条，均不阻断）。

## 1. 范围与环境

- 分支 `feature-package`，基线提交 `d850a7f`，全部交付为未提交改动（不提交、不推送）。
- 环境：Darwin arm64，Node v24.13.0，pnpm 11.28.5，真实 DSH 宿主 `0.2.1-rc.5`（`/opt/homebrew/bin/dsh`）。
- 交付面：新增 `scripts/init-enterprise-plugin.mjs`（534 行，单文件自包含）与 `tests/init-enterprise-plugin.test.mjs`（14 例）；删除完整安装包 5 文件；改造 `scripts/build-public-release.mjs` 工具链清单、`tests/release-public.test.mjs`、技能 `SKILL.md`/`sop.md`、`docs/architecture/public-enterprise-bundle.md`（V0.5.0）、`docs/DOCUMENT-REGISTER.md:55`、`docs/README.md:86`、`docs/teamflow/memory.md`。
- 重点核验的契约：唯一写入口 `dsh plugin --profile <p> add <tgz>`（execFile、`shell:false`、固定 argv）；同版本零写入幂等；异版本停止；L1 退出码 / L2 `--dump-config` 含包名且 `dependencies` 与 `dsh.profile.bundles` 对齐 / L3 只报 `mounted=unknown`；不启动宿主、不建 profile、不覆盖用户数据。

## 2. 用例与结果（全部 execute，非存在性检查）

| 编号 | 类型 | 命令（逐条独立执行，≤120s） | 结果 |
| --- | --- | --- | --- |
| T-01 | 实现主路径真机 E2E | `node logs/teamflow/tf-mwam0u2s-zfaqha/scripts/qa-r17-real-host-e2e.mjs` | PASS 6/6，exit 0（临时 `DSH_HOME`，回滚=删临时目录） |
| T-02 | 契约/失败面探针 | `node logs/teamflow/tf-mwam0u2s-zfaqha/scripts/qa-r17-init-mainpath.mjs` | PASS 9/9，exit 0 |
| T-03 | 新增用例 | `node --test tests/init-enterprise-plugin.test.mjs` | exit 0，14 tests / 14 pass / 0 fail / 0 skip |
| T-04 | 改造用例 | `node --test tests/private-bundle.test.mjs tests/release-public.test.mjs` | exit 0，23 pass / 0 fail |
| T-05 | 全量门禁 | `pnpm check` | exit 0，3370 tests / 3365 pass / 5 skipped / 0 fail（67.4s） |
| T-06 | 文档门禁 | `node scripts/check-docs.mjs` | exit 0 |
| T-07 | 技能门禁 | `node scripts/check-skills.mjs` | exit 0 |
| T-08 | 空白字符 | `git diff --check` | exit 0 |
| T-09 | 旧口径残留 | `grep -rn 'assemble-full-installer\|verify-full-installer\|installer-inputs\|完整安装包\|full-installer' docs README.md AGENTS.md .agents scripts tests --exclude-dir=teamflow` | exit 0，仅 2 处合法命中，都是 `tests/release-public.test.mjs:141/143` 的反向守卫断言；`docs/teamflow/memory.md:8` 另有一条历史记录（该命令按 `--exclude-dir=teamflow` 排除，非残留） |
| T-10 | 接口一致性（静态） | `node -e "import('./scripts/init-enterprise-plugin.mjs').then(m=>console.log(Object.keys(m).sort().join(',')))"` | exit 0，16 个导出；测试文件 `tests/init-enterprise-plugin.test.mjs` 导入的 12 个符号全部命中 |
| T-11 | 写面收敛 | `grep -n "execFile\|spawn\|shell:" scripts/init-enterprise-plugin.mjs` | 仅 `:321` execFile 一处真实调用（`defaultExec`），`:336`/`:321` 均 `shell:false`；无 spawn/exec |
| T-12 | 版本控制卫生 | `git status --porcelain` + `git check-ignore -v logs/teamflow` | 仅 16 项（13 改动/删除 + 2 新增代码 + 任务夹），无 `node_modules/`/`dist/`/`*.tgz`；`.gitignore:41 dist/`、`:62 *.tgz`、`:86 logs/` |

### T-01 真机端到端（关键证据）

用真实 `dsh 0.2.1-rc.5` 在**临时 `DSH_HOME`**（不触碰 `~/.dsh/profiles/*`）完成一次真实安装：

- H0 真实宿主初始化临时 `web` profile（等价员工先启动一次官方宿主）→ exit 0。
- H1 合成含 `dsh.bundle.patch` 的私版 tgz + 合规 `private-release.json`（schema `heluo-private-release/1`）。
- H2 脚本执行真实 `dsh plugin --profile web add <tgz>` → 回显「安装：dsh 退出码 0」「L2 --dump-config 含 @heluo/forge-enterprise」「mounted=unknown」。
- H3 真实 profile `dependencies` 记录该包、`dsh.profile.bundles` 含该包、`node_modules` 就位 —— 证明 L2 的「对齐」判据在真实宿主上成立（宿主 `@deepseek-ai/dsh-plugin-manager` `runPluginCommand`→`runProfilePnpm`→`reconcile` 会把声明 `dsh.bundle` 的新依赖追加进 bundles）。
- H4 同版本重跑 → 「已安装同版本 9.9.9，本次不写入」，profile `package.json` 字节不变（幂等零写入）。
- H5 脚本未编辑 profile `cordis.patch.yml`（不碰补丁层）。

### T-02 失败面与契约细节

dry-run 零 exec；argv 逐字 `['plugin','--profile','web','add',<tgz>]` 与随后 `['--profile','web','--dump-config']`；异版本 exit 1 `VERSION_CONFLICT` 零写入；`--sha256` 错配 exit 1 `DIGEST_MISMATCH` 且不吐栈；tgz 篡改 `TARBALL_MISMATCH`/`SIDECAR_DIGEST_MISMATCH`；PATH 空 `DSH_MISSING`；profile 缺失 `PROFILE_MISSING` 且不建目录；`--json` 含 `status`/`profile`/`artifact.sha256`/`mounted=unknown`/`command`。

## 3. 接口一致性（0a · 静态）

- 导入符号：`tests/init-enterprise-plugin.test.mjs` 的 `init-exports` 断言脚本导出名与实现一致（T-10），无「文件在、导出不在」。
- 调用形态：`runInit({ argv, env, home, exec })` 与测试注入的 exec 签名 `(bin, args, options)` 一致；`main` 用 `process.exitCode` 回报，测试以子进程退出码断言（T-03/T-02）。
- 生产者↔消费者：`scripts/lib/private-bundle.mjs:29/419/487/489-501/508-535` 写出的 `schema`/`entry`/`tarball{name,sha256,bytes}` 与 init 读取字段逐一对齐；`packages/forge-enterprise/package.json` 的 `dsh.bundle.patch` 是 L2 判据的真实前提（T-01 H3 已实测）。
- 宿主 CLI 契约：`dsh plugin --help` 的 `--profile <name>` 与剩余参数转发、`reconcile` 行为均已按源码核对并在 T-01 实跑命中。

## 4. 架构核查（0 · 轻量）

- **蓝图符合性**：TECH-CHANGE §7.2 要求单文件自包含（不新增 `scripts/lib` 副本），实现即单文件、仅 `node:` 内置模块；与 §2 表格的路径写法存在笔误（见 D-1），实现侧按裁决执行，无跨模块相对导入、无新增依赖。
- **单写入口**：全脚本只 `:321` 一处 `execFile`（`shell:false`），安装与 `--dump-config` 核验复用同一 exec 封装（T-11），未出现第二条写路径或 `spawn`。
- **能力不外溢**：脚本不建 profile、不启宿主、不编辑 `cordis.patch.yml`（T-01 H5）；失败面统一 `InitError{code,message,next}`，不泄漏 stack（T-02）。
- **可复用抽取判断**：仅两处小工具与既有脚本重复（`dshHomeOf` 与 `scripts/uat-profile.mjs:84` 同名同义；`sha256File` 与 `scripts/lib/release-support.mjs` 的摘要工具重复 3 行）。因「交付物为可单独复制的初始化脚本」这一硬约束（不可 import `scripts/lib`），重复是可接受权衡，列为 P3 观察（D-2），不构成抽象未抽取缺陷。
- 未发现重复的安全包装/存储/适配器漂移，未破坏既有结构（`pnpm check` 全绿，16 个 `scripts/*.mjs` 与 3370 例测试无回归）。

## 5. 交付形态与安装回滚（0b）

- 形态：可执行 CLI + 单测 + 文档口径。本交付**不应被启动为服务**，采用「真实宿主安装 + 单测 + 静态门禁」组合验证。
- 回滚纪律：任何真实安装前先写定回滚命令 `dsh plugin --profile <p> remove @heluo/forge-enterprise`；本次唯一真机安装发生在**临时 `DSH_HOME`**，回滚 = 删除临时目录，已执行，用户 profile 零改动（`~/.dsh/profiles/web` 未触碰，`git status` 无 profile 相关项）。
- L3 运行期挂载不伪造：脚本只输出 `mounted=unknown`，真实挂载确认进入人工补测清单。

## 6. 人工补测清单（环境限制，非交付缺陷）

| # | 项目 | 方法 / 工具 | 验收判据 |
| --- | --- | --- | --- |
| M-1 | 真实企业私版 tgz（含企业 IAM/Gitee 配置、无密钥）在员工官方 DSH 上安装 | 按 `heluo-forge-release-bundle` SOP 在真机执行 `node scripts/init-enterprise-plugin.mjs --release <dir> --profile web --sha256 <独立摘要>` | exit 0，输出 `status=installed`、`L2` 通过、`mounted=unknown` |
| M-2 | 安装后真实挂载确认 | 启动官方 DSH → 设置 → 插件 | 出现 `@heluo/forge-enterprise` 且其工具可调用（本机仅有 rc.5，未装 Desktop 宿主，故 NOT RUN） |
| M-3 | Desktop 宿主（首启后 `profiles/desktop`）路径 | 同上，`--profile desktop` | 与 web 同结论；本机未安装 Desktop 宿主 → 环境限制 |
| M-4 | Windows / 麒麟 aarch64 | 真机执行同一脚本 | `dsh.exe` 判定、PATH 解析、pnpm 存在性均正常；Linux/arm64 本机不可得 |
| M-5 | 慢网/宿主升级中并发安装 | 真机观察 `INSTALL_FAILED`/超时（300s）行为 | 失败即零半写入，回显回滚命令 |

## 7. 缺陷表

| 编号 | 严重级 | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-1 | P3 | 文档/契约一致性 | 打开 TECH-CHANGE.md:22 看「新增」行 | 新增文件路径写作 `scripts/init-enterprise-plugin.mjs`（与 §7.2 及实现一致） | 写作 `scripts/lib/init-enterprise-plugin.mjs`，与 §7.2「单文件自包含」及实际文件位置矛盾 | TECH-CHANGE §2/§7.2 | `grep -n "scripts/lib/init-enterprise-plugin" docs/teamflow/20261110-r17-dsh-lite-integration/TECH-CHANGE.md` | 该命令无输出（exit 1） |
| D-2 | P3 | 架构 | 对比两个 `dshHomeOf` 实现 | 同义工具只保留一处，或显式注明「自包含副本」 | `scripts/uat-profile.mjs:84` 与 `scripts/init-enterprise-plugin.mjs:167` 各有一份（后者默认 `env = {}`，前者默认 `process.env`，语义略有差异） | 架构核查（0） | `grep -n "export function dshHomeOf" scripts/uat-profile.mjs scripts/init-enterprise-plugin.mjs` | 保留但加注释说明，或收敛为一处；属观察项，不阻断 |

> 未发现 P0/P1/P2 缺陷。D-1/D-2 均为 P3 观察，不影响验收结论。

## 8. 结论

**可验收**。契约要求的「唯一写入口、幂等零写入、异版本停止、L1/L2/L3 分层核验、不建 profile、不启宿主」均有真机执行证据（T-01/T-02）；全量门禁 `pnpm check` 与文档/技能/空白门禁全绿（T-05~T-08）；接口一致性与写面收敛静态核查通过（T-10/T-11）；工作区卫生干净（T-12）。

未覆盖项：真实企业配置的私版 tgz、Desktop 宿主、Windows/麒麟双端、真实运行期挂载 —— 均按 §6 转入人工补测，不计为交付缺陷。
