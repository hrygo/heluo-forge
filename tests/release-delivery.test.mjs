/**
 * Delivery package tests (issue #222 items ③④⑤⑥).
 *
 * The delivery builder is the packager-facing entry point: it turns a public
 * artifact plus a local configuration into a zip an employee can run
 * without editing files. These tests pin the package shape and the fail-closed
 * behaviour that keeps a half-built delivery from being mistaken for a release.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { APP_IDENTITY, buildDelivery, parseArguments, writeBrandingAssets } from '../scripts/release-delivery.mjs';
import { readBundleEntries } from '../scripts/lib/bundle-archive.mjs';
import { writeBundleTarball } from '../scripts/lib/bundle-write.mjs';
import { buildConfig, parseEnvConfig, PrivateBundleError } from '../scripts/lib/private-bundle.mjs';
import { zipDirectory } from '../scripts/lib/release-support.mjs';

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
    '    - id: heluo-skills-manager',
    "      name: '@heluo/forge-skills-manager'",
    '      config: {}',
    '    - id: forge-devops',
    "      name: '@heluo/forge-devops'",
    '      config: {}',
    '',
  ].join('\n');
}

function publicTarball() {
  return writeBundleTarball([
    {
      path: 'package.json',
      body: `${JSON.stringify({ name: '@heluo/forge-enterprise', version: '0.1.0', license: 'Apache-2.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2)}\n`,
    },
    { path: 'cordis.patch.yml', body: neutralPatch() },
    { path: 'README.md', body: '# fixture\n' },
    { path: 'node_modules/@heluo/forge-skills-manager/lib/nacos.js',
      body: readFileSync(new URL('../packages/forge-skills-manager/lib/nacos.js', import.meta.url)) },
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
      'HELUO_IAM_DISCOVERY_URL=https://iam.corp.example/.well-known/openid-configuration',
      'HELUO_IAM_CLIENT_ID=test-client',
      'HELUO_IAM_SCOPES=openid profile',
      'HELUO_IAM_CALLBACK_PORT=17321',
      'HELUO_IAM_MANAGED_MODELS_BASE_URL=https://gateway.corp.example/v1',
      'HELUO_IAM_DEFAULT_PROVIDER=route-1',
      'HELUO_NACOS_SERVER_URL=http://nacos.corp.example/nacos',
      'HELUO_NACOS_NAMESPACE_ID=public',
      'HELUO_NACOS_USERNAME=svc-ci',
      'HELUO_NACOS_PASSWORD=synthetic-password',
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

test('delivery plan distinguishes Nacos password from an explicitly embedded IAM client secret', t => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const baseEnv = readFileSync(configPath, 'utf8').split('\n').filter(line => !line.startsWith('HELUO_IAM_AUTH_MODE='));
  for (const withClientSecret of [false, true]) {
    const config = buildConfig(parseEnvConfig([
      ...baseEnv,
      `HELUO_IAM_AUTH_MODE=${withClientSecret ? 'confidential' : 'public'}`,
      ...(withClientSecret ? [
        'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_post',
        'HELUO_IAM_CLIENT_SECRET_REF=enterprise-oidc',
        'HELUO_IAM_CLIENT_SECRET=synthetic-client-secret',
      ] : []),
    ].join('\n'), { allowSecret: true }));
    const result = buildDelivery({ publicPath, publicSha256: sha256, config,
      embedClientSecret: withClientSecret, version: '0.1.0-corp.1',
      output: join(root, 'delivery'), toolRoot: TOOL_ROOT, dryRun: true });
    assert.equal(result.plan.clientSecretEmbedded, withClientSecret);
    assert.deepEqual(result.plan.embeddedSecrets, ['nacos.password']);
    assert.doesNotMatch(JSON.stringify(result.plan), /synthetic-client-secret|synthetic-password/);
  }
});

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
  assert.equal(result.plan.configKeys.includes('iam.discoveryUrl'), true);
  assert.equal(result.plan.configKeys.includes('iam.issuer'), false);
  assert.equal(result.plan.loginReady, true);
  assert.equal(result.plan.nacosConfigured, true);
  assert.deepEqual(result.plan.embeddedSecrets, ['nacos.password']);
  assert.equal(result.plan.gatewayConfigured, true);
  assert.equal(result.plan.revocationConfigured, false);
  assert.equal(JSON.stringify(result.plan).includes('iam.corp.example'), false);
  assert.doesNotMatch(JSON.stringify(result.plan), /svc-ci|synthetic-password|nacos\.corp\.example/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.zip`), false);
  assert.match(result.digest, /^[0-9a-f]{64}$/u);
});

test('delivery rejects unvalidated snapshots and preserves the preview digest for validated input', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const output = join(root, 'delivery');
  const input = { publicPath, publicSha256: sha256, configPath, version: '0.1.0-corp.1', output, dryRun: true };
  const config = buildConfig(parseEnvConfig(readFileSync(configPath, 'utf8')));
  expectCode(() => buildDelivery({ ...input, config: structuredClone(config) }), 'CONFIG_INVALID');
  assert.equal(buildDelivery({ ...input, configPath: undefined, config }).digest, buildDelivery(input).digest);
  assert.equal(existsSync(output), false);
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

function runCli(script, args, nodeArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, join(TOOL_ROOT, 'scripts', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Nacos preflight runs before confirmation in both packaging CLIs', async t => {
  const { root, publicPath, configPath } = fixture(t);
  const fullConfig = readFileSync(configPath, 'utf8');
  const sourceEntries = readBundleEntries(publicTarball(), { withContent: true });
  // Windows cannot represent POSIX 600. Simulate only this synthetic file's mode
  // in these child processes; this test covers preflight, not permission checks.
  const nodeArgs = process.platform === 'win32' ? ['--import', `data:text/javascript,${encodeURIComponent(`
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.statSync;
    fs.statSync = function(path, ...args) {
      const stat = original.call(this, path, ...args);
      if (String(path) === ${JSON.stringify(configPath)}) stat.mode = (stat.mode & ~0o777) | 0o600;
      return stat;
    };
    syncBuiltinESMExports();
  `)}`] : [];
  for (const scenario of ['configured', 'old-runtime', 'missing-runtime', 'missing-config', 'without-plugin']) {
    let entries = sourceEntries;
    if (scenario === 'old-runtime') entries = entries.map(entry => entry.path.endsWith('/lib/nacos.js') ? { ...entry, content: Buffer.from('// old runtime\n') } : entry);
    if (scenario === 'missing-runtime') entries = entries.filter(entry => !entry.path.endsWith('/lib/nacos.js'));
    if (scenario === 'without-plugin') entries = entries.filter(entry => !entry.path.includes('@heluo/forge-skills-manager/')).map(entry => entry.path === 'cordis.patch.yml'
      ? { ...entry, content: Buffer.from(neutralPatch().replace(/    - id: heluo-skills-manager\n      name: '@heluo\/forge-skills-manager'\n      config: \{\}\n/u, '')) } : entry);
    const bytes = writeBundleTarball(entries.map(entry => ({ path: entry.path, body: entry.content })));
    writeFileSync(publicPath, bytes);
    writeFileSync(configPath, ['missing-config', 'without-plugin'].includes(scenario)
      ? fullConfig.split('\n').filter(line => !line.startsWith('HELUO_NACOS_')).join('\n') : fullConfig);
    for (const script of ['release-delivery.mjs', 'make-private-bundle.mjs']) {
      const output = join(root, `${scenario}-${script}`);
      const result = await runCli(script, ['--public', publicPath, '--public-sha256', sha256Of(bytes), '--config', configPath,
        '--version', '0.1.0-corp.1', '--output', output, '--skip-discovery-check', ...(script === 'release-delivery.mjs' ? ['--dry-run'] : [])], nodeArgs);
      const code = scenario.endsWith('runtime') ? 'NACOS_RUNTIME_MISMATCH' : scenario === 'missing-config' ? 'CONFIG_INVALID' : 'CONFIRM_REQUIRED';
      assert.equal(result.code, 1, `${script} ${scenario}: ${result.stderr}`);
      assert.ok(result.stderr.includes(code), `${script} ${scenario}: ${result.stderr}`);
      if (code === 'CONFIRM_REQUIRED') {
        assert.match(result.stderr, new RegExp(`"nacosConfigured": ${scenario === 'configured'}`));
        assert.match(result.stderr, /"planDigest"/u);
      } else assert.doesNotMatch(result.stderr, /"planDigest"/u);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-password|svc-ci|nacos\.corp\.example/u);
      assert.equal(existsSync(output), false);
      assert.equal(existsSync(`${output}.zip`), false);
    }
  }
});

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
    `HELUO_IAM_DISCOVERY_URL=${base}/private-discovery-marker`,
    'HELUO_IAM_CLIENT_ID=client-marker',
    `HELUO_IAM_MANAGED_MODELS_BASE_URL=${base}/private-gateway-marker`,
    'HELUO_IAM_DEFAULT_PROVIDER=route-1',
    'HELUO_IAM_ALLOW_INSECURE_HTTP=true',
    ...readFileSync(configPath, 'utf8').split('\n').filter(line => line.startsWith('HELUO_NACOS_')),
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

  document = { ...document, jwks_uri: 'ftp://private-mismatch-marker/jwks' };
  for (const [script, args] of [['release-delivery.mjs', [...deliveryArgs, '--dry-run']], ['make-private-bundle.mjs', makerArgs]]) {
    const failed = await runCli(script, args);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /DISCOVERY_INVALID/u);
    assert.doesNotMatch(failed.stdout + failed.stderr, /private-(issuer|discovery|gateway|mismatch)-marker/u);
  }
});

for (const script of ['release-delivery.mjs', 'make-private-bundle.mjs']) {
  test(`${script} packages the same config snapshot used for Discovery and confirmation`, async (t) => {
    const { root, publicPath, configPath, sha256 } = fixture(t);
    const output = join(root, 'delivery');
    let replacement;
    let document;
    const server = createServer((_request, response) => {
      if (replacement) writeFileSync(configPath, replacement);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(document));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const issuer = `http://127.0.0.1:${server.address().port}`;
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
    document = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` };
    const initial = [
      'HELUO_NACOS_SERVER_URL=http://nacos.corp.example/nacos',
      'HELUO_NACOS_NAMESPACE_ID=public',
      'HELUO_NACOS_USERNAME=svc-ci',
      'HELUO_NACOS_PASSWORD=synthetic-password',
      'HELUO_IAM_AUTH_MODE=confidential',
      'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_post',
      'HELUO_IAM_CLIENT_SECRET_REF=enterprise-oidc',
      `HELUO_IAM_DISCOVERY_URL=${discoveryUrl}`,
      'HELUO_IAM_CLIENT_ID=test-client',
      'HELUO_IAM_ALLOW_INSECURE_HTTP=true',
    ].join('\n');
    writeFileSync(configPath, initial);
    const args = ['--public', publicPath, '--public-sha256', sha256, '--config', configPath, '--version', '0.1.0-corp.1', '--output', output];
    const isDelivery = script === 'release-delivery.mjs';
    const preview = await runCli(script, isDelivery ? [...args, '--dry-run'] : args);
    assert.equal(preview.code, 1);
    assert.match(preview.stderr, /CONFIRM_REQUIRED/u);
    const digest = /"planDigest":\s*"([a-f0-9]{64})"/u.exec(preview.stderr)?.[1];
    assert.ok(digest);
    replacement = initial.replace(discoveryUrl, 'https://iam.corp.example/discovery').replace('HTTP=true', 'HTTP=false');

    const built = await runCli(script, [...args, '--confirm', digest]);
    assert.equal(built.code, 0, built.stderr);
    assert.equal(readFileSync(configPath, 'utf8'), replacement);
    const summary = JSON.parse(built.stdout);
    assert.equal(summary.discovery.checked, true);
    const tarball = isDelivery ? summary.private.tarball : summary.tarball;
    const files = readBundleEntries(readFileSync(tarball), { withContent: true });
    const patch = files.find((file) => file.path === 'cordis.patch.yml').content.toString('utf8');
    assert.ok(patch.includes(`discoveryUrl: "${discoveryUrl}"`));
    assert.match(patch, /allowInsecureClientAuthHttp: true/u);
  });
}

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
    'branding/app-icon.ico',
    'branding/app-icon.icns',
    ...[16, 32, 48, 64, 128, 256, 512, 1024].map((size) => `branding/app-icon-${size}.png`),
    'branding/wordmark-color.svg',
    'branding/app-identity.json',
    'INSTALL.md',
    'SHA256SUMS',
  ]) {
    assert.equal(existsSync(join(output, path)), true, `${path} is missing`);
  }
  assert.equal(existsSync(`${output}.zip`), true);
  const guide = readFileSync(join(output, 'INSTALL.md'), 'utf8');
  assert.match(guide, /^# 河洛 Forge 企业版 · 安装说明$/mu);
  assert.match(guide, /install-macos\.command/u);
  assert.match(guide, /mounted=unknown/u);
  assert.match(guide, /有旧版本时先执行\s*$/mu, '安装流程必须说明异版本先卸载再安装');
  assert.match(guide, /dsh plugin remove 卸载旧版本/u);
  assert.match(guide, /内嵌了企业 IAM 客户端密钥/u);
  assert.match(guide, /IAM_DISCOVERY_FAILED/u);
  assert.match(guide, /HELUO_PROFILE/u, '说明要怎么写才能装到 uat 等自定义 profile');
  assert.match(guide, /Linux[^\n]+XDG_DATA_HOME[^\n]+\.local\/share\/HeluoForge/u);
  assert.match(guide, /\.keys\S*keyring\.json/u);
  assert.match(guide, /HTTP[^\n]+明文[^\n]+客户端密钥/u);
  const launcher = readFileSync(join(output, 'installer', 'install-macos.command'), 'utf8');
  assert.match(launcher, /--release "\$ROOT\/enterprise-plugin"/u);
  assert.match(launcher, /--profile "\$\{HELUO_PROFILE:-auto\}" --install-host/u);
  const windows = readFileSync(join(output, 'installer', 'install-windows.cmd'), 'utf8');
  assert.match(windows, /\r\n/u, 'Windows launcher must use CRLF line endings');
  assert.match(windows, /where node/u);
  assert.match(windows, /--profile "%HELUO_PROFILE%" --install-host/u);
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

test('an out-of-checkout symlink that points back in is refused', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const link = join(root, 'into-checkout');
  symlinkSync(TOOL_ROOT, link, 'dir');
  expectCode(
    () => buildDelivery({
      publicPath,
      publicSha256: sha256,
      configPath,
      version: '0.1.0-corp.1',
      output: join(link, 'delivery'),
      toolRoot: TOOL_ROOT,
      confirm: 'aaaaaaaaaaaa',
    }),
    'OUTPUT_INSIDE_REPO',
  );
});

test('a sibling directory named like a parent reference is not mistaken for the checkout', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const output = join(root, '..delivery');
  const plan = buildDelivery({
    publicPath,
    publicSha256: sha256,
    configPath,
    version: '0.1.0-corp.1',
    output,
    toolRoot: TOOL_ROOT,
    dryRun: true,
  });
  assert.ok(plan);
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

/** 先演练拿确认码，再真正打包；extra 用来注入测试用参数（如 zipCommand）。 */
function packageDelivery({ publicPath, configPath, sha256 }, output, extra = {}) {
  const base = {
    publicPath,
    publicSha256: sha256,
    configPath,
    version: '0.1.0-corp.1',
    output,
    toolRoot: TOOL_ROOT,
  };
  // 预览与正式执行必须用同一组开关，否则带密钥/绑定历史时预览会先被拒。
  const plan = buildDelivery({ ...base, dryRun: true, ...extra });
  return buildDelivery({ ...base, confirm: plan.digest.slice(0, 16), ...extra });
}

