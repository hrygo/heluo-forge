import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { createPortablePathSet, isMacSystemDirectoryAlias, isPortableFileSegment, isSafeAncestorDirectory, portablePathKey } from '../lib/filesystem-paths.js';
import { checkedRepositoryRootDefinition, importUploadedSkill, userRoots } from '../lib/core.js';
import { readSkillTree } from '../lib/installation-records.js';
import { createNacosClient } from '../lib/nacos.js';
import { fakeNacos, nacosConfig, skillDocument, useNacosEnvironment } from '../spec/fixtures/nacos.mjs';

const invalidSegments = ['report:notes.txt', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'trailing.', 'trailing ', 'control\x01.txt', 'NUL.txt', 'COM1', 'LPT9.log', 'COM¹.txt', 'LPT².txt'];
const encoded = value => Buffer.from(value).toString('base64');

async function isolatedHome(context) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-portable-paths-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, 'dsh');
  context.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('portable filenames reject Windows special names on every platform', () => {
  for (const segment of [...invalidSegments, '', '.', '..', 'a\\b', 'a/b', 'nul']) {
    assert.equal(isPortableFileSegment(segment), false, JSON.stringify(segment));
  }
  for (const segment of ['SKILL.md', '中文模板.md', 'café.txt', 'safe name.txt', 'console.txt', '.hidden']) {
    assert.equal(isPortableFileSegment(segment), true, segment);
  }
  assert.equal(portablePathKey('templates/Café.txt'), portablePathKey('templates/cafe\u0301.txt'));
});

test('portable paths reject directory spelling aliases even when child filenames differ', () => {
  for (const names of [['Café/one.txt', 'cafe\u0301/two.txt'], ['Templates/one.txt', 'templates/two.txt']]) {
    const paths = createPortablePathSet();
    assert.equal(paths.add(names[0]), true);
    assert.equal(paths.add(names[1]), false);
  }
  const paths = createPortablePathSet();
  assert.equal(paths.add('templates/one.txt'), true);
  assert.equal(paths.add('templates'), true);
  assert.equal(paths.add('templates/two.txt'), true);
  assert.equal(paths.add('templates/one.txt'), false);
});

test('only fixed macOS system aliases qualify, including relative system targets', () => {
  for (const alias of ['/tmp', '/var', '/etc']) {
    assert.equal(isMacSystemDirectoryAlias(alias, '/private' + alias, 'darwin'), true);
    assert.equal(isMacSystemDirectoryAlias(alias, 'private' + alias, 'darwin'), true);
    for (const platform of ['win32', 'linux']) {
      assert.equal(isMacSystemDirectoryAlias(alias, '/private' + alias, platform), false);
    }
    assert.equal(isMacSystemDirectoryAlias(alias, '/outside' + alias, 'darwin'), false);
    assert.equal(isMacSystemDirectoryAlias(alias, '/private/linked/..' + alias, 'darwin'), false);
  }
  for (const alias of ['/tmp/skills', '/var/user', '/opt/skills/link', '/private/tmp', '/tmp/../tmp']) {
    assert.equal(isMacSystemDirectoryAlias(alias, '/private/tmp', 'darwin'), false);
  }
});

test('synthetic macOS ancestor checks accept directory aliases and reject redirected or non-directory targets', async context => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  context.after(() => Object.defineProperty(process, 'platform', descriptor));
  const link = { isSymbolicLink: () => true, isDirectory: () => false };
  const readlink = context.mock.method(fs, 'readlink', async () => 'private/var');
  const stat = context.mock.method(fs, 'stat', async () => ({ isDirectory: () => true }));
  assert.equal(await isSafeAncestorDirectory('/var', link), true);
  readlink.mock.mockImplementation(async () => '/outside');
  assert.equal(await isSafeAncestorDirectory('/var', link), false);
  readlink.mock.mockImplementation(async () => '/private/var');
  stat.mock.mockImplementation(async () => ({ isDirectory: () => false }));
  assert.equal(await isSafeAncestorDirectory('/var', link), false);
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  readlink.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(isSafeAncestorDirectory('/var', link), caught => caught === failure);
});

test('uploads reject non-portable resource paths before installing folders or ZIPs', async context => {
  await isolatedHome(context);
  for (const segment of invalidSegments) {
    const files = { 'SKILL.md': skillDocument('portable-rejected'), ['templates/' + segment]: 'payload' };
    const entries = Object.entries(files).map(([path, data]) => ({ path, data: encoded(data) }));
    for (const input of [{ entries }, { zip: encoded(zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, strToU8(data)])))) }]) {
      const result = await importUploadedSkill({ name: 'portable-rejected', ...input });
      assert.equal(result.ok, false, segment);
      assert.equal(result.code, 'error.upload.path', segment);
    }
  }
  await assert.rejects(fs.stat(join(process.env.DSH_HOME, 'skills', 'portable-rejected')), { code: 'ENOENT' });
});

