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
| `codex-min` | `sha256:f9c6f5ab3d3e00bce1679d22e7b301a1dc3c6d013dfd63a4e94545679c5bc87f` | 323618497 | — |
| `codex-java-21` | `sha256:3da27b03d9d5f4006ed8c24b3c0d5bee9629a3be09556cdc9d0d720e4e2bb98f` | 489379138 | 165760641 |
| `codex-min-native` | `sha256:beac472772eba52a9ffac45e1359f87a26e04525282818703f53fb0549dc6703` | 316916298 | — |
| `codex-java-21-native` | `sha256:c9da0ceb251622e3bd8b4fc1b419f8c1bceba63d3dc15fe9fc17833dab094f1d` | 482676976 | 165760678 |

公共层通过固定 Debian 快照安装 Python `3.13.5`，`python3.13` 包版本为 `3.13.5-2+deb13u5`，`python3-venv` 包版本为 `3.13.5-1`。公共层装入 `uv` 和 `uvx` 后，npm 版压缩体积在仅含 Python 的同配置基线上增加 17.36 MiB。原生归档版比 npm 版少 6,702,199 字节。JDK 21 为 Temurin `21.0.12.1`。公共层选型按目标 Runner 实际启动验收。 [issue #394](https://github.com/hrygo/heluo-forge/issues/394)

公共镜像带 `curl`（Debian `8.14.1-2+deb13u7`）和 `jq`（Debian `1.7.1-6+deb13u4`）。公开轨迹记录两项命令的实际使用。以含 Python 和 uv 的公共镜像为基线，`apt-get -y --no-install-recommends --print-uris --download-only install` 估算含新增依赖的压缩下载量。`curl` 为 623,980 字节，`jq` 为 410,916 字节。两项合装后，npm 版实际 OCI 压缩层净增 1,076,922 字节（1.03 MiB）。 [Agent 调用轨迹表 4](https://junchengyang.com/publication/arxiv/agentWorkload.pdf)

公共冒烟覆盖 OCI 和 ELF 架构、默认 UID/GID、UTF-8 文件、Git、Shell、只读工具目录、`codex exec --help`、`app-server` 初始化、EOF 和 `tini` 退出码。Python 验证覆盖 AArch64 ELF、同一解释器、普通用户断网创建带 pip 的 venv、`uv venv` 和 CSV 单元测试。各镜像以普通用户核对 `uv`、`uvx` 版本及许可证可读性，并用 `curl` 请求回环模拟接口、用 `jq` 断言合成 JSON。在原生归档版公共镜像中，`uv sync --locked --offline` 使用 Python `3.13.5` 创建虚拟环境，锁文件哈希一致。

缺工具的旧公共镜像分别触发 `missing required tool: uv` 和 `missing required tool: curl`。BuildKit 自动创建的许可证目录曾继承文件模式 `0644`，普通用户无法读取其中的文件。构建配方将目录设为 `0755`，普通用户通过构建和冒烟检查。缺工具、stdio 超时及容器清理反例通过，耗时 2.35 秒。Bake 的 AMD64 反例在平台断言处失败，替换 Runner SHA-256 的反例在制品校验处失败。

## 场景目录

Bake `--print` 核对了 13 份 Dockerfile、17 个发布目标以及独立的两个对照目标的 ARM64 平台和父镜像。各目标使用同一公共冒烟入口，场景使用网络隔离容器内的回环服务和合成输入。

全量构建使用 `docker buildx bake -f deploy/delegra-expert-images/buildx-bake.hcl --load --sbom=true --provenance=mode=min,version=v1 default reference`，耗时 13 分 10.68 秒，加载后逐项核对 Buildx 的 `--metadata-file`。经 `docker image save` 核对 19 个镜像的 SPDX SBOM、SLSA provenance 和父镜像压缩层，耗时 20.06 秒。两类声明均绑定实际 ARM64 manifest。统一冒烟入口分两批运行全部 19 个镜像，合计耗时 55.56 秒。表中体积由各 Linux ARM64 manifest 按层 SHA-256 去重计算，Kubernetes 和 IaC 按运维诊断父层计算增量。

| 目标 | 场景判据 | image index digest | 压缩 MiB | 父层增量 MiB | 冒烟秒数 |
| --- | --- | --- | ---: | ---: | ---: |
| `codex-min` | 公共工具、Python 3.13.5、uv 0.13.9、回环 HTTP 与 JSON、Codex 0.160.0 stdio | `sha256:a246c8250960d7bed97b1196d9f8114d8b0faeadbb97cc6961b907c7aa428a14` | 308.63 | — | 3.31 |
| `codex-java-8` | Temurin 1.8.0_504，Java 8 编译与执行 | `sha256:c5ec6fe4dabfdb7443ce53564ce6f18ce89ef61aaa4e426433058be36d91daba` | 369.29 | 60.67 | 2.51 |
| `codex-java-11` | Temurin 11.0.32.1，指定 release 编译与执行 | `sha256:282f4073e7eec19f45067a88aaf88c7745e7004d3a84d1760f5378ed0ba870d4` | 453.52 | 144.90 | 2.50 |
| `codex-java-17` | Temurin 17.0.20.1，指定 release 编译与执行 | `sha256:46a347d62575855b456b5c03b355d67283a4fd1546cc39394022f14db0b8ce27` | 455.50 | 146.87 | 2.49 |
| `codex-java-21` | Temurin 21.0.12.1，指定 release 编译与执行 | `sha256:d1b24c0bffe6a2f783408f3bae74e4532a2134e2b6706f6e9e4c2dd267c56985` | 466.71 | 158.08 | 2.58 |
| `codex-java-25` | Temurin 25.0.4.1，指定 release 编译与执行 | `sha256:331e89e4364d4dd24da9862b5aedf7dac81660951d775ffbbb8b94df9078effc` | 404.84 | 96.22 | 2.49 |
| `codex-node` | Node 24.21.0、pnpm 11.28.5、TypeScript 6.0.3，编译与执行 | `sha256:3fde9b87e910676e017575c6c19c70dbdba61f0360c94666fdcd59932a67d3f6` | 318.45 | 9.82 | 2.92 |
| `codex-go` | Go 1.27.4，断网运行 go test | `sha256:249a09cbd1e85da8838b66fb19f578470dfedf8d79a64fc47a0838cfcdfde4c2` | 373.27 | 64.64 | 4.34 |
| `codex-sql` | PostgreSQL 客户端 17.12、MariaDB 11.8.6、SQLite 3.46.1，查询结果核对 | `sha256:79eff82d22727dedc8708ea9d05c6b04289a8eecadeea859006803b0b4a931f1` | 329.13 | 20.50 | 2.13 |
| `codex-dotnet-10` | .NET SDK 10.0.404，无外部源 restore、编译与执行 | `sha256:edca6a71e51775f9b6342437d606866732b8e388a144f56ed1020cb2d3016cd8` | 547.81 | 239.18 | 3.57 |
| `codex-test-api` | Newman 6.2.3，200、404 及 JSON 共 4 项断言和 JUnit 报告 | `sha256:068b632f96cb04983c94731f4cb05d5e2a93c5627e647d6843dfa6bfe0591812` | 320.01 | 11.38 | 2.74 |
| `codex-test-web` | Playwright 1.65.1、Chromium 159.0.8154.6，表单、导航和 PNG | `sha256:e19d01ac606588b24f2831e600939f83c6a0a11563c9c2c9b4c24a5f25270bf3` | 718.82 | 410.19 | 4.56 |
| `codex-test-load` | k6 2.4.0，单虚拟用户对回环接口测试 | `sha256:3b8b534365e10c6b7b36ddfb5625fc3688a4832ce3bd55de1970d8da7fe50375` | 336.56 | 27.94 | 4.18 |
| `codex-ops-diag` | BIND 9.20.30、回环网卡、证书及进程 | `sha256:9dfe03b78bae307ef74f43edb05990a187d0d6f3a7104217fdf6b63397ba6bcd` | 314.09 | 5.47 | 2.15 |
| `codex-ops-k8s` | kubectl 1.37.2、Helm 4.3.2，离线渲染两类清单 | `sha256:6db7f244b2eeac232d4b6eddcc32ebb95baf1146d558090931f37a29865a9a93` | 347.60 | 33.51 | 2.08 |
| `codex-ops-iac` | OpenTofu 1.13.9，无外部 provider 初始化及校验 | `sha256:9d526d9d2093c87b139c59486cd863fd697717298558edcc22022ef36e2237ab` | 344.15 | 30.06 | 2.21 |
| `codex-office-zh` | LibreOffice 25.2.3.2、Pandoc 3.1.11.1，三种格式导出与中文文本核对 | `sha256:ddc46adc8148347d3a38c8c09a61ddb3789cc918420db92399b9dc673a1a7a36` | 597.21 | 288.59 | 4.26 |

`codex-min-native` 的 image index digest 为 `sha256:a86080c02c7bee6aa222994f897d318480049ff29893e58178f81350ffdcc499`，冒烟耗时 1.94 秒。`codex-java-21-native` 的 image index digest 为 `sha256:adfb9a9d916866e2742a8c58a3552dfd2e383fc1d963368c2bb3b99a6bdd547c`，冒烟耗时 2.53 秒。

早期参考矩阵的 .NET 构建遇到下载中断，单目标重试使用相同的 MCR ARM64 digest，耗时 12 分 34 秒。中文办公构建耗时 8 分 02 秒。个别下载先使用相同 SHA-256 的暂存制品，最终全量构建使用默认锁定输入。

浏览器在 Docker 默认 seccomp 配置下拒绝启动沙箱。使用 Playwright 1.65.1 的官方 seccomp 配置并启用 `chromiumSandbox: true` 后，通过表单、导航、截图和容器清理。配置 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，截图 SHA-256 为 `593d6fbb8fdb8f468c22832a1ac3ff5d4ed67ca6f21538715ad2fec475c69144`。 [Playwright Docker 说明](https://playwright.dev/docs/docker)

办公镜像命中 `Noto Sans CJK SC`。DOCX、XLSX 和 PPTX 各导出一页 PDF，三个输出均可提取 `河洛样例` 与表格数据。

`pnpm check` 耗时 52.06 秒，4568 项通过、3 项跳过、0 失败。版本检查的回归用例同时核对 npm 锁文件误报消除和部署配置里的 DSH 版本硬编码仍被拦截。

## 待联调

真实 Delegra Runner 的按摘要拉取、选择、取消、进程回收及回退在 #394 验收。制品库上传、远端扫描、实际集群版本与企业网关访问按目标环境验收。 [镜像实施计划](../delegra-runtime-images.md#8-实施计划)
