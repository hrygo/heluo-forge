/**
 * Entry tests of the desktop shell: how the embedded dsh is handed the pnpm
 * the app ships, which is what lets a machine without Node or pnpm install
 * the enterprise plugin.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EMBEDDED_ENTRY, packageManagerFor, runEmbeddedCli } from '../src/embedded-cli.mjs';
import { ShellError } from '../src/errors.mjs';
import { DSH_ENTRY_PARTS, PNPM_ENTRY_PARTS } from '../src/layout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the entry is this module itself, the file the shell starts', () => {
  assert.equal(EMBEDDED_ENTRY, join(HERE, '..', 'src', 'embedded-cli.mjs'));
  assert.equal(existsSync(EMBEDDED_ENTRY), true);
});

test('the package manager is the app binary as Node, running the staged pnpm, and nothing more', () => {
  const manager = packageManagerFor({ command: '/apps/heluo', pnpmEntry: '/apps/Resources/pnpm/bin/pnpm.mjs' });
  // Exactly what dsh runs for every package operation: no PATH lookup, no inherited variable.
  assert.deepEqual(manager, { command: '/apps/heluo', args: ['/apps/Resources/pnpm/bin/pnpm.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(Object.keys(manager.env), ['ELECTRON_RUN_AS_NODE']);
});

test('反向：缺应用二进制或缺 pnpm 入口时不给出包管理器', () => {
  const valid = { command: '/apps/heluo', pnpmEntry: '/apps/Resources/pnpm/bin/pnpm.mjs' };
  for (const missing of [{ command: undefined }, { command: '' }, { pnpmEntry: undefined }, { pnpmEntry: '' }]) {
    assert.throws(
      () => packageManagerFor({ ...valid, ...missing }),
      (error) => error instanceof ShellError && error.code === 'BAD_ARGUMENT',
    );
  }
  // The same two values, given whole, are accepted: it is the missing one that is refused.
  assert.deepEqual(Object.keys(packageManagerFor(valid)), ['command', 'args', 'env']);
});

test('the dsh command line is run once, with the package manager as its only option', async () => {
  const calls = [];
  const loaded = [];
  const runCli = async (options) => {
    calls.push(options);
  };
  await runEmbeddedCli({
    command: '/apps/heluo',
    dshEntry: '/apps/Resources/dsh/lib/bin.js',
    pnpmEntry: '/apps/Resources/pnpm/bin/pnpm.mjs',
    load: async (path) => {
      loaded.push(path);
      return { runCli };
    },
  });
  assert.deepEqual(loaded, ['/apps/Resources/dsh/lib/bin.js']);
  // dsh reads the arguments itself; the only thing added is where pnpm comes from.
  assert.deepEqual(calls, [{ packageManager: { command: '/apps/heluo', args: ['/apps/Resources/pnpm/bin/pnpm.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } } }]);
});

test('反向：dsh 入口加载失败或不提供命令行入口时拒绝；dsh 自己的失败原样上抛，不被改写', async () => {
  const input = { command: '/apps/heluo', dshEntry: '/apps/Resources/dsh/lib/bin.js', pnpmEntry: '/apps/Resources/pnpm/bin/pnpm.mjs' };
  const loading = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });
  await assert.rejects(runEmbeddedCli({ ...input, load: async () => { throw loading; } }), (error) => error === loading);

  for (const entry of [{}, { runCli: 'function' }, undefined]) {
    await assert.rejects(
      runEmbeddedCli({ ...input, load: async () => entry }),
      (error) => error instanceof ShellError && error.code === 'EMBEDDED_RUNTIME_MISSING',
    );
  }

  // A failure inside dsh keeps its code and its message: it is not turned into a shell code.
  const startup = Object.assign(new Error('profile is locked'), { code: 'ELOCKED' });
  await assert.rejects(runEmbeddedCli({ ...input, load: async () => ({ runCli: async () => { throw startup; } }) }), (error) => error === startup);

  // dsh is loaded before the package manager is checked, and never run without one.
  let loads = 0;
  const runs = [];
  await assert.rejects(
    runEmbeddedCli({ ...input, pnpmEntry: '', load: async () => { loads += 1; return { runCli: (...args) => { runs.push(args); } }; } }),
    (error) => error instanceof ShellError && error.code === 'BAD_ARGUMENT',
  );
  assert.equal(loads, 1);
  assert.deepEqual(runs, []);
});

test('importing the entry starts nothing; only the packaged app can run it as a command', async () => {
  // The module was imported by this file: nothing ran, or the test process would have left.
  const source = readFileSync(EMBEDDED_ENTRY, 'utf8');
  assert.match(source, /if \(import\.meta\.main\)/u);
  // Started as a command outside the app there is no resources directory: it refuses, and says why.
  const run = spawnSync(process.execPath, [EMBEDDED_ENTRY, 'plugin', '--profile', 'web', 'add', 'x.tgz'], { encoding: 'utf8', timeout: 20_000 });
  assert.notEqual(run.status, 0, 'the command must not report success');
  assert.match(run.stderr, /ShellError: this entry runs only from the packaged application/u);
  // Both resource paths are the layout's.
  assert.deepEqual(PNPM_ENTRY_PARTS, ['pnpm', 'bin', 'pnpm.mjs']);
  assert.deepEqual(DSH_ENTRY_PARTS, ['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']);
});
