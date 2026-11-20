variable "EXPERT_IMAGE_PREFIX" {
  default = "paperclip-expert"
}

variable "RUNNER_REVISION" {
  default = "25c86a283a9c787a01911c714618d78df7552af7"
}

variable "NODE_IMAGE" {
  default = "docker-image://docker.io/library/node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66"
}

variable "JAVA_IMAGES" {
  default = {
    "8"  = "docker-image://docker.io/library/maven:3.9-eclipse-temurin-8@sha256:fb202aee3d84117bc9b1db9047f3f37c4a88a9c7da119de7f7b551de4f3b146c"
    "11" = "docker-image://docker.io/library/maven:3.9-eclipse-temurin-11@sha256:26fe0264f4b197d52638ff3dc415cf8c2f6ae4ad669445feeaa8d483a74a9ec4"
    "17" = "docker-image://docker.io/library/maven:3.9-eclipse-temurin-17@sha256:a9f2cf869775553ae002e9d64b35679b9e810b335f58035031b39bf5c6429886"
    "21" = "docker-image://docker.io/library/maven:3.9-eclipse-temurin-21@sha256:71a6832f657180ea206901ffc548c0e73a257cb09b4912619177586d0268d59c"
    "25" = "docker-image://docker.io/library/maven:3.9-eclipse-temurin-25@sha256:4908705d2e22261d4ee0aa74f2ecdabf7c034fd49f1aa15e262e4220f1d6ef06"
  }
}

group "default" {
  targets = [
    "codex-min", "java", "codex-python", "codex-node", "codex-go", "codex-sql",
    "codex-dotnet-10", "codex-test-api", "codex-test-web", "codex-test-load",
    "codex-ops-diag", "codex-ops-k8s", "codex-ops-iac", "codex-office-zh"
  ]
}

group "reference" {
  targets = ["codex-min", "codex-java-21", "codex-min-native", "codex-java-21-native"]
}

target "_arm64" {
  context   = "deploy/delegra-expert-images"
  platforms = ["linux/arm64"]
}

target "codex-min" {
  inherits = ["_arm64"]
  tags     = ["${EXPERT_IMAGE_PREFIX}/codex-min:arm64-local"]
  args = {
    RUNNER_REVISION      = RUNNER_REVISION
    RUNNER_SOURCE_URL    = "https://codeload.github.com/hrygo/Delegra/tar.gz/${RUNNER_REVISION}"
    RUNNER_SOURCE_SHA256 = "108b6cf32d4d661b79396899b95fc456354a65a1855a38e4f36870b6f50b123a"
  }
  contexts = {
    runner_compiler = "docker-image://docker.io/library/rust:1.97-bookworm@sha256:6e957ef098dcc77d33e310261e4ed5843bb108d5c3b5dc2b476cbc8b6caf53fa"
    node_toolchain  = NODE_IMAGE
    runtime_base    = NODE_IMAGE
  }
}

target "codex-min-native" {
  inherits = ["codex-min"]
  tags     = ["${EXPERT_IMAGE_PREFIX}/codex-min:arm64-native-local"]
  args = {
    CODEX_STAGE          = "codex-native"
    CODEX_ARCHIVE_URL    = "https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-package-aarch64-unknown-linux-musl.tar.zst"
    CODEX_ARCHIVE_SHA256 = "83d68fdeb6022722b66f50459363aa43f55ce0fb70778aa1cfeaa70e46ce97fe"
  }
  contexts = {
    runtime_base = "docker-image://docker.io/library/debian:trixie-slim@sha256:24a01011d10eba3a023bc8585b9650b8b29021240d4217c05b905e09ef4a5232"
  }
}

target "_scene" {
  inherits = ["_arm64"]
  contexts = { expert_base = "target:codex-min" }
}

target "java" {
  inherits   = ["_scene"]
  matrix     = { major = ["8", "11", "17", "21", "25"] }
  name       = "codex-java-${major}"
  dockerfile = "Dockerfile.java"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-java-${major}:arm64-local"]
  contexts   = { java_toolchain = JAVA_IMAGES[major] }
}

target "codex-java-21-native" {
  inherits   = ["_arm64"]
  dockerfile = "Dockerfile.java"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-java-21:arm64-native-local"]
  contexts = {
    expert_base    = "target:codex-min-native"
    java_toolchain = JAVA_IMAGES["21"]
  }
}

target "codex-python" {
  inherits   = ["_scene"]
  dockerfile = "Dockerfile.python"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-python:arm64-local"]
  contexts   = { uv_toolchain = "docker-image://ghcr.io/astral-sh/uv:0.11.25@sha256:afb0e190853be0b7418175027d5158a3f4c2d30f3ca64312df8dac758cc2fcb2" }
}

