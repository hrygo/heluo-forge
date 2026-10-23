import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { freeze, loadManifest, verifyManifest } from '../src/freeze.mjs';
import { SddManifestError } from '../src/manifest.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'forge-sdd-'));
  mkdirSync(join(root, 'docs/sdd'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'docs/sdd/spec.md'), 'spec v1\n');
  writeFileSync(join(root, 'src/a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, 'unrelated.txt'), 'leave me alone\n');
  return root;
}

const baseInput = (root) => ({
  freezePath: join(root, 'docs/sdd/freeze.json'),
  root,
  unitId: 'U-1',
  changeId: 'C-2026-1',
  revision: 'rev-7',
  testedRevision: 'rev-7',
  artifacts: [
    { path: 'docs/sdd/spec.md', kind: 'spec' },
    { path: 'src/a.mjs', kind: 'implementation' },
  ],
  testEvidence: [{ ref: 'ci-1', state: 'passed', testedRevision: 'rev-7' }],
  now: () => new Date('2026-10-24T00:00:00Z'),
});

test('freezing writes a manifest that verifies cleanly', () => {
  const root = sandbox();
  const manifest = freeze(baseInput(root));
  assert.equal(manifest.artifacts.length, 2);
  assert.match(manifest.artifacts[0].sha256, /^[0-9a-f]{64}$/u);
  assert.equal(manifest.createdAt, '2026-10-24T00:00:00.000Z');
  assert.equal(existsSync(`${baseInput(root).freezePath}.lock`), false, 'the lock is released');

  const result = verifyManifest({ manifest, root, currentRevision: 'rev-7' });
  assert.equal(result.ok, true);
  assert.equal(result.severity, 'hard-only');
  assert.match(result.notes.join(' '), /不证明业务正确/);
});

test('a missing artifact refuses the freeze and leaves no manifest behind', () => {
  const root = sandbox();
  const input = baseInput(root);
  assert.throws(
    () => freeze({ ...input, artifacts: [...input.artifacts, { path: 'src/missing.mjs' }] }),
    (error) => error instanceof SddManifestError && error.code === 'SDD_ARTIFACT_MISSING',
  );
  assert.equal(existsSync(input.freezePath), false, 'no half-written manifest');
  assert.equal(existsSync(`${input.freezePath}.lock`), false, 'the lock is released on failure too');
});

test('a silent edit after the freeze and a stale revision are both located', () => {
  const root = sandbox();
  const input = baseInput(root);
  const manifest = freeze(input);
  writeFileSync(join(root, 'docs/sdd/spec.md'), 'spec v2 (silently edited)\n');

  const tampered = verifyManifest({ manifest, root, currentRevision: 'rev-7' });
  assert.equal(tampered.ok, false);
  assert.deepEqual(tampered.blocking.map((finding) => finding.rule), ['fingerprint-mismatch']);
  assert.equal(tampered.blocking[0].locator, 'docs/sdd/spec.md');

  const drifted = verifyManifest({ manifest, root, currentRevision: 'rev-8' });
  assert.ok(drifted.blocking.some((finding) => finding.rule === 'revision-drift'));

  const noRevision = verifyManifest({ manifest, root });
  assert.equal(noRevision.blocking.some((finding) => finding.rule === 'revision-drift'), false, 'without a current revision the drift rule cannot run');
});

test('an explicit re-freeze replaces a stale freeze', () => {
  const root = sandbox();
  const input = baseInput(root);
  const first = freeze(input);
  writeFileSync(join(root, 'docs/sdd/spec.md'), 'spec v2\n');
  const second = freeze({ ...input, revision: 'rev-8', testedRevision: 'rev-8', testEvidence: [{ ref: 'ci-2', state: 'passed', testedRevision: 'rev-8' }] });
  assert.notEqual(first.artifacts[0].sha256, second.artifacts[0].sha256);
  assert.equal(verifyManifest({ manifest: second, root, currentRevision: 'rev-8' }).ok, true);
  assert.equal(verifyManifest({ manifest: loadManifest(input.freezePath), root, currentRevision: 'rev-8' }).ok, true);
});

test('an invalid freeze is refused before anything is written', () => {
  const root = sandbox();
  const input = baseInput(root);
  assert.throws(() => freeze({ ...input, changeId: undefined }), (error) => error.code === 'SDD_FREEZE_INVALID');
  assert.throws(() => freeze({ ...input, artifacts: [] }), (error) => error.code === 'SDD_FREEZE_NO_ARTIFACTS');
  assert.throws(
    () => freeze({ ...input, artifacts: [{ path: 'docs/sdd/spec.md', kind: 'spec', unitId: 'U-2' }, { path: 'src/a.mjs', kind: 'implementation' }] }),
    (error) => error.code === 'SDD_FREEZE_INVALID' && error.details.findings.some((finding) => finding.rule === 'foreign-unit-artifact'),
  );
  assert.equal(existsSync(input.freezePath), false);
});

test('a held lock refuses the freeze and unrelated files are untouched', () => {
  const root = sandbox();
  const input = baseInput(root);
  const unrelatedBefore = readFileSync(join(root, 'unrelated.txt'), 'utf8');
  const mtimeBefore = statSync(join(root, 'unrelated.txt')).mtimeMs;

  writeFileSync(`${input.freezePath}.lock`, 'someone else\n');
  assert.throws(() => freeze(input), (error) => error.code === 'SDD_LOCK_HELD');
  assert.equal(existsSync(input.freezePath), false);
  rmSync(`${input.freezePath}.lock`, { force: true });
  const manifest = freeze({ ...input, now: () => new Date('2026-10-24T00:00:00Z') });
  assert.ok(manifest.artifacts.length === 2);

  assert.equal(readFileSync(join(root, 'unrelated.txt'), 'utf8'), unrelatedBefore);
  assert.equal(statSync(join(root, 'unrelated.txt')).mtimeMs, mtimeBefore, 'unrelated working-tree files are never rewritten');
});

test('the unit is declared, never inferred from a file name', () => {
  const root = sandbox();
  writeFileSync(join(root, 'src/U-1-looks-like-this-unit.mjs'), 'export const b = 2;\n');
  const manifest = freeze(baseInput(root));
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.path), ['docs/sdd/spec.md', 'src/a.mjs']);
  assert.equal(manifest.artifacts.some((artifact) => artifact.path.includes('looks-like')), false);
  assert.equal(verifyManifest({ manifest, root }).ok, true);
  assert.throws(() => loadManifest(join(root, 'docs/sdd/absent.json')), (error) => error.code === 'SDD_MANIFEST_MISSING');
  writeFileSync(join(root, 'docs/sdd/broken.json'), '{ not json');
  assert.throws(() => loadManifest(join(root, 'docs/sdd/broken.json')), (error) => error.code === 'SDD_MANIFEST_INVALID');
});
