/**
 * Command execution tests of the desktop shell: one shape of result for every
 * outcome, and the executor that lets the installer reach the embedded
 * runtime and nothing else.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { embeddedExec, MAX_CAPTURE, runCommand } from '../src/process.mjs';

/** A stand-in for child_process.spawn: the test decides what each child does. */
function fakeSpawn(script = () => {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = { ended: undefined, on() {}, end(input) { this.ended = input; } };
    child.kills = [];
    child.kill = (signal) => {
      child.kills.push(signal);
    };
    calls.push({ command, args, options, child });
    // The caller attaches its listeners after spawn returns.
    queueMicrotask(() => script(child, { command, args, options }));
    return child;
  };
  return { spawn, calls };
}

const prints = (child, { out = '', err = '', code = 0 }) => {
  if (out !== '') child.stdout.emit('data', out);
  if (err !== '') child.stderr.emit('data', err);
  child.emit('close', code);
};

test('a command reports its exit code and what it printed, run without a shell', async () => {
  const { spawn, calls } = fakeSpawn((child) => prints(child, { out: 'installed\n', err: 'warning\n', code: 3 }));
  const env = { PATH: '/usr/bin' };
  const result = await runCommand('/bin/tool', ['--flag', 'a b'], { env, cwd: '/work', input: 'secret\n', timeout: 1_000, spawn });
  assert.deepEqual(result, { code: 3, stdout: 'installed\n', stderr: 'warning\n' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--flag', 'a b']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env, env);
  assert.equal(calls[0].options.cwd, '/work');
  // Input reaches stdin; a timeout arms nothing as long as the command finishes.
  assert.equal(calls[0].child.stdin.ended, 'secret\n');
  assert.deepEqual(calls[0].child.kills, []);
});

test('a command that cannot start, crashes or is killed still resolves, with a non-zero code', async () => {
  const failing = fakeSpawn((child) => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
  const failed = await runCommand('/absent', [], { spawn: failing.spawn });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /spawn ENOENT/);
  assert.equal(failed.stdout, '');

  const throwing = () => {
    throw new TypeError('The argument "args" must be of type string');
  };
  const thrown = await runCommand('/bin/tool', null, { spawn: throwing });
  assert.equal(thrown.code, 1);
  assert.match(thrown.stderr, /could not be started/);

  // A signal has no exit code: that is not success.
  const signalled = fakeSpawn((child) => child.emit('close', null, 'SIGTERM'));
  assert.equal((await runCommand('/bin/tool', [], { spawn: signalled.spawn })).code, 1);
});

test('a command that outlives its timeout is killed and said so', async () => {
  const { spawn, calls } = fakeSpawn((child) => {
    // It answers a kill by closing, the way a real process does.
    child.kill = (signal) => {
      child.kills.push(signal);
      child.emit('close', null, signal);
    };
  });
  const result = await runCommand('/bin/slow', ['wait'], { timeout: 10, spawn });
  assert.equal(result.code, 1);
  assert.deepEqual(calls[0].child.kills, ['SIGKILL']);
  assert.match(result.stderr, /did not finish within 10 ms and was killed/);
});

test('the embedded executor runs only the embedded runtime, as Node, with the dsh entry first', async () => {
  const { spawn, calls } = fakeSpawn((child) => prints(child, { out: '{}', code: 0 }));
  const base = { PATH: '/app/bin:/usr/bin', HOME: '/profiles/someone' };
  const exec = embeddedExec({ command: '/apps/electron', entry: '/apps/dsh/lib/bin.js', env: base, spawn });

  // Another binary is refused before anything starts.
  const refused = await exec('/usr/bin/dsh', ['--version'], {});
  assert.equal(refused.code, 1);
  assert.equal(calls.length, 0);

  const env = { PATH: '/usr/bin', DSH_HOME: '/profiles/someone/.dsh' };
  await exec('/apps/electron', ['--profile', 'web', '--dump-config'], { timeout: 5_000, input: 'x', env, cwd: '/work' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['/apps/dsh/lib/bin.js', '--profile', 'web', '--dump-config']);
  assert.equal(calls[0].command, '/apps/electron');
  // The caller's environment wins over the base one; the Node switch is the executor's alone.
  assert.deepEqual(calls[0].options.env, { ...base, ...env, ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(calls[0].options.cwd, '/work');
  assert.equal(calls[0].child.stdin.ended, 'x');
  assert.equal(calls[0].options.shell, false);
  // The base environment object itself is left as it was.
  assert.equal(base.ELECTRON_RUN_AS_NODE, undefined);

  // A step that outlives its deadline is killed, like any other command.
  const { spawn: hanging, calls: hung } = fakeSpawn((child) => {
    child.kill = (signal) => {
      child.kills.push(signal);
      child.emit('close', null, signal);
    };
  });
  const timedOut = await embeddedExec({ command: '/apps/electron', entry: '/apps/dsh/lib/bin.js', spawn: hanging })('/apps/electron', ['plugin', 'add'], { timeout: 10 });
  assert.equal(timedOut.code, 1);
  assert.deepEqual(hung[0].child.kills, ['SIGKILL']);
  assert.match(timedOut.stderr, /did not finish within 10 ms/);

  // Even an inherited switch cannot turn the child into anything else.
  const forced = await exec('/apps/electron', [], { env: { ELECTRON_RUN_AS_NODE: '0' }, spawn });
  assert.equal(forced.code, 0);
  assert.equal(calls[1].options.env.ELECTRON_RUN_AS_NODE, '1');
});

test('what a command prints is kept up to a limit, the end first', async () => {
  const { spawn } = fakeSpawn((child) => {
    child.stdout.emit('data', 'BEGINNING' + '0'.repeat(400_000));
    child.stdout.emit('data', '1'.repeat(400_000));
    child.stdout.emit('data', '2'.repeat(400_000));
    child.stderr.emit('data', 'z'.repeat(MAX_CAPTURE + 10));
    child.emit('close', 0);
  });
  const result = await runCommand('/bin/chatty', [], { spawn });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, MAX_CAPTURE);
  // More than the limit was printed: its beginning is gone, its end is kept.
  assert.equal(result.stdout.includes('BEGINNING'), false);
  assert.equal(result.stdout.endsWith('2'), true);
  assert.equal(result.stderr.length, MAX_CAPTURE);
});
