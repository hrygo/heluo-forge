import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'probe', 'run-bundle-install-rehearsal.mjs');
const dsh = process.env.DSH_BIN ?? 'dsh';
const dshReady = spawnSync(dsh, ['--version'], { encoding: 'utf8' }).status === 0;
const enabled = process.env.DSH_INSTALL_REHEARSAL !== '0';
const skip = dshReady && enabled ? false : `needs ${dsh} on PATH and npm (or DSH_INSTALL_REHEARSAL=0)`;

test('the bundle install/upgrade/uninstall/rollback rehearsal passes', { skip, timeout: 300_000 }, () => {
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 240_000 });
  assert.match(output, /install-v1-with-patch-and-workspace-intact/);
  assert.match(output, /installed-patch-disables-official-rows/);
  assert.match(output, /installed-bin-is-executable/);
  assert.match(output, /rollback-to-0\.1\.0-keeps-composition-and-workspace/);
  assert.match(output, /uninstall-removes-packages-and-keeps-workspace/);
  assert.match(output, /repository-working-tree-untouched/);
  assert.match(output, /\d+\/\d+ steps ok/);
  assert.doesNotMatch(output, /^FAIL /mu);
});
