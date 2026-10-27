/**
 * Native CLI contract spec (explicit file, never auto-discovered by `node --test`).
 *
 * Builds the offline synthetic Go fixture for the current OS/arch and drives
 * the production DOP/gh runners plus host readers against it. Run with:
 *   node --test tests/native-cli-mock.spec.mjs
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativeCli } from '../scripts/build-native-cli-mock.mjs';
import { runDopChange } from '../packages/forge-devops/src/dop-process.mjs';
import { normalizeChangeBriefing } from '../packages/forge-devops/src/change-briefing.mjs';
import { runGh } from '../packages/forge-devops/src/gh-process.mjs';
import { createGhReader } from '../packages/forge-devops/src/host-readers.mjs';

const HOST = 'gitee.corp.example';
const REPO = `${HOST}/demo/repo`;

let dir;
let dop;
let gh;

before(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'heluo-native-contract-')), 'out');
  const built = buildNativeCli({ out: dir });
  dop = built.dop;
  gh = built.gh;
});

after(async () => {
  if (dir) await rm(join(dir, '..'), { recursive: true, force: true });
});

const dopEnv = (c) => ({ ...(c === 'success' ? {} : { HELUO_CONTRACT_CASE: c }) });
const ghOpts = (args, c = 'success', extra = {}) => ({
  executable: gh, allowedHost: HOST, args,
  env: { ...dopEnv(c) }, timeoutMs: 10000, maxOutputBytes: 262144, ...extra,
});

test('native DOP targets normalize with first-non-null release selection', async () => {
  const first = normalizeChangeBriefing(await runDopChange({ changeId: 'ARD123456', executable: dop, env: dopEnv('success') }), 'ARD123456');
  assert.equal(first.release, null);
  assert.equal(first.acceptance.length, 2);
  const second = normalizeChangeBriefing(await runDopChange({ changeId: 'ARD222222', executable: dop, env: dopEnv('success') }), 'ARD222222');
  assert.equal(second.release?.number, 'R20260620002');
  assert.equal(second.stories.length, 2);
});

test('native gh repo/issue/pr validate explicit host bindings', async () => {
  const reader = createGhReader({ executable: gh, allowedHost: HOST, runner: (options) => runGh(options) });
  const repo = await reader.read({ action: 'repository.read', target: REPO });
  assert.equal(repo.facts.defaultBranch, 'main');
  const issue = await reader.read({ action: 'issue.read', target: `${REPO}#2` });
  assert.deepEqual(issue.facts.closingPullRequests, [{ number: 3, url: `https://${REPO}/pull/3` }]);
  const open = await reader.read({ action: 'issue.read', target: `${REPO}#4` });
  assert.deepEqual(open.facts.closingPullRequests, []);
  const pr = await reader.read({ action: 'pr.read', target: `${REPO}#3` });
  assert.equal(pr.facts.headRefOid, 'a'.repeat(40));
});

test('native fault matrix maps to safe runner codes', async () => {
  await assert.rejects(runDopChange({ changeId: 'ARD123456', executable: dop, env: dopEnv('denied401') }), { code: 'AUTH_FAILED' });
  await assert.rejects(runDopChange({ changeId: 'ARD123456', executable: dop, env: dopEnv('denied403') }), { code: 'AUTH_FAILED' });
  await assert.rejects(runGh(ghOpts(['repo', 'view', REPO, '--json', 'nameWithOwner,url,isPrivate,defaultBranchRef'], 'denied401')), { code: 'AUTH_FAILED' });
  await assert.rejects(runDopChange({ changeId: 'ARD123456', executable: dop, env: dopEnv('malformed') }), { code: 'INVALID_JSON' });
  await assert.rejects(runDopChange({ changeId: 'ARD123456', executable: dop, env: dopEnv('truncated') }), { code: 'INVALID_JSON' });
  await assert.rejects(
    runDopChange({ changeId: 'ARD123456', executable: dop, env: dopEnv('overflow'), maxOutputBytes: 1024 }),
    { code: 'OUTPUT_LIMIT' },
  );
  await assert.rejects(
    runDopChange({ changeId: 'ARD123456', executable: dop, env: dopEnv('timeout'), timeoutMs: 500 }),
    { code: 'CLI_TIMEOUT' },
  );
});

test('native missing-fields and wrong-target are reader-level mismatches, not successes', async () => {
  const missingReader = createGhReader({
    executable: gh, allowedHost: HOST,
    runner: (options) => runGh({ ...options, env: { HELUO_CONTRACT_CASE: 'missing-fields' } }),
  });
  await assert.rejects(missingReader.read({ action: 'repository.read', target: REPO }), { name: 'HostReaderError' });
  await assert.rejects(
    (async () => normalizeChangeBriefing(await runDopChange({ changeId: 'ARD123456', executable: dop, env: dopEnv('wrong-target') }), 'ARD123456'))(),
    (error) => error?.code === 'CHANGE_ID_MISMATCH',
  );
});

test('native write-shaped argv is refused without a business effect', async () => {
  await assert.rejects(runGh({ executable: gh, allowedHost: HOST, args: ['pr', 'merge', '3', '--repo', REPO], env: {} }), (error) => (
    error?.code === 'BAD_TARGET' || error?.code === 'CLI_FAILED'
  ));
  const { execFile } = await import('node:child_process');
  await assert.rejects(new Promise((resolve, reject) => {
    execFile(dop, ['change', 'done', 'ARD123456'], { timeout: 10000 }, (error) => (error ? reject(error) : resolve()));
  }));
});

test('adjacent fixture-case selector works and invalid selectors fail closed', async () => {
  const selector = join(dir, 'fixture-case.txt');
  await writeFile(selector, 'success', { flag: 'w', mode: 0o600 });
  const raw = await runDopChange({ changeId: 'ARD123456', executable: dop, env: {} });
  assert.equal(raw.id, 'ARD123456');
  await writeFile(selector, 'bogus', { flag: 'w', mode: 0o600 });
  await assert.rejects(runDopChange({ changeId: 'ARD123456', executable: dop, env: {} }), { code: 'CLI_FAILED' });
  await rm(selector, { force: true });
});

test('call log records only fixed argv and case names', async () => {
  const log = join(dir, 'calls.jsonl');
  await runDopChange({ changeId: 'ARD123456', executable: dop, env: { HELUO_CONTRACT_CASE: 'success', HELUO_CONTRACT_CALLS: log } });
  const line = JSON.parse(await readFile(log, 'utf8'));
  assert.deepEqual(line, { argv: ['change', 'view', 'ARD123456', '-j'], case: 'success' });
});
