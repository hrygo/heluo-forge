# 企业研发总览返工交付说明（r16）

> 需求：`docs/teamflow/20261106-r16-r15-iam-readiness-rework/PRD.md`（12 条 AC）
> 设计：`docs/teamflow/20261106-r16-r15-iam-readiness-rework/TECHNICAL.md`
> 基线：`docs/teamflow/20261106-r15-enterprise-iam-ui/`（D-1～D-5 验收打回项）
> 交付日期：2026-11-06；工作树 `wt_622dc4710a35`，分支 `feat/plugin-workflow`（未提交、未推送、未切分支）。

## 1. 结论与范围

- 按 TECHNICAL §11 的 T1～T5 全部落地：新增服务端 `src/readiness.mjs` 与四层证据投影、客户端七行就绪面板（身份六态 / Key 五态 / 检查四项 + 四层证据 / 三层来源 / 导航探测与文字降级）、探针单次派发、15 条文档最小清理与 `.gitignore` 两条目。
- 本轮**未**做：真实企业 IAM 联调、生产 Key 验证、企业 `dop` 只读实跑、Windows/麒麟实机、真实浏览器 DOM/Network、tarball GUI 装载（见 §5 NOT RUN）。
- 无新增依赖、无新增路由、无新增身份/凭据存储；两包 `src` 仍零 `spawn(`、零 `shell: true`，子进程只有 `execFile` 一个出口（`packages/forge-devops/src/cli-runner.mjs:127`、`packages/forge-gitee/src/gitee-cli.mjs:425`）。

## 2. 变更文件

| 文件 | 变更 |
|---|---|
| `packages/forge-devops/src/readiness.mjs` | 新增：`buildReadiness` / `projectLayers` / `verdictOf` 与四层证据常量（纯函数，零 IO、零子进程） |
| `packages/forge-devops/src/cli-access.mjs` | 快照增 `layers`（只键名）与 `readAt`；新增只读访问器 `rowForReadiness()` |
| `packages/forge-devops/src/index.mjs` | `withReadiness()` 包住四个快照出口（GET / cliSnapshot / 保存成功回读 / 保存失败回读） |
| `packages/forge-devops/client.js` | 七行就绪面板、身份六态与导航探测、Key 五态、检查四项与四层证据、三层来源折叠、过期与迟到回包、zh/en 文案与样式 |
| `packages/forge-devops/test/readiness.test.mjs` | 新增：服务端四层证据三态、verdict 一致性、layers 只键名、降级、来源类型、零副作用 |
| `packages/forge-devops/test/support/readiness-harness.mjs` | 新增：客户端 hook 运行时 + 三源 fetch 夹具 |
| `packages/forge-devops/test/readiness-section.test.mjs` | 新增：19 条客户端行为用例（先红后绿，见 §3） |
| `packages/forge-devops/test/client-shape.test.mjs` | 只增：两分区 `inject` 带 `navigate`、七行含 `key`、导航能力探测；旧文案断言收窄理由见 §7 |
| `tests/ui-contract.test.mjs` | 只增 3 条：四层/来源类型/原因与 `readiness.mjs` 逐字一致、三层键名同源、Gitee 分区零探测 |
| `tests/host-probe-shape.test.mjs` | 新增：单次 `execute` 形状（`{callId,name,arguments,signal}`，无 `calls` 信封） |
| `scripts/probe/host-probe-plugin.mjs` | 三处批式派发统一改 `dispatchTool`；`arguments` 改传对象（单次契约） |
| `.gitignore` | 追加 `artifacts/`、`tarballs/` |
| `docs/teamflow/20261106-r14-enterprise-iam-ui/{DESIGN,TECHNICAL}.md`、`docs/teamflow/20261106-r15-enterprise-iam-ui/{DESIGN,PRD,ACCEPTANCE}.md` | AC-8 的 15 条最小字面清理 |

## 3. 先红后绿（AC-5）

命令与结果（同一份新用例、同一台机器）：

```sh
# 红：把 HEAD 的旧 client.js 物化到 probe/head，用例指向它
git show HEAD:packages/forge-devops/client.js > logs/teamflow/tf-mw4y10xm-5q3dff/probe/head/client.js
FORGE_DEVOPS_CLIENT=logs/teamflow/tf-mw4y10xm-5q3dff/probe/head/client.js \
  node --test packages/forge-devops/test/readiness-section.test.mjs
# → tests 19 / pass 3 / fail 16

# 绿：当前源码
node --test packages/forge-devops/test/readiness-section.test.mjs
# → tests 19 / pass 19 / fail 0
```

红的 3 条是纯源码断言（字面量计数类），其余 16 条全部因旧面板缺行/缺证据/缺导航而失败。

## 4. 探针（AC-7）

```sh
node scripts/probe/run-host-probe.mjs
# → probe: 32/32 checks passed, 1 blocked
```

