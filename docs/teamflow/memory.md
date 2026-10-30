# memory.md — heluo-forge 团队约定与待办（TeamFlow）

> 只记跨需求长期有效的团队约定与待办；需求过程产物留在各自任务夹，不在此追加变更日志。

## 约定

- **插件交付形态**：交付物必须能被宿主以 profile 包形态安装——`package.json` 声明 `dsh.bundle.patch`，补丁 `insert:` 行 `name` 用**包根名**（子路径会被判"无 client 声明"而静默跳过）；声明文件进 `files` 白名单；安装清单不含 `workspace:` 等本地协议（源码引用由构建期闭包，见 ADR-12/#37）；`@deepseek-ai/*` 与 `react` 只走 `peerDependencies` + `peerDependenciesMeta.optional`；策略依赖型插件（如 devops）的补丁层还须自带非空 `config.catalog`（覆盖其只读动作）与显式 `config.audit`（内存舱须 `allowNonDurable`，生产换持久 sink），否则装上也不激活；策略依赖型插件与既有策略服务共存时，补丁层用独立行 id（如 `heluo-policy-gitee`）并为策略行与插件行写同一个 `isolate: {policy: <label>}`，各自声明本插件目录；同 id 叠加仍禁止（后装者覆盖先装者 config、先装方工具静默掉线）。
- **安装入口以本机探测为准**，不写死 profile 名/路径：`dsh` 在 PATH 时用 `dsh plugin --profile <p> add|remove <pkg>`（转发到 profile 目录执行 pnpm），`dsh.profile.bundles` 条目由包自身的 `dsh.bundle.patch` 推导；安装发生在工作区之外，由**主 agent** 执行并预先写明回滚步骤。
- **CLI 入口与配置面**：路径类配置以插件配置页（Web UI 表单；经 `dsh-settings` 表单面 + `dsh-config-editor` 落到活动 profile 补丁）为主路径，环境变量只在 CI / 无 UI 场景兜底；缺省由装配期自动发现自身位置。Windows 上路径类入口只判「存在且是普通文件」，不按扩展名拦截：npm 生成的 `.cmd`/`.ps1`/无后缀 shim 都能保存、也能被自动发现（同一位置有原生 `.exe` 时 `.exe` 优先），`.cmd`/`.bat`/`.ps1`/`.com`/`.vbs` 词表只用于运行期失败提示。`shell:false` 启动不了这些脚本，提示须把原因归到运行时能力并指向原生可执行文件，绝不为此引入 shell 或改启动方式。契约键仍是六个 camelCase `dopBin`/`dopEndpoint`/`ghBin`/`ghOwner`/`sourceType`/`timeoutMs`，但配置页只暴露普通用户能判断的三项 `dopBin`/`ghBin`/`timeoutMs`；`dopEndpoint`/`ghOwner` 只经环境变量或配置文件设置，页面保存不得清空它们；`sourceType` 由后端推导（显式配置 > 环境变量 > 推导：dop 与 gh 入口均已解析时 `enterprise`，否则 `mock`），普通用户在页面上既看不到也不需要判断。配置页显示名与指引句统一为「设置 → 企业 DevOps」（页面 `nav`/`title`、`CLI_PAGE_HINT`、README 同源），用户可见文案不写 `.exe` 后缀。路径与 endpoint 只在配置页内可见，工具输出、日志、报告一律不回显。
- **平台来源分工**：业务事实（系统变更、用户故事、验收条件、发布信息）走企业 dop CLI（`change view <id> -j`，字段契约按 2026-07-06 校准；本机为 mock，位于外部工程 oh-my-sdd 的 `scripts/dop`，不在 PATH、非常驻服务，可执行路径与 endpoint 按「插件配置页 > 环境变量 > 装配期自动发现」三层解析，不硬编码、不写入文档、不落版本库）；仓库/Issue/PR 的事实与动作走 GitHub `gh`（本机已登录，写动作指向**真实远端仓库**）。mock 结果不算企业证据。
- **契约兼容只在适配层吸收**：平台原生命名与输出封装差异——dop 原生 `code`/`state`/`summary`/`userStory`、Gitee `gh` 的 `data.list` 信封与 `path_with_namespace`、`org/group/repo` 三段仓库引用——只在 `packages/forge-devops/src/` 适配层单点归一（字段别名表一处、仓库引用解析一处，不得在多处复制正则），归一结果仍是契约里的 snake_case 形状；平台未给的字段进 `missingFields` 并在卡片上显示「平台未提供」，不猜字段、不伪造，同样不得因此放松任何写门禁或 fail-closed 语义。
- **平台写动作按门禁已覆盖范围默认开放**（建 Issue、审查评论、PR 关联；澄清回写按 dop 命令面现状落 `denied`），未覆盖或无权限时状态可见为 `denied`，绝不静默跳过；状态只允许 `done` / `failed` / `denied` / `unknown`（扩展 `skipped` / `blocked` / `stale`），只用退出码 0 不算成功，`unknown` 不自动重放；同一变更重复执行幂等。合并 PR、关闭 Issue、`dop change done`、CI 触发、部署/回滚与审批永不在动作白名单内。
- **证据纪律**：任何"已实测/已验证"的结论必须写明命令、时间、宿主版本、目标对象与**来源类型（mock 实测 / 企业实测）**；mock 结论不得写成企业已联调。
- **验证基线**：仓库根 `pnpm check` + `git diff --check`；新增或修改包必须带离线测试并进入 `node --test` 自动发现范围，tarball 清单复用 `scripts/check-bundle-tarballs.mjs`。

