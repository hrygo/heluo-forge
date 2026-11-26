# forge-skills-manager 实现与验证记录

编制：Agent（代拟）。使用说明见[技能管理器](../../../packages/forge-skills-manager/README.md)，行为与边界见[模块设计](../plugins/forge-skills-manager.md)。

## 当前实现

本地技能管理与 Nacos 只读发现；Skill Manager 由自己的 TGZ 与补丁独立安装，enterprise 不依赖、捆绑或挂载它。正式交付由包内 `scripts/package.mjs` 预置 Nacos 地址、命名空间和固定凭据引用；账号密码写入包内 `private/nacos-credentials.json`，Host 运行时读取，不写回配置对象，安装后无需填写连接配置。中性构建包用于开发，profile 可作开发覆盖。HTTP/HTTPS 均可，无 Nacos HTTP 开关。项目级交付器和安装器保持 enterprise 单包流程；Nacos 内嵌限定要求按契约记账。页面与错误不回显凭据，旧环境变量方式兼容开发使用。真实 Cordis 用例验证 manager 作用域可以动态绑定同 Host 的 IAM；产品代码尚不消费具体 IAM 能力，不实现 IAM 换票。独立预置 TGZ 在目标 DSH 0.2.2-rc.5 的隔离 profile 装载与诊断脱敏通过；三包离线装配的历史实测宿主为 0.2.2-rc.2；企业权限、完整三包装卸及目标平台仍待验。

## 2026-11-26 PR 465 最新主线文档冲突集成

本地 rebase 集成主线 `6e4bfef` 的七个新提交，保留 27 个分支提交，由 `post-rewrite` 完成重新扫描与签名。唯一冲突是本文关联架构方案的版本字段，正文保留双方修改，版本统一为 V0.9.4。安装器及测试自动合并；三方树核对表明 rebase 结果与预期自动合并树仅有该文档版本字段差异。Skill Manager 包内容与集成前逐字一致，包含上一轮 Linux 凭据目录修复。根 README 的产品受众职责未变化。

固定 Node 24.21.0 / pnpm 11.28.5，本机 Windows；未重新制作正式员工包，未新增企业 Nacos/IAM 或目标平台验收。

| 命令与范围 | 结果与耗时 |
|---|---|
| `node --test packages/forge-skills-manager/test/bundled-credentials.test.mjs packages/forge-skills-manager/test/nacos-credentials.test.mjs` | 17 项全部通过，约 1.1 秒；包括目录链接拒绝、包内及开发凭据读取、令牌失效与轮换 |
| `node --test --test-name-pattern='readPrivateRelease\|parseArgs：--pnpm-store\|storePreflight\|预检演练' tests/init-enterprise-plugin.test.mjs` | 6 项中 5 通过、1 失败，约 0.45 秒；失败为 main 新增 store 预检用例的 Windows 绝对路径预期。对 `6e4bfef` 隔离源码归档运行同一失败用例，约 0.23 秒，以相同差异复现；不是自动合并引入。去除该已核验失败项的五项定向回归全部通过，约 0.69 秒 |
| 根目录 `pnpm check` | 生成物一致性、类型、文档、仓库结构、技能、12 包 618 文件归档审计与版本检查通过；5488 项中 5312 通过、109 失败、67 跳过，整体约 405.6 秒、测试约 355.6 秒。失败涉及 Windows 路径、权限、IAM 锁等待与 POSIX 工具等；失败明细未列出 Skill Manager 包内用例。除上述 store 用例外，本轮未逐项基线对照，不记全库通过 |
| `node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD`（rebase 后、收尾记录提交前） | 27 个提交签名校验通过，约 5.9 秒；推送前再次核验 |

## 2026-11-26 PR 465 Linux 凭据目录链接校验

包内凭据目录以不带末尾斜杠的固定路径执行 `lstat`，拒绝符号链接或 junction 后才读取凭据文件。POSIX 对带末尾斜杠的目录路径会跟随链接，原路径使目录链接被当成普通目录；修复同步源码与 `lib/nacos.js`，保留既有行为回归用例，不调整凭据交付方式和错误契约。

固定 Node 24.21.0 / pnpm 11.28.5；Windows 自动化使用合成凭据与临时目录，Linux 路径探针在本机 WSL 隔离目录执行：

