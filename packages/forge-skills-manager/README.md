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

企业交付通过私版制作器将连接配置预置在 bundle 内声明 `heluo-skills-manager` 的补丁层，员工 profile 无需填写 Nacos 配置。DSH「打开配置文件」显示当前 profile 的补丁，技能管理不提供 Nacos 配置表单；包内预置字段仍可从安装目录或解包查看。页面中的技能命名空间信息保留。

在打包人员的专用、未跟踪且受 Git 忽略的配置文件中，除已有 IAM 必填配置外，可加入：

```dotenv
HELUO_NACOS_SERVER_URL=https://nacos.corp.example/nacos
HELUO_NACOS_NAMESPACE_ID=public
HELUO_NACOS_USERNAME_ENV=FORGE_NACOS_USERNAME
HELUO_NACOS_PASSWORD_ENV=FORGE_NACOS_PASSWORD
HELUO_NACOS_TIMEOUT_MS=15000
HELUO_NACOS_ALLOW_INSECURE_HTTP=false
```

只有 `HELUO_NACOS_SERVER_URL` 为启用预置时必填；其余字段可省略，沿用插件默认值。超时为 100–120000 毫秒；HTTP 必须单独设置 `HELUO_NACOS_ALLOW_INSECURE_HTTP=true`，不继承 IAM 的 HTTP 开关。`USERNAME_ENV`、`PASSWORD_ENV` 是变量名，不是账号密码。制作器拒绝未知字段，不能把实际用户名、密码或 token 放入该文件。

使用配套 Node 和仓库现有私版制作流程，配置文件权限须为 `600`，输出在仓库外，版本须与公版不同：

```sh
node scripts/make-private-bundle.mjs --public <public.tgz> --public-sha256 <trusted-sha256> --config <enterprise.env> --version <private-version> --output <private-output-dir>
```

