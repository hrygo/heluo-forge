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
| `codex-min` | `sha256:33b70fdcfe9c97cb2871bc1b4a2cfc78dd507b87f288abb2b94f18ab9c80df7d` | 326625650 | — |
| `codex-java-21` | `sha256:589c3ebd5b9f9651368bcfa6652740425175821b2be9ae56b332737d538c863b` | 492386274 | 165760624 |
| `codex-min-native` | `sha256:210696d71b1f6e2b6a2c43c2c920b34d2f0841d39da25bc71b54512e87e7b113` | 319814556 | — |
| `codex-java-21-native` | `sha256:39892ada95c7c201738a149f11e13c8ee2232262ccd0616b846be2414d8a4889` | 485575201 | 165760645 |

公共层通过固定 Debian 快照安装 Python `3.13.5`，`python3.13` 包版本为 `3.13.5-2+deb13u5`，`python3-venv` 包版本为 `3.13.5-1`。公共层装入 `uv` 和 `uvx` 后，npm 版压缩体积在仅含 Python 的同配置基线上增加 17.36 MiB。原生归档版比 npm 版少 6,811,094 字节。JDK 21 为 Temurin `21.0.12.1`。公共层选型按目标 Runner 实际启动验收。 [issue #394](https://github.com/hrygo/heluo-forge/issues/394)

公共镜像带 `curl`（Debian `8.14.1-2+deb13u7`）和 `jq`（Debian `1.7.1-6+deb13u4`）。公开轨迹记录两项命令的实际使用。以含 Python 和 uv 的公共镜像为基线，`apt-get -y --no-install-recommends --print-uris --download-only install` 估算含新增依赖的压缩下载量。`curl` 为 623,980 字节，`jq` 为 410,916 字节。两项合装后，npm 版实际 OCI 压缩层净增 1,076,922 字节（1.03 MiB）。 [Agent 调用轨迹表 4](https://junchengyang.com/publication/arxiv/agentWorkload.pdf)

以含 `curl` 和 `jq` 的同配置 ARM64 镜像为基线，五项工具的 APT 压缩下载量合计为 1,456,412 字节（含新增依赖）。公共层装入五项后，npm 版实际 OCI 压缩层由 308.63 MiB 增至 309.78 MiB，净增 1,208,215 字节（1.15 MiB）。Codex 官方通用镜像预装 `make`、`zip` 和 `unzip`，项目测试执行 Agent 的公开轨迹记录了 `make` 的实际使用。 [Codex 官方镜像](https://github.com/openai/codex-universal/blob/main/Dockerfile) · [ExecutionAgent 图 10](https://software-lab.org/publications/issta2025_ExecutionAgent.pdf#page=17)

| 公共工具 | Debian 快照包版本 | 含新增依赖的 APT 下载字节 |
| --- | --- | ---: |
| `unzip` | `6.0-29+deb13u1` | 163,616 |
| `zip` | `3.0-15+deb13u1` | 227,476 |
| `file` | `1:5.46-5` | 484,704 |
| `make` | `4.4.1-2` | 452,396 |
| `patch` | `2.8-2` | 128,220 |

以含 ZIP、文件识别和构建工具的同配置 ARM64 镜像为基线，本组七项工具的 APT 压缩下载量合计为 2,838,216 字节（含新增依赖）。npm 版实际 OCI 压缩层由 309.78 MiB 增至 311.49 MiB，净增 1,798,938 字节（1.72 MiB）。Pi 的 macOS 会话样本有 585 条 Shell 调用使用 `lsof`。Codex 官方通用镜像预装 `rsync` 和 `xz`。`zstd` 可解包本仓库使用的 Codex 原生归档。 [Pi 调用记录](https://raw.githubusercontent.com/earendil-works/psh/main/research/corpus.md) · [Codex 官方镜像](https://github.com/openai/codex-universal/blob/main/Dockerfile)

| 公共工具包 | Debian 快照包版本 | 含新增依赖的 APT 下载字节 |
| --- | --- | ---: |
| `bzip2` | `1.0.8-6` | 39,492 |
| `lsof` | `4.99.4+dfsg-2` | 523,800 |
| `rsync` | `3.5.0+ds1-0+deb13u1` | 522,372 |
| `tree` | `2.2.1-1` | 57,900 |
| `xxd` | `2:9.1.1230-2+deb13u2` | 98,680 |
| `xz-utils` | `5.8.1-1+deb13u2` | 960,936 |
| `zstd` | `1.5.7+dfsg-1` | 635,036 |

公共冒烟覆盖 OCI 和 ELF 架构、默认 UID/GID、UTF-8 文件、Git、Shell、只读工具目录、`codex exec --help`、`app-server` 初始化、EOF 和 `tini` 退出码。Python 验证覆盖 AArch64 ELF、同一解释器、普通用户断网创建带 pip 的 venv、`uv venv` 和 CSV 单元测试。各镜像以普通用户核对 `uv`、`uvx` 版本及许可证可读性，并用 `curl` 请求回环模拟接口、用 `jq` 断言合成 JSON。通用工程工具的冒烟覆盖 ZIP 和 UTF-8 文件名、MIME 类型、Make 目标及补丁应用后的内容。以同一 UID 验证目录树、ZIP 二进制签名、当前进程打开的文件、本地目录同步及重复同步无变更，并对 `.tar.bz2`、`.tar.xz` 和 `.tar.zst` 作压缩解压往返。在原生归档版公共镜像中，`uv sync --locked --offline` 使用 Python `3.13.5` 创建虚拟环境，锁文件哈希一致。

缺工具的旧公共镜像分别触发 `missing required tool: uv`、`missing required tool: curl`、`missing required tool: file` 和 `missing required tool: bzip2`。BuildKit 自动创建的许可证目录曾继承文件模式 `0644`，普通用户无法读取其中的文件。构建配方将目录设为 `0755`，普通用户通过构建和冒烟检查。缺工具、stdio 超时及容器清理反例通过，耗时 2.38 秒。Bake 的 AMD64 反例在平台断言处失败，替换 Runner SHA-256 的反例在制品校验处失败。

## 场景目录

Bake `--print` 核对了 13 份 Dockerfile、17 个发布目标以及独立的两个对照目标的 ARM64 平台和父镜像。各目标使用同一公共冒烟入口，场景使用网络隔离容器内的回环服务和合成输入。

全量构建使用 `docker buildx bake -f deploy/delegra-expert-images/buildx-bake.hcl --load --sbom=true --provenance=mode=min,version=v1 default reference`，耗时 6 分 4.45 秒，加载后逐项核对 Buildx 的 `--metadata-file`。经 `docker image save` 核对 19 个镜像的 SPDX SBOM、SLSA provenance 和父镜像压缩层，耗时 17.76 秒。两类声明均绑定实际 ARM64 manifest。统一冒烟入口分批运行全部 19 个镜像，合计耗时 1 分 10.15 秒。表中体积由各 Linux ARM64 manifest 按层 SHA-256 去重计算，Kubernetes 和 IaC 按运维诊断父层计算增量。

| 目标 | 场景判据 | image index digest | 压缩 MiB | 父层增量 MiB | 冒烟秒数 |
| --- | --- | --- | ---: | ---: | ---: |
| `codex-min` | 公共工具、Python 3.13.5、uv 0.13.9、回环 HTTP 与 JSON、Codex 0.160.0 stdio | `sha256:71749d459f7163279c4aec3db1a57a5a4e84f19ed9bd721db03a7eba62350669` | 311.49 | — | 2.70 |
| `codex-java-8` | Temurin 1.8.0_504，Java 8 编译与执行 | `sha256:3a2d048b467aa9eaa3a0b0632993357dbc8ebd9ef67c324adadf3991f8353d01` | 372.16 | 60.67 | 2.94 |
| `codex-java-11` | Temurin 11.0.32.1，指定 release 编译与执行 | `sha256:668f3c5a17e7db96d794e7f717c15792f295079b2cb97b7229ae9c959ad72888` | 456.39 | 144.90 | 2.56 |
| `codex-java-17` | Temurin 17.0.20.1，指定 release 编译与执行 | `sha256:8b250017489ad9aab4e7d18005345c07658816f87e73e99960f2b3a5d0e2fafd` | 458.37 | 146.87 | 2.76 |
| `codex-java-21` | Temurin 21.0.12.1，指定 release 编译与执行 | `sha256:a6a2da7f77efb5a5c40a3e285ee7964e7e41cedbfc53ff5373dcc788f28fb782` | 469.58 | 158.08 | 2.95 |
| `codex-java-25` | Temurin 25.0.4.1，指定 release 编译与执行 | `sha256:0e28b63a1623e4f792dba37ee3172a79a6bb4dbf07a40fab7913b338975513e3` | 407.71 | 96.22 | 2.92 |
| `codex-node` | Node 24.21.0、pnpm 11.28.5、TypeScript 6.0.3，编译与执行 | `sha256:7dbc69099bb570000d1a83dde97e9879cd1aabd70cdf59336393c9a6da04a0f0` | 321.32 | 9.82 | 3.15 |
| `codex-go` | Go 1.27.4，断网运行 go test | `sha256:c5230c3e5274e2ef230ed856c64288695d3aba3043a92e1f13a00524ee6e2327` | 376.14 | 64.64 | 12.66 |
| `codex-sql` | PostgreSQL 客户端 17.12、MariaDB 11.8.6、SQLite 3.46.1，查询结果核对 | `sha256:3bd876b4e026b079d673b0f78cf3ba760f5448018faee38db606c779156a04f0` | 332.01 | 20.51 | 2.30 |
| `codex-dotnet-10` | .NET SDK 10.0.404，无外部源 restore、编译与执行 | `sha256:f745e12035793b4f3287d013910f281029a010b31fa4791f7ff72bee0890fec9` | 550.69 | 239.19 | 5.83 |
| `codex-test-api` | Newman 6.2.3，200、404 及 JSON 共 4 项断言和 JUnit 报告 | `sha256:284b6e517332c8811b484ab8ac46a21ca05650569b99b3183f454baed7113297` | 322.88 | 11.38 | 2.95 |
| `codex-test-web` | Playwright 1.65.1、Chromium 159.0.8154.6，表单、导航和 PNG | `sha256:e3e5d4705624642c1bdc6927b3ec8676bee523eaad6814c3efd4feb54338f552` | 721.70 | 410.20 | 2.74 |
| `codex-test-load` | k6 2.4.0，单虚拟用户对回环接口测试 | `sha256:142e7d531cd37db211af11266ef20dbccff5f15c0b364ad0d385212622f1bf3f` | 339.43 | 27.94 | 4.45 |
| `codex-ops-diag` | BIND 9.20.30、回环网卡、证书及进程 | `sha256:878914c5efc6ddd7763b8787fa1eed26fca6e148da1b81fdbf6ad782131ad935` | 316.88 | 5.39 | 2.54 |
| `codex-ops-k8s` | kubectl 1.37.2、Helm 4.3.2，离线渲染两类清单 | `sha256:9408adcac50b0b67660f34f5240e76e3186302247c52499abc23b034bc7dcb23` | 350.39 | 33.51 | 2.29 |
| `codex-ops-iac` | OpenTofu 1.13.9，无外部 provider 初始化及校验 | `sha256:b2cf8526e3341cd868a5a63fc968b923885b7ae65fa5cb1c6822a7d555541177` | 346.94 | 30.06 | 2.19 |
| `codex-office-zh` | LibreOffice 25.2.3.2、Pandoc 3.1.11.1，三种格式导出与中文文本核对 | `sha256:c90a1807d624d8cf64204a2b717435c6292f53da871bfb4acbca7c957c8db8a7` | 600.09 | 288.60 | 3.86 |

`codex-min-native` 的 image index digest 为 `sha256:aa85ecaeb1b6bed770cbe8ede926f2da81dd17243e7c672191d3288af8da2137`，冒烟耗时 2.15 秒。`codex-java-21-native` 的 image index digest 为 `sha256:12ab85caf5be7a54dbb7d462f0231d14b322e10d9c4fc2361d16e6c9e05f7668`，冒烟耗时 5.97 秒。

早期参考矩阵的 .NET 构建遇到下载中断，单目标重试使用相同的 MCR ARM64 digest，耗时 12 分 34 秒。中文办公构建耗时 8 分 02 秒。个别下载先使用相同 SHA-256 的暂存制品，最终全量构建使用默认锁定输入。

浏览器在 Docker 默认 seccomp 配置下拒绝启动沙箱。使用 Playwright 1.65.1 的官方 seccomp 配置并启用 `chromiumSandbox: true` 后，通过表单、导航、截图和容器清理。配置 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，截图 SHA-256 为 `593d6fbb8fdb8f468c22832a1ac3ff5d4ed67ca6f21538715ad2fec475c69144`。 [Playwright Docker 说明](https://playwright.dev/docs/docker)

办公镜像命中 `Noto Sans CJK SC`。DOCX、XLSX 和 PPTX 各导出一页 PDF，三个输出均可提取 `河洛样例` 与表格数据。

`pnpm check` 耗时 51.86 秒，4538 项通过、3 项跳过、0 失败。版本检查的回归用例同时核对 npm 锁文件误报消除和部署配置里的 DSH 版本硬编码仍被拦截。

## 待联调

真实 Delegra Runner 的按摘要拉取、选择、取消、进程回收及回退在 #394 验收。制品库上传、远端扫描、实际集群版本与企业网关访问按目标环境验收。 [镜像实施计划](../delegra-runtime-images.md#8-实施计划)
