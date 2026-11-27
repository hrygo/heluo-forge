/**
 * Employee package builder tests (CORP-DSH-PLAN-026 §4.0).
 *
 * The builder is the only step that turns the enterprise configuration into
 * something employees receive. These tests pin three things: every mapped key
 * reaches its plugin field or is refused by name; the package is complete and
 * self-verifying; and a configuration value travels only where it belongs (the
 * patch layer for non-secret settings, a 0600 file for the client secret).
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildEmployeePackage,
  EMPLOYEE_MANIFEST_FILE,
  employeeVersionOf,
  parseArguments,
  releaseNotesOf,
  resolveEmployeeConfig,
} from '../scripts/build-employee-package.mjs';
import { readBundleEntries } from '../scripts/lib/bundle-archive.mjs';
import { buildConfig, IAM_ENV_MAP, parseEnvConfig, PrivateBundleError, SECRET_ENV_KEYS } from '../scripts/lib/private-bundle.mjs';
import { RELEASE_CONFIG_KEYS } from '../scripts/lib/release-config.mjs';
import { NACOS_ENV_MAP } from '../scripts/lib/nacos-release.mjs';
import { buildDelivery } from '../scripts/release-delivery.mjs';
import { buildPrivateTarball } from '../scripts/lib/private-bundle.mjs';
import { fakePublicBuilder, FREE_FORM, publicTarball, sha256Of, sourceRepo, temp, TOOL_ROOT, VALUES } from './support/employee-package-fixture.mjs';

const TAG = 'v1.2.3';
const ENTRY = '@heluo/forge-enterprise';
const ENGINEERING = '@heluo/forge-engineering';

// Historical combined artifacts retain their own Nacos contract. They do not
// use the current employee build's environment allowlist.
function legacySkillsConfig(env = VALUES) {
  const text = Object.entries(env).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${key === 'HELUO_NACOS_USERNAME' || key === 'HELUO_NACOS_PASSWORD' ? `"${value}"` : value}`).join('\n');
  return buildConfig(parseEnvConfig(text, { allowSecret: true }));
}

function expectCode(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof PrivateBundleError || error?.name === 'EmployeePackageError', true, `expected a coded error, got ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return true;
  });
}

/** Every file under `directory`, relative to it with forward slashes. */
function filesUnder(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path.slice(directory.length + 1).split('\\').join('/'));
    }
  };
  walk(directory);
  return files.sort();
}

test('the tag names the package and gives the private plugin a version of its own', () => {
  assert.deepEqual(employeeVersionOf('v1.2.3'), { packageVersion: '1.2.3', pluginVersion: '1.2.3-corp.1' });
  assert.deepEqual(employeeVersionOf('v1.2.3-rc.1'), { packageVersion: '1.2.3-rc.1', pluginVersion: '1.2.3-rc.1-corp.1' });
  for (const tag of ['1.2.3', 'v1.2', 'v1.2.3+build', 'main', undefined]) {
    expectCode(() => employeeVersionOf(tag), 'TAG_INVALID');
  }
});

test('arguments demand a tag, an output and exactly one configuration source', () => {
  const base = ['--tag', TAG, '--output', 'out'];
  assert.equal(parseArguments([...base, '--config', 'enterprise.env']).config, 'enterprise.env');
  assert.equal(parseArguments([...base, '--config-from-env']).configFromEnv, true);
  assert.deepEqual(parseArguments([...base, '--config', 'e.env', '--previous-issuer', 'https://old', '--previous-issuer', 'https://older']).previousIssuers, [
    'https://old',
    'https://older',
  ]);
  expectCode(() => parseArguments(['--output', 'out']), 'BAD_ARGUMENT', /--tag is required/);
  expectCode(() => parseArguments(['--tag', TAG]), 'BAD_ARGUMENT', /--output is required/);
  expectCode(() => parseArguments(base), 'BAD_ARGUMENT', /exactly one of --config/);
  expectCode(() => parseArguments([...base, '--config', 'e.env', '--config-from-env']), 'BAD_ARGUMENT', /exactly one of --config/);
  expectCode(() => parseArguments([...base, '--config', 'e.env', '--config-stdin']), 'BAD_ARGUMENT', /unknown argument --config-stdin/);
});

