# Enterprise Gitee

Integrates enterprise Gitee (`gh`) repository, issue, and pull request workflows with local Git checks.

## Features

- **Repository & PR Queries**: Inspect repositories, issues, pull requests, and diffs.
- **Controlled Collaboration**: Create or comment on issues/PRs, post reviews, run `git commit` / `git push` with confirmation, and check release readiness.
- **Safety Guardrails**: Never performs high-risk actions such as merge, close, revert, or tag deletion.

## Usage

1. Reuses your authenticated local `gh` session automatically.
2. Configure CLI path, timeout, or an optional workspace token in Settings.
