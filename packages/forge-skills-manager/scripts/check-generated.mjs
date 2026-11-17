import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildPlugin, packageRoot } from './build.mjs';

async function inventory(root, dir = root) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) files.push(...await inventory(root, path));
    else files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files.sort();
}

const temporary = await mkdtemp(join(tmpdir(), 'forge-skills-generated-'));
try {
  await buildPlugin(temporary);
  const tracked = join(packageRoot, 'lib');
  const generated = await inventory(temporary);
  assert.deepEqual(await inventory(tracked), generated, 'generated file list differs; rebuild plugin');
  for (const file of generated) {
    const normalize = bytes => bytes.toString('utf8').replaceAll('\r\n', '\n');
    const digest = bytes => createHash('sha256').update(normalize(bytes)).digest('hex');
    assert.equal(digest(await readFile(join(tracked, file))), digest(await readFile(join(temporary, file))), `${file} differs; rebuild plugin`);
  }
  console.log(`forge-skills-manager: ${generated.length} generated files match source`);
} finally { await rm(temporary, { recursive: true, force: true }); }
