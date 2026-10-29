#!/usr/bin/env node
import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
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
  try {
    // Exclusive creation prevents an existing hook, including a dangling symlink,
    // from being replaced between an existence check and the write.
    const fd = openSync(target, 'wx', 0o755);
    try {
      writeFileSync(fd, SHIM);
      fchmodSync(fd, 0o755);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!lstatSync(target).isFile() || readFileSync(target, 'utf8') !== SHIM) {
      throw new Error(`refusing to overwrite existing commit-msg hook: ${target}`);
    }
  }
  console.log(`sensitive-scan: installed ${target}`);
  console.log('legacy v1 hook installed; it cannot satisfy the team v2 remote check. Use TEAM-FULL-INSTALL.md for the team hook.');
} catch (error) {
  console.error(`sensitive-scan install-hook: ${error.message}`);
  process.exit(1);
}