target "_node-tools" {
  inherits = ["_scene"]
  contexts = { node_toolchain = NODE_IMAGE }
}

target "codex-node" {
  inherits   = ["_node-tools"]
  dockerfile = "Dockerfile.node"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-node:arm64-local"]
}

target "_downloads" {
  inherits = ["_scene"]
  contexts = { download_base = "target:codex-min" }
}

target "codex-go" {
  inherits   = ["_downloads"]
  dockerfile = "Dockerfile.go"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-go:arm64-local"]
  args = {
    GO_URL    = "https://go.dev/dl/go1.27.4.linux-arm64.tar.gz"
    GO_SHA256 = "3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92"
  }
}

target "codex-sql" {
  inherits   = ["_scene"]
  dockerfile = "Dockerfile.sql"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-sql:arm64-local"]
}

target "codex-dotnet-10" {
  inherits   = ["_scene"]
  dockerfile = "Dockerfile.dotnet"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-dotnet-10:arm64-local"]
  contexts   = { dotnet_toolchain = "docker-image://mcr.microsoft.com/dotnet/sdk:10.0-noble@sha256:299dd5c45103c1fb44ea9d1fd1b149ca056786da47afb84438140411892eec46" }
}

target "codex-test-api" {
  inherits   = ["_node-tools"]
  dockerfile = "Dockerfile.test-api"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-test-api:arm64-local"]
}

target "codex-test-web" {
  inherits   = ["_node-tools"]
  dockerfile = "Dockerfile.test-web"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-test-web:arm64-local"]
  args = {
    CHROMIUM_URL    = "https://cdn.playwright.dev/builds/cft/159.0.8154.6/linux-arm64/chrome-linux-arm64.zip"
    CHROMIUM_SHA256 = "4a9ea5f9422e268fff9df19908365b6d1e92da154607d0f90c7138cf6c42ce38"
    HEADLESS_URL    = "https://cdn.playwright.dev/builds/cft/159.0.8154.6/linux-arm64/chrome-headless-shell-linux-arm64.zip"
    HEADLESS_SHA256 = "e1262e9f4f244c441dcb54aa0e9abe4cf7b266ab02dc666fd975bd55aba9b3dc"
    FFMPEG_URL      = "https://cdn.playwright.dev/builds/ffmpeg/1013/ffmpeg-linux-arm64.zip"
    FFMPEG_SHA256   = "457360e803a7d8d5f8f7f5ecf562b2d338f6b4f7f86339d0c31938a451e8878b"
  }
}

target "codex-test-load" {
  inherits   = ["_downloads"]
  dockerfile = "Dockerfile.test-load"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-test-load:arm64-local"]
  args = {
    K6_URL    = "https://github.com/grafana/k6/releases/download/v2.4.0/k6-v2.4.0-linux-arm64.tar.gz"
    K6_SHA256 = "7bb415f59d81ad649a86f6da6b3e1bd2e4e64e84909deef13e9bca70608abccb"
  }
}

target "codex-ops-diag" {
  inherits   = ["_scene"]
  dockerfile = "Dockerfile.ops-diag"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-ops-diag:arm64-local"]
}

target "_platform-tools" {
  inherits = ["_downloads"]
  contexts = { expert_base = "target:codex-ops-diag" }
}

target "codex-ops-k8s" {
  inherits   = ["_platform-tools"]
  dockerfile = "Dockerfile.ops-k8s"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-ops-k8s:arm64-local"]
  args = {
    KUBECTL_URL    = "https://dl.k8s.io/release/v1.37.2/bin/linux/arm64/kubectl"
    KUBECTL_SHA256 = "fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509"
    HELM_URL       = "https://get.helm.sh/helm-v4.3.2-linux-arm64.tar.gz"
    HELM_SHA256    = "df31cb61680ef728f82c770e5280dd565617bee6b039d37e85c677288be4bbb0"
  }
}

target "codex-ops-iac" {
  inherits   = ["_platform-tools"]
  dockerfile = "Dockerfile.ops-iac"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-ops-iac:arm64-local"]
  args = {
    TOFU_URL    = "https://github.com/opentofu/opentofu/releases/download/v1.13.9/tofu_1.13.9_linux_arm64.tar.gz"
    TOFU_SHA256 = "5dc196dde75b667e4806d358310ec96742774cd0993c54c1237efee5644b69b8"
  }
}

target "codex-office-zh" {
  inherits   = ["_scene"]
  dockerfile = "Dockerfile.office-zh"
  tags       = ["${EXPERT_IMAGE_PREFIX}/codex-office-zh:arm64-local"]
}
