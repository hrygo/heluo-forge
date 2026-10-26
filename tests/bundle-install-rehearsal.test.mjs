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
// Installation layout (desktop ASAR or Node CLI) and runtime profile are
// independent. Exercise both built-in profiles for whichever host was selected.
const profiles = process.env.DSH_HOST_PROBE_PROFILE ? [process.env.DSH_HOST_PROBE_PROFILE] : ['sdk', 'web'];

for (const profile of profiles) {
  test(`the bundle install/upgrade/uninstall/rollback rehearsal passes (${profile})`, { skip, timeout: 300_000 }, () => {
    const output = execFileSync(process.execPath, [script], {
      encoding: 'utf8', timeout: 240_000, env: { ...process.env, DSH_HOST_PROBE_PROFILE: profile },
    });
    assert.match(output, /install-v1-with-patch-and-workspace-intact/);
    assert.match(output, /installed-patch-disables-official-rows/);
    assert.match(output, /installed-bin-is-executable/);
    assert.match(output, /installed-final-tarball-closure/);
    assert.match(output, /install-real-loader-instantiates-members/);
    assert.match(output, /legacy-sdd-plugin-mount-is-rejected/);
    assert.match(output, /upgrade-real-loader-instantiates-members/);
    assert.match(output, /rollback-real-loader-instantiates-members/);
    assert.match(output, /rollback-loader-unload-clears-registrations/);
    assert.match(output, /installed-real-cli-freeze-verify-and-reject-tamper/);
    assert.match(output, /rollback-to-0\.1\.0-keeps-composition-and-workspace/);
    assert.match(output, /uninstall-removes-packages-and-keeps-workspace/);
    assert.match(output, /repository-working-tree-untouched/);
    assert.match(output, /\d+\/\d+ steps ok/);
    assert.doesNotMatch(output, /^FAIL /mu);
  });
}
