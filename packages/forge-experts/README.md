# @heluo/forge-experts

> 状态：可用（Stage 3A-1 管理包骨架；仅仓内离线单测与独立制品构建验证。目标 DSH 发行物装入、设置页实机渲染、重启回读与真实 Delegra 联调均未实测，配置默认关闭）。核对日期：2026-11-22。

河洛（Heluo Forge）面向 DeepSeek Harness（DSH `>=0.2.1-rc.3`）的**专家智能体独立插件包**（方案 B 单安装单元）。

## 定位与当前范围

- **当前阶段（Stage 3A-1 管理包）**：提供「设置 → 专家智能体」浏览目录、「可调用」视图、个人手动启停（默认未启用）与同源 SSE 失效通知。
- **默认关闭（Fail-Closed）**：`cordis.patch.yml` 中 `managementEnabled` 与 `dispatchEnabled` 默认均为 `false`。生产 `@` 点选与真实委派须待 [#244](https://github.com/hrygo/heluo-forge/issues/244)、[#245](https://github.com/hrygo/heluo-forge/issues/245)、[#247](https://github.com/hrygo/heluo-forge/issues/247) 准入通过后方可在后续批次开放。
- **架构约束**：遵循 [DSH 插件高阶规范（P1–P9）](../../docs/engineering/dsh-plugin-conventions.md)：浏览器侧单 bundle `client.js`、Host 入口 `src/index.mjs` 仅做装配、业务轴间零互导、`storageDomain` 为唯一偏好真源。
- **宿主接缝（按 DSH `0.2.1-rc.3` 源码核验）**：`inject` 为服务名数组；路由经 `webServer.register({ kind: 'prefix', path, handler })` 装配；偏好存储经 `storageDomain.open(<DomainSpec>)` 取得 `Domain`，再以 `domain.table('preferences')`（`KvTable.get/put`）读写，记录 schema 由 `valueSchema.parse` 校验。
- **Delegra 连接器未接线**：`resolveDelegraScope`／`fetchDelegraCatalog`／`verifyOrgCallable` 三个端口在 #244 契约冻结前固定 fail closed（`EXPERT_DIRECTORY_UNAVAILABLE`），因此当前只能验证拒绝路径，不能验证目录与启停链路。

## 关联文档

- [Forge 专家智能体管理插件详细设计](../../docs/design/plugins/forge-experts.md)（含 §3.3 员工授权与目录、§3.5 同源接口）
- [Forge 专家智能体产品需求文档](../../docs/requirements/delegra-experts-prd.md)
- Delegra 员工访问与受限受理契约随 #244 落地（合同文本另提，本文不预置链接）

## 本地测试与独立制品构建

```sh
pnpm --filter @heluo/forge-experts test
node scripts/build-enterprise-bundle.mjs --entry @heluo/forge-experts "$(mktemp -d)"
node --run check
```

## 当前未验证范围

- 目标企业环境中的真实 Delegra 员工目录、逐专家授权、撤权收敛与受限受理（#244）；
- 目标 DSH `0.2.1-rc.3` 发行物（Windows / macOS / 银河麒麟 Web）上的真实装入、设置页渲染、重启回读与卸载清理（#246 / PR #423 预检）；
- 两窗口交错启停、写回未知与存储域重开的端到端行为：现仅有进程内单测覆盖，未在真实 `storageDomain` 后端上复跑；
- 候选 `@` 投影（`/api/forge-experts/mentions`）本次未实现，属候选阶段范围。
