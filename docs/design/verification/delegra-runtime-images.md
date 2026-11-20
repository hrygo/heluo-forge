# Delegra 专家运行时镜像实测记录

核验日期为 2026-11-20。构建和运行使用 Docker Engine 29.9.3、Buildx 0.38.1、BuildKit 0.34.2 的原生 Linux ARM64 节点。公共镜像的 glibc 为 `2.41`。仓库检查使用 Node `24.21.0` 和 pnpm `11.28.5`。配方和复跑入口见[部署资产说明](../../../deploy/delegra-expert-images/README.md)。

## 固定构建输入

- Runner 使用 Delegra `deploy/v2026.1106.0-r2` 的 `25c86a283a9c787a01911c714618d78df7552af7`。对官方源码归档中参与构建的 182 个文件与 Git 对象逐一核验，`Cargo.lock` 的 SHA-256 为 `1dea479bbc7c522d0d1e299991aa43ec08a575668a87973eda3584bd295bc34d`。
- 基础、Rust、Java 和其他场景工具链摘要见 [Bake](../../../deploy/delegra-expert-images/buildx-bake.hcl)。npm 包及 ARM64 Codex `0.160.0` 的完整依赖由各自锁文件固定。
- Debian `20261119T203050Z` 和安全更新 `20261119T205304Z` 快照以 Debian archive keyring 验签。核对的 InRelease SHA-256 见下表。

| Suite | InRelease SHA-256 |
| --- | --- |
| `trixie` | `0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675` |
| `trixie-updates` | `6f57bff7c8bf51425b0d654b57a93a8cf83f07a6a5d6116ee766f4612336c642` |
| `trixie-security` | `66106c1ecda6d4c90be107fd66d2daa815d5aa924cd6b10423b06a5c7cac38f9` |

## 公共层与 Java 21

四个目标用 `docker buildx bake --load` 构建，以 gzip level 6 导出 OCI，耗时 20.29 秒，并由 `expert-runtime-oci-size.mjs` 读取 `linux/arm64` manifest。压缩层以 SHA-256 去重，派生增量按同次导出的父层计算。

| Bake 目标 | ARM64 manifest digest | 压缩层字节 | 父层增加字节 |
| --- | --- | ---: | ---: |
| `codex-min` | `sha256:7b6f6cd7efc05a93cefbf5eb7d7752e98602bb2c92e1d08009c8c64eee45c6d4` | 290456702 | — |
| `codex-java-21` | `sha256:30143c0f7ddf2150a1da8c0f1472d327980280275b6c8382a745eb02279d3c2b` | 456217345 | 165760643 |
| `codex-min-native` | `sha256:9ecc0718f74457d767362d9b8022c620dbde9baa93d2eb8eeed8137e2df1d93a` | 283754581 | — |
| `codex-java-21-native` | `sha256:fdee77fda762578f493760f8276ae69840ac0bb6357c19be79edf4bf65204ced` | 449515289 | 165760708 |

