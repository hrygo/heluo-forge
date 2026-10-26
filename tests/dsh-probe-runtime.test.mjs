import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { resolveDshProbeHost } from '../scripts/lib/dsh-probe-runtime.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-probe-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (relative, content = '') => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  return { root, file };
}

test('probe host: ordinary CLI resolves from its real path, including PATH symlinks', (t) => {
  const { root, file } = fixture(t);
  const cli = file('installed/bin/dsh');
  mkdirSync(join(root, 'commands'));
  symlinkSync(cli, join(root, 'commands/dsh'));
  assert.deepEqual(resolveDshProbeHost({ dsh: 'dsh', searchPath: join(root, 'commands') }), {
    anchor: realpathSync(cli),
    runtime: null,
    kind: 'node-cli',
  });
});

test('probe host: packaged macOS CLI selects its own Electron runtime and ASAR SDK', (t) => {
  const { root, file } = fixture(t);
  const cli = file('Renamed App.app/Contents/Resources/runtime/cli/bin/dsh', '#!/bin/sh\n');
  file('Renamed App.app/Contents/Resources/app.asar');
  const runtime = file('Renamed App.app/Contents/MacOS/Renamed App');
  chmodSync(runtime, 0o755);
  const result = resolveDshProbeHost({ dsh: cli });
  assert.deepEqual(result, {
    anchor: join(realpathSync(root), 'Renamed App.app/Contents/Resources/app.asar/dsh/package.json'),
    runtime: realpathSync(runtime),
    kind: 'electron-asar',
  });
});

test('probe host: explicit SDK modules take precedence over CLI discovery', (t) => {
  const { root } = fixture(t);
  const modules = join(root, 'custom/node_modules');
  assert.deepEqual(resolveDshProbeHost({ dsh: 'absent', searchPath: '', modules }), {
    anchor: join(modules, '__probe__.cjs'),
    runtime: null,
    kind: 'explicit-modules',
  });
});

test('probe host: missing CLI fails instead of selecting an unrelated SDK', () => {
  assert.throws(() => resolveDshProbeHost({ dsh: 'missing-probe-cli', searchPath: '' }), /DSH executable not found/);
});

test('probe host: ambiguous desktop executables fail instead of guessing', (t) => {
  const { file } = fixture(t);
  const cli = file('DSH.app/Contents/Resources/runtime/cli/bin/dsh');
  file('DSH.app/Contents/Resources/app.asar');
  for (const name of ['DSH', 'other']) chmodSync(file(`DSH.app/Contents/MacOS/${name}`), 0o755);
  assert.throws(() => resolveDshProbeHost({ dsh: cli }), /exactly one executable/);
});
