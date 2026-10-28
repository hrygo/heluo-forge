#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitOutput, repoRoot } from './lib.mjs';

const MARKER = '# managed by scripts/sensitive-scan/install-hook.mjs';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Pin the Node executable used at install time. On Windows this avoids
// depending on how Git Bash inherits PATH; the path is converted to MSYS form.
const NODE = shellQuote(process.execPath.replace(/\\/g, '/'));
const SHIM = `#!/bin/sh
${MARKER}
exec ${NODE} "$(git rev-parse --show-toplevel)/scripts/sensitive-scan/commit-msg.mjs" "$1"
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
