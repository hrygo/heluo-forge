/**
 * Release-gate regression for the published source and tool archives
 * (Greptile review 5872697951 on PR #256).
 *
 * `scanReleaseFiles()` never honors `security-scan: allow`, so a tracked file
 * that carries a literal credential-shaped string (for example a password URL
 * kept in a test fixture) makes every release built with `--include-source`
 * fail with `SOURCE_UNSAFE` at publish time. The manifest below is the release
 * script's own: `createReleaseSource()` runs the same `git archive HEAD` and
 * prefix the builder scans, and `releaseToolFiles()` returns the same tool list
 * the tool archive ships. Both scans therefore run the exact rule set the
 * release applies (`scanReleaseFiles(..., { publicOnly: false })`).
 *
 * A finding fails this suite in CI, before a release tag is ever cut.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createReleaseSource, releaseToolFiles } from '../scripts/build-public-release.mjs';
import { scanReleaseFiles } from '../scripts/lib/release-support.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_VERSION = '0.0.0-scan-fixture';

function gitHeadAvailable() {
  const result = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0;
}

const skip = gitHeadAvailable() ? false : 'needs a git checkout to read the release manifest';

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-release-scan-'));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), 'forge-release-scan-')));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('the published source archive carries no sensitive literal', { skip }, (t) => {
  const archive = createReleaseSource({ root: REPO, version: SAMPLE_VERSION, destination: temp(t) });
  assert.ok(archive.entries.length > 0, 'the source manifest must not be empty');
  const problems = scanReleaseFiles(
    archive.entries.map((entry) => ({ path: entry.path, body: entry.content })),
    { publicOnly: false },
  );
  assert.deepEqual(problems, [], `the public source archive would fail SOURCE_UNSAFE:\n${problems.join('\n')}`);
});

test('the published tool archive carries no sensitive literal', { skip }, () => {
  const files = releaseToolFiles(REPO);
  assert.ok(files.length > 0, 'the tool manifest must not be empty');
  const problems = scanReleaseFiles(
    files.map((path) => ({ path: `toolchain/${path}`, body: readFileSync(join(REPO, path)) })),
    { publicOnly: false },
  );
  assert.deepEqual(problems, [], `the public tool archive would fail TOOLS_SENSITIVE:\n${problems.join('\n')}`);
});
