import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistFiles } from '../src/persist.mjs';

test('writes files under the target directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-market-'));
  try {
    const result = await persistFiles([
      { path: 'package.json', bytes: Buffer.from('{}') },
      { path: 'src/index.mjs', bytes: Buffer.from('export {};') },
    ], root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.written, ['package.json', 'src/index.mjs']);
    assert.equal(await readFile(join(root, 'src/index.mjs'), 'utf8'), 'export {};');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to escape the target directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-market-'));
  try {
    const result = await persistFiles([{ path: '../escape', bytes: Buffer.from('x') }], root);
    assert.equal(result.reason, 'outside-target');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires a target directory', async () => {
  assert.equal((await persistFiles([], '')).reason, 'no-target');
});