test('the configuration list is part of the maker schema', () => {
  // A key the maker refuses could be mapped into the workflow but never injected.
  const known = new Set([...Object.keys(IAM_ENV_MAP), ...SECRET_ENV_KEYS]);
  assert.deepEqual(RELEASE_CONFIG_KEYS.filter((key) => !known.has(key)), []);
  assert.equal(new Set(RELEASE_CONFIG_KEYS).size, RELEASE_CONFIG_KEYS.length);
});

test('every configuration key reaches its plugin field, and a bad value is refused by name', () => {
  const env = { ...VALUES, HELUO_IAM_PROFILE_FIELDS: 'workNo=staffNumber,name=displayName' };
  const config = resolveEmployeeConfig({ env });
  const fieldOf = {
    HELUO_IAM_AUTH_MODE: () => config.iam.authMode,
    HELUO_IAM_DISCOVERY_URL: () => config.iam.discoveryUrl,
    HELUO_IAM_REVOCATION_ENDPOINT: () => config.iam.revocationEndpoint,
    HELUO_IAM_CLIENT_ID: () => config.iam.clientId,
    HELUO_IAM_SCOPES: () => config.iam.scopes,
    HELUO_IAM_PROFILE_FIELDS: () => config.iam.profileFields,
    HELUO_IAM_CALLBACK_PORT: () => config.iam.callbackPort,
    HELUO_IAM_CALLBACK_ADDRESS: () => config.iam.callbackAddress,
    HELUO_IAM_MANAGED_MODELS_BASE_URL: () => config.iam.managedModels.baseURL,
    HELUO_IAM_DEFAULT_PROVIDER: () => config.iam.defaultProvider,
    // A maker-side switch: kept in the snapshot, never written to the patch layer as such.
    HELUO_IAM_ALLOW_INSECURE_HTTP: () => config.iam.allowInsecureHttp,
    HELUO_IAM_CLIENT_AUTH_METHOD: () => config.iam.clientAuthMethod,
    HELUO_IAM_CLIENT_SECRET_REF: () => config.iam.clientSecretRef,
    // The client secret is carried beside the configuration, not inside it.
    HELUO_IAM_CLIENT_SECRET: () => config.secret.clientSecret,
  };
  // `HELUO_IAM_ISSUER` is the one listed key with no valid use in this build.
  assert.deepEqual(Object.keys(fieldOf).sort(), RELEASE_CONFIG_KEYS.filter((key) => key !== 'HELUO_IAM_ISSUER').sort());
  const parsed = {
    HELUO_IAM_SCOPES: ['openid', 'profile-4a6c'],
    HELUO_IAM_PROFILE_FIELDS: { workNo: 'staffNumber', name: 'displayName' },
    HELUO_IAM_CALLBACK_PORT: 17321,
    HELUO_IAM_ALLOW_INSECURE_HTTP: true,
  };
  for (const [key, read] of Object.entries(fieldOf)) {
    assert.deepEqual(read(), parsed[key] ?? env[key], `${key} did not reach its field`);
  }
  assert.equal(Object.hasOwn(config.iam, 'clientSecret'), false);

  const refused = [
    ['HELUO_IAM_AUTH_MODE', 'sso-5b2e', /HELUO_IAM_AUTH_MODE must be public or confidential/],
    // The issuer comes from the Discovery document; explicit-endpoint mode cannot be completed from this list.
    ['HELUO_IAM_ISSUER', 'https://issuer-7f3a.corp.example', /HELUO_IAM_ISSUER must not be set together with HELUO_IAM_DISCOVERY_URL/],
    ['HELUO_IAM_DISCOVERY_URL', 'ftp://idp-7f3a.corp.example', /HELUO_IAM_DISCOVERY_URL must be an https URL/],
    ['HELUO_IAM_REVOCATION_ENDPOINT', 'https://idp-7f3a.corp.example/revoke?token=bad-9c1d', /HELUO_IAM_REVOCATION_ENDPOINT must be an https URL/],
    ['HELUO_IAM_CLIENT_ID', 'client-$(whoami)-5b2e', /HELUO_IAM_CLIENT_ID/],
    ['HELUO_IAM_SCOPES', 'profile-4a6c', /HELUO_IAM_SCOPES must include openid/],
    ['HELUO_IAM_PROFILE_FIELDS', 'workNo=employeeNumber,workNo=staffNumber', /HELUO_IAM_PROFILE_FIELDS lists workNo more than once/],
    ['HELUO_IAM_CALLBACK_PORT', '80', /HELUO_IAM_CALLBACK_PORT must be 0/],
    ['HELUO_IAM_CALLBACK_ADDRESS', 'cb-addr-7f3a.corp.example', /HELUO_IAM_CALLBACK_ADDRESS must be auto/],
    ['HELUO_IAM_MANAGED_MODELS_BASE_URL', 'gw-3e9b.corp.example/v1', /HELUO_IAM_MANAGED_MODELS_BASE_URL must be an https URL/],
    ['HELUO_IAM_DEFAULT_PROVIDER', 'bad provider-6f1d!', /HELUO_IAM_DEFAULT_PROVIDER must be an exact route ID/],
    ['HELUO_IAM_ALLOW_INSECURE_HTTP', 'yes-4d7a', /HELUO_IAM_ALLOW_INSECURE_HTTP must be true or false/],
    ['HELUO_IAM_CLIENT_AUTH_METHOD', 'none', /requires HELUO_IAM_CLIENT_AUTH_METHOD=/],
    ['HELUO_IAM_CLIENT_SECRET_REF', 'Bad_Ref-4d7a', /clientSecretRef/],
    // A line break would turn the rest of a secret into a second entry.
    ['HELUO_IAM_CLIENT_SECRET', 'line-one-9e2f\nline-two-7b4c', /expected KEY=VALUE/],
  ];
  for (const [key, value, pattern] of refused) {
    const env = { ...VALUES, [key]: value };
    expectCode(() => resolveEmployeeConfig({ env }), 'CONFIG_INVALID', pattern);
    // Refused by name: neither the value nor its first line is repeated.
    assert.throws(() => resolveEmployeeConfig({ env }), (error) => !error.message.includes(value) && !error.message.includes(value.split('\n')[0]));
  }
  // A client secret only belongs to confidential authentication.
  expectCode(() => resolveEmployeeConfig({ env: { ...VALUES, HELUO_IAM_AUTH_MODE: 'public' } }), 'CONFIG_INVALID', /HELUO_IAM_CLIENT_SECRET\(_FILE\)/);
  // Without the insecure opt-in an HTTP gateway is refused.
  expectCode(
    () => resolveEmployeeConfig({ env: { ...VALUES, HELUO_IAM_ALLOW_INSECURE_HTTP: 'false', HELUO_IAM_MANAGED_MODELS_BASE_URL: 'http://gw-3e9b.corp.example/v1' } }),
    'CONFIG_INVALID',
    /HELUO_IAM_MANAGED_MODELS_BASE_URL must be an https URL/,
  );
  // An issuer alone cannot complete a login: the explicit-endpoint keys are not in the list.
  expectCode(() => resolveEmployeeConfig({ env: { ...VALUES, HELUO_IAM_DISCOVERY_URL: undefined } }), 'CONFIG_INVALID', /HELUO_IAM_ISSUER is required when HELUO_IAM_DISCOVERY_URL is not set/);
  // Nothing mapped, nothing to build with.
  expectCode(() => resolveEmployeeConfig({ env: { PATH: '/usr/bin' } }), 'CONFIG_EMPTY');
  // Keys outside the list are not read, even when present in the environment.
  const ignored = resolveEmployeeConfig({
    env: { ...VALUES, HELUO_GITEE_HOST: 'gitee-7f3a.corp.example', HELUO_IAM_AUTHORIZATION_ENDPOINT: 'https://auth-7f3a.corp.example' },
  });
  assert.deepEqual(ignored.gitee, {});
  assert.equal(ignored.iam.authorizationEndpoint, undefined);
});

