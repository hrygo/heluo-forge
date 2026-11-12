import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const probe = fileURLToPath(new URL('../scripts/probe/installed-credential-smoke.mjs', import.meta.url));
const packageDir = fileURLToPath(new URL('../packages/forge-credentials-keychain', import.meta.url));

test('installed credential smoke checks a synthetic SQLite round trip', () => {
  const result = spawnSync(process.execPath, [probe, packageDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synthetic SQLite round trip passed/u);
});

test('installed credential smoke rejects a missing package', () => {
  const result = spawnSync(process.execPath, [probe, `${packageDir}/missing`], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