test('zip failure publishes nothing, so a retry is not blocked by OUTPUT_EXISTS', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const output = join(root, 'delivery');
  const input = { publicPath, configPath, sha256 };
  expectCode(
    () => packageDelivery(input, output, { zipCommand: join(root, 'missing', 'zip-not-here') }),
    'ARCHIVE_FAILED',
  );
  assert.equal(existsSync(output), false, '打包失败不能留下半成品输出目录');
  assert.equal(existsSync(`${output}.zip`), false, '打包失败不能留下 zip');

  const retried = packageDelivery(input, output);
  assert.equal(retried.written, true, '重跑不应被 OUTPUT_EXISTS 挡住');
  assert.equal(existsSync(`${output}.zip`), true);
  assert.equal(existsSync(join(output, 'INSTALL.md')), true);
});

test('zip failure keeps a pre-existing empty output directory and never deletes user files', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const output = join(root, 'delivery');
  mkdirSync(output);
  expectCode(
    () => packageDelivery({ publicPath, configPath, sha256 }, output, { zipCommand: join(root, 'missing', 'zip') }),
    'ARCHIVE_FAILED',
  );
  assert.equal(existsSync(output), true, '用户原有的空目录必须原样保留');
  assert.deepEqual(readdirSync(output), [], '失败时不能往里写任何东西');
  assert.equal(existsSync(`${output}.zip`), false);
});

