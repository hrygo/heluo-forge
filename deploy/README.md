# 部署资产

本目录存放私有市场、独立服务和双端分发的部署资产。

市场采用轻量原生索引模式：[轻量市场设计](<../docs/design/plugins/forge-market.md>)、[索引契约](<../docs/design/services/market-index.md>)与 [issue #12](https://github.com/hrygo/heluo-forge/issues/12)。`packages/forge-market` 与旧 `market-index` HTTP 服务仅历史参考，不属目标；`market-index` 只保留只读校验器。[ADR-11/13](<../docs/architecture/plugin-registry-source-decision.md>)已确认企业私有 npm（公网同步包与内部定制包）与 AIHUB 托管索引；首版只收自包含、三目标通用稳定版。索引交付、终端认证与三目标安装尚待验证，不是已完成部署。

| 子目录 | 内容 | 状态 |
|---|---|---|
| [`registry/`](<registry/README.md>) | 企业私有 npm 的接入、公网同步、内部包发布与运维边界 | 来源已定；接入待核验 |
| [`clients/`](<clients/README.md>) | Windows 与银河麒麟客户端配置、安装与更新资产 | 待构建 |

## Delegra 专家运行时镜像

Delegra 维护 `docker/expert-runtime/` 下的 Dockerfile、Bake、锁文件、测试夹具和冒烟入口。镜像工作流在原生 ARM64 节点验证 17 个发布目标和两个对照目标，仅使用 `expert-images-vMAJOR.MINOR.PATCH` 稳定标签向 `ghcr.io/hrygo/delegra/<target>` 发布。 [镜像源目录与复跑说明](https://github.com/hrygo/Delegra/tree/deploy/docker/expert-runtime) · [Delegra 镜像工作流](https://github.com/hrygo/Delegra/actions/workflows/delegra-expert-images.yml)

Heluo Forge 验证 `expert-images-release.json`，将 `images[].name` 和 OCI 索引 `images[].digest` 拼接为 `name@digest`，用 `images[].platformDigest` 核对 ARM64 manifest。目标提供方的实际配置入口、按摘要调度、取消、回收和回退待验收。 [消费步骤](../docs/design/verification/delegra-runtime-images.md#按摘要选用发布镜像) · [镜像设计](../docs/design/delegra-runtime-images.md) · [issue #394](https://github.com/hrygo/heluo-forge/issues/394)

## 边界

- 优先复用企业现有 registry 与分发通道，不默认自建基础设施。
- 仓库内不保存真实地址、凭据、证书私钥或生产配置；使用占位与外部注入。
- 部署资产进入仓库前须明确归属、审批人与回滚方式。
- 本目录的存在不代表任何环境已部署；实机与生产验证记录另存门禁证据。
