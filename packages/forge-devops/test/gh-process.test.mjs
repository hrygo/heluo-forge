import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GhProcessError, runGh } from '../src/gh-process.mjs';

let directory;
let fixture;
const canary = 'FIXTURE_ONLY_PRIVATE_CANARY';
const HOST = 'gitee.corp.example';
const REPO = `${HOST}/demo/repo`;

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-gh-process-')));
  fixture = join(directory, 'fixture with spaces.mjs');
  await writeFile(fixture, `
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.env.FIXTURE_PID_FILE) writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
const mode = process.env.FIXTURE_MODE || 'echo';
const canary = ${JSON.stringify(canary)};
const emit = (value) => process.stdout.write(JSON.stringify(value));
switch (mode) {
  case 'echo':
    emit({ argv: process.argv.slice(2), cwd: process.cwd(),
      explicit: process.env.FORGE_TEST_EXPLICIT ?? null,
      ambient: process.env.FORGE_TEST_AMBIENT ?? null });
    break;
  case 'payload': process.stdout.write(process.env.FIXTURE_PAYLOAD ?? ''); break;
  case 'stderr': process.stderr.write(canary); emit({ ok: true }); break;
  case 'fail': process.stderr.write(canary); process.stdout.write(canary); process.exitCode = 7; break;
  case 'auth401': process.stderr.write(canary + ' 401'); process.exitCode = 1; break;
  case 'auth403': process.stderr.write('403 ' + canary); emit({ ok: true }); break;
  case 'split-auth':
    process.stderr.write('4');
    setTimeout(() => process.stderr.write('0'), 20);
    setTimeout(() => { process.stderr.write('1' + canary); process.exitCode = 1; }, 40);
    break;
  case 'stdout-overflow': process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000); break;
  case 'stderr-overflow': process.stderr.write('x'.repeat(8192)); setInterval(() => {}, 1000); break;
  case 'combined': process.stdout.write('{}'); process.stderr.write('abcd'); break;
  case 'hang': process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); break;
  case 'stdin': {
    let data = '';
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => emit({ stdin: data }));
    process.stdin.resume();
    break;
  }
  case 'invalid-utf8': process.stdout.write(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])); break;
  case 'signal': process.kill(process.pid, 'SIGKILL'); break;
  case 'inherited-pipes': {
    const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2] });
    if (process.env.FIXTURE_DESCENDANT_FILE) writeFileSync(process.env.FIXTURE_DESCENDANT_FILE, String(descendant.pid));
    descendant.unref();
    emit({ ok: true });
    break;
  }
}
`);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const REPO_ARGS = ['repo', 'view', REPO, '--json', 'nameWithOwner,url,isPrivate,defaultBranchRef'];
const ISSUE_ARGS = ['issue', 'view', '2', '--repo', REPO, '--json', 'number,title,body,state,url,closedByPullRequestsReferences'];
const PR_ARGS = ['pr', 'view', '3', '--repo', REPO, '--json', 'number,title,state,url,headRefOid,baseRefName,mergedAt'];

function run(args = REPO_ARGS, options = {}) {
  return runGh({
    executable: process.execPath, prefixArgs: [fixture], allowedHost: HOST,
    args, env: { FIXTURE_MODE: 'echo' }, ...options,
  });
}

function safeError(code, forbidden = []) {
  return (error) => {
    assert.ok(error instanceof GhProcessError);
    assert.equal(error.name, 'GhProcessError');
    assert.equal(error.code, code);
    assert.equal(error.message, new GhProcessError(code).message);
    assert.equal(error.cause, undefined);
    for (const text of [canary, ...forbidden]) {
      assert.ok(!String(error).includes(text), 'exception text must be sanitized');
      assert.ok(!JSON.stringify(error).includes(text), 'exception properties must be sanitized');
    }
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
    return true;
  };
}

