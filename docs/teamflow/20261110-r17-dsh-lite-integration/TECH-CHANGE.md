# 技术变更单 · issue #222 收窄：官方 DSH 宿主 + 企业插件轻量集成

> 编号：req-17（run tf-mwam0u2s-zfaqha）｜类型：技术驱动返工（无完整功能 PRD）
> 基线依赖：origin/main f60b7f5（#223 方案文档 V0.4.0）+ feature-package d850a7f（公版/私版/完整安装包工具链）
> 取代：`docs/architecture/public-enterprise-bundle.md` V0.4.0 §4.2、§5 技能表中的安装包装配要求、§8 完整安装包验收行、§9 第 3 步、§10 相应待确认项；同时取代 d850a7f 交付的完整安装包实现。
> 本单是 dev/QA/验收的契约；不改写任何历史任务夹的 PRD/TECHNICAL/AC。

## 1. 背景与目标

issue #222 的边界已改为「公版插件、企业私版与官方 DSH 轻量集成」，故删除完整 DSH 安装包（装配/核验/重签/公证/双击安装器）实现，改为官方宿主原样 + 企业私版插件 + 员工端一次初始化脚本。

## 2. 影响范围

| 动作 | 路径 | 说明 |
|---|---|---|
| 删除 | scripts/assemble-full-installer.mjs | 安装包装配 CLI |
| 删除 | scripts/verify-full-installer.mjs | 安装包离线核验 CLI |
| 删除 | scripts/lib/full-installer.mjs | 六平台安装包装配/核验库 |
| 删除 | tests/full-installer.test.mjs | 上者专属用例（实现整块删除，用例随删） |
| 删除 | .agents/skills/heluo-forge-release-bundle/references/installer-inputs.md | `installer-inputs.json` 契约 |
| 新增 | scripts/init-enterprise-plugin.mjs | 员工端初始化薄入口（参数解析/退出码/usage） |
| 新增 | scripts/init-enterprise-plugin.mjs | 预检、安装、核验、幂等编排（可注入 exec） |
| 新增 | tests/init-enterprise-plugin.test.mjs | 离线正反例 |
| 修改 | scripts/build-public-release.mjs | 发布工具链清单：去 3 个安装包脚本，加 init 脚本；注释同步 |
| 修改 | tests/release-public.test.mjs | 工具链清单断言随之更新 |
| 修改 | .agents/skills/heluo-forge-release-bundle/SKILL.md、references/sop.md | 目标改为「私版包 + 初始化脚本交付」，删装配步骤 |
| 修改 | docs/architecture/public-enterprise-bundle.md | V0.5.0：§4.2 改为轻量集成，删重签/公证/双击安装器/六平台安装装配，§5/§8/§9/§10 同步 |
| 修改 | docs/DOCUMENT-REGISTER.md、docs/README.md | ARCH-006 标题/状态/摘要同步 |
| 修改 | docs/teamflow/memory.md | 「约定」增补交付形态一条（同主题替换，幂等） |
| 不变 | .github/workflows/release-bundle.yml、私版制作器、公版构建、`issue-delivery` 技能 | 公版 Release 仍只出单 tgz + 工具资源 |

## 3. 技术方案

### 3.1 集成路线（#222「低成本安装方式」候选 2）

官方渠道安装 DSH 宿主 → 员工运行企业初始化脚本安装私版插件。不重签、不公证、不制作双击安装包、不随包再分发宿主；官方载荷原样，来源与版本可追溯。理由：与现行「不修改或分发 DSH 本体」一致，避免宿主再分发与签名义务；候选 1（内部成套交付官方宿主）保留为替代路线，见 §7。

### 3.2 初始化脚本契约

```
node scripts/init-enterprise-plugin.mjs --release <交付目录> --profile <desktop|web>
  [--sha256 <hex>] [--dsh <path>] [--dry-run] [--json]
```

| 环节 | 契约 |
|---|---|
| 预检 | `--release` 目录须含 `private-release.json` 与同名 tgz；摘要取 `--sha256`（优先）或 sidecar；摘要不符、缺 sidecar、缺 `dsh`、`--profile` 缺失或非 desktop/web 一律 fail-closed（退出 1），不猜 profile |
| 安装 | 唯一写入口 `dsh plugin --profile <p> add <tgz 绝对路径>`（execFile、`shell:false`、固定 argv），不直接改 profile 文件、不改 `plugin_manager` 权限 |
| 幂等 | 已装同名同版本 → 0 且零写入；已装不同版本 → 停止并打印升级/回退命令，不自动升级 |
| 核验 | L1：dsh 退出 0；L2：`dsh --profile <p> --dump-config` 含 `@heluo/forge-enterprise` 且 profile `dependencies`/`dsh.profile.bundles` 对齐；L3 运行期挂载**不在脚本内断言**，输出 `mounted=unknown` 并指引启动宿主查设置页 |
| 失败面 | 分类 + 下一步（宿主未安装 / profile 未初始化 / 摘要不符等），不回显凭据或配置值，不把失败写成成功 |
| 不做 | 不启动或重启宿主、不创建 profile、不覆盖对话/工作区/非企业设置/个人凭据、不编辑第三方补丁条目、不删除用户文件 |

