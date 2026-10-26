import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { freeze, loadManifest, verifyManifest } from '../src/freeze.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'forge-sdd-cli-'));
  mkdirSync(join(root, 'docs/sdd'), { recursive: true });
  writeFileSync(join(root, 'docs/sdd/spec.md'), 'spec v1\n');
  writeFileSync(join(root, 'unrelated.txt'), 'untouched\n');
  return root;
}

test('the CLI freezes and verifies a delivery, and its verdict matches the library', () => {
  const root = sandbox();
  const manifestPath = join(root, 'docs/sdd/freeze.json');
  const frozen = run([
    'freeze', '--root', root, '--manifest', manifestPath, '--unit', 'U-1', '--change', 'C-2026-1',
    '--revision', 'rev-7', '--tested-revision', 'rev-7', '--artifact', 'docs/sdd/spec.md:spec',
  ]);
  assert.equal(frozen.code, 0, frozen.stderr);
  assert.match(frozen.stdout, /未经 CI 验证/);

  const cliVerdict = run(['verify', '--root', root, '--manifest', manifestPath, '--revision', 'rev-7', '--json']);
  assert.equal(cliVerdict.code, 0, cliVerdict.stderr);
  const libraryVerdict = verifyManifest({ manifest: loadManifest(manifestPath), root, currentRevision: 'rev-7' });
  const parsed = JSON.parse(cliVerdict.stdout);
  assert.equal(parsed.ok, libraryVerdict.ok, 'the local pre-check and the CI job must agree on the same fixture');
  assert.deepEqual(parsed.blocking, libraryVerdict.blocking);
  assert.deepEqual(parsed.notes, libraryVerdict.notes);
  assert.equal(parsed.severity, 'hard-only');
});

test('the CLI and shared library reject all three FIX-04 counterexamples', () => {
  for (const scenario of ['stale-tests', 'untyped-stage', 'archive-only-stage', 'binary-tamper']) {
    const root = sandbox();
    const manifestPath = join(root, 'docs/sdd/freeze.json');
    const binary = scenario === 'binary-tamper';
    const path = binary ? 'artifact.bin' : 'docs/sdd/spec.md';
    if (binary) writeFileSync(join(root, path), Buffer.from([0x80]));
    const manifest = freeze({
      root, freezePath: manifestPath, unitId: 'U-1', changeId: 'C-1', revision: 'rev-7', testedRevision: 'rev-7',
      artifacts: [{ path }], testEvidence: [{ ref: 'ci-old', state: 'passed', testedRevision: 'rev-7' }],
    });
    const verifyArgs = ['verify', '--root', root, '--manifest', manifestPath, '--revision', 'rev-7', '--json'];
    assert.equal(run(verifyArgs).code, 0, `${scenario}: the unchanged unstaged fixture passes`);
    let expectedRule;
    if (scenario === 'stale-tests') {
      manifest.revision = 'rev-8';
      verifyArgs[verifyArgs.indexOf('--revision') + 1] = 'rev-8';
      expectedRule = 'test-revision-mismatch';
    } else if (binary) {
      writeFileSync(join(root, path), Buffer.from([0x81]));
      expectedRule = 'fingerprint-mismatch';
    } else {
      manifest.stage = 'implementation';
      if (scenario === 'archive-only-stage') manifest.artifacts[0].kind = 'archive';
      expectedRule = 'atomic-delivery';
    }
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const cliVerdict = run(verifyArgs);
    const libraryVerdict = verifyManifest({ manifest, root, currentRevision: manifest.revision });
    assert.equal(cliVerdict.code, 1, `${scenario}: CLI must block`);
    assert.equal(libraryVerdict.ok, false, `${scenario}: shared library must block`);
    assert.deepEqual(JSON.parse(cliVerdict.stdout), JSON.parse(JSON.stringify(libraryVerdict)), 'CLI and library JSON verdicts must match');
    assert.ok(libraryVerdict.blocking.some((finding) => finding.rule === expectedRule));
  }
});

test('the CLI refuses freezing stale tests or a staged delivery with no required kinds', () => {
  const root = sandbox();
  const args = ['freeze', '--root', root, '--manifest', join(root, 'docs/sdd/freeze.json'), '--unit', 'U-1', '--change', 'C-1', '--revision', 'rev-8', '--tested-revision', 'rev-7', '--artifact', 'docs/sdd/spec.md'];
  const stale = run(args);
  assert.equal(stale.code, 2);
  assert.match(stale.stderr, /test-revision-mismatch/);
  args[args.indexOf('--tested-revision') + 1] = 'rev-8';
  const untyped = run([...args, '--stage', 'implementation']);
  assert.equal(untyped.code, 2);
  assert.match(untyped.stderr, /atomic-delivery/);
});

test('the CLI reports a located failure and exits non-zero', () => {
  const root = sandbox();
  const manifestPath = join(root, 'docs/sdd/freeze.json');
  run(['freeze', '--root', root, '--manifest', manifestPath, '--unit', 'U-1', '--change', 'C-2026-1', '--revision', 'rev-7', '--tested-revision', 'rev-7', '--artifact', 'docs/sdd/spec.md:spec']);
  writeFileSync(join(root, 'docs/sdd/spec.md'), 'spec v2\n');

  const tampered = run(['verify', '--root', root, '--manifest', manifestPath, '--revision', 'rev-7']);
  assert.equal(tampered.code, 1);
  assert.match(tampered.stdout, /fingerprint-mismatch/);
  assert.match(tampered.stdout, /docs\/sdd\/spec\.md/);

  const drifted = run(['verify', '--root', root, '--manifest', manifestPath, '--revision', 'rev-9']);
  assert.equal(drifted.code, 1);
  assert.match(drifted.stdout, /revision-drift/);
});

test('usage and environment problems exit with code 2', () => {
  assert.equal(run(['verify', '--root', '/tmp']).code, 2, 'a missing --manifest is a usage error');
  assert.match(run(['verify', '--root', '/tmp']).stderr, /--manifest is required/);
  const missing = run(['verify', '--root', '/tmp', '--manifest', '/tmp/definitely-absent.json']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /SDD_MANIFEST_MISSING/);
  const usage = run([]);
  assert.equal(usage.code, 0);
  assert.match(usage.stdout, /用法/);
  assert.equal(run(['nonsense', '--root', '/tmp', '--manifest', '/tmp/x.json']).code, 2);
});

test('a freeze with an invalid delivery exits with code 2 and writes nothing', () => {
  const root = sandbox();
  const manifestPath = join(root, 'docs/sdd/freeze.json');
  const failed = run(['freeze', '--root', root, '--manifest', manifestPath, '--unit', 'U-1', '--change', '', '--revision', 'rev-7', '--tested-revision', 'rev-7', '--artifact', 'docs/sdd/spec.md:spec']);
  assert.equal(failed.code, 2);
  assert.match(failed.stderr, /change-id-missing/);
  const missingChange = run(['freeze', '--root', root, '--manifest', manifestPath, '--unit', 'U-1', '--revision', 'rev-7', '--tested-revision', 'rev-7', '--artifact', 'docs/sdd/spec.md:spec']);
  assert.equal(missingChange.code, 2);
  assert.match(missingChange.stderr, /--change is required/);
  const badPath = run(['freeze', '--root', root, '--manifest', manifestPath, '--unit', 'U-1', '--change', 'C-1', '--revision', 'rev-7', '--tested-revision', 'rev-7', '--artifact', '../escape.md']);
  assert.equal(badPath.code, 2);
  assert.match(badPath.stderr, /does not exist/);
});
