import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredSdk = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
];

export function inspectRuntime(directory) {
  assert.ok(typeof directory === 'string' && directory.trim(), 'installed DSH package directory is required');
  const root = realpathSync(resolve(directory));
  const baseline = readFileSync(resolve(packageRoot, '..', '..', '.dsh-version'), 'utf8').trim();
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh', 'runtime directory must be the installed @deepseek-ai/dsh package');
  assert.equal(manifest.version, baseline, 'installed DSH version must match .dsh-version');
  const runtimeRequire = createRequire(join(root, 'package.json'));
  const entries = {};
  const versions = {};
  for (const name of requiredSdk) {
    const sdk = JSON.parse(readFileSync(runtimeRequire.resolve(`${name}/package.json`), 'utf8'));
    assert.equal(sdk.name, name, `unexpected SDK identity for ${name}`);
    if (name.startsWith('@deepseek-ai/dsh-')) {
      assert.equal(sdk.version, baseline, `${name} version must match .dsh-version`);
    }
    entries[name] = runtimeRequire.resolve(name);
    versions[name] = sdk.version;
  }
  return { root, version: manifest.version, entries, versions };
}

export function verifyRuntime(directory) {
  const runtime = inspectRuntime(directory);
  console.log('skills-manager compatibility runtime: ' + JSON.stringify({ node: process.version, dsh: runtime.version, sdk: runtime.versions }));
  const environment = { ...process.env, DSH_RUNTIME_DIR: runtime.root };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=240000', 'compat/disabled-external-native.case.mjs'], {
    cwd: packageRoot, env: environment, stdio: 'inherit', timeout: 270000, windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Host compatibility failed (signal: ${result.signal ?? 'none'})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-runtime.mjs <installed-dsh-dir>');
  verifyRuntime(process.argv[2]);
}
