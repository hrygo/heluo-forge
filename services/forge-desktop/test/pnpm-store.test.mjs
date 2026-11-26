/**
 * Tests of the store probe: the shell asks the bundled runtime's pnpm — the
 * one every package operation will run — which store it resolves for the
 * profile, and hands the answer to the installer.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePnpmStore, STORE_PROBE_TIMEOUT_MS } from '../src/pnpm-store.mjs';

const NODE = '/apps/Resources/primary-runtime/dependencies/node/bin/node';
const PNPM = '/apps/Resources/primary-runtime/dependencies/pnpm/bin/pnpm.mjs';

/** A stand-in for the one-shot runner: it records the call and answers it. */
function fakeRun(answer) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const result = typeof answer === 'function' ? answer({ command, args, options }) : answer;
    return result ?? { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('the probe runs the bundled pnpm, through the payload Node, in the profile directory', async () => {
  const { calls, run } = fakeRun(() => ({ code: 0, stdout: '/store/v10\n', stderr: '' }));
  const store = await resolvePnpmStore({ nodeEntry: NODE, pnpmEntry: PNPM, cwd: '/dsh/profiles/heluo-desktop', env: { PATH: '/usr/bin' }, run });
  assert.equal(store, '/store/v10');
  assert.deepEqual(calls[0], {
    command: NODE,
    args: [PNPM, 'store', 'path'],
    options: { cwd: '/dsh/profiles/heluo-desktop', env: { PATH: '/usr/bin' }, timeout: STORE_PROBE_TIMEOUT_MS },
  });
});

test('the last non-empty line of the output is the store, whatever pnpm prints around it', async () => {
  for (const stdout of ['/store/v10\n\n', '\nwarning: something\n/store/v10\n', '/store/v10']) {
    const { run } = fakeRun(() => ({ code: 0, stdout, stderr: '' }));
    assert.equal(await resolvePnpmStore({ nodeEntry: NODE, pnpmEntry: PNPM, run }), '/store/v10');
  }
});

test('a probe that cannot name a store answers null: no store, not a failure of the first run', async () => {
  // The command itself failed (a profile directory that does not exist yet is one way).
  const failed = fakeRun(() => ({ code: 1, stdout: '', stderr: 'spawn ENOENT' }));
  assert.equal(await resolvePnpmStore({ nodeEntry: NODE, pnpmEntry: PNPM, cwd: '/nowhere', run: failed.run }), null);
  // Nothing readable in the output.
  for (const stdout of ['', '\n', 'not an absolute path', 'relative/store']) {
    const { run } = fakeRun(() => ({ code: 0, stdout, stderr: '' }));
    assert.equal(await resolvePnpmStore({ nodeEntry: NODE, pnpmEntry: PNPM, run }), null);
  }
  // Entries missing: nothing to ask.
  for (const missing of [{ nodeEntry: undefined }, { nodeEntry: '' }, { pnpmEntry: undefined }, { pnpmEntry: '' }]) {
    assert.equal(await resolvePnpmStore({ nodeEntry: NODE, pnpmEntry: PNPM, run: fakeRun().run, ...missing }), null);
  }
  // A thrown runner is a probe that failed, not the first run.
  const throwing = async () => { throw new Error('the one-shot runner is gone'); };
  assert.equal(await resolvePnpmStore({ nodeEntry: NODE, pnpmEntry: PNPM, run: throwing }), null);
});