test('uploads reject case and Unicode equivalent resource paths in folders and ZIPs', async context => {
  await isolatedHome(context);
  for (const names of [['Café.txt', 'cafe\u0301.txt'], ['same.txt', 'SAME.txt'], ['Café/one.txt', 'cafe\u0301/two.txt']]) {
    const files = { 'SKILL.md': skillDocument('portable-duplicate'), ['templates/' + names[0]]: 'first', ['templates/' + names[1]]: 'second' };
    const entries = Object.entries(files).map(([path, data]) => ({ path, data: encoded(data) }));
    const zip = encoded(zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, strToU8(data)]))));
    for (const input of [{ entries }, { zip }]) {
      const result = await importUploadedSkill({ name: 'portable-duplicate', ...input });
      assert.equal(result.code, 'error.upload.duplicate');
    }
  }
  await assert.rejects(fs.stat(join(process.env.DSH_HOME, 'skills', 'portable-duplicate')), { code: 'ENOENT' });
});

test('portable uploads retain resource bytes and accept browser Windows separators', async context => {
  await isolatedHome(context);
  const entries = [
    { path: 'SKILL.md', data: encoded(skillDocument('portable-valid')) },
    { path: 'templates\\中文模板.md', data: encoded('template') },
    { path: 'scripts/run.sh', data: encoded('#!/bin/sh\nprintf hello\n') },
    { path: 'references/cafe\u0301.txt', data: encoded('unicode') },
  ];
  const result = await importUploadedSkill({ name: 'portable-valid', entries });
  assert.equal(result.imported.length, 1);
  const root = join(process.env.DSH_HOME, 'skills', 'portable-valid');
  assert.equal(await fs.readFile(join(root, 'templates', '中文模板.md'), 'utf8'), 'template');
  assert.equal(await fs.readFile(join(root, 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh\nprintf hello\n');
  assert.equal(await fs.readFile(join(root, 'references', 'cafe\u0301.txt'), 'utf8'), 'unicode');
  assert.equal(Object.keys(await readSkillTree(root)).length, entries.length);
});

test('Nacos archives reject portable filename and Unicode collisions before exposing a package', async context => {
  useNacosEnvironment(context);
  const fixture = fakeNacos();
  const client = createNacosClient(nacosConfig, fixture.fetcher);
  const selected = { skillName: fixture.state.name, version: fixture.state.version };
  for (const names of [...invalidSegments.map(name => [name]), ['Café.txt', 'cafe\u0301.txt'], ['Café/one.txt', 'cafe\u0301/two.txt']]) {
    fixture.state.bytes = zipSync({
      'example-skill/SKILL.md': strToU8(skillDocument('example-skill')),
      ...Object.fromEntries(names.map(name => ['example-skill/templates/' + name, strToU8('payload')])),
    });
    await assert.rejects(client.load(selected), { code: 'error.nacos.package' });
  }
  fixture.state.bytes = zipSync({
    'example-skill/SKILL.md': strToU8(skillDocument('example-skill')),
    'example-skill/templates/中文.md': strToU8('payload'),
  });
  const loaded = await client.load(selected);
  assert.ok(loaded.pack.entries.some(entry => entry.path === 'templates/中文.md'));
});

test('ordinary ancestor junctions remain forbidden for installation and record reads', async context => {
  const directory = await isolatedHome(context);
  const physical = join(directory, 'physical');
  const alias = join(directory, 'alias');
  await fs.mkdir(join(physical, 'skills', 'example-skill'), { recursive: true });
  await fs.writeFile(join(physical, 'skills', 'example-skill', 'SKILL.md'), skillDocument('example-skill'));
  await fs.symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  process.env.DSH_HOME = alias;
  const checked = await checkedRepositoryRootDefinition(userRoots().find(root => root.key === 'dsh'));
  assert.equal(checked.code, 'error.root.unsafe');
  await assert.rejects(readSkillTree(join(alias, 'skills', 'example-skill')), { code: 'error.repo.invalid' });
  assert.equal(await fs.readFile(join(physical, 'skills', 'example-skill', 'SKILL.md'), 'utf8'), skillDocument('example-skill'));
});
