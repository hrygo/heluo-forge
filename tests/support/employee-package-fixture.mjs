/**
 * Fixture helpers of the unified employee build.
 *
 * Shared by the build's own tests and by the contract test that feeds what the
 * build produces to the desktop shell, so both judge the same employee package.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeBundleTarball } from '../../scripts/lib/bundle-write.mjs';

export const TOOL_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Every value is unique and unlike anything a manifest or a note could hold
// for its own reasons, so "the value is absent" is a real statement.
export const VALUES = Object.freeze({
  HELUO_IAM_AUTH_MODE: 'confidential',
  HELUO_IAM_DISCOVERY_URL: 'https://idp-7f3a.corp.example/.well-known/openid-configuration',
  HELUO_IAM_REVOCATION_ENDPOINT: 'https://idp-7f3a.corp.example/oauth/revoke-9c1d',
  HELUO_IAM_CLIENT_ID: 'client-5b2e-8d7f',
  HELUO_IAM_SCOPES: 'openid profile-4a6c',
  HELUO_IAM_CALLBACK_PORT: '17321',
  HELUO_IAM_CALLBACK_ADDRESS: '127.0.0.1',
  HELUO_IAM_MANAGED_MODELS_BASE_URL: 'https://gw-3e9b.corp.example/v1',
  HELUO_IAM_DEFAULT_PROVIDER: 'route-6f1d-2a8c',
  HELUO_IAM_ALLOW_INSECURE_HTTP: 'true',
  HELUO_IAM_CLIENT_AUTH_METHOD: 'client_secret_post',
  HELUO_IAM_CLIENT_SECRET_REF: 'desktop-ref-4d7a',
  HELUO_IAM_CLIENT_SECRET: 'synthetic-client-secret-9e2f-7b4c',
  HELUO_NACOS_SERVER_URL: 'http://nacos-7f3a.corp.example/nacos',
  HELUO_NACOS_NAMESPACE_ID: 'skills-7f3a',
  HELUO_NACOS_USERNAME: 'svc-ci',
  HELUO_NACOS_PASSWORD: 'synthetic-nacos-password-7f3a',
  HELUO_NACOS_TIMEOUT_MS: '20000',
});

// Free-form values: the ones whose presence elsewhere would be a disclosure.
export const FREE_FORM = Object.freeze(
  [
    'HELUO_IAM_DISCOVERY_URL',
    'HELUO_IAM_REVOCATION_ENDPOINT',
    'HELUO_IAM_CLIENT_ID',
    'HELUO_IAM_SCOPES',
    'HELUO_IAM_MANAGED_MODELS_BASE_URL',
    'HELUO_IAM_DEFAULT_PROVIDER',
    'HELUO_IAM_CLIENT_SECRET_REF',
    'HELUO_IAM_CLIENT_SECRET',
    'HELUO_NACOS_SERVER_URL',
    'HELUO_NACOS_NAMESPACE_ID',
    'HELUO_NACOS_USERNAME',
    'HELUO_NACOS_PASSWORD',
  ].map((key) => VALUES[key]),
);

export function temp(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A committed Git checkout with a pinned host version: what a tag is built from. */
export function sourceRepo(t) {
  const root = temp(t, 'forge-employee-source-');
  writeFileSync(join(root, '.dsh-version'), readFileSync(join(TOOL_ROOT, '.dsh-version')));
  writeFileSync(join(root, 'README.md'), '# Source fixture\n');
  const git = (...args) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=Forge Test', '-c', 'user.email=forge-test', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--quiet', '--template=');
  git('-c', 'core.autocrlf=false', 'add', '--all');
  git('commit', '--quiet', '--no-gpg-sign', '-m', 'fixture');
  return { root, commit: git('rev-parse', 'HEAD') };
}

function neutralPatch({ skills = true } = {}) {
  return [
    '# fixture composition',
    '- insert:',
    '    - id: heluo-iam',
    "      name: '@heluo/forge-iam'",
    '    - id: heluo-gitee',
    "      name: '@heluo/forge-gitee'",
    '      config: {}',
    ...(skills ? [
      '    - id: heluo-skills-manager',
      "      name: '@heluo/forge-skills-manager'",
      '      config: {}',
    ] : []),
    '',
  ].join('\n');
}

/** The tarball a real public build produces for `name`: neutral, verifier-matched, closable. */
export function publicTarball(name = '@heluo/forge-enterprise') {
  const manifest = { name, version: '0.1.0', license: 'Apache-2.0', dsh: { bundle: { patch: './cordis.patch.yml' } } };
  return writeBundleTarball([
    { path: 'package.json', body: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'cordis.patch.yml', body: neutralPatch({ skills: name === '@heluo/forge-enterprise' }) },
    { path: 'README.md', body: '# fixture\n' },
    ...(name === '@heluo/forge-enterprise' ? [{
      path: 'node_modules/@heluo/forge-skills-manager/lib/nacos.js',
      body: readFileSync(join(TOOL_ROOT, 'packages/forge-skills-manager/lib/nacos.js')),
    }] : []),
    ...['config.mjs', 'model-options.mjs', 'http-url.mjs', 'errors.mjs'].map((module) => ({
      path: `node_modules/@heluo/forge-iam/src/${module}`,
      body: readFileSync(join(TOOL_ROOT, 'packages/forge-iam/src', module)),
    })),
  ]);
}

/** Stands in for `buildPublicRelease`: same output shape, no packing work. */
export function fakePublicBuilder({ commit, calls = [], tag }) {
  return (input) => {
    calls.push(input);
    const name = input.entry ?? '@heluo/forge-enterprise';
    const bytes = publicTarball(name);
    const tarballName = `heluo-${name.slice('@heluo/'.length)}-0.1.0.tgz`;
    mkdirSync(input.output, { recursive: true });
    const tarball = join(input.output, tarballName);
    const manifest = join(input.output, 'release-manifest.json');
    writeFileSync(tarball, bytes);
    writeFileSync(join(input.output, 'bundle-manifest.json'), `${JSON.stringify({ entry: { name, version: '0.1.0' }, tarball: tarballName }, null, 2)}\n`);
    writeFileSync(
      manifest,
      `${JSON.stringify({
        tag: tag ?? input.tag,
        commit,
        entry: { name, version: '0.1.0' },
        artifact: { name: tarballName, sha256: sha256Of(bytes), bytes: bytes.length },
      }, null, 2)}\n`,
    );
    return { output: input.output, tarball, sha256: sha256Of(bytes), version: '0.1.0', manifest };
  };
}
