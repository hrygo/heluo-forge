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

四个目标用 `docker buildx bake --load` 构建，以 gzip level 6 导出 OCI，耗时 34.05 秒，并由 `expert-runtime-oci-size.mjs` 读取 `linux/arm64` manifest。压缩层以 SHA-256 去重，派生增量按同次导出的父层计算。

| Bake 目标 | ARM64 manifest digest | 压缩层字节 | 父层增加字节 |
| --- | --- | ---: | ---: |
| `codex-min` | `sha256:59e0eb0df5e719fe36d1767f7384e144e95f9bd68c050580bc201244db43db38` | 304335542 | — |
| `codex-java-21` | `sha256:20feb5fd0757558729887dc1bc6c798fe38f92d1da69f29d11253233c71b4e0d` | 470096249 | 165760707 |
| `codex-min-native` | `sha256:b6d157e85a5be62653887f1f0b51f3f4e297a65678214d7426974b966c349adb` | 297633294 | — |
| `codex-java-21-native` | `sha256:55b548788ed2b00f7ca270208b1317d024b5cd6dc814413b9df127d21edae274` | 463393928 | 165760634 |

公共层通过固定 Debian 快照安装 Python `3.13.5`，`python3.13` 包版本为 `3.13.5-2+deb13u5`，`python3-venv` 包版本为 `3.13.5-1`。计入 Python 与 venv 后，npm 版公共层的压缩体积增加 13.24 MiB。当前原生归档版公共层比 npm 版少 6,702,248 字节。JDK 21 为 Temurin `21.0.12.1`。Python 场景从公共层派生并增加 uv，压缩层增量为 23.40 MiB。公共层选型按目标 Runner 实际启动验收。 [issue #394](https://github.com/hrygo/heluo-forge/issues/394)

公共冒烟覆盖 OCI 和 ELF 架构、默认 UID/GID、UTF-8 文件、Git、Shell、只读工具目录、`codex exec --help`、`app-server` 初始化、EOF 和 `tini` 退出码。Python 验证覆盖两个命令解析同一 AArch64 解释器、普通用户断网创建 venv、加载标准库及运行环境内的 pip。缺少 Python 的旧公共镜像触发 `missing required tool: python`，新矩阵全部通过。缺工具、stdio 超时及容器清理反例通过，耗时 2.38 秒。Bake 的 AMD64 反例在平台断言处失败，替换 Runner SHA-256 的反例在制品校验处失败。

## 场景目录

Bake `--print` 核对了 14 份 Dockerfile、18 个发布目标以及独立的两个对照目标的 ARM64 平台和父镜像。各目标使用同一公共冒烟入口，场景使用网络隔离容器内的回环服务和合成输入。

全量构建使用 `docker buildx bake -f deploy/delegra-expert-images/buildx-bake.hcl --load --sbom=true --provenance=mode=min default reference`，耗时 4 分 30.00 秒，加载后逐项核对 Buildx 的 `--metadata-file`。经 `docker image save` 核对 20 个镜像的 SPDX SBOM、SLSA provenance 和父镜像压缩层，耗时 24.45 秒。两类声明均绑定实际 ARM64 manifest。统一冒烟入口运行全部 20 个镜像，耗时 1 分 9.75 秒。表中体积由各 Linux ARM64 manifest 按层 SHA-256 去重计算，Kubernetes 和 IaC 按运维诊断父层计算增量。

| 目标 | 场景判据 | image index digest | 压缩 MiB | 父层增量 MiB | 冒烟秒数 |
| --- | --- | --- | ---: | ---: | ---: |
| `codex-min` | 公共工具、Python 3.13.5 及 Codex 0.160.0 stdio | `sha256:581de3c96c303736e95803db9044be1252c847201cdb00b397f49916ed1d0a59` | 290.24 | — | 1.86 |
| `codex-java-8` | Temurin 1.8.0_504，Java 8 编译与执行 | `sha256:2ab84af16b4b9e650d9ddeea403494b482594c952a66b4128a25472ffe0267a8` | 350.90 | 60.67 | 2.37 |
| `codex-java-11` | Temurin 11.0.32.1，指定 release 编译与执行 | `sha256:81058cfe82d81fee1a0c2763295ddbf41f7500de2df1cb1e83c6240793b04820` | 435.13 | 144.90 | 2.91 |
| `codex-java-17` | Temurin 17.0.20.1，指定 release 编译与执行 | `sha256:f87a95b276eef81e4a1bad1029658c661115badb28da0600f23ba91b4f370592` | 437.11 | 146.87 | 2.97 |
| `codex-java-21` | Temurin 21.0.12.1，指定 release 编译与执行 | `sha256:6e0c7e9ca24b5dd71034f8d9922cb82f39320d2c3e0b80917ec0f3f576163d14` | 448.32 | 158.08 | 8.16 |
| `codex-java-25` | Temurin 25.0.4.1，指定 release 编译与执行 | `sha256:d93c14afcf77d36a573bac293a4c310f2ffa98949b31383f1ab9c239d377ce72` | 386.45 | 96.22 | 2.42 |
| `codex-python` | uv 0.11.25 使用公共 Python 创建虚拟环境并执行 CSV 单测 | `sha256:8b79d5015441f68110bd18208b96db4f60e36c1f09da9c722521f8ce27d8cf3d` | 313.64 | 23.40 | 3.48 |
| `codex-node` | Node 24.21.0、pnpm 11.28.5、TypeScript 6.0.3，编译与执行 | `sha256:618f5e80973202526455c2fd14b766754e916e18b5dc520c7f47d821d2d36eba` | 300.06 | 9.82 | 2.94 |
| `codex-go` | Go 1.27.4，断网运行 go test | `sha256:96a01805a5b361e8f6e9b448ce1d569a0483d0843e396eeae9021531f1abd732` | 354.88 | 64.64 | 5.54 |
| `codex-sql` | PostgreSQL 客户端 17.12、MariaDB 11.8.6、SQLite 3.46.1，查询结果核对 | `sha256:b31c51737bcbea7fd47a63a122ed681303df73a87ae51f34f2dd79ab9b7ea34e` | 310.74 | 20.50 | 3.22 |
| `codex-dotnet-10` | .NET SDK 10.0.404，无外部源 restore、编译与执行 | `sha256:a67b3f13beaf258166bcc18193969d9379aa9d40b7683b3bf8b2c6a476831c97` | 529.42 | 239.18 | 5.12 |
| `codex-test-api` | Newman 6.2.3，200、404 及 JSON 共 4 项断言和 JUnit 报告 | `sha256:e51a08b748df4b41aae6cc6e7f9779e566e85572d97ca85a99e1a44d75806516` | 301.62 | 11.38 | 3.87 |
| `codex-test-web` | Playwright 1.65.1、Chromium 159.0.8154.6，表单、导航和 PNG | `sha256:e1767edc027dad71aad03783453f025b38fc6bd2837910a9e6127f6f59c4f597` | 700.43 | 410.19 | 3.15 |
| `codex-test-load` | k6 2.4.0，单虚拟用户对回环接口测试 | `sha256:f9ea6142d1296f1f12e4be9bfac24c2275006b094dee7065d08b6d72e237d1b8` | 318.17 | 27.94 | 4.55 |
| `codex-ops-diag` | curl 8.14.1、jq 1.7、BIND 9.20.30，回环 HTTP、证书和进程 | `sha256:8a86ca85b79417274d309de246f97f20df4ca71a39678f265ec00a90152e3082` | 296.74 | 6.50 | 2.35 |
| `codex-ops-k8s` | kubectl 1.37.2、Helm 4.3.2，离线渲染两类清单 | `sha256:35b68726fd3f61b0ef131f79906f0771a40b84151fef1fc3a8acb2824f0f453b` | 330.24 | 33.51 | 3.37 |
| `codex-ops-iac` | OpenTofu 1.13.9，无外部 provider 初始化及校验 | `sha256:594f72b613eab46684a5cb769cf6b19a41df013a8be0501fb1463f6525a4ee1f` | 326.80 | 30.06 | 3.61 |
| `codex-office-zh` | LibreOffice 25.2.3.2、Pandoc 3.1.11.1，三种格式导出与中文文本核对 | `sha256:4bcf88ca7e80d5fa1994624a49204c325f578550dbe8077e804a89dd3fad388c` | 579.28 | 289.04 | 3.49 |

`codex-min-native` 的 image index digest 为 `sha256:c0b8f7f792eadc07ceab51193e3d3cf82a47f5387caa60b6efc9432d14d07e69`，冒烟耗时 1.85 秒。`codex-java-21-native` 的 image index digest 为 `sha256:7f41f4ad9c2d0902a2fe83846b0a061c039f72e7470eeb695c62c31835626f8d`，冒烟耗时 2.48 秒。

早期参考矩阵的 .NET 构建遇到下载中断，单目标重试使用相同的 MCR ARM64 digest，耗时 12 分 34 秒。中文办公构建耗时 8 分 02 秒。个别下载先使用相同 SHA-256 的暂存制品，最终全量构建使用默认锁定输入。

浏览器在 Docker 默认 seccomp 配置下拒绝启动沙箱。使用 Playwright 1.65.1 的官方 seccomp 配置并启用 `chromiumSandbox: true` 后，通过表单、导航、截图和容器清理。配置 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，截图 SHA-256 为 `593d6fbb8fdb8f468c22832a1ac3ff5d4ed67ca6f21538715ad2fec475c69144`。 [Playwright Docker 说明](https://playwright.dev/docs/docker)

办公镜像命中 `Noto Sans CJK SC`。DOCX、XLSX 和 PPTX 各导出一页 PDF，三个输出均可提取 `河洛样例` 与表格数据。

`pnpm check` 耗时 52.16 秒，4568 项通过、3 项跳过、0 失败。版本检查的回归用例同时核对 npm 锁文件误报消除和部署配置里的 DSH 版本硬编码仍被拦截。

## 待联调

真实 Delegra Runner 的按摘要拉取、选择、取消、进程回收及回退在 #394 验收。制品库上传、远端扫描、实际集群版本与企业网关访问按目标环境验收。 [镜像实施计划](../delegra-runtime-images.md#8-实施计划)
