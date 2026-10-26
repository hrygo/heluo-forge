import assert from 'node:assert/strict';
import test from 'node:test';

import { blockingFindings, inspectManifest, MANIFEST_VERSION, resolveArtifactPath, SddManifestError } from '../src/manifest.mjs';

const sha = 'a'.repeat(64);
const base = {
  version: MANIFEST_VERSION,
  unitId: 'U-1',
  changeId: 'C-2026-1',
  revision: 'rev-7',
  testedRevision: 'rev-7',
  artifacts: [{ path: 'docs/sdd/spec.md', sha256: sha, kind: 'spec', unitId: 'U-1' }],
};

const rules = (manifest) => inspectManifest(manifest).findings.map((finding) => finding.rule);

test('a valid minimal delivery passes', () => {
  const { findings } = inspectManifest(base);
  assert.deepEqual(blockingFindings(findings), []);
});

test('missing change id, unit, revision and tested revision are located', () => {
  assert.deepEqual(rules({ ...base, changeId: undefined }), ['change-id-missing']);
  assert.ok(rules({ ...base, unitId: '' }).includes('unit-id-missing'));
  assert.deepEqual(rules({ ...base, revision: undefined }), ['revision-missing']);
  assert.deepEqual(rules({ ...base, testedRevision: '  ' }), ['tested-revision-missing']);
  assert.ok(rules({ ...base, version: 99 }).includes('manifest-version'));
  assert.ok(rules('nope').includes('manifest-shape'));
  assert.ok(rules({ ...base, artifacts: [] }).includes('artifacts-missing'));
});

test('fingerprint, duplicate, kind and unit mismatches are blocking', () => {
  assert.ok(rules({ ...base, artifacts: [{ path: 'a.md' }] }).includes('fingerprint-missing'));
  assert.ok(rules({ ...base, artifacts: [{ path: 'a.md', sha256: 'short' }] }).includes('fingerprint-missing'));
  assert.ok(rules({ ...base, artifacts: [{ ...base.artifacts[0] }, { ...base.artifacts[0] }] }).includes('artifact-duplicate'));
  assert.ok(rules({ ...base, artifacts: [{ ...base.artifacts[0], kind: 'other' }] }).includes('artifact-kind-unknown'));
  assert.ok(
    rules({ ...base, artifacts: [{ ...base.artifacts[0], unitId: 'U-2' }] }).includes('foreign-unit-artifact'),
    'a file from another delivery unit must fail',
  );
  assert.ok(rules({ ...base, stage: 'unknown' }).includes('stage-unknown'));
});

test('absolute paths and traversal are refused', () => {
  assert.throws(() => resolveArtifactPath({ path: '/etc/passwd' }, base), (error) => error instanceof SddManifestError && error.code === 'SDD_PATH_ABSOLUTE');
  assert.throws(() => resolveArtifactPath({ path: '../outside.md' }, base), (error) => error.code === 'SDD_PATH_TRAVERSAL');
  assert.throws(() => resolveArtifactPath({ path: 'a/../../b.md' }, base), (error) => error.code === 'SDD_PATH_TRAVERSAL');
  assert.throws(() => resolveArtifactPath({}, base), (error) => error.code === 'SDD_MANIFEST_INVALID');
  assert.equal(resolveArtifactPath({ path: 'a/./b.md' }, base, '/root'), '/root/a/b.md');
});

test('NOT RUN, timeout and stale test revisions are not a pass', () => {
  for (const state of ['not-run', 'timeout', 'failed']) {
    const found = rules({ ...base, testEvidence: [{ ref: 'ci-1', state, testedRevision: 'rev-7' }] });
    assert.ok(found.includes('test-not-passed'), `${state} must not count as a pass`);
  }
  assert.ok(rules({ ...base, testEvidence: [{ ref: 'ci-1', state: 'passed', testedRevision: 'rev-6' }] }).includes('test-revision-mismatch'));
  assert.ok(rules({ ...base, testEvidence: [{ ref: 'ci-1', state: 'weird' }] }).includes('test-state-unknown'));
  assert.ok(rules({ ...base, testEvidence: 'nope' }).includes('test-evidence-shape'));
  assert.deepEqual(blockingFindings(inspectManifest({ ...base, testEvidence: [{ ref: 'ci-1', state: 'passed', testedRevision: 'rev-7' }] }).findings), []);
});

test('matching old test declarations cannot pass for a newer delivery revision', () => {
  for (const stage of [undefined, 'implementation']) {
    const { findings } = inspectManifest({
      ...base,
      revision: 'rev-8',
      stage,
      testEvidence: [{ ref: 'ci-old', state: 'passed', testedRevision: 'rev-7' }],
    });
    assert.ok(blockingFindings(findings).some((finding) => finding.rule === 'test-revision-mismatch' && finding.locator === 'testedRevision'));
  }
});

test('every declared stage requires each of spec and implementation, including when both are missing', () => {
  for (const stage of ['spec', 'implementation', 'archive']) {
    for (const kind of [undefined, 'archive', 'spec', 'implementation']) {
      const manifest = { ...base, stage, artifacts: [{ ...base.artifacts[0], kind }] };
      assert.ok(blockingFindings(inspectManifest(manifest).findings).some((finding) => finding.rule === 'atomic-delivery'), `${stage} with only ${kind} must fail`);
    }
    const { findings } = inspectManifest({
      ...base,
      stage,
      artifacts: [base.artifacts[0], { path: 'src/a.mjs', kind: 'implementation', sha256: sha }],
    });
    assert.deepEqual(blockingFindings(findings), []);
    assert.deepEqual(findings.map((finding) => finding.rule), ['archive-missing'], 'archive absence remains soft');
  }
  for (const kind of [undefined, 'archive', 'spec', 'implementation']) {
    assert.deepEqual(inspectManifest({ ...base, artifacts: [{ ...base.artifacts[0], kind }] }).findings, [], 'ordinary unstaged work needs no new artifact categories');
  }
});

test('without stage metadata only HARD rules apply', () => {
  const { findings, stage } = inspectManifest(base);
  assert.equal(stage, undefined);
  assert.equal(findings.some((finding) => finding.severity === 'SOFT'), false, 'no soft expectation without stage metadata');
  const staged = inspectManifest({ ...base, stage: 'implementation' });
  assert.equal(staged.stage, 'implementation');
  assert.ok(staged.findings.some((finding) => finding.severity === 'SOFT' && finding.rule === 'archive-missing'));
  assert.deepEqual(blockingFindings(staged.findings).map((finding) => finding.rule), ['atomic-delivery'], 'a staged delivery must carry spec and implementation together');
  const both = inspectManifest({
    ...base,
    stage: 'implementation',
    artifacts: [base.artifacts[0], { path: 'src/a.mjs', sha256: sha, kind: 'implementation', unitId: 'U-1' }],
  });
  assert.deepEqual(blockingFindings(both.findings), []);
  assert.equal(both.findings.filter((finding) => finding.severity === 'SOFT').length, 1);
});