- 唯一 blocked：`official-rows-runtime-model-surface` —— 本 profile 的 LLM 提供方在禁用前后都是 0 个（基线对照同样为 0），无法证明禁用行对模型面的运行时影响；禁用行是否落地改由驱动的 `--dump-config` 对照证明（该项已 ok）。
- `node --test tests/host-probe.test.mjs` → 2/2 pass（`DSH_HOME` 干净与污染两种起法都通过）。

## 5. NOT RUN（本轮不执行，逐项给命令、期望证据与原因）

| # | 项 | 命令 | 期望证据 | 未执行原因 |
|---|---|---|---|---|
| 1 | 真实企业 IAM 联调（登录/退出/过期/主体匹配） | 企业网络内 `curl -s "$DSH/api/forge-iam/view"` | `state` 六态真实流转、`gatewayCredential.matchesAccount` 由服务端判定 | 无企业 IdP 与账号，本机零凭据 |
| 2 | 生产网关 Key 验证 | 同上，观察 `gatewayCredential.state` 与 `modelAccess.state` | 真实 `configured` + `ready` 才显示「已验证」 | 不写、不读真实 token；只按既有视图投影 |
| 3 | 企业 `dop` 只读探测（`change.read` 实跑） | `dop change view <id> --json` | 真实只读返回；四层证据的 `readonly` 从「策略准入」升级为「真实探测」 | 需已批准策略与企业 CLI；本轮 `readonly: pass` 只表示策略准入 |
| 4 | Windows 与麒麟 aarch64 双端实机 | 两平台各跑 `pnpm check` + 手工打开设置页 | 入口形态、执行位、路径大小写分支实测 | 无该环境；win32/POSIX 分支只有单测与静态覆盖 |
| 5 | 真实浏览器 DOM/Network 证据 | 见 §6 的 GUI 交接 | 截图/aria 树/Network 面板 | 由主 agent 在隔离 profile 完成 |
| 6 | tarball 的真实 GUI 装载与回滚 | 见 §6 | 两个分区出现、启动日志干净、回滚后零残留 | 同上 |
| 7 | 宿主 `settings.section` 分区切换公开 API | 反查 asar 与运行时探测 | 命中即出「前往企业账号」按钮 | 未核验；已实现能力探测 + 文字降级，不猜路由 |

## 6. GUI 交接（AC-11）

本轮不装日常 `desktop` profile、不伪造截图。交接给主 agent，建议隔离 profile `heluo-r16-uat`：

```sh
# 1) 构建企业组合包 tarball（产物落在被忽略的 dist/ 下）
node --input-type=module -e "import('./scripts/build-enterprise-bundle.mjs').then(m=>m.buildBundle({entry:'@heluo/forge-enterprise',destination:'dist/r16-uat'}))"

# 2) 隔离 profile 安装（不碰 desktop）
dsh plugin --profile heluo-r16-uat add dist/r16-uat/heluo-forge-enterprise-0.1.0.tgz

# 3) 起宿主并打开设置
dsh --profile heluo-r16-uat web

# 4) 回滚
dsh plugin --profile heluo-r16-uat remove @heluo/forge-enterprise
#    再按 README「卸载」段清掉补丁层里对应条目，最后删除 profile 目录
```

判据（全部满足才算通过）：

1. 设置页出现「企业研发」（order 29）与「企业 Gitee」（order 50）两个分区，文案不混排；
2. 企业研发页七行齐全：企业身份 / 公共参数 / 本机配置 / 网关 Key / DevOps / Gitee / 业务写权限，固定声明句在场；
3. 若宿主提供分区切换 API，身份行出现唯一「前往企业账号」按钮且点击切到 `forge-iam`；未提供时只出现「设置 → 企业账号」文字，**不出现点了没反应的按钮**；
4. 「检查 DevOps」发出且仅发出一次 `?refresh=1`；Gitee 检查按钮为禁用态；
5. 启动日志无 `entry not found`、无 `did not activate`；
6. 回滚后 `dsh.profile.bundles` 与补丁层零 `@heluo/*` 残留。

## 7. 已知偏差与保留说明

1. **Key 行在 IAM 不可达时显示「未知」**：TECHNICAL §10.2 的「四组反例其余行不变」对 Key 行不成立——Key 五态全部由 `/api/forge-iam/view` 推导，数据源断开时只能显示「未知」。用例据此断言「其余四行逐字不变 + Key 单独断言」，不把旧值冒充当前状态（诚实显示优先）。
2. **`client-shape.test.mjs` 旧文案断言收窄**：原「零命中旧显示名」正则含 `\benterprise\b`，与 r16 必须上屏的「企业账号 / 企业真实证据」冲突；收窄为 `/dop 服务地址|gh 组织|事实来源|\bmock\b|\.exe/u`，并新增「含 enterprise 的文案 key 必须以 `readiness.` 开头或为 `nav`/`title`」断言，保证该词只出现在契约名词位。
3. **探针 `arguments` 改传对象**：单次 `execute` 契约收对象参数；原先沿用批式的 JSON 字符串会让工具收到空参数（真实探针上表现为 7 条 gate 用例失败），改为对象后 32/32。

