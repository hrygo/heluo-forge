# Delegra 专家运行时镜像

此目录提供 14 份 Dockerfile 和 18 个 Linux ARM64 发布目标。所有场景共享固定版本的 Codex、`paperclip-runnerd`、Node 与工作区工具。容器以 `1000:1000` 运行，默认工作区为 `/workspace`。[`capabilities.json`](capabilities.json) 记录各目标提供的命令。

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

测量输出包含 ARM64 manifest digest、压缩层总字节数和去重后的父层增量。获准的制品发布启用 `--sbom=true --provenance=mode=min`，登记实际摘要及部署环境的验收记录。