/** 假的 zip：把本次运行预留的占位文件换成「别人」的 zip，然后失败（PR #256 R4）。 */
function zipReplacedByAnotherProcess(root, archive) {
  const path = join(root, 'zip-replaced.sh');
  writeFileSync(path, `#!/bin/sh\nrm -f '${archive}'\nprintf 'external-zip' > '${archive}'\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

/** 假的 zip：模拟并发进程在打包期间发布了最终目录，然后照常写出 zip（PR #256 R4）。 */
function zipWhileAnotherProcessPublishes(root, output, partialArchiveIndex = 3) {
  const path = join(root, 'zip-concurrent.sh');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `mkdir -p '${output}'`,
      `printf 'published by A\\n' > '${output}/INSTALL.md'`,
      `: > "$${partialArchiveIndex}"`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

/** 假的 zip：只写出 zip 再失败，模拟本次运行自己的产物（PR #256 R4）。 */
function zipFailingAfterWrite(root) {
  const path = join(root, 'zip-failing.sh');
  writeFileSync(path, '#!/bin/sh\n: > "$3"\nexit 1\n');
  chmodSync(path, 0o755);
  return path;
}

/** 暂存目录是发布前的唯一中间产物，失败后必须清理干净。 */
function stagingLeftovers(root) {
  return readdirSync(root).filter((name) => name.startsWith('.release-delivery-'));
}

test(
  'an archive created by another process during the build is never deleted (PR #256 R4)',
  { skip: process.platform === 'win32' ? 'needs a POSIX shell to fake the zip step' : false },
  (t) => {
    const { root, publicPath, configPath, sha256 } = fixture(t);
    const output = join(root, 'delivery');
    const archive = `${output}.zip`;
    const warnings = [];
    expectCode(
      () => packageDelivery({ publicPath, configPath, sha256 }, output, {
        zipCommand: zipReplacedByAnotherProcess(root, archive),
        warn: (message) => warnings.push(message),
      }),
      'ARCHIVE_FAILED',
    );
    assert.equal(existsSync(archive), true, '别的进程写出的 zip 不能被本次运行的失败清理删掉');
    assert.equal(readFileSync(archive, 'utf8'), 'external-zip');
    assert.equal(warnings.length, 1, '跳过清理必须告警，不能静默');
    assert.match(warnings[0], /left .*delivery\.zip in place: it was replaced by another process/u);
    assert.equal(existsSync(output), false);
    assert.deepEqual(stagingLeftovers(root), []);
  },
);

test(
  'a delivery directory published by a concurrent run survives this run failing (PR #256 R4)',
  { skip: process.platform === 'win32' ? 'needs a POSIX shell to fake the zip step' : false },
  (t) => {
    const { root, publicPath, configPath, sha256 } = fixture(t);
    const output = join(root, 'delivery');
    const warnings = [];
    expectCode(
      () => packageDelivery({ publicPath, configPath, sha256 }, output, {
        zipCommand: zipWhileAnotherProcessPublishes(root, output),
        warn: (message) => warnings.push(message),
      }),
      'OUTPUT_EXISTS',
    );
    assert.deepEqual(readdirSync(output), ['INSTALL.md'], '先到者的产物必须原样保留');
    assert.equal(readFileSync(join(output, 'INSTALL.md'), 'utf8'), 'published by A\n');
    assert.equal(existsSync(`${output}.zip`), false, '失败时本次运行的 zip 不能留在发布位上');
    assert.deepEqual(warnings, [], '没有替换发生时不该告警');
    assert.deepEqual(stagingLeftovers(root), []);
  },
);

test(
  'a failure still removes the artifacts this run created (PR #256 R4)',
  { skip: process.platform === 'win32' ? 'needs a POSIX shell to fake the zip step' : false },
  (t) => {
    const { root, publicPath, configPath, sha256 } = fixture(t);
    const output = join(root, 'delivery');
    const archive = `${output}.zip`;
    const warnings = [];
    expectCode(
      () => packageDelivery({ publicPath, configPath, sha256 }, output, {
        zipCommand: zipFailingAfterWrite(root),
        warn: (message) => warnings.push(message),
      }),
      'ARCHIVE_FAILED',
    );
    assert.equal(existsSync(archive), false, '本次运行预留的 zip 占位必须清掉');
    assert.equal(existsSync(output), false);
    assert.deepEqual(warnings, [], '自己的产物不需要告警');
    assert.deepEqual(stagingLeftovers(root), []);
  },
);

/** 假的归档器：只记录工作目录与参数，用来断言各平台归档器的调用契约。 */
function recordingArchiver(root, record) {
  const path = join(root, 'archiver-recorder.sh');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > '${record}'\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

const ZIP_MAGIC = 'PK\u0003\u0004';

test(
  'each platform hands its archiver the same job: one directory, zipped from the staging tree',
  { skip: process.platform === 'win32' ? 'needs a POSIX shell to fake the archiver' : false },
  (t) => {
    const root = temp(t, 'forge-zip-contract-');
    const staging = join(root, 'staging');
    mkdirSync(join(staging, 'package'), { recursive: true });
    writeFileSync(join(staging, 'package', 'INSTALL.md'), '# guide\n');
    const archive = join(root, 'package.zip');

    // POSIX keeps Info-ZIP: the injected zipCommand still receives the exact
    // Info-ZIP invocation, so the failure and race cases above stay honest.
    // (The shell reports its physical working directory: /var is a symlink on macOS.)
    const invoked = (record) => {
      const [cwd, ...args] = readFileSync(record, 'utf8').trimEnd().split('\n');
      return { cwd, args };
    };
    const zipRecord = join(root, 'zip.args');
    zipDirectory({ staging, name: 'package', archive, zipCommand: recordingArchiver(root, zipRecord) });
    assert.deepEqual(invoked(zipRecord), { cwd: realpathSync(staging), args: ['-r', '-q', archive, 'package'] });

    // Windows ships no zip: System32's bsdtar picks the zip container from the
    // .zip suffix and must be addressed as the archiver of that platform.
    const tarRecord = join(root, 'tar.args');
    zipDirectory({ staging, name: 'package', archive, platform: 'win32', windowsTar: recordingArchiver(root, tarRecord) });
    assert.deepEqual(invoked(tarRecord), { cwd: realpathSync(staging), args: ['--auto-compress', '--create', '--file', archive, 'package'] });

    // An explicit zipCommand wins over the platform default.
    const explicit = join(root, 'explicit.args');
    zipDirectory({ staging, name: 'package', archive, platform: 'win32', zipCommand: recordingArchiver(root, explicit) });
    assert.deepEqual(invoked(explicit), { cwd: realpathSync(staging), args: ['-r', '-q', archive, 'package'] });
  },
);

test('the default archiver of this platform writes a real zip', (t) => {
  const root = temp(t, 'forge-zip-default-');
  const staging = join(root, 'staging');
  mkdirSync(join(staging, 'package', 'installer'), { recursive: true });
  writeFileSync(join(staging, 'package', 'INSTALL.md'), '# guide\n');
  writeFileSync(join(staging, 'package', 'installer', 'run.sh'), '#!/bin/sh\n');
  const archive = join(root, 'package.zip');
  zipDirectory({ staging, name: 'package', archive });
  assert.equal(readFileSync(archive).subarray(0, 4).toString('latin1'), ZIP_MAGIC);
});

const BSDTAR = process.platform === 'win32' ? '' : (spawnSync('/usr/bin/tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');

test(
  'the Windows archiver syntax is one a real bsdtar accepts',
  { skip: /bsdtar/u.test(BSDTAR) ? false : 'needs a bsdtar (the libarchive tar Windows ships) to exercise the Windows syntax' },
  (t) => {
    const root = temp(t, 'forge-zip-bsdtar-');
    const staging = join(root, 'staging');
    mkdirSync(join(staging, 'package', 'installer'), { recursive: true });
    writeFileSync(join(staging, 'package', 'INSTALL.md'), '# guide\n');
    writeFileSync(join(staging, 'package', 'installer', 'run.sh'), '#!/bin/sh\n');
    const archive = join(root, 'package.zip');
    zipDirectory({ staging, name: 'package', archive, platform: 'win32', windowsTar: '/usr/bin/tar' });
    assert.equal(readFileSync(archive).subarray(0, 4).toString('latin1'), ZIP_MAGIC);
    const listing = execFileSync('/usr/bin/tar', ['-tf', archive], { encoding: 'utf8' });
    assert.match(listing, /package\/INSTALL\.md/u);
    assert.match(listing, /package\/installer\/run\.sh/u);
  },
);

test('employee guide starts dsh web and Desktop is documented separately (issue #254 items 19/26)', (t) => {
  const { root, publicPath, configPath, sha256 } = fixture(t);
  const output = join(root, 'delivery');
  const result = packageDelivery({ publicPath, configPath, sha256 }, output);
  assert.equal(result.written, true);

  const guide = readFileSync(join(output, 'INSTALL.md'), 'utf8');
  assert.match(guide, /在终端运行 dsh web/u, '默认安装写入 web profile，必须让员工显式启动 dsh web');
  assert.doesNotMatch(guide, /或打开 Desktop/u, '不能用「打开 Desktop」代替启动 web profile');
  assert.match(guide, /## Desktop 用户/u, 'Desktop 需单独说明安装与核验条件');
  // The desktop shell owns its own profile: an employee with both the terminal and the app installs twice.
  assert.match(guide, /桌面应用（Windows \/ macOS 安装包）使用自己的 heluo-desktop profile/u, '须说明桌面应用使用独立 profile，本启动器只装 web profile');
  assert.match(guide, /它使用 heluo-desktop profile，\s*与 web profile 各自安装、各自升级/u, '终端与桌面应用各自安装、各自升级');
  // The launcher never clears node_modules itself: the guide says what the employee is to do when pnpm refuses the profile.
  assert.match(guide, /提示 PROFILE_STORE_MISMATCH：这个 profile 的 node_modules 是另一个 pnpm 用别的 store 装的。退出所有 DSH 进程（含托盘驻留的），删除 ~\/\.dsh\/profiles\/<profile 名>\/node_modules，再运行本启动器/u, '须给出 PROFILE_STORE_MISMATCH 的处理办法');
  assert.match(guide, /自算值\*\*（自证）/u, '自算摘要必须标成自证，而不是独立口径');

  for (const name of ['install-macos.command', 'install-linux.sh']) {
    const body = readFileSync(join(output, 'installer', name), 'utf8');
    assert.match(body, /自算摘要/u, `${name} 必须说明 HASH 是自算值`);
    assert.doesNotMatch(body, /独立口径/u);
    assert.match(body, /--profile "\$\{HELUO_PROFILE:-auto\}"/u, `${name} 要允许用 HELUO_PROFILE 指定目标 profile（如 uat）`);
  }
  assert.match(readFileSync(join(output, 'installer', 'install-windows.cmd'), 'utf8'), /HELUO_PROFILE/u);
  const windows = readFileSync(join(output, 'installer', 'install-windows.cmd'), 'utf8');
  assert.match(windows, /dsh web/u);
  assert.match(windows, /separate profile/u, 'Windows 启动器必须说明 Desktop 是另一个 profile');
});

test('--embed-client-secret 允许把客户端密钥写进交付目录，但不进插件包、不进 plan、不落 zip 之外的明文清单', (t) => {
  const { root, publicPath, sha256 } = fixture(t);
  const secret = 'corp-secret-value-abcdef';
  const configPath = join(root, 'confidential.env');
  writeFileSync(configPath, [
    'HELUO_NACOS_SERVER_URL=http://nacos.corp.example/nacos',
    'HELUO_NACOS_NAMESPACE_ID=public',
    'HELUO_NACOS_USERNAME=svc-ci',
    'HELUO_NACOS_PASSWORD=synthetic-password',
    'HELUO_IAM_AUTH_MODE=confidential',
    'HELUO_IAM_DISCOVERY_URL=https://iam.corp.example/.well-known/openid-configuration',
    'HELUO_IAM_CLIENT_ID=DSH',
    'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_post',
    'HELUO_IAM_CLIENT_SECRET_REF=enterprise-oidc',
    'HELUO_IAM_SCOPES=openid profile offline_access',
    '',
  ].join('\n'));
  chmodSync(configPath, 0o600);
  const withSecret = `${configPath}.secret`;
  writeFileSync(withSecret, `${readFileSync(configPath, 'utf8')}HELUO_IAM_CLIENT_SECRET=${secret}\n`);
  chmodSync(withSecret, 0o600);
  const output = join(root, 'delivery');
  const base = { publicPath, publicSha256: sha256, configPath: withSecret, version: '0.1.0-corp.1', output, toolRoot: TOOL_ROOT };

  // 默认仍然拒绝：内嵌密钥必须由出包人显式授权。
  expectCode(() => buildDelivery({ ...base, dryRun: true }), 'BUNDLE_SECRET_EMBED_UNSUPPORTED');
  assert.equal(existsSync(output), false);

  const plan = buildDelivery({ ...base, embedClientSecret: true, dryRun: true });
  assert.equal(plan.plan.clientSecretEmbedded, true);
  assert.equal(JSON.stringify(plan.plan).includes(secret), false, 'plan 只报摘要口径，不能带密钥原文');

  const result = buildDelivery({ ...base, embedClientSecret: true, confirm: plan.digest.slice(0, 16) });
  assert.equal(result.written, true);

  const pluginDir = join(output, 'enterprise-plugin');
  const secretPath = join(pluginDir, 'iam-client-secret.txt');
  assert.equal(readFileSync(secretPath, 'utf8'), secret, '密钥按 .env 原值落到交付目录');
  assert.equal(statSync(secretPath).mode & 0o777, 0o600, '密钥文件必须 0600');

  const binding = JSON.parse(readFileSync(join(pluginDir, 'client-secret.json'), 'utf8'));
  assert.equal(binding.schema, 'heluo-client-secret/1');
  assert.equal(binding.file, 'iam-client-secret.txt');
  assert.equal(binding.sha256, sha256Of(Buffer.from(secret)));
  assert.equal(binding.clientId, 'DSH');
  assert.equal(binding.clientAuthMethod, 'client_secret_post');
  assert.equal(binding.clientSecretRef, 'enterprise-oidc');
  assert.equal(binding.discoveryUrl, 'https://iam.corp.example/.well-known/openid-configuration');

  const sums = readFileSync(join(output, 'SHA256SUMS'), 'utf8');
  assert.match(sums, /enterprise-plugin\/iam-client-secret\.txt/u);
  assert.match(sums, /enterprise-plugin\/client-secret\.json/u);

  // 插件包本身不含密钥：sidecar 只标记「随交付内嵌」，patch/配置里没有值。
  assert.equal(readFileSync(result.privateTarball).includes(Buffer.from(secret)), false, '插件 tgz 不能夹带密钥');
  const sidecarEntry = readBundleEntries(result.privateTarball, { withContent: true })
    .find((entry) => entry.path.endsWith('heluo-private-release.json'));
  const sidecar = JSON.parse(Buffer.from(sidecarEntry.content).toString('utf8'));
  assert.equal(sidecar.config.secretEmbedded, true);
  assert.equal(JSON.stringify(sidecar).includes(secret), false);

  const guide = readFileSync(join(output, 'INSTALL.md'), 'utf8');
  assert.match(guide, /内嵌的 IAM 客户端密钥/u, '安装说明必须讲清密钥随包下发与自动预置');
  assert.equal(guide.includes(secret), false, '安装说明不能出现密钥原文');
});

test('--previous-issuer 把历史绑定写进 client-secret.json，供安装器在换环境后更正绑定', (t) => {
  // 同一 ref 在旧交付里绑定过别的 issuer 时，目标机的 set 会被凭据库拒绝；制包人知道旧值，
  // 就写进绑定文件，安装器据此逐个 replace。
  const options = parseArguments([
    '--public', '/tmp/public.tgz',
    '--public-sha256', 'a'.repeat(64),
    '--config', '/tmp/enterprise.env',
    '--version', '0.1.0-corp.1',
    '--output', '/tmp/out',
    '--embed-client-secret',
    '--previous-issuer', 'http://old-iam.corp.example/oidc',
    '--previous-issuer', 'https://old.corp.example/oidc',
  ]);
  assert.deepEqual(options.previousIssuers, ['http://old-iam.corp.example/oidc', 'https://old.corp.example/oidc']);
  expectCode(() => parseArguments(['--public', '/tmp/p.tgz', '--public-sha256', 'a'.repeat(64), '--config', '/tmp/e.env', '--version', 'v', '--output', '/tmp/o', '--previous-issuer', '--embed-client-secret']), 'BAD_ARGUMENT');

  const { root, publicPath, sha256 } = fixture(t);
  const configPath = join(root, 'confidential.env');
  writeFileSync(configPath, [
    'HELUO_NACOS_SERVER_URL=http://nacos.corp.example/nacos',
    'HELUO_NACOS_NAMESPACE_ID=public',
    'HELUO_NACOS_USERNAME=svc-ci',
    'HELUO_NACOS_PASSWORD=synthetic-password',
    'HELUO_IAM_AUTH_MODE=confidential',
    'HELUO_IAM_DISCOVERY_URL=https://iam.corp.example/.well-known/openid-configuration',
    'HELUO_IAM_CLIENT_ID=DSH',
    'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_post',
    'HELUO_IAM_CLIENT_SECRET_REF=enterprise-oidc',
    'HELUO_IAM_SCOPES=openid profile offline_access',
    'HELUO_IAM_CLIENT_SECRET=corp-secret-value-abcdef',
    '',
  ].join('\n'));
  chmodSync(configPath, 0o600);
  const output = join(root, 'delivery');
  const result = packageDelivery(
    { publicPath, configPath, sha256 },
    output,
    { embedClientSecret: true, previousIssuers: ['https://old.corp.example/oidc'] },
  );
  assert.equal(result.written, true);
  const binding = JSON.parse(readFileSync(join(output, 'enterprise-plugin', 'client-secret.json'), 'utf8'));
  assert.deepEqual(binding.previousIssuers, ['https://old.corp.example/oidc']);
  assert.equal(JSON.stringify(binding).includes('corp-secret-value-abcdef'), false, '绑定文件不含密钥原文');
});

// ---- outer brand materials -----------------------------------------------------

const BRAND_SOURCES = [
  'icons/app-icon.ico',
  'icons/app-icon.icns',
  ...[16, 32, 48, 64, 128, 256, 512, 1024].map((size) => `sizes/app-icon-${size}.png`),
  'primary/wordmark-color.svg',
];

test('外层品牌：材料与品牌套件逐字节一致，身份五元组写入 app-identity.json', (t) => {
  const root = temp(t, 'forge-brand-out-');
  const content = join(root, 'content');
  const result = writeBrandingAssets(content, TOOL_ROOT, '0.1.0-corp.1');
  assert.equal(result.files.length, BRAND_SOURCES.length + 1);
  for (const source of BRAND_SOURCES) {
    const name = basename(source);
    assert.equal(
      readFileSync(join(content, 'branding', name)).equals(readFileSync(join(TOOL_ROOT, 'docs/assets/branding/cyber-long', source))),
      true,
      `${name} 必须与品牌源逐字节一致`,
    );
  }
  const identity = JSON.parse(readFileSync(join(content, 'branding', 'app-identity.json'), 'utf8'));
  assert.deepEqual(
    { ...identity, version: null, brandManifest: null },
    { schema: 'heluo-app-identity/1', ...APP_IDENTITY, version: null, brandManifest: null },
  );
  assert.equal(identity.version, '0.1.0-corp.1');
  assert.equal(typeof identity.brandManifest, 'string');
});

test('外层品牌降级：工具链缺品牌套件时返回 null 不建目录（不阻塞插件级品牌化）', (t) => {
  const root = temp(t, 'forge-brand-missing-');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'init-enterprise-plugin.mjs'), 'void 0;\n');
  const result = writeBrandingAssets(join(root, 'content'), root, '0.1.0-corp.1');
  assert.equal(result, null);
  assert.equal(existsSync(join(root, 'content', 'branding')), false);
});

test('外层品牌反向：套件存在但登记表被篡改时拒绝复制（fail-closed）', (t) => {
  const root = temp(t, 'forge-brand-tamper-');
  const brandDir = join(root, 'docs/assets/branding/cyber-long');
  const sourceDir = join(TOOL_ROOT, 'docs/assets/branding/cyber-long');
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'));
  manifest.assets = manifest.assets.filter((asset) => BRAND_SOURCES.includes(asset.path));
  const tampered = manifest.assets.find((asset) => asset.path === 'icons/app-icon.ico');
  tampered.sha256 = '0'.repeat(64);
  for (const dir of ['icons', 'sizes', 'primary']) mkdirSync(join(brandDir, dir), { recursive: true });
  for (const asset of manifest.assets) {
    writeFileSync(join(brandDir, asset.path), readFileSync(join(sourceDir, asset.path)));
  }
  writeFileSync(join(brandDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  assert.throws(
    () => writeBrandingAssets(join(root, 'content'), root, '0.1.0-corp.1'),
    (error) => error.code === 'SOURCE_MISMATCH',
  );
});
