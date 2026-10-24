import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const probe = join(here, '..', 'scripts', 'probe', 'run-keychain-migration-rehearsal.mjs');
const canRun = process.platform === 'darwin' && existsSync('/usr/bin/security') && process.env.DSH_KEYCHAIN_MIGRATION !== '0';

test('the 0600 → keychain migration rehearsal passes on a real keychain', { skip: canRun ? false : 'needs darwin + /usr/bin/security (or DSH_KEYCHAIN_MIGRATION=0)', timeout: 120_000 }, () => {
  const output = execFileSync(process.execPath, [probe], { encoding: 'utf8', timeout: 90_000 });
  assert.match(output, /migrate-then-delete-legacy/);
  assert.match(output, /unavailable-keychain-fails-closed/);
  assert.match(output, /read-back-mismatch-stops-and-keeps-legacy/);
  assert.match(output, /target-conflict-does-not-overwrite/);
  assert.match(output, /cleanup-verified/);
  assert.match(output, /\d+\/\d+ steps ok/);
  assert.doesNotMatch(output, /^FAIL /mu);
});
