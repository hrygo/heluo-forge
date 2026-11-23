# IAM 接入设计外部评审的核查记录（脱敏）

> 记录日期 2026-11-23。来源为外部厂商售前团队 2026-11-21 出具的 IAM 接入设计评审（V0.3，HTML，基线 IAM 6.0.3）。原件含目标企业名称、内网主机名与厂商标识，按[仓库脱敏规则](../../README.md#6-编写约定)不入库；本文为重述要点与本侧核查结论，不是原件副本。
>
> 本记录只作证据与处置索引，不构成认证实现或生产准入结论。必改项与批次见 [IAM 快速上线必改清单与迭代路线](../../plans/2026-11-23-iam-fast-launch-and-iteration.md)（PLAN-025），需 IAM 团队书面答复的部分见 [IAM 接入评审反馈函](../../collaboration/iam-review-feedback.md)（CONF-007）。

## 1. 核查方式与基线

| 项 | 值 |
|---|---|
| 原件主张的代码基线 | `heluo-forge` 的旧快照，引用 `src/index.mjs:114-141`、`src/config.mjs:67`、`src/oidc.mjs:330` 等位置 |
| 原件引用的设计文档 | IAM 接入详细设计 V3.3.2 |
| 本次核查的代码基线 | IAM 刷新线 `codex/issue-408-iam-refresh`，提交 `a5848fa9`（2026-11-21）；该线尚未合入 `main`，哈希仅作核查时点标识 |
| 本次核查的设计文档 | [IAM 接入详细设计](../../design/plugins/forge-iam.md) V3.6.1（核查时版本；按本记录修订后为 V3.8.0） |
| 核查方式 | 静态代码与文档比对；逐条复算原件给出的文件、符号与默认值 |
| 未验项 | 未连接目标 IAM 与企业网关；原件所依据的产品能力结论（NotebookLM 检索结果）与目标环境实际行为均未实测 |
| 结论口径 | “成立”指与本侧当前代码或文档事实一致；“不成立”指与当前基线冲突；“部分成立”指事实成立但结论或范围需修正 |
| 能力基线 | 按 ADR-32 固定为 IAM 6.0.3 版本反馈（厂商 21 项回函、内部校验回函(3)、C1—C11、D1—D3、最终确认函 13 题），6.3.0 与 AIGS 只作演进观察 |

原件所依据的产品能力证据是文档检索所得，不是目标环境实测。原件中以“6.0.3 不支持 / 必须”开头的判定，按 ADR-32 的规则重新定性：与企业团队较新日期的书面答复一致则采纳，不一致则以企业答复为准，无先后可取时按不假设能力存在处理。

## 2. 结论

- 原件“上线前必改 #1”（`client_secret` 来源缺失、机密模式跑不通）在核查时点（`a5848fa9`）上**不成立**：机密客户端的受信来源、凭据隔离、换票刷新与撤销链路已实现并有隔离用例，设计见 [IAM 机密客户端认证设计](../../design/iam-confidential-isolated.md)（DESIGN-016）与[客户端认证契约](../../contracts/iam-client-auth-isolated.md)（IAM-002）。
- 原件“patch 补全所有官方 row id”与“CI 防升级覆盖”**基本已具备**：补丁层已停用 7 行，且组合包在装配时按 `OFFICIAL_ROWS` 断言缺席行。
- 原件把 PKCE 只当作“public 客户端默认值”的证据，未识别到它**不可配置关闭**，也未把它列为阻塞。核查后它是唯一需要提高优先级的协议项：6.0.3 反馈只确认 PKCE 能力存在、允许 `plain`、未强制 S256，若目标部署不接受 S256，登录即失败。
- 能力判定统一以 IAM 6.0.3 版本反馈为准（ADR-32）：原件据厂商 6.0.3 回函得出的“不支持 public/PKCE”“回调须精确匹配”等结论，与企业团队较新日期的书面答复不一致时，以企业答复为准；无先后可取时按不假设能力存在处理。
- 按该基线，登录路径不变（机密客户端），但回调形态、撤销模式、UserInfo 字段与网关判权方式都从“待确认”转为“有书面基线、只差证据”。

| 原件项 | 定性 | 处置去向 |
|---|---|---|
| 2.1 机密客户端 | 部分成立：默认值属实，“无法跑通”不成立 | 部署侧显式设置 `confidential` 并完成登记预置（MC-07/08），不改码 |
| 2.2 回调形态 | 不成立：与 6.0.3 前缀登记答复冲突 | 保持前缀登记，固定端口为可选形态（MC-09） |
| 2.3 显式端点 | 成立，配置能力已具备 | 私版显式配置端点（MC-08） |
| 2.4 撤销模式 | 部分成立：路径已定，缺实测 | 固定 `access_token_query`（MC-10） |
| 2.5 身份字段 | 成立，需改码 | UserInfo 映射配置化（MC-05） |
| 2.6 官方禁用 | 部分成立：行已全，运行期检测缺失 | 断言扩展与环境旁路检测（MC-03/04） |
| 2.7 网关身份头 | 成立，需改码 | 头名与类型配置化（MC-02） |
| 2.8 推荐配置 | 采纳为模板 | 私版模板收敛（MC-06） |

结论：8 项中需改码 3 项（2.5、2.6、2.7），只需配置 3 项（2.1、2.3、2.8），不成立 1 项（2.2），部分成立且只差实测 1 项（2.4）。

## 3. 逐项核查

| 编号 | 原件主张 | 核查结论 | 证据与落点 |
|---|---|---|---|
| 2.1 | 默认 public client + PKCE，与 IAM 6.0.3 不兼容；须切 confidential；`src/index.mjs` 未提供 `getClientSecretSource`/`verifyClientSecretSource` | **部分成立**：默认值确为 `public`/`none`（通用插件兼容默认，也是私版打包在未设置 `HELUO_IAM_AUTH_MODE` 时的取值）；但机密来源已实现，设置 `confidential` 后可换票、刷新与撤销，故“无法跑通”不成立。注意：私版**不会**自动切机密，必须显式设置 | `packages/forge-iam/src/config.mjs:68-69`、`scripts/lib/private-bundle.mjs:383-391`；`packages/forge-iam/src/index.mjs:111-131`、`:386-400`；`packages/forge-credentials-keychain/src/index.mjs:337`；`tests/private-bundle.test.mjs:419` |
| 2.1b | 授权请求强制带 PKCE，`code_challenge` 不可省 | **成立，且比原件更严重**：`pkce`/`pkceMethod`/`disablePkce` 被列为禁止配置项，无法关闭 | `packages/forge-iam/src/oidc.mjs:409-410`；`packages/forge-iam/src/config.mjs:13` |
| 2.2 | 应去掉 `callbackPort: 0`，改用宿主 webServer 固定 Origin 或固定端口；IAM 要求 `redirect_uri` 全量精确匹配 | **不成立**：6.0.3 反馈（2026-11-06）明确管理台按前缀登记、端口可随机；固定端口精确匹配是可选形态。两种形态本侧都已支持，缺的只是登记口径确认，不是“必须去掉动态端口” | 前缀登记与固定端口校验：`packages/forge-iam/src/config.mjs:212-245`、`callback-listener.mjs`；宿主 Origin 形态：`packages/forge-iam/src/index.mjs:150-172` |
| 2.3 | 应显式配置 issuer / authorization / token / jwks（及 revocation、endSession），discovery 仅 fallback | **成立**，配置面已支持，无需改码 | `packages/forge-iam/src/config.mjs:22-36`；`packages/forge-iam/src/oidc.mjs:330-397`；私版映射 `scripts/lib/private-bundle.mjs:57-79` |
| 2.4 | 按目标实际端点选 `rfc7009` 或保留 `access_token_query`；退出失败不得报成功 | **部分成立**：6.0.3 反馈只有 `GET /idp/oauth2/revokeToken?access_token=` 一条路径且 RT 不可撤销，故基线固定为 `access_token_query`，`rfc7009` 不启用；不报成功的判据成立 | `packages/forge-iam/src/config.mjs:76`、`service-signout.mjs:145-190`；依据 D1 |
| 2.5 | 配置 `userInfoEndpoint`，工号/姓名取自 userinfo；属主绑定只用 `sub` | **部分成立**：端点与投影机制已实现，但字段名映射只在 Host 选项注入、私版 `.env` 无对应键；字段名 6.0.3 反馈给出两组不一致的候选（`work_no`/`pinyin` 与 `employeeNumber`/`name`），需二选一 | `packages/forge-iam/src/userinfo.mjs:1-45`、`service.mjs:56`、`service-grant.mjs:96-119`；依据最终确认函 3.2 |
| 2.6 | 补丁需补全所有官方 row id；启动检测 `DEEPSEEK_API_KEY`；CI 防升级覆盖 | **部分成立**：7 行已全量停用，装配期按 `OFFICIAL_ROWS` 断言缺席行；环境变量旁路无运行期检测，运行期独占断言只覆盖一个服务 | `packages/forge-enterprise/cordis.patch.yml`；`packages/forge-enterprise/src/reflow.mjs:10-19`、`:63-90`；`packages/forge-iam/src/exclusive.mjs:14-27` |
| 2.7 | 静态 Key 与 `X-IAM-Token` 头名应配置化，统一走 `resolveGatewayConnection()` | **成立**：头名与 `X-Consumer-Type` 硬编码 | `packages/forge-iam/src/model-transport.mjs:76-77`；`packages/forge-iam/src/service-gateway.mjs` 的连接解析 |
| 2.8 | 给出 IAM 6.0.3 快速上线推荐配置（不配 `callbackPort`、`gatewayResource` 留空、先去 `offline_access`） | **采纳为模板**：6.0.3 反馈的换票响应直接返回 `refresh_token`，未把 `offline_access` 列为必要条件；`resource` 不支持。注意私版未设置 `HELUO_IAM_SCOPES` 时不写 scopes，插件默认值含 `offline_access`，所以方针是**显式覆盖**而非删除 | `packages/forge-iam/src/config.mjs:80`、`scripts/lib/private-bundle.mjs:70`、`:323-329`；`gatewayResource` 默认空串、不外发 `resource` |
| 03 | 5 项“可容忍短期风险”（RT 轮换证据不足、RT 不可撤销、跨进程非即时、本地门禁无 PDP、审计未上送） | **采纳**，与本侧既有边界一致，不新增改动 | [IAM 实现与验证记录](../../design/verification/forge-iam.md)；[从 IAM 到 AIGS](../../plans/dsh-plugin-tools/iam-to-aigs-evolution.md) |
| 05 | 12 项遗漏点（M01—M12：secret 生命周期、`resource`、`offline_access`、旁路清单、多实例、RP 登出、弱网 UX、AIGS 降级、MCP 迁移、补丁覆盖、public 实测、回调前缀负面用例） | **逐项分流**：5 项转 IAM 问题（M01 密钥生命周期、M05 多实例档位、M06 会话失效推送、M11 PKCE 实测、M12 回调测试集），2 项由 6.0.3 反馈结案（M02 `resource`、M03 `offline_access`），3 项属我方（M04 旁路清单、M07 弱网文案、M10 补丁覆盖，其中 M10 已具备），2 项转 AIGS 演进（M08/M09） | [CONF-007 §5](../../collaboration/iam-review-feedback.md#5-最新评审-12-项遗漏点的归属)、PLAN-025 §3 |

## 4. 不成立的项与原因

### 4.1 机密客户端来源缺失

原件引用的 `src/index.mjs:114-141` 与“未提供 secret source”在当前基线上已不成立。当前实现以 `iam-client-secret-source` 私有端口注入来源，绑定的来源与凭据实例、issuer、clientId、认证方法和 revision 逐项核对，任一不符即拒绝机密请求；来源缺失时在产生授权 URL 前失败，不回退 public。私版打包在 `authMode=confidential` 且缺少 `HELUO_IAM_CLIENT_SECRET_REF` 时直接报错，不生成“看似已配置”的包。

因此该项的工作量不是“补代码”，而是**在目标终端预置 secret 记录并完成 IAM 侧客户端登记**，属 G1 联调前置，不是代码阻塞。

### 4.2 官方账号 row 未补全

原件称“补丁需补全所有官方 row id”。补丁层实际停用 7 行：`deepseek-account`、`ui-settings-account`、`llm-deepseek-account`、`llm-deepseek`、`llm-pi-ai`、`ui-settings-models`、`credentials`；组合包在装配时按 `OFFICIAL_ROWS` 复核，缺席行单独记入 `absent`，跳过不等于已禁用。原件未涵盖的后两行（模型自由配置与官方明文凭据）恰是更直接的旁路。

真正的剩余缺口是**运行期独占断言只检查 `deepseekAccount` 服务**，其他官方行残留不会被该断言发现，以及**环境变量旁路无运行期检测**。

### 4.3 回调默认动态端口

`callbackPort` 无默认值：不配置时回调走宿主 `webServer` 的实时 Origin，配置 `0` 时是系统分配的回环端口，配置固定值则绑定该端口。

原件把设计文档的方案枚举读成了“推荐生产使用 0”，并据此主张 IAM 要求逐字精确匹配、前缀登记不受理。按 ADR-32，该项应以 6.0.3 反馈为准：2026-11-06 的企业确认明确管理台按**前缀**登记（合法形态仅 `http://127.0.0.1:` 与 `http://127.0.0.1/`，`https` 可用），端口可以随机；同一版本的最终确认函 1.3 另答“支持固定端口预登记与精确匹配、支持多端口登记”。因此原件的前提不成立，动态端口并非必须去掉，设计 §4.5.1 保持前缀口径并把固定端口列为可选形态，不存在需要按原件修正的登记缺陷。

真正的剩余问题是边界证据：主机大写、尾斜杠、非数字端口与 `https` 登记写法没有负面用例（FB-IAM-02）。

## 5. 核查中补充识别、需提高优先级的五项

原件对下列五项或未提及、或提及但未识别其真正约束，核查后列入必改与待确认。

| 编号 | 发现 | 影响 | 处置 |
|---|---|---|---|
| N-01 | 授权请求恒定携带 `code_challenge`/`code_challenge_method=S256`，且 `pkce`/`disablePkce` 属禁止配置项，无法关闭（原件只据此论证 public 默认值，未列为阻塞） | 6.0.3 反馈只答“PKCE 能力具备、允许 `plain`、未强制 S256”，S256 是否被接受未知；若不被接受，登录会失败 | 列为 P0 实测项：用一次真实授权请求确认 S256 被接受并留证。不引入 `plain` 分支；若被拒则提交议题由用户裁决，不用弱化 PKCE 换可用性 |
| N-02 | `userInfo` 字段名映射（`workNo`/`name`）只能由 Host 选项注入，私版 `.env` 无对应键 | 即使配好 `userInfoEndpoint`，账户页仍可能不显示工号 | 列为 P1 必改：私版暴露字段映射键，默认不投影 |
| N-03 | 独占断言只覆盖 `deepseekAccount` 服务 | 其他官方行残留时本地不告警 | 列为 P1：断言扩展到装配可见的官方行或改用 reflow 结论 |
| N-04 | 无 `DEEPSEEK_API_KEY` 等环境旁路的运行期检测 | 环境变量配置的官方 Key 仍可能构成旁路 | 列为 P1：启动检测 + 告警/阻断，与 O3 一致性核验 |
| N-05 | 网关请求头与 consumer 类型硬编码 | AIGS 切换需改代码而非改配置 | 列为 P1：头名与类型配置化，统一出口 |

## 6. 能力基线与口径更正

能力判定按 ADR-32 固定为 IAM 6.0.3 版本反馈。同一版本内答复冲突时，取企业 IAM 团队较新日期的书面答复；仍无先后可取时按不假设能力存在处理。据此对原件涉及的四处口径做更正：

| 事项 | 原件口径 | 6.0.3 反馈结论 | 本记录处置 |
|---|---|---|---|
| public client / PKCE | 6.0.3 不支持 public client 与 PKCE | 企业答复称授权码 PKCE 能力具备、允许 `plain`、未强制 S256；刷新必须携带 `client_secret` | 登录基线维持机密客户端；PKCE 固定 S256，不启用 `plain`；S256 接受度列一项实测（FB-IAM-01） |
| 回调登记 | 必须逐字精确匹配，前缀不受理 | 管理台按前缀登记（`http://127.0.0.1:` 与 `http://127.0.0.1/`，`https` 可用），端口可随机；另有固定端口预登记与精确匹配的答复 | 前缀登记为基线，固定端口为可选形态；设计 §4.5.1 据此保持前缀口径并注明两种形态 |
| `offline_access` | 建议先去掉 | 换票响应直接返回 `refresh_token`，未把 `offline_access` 列为必要条件 | 企业模板去掉该项，兼容默认值不变 |
| 令牌实时作废 | 厂商把“已发 AT 实时阻断”列为不具备 | 企业答复称停用立即作废、无宽限期（C5），但网关端到端五分钟未给数值 | 能力按企业答复记录，网关判权仍按未证实处理，不据此开放路径 |

## 7. 未验证项

- PKCE S256 是否被目标部署接受（6.0.3 反馈只确认 PKCE 能力存在，未确认 S256）。
- 前缀登记的负面边界：主机大写、尾斜杠、非数字端口与 `https` 的登记写法。
- 令牌有效性回查接口的端点、鉴权、容量与故障语义；网关的在线判权只有这一条依赖。
- 五分钟撤权的端到端最坏时延与 t0 起点。
- UserInfo 字段名的二选一口径（`work_no`/`pinyin` 与 `employeeNumber`/`name`）。
- RT 轮换、重用检测与休眠恢复的真实端点表现（能力已书面确认）。
- `client_secret` 的生成方、分发方式与泄漏/轮换失败时的回滚能力。
- 同一账号多设备并发的实际档位（并存、后踢前或先占）。
- 是否存在向客户端推送会话失效的通道（back-channel logout 或会话管理端点）。
- 全部结论来自静态比对与书面答复，本记录不包含任何企业环境往返。

## 8. 处置去向

| 类别 | 内容 | 落点 |
|---|---|---|
| 必改（我方代码） | S256 接受度实测留证、网关头配置化、独占断言扩展、环境旁路检测、userinfo 字段映射、模板收敛 | [PLAN-025 §3](../../plans/2026-11-23-iam-fast-launch-and-iteration.md#3-必须改动清单) |
| 必改（部署配置） | confidential 认证、显式端点、回环回调与登记、网关 Key 属主绑定 | 同上 §3.2 |
| 待 IAM 答复 | S256 接受度、前缀登记边界、UserInfo 字段二选一、有效性回查接口、五分钟撤权时延 | [CONF-007 §3](../../collaboration/iam-review-feedback.md#3-需-iam-团队书面确认的事项) |
| 文档修正 | 独占断言覆盖面、PKCE 与 `scopes` 口径、回调两种形态并存、待决事项补充 | [forge-iam.md §4.3](../../design/plugins/forge-iam.md#43-官方账号禁用与独占断言)、[§5.1](../../design/plugins/forge-iam.md#51-配置项规范)、[§4.5.1](../../design/plugins/forge-iam.md#451-回调监听归属)、[§12.1](../../design/plugins/forge-iam.md#121-待决技术事项清单) |

## 9. 资源判断与处置

| 资源 | 判断 | 处置 |
|---|---|---|
| 外部评审原件（HTML，含企业可识别信息） | 代码基线为旧快照；8 项建议中 3 项与 6.0.3 反馈或本仓库实现不符 | 不入库，仅留本记录的重述与证据 |
| [IAM 接入详细设计](../../design/plugins/forge-iam.md) | 结论基本正确；回调登记口径原本就是前缀登记，无需按原件修改 | 升版至 V3.8.0，补独占断言、PKCE/`scopes` 说明、两种回调形态与 ADR-32 基线 |
| [IAM 实现与验证记录](../../design/verification/forge-iam.md) | 缺 PKCE 接受度、官方行断言、网关头、UserInfo 映射四类待闭合项 | 补四行并把实测与答复分层 |
| [问询函登记](../../collaboration/iam-confirmation-letter.md)（CONF-004） | 能力真源；同一版本内存在两处口径冲突（PKCE、UserInfo 字段） | 不改写原文，冲突按 ADR-32 规则裁决并在此登记 |
| [接入确认函](../../collaboration/iam-access-confirmation.md)（CONF-006） | C1—C11、D1—D3 已登记，与原件无冲突 | 引用，不重复登记 |
| 历史 ADR（ADR-26、ADR-31） | ADR-26 已被 ADR-31 取代；ADR-31 的机密客户端基线不受本次影响 | 新增 ADR-32 记录能力基线，不改写 ADR-26/31 |
