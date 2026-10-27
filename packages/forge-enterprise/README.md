# @heluo/forge-enterprise

状态：可用（组合骨架：按需企业 Skill 与规范条款装配、五类开关声明与判定、官方行回灌检测已实现；官方行默认禁用、三个 Host 插件最小挂载；SDD 保留库/CLI，不作为插件挂载；最终制品验收见下文；企业环境接入、运行时模型面与业务行待实施）

| 项 | 内容 |
|---|---|
| 形态 | umbrella bundle（`cordis.patch.yml`）＋装配源码 |
| 职责 | 按行组装企业能力、角色 preset 与默认依赖检查；按需挑选并注册企业 Skill 与规范条款；声明五类开关（只读/普通研发写/AI 发布/人工 review/观察）并做 fail-closed 判定 |
| 不负责 | 不重复实现成员包逻辑，不承载业务接口，不做路径门禁（由 [@heluo/forge-policy](../forge-policy/README.md) 执行） |
| 详细设计 | [详细设计](../../docs/design/plugins/forge-enterprise.md)（草案；§5.2 按需企业 Skill 与规范条款加载） |
| 实现状态 | 条款包加载、适用性选择、预算与加载记录、按需注册已实现并有离线用例；[cordis.patch.yml](cordis.patch.yml) 的官方行禁用层已实现并在本机核验（组合层对照见[详细设计 §5.1.1](../../docs/design/plugins/forge-enterprise.md)）；`insert:` 段挂三个 Host 插件（凭据/策略/IAM）；SDD 通过发行依赖提供 CLI，历史市场包按设计不挂，运行时模型面与企业环境接入未实现 |

## 当前实现

| 项 | 状态 |
|---|---|
| 适用性 | 只加载适用系统与版本的条款；版本不符、系统不符、已过期分别按原因归档，不静默丢弃 |
| 分级 | `hard` / `advice` 分开返回；硬要求可用 `preActionConstraints` 在动作前取出 |
| 冲突与过期 | 同一主题的活跃硬条款冲突时**同时呈现双方与各自责任人**；过期条款移出并指向责任人，不允许调用方自行废止 |
| 上下文预算 | 每次选择给出条款数、字节数与估算 token；超预算直接拒绝整体注入，不静默截断 |
| 加载记录 | `loadRecord` 记录本次加载了什么（含引用）与跳过了什么及原因 |
| 按需加载 | 有 provider 入口时经 `registerEnterpriseSkillsViaProvider` 走宿主懒加载（探针已验证 list 无正文/get 按需取正文，rc.2）；无 provider 入口时回落直接注册并如实嵌入正文；装配入口的发现面只暴露摘要，正文经 `bodyFor(id)` 按需取用；加载、选择与注册都不写文件 |
| 用户入口 | 默认 `modelInvocable: false`、`userInvocable: true`：只有用户显式触发才承接，模型不能自动冒用企业入口 |
| 受管装配 | `assembleEnterpriseSkills(ctx, …)` 是交付 Skill 的单一入口：加载→选择→注册一次完成，一次 `dispose()` 注销全部；无宿主 skills 服务即拒绝，不授予权限、不固定流程、不产出合规结论；真实企业条款来源与安装路径实际调用待企业提供/宿主装配完成后记账 |
| 五类开关 | `resolveSwitches()` 只做声明与判定：依赖未就绪/能力缺失/未批准一律关闭，审计缺失不降级为无审计只读，C3 未批准时人工 review 关闭，角色 preset 只收窄 |
| 回灌检测 | `detectOfficialRowReflow()` 只看实际生效配置：仍启用的官方行报回灌（状态未知也按启用），缺席行单列（跳过 ≠ 已禁用）；`rowsFromDump()` 解析 `--dump-config` |
| 自证边界 | 只报告条款与引用，不产出"合规通过"结论；确定性要求引用 [S01 (#27)](https://github.com/hrygo/heluo-forge/issues/27) 的交付清单与 CI 校验 |

## 自包含制品与本地验收

- 构建入口：从仓库根执行 `node scripts/build-enterprise-bundle.mjs [输出目录]`；省略输出目录时使用独立 OS 临时目录，返回最终 `.tgz` 路径。裸源码目录的 `npm pack` 不是本包的发行入口。
- 源码成员关系使用 `workspace:*`；构建期只复制各成员 `files` 中声明的实体资源，生成精确版本的 `dependencies` 与标准 `bundledDependencies`，再由 npm 打出最终 tarball。安装端无需另取成员、补 peer、编译或连接源码仓库；不打入 DSH 内核、测试或缓存。构建拒绝软链、未闭合运行时依赖及安装钩子，失败不发布半成品、不改源目录；相同输入的 tarball 摘要可重复。
- `forge-sdd` bin 转发成员公开的 `@heluo/forge-sdd/cli`，执行真正的本地/CI 冻结与验证；不向 Cordis 插入 SDD 行，也不增加空 `apply`。
- `heluo-change` bin 转发 `@heluo/forge-devops/change-cli`，提供本地仿 CLI 演示/显式本机诊断与离线 HTML 简报；不新增 Cordis 挂载行，不冒充 profile IAM/组织开关已接入。见[试用手册](../../docs/operations/change-briefing.md)。
- 定向验收：`node --test tests/bundle-build.test.mjs tests/bundle-closure.test.mjs tests/bundle-install-rehearsal.test.mjs packages/forge-enterprise/test/bundle-patch.test.mjs`。闭包失败/成功回归与真实最终制品演练分开记账。
- `node scripts/probe/run-bundle-install-rehearsal.mjs` 使用空 npm cache、`--offline` 和不可达 registry，在干净 scratch 项目安装最终 tarball；分别证明 dump 组合、真实 Cordis/Loader 插件实例化与服务查询、SDD CLI 冻结/验证/篡改拒绝、升级/回退、卸载注册清理及用户标记保留。`DSH_BIN` 选择已有 CLI，`DSH_NODE_MODULES` 可显式选择已有 SDK 的 node_modules 目录；不下载或升级宿主。
- **2026-10-26 本地证据边界**：已安装宿主只覆盖清单声明的兼容下限；仓库 `.dsh-version` 目标尚未运行，证据 JSON 明确记录实际/目标版本与 `NOT RUN`，不能宣称目标基线通过。凭据使用显式内存夹具，IAM 未配置企业端点；这只验证本地方向的制品/组合生命周期，不代表真实 IAM、OS keychain、企业 registry/官方 manager、Windows 或麒麟业务准入。

## 边界

- 每个能力一行 `insert`，可单独 `disabled` 或覆盖配置。
- 组合顺序遵循[设计顺序](../../docs/design/README.md)：身份与策略先定，组合包最后收敛。
- IAM、policy 与必要审计缺失时，拒绝相应企业调用；可关闭不等于关闭后仍保留权限。
- 角色 preset 只调整工具可见性与提示，不替代服务端授权。
- 条款责任人与维护者由企业侧指定；本包只按索引标注呈现，不代替责任人裁定。
- `cordis.patch.yml` 的 `insert:` 段只挂三个有真实 Host 职责的插件（凭据/策略/IAM）；SDD 是库/CLI，不补空 `apply` 伪装成插件；网关、Gitee、品牌仍只有 README，不预建指向未实现包的入口。
- 禁用实验失败即暂停 O3，不 patch 内核；`desktop` profile 行 id 与运行时模型面待核验。
