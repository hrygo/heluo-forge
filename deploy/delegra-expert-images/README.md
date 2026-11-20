# Delegra 专家运行时镜像

此目录提供 14 份 Dockerfile 和 18 个 Linux ARM64 发布目标。所有镜像共用固定版本的 Codex、`paperclip-runnerd`、Node、Python `3.13.5` 与工作区工具。`python` 和 `python3` 调用同一解释器，`python -m venv .venv` 可创建带 pip 的任务级虚拟环境。`codex-python` 额外提供固定版 `uv`。容器以 `1000:1000` 运行，默认工作区为 `/workspace`。[`capabilities.json`](capabilities.json) 记录各目标提供的命令。

Runner 来源为 Delegra 标签 `deploy/v2026.1106.0-r2` 对应的固定提交。Bake 核对官方源码归档的 SHA-256，Rust 使用该提交的 `Cargo.lock` 构建。Java、uv 和 .NET 工具链使用 ARM64 镜像摘要，npm 工具使用各自的锁文件。Debian 包使用固定日期的快照和 Debian archive keyring 验签。首次取得 CA 证书时，APT 同样按签名索引和包哈希校验下载内容。[运行时镜像设计](../../docs/design/delegra-runtime-images.md) · [本机实测记录](../../docs/design/verification/delegra-runtime-images.md)

## 本机验证

从仓库根目录在原生 ARM64 Docker 节点执行。默认组包含 18 个发布目标，`reference` 组包含公共及 Java 21 的 npm 与原生归档对照。标签中的 `arm64-local` 和 `arm64-native-local` 用于本地测试。

```sh
bake_file=deploy/delegra-expert-images/buildx-bake.hcl
docker buildx bake -f "$bake_file" --print default reference
docker buildx bake -f "$bake_file" --load reference
node tests/runner-e2e/expert-runtime-images-smoke.mjs \
  paperclip-expert/codex-min:arm64-local \
  paperclip-expert/codex-java-21:arm64-local \
  paperclip-expert/codex-min:arm64-native-local \
  paperclip-expert/codex-java-21:arm64-native-local
node tests/runner-e2e/expert-runtime-images-smoke.mjs --negative \
  paperclip-expert/codex-min:arm64-local
```

使用 `docker buildx bake -f "$bake_file" --load default` 构建全量。把 `default` 换成目标名即可独立构建，再把该镜像标签传给同一冒烟入口。浏览器样例以普通用户运行并启用 Chromium 沙箱。Docker 环境若要求单独配置用户命名空间权限，可通过 `EXPERT_BROWSER_SECCOMP` 指向受信的 Playwright seccomp 配置文件。目标集群接入前按其 API Server 版本核对镜像内的 kubectl 版本差。[Playwright 容器与 seccomp](https://playwright.dev/docs/docker) · [Kubernetes 版本偏差规则](https://kubernetes.io/releases/version-skew-policy/)

## OCI 测量

每个目标使用相同的 gzip 压缩设置。OCI 文件的构建输出目录由调用方指定。

```sh
oci_dir=$(mktemp -d)
oci_dir=$(cd "$oci_dir" && pwd -P)
for target in codex-min codex-java-21; do
  docker buildx bake -f "$bake_file" --allow "fs.write=$oci_dir" \
    --set "$target.output=type=oci,dest=$oci_dir/$target.oci.tar,compression=gzip,compression-level=6,force-compression=true" \
    "$target"
done
node tests/runner-e2e/expert-runtime-oci-size.mjs \
  "$oci_dir/codex-java-21.oci.tar" "$oci_dir/codex-min.oci.tar"
```

测量输出包含 ARM64 manifest digest、压缩层总字节数和去重后的父层增量。


## GitHub Actions

| 触发 | 执行 |
| --- | --- |
| 面向 `main` 的 PR 或 `main` 推送，镜像配方、锁文件、冒烟夹具、工作流或 Node 版本有改动 | 在原生 ARM64 节点验证 18 个发布目标和 2 个对照目标。每批最多 3 个镜像，同时运行最多 3 批。旧验证任务随新提交取消。 |
| 在 Actions 手动选择分支 | 执行同一套只读验证。 |
| 推送或手动选择专用标签 `expert-images-v1.2.3` | 检查标签指向 `origin/main` 历史中的提交，构建并发布 18 个场景镜像。同版任务串行。 |

缓存按目标隔离，默认分支验证负责更新缓存。PR 与发布作业读取缓存，发布作业重新验证制品。相关文件的路径过滤只用于验证任务，镜像工作流适合作为可选 PR 检查。[工作流](../../.github/workflows/delegra-expert-images.yml)

发布以 `GITHUB_TOKEN` 写入 `ghcr.io/hrygo/heluo-forge/<目标>`。工作流先按 OCI 摘要上传候选，核对 ARM64 manifest、SPDX SBOM 和 SLSA 来源证明，并拉回同一摘要运行冒烟。收到全部场景回执后，生成并签署记录 Python 版本和镜像摘要的 `expert-images-release.json`，再将每个已验证的索引加上 `v1.2.3` 这样的精确版本标签。已有标签指向相同摘要时复用，指向其他摘要时发布失败。GitHub Container Registry 首次创建的软件包默认为 private。 [GitHub 容器仓库](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) · [Docker 摘要发布和标签复制](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/)

发布回执及签名证明保留在 Actions 制品中，可通过下列命令验证。登记和回退使用回执中的 `name@digest`。如果加标签阶段中途失败，在回执有效期内重跑失败作业以沿用原候选。制品库扫描和真实 Delegra Runner 仍按目标环境验收。 [GitHub 构建证明](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) · [issue #394](https://github.com/hrygo/heluo-forge/issues/394)

```sh
gh attestation verify expert-images-release.json --repo hrygo/heluo-forge \
  --signer-workflow hrygo/heluo-forge/.github/workflows/delegra-expert-images.yml
```

策略依据核验于 2026-11-20。 [GitHub 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) · [操作安全](https://docs.github.com/en/actions/reference/security/secure-use) · [Docker 构建缓存](https://docs.docker.com/build/cache/backends/gha/)
