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
| `codex-min` | `sha256:5b4b4f4c205b23e4afac6a6bad471e9df4a05aa94aeb3e0733c5e9e68e26a0b2` | 324826712 | — |
| `codex-java-21` | `sha256:80a9a22b40aff432b464e0f36f103596a0adaa1279978225e6e6f36c8c3d85e2` | 490587335 | 165760623 |
| `codex-min-native` | `sha256:9abf18500126617175ed25590af6a8dff557ec9503090cc5fba4660919361cc6` | 318124612 | — |
| `codex-java-21-native` | `sha256:8c331f1412596c75d0cd99183756fb7cb8c9281d489678cadde0dc4ef6667767` | 483885320 | 165760708 |

公共层通过固定 Debian 快照安装 Python `3.13.5`，`python3.13` 包版本为 `3.13.5-2+deb13u5`，`python3-venv` 包版本为 `3.13.5-1`。公共层装入 `uv` 和 `uvx` 后，npm 版压缩体积在仅含 Python 的同配置基线上增加 17.36 MiB。原生归档版比 npm 版少 6,702,100 字节。JDK 21 为 Temurin `21.0.12.1`。公共层选型按目标 Runner 实际启动验收。 [issue #394](https://github.com/hrygo/heluo-forge/issues/394)

公共镜像带 `curl`（Debian `8.14.1-2+deb13u7`）和 `jq`（Debian `1.7.1-6+deb13u4`）。公开轨迹记录两项命令的实际使用。以含 Python 和 uv 的公共镜像为基线，`apt-get -y --no-install-recommends --print-uris --download-only install` 估算含新增依赖的压缩下载量。`curl` 为 623,980 字节，`jq` 为 410,916 字节。两项合装后，npm 版实际 OCI 压缩层净增 1,076,922 字节（1.03 MiB）。 [Agent 调用轨迹表 4](https://junchengyang.com/publication/arxiv/agentWorkload.pdf)

以含 `curl` 和 `jq` 的同配置 ARM64 镜像为基线，五项工具的 APT 压缩下载量合计为 1,456,412 字节（含新增依赖）。公共层装入五项后，npm 版实际 OCI 压缩层由 308.63 MiB 增至 309.78 MiB，净增 1,208,215 字节（1.15 MiB）。Codex 官方通用镜像预装 `make`、`zip` 和 `unzip`，项目测试执行 Agent 的公开轨迹记录了 `make` 的实际使用。 [Codex 官方镜像](https://github.com/openai/codex-universal/blob/main/Dockerfile) · [ExecutionAgent 图 10](https://software-lab.org/publications/issta2025_ExecutionAgent.pdf#page=17)

| 公共工具 | Debian 快照包版本 | 含新增依赖的 APT 下载字节 |
| --- | --- | ---: |
| `unzip` | `6.0-29+deb13u1` | 163,616 |
| `zip` | `3.0-15+deb13u1` | 227,476 |
| `file` | `1:5.46-5` | 484,704 |
| `make` | `4.4.1-2` | 452,396 |
| `patch` | `2.8-2` | 128,220 |

公共冒烟覆盖 OCI 和 ELF 架构、默认 UID/GID、UTF-8 文件、Git、Shell、只读工具目录、`codex exec --help`、`app-server` 初始化、EOF 和 `tini` 退出码。Python 验证覆盖 AArch64 ELF、同一解释器、普通用户断网创建带 pip 的 venv、`uv venv` 和 CSV 单元测试。各镜像以普通用户核对 `uv`、`uvx` 版本及许可证可读性，并用 `curl` 请求回环模拟接口、用 `jq` 断言合成 JSON。通用工程工具的冒烟覆盖 ZIP 和 UTF-8 文件名、MIME 类型、Make 目标及补丁应用后的内容。在原生归档版公共镜像中，`uv sync --locked --offline` 使用 Python `3.13.5` 创建虚拟环境，锁文件哈希一致。

缺工具的旧公共镜像分别触发 `missing required tool: uv`、`missing required tool: curl` 和 `missing required tool: file`。BuildKit 自动创建的许可证目录曾继承文件模式 `0644`，普通用户无法读取其中的文件。构建配方将目录设为 `0755`，普通用户通过构建和冒烟检查。缺工具、stdio 超时及容器清理反例通过，耗时 2.34 秒。Bake 的 AMD64 反例在平台断言处失败，替换 Runner SHA-256 的反例在制品校验处失败。

## 场景目录

Bake `--print` 核对了 13 份 Dockerfile、17 个发布目标以及独立的两个对照目标的 ARM64 平台和父镜像。各目标使用同一公共冒烟入口，场景使用网络隔离容器内的回环服务和合成输入。

全量构建使用 `docker buildx bake -f deploy/delegra-expert-images/buildx-bake.hcl --load --sbom=true --provenance=mode=min,version=v1 default reference`，耗时 9 分 22.13 秒，加载后逐项核对 Buildx 的 `--metadata-file`。经 `docker image save` 核对 19 个镜像的 SPDX SBOM、SLSA provenance 和父镜像压缩层，耗时 17.74 秒。两类声明均绑定实际 ARM64 manifest。统一冒烟入口分批运行全部 19 个镜像，合计耗时 1 分 1.40 秒。表中体积由各 Linux ARM64 manifest 按层 SHA-256 去重计算，Kubernetes 和 IaC 按运维诊断父层计算增量。

| 目标 | 场景判据 | image index digest | 压缩 MiB | 父层增量 MiB | 冒烟秒数 |
| --- | --- | --- | ---: | ---: | ---: |
| `codex-min` | 公共工具、Python 3.13.5、uv 0.13.9、回环 HTTP 与 JSON、Codex 0.160.0 stdio | `sha256:1bf307c7991c2e5b312b602a270c0b6c9c2751ee3674630a3a91d6bf6e8f8b25` | 309.78 | — | 2.24 |
| `codex-java-8` | Temurin 1.8.0_504，Java 8 编译与执行 | `sha256:835ab103b7d3aa90342da3435f0ac1d1e22b1f25ebeb35c3d2b22671a4d107b4` | 370.45 | 60.67 | 3.08 |
| `codex-java-11` | Temurin 11.0.32.1，指定 release 编译与执行 | `sha256:2654767d47aa4fd8d0c59bf22479ce809e5d8831ebbcc991081bc38b2c0cb00e` | 454.68 | 144.90 | 7.17 |
| `codex-java-17` | Temurin 17.0.20.1，指定 release 编译与执行 | `sha256:e0d02af65ffe83af52def39e7315951deb1c42b3d5edf30b449c5f91274a9a09` | 456.65 | 146.87 | 2.53 |
| `codex-java-21` | Temurin 21.0.12.1，指定 release 编译与执行 | `sha256:5710192c3e9b63cf6399cac72ceaf614f7312f454d83dc2e85c958a854ef4fb8` | 467.86 | 158.08 | 2.55 |
| `codex-java-25` | Temurin 25.0.4.1，指定 release 编译与执行 | `sha256:a2ff0e558382cbde060203f27b4cfc8d67565ffc22ce0055475de8b597514897` | 405.99 | 96.22 | 2.79 |
| `codex-node` | Node 24.21.0、pnpm 11.28.5、TypeScript 6.0.3，编译与执行 | `sha256:089da922ec5eff4fd3dea0b27d5b1237b2f9b4b3ce104dbf9671d42f6861ca37` | 319.60 | 9.82 | 3.29 |
| `codex-go` | Go 1.27.4，断网运行 go test | `sha256:a8190189512670a78a78387eb26399a7972d498dd205b07f118083f430837c28` | 374.42 | 64.64 | 4.34 |
| `codex-sql` | PostgreSQL 客户端 17.12、MariaDB 11.8.6、SQLite 3.46.1，查询结果核对 | `sha256:c74b356fcd3e16364bf572e62ec16951698f76fc107642c18389192758791e04` | 330.28 | 20.51 | 2.38 |
| `codex-dotnet-10` | .NET SDK 10.0.404，无外部源 restore、编译与执行 | `sha256:cec85a758e941ca976350060a570e4e4234fc3fea97d31c4efa780e15278720d` | 548.97 | 239.19 | 3.99 |
| `codex-test-api` | Newman 6.2.3，200、404 及 JSON 共 4 项断言和 JUnit 报告 | `sha256:3013aee6c9b3ba4932f7e3ee573fdfd22188f7c334e922f0e9178bd5b12ff1c6` | 321.16 | 11.38 | 2.81 |
| `codex-test-web` | Playwright 1.65.1、Chromium 159.0.8154.6，表单、导航和 PNG | `sha256:2e5a3430946e9acb07965d2e5c3e9c52dde588da7a3294566ce1121f50102f1e` | 719.98 | 410.20 | 3.24 |
| `codex-test-load` | k6 2.4.0，单虚拟用户对回环接口测试 | `sha256:f5046719f558bbfeaf689184b74ef2a58c0c6d8a004166a13a2deaf1a2bd4f92` | 337.71 | 27.94 | 4.20 |
| `codex-ops-diag` | BIND 9.20.30、回环网卡、证书及进程 | `sha256:54475f07d796262ed63d87f9138e472d4fac81cdafd91a36e64fe7c5d7631050` | 315.25 | 5.47 | 2.44 |
| `codex-ops-k8s` | kubectl 1.37.2、Helm 4.3.2，离线渲染两类清单 | `sha256:90a174b9d2612c6f0293b642746f858dcbc2b222a73fb848af164a4308f68dc4` | 348.75 | 33.51 | 2.38 |
| `codex-ops-iac` | OpenTofu 1.13.9，无外部 provider 初始化及校验 | `sha256:cfaaf795cd64337ba2eebae2fb4bee575be8582a38d0725ab950cdd4dd04b5d9` | 345.31 | 30.06 | 2.29 |
| `codex-office-zh` | LibreOffice 25.2.3.2、Pandoc 3.1.11.1，三种格式导出与中文文本核对 | `sha256:9556f3f16534fa2747af71628ae8c0c9468d7397a38f5a47f10a12ed85764b88` | 598.37 | 288.59 | 3.66 |

`codex-min-native` 的 image index digest 为 `sha256:0063c3041672275ebb0fef1f40035ccffa9b9e7177b1c4fec41b3e0f1c09065a`，冒烟耗时 1.83 秒。`codex-java-21-native` 的 image index digest 为 `sha256:d05a73be55928be257ab16eed8e4914c4505f1f238327a45ae1aef02e7a30010`，冒烟耗时 3.90 秒。

早期参考矩阵的 .NET 构建遇到下载中断，单目标重试使用相同的 MCR ARM64 digest，耗时 12 分 34 秒。中文办公构建耗时 8 分 02 秒。个别下载先使用相同 SHA-256 的暂存制品，最终全量构建使用默认锁定输入。

浏览器在 Docker 默认 seccomp 配置下拒绝启动沙箱。使用 Playwright 1.65.1 的官方 seccomp 配置并启用 `chromiumSandbox: true` 后，通过表单、导航、截图和容器清理。配置 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，截图 SHA-256 为 `593d6fbb8fdb8f468c22832a1ac3ff5d4ed67ca6f21538715ad2fec475c69144`。 [Playwright Docker 说明](https://playwright.dev/docs/docker)

办公镜像命中 `Noto Sans CJK SC`。DOCX、XLSX 和 PPTX 各导出一页 PDF，三个输出均可提取 `河洛样例` 与表格数据。

`pnpm check` 耗时 54.00 秒，4538 项通过、3 项跳过、0 失败。版本检查的回归用例同时核对 npm 锁文件误报消除和部署配置里的 DSH 版本硬编码仍被拦截。

## 待联调

真实 Delegra Runner 的按摘要拉取、选择、取消、进程回收及回退在 #394 验收。制品库上传、远端扫描、实际集群版本与企业网关访问按目标环境验收。 [镜像实施计划](../delegra-runtime-images.md#8-实施计划)
