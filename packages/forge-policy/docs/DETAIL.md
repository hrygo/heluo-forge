# Enterprise Policy Gate

Unified policy core for Heluo Forge plugins, enforcing action-catalog admission, protected-path guards, outbound confirmation checks, and decision auditing before tool or command execution.

## Capabilities

- **Controlled Action Catalog & Gate**: Permits only actions registered and enabled in the configured policy catalog; missing catalogs, targets, or audit sinks fail closed.
- **Protected-Path Protection**: Canonicalizes paths and symlink targets to deny writes or modifications into core runtime directories (`$DSH_HOME/**`).
- **Sensitive Egress Confirmation**: Enforces user confirmation bound to `(action, target, contentDigest)` for controlled outbound actions.
- **Pre/Post Execution Audit Trail**: Records pre-execute receipts and settles results upon completion without falsifying outcomes on failure.

## Scope & Boundaries

- Governs explicitly registered business actions and declared command categories; unregistered tools fall outside policy scope.
- Offers no `fail-open` bypass switches or regex-blocklist security claims; server-side authorization remains enforced upstream.
