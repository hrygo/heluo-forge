# Delegra 专家运行时镜像实测记录

核验日期为 2026-11-20。构建和运行使用 Docker Engine 29.9.3、Buildx 0.38.1、BuildKit 0.34.2 的原生 Linux ARM64 节点。公共镜像的 glibc 为 `2.41`。仓库检查使用 Node `24.21.0` 和 pnpm `11.28.5`。 [Delegra 配方与本机构建入口](https://github.com/hrygo/Delegra/tree/deploy/docker/expert-runtime)

## 固定构建输入

- Runner 使用 Delegra `deploy/v2026.1106.0-r2` 的 `25c86a283a9c787a01911c714618d78df7552af7`。对官方源码归档中参与构建的 182 个文件与 Git 对象逐一核验，`Cargo.lock` 的 SHA-256 为 `1dea479bbc7c522d0d1e299991aa43ec08a575668a87973eda3584bd295bc34d`。
- 基础、Rust、Java、uv 和其他场景工具链摘要在 Delegra 的 Bake 文件固定。npm 包及 ARM64 Codex `0.160.0` 的完整依赖由各自锁文件固定。 [Delegra Bake](https://github.com/hrygo/Delegra/blob/deploy/docker/expert-runtime/buildx-bake.hcl)
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
| `codex-min` | `sha256:6d8ec5741fdd921bb89b6d7dcfa167b8d479a44f549f96d5011de9bc011ba8a0` | 327775796 | — |
| `codex-java-21` | `sha256:8e5deb66c1479f5c60b3d6c3978199e46fa0fcef623b82ac4ea34b7f71427c33` | 493536392 | 165760596 |
| `codex-min-native` | `sha256:aa030d1d1e048b56820c698168a679b08f5a213d0aae1025b58996440c3c9be0` | 320958999 | — |
| `codex-java-21-native` | `sha256:b7478907ac0d507b4045175239f6d5b5b9e88473619a2744dbaa70990ec6022e` | 486719632 | 165760633 |

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

缺工具的旧公共镜像分别触发 `missing required tool: uv`、`missing required tool: curl`、`missing required tool: file`、`missing required tool: bzip2` 和 `missing required tool: column`。BuildKit 自动创建的许可证目录曾继承文件模式 `0644`，普通用户无法读取其中的文件。构建配方将目录设为 `0755`，普通用户通过构建和冒烟检查。缺工具、stdio 超时及容器清理反例通过，耗时 2.30 秒。Bake 的 AMD64 反例在平台断言处失败，替换 Runner SHA-256 的反例在制品校验处失败。

## 场景目录

Bake `--print` 核对了 13 份 Dockerfile、17 个发布目标以及独立的两个对照目标的 ARM64 平台和父镜像。各目标使用同一公共冒烟入口，场景使用网络隔离容器内的回环服务和合成输入。

从 Delegra 仓库根目录运行 `docker buildx bake -f docker/expert-runtime/buildx-bake.hcl --load --sbom=true --provenance=mode=min,version=v1 default reference`。初次验收复用本机构建缓存，构建耗时 12.12 秒。经 `docker image save` 核对 19 个镜像的 SPDX SBOM、SLSA provenance 和父镜像压缩层，耗时 24.74 秒。两类声明均绑定各自的 ARM64 manifest。Delegra 的统一入口完成 19 个离线冒烟，耗时 57.99 秒。表中摘要来自该次本地 Buildx 导出，压缩体积按 ARM64 manifest 去重，Kubernetes 和 IaC 按运维诊断父层计算增量。

| 目标 | 场景判据 | image index digest | 压缩 MiB | 父层增量 MiB | 冒烟秒数 |
| --- | --- | --- | ---: | ---: | ---: |
| `codex-min` | 公共工具、Python 3.13.5、uv 0.13.9、回环 HTTP 与 JSON、Codex 0.160.0 stdio | `sha256:a2f804ee66b1df4ebeb920b62a6d0cf07e72e16daacbb49d84d3d3f44fc1d3b4` | 312.59 | — | 1.92 |
| `codex-java-8` | Temurin 1.8.0_504，Java 8 编译与执行 | `sha256:2049e7e517db1c32c0210d2b4b810d892379c3d2cce732c3eb9e8192f1b4d79a` | 373.26 | 60.67 | 2.39 |
| `codex-java-11` | Temurin 11.0.32.1，指定 release 编译与执行 | `sha256:9d88c3191fe7151f20ba53b7127a0af14e6443461100260611efc4ed48068c43` | 457.49 | 144.90 | 2.98 |
| `codex-java-17` | Temurin 17.0.20.1，指定 release 编译与执行 | `sha256:ec550460d217b256827130c00b2f16c155efe10bfd0fa4a0e90510c7098a463f` | 459.47 | 146.87 | 3.08 |
| `codex-java-21` | Temurin 21.0.12.1，指定 release 编译与执行 | `sha256:bfd3f21e011a39cdd3680becfed649d09b27f2e38092c4b340ce4bafaf36255e` | 470.67 | 158.08 | 3.48 |
| `codex-java-25` | Temurin 25.0.4.1，指定 release 编译与执行 | `sha256:a156479ddf0759e686ae3713491a9f9a204e866b085c0c48d09d74bebee15fd1` | 408.81 | 96.22 | 2.85 |
| `codex-node` | Node 24.21.0、pnpm 11.28.5、TypeScript 6.0.3，编译与执行 | `sha256:65f82b2333cd30862d8306eea918fda35c74cbf17eb86be01eb75e9f1d48e744` | 322.42 | 9.82 | 2.91 |
| `codex-go` | Go 1.27.4，断网运行 go test | `sha256:b48e2ecd1cb86bbf28d475e78e72bbf1e98b8fb56dfa84d5252b22378af834b2` | 377.24 | 64.64 | 4.97 |
| `codex-sql` | PostgreSQL 客户端 17.12、MariaDB 客户端 11.8.6 | `sha256:887b0215d1ba0a3c6ea05e1df11e778746f90ef5404c413da76cffd18310374d` | 332.95 | 20.36 | 2.16 |
| `codex-dotnet-10` | .NET SDK 10.0.404，无外部源 restore、编译与执行 | `sha256:1d43bf6df74ed3a91eb59f1eee5bb41056672fd5b960361527b15dfb75ffc159` | 551.79 | 239.20 | 5.11 |
| `codex-test-api`（初次验收基线） | Newman 6.2.3，200、404 及 JSON 共 4 项断言和 JUnit 报告 | `sha256:bdb8a4691e71da38058bf8e200a05d7a7ca04fa18453f6b932d8925fd76746dc` | 323.98 | 11.38 | 2.52 |
| `codex-test-web` | Playwright 1.65.1、Chromium 159.0.8154.6，表单、导航和 PNG | `sha256:b6069afea435cd5dd80d3fe21ffcc413f1eed2301f41f1bc08010c7fe924c6a3` | 722.80 | 410.21 | 2.92 |
| `codex-test-load` | k6 2.4.0，单虚拟用户对回环接口测试 | `sha256:54b1de156983329eb97c286e4f725ae1e5757ef89697ac38106bdb843d700381` | 340.53 | 27.94 | 4.21 |
| `codex-ops-diag` | BIND 9.20.30、回环网卡、证书及进程 | `sha256:f4c6af1a1fb056c6880f30857501d6f8e901676511de5afafb00a115088fec19` | 317.73 | 5.14 | 2.22 |
| `codex-ops-k8s` | kubectl 1.37.2、Helm 4.3.2，离线渲染两类清单 | `sha256:2bbbc3d327baebfcb772f6305085d779d533dfd01dabd985bcc1732acd6e6d87` | 351.23 | 33.51 | 2.88 |
| `codex-ops-iac` | OpenTofu 1.13.9，无外部 provider 初始化及校验 | `sha256:6f620efb3523c6bb0af2a8af3ead7fa9e829dad1fc2ba8e9c4930e63e0c350e0` | 347.79 | 30.06 | 2.24 |
| `codex-office-zh` | LibreOffice 25.2.3.2、Pandoc 3.1.11.1，三种格式导出与中文文本核对 | `sha256:39ad74e9eda25ce012578f633abce11d086b2d0d191c6d43f14fc233a83813d7` | 601.19 | 288.60 | 3.65 |

`codex-min-native` 的 image index digest 为 `sha256:347369c8a80f0af28db01a9514f043086b23435099e09c32ca15933884b22422`，冒烟耗时 1.81 秒。`codex-java-21-native` 的 image index digest 为 `sha256:3cdefa128e6af5954b94dceef3487212c669788e66768fa8aedb4f461c1cd176`，冒烟耗时 3.66 秒。

`codex-test-api` 的交付配方使用 Hurl 8.1.0。官方 ARM64 包为 2,014,052 字节，SHA-256 为 `74dce80fd6d9d6a8f70ec4af963c811184d35232798e1fe263897ecc4cf061dc`。使用同一 Dockerfile 安装步骤和同一 Debian 签名快照，在临时 Debian ARM64 底层镜像上核对 `hurl`、`hurlfmt` 和许可证。以 UID 1000 在断网容器中运行仓库的 `.hurl` 用例，两项 HTTP 状态和两项 JSON 断言通过，JUnit 为 1 项测试、0 项失败。将 404 改为 500 的反例以退出码 4 失败。构建耗时 314.48 秒，容器内验证耗时 0.13 秒。实际 `codex-min` 父层的镜像摘要和依赖增量以完整 Bake 构建为准。 [Hurl 8.1.0 ARM64 包](https://github.com/Orange-OpenSource/hurl/releases/tag/8.1.0)

早期参考矩阵的 .NET 构建遇到下载中断，单目标重试使用相同的 MCR ARM64 digest，耗时 12 分 34 秒。中文办公构建耗时 8 分 02 秒。个别下载先使用相同 SHA-256 的暂存制品，最终全量构建使用默认锁定输入。

浏览器在 Docker 默认 seccomp 配置下拒绝启动沙箱。使用 Playwright 1.65.1 的官方 seccomp 配置并启用 `chromiumSandbox: true` 后，通过表单、导航、截图和容器清理。配置 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，截图 SHA-256 为 `593d6fbb8fdb8f468c22832a1ac3ff5d4ed67ca6f21538715ad2fec475c69144`。 [Playwright Docker 说明](https://playwright.dev/docs/docker)

办公镜像命中 `Noto Sans CJK SC`。DOCX、XLSX 和 PPTX 各导出一页 PDF，三个输出均可提取 `河洛样例` 与表格数据。

Delegra 的工作流规划和发布逻辑通过 8 个 Node 测试及 `actionlint` 检查。发布规划用 Delegra 的 fork 事件验证了 17 项发布矩阵，并在分支推送和非发布仓库事件下保留 19 项验证矩阵。未进入 `origin/deploy` 的提交被发布规划拒绝。分支策略检查识别了迁移补丁。Heluo Forge `pnpm check` 耗时 52.53 秒，4529 项通过，3 项跳过。

在临时 OCI 仓库用两个合成 ARM64 镜像复验发布路径，耗时 17.86 秒。与发布工作流同一摘要的 `docker-container` BuildKit 只按摘要上传候选。发布脚本校验 ARM64 manifest、SBOM 与来源证明，添加版本标签并重跑后，标签对应的 OCI 索引字节保持一致。预置冲突标签时，发布脚本拒绝该批次，同批其他镜像的版本标签仍不存在。本机 Docker Engine 直连虚拟机回环仓库的尝试返回连接拒绝。通过独立 BuildKit 实例执行 `docker buildx build --pull --platform linux/arm64`，从仓库按索引摘要加载合成镜像，随后在断网容器中执行并核对 `linux/arm64`。

## 按摘要选用发布镜像

在 Delegra 的镜像工作流中选择成功的专用版本发布运行。用其运行 ID 和 Git 标签中的版本下载回执，核对回执的签名仓库、工作流和源标签。下例使用 `codex-min`，执行前将 `run_id` 和 `version` 替换为选中的运行值。 [Delegra ARM64 镜像发布](https://github.com/hrygo/Delegra/actions/workflows/delegra-expert-images.yml)

```sh
set -eu
run_id=1234567890
version=v1.2.3
target=codex-min
receipt_dir=$(mktemp -d)
gh run download "$run_id" --repo hrygo/Delegra \
  --name "expert-images-release-$version" --dir "$receipt_dir"
receipt="$receipt_dir/expert-images-release.json"
gh attestation verify "$receipt" --repo hrygo/Delegra \
  --signer-workflow hrygo/Delegra/.github/workflows/delegra-expert-images.yml \
  --source-ref "refs/tags/expert-images-$version"
image_ref=$(jq -er --arg target "$target" --arg version "$version" '
  select(.version == $version and .platform == "linux/arm64")
  | [.images[] | select(.target == $target)] | select(length == 1) | .[0]
  | select(.name == ("ghcr.io/hrygo/delegra/" + $target)
      and (.digest | test("^sha256:[0-9a-f]{64}$")))
  | .name + "@" + .digest
' "$receipt")
docker pull --platform linux/arm64 "$image_ref"
printf '%s\n' "$image_ref"
```

将输出的 `name@digest` 用于目标运行环境登记和任务受理。回执中的 `digest` 是 OCI 索引，`platformDigest` 用于对照 Runner 实际使用的 ARM64 manifest。保存发布回执、签名包和目标环境实测证据，回退时使用上一份已验收的 `name@digest`。首次拉取需要目标环境具备对应 GHCR 包的读取权限。

摘要提取已使用从本地构建结果生成的 17 项回执验证。提取结果匹配 OCI 索引。缺少场景、目标重复、版本不匹配、平台错误、仓库错误或摘要格式错误时，命令退出失败。

## 待联调

真实 Delegra Runner 的按摘要拉取、选择、取消、进程回收及回退在 #394 验收。GHCR 上传、签名回执下载与校验、远端扫描、实际集群版本与企业网关访问按目标环境验收。 [镜像实施计划](../delegra-runtime-images.md#8-实施计划)