`--dry-run` 只打印将执行的命令与核验点；`--json` 输出同一结论的结构化版本。Desktop 首启初始化、Web profile、离线 tgz 安装等真实宿主行为属主 agent 实测项，脚本只覆盖结构与命令编排。

### 3.3 工具链与技能收敛

- 公版 Release 工具资源 = 公版构建/核验 + 私版制作器 + init 脚本 + 制作 Skill；不再含安装包装配器。
- Skill `heluo-forge-release-bundle`：description 去掉「装配/核验完整安装包」；SOP 增加「交付物 = 私版 tgz + private-release.json + init 脚本 + 简明步骤」，删除 `installer-inputs` 引用与 `verify-full-installer` 步骤。
- `issue-delivery` 技能不在本单范围，保持现状。

## 4. 行为兼容性影响

- 唯一用户可见变化：员工交付从「双击完整安装包」变为「官方渠道装宿主 → 运行初始化脚本」，员工多一步，且不再有预置宿主的安装包；不重签、不公证官方制品。
- 发布维护者：工具链少 3 个脚本与 1 组用例，公版资源更小。
- 不变：公版插件字节面、私版 config 注入与摘要/清单规则、版本号规则、`engines.dsh`、既有安装/卸载命令（r9）。
- 历史任务夹 PRD/AC 不改写；本单不新增功能 AC，只增技术验收判据（§5）。

## 5. 回归与验证

| # | 命令 | 判据 |
|---|---|---|
| 1 | `node --test tests/init-enterprise-plugin.test.mjs` | 正例：安装、幂等、不同版本停止；反例：摘要不符、缺 sidecar、缺 dsh、profile 缺失/非法、dump-config 缺条目；全程注入 exec，不 spawn 真实 dsh |
| 2 | `node --test tests/private-bundle.test.mjs tests/release-public.test.mjs` | 私版制作与公版发布不回归；工具链清单断言已更新 |
| 3 | `node --test` | 全量用例只增不减、0 skip；唯一减少为 §2 列明的 full-installer 专属用例 |
| 4 | `pnpm check` | docs/repo/skills/tarballs 门禁全绿 |
| 5 | `git diff --check` | 干净 |
| 6 | 全库 grep `assemble-full-installer\|verify-full-installer\|full-installer\|完整安装包` | docs/README/AGENTS/Skill/scripts 零命中（历史任务夹除外） |
| 7 | 真实 `dsh plugin --profile … add` 与启动后挂载 | **NOT RUN**；主 agent 在目标机执行并记录命令/时间/宿主版本/来源类型 |

回归底线：公版/私版正反例不得删；`check-skills` 与 `repo-rules` 不得放宽；安全扫描规则不放松。证据纪律沿用 memory.md「证据纪律」条。

## 6. 风险与回滚

- 宿主 CLI 差异（add 参数、离线 tgz、Desktop 首启初始化前提、Web profile 独立）→ 脚本只编排与核验，失败即停并打印原始命令；未实测缺口标 NOT RUN。
- 上游 remove 不清补丁层（r9）→ 回滚步骤引用 r9 口径；通用清理器另开需求，不在本单扩大范围。
- sidecar 摘要属交付内自证 → `--sha256` 提供独立口径，不把 sidecar 当来源证明。
- 文档/索引残留旧「完整安装包」口径 → §5 第 6 条 grep 门禁。
- 回滚：revert 本单提交即恢复 d850a7f 工具链；不触碰任何 profile 与用户数据；脚本失败不删除用户文件。

## 7. 假设与待澄清

1. 路线已选候选 2（官方渠道 + 企业初始化）；若改候选 1（内部成套交付官方宿主），只需在交付清单增加宿主来源/许可/摘要与再分发结论，init 脚本不变。
2. init 脚本为**单文件自包含**（仅 `node:` 内置模块），随私版交付目录分发，不依赖源码工作区；若改为共享 `scripts/lib` 打包分发，则需同步发布工具链清单、导入路径与测试。
3. `--profile` 必填（desktop/web），不自动探测；若要求自动探测，需定义默认值表、多 profile 冲突与 Desktop 首启前提。
4. 摘要信任默认 sidecar、`--sha256` 覆盖；若要求强制独立摘要，`--sha256` 改必填。
5. IAM `authMode=public` 基线与 secret 相关文档同步属 #222 工作项 2，不在本单；本单只保持制作器不写入任何 secret 的现状。
6. 六平台真实环境验收归 #123；本单只做离线结构、自动化与命令编排。
7. 版本/宿主兼容不在脚本内复制矩阵，以宿主 CLI 报错为准。