| 命令与范围 | 结果与耗时 |
|---|---|
| 修复前 [Ubuntu CI](https://github.com/hrygo/heluo-forge/actions/runs/45787743527/job/139798835330) | 5478 项中 5469 通过、1 失败、8 跳过，测试约 91.6 秒；既有 `a linked private directory is rejected before remote access` 用例因未拒绝目录链接而失败 |
| `node packages/forge-skills-manager/scripts/build.mjs`；`node --test packages/forge-skills-manager/test/bundled-credentials.test.mjs packages/forge-skills-manager/test/nacos-credentials.test.mjs` | 构建通过，仅更新 Nacos 生成模块；17 项全部通过，测试约 1.0 秒，覆盖目录链接拒绝、正常包内凭据、旧显式/环境配置、远端读取、凭据失效和令牌轮换 |
| WSL 隔离目录建立符号链接，分别对带与不带末尾斜杠的路径执行 `stat -c '%F'` 并断言类型 | 通过，约 7.3 秒；原路径识别为目标目录，修复路径识别为符号链接。该项是 Linux 文件系统语义探针，不代替 Node 自动化或企业环境验收 |
| 根目录 `pnpm check` | 生成物一致性、类型、文档、结构、技能、12 个包的 618 文件归档审计及版本检查通过；5469 项中 5297 通过、108 失败、64 跳过，整体约 405.0 秒、测试约 358.8 秒。失败涉及 Windows 下的 IAM 锁等待、路径、权限及 POSIX 工具等，失败明细未列出 Skill Manager 包内用例；本轮未逐项主线对照，不将全量检查记为通过 |

## 2026-11-26 PR 465 冲突与宿主基线集成

分支以本地 rebase 集成主线 `b4e393a`，保留主线 `DSH_PRIMARY_RUNTIME` 两行条件装配、Windows bin 模式归一化与发布文件名处理；保留 enterprise 四插件、engineering 五行与独立 Skill Manager 一行的分层，按 id 合并为九行。Skill Manager 的运行时代码、凭据隔离及自身补丁与集成前逐字一致。24 个分支提交由 `post-rewrite` 重新扫描并签名。随后集成主线 `cb8c4dd`（新增的 PR 审查配置、CI 分类白名单与桌面载荷预算调整），25 个分支提交再次由钩子扫描、签名，未引入 merge commit。开发 SDK 与安装下限同步根基线 `0.2.2-rc.5`，锁文件随依赖重建；构建后 26 个生成文件未变化。

集成检查发现打包脚本重复声明 tarballs，既有制包测试因 SyntaxError 失败；删除重复声明后，脚本与主线一致、原入口可执行。独立发布工具说明新增的 README 链接不在归档内，既有闭包断言失败；改为源码位置说明后同一断言通过，不扩大发布工具内容。企业设计中的策略目录口径统一为补丁实际登记的六条受控写动作，运行时两行与品牌四插件同时保留。根 README 未增加内部开发内容。

固定 Node 24.21.0 / pnpm 11.28.5，本机 Windows；使用仓库外新装的官方 DSH 0.2.2-rc.5，未修改用户现用 DSH、Nacos 或已有正式候选制品。

| 命令与范围 | 结果与耗时 |
|---|---|
| `pnpm install --ignore-scripts`、`node packages/forge-skills-manager/scripts/build.mjs` | 依赖安装通过，约 12.6 秒；构建通过、生成物无差异，未单独计时 |
| 包目录 `node --run verify` | 176 项全部通过，无跳过；测试约 332.8 秒，生成物一致性与类型检查通过 |
| `verify-runtime.mjs <installed-dsh-dir>`（包内脚本） | 官方目标 DSH 及四个 dsh SDK 精确版本核验通过；真实 Scope/SkillRegistry/skill.execute 禁用与恢复回归通过，约 2.8 秒 |
| `verify-preset-host.mjs <installed-dsh-cli.js>`（包内脚本） | 3 项通过，约 39.8 秒；最终预置 TGZ、新 HOME/profile/空缓存、合成账号登录成功；安装 stdout/stderr、启动前后配置诊断、HTTP/Host 输出及排障分类无凭据原值；删除凭据文件后拒绝缓存远端访问、本地管理可用 |
| enterprise 补丁、演练断言、独立包、员工包边界、IAM 同 Host、公共发布及组合构建/校验定向八文件 | 初轮 79 项中 73 通过、4 失败、2 跳过，约 92.0 秒；其中说明链接失败已修复，同一断言重跑通过，约 1.0 秒。另三项为 Windows 文件 symlink EPERM 与 POSIX mkdir 缺失；在 `cb8c4dd` 隔离源码归档以相同工具链逐项复现 3 项同名失败，约 3.5 秒 |
| 最新 main 集成后：enterprise 补丁、演练断言、独立 TGZ、同 Host IAM 与员工包边界五文件 | 21 项中 19 通过、2 项完整 sdk/web 演练跳过，无失败，约 28.6 秒 |
| 最新 main 的 CI 分类、PR 审查配置与桌面载荷暂存三文件；与 `cb8c4dd` 隔离副本逐项对照 | 两侧均为 164 项中 142 通过、21 失败、1 跳过，约 175.9 / 175.8 秒；失败名称逐项一致，涉及 Windows 不可移植路径及缺少 POSIX 工具；相关源码与 main 逐字一致 |
| `node scripts/check-docs.mjs`、`check-repo.mjs`、`dsh-version.mjs check` | 通过，合计约 7 秒；提交前重新核验 |
| 根目录 `pnpm check`（b4e393a 集成后） | 静态检查与全部 12 个产品归档审计通过（618 文件）；全库 5450 项中 5280 通过、106 失败、64 跳过，整体约 391.7 秒、测试约 346.4 秒。失败涉及未修改的 IAM 锁等待、品牌/研发用例及 Windows 权限、路径和缺少 POSIX 工具等；仅对上行三项做了主线对照，不推断其余全部为既有失败，不记全库通过 |

本轮验证不代替企业 Nacos/IAM 权限、完整桌面 GUI 或国产平台验收。完整 sdk/web 三包装卸演练因入口未检测到 PATH 上的 dsh 而跳过；独立预置包的真实目标 Host 已由上述专用入口验证。此前正式候选 `0.1.0-corp.20261126.3` 保持原制品与历史宿主证据，不将其标记为本次新基线的重新制包。

## 2026-11-26 PR 465 配置诊断凭据隔离

独立预置包把账号密码放入 UTF-8 JSON，最大 16 KiB、归档模式 0600；补丁只含非敏感连接字段及 `credentialsRef: bundled`。运行时读取固定包内文件，拒绝任意引用、链接、混用旧明文/环境字段、损坏或缺失文件，不回落环境凭据。移除文件后即使存在缓存令牌也拒绝远端访问；恢复或轮换后重新登录。本地管理保留。员工排障说明只收集装载状态和公开错误分类，独立包不经过项目级安装器或交付器；这两个工具与公共发布流程未修改。设计、契约、包 README 与制包说明同步，根 README 的产品受众职责保持。

固定 Node 24.21.0 / pnpm 11.28.5，本机 Windows，代码回归使用合成凭据、全新 profile 和临时目录；正式私版制包单独沿用本机 Nacos 配置。未改动用户现用 DSH/Nacos：

| 命令与范围 | 结果与耗时 |
|---|---|
| 根目录：`node --test --test-reporter=spec --test-name-pattern='private TGZ' tests/skills-manager-package.test.mjs`，修复前执行新增断言 | 因补丁仍含账号密码且缺少引用，1 项按原缺陷失败，约 5.5 秒；修复后同入口通过，约 11.5 秒 |
| 根目录：`node packages/forge-skills-manager/scripts/build.mjs` | 通过，更新跟踪的 `lib/nacos.js`；未单独计时 |
| 根目录：`node --test packages/forge-skills-manager/test/bundled-credentials.test.mjs` | 5 项通过，约 1.3 秒；覆盖冻结 Host 配置、列表/详情/下载、精确保留凭据字节、缺失/损坏/超限/编码/字段错误、混用拒绝、缓存撤销/恢复/轮换及目录链接拒绝 |
| 包目录：`node --run verify` | 176 项全部通过，无跳过，测试约 102.2 秒；26 个生成文件一致、类型检查通过，包含既有明文与环境凭据、管理/Nacos/UI 回归、并发与结构变异 |
| 根目录：`node --test tests/skills-manager-package.test.mjs tests/skills-manager-iam.test.mjs tests/employee-skills-boundary.test.mjs packages/forge-enterprise/test/bundle-patch.test.mjs packages/forge-skills-manager/test/independent-package.test.mjs` | 16 项通过，约 32.7 秒；最终预置 TGZ、归档模式、清单保留凭据文件、其他条目无凭据、摘要与回执脱敏、空缓存离线安装及超限拒绝；保持 enterprise 装配和同 Host IAM 服务绑定 |
| 根目录：`node packages/forge-skills-manager/scripts/verify-preset-host.mjs <installed-dsh-cli.js> <official-electron-executable>` | 首轮及补充 npm stderr 核验后的重跑均为 3 项通过；首轮约 20.5 秒。该入口自行构建最终预置 TGZ，以全新 HOME/profile/空缓存离线安装，实际 DSH 为 0.2.2-rc.2。合成账号登录成功；错误环境凭据无效；启动前后 `--dump-config`、npm 输出、HTTP 成功/失败响应和 Host 日志无账号密码原值；文件删除后返回 503/config，本地状态仍可读，排障回执仅装载状态与错误分类 |
| 根目录：`node packages/forge-skills-manager/scripts/package.mjs --config <existing-private-nacos.env> --version 0.1.0-corp.20261126.3 --output <new-output-dir>`，先 `--dry-run` 后正式写出，再运行 `verify-enterprise-bundle.mjs` 独立核验；仓库外本机验证脚本对最终 TGZ 离线安装和启动真实 Host | 制包与独立核验通过，约 8.0 秒，34 文件；归档 SHA-256 为 `08fa01098a49a1306367d8c7d31918f4b71d2636265c471e5970d677074b99aa`。沿用已有本机私有配置且未打印凭据，凭据文件 0600、补丁仅引用；新 HOME/profile/空缓存，实际 DSH 0.2.2-rc.2，3 项通过，约 7.8 秒；本机 Nacos 登录及列表 HTTP 200，首屏 3 项，安装输出及启动前后配置诊断无凭据，profile 补丁无回写。测试 Host 已停止。构建来源为 `51fd504` 加本地未提交修改，制品目录保存源状态与回执；不是企业环境取证 |
| 根目录：`pnpm check` | 生成物、类型、文档、结构与技能检查通过；在既有 enterprise/IAM 的 bin 0644 归档审计失败，未进入全库单测，不记全库通过；未单独计时 |
| 根目录：`node scripts/check-docs.mjs`、`node scripts/check-repo.mjs`、`node scripts/dsh-version.mjs check`、`git diff --check` | 同步验证记录前通过，约 4.2 秒；最终文档补写后另行复核 |

配置诊断隔离仅适用于本轮独立预置包且 profile 无旧明文覆盖的场景；历史组合制品仍按旧契约。实际 Host 不是 `.dsh-version` 的精确基线，不能据此宣称严格兼容通过。归档 0600 不等于 npm 安装后的 POSIX 模式或 Windows ACL；目标安装权限收紧仍待验。未验证企业 Nacos 只读权限、真实 IAM 认证、完整桌面 GUI 或国产平台。持包人、同账户进程和同权插件仍可读取凭据，不提供加密隔离。

## 2026-11-26 PR 465 其余 P2 修复

本轮修复七项评审问题：内联第三方代码许可证交付、实际声明的补丁层预检与注入、响应体断流拒绝、未准入 UUID 拒绝、管理状态写入阶段判定、回收事务恢复及首次安装响应校验。状态存储只读核验不重复写入；移除来源和永久删除等已产生部分副作用的复合操作保持 pending。第三方声明随 `lib/` 进入独立中性及预置 TGZ；员工企业包不包含 Skill Manager 的代码和声明。设计、契约与包内制包说明同步，根 README 和项目级安装器、交付器未修改。

固定 Node 24.21.0 / pnpm 11.28.5，本机 Windows，全部新增验证使用合成配置和隔离目录：

| 命令与范围 | 结果与耗时 |
|---|---|
| 新增 P2 的 UI、HTTP、回执容量回归；再扩展回收恢复用例 | 修复前首组 7 项失败；暂存夹具修正为实际变更后仍因 ENOSPC 失败。回收组 4 项因原缺陷失败；修复后对应项通过。覆盖未写入、拒绝后重试、原 UUID、未知异常，以及目录和双形态、本地修改、来源替换、移动前中断与删除后的提交失败 |
| 包目录：`node --run verify` | 最终 171 项全部通过，无失败或跳过；26 个生成文件一致、类型检查通过；测试约 103.1 秒，整体约 110.7 秒。包含许可证及异地构建可复现性、管理/Nacos/UI、存储并发和结构变异 |
| 根目录：`node --test tests/skills-manager-package.test.mjs tests/skills-manager-iam.test.mjs tests/employee-skills-boundary.test.mjs packages/forge-enterprise/test/bundle-patch.test.mjs packages/forge-skills-manager/test/independent-package.test.mjs` | 16 项通过，约 15.8 秒；正式预置及声明文件、空缓存离线安装、同 Host IAM 动态注入与 enterprise 不挂载 manager 的既有行为保持 |
| 根目录：`node --test tests/private-bundle.test.mjs tests/build-employee-package.test.mjs tests/release-delivery.test.mjs tests/release-public.test.mjs`，与隔离 `90922cd` 源码对照 | 最终 112 项中 62 通过、47 失败、3 跳过，约 60.3 秒；基线 111 项中 61 通过、47 失败、3 跳过，约 46.4 秒。失败名称逐项一致，为 Windows 权限、链接夹具及缺少 `zip` 等既有环境限制；声明清单夹具同步后无新增失败。抽取发布工具的实际导入闭包验证通过 |
| 最终中性 TGZ 的 `verify-host.mjs`，仓库外仅适配为官方 Electron 执行 ASAR CLI | 11 项通过，约 25.2 秒；真实 DSH 0.2.2-rc.2、新 HOME/profile、空缓存、合成 Nacos。覆盖认证、准入拒绝、丢失响应核对、默认禁用、完整资源、并发写入、重启、热停启和卸载保留数据 |
| 预置 TGZ 的单层及声明双层隔离 Host 探针 | 各 4 项通过，约 8.1 / 9.1 秒；包内预置完成合成 Nacos 登录与列表，错误环境凭据未覆盖预置，无 profile Nacos 覆盖或启动回写，声明文件保留。双层为从预置 TGZ 重组的合成夹具；不是正式多层产品制包。探针后仅调整复合操作错误处理与演练断言，连接预置及声明逻辑不变 |
| 根目录：`pnpm check` | 约 39.9 秒后在既有 enterprise/IAM 的 bin 0644 归档审计失败；此前生成物、类型、文档、结构和技能检查通过。未进入全库单测，不记全库通过 |

正式包仍在制包时将 Nacos 地址、命名空间及专用只读账号密码写入有效 `cordis.patch.yml` 的 `config.nacos`；配置诊断可能携带密码的评审项按用户指示暂不修复。企业真实服务端权限、目标 DSH 0.2.1-rc.3 及其他操作系统未验；本机用户现用 DSH Web 与 Nacos 保持原样。最终文档、结构、版本、差异格式与提交签名检查随交付复核；此记录不代替远端 CI 或企业验收。

## 2026-11-26 精确版本准入与 ZIP 完整性

Nacos 目录仅展示已启用、latest 精确版本状态为 `online` 的条目；版本列表缺失时只补查当前页候选的元数据。详情及安装复核名称、命名空间、latest 与精确版本状态，通过 Client API 显式指定版本下载。上传及企业下载共用内联 yauzl 读取器，按流检查实际长度、CRC32、单项及累计输出预算，全部验证通过后才交给解析或写入；保留便携路径规则和既有错误码。读取器及传递依赖的许可证随生成模块保留。设计与 Nacos 契约同步，包内 README 保持功能和使用说明职责，根 README 未修改。

固定 Node 24.21.0 / npm 11.19.0 / pnpm 11.28.5，本机 Windows；下表为本地证据。

| 命令与范围 | 结果与耗时 |
|---|---|
| `node --test packages/forge-skills-manager/test/p1-resource-admission.test.mjs`；隔离副本替换为修复前 `3758dce` 的生成模块，运行同一组可比较用例 | 修复前 7 项中 5 因原缺陷失败，截断归档拒绝和正常资源 2 项通过，约 0.67 秒；修复后 8 项全部通过，约 0.78 秒。覆盖所选版本下线但技能启用、latest 不变且其他版本在线，下载前临时下线，缺失或未知版本状态，CRC、声明长度、结构及预算；拒绝路径核对既有技能、策略和安装记录不变 |
| 包目录：`node --run verify` | 最终 157 项通过，无失败或跳过，测试约 99.6 秒、整体约 105.5 秒；含 25 个生成文件一致性、类型、全部管理/Nacos/UI 回归、跨平台路径及结构变异 |
| 生成物检查及 `node --test test/build-output.test.mjs test/p1-resource-admission.test.mjs`（包目录） | 提交钩子将第三方 CP437 表的数字字母表误报为电话；生成器改用等价字符串连接，不修改扫描规则。10 项通过，测试约 2.1 秒、含生成物检查约 4.1 秒；逐字符比对原库编码表、核验两个依赖许可证，并复测两项 P1 |
| `node --test tests/skills-manager-package.test.mjs tests/skills-manager-iam.test.mjs` | 5 项通过，约 14.9 秒；含正式预置 TGZ、空缓存离线安装、运行入口导入及同 Host IAM 动态注入 |
| 同一上述根测试另加 `tests/private-bundle-boundary.test.mjs`，并用隔离 `3758dce` 源码对照该文件 | 合计 31 项中 23 通过、8 失败，约 15.5 秒；隔离基线约 0.99 秒，8 个失败名称逐项一致，均为 Windows 配置权限或链接夹具限制，未新增失败 |
| 中性独立 TGZ 构建及 `verify-host.mjs`，仓库外仅适配为官方 Electron 执行 ASAR CLI | 11 项通过，宿主演练约 21.9 秒；真实 DSH 0.2.2-rc.2、合成 Nacos、新 HOME/profile 和空 npm 缓存，覆盖已认证读取、Client 下载、完整资源、默认禁用、回执、重启、热停启及卸载保留数据 |
| 当前客户端连接本机真实 Nacos 3.2.3，使用既有专用只读账号 | 通过，约 1 秒；登录、列表及元数据读取返回 3 个在线技能，精确状态值为小写 `online`；Client API 读取 2 项资源并生成完整摘要，未调用 Admin 下载接口。未修改演示技能发布状态或本地安装数据 |
| 根目录：`pnpm check` | 约 43.9 秒后在 enterprise/IAM 的 bin 0644 归档执行位审计失败；此前生成物、类型、文档、结构和技能检查通过，未进入全库单测，不记全库通过 |
| `node scripts/check-docs.mjs`、`node scripts/check-repo.mjs`、`node scripts/dsh-version.mjs check`、`git diff --check` | 通过，约 4.6 秒；记录补写后的文档与最终差异另作复核 |

真实企业 Nacos 权限、企业 IAM、目标 DSH 0.2.1-rc.3 及其他操作系统未验。本机实际账号可使用新读取路径；单版本下线和下载竞争通过合成服务回归验证，未在用户正在使用的 Nacos 实例中修改版本状态。现有 DSH Web/profile 与演示技能保持原样。其余 P2 评审项不在本次修复范围；项目级安装器与交付器未修改。

## 2026-11-26 企业发布输入与安装说明复核

统一员工包的环境配置白名单与 `release-bundle` 工作流不映射 Nacos 字段；环境中遗留的 Nacos 值不进入企业私版配置、补丁或元数据。独立 Skill Manager 仍在自己的制包入口要求四项连接配置，历史组合制品保留既有必填、原值与凭据声明校验。企业安装器和交付器的实现未修改。README 人工调试步骤区分中性开发包与预配置交付包：交付包直接使用包内配置，旧 profile 覆盖项需先备份并移除；开发包按需配置，包内连接更新通过新版本重新制包。

固定 Node 24.21.0 / pnpm 11.28.5，本机 Windows；全部验证使用合成配置，不读取企业凭据：

| 命令与范围 | 结果与耗时 |
|---|---|
| 根目录：`node --test tests/employee-skills-boundary.test.mjs`，先运行新用例再修复 | 修复前 1 通过、3 因原缺陷失败，约 0.29 秒；当前 enterprise 补丁在保留 Nacos 环境值时触发 `PUBLIC_TARBALL_INVALID`。修复后 4 项通过，约 0.23 秒；覆盖实际企业补丁制作、遗留或非法环境值隔离、工作流/白名单边界和独立包四项必填 |
| 根目录：`node --test --test-name-pattern='configuration list\|every configuration\|historical\|release-bundle is admitted' tests/build-employee-package.test.mjs tests/check-repo.test.mjs` | 5 项通过，约 2.96 秒；检查器变异覆盖五项 Nacos Secret 映射均被拒绝，IAM 输入与历史组合包断言保留 |
| 根目录：`node --test --test-reporter=spec tests/employee-skills-boundary.test.mjs tests/build-employee-package.test.mjs tests/check-repo.test.mjs tests/desktop-shell-contract.test.mjs tests/skills-manager-package.test.mjs tests/skills-manager-iam.test.mjs packages/forge-enterprise/test/bundle-patch.test.mjs packages/forge-skills-manager/test/independent-package.test.mjs` | 55 项中 48 通过、7 失败，无跳过，约 18.25 秒；失败为员工包/桌面契约中缺少 `zip` 及 Windows POSIX 文件权限检查 |
| 隔离 `0a446a6` HEAD 源码：`node --test --test-reporter=tap tests/build-employee-package.test.mjs tests/desktop-shell-contract.test.mjs` | 约 3.88 秒；逐项核对失败名称与上述 7 项一致，未新增失败；仅补入当前未改动的 manager 生成文件用于加载测试，不修改基线源码 |
| 根目录：`pnpm check` | 生成物、类型、文档、结构和技能检查通过，仍在 enterprise/IAM 的 bin 0644 制品审计失败，未进入全库单测；未单独计时，不记全库通过 |

本轮未执行远端发布、完整员工 ZIP、企业服务或目标平台验收。最终文档、结构、版本与差异格式检查结果随交付报告记录。全部修改保留在工作区，未提交、未推送。

## 2026-11-26 独立交付包预置 Nacos

保留 2026-11-24 已确认的制包预置要求，独立制包入口为 `packages/forge-skills-manager/scripts/package.mjs`，包脚本为 `pack:private`。复用 Nacos 字段与运行文件校验、补丁注入、TGZ 编写及独立制品核验，不修改项目级安装器和交付器。设计、契约、包 README 与操作说明统一为正式包预置、profile 仅开发覆盖；根产品首页未加入开发操作。

固定 Node 24.21.0、pnpm 11.28.5、npm 11.19.0，本机 Windows 验证如下：

| 命令与范围 | 结果与耗时 |
|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | 通过，pnpm 报告约 0.8 秒；锁文件不需改动 |
| `node --test --test-reporter=spec tests/skills-manager-package.test.mjs` 联合 enterprise 补丁/形状、manager 独立包及同 Host IAM 用例 | 14 项通过，无失败或跳过，约 16.2 秒；覆盖四项必填、HTTP、未知/无关字段拒绝与脱敏、实际 Windows ACL、CLI 预检不写最终目录、版本区分、已有输出拒绝、独立闭包和空缓存离线安装 |
| 同一预置断言分别读取原中性构建与新私版 TGZ | 原构建缺少配置，断言按预期失败；新包通过。除 package.json、补丁及新增预置元数据外，原文件内容与模式保持一致；安装后使用实际 Nacos 客户端登录合成服务，无 enterprise/IAM 依赖及 profile 配置 |
| `node --test --test-reporter=spec --test-name-pattern='Nacos\|nacos\|standalone toolchain includes' tests/private-bundle.test.mjs tests/private-bundle-boundary.test.mjs tests/release-public.test.mjs` | 10 项通过，约 0.6 秒；保留既有企业私版字段、嵌套运行文件和元数据语义 |
| `node --test --test-reporter=spec packages/forge-skills-manager/test/nacos-credentials.test.mjs packages/forge-skills-manager/test/nacos-installation.test.mjs` | 13 项通过，约 0.8 秒；覆盖显式配置及环境兼容、配置撤销/轮换、缺项拒绝和下载资源保留 |
| `node packages/forge-skills-manager/scripts/package.mjs --config <private-nacos.env> --version <private-semver> --output <new-output-dir>`，分别预检与写出 | 通过，含配置准备约 8.7 秒；实际候选版本 `0.1.0-corp.20261126.1`，32 文件，附 manifest、摘要及脱敏回执。专用文件由原本机配置提取四项 Nacos 字段，限制 Windows ACL；原文件保留 |
| 仓库外 `verify-preset-host.mjs`：预置合成 Nacos 的实际 TGZ、全新 profile、空缓存离线安装及真实 DSH HTTP 访问 | 3 项通过，约 9.2 秒；实际 DSH 0.2.2-rc.2，无 profile Nacos 覆盖，故意提供错误环境凭据仍以包内值登录并列出技能；启动后未回写连接配置 |
| `pnpm check` | 约 40.9 秒后仍在 enterprise/IAM 的 bin 0644 制品审计失败；生成物、类型、文档、仓库结构及技能检查通过，未进入全库单测，不记全库通过 |
| `check-docs.mjs`、`check-repo.mjs`、`dsh-version.mjs check`、`git diff --check` | 通过，约 3.7 秒；实际预配置 TGZ 另经独立 manifest 校验通过 |

本轮没有修改运行时代码和 `lib/`。候选包携带原本机专用 Nacos 配置；真实服务端只读权限、该账号对新纯净 Nacos 的可用性、企业联调与其他平台未验。合成服务通过只证明包内预置可实际装载使用。原纯净 DSH Web 与 Nacos 未安装本包、未初始化账号或导入技能。工作区修改未提交、未推送；检查器及完整工程检查结果以本轮最终交付记录为准。

## 2026-11-26 本地完整制包演练

从当前未提交工作区制作候选产物，源提交、工作区状态、构建日志、制品清单及摘要均保存在仓库外。企业交付 ZIP 由现有交付器生成，只包含企业插件与安装器；研发包、Skill Manager 分别提供独立 TGZ。项目级交付器、安装器及官方 DSH 载荷未修改，用户现用 profile 未更新。

| 命令与范围 | 结果与耗时 |
|---|---|
| 固定 Node 24.21.0、npm 11.19.0、pnpm 11.28.5：`pnpm install --frozen-lockfile --ignore-scripts`，随后 manager `build` / `verify` | 安装和构建通过；verify 149 项全部通过、无跳过，测试约 123.0 秒 |
| `build-enterprise-bundle.mjs`：manager、engineering 两个独立入口；`verify-enterprise-bundle.mjs` 与摘要复核 | 均通过；manager 31 文件，无运行时依赖成员；engineering 制包约 4.9 秒，manager 制包及独立核验约 3.9 秒 |
| enterprise 默认构建 | 约 5.2 秒后因 Windows 下 IAM bin 归档模式 0644 失败；原始制包路径仍受此限制 |
| enterprise 本地 Windows 适配后构建、独立校验及 0644 反向控制 | 通过，约 3.9 秒；仅在仓库外构建进程中按 Git 的 100755 恢复 IAM bin 归档执行位，逐文件验证内容和其他模式不变。原有校验器仍拒绝 0644；132 文件，四个依赖成员，不包含 manager 文件或挂载 |
| 现有 `release-delivery.mjs` 的 `buildDelivery`：预览、生成私版、独立校验、ZIP 与逐文件摘要核验 | 通过，生成约 1.1 秒，ZIP 22 文件与输出目录逐字节一致。Windows 使用本地 .NET ZIP 适配，交付器源码未改 |
| manager `verify-host.mjs`，仅在仓库外适配为官方 Electron 执行 ASAR CLI | 11 项全部通过，约 25.3 秒；新 HOME/profile、空 npm 缓存离线安装，真实 DSH 0.2.2-rc.2 与合成 Nacos，覆盖 HTTP 准入、响应丢失回执、并发写入、重启、热禁用/启用及卸载保留数据 |
| 三个实际 TGZ 的全新 profile 离线安装、配置 dump 与真实 DSH HTTP 启动 | 通过，约 14.3 秒；enterprise 单独安装不安装或挂载 manager；三包共存时 manager、IAM、研发 UI 各一行，manager 已认证接口可用 |
| enterprise 补丁/包形状、manager 独立包、同 Host IAM 用例 | 10 项全部通过、无跳过，约 0.5 秒 |
| 根目录 `pnpm check` | 约 39.9 秒后在 enterprise/IAM 的 0644 bin 制品审计失败；之前的生成物、类型、文档、仓库结构及技能检查通过。未进入全库单测，不记全库通过 |
| `check-docs.mjs`、`check-repo.mjs`、`dsh-version.mjs check`、`git diff --check` | 通过，连同制品回执整理约 4.7 秒 |

私版沿用本机既有的环回模拟 IAM/网关配置，未内嵌客户端密钥。配置原文件及其受限 Windows ACL 保留；仅在内存选取企业配置，Discovery 模式省略显式 issuer，Nacos 配置不进入企业包。模拟 Discovery 服务当前不可达，预览和回执明确记录未执行在线验证；此制品为本地离线联调候选，不是企业正式发布。真实企业登录、Nacos 权限、浏览器 GUI、根文件指定的目标 DSH 0.2.1-rc.3 及其他平台未验。三包启动不等于产品已消费 IAM subject，也不等于完整三包装卸演练。完整校验、文档及差异检查以本次交付报告为准；未提交、未推送或发布。

## 2026-11-26 文档职责复核

项目级文档保留产品功能与范围、插件职责与导航、开发检查、跨插件技能命名约束；构建安装步骤集中于包内说明，IAM 服务边界留在模块设计。移除尚未入库的专项方案及公共导航，企业交付方案、enterprise 设计和设置菜单设计不再重复描述 Skill Manager；历史制品兼容规则与测试事实保留于契约和本记录。根 README 修正旧的组合交付表述，保持产品说明职责。

本轮只调整文档。固定 Node 24.21.0 / pnpm 11.28.5：`node scripts/check-docs.mjs`、`node scripts/check-repo.mjs` 与 `git diff --check` 通过，约 2.9 秒；`node --test --test-reporter=spec --test-name-pattern='standalone toolchain includes Nacos rules runtime and packaging instructions' tests/release-public.test.mjs` 及 enterprise 的 `bundle-patch`、`package-shape` 用例共 9 项通过，约 1.3 秒。`pnpm check` 约 37.1 秒后仍在 IAM/enterprise TGZ 的 bin 0644 审计处停止，之前的生成物、类型、文档、结构与技能检查通过；未进入全库单测，不记全库通过。补写记录后的文档及差异检查另作最终复核。

## 2026-11-26 独立打包安装与 IAM 共存

项目负责人确认安装与打包解耦：enterprise 的依赖、捆绑清单及补丁移除 Skill Manager，底座仅保留品牌、凭据、IAM、策略四个成员；Skill Manager 继续用自己的入口与补丁。项目级员工交付器和安装器未修改。操作见[独立制包安装说明](../../../packages/forge-skills-manager/docs/packaging.md)。根 README 的产品受众职责保持，设计、需求与 Nacos 当前安装路径同步。

环境为 Windows、固定 Node 24.21.0 / pnpm 11.28.5，子进程 PATH 使用同一 Node，构建器记录 npm 11.19.0。所有安装使用仓库外临时目录与合成数据，未修改用户现用 profile。下表为本地离线证据，不表示真实企业 IAM、Nacos 或生产发布验收。

| 命令与范围 | 结果与耗时 |
|---|---|
| 根目录：`pnpm install --frozen-lockfile --ignore-scripts` | 通过，约 14.2 秒；锁文件无需重新解析 |
| 根目录：`node packages/forge-skills-manager/scripts/build.mjs` | 通过，约 1.7 秒；生成物与既有内容一致 |
| 包目录：`node --run verify` | 最终 149 项通过，无失败或跳过，约 118.0 秒；含生成物一致性、类型、管理/Nacos/UI 回归与结构变异。跨包 IAM 用例单列于根测试 |
| 根目录：`node --test --test-reporter=spec packages/forge-enterprise/test/bundle-patch.test.mjs packages/forge-enterprise/test/package-shape.test.mjs packages/forge-enterprise/test/reflow.test.mjs packages/forge-skills-manager/test/independent-package.test.mjs tests/skills-manager-iam.test.mjs tests/bundle-install-rehearsal.test.mjs` | 22 项通过、2 项跳过，约 0.8 秒；缺少可被入口识别的 DSH 可执行文件，SDK/web 完整装卸演练未运行 |
| 上述文件另加 `tests/bundle-build.test.mjs tests/bundle-closure.test.mjs tests/bundle-verify.test.mjs` | 98 通过、4 失败、2 跳过，约 26.1 秒；四项失败为两处 Windows symlink EPERM、执行位夹具、POSIX npm 路径夹具，与此前主线对照记录一致 |
| 根目录：`node scripts/build-enterprise-bundle.mjs --entry @heluo/forge-skills-manager <new-output-dir>` | 通过，约 2.7 秒；31 个文件，无运行时依赖成员，附 manifest 与摘要 |
| 根目录：`node scripts/verify-enterprise-bundle.mjs <skills-manager.tgz> --manifest <output-dir>/bundle-manifest.json --json` | 通过，约 0.3 秒；核验实际 TGZ、入口、包体闭包与 SHA-256 |
| 空项目：`npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false <skills-manager.tgz>`，使用空缓存与空 npmrc，再导入包入口并检查清单及安装目录 | 通过，约 1.9 秒；入口可导入、自有补丁存在，未安装 enterprise 或 IAM |
| 根目录：`pnpm check` | 约 40.6 秒后在制品审计失败；生成物、类型、文档、结构和技能检查通过，enterprise/IAM 的 IAM bin 在 TGZ 内为 0644。未进入全库单测，不记全库通过；主线同平台限制见 2026-11-25 记录 |
| 根目录：`node scripts/check-docs.mjs`、`node scripts/check-repo.mjs`、`node scripts/dsh-version.mjs check` | 通过，合计约 3.9 秒；文档证据补写后的最终复核另随交付报告记录 |

`tests/skills-manager-iam.test.mjs` 使用真实 Cordis、实际 manager 与 IAM 插件，并在 manager 作用域添加仅用于测试的动态注入回调；connection、skills、sessions 为合成 Host 服务。覆盖 IAM 缺失时 manager 启动、服务装载后取得同一实例、卸载后引用清除、替换后绑定新实例，以及卸载 manager 后 IAM 保留。未在产品代码添加空壳身份消费者，也未调用企业端点。IAM 诊断日志异步写入在 Windows 清理临时目录时可能短暂持锁，测试仅对临时目录删除使用有限重试。

三包安装演练已更新为 enterprise、engineering、manager 分别构建安装，合并九行、只有策略共享；变异用例证明缺少 manager 或将其重新混入 enterprise 均会失败。完整真实 DSH 三包装卸、旧组合包迁移、浏览器界面、严格 SDK 兼容、真实企业权限与目标平台本轮未验；不将普通 npm 离线安装或 Cordis 服务绑定当作这些验收。

## 2026-11-25 PR 465 主线同步与 P2 修复

PR 分支保留协作者的锁文件与版本检查收口，19 个功能提交通过 `git rebase --force-rebase origin/main` 重放到 `1ebfc5e`，并由 `post-rewrite` 重新扫描、签名。保留主线 Windows bin 执行位判据及其测试，以及研发技能装配前的名称冲突检查；不产生 merge commit。

普通变更回执增加只读核验入口，接入带目录来源或历史仓库来源的回收恢复。恢复前保留原身份、位置与完整资源摘要，包含用户本地修改；管理视图正常读取完成本地恢复后，只有原来源已确认、回收目录消失且完整资源一致才确认成功、解除客户端锁。状态查询不恢复、不移动资源；来源被替换、文件变化、读取失败及未知异常不被误报为成功。首次安装意图写失败后重新只读核验持久记录，确定未落盘且未复制资源时明确拒绝并允许新请求；记录无法读取或意图已提交时继续待确认，保留恢复证据。

环境为 Windows、固定 Node 24.21.0 / pnpm 11.28.5，子进程 PATH 使用同一 Node。下列证据仅覆盖本地实现、合成数据与离线检查。

| 命令与执行位置 | 结果与耗时 |
|---|---|
| 包目录：`node scripts/build.mjs`、`node node_modules/typescript/bin/tsc --noEmit` | 构建与类型检查通过，未单独计时；最终生成物一致性及类型结果另由完整 verify 核验 |
| 隔离未修代码副本，包目录：`node --test --test-name-pattern="partially committed\|confirmed failure to persist" test/host-mutations.test.mjs` | 同一最终回归用例 3 项均因原缺陷失败，约 1.9 秒：两类恢复始终 pending，首次意图写失败返回 pending 而非 rejected |
| 修复后包目录：`node --test test/host-mutations.test.mjs test/install-operations.test.mjs test/nacos-installation.test.mjs` | 20 项通过，约 3.3 秒；覆盖正常 HTTP 入口、管理视图恢复、只读核对、客户端后续写入、来源替换与文件变更拒绝、意图持续写失败及新 UUID 重试、读取失败与已提交意图的保守判定、卸载及热重载 |
| 包目录：`node --run verify` | 148 项全部通过，无失败或跳过；含 25 个生成文件一致性、类型检查及结构变异验证，测试约 94.3 秒、整体约 102.4 秒 |
| 根目录：`node --test packages/forge-enterprise/test/bundle-patch.test.mjs packages/forge-enterprise/test/package-shape.test.mjs packages/forge-enterprise/test/reflow.test.mjs packages/forge-engineering/test/skills.test.mjs tests/bundle-install-rehearsal.test.mjs` | 35 项通过、2 项跳过，约 0.7 秒；跳过 SDK/web 完整装卸演练，本机入口未识别可执行 DSH |
| 根目录：`pnpm check` | 约 75.6 秒后在工作区链接步骤因 Windows symlink `EPERM` 停止；随后仅在忽略的 `node_modules` 内补齐缺失目录 junction，未修改全局权限或检查器 |
| 根目录：`node --run check` | 生成物、类型、文档、仓库结构及技能检查通过；约 34.3 秒后在制品审计停止：IAM 与企业组合的 IAM bin 在 tarball 内为 0644。未进入全库单测阶段，不记全库通过 |
| 主线 `1ebfc5e` 隔离归档：`node scripts/check-bundle-tarballs.mjs` | 约 17.9 秒，同样仅上述两个 bin 执行位审计失败；确认该失败在相同主线基线存在，不放宽归档判据 |
| 根目录：`node scripts/dsh-version.mjs check` | 通过，约 1.8 秒 |
| 根目录：`node scripts/check-docs.mjs`、`node scripts/check-repo.mjs`、`git diff --check` | 文档同步后复核通过，合计约 2.8 秒 |

设计和 Nacos 契约同步回执与意图失败语义，根 README 的产品受众职责保持。整体制品验收保持待定；本轮未重新运行真实 CLI/SDK 兼容、完整桌面 GUI、企业 Nacos/IAM 或国产目标平台验收，不将本地 HTTP 与客户端控制器回归当作实机证据。

## 2026-11-25 主线集成复核

集成基线为 `aac6077`，18 个分支提交通过 `git rebase --force-rebase origin/main` 回放并由 `post-rewrite` 重新扫描、签名。保留主线品牌插件、图标资产、员工包品牌材料与发布上传修复；企业底座同时装配凭据、策略、IAM、品牌与技能管理五项成员，与研发套件按 id 合并为九行。Nacos 密码声明与 IAM client secret 声明保持独立，主线品牌回执未丢失。

修正冲突处理中测试期望的包名；安装演练的八行旧判据同步为九行，检查品牌与技能管理都属于底座且不串入研发层。用实际两层补丁执行原判据，两条检查均失败；修正后均通过。新增回归直接执行演练中的检查，缺少品牌、缺少技能管理、重复行、缺失研发行及两层串包均拒绝。独立工具链的既有闭包用例另发现制包说明链接到未随包交付的开发文档，改为标明源码位置；该用例修复前失败、修复后通过，未放宽断言或扩大归档内容。

本轮环境为 Windows，固定 Node 24.21.0 / pnpm 11.28.5，子进程 PATH 同步使用固定 Node。证据均为本地实现、合成配置及离线测试，不作为真实企业联调结论。

| 命令或范围 | 结果与耗时 |
|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | 通过，约 4.5 秒 |
| `pnpm --filter @heluo/forge-skills-manager verify` | 142 项通过，无失败或跳过；测试约 97.1 秒、整体约 105.7 秒 |
| `node --run check:skills-manager` | 25 个生成文件与源码一致、类型检查通过，约 8.9 秒 |
| `node --test --test-reporter=spec packages/forge-enterprise/test/bundle-patch.test.mjs packages/forge-enterprise/test/package-shape.test.mjs packages/forge-enterprise/test/reflow.test.mjs tests/bundle-install-rehearsal.test.mjs` | 20 通过、2 跳过，约 1.0 秒；跳过 sdk/web 完整安装演练，本机测试入口未识别可执行 DSH |
| `node --test --test-reporter=spec --test-name-pattern='standalone toolchain includes Nacos rules runtime and packaging instructions' tests/release-public.test.mjs` | 原失败用例修复后通过，约 0.8 秒 |
| `node scripts/check-docs.mjs` / `node scripts/dsh-version.mjs check` | 通过；221 文件、94 份受控文档，约 1.7 / 1.3 秒 |
| `node scripts/check-repo.mjs` | 失败，仅 IAM bin 执行位检查报错，约 2.8 秒 |
| `node --run check` | 首步创建工作区符号链接因 Windows `EPERM` 停止，约 0.3 秒；不记全库通过 |

以下范围在 `aac6077` 的隔离源码归档中以相同工具链对照，逐项比较失败用例名称：

| `node --test --test-reporter=spec` 后的文件列表 | 本分支 | 主线基线 |
|---|---|---|
| `tests/build-employee-package.test.mjs tests/release-delivery.test.mjs tests/derive-brand-icons.test.mjs tests/upload-draft-release.test.mjs tests/desktop-shell-contract.test.mjs` | 73 项：43 通过、27 失败、3 跳过，约 5.5 秒 | 69 项：39 通过、相同 27 失败、3 跳过，约 4.3 秒 |
| `packages/forge-enterprise/test/bundle-patch.test.mjs packages/forge-enterprise/test/package-shape.test.mjs packages/forge-enterprise/test/reflow.test.mjs packages/forge-brand/test/config.test.mjs packages/forge-brand/test/package-shape.test.mjs tests/dsh-version.test.mjs` | 56 项：55 通过、1 失败，约 6.0 秒 | 55 项：54 通过、相同 1 失败，约 6.0 秒 |
| `tests/bundle-build.test.mjs tests/bundle-closure.test.mjs tests/bundle-verify.test.mjs tests/bundle-install-rehearsal.test.mjs`（增加演练判据回归前） | 81 项：75 通过、4 失败、2 跳过，约 26.8 秒 | 81 项：75 通过、相同 4 失败、2 跳过，约 25.3 秒 |
| `tests/private-bundle.test.mjs tests/private-bundle-boundary.test.mjs tests/init-enterprise-plugin.test.mjs tests/release-public.test.mjs`（说明链接修复后） | 141 项：104 通过、36 失败、1 跳过，约 45.0 秒 | 130 项：93 通过、相同 36 失败、1 跳过，约 61.3 秒 |

上述失败涉及 Windows 模式位、符号链接权限、缺少 `zip`、POSIX 路径夹具及品牌测试动态导入绝对路径的 ESM URL 格式；只确认所列范围未新增失败，不推断全库或其他平台通过。未重验真实 IAM/Nacos、宿主 SDK 兼容、完整桌面 GUI、员工 zip 及国产目标平台；main 的历史发布记录不作为本分支交付验收。设计与制包说明同步当前组合及归档边界，根 README 的产品受众职责不变。

## 2026-11-24 主线集成复核

最终集成基线为 `d96ab50`，在本地 rebase 保留新增桌面壳与统一员工包构建。统一构建的配置清单与发布 Environment 映射接入 Nacos 四项必填及可选超时，凭据首尾空格与字面引号保留；缺项及非法值拒绝，预览与元数据不含凭据值。`node --test --test-reporter=spec tests/build-employee-package.test.mjs tests/desktop-shell-contract.test.mjs tests/check-repo.test.mjs` 共 39 项，32 通过、7 失败（约 10.8 秒）；同基线隔离检出 37 项，30 通过、相同 7 失败（约 10.6 秒），逐项比对失败名称一致。失败为缺少 `zip` 及 Windows 配置文件模式位，不记员工 zip/桌面端验收通过。检查器单独回归 23 项通过（约 11.6 秒）。下列 `96fe261` 阶段所验插件及制包/安装实现、用例在第二次 rebase 后逐文件比对无变化，不重复计算其验证次数。

最终固定工具链 `pnpm install --frozen-lockfile --ignore-scripts` 通过（约 3.1 秒）；`node scripts/check-docs.mjs` 通过（221 文件、94 份受控文档，约 1.3 秒）；`node scripts/dsh-version.mjs check` 通过。`node scripts/check-repo.mjs` 仍仅报 IAM bin 执行位错误；固定 Node 且 PATH 同步后 `node --run check` 在首步工作区符号链接创建因 Windows `EPERM` 停止（约 0.5 秒）。企业服务、原生宿主 SDK 兼容、完整 GUI 和目标平台交付均未在本轮补验。

本轮以主线 `96fe261` 为对照，Windows、固定 Node 24.21.0 / pnpm 11.28.5。冻结锁文件安装（禁用安装脚本）通过，约 5.7 秒；插件 `verify` 142 项全部通过，测试约 94.9 秒。五文件制包/安装回归 169 项中 109 通过、56 失败、4 跳过，约 51.0 秒；主线隔离检出同范围 156 项中 96 通过、56 失败、4 跳过，约 47.7 秒。逐项比较失败名称完全一致，无新增失败；失败涉及 Windows 权限、符号链接与路径夹具，不能据此记为完整交付通过。新增凭据组合验证覆盖实际 tarball、制作器回执、安装器与旧 IAM 绑定兼容；补充三项定向验证通过，约 0.5 秒。企业补丁及版本集成 35 项通过，约 4.1 秒。构建/闭包/校验/装卸演练 79 项中 73 通过、4 失败、2 跳过，约 28.1 秒；失败涉及符号链接、执行位及 npm 路径，未另行逐项运行主线对照；跳过为未提供 DSH SDK/CLI。

文档检查、版本检查通过（约 1.2 / 1.1 秒）；仓库检查因 IAM bin 执行位失败（约 1.7 秒）。全量 `node --run check` 在首步工作区链接因 Windows `EPERM` 停止，后续阶段未运行。本轮不记全库通过，不代表真实企业 IAM/Nacos、桌面 GUI、目标平台交付或原生 SDK 兼容验收。

## 历史验证记录

2026-11-24 插件验证：Windows、固定 Node 24.21.0 / pnpm 11.28.5；写请求仅接受 `x-dsh-skills-manager: 1` 客户端标记。`pnpm --filter @heluo/forge-skills-manager verify` 142 项通过、零失败/跳过（测试约 98.9 秒，包含 25 个生成物一致性、类型检查与标记准入回归）；单插件实际 tarball 构建通过（31 文件，约 2.8 秒）。文档、版本检查通过；`check:repo` 仍因既有 IAM bin 执行位失败，不记全库通过。本轮未更新已安装实例或发布交付物，企业环境及目标平台未重验。 2026-11-24 包内凭据与制包规则补验：Windows，实际 Node 24.13.1 / pnpm 11.25.0（与固定 24.21.0 / 11.28.5 不同）。`node packages/forge-skills-manager/scripts/build.mjs` 成功；插件 `verify` 142 项通过（测试约 99.9 秒，含生成物、类型与结构/变异验证）。最终五文件回归（`tests/private-bundle.test.mjs`、`tests/private-bundle-boundary.test.mjs`、`tests/release-delivery.test.mjs`、`tests/init-enterprise-plugin.test.mjs`、`tests/release-public.test.mjs`）136 项中 85 通过、47 失败、4 跳过（约 45.2 秒）；隔离 HEAD 源码对照 131 项中 80 通过、相同 47 项失败、4 跳过（约 45.7 秒），无新增失败。失败涉及 Windows POSIX 600 权限、符号链接、发布路径及安装夹具，跳过为 POSIX shell 相关场景；不记完整交付通过。Nacos 定向 10 项通过（测试约 2.0 秒），覆盖两个公共 CLI 确认前拒绝缺配置/缺运行文件/旧文件、无插件不要求 Nacos 及工具链归档解压后的独立导入；Windows CLI 该项仅对合成配置文件模拟 POSIX 模式位，不作为权限验证。README 与随包说明 17 个本地链接/锚点独立核验通过。本次合成验证覆盖正式制包四项必填、缺项拒绝、HTTP 无开关、包内标量实际登录、旧公版运行文件不匹配拒绝、账号密码原值、显式不完整配置禁止回退、轮换/撤销缓存与安装器限定例外及矛盾元数据声明拒绝；不代表真实企业 IAM/Nacos、完整员工 zip 或目标平台验收。`pnpm check` 在生成物/类型/文档通过后因 IAM bin 执行位失败停止（约 9.4 秒）；不记全库通过。单插件 tarball 构建及独立 manifest 核验通过（31 文件，约 13.3 秒）；发布源码/配套工具扫描 2 项通过（测试约 4.9 秒；源码归档读取 HEAD，配套工具读取工作区）；本次 24 个改动文件另行扫描通过。公共 Skill 与 SOP 相对 HEAD 无修改，文档/版本检查通过。本轮未读取真实企业凭据，未发布；提交状态以 Git 记录为准。下列历史实测不作为本版包内凭据方案的证据。 2026-11-18 main 集成补验：Windows、固定 Node 24.21.0 / pnpm 11.28.5；保留主线企业底座与研发套件独立分发，正式交付 Skill 归研发套件，双包共存按 id 合并为八行。`pnpm install --frozen-lockfile --ignore-scripts` 通过（约 5.8 秒）；八文件集成回归 96 通过、2 跳过（约 25.6 秒），跳过项为缺少 PATH 中 `dsh` 的 sdk/web Loader 演练；两包构建及独立制品校验通过（约 11.4 秒）。`verify-host.mjs` 使用真实本机 CLI、隔离 profile 与合成 Nacos，11 项 HTTP/重启/热禁用/卸载检查通过（约 124.3 秒），不代表双包完整装卸或企业环境联调。全库 `pnpm check` 静态阶段通过；4353 项测试中 4253 通过、68 失败、32 跳过（整体约 321.5 秒），其中 PATH 键名集成断言已修复并单独回归 20 项通过（约 0.9 秒）；其余失败涉及 Windows 路径、权限、符号链接与发布夹具，未逐项对照 main，不记全库通过。当前用户预览未更新。2026-11-18 市场下载状态补验：Windows、固定 Node 24.21.0 / pnpm 11.28.5；`node scripts/build.mjs` 通过，`node --test test/nacos-download-state.test.mjs test/nacos-installation.test.mjs spec/nacos-ui.case.mjs` 的 32 项定向测试通过（约 1.7 秒），覆盖重入/重挂载、同名来源隔离、版本变化、全局与项目、登记子目录与 Windows 路径大小写、本地修改、移除及回收恢复、待确认与不可核验、记录损坏及未知异常传播；列表投影不额外下载 ZIP。`pnpm --filter @heluo/forge-skills-manager verify` 的 123 项顶层测试通过（测试约 89.1 秒，包含生成物一致性、类型检查、保留回归及结构/变异检查）；登记子目录及 Windows 路径匹配另由上述定向用例覆盖。生成物已更新，未重新打包或更新当前用户预览；实际浏览器、企业 Nacos/IAM 与目标平台未补验。 2026-11-18 预览版环境变量接入补验：Windows、固定 Node 24.21.0 / pnpm 11.28.5；`node scripts/build.mjs` 生成 24 个运行文件（约 1.6 秒）；`node --test test/nacos-credentials.test.mjs test/nacos-installation.test.mjs spec/nacos.case.mjs` 的 26 项定向测试通过（约 1.5 秒），`pnpm --filter @heluo/forge-skills-manager typecheck` 通过（约 6.0 秒）；`pnpm --filter @heluo/forge-skills-manager verify` 的 120 项顶层测试通过（约 97.9 秒，含生成物一致性、类型检查、完整保留回归及 89 项结构/变异测试）。覆盖默认及自定义环境变量、缺失/空白值拒绝且零网络、原值保留、凭据移除阻止旧令牌复用、账号密码轮换重新登录、无 credentials 服务的实际 Cordis 装载及错误体脱敏。`buildBundle` 构建独立 30 文件及企业组合 173 文件制品（合计约 5.8 秒）；`node packages/forge-skills-manager/scripts/verify-host.mjs <installed-dsh-cli.js> <tarball>` 分别在真实 DSH CLI 0.2.2-rc.1 下完成 11 项 HTTP 验收（约 57.6 / 59.9 秒），合成账号仅经验收子进程环境注入，仿 Nacos 校验实际登录表单。`pnpm check:docs`、`pnpm check:repo`、`pnpm check:version` 通过（约 1.9 / 2.4 / 2.3 秒），`git diff --check` 通过。仅验证技能管理器及直接组合路径；当前用户预览未重新安装，企业 Nacos/IAM、国产平台及完整桌面 GUI 未验；P8 受信存储的环境变量临时例外仅适用预览版。 此前 Host 凭据版补验（2026-11-18，不能作为当前环境变量版验证结论）：固定 Node 24.21.0 / pnpm 11.28.5、Windows 下，`pnpm --filter @heluo/forge-skills-manager verify` 的 120 项顶层测试通过（约 95.2 秒，含生成物一致性、类型检查、完整保留回归与 89 项结构/变异测试）；覆盖普通写入响应丢失和只读核对、跨组件重挂载、刷新失败不展示旧成功、卸载与热重载交叠、未知异常注入、凭据撤销和轮换。使用 `buildBundle` 构建独立 30 文件及企业组合 173 文件制品，分别在真实 DSH CLI 0.2.2-rc.1 的新临时 HOME/profile 下完成 11 项 HTTP 验收（约 56.2 / 60.0 秒）；额外验证普通本地写入丢弃响应后回执成功及变更请求重放拒绝。合成账号经实际 Host credentials 写入和解析，未使用环境变量提供 Nacos 秘密；Nacos 服务为合成夹具。当前用户预览未重新安装；未验真实企业权限、国产平台与完整桌面 GUI，不承诺跨进程幂等。此前隔离验收：Windows、固定 Node 24.21.0 / pnpm 11.28.5 下插件 `verify` 的 36 项顶层测试通过（约 83.8 秒，含生成物一致性与类型检查）；真实本机 DSH CLI 0.2.2-rc.1 分别安装独立 30 文件制品与企业组合 173 文件制品，各 10 项 HTTP 验收通过（约 46.2 / 48.5 秒）。覆盖已认证路由及匿名拒绝、未登记和禁止目标拒绝、正式技能重名保护、完整资源与默认禁用、丢弃成功响应后的只读回执及零重复下载、pending 同目标拒绝、并发启停/备注/分类/入口写入、重启恢复和未知回执 pending、同一宿主进程内禁用清理与重新启用、离线卸载保留技能/策略/备注；本轮仅验收 skillmanager 及直接组合链路，不代表其他企业插件完整功能通过。验收脚本为 `packages/forge-skills-manager/scripts/verify-host.mjs`，每次使用新临时 HOME/profile 和合成 Nacos，不读取用户默认配置；未验真实企业 Nacos/IAM、国产平台及完整桌面 GUI，不承诺跨进程幂等。此前整改记录：2026-11-18 本机 Windows：插件 `verify` 的 36 项顶层测试通过（约 2 分钟，含生成物一致性与类型检查）；本轮界面定向 23 项通过（约 1.3 秒），企业补丁、组合包构建/闭包/校验及正式技能集成 74 项通过（约 22.3 秒）；30 文件独立 tarball 完成离线安装及 Host 入口导入（约 4 秒），不等于真实 DSH profile 安装。本轮全库 `pnpm check` 静态阶段通过，3827 项测试中 3710 通过、85 失败、32 跳过（测试约 206.6 秒）；失败位于未修改的 IAM、发布工具及 Windows 路径/权限等用例，未运行基线对照，不能据此认定全属既有失败。实际 Node 24.13.1 / pnpm 11.25.0 与仓库固定 24.21.0 / 11.28.5 不同。回执不保证跨进程幂等，该轮未重验企业环境、目标平台及真实宿主；真实 CLI 补验结果见前述记录。历史证据：2026-11-17 本机 Nacos 3.2.3 只读查询确认 namespaceId/downloadCount 字段；orderBy=download_count、pageSize=1 的三页查询返回次数 22、17、14，验证先排序后分页；Nacos/界面定向 33 项通过（约 1.2 秒），插件 verify 20 项顶层测试通过（约 115 秒，含生成物一致性及类型），组合构建/闭包/校验与正式技能集成 69 项通过（约 27 秒）。实际源码组件配合合成数据及原语替身，在本机 Chromium 的 564px/864px/300px 容器与深浅主题下无横向溢出、详情按钮均在卡片内，长命名空间省略；该布局矩阵使用合成页面。另在本机 DSH 0.2.2-rc.2 企业组合的隔离 web 预览中，通过开发覆盖加载本轮全部生成物，实测浏览器卡片显示 public 命名空间和 22、17、14 次下载，Host 列表与前端降序一致；未重新打包发行制品，不代表企业环境联调。2026-11-17 未使用代码清理后，固定 Node/pnpm 下插件 `verify` 的 20 项顶层测试通过（约 99 秒，含完整本地管理与 Nacos 回归），正式技能保护及组合包构建/闭包/校验 69 项通过（约 25 秒）；旧布尔入口配置读取及 HTTP 兼容回归通过。2026-11-17 本机 Windows、固定 Node/pnpm：插件 `verify` 的 19 项顶层测试通过（测试约 115 秒，含完整保留回归）；UI/结构定向 33 项通过（约 2.3 秒），正式技能保护、组合包闭包/构建/校验及企业包定向集成 118 项通过（约 27 秒）。全库 `pnpm check` 的生成物/类型/文档/仓库/版本/制品静态阶段通过；3811 项测试中 3713 通过、66 失败、32 跳过（整体约 361 秒），失败涉及 Windows 路径/权限/软链及发布夹具，不记全库通过。企业组合 web 调试环境采用客户端开发覆盖，默认 564px 面板完整显示三个本机 Nacos 3.2.3 演示技能、864px 容器双列、深浅主题、回车搜索/清空、Tab/Esc 通过；390px 窄窗口与合成长名称/长 Markdown 无横向溢出，标题/操作固定，原始 HTML 和图片不执行/加载。真实本机 Nacos 全局下载保持禁用、定位及重开折叠分组通过；项目下载定位与已完成下载后列表刷新失败提示使用浏览器临时响应夹具，未写入用户默认工作区。宽面板与长正文亦为浏览器夹具。独立/企业 tarball 离线安装、资源下载与显式启停/卸载保留文件通过；实际桌面 SDK `0.2.2-rc.2` 的 Cordis/SkillRegistry 装载与路由清理通过（连接/会话为合成夹具），目标 SDK 按根 `.dsh-version` 管理。未验企业 Nacos、个人权限、三目标实机、完整桌面 UI 与七行企业能力真实联调
