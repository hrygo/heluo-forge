# Enterprise Encrypted Credential Store

Low-level local encrypted credential provider for Heluo Forge plugins, replacing default plaintext credential storage.

## Capabilities

- **Per-Record Authenticated Encryption**: Encrypts each credential reference and payload with AES-256-GCM and a fresh IV inside `credentials.sqlite`, binding AAD to record type, key, owner, and key version.
- **Cross-Process Coordination**: Coordinates concurrent reads and writes across processes using database-level locking and bounded short transactions.
- **Separated Keyring & Legacy Rejection**: Stores keyrings in a sibling `.keys/keyring.json` directory and refuses untrusted legacy plaintext credential files without silent migration.

## Security & Scope

- Designed to be mounted alongside enterprise bundles with plaintext local credential providers disabled.
- Logs and event hooks never record raw secret payloads or token values.
- Filesystem permissions and OS user-boundary protection depend on target platform configuration and host verification.
