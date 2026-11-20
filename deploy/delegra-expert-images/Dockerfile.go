# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM download_base AS tools
ARG GO_URL
ARG GO_SHA256
USER 0
ADD --checksum=sha256:${GO_SHA256} ${GO_URL} /tmp/go.tar.gz
RUN mkdir /out && tar -xzf /tmp/go.tar.gz -C /out

FROM expert_base
COPY --from=tools /out/go/ /usr/local/go/
ENV PATH="/usr/local/go/bin:${PATH}" \
    GOTOOLCHAIN=local
