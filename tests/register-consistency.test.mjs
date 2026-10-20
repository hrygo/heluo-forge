import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every register row carries the version its document declares', async () => {
  const register = await readFile(join(root, 'docs/DOCUMENT-REGISTER.md'), 'utf8');
  const rows = [...register.matchAll(/\[([^\]]+)\]\(<?([^)>]+)>?\)\s*\|\s*(V[\d.]+)\s*\|/g)];
  assert.ok(rows.length >= 8, `expected register rows, saw ${rows.length}`);
  const drift = [];
  for (const [, , path, listed] of rows) {
    if (!path.endsWith('.md')) continue;
    let text;
    try {
      text = await readFile(join(root, 'docs', path), 'utf8');
    } catch {
      continue; // 同目录链接由 check-docs 负责，这里只比版本。
    }
    const declared = /\|\s*版\s*本\s*\|\s*(V[\d.]+)\s*\|/.exec(text)?.[1];
    if (declared && declared !== listed) drift.push(`${path}: 登记 ${listed} / 文档 ${declared}`);
  }
  assert.deepEqual(drift, [], `version drift:\n${drift.join('\n')}`);
});
