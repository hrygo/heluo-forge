/**
 * Private-release maker tests (issue #222 items ④, ⑦, ⑧).
 *
 * The fixture is a *public* tarball, not a source checkout: that is the only
 * input the maker is allowed to trust. Every refusal case asserts that no output
 * directory survives, because a half-written private artifact is worse than a
 * failed run.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readBundleEntries } from '../scripts/lib/bundle-archive.mjs';
import { writeBundleTarball } from '../scripts/lib/bundle-write.mjs';
import { verifyBundle } from '../scripts/verify-enterprise-bundle.mjs';
import { validateConfig } from '../packages/forge-iam/src/config.mjs';
import { createNacosClient } from '../packages/forge-skills-manager/lib/nacos.js';
import { fakeNacos } from '../packages/forge-skills-manager/spec/fixtures/nacos.mjs';
import {
  assertNacosReleaseConfig,
  preflightNacosRelease,
  assertIamValidatorMatches,
  assertNeutralPatch,
  patchEntriesOf,
  buildConfig,
  buildPrivateTarball,
  inspectPublicTarball,
  makePrivateBundle,
  parseEnvConfig,
  planDigest,
  requiredRowsForEntry,
  PrivateBundleError,
} from '../scripts/lib/private-bundle.mjs';

const PUBLIC_VERSION = '0.1.0';
const ENTRY = '@heluo/forge-enterprise';

test('P2 Nacos preflight rejects undeclared, wrong-package and disabled insert rows', () => {
  const config = buildConfig(parseEnvConfig(ENV.join('\n')));
  const layers = layeredPatchText();
  layers.base = layers.base.replace(SKILLS_ROW.trimEnd(), '');
  const undeclared = readBundleEntries(publicTarball({ patches: { 'cordis.patch.yml': layers.base, 'cordis.patch.skills.yml': '- insert:\n' + SKILLS_ROW }, declaredPatches: './cordis.patch.yml' }), { withContent: true });
  expectCode(() => preflightNacosRelease(undeclared, config), 'PUBLIC_TARBALL_INVALID');
  for (const row of [SKILLS_ROW.replace('@heluo/forge-skills-manager', '@heluo/forge-brand'), SKILLS_ROW.replace('config: {}', 'disabled: true\n      config: {}')]) {
    const entries = readBundleEntries(publicTarball({ patch: layers.base + row }), { withContent: true });
    expectCode(() => preflightNacosRelease(entries, config), 'PUBLIC_TARBALL_INVALID');
  }
});

function temp(t, prefix = 'forge-private-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), prefix)));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function patchText({ iamConfig = '', giteeConfig = '', skills = true } = {}) {
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
    ...(skills ? SKILLS_ROW.trimEnd().split('\n') : []),
    '    - id: forge-devops',
    "      name: '@heluo/forge-devops'",
    '      config: {}',
    '',
  ].join('\n');
}

function layeredPatchText() {
  return {
    base: [
      '# fixture base layer',
      '- insert:',
      '    - id: heluo-credentials-keychain',
      "      name: '@heluo/forge-credentials-keychain'",
      '    - id: heluo-iam',
      "      name: '@heluo/forge-iam'",
      ...SKILLS_ROW.trimEnd().split('\n'),
      '',
    ].join('\n'),
    overlay: [
      '# fixture engineering layer',
      '- insert:',
      '    - id: heluo-gitee',
      "      name: '@heluo/forge-gitee'",
      '      config: {}',
      '    - id: forge-devops',
      "      name: '@heluo/forge-devops'",
      '      config: {}',
      '',
    ].join('\n'),
  };
}

function publicTarball({ patch, patches, declaredPatches, validatorOverride, omitValidator, omitPatchDeclaration } = {}) {
  const files = [
    // 真实公版包必须声明默认层（`dsh.bundle.patch`）：夹具照抄这条，否则测的不是可安装形态。
    {
      path: 'package.json',
      body: `${JSON.stringify({
        name: ENTRY,
        version: PUBLIC_VERSION,
        license: 'Apache-2.0',
        ...(omitPatchDeclaration === true ? {} : { dsh: { bundle: { patch: declaredPatches ?? (patches ? ['./cordis.patch.yml', ...Object.keys(patches).filter(path => path !== 'cordis.patch.yml' && /^cordis\.patch\.[A-Za-z0-9-]+\.yml$/.test(path)).map(path => './' + path)] : './cordis.patch.yml') } } }),
      }, null, 2)}\n`,
    },
    ...(patches === undefined
      ? [{ path: 'cordis.patch.yml', body: patch ?? patchText() }]
      : Object.entries(patches).map(([name, body]) => ({ path: name, body }))),
    { path: 'README.md', body: '# fixture enterprise bundle\n' },
    { path: 'src/index.mjs', body: 'export const fixture = true;\n' },
    { path: 'node_modules/@heluo/forge-skills-manager/lib/nacos.js',
      body: readFileSync(new URL('../packages/forge-skills-manager/lib/nacos.js', import.meta.url)) },
    ...['config.mjs', 'model-options.mjs', 'http-url.mjs', 'errors.mjs'].filter((name) => name !== omitValidator).map((name) => ({
      path: `node_modules/@heluo/forge-iam/src/${name}`,
      body: name === 'config.mjs' && validatorOverride !== undefined ? validatorOverride : readFileSync(new URL(`../packages/forge-iam/src/${name}`, import.meta.url)),
    })),
  ];
  return writeBundleTarball(files);
}

test('maker rejects a public bundle with a different or missing IAM validator', (t) => {
  const root = temp(t);
  for (const [label, options] of [['different', { validatorOverride: 'export const different = true;\n' }], ['missing', { omitValidator: 'http-url.mjs' }]]) {
    const path = join(root, `${label}.tgz`);
    const bytes = publicTarball(options);
    writeFileSync(path, bytes);
    expectCode(() => inspectPublicTarball(path), 'IAM_VALIDATOR_MISMATCH');
    expectCode(() => makePrivateBundle({ publicPath: path, expectedSha256: createHash('sha256').update(bytes).digest('hex'), configPath: writeConfig(root, ENV), version: '0.2.0', output: join(root, 'out') }), 'IAM_VALIDATOR_MISMATCH');
    assert.equal(existsSync(join(root, 'out')), false);
  }
});

test('IAM validator comparison accepts LF and CRLF without accepting changed bytes', (t) => {
  const root = temp(t);
  const config = readFileSync(new URL('../packages/forge-iam/src/config.mjs', import.meta.url));
  const crlf = Buffer.from(config.toString('utf8').replace(/\r?\n/gu, '\r\n'));
  const publicPath = join(root, 'public-crlf.tgz');
  writeFileSync(publicPath, publicTarball({ validatorOverride: crlf }));
  const inspected = inspectPublicTarball(publicPath);
  const output = join(root, 'private');
  makePrivateBundle({ publicPath, expectedSha256: inspected.sha256, configPath: writeConfig(root, ENV), version: '0.2.0', output });
  assert.equal(existsSync(output), true);

  const localDirectory = join(root, 'tool', 'packages', 'forge-iam', 'src');
  mkdirSync(localDirectory, { recursive: true });
  const entries = readBundleEntries(publicTarball(), { withContent: true });
  for (const name of ['config.mjs', 'model-options.mjs', 'http-url.mjs', 'errors.mjs']) {
    const source = readFileSync(new URL(`../packages/forge-iam/src/${name}`, import.meta.url), 'utf8');
    writeFileSync(join(localDirectory, name), source.replace(/\r?\n/gu, '\r\n'));
  }
  assert.doesNotThrow(() => assertIamValidatorMatches(entries, { toolRoot: join(root, 'tool') }));
  writeFileSync(join(localDirectory, 'config.mjs'), Buffer.concat([crlf, Buffer.from('\n// changed')]));
  assert.throws(() => assertIamValidatorMatches(entries, { toolRoot: join(root, 'tool') }), (error) => {
    assert.equal(error.code, 'IAM_VALIDATOR_MISMATCH');
    assert.match(error.message, /config\.mjs/u);
    assert.equal(error.message.includes(root), false);
    return true;
  });
  const invalidBytes = entries.map((entry) => entry.path.endsWith('/config.mjs')
    ? { ...entry, content: Buffer.from([0x80, 0x0a]) }
    : entry);
  writeFileSync(join(localDirectory, 'config.mjs'), Buffer.from([0x81, 0x0d, 0x0a]));
  expectCode(() => assertIamValidatorMatches(invalidBytes, { toolRoot: join(root, 'tool') }), 'IAM_VALIDATOR_MISMATCH');
});

function writeConfig(root, lines) {
  const path = join(root, 'enterprise.env');
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  return path;
}

const IAM_ENV = [
  'HELUO_IAM_ISSUER=https://iam.corp.example',
  'HELUO_IAM_CLIENT_ID=forge-console',
  'HELUO_IAM_AUTHORIZATION_ENDPOINT=https://iam.corp.example/authorize',
  'HELUO_IAM_TOKEN_ENDPOINT=https://iam.corp.example/token',
  'HELUO_IAM_JWKS_URI=https://iam.corp.example/jwks',
  'HELUO_IAM_SCOPES=openid profile',
  'HELUO_IAM_CALLBACK_PORT=53682',
  'HELUO_IAM_CALLBACK_ADDRESS=127.0.0.1',
  'HELUO_GITEE_HOST=gitee.corp.example',
  'HELUO_GITEE_TIMEOUT_MS=15000',
];

const NACOS_ENV = [
  'HELUO_NACOS_SERVER_URL=http://nacos.corp.example/nacos',
  'HELUO_NACOS_NAMESPACE_ID=skills-prod',
  'HELUO_NACOS_USERNAME=svc-ci',
  'HELUO_NACOS_PASSWORD=synthetic-password',
  'HELUO_NACOS_TIMEOUT_MS=20000',
];
const ENV = [...IAM_ENV, ...NACOS_ENV];

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof PrivateBundleError, true, `expected PrivateBundleError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

const SKILLS_ROW = '    - id: heluo-skills-manager\n      name: \'@heluo/forge-skills-manager\'\n      config: {}\n';

test('Nacos configuration is optional and its defaults are left to the plugin', () => {
  assert.deepEqual(buildConfig(parseEnvConfig(IAM_ENV.join('\n'))).nacos, {});
  const minimal = buildConfig(parseEnvConfig([...IAM_ENV, NACOS_ENV[0]].join('\n')));
  assert.deepEqual(minimal.nacos, { serverUrl: 'http://nacos.corp.example/nacos' });
  assert.deepEqual(minimal.keys.filter((key) => key.startsWith('nacos.')), ['nacos.serverUrl']);
  for (const timeout of [100, 120000]) {
    const config = buildConfig(parseEnvConfig([...IAM_ENV, NACOS_ENV[0], `HELUO_NACOS_TIMEOUT_MS=${timeout}`].join('\n')));
    assert.match(createNacosClient(config.nacos).identity({ skillName: 'example-skill', version: '1.0.0' }), /^nacos:[a-f0-9]{64}$/u);
  }
});

test('maker embeds Nacos configuration in the owning layer and preserves other files', async (t) => {
  for (const owner of ['base', 'overlay']) {
    const root = temp(t);
    const layers = layeredPatchText();
    layers.base = layers.base.replace(SKILLS_ROW.trimEnd(), '');
    layers[owner] += SKILLS_ROW;
    const publicBytes = publicTarball({ patches: { 'cordis.patch.yml': layers.base, 'cordis.patch.engineering.yml': layers.overlay } });
    const publicPath = join(root, 'public.tgz');
    writeFileSync(publicPath, publicBytes);
    const configPath = writeConfig(root, [...IAM_ENV, ...NACOS_ENV]);
    const configBefore = readFileSync(configPath);
    assert.deepEqual(inspectPublicTarball(publicPath).problems, []);
    const config = buildConfig(parseEnvConfig(readFileSync(configPath, 'utf8')));
    const result = buildPrivateTarball({ entries: readBundleEntries(publicBytes, { withContent: true }),
      config, version: '0.1.0-corp.1', baseSha256: createHash('sha256').update(publicBytes).digest('hex') });
    const tarball = join(root, 'private.tgz');
    writeFileSync(tarball, result.tar);
    const packed = readBundleEntries(tarball, { withContent: true });
    const ownerPath = owner === 'base' ? 'cordis.patch.yml' : 'cordis.patch.engineering.yml';
    const text = packed.find((entry) => entry.path === ownerPath).content.toString('utf8');
    assert.ok(text.includes('      config:\n        nacos:\n          serverUrl: "http://nacos.corp.example/nacos"'));
    for (const expected of ['namespaceId: "skills-prod"', 'username: "svc-ci"', 'password: "synthetic-password"', 'timeoutMs: 20000']) assert.ok(text.includes(expected), expected);
    const runtimeConfig = Object.fromEntries([...text.matchAll(/^ {10}(serverUrl|namespaceId|username|password): (".*")$/gm)]
      .map(([, field, value]) => [field, JSON.parse(value)]));
    const nacos = fakeNacos('http://nacos.corp.example');
    // Read the shipped scalars, so this proves the archive and runtime contracts agree.
    await createNacosClient(runtimeConfig, nacos.fetcher).list();
    assert.deepEqual(Object.fromEntries(new URLSearchParams(nacos.calls[0].options.body)), { username: 'svc-ci', password: 'synthetic-password' });
    const otherPath = owner === 'base' ? 'cordis.patch.engineering.yml' : 'cordis.patch.yml';
    assert.doesNotMatch(packed.find((entry) => entry.path === otherPath).content.toString('utf8'), /nacos/iu);
    for (const before of readBundleEntries(publicBytes, { withContent: true })) {
      if (['package.json', 'cordis.patch.yml', 'cordis.patch.engineering.yml'].includes(before.path)) continue;
      const after = packed.find((entry) => entry.path === before.path);
      assert.equal(after.sha256, before.sha256, before.path);
      assert.equal(after.mode, before.mode, before.path);
    }
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.equal(existsSync(join(root, 'cordis.patch.yml')), false);
    const metadata = JSON.parse(packed.find((entry) => entry.path === 'heluo-private-release.json').content);
    assert.equal(metadata.config.secretEmbedded, true);
    assert.ok(metadata.config.keys.includes('nacos.serverUrl'));
    assert.doesNotMatch(JSON.stringify(metadata), /nacos\.corp\.example|skills-prod|synthetic-password|svc-ci/u);
    assert.equal(verifyBundle(tarball).ok, true);
  }
});

test('Nacos fields reject invalid deployment settings without exposing values', () => {
  const credentialUrl = new URL('https://nacos.corp.example/nacos');
  credentialUrl.username = 'svc-ci';
  credentialUrl.password = 'example-secret';
  for (const [key, value] of [
    ['SERVER_URL', ''], ['SERVER_URL', 'ftp://nacos.corp.example'],
    ['SERVER_URL', credentialUrl.href],
    ['SERVER_URL', 'https://nacos.corp.example/nacos?token=example-secret'],
    ['SERVER_URL', 'https://nacos.corp.example/nacos#example-secret'],
    ['NAMESPACE_ID', ''], ['NAMESPACE_ID', 'bad/namespace'], ['NAMESPACE_ID', 'a'.repeat(129)],
    ['USERNAME', ''], ['PASSWORD', '"   "'],
    ['TIMEOUT_MS', '99'], ['TIMEOUT_MS', '120001'], ['TIMEOUT_MS', '100.5'],
  ]) {
    const lines = NACOS_ENV.filter((line) => !line.startsWith(`HELUO_NACOS_${key}=`));
    assert.throws(() => buildConfig(parseEnvConfig([...IAM_ENV, ...lines, `HELUO_NACOS_${key}=${value}`].join('\n'))), (error) => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.doesNotMatch(error.message, /example-secret/u);
      return true;
    });
  }
  expectCode(() => buildConfig(parseEnvConfig([...IAM_ENV, 'HELUO_NACOS_NAMESPACE_ID=public'].join('\n'))), 'CONFIG_INVALID');
  for (const key of ['USERNAME_ENV', 'PASSWORD_ENV', 'ALLOW_INSECURE_HTTP', 'TOKEN']) {
    assert.throws(() => parseEnvConfig([...IAM_ENV, `HELUO_NACOS_${key}=example-secret`].join('\n')), (error) => {
      assert.equal(error.code, 'CONFIG_UNKNOWN_KEY');
      assert.doesNotMatch(error.message, /example-secret/u);
      return true;
    });
  }
});

test('formal Nacos configuration requires all four fields and accepts HTTP without an opt-in', () => {
  const full = buildConfig(parseEnvConfig([...IAM_ENV, ...NACOS_ENV].join('\n')));
  assertNacosReleaseConfig(full);
  assert.equal(full.nacos.serverUrl, 'http://nacos.corp.example/nacos');
  for (const key of ['SERVER_URL', 'NAMESPACE_ID', 'USERNAME', 'PASSWORD']) {
    const lines = NACOS_ENV.filter(line => !line.startsWith(`HELUO_NACOS_${key}=`));
    expectCode(() => assertNacosReleaseConfig(buildConfig(parseEnvConfig([...IAM_ENV, ...lines].join('\n')))), 'CONFIG_INVALID');
    const incomplete = { ...full, nacos: { ...full.nacos } };
    delete incomplete.nacos[{ SERVER_URL: 'serverUrl', NAMESPACE_ID: 'namespaceId', USERNAME: 'username', PASSWORD: 'password' }[key]];
    expectCode(() => buildPrivateTarball({ entries: readBundleEntries(publicTarball(), { withContent: true }), version: '0.1.0-corp.1', config: incomplete, baseSha256: 'a'.repeat(64) }), 'CONFIG_INVALID');
  }
  expectCode(() => assertNacosReleaseConfig(buildConfig(parseEnvConfig(IAM_ENV.join('\n')))), 'CONFIG_INVALID');
  const parameters = { publicSha256: 'a'.repeat(64), version: '0.1.0-corp.1', platforms: ['windows-x64'] };
  for (const field of ['serverUrl', 'namespaceId', 'username', 'password']) {
    const changed = { ...full, nacos: { ...full.nacos, [field]: full.nacos[field] + '-changed' } };
    assert.notEqual(planDigest({ ...parameters, config: full }), planDigest({ ...parameters, config: changed }));
  }
});

test('maker refuses Nacos configuration without an unambiguous neutral Skill Manager row', () => {
  const config = buildConfig(parseEnvConfig([...IAM_ENV, ...NACOS_ENV].join('\n')));
  const nonNeutral = SKILLS_ROW.replace('config: {}', 'config:\n        nacos:\n          serverUrl: https://nacos.corp.example/nacos');
  for (const patches of [
    { 'cordis.patch.yml': patchText({ skills: false }) },
    { 'cordis.patch.yml': patchText() + SKILLS_ROW + SKILLS_ROW },
    { 'cordis.patch.yml': patchText() + SKILLS_ROW, 'cordis.patch.other.yml': '- insert:\n' + SKILLS_ROW },
    { 'cordis.patch.yml': patchText() + nonNeutral },
  ]) {
    const bytes = publicTarball({ patches });
    expectCode(() => buildPrivateTarball({ entries: readBundleEntries(bytes, { withContent: true }),
      version: '0.1.0-corp.1', config, baseSha256: createHash('sha256').update(bytes).digest('hex') }), 'PUBLIC_TARBALL_INVALID');
  }
  assert.ok(assertNeutralPatch(patchText({ skills: false }) + nonNeutral).some((problem) => problem.includes('non-empty config')));
});

test('maker refuses an old or absent Nacos runtime that cannot read package credentials', () => {
  const config = buildConfig(parseEnvConfig(ENV.join('\n')));
  const entries = readBundleEntries(publicTarball(), { withContent: true });
  const path = 'node_modules/@heluo/forge-skills-manager/lib/nacos.js';
  for (const changed of [entries.filter(entry => entry.path !== path), entries.map(entry =>
    entry.path === path ? { ...entry, content: Buffer.from('export const oldRuntime = true;\n') } : entry)]) {
    expectCode(() => preflightNacosRelease(changed, config), 'NACOS_RUNTIME_MISMATCH');
    expectCode(() => buildPrivateTarball({ entries: changed, config, version: '0.1.0-corp.1', baseSha256: 'a'.repeat(64) }), 'NACOS_RUNTIME_MISMATCH');
  }
});

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
  assert.equal(result.configKeys.length, 15);
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
  assert.equal(metadata.config.secretEmbedded, true);
  assert.equal(JSON.stringify(metadata).includes('corp.example'), false, 'metadata must not copy configuration values');
  const verified = verifyBundle(result.tarball, { manifestPath: join(output, 'bundle-manifest.json') });
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  const sidecar = JSON.parse(readFileSync(join(output, 'private-release.json'), 'utf8'));
  assert.equal(sidecar.tarball.sha256, result.sha256);
  assert.match(readFileSync(join(output, 'SHA256SUMS'), 'utf8'), new RegExp(result.sha256, 'u'));
});

test('callback port 0 asks the plugin for an OS-assigned port', (t) => {
  const root = temp(t);
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, publicTarball());
  const configPath = writeConfig(root, ENV.map((line) => (line.startsWith('HELUO_IAM_CALLBACK_PORT=') ? 'HELUO_IAM_CALLBACK_PORT=0' : line)));
  const result = makePrivateBundle({
    publicPath,
    expectedSha256: inspectPublicTarball(publicPath).sha256,
    configPath,
    version: '0.2.0',
    output: join(root, 'private'),
  });
  const patch = readBundleEntries(result.tarball, { withContent: true })
    .find((entry) => entry.path === 'cordis.patch.yml').content.toString('utf8');
  assert.match(patch, /callbackPort: 0/u);
});

test('callback address only accepts auto or a bare loopback literal', () => {
  for (const address of ['localhost', '[::1]', '0.0.0.0', '127.0.0.2']) {
    const entries = parseEnvConfig(ENV.map((line) => (line.startsWith('HELUO_IAM_CALLBACK_ADDRESS=') ? `HELUO_IAM_CALLBACK_ADDRESS=${address}` : line)).join('\n'));
    expectCode(() => buildConfig(entries), 'CONFIG_INVALID');
  }
  for (const address of ['auto', '::1']) {
    const entries = parseEnvConfig(ENV.map((line) => (line.startsWith('HELUO_IAM_CALLBACK_ADDRESS=') ? `HELUO_IAM_CALLBACK_ADDRESS=${address}` : line)).join('\n'));
    assert.equal(buildConfig(entries).iam.callbackAddress, address);
  }
});

test('callback port outside 0 or 1024-65535 is refused', () => {
  for (const port of ['1023', '65536']) {
    const entries = parseEnvConfig(ENV.map((line) => (line.startsWith('HELUO_IAM_CALLBACK_PORT=') ? `HELUO_IAM_CALLBACK_PORT=${port}` : line)).join('\n'));
    expectCode(() => buildConfig(entries), 'CONFIG_INVALID');
  }
});

test('maker rejects representative configuration rejected by the IAM runtime', () => {
  const baseline = buildConfig(parseEnvConfig(ENV.join('\n'))).iam;
  const cases = [
    ['HELUO_IAM_SCOPES', 'profile offline_access', 'scopes', ['profile', 'offline_access']],
    ['HELUO_IAM_REDIRECT_PATH', '/api/forge-iam/test', 'redirectPath', '/api/forge-iam/test'],
    ['HELUO_IAM_REDIRECT_PATH', '/', 'redirectPath', '/'],
    ['HELUO_IAM_REDIRECT_PATH', '/callback/', 'redirectPath', '/callback/'],
    ['HELUO_IAM_REDIRECT_PATH', '/callback?secret=example', 'redirectPath', '/callback?secret=example'],
    ['HELUO_IAM_REDIRECT_PATH', '/x/../callback', 'redirectPath', '/x/../callback'],
    ['HELUO_IAM_POST_LOGOUT_REDIRECT_URI', 'invalid-url', 'postLogoutRedirectUri', 'invalid-url'],
  ];
  for (const [envKey, input, field, runtimeValue] of cases) {
    const runtime = validateConfig({ ...baseline, [field]: runtimeValue });
    assert.ok(runtime.issues?.some((issue) => issue.path.includes(field)), `${envKey} fixture must be invalid at runtime`);
    const lines = ENV.filter((line) => !line.startsWith(`${envKey}=`));
    expectCode(() => buildConfig(parseEnvConfig([...lines, `${envKey}=${input}`].join('\n'))), 'CONFIG_INVALID');
  }
  for (const path of ['/iam/callback', '/valid-callback']) {
    const built = buildConfig(parseEnvConfig([...ENV, `HELUO_IAM_REDIRECT_PATH=${path}`].join('\n')));
    assert.equal(validateConfig(built.iam).issues, undefined);
  }
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

test('the maker accepts only immutable snapshots issued by configuration validation', (t) => {
  const root = temp(t);
  const publicPath = join(root, 'public.tgz');
  const bytes = publicTarball();
  const entries = readBundleEntries(bytes, { withContent: true });
  writeFileSync(publicPath, bytes);
  const configPath = writeConfig(root, [
    ...ENV,
    'HELUO_IAM_MANAGED_MODELS_BASE_URL=https://gateway.corp.example/v1',
    'HELUO_IAM_DEFAULT_PROVIDER=route-1',
    'HELUO_GITEE_AUTH_ENV=FORGE_GITEE_TOKEN',
  ]);
  const config = buildConfig(parseEnvConfig(readFileSync(configPath, 'utf8')));
  const unvalidated = { ...config, iam: { ...config.iam, allowInsecureClientAuthHttp: true } };
  const version = '0.2.0';
  const output = join(root, 'out');
  const baseSha256 = inspectPublicTarball(publicPath).sha256;

  expectCode(() => makePrivateBundle({ publicPath, expectedSha256: baseSha256, configPath, config: unvalidated, version, output }), 'CONFIG_INVALID');
  expectCode(() => buildPrivateTarball({ entries, config: structuredClone(config), version, baseSha256 }), 'CONFIG_INVALID');
  assert.equal(existsSync(output), false);
  for (const object of [config, config.iam, config.gitee, config.iam.scopes, config.iam.managedModels, config.gitee.authEnv, config.keys]) {
    assert.ok(object && Object.isFrozen(object));
  }
  assert.equal(makePrivateBundle({ publicPath, expectedSha256: baseSha256, config, version, output }).verified, true);
});

test('a confidential private bundle carries only the declared IAM method and reference', (t) => {
  const root = temp(t);
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, publicTarball());
  const configPath = writeConfig(root, [
    ...ENV,
    'HELUO_IAM_AUTH_MODE=confidential',
    'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_post',
    'HELUO_IAM_CLIENT_SECRET_REF=enterprise-oidc',
  ]);
  const result = makePrivateBundle({
    publicPath,
    expectedSha256: inspectPublicTarball(publicPath).sha256,
    configPath,
    version: '0.2.0',
    output: join(root, 'private'),
    repoRoot: join(root, 'repo-does-not-exist'),
  });
  const entries = readBundleEntries(result.tarball, { withContent: true });
  const patch = entries.find((entry) => entry.path === 'cordis.patch.yml').content.toString('utf8');
  assert.match(patch, /authMode: "confidential"/u);
  assert.match(patch, /clientAuthMethod: "client_secret_post"/u);
  assert.match(patch, /clientSecretRef: "enterprise-oidc"/u);
  assert.doesNotMatch(patch, /^\s*(?:clientSecret|client_secret):/mu);
  const metadata = JSON.parse(entries.find((entry) => entry.path === 'heluo-private-release.json').content.toString('utf8'));
  assert.equal(metadata.config.secretEmbedded, true);
  assert.equal(metadata.config.clientSecretEmbedded, false);
  assert.deepEqual(metadata.config.embeddedSecrets, ['nacos.password']);
  assert.doesNotMatch(JSON.stringify(metadata), /enterprise-oidc/u);
});

test('a confidential configuration requires an explicit supported method and record selector', () => {
  const mode = [...ENV, 'HELUO_IAM_AUTH_MODE=confidential'];
  const method = 'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_basic';
  const ref = 'HELUO_IAM_CLIENT_SECRET_REF=enterprise-oidc';
  for (const additions of [[method], [ref], [method, 'HELUO_IAM_CLIENT_SECRET_REF=file:iam-secret']]) {
    expectCode(() => buildConfig(parseEnvConfig([...mode, ...additions].join('\n'))), 'CONFIG_INVALID');
  }
  for (const value of ['', '"   "']) {
    const input = [...mode, method, `HELUO_IAM_CLIENT_SECRET_REF=${value}`];
    expectCode(() => buildConfig(parseEnvConfig(input.join('\n'))), 'CONFIG_INVALID');
  }
});

test('enterprise HTTP endpoints require an explicit insecure opt-in', () => {
  const entries = (extra = []) => parseEnvConfig([
    'HELUO_IAM_AUTH_MODE=public',
    'HELUO_IAM_DISCOVERY_URL=http://iam.corp.example/esc-sso/oidc/.well-known/openid-configuration',
    'HELUO_IAM_CLIENT_ID=DSH',
    'HELUO_IAM_SCOPES=openid profile offline_access',
    'HELUO_IAM_CALLBACK_PORT=17321',
    'HELUO_IAM_CALLBACK_ADDRESS=127.0.0.1',
    'HELUO_IAM_MANAGED_MODELS_BASE_URL=http://gateway.corp.example:9080/aig-coding/v1',
    'HELUO_IAM_DEFAULT_PROVIDER=zy-coding',
    ...NACOS_ENV,
    ...extra,
  ].join('\n'));
  assert.throws(
    () => buildConfig(entries()),
    (error) => error.code === 'CONFIG_INVALID' && /HELUO_IAM_ALLOW_INSECURE_HTTP=true/u.test(error.message),
  );
  const config = buildConfig(entries(['HELUO_IAM_ALLOW_INSECURE_HTTP=true']));
  assert.equal(config.iam.discoveryUrl, 'http://iam.corp.example/esc-sso/oidc/.well-known/openid-configuration');
  assert.equal('issuer' in config.iam, false, 'discovery mode must not emit a pinned issuer');
  assert.equal(config.iam.managedModels.baseURL, 'http://gateway.corp.example:9080/aig-coding/v1');
  assert.equal(config.iam.allowInsecureHttp, true);
  const built = buildPrivateTarball({ entries: readBundleEntries(publicTarball(), { withContent: true }), version: '0.2.0', config, baseSha256: 'a'.repeat(64) });
  assert.doesNotMatch(built.patch, /allowInsecureHttp/u, 'the packaging-only opt-in must not be represented as a runtime guard');
  assert.doesNotMatch(built.patch, /allowInsecureClientAuthHttp/u);
});

test('confidential private patches carry the explicit HTTP opt-in for either Discovery protocol', () => {
  const env = [
    ...ENV.filter((line) => !line.startsWith('HELUO_IAM_ISSUER=')),
    'HELUO_IAM_DISCOVERY_URL=https://iam.corp.example/.well-known/openid-configuration',
    'HELUO_IAM_AUTH_MODE=confidential',
    'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_post',
    'HELUO_IAM_CLIENT_SECRET_REF=enterprise-oidc',
  ];
  const entries = readBundleEntries(publicTarball(), { withContent: true });
  const httpEnv = env.map((line) => line.replace('https://iam.corp.example/', 'http://iam.corp.example/'));
  for (const [endpoints, optIn] of [[env, undefined], [env, 'false'], [env, 'true'], [httpEnv, 'true']]) {
    const input = optIn === undefined ? endpoints : [...endpoints, `HELUO_IAM_ALLOW_INSECURE_HTTP=${optIn}`];
    const config = buildConfig(parseEnvConfig(input.join('\n')));
    const { patch } = buildPrivateTarball({ entries, version: '0.2.0', config, baseSha256: 'a'.repeat(64) });
    assert.ok(patch.includes(`discoveryUrl: "${config.iam.discoveryUrl}"`));
    assert.doesNotMatch(patch, /allowInsecureHttp/u);
    if (optIn === 'true') assert.match(patch, /^\s+allowInsecureClientAuthHttp: true$/mu);
    else assert.doesNotMatch(patch, /allowInsecureClientAuthHttp/u);
  }
});

test('discovery is sufficient for login; an issuer without endpoints is incomplete', () => {
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
    'HELUO_IAM_DISCOVERY_URL=https://iam.corp.example/.well-known/openid-configuration',
    'HELUO_IAM_CLIENT_ID=test-client',
  ].join('\n'));
  const config = buildConfig(complete);
  assert.equal(config.iam.discoveryUrl, 'https://iam.corp.example/.well-known/openid-configuration');
  assert.equal('issuer' in config.iam, false);
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

test('patch layer set: the declared default layer must ship, duplicates and dirty overlay rows are refused', (t) => {
  const root = temp(t);
  const patches = layeredPatchText();

  // 1) 少了 `dsh.bundle.patch` 指向的默认层：装上也加载不到，必须 fail closed。
  const overlayOnly = join(root, 'overlay-only.tgz');
  writeFileSync(overlayOnly, publicTarball({ patches: { 'cordis.patch.engineering.yml': patches.overlay } }));
  assert.ok(inspectPublicTarball(overlayOnly).problems.some((problem) => problem.includes('does not ship the declared patch cordis.patch.yml')));
  expectCode(() => buildPrivateTarball({
    entries: readBundleEntries(readFileSync(overlayOnly), { withContent: true }),
    version: '0.1.1',
    config: buildConfig(parseEnvConfig(ENV.join('\n'))),
    baseSha256: createHash('sha256').update(readFileSync(overlayOnly)).digest('hex'),
  }), 'PUBLIC_TARBALL_INVALID');

  // 1b) 连声明都没有：`package.json` 没写 `dsh.bundle.patch`，同样不可安装。
  const undeclared = join(root, 'undeclared.tgz');
  writeFileSync(undeclared, publicTarball({ omitPatchDeclaration: true }));
  assert.ok(inspectPublicTarball(undeclared).problems.some((problem) => problem.includes('does not declare dsh.bundle.patch')));

  // 2) 一层都没有：同样拒绝（旧门禁在这里报 no bundle patch file）。
  const noPatch = join(root, 'no-patch.tgz');
  writeFileSync(noPatch, publicTarball({ patches: {} }));
  assert.ok(inspectPublicTarball(noPatch).problems.some((problem) => problem.includes('bundle has no patch file')));

  // 3) 必需行在两层都不存在：集合判定的否定方向。
  const missingRow = join(root, 'missing-row.tgz');
  writeFileSync(missingRow, publicTarball({
    patches: {
      'cordis.patch.yml': patches.base.replace(/ {4}- id: heluo-iam\n {6}name: '@heluo\/forge-iam'\n/u, ''),
      'cordis.patch.engineering.yml': patches.overlay,
    },
  }));
  assert.ok(inspectPublicTarball(missingRow).problems.some((problem) => problem.includes('patch set has no insert entry "heluo-iam"')));

  // 3b) 通用底座无研发行（仅 keychain + policy + iam）属于合规形态；而工程套件包则仍要求 devops 与 gitee 行。
  const universalOnly = join(root, 'universal-only.tgz');
  writeFileSync(universalOnly, publicTarball({ patches: { 'cordis.patch.yml': patches.base } }));
  assert.deepEqual(inspectPublicTarball(universalOnly).problems, []);
  const engineeringProblems = assertNeutralPatch(
    patches.overlay.replace(/ {4}- id: forge-devops\n {6}name: '@heluo\/forge-devops'\n {6}config: \{\}\n?/u, ''),
    { required: requiredRowsForEntry('@heluo/forge-engineering') },
  );
  assert.ok(engineeringProblems.some((problem) => problem.includes('patch set has no insert entry "forge-devops"')));

  // 4) 同一行出现在两层：归属不明，注入只落第一处，另一处留空 config 反而可能覆盖回去。
  const duplicate = join(root, 'duplicate.tgz');
  writeFileSync(duplicate, publicTarball({
    patches: {
      'cordis.patch.yml': patches.base,
      'cordis.patch.engineering.yml': `${patches.overlay}    - id: heluo-iam\n      name: '@heluo/forge-iam'\n      config: {}\n`,
    },
  }));
  assert.ok(inspectPublicTarball(duplicate).problems.some((problem) => problem.includes('declared by more than one patch layer')));

  // 5) 非首层的行带非空 config：中立性扫描必须逐层看，不能只看第一层。
  const dirtyOverlay = join(root, 'dirty-overlay.tgz');
  writeFileSync(dirtyOverlay, publicTarball({
    patches: {
      'cordis.patch.yml': patches.base,
      'cordis.patch.engineering.yml': patches.overlay.replace('config: {}', 'config:\n        host: "gitee.corp.example"'),
    },
  }));
  assert.ok(inspectPublicTarball(dirtyOverlay).problems.some((problem) => problem.includes('carries a non-empty config')));
});

test('member package patches are not bundle layers: only top-level cordis.patch*.yml participates', () => {
  const patches = layeredPatchText();
  const withMemberPatch = publicTarball({
    patches: {
      'cordis.patch.yml': patches.base,
      'cordis.patch.engineering.yml': patches.overlay,
      'node_modules/@heluo/forge-gitee/cordis.patch.yml': '- insert:\n    - id: heluo-gitee\n      name: \'@heluo/forge-gitee\'\n      config: {}\n',
    },
  });
  const entries = readBundleEntries(withMemberPatch, { withContent: true });
  const layers = patchEntriesOf(entries).map((entry) => entry.path);
  assert.deepEqual(layers.sort(), ['cordis.patch.engineering.yml', 'cordis.patch.yml'], '成员包自带的补丁不得算作 bundle 层');
  const built = buildPrivateTarball({
    entries,
    version: '0.1.1',
    config: buildConfig(parseEnvConfig(ENV.join('\n'))),
    baseSha256: createHash('sha256').update(withMemberPatch).digest('hex'),
  });
  assert.match(built.patches.get('cordis.patch.engineering.yml'), /gitee\.corp\.example/u, '注入仍落在根叠加层');
  assert.doesNotMatch(built.patches.get('cordis.patch.yml'), /gitee\.corp\.example/u);
});

test('change metadata lists only the layers that were actually rewritten', () => {
  const patches = layeredPatchText();
  const bytes = publicTarball({
    patches: {
      'cordis.patch.yml': patches.base,
      'cordis.patch.engineering.yml': patches.overlay,
      'cordis.patch.extra.yml': '- insert:\n    - id: forge-policy-extra\n      name: \'@heluo/forge-policy\'\n      config: {}\n',
    },
  });
  const built = buildPrivateTarball({
    entries: readBundleEntries(bytes, { withContent: true }),
    version: '0.1.1',
    config: buildConfig(parseEnvConfig(ENV.join('\n'))),
    baseSha256: createHash('sha256').update(bytes).digest('hex'),
  });
  assert.ok(built.changed.includes('cordis.patch.engineering.yml'));
  assert.equal(built.changed.includes('cordis.patch.extra.yml'), false, '没被改写的层不该出现在 change 元数据里');
});

test('a run that writes an artifact the verifier rejects fails and leaves no output', (t) => {
  const root = temp(t);
  const publicBytes = publicTarball();
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, publicBytes);
  const output = join(root, 'out');
  assert.throws(() => makePrivateBundle({
    publicPath,
    expectedSha256: createHash('sha256').update(publicBytes).digest('hex'),
    configPath: writeConfig(root, ENV),
    version: '0.2.0',
    output,
    verifyImpl: () => ({ ok: false, errors: ['forced failure'] }),
  }), (error) => {
    assert.equal(error.code, 'ARTIFACT_VERIFY_FAILED');
    assert.equal(error.message.includes(root), false);
    return true;
  });
  assert.equal(existsSync(output), false, '校验不过时不得留下输出目录');
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
  assert.match(patch, /id: heluo-gitee\n {6}name: '@heluo\/forge-gitee'\n {6}config:\n {8}host: "gitee\.corp\.example"/u);
  assert.equal((patch.match(/- id: /gu) ?? []).length, 5);
});

test('layer-aware gate: a two-layer bundle is neutral and gets its config injected where the row lives', (t) => {
  const root = temp(t);
  const patches = layeredPatchText();
  const publicBytes = publicTarball({ patches: { 'cordis.patch.yml': patches.base, 'cordis.patch.engineering.yml': patches.overlay } });
  const publicPath = join(root, 'layered-public.tgz');
  writeFileSync(publicPath, publicBytes);

  // The gate judges the set: neither layer alone carries all three rows.
  const inspected = inspectPublicTarball(publicPath);
  assert.deepEqual(inspected.problems, []);

  const config = buildConfig(parseEnvConfig(ENV.join('\n')));
  const built = buildPrivateTarball({
    entries: readBundleEntries(publicBytes, { withContent: true }),
    version: '0.1.1',
    config,
    baseSha256: createHash('sha256').update(publicBytes).digest('hex'),
    requireVersionChange: true,
  });
  // The rows moved; the injected config must move with them.
  const base = built.patches.get('cordis.patch.yml');
  const overlay = built.patches.get('cordis.patch.engineering.yml');
  assert.match(base, /id: heluo-iam/u);
  assert.doesNotMatch(base, /heluo-gitee/u);
  assert.match(overlay, /id: heluo-gitee/u);
  assert.match(overlay, /gitee\.corp\.example/u, 'Gitee endpoint must land in the layer that declares the row');
  assert.match(base, /iam\.corp\.example/u);
  assert.doesNotMatch(overlay, /iam\.corp\.example/u);

  // 断言产物字节，而不只是内存里的 map：`buildPrivateTarball` 真正把两层写进 tar 的那一步
  // 单独回退（只写 IAM 层、叠加层保持 `config: {}`）时，上面的断言仍然全绿。
  const entries = readBundleEntries(built.tar, { withContent: true });
  const textOf = (name) => {
    const entry = entries.find((item) => item.path === name || item.path === `package/${name}`);
    assert.ok(entry, `${name} must be present in the private tarball`);
    return String(entry.content ?? '');
  };
  const packedBase = textOf('cordis.patch.yml');
  const packedOverlay = textOf('cordis.patch.engineering.yml');
  assert.match(packedBase, /iam\.corp\.example/u, 'IAM config must be written into the packed base layer');
  assert.doesNotMatch(packedBase, /gitee\.corp\.example/u, 'base layer must not carry the Gitee endpoint');
  assert.match(packedOverlay, /gitee\.corp\.example/u, 'Gitee config must be written into the packed overlay layer');
  assert.doesNotMatch(packedOverlay, /iam\.corp\.example/u, 'overlay layer must not carry the gateway endpoint');
  assert.ok(built.changed.includes('cordis.patch.yml'), 'change metadata must list the base layer');
  assert.ok(built.changed.includes('cordis.patch.engineering.yml'), 'change metadata must list the overlay layer');
});

test('universal base tarball succeeds with IAM-only config and refuses Gitee config mismatch', () => {
  const baseOnlyPatch = layeredPatchText().base;
  const universalBytes = publicTarball({ patches: { 'cordis.patch.yml': baseOnlyPatch } });
  const iamOnlyEnv = ENV.filter((line) => !line.startsWith('HELUO_GITEE_'));
  const iamOnly = buildConfig(parseEnvConfig(iamOnlyEnv.join('\n')));
  const built = buildPrivateTarball({
    entries: readBundleEntries(universalBytes, { withContent: true }),
    version: '0.1.1',
    config: iamOnly,
    baseSha256: createHash('sha256').update(universalBytes).digest('hex'),
  });
  assert.match(built.patch, /iam\.corp\.example/u);
  assert.doesNotMatch(built.patch, /heluo-gitee/u);

  const withGitee = buildConfig(parseEnvConfig(ENV.join('\n')));
  expectCode(() => buildPrivateTarball({
    entries: readBundleEntries(universalBytes, { withContent: true }),
    version: '0.1.1',
    config: withGitee,
    baseSha256: createHash('sha256').update(universalBytes).digest('hex'),
  }), 'PUBLIC_TARBALL_INVALID');
});

test('客户端密钥：默认拒绝，显式允许时只作为交付侧材料，不进 patch 与配置键', (t) => {
  const root = temp(t);
  const secretFile = join(root, 'client-secret.txt');
  writeFileSync(secretFile, 'file-secret-value\n');
  const base = [
    'HELUO_IAM_AUTH_MODE=confidential',
    'HELUO_IAM_DISCOVERY_URL=https://iam.corp.example/.well-known/openid-configuration',
    'HELUO_IAM_CLIENT_ID=test-client',
    'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_post',
    'HELUO_IAM_CLIENT_SECRET_REF=enterprise-oidc',
    'HELUO_IAM_SCOPES=openid profile',
  ];
  const inline = [...base, 'HELUO_IAM_CLIENT_SECRET=corp-secret-value', ''].join('\n');
  assert.throws(
    () => parseEnvConfig(inline),
    (error) => error instanceof PrivateBundleError && error.code === 'BUNDLE_SECRET_EMBED_UNSUPPORTED',
    '不带显式许可时必须仍然拒绝',
  );

  const config = buildConfig(parseEnvConfig(inline, { allowSecret: true }));
  assert.equal(config.secret.clientSecret, 'corp-secret-value');
  assert.equal(Object.keys(config.iam).includes('clientSecret'), false, '密钥不得进入插件配置');
  assert.equal(Object.values(config.iam).includes('corp-secret-value'), false);
  assert.equal(config.keys.some((key) => /clientSecret$/u.test(key)), false, '配置键清单会被打印，不能含密钥');
  assert.equal(config.keys.includes('iam.clientSecretRef'), true);

  const fromFile = buildConfig(parseEnvConfig([...base, `HELUO_IAM_CLIENT_SECRET_FILE=${secretFile}`, ''].join('\n'), { allowSecret: true }));
  assert.equal(fromFile.secret.clientSecret, 'file-secret-value', '文件形式读到内容并去掉行尾换行');

  assert.throws(
    () => buildConfig(parseEnvConfig([...base, 'HELUO_IAM_CLIENT_SECRET=a', `HELUO_IAM_CLIENT_SECRET_FILE=${secretFile}`, ''].join('\n'), { allowSecret: true })),
    (error) => error instanceof PrivateBundleError && error.code === 'CONFIG_INVALID' && /set only one of/u.test(error.message),
    '两个密钥键同时出现时整体拒绝',
  );
});

test('客户端密钥只允许与 confidential 搭配', () => {
  const text = [
    'HELUO_IAM_AUTH_MODE=public',
    'HELUO_IAM_DISCOVERY_URL=https://iam.corp.example/.well-known/openid-configuration',
    'HELUO_IAM_CLIENT_ID=test-client',
    'HELUO_IAM_SCOPES=openid profile',
    'HELUO_IAM_CLIENT_SECRET=corp-secret-value',
    '',
  ].join('\n');
  assert.throws(
    () => buildConfig(parseEnvConfig(text, { allowSecret: true })),
    (error) => error instanceof PrivateBundleError && error.code === 'CONFIG_INVALID' && /only valid with/u.test(error.message),
  );
});

test('profile fields map claim names into the iam config', () => {
  const entries = parseEnvConfig([...ENV, 'HELUO_IAM_PROFILE_FIELDS=workNo=employeeNumber,name=displayName'].join('\n'));
  assert.deepEqual(buildConfig(entries).iam.profileFields, { workNo: 'employeeNumber', name: 'displayName' });
});

test('profile fields refuse unknown keys, missing pairs and non-token claims', () => {
  for (const value of ['dept=department', 'workNo', 'workNo=work no', 'name=displayName=extra', '=work_no']) {
    const entries = parseEnvConfig([...ENV, `HELUO_IAM_PROFILE_FIELDS=${value}`].join('\n'));
    expectCode(() => buildConfig(entries), 'CONFIG_INVALID');
  }
});

test('a repeated profile key is refused instead of shipping an empty mapping', () => {
  // Dropping the mapping would leave the account panel blank with a green build,
  // which is exactly what this key is meant to prevent.
  for (const value of ['workNo=employeeNumber,workNo=displayName', 'name=displayName,workNo=employeeNumber,name=work_no']) {
    const entries = parseEnvConfig([...ENV, `HELUO_IAM_PROFILE_FIELDS=${value}`].join('\n'));
    expectCode(() => buildConfig(entries), 'CONFIG_INVALID');
  }
});

test('the shipped profile mapping passes the plugin schema', () => {
  const entries = parseEnvConfig([...ENV, 'HELUO_IAM_PROFILE_FIELDS=name=displayName,workNo=employeeNumber'].join('\n'));
  const { iam } = buildConfig(entries);
  const result = validateConfig({ ...iam });
  assert.equal('issues' in result, false, JSON.stringify(result.issues ?? []));
  assert.deepEqual(result.value.profileFields, { name: 'displayName', workNo: 'employeeNumber' });
});

test('private metadata distinguishes Nacos and IAM client secrets in every combination', t => {
  for (const withNacos of [false, true]) {
    for (const withClientSecret of [false, true]) {
      const config = buildConfig(parseEnvConfig([
        ...IAM_ENV,
        ...(withNacos ? NACOS_ENV : []),
        'HELUO_IAM_AUTH_MODE=confidential',
        'HELUO_IAM_CLIENT_AUTH_METHOD=client_secret_post',
        'HELUO_IAM_CLIENT_SECRET_REF=enterprise-oidc',
        ...(withClientSecret ? ['HELUO_IAM_CLIENT_SECRET=synthetic-client-secret'] : []),
      ].join('\n'), { allowSecret: true }));
      const bytes = publicTarball({ patch: patchText({ skills: withNacos }) });
      const built = buildPrivateTarball({ entries: readBundleEntries(bytes, { withContent: true }),
        config, version: '0.1.0-corp.1', baseSha256: createHash('sha256').update(bytes).digest('hex') });
      const packed = readBundleEntries(built.tar, { withContent: true });
      const metadata = JSON.parse(packed.find(entry => entry.path === 'heluo-private-release.json').content);
      const patch = packed.find(entry => entry.path === 'cordis.patch.yml').content.toString('utf8');
      assert.equal(metadata.config.secretEmbedded, withNacos || withClientSecret);
      assert.equal(metadata.config.clientSecretEmbedded, withClientSecret);
      assert.deepEqual(metadata.config.embeddedSecrets, withNacos ? ['nacos.password'] : []);
      assert.doesNotMatch(patch + JSON.stringify(metadata), /synthetic-client-secret/);
      assert.equal(patch.includes('synthetic-password'), withNacos);
      const root = temp(t);
      const publicPath = join(root, 'public.tgz');
      writeFileSync(publicPath, bytes);
      const result = makePrivateBundle({ publicPath, expectedSha256: createHash('sha256').update(bytes).digest('hex'),
        config, version: '0.1.0-corp.1', output: join(root, 'private'), repoRoot: join(root, 'repo') });
      assert.equal(result.secretEmbedded, withNacos || withClientSecret);
      assert.equal(result.clientSecretEmbedded, withClientSecret);
    }
  }
});

test('Nacos requirement follows the installed plugin instead of every private bundle', () => {
  const config = buildConfig(parseEnvConfig(IAM_ENV.join('\n')));
  const entries = readBundleEntries(publicTarball({ patch: patchText({ skills: false }) }), { withContent: true })
    .filter(entry => !entry.path.includes('@heluo/forge-skills-manager/'));
  const plan = preflightNacosRelease(entries, config);
  assert.deepEqual(plan, { nacosConfigured: false, embeddedSecrets: [], secretEmbedded: false });
  const built = buildPrivateTarball({ entries, config, version: '0.1.0-corp.1', baseSha256: 'a'.repeat(64) });
  assert.equal(built.metadata.config.secretEmbedded, false);
  assert.deepEqual(built.metadata.config.embeddedSecrets, []);
  assert.doesNotMatch(built.patch, /nacos/);
  const withNacos = buildConfig(parseEnvConfig(ENV.join('\n')));
  expectCode(() => preflightNacosRelease(entries, withNacos), 'PUBLIC_TARBALL_INVALID');
  const installed = readBundleEntries(publicTarball(), { withContent: true });
  expectCode(() => preflightNacosRelease(installed, config), 'CONFIG_INVALID');
});
