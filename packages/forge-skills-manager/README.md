# 技能管理

状态：可用（本地实现；验证边界见[设计索引](../../docs/design/README.md#22-实现与验证入口)）。

`@heluo/forge-skills-manager` 为 DSH 提供全局与项目技能、其他本机 Agent 技能、本地创建和导入、启停分类、回收站，以及 Nacos 企业公共技能库。下载包含完整资源，默认禁用，须由用户显式启用。下载响应中断时可核对结果，确认前不会重复安装。界面支持中文、英文。

在「发现技能」按名称搜索企业技能，打开详情阅读 Markdown 说明与资源清单，选择全局或已登记项目后下载。成功提示可直接前往对应技能页查看和启用；本地修改不会上传到企业库。

再次进入或刷新发现页时，卡片显示当前版本已下载的全局/项目范围，详情按所选位置提示并避免重复下载。本地修改保留下载标识并单独提示；移入回收站或移除后重新核验，恢复后重新显示。状态来自宿主安装记录及本地资源，不依赖浏览器历史；待确认或暂不可核验时不显示下载成功。不同来源及版本分别识别，不自动覆盖同名技能或升级。

本包可独立安装，也由 `@heluo/forge-enterprise` 组合交付。目标宿主版本由根 `.dsh-version` 管理。实现与部署边界见[设计](../../docs/design/plugins/forge-skills-manager.md)，配置字段见[Nacos 契约](../../docs/contracts/nacos-skills.md)。

上传和企业库下载的资源文件名采用 Windows、macOS、Linux 共同可用的规则：拒绝保留字符、设备名、末尾点或空格，并拒绝大小写或 Unicode 规范化后重复的路径。macOS 标准 `/tmp`、`/var`、`/etc` 系统目录别名可用，普通祖先链接及技能内部链接仍受拒绝。上传与企业 ZIP 下载不还原 POSIX 执行位；脚本请通过 `bash`、`python3` 等已安装解释器调用。源码级兼容检查不代表 macOS 实机验证。

## 功能与来源权限

| 来源 | 管理边界 |
|---|---|
| 全局 DSH、全局公共 Agent | 可创建、导入、启停、分类及移入回收站，写入前仍须通过根目录和权限校验 |
| 已登记项目的 DSH 技能 | 在有效工作区内管理；不接受页面指定的任意项目目录 |
| Codex、Claude Code 等其他 Agent | 发现和读取源文件；本插件策略启停不修改对方源文件，也不控制对方 Agent 的调用 |
| 自定义来源 | 仅受支持且通过配置、安全校验的可写根允许修改，不能将任意只读来源变成可写 |
| Nacos 企业公共库 | 只读发现、详情与完整资源下载；目标仅全局 DSH 或已登记项目，默认禁用 |

源目录不存在、来源被禁用或环境变量指向另一个用户目录时，不会显示预期技能。检查「来源」设置和启动 DSH 时的环境；仅设置 `DSH_HOME` 不会改变 Codex、Claude 等默认从用户主目录发现的位置。

## 版本与后续验收

当前插件制品版本为 `0.1.0`，处于预览阶段；版本号未带预发布后缀不表示生产准入。`engines.dsh` 的 `>=0.2.1-rc.2` 是声明下限，SDK 与严格兼容验收的精确版本以仓库 `.dsh-version` 为准，不表示范围内每个宿主均已验证。设计文档版本独立于插件制品版本，不表示生产准入。

同版本重打包须记录源提交及是否含未提交修改，并用制品 SHA-256、`bundle-manifest.json` 和 `SHA256SUMS` 区分；只比较文件名或 `0.1.0` 不足以确认内容。最新测试、安装和宿主版本证据统一见[设计索引 §2.2](../../docs/design/README.md#22-实现与验证入口)。

后续按[设计 §6](../../docs/design/plugins/forge-skills-manager.md#6-实施与验收)收口预览回归、精确宿主基线兼容、正式凭据接入、企业只读权限与目标平台验收。Nacos 凭据采用包内专用只读账号；个人 IAM 换票未实现；当前未承诺正式版发布日期或新增产品范围。

## 打包方式选择

企业 IAM 联调与员工交付均使用包含 IAM 和技能管理器的 `@heluo/forge-enterprise`，按配置放置位置选择以下两种方式：

| 要求 | 开发联调包 | 正式交付包 |
|---|---|---|
| 用途 | 开发人员联调企业 IAM、网关和技能库 | 员工安装使用，统一企业连接配置 |
| 制品入口 | `build-enterprise-bundle.mjs` 默认企业入口 | 同一中性企业公版，经 `release-delivery.mjs` 制作私版 |
| 企业配置位置 | 隔离 profile 的 `cordis.patch.yml` | 打包人员的专用 `.env` → 私版 bundle 补丁层 |
| Nacos 四项配置 | 访问企业库前在 profile 中配齐；可先不配，验证本地管理 | 制包时地址、命名空间、账号、密码均必填，缺项拒绝 |
| 修改 Nacos 配置 | 修改 profile 后重启该 profile，无需重新打包 | 修改制包配置，以新私版版本重新预检、确认、安装并重启 |
| 员工侧配置 | 由开发人员维护测试 profile | 无需填写 Nacos 配置或注入账号密码环境变量 |
| 操作入口 | [开发联调包](#开发联调包)、[本地人工调试](#本地人工调试) | [企业测试包与正式环境包交付](#企业测试包与正式环境包交付) |

中性企业公版是可复用的构建基线，不含企业部署值；安装后配置开发 profile 即用于联调，注入企业配置后生成私版即用于交付。独立 Skill Manager 包用于仅调试本插件，不包含企业 IAM。当前脚本没有 `--mode dev/release` 参数，两种方式由上述命令流程区分。

测试环境与正式环境是正式交付方式的两套配置实例，均须预置 Nacos 四项配置；`.env.test` 生成的私版也不等于可随时修改配置的开发联调包。正式交付方式不表示当前预览插件已完成生产验收。

## 配置

### 正式制包配置

装配本插件的企业私版必须在制包时提供 Nacos 地址、命名空间、只读账号和密码，写入包内配置；员工无需环境注入。未装配本插件的包无需填写 Nacos，误填则拒绝。Nacos 无需 HTTP 开关，IAM 与网关仍遵循公共流程。

完整字段、文件权限、命令、预检与凭据边界集中在[技能管理器打包说明](docs/packaging.md)，该说明随独立工具链交付；规范定义见[Nacos 契约 §1](../../docs/contracts/nacos-skills.md#1-连接)。公共打包 Skill 与 SOP 保持原样，限定的 Nacos 凭据要求不扩展到其他秘密。

### 开发 profile 配置

开发联调在隔离 profile 的现有 `cordis.patch.yml` 合并以下内容；真实账号密码只放本机私有配置，不提交仓库：

```yaml
- id: heluo-skills-manager
  config:
    nacos:
      serverUrl: http://nacos.corp.example/nacos
      namespaceId: public
      username: svc-ci
      password: '<只读账号密码>'
```

修改上述字段后重启同一 profile 的 DSH，无需重新制包。IAM 配置按 [IAM 说明](../forge-iam/README.md)维护；同包安装不等于 Nacos 使用个人 IAM 权限，当前仍使用独立只读账号，不实现 IAM 换票。旧开发环境变量方式保留兼容；显式提供任一账号密码字段后必须两项完整，不回落环境变量。

### 正式包配置生效

正式包安装前备份并移除既有 profile 的 Nacos 覆盖项，避免旧值覆盖包内预置。DSH「打开配置文件」只显示 profile 补丁；插件不提供 Nacos 配置表单，不向浏览器返回账号密码。更新包内配置需重新制包、安装并重启 DSH。

缺少凭据时拒绝企业库访问且不复用缓存令牌，本地管理仍可用；Nacos 服务端必须限制账号只读。真实权限及目标平台验收分别记录。

本地操作响应丢失时显示待确认，通过「核对操作结果」读取 Host 回执，确认前不重复提交。插件卸载停止排队任务与远端读取，保留技能和管理数据。插件以 `heluo-skills-manager` 行挂载，每个 profile 只挂载一次。

## 构建与打包

从仓库根执行，Node 使用 `.node-version`，pnpm 使用根 `package.json` 的 `packageManager`。本包保留 TypeScript/esbuild 构建，`lib/` 是提交的生成物；修改 `src/` 后必须重建并核对差异：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @heluo/forge-skills-manager build
pnpm --filter @heluo/forge-skills-manager verify
pnpm check:docs
pnpm check:version
```

`build` 只生成 `lib/`，不生成安装包。fflate、react-markdown 与 remark-gfm 在构建期内联，浏览器只交付一个 `client.js` bundle，React 由宿主提供；终端不安装开发依赖、不再次编译 TypeScript 或这些库。

单包和企业组合包分别使用以下入口。将尖括号参数替换为仓库外、各自独立的新输出目录；默认企业入口已包含本插件，不再另装单包：

```sh
node scripts/build-enterprise-bundle.mjs --entry @heluo/forge-skills-manager <single-output-dir>
node scripts/build-enterprise-bundle.mjs <enterprise-output-dir>
```

每个目录生成 `.tgz`、`bundle-manifest.json`、`SHA256SUMS`。对实际选用的制品执行独立核验：

```sh
node scripts/verify-enterprise-bundle.mjs <tarball.tgz> --manifest <bundle-manifest.json> --json
```

打包器校验实际包体闭包及执行位，不代替源码构建和测试。Windows 工作区的企业组合打包当前可能被 IAM `bin/heluo-forge.mjs` 执行位检查拒绝；这与本插件 TypeScript 构建不同，不能将拒绝视为打包成功或关闭公共规则。标准企业交付使用符合包体要求的构建环境；本机已运行的预览重组制品及其核验边界见设计索引，不作为通用 Windows 发布命令已通过的证据。

完整检查入口为 `pnpm check`，具体检查职责见[贡献指南](../../CONTRIBUTING.md#7-检查命令)。全量检查在本机仍有上述 Windows IAM 执行位限制，本插件单独通过不表示全库通过。

### 开发联调包

1. 用上面的默认企业入口构建并核验中性 `.tgz`，不向源码或公版补丁写入企业配置。
2. 按[本地人工调试](#本地人工调试)安装到隔离 profile，登记 `@heluo/forge-enterprise` 一次。
3. 在该 profile 配置 [IAM](../forge-iam/docs/developer-guide.md) 与网关；按[开发 profile 配置](#开发-profile-配置)合并 Nacos 地址、命名空间、账号和密码。
4. 重启同一 profile，分别核验 IAM 登录、网关及 Nacos 读取。仅调整 Nacos 配置时重复第 3、4 步；修改插件源码时重新构建、打包并安装。

这条路径不调用私版制作器，构建时不要求提供 Nacos 四项部署值。未配置 Nacos 时可验证本地技能管理，发现页显示未配置。同包安装不代表 Nacos 继承个人 IAM 权限；当前 Nacos 仍使用独立只读账号，不实现 IAM 换票。

### 企业测试包与正式环境包交付

先执行前文的源码编译和验证，再构建并独立核验中性企业公版：

```sh
node scripts/build-enterprise-bundle.mjs ../releases/public
node scripts/verify-enterprise-bundle.mjs ../releases/public/heluo-forge-enterprise-0.1.0.tgz --manifest ../releases/public/bundle-manifest.json --json
```

输出使用仓库外的新目录，文件名版本须与实际公版一致。保留源提交、工作区状态、构建记录和摘要；使用他人提供的公版时，从可信发布记录取得 SHA-256。制作器只接受企业公版，不接受 Skill Manager 独立包或已配置的私版。

随后按[随工具链交付的专项说明](docs/packaging.md#预检与生成)准备配置、预检、确认并生成。测试与正式环境可复用同一中性公版，分别维护未跟踪且受忽略的配置文件、私版版本与输出目录；两者均需预置 Nacos 四项。仅修改部署值无需重新编译源码，修改后使用新私版版本重新生成。

标准制包环境为 macOS、Node 和系统 `zip`；Windows 源码调试不代表标准企业制包通过，POSIX 配置权限及 IAM 执行位限制仍需目标环境验证。员工按产物 `INSTALL.md` 安装，安装后分别核验实际 IAM、网关、Nacos 只读权限与目标平台；预检不证明企业联调或生产准入完成。

## 自动化验证

默认回归保留 Cordis 装卸和 SkillRegistry 候选选择测试。原生文件系统 provider、scope 合并与实际技能调用使用指定已安装宿主独立验证，不随默认测试安装完整调用链：

```sh
pnpm --filter @heluo/forge-skills-manager test:compat <installed-dsh-dir>
```

参数是已安装 `@deepseek-ai/dsh` 的包目录，须包含该包的 `package.json`；入口核对宿主及所需 DSH SDK 与根 `.dsh-version` 精确一致。未指定路径、依赖缺失或版本不符直接失败，不自动安装、不回落开发依赖、不跳过用例。发布、升级宿主基线以及修改技能发现、优先级或启停逻辑时必须运行，并单独记录兼容结果。该命令仅在临时目录验证原生技能调用，不启动用户 profile。

隔离宿主验收使用已安装 DSH 的 CLI 入口和本轮制品：

```sh
node packages/forge-skills-manager/scripts/verify-host.mjs <installed-dsh-cli.js> <plugin-or-enterprise.tgz>
```

该命令离线安装到全新临时 profile，启动仅绑定环回地址的真实 web 宿主，核对认证路由、并发管理、下载中断回执、重启恢复、同进程禁用/重载及卸载保留数据。Nacos 为合成 HTTP 服务，不读取用户默认配置；证据写入命令返回的临时目录。单包与企业组合制品分别执行。运行环境须提供与 Node 配套的 npm；浏览器交互、企业权限及目标平台另行验收。命令结束后停止测试宿主和合成 Nacos，不是持续运行的人工调试服务器。

## 本地人工调试

以下流程使用已安装的 DSH CLI、已核验的 `.tgz` 和新测试 profile。先确认 `node`、`npm`、`dsh` 可在当前终端调用并记录 `dsh --version`；CLI 版本与 `.dsh-version` 不一致时，仅记录实际版本的本机试用，不能据此宣称严格兼容通过。未配置 Nacos 时也可验证本地技能管理；仅调试本插件可选独立包，企业包的 IAM、网关配置分别遵循各自说明。

### 1. 准备隔离目录

在新终端中选用一段脚本；环境变量只对该终端及其子进程生效。脚本隔离文件来源，清除继承的 Agent 路径覆盖，不修改 PowerShell 的只读 `$HOME` 变量。它不提供同账户进程隔离，也不自动清除其他插件继承的企业认证环境。

PowerShell：

```powershell
$debugRoot = Join-Path ([IO.Path]::GetTempPath()) ('forge-skills-debug-' + [guid]::NewGuid())
Get-ChildItem Env:DSH_*_HOME | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
$env:HOME = Join-Path $debugRoot 'user'
$env:USERPROFILE = $env:HOME
$env:APPDATA = Join-Path $env:HOME 'AppData/Roaming'
$env:LOCALAPPDATA = Join-Path $env:HOME 'AppData/Local'
$env:DSH_HOME = Join-Path $debugRoot 'dsh'
$env:DSH_AGENTS_HOME = Join-Path $debugRoot 'agents'
New-Item -ItemType Directory -Force -Path $env:HOME, $env:APPDATA, $env:LOCALAPPDATA, (Join-Path $debugRoot 'workspace') | Out-Null
Set-Location (Join-Path $debugRoot 'workspace')
```

macOS/Linux（Bash；步骤供目标平台验收使用，本轮未实机验证）：

```bash
debug_root="$(mktemp -d "${TMPDIR:-/tmp}/forge-skills-debug.XXXXXX")"
for agent_variable in ${!DSH_@}; do
  case "$agent_variable" in DSH_*_HOME) unset "$agent_variable" ;; esac
done
export HOME="$debug_root/user" USERPROFILE="$debug_root/user"
export APPDATA="$HOME/AppData/Roaming" LOCALAPPDATA="$HOME/AppData/Local"
export DSH_HOME="$debug_root/dsh" DSH_AGENTS_HOME="$debug_root/agents"
mkdir -p "$HOME" "$APPDATA" "$LOCALAPPDATA" "$debug_root/workspace"
cd "$debug_root/workspace"
```

默认只在隔离用户目录内放置合成技能，例如 `.codex/skills/demo-skill/SKILL.md`、`.claude/skills/demo-skill/SKILL.md`。文件须有合法的 `name`、`description` frontmatter 和正文。测试项目技能前，在宿主登记该测试 workspace。若要检查真实本机 Agent 技能，可有意保留真实用户主目录和相应 Agent 环境覆盖、只隔离 `DSH_HOME`；这会读取真实技能，公共 Agent 可写来源也可能落到真实目录，不能再视为隔离数据验收。

合成 `SKILL.md` 的最小内容：

```markdown
---
name: demo-skill
description: 本地隔离来源识别测试
---
仅用于检查技能来源识别，不访问外部系统。
```

### 2. 安装并登记一个 bundle

在上述终端初始化全新 web profile：

```sh
dsh --profile skills-debug --from-default-profile web --dump-config
```

切换到刚生成的 `DSH_HOME/profiles/skills-debug` 目录；PowerShell 使用 `$env:DSH_HOME`，Bash 使用 `$DSH_HOME`。将参数替换为制品的绝对路径后执行：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false <absolute-tarball.tgz>
```

在该目录现有 `package.json` 的 `dsh.profile.bundles` 数组中追加 `@heluo/forge-skills-manager`；若安装企业组合制品，改为追加 `@heluo/forge-enterprise`。保留其他字段和默认 bundle，同一条目只登记一次，两个制品二选一。安装依赖和登记装配是两个步骤，不能只安装而未挂载。

### 3. 配置与启动

安装独立包或中性企业公版作开发调试时，在该 profile 的 `cordis.patch.yml` 合并本文「配置与替换」中的 `heluo-skills-manager` 行，保留其他配置；只有本机 Nacos 演示才将 `serverUrl` 改为 `http://127.0.0.1:8848/nacos`。没有 Nacos 时省略连接配置，预期发现页显示未配置。

安装已预置连接配置的企业私版时，直接使用包内配置，不在 profile 中新增 Nacos 行；若有旧覆盖项，先备份再移除。已有 profile 不可整份覆盖；最终有效装配中 `heluo-skills-manager` 只挂载一次。配置文件入口不显示 Nacos 字段的验收使用这种安装方式。

开发联调在私有 profile 配置账号密码；正式包直接使用包内预置，无需运行环境变量。

从测试 workspace 运行：

```sh
dsh --profile skills-debug --dump-config
dsh --profile skills-debug --host 127.0.0.1 --port 0 --no-open
```

先核对 dump 中本插件恰好挂载一次，再使用终端返回的本机地址及启动认证信息进入浏览器。端口自动分配，不固定抄用历史地址；带认证令牌的链接、Cookie 和配置秘密不复制到文档或问题报告。关闭测试宿主使用所在终端的 Ctrl+C。

### 4. 验收与修改后更新

| 场景 | 预期 |
|---|---|
| 来源识别 | 合成 Codex/Claude 技能可见且源文件只读；缺失来源明确检查目录和来源开关 |
| 本地管理 | 全局及已登记项目创建/导入、显式启停、分类、回收及恢复正常，重启后状态保留 |
| 企业库下载 | 完整资源下载后默认禁用，显式启用；再次进入或刷新发现页显示对应全局/项目的已下载状态 |
| 冲突和待确认 | 不覆盖已有同名技能；响应不确定时只核对结果，不重复下载，不显示虚假成功 |
| 数据保留 | 移除插件挂载后技能与管理数据仍在；卸载步骤可使用自动化隔离验收，勿拿真实技能试删 |

插件没有仓库源码热更新或独立开发服务器。修改后按「构建与打包」重新生成 `lib/`，打到新输出目录并核验摘要；停止这个测试 DSH，在同一测试 profile 安装新的 `.tgz`，保留 bundle 登记及配置，再启动并刷新浏览器。仅重编译仓库不会更新已安装的 `node_modules`；同为 `0.1.0` 时也要核对实际安装文件或制品摘要，避免误测旧包。

只发布清单声明的生成物和资源。fflate、react-markdown 与 remark-gfm 在构建期内联，React 复用宿主。构建仅生成运行代码；生成物检查先通过包内 `scripts/check-sdk.mjs` 核对本包开发 SDK 与根 `.dsh-version` 一致，再比对生成物与源码。终端不安装开发依赖、不编译。合成离线用例不连接企业 Nacos，也不代替真实宿主、企业联调或国产平台验证。用户页面写入不等同于 Agent 工具授权；首版不注册自动 `create_skill` 工具，不放宽企业策略的宿主目录保护。同账户进程和同权 Host 插件仍能绕过进程内检查，本包不提供进程隔离。
