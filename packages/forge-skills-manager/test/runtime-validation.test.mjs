import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectRuntime } from '../scripts/verify-runtime.mjs';

const baseline = readFileSync(new URL('../../../.dsh-version', import.meta.url), 'utf8').trim();
const requiredSdk = ['cordis', 'dsh-skill', 'dsh-scope', 'dsh-skill-filesystem', 'dsh-tool-skill'];

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-check-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, version = baseline) => {
    const directory = join(root, 'node_modules', '@deepseek-ai', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version, main: './index.js' }));
    writeFileSync(join(directory, 'index.js'), 'throw new Error("preflight must not execute SDK code");');
    return directory;
  };
  const runtime = put('dsh');
  for (const name of requiredSdk) put(name, name === 'cordis' ? '4.1.0' : baseline);
  return { root, runtime, put };
}

test('compatibility preflight resolves SDK entries only from the specified runtime', context => {
  const { root, runtime } = fixture(context);
  // inspectRuntime 对运行目录做 realpath（macOS 的 /var → /private/var 等），
  // 期望值必须同口径规范，否则只在无系统符号链接的平台成立。
  const canonicalRoot = realpathSync(root);
  const checked = inspectRuntime(runtime);
  assert.equal(checked.version, baseline);
  assert.equal(Object.keys(checked.entries).length, requiredSdk.length);
  for (const name of requiredSdk) {
    assert.equal(checked.entries['@deepseek-ai/' + name], join(canonicalRoot, 'node_modules', '@deepseek-ai', name, 'index.js'));
  }
});

test('missing runtime, wrong package identity and stale Host versions are rejected', context => {
  const { root, runtime, put } = fixture(context);
  assert.throws(() => inspectRuntime(), /directory is required/);
  assert.throws(() => inspectRuntime(join(root, 'missing')), /ENOENT/);
  const manifestPath = join(runtime, 'package.json');
  writeFileSync(manifestPath, JSON.stringify({ name: 'unrelated', version: baseline }));
  assert.throws(() => inspectRuntime(runtime), /installed @deepseek-ai\/dsh package/);
  put('dsh', baseline + '-stale');
  assert.throws(() => inspectRuntime(runtime), /installed DSH version/);
});

test('missing SDK and mismatched SDK versions fail without development dependency fallback', context => {
  const { runtime, put } = fixture(context);
  const sdk = put('dsh-skill', baseline + '-stale');
  assert.throws(() => inspectRuntime(runtime), /dsh-skill version must match/);
  rmSync(sdk, { recursive: true });
  assert.throws(() => inspectRuntime(runtime), error => ['MODULE_NOT_FOUND', 'ENOENT'].includes(error.code));
});

test('compatibility CLI fails when the runtime argument is absent', () => {
  const script = fileURLToPath(new URL('../scripts/verify-runtime.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd: dirname(script), encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Usage:.*installed-dsh-dir/);
});
