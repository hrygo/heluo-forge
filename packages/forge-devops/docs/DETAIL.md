# Enterprise DevOps

Enterprise DevOps integration for DeepSeek Harness, connecting the `dop` CLI and policy-gated change delivery tools with Web configuration controls.

## Capabilities

- **Change Queries & Context Cards**: Provides `forge_devops_query` (single-change inspection and backlog listing) and `forge_devops_change_context` (structured change context cards).
- **Controlled Updates & Delivery Artifacts**: Provides `forge_devops_change_update` (explicitly confirmed updates to summary, description, or acceptance criteria) and `forge_devops_write_artifact` (workspace clarification, plan, and review artifact output).
- **Command Entry & Web Settings** (`/devops-change`): Automatically discovers local `dop` executables on startup; displays tool readiness checks, allows overriding CLI paths and timeout thresholds, and provides a bottom credential section for optional per-workspace token overrides.

## Configuration & Credentials

1. Uses your existing local `dop` CLI session automatically with zero environment-variable setup required.
2. When auto-discovery cannot find `dop`, configure the executable path and timeout in settings (precedence: **Settings page > Environment variable > Auto-discovery**).
3. Use the credential section at the bottom of the panel when you need to specify a dedicated override token instead of inheriting the local environment.

## Scope & Boundaries

- Scoped to enterprise DevOps change workflows; code repositories, Issues, and Pull Requests are handled by the Gitee plugin.
- Execution remains gated by `@heluo/forge-policy` admission rules and server-side enterprise DevOps permissions.

