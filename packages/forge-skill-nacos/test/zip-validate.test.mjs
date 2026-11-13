import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REASONS } from '../src/errors.mjs';
import { readZip } from '../src/zip.mjs';
import { safeSegments, validateAndExtract } from '../src/validate.mjs';
import { buildZip, skillMd, skillPackage } from './helpers.mjs';

/** 接收 thunk：readZip 同步抛错也必须被收进断言。 */
const expectCode = async (thunk, code) => {
  try {
    await thunk();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code, error.message);
    return error;
  }
};

const extract = (zip, options = {}) => validateAndExtract(zip, {
  expectedName: options.expectedName ?? 'demo-skill',
  expectedVersion: options.expectedVersion ?? '1.0.0',
  targetDir: options.targetDir,
});

test('path safety rejects traversal, absolute, backslash and drive letters', () => {
  for (const bad of ['../escape.md', 'a/../../escape.md', '/etc/passwd', 'C:/x.md', 'a\\b.md']) {
    assert.throws(() => safeSegments(bad), (error) => error.code === REASONS.PATH_ESCAPE, bad);
  }
  assert.deepEqual(safeSegments('a/./b/c.md'), ['a', 'b', 'c.md']);
});

test('a valid single-root package extracts with metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sn-val-'));
  const zip = readZip(skillPackage('demo-skill', { version: '1.0.0', extra: [{ path: 'checklist.md', data: '# 清单\n' }] }), {});
  const staged = await extract(zip, { targetDir: dir });
  assert.equal(staged.name, 'demo-skill');
  assert.equal(staged.description, '示例技能');
  assert.equal(staged.fileCount, 2);
  const files = await readdir(dir, { recursive: true });
  assert.ok(files.includes('SKILL.md'));
  assert.ok(files.includes('checklist.md'));
});

test('case-duplicate entries are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sn-case-'));
  const zip = readZip(buildZip([
    { path: 'demo-skill/SKILL.md', data: skillMd({ name: 'demo-skill' }) },
    { path: 'demo-skill/skill.md', data: skillMd({ name: 'demo-skill' }) },
  ]), {});
  await expectCode(() => extract(zip, { targetDir: dir }), REASONS.PATH_ESCAPE);
});

test('symlink entries are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sn-link-'));
  await expectCode(() => extract(readZip(buildZip([
    { path: 'demo-skill/SKILL.md', data: skillMd({ name: 'demo-skill' }) },
    { path: 'demo-skill/link', data: '/etc/passwd', externalAttrs: (0o120000 << 16) | 0o777 },
  ]), {}), { targetDir: dir }), REASONS.PATH_ESCAPE);
});

test('entry count and total size caps abort immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sn-quota-'));
  const many = [{ path: 'demo-skill/SKILL.md', data: skillMd({ name: 'demo-skill' }) }];
  for (let i = 0; i < 12; i += 1) many.push({ path: `demo-skill/f${i}.md`, data: 'x' });
  await expectCode(() => extract(readZip(buildZip(many), { maxFileCount: 8 }), { targetDir: dir }), REASONS.QUOTA_EXCEEDED);

  const big = [{ path: 'demo-skill/SKILL.md', data: skillMd({ name: 'demo-skill' }) }, { path: 'demo-skill/big.bin', data: Buffer.alloc(4096, 1) }];
  await expectCode(() => extract(readZip(buildZip(big), { maxTotalBytes: 2048 }), { targetDir: dir }), REASONS.QUOTA_EXCEEDED);
});

test('a deflate bomb is cut off by maxOutputLength', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sn-bomb-'));
  await expectCode(() => extract(readZip(buildZip([
    { path: 'demo-skill/SKILL.md', data: skillMd({ name: 'demo-skill' }) },
    { path: 'demo-skill/bomb.bin', data: Buffer.alloc(1024 * 1024, 0), method: 'deflate' },
  ]), { maxEntryBytes: 64 * 1024 }), { targetDir: dir }), REASONS.QUOTA_EXCEEDED);
});

test('structure and frontmatter failures name the exact cause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sn-meta-'));
  await expectCode(() => extract(readZip(buildZip([{ path: 'a.md', data: 'no skill' }]), {}), { targetDir: dir }), REASONS.INVALID_PACKAGE);
  await expectCode(() => extract(readZip(buildZip([
    { path: 'one/SKILL.md', data: skillMd({ name: 'one' }) },
    { path: 'two/SKILL.md', data: skillMd({ name: 'two' }) },
  ]), {}), { targetDir: dir }), REASONS.INVALID_PACKAGE);
  await expectCode(() => extract(readZip(buildZip([{ path: 'demo-skill/SKILL.md', data: 'no frontmatter' }]), {}), { targetDir: dir }), REASONS.INVALID_PACKAGE);
  await expectCode(() => extract(readZip(buildZip([{ path: 'demo-skill/SKILL.md', data: '---\nname: demo-skill\n---\nbody' }]), {}), { targetDir: dir }), REASONS.INVALID_PACKAGE);
  await expectCode(() => extract(readZip(buildZip([{ path: 'demo-skill/SKILL.md', data: skillMd({ name: 'Demo Skill' }) }]), {}), { targetDir: dir }), REASONS.NAME_INVALID);
  await expectCode(() => extract(readZip(skillPackage('demo-skill'), {}), { targetDir: dir, expectedName: 'other-skill' }), REASONS.NAME_INVALID);
  // 2026-11-03 调整：frontmatter 版本与请求版本不匹配不再硬拒绝（Nacos Registry 版本为权威）
  {
    const zip = readZip(skillPackage('demo-skill', { version: '1.0.0' }), {});
    const staged = await extract(zip, { targetDir: dir, expectedVersion: '2.0.0' });
    assert.equal(staged.name, 'demo-skill'); // 安装成功，版本由 Registry 决定
  }
  await expectCode(() => extract(readZip(Buffer.from('not a zip at all')), { targetDir: dir }), REASONS.INVALID_PACKAGE);
});

test('missing description is rejected; when-to-use and invocation flow through', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sn-desc-'));
  const restricted = readZip(buildZip([{
    path: 'demo-skill/SKILL.md',
    data: [
      '---',
      'name: demo-skill',
      'description: 示例技能',
      'when-to-use: 提交前',
      'disable-model-invocation: true',
      'user-invocable: false',
      '---',
      '',
      '正文',
    ].join('\n'),
  }]), {});
  const staged = await extract(restricted, { targetDir: dir });
  assert.deepEqual(staged.invocation, { modelInvocable: false, userInvocable: false });
  const content = await readFile(join(dir, 'SKILL.md'), 'utf8');
  assert.match(content, /disable-model-invocation: true/);
});
