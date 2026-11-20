# Delegra 专家运行时镜像实测记录

核验日期为 2026-11-20。构建和运行使用 Docker Engine 29.9.3、Buildx 0.38.1、BuildKit 0.34.2 的原生 Linux ARM64 节点。公共镜像的 glibc 为 `2.41`。仓库检查使用 Node `24.21.0` 和 pnpm `11.28.5`。配方和复跑入口见[部署资产说明](../../../deploy/delegra-expert-images/README.md)。

## 固定构建输入

- Runner 使用 Delegra `deploy/v2026.1106.0-r2` 的 `25c86a283a9c787a01911c714618d78df7552af7`。对官方源码归档中参与构建的 182 个文件与 Git 对象逐一核验，`Cargo.lock` 的 SHA-256 为 `1dea479bbc7c522d0d1e299991aa43ec08a575668a87973eda3584bd295bc34d`。
- 基础、Rust、Java、uv 和其他场景工具链摘要见 [Bake](../../../deploy/delegra-expert-images/buildx-bake.hcl)。npm 包及 ARM64 Codex `0.160.0` 的完整依赖由各自锁文件固定。
- uv `0.13.9` 的 Astral OCI 索引 `sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d` 已通过 `gh attestation verify --repo astral-sh/uv`。索引中的 `linux/arm64` manifest `sha256:3c427f748c40dc9fc439a497f48dea59d2386cb02937e49f2399aaba1de8028a` 为 Bake 输入。随镜像携带同版本的 MIT 许可证。 [Astral 0.13.9](https://github.com/astral-sh/uv/releases/tag/0.13.9)
- Debian `20261119T203050Z` 和安全更新 `20261119T205304Z` 快照以 Debian archive keyring 验签。核对的 InRelease SHA-256 见下表。

| Suite | InRelease SHA-256 |
| --- | --- |
| `trixie` | `0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675` |
| `trixie-updates` | `6f57bff7c8bf51425b0d654b57a93a8cf83f07a6a5d6116ee766f4612336c642` |
| `trixie-security` | `66106c1ecda6d4c90be107fd66d2daa815d5aa924cd6b10423b06a5c7cac38f9` |

## 公共层与 Java 21

四个目标来自同一次完整矩阵构建。压缩体积按各 `linux/arm64` manifest 的 gzip 层和 SHA-256 计算，派生增量以同批次父镜像的去重层为准。

| Bake 目标 | ARM64 manifest digest | 压缩层字节 | 父层增加字节 |
| --- | --- | ---: | ---: |
| `codex-min` | `sha256:b6657bcf0c8dfbd1ca2b3523cd76b806ff222e4333415cebe509ce06dbd830c8` | 322541575 | — |
| `codex-java-21` | `sha256:1fd53d0cd315b4764531bbcdb821701481b94ebb1e6734ae0c72dcbc8aff1ecc` | 488302219 | 165760644 |
| `codex-min-native` | `sha256:94a59637203c4072a1a731ee432bad10a48598d94245438146e2369c68df33b0` | 315839351 | — |
| `codex-java-21-native` | `sha256:63e75f00875f264513abb965f34d4d4c0a67d8dcb3f1617823ed8befc3799b45` | 481599992 | 165760641 |

公共层通过固定 Debian 快照安装 Python `3.13.5`，`python3.13` 包版本为 `3.13.5-2+deb13u5`，`python3-venv` 包版本为 `3.13.5-1`。公共层装入 `uv` 和 `uvx` 后，npm 版压缩体积在仅含 Python 的同配置基线上增加 17.36 MiB。原生归档版比 npm 版少 6,702,224 字节。JDK 21 为 Temurin `21.0.12.1`。公共层选型按目标 Runner 实际启动验收。 [issue #394](https://github.com/hrygo/heluo-forge/issues/394)

公共冒烟覆盖 OCI 和 ELF 架构、默认 UID/GID、UTF-8 文件、Git、Shell、只读工具目录、`codex exec --help`、`app-server` 初始化、EOF 和 `tini` 退出码。Python 验证覆盖 AArch64 ELF、同一解释器、普通用户断网创建带 pip 的 venv、`uv venv` 和 CSV 单元测试。各镜像以普通用户核对 `uv`、`uvx` 版本及许可证可读性。在原生归档版公共镜像中，`uv sync --locked --offline` 使用 Python `3.13.5` 创建虚拟环境，锁文件哈希一致。

旧公共镜像在新检查中报 `missing required tool: uv`。BuildKit 自动创建的许可证目录曾继承文件模式 `0644`，普通用户无法读取其中的文件。构建配方将目录设为 `0755`，普通用户通过构建和冒烟检查。缺工具、stdio 超时及容器清理反例通过，耗时 2.43 秒。Bake 的 AMD64 反例在平台断言处失败，替换 Runner SHA-256 的反例在制品校验处失败。

## 场景目录

Bake `--print` 核对了 13 份 Dockerfile、17 个发布目标以及独立的两个对照目标的 ARM64 平台和父镜像。各目标使用同一公共冒烟入口，场景使用网络隔离容器内的回环服务和合成输入。

全量构建使用 `docker buildx bake -f deploy/delegra-expert-images/buildx-bake.hcl --load --sbom=true --provenance=mode=min,version=v1 default reference`，耗时 6 分 20.47 秒，加载后逐项核对 Buildx 的 `--metadata-file`。经 `docker image save` 核对 19 个镜像的 SPDX SBOM、SLSA provenance 和父镜像压缩层，耗时 35.70 秒。两类声明均绑定实际 ARM64 manifest。统一冒烟入口运行全部 19 个镜像，耗时 1 分 27.82 秒。表中体积由各 Linux ARM64 manifest 按层 SHA-256 去重计算，Kubernetes 和 IaC 按运维诊断父层计算增量。

| 目标 | 场景判据 | image index digest | 压缩 MiB | 父层增量 MiB | 冒烟秒数 |
| --- | --- | --- | ---: | ---: | ---: |
| `codex-min` | 公共工具、Python 3.13.5、uv 0.13.9 及 Codex 0.160.0 stdio | `sha256:85128ef74b3a7ea55ca8bbbe05396df4da0533eeff4d02958ebfe7e7ea9378ae` | 307.60 | — | 1.95 |
| `codex-java-8` | Temurin 1.8.0_504，Java 8 编译与执行 | `sha256:ca824e5761851a577b6cc5e4de963245f17954619a20e7713818a30cf5d2f119` | 368.27 | 60.67 | 2.71 |
| `codex-java-11` | Temurin 11.0.32.1，指定 release 编译与执行 | `sha256:0237096bbf52abff18ff34c26302539e9f6671d574d1d6c28b02054dc8bf4303` | 452.50 | 144.90 | 8.54 |
| `codex-java-17` | Temurin 17.0.20.1，指定 release 编译与执行 | `sha256:66a769bb088afac2a7a760cf3b1c83790170f255715c48d56cf737101c1c38e4` | 454.47 | 146.87 | 12.78 |
| `codex-java-21` | Temurin 21.0.12.1，指定 release 编译与执行 | `sha256:7aa8b446228a94a306e2d41977f66a434b37fd179de7fef0c540542a7aee0533` | 465.68 | 158.08 | 12.72 |
| `codex-java-25` | Temurin 25.0.4.1，指定 release 编译与执行 | `sha256:36b5eef8e25b44214bcfafbf3829645a5a0b21a5d4e913cfef6ef439187a2147` | 403.81 | 96.22 | 3.26 |
| `codex-node` | Node 24.21.0、pnpm 11.28.5、TypeScript 6.0.3，编译与执行 | `sha256:724911d7c17cb987ce2aed79b284b826e0215909fae57e30390c05e6775fa8b4` | 317.42 | 9.82 | 3.71 |
| `codex-go` | Go 1.27.4，断网运行 go test | `sha256:60d72a1bbd168d20c1f49de0b48adbaaaee38c53652e337fe0292f44067df460` | 372.24 | 64.64 | 6.72 |
| `codex-sql` | PostgreSQL 客户端 17.12、MariaDB 11.8.6、SQLite 3.46.1，查询结果核对 | `sha256:cc553aadd290cb29f2ded9e304da627d2f65aea2ccc0cdc83a07b5f635d08b30` | 328.10 | 20.50 | 2.17 |
| `codex-dotnet-10` | .NET SDK 10.0.404，无外部源 restore、编译与执行 | `sha256:524a78340b2303b3dfd6da2111fbda936a100a75cdec403a276dbe0483fb20cd` | 546.78 | 239.18 | 6.19 |
| `codex-test-api` | Newman 6.2.3，200、404 及 JSON 共 4 项断言和 JUnit 报告 | `sha256:077c752cbcbe8e4563ed9504d95f0dabc1313c5c93b226688ba93b7c8d1f85fb` | 318.98 | 11.38 | 2.76 |
| `codex-test-web` | Playwright 1.65.1、Chromium 159.0.8154.6，表单、导航和 PNG | `sha256:538648f452328d576c43b0d723840636b1127c801a6ef01848c1b384c68ef040` | 717.79 | 410.19 | 2.76 |
| `codex-test-load` | k6 2.4.0，单虚拟用户对回环接口测试 | `sha256:7b6096385d4b4358e1c1f29dac4a5bc32f5fb2ff68b8590d4295059d87b13926` | 335.53 | 27.94 | 4.23 |
| `codex-ops-diag` | curl 8.14.1、jq 1.7、BIND 9.20.30，回环 HTTP、证书和进程 | `sha256:340894d429db0c5439c3599d27714961c68064b02cf205aca6ba5419238a5fcc` | 314.10 | 6.50 | 2.55 |
| `codex-ops-k8s` | kubectl 1.37.2、Helm 4.3.2，离线渲染两类清单 | `sha256:f68e4ca87275b1f0f9cd00f45a9944040e8c653f8a7ba8a8a9aeefd883e53b53` | 347.61 | 33.51 | 2.22 |
| `codex-ops-iac` | OpenTofu 1.13.9，无外部 provider 初始化及校验 | `sha256:a4aab6803ec9b477a735bfcb218d448fc224805f9d271dd9faf7f24c98563152` | 344.16 | 30.06 | 2.15 |
| `codex-office-zh` | LibreOffice 25.2.3.2、Pandoc 3.1.11.1，三种格式导出与中文文本核对 | `sha256:9888173c6efde1021abc5e8cbac9d04cba59e5b089c2a11ae24f361970dcc635` | 596.64 | 289.04 | 3.65 |

`codex-min-native` 的 image index digest 为 `sha256:edd2a92d2b3e2b2a81362995e6f2f12b230539a770688696822e4ea38a678dd4`，冒烟耗时 2.12 秒。`codex-java-21-native` 的 image index digest 为 `sha256:aae434e54f13f2ad0fb4260b9b16c4e6bc7468ca3fd71fba6e9e0233768f7953`，冒烟耗时 4.61 秒。

早期参考矩阵的 .NET 构建遇到下载中断，单目标重试使用相同的 MCR ARM64 digest，耗时 12 分 34 秒。中文办公构建耗时 8 分 02 秒。个别下载先使用相同 SHA-256 的暂存制品，最终全量构建使用默认锁定输入。

浏览器在 Docker 默认 seccomp 配置下拒绝启动沙箱。使用 Playwright 1.65.1 的官方 seccomp 配置并启用 `chromiumSandbox: true` 后，通过表单、导航、截图和容器清理。配置 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，截图 SHA-256 为 `593d6fbb8fdb8f468c22832a1ac3ff5d4ed67ca6f21538715ad2fec475c69144`。 [Playwright Docker 说明](https://playwright.dev/docs/docker)

办公镜像命中 `Noto Sans CJK SC`。DOCX、XLSX 和 PPTX 各导出一页 PDF，三个输出均可提取 `河洛样例` 与表格数据。

`pnpm check` 耗时 51.62 秒，4568 项通过、3 项跳过、0 失败。版本检查的回归用例同时核对 npm 锁文件误报消除和部署配置里的 DSH 版本硬编码仍被拦截。

## 待联调

真实 Delegra Runner 的按摘要拉取、选择、取消、进程回收及回退在 #394 验收。制品库上传、远端扫描、实际集群版本与企业网关访问按目标环境验收。 [镜像实施计划](../delegra-runtime-images.md#8-实施计划)
