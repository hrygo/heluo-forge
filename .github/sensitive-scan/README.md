# Team sensitive-scan public key

`team-public-key.pub` is the single trusted team Ed25519 public key. The remote
verifier reads it from the PR base revision, not the PR head; a missing or invalid
base key fails verification. Confirm its fingerprint with the authorized
custodian and change it only through a reviewed PR.

This directory must never contain private keys, real local rules, scan findings
or production secrets. Git repository contents are pushed normally; the private
key, real rules and scan results are not uploaded. The signature does not defend
against a malicious holder of the shared private key.

See [the sensitive-scan guide](../../scripts/sensitive-scan/README.md) for the
bootstrap, required check and rotation procedure. A file in this worktree does
not establish that the workflow or branch protection has been deployed.