JDK 21 为 Temurin `21.0.12.1`。原生归档版公共层压缩体积减少 6,702,121 字节。公共层选型按目标 Runner 实际启动验收。 [issue #394](https://github.com/hrygo/heluo-forge/issues/394)

公共冒烟覆盖 OCI 和 ELF 架构、默认 UID/GID、UTF-8 文件、Git、Shell、只读工具目录、`codex exec --help`、`app-server` 初始化、EOF 和 `tini` 退出码。缺工具、stdio 超时及容器清理反例通过，耗时 2.98 秒。Bake 的 AMD64 反例在平台断言处失败，替换 Runner SHA-256 的反例在制品校验处失败。

## 场景目录

Bake `--print` 核对了 14 份 Dockerfile、18 个发布目标以及独立的两个对照目标的 ARM64 平台和父镜像。各目标使用同一公共冒烟入口，场景使用网络隔离容器内的回环服务和合成输入。

全量构建使用 `docker buildx bake -f deploy/delegra-expert-images/buildx-bake.hcl --load --sbom=true --provenance=mode=min default reference`，耗时 6 分 34.50 秒，加载后逐项核对 Buildx 的 `--metadata-file`。经 `docker image save` 核对 20 个镜像的 SPDX SBOM、SLSA provenance 和父镜像压缩层，耗时 60.29 秒。两类声明均绑定实际 ARM64 manifest。统一冒烟入口运行全部 20 个镜像，耗时 1 分 38.10 秒。表中体积由各 Linux ARM64 manifest 按层 SHA-256 去重计算，Kubernetes 和 IaC 按运维诊断父层计算增量。

| 目标 | 场景判据 | image index digest | 压缩 MiB | 父层增量 MiB | 冒烟秒数 |
| --- | --- | --- | ---: | ---: | ---: |
| `codex-min` | 公共工具及 Codex 0.160.0 stdio | `sha256:74bae7c0d1725e9fee826f34de19413a4f02c5c5e66855cafcf3d77457729bf6` | 277.00 | — | 4.85 |
| `codex-java-8` | Temurin 1.8.0_504，Java 8 编译与执行 | `sha256:0bfc8e415a4302450d0c454305bb92a6eef885eeec9e22e4587741dea4113c47` | 337.67 | 60.67 | 4.25 |
| `codex-java-11` | Temurin 11.0.32.1，指定 release 编译与执行 | `sha256:7c32a24ab708bc9bf0465832a6b9be6ca82428b84697d8abde839e030fa4d74c` | 421.90 | 144.90 | 6.51 |
| `codex-java-17` | Temurin 17.0.20.1，指定 release 编译与执行 | `sha256:ded0f77228805855d6a5a009185c7b63361b5d40d253ee99b8b3bbb1947a0e52` | 423.87 | 146.87 | 6.04 |
| `codex-java-21` | Temurin 21.0.12.1，指定 release 编译与执行 | `sha256:4dfb25352801779d64abcd31ca912d01f8094eb7fc8d17e033eca7a6dfbe30fe` | 435.08 | 158.08 | 8.51 |
| `codex-java-25` | Temurin 25.0.4.1，指定 release 编译与执行 | `sha256:b465c557e358087172d69f834400891158af270dbc970f0cfe45180acbfeff31` | 373.22 | 96.22 | 7.20 |
| `codex-python` | Python 3.13.5、uv 0.11.25，虚拟环境和 CSV 单测 | `sha256:839d0a79f4e42f3e991b67be4b3c6ccb24c2bb826b1e1b08e1183baf47be59cd` | 313.66 | 36.66 | 7.87 |
| `codex-node` | Node 24.21.0、pnpm 11.28.5、TypeScript 6.0.3，编译与执行 | `sha256:bc162ebde91320db9bf4e2f9e849ab6fcad37c11873519e51aafcb80b1cff079` | 286.83 | 9.82 | 6.47 |
| `codex-go` | Go 1.27.4，断网运行 go test | `sha256:67be3503c33ca0b9834cd684c557d47ed68cd32b5330203751c7bc8bef8bdaaa` | 341.65 | 64.64 | 9.17 |
| `codex-sql` | PostgreSQL 客户端 17.12、MariaDB 11.8.6、SQLite 3.46.1，查询结果核对 | `sha256:40fca71981450f239560cc3175244c7ee96c550b9b8bbc23c9a0f898658ce9ea` | 297.49 | 20.49 | 3.63 |
| `codex-dotnet-10` | .NET SDK 10.0.404，无外部源 restore、编译与执行 | `sha256:6dda3d6f6324498a38defcafaeebe7a822e7a2c92ee6c320e413893cc8a4bfcc` | 516.18 | 239.18 | 5.67 |
| `codex-test-api` | Newman 6.2.3，200、404 及 JSON 共 4 项断言和 JUnit 报告 | `sha256:9711be24c69f42d63d2cec13290e873072d489cb9496d1096fd1ec68ab0c5d79` | 288.39 | 11.38 | 3.40 |
| `codex-test-web` | Playwright 1.65.1、Chromium 159.0.8154.6，表单、导航和 PNG | `sha256:2b200a3704c37055263a87ed6d9a080d1aa17312f61557194186e17c3ab0d716` | 687.19 | 410.18 | 3.99 |
| `codex-test-load` | k6 2.4.0，单虚拟用户对回环接口测试 | `sha256:65a3f05944650397c4e8e44de0acbb89a36a8a610387d4a1a985f82669e21185` | 304.94 | 27.94 | 4.21 |
| `codex-ops-diag` | curl 8.14.1、jq 1.7、BIND 9.20.30，回环 HTTP、证书和进程 | `sha256:7d4fccf5f5129d33146b4628abfdb31373438ed211abec873bcef996741bc5cc` | 283.49 | 6.49 | 2.02 |
| `codex-ops-k8s` | kubectl 1.37.2、Helm 4.3.2，离线渲染两类清单 | `sha256:b4e39f9c4eed31ea797e46d033afe09f083764af77126a9fbe5169c71547c6f2` | 317.00 | 33.51 | 2.01 |
| `codex-ops-iac` | OpenTofu 1.13.9，无外部 provider 初始化及校验 | `sha256:bb027f08e6b63a69fa470a3284deb7c96b049941d606c716dbb853d4eacc7fe9` | 313.55 | 30.06 | 2.19 |
| `codex-office-zh` | LibreOffice 25.2.3.2、Pandoc 3.1.11.1，三种格式导出与中文文本核对 | `sha256:6a8804f0e34f30bca940674f6d8e146abacfdc0fd50c74e43c61a56e51d6654e` | 566.04 | 289.04 | 5.21 |

`codex-min-native` 的 image index digest 为 `sha256:e5e7d538d0a5d7af1a0018c8f95740b3128256f1f1af4a4f07e38783e893c82c`，冒烟耗时 2.26 秒。`codex-java-21-native` 的 image index digest 为 `sha256:272a5855a65f26028b333375e1f80140d69ffb74b3f2133f75e3bc35524bb103`，冒烟耗时 2.57 秒。

首次 .NET 构建因制品拉取中断失败，单目标重试使用相同的 MCR ARM64 digest，耗时 12 分 34 秒。中文办公构建耗时 8 分 02 秒。个别下载先使用相同 SHA-256 的暂存制品，最终全量构建使用默认锁定输入。

浏览器在 Docker 默认 seccomp 配置下拒绝启动沙箱。使用 Playwright 1.65.1 的官方 seccomp 配置并启用 `chromiumSandbox: true` 后，通过表单、导航、截图和容器清理。配置 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，截图 SHA-256 为 `593d6fbb8fdb8f468c22832a1ac3ff5d4ed67ca6f21538715ad2fec475c69144`。 [Playwright Docker 说明](https://playwright.dev/docs/docker)

办公镜像命中 `Noto Sans CJK SC`。DOCX、XLSX 和 PPTX 各导出一页 PDF，三个输出均可提取 `河洛样例` 与表格数据。

`pnpm check` 耗时 61.54 秒，4560 项通过、3 项跳过、0 失败。版本检查的回归用例同时核对 npm 锁文件误报消除和部署配置里的 DSH 版本硬编码仍被拦截。

## 待联调

真实 Delegra Runner 的按摘要拉取、选择、取消、进程回收及回退在 #394 验收。制品库上传、远端扫描、实际集群版本与企业网关访问按目标环境验收。 [镜像实施计划](../delegra-runtime-images.md#8-实施计划)
