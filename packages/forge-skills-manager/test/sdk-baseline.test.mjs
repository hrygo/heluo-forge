import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkDevelopmentSdk, verifyDevelopmentSdk } from '../scripts/check-sdk.mjs';

const baseline = readFileSync(new URL('../../../.dsh-version', import.meta.url), 'utf8').trim();

test('plugin development SDK pins follow the root baseline and reject other release lines and ranges', () => {
  assert.deepEqual(checkDevelopmentSdk({
    devDependencies: { '@deepseek-ai/dsh-skill': baseline, 'unrelated-library': '1.0.0' },
  }, baseline), []);
  const [major, minor, patch] = baseline.split('.');
  for (const version of [major + '.' + minor + '.' + (Number.parseInt(patch) + 1), major + '.' + (Number(minor) + 1) + '.0', '^' + baseline]) {
    const problems = checkDevelopmentSdk({ devDependencies: { '@deepseek-ai/dsh-skill': version } }, baseline);
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes('@deepseek-ai/dsh-skill'));
  }
});

test('plugin verification reads its own manifest and the root baseline without checking other packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-sdk-baseline-'));
  const plugin = join(root, 'packages', 'fixture');
  const sibling = join(root, 'packages', 'unrelated');
  try {
    mkdirSync(plugin, { recursive: true });
    mkdirSync(sibling);
    writeFileSync(join(root, '.dsh-version'), baseline + '\n');
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ devDependencies: { '@deepseek-ai/dsh-skill': baseline } }));
    writeFileSync(join(sibling, 'package.json'), JSON.stringify({ devDependencies: { '@deepseek-ai/dsh-skill': 'different' } }));
    assert.doesNotThrow(() => verifyDevelopmentSdk(plugin));
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ devDependencies: { '@deepseek-ai/dsh-skill': 'different' } }));
    assert.throws(() => verifyDevelopmentSdk(plugin), /development SDK pins/);
    writeFileSync(join(plugin, 'package.json'), '{');
    assert.throws(() => verifyDevelopmentSdk(plugin), SyntaxError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
