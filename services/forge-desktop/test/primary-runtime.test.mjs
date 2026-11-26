/**
 * Tests of how the shell hands the bundled runtime to the web profile
 * (CORP-DSH-DESIGN-025).
 *
 * `scripts/stage-primary-runtime.mjs` stages upstream's payload; the shell only
 * names its directory in a child's environment, and the enterprise bundle's
 * patch layer lets upstream's own rows read that name. These tests hold the
 * three sides to one variable name, and to the rule that nothing inherited may
 * supply it. `main.mjs` itself is not executed here: it is read as text, the
 * way the package-shape tests read it.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PRIMARY_RUNTIME_DIR, PRIMARY_RUNTIME_VARIABLE } from '../src/layout.mjs';
import { primaryRuntimeVariable } from '../src/primary-runtime.mjs';
import { childEnvironment, parseNulEnv, parseShellEnv } from '../src/shell-env.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const refused = (code) => (error) => typeof error?.code === 'string' && error.code === code;
const other = (value) => (value === 'arm64' ? 'x64' : 'arm64');

const NATIVE = {
  desktopVersion: 'v0.0.0-test',
  platform: process.platform,
  arch: process.arch,
  python: '3.12.14',
  node: process.versions.node,
  pnpm: '11.28.5-test',
  pythonPackages: { numpy: '2.3.5' },
};

/** A resources directory with a payload manifest in it; none at all when `manifest` is left out. */
function resources(t, manifest) {
  const root = mkdtempSync(join(tmpdir(), 'forge-shell-runtime-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, PRIMARY_RUNTIME_DIR), { recursive: true });
  if (manifest !== undefined) writeFileSync(join(root, PRIMARY_RUNTIME_DIR, 'runtime.json'), typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

/** Why `main.mjs` would not hand the bundled runtime to its children; empty when it does. */
function mainProblems(main) {
  const problems = [];
  if (!/import \{ primaryRuntimeVariable \} from '\.\/primary-runtime\.mjs';/u.test(main)) problems.push("main.mjs must take the bundled runtime's variable from ./primary-runtime.mjs");
  if (!/\.\.\.primaryRuntimeVariable\(process\.resourcesPath\),/u.test(main)) problems.push('main.mjs must spread primaryRuntimeVariable into the environment of its children');
  if (!/return \{\s*\.\.\.childEnvironment\(/u.test(main)) problems.push('the children\u2019s environment must be the merged one plus the bundled runtime, built in one place');
  if (/'primary-runtime'|DSH_PRIMARY_RUNTIME/u.test(main)) problems.push('main.mjs must not inline the payload directory or the variable name');
  return problems;
}

test('布局：载荷目录与变量名是 layout.mjs 的两个常量', () => {
  assert.equal(PRIMARY_RUNTIME_DIR, 'primary-runtime');
  assert.equal(PRIMARY_RUNTIME_VARIABLE, 'DSH_PRIMARY_RUNTIME', "upstream's rows are keyed to this exact name");
});

test('随包运行时以一个变量交出载荷目录，壳不读载荷内部', (t) => {
  const root = resources(t, NATIVE);
  assert.deepEqual(primaryRuntimeVariable(root), { [PRIMARY_RUNTIME_VARIABLE]: join(root, PRIMARY_RUNTIME_DIR) });
});

test('反向：载荷缺失、清单不可读或为别的机器构建时，壳拒绝启动（变异证明）', (t) => {
  const cases = [
    ['no payload was staged', resources(t), /missing its manifest/u],
    ['the manifest is not JSON', resources(t, '{ not json'), /no readable manifest/u],
    ['the manifest names no target', resources(t, { desktopVersion: 'v0.0.0-test' }), /built for undefined-undefined/u],
    ['built for another architecture', resources(t, { ...NATIVE, arch: other(process.arch) }), new RegExp(`built for ${process.platform}-${other(process.arch)}, not for ${process.platform}-${process.arch}`, 'u')],
    ['built for another platform', resources(t, { ...NATIVE, platform: process.platform === 'darwin' ? 'linux' : 'darwin' }), /built for /u],
  ];
  for (const [label, root, pattern] of cases) {
    assert.throws(() => primaryRuntimeVariable(root), (error) => refused('EMBEDDED_RUNTIME_MISSING')(error) && pattern.test(error.message), label);
  }
});

test('继承环境里的同名变量被剥离，只有壳给出的位置到达子进程', (t) => {
  const root = resources(t, NATIVE);
  const gui = { PATH: '/usr/bin', [PRIMARY_RUNTIME_VARIABLE]: '/from/the/gui/environment' };
  const login = { [PRIMARY_RUNTIME_VARIABLE]: '/from/the/login/shell', HOME: '/profiles/someone' };
  const inherited = childEnvironment(gui, login, { prepend: [] });
  assert.equal(PRIMARY_RUNTIME_VARIABLE in inherited, false, 'neither the GUI environment nor the login shell names the payload');
  assert.equal('DSH_PRIMARY_RUNTIME' in parseNulEnv(`DSH_PRIMARY_RUNTIME=/from/env-0\0HOME=/profiles/someone\0`), false);
  assert.equal('DSH_PRIMARY_RUNTIME' in parseShellEnv(`DSH_PRIMARY_RUNTIME=/from/printenv\nHOME=/profiles/someone\n`), false);
  assert.deepEqual(
    { ...inherited, ...primaryRuntimeVariable(root) },
    { PATH: '/usr/bin', HOME: '/profiles/someone', DSH_PRIMARY_RUNTIME: join(root, PRIMARY_RUNTIME_DIR) },
    'the app\u2019s own location is the only one a child ever sees',
  );
});

test('通用底座的补丁层按同一个变量名解锁，且不读别的环境变量', async () => {
  const patch = await readFile(join(REPO_ROOT, 'packages', 'forge-enterprise', 'cordis.patch.yml'), 'utf8');
  const body = patch
    .split('\n')
    .map((line) => line.replace(/#.*$/u, ''))
    .join('\n');
  const variables = [...new Set([...body.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]))];
  assert.deepEqual(variables, [PRIMARY_RUNTIME_VARIABLE], 'the bundle reads exactly the variable the shell sets');
  // The tool's own gate, the payload's location, and the Office skills' choice of interpreter.
  assert.equal(body.split(`process.env.${PRIMARY_RUNTIME_VARIABLE}`).length - 1, 3);
});

test('main.mjs 把变量并入子进程环境，路径与变量名都来自模块而不内联（变异证明）', async () => {
  const main = await readFile(join(PKG_ROOT, 'src', 'main.mjs'), 'utf8');
  assert.deepEqual(mainProblems(main), []);
  const variants = [
    ['without the import', main.replace("import { primaryRuntimeVariable } from './primary-runtime.mjs';\n", ''), /primary-runtime\.mjs/u],
    ['without the spread', main.replace('    ...primaryRuntimeVariable(process.resourcesPath),\n', ''), /must spread primaryRuntimeVariable/u],
    ['a return that is the merged environment alone', main.replace(/return \{\s*\.\.\.childEnvironment\(/u, 'return childEnvironment('), /built in one place/u],
    ['the directory inlined', main.replace('...primaryRuntimeVariable(process.resourcesPath),', "...{ DSH_PRIMARY_RUNTIME: join(process.resourcesPath, 'primary-runtime') },"), /must not inline/u],
  ];
  for (const [label, variant, pattern] of variants) {
    assert.notEqual(variant, main, `${label}: the mutation must change the file`);
    const problems = mainProblems(variant);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${label}: ${problems.join('; ') || 'no problem reported'}`);
  }
});