## 待办

- 企业 dop 真实接口联调（命令、字段、结构化输出、双端产物、凭据注入）：联调前只白名单 `change view|list` 只读，替换 mock 时只改适配层；`change done` 永久禁用。r6 已按 UAT 报告描述的原生字段补别名表与离线夹具（夹具是报告描述的形状，非企业实测），真机复测 T3 仍 `NOT RUN`；同一批取证还须覆盖写回执——`parseCreatedRef`/`parseCommentRef` 不拆 `data` 信封，企业 `gh` 若对 `issue create`/`comment` 输出同样包封会落 `unknown`（fail-closed、不重放，但需实测确认，验收 L2）。
- profile `web` 现存 2026-10-28 的手工 `file://` UAT 段（`forge-policy` / `heluo-uat-reader` / `forge-devops`）待被正式安装替代；替换时同步删除该段并在回滚时原样恢复。
- 宿主版本双轨（仓库目标 `.dsh-version` `0.2.1-rc.3`，本机已装 `0.2.1-rc.2`）：目标版本上的装载证据仍为 `NOT RUN`，升级宿主后补跑。
- r3 配置页三处人工补测仍 `NOT RUN`：Windows 实机零配置（AC-1/2）、真实浏览器点击走查（AC-6/7）、真实 web profile 重启（AC-8，需先删 2026-10-28 手工 `file://` UAT 段）。`dist/` 内 `UAT-WINDOWS.md` 与旧 tarball 是 r3 前构建产物，勿作为新版本分发。
- gitee（`@heluo/forge-gitee`）人工补测：真实 `web` profile 按 PRD §10.3 装入并回读 `dependencies`/`bundles`、真实会话内 8 个 `forge_gitee_*` 工具枚举；企业 Gitee CLI 与 `--json` 字段联调、Windows/麒麟 aarch64、真实凭据持久化仍 `NOT RUN`。forge-gitee 内同源的两段仓库假设与不解包 `data.list` 尚未修，须另开一单，勿与 devops 侧共用一次取证。
- **r8 遗留的入口形态副本**：`packages/forge-gitee/src/runtime-config.mjs:66-100` 仍自带 `WRAPPER_SUFFIXES` 与包装脚本拒收，gitee 侧 `cliPath` 在 Windows 上仍拒 `.cmd`/无后缀 shim，与 devops r8 的「存在且普通文件 + 运行期归因」口径不一致（r8 `TECHNICAL.md` R1）；跨包 import 源码被仓库约定禁止，须作为独立需求修，不夹带进 devops 需求。
