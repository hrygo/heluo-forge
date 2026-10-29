import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ARTIFACT_KINDS,
  ARTIFACT_REASONS,
  ArtifactError,
  assertChangeId,
  artifactPath,
  renderFrontMatter,
  writeArtifact,
} from '../src/artifacts.mjs';

/**
 * 产物唯一出口的契约：路径不越界、front matter 定长定序、写入可核对。
 * 全部落在临时目录里，不碰仓库工作区。
 */
const repoRoot = mkdtempSync(path.join(tmpdir(), 'forge-devops-artifacts-'));
after(() => rmSync(repoRoot, { recursive: true, force: true }));

const META = Object.freeze({ sourceType: 'mock', sourceRevision: 'dop:abc123456789' });
const isArtifactError = (code) => (error) => error instanceof ArtifactError && error.code === code;

test('五类产物、六字段定序、以 --- 收尾', () => {
  assert.deepEqual([...ARTIFACT_KINDS], ['context', 'clarify', 'plan', 'review', 'report']);
  const header = renderFrontMatter({
    changeId: 'ARD123456',
    kind: 'report',
    generatedAt: '2026-10-28T12:00:00.000Z',
    sourceType: 'mock',
    sourceRevision: 'dop:abc123456789',
    commit: null,
  });
  const fields = ['change', 'kind', 'generatedAt', 'sourceType', 'sourceRevision', 'commit'];
  const positions = fields.map((field) => header.indexOf(`${field}: `));
  assert.ok(positions.every((position) => position > 0), `缺字段：${fields.filter((_, i) => positions[i] <= 0)}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'front matter 字段必须按定序出现');
  assert.equal(header.split('\n')[0], '---');
  assert.ok(header.trimEnd().endsWith('---'));
  assert.match(header, /^commit: null$/mu, '无代码关联时 commit 记 null，而不是省略该行');
  assert.equal(header.trimEnd().split('\n').length, 8, 'front matter 定长：两行 --- + 六个字段');
});

test('路径唯一：<仓库根>/.dsh-devops/<变更号>/<kind>.md', () => {
  const file = artifactPath({ repoRoot, changeId: 'ARD123456', kind: 'report' });
  assert.ok(file.startsWith(path.resolve(repoRoot)), '产物必须落在目标仓库根内');
  assert.ok(file.endsWith(path.join('.dsh-devops', 'ARD123456', 'report.md')));
  assert.equal(assertChangeId('  ARD123456  '), 'ARD123456', '变更号先去空白再校验');
});

test('路径逃逸与非法输入直接拒绝，且不创建任何目录', () => {
  for (const changeId of ['../evil', 'ARD/123456', '/etc/passwd', 'ARD 123456', '', null, undefined]) {
    assert.throws(
      () => artifactPath({ repoRoot, changeId, kind: 'report' }),
      isArtifactError(ARTIFACT_REASONS.INVALID_CHANGE_ID),
      `变更号「${String(changeId)}」必须被拒绝`,
    );
  }
  assert.throws(
    () => artifactPath({ repoRoot, changeId: 'ARD123456', kind: '../evil' }),
    isArtifactError(ARTIFACT_REASONS.INVALID_KIND),
  );
  assert.throws(() => artifactPath({ repoRoot: '', changeId: 'ARD123456', kind: 'report' }), isArtifactError(ARTIFACT_REASONS.INVALID_ROOT));
  assert.equal(existsSync(path.join(repoRoot, '.dsh-devops')), false, '校验失败不得留下目录');
});

test('front matter 缺字段、换行注入、未知来源类型都拒绝', () => {
  const base = {
    changeId: 'ARD123456',
    kind: 'plan',
    generatedAt: '2026-10-28T12:00:00.000Z',
    sourceType: 'mock',
    sourceRevision: 'dop:abc123456789',
  };
  assert.throws(() => renderFrontMatter({ ...base, sourceRevision: undefined }), isArtifactError(ARTIFACT_REASONS.MISSING_FIELD));
  assert.throws(() => renderFrontMatter({ ...base, generatedAt: undefined }), isArtifactError(ARTIFACT_REASONS.MISSING_FIELD));
  assert.throws(
    () => renderFrontMatter({ ...base, sourceRevision: 'dop:abc\nkind: report' }),
    isArtifactError(ARTIFACT_REASONS.INVALID_VALUE),
    '头部字段带换行会让正文伪造 front matter',
  );
  assert.throws(() => renderFrontMatter({ ...base, generatedAt: '不是时间' }), isArtifactError(ARTIFACT_REASONS.INVALID_VALUE));
  assert.throws(
    () => renderFrontMatter({ ...base, sourceType: 'production' }),
    isArtifactError(ARTIFACT_REASONS.INVALID_VALUE),
    '来源类型只有 mock / enterprise 两档（AC-23 分记）',
  );
});

test('写盘返回可核对信息，覆盖写不产生第二份文件，中文不丢字', () => {
  const first = writeArtifact({
    repoRoot,
    changeId: 'ARD123456',
    kind: 'context',
    body: '## 上下文卡\n\n- 变更：ARD123456\n- 承建：group/repo\n',
    meta: META,
  });
  assert.ok(existsSync(first.path));
  const text = readFileSync(first.path, 'utf8');
  assert.ok(text.startsWith(first.header), '文件必须以定长 front matter 开头');
  assert.equal(first.bytes, Buffer.byteLength(text, 'utf8'));
  assert.match(text, /## 上下文卡/u);
  assert.match(text, /承建：group\/repo/u);

  const second = writeArtifact({ repoRoot, changeId: 'ARD123456', kind: 'context', body: '第二版', meta: META });
  assert.equal(second.path, first.path, '同一变更号同一 kind 只对应一个文件');
  assert.match(readFileSync(second.path, 'utf8'), /第二版/u);
  assert.ok(!readFileSync(second.path, 'utf8').includes('## 上下文卡'));
});

test('review 必须绑定 commit 与模型名；report 必须带证据数组', () => {
  const review = { repoRoot, changeId: 'ARD123456', kind: 'review', body: '审查记录', meta: { ...META, commit: 'abc1234', model: 'deepseek-v4.1-flash' } };
  const written = writeArtifact(review);
  assert.match(readFileSync(written.path, 'utf8'), /^commit: abc1234$/mu);
  assert.throws(() => writeArtifact({ ...review, meta: { ...META, model: 'x' } }), isArtifactError(ARTIFACT_REASONS.MISSING_META));
  assert.throws(() => writeArtifact({ ...review, meta: { ...META, commit: 'abc1234' } }), isArtifactError(ARTIFACT_REASONS.MISSING_META));
  assert.throws(
    () => writeArtifact({ repoRoot, changeId: 'ARD123456', kind: 'report', body: '报告', meta: META }),
    isArtifactError(ARTIFACT_REASONS.MISSING_META),
    '报告没有证据数组即不合格（AC-23）',
  );
  const report = writeArtifact({
    repoRoot,
    changeId: 'ARD123456',
    kind: 'report',
    body: '报告',
    meta: { ...META, evidence: [{ ac: 'AC-1', evidence: 'node --test 通过' }] },
  });
  assert.ok(existsSync(report.path));
});

test('空正文与非法 kind 不落盘', () => {
  assert.throws(
    () => writeArtifact({ repoRoot, changeId: 'ARD123456', kind: 'plan', body: '   ', meta: META }),
    isArtifactError(ARTIFACT_REASONS.MISSING_BODY),
  );
  assert.throws(
    () => writeArtifact({ repoRoot, changeId: 'ARD123456', kind: 'notes', body: 'x', meta: META }),
    isArtifactError(ARTIFACT_REASONS.INVALID_KIND),
  );
  assert.equal(existsSync(path.join(repoRoot, '.dsh-devops', 'ARD123456', 'notes.md')), false);
});
