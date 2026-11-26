import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveEmployeeConfig } from '../scripts/build-employee-package.mjs';
import { readBundleEntries } from '../scripts/lib/bundle-archive.mjs';
import { buildPrivateTarball } from '../scripts/lib/private-bundle.mjs';
import { NACOS_ENV_MAP } from '../scripts/lib/nacos-release.mjs';
import { isReleaseSecret } from '../scripts/lib/release-config.mjs';
import { parsePackageConfig } from '../packages/forge-skills-manager/scripts/package.mjs';
import { publicTarball, sha256Of, VALUES } from './support/employee-package-fixture.mjs';

test('employee configuration with retained Nacos environment values builds the current enterprise patch', () => {
  const bytes = publicTarball();
  const entries = readBundleEntries(bytes, { withContent: true })
    .filter(entry => !entry.path.includes('/forge-skills-manager/'))
    .map(entry => entry.path === 'cordis.patch.yml'
      ? { ...entry, content: readFileSync(new URL('../packages/forge-enterprise/cordis.patch.yml', import.meta.url)) }
      : entry);
  const config = resolveEmployeeConfig({ env: VALUES });
  const built = buildPrivateTarball({ entries, config, version: '0.1.0-corp.test', baseSha256: sha256Of(bytes) });
  assert.deepEqual(config.nacos, {});
  assert.equal(config.iam.clientId, VALUES.HELUO_IAM_CLIENT_ID);
  assert.equal(built.metadata.config.clientSecretEmbedded, true);
  assert.deepEqual(built.metadata.config.embeddedSecrets, []);
  assert.equal(built.metadata.config.keys.some(key => key.startsWith('nacos.')), false);
  assert.equal(built.patch.includes('heluo-skills-manager'), false);
  for (const key of Object.keys(NACOS_ENV_MAP)) assert.equal(built.patch.includes(VALUES[key]), false);
});

test('employee environment ignores unrelated Nacos fields even when incomplete or malformed', () => {
  const clean = Object.fromEntries(Object.entries(VALUES).filter(([key]) => !Object.hasOwn(NACOS_ENV_MAP, key)));
  const expected = resolveEmployeeConfig({ env: clean });
  for (const key of Object.keys(NACOS_ENV_MAP)) {
    assert.deepEqual(resolveEmployeeConfig({ env: { ...clean, [key]: 'synthetic\nmalformed=$(value)' } }), expected);
  }
});

test('employee release workflow and its secret allowlist exclude every Nacos field', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-bundle.yml', import.meta.url), 'utf8');
  for (const key of Object.keys(NACOS_ENV_MAP)) {
    assert.equal(isReleaseSecret(key), false, key);
    assert.equal(workflow.includes(key), false, key);
  }
  assert.equal(isReleaseSecret('HELUO_IAM_CLIENT_SECRET'), true);
  assert.equal(isReleaseSecret('GITHUB_TOKEN'), true);
});

test('standalone Skill Manager still requires and preserves its Nacos preset', () => {
  const entries = Object.keys(NACOS_ENV_MAP).map(key => [key, VALUES[key]]);
  const render = items => items.map(([key, value]) => `${key}="${value}"`).join('\n');
  const config = parsePackageConfig(render(entries));
  assert.equal(config.nacos.password, VALUES.HELUO_NACOS_PASSWORD);
  for (const key of Object.keys(NACOS_ENV_MAP).filter(key => key !== 'HELUO_NACOS_TIMEOUT_MS')) {
    assert.throws(() => parsePackageConfig(render(entries.filter(([name]) => name !== key))), { code: 'CONFIG_INVALID' });
  }
});
