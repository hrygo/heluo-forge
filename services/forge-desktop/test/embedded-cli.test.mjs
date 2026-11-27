/**
 * Entry tests of the desktop shell: how the embedded dsh is handed the pnpm
 * the app ships — the one of the bundled runtime, run by its own Node — which
 * is what lets a machine without Node or pnpm install the enterprise plugin.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EMBEDDED_ENTRY, packageManagerFor, runEmbeddedCli } from '../src/embedded-cli.mjs';
import { ShellError } from '../src/errors.mjs';
import { DSH_ENTRY_PARTS, PRIMARY_RUNTIME_PNPM_PARTS, primaryRuntimeNodeParts } from '../src/layout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the entry is this module itself, the file the shell starts', () => {
  assert.equal(EMBEDDED_ENTRY, join(HERE, '..', 'src', 'embedded-cli.mjs'));
  assert.equal(existsSync(EMBEDDED_ENTRY), true);
});

test('the package manager is the bundled runtime Node, running the pnpm of the same payload, and nothing more', () => {
  const manager = packageManagerFor({ nodeEntry: '/apps/Resources/primary-runtime/dependencies/node/bin/node', pnpmEntry: '/apps/Resources/primary-runtime/dependencies/pnpm/bin/pnpm.mjs' });
  // Exactly what dsh runs for every package operation: the payload's own
  // interpreter and its pnpm, no PATH lookup, no Electron switch to merge.
  assert.deepEqual(manager, {
    command: '/apps/Resources/primary-runtime/dependencies/node/bin/node',
    args: ['/apps/Resources/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'],
    env: {},
  });
  assert.deepEqual(Object.keys(manager.env), []);
});

test('反向：缺载荷 Node 或缺 pnpm 入口时不给出包管理器', () => {
  const valid = { nodeEntry: '/apps/Resources/primary-runtime/dependencies/node/bin/node', pnpmEntry: '/apps/Resources/primary-runtime/dependencies/pnpm/bin/pnpm.mjs' };
  for (const missing of [{ nodeEntry: undefined }, { nodeEntry: '' }, { pnpmEntry: undefined }, { pnpmEntry: '' }]) {
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
    dshEntry: '/apps/Resources/dsh/lib/bin.js',
    nodeEntry: '/apps/Resources/primary-runtime/dependencies/node/bin/node',
    pnpmEntry: '/apps/Resources/primary-runtime/dependencies/pnpm/bin/pnpm.mjs',
    load: async (path) => {
      loaded.push(path);
      return { runCli };
    },
  });
  assert.deepEqual(loaded, ['/apps/Resources/dsh/lib/bin.js']);
  // dsh reads the arguments itself; the only thing added is where pnpm comes from.
  assert.deepEqual(calls, [{
    packageManager: {
      command: '/apps/Resources/primary-runtime/dependencies/node/bin/node',
      args: ['/apps/Resources/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'],
      env: {},
    },
  }]);
});

test('反向：dsh 入口加载失败或不提供命令行入口时拒绝；dsh 自己的失败原样上抛，不被改写', async () => {
  const input = {
    dshEntry: '/apps/Resources/dsh/lib/bin.js',
    nodeEntry: '/apps/Resources/primary-runtime/dependencies/node/bin/node',
    pnpmEntry: '/apps/Resources/primary-runtime/dependencies/pnpm/bin/pnpm.mjs',
  };
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

test('a runtime loaded from inside the archive installs the physical path layer first, keyed to that archive', async () => {
  const runtime = {
    nodeEntry: '/apps/Resources/primary-runtime/dependencies/node/bin/node',
    pnpmEntry: '/apps/Resources/primary-runtime/dependencies/pnpm/bin/pnpm.mjs',
  };
  const events = [];
  const record = {
    install: (input) => { events.push(['install', input]); },
    load: async () => { events.push(['load']); return { runCli() {} }; },
  };
  await runEmbeddedCli({ ...runtime, dshEntry: '/apps/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', ...record });
  assert.deepEqual(events, [['install', { archiveRoot: '/apps/Resources/app.asar' }], ['load']]);

  // A staged tree outside any archive has nothing to translate: the layer is not installed.
  events.length = 0;
  await runEmbeddedCli({ ...runtime, dshEntry: '/apps/Resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', ...record });
  assert.deepEqual(events, [['load']]);
});

test('importing the entry starts nothing; only the packaged app can run it as a command', async () => {
  // The module was imported by this file: nothing ran, or the test process would have left.
  const source = readFileSync(EMBEDDED_ENTRY, 'utf8');
  assert.match(source, /if \(import\.meta\.main\)/u);
  // Started as a command outside the app there is no resources directory: it refuses, and says why.
  const run = spawnSync(process.execPath, [EMBEDDED_ENTRY, 'plugin', '--profile', 'web', 'add', 'x.tgz'], { encoding: 'utf8', timeout: 20_000 });
  assert.notEqual(run.status, 0, 'the command must not report success');
  assert.match(run.stderr, /ShellError: this entry runs only from the packaged application/u);
  // Both resource paths are the layout's, for this platform and for Windows.
  assert.deepEqual(PRIMARY_RUNTIME_PNPM_PARTS, ['primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs']);
  assert.deepEqual(primaryRuntimeNodeParts('linux'), ['primary-runtime', 'dependencies', 'node', 'bin', 'node']);
  assert.deepEqual(primaryRuntimeNodeParts('win32'), ['primary-runtime', 'dependencies', 'node', 'bin', 'node.exe']);
  assert.deepEqual(DSH_ENTRY_PARTS, ['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']);
});
