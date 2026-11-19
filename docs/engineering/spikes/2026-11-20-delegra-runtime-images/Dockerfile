FROM docker.io/library/maven:3.9-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320 AS java-toolchain

FROM docker.io/library/node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS codex-min

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/forge-codex
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/forge-npm-cache \
    && rm -rf /tmp/forge-npm-cache \
    && ln -s /opt/forge-codex/node_modules/.bin/codex /usr/local/bin/codex \
    && install -d -o node -g node /workspace

ENV LANG=C.UTF-8
USER node:node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["codex", "--help"]

FROM codex-min AS codex-java-21

COPY --from=java-toolchain /opt/java/openjdk /opt/java/openjdk
COPY --from=java-toolchain /usr/share/maven /usr/share/maven

ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:/usr/share/maven/bin:${PATH}"
