import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildPlugin, packageRoot } from '../scripts/build.mjs';
import { normalizeDependencyIds } from '../scripts/build-identities.mjs';

test('dependency normalization changes wrapper identities and preserves application strings', () => {
  const source = 'var dependency = __commonJS({"D:/fixture/node_modules/.pnpm/extend@3/node_modules/extend/index.js"(exports) {}}); const text = "D:/fixture/node_modules/keep";';
  const result = normalizeDependencyIds(source);
  assert.ok(result.includes('"node_modules/extend/index.js"'));
  assert.ok(result.includes('const text = "D:/fixture/node_modules/keep"'));
});

test('build output is identical with dependencies linked from another checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-build-layout-'));
  const relocated = join(directory, 'relocated');
  try {
    await mkdir(relocated);
    await cp(join(packageRoot, 'package.json'), join(relocated, 'package.json'));
    await cp(join(packageRoot, 'tsconfig.json'), join(relocated, 'tsconfig.json'));
    await cp(join(packageRoot, 'src'), join(relocated, 'src'), { recursive: true });
    await symlink(join(packageRoot, 'node_modules'), join(relocated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const baseline = join(directory, 'baseline');
    const rebuilt = join(directory, 'rebuilt');
    await buildPlugin(baseline);
    await buildPlugin(rebuilt, relocated);
    const files = (await readdir(baseline)).sort();
    assert.deepEqual((await readdir(rebuilt)).sort(), files);
    for (const file of files) {
      const original = await readFile(join(baseline, file), 'utf8');
      const relocatedText = await readFile(join(rebuilt, file), 'utf8');
      const originalLines = original.split('\n');
      const relocatedLines = relocatedText.split('\n');
      const difference = originalLines.findIndex((line, index) => line !== relocatedLines[index]);
      const digest = text => createHash('sha256').update(text).digest('hex');
      assert.equal(digest(original), digest(relocatedText), `${file}:${difference + 1}: ${originalLines[difference]} != ${relocatedLines[difference]}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