test('historical combined bundle parsing preserves Nacos credential whitespace and literal quotes and refuses multiline input', () => {
  for (const key of ['HELUO_NACOS_USERNAME', 'HELUO_NACOS_PASSWORD']) {
    const field = key === 'HELUO_NACOS_USERNAME' ? 'username' : 'password';
    for (const value of ['  synthetic value  ', '"synthetic-value"', "'synthetic-value'", 'synthetic"value']) {
      assert.equal(legacySkillsConfig({ ...VALUES, [key]: value }).nacos[field], value);
    }
    expectCode(() => legacySkillsConfig({ ...VALUES, [key]: 'line-one\nline-two' }), 'CONFIG_INVALID');
  }
});

test('historical combined delivery embeds Nacos input and refuses every missing required field', t => {
  const root = temp(t, 'forge-employee-nacos-');
  const bytes = publicTarball(ENTRY, { skills: true });
  const publicPath = join(root, 'public.tgz');
  writeFileSync(publicPath, bytes);
  const config = legacySkillsConfig();
  const input = { publicPath, publicSha256: sha256Of(bytes), config, embedClientSecret: true,
    version: '1.2.3-corp.1', output: join(root, 'delivery'), dryRun: true };
  const preview = buildDelivery(input);
  assert.equal(preview.plan.nacosConfigured, true);
  assert.equal(preview.plan.clientSecretEmbedded, true);
  assert.deepEqual(preview.plan.embeddedSecrets, ['nacos.password']);
  assert.equal(FREE_FORM.some(value => JSON.stringify(preview.plan).includes(value)), false);
  const built = buildPrivateTarball({ entries: readBundleEntries(bytes, { withContent: true }),
    config, version: input.version, baseSha256: input.publicSha256 });
  assert.ok(built.patch.includes(VALUES.HELUO_NACOS_PASSWORD));
  assert.equal(built.patch.includes(VALUES.HELUO_IAM_CLIENT_SECRET), false);
  assert.equal(built.metadata.config.clientSecretEmbedded, true);
  for (const key of Object.keys(NACOS_ENV_MAP).filter(key => key !== 'HELUO_NACOS_TIMEOUT_MS')) {
    expectCode(() => buildDelivery({ ...input, config: legacySkillsConfig({ ...VALUES, [key]: undefined }) }), 'CONFIG_INVALID', new RegExp(key));
  }
  assert.equal(existsSync(input.output), false);
  assert.equal(existsSync(`${input.output}.zip`), false);
});

