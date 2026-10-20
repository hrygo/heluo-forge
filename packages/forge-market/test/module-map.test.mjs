import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const here = join(root, 'packages/forge-market');

test('the module map in DESIGN-007 matches the package on disk', async () => {
  const doc = await readFile(join(root, 'docs/design/plugins/forge-market.md'), 'utf8');
  const block = doc.slice(doc.indexOf('```text\npackages/forge-market/'), doc.indexOf('```', doc.indexOf('```text\npackages/forge-market/') + 10));
  const listed = [...block.matchAll(/(?:├──|│   ├──|│   └──|└──)\s+([A-Za-z0-9._-]+)/g)].map((match) => match[1]);

  const actual = new Set(await readdir(join(here, 'src')));
  const documentedSrc = new Set(listed.filter((name) => name.endsWith('.mjs')));
  assert.deepEqual([...documentedSrc].sort(), [...actual].sort(), 'design and src disagree');

  for (const file of ['cordis.patch.yml', 'client.js']) {
    await readFile(join(here, file));
    assert.ok(listed.includes(file), `${file} is missing from the module map`);
  }
});
