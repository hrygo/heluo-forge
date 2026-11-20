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
| `codex-min` | `sha256:dc681084beb456c78c100b591c85fd65e7b09416e1ad14afd736800396e627c4` | 327775796 | — |
| `codex-java-21` | `sha256:272bd8ade45dc3b9b3e7f7352cf06263f26de401d4e95a2c790e82db9c93a7e5` | 493536392 | 165760596 |
| `codex-min-native` | `sha256:42c506f136ea15e1b5f68dadc8259ffc074abd46a55d057ff4cf0be059c41742` | 320958999 | — |
| `codex-java-21-native` | `sha256:245aa0221aabf5afb84dce95be75ef018a94ab5dda36f0a88e1c66e913096bb3` | 486719632 | 165760633 |

公共层通过固定 Debian 快照安装 Python `3.13.5`，`python3.13` 包版本为 `3.13.5-2+deb13u5`，`python3-venv` 包版本为 `3.13.5-1`。公共层装入 `uv` 和 `uvx` 后，npm 版压缩体积在仅含 Python 的同配置基线上增加 17.36 MiB。原生归档版比 npm 版少 6,816,797 字节。JDK 21 为 Temurin `21.0.12.1`。公共层选型按目标 Runner 实际启动验收。 [issue #394](https://github.com/hrygo/heluo-forge/issues/394)

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

公共工具选型以 Pi/P2 公开 macOS 样本的 295,401 条 Shell 调用为频率参考，计数取包含相应命令的调用数。`nc` 的调用证据来自 SWE-chat 表 5 的命令分类。候选体积以 Linux ARM64 npm 版公共镜像为基线，以同一签名快照单独安装各 Debian 包，在 `docker image save` 的 OCI manifest 中核对新增 gzip 层。测量包含新增依赖及安装状态。 [Pi 统计原表](https://raw.githubusercontent.com/earendil-works/psh/main/research/corpus/results.json) · [SWE-chat 表 5](https://openreview.net/pdf/e03684a2d55f5414e50309bd5d4d8826b5be8819.pdf)

| 公共命令 | Debian 快照包和版本 | 样本调用数 | 独装 OCI 增量 KiB |
| --- | --- | ---: | ---: |
| `tmux` | `tmux` `3.5a-3` | 1,789 | 932.3 |
| `sqlite3` | `sqlite3` `3.46.1-7+deb13u2` | 199 | 265.0 |
| `column` | `bsdextrautils` `2.41.5-0+deb13u1` | 76 | 228.0 |
| `nc` | `netcat-openbsd` `1.229-1` | SWE-chat 分类记录 | 124.3 |

同一探针测得 `gh` 增量 9.21 MiB，样本调用 8,128 次。`openssh-client` 增量 2.30 MiB。默认 Bash 提供 `time` 关键字，样本的 `time` 计数覆盖 Shell 计时语法。四项入选命令合装后，npm 版实际 OCI 压缩层净增 1,150,146 字节（1.10 MiB），合计 312.59 MiB。

公共冒烟覆盖 OCI 和 ELF 架构、默认 UID/GID、UTF-8 文件、Git、Shell、只读工具目录、`codex exec --help`、`app-server` 初始化、EOF 和 `tini` 退出码。Python 验证覆盖 AArch64 ELF、同一解释器、普通用户断网创建带 pip 的 venv、`uv venv` 和 CSV 单元测试。各镜像以普通用户核对 `uv`、`uvx` 版本及许可证可读性，先用 `nc` 验证回环 TCP 连接，再用 `curl` 请求模拟接口、用 `jq` 断言合成 JSON。通用工程工具的冒烟覆盖 ZIP 和 UTF-8 文件名、MIME 类型、Make 目标及补丁应用后的内容。以同一 UID 验证目录树、ZIP 二进制签名、当前进程打开的文件、本地目录同步及重复同步无变更，并对 `.tar.bz2`、`.tar.xz` 和 `.tar.zst` 作压缩解压往返。无 TTY 时用 `tmux` 建立并清理终端会话，用 `column` 对齐制表符分隔的数据，并用 `sqlite3` 对合成数据库执行查询。在原生归档版公共镜像中，`uv sync --locked --offline` 使用 Python `3.13.5` 创建虚拟环境，锁文件哈希一致。

缺工具的旧公共镜像分别触发 `missing required tool: uv`、`missing required tool: curl`、`missing required tool: file`、`missing required tool: bzip2` 和 `missing required tool: column`。BuildKit 自动创建的许可证目录曾继承文件模式 `0644`，普通用户无法读取其中的文件。构建配方将目录设为 `0755`，普通用户通过构建和冒烟检查。缺工具、stdio 超时及容器清理反例通过，耗时 2.33 秒。Bake 的 AMD64 反例在平台断言处失败，替换 Runner SHA-256 的反例在制品校验处失败。

## 场景目录

Bake `--print` 核对了 13 份 Dockerfile、17 个发布目标以及独立的两个对照目标的 ARM64 平台和父镜像。各目标使用同一公共冒烟入口，场景使用网络隔离容器内的回环服务和合成输入。

全量构建使用 `docker buildx bake -f deploy/delegra-expert-images/buildx-bake.hcl --load --sbom=true --provenance=mode=min,version=v1 default reference`，耗时 5 分 28.80 秒，加载后逐项核对 Buildx 的 `--metadata-file`。经 `docker image save` 核对 19 个镜像的 SPDX SBOM、SLSA provenance 和父镜像压缩层，耗时 20.37 秒。两类声明均绑定实际 ARM64 manifest。统一冒烟入口分批运行全部 19 个镜像，合计耗时 1 分 9.31 秒。表中体积由各 Linux ARM64 manifest 按层 SHA-256 去重计算，Kubernetes 和 IaC 按运维诊断父层计算增量。

| 目标 | 场景判据 | image index digest | 压缩 MiB | 父层增量 MiB | 冒烟秒数 |
| --- | --- | --- | ---: | ---: | ---: |
| `codex-min` | 公共工具、Python 3.13.5、uv 0.13.9、回环 HTTP 与 JSON、Codex 0.160.0 stdio | `sha256:a807035c4558eab2559825c57f3d39857d99a92bbd941c70624bddc151b8456c` | 312.59 | — | 1.98 |
| `codex-java-8` | Temurin 1.8.0_504，Java 8 编译与执行 | `sha256:7677dd1341a12729af1705f64648ff4249d92628352f9c39b4ba289751be22ac` | 373.26 | 60.67 | 2.54 |
| `codex-java-11` | Temurin 11.0.32.1，指定 release 编译与执行 | `sha256:2b6b4717429695f6a9a1ab57291a88dffde19cd802deb2d02081071b4db31035` | 457.49 | 144.90 | 2.93 |
| `codex-java-17` | Temurin 17.0.20.1，指定 release 编译与执行 | `sha256:cccab604bf53b9032164ea591cfd0658f93af7a92dc5dd0fc4487eef5e96fa30` | 459.47 | 146.87 | 2.68 |
| `codex-java-21` | Temurin 21.0.12.1，指定 release 编译与执行 | `sha256:70444dcc8c095509ad9be8215241f9d9a5b7ae442a178f04ef64282c8d5fc2c2` | 470.67 | 158.08 | 2.74 |
| `codex-java-25` | Temurin 25.0.4.1，指定 release 编译与执行 | `sha256:448ef88779f7be639c02e30120003f1965979370f80a63b9f29cd19d2931dd01` | 408.81 | 96.22 | 2.67 |
| `codex-node` | Node 24.21.0、pnpm 11.28.5、TypeScript 6.0.3，编译与执行 | `sha256:50adc4c5a5a7d41913ed61190fa60bb296139bfac8a8bd92acabb00f5f01dc31` | 322.42 | 9.82 | 3.19 |
| `codex-go` | Go 1.27.4，断网运行 go test | `sha256:2fe3705d332ef132bdcc3d59cf23515986ee7e62e0079835dbba9d94a4d1d56a` | 377.24 | 64.64 | 13.00 |
| `codex-sql` | PostgreSQL 客户端 17.12、MariaDB 客户端 11.8.6 | `sha256:23f515ebc3dbd7e315c52244c6fdc425ecf75f9127dc6b09ab65f8ef611e7b4e` | 332.95 | 20.36 | 2.41 |
| `codex-dotnet-10` | .NET SDK 10.0.404，无外部源 restore、编译与执行 | `sha256:30de7960eb2b2445f6aace58be15ebb258533885fac15d32432c21899c7dffa7` | 551.79 | 239.20 | 3.68 |
| `codex-test-api` | Newman 6.2.3，200、404 及 JSON 共 4 项断言和 JUnit 报告 | `sha256:0f57c9413cf4ae98482074614468378ccc948854047d610ba9aa2ce7499f5e7d` | 323.98 | 11.38 | 2.73 |
| `codex-test-web` | Playwright 1.65.1、Chromium 159.0.8154.6，表单、导航和 PNG | `sha256:c0f0b3e199a1e4855635da8605e1e7cd0379e594583c234a27a7fe6ebecd27a5` | 722.80 | 410.21 | 2.92 |
| `codex-test-load` | k6 2.4.0，单虚拟用户对回环接口测试 | `sha256:0267c3ebd77a2800ffc866596d605a6c1b7514e4574e0903aad465e09cd2773f` | 340.53 | 27.94 | 4.83 |
| `codex-ops-diag` | BIND 9.20.30、回环网卡、证书及进程 | `sha256:bd66d18d0bf0a661e52caa66e8496be8d48ea97bdbf4ac058e33074faca84d91` | 317.73 | 5.14 | 3.31 |
| `codex-ops-k8s` | kubectl 1.37.2、Helm 4.3.2，离线渲染两类清单 | `sha256:85a1e52de228bb7e8d0519f4cc781f4062b7fed4849294eaa4ae79ad106ad41c` | 351.23 | 33.51 | 2.86 |
| `codex-ops-iac` | OpenTofu 1.13.9，无外部 provider 初始化及校验 | `sha256:d89beda93afebe3c0fa5b1cef2f1211b0bb8da83358905007f92249ba41ea46d` | 347.79 | 30.06 | 2.87 |
| `codex-office-zh` | LibreOffice 25.2.3.2、Pandoc 3.1.11.1，三种格式导出与中文文本核对 | `sha256:806f9733cec9dc41eb9af3425b82297d8e8f515e1b750d74c6e3e7a9500e72b3` | 601.19 | 288.60 | 6.19 |

`codex-min-native` 的 image index digest 为 `sha256:1bae3c015b36b6ab505dc4b5df8a056065ef31eb3a60e75296b909b05acddcd9`，冒烟耗时 2.09 秒。`codex-java-21-native` 的 image index digest 为 `sha256:413986de13d525bd9b99096af846f12e1468462e87dfa7d30ec818266a7f770b`，冒烟耗时 3.42 秒。

早期参考矩阵的 .NET 构建遇到下载中断，单目标重试使用相同的 MCR ARM64 digest，耗时 12 分 34 秒。中文办公构建耗时 8 分 02 秒。个别下载先使用相同 SHA-256 的暂存制品，最终全量构建使用默认锁定输入。

浏览器在 Docker 默认 seccomp 配置下拒绝启动沙箱。使用 Playwright 1.65.1 的官方 seccomp 配置并启用 `chromiumSandbox: true` 后，通过表单、导航、截图和容器清理。配置 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，截图 SHA-256 为 `593d6fbb8fdb8f468c22832a1ac3ff5d4ed67ca6f21538715ad2fec475c69144`。 [Playwright Docker 说明](https://playwright.dev/docs/docker)

办公镜像命中 `Noto Sans CJK SC`。DOCX、XLSX 和 PPTX 各导出一页 PDF，三个输出均可提取 `河洛样例` 与表格数据。

`pnpm check` 耗时 52.11 秒，4538 项通过、3 项跳过、0 失败。版本检查的回归用例同时核对 npm 锁文件误报消除和部署配置里的 DSH 版本硬编码仍被拦截。

## 待联调

真实 Delegra Runner 的按摘要拉取、选择、取消、进程回收及回退在 #394 验收。制品库上传、远端扫描、实际集群版本与企业网关访问按目标环境验收。 [镜像实施计划](../delegra-runtime-images.md#8-实施计划)