test('the package is complete, self-verifying and carries the configuration where it belongs', (t) => {
  const { root, commit } = sourceRepo(t);
  const out = temp(t, 'forge-employee-out-');
  const calls = [];
  const output = join(out, 'heluo-forge-employee-1.2.3-assets');
  const result = buildEmployeePackage({
    repoRoot: root,
    tag: TAG,
    output,
    env: VALUES,
    withEngineering: true,
    buildPublicReleaseImpl: fakePublicBuilder({ commit, calls }),
  });

  // Structure: what the employee runs, what is loaded first, and the record of both.
  assert.deepEqual(filesUnder(output).filter((file) => !file.includes('/')), ['INSTALL.md', 'SHA256SUMS', EMPLOYEE_MANIFEST_FILE].sort());
  assert.deepEqual(
    readdirSync(output).sort(),
    ['INSTALL.md', 'SHA256SUMS', 'branding', EMPLOYEE_MANIFEST_FILE, 'engineering-plugin', 'enterprise-plugin', 'installer'],
  );
  assert.equal(existsSync(join(output, 'installer', 'init-enterprise-plugin.mjs')), true);
  assert.equal(existsSync(`${output}.zip`), true);
  // A finished run leaves no staging directory behind.
  assert.deepEqual(readdirSync(out).sort(), ['heluo-forge-employee-1.2.3-assets', 'heluo-forge-employee-1.2.3-assets.zip']);

  // The manifest records where everything came from, by name and digest.
  const manifest = JSON.parse(readFileSync(join(output, EMPLOYEE_MANIFEST_FILE), 'utf8'));
  assert.deepEqual(manifest, {
    schema: 'heluo-employee-package/1',
    tag: TAG,
    version: '1.2.3',
    source: { commit, dirty: false },
    host: { dshVersion: readFileSync(join(TOOL_ROOT, '.dsh-version'), 'utf8').trim() },
    packages: [
      {
        role: 'enterprise',
        name: ENTRY,
        version: '1.2.3-corp.1',
        file: 'enterprise-plugin/heluo-forge-enterprise-1.2.3-corp.1.tgz',
        sha256: result.packages[0].sha256,
      },
      {
        role: 'engineering',
        name: ENGINEERING,
        version: '0.1.0',
        file: 'engineering-plugin/heluo-forge-engineering-0.1.0.tgz',
        sha256: result.packages[1].sha256,
      },
    ],
    branding: {
      manifestVersion: 'V2.1.5',
      identity: {
        appId: 'com.heluo.forge.enterprise',
        upgradeGuid: '3fa730a8-e95c-45dc-9724-c525f3654136',
        productName: 'Heluo Forge Enterprise',
        executableName: 'heluo-forge-enterprise',
        displayName: '河洛 Forge 企业版',
      },
      files: [
        'branding/app-icon.ico',
        'branding/app-icon.icns',
        'branding/app-icon-16.png',
        'branding/app-icon-32.png',
        'branding/app-icon-48.png',
        'branding/app-icon-64.png',
        'branding/app-icon-128.png',
        'branding/app-icon-256.png',
        'branding/app-icon-512.png',
        'branding/app-icon-1024.png',
        'branding/wordmark-color.svg',
        'branding/app-identity.json',
      ],
    },
    configKeys: manifest.configKeys,
    clientSecretEmbedded: true,
    discovery: { checked: false, reason: 'not-run: the runner cannot reach the enterprise IAM' },
  });
  assert.equal(manifest.configKeys.includes('iam.discoveryUrl'), true);
  for (const pkg of manifest.packages) {
    assert.equal(sha256Of(readFileSync(join(output, pkg.file))), pkg.sha256, `${pkg.file} digest`);
  }

  // SHA256SUMS covers every file of the package but itself, and every line verifies.
  const listed = new Map(
    readFileSync(join(output, 'SHA256SUMS'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
        assert.ok(match !== null, `malformed SHA256SUMS line: ${line}`);
        return [match[2], match[1]];
      }),
  );
  assert.deepEqual([...listed.keys()].sort(), filesUnder(output).filter((file) => file !== 'SHA256SUMS'));
  for (const [file, digest] of listed) assert.equal(sha256Of(readFileSync(join(output, file))), digest, `${file} digest`);
  assert.equal(result.archiveSha256, sha256Of(readFileSync(`${output}.zip`)));

  // The builders were asked for this tag from a clean checkout: enterprise first, engineering only on request.
  assert.deepEqual(
    calls.map((call) => [call.tag, call.entry ?? ENTRY, call.includeSource, call.allowDirty]),
    [
      [TAG, ENTRY, false, false],
      [TAG, ENGINEERING, false, false],
    ],
  );

  // Non-secret settings live in the patch layer of the private tarball; the
  // maker-side HTTP switch becomes the plugin's confidential-client switch.
  const entries = readBundleEntries(join(output, manifest.packages[0].file), { withContent: true });
  const patch = entries.find((entry) => entry.path === 'cordis.patch.yml').content.toString('utf8');
  assert.ok(patch.includes(VALUES.HELUO_IAM_DISCOVERY_URL));
  assert.match(patch, /\n +profileFields:\n +workNo: "employeeNumber"\n/u);
  assert.match(patch, /allowInsecureClientAuthHttp: true/);
  assert.doesNotMatch(patch, /allowInsecureHttp:/);
  // The client secret does not: it travels as a 0600 file for first-run provisioning.
  assert.equal(patch.includes(VALUES.HELUO_IAM_CLIENT_SECRET), false);
  assert.equal(patch.includes(VALUES.HELUO_NACOS_PASSWORD), false);
  assert.doesNotMatch(patch, /heluo-skills-manager|nacos:/);
  const privateMetadata = JSON.parse(entries.find(entry => entry.path === 'heluo-private-release.json').content);
  assert.equal(privateMetadata.config.clientSecretEmbedded, true);
  assert.deepEqual(privateMetadata.config.embeddedSecrets, []);
  const secretPath = join(output, 'enterprise-plugin', 'iam-client-secret.txt');
  assert.equal(readFileSync(secretPath, 'utf8'), VALUES.HELUO_IAM_CLIENT_SECRET);
  assert.equal(statSync(secretPath).mode & 0o777, 0o600);
  const binding = JSON.parse(readFileSync(join(output, 'enterprise-plugin', 'client-secret.json'), 'utf8'));
  assert.equal(binding.clientSecretRef, VALUES.HELUO_IAM_CLIENT_SECRET_REF);
  assert.equal(binding.clientAuthMethod, VALUES.HELUO_IAM_CLIENT_AUTH_METHOD);
  // The engineering extension ships neutral: no enterprise value of any kind.
  const engineeringPatch = readBundleEntries(join(output, manifest.packages[1].file), { withContent: true })
    .find((entry) => entry.path === 'cordis.patch.yml')
    .content.toString('utf8');
  assert.equal(FREE_FORM.some((value) => engineeringPatch.includes(value)), false);
});

