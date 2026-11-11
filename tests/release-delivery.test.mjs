/**
 * Delivery package tests (issue #222 items ③④⑤⑥).
 *
 * The delivery builder is the packager-facing entry point: it turns a public
 * artifact plus an out-of-repo configuration into a zip an employee can run
 * without editing files. These tests pin the package shape and the fail-closed
 * behaviour that keeps a half-built delivery from being mistaken for a release.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDelivery } from '../scripts/release-delivery.mjs';
import { writeBundleTarball } from '../scripts/lib/bundle-write.mjs';
import { PrivateBundleError } from '../scripts/lib/private-bundle.mjs';

const TOOL_ROOT = fileURLToPath(new URL('..', import.meta.url));

function temp(t, prefix = 'forge-delivery-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), prefix)));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function neutralPatch() {
  return [
    '# fixture composition',
    '- insert:',
    '    - id: heluo-iam',
    "      name: '@heluo/forge-iam'",
    '    - id: heluo-gitee',
    "      name: '@heluo/forge-gitee'",
    '      config: {}',
    '    - id: forge-devops',
    "      name: '@heluo/forge-devops'",
    '      config: {}',
    '',
  ].join('\n');
}

function publicTarball() {
  return writeBundleTarball([
    { path: 'package.json', body: `${JSON.stringify({ name: '@heluo/forge-enterprise', version: '0.1.0', license: 'Apache-2.0' }, null, 2)}\n` },
    { path: 'cordis.patch.yml', body: neutralPatch() },
    { path: 'README.md', body: '# fixture\n' },
  ]);
}

function fixture(t) {
  const root = temp(t);
  const publicPath = join(root, 'public.tgz');
  const bytes = publicTarball();
  writeFileSync(publicPath, bytes);
  const configPath = join(root, 'enterprise.env');
  writeFileSync(
    configPath,
    [
      'HELUO_IAM_AUTH_MODE=public',
      'HELUO_IAM_ISSUER=https://iam.corp.example',
      'HELUO_IAM_DISCOVERY_URL=https://iam.corp.example/.well-known/openid-configuration',
      'HELUO_IAM_CLIENT_ID=test-client',
      'HELUO_IAM_SCOPES=openid profile',
      'HELUO_IAM_CALLBACK_PORT=17321',
      'HELUO_IAM_MANAGED_MODELS_BASE_URL=https://gateway.corp.example/v1',
      'HELUO_IAM_DEFAULT_PROVIDER=route-1',
      '',
    ].join('\n'),
  );
  chmodSync(configPath, 0o600);
  return { root, publicPath, configPath, sha256: sha256Of(bytes) };
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof PrivateBundleError, true, `expected PrivateBundleError, got ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('dry-run prints the redacted plan and writes nothing', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const output = join(root, 'delivery');
  const result = buildDelivery({
    publicPath,
    publicSha256: sha256,
    configPath,
    version: '0.1.0-corp.1',
    output,
    toolRoot: TOOL_ROOT,
    dryRun: true,
  });
  assert.equal(result.written, false);
  assert.equal(result.plan.configValues, 'redacted');
  assert.equal(result.plan.configKeys.includes('iam.issuer'), true);
  assert.equal(result.plan.loginReady, true);
  assert.equal(JSON.stringify(result.plan).includes('iam.corp.example'), false);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.zip`), false);
  assert.match(result.digest, /^[0-9a-f]{64}$/u);
});

test('a package without complete IAM login config is refused before writing', (t) => {
  const { root, publicPath, sha256 } = fixture(t);
  const configPath = join(root, 'incomplete.env');
  writeFileSync(
    configPath,
    [
      'HELUO_IAM_AUTH_MODE=public',
      'HELUO_IAM_ISSUER=https://iam.corp.example',
      'HELUO_IAM_CLIENT_ID=test-client',
      '',
    ].join('\n'),
  );
  chmodSync(configPath, 0o600);
  const output = join(root, 'delivery');
  expectCode(
    () => buildDelivery({
      publicPath,
      publicSha256: sha256,
      configPath,
      version: '0.1.0-corp.1',
      output,
      toolRoot: TOOL_ROOT,
      dryRun: true,
    }),
    'CONFIG_INVALID',
  );
  assert.equal(existsSync(output), false);
});

test('builder writes the employee package and a zip', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const output = join(root, 'delivery');
  const plan = buildDelivery({
    publicPath,
    publicSha256: sha256,
    configPath,
    version: '0.1.0-corp.1',
    output,
    toolRoot: TOOL_ROOT,
    dryRun: true,
  });
  const result = buildDelivery({
    publicPath,
    publicSha256: sha256,
    configPath,
    version: '0.1.0-corp.1',
    output,
    toolRoot: TOOL_ROOT,
    confirm: plan.digest.slice(0, 16),
  });
  assert.equal(result.written, true);
  assert.match(result.archiveSha256, /^[0-9a-f]{64}$/u);
  for (const path of [
    'enterprise-plugin/heluo-forge-enterprise-0.1.0-corp.1.tgz',
    'enterprise-plugin/private-release.json',
    'enterprise-plugin/bundle-manifest.json',
    'installer/init-enterprise-plugin.mjs',
    'installer/install-macos.command',
    'installer/install-linux.sh',
    'installer/install-windows.cmd',
    'INSTALL.md',
    'SHA256SUMS',
  ]) {
    assert.equal(existsSync(join(output, path)), true, `${path} is missing`);
  }
  assert.equal(existsSync(`${output}.zip`), true);
  const guide = readFileSync(join(output, 'INSTALL.md'), 'utf8');
  assert.match(guide, /install-macos\.command/u);
  assert.match(guide, /mounted=unknown/u);
  const launcher = readFileSync(join(output, 'installer', 'install-macos.command'), 'utf8');
  assert.match(launcher, /--release "\$ROOT\/enterprise-plugin"/u);
  assert.match(launcher, /--profile "\$PROFILE"/u);
  const windows = readFileSync(join(output, 'installer', 'install-windows.cmd'), 'utf8');
  assert.match(windows, /\r\n/u, 'Windows launcher must use CRLF line endings');
  assert.match(windows, /where node/u);
  assert.match(windows, /heluo-enterprise-install\.log/u);
  assert.match(windows, /DSH_HOME/u);
  assert.match(guide, /解除锁定/u);
  const sums = readFileSync(join(output, 'SHA256SUMS'), 'utf8');
  assert.match(sums, /enterprise-plugin\/heluo-forge-enterprise-0\.1\.0-corp\.1\.tgz/u);
  assert.equal(sums.includes('config.example'), false);
  assert.equal(JSON.stringify(result).includes('iam.corp.example'), false);
});

test('a wrong confirmation writes nothing', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const output = join(root, 'delivery');
  expectCode(
    () => buildDelivery({
      publicPath,
      publicSha256: sha256,
      configPath,
      version: '0.1.0-corp.1',
      output,
      toolRoot: TOOL_ROOT,
      confirm: 'deadbeefdeadbeef',
    }),
    'CONFIRM_MISMATCH',
  );
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.zip`), false);
});

test('a world-readable configuration is refused before any write', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  chmodSync(configPath, 0o644);
  const output = join(root, 'delivery');
  expectCode(
    () => buildDelivery({
      publicPath,
      publicSha256: sha256,
      configPath,
      version: '0.1.0-corp.1',
      output,
      toolRoot: TOOL_ROOT,
      confirm: 'aaaaaaaaaaaa',
    }),
    'CONFIG_PERMISSIONS',
  );
  assert.equal(existsSync(output), false);
});

test('a secret in the configuration cannot become part of the delivery', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  writeFileSync(configPath, 'HELUO_IAM_CLIENT_SECRET=leaked-value\n');
  chmodSync(configPath, 0o600);
  expectCode(
    () => buildDelivery({
      publicPath,
      publicSha256: sha256,
      configPath,
      version: '0.1.0-corp.1',
      output: join(root, 'delivery'),
      toolRoot: TOOL_ROOT,
      confirm: 'aaaaaaaaaaaa',
    }),
    'BUNDLE_SECRET_EMBED_UNSUPPORTED',
  );
});

test('a mismatched public digest is refused', (t) => {
  const { root, publicPath, configPath } = fixture(t);
  expectCode(
    () => buildDelivery({
      publicPath,
      publicSha256: '0'.repeat(64),
      configPath,
      version: '0.1.0-corp.1',
      output: join(root, 'delivery'),
      toolRoot: TOOL_ROOT,
      confirm: 'aaaaaaaaaaaa',
    }),
    'PUBLIC_DIGEST_MISMATCH',
  );
});

test('output inside the source checkout is refused', (t) => {
  const { publicPath, configPath, sha256 } = fixture(t);
  expectCode(
    () => buildDelivery({
      publicPath,
      publicSha256: sha256,
      configPath,
      version: '0.1.0-corp.1',
      output: join(TOOL_ROOT, 'dist', 'delivery'),
      toolRoot: TOOL_ROOT,
      confirm: 'aaaaaaaaaaaa',
    }),
    'OUTPUT_INSIDE_REPO',
  );
});

test('a non-empty output directory is refused', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const output = join(root, 'delivery');
  mkdirSync(output);
  writeFileSync(join(output, 'keep.txt'), 'keep');
  const plan = buildDelivery({
    publicPath,
    publicSha256: sha256,
    configPath,
    version: '0.1.0-corp.1',
    output,
    toolRoot: TOOL_ROOT,
    dryRun: true,
  });
  expectCode(
    () => buildDelivery({
      publicPath,
      publicSha256: sha256,
      configPath,
      version: '0.1.0-corp.1',
      output,
      toolRoot: TOOL_ROOT,
      confirm: plan.digest.slice(0, 16),
    }),
    'OUTPUT_EXISTS',
  );
  assert.equal(readFileSync(join(output, 'keep.txt'), 'utf8'), 'keep');
});
