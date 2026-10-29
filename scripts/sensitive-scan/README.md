# Team sensitive-scan attestation

This change provides a local scan and a remote signature verifier using one team
Ed25519 key pair. The Git `commit-msg` hook scans staged changes and the commit
message; GitHub verifies signed commit trailers using the public key from the PR
base. Git repository contents are pushed normally. The shared private key, real
rules and scan results must not be committed or uploaded to the remote service.
The verifier does not scan files or receive the real rules or findings.

## Installation and trust boundary

Use the controlled complete distribution and follow [TEAM-FULL-INSTALL.md](TEAM-FULL-INSTALL.md).
It includes the existing team key and rules; its unencrypted ZIP and extracted
copies are sensitive key material. Do not create individual developer keys.
The installer places scripts, private key and rules in the Git common dir and
installs the Git-selected hook; linked worktrees ordinarily share that setup,
while independent clones each need installation. Existing different hooks or
files are not overwritten. Check the installation guide for path, permission,
worktree and platform limitations; later Git configuration can bypass the hook.

A valid signature proves only that a holder of the shared private key signed a
v2 statement bound to the commit tree, the scanned baseline HEAD tree, normalized
commit message and trailer metadata. It does not prove the hook ran, the scanner was unmodified, or the rules were
correct or effective. A malicious or compromised key holder can sign a false
statement; this is not a defense against them, and individual holders cannot be
identified or revoked using the shared key. The v2 trailer and signed payload do
not contain a rules fingerprint; scanner ID, time and nonce are informational.
The verifier does not enforce a rules or scanner allowlist or attestation age.
It rejects older experimental v2 trailers that contain a rules field.

## Bootstrap and GitHub configuration

The target workflow always verifies; no repository-variable bypass is used.
Missing or invalid public key on the base fails closed. The workflow and key in a
worktree do not establish remote deployment, successful checks or branch rules.

1. Review and merge the verifier, workflow and `team-public-key.pub` into the PR
   base before requiring the new check. During initial bootstrap, the base lacks
   the new key, so the new check can fail and must not yet be required. Confirm
   the key fingerprint through an independent trusted channel.
2. Test a correctly signed PR and an unsigned or incorrectly signed PR. Only
   after verifying the results, configure the one new required context
   `sensitive-attestation-verify`; keep the existing `verify` check separately.
   Require up-to-date branches and linear history, disable squash and merge
   commits, and use rebase merging. These are administrator actions, not effects
   of installing the package.
3. The `pull_request_target` workflow checks out trusted base code, fetches PR
   Git objects and verifies the event head; it does not check out or execute PR
   code, reads no secrets and uses read-only contents permission. Protect workflow
   and public key changes with review; an organization-level required workflow
   offers stronger control. Merge queue is not supported by this workflow.

## Verification and rotation

```sh
node scripts/sensitive-scan/verify.mjs --base origin/main --head HEAD
```

The team hook signs v2 with the actual scanned baseline HEAD tree. The verifier
reads the public key from `--base`, rejects v1 and requires exactly one parent;
it checks that the parent's tree matches the signed baseline tree, as well as
the signature, commit tree and message. Root and merge commits cannot be signed
by the team hook; empty ranges are rejected. A changed baseline tree after rebase
requires a fresh scan and signature. Ordinary amend also requires a fresh scan
and signature: its final parent tree normally differs from the HEAD tree scanned
by the hook, so a trailer produced during that amend is rejected. Rewriting the
committer or a conflict-free rebase can retain the signature only when the signed
baseline tree, commit tree and message remain unchanged. Tree binding does not
prevent races during scanning or forgery by a key holder. Unscannable content is
blocked by the local hook unless explicitly excluded in local rules; see the
installation guide for supported file types and limitations.

The older `sensitive:scan` and `sensitive:install` CLI entries use the legacy v1
scanner and different rule format and paths; they cannot satisfy the v2 remote
check. The legacy `scan.mjs` outputs a rules digest and legacy `commit-msg.mjs`
signs one into its v1 trailer: do not use them with real sensitive rules. Use the
team hook instead. The legacy installer refuses to overwrite the team hook. Existing v1
complete-package installations require the new complete package and its explicit
`--upgrade-known-v1` procedure; see [TEAM-FULL-INSTALL.md](TEAM-FULL-INSTALL.md)
for preconditions, backups and interruption recovery. Do not overwrite unknown
hooks or replace private keys or rules manually.

Rotate the shared pair under custodian control. A reviewed key-replacement PR
must be signed with the old key because the verifier reads the base key. After
merge, securely distribute the new private key and re-sign in-flight PRs; only
one key is trusted at a time. If the old key is unavailable or compromised,
use a reviewed administrator-controlled recovery process rather than claiming an
unsigned PR passed the required check. The complete package does not configure
GitHub settings; platform and remote enforcement acceptance remain separate.