test('without the engineering extension the package holds the enterprise plugin alone', (t) => {
  const { root, commit } = sourceRepo(t);
  const out = temp(t, 'forge-employee-out-');
  const calls = [];
  const result = buildEmployeePackage({
    repoRoot: root,
    tag: TAG,
    output: join(out, 'package'),
    env: VALUES,
    buildPublicReleaseImpl: fakePublicBuilder({ commit, calls }),
  });
  assert.deepEqual(
    readdirSync(result.output).sort(),
    ['INSTALL.md', 'SHA256SUMS', 'branding', EMPLOYEE_MANIFEST_FILE, 'enterprise-plugin', 'installer'],
  );
  assert.deepEqual(
    calls.map((call) => call.entry ?? ENTRY),
    [ENTRY],
  );
  assert.deepEqual(
    result.packages.map((pkg) => pkg.role),
    ['enterprise'],
  );
});

test('no configuration value reaches the manifest, the release notes or the receipt', (t) => {
  const { root, commit } = sourceRepo(t);
  const out = temp(t, 'forge-employee-out-');
  const result = buildEmployeePackage({
    repoRoot: root,
    tag: TAG,
    output: join(out, 'package'),
    env: VALUES,
    buildPublicReleaseImpl: fakePublicBuilder({ commit }),
  });
  const texts = {
    manifest: readFileSync(join(result.output, EMPLOYEE_MANIFEST_FILE), 'utf8'),
    notes: releaseNotesOf(result),
    receipt: JSON.stringify(result),
    sums: readFileSync(join(result.output, 'SHA256SUMS'), 'utf8'),
  };
  for (const [label, text] of Object.entries(texts)) {
    for (const value of FREE_FORM) assert.equal(text.includes(value), false, `${label} carries a configuration value`);
  }
  // Key names are the trace that remains.
  for (const key of ['iam.clientId', 'iam.discoveryUrl', 'iam.clientSecretRef']) {
    assert.ok(texts.manifest.includes(key) && texts.notes.includes(key), `${key} is missing`);
  }
  assert.match(texts.notes, new RegExp(commit));
  assert.match(texts.notes, /Discovery 预检未在构建时执行/);
});

