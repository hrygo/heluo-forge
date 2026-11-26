import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parsePatchLayer } from '../scripts/lib/bundle-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'probe', 'run-bundle-install-rehearsal.mjs');
const dsh = process.env.DSH_BIN ?? 'dsh';
const dshReady = spawnSync(dsh, ['--version'], { encoding: 'utf8' }).status === 0;
const enabled = process.env.DSH_INSTALL_REHEARSAL !== '0';
const skip = dshReady && enabled ? false : `needs ${dsh} on PATH and npm (or DSH_INSTALL_REHEARSAL=0)`;
// Installation layout (desktop ASAR or Node CLI) and runtime profile are
// independent. Exercise both built-in profiles for whichever host was selected.
const profiles = process.env.DSH_HOST_PROBE_PROFILE ? [process.env.DSH_HOST_PROBE_PROFILE] : ['sdk', 'web'];

test('rehearsal evidence does not claim production storage verification', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /storage: 'synthetic fixture; production storage not verified'/u);
});

test('rehearsal composition checks retain brand and skills and reject missing or duplicate members', () => {
  const source = readFileSync(script, 'utf8');
  const start = source.indexOf('    record(\n      `${label}-patch-mounts-base-and-overlay`');
  const end = source.indexOf('    const phases = [];', start);
  assert.ok(start >= 0 && end > start, 'the actual rehearsal composition checks must be located');
  const checks = source.slice(start, end);
  const base = parsePatchLayer(readFileSync(join(here, '..', 'packages', 'forge-enterprise', 'cordis.patch.yml'), 'utf8'));
  const engineering = parsePatchLayer(readFileSync(join(here, '..', 'packages', 'forge-engineering', 'cordis.patch.yml'), 'utf8'));
  const manager = parsePatchLayer(readFileSync(join(here, '..', 'packages', 'forge-skills-manager', 'cordis.patch.yml'), 'utf8'));
  const merged = [...new Map([...base.inserted, ...engineering.inserted, ...manager.inserted].map((row) => [row.id, row])).values()];
  const evaluate = (baseRows, rows) => {
    const results = [];
    runInNewContext(checks, {
      label: 'test', patch: { inserted: rows }, resolved: rows,
      enterprisePatch: { inserted: baseRows }, engineeringPatch: engineering, skillsManagerPatch: manager,
      record: (id, ok) => results.push(ok),
    });
    return results;
  };
  assert.deepEqual(evaluate(base.inserted, merged), [true, true]);
  assert.deepEqual(evaluate(base.inserted.filter((row) => row.id !== 'heluo-brand'), merged.filter((row) => row.id !== 'heluo-brand')), [false, false]);
  assert.equal(evaluate(base.inserted, merged.filter((row) => row.id !== 'heluo-skills-manager'))[0], false);
  assert.equal(evaluate([...base.inserted, ...manager.inserted], merged)[1], false, 'manager must not re-enter enterprise patch');
  assert.equal(evaluate(base.inserted, [...merged.slice(0, -1), merged[0]])[0], false);
  assert.equal(evaluate([...base.inserted, engineering.inserted.find((row) => row.id === 'heluo-gitee')], merged)[1], false);
  assert.equal(evaluate(base.inserted, merged.slice(0, -1))[0], false);
});

for (const profile of profiles) {
  test(`the bundle install/upgrade/uninstall/rollback rehearsal passes (${profile})`, { skip, timeout: 300_000 }, () => {
    const output = execFileSync(process.execPath, [script], {
      encoding: 'utf8', timeout: 240_000, env: { ...process.env, DSH_HOST_PROBE_PROFILE: profile },
    });
    assert.match(output, /install-v1-with-patch-and-workspace-intact/);
    assert.match(output, /installed-patch-disables-official-rows/);
    assert.match(output, /installed-final-tarball-closure/);
    assert.match(output, /installed-iam-client-secret-provision/);
    // 底座四行 + 研发独占四行 + 独立管理器一行。
    assert.match(output, /install-patch-mounts-base-and-overlay/);
    assert.match(output, /install-real-loader-instantiates-members/);
    assert.match(output, /installed-skill-candidate-shape/);
    assert.match(output, /installed-skill-get-by-candidate/);
    assert.match(output, /installed-patch-independent-manager-and-policy-union/);
    assert.match(output, /install-independent-skills-manager-shares-iam-host/);
    assert.match(output, /install-loader-unload-clears-skill-providers/);
    assert.match(output, /legacy-sdd-member-retired/);
    assert.match(output, /upgrade-real-loader-instantiates-members/);
    assert.match(output, /rollback-real-loader-instantiates-members/);
    assert.match(output, /rollback-loader-unload-clears-registrations/);
    assert.match(output, /install-services-queryable/);
    assert.match(output, /rollback-services-queryable/);
    assert.match(output, /rollback-to-0\.1\.0-keeps-composition-and-workspace/);
    assert.match(output, /uninstall-removes-packages-and-keeps-workspace/);
    assert.match(output, /repository-working-tree-untouched/);
    assert.match(output, /\d+\/\d+ steps ok/);
    assert.doesNotMatch(output, /^FAIL /mu);
  });
}
