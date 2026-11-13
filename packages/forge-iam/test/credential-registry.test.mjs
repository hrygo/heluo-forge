import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CredentialRegistryError, createCredentialRegistry } from '../src/credential-registry.mjs';

test('credential registry validates descriptors, enforces uniqueness, and unregisters cleanly', () => {
  const registry = createCredentialRegistry();

  const disposeBeta = registry.registerExtensionCredential({
    extensionId: 'beta-tool',
    storageRef: 'HEL_EXT_BETA_TOKEN',
    envKey: 'BETA_API_TOKEN',
    allowlistedEnvNames: ['BETA_API_TOKEN', 'BETA_ALT_TOKEN'],
  });
  const disposeAlpha = registry.registerExtensionCredential({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    envKey: 'ALPHA_API_TOKEN',
  });

  const listed = registry.list();
  assert.deepEqual(listed.map((d) => d.extensionId), ['alpha-tool', 'beta-tool']);
  assert.deepEqual(registry.get('alpha-tool').allowlistedEnvNames, ['ALPHA_API_TOKEN']);
  assert.deepEqual(registry.get('beta-tool').allowlistedEnvNames, ['BETA_API_TOKEN', 'BETA_ALT_TOKEN']);

  assert.throws(
    () => registry.registerExtensionCredential({
      extensionId: 'alpha-tool',
      storageRef: 'HEL_EXT_OTHER',
      envKey: 'OTHER_TOKEN',
    }),
    (err) => err instanceof CredentialRegistryError && err.code === 'IAM_EXT_CREDENTIAL_DUPLICATE',
  );

  assert.throws(
    () => registry.registerExtensionCredential({
      extensionId: 'gamma-tool',
      storageRef: 'HEL_EXT_ALPHA_TOKEN',
      envKey: 'GAMMA_TOKEN',
    }),
    (err) => err instanceof CredentialRegistryError && err.code === 'IAM_EXT_CREDENTIAL_CONFLICT',
  );

  for (const reserved of ['ENTERPRISE_STATIC_KEY', 'ENTERPRISE_ACCESS_TOKEN']) {
    assert.throws(
      () => registry.registerExtensionCredential({
        extensionId: 'gamma-tool',
        storageRef: reserved,
        envKey: 'GAMMA_TOKEN',
      }),
      (err) => err instanceof CredentialRegistryError && err.code === 'IAM_EXT_CREDENTIAL_CONFLICT',
    );
  }

  for (const badId of ['', 'Upper', 'bad/slash', 'bad_underscore']) {
    assert.throws(
      () => registry.registerExtensionCredential({
        extensionId: badId,
        storageRef: 'HEL_EXT_VALID',
        envKey: 'VALID_KEY',
      }),
      (err) => err instanceof CredentialRegistryError && err.code === 'IAM_EXT_CREDENTIAL_INVALID',
    );
  }

  disposeAlpha();
  assert.equal(registry.get('alpha-tool'), null);
  assert.deepEqual(registry.list().map((d) => d.extensionId), ['beta-tool']);
  disposeBeta();
  assert.deepEqual(registry.list(), []);
});

test('domain-agnostic broker modules contain zero hardcoded R&D business names', () => {
  const forbidden = /\b(devops|gitee|dop|gh|DEVOPS_API_KEY|GITEE_TOKEN)\b/i;
  for (const rel of [
    '../src/credential-registry.mjs',
    '../src/ext-token-store.mjs',
    '../src/service-ext-tokens.mjs',
  ]) {
    const content = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.equal(forbidden.test(content), false, `${rel} must remain domain-agnostic`);
  }
});