test('a configuration the plugins would refuse is refused before anything is built', (t) => {
  const { root, commit } = sourceRepo(t);
  const out = temp(t, 'forge-employee-out-');
  const calls = [];
  const output = join(out, 'package');
  expectCode(
    () =>
      buildEmployeePackage({
        repoRoot: root,
        tag: TAG,
        output,
        env: { ...VALUES, HELUO_IAM_ISSUER: 'https://issuer-7f3a.corp.example' },
        buildPublicReleaseImpl: fakePublicBuilder({ commit, calls }),
      }),
    'CONFIG_INVALID',
    /HELUO_IAM_ISSUER must not be set together with HELUO_IAM_DISCOVERY_URL/,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(readdirSync(out), []);
  expectCode(() => buildEmployeePackage({ tag: '1.2.3', output, env: VALUES, repoRoot: root }), 'TAG_INVALID');
  expectCode(() => buildEmployeePackage({ tag: TAG, output, repoRoot: root, env: {} }), 'CONFIG_EMPTY');
  expectCode(
    () => buildEmployeePackage({ tag: TAG, output, repoRoot: root, config: { iam: { clientId: 'unvalidated-5b2e' } } }),
    'CONFIG_INVALID',
  );
  assert.equal(calls.length, 0);
});

test('a configuration file is read only when it is private to the packager', (t) => {
  const dir = temp(t, 'forge-employee-config-');
  const configPath = join(dir, 'enterprise.env');
  const text = Object.entries(VALUES)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(configPath, `${text}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  const config = resolveEmployeeConfig({ configPath });
  assert.equal(config.iam.clientId, VALUES.HELUO_IAM_CLIENT_ID);
  assert.deepEqual(config.iam.profileFields, { workNo: 'employeeNumber' });
  chmodSync(configPath, 0o644);
  expectCode(() => resolveEmployeeConfig({ configPath }), 'CONFIG_PERMISSIONS', /chmod 600/);
});

test('an occupied destination is never replaced', (t) => {
  const { root, commit } = sourceRepo(t);
  const out = temp(t, 'forge-employee-out-');
  const output = join(out, 'package');
  const build = (target = output) =>
    buildEmployeePackage({ repoRoot: root, tag: TAG, output: target, env: VALUES, buildPublicReleaseImpl: fakePublicBuilder({ commit }) });
  mkdirSync(output);
  writeFileSync(join(output, 'kept.txt'), 'placed by someone else');
  expectCode(build, 'OUTPUT_EXISTS', /not empty/);
  assert.equal(readFileSync(join(output, 'kept.txt'), 'utf8'), 'placed by someone else');
  // An archive alone also claims the destination: the directory and the archive are published as a pair.
  rmSync(output, { recursive: true });
  writeFileSync(`${output}.zip`, 'placed by someone else');
  expectCode(build, 'OUTPUT_EXISTS', /archive already exists/);
  assert.equal(readFileSync(`${output}.zip`, 'utf8'), 'placed by someone else');
  // A new or empty directory is an acceptable destination.
  assert.equal(build(join(out, 'new')).version, '1.2.3');
  mkdirSync(join(out, 'empty'));
  assert.equal(build(join(out, 'empty')).version, '1.2.3');
});

test('a build whose record does not match the request is refused before the package is assembled', (t) => {
  const { root, commit } = sourceRepo(t);
  const out = temp(t, 'forge-employee-out-');
  const output = join(out, 'package');
  const buildWith = (buildPublicReleaseImpl) =>
    buildEmployeePackage({ repoRoot: root, tag: TAG, output, env: VALUES, buildPublicReleaseImpl });

  // No source commit: the package could not say what it was built from.
  const withoutCommit = (input) => {
    const built = fakePublicBuilder({ commit })(input);
    writeFileSync(built.manifest, JSON.stringify({ tag: input.tag, commit: null, entry: { name: ENTRY }, artifact: {} }));
    return built;
  };
  expectCode(() => buildWith(withoutCommit), 'SOURCE_UNKNOWN', /Git checkout/);
  // A record for another tag: the traceability chain is broken.
  expectCode(() => buildWith(fakePublicBuilder({ commit, tag: 'v9.9.9' })), 'TAG_MISMATCH', /v9\.9\.9/);
  assert.deepEqual(readdirSync(out), []);
});