async function assertDead(pidFile) {
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

async function awaitPid(pidFile) {
  for (let count = 0; count < 200; count += 1) {
    try { await access(pidFile); return; } catch { await delay(10); }
  }
  assert.fail('Node fixture did not become ready');
}

test('fixed repo/issue/pr argv execute once with explicit env and no credential argv', async () => {
  assert.deepEqual((await run(REPO_ARGS, { cwd: directory, env: { FORGE_TEST_EXPLICIT: canary } })).argv, REPO_ARGS);
  assert.deepEqual((await run(ISSUE_ARGS)).argv, ISSUE_ARGS);
  assert.deepEqual((await run(PR_ARGS)).argv, PR_ARGS);
});

test('omitted env never forwards ambient values', async () => {
  const previous = process.env.FORGE_TEST_AMBIENT;
  process.env.FORGE_TEST_AMBIENT = canary;
  try {
    assert.equal((await run(REPO_ARGS, { env: undefined })).ambient, null);
  } finally {
    if (previous === undefined) delete process.env.FORGE_TEST_AMBIENT;
    else process.env.FORGE_TEST_AMBIENT = previous;
  }
});

test('stdin is ignored and reaches EOF', async () => {
  assert.deepEqual((await run(REPO_ARGS, { env: { FIXTURE_MODE: 'stdin' } })).stdin, '');
});

test('stderr canary is never exposed', async () => {
  assert.deepEqual(await run(REPO_ARGS, { env: { FIXTURE_MODE: 'stderr' } }), { ok: true });
  await assert.rejects(run(REPO_ARGS, { env: { FIXTURE_MODE: 'fail' } }), safeError('CLI_FAILED'));
});

for (const mode of ['auth401', 'auth403', 'split-auth']) {
  test(`${mode} returns sanitized AUTH_FAILED`, async () => {
    await assert.rejects(run(REPO_ARGS, { env: { FIXTURE_MODE: mode } }), safeError('AUTH_FAILED'));
  });
}

test('write or unlisted argv shapes are refused before spawn', async () => {
  const pidFile = join(directory, 'refused.pid');
  const badShapes = [
    ['repo', 'create', REPO], ['repo', 'delete', REPO],
    ['issue', 'create', '--repo', REPO], ['issue', 'comment', '2', '--repo', REPO],
    ['pr', 'merge', '3', '--repo', REPO], ['pr', 'create', '--repo', REPO],
    ['repo', 'view', REPO], ['repo', 'view', REPO, '--json', 'url'],
    ['issue', 'view', '2', '--repo', REPO, '--json', 'number'],
    ['issue', 'view', '0', '--repo', REPO, '--json', 'number,title,body,state,url,closedByPullRequestsReferences'],
    ['issue', 'view', '2', '--repo', 'github.com/other/repo', '--json', 'number,title,body,state,url,closedByPullRequestsReferences'],
    ['pr', 'view', '3', '--repo', 'github.com/other/repo', '--json', 'number,title,state,url,headRefOid,baseRefName,mergedAt'],
    ['repo', 'view', 'not-a-repo', '--json', 'nameWithOwner,url,isPrivate,defaultBranchRef'],
    ['repo', 'view', `${HOST}/demo/repo/extra`, '--json', 'nameWithOwner,url,isPrivate,defaultBranchRef'],
    [...REPO_ARGS, '--extra'], ['status'],
  ];
  for (const args of badShapes) {
    await assert.rejects(run(args, { env: { FIXTURE_PID_FILE: pidFile } }), safeError('BAD_TARGET'));
  }
  await assert.rejects(access(pidFile), { code: 'ENOENT' });
});

test('production path requires an absolute native executable', async () => {
  await assert.rejects(runGh({ allowedHost: HOST, args: REPO_ARGS }), safeError('INVALID_OPTIONS'));
  await assert.rejects(runGh({ executable: 'gh', allowedHost: HOST, args: REPO_ARGS }), safeError('INVALID_OPTIONS'));
});

test('missing executable and nonexistent cwd stay sanitized', async () => {
  const missing = join(directory, canary);
  await assert.rejects(run(REPO_ARGS, { executable: missing, prefixArgs: [] }), safeError('CLI_NOT_FOUND', [missing]));
  await assert.rejects(run(REPO_ARGS, { cwd: missing }), safeError('CLI_NOT_FOUND', [missing]));
});

for (const payload of ['', '[]', 'null', '"s"', '{}{}', '{"x":1,}', 'not-json']) {
  test(`rejects malformed JSON ${JSON.stringify(payload)}`, async () => {
    await assert.rejects(run(REPO_ARGS, { env: { FIXTURE_MODE: 'payload', FIXTURE_PAYLOAD: payload } }), safeError('INVALID_JSON'));
  });
}

test('invalid runner options reject before launch', async () => {
  const pidFile = join(directory, 'invalid-options.pid');
  const cases = [
    { extra: true }, { executable: '' }, { allowedHost: '' }, { allowedHost: 'a/b' },
    ...[0, -1, 0.5, NaN, Infinity, '10', null, 2147483648].map((timeoutMs) => ({ timeoutMs })),
    ...[null, {}, 'bad', [2], [''], ['bad\0arg'], ['-e', 'x'], ['relative.mjs'],
      [fixture, '--token=canary']].map((prefixArgs) => ({ prefixArgs })),
    { executable: 'gh', prefixArgs: [fixture] },
  ];
  for (const options of cases) {
    await assert.rejects(run(REPO_ARGS, { env: { FIXTURE_PID_FILE: pidFile }, ...options }), safeError('INVALID_OPTIONS'));
  }
  for (const args of [undefined, [], 'bad', [2]]) {
    await assert.rejects(runGh({
      executable: process.execPath, prefixArgs: [fixture], allowedHost: HOST,
      args, env: { FIXTURE_PID_FILE: pidFile },
    }), safeError('BAD_TARGET'));
  }
  await assert.rejects(access(pidFile), { code: 'ENOENT' });
});

test('timeout and cancellation behave like the DOP runner', async () => {
  const pidFile = join(directory, 'gh-timeout.pid');
  await assert.rejects(run(REPO_ARGS, {
    timeoutMs: 350, env: { FIXTURE_MODE: 'hang', FIXTURE_PID_FILE: pidFile },
  }), safeError('CLI_TIMEOUT'));
  await assertDead(pidFile);
  const controller = new AbortController();
  controller.abort(canary);
  await assert.rejects(run(REPO_ARGS, { signal: controller.signal }), safeError('CLI_CANCELLED'));
});

test('timeout cleans inherited descriptors and the descendant process', { timeout: 5000 }, async () => {
  const pidFile = join(directory, 'gh-descendant.pid');
  let pid;
  try {
    await assert.rejects(run(REPO_ARGS, {
      timeoutMs: 800, env: { FIXTURE_MODE: 'inherited-pipes', FIXTURE_DESCENDANT_FILE: pidFile },
    }), safeError('CLI_TIMEOUT'));
    pid = Number(await readFile(pidFile, 'utf8'));
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
      await delay(10);
    }
    assert.fail('descendant survived process-tree cleanup');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already dead. */ } }
  }
});

test('unknown error codes cannot inject messages', async () => {
  assert.equal(new GhProcessError(canary).code, 'INVALID_OPTIONS');
  assert.ok(!new GhProcessError('CLI_FAILED', canary).message.includes(canary));
  assert.equal(getEventListeners(new AbortController().signal, 'abort').length, 0);
});
