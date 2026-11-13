# Enterprise Gitee Integration

Enterprise code-hosting and delivery plugin connecting the `gh`-compatible Gitee CLI and local Git tooling for structured queries, controlled writes, and delivery checks.

## Capabilities

- **Repository & Collaboration Queries**: Queries repository metadata, Issues, Pull Requests, and deterministic workspace snapshots (`contentId`).
- **Controlled Writes & Git Actions**: Supports policy-gated, idempotency-checked Issue/PR actions, review recording/publishing, and local `git commit` / `git push`.
- **Delivery Verification**: Validates delivery closure prerequisites and `review.md` review freshness.
- **Gitee Settings & Security Alerts**: Configure `cliPath` and `timeoutMs` overrides, inspect plaintext persistent credential warnings, and manage per-workspace token overrides at the bottom of the panel.

## Credentials & Boundaries

- Inherits local CLI authentication automatically; custom override tokens can be configured at the bottom of the Gitee panel without altering local CLI config files.
- Does not perform merge, close, tag, or revert operations; remote authorization remains governed by enterprise Gitee permissions.

