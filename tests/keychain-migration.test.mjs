import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const probe = join(here, '..', 'scripts', 'probe', 'run-keychain-migration-rehearsal.mjs');

test('legacy migration remains blocked without touching the fixture or target', { timeout: 30_000 }, () => {
  const output = execFileSync(process.execPath, [probe], { encoding: 'utf8', timeout: 20_000 });
  assert.match(output, /ok migration-blocked-no-access/);
  assert.match(output, /BLOCKED: actual migration/);
  assert.doesNotMatch(output, /^FAIL /mu);
});
