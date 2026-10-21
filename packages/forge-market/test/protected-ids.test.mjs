import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('the protected row ids match DESIGN-007 附录 A.6', async () => {
  const source = await readFile(join(root, 'packages/forge-market/src/validate.mjs'), 'utf8');
  const listed = /const PROTECTED_IDS = \[([^\]]+)\]/.exec(source);
  assert.ok(listed, 'expected a PROTECTED_IDS list');
  const ids = [...listed[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(ids.length >= 3);

  const doc = await readFile(join(root, 'docs/design/plugins/forge-market.md'), 'utf8');
  const section = doc.slice(doc.indexOf('### A.6'), doc.indexOf('### A.7'));
  const missing = ids.filter((id) => !section.includes(`\`${id}\``));
  assert.deepEqual(missing, [], `undocumented protected ids: ${missing.join(', ')}`);
});
