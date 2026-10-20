import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('every failure reason is documented in DESIGN-007 §8.1', async () => {
  const src = join(root, 'packages/forge-market/src');
  const files = (await readdir(src)).filter((name) => name.endsWith('.mjs'));
  const emitted = new Set();
  for (const file of files) {
    const text = await readFile(join(src, file), 'utf8');
    for (const match of text.matchAll(/reason: '([a-z-]+)'/g)) emitted.add(match[1]);
  }
  assert.ok(emitted.size >= 40, `expected a broad reason space, saw ${emitted.size}`);

  const doc = await readFile(join(root, 'docs/design/plugins/forge-market.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## 8.1'), doc.indexOf('## 9. 权限与安全'));
  const missing = [...emitted].filter((reason) => !section.includes(`\`${reason}\``));
  assert.deepEqual(missing.sort(), [], `undocumented reasons: ${missing.join(', ')}`);
});