先核对脱敏预览，再按工具回显的摘要确认；完整交付方式见[企业集成方案](../../docs/architecture/public-enterprise-bundle.md#4-公版构建与本地二次制作)。只改变部署字段无需重编译 TypeScript 或内联库。已有 profile 中的 Nacos 覆盖项须在备份后移除，否则「打开配置文件」仍能看到旧值，且旧值可能覆盖包内配置。更新包内连接字段后重启 DSH。

独立安装或本地开发调试可在 profile 中配置下列内容；该方式会让这些字段在「打开配置文件」中可见，不用于上述企业交付：

```yaml
- id: heluo-skills-manager
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

替换旧版时先备份 profile 配置，再停用并移除旧 `@michengai/dsh-skills-manager` 挂载（其行 id 为 `skills-manager`），安装新包并检查旧 `skills-manager` 行已消失、`heluo-skills-manager` 行只出现一次；两个行 id 并存会让两个管理器同时挂载。保留原 `$DSH_HOME/skills-manager` 数据、宿主全局与项目技能；不同时运行两个管理器。卸载本包不删除这些数据。本包在创建、导入与自身 provider 中拒绝 `enterprise-*` 个人候选；宿主原生 provider 的同名候选选择仍遵循宿主规则。

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

### 企业测试包与正式环境包交付

交接顺序为：源码编译与检查 → 中性企业公版构建与核验 → 准备环境配置 → 私版预检与摘要确认 → 交付 → 注入运行凭据并验收。这里的「正式环境包」指写入正式环境部署配置的私版包，不代表当前预览插件已获生产准入。企业联调、正式凭据方案与目标平台验收仍按[设计 §6](../../docs/design/plugins/forge-skills-manager.md#6-实施与验收)收口。

制包命令从仓库根执行，以下使用 macOS 的 Bash 环境与系统 `zip`。Windows 的源码编译和本地调试与标准企业制包分开：除了上述执行位限制，私版制作器还要求配置文件具备 POSIX `600` 权限；不能以本机预览重组结果替代标准流程通过的证据。完整 macOS 交付与真实企业环境须另行验证。

#### 1. 准备中性企业公版

先执行本节前面的依赖安装、源码 `build`、`verify` 和相关检查，再构建企业组合包：

```sh
node scripts/build-enterprise-bundle.mjs ../releases/public
node scripts/verify-enterprise-bundle.mjs ../releases/public/heluo-forge-enterprise-0.1.0.tgz --manifest ../releases/public/bundle-manifest.json --json
```

`../releases/public` 是仓库外的新目录，文件名中的 `0.1.0` 须与实际公版版本一致。公版保持配置中性，不含企业地址、账号密码或个人状态。保留源提交、工作区是否有未提交修改、构建记录与摘要；读取他人提供的公版时，从可信发布记录核对 SHA-256，不只信任同目录的校验文件。工具链须与公版配套，IAM 校验模块不匹配时停止，不跳过校验。

私版制作器仅接受 `@heluo/forge-enterprise` 的公版 `.tgz`，不接受 Skill Manager 独立包，也不以已配置的企业私版包再次作为公版输入。只需要独立插件开发调试时，使用前文单包命令和[本地人工调试](#本地人工调试)。

#### 2. 准备测试与正式环境配置

打包人员手工维护 `.env.test`、`.env.production`，不覆盖已有文件；确认文件被 Git 忽略且未被跟踪。两者都只供制作器读取，不随包交付。下列 `.env.test` 示例包含企业 IAM、模型网关及 Nacos 连接字段，全部值均为占位示例，须按提供方实际配置替换：

```dotenv
HELUO_IAM_AUTH_MODE=public
HELUO_IAM_ISSUER=https://iam-test.corp.example
HELUO_IAM_DISCOVERY_URL=https://iam-test.corp.example/.well-known/openid-configuration
HELUO_IAM_CLIENT_ID=forge-console
HELUO_IAM_SCOPES=openid profile offline_access
HELUO_IAM_CALLBACK_PORT=0
HELUO_IAM_REVOCATION_ENDPOINT=https://iam-test.corp.example/revoke
HELUO_IAM_MANAGED_MODELS_BASE_URL=https://gateway-test.corp.example/v1
HELUO_IAM_DEFAULT_PROVIDER=enterprise
HELUO_NACOS_SERVER_URL=https://nacos-test.corp.example/nacos
HELUO_NACOS_NAMESPACE_ID=public
HELUO_NACOS_USERNAME_ENV=FORGE_NACOS_USERNAME
HELUO_NACOS_PASSWORD_ENV=FORGE_NACOS_PASSWORD
HELUO_NACOS_TIMEOUT_MS=15000
HELUO_NACOS_ALLOW_INSECURE_HTTP=false
```

`issuer` 是信任锚，必须与 Discovery 文档及令牌中的值精确一致；Discovery、撤销端点、client ID 和网关 provider 取实际值，不能按示例猜测地址或路由标识。默认退出路径的撤销协议须另行联调。使用 HTTP 时分别显式配置 `HELUO_IAM_ALLOW_INSECURE_HTTP=true`、`HELUO_NACOS_ALLOW_INSECURE_HTTP=true`，仅设置所需的开关；两者不互相授权。

| 项目 | 测试环境包 | 正式环境包 |
|---|---|---|
| 制包配置文件 | `.env.test` | `.env.production` |
| IAM、网关及 Nacos | 实际测试服务；本地模拟须明确标记 | 企业正式服务与经核验的端点 |
| Nacos 命名空间及只读权限 | 测试命名空间与测试账号 | 正式命名空间与专用只读账号 |
| 私版版本示例 | `0.1.0-corp.test.1` | `0.1.0-corp.1` |
| 输出目录示例 | `../releases/corp-test-1` | `../releases/corp-1` |
| 验证边界 | 测试服务或 mock，不替代企业联调 | 企业登录、网关、Nacos 服务端拒写及目标平台实测 |

两个环境可复用同一份已核验的中性公版，但配置、私版版本、输出目录及测试数据必须区分。私版版本须与公版不同；配置或内容改变时使用新的私版版本，不覆盖已有交付物。profile 名称不是构建参数，不打入用户 profile、技能目录、凭据库或会话数据。仅改变部署配置时无需重新编译 TypeScript 或内联库。

#### 3. 预检、确认并生成交付物

确认 `.env.test` 是本次专用配置文件后设置权限，并填写下列参数。`bundle_sha` 使用前一步核验的公版摘要；输入文件、配置、版本或输出位置改变后，重新预检：

```bash
chmod 600 .env.test
bundle_public='../releases/public/heluo-forge-enterprise-0.1.0.tgz'
bundle_sha='<替换为已核验的公版SHA-256>'
bundle_config='.env.test'
bundle_version='0.1.0-corp.test.1'
bundle_output='../releases/corp-test-1'
node scripts/release-delivery.mjs \
  --public "$bundle_public" --public-sha256 "$bundle_sha" \
  --config "$bundle_config" --version "$bundle_version" \
  --output "$bundle_output" --dry-run
```

预检不写产物。核对 `configKeys` 包含所需的 `nacos.*` 键、`loginReady: true`、`gatewayConfigured: true`；使用 Discovery 时核对 `discovery.checked: true`。配置了撤销端点不表示其协议已联调。预检与错误不回显配置值；本地路径仍须在对外分享前脱敏。不要把 `--skip-discovery-check` 当成解决配置错误的方法；必要的离线制作须单列未验证项。

审核预检结果后，使用其 `planDigest` 的前至少 8 位确认，同一终端内执行：

```bash
read -r -p '输入本次预检 planDigest 的前至少 8 位: ' bundle_confirm
node scripts/release-delivery.mjs \
  --public "$bundle_public" --public-sha256 "$bundle_sha" \
  --config "$bundle_config" --version "$bundle_version" \
  --output "$bundle_output" --confirm "$bundle_confirm"
```

正式环境包先对 `.env.production` 设置 `600` 权限，再把 `bundle_config`、`bundle_version`、`bundle_output` 分别换成表中正式环境参数，重新执行预检及确认，不沿用测试包摘要。目录须在仓库外且不存在或为空，相邻的同名 `.zip` 也不得已存在。命令失败时保留错误证据，不手工补清单把失败产物当成功交付。

成功时输出目录及其相邻的 `<输出目录名>.zip` 包含：

| 位置 | 内容及用途 |
|---|---|
| `enterprise-plugin/` | 配置预置后的企业 `.tgz`、`bundle-manifest.json`、`private-release.json` 和插件校验和 |
| `installer/` | 初始化脚本及 macOS、Windows、Linux 安装启动器 |
| `INSTALL.md` | 员工安装、profile 边界及故障说明 |
| `SHA256SUMS` | 交付目录内文件校验和；外层 zip 摘要另由命令回显 |

员工接收经授权的内部交付 zip；保留制包回执和 zip 摘要。只有需要私版插件 `.tgz`、不需要员工安装材料时，可使用[配置与替换](#配置与替换)中的 `make-private-bundle.mjs`，输入字段和运行凭据边界相同。

#### 4. 注入运行凭据并安装验收

制包配置中的 `HELUO_NACOS_USERNAME_ENV`、`HELUO_NACOS_PASSWORD_ENV` 只保存变量名。实际账号密码由部署人员通过启动环境提供，例如本例使用 `FORGE_NACOS_USERNAME`、`FORGE_NACOS_PASSWORD`；具体隐藏输入方法见[配置与启动](#3-配置与启动)。私版制作器不读取这些变量的实际值，不把秘密写入 bundle，也不从 IAM 登录自动换取 Nacos 凭据。

安装启动器负责准备宿主和安装插件，**不负责读取私有运行期 `.env` 或注入 Nacos 账号密码**。若使用运行期 `.env`，须另由部署方启动脚本按数据加载并注入，不能与制包配置混用或随包交付；插件不会自行读取该文件。通过同一环境启动 DSH，外部环境变更后重启；Desktop 应用也必须从能够继承该环境的启动方式运行，不能假定终端中设置的变量会自动传给已运行的应用。统一凭据启动器与正式凭据方案仍待实现和核验，交接时须明确部署负责人。

按产物内 `INSTALL.md` 安装；默认员工启动器安装到 web profile，Desktop 是独立 profile，按其应用内安装流程操作。安装后从注入凭据的终端运行 `dsh web`；使用自定义 profile 的开发人员按[本地人工调试](#本地人工调试)启动同一 profile，不依赖历史的测试 profile 名称。

| 验收项 | 预期 |
|---|---|
| 安装与装配 | 本次版本及摘要正确，企业 bundle 挂载一次，不同时挂载独立 Skill Manager |
| 配置展示 | 备份后移除既有 profile 中旧的 Nacos 覆盖项；「打开配置文件」不显示这些字段，包内预置内容仍可解包读取 |
| 本地管理 | 全局、已登记项目、其他 Agent 来源与既有用户数据正常，企业库不可达不影响本地管理 |
| 企业库已配置且凭据正确 | 可以读取列表、查看详情和下载；下载默认禁用，再次进入显示已下载状态 |
| 凭据缺失或服务停止 | 凭据缺失按契约拒绝；已配置但服务不可达时显示不可用，不应显示未配置或下载成功 |
| 企业依赖 | 实际登录、网关模型及 Nacos 服务端只读权限分别验证；本地 mock 不算企业证据 |

记录制品版本、源提交及工作区状态、摘要、宿主版本、profile、命令结果及未验证项，不记录密码、令牌或 Cookie。完整本地检查、测试环境可用、企业联调通过和正式上线准入是不同事实。

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

安装独立包或中性企业公版作开发调试时，在该 profile 的 `cordis.patch.yml` 合并本文「配置与替换」中的 `heluo-skills-manager` 行，保留其他配置；只有本机 Nacos 演示才将 `serverUrl` 改为 `http://127.0.0.1:8848/nacos` 并显式增加 `allowInsecureHttp: true`。没有 Nacos 时省略连接配置，预期发现页显示未配置。

安装已预置连接配置的企业私版时，直接使用包内配置，不在 profile 中新增 Nacos 行；若有旧覆盖项，先备份再移除。已有 profile 不可整份覆盖；最终有效装配中 `heluo-skills-manager` 只挂载一次。配置文件入口不显示 Nacos 字段的验收使用这种安装方式。

两种方式都需要由部署方启动脚本或当前终端注入账号密码，不写进 YAML；私有运行期 `.env` 须先由该脚本加载，交付物中的安装启动器不会自动完成此步骤。

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
