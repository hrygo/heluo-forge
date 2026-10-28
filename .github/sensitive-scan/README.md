# Sensitive-scan public registry

This directory contains only public verification data. It must never contain
local rule patterns, scan findings, private keys or production secret values.

- `keys.json`: public Ed25519 keys registered for devices. Add entries through
  a reviewed pull request after a device is enrolled; remove or set
  `status: "revoked"` on offboarding or suspected key compromise.
- `allowed-rules.json`: SHA-256 digests of approved local rule files and the
  approved scanner versions. The remote verifier reads these from the base
  revision of a pull request, so a pull request cannot register its own key.

An empty registry is intentional until the first device is enrolled. The
GitHub workflow stays non-enforcing until the repository variable
`SENSITIVE_SCAN_ENFORCE` is set to `true`.
