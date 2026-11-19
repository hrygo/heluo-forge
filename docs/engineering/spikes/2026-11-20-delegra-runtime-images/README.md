# Delegra 专家运行时镜像本机探针

2026-11-20 使用本机 Docker Engine `29.9.3`、Buildx `0.38.1` 和 `linux/arm64` 构建并运行镜像。由同一份 [Dockerfile](Dockerfile) 输出公共 Codex 层和 Java 21 派生镜像。Codex 锁定为 `0.167.1`，npm 锁文件固定制品完整性校验值。Node 和 Maven 来源固定 OCI 摘要，APT 包按探针执行时解析。

| 本机镜像 | `docker image inspect` 大小 | 实测结果 |
| --- | --- | --- |
| `heluo-forge-probe/codex-min:0.167.1-20261120.2` | 1,092,912,077 字节 | Codex `0.167.1`，glibc `2.41`，UID `1000`，`/workspace` 可写 |
| `heluo-forge-probe/codex-java-21:0.167.1-20261120.2` | 1,578,874,730 字节 | Codex `0.167.1`，Temurin `21.0.12.1`，Maven `3.9.16`，Java 样例编译并运行 |

本机 OCI 索引摘要依次为 `sha256:75cd1132528bfa5956b09fd2dd38d8918084105279023464e6a37319cb351106` 和 `sha256:b2a6c235543b7f20aaebf26d971b7ad93413407d88d734ebe1c4a9f3cd7e3a89`。Java 镜像复用最小镜像的全部 10 个文件系统层。清理构建缓存后，最小镜像的 Docker 报告大小较探针初版减少 331,867,569 字节。

## 构建与运行

在本目录执行。两个构建目标依次复用公共层，镜像加载到本机 Docker。最终探针在已拉取基础镜像的情况下分别耗时 38.04 秒和 6.12 秒。

```sh
set -e
probe_tag=0.167.1-20261120.2
for probe_target in codex-min codex-java-21; do
  docker buildx build --platform linux/arm64 --target "$probe_target" \
    --tag "heluo-forge-probe/$probe_target:$probe_tag" --load .
done

docker run --rm --platform linux/arm64 --network none \
  "heluo-forge-probe/codex-min:$probe_tag" sh -eu -c '
  test "$(id -u)" = 1000
  test "$PWD" = /workspace
  touch .forge-workspace-probe
  test "$(codex --version)" = "codex-cli 0.167.1"
  codex --version
  getconf GNU_LIBC_VERSION
'

docker run --rm -i --platform linux/arm64 --network none \
  "heluo-forge-probe/codex-java-21:$probe_tag" sh -eu <<'SCRIPT'
test "$(id -u)" = 1000
test "$PWD" = /workspace
test "$(codex --version)" = "codex-cli 0.167.1"
java -version
mvn -version
cat >RuntimeHello.java <<'JAVA'
class RuntimeHello {
    public static void main(String[] args) {
        System.out.println("JAVA_21_PROBE_OK");
    }
}
JAVA
javac --release 21 RuntimeHello.java
test "$(java RuntimeHello)" = JAVA_21_PROBE_OK
java RuntimeHello
SCRIPT
```

断网启动和工作区检查实测约 0.27 秒，Java 工具版本检查及样例编译运行实测约 0.77 秒。

## 模拟网关验证

[探针脚本](gateway-probe.mjs)在容器回环地址启动模拟网关，使用合成的个人网关 Key 和 IAM access token。实际 Codex CLI 请求 `POST /aig/v1/responses`，探针断言 `Authorization: Bearer …`、`X-IAM-Token` 和 `X-Consumer-Type: personal` 准确到达。两项凭据齐备时，Codex 读到模拟流式结果并完成 turn。缺少 IAM 令牌时，模拟网关返回 `401`，Codex 以失败退出。全程使用 `--network none`。 [Codex Provider 配置](https://developers.openai.com/codex/config-reference)

```sh
docker run --rm --platform linux/arm64 --network none \
  --mount "type=bind,source=$PWD/gateway-probe.mjs,target=/tmp/gateway-probe.mjs,readonly" \
  heluo-forge-probe/codex-min:0.167.1-20261120.2 node /tmp/gateway-probe.mjs
```

正反向探针通过，耗时 5.48 秒。镜像现存于本机 Docker。目标 Delegra Runner 的镜像拉取、任务挂载和回收，以及企业网关的 `/responses`、调用来源、凭据隔离和真实用户计量待联调。授权链与验收边界见[概念简报](../../reviews/2026-11-20-delegra-runtime-images-concepts-brief.md)。
