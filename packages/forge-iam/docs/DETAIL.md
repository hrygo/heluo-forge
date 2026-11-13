# Enterprise IAM Sign-in

Universal enterprise authentication and model gateway plugin providing single sign-on, personal gateway credential management, and enterprise model catalog configuration.

## Capabilities

- **Enterprise Account Sign-in** (`Settings → Enterprise account`): Authenticates via OIDC Authorization Code flow with PKCE, supports automatic session renewal, collapsible diagnostics, and clean sign-out.
- **AI Gateway Credential Management** (`Settings → Enterprise account`): Stores, replaces, and clears personal gateway API keys inside encrypted host storage without leaking into personal public providers.
- **Enterprise Model Management** (`Settings → Enterprise models`): Syncs the authorized model catalog from your enterprise AI gateway, supports one-click enabling with default parameters, manual custom model registration, and fine-grained tuning for context window, output token limits, and reasoning effort bounds.

## Quick Start

1. Open **Settings → Enterprise account** and complete enterprise SSO authentication, then enter your personal AI gateway credential.
2. Open **Settings → Enterprise models** and click **Enable** (or **Enable all with defaults**) for the models you need, or add custom gateway models via **Manual add**.
3. Enabled enterprise models immediately become selectable in chat conversations.

## Security & Scope

- Enterprise session grants and personal gateway keys are encrypted through the credential provider; signing out stops enterprise model traffic cleanly.
- This plugin focuses strictly on enterprise authentication and model gateway access and includes no unrelated domain tools.
- Live connectivity depends on your administrator's deployed IAM issuer and AI gateway endpoints.

