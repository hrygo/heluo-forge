# Enterprise Account & Models

The universal enterprise foundation for DeepSeek Harness covering unified sign-in, enterprise AI gateway connectivity, managed model catalogs, and encrypted credential storage, without engineering-specific tooling.

## Included Capabilities

- **Enterprise Sign-in** (`Settings -> Enterprise Account`): Handles unified enterprise authentication, AI gateway URL and key setup, session refresh, and clean sign-out.
- **Enterprise Model Management** (`Settings -> Enterprise Models`): Fetches authorized gateway model catalogs, enables models with one-click defaults, supports manual model entries, and allows fine-grained tuning of context, output tokens, and reasoning levels.
- **Encrypted Credential Storage**: Disables plaintext credential storage in favor of value-encrypted SQLite backed by the local keyring.
- **Unified Policy & Exclusive Guardrails**: Registers the enterprise policy service and disables public account sign-in, direct API key bypasses, and unmanaged model additions.

## Getting Started

1. Open **Settings -> Enterprise Account** and complete your enterprise sign-in.
2. Verify or enter your AI gateway URL and access key until the gateway status is ready.
3. Open **Settings -> Enterprise Models**, enable models with one click or tune their parameters, and select them in chat.

## Boundaries & Notes

- Personal public accounts, unmanaged model endpoints, and plaintext credential persistence are disabled while this bundle is active.
- Default policy settings use an in-memory audit sink for local/pilot validation; persistent compliance audit sinks, enterprise IAM endpoints, and OS keyring integration depend on your enterprise deployment configuration.
- This bundle focuses strictly on unified enterprise identity, AI gateway connectivity, and managed model access; additional domain toolkits can be installed independently as needed.
