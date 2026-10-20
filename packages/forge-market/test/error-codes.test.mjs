import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('every validation code is documented in DESIGN-012 §5.1', async () => {
  const source = await readFile(join(root, 'packages/forge-market/src/validate.mjs'), 'utf8');
  const doc = await readFile(join(root, 'docs/design/services/market-index.md'), 'utf8');
  const section = doc.slice(doc.indexOf('### 5.1'), doc.indexOf('## 6.'));

  const emitted = [...source.matchAll(/code: '([a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(emitted.length >= 10, 'expected the validator to emit its codes');
  const missing = [...new Set(emitted)].filter((code) => !section.includes(`\`${code}\``));
  assert.deepEqual(missing, [], `undocumented codes: ${missing.join(', ')}`);
});
