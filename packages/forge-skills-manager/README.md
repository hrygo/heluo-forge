# 技能管理

状态：可用（本地实现；迁移后的验证边界见[设计索引](../../docs/design/README.md#22-实现与验证入口)）。

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

当前插件制品版本为 `0.1.0`，处于预览阶段；版本号未带预发布后缀不表示生产准入。`engines.dsh` 的 `>=0.2.1-rc.2` 是声明下限，SDK 与严格兼容验收的精确版本以仓库 `.dsh-version` 为准，不表示范围内每个宿主均已验证。设计文档的 `V0.x` 是独立文档版本。

同版本重打包须记录源提交及是否含未提交修改，并用制品 SHA-256、`bundle-manifest.json` 和 `SHA256SUMS` 区分；只比较文件名或 `0.1.0` 不足以确认内容。最新测试、安装和宿主版本证据统一见[设计索引 §2.2](../../docs/design/README.md#22-实现与验证入口)。

后续按[设计 §6](../../docs/design/plugins/forge-skills-manager.md#6-实施与验收)收口预览回归、精确宿主基线兼容、正式凭据接入、企业只读权限与目标平台验收。正式凭据来源和 IAM 换票接口仍待确认；当前未承诺正式版发布日期或新增产品范围。

## 配置与替换

```yaml
- id: skills-manager
  config:
    nacos:
      serverUrl: https://nacos.corp.example/nacos
      namespaceId: public
      usernameEnv: FORGE_NACOS_USERNAME
      passwordEnv: FORGE_NACOS_PASSWORD
```

预览版在启动 DSH 的进程环境中设置 `FORGE_NACOS_USERNAME`、`FORGE_NACOS_PASSWORD`，上述配置只写变量名。也可使用自定义变量名；省略这两个配置字段时使用上述默认名称。账号密码不需在构建或安装时设置、不打进插件包，也不需录入宿主凭据库。若使用本机私有 `.env`，须由启动脚本加载并注入 Host 环境，插件不自动读取该文件；秘密文件不得提交或放入交付物。修改外部环境或 `.env` 后须重启 DSH。

缺少或空白凭据时，企业库拒绝访问且不复用缓存令牌，本地管理仍可使用。进程内凭据变化会触发重新登录；令牌仅缓存于内存。Nacos 账号必须由服务端赋予读取权限；客户端不使用管理员、不提供上传接口。共享账号不是个人 IAM 身份映射；只读账号的服务端拒写须另行验证。环境变量方式是仅限预览版的 P8 受信存储临时例外，正式版接入仍须核验，详见[设计](../../docs/design/plugins/forge-skills-manager.md#3-配置与数据)。

本地操作响应丢失时显示待确认，通过「核对操作结果」读取 Host 回执，确认前不重复提交。确认后重新读取当前状态；刷新失败会明确提示视图尚未更新。插件卸载停止排队任务和远端读取，已开始的本地事务与下一实例串行衔接。

替换旧版时先备份 profile 配置，再停用并移除旧 `@michengai/dsh-skills-manager` 挂载，安装新包并检查同一个 `skills-manager` 行只出现一次。保留原 `$DSH_HOME/skills-manager` 数据、宿主全局与项目技能；不同时运行两个管理器。卸载本包不删除这些数据。本包在创建、导入与自身 provider 中拒绝 `enterprise-*` 个人候选；宿主原生 provider 的同名候选选择仍遵循宿主规则。

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

在该 profile 的 `cordis.patch.yml` 合并本文「配置与替换」中的 `skills-manager` 行，保留其他配置；只有本机 Nacos 演示才将 `serverUrl` 改为 `http://127.0.0.1:8848/nacos` 并显式增加 `allowInsecureHttp: true`。没有 Nacos 时省略连接配置，预期发现页显示未配置。账号密码由私有启动器或当前终端注入，不写进 YAML；`.env` 必须先由启动器加载。替换现有 profile 前先备份，不覆盖原配置；最终合并结果中 `skills-manager` 只能出现一次。

需要手动注入时，在启动 DSH 的同一终端输入只读测试账号；密码采用隐藏输入，避免将明文直接写入命令历史。

PowerShell：

```powershell
$env:FORGE_NACOS_USERNAME = Read-Host 'Nacos 只读测试账号'
$nacosPassword = Read-Host 'Nacos 测试密码' -AsSecureString
$env:FORGE_NACOS_PASSWORD = [System.Net.NetworkCredential]::new('', $nacosPassword).Password
Remove-Variable nacosPassword
```

Bash：

```bash
read -r -p 'Nacos 只读测试账号: ' FORGE_NACOS_USERNAME
read -r -s -p 'Nacos 测试密码: ' FORGE_NACOS_PASSWORD
printf '\n'
export FORGE_NACOS_USERNAME FORGE_NACOS_PASSWORD
```

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
