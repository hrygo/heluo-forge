import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every policy export is either wired or listed as unwired', async () => {
  const source = await readFile(join(here, 'src', 'policy.mjs'), 'utf8');
  const exports = [...source.matchAll(/export (?:async )?function (\w+)/g)].map((match) => match[1]);
  assert.ok(exports.length >= 5, `expected policy exports, saw ${exports.length}`);

  const others = await readdir(join(here, 'src'));
  let text = '';
  for (const file of others) {
    if (file === 'policy.mjs') continue;
    text += await readFile(join(here, 'src', file), 'utf8');
  }
  const wired = new Set(exports.filter((name) => new RegExp(`\\b${name}\\b`).test(text)));

  const design = await readFile(join(here, '..', '..', 'docs', 'design', 'plugins', 'forge-market.md'), 'utf8');
  const section = design.slice(design.indexOf('### 8.2'), design.indexOf('## 9. 权限与安全'));
  const declared = new Set([...section.matchAll(/^\| `(\w+)` \| \*\*未接线\*\* \|/gm)].map((match) => match[1]));

  const unwired = exports.filter((name) => !wired.has(name));
  assert.deepEqual([...unwired].sort(), [...declared].sort(), `unwired policy exports must be documented in DESIGN-007 §8.2`);
});
