import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DopProcessError, runDopChange } from '../src/dop-process.mjs';

let directory;
let fixture;
const canary = 'FIXTURE_ONLY_PRIVATE_CANARY';

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-dop-process-')));
  // A real child process, never a fake spawn implementation or the real dop CLI.
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

function run(mode = 'echo', options = {}) {
  return runDopChange({
    changeId: 'AB123', executable: process.execPath, prefixArgs: [fixture],
    env: { FIXTURE_MODE: mode }, ...options,
  });
}

function safeError(code, forbidden = []) {
  return (error) => {
    assert.ok(error instanceof DopProcessError);
    assert.equal(error.name, 'DopProcessError');
    assert.equal(error.code, code);
    assert.equal(error.message, new DopProcessError(code).message);
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

test('returns a JSON object with exact read-only argv, cwd, explicit env, and no credential argv', async () => {
  const result = await run('echo', {
    cwd: directory,
    env: { FORGE_TEST_EXPLICIT: canary },
  });
  assert.deepEqual(result, {
    argv: ['change', 'view', 'AB123', '-j'], cwd: directory, explicit: canary, ambient: null,
  });
  assert.ok(!result.argv.join(' ').includes(canary));
});

test('omitted env never forwards an ambient synthetic credential/configuration value', async () => {
  const previous = process.env.FORGE_TEST_AMBIENT;
  process.env.FORGE_TEST_AMBIENT = canary;
  try {
    assert.equal((await run('echo', { env: undefined })).ambient, null);
    assert.equal((await run('echo', { env: {} })).ambient, null);
  } finally {
    if (previous === undefined) delete process.env.FORGE_TEST_AMBIENT;
    else process.env.FORGE_TEST_AMBIENT = previous;
  }
});

test('stdin is ignored and reaches EOF, with no prompt interaction', async () => {
  assert.deepEqual(await run('stdin'), { stdin: '' });
});

test('stderr canary is neither exposed in success nor in nonzero failure', async () => {
  assert.deepEqual(await run('stderr'), { ok: true });
  await assert.rejects(run('fail'), safeError('CLI_FAILED'));
});

for (const mode of ['auth401', 'auth403', 'split-auth']) {
  test(`${mode} returns sanitized AUTH_FAILED (including exit zero and chunk splits)`, async () => {
    await assert.rejects(run(mode), safeError('AUTH_FAILED'));
  });
}

test('missing executable and nonexistent cwd never expose process error paths', async () => {
  const missing = join(directory, canary);
  await assert.rejects(run('echo', { executable: missing, prefixArgs: [] }), safeError('CLI_NOT_FOUND', [missing]));
  await assert.rejects(run('echo', { cwd: missing }), safeError('CLI_NOT_FOUND', [missing]));
});

test('non-executable path and child signal exit return sanitized CLI_FAILED', async () => {
  await assert.rejects(run('echo', { executable: directory, prefixArgs: [] }), safeError('CLI_FAILED', [directory]));
  await assert.rejects(run('signal'), safeError('CLI_FAILED'));
});

test('change ID validation occurs before any child can spawn (including shell injection)', async () => {
  const pidFile = join(directory, 'invalid-id.pid');
  for (const changeId of [undefined, null, '', 1, 'A1', 'ABCDEFG1', 'ab123', 'AB', 'AB-1',
    'AB1\n', 'AB1\r', 'AB1\r\n', ' AB1', 'AB1 ', 'AB1; echo injected', '$(echo AB1)',
    'AB1&&echo injected', 'AB1\0', 'AB1 -j', 'AB１']) {
    await assert.rejects(run('echo', { changeId, env: { FIXTURE_PID_FILE: pidFile } }), safeError('BAD_CHANGE_ID'));
  }
  await assert.rejects(access(pidFile), { code: 'ENOENT' });
  await assert.rejects(runDopChange(), safeError('BAD_CHANGE_ID'));
});

test('minimum and maximum prefix lengths and numeric suffixes are accepted', async () => {
  for (const changeId of ['AA0', 'ABCDEF1234567890']) {
    assert.deepEqual((await run('echo', { changeId })).argv, ['change', 'view', changeId, '-j']);
  }
});

for (const payload of ['', ' ', canary, '[]', '[{}]', 'null', 'true', '1', '"string"', '{}{}', '{"x":1,}', '\ufeff{}']) {
  test(`rejects non-object or malformed JSON ${JSON.stringify(payload)}`, async () => {
    await assert.rejects(run('payload', { env: { FIXTURE_MODE: 'payload', FIXTURE_PAYLOAD: payload } }), safeError('INVALID_JSON'));
  });
}

test('accepts only strict complete JSON objects, retaining nested data', async () => {
  const data = { items: [1, null, { title: '系统变更' }], valid: false };
  assert.deepEqual(await run('payload', {
    env: { FIXTURE_MODE: 'payload', FIXTURE_PAYLOAD: ` \n${JSON.stringify(data)}\n ` },
  }), data);
  await assert.rejects(run('invalid-utf8'), safeError('INVALID_JSON'));
});

for (const mode of ['stdout-overflow', 'stderr-overflow']) {
  test(`${mode} is bounded and kills the real process before rejecting`, async () => {
    const pidFile = join(directory, `${mode}.pid`);
    await assert.rejects(run(mode, {
      maxOutputBytes: 32, env: { FIXTURE_MODE: mode, FIXTURE_PID_FILE: pidFile },
    }), safeError('OUTPUT_LIMIT'));
    await assertDead(pidFile);
  });
}

test('stdout and stderr share a byte budget with an inclusive exact boundary', async () => {
  assert.deepEqual(await run('combined', { maxOutputBytes: 6 }), {});
  await assert.rejects(run('combined', { maxOutputBytes: 5 }), safeError('OUTPUT_LIMIT'));
  assert.deepEqual(await run('payload', {
    maxOutputBytes: 2, env: { FIXTURE_MODE: 'payload', FIXTURE_PAYLOAD: '{}' },
  }), {});
});

test('timeout kills even a SIGTERM-resistant process and does not retry', async () => {
  const pidFile = join(directory, 'timeout.pid');
  await assert.rejects(run('hang', {
    timeoutMs: 350, env: { FIXTURE_MODE: 'hang', FIXTURE_PID_FILE: pidFile },
  }), safeError('CLI_TIMEOUT'));
  await assertDead(pidFile);
});

test('pre-cancellation launches no process', async () => {
  const controller = new AbortController();
  const pidFile = join(directory, 'pre-cancel.pid');
  controller.abort(canary);
  await assert.rejects(run('hang', {
    signal: controller.signal, env: { FIXTURE_MODE: 'hang', FIXTURE_PID_FILE: pidFile },
  }), safeError('CLI_CANCELLED'));
  await assert.rejects(access(pidFile), { code: 'ENOENT' });
});

test('in-flight cancellation kills the child, sanitizes reason, and removes abort listener', async () => {
  const controller = new AbortController();
  const pidFile = join(directory, 'cancel.pid');
  const pending = run('hang', {
    signal: controller.signal, env: { FIXTURE_MODE: 'hang', FIXTURE_PID_FILE: pidFile },
  });
  const checked = assert.rejects(pending, safeError('CLI_CANCELLED'));
  await awaitPid(pidFile);
  controller.abort(new Error(canary));
  await checked;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assertDead(pidFile);
});

test('completed process detaches abort listener and tolerates later cancellation', async () => {
  const controller = new AbortController();
  assert.deepEqual(await run('combined', { signal: controller.signal }), {});
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(canary);
});

test('timeout cleans inherited descriptors AND the descendant process, not only the wrapper', { timeout: 5000 }, async () => {
  const pidFile = join(directory, 'descendant.pid');
  let pid;
  try {
    await assert.rejects(run('inherited-pipes', { timeoutMs: 800, env: { FIXTURE_MODE: 'inherited-pipes', FIXTURE_DESCENDANT_FILE: pidFile } }), safeError('CLI_TIMEOUT'));
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

test('invalid runner options reject before launch', async () => {
  const pidFile = join(directory, 'invalid-options.pid');
  const cases = [
    { extra: true }, { executable: '' }, { executable: 5 }, { executable: 'bad\0path' },
    { cwd: '' }, { cwd: 2 }, { cwd: 'bad\0path' },
    ...[0, -1, 0.5, NaN, Infinity, '10', null, 2147483648].map((timeoutMs) => ({ timeoutMs })),
    ...[0, -1, 0.5, NaN, Infinity, '10', null, Number.MAX_SAFE_INTEGER + 1].map((maxOutputBytes) => ({ maxOutputBytes })),
    ...[null, true, {}, { aborted: false, addEventListener() {} }].map((signal) => ({ signal })),
    ...[null, {}, 'bad', [2], Array(1), [''], ['bad\0arg'], ['-e', 'process.exit(0)'], ['relative.mjs'],
      [fixture, '--token=canary'], [fixture, '--password', canary], [fixture, '--api-key=canary'],
      [fixture, '--authorization=canary']].map((prefixArgs) => ({ prefixArgs })),
    { executable: 'dop', prefixArgs: [fixture] },
    ...[null, [], 'bad', { BAD: 1 }, { BAD: undefined }, { '': 'x' }, { 'A=B': 'x' },
      { 'BAD\0KEY': 'x' }, { BAD: 'x\0y' }].map((env) => ({ env })),
  ];
  for (const options of cases) {
    await assert.rejects(run('echo', {
      env: { FIXTURE_PID_FILE: pidFile }, ...options,
    }), safeError('INVALID_OPTIONS'));
  }
  for (const options of [null, [], 'bad', 1, new Date()]) {
    await assert.rejects(runDopChange(options), safeError('INVALID_OPTIONS'));
  }
  await assert.rejects(access(pidFile), { code: 'ENOENT' });
});

test('validation failures from option accessors are sanitized', async () => {
  await assert.rejects(runDopChange({ get changeId() { throw new Error(canary); } }), safeError('INVALID_OPTIONS'));
});

test('null-prototype options/env are accepted, and unknown error codes cannot inject messages', async () => {
  const options = Object.assign(Object.create(null), {
    changeId: 'AB123', executable: process.execPath, prefixArgs: [fixture], env: Object.create(null),
  });
  assert.equal((await runDopChange(options)).argv[2], 'AB123');
  assert.equal(new DopProcessError(canary).code, 'INVALID_OPTIONS');
  assert.ok(!new DopProcessError('CLI_FAILED', canary).message.includes(canary));
});
