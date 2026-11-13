# Enterprise Engineering Suite

An integrated engineering workbench bundle for developers in DeepSeek Harness. It installs independently without bundling the enterprise account base and does not disable personal account, model, or local credential rows.

## Included Capabilities

- **Enterprise Engineering Settings Panel** (`Settings -> Enterprise Engineering`): Hosts DevOps and Gitee configuration tabs and collapsed environment diagnostics in one place.
- **DevOps Integration (DOP)**: Exposes `dop` CLI readiness checks, environment configuration, and change workflow tools.
- **Gitee Workflow Integration**: Exposes `gh`-compatible Gitee CLI tools for repository, issue, and pull-request workflows, delivery readiness assessment, and gated local commit/push flows.
- **Enterprise Issue Delivery Skill** (`enterprise-issue-delivery`): User-invoked skill that anchors issue scoping, native Teamflow orchestration, and version-bound validation evidence.
- **Unified Policy Gate**: Registers the shared policy catalog and tool execution gate prior to adapter calls.

## Credentials & Usage

1. Open **Settings -> Enterprise Engineering** to verify CLI executable paths and connection readiness for DevOps (DOP) and Gitee.
2. **Reuse local CLI sessions by default**: Engineering tools automatically pick up your existing `dop` / `gh` login state.
3. **Per-tool override token on demand**: Set a tool-specific token directly inside the corresponding DevOps or Gitee panel when needed (encrypted by Enterprise IAM when co-installed; standalone installs fall back cleanly to local environment guidance without modifying existing CLI config files).

## Boundaries & Notes

- UI visibility and local policy catalogs do not grant remote authorization; server-side permissions are still enforced by DevOps and Gitee.
- When a plaintext CLI token file is detected on disk for Gitee, the panel displays an explicit security notice without altering your existing CLI config.

