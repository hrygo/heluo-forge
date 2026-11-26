import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildPlugin, packageRoot } from '../scripts/build.mjs';
import { normalizeDependencyIds } from '../scripts/build-identities.mjs';

test('P2 shipped notices contain every bundled Markdown and ZIP dependency license', async () => {
  const notice = await readFile(join(packageRoot, 'lib', 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  for (const id of ['react-markdown@10.1.0', 'remark-gfm@4.0.1', 'yauzl@3.4.0', 'pend@1.2.0', 'micromark@', 'mdast-util-to-hast@']) assert.ok(notice.includes(id), id);
  assert.match(notice, /Permission is hereby granted/);
  assert.match(notice, /Titus Wormer/);
  assert.doesNotMatch(notice, /fflate@|react@18/);
});

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
    const reader = await readFile(createRequire(import.meta.url).resolve('yauzl'), 'utf8');
    const emitted = await readFile(join(baseline, 'zip.js'), 'utf8');
    const table = source => runInNewContext('(' + source.match(/var cp437 = ([^\r\n]+);/u)[1] + ')');
    assert.equal(table(emitted), table(reader), 'emitted CP437 expression preserves every character');
    assert.match(emitted, /Copyright \(c\) 2014 Josh Wolfe/u);
    assert.match(emitted, /Copyright \(c\) 2014 Andrew Kelley/u);
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
