import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { slugify, unfenced } from '../../../scripts/lib/doc-rules.mjs';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(join(here, file), 'utf8');

test('the manifest declares the repository package contract', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, '@heluo/forge-iam');
  assert.equal(manifest.private, true);
  assert.ok(manifest.engines.dsh);
  assert.ok(manifest.scripts.test);
  await access(join(here, manifest.main));
  for (const file of manifest.files.filter((entry) => entry.includes('.'))) {
    await access(join(here, file));
  }
});

test('the package README claims only the development skeleton', async () => {
  const text = await read('README.md');
  assert.match(text, /状态：可用（开发骨架/);
  assert.match(text, /真实 IAM 未联调/);
  assert.doesNotMatch(text, /已联调/);
});

test('the reader guides ship with the package and have valid local links, headings and tables', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.ok(manifest.files.includes('docs'), 'the guides must be in the packed artifact');
  for (const file of ['README.md', 'docs/user-guide.md', 'docs/developer-guide.md']) {
    const lines = unfenced(await read(file));
    assert.equal(lines.filter((line) => /^#\s/.test(line)).length, 1, file);
    let width = null;
    for (const line of lines) {
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const count = line.trim().slice(1, -1).split(/(?<!\\)\|/).length;
        if (width !== null) assert.equal(count, width, `${file}: table column count`);
        width = count;
      } else width = null;
    }
    for (const match of lines.join('\n').matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)\s*\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^https?:/i.test(target)) continue;
      assert.doesNotMatch(target, /^[a-z][a-z0-9+.-]*:/i, 'no machine-specific links');
      const [path, fragment] = target.split('#');
      const full = path ? resolve(here, dirname(file), decodeURIComponent(path)) : join(here, file);
      const packaged = relative(here, full).split(sep).join('/');
      assert.ok(!packaged.startsWith('../') && manifest.files.some((entry) => packaged === entry || packaged.startsWith(`${entry}/`)), `${file}: ${target} must resolve within the artifact`);
      await access(full);
      if (fragment) {
        const headings = new Set();
        const counts = new Map();
        for (const line of unfenced(await readFile(full, 'utf8'))) {
          const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
          if (!heading) continue;
          const slug = slugify(heading[1]);
          const n = counts.get(slug) ?? 0;
          headings.add(n ? `${slug}-${n}` : slug);
          counts.set(slug, n + 1);
        }
        assert.ok(headings.has(decodeURIComponent(fragment)), `${file}: unknown anchor ${target}`);
      }
    }
  }
});

test('the source never imports a DSH runtime just to load the skeleton', async () => {
  const source = await read('src/index.mjs');
  assert.doesNotMatch(source, /from '@deepseek-ai\//);
  assert.match(source, /ctx\.provide\('iam'/);
});
test('the packaged icon is the pre-designed brand symbol, not a redrawn copy', async () => {
  // Provenance rule: packages ship the brand kit's symbol verbatim so the
  // plugin surface and the design assets cannot drift apart.
  const icon = await read('icon.svg');
  const branded = await readFile(join(
    here, '..', '..', 'docs', 'assets', 'branding', 'cyber-long', 'components', 'forge-iam-symbol.svg',
  ), 'utf8');
  assert.equal(icon, branded);
  assert.match(icon, /<svg[^>]+viewBox="0 0 320 320"/);
  assert.ok(Buffer.byteLength(icon) <= 256 * 1024);
});
