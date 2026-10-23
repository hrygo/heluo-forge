import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, '..', 'scripts', 'probe', 'run-keychain-spike.mjs');
const canRun = process.platform === 'darwin' && existsSync('/usr/bin/security') && process.env.DSH_KEYCHAIN_SPIKE !== '0';

test('the macOS keychain spike passes on a real system keychain', { skip: canRun ? false : 'needs darwin + /usr/bin/security (or DSH_KEYCHAIN_SPIKE=0)' }, () => {
  const output = execFileSync(process.execPath, [spike], { encoding: 'utf8', timeout: 120_000 });
  assert.match(output, /security-cli-available/);
  assert.match(output, /no-plaintext-in-files/);
  assert.match(output, /cleanup-verified/);
  assert.match(output, /\d+\/\d+ steps ok/);
  assert.doesNotMatch(output, /^FAIL /mu);
});
