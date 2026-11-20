# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG CODEX_STAGE=codex-npm

FROM runner_compiler AS runner-source
ARG BUILDOS
ARG BUILDARCH
ARG TARGETOS
ARG TARGETARCH
RUN test "$BUILDOS/$BUILDARCH:$TARGETOS/$TARGETARCH" = linux/arm64:linux/arm64
ARG RUNNER_REVISION
ARG RUNNER_SOURCE_URL
ARG RUNNER_SOURCE_SHA256
ADD --checksum=sha256:${RUNNER_SOURCE_SHA256} ${RUNNER_SOURCE_URL} /tmp/delegra.tar.gz
RUN mkdir /source \
    && prefix="Delegra-${RUNNER_REVISION}" \
    && tar -xzf /tmp/delegra.tar.gz -C /source --strip-components=1 \
        "$prefix/LICENSE" "$prefix/packages/paperclip-runner/runner" \
        "$prefix/packages/paperclip-runner/protocol" \
        "$prefix/packages/paperclip-runner/acpx-profiles.json" \
        "$prefix/packages/paperclip-runner/antigravity-distributions.json"

FROM runner_compiler AS runner-build
WORKDIR /src/packages/paperclip-runner/runner
COPY --from=runner-source /source/packages/paperclip-runner/runner/Cargo.toml /source/packages/paperclip-runner/runner/Cargo.lock ./
COPY --from=runner-source /source/packages/paperclip-runner/runner/crates ./crates
COPY --from=runner-source /source/packages/paperclip-runner/protocol ../protocol
COPY --from=runner-source /source/packages/paperclip-runner/acpx-profiles.json /source/packages/paperclip-runner/antigravity-distributions.json ../
RUN --mount=type=cache,id=expert-r2-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=expert-r2-cargo-target,target=/cargo-target,sharing=locked \
    CARGO_TARGET_DIR=/cargo-target CARGO_NET_RETRY=4 \
    cargo build --locked --release -j 2 -p paperclip-runner-core --bin paperclip-runnerd \
    && install -D -s -m 0755 /cargo-target/release/paperclip-runnerd /out/paperclip-runnerd

FROM node_toolchain AS codex-npm
WORKDIR /out
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && mkdir bin \
    && ln -s ../node_modules/.bin/codex bin/codex \
    && test "$(./bin/codex --version)" = 'codex-cli 0.160.0'

FROM node_toolchain AS codex-native
ARG CODEX_ARCHIVE_URL
ARG CODEX_ARCHIVE_SHA256
COPY debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends zstd \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:${CODEX_ARCHIVE_SHA256} ${CODEX_ARCHIVE_URL} /tmp/codex.tar.zst
RUN mkdir /out \
    && tar --zstd -xf /tmp/codex.tar.zst -C /out \
    && test "$(/out/bin/codex --version)" = 'codex-cli 0.160.0'

FROM ${CODEX_STAGE} AS codex-assets

FROM runtime_base AS expert-runtime
ARG RUNNER_REVISION
LABEL org.opencontainers.image.title="Heluo Forge Delegra expert runtime" \
      io.heluo-forge.delegra.runner-revision="${RUNNER_REVISION}" \
      io.heluo-forge.codex.version="0.160.0"
COPY debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
        bash ca-certificates coreutils diffutils findutils gawk git grep libstdc++6 \
        procps python3 python3-venv ripgrep sed tar tini util-linux \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/home
ENV HOME="${HOME}/node"
ENV CODEX_HOME="${HOME}/.codex" \
    XDG_CACHE_HOME="${HOME}/.cache" \
    LANG=C.UTF-8
RUN --mount=type=bind,from=node_toolchain,source=/usr/local/bin/node,target=/tmp/expert-node,ro \
    { command -v node >/dev/null || install -m 0755 /tmp/expert-node /usr/local/bin/node; } \
    && { id node >/dev/null 2>&1 || { groupadd --gid 1000 node && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash node; }; } \
    && test "$(id -u node):$(id -g node)" = 1000:1000 \
    && test "$(getent passwd node | cut -d: -f6)" = "$HOME" \
    && install -d -o node -g node -m 0755 /workspace "$XDG_CACHE_HOME" \
    && install -d -o node -g node -m 0700 "$CODEX_HOME"
COPY --from=runner-build /out/paperclip-runnerd /usr/local/bin/paperclip-runnerd
COPY --from=runner-source /source/LICENSE /usr/share/doc/paperclip-runnerd/LICENSE
COPY --from=codex-assets /out/ /opt/expert-codex/
COPY --from=uv_toolchain /uv /uvx /usr/local/bin/
ADD --chmod=0644 --checksum=sha256:860e3d7a86b84e6a7012c7a635fc64df475cebc6cce34dfeb73a5982ec58176c \
    https://raw.githubusercontent.com/astral-sh/uv/0.13.9/LICENSE-MIT /usr/share/doc/uv/LICENSE-MIT
RUN ln -s /opt/expert-codex/bin/codex /usr/local/bin/codex \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && chmod 0755 /usr/share/doc/uv

USER 1000:1000
WORKDIR /workspace
RUN test "$(node --version)" = v24.21.0 \
    && test "$(codex --version)" = 'codex-cli 0.160.0' \
    && python -c 'import venv' \
    && uv --version >/dev/null \
    && uvx --version >/dev/null \
    && test -r /usr/share/doc/uv/LICENSE-MIT \
    && paperclip-runnerd --build-metadata >/dev/null
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["codex", "--help"]
