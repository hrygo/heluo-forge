import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from '../src/validate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('this package passes its own format validation', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');

  const result = validatePlugin(
    {
      files: ['package.json', 'README.md', 'cordis.patch.yml'],
      manifest,
      readme,
      patch,
      tag: `v${manifest.version}`,
    },
    { allowedScopes: ['@heluo'] },
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});
