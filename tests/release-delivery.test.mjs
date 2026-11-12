/**
 * Delivery package tests (issue #222 items ③④⑤⑥).
 *
 * The delivery builder is the packager-facing entry point: it turns a public
 * artifact plus a local configuration into a zip an employee can run
 * without editing files. These tests pin the package shape and the fail-closed
 * behaviour that keeps a half-built delivery from being mistaken for a release.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDelivery } from '../scripts/release-delivery.mjs';
import { readBundleEntries } from '../scripts/lib/bundle-archive.mjs';
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
    ...['config.mjs', 'model-options.mjs', 'http-url.mjs', 'errors.mjs'].map((name) => ({
      path: `node_modules/@heluo/forge-iam/src/${name}`,
      body: readFileSync(new URL(`../packages/forge-iam/src/${name}`, import.meta.url)),
    })),
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
  assert.equal(result.plan.gatewayConfigured, true);
  assert.equal(result.plan.revocationConfigured, false);
  assert.equal(JSON.stringify(result.plan).includes('iam.corp.example'), false);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.zip`), false);
  assert.match(result.digest, /^[0-9a-f]{64}$/u);
});

test('a login-only plan reports that gateway and revocation are not configured', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const config = readFileSync(configPath, 'utf8').split('\n')
    .filter((line) => !line.startsWith('HELUO_IAM_MANAGED_MODELS_BASE_URL=') && !line.startsWith('HELUO_IAM_DEFAULT_PROVIDER='));
  writeFileSync(configPath, config.join('\n'));
  const result = buildDelivery({ publicPath, publicSha256: sha256, configPath, version: '0.1.0-corp.1', output: join(root, 'delivery'), toolRoot: TOOL_ROOT, dryRun: true });
  assert.equal(result.plan.loginReady, true);
  assert.equal(result.plan.gatewayConfigured, false);
  assert.equal(result.plan.revocationConfigured, false);
});

function runCli(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(TOOL_ROOT, 'scripts', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('both packaging CLIs accept a git-ignored in-repository .env', async (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const outside = temp(t);
  const ignoredConfig = join(root, '.env');
  writeFileSync(ignoredConfig, readFileSync(configPath), { mode: 0o600 });
  writeFileSync(join(root, '.gitignore'), readFileSync(join(TOOL_ROOT, '.gitignore')));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['check-ignore', '-q', '--', '.env'], { cwd: root });
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'init-enterprise-plugin.mjs'), readFileSync(join(TOOL_ROOT, 'scripts', 'init-enterprise-plugin.mjs')));

  const common = ['--public', publicPath, '--public-sha256', sha256, '--config', ignoredConfig, '--version', '0.1.0-corp.1', '--skip-discovery-check'];
  const commands = [
    ['release-delivery.mjs', [...common, '--tool-root', root, '--output', join(outside, 'delivery')], ['--dry-run']],
    ['make-private-bundle.mjs', [...common, '--repo-root', root, '--output', join(outside, 'private')], []],
  ];
  for (const [script, args, previewArgs] of commands) {
    const preview = await runCli(script, [...args, ...previewArgs]);
    assert.equal(preview.code, 1, preview.stderr);
    assert.match(preview.stderr, /CONFIRM_REQUIRED/u);
    const digest = /"planDigest":\s*"([a-f0-9]{64})"/u.exec(preview.stderr)?.[1];
    assert.ok(digest);
    const result = await runCli(script, [...args, '--confirm', digest.slice(0, 16)]);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const tarball = script === 'release-delivery.mjs' ? summary.private.tarball : summary.tarball;
    const files = readBundleEntries(readFileSync(tarball), { withContent: true });
    assert.equal(files.some((file) => file.path.split('/').includes('.env')), false);
  }
  for (const [script, rootFlag] of [['release-delivery.mjs', '--tool-root'], ['make-private-bundle.mjs', '--repo-root']]) {
    const forbiddenOutput = join(root, 'forbidden-output');
    const result = await runCli(script, [...common, rootFlag, root, '--output', forbiddenOutput]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /outside/u);
    assert.equal(existsSync(forbiddenOutput), false);
  }
});

test('both packaging CLIs redact discovery on success and failure', async (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  let document;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(document));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const marker = 'private-issuer-marker';
  const issuer = `${base}/${marker}`;
  document = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` };
  writeFileSync(configPath, [
    `HELUO_IAM_ISSUER=${issuer}`,
    `HELUO_IAM_DISCOVERY_URL=${base}/private-discovery-marker`,
    'HELUO_IAM_CLIENT_ID=client-marker',
    `HELUO_IAM_MANAGED_MODELS_BASE_URL=${base}/private-gateway-marker`,
    'HELUO_IAM_DEFAULT_PROVIDER=route-1',
    'HELUO_IAM_ALLOW_INSECURE_HTTP=true',
    '',
  ].join('\n'));
  const common = ['--public', publicPath, '--public-sha256', sha256, '--config', configPath, '--version', '0.1.0-corp.1'];
  const deliveryArgs = [...common, '--output', join(root, 'delivery')];
  const preview = await runCli('release-delivery.mjs', [...deliveryArgs, '--dry-run']);
  assert.equal(preview.code, 1);
  assert.match(preview.stderr, /CONFIRM_REQUIRED/u);
  assert.doesNotMatch(preview.stderr, /private-(issuer|discovery|gateway)-marker/u);
  const digest = /"planDigest":\s*"([a-f0-9]{64})"/u.exec(preview.stderr)?.[1];
  assert.ok(digest);
  const delivery = await runCli('release-delivery.mjs', [...deliveryArgs, '--confirm', digest.slice(0, 16)]);
  assert.equal(delivery.code, 0, delivery.stderr);
  assert.doesNotMatch(delivery.stdout + delivery.stderr, /private-(issuer|discovery|gateway)-marker/u);
  const summary = JSON.parse(delivery.stdout);
  assert.equal(summary.gatewayConfigured, true);
  assert.equal(summary.discovery.revocationEndpoint, 'discovered');

  const makerArgs = [...common, '--output', join(root, 'private'), '--repo-root', TOOL_ROOT];
  const maker = await runCli('make-private-bundle.mjs', makerArgs);
  assert.equal(maker.code, 1);
  assert.match(maker.stderr, /CONFIRM_REQUIRED/u);
  assert.doesNotMatch(maker.stderr, /private-(issuer|discovery|gateway)-marker/u);

  document = { ...document, issuer: `${base}/private-mismatch-marker` };
  for (const [script, args] of [['release-delivery.mjs', [...deliveryArgs, '--dry-run']], ['make-private-bundle.mjs', makerArgs]]) {
    const failed = await runCli(script, args);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /DISCOVERY_ISSUER_MISMATCH/u);
    assert.doesNotMatch(failed.stdout + failed.stderr, /private-(issuer|discovery|gateway|mismatch)-marker/u);
  }
});

test('a missing configuration file does not leak its path in CLI errors', async (t) => {
  const { root, publicPath, sha256 } = fixture(t);
  const marker = 'sensitive-config-path-marker';
  const args = ['--public', publicPath, '--public-sha256', sha256, '--config', join(root, marker), '--version', '0.1.0-corp.1', '--output', join(root, 'delivery')];
  for (const script of ['release-delivery.mjs', 'make-private-bundle.mjs']) {
    const result = await runCli(script, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CONFIG_UNREADABLE/u);
    assert.equal((result.stdout + result.stderr).includes(marker), false);
  }
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
  assert.match(launcher, /--profile auto --install-host/u);
  const windows = readFileSync(join(output, 'installer', 'install-windows.cmd'), 'utf8');
  assert.match(windows, /\r\n/u, 'Windows launcher must use CRLF line endings');
  assert.match(windows, /where node/u);
  assert.match(windows, /--profile auto --install-host/u);
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
