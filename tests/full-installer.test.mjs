/**
 * Full-installer assembler/verifier tests (issue #222 items ⑤, ⑦).
 *
 * Inputs are fixtures, not a real vendor host build: the tests assert the
 * contract (six platforms, per-platform digests, loopback-only Web) and that
 * every tampering path is detected. They deliberately do not claim the vendor
 * host itself was exercised.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeBundleTarball } from '../scripts/lib/bundle-write.mjs';
import {
  assembleFullInstaller,
  readInstallerInputs,
  readPrivateRelease,
  verifyFullInstaller,
} from '../scripts/lib/full-installer.mjs';
import { makePrivateBundle, inspectPublicTarball, PrivateBundleError } from '../scripts/lib/private-bundle.mjs';
import { sha256 } from '../scripts/lib/release-support.mjs';

const PLATFORMS = {
  'windows-x64': { web: false, extension: 'zip' },
  'windows-arm64': { web: true, extension: 'zip' },
  'linux-x64': { web: true, extension: 'tgz' },
  'linux-arm64': { web: true, extension: 'tgz' },
  'macos-x64': { web: false, extension: 'zip' },
  'macos-arm64': { web: false, extension: 'zip' },
};

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-installer-test-'));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), 'forge-installer-test-')));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof PrivateBundleError, `unexpected error: ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    return true;
  });
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

function makePrivate(root) {
  const publicPath = join(root, 'public.tgz');
  writeFileSync(
    publicPath,
    writeBundleTarball([
      { path: 'package.json', body: `${JSON.stringify({ name: '@heluo/forge-enterprise', version: '0.1.0', license: 'Apache-2.0' }, null, 2)}\n` },
      {
        path: 'cordis.patch.yml',
        body: [
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
        ].join('\n'),
      },
      { path: 'README.md', body: '# fixture\n' },
    ]),
  );
  const configPath = join(root, 'enterprise.env');
  writeFileSync(configPath, `${ENV.join('\n')}\n`, { mode: 0o600 });
  return makePrivateBundle({
    publicPath,
    expectedSha256: inspectPublicTarball(publicPath).sha256,
    configPath,
    version: '0.2.0',
    output: join(root, 'private'),
  });
}

function makeInputs(root, { platforms = PLATFORMS, webPort = undefined } = {}) {
  const hosts = join(root, 'hosts');
  mkdirSync(hosts, { recursive: true });
  const entries = {};
  for (const [id, form] of Object.entries(platforms)) {
    const body = Buffer.from(`fixture host for ${id}\n`);
    writeFileSync(join(hosts, `${id}.${form.extension}`), body);
    entries[id] = {
      archive: `hosts/${id}.${form.extension}`,
      sha256: sha256(body),
      license: 'Apache-2.0',
      signature: id.startsWith('macos') ? 'notarized' : 'signed',
      web: form.web,
    };
  }
  const path = join(root, 'inputs.json');
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schema: 'heluo-installer-inputs/1',
        host: { version: '0.2.1-rc.3', license: 'Apache-2.0', source: 'https://github.com/deepseek-ai/dsh/releases/tag/v0.2.1-rc.3' },
        ...(webPort === undefined ? {} : { webPort }),
        platforms: entries,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

function assemble(root) {
  const priv = makePrivate(root);
  const inputsPath = makeInputs(root);
  const output = join(root, 'installer');
  const result = assembleFullInstaller({
    inputsPath,
    privatePath: priv.tarball,
    expectedPrivateSha256: priv.sha256,
    output,
  });
  return { ...result, output, priv };
}

test('assembles all six platform directories with loopback-only Web settings', (t) => {
  const root = temp(t);
  const built = assemble(root);
  assert.deepEqual(built.platforms, Object.keys(PLATFORMS).sort());
  assert.equal(built.secretsIncluded, false);
  assert.equal(verifyFullInstaller(built.output).ok, true);
  const manifest = JSON.parse(readFileSync(join(built.output, 'installer-manifest.json'), 'utf8'));
  assert.equal(manifest.secretsIncluded, false);
  assert.equal(manifest.host.version, '0.2.1-rc.3');
  for (const platform of manifest.platforms) {
    const install = JSON.parse(readFileSync(join(built.output, platform.id, 'install.json'), 'utf8'));
    assert.equal(install.schema, 'heluo-installer/1');
    if (install.web) {
      assert.equal(install.listen, '127.0.0.1:58260');
      assert.equal(install.steps.some((step) => step.includes('keep the token out of logs')), true);
    } else {
      assert.equal(install.listen, null);
    }
    assert.equal(install.host.signatureStatus, 'declared');
    assert.equal(install.private.baseVersion, '0.1.0');
    assert.equal(install.private.version, '0.2.0');
  }
});

test('honours an explicit platform subset and custom Web port', (t) => {
  const root = temp(t);
  const priv = makePrivate(root);
  const inputsPath = makeInputs(root, { webPort: 58443 });
  const output = join(root, 'installer');
  const result = assembleFullInstaller({
    inputsPath,
    privatePath: priv.tarball,
    expectedPrivateSha256: priv.sha256,
    output,
    platforms: ['windows-arm64', 'macos-arm64'],
  });
  assert.deepEqual(result.platforms, ['macos-arm64', 'windows-arm64']);
  const web = JSON.parse(readFileSync(join(output, 'windows-arm64', 'install.json'), 'utf8'));
  assert.equal(web.listen, '127.0.0.1:58443');
  assert.equal(existsSync(join(output, 'windows-x64')), false);
  assert.equal(verifyFullInstaller(output).ok, true);
});

test('verifier detects a tampered host archive', (t) => {
  const root = temp(t);
  const built = assemble(root);
  writeFileSync(join(built.output, 'windows-x64', 'host', 'windows-x64.zip'), 'tampered\n');
  const report = verifyFullInstaller(built.output);
  assert.equal(report.ok, false);
  assert.equal(report.problems.some((problem) => problem.includes('digest mismatch')), true);
});

test('verifier detects a tampered private artifact', (t) => {
  const root = temp(t);
  const built = assemble(root);
  const platform = 'windows-x64';
  const [privateName] = readdirSync(join(built.output, platform, 'private'));
  writeFileSync(join(built.output, platform, 'private', privateName), 'tampered\n');
  const report = verifyFullInstaller(built.output);
  assert.equal(report.ok, false);
  assert.equal(report.problems.some((problem) => problem.includes('private/')), true);
});

test('verifier reports a missing per-platform directory', (t) => {
  const root = temp(t);
  const built = assemble(root);
  rmSync(join(built.output, 'linux-x64'), { recursive: true, force: true });
  const report = verifyFullInstaller(built.output);
  assert.equal(report.ok, false);
  assert.equal(report.problems.some((problem) => problem.includes('linux-x64')), true);
});

test('refuses inputs that miss a required platform', (t) => {
  const root = temp(t);
  const priv = makePrivate(root);
  const partial = Object.fromEntries(Object.entries(PLATFORMS).filter(([id]) => id !== 'macos-x64'));
  const inputsPath = makeInputs(root, { platforms: partial });
  expectCode(
    () => assembleFullInstaller({ inputsPath, privatePath: priv.tarball, expectedPrivateSha256: priv.sha256, output: join(root, 'out') }),
    'PLATFORMS_INCOMPLETE',
  );
});

test('refuses a Web target without web=true', (t) => {
  const root = temp(t);
  const priv = makePrivate(root);
  const inputs = readInstallerInputs(makeInputs(root));
  // Patch the fixture inputs on disk to flip the flag; JSON round-trip keeps the
  // digest fields consistent with the archives it already wrote.
  const path = join(root, 'inputs.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(inputs.platforms['linux-x64'].web, true);
  parsed.platforms['linux-x64'].web = false;
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  expectCode(
    () => assembleFullInstaller({ inputsPath: path, privatePath: priv.tarball, expectedPrivateSha256: priv.sha256, output: join(root, 'out') }),
    'PLATFORM_FORM_INVALID',
  );
});

test('refuses an unknown platform and an unsafe archive path', (t) => {
  const root = temp(t);
  const inputsPath = makeInputs(root);
  const parsed = JSON.parse(readFileSync(inputsPath, 'utf8'));
  parsed.platforms['solaris-x64'] = parsed.platforms['linux-x64'];
  writeFileSync(inputsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  expectCode(() => readInstallerInputs(inputsPath), 'INPUTS_INVALID');

  const second = join(root, 'inputs2.json');
  const escaped = JSON.parse(readFileSync(makeInputs(root), 'utf8'));
  escaped.platforms['linux-x64'].archive = '../hosts/linux-x64.tgz';
  writeFileSync(second, `${JSON.stringify(escaped, null, 2)}\n`);
  expectCode(() => readInstallerInputs(second), 'INPUTS_INVALID');
});

test('refuses to write inside the source checkout', (t) => {
  const root = temp(t);
  const priv = makePrivate(root);
  const inputsPath = makeInputs(root);
  expectCode(
    () => assembleFullInstaller({ inputsPath, privatePath: priv.tarball, expectedPrivateSha256: priv.sha256, output: join(root, 'inside'), repoRoot: root }),
    'OUTPUT_INSIDE_REPO',
  );
  assert.equal(existsSync(join(root, 'inside')), false);
});

test('private metadata is redacted and declares no embedded secret', (t) => {
  const root = temp(t);
  const priv = makePrivate(root);
  const release = readPrivateRelease(priv.tarball);
  assert.equal(release.metadata.config.secretEmbedded, false);
  assert.equal(release.metadata.config.keys.some((key) => key.includes('issuer')), true);
  assert.equal(JSON.stringify(release.metadata).includes('corp.example'), false);
});
