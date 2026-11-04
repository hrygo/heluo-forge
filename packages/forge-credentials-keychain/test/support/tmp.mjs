// Tests that mount a plaintext file backend must not assume the ambient temp
// directory is outside a Git work tree: a machine can have /tmp inside one, and
// pnpm can point TMPDIR into node_modules. Pick a base that is provably outside
// any work tree, or fail loudly instead of asserting the wrong behavior.

import { existsSync, mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function insideRepository(base) {
  let current = resolve(base);
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function outsideRepositoryTmp(prefix = 'forge-keychain-') {
  const bases = [tmpdir(), process.platform === 'win32' ? undefined : '/var/tmp'].filter(Boolean);
  for (const base of bases) {
    if (insideRepository(base)) continue;
    try {
      return mkdtempSync(join(base, prefix));
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('no temporary base outside a Git work tree');
}

export async function outsideRepositoryTmpAsync(prefix = 'forge-keychain-') {
  const bases = [tmpdir(), process.platform === 'win32' ? undefined : '/var/tmp'].filter(Boolean);
  for (const base of bases) {
    if (insideRepository(base)) continue;
    try {
      return await mkdtemp(join(base, prefix));
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('no temporary base outside a Git work tree');
}
