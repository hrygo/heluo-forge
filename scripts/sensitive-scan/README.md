# Sensitive-scan local attestation

This directory implements the **local scan + remote signature verification**
contract. Rule patterns and file contents stay on the developer machine. The
remote side receives only a signed commit trailer containing a tree OID, a
message digest, a rules digest and a scanner version.

The design is intentionally **not** a remote scanner: sensitive rule sets must
not be copied to a SaaS CI system, and scan findings must not be uploaded.

## Trust boundary

The signature proves:

> A holder of key `key-id` signed a statement that the local scanner passed for
> tree `X`, message `M`, rules digest `R` and scanner version `S`.

It does **not** prove that the scanner binary was unmodified, that the rules
were effective, or that the signer is not a compromised same-user process. A
per-device key stored in an OS keychain/TPM is the recommended production
control; the initial CLI stores a 0600 key file and is a bootstrap mechanism,
not the final hardware-backed design.

## Setup

1. Generate a device key:

   ```sh
   node scripts/sensitive-scan/keygen.mjs --owner "your-enterprise-identity"
   ```

   The private key is written outside the repository, under
   `~/.config/heluo-forge/sensitive-scan/device-key.pem` by default, with mode
   `0600`. The command prints a public registry entry.

2. Put the local rules file outside the repository, for example:

   ```sh
   ~/.config/heluo-forge/sensitive-scan/rules.json
   ```

   `scripts/sensitive-scan/rules.example.json` is a synthetic example only.
   Do not commit real rule patterns. Keep the effective rules file out of git.

3. Add the printed public entry to `.github/sensitive-scan/keys.json` through a
   reviewed pull request. Add the SHA-256 of the approved rules file to
   `.github/sensitive-scan/allowed-rules.json`.

4. Install the local `commit-msg` hook:

   ```sh
   node scripts/sensitive-scan/install-hook.mjs
   ```

   This is a convenience and feedback path. It is not an enforcement boundary;
   the server-side required check is.

5. Enable enforcement only after keys and rules are registered:

   - set repository variable `SENSITIVE_SCAN_ENFORCE=true`;
   - make `sensitive-attestation / verify` a required check;
   - require linear history and review;
   - disable squash merge and merge commits.

## Commit trailer

The `commit-msg` hook appends:

```text
Sensitive-Scan: v1
Sensitive-Scan-Tree: <tree oid>
Sensitive-Scan-Message: <sha256 of message without trailer>
Sensitive-Scan-Rules: <sha256 of local rules file>
Sensitive-Scan-Scanner: heluo-sensitive-scan@1.0.0
Sensitive-Scan-Time: <unix seconds>
Sensitive-Scan-Nonce: <random>
Sensitive-Scan-Key: <key id>
Sensitive-Scan-Sig: <base64 Ed25519 signature>
```

The signature covers `v1`, tree, message digest, rules digest, scanner id, time
and nonce. The tree and message binding prevents copying a valid trailer onto a
different commit. Parents are intentionally not signed so a conflict-free
rebase does not invalidate the attestation; any conflict resolution changes the
tree and requires a new scan.

## Verify locally

```sh
node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD
```

The verifier reads public keys and the rules allowlist from `--base` by default,
not from the PR head. It never reads the local rules file and never scans files.

## GitHub enforcement

`.github/workflows/sensitive-attestation.yml` runs on `pull_request_target`,
checks out the base revision only, fetches the PR commits, and verifies the
trailers. It has read-only permissions and no secrets. It does not execute PR
code. The workflow is non-blocking until `SENSITIVE_SCAN_ENFORCE=true` is set.

After enabling, the check name is `sensitive-attestation / verify`. It should be
required by the branch ruleset, with "require branches to be up to date before
merging" enabled. Without that setting, a key revocation or allowlist change on
the base branch does not re-run checks already attached to an open PR. A PR can
modify the workflow file, so use an organization-level required workflow for
stronger protection; the repository workflow is the reference implementation.

## Enrollment and rotation

- The first key/rules allowlist can only be merged while enforcement is off
  (bootstrap). After that, key-enrollment PRs must be signed by an already
  trusted key; otherwise the base registry has no key to verify them.
- Rotate by adding the new public key and revoking the old one in a reviewed PR.
  Merge the rotation before revoking commits that are still in flight.
- Offboarding: set `status: "revoked"` and/or `notAfter`; the verifier reads the
  base registry, so revocation takes effect for new PR checks immediately.
- A rules update changes the digest. Add the new digest to the allowlist and
  remove the old one only after in-flight PRs are rebased and re-signed.

## Why not a fixed string or remote scan

- A fixed string is forgeable and copyable.
- A shared HMAC key can be extracted from one client and used to forge all
  clients.
- Remote scanning requires sending sensitive rules or findings to the remote
  service.
- A per-device asymmetric key plus a tree-bound payload is the minimum practical
  contract when rules must stay local.

## Limitations

- The initial key is a 0600 file; production should move it to an OS keychain,
  TPM or secure enclave with non-exportable keys.
- A compromised developer account can sign a false statement. Hardware-backed
  keys and device compliance reduce, but do not eliminate, this risk.
- Merge commits and squash merges are rejected. Use rebase merge with linear
  history, or add a trusted merge bot that re-signs the final commit.
- Rules updates require a new allowlist digest and a reviewed registry change.
- The verifier checks the allowlist digest, not the rule content; the remote
  cannot know what the local rules were.
- Binary, oversized or unreadable files are blocking by default. A path must be
  explicitly excluded in the approved local rules to skip it; otherwise the
  local hook refuses to create an attestation.
