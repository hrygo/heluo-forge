# Enterprise Policy Engine

Provides unified access control and audit protection before enterprise tools or commands run.

## Features

- **Action Guardrails**: Allows only permitted actions; unregistered actions, missing identities, missing targets and subagent-originated calls are rejected, and every admission leaves an audit receipt.
- **Confirmation Cards**: Asks once for pushes (`confirmPush`) and DevOps change updates (`confirmDopWrite`); the call runs only when every question selects "allow this write". Timeouts, unavailable channels and malformed answers are all treated as not confirmed. A retry of the same call may reuse an earlier approval, capped at 32 entries and never written to disk.
- **Path Protection**: Paths under protected roots such as `$DSH_HOME` are rejected by `checkPath`.
- **Audit Logging**: Records every controlled operation, plus one record for the question and one for the answer, without bodies, raw arguments or absolute paths.

## Usage

This is a background security component that works automatically once enabled. Three of the eight policy switches are implemented (`denyDelegatedWrites`, `confirmPush`, `confirmDopWrite`); enabling any of the other five fails at mount time instead of being silently ignored. Confirmation keeps waiting 120000 ms by default (`confirmation.timeoutMs`). Without a desktop confirmation channel the plugin still mounts, but writes that need a card are rejected with `POLICY_CONFIRM_UNAVAILABLE`.
