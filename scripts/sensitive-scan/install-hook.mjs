#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitOutput, repoRoot } from './lib.mjs';

const MARKER = '# managed by scripts/sensitive-scan/install-hook.mjs';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Prefer the Node on PATH so upgrades keep working; fall back to the exact
// executable used at install time (useful for Git GUI environments that do not
// inherit the developer terminal's PATH). Convert Windows paths to MSYS form.
const INSTALL_NODE = shellQuote(process.execPath.replace(/\\/g, '/'));
const SHIM = `#!/bin/sh
${MARKER}
NODE="$(command -v node 2>/dev/null || true)"
[ -n "$NODE" ] || NODE=${INSTALL_NODE}
exec "$NODE" "$(git rev-parse --show-toplevel)/scripts/sensitive-scan/commit-msg.mjs" "$1"
`;

try {
  const root = repoRoot();
  const hooksDir = resolve(root, gitOutput(['rev-parse', '--git-path', 'hooks'], { cwd: root }).trim());
  mkdirSync(hooksDir, { recursive: true });
  const target = join(hooksDir, 'commit-msg');
  if (existsSync(target)) {
    const current = readFileSync(target, 'utf8');
    if (!current.includes(MARKER)) {
      const backup = `${target}.bak.${Date.now()}`;
      copyFileSync(target, backup);
      console.error(`sensitive-scan: backed up existing hook to ${backup}`);
    }
  }
  writeFileSync(target, SHIM, { mode: 0o755 });
  chmodSync(target, 0o755);
  console.log(`sensitive-scan: installed ${target}`);
  console.log('run `git commit` once to create a signed attestation; --no-verify is visible to the server check');
} catch (error) {
  console.error(`sensitive-scan install-hook: ${error.message}`);
  process.exit(1);
}