## 8. 保留项（AC-12，未提交修正原样保留）

本轮未写入以下路径（改动前即存在的未提交修正），交付时 `sha256`：

```
970ab4f75ab541aa6d0478d29b1cc110757d5cd9f36bfe2717c2b0487ff6c25d  demos/enterprise-settings/README.md
d55b8098f1d31ed660fc2405d60b84dadc9109766f0b170416427830b793c9e1  demos/enterprise-settings/build.mjs
48ab2321840be89f2252ce5be5791e5ff3bb7cf3f4a6d1d71b09aba01c12f57d  demos/enterprise-settings/client.js
c40d2c7691454df4acdee3945abdf3111f960d9847dba91a3cbc02aeb1318001  demos/enterprise-settings/cordis.patch.yml
4b85fd8fffd915ee8f006c09b34cc1c9a2f2ea6af93b515834d2dc0acb765411  demos/enterprise-settings/icon.svg
737463fa2917ec84aaa71ffdbea427d1b2bc9b7a795260f25c89a5e2ab34288f  demos/enterprise-settings/index.js
e74004e93bc3654349ed31a6afe68364979c8879bbfd0d7e7c35541655b6e30d  demos/enterprise-settings/locale/en.json
da26982154c38935827bb36cb9e0b8a005dec1d71fa8f70705fad5ef912bab1d  demos/enterprise-settings/locale/zh.json
0a3657ae2ba2cc50093944398358d1c8ab501bae43141e6d323807ba0b9fa75d  demos/enterprise-settings/model.mjs
1e1e909e1d582ce5425681d2ddd51f2497c0ef29b472eb36d0eaf3c60eb5a67a  demos/enterprise-settings/model.test.mjs
e2b661d168ad9814792b25982ae899b507e9bfa3da197b7ba221ea5606acf56c  scripts/probe/iam-review-memory-credentials.mjs
6ce0e1faf994643e8748c4aa0f8134cf6e439548f5295d2856a990ff4f701afd  scripts/lib/dsh-version.mjs
fbf615d1f14623341b8a04940639a5c75376c27f63291bcdfbd7a933a5e52886  tests/dsh-version.test.mjs
```

## 9. 验证记录（AC-10）

| 命令 | 结果 |
|---|---|
| `cd packages/forge-devops && node --test "test/*.test.mjs"` | 437 pass / 0 fail（≥404，不回退） |
| `cd packages/forge-gitee && node --test "test/*.test.mjs"` | 259 pass / 0 fail（=259，不回退） |
| `node --test tests/ui-contract.test.mjs` | 9 pass / 0 fail（≥6，只增） |
| `node --test tests/host-probe.test.mjs` | 2 pass / 0 fail |
| `node --test tests/host-probe-shape.test.mjs` | 4 pass / 0 fail |
| `node scripts/probe/run-host-probe.mjs` | 32/32 checks passed，0 FAIL，1 blocked |
| `node scripts/check-docs.mjs` | `docs: ok`（0 error，清理前 15） |
| `pnpm check` | exit 0；tests 2824 / pass 2823 / fail 0 / skipped 1（既有 Windows-only skip，本轮新增 skip 0） |
| `git diff --check` | 干净 |
| `git status --short` | 无 `*.tgz` / `dist/` / `logs/` / `artifacts/` 泄漏 |

## 10. 15 条文档清理逐条处置（AC-8）

| # | 位置 | 处置 |
|---|---|---|
| 1-4 | `docs/teamflow/20261106-r14-enterprise-iam-ui/DESIGN.md:46` | 4 条代码文件链接去掉 `#L..-L..` 片段，链接与结论不变 |
| 5-12 | `docs/teamflow/20261106-r14-enterprise-iam-ui/TECHNICAL.md:15,16,17(×2),19,20(×2),21` | 8 条代码文件链接同样只去片段 |
| 13 | `docs/teamflow/20261106-r15-enterprise-iam-ui/DESIGN.md:8` | 同上（1 条） |
| 14 | `docs/teamflow/20261106-r15-enterprise-iam-ui/PRD.md:22` | 本机绝对路径（`DSH_HOME` 指向用户目录）→ `DSH_HOME=<profile 根目录>` |
| 15 | `docs/teamflow/20261106-r15-enterprise-iam-ui/ACCEPTANCE.md:70` | 同上的复述改为占位，并注明已脱敏 |

历史任务夹只做最小字面清理：不归档、不升版、不改结论。
