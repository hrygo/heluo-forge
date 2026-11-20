# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM expert_base
USER 0
RUN apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
        postgresql-client default-mysql-client \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
