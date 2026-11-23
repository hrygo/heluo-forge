# @heluo/forge-experts

> 状态：可用（管理包 Stage 3A-1/3A-2 本地单测与独立制品构建已通过；目标 DSH 实机与真实 Delegra 联调待验收）

河洛（Heluo Forge）面向 DeepSeek Harness（DSH `>=0.2.1-rc.3`）的**专家智能体独立插件包**（方案 B 单安装单元）。

## 定位与当前范围

- **当前阶段（Stage 3A-1/3A-2）**：提供「设置 → 专家智能体」浏览目录、「可调用」视图、个人手动启停（默认未启用）、同源 SSE 失效通知，以及隔离配置下的只读 `@` 候选投影（`GET /api/forge-experts/mentions`）。
- **默认关闭（Fail-Closed）**：`cordis.patch.yml` 中 `managementEnabled`、`isolatedMentionsPreviewEnabled` 与 `dispatchEnabled` 默认均为 `false`。生产 `@` 点选与真实委派须待 [#244](https://github.com/hrygo/heluo-forge/issues/244)、[#245](https://github.com/hrygo/heluo-forge/issues/245)、[#247](https://github.com/hrygo/heluo-forge/issues/247) 准入通过后方可在后续批次开放。
- **架构约束**：遵循 [DSH 插件高阶规范（P1–P9）](../../docs/engineering/dsh-plugin-conventions.md)：浏览器侧单 bundle `client.js`、Host 入口 `src/index.mjs` 仅做装配、业务轴间零互导、`storageDomain` 为唯一偏好真源。

## 关联文档

- [Forge 专家智能体管理插件详细设计](../../docs/design/plugins/forge-experts.md)
- [Delegra 专家智能体员工访问与受限受理契约](../../docs/contracts/delegra-expert-access.md)
- [Forge 专家智能体产品需求文档](../../docs/requirements/delegra-experts-prd.md)

## 本地测试与独立制品构建

```sh
pnpm --filter @heluo/forge-experts test
node scripts/build-enterprise-bundle.mjs --entry @heluo/forge-experts "$(mktemp -d)"
```

## 当前未验证范围

- 目标企业环境中的真实 Delegra 员工目录、逐专家授权与撤权收敛（#244）；
- 目标 DSH `0.2.1-rc.3` 发行物（Windows / macOS / 银河麒麟 Web）上的真实安装、重启与原生 UI 实机验收（#246）。
