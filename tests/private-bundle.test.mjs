/**
 * Private-release maker tests (issue #222 items ④, ⑦, ⑧).
 *
 * The fixture is a *public* tarball, not a source checkout: that is the only
 * input the maker is allowed to trust. Every refusal case asserts that no output
 * directory survives, because a half-written private artifact is worse than a
 * failed run.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readBundleEntries } from '../scripts/lib/bundle-archive.mjs';
import { writeBundleTarball } from '../scripts/lib/bundle-write.mjs';
import { verifyBundle } from '../scripts/verify-enterprise-bundle.mjs';
import {
  buildConfig,
  buildPrivateTarball,
  inspectPublicTarball,
  makePrivateBundle,
  parseEnvConfig,
  PrivateBundleError,
} from '../scripts/lib/private-bundle.mjs';

const PUBLIC_VERSION = '0.1.0';
const ENTRY = '@heluo/forge-enterprise';

function temp(t, prefix = 'forge-private-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), prefix)));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function patchText({ iamConfig = '', giteeConfig = '' } = {}) {
  const iam = iamConfig === '' ? '' : `      config:\n${iamConfig}`;
  const gitee = giteeConfig === '' ? '      config: {}\n' : `      config:\n${giteeConfig}`;
  return [
    '# fixture composition',
    '- insert:',
    '    - id: heluo-credentials-keychain',
    "      name: '@heluo/forge-credentials-keychain'",
    '    - id: heluo-iam',
    "      name: '@heluo/forge-iam'",
    ...(iam === '' ? [] : iam.split('\n')),
    '    - id: heluo-gitee',
    "      name: '@heluo/forge-gitee'",
    ...gitee.split('\n').filter(Boolean),
    '    - id: forge-devops',
    "      name: '@heluo/forge-devops'",
    '      config: {}',
    '',
  ].join('\n');
}

function publicTarball({ patch } = {}) {
  const files = [
    { path: 'package.json', body: `${JSON.stringify({ name: ENTRY, version: PUBLIC_VERSION, license: 'Apache-2.0' }, null, 2)}\n` },
    { path: 'cordis.patch.yml', body: patch ?? patchText() },
    { path: 'README.md', body: '# fixture enterprise bundle\n' },
    { path: 'src/index.mjs', body: 'export const fixture = true;\n' },
  ];
  return writeBundleTarball(files);
}

function writeConfig(root, lines) {
  const path = join(root, 'enterprise.env');
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  return path;
}

const ENV = [
  'HELUO_IAM_ISSUER=https://iam.corp.example',
  'HELUO_IAM_CLIENT_ID=forge-console',
  'HELUO_IAM_AUTHORIZATION_ENDPOINT=https://iam.corp.example/authorize',
  'HELUO_IAM_TOKEN_ENDPOINT=https://iam.corp.example/token',
  'HELUO_IAM_JWKS_URI=https://iam.corp.example/jwks',
  'HELUO_IAM_SCOPES=openid profile',
  'HELUO_IAM_CALLBACK_PORT=53682',
  'HELUO_IAM_CALLBACK_ADDRESS=127.0.0.1',
  'HELUO_GITEE_HOST=https://gitee.corp.example',
  'HELUO_GITEE_TIMEOUT_MS=15000',
];

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof PrivateBundleError, true, `expected PrivateBundleError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('maker changes only the patch, the version and its own metadata', (t) => {
  const root = temp(t);
  const publicBytes = publicTarball();
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, publicBytes);
  const configPath = writeConfig(root, ENV);
  const output = join(root, 'private');
  const result = makePrivateBundle({
    publicPath,
    expectedSha256: inspectPublicTarball(publicPath).sha256,
    configPath,
    version: '0.2.0',
    output,
    repoRoot: join(root, 'repo-does-not-exist'),
  });
  assert.equal(result.version, '0.2.0');
  assert.equal(result.base.version, PUBLIC_VERSION);
  assert.equal(result.configKeys.length, 10);
  const after = readBundleEntries(result.tarball, { withContent: true });
  const before = readBundleEntries(publicBytes, { withContent: true });
  const changed = [];
  for (const entry of before) {
    const next = after.find((item) => item.path === entry.path);
    assert.ok(next !== undefined, `${entry.path} disappeared`);
    if (entry.sha256 !== next.sha256) changed.push(entry.path);
  }
  assert.deepEqual(changed.sort(), ['cordis.patch.yml', 'package.json']);
  assert.ok(after.some((entry) => entry.path === 'heluo-private-release.json'));
  const pack = JSON.parse(after.find((entry) => entry.path === 'package.json').content.toString('utf8'));
  assert.equal(pack.version, '0.2.0');
  const patch = after.find((entry) => entry.path === 'cordis.patch.yml').content.toString('utf8');
  assert.match(patch, /id: heluo-iam/u);
  assert.match(patch, /issuer: "https:\/\/iam\.corp\.example"/u);
  assert.match(patch, /scopes:/u);
  assert.match(patch, /- "openid"/u);
  assert.match(patch, /timeoutMs: 15000/u);
  const metadata = JSON.parse(after.find((entry) => entry.path === 'heluo-private-release.json').content.toString('utf8'));
  assert.equal(metadata.config.secretEmbedded, false);
  assert.equal(JSON.stringify(metadata).includes('corp.example'), false, 'metadata must not copy configuration values');
  const verified = verifyBundle(result.tarball, { manifestPath: join(output, 'bundle-manifest.json') });
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  const sidecar = JSON.parse(readFileSync(join(output, 'private-release.json'), 'utf8'));
  assert.equal(sidecar.tarball.sha256, result.sha256);
  assert.match(readFileSync(join(output, 'SHA256SUMS'), 'utf8'), new RegExp(result.sha256, 'u'));
});

test('two runs over the same inputs produce the same tarball bytes', (t) => {
  const root = temp(t);
  const publicBytes = publicTarball();
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, publicBytes);
  const configPath = writeConfig(root, ENV);
  const digest = inspectPublicTarball(publicPath).sha256;
  const first = makePrivateBundle({ publicPath, expectedSha256: digest, configPath, version: '0.2.0', output: join(root, 'a') });
  const second = makePrivateBundle({ publicPath, expectedSha256: digest, configPath, version: '0.2.0', output: join(root, 'b') });
  assert.equal(readFileSync(first.tarball).equals(readFileSync(second.tarball)), true);
});

for (const [label, mutate, code] of [
  [
    'public digest mismatch',
    (context) => ({ ...context, expectedSha256: '0'.repeat(64) }),
    'PUBLIC_DIGEST_MISMATCH',
  ],
  [
    'unchanged private version',
    (context) => ({ ...context, version: PUBLIC_VERSION }),
    'VERSION_UNCHANGED',
  ],
  [
    'output inside the source checkout',
    (context) => ({ ...context, repoRoot: context.root, output: join(context.root, 'inside') }),
    'OUTPUT_INSIDE_REPO',
  ],
]) {
  test(`maker refuses ${label} and leaves no output`, (t) => {
    const root = temp(t);
    const publicPath = join(root, 'public.tgz');
    writeFileSync(publicPath, publicTarball());
    const configPath = writeConfig(root, ENV);
    const context = {
      root,
      publicPath,
      expectedSha256: inspectPublicTarball(publicPath).sha256,
      configPath,
      version: '0.2.0',
      output: join(root, 'out'),
      repoRoot: join(root, 'repo'),
    };
    const mutated = mutate(context);
    expectCode(() => makePrivateBundle(mutated), code);
    if (mutated.output !== join(context.root, 'inside')) assert.equal(existsSync(mutated.output), false);
  });
}

test('maker refuses an existing non-empty output', (t) => {
  const root = temp(t);
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, publicTarball());
  const configPath = writeConfig(root, ENV);
  const output = join(root, 'out');
  mkdirSync(output);
  writeFileSync(join(output, 'keep.txt'), 'do not replace\n');
  expectCode(() => makePrivateBundle({ publicPath, expectedSha256: inspectPublicTarball(publicPath).sha256, configPath, version: '0.2.0', output }), 'OUTPUT_EXISTS');
  assert.equal(readFileSync(join(output, 'keep.txt'), 'utf8'), 'do not replace\n');
});

for (const [label, lines, code] of [
  ['an exported assignment', ['export HELUO_IAM_ISSUER=https://iam.corp.example'], 'CONFIG_INVALID'],
  ['a duplicate key', [...ENV, 'HELUO_IAM_ISSUER=https://other.corp.example'], 'CONFIG_INVALID'],
  ['an unknown key', [...ENV, 'HELUO_IAM_UNKNOWN=1'], 'CONFIG_UNKNOWN_KEY'],
  ['a secret value', [...ENV, 'HELUO_IAM_CLIENT_SECRET=super-secret-value'], 'BUNDLE_SECRET_EMBED_UNSUPPORTED'],
  ['a command substitution', ['HELUO_IAM_ISSUER=$(cat /etc/hostname)'], 'CONFIG_INVALID'],
]) {
  test(`config parser refuses ${label}`, (t) => {
    const root = temp(t);
    writeFileSync(join(root, 'x.env'), `${lines.join('\n')}\n`, { mode: 0o600 });
    expectCode(() => parseEnvConfig(readFileSync(join(root, 'x.env'), 'utf8')), code);
  });
}

test('maker refuses a broadly readable configuration file', (t) => {
  const root = temp(t);
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, publicTarball());
  const configPath = writeConfig(root, ENV);
  chmodSync(configPath, 0o644);
  expectCode(
    () => makePrivateBundle({
      publicPath,
      expectedSha256: inspectPublicTarball(publicPath).sha256,
      configPath,
      version: '0.2.0',
      output: join(root, 'out'),
    }),
    'CONFIG_PERMISSIONS',
  );
  assert.equal(existsSync(join(root, 'out')), false);
});

test('confidential authentication fails closed until the secret source exists', (t) => {
  const root = temp(t);
  const entries = parseEnvConfig(
    [
      ...ENV,
      'HELUO_IAM_AUTH_MODE=confidential',
      'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_basic',
      'HELUO_IAM_CLIENT_SECRET_REF=file:iam-secret',
    ].join('\n'),
  );
  const error = (() => {
    try {
      buildConfig(entries);
    } catch (caught) {
      return caught;
    }
    return undefined;
  })();
  assert.ok(error !== undefined);
  assert.equal(error.code, 'CONFIG_INVALID');
  assert.match(error.message, /not supported by this maker yet/u);
});

test('enterprise HTTP endpoints require an explicit insecure opt-in', () => {
  const entries = (extra = []) => parseEnvConfig([
    'HELUO_IAM_AUTH_MODE=public',
    'HELUO_IAM_ISSUER=http://iam.corp.example/esc-sso/oidc',
    'HELUO_IAM_DISCOVERY_URL=http://iam.corp.example/esc-sso/oidc/.well-known/openid-configuration',
    'HELUO_IAM_CLIENT_ID=DSH',
    'HELUO_IAM_SCOPES=openid profile offline_access',
    'HELUO_IAM_CALLBACK_PORT=17321',
    'HELUO_IAM_CALLBACK_ADDRESS=127.0.0.1',
    'HELUO_IAM_MANAGED_MODELS_BASE_URL=http://gateway.corp.example:9080/aig-coding/v1',
    'HELUO_IAM_DEFAULT_PROVIDER=zy-coding',
    ...extra,
  ].join('\n'));
  assert.throws(
    () => buildConfig(entries()),
    (error) => error.code === 'CONFIG_INVALID' && /HELUO_IAM_ALLOW_INSECURE_HTTP=true/u.test(error.message),
  );
  const config = buildConfig(entries(['HELUO_IAM_ALLOW_INSECURE_HTTP=true']));
  assert.equal(config.iam.issuer, 'http://iam.corp.example/esc-sso/oidc');
  assert.equal(config.iam.managedModels.baseURL, 'http://gateway.corp.example:9080/aig-coding/v1');
  assert.equal(config.iam.allowInsecureHttp, true);
});

test('issuer without discovery or explicit endpoints is rejected at package time', () => {
  const entries = parseEnvConfig([
    'HELUO_IAM_AUTH_MODE=public',
    'HELUO_IAM_ISSUER=https://iam.corp.example',
    'HELUO_IAM_CLIENT_ID=test-client',
  ].join('\n'));
  assert.throws(
    () => buildConfig(entries),
    (error) => error.code === 'CONFIG_INVALID' && /IAM login is incomplete/u.test(error.message),
  );
  const complete = parseEnvConfig([
    'HELUO_IAM_AUTH_MODE=public',
    'HELUO_IAM_ISSUER=https://iam.corp.example',
    'HELUO_IAM_DISCOVERY_URL=https://iam.corp.example/.well-known/openid-configuration',
    'HELUO_IAM_CLIENT_ID=test-client',
  ].join('\n'));
  assert.equal(buildConfig(complete).iam.discoveryUrl, 'https://iam.corp.example/.well-known/openid-configuration');
});

test('the credentials row carries no adapter config: the platform store is the default', () => {
  const config = buildConfig(parseEnvConfig(ENV.join('\n')));
  assert.equal(config.keys.some((key) => key.startsWith('keychain.')), false);
  const built = buildPrivateTarball({
    entries: readBundleEntries(publicTarball(), { withContent: true }),
    version: '0.2.0',
    config,
    baseSha256: 'a'.repeat(64),
  });
  assert.match(built.patch, /id: heluo-credentials-keychain/u, 'the credentials provider must still be composed');
  assert.equal(/allowUnvettedPlatformAdapter|platformAdapter/u.test(built.patch), false, 'no adapter opt-in may leak into the bundle');
  // The retired key must fail loudly instead of silently changing nothing.
  assert.throws(
    () => parseEnvConfig([...ENV, 'HELUO_KEYCHAIN_ALLOW_UNVETTED_ADAPTER=true'].join('\n')),
    (error) => error.code === 'CONFIG_UNKNOWN_KEY',
  );
});

test('public input must be configuration-neutral before the maker touches it', (t) => {
  const root = temp(t);
  const dirty = publicTarball({ patch: patchText({ iamConfig: '        issuer: "https://iam.corp.example",\n' }) });
  const path = join(root, 'dirty.tgz');
  writeFileSync(path, dirty);
  const info = inspectPublicTarball(path);
  assert.equal(info.problems.some((problem) => problem.includes('non-empty config')), true, JSON.stringify(info.problems));
  expectCode(
    () => makePrivateBundle({ publicPath: path, expectedSha256: info.sha256, configPath: writeConfig(root, ENV), version: '0.2.0', output: join(root, 'out') }),
    'PUBLIC_TARBALL_INVALID',
  );
  assert.equal(existsSync(join(root, 'out')), false);
});

test('patch injection keeps every other composition line intact', () => {
  const built = buildPrivateTarball({
    entries: readBundleEntries(publicTarball(), { withContent: true }),
    version: '0.2.0',
    config: buildConfig(parseEnvConfig(ENV.join('\n'))),
    baseSha256: 'a'.repeat(64),
  });
  const patch = built.patch;
  assert.match(patch, /id: forge-devops\n {6}name: '@heluo\/forge-devops'\n {6}config: \{\}/u);
  assert.match(patch, /id: heluo-gitee\n {6}name: '@heluo\/forge-gitee'\n {6}config:\n {8}host: "https:\/\/gitee\.corp\.example"/u);
  assert.equal((patch.match(/- id: /gu) ?? []).length, 4);
});
