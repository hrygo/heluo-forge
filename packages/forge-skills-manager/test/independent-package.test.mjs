import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the package owns its mount row and has no enterprise or IAM package dependency', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  const source = await readFile(join(root, 'src', 'index.ts'), 'utf8');

  assert.equal(manifest.name, '@heluo/forge-skills-manager');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dependencies, undefined);
  assert.match(patch, /id: heluo-skills-manager\n\s+name: '@heluo\/forge-skills-manager'/u);
  assert.match(source, /export const inject = \['connection', 'skills', 'sessions'\]/u);
  assert.doesNotMatch(source, /forge-enterprise|forge-iam/u);
});
