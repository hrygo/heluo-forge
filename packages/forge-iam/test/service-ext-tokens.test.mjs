import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeychainProvider, createMemoryBackend } from '@heluo/forge-credentials-keychain';
import { createCredentialRegistry } from '../src/credential-registry.mjs';
import { ExtTokenStoreError, createExtTokenStore } from '../src/ext-token-store.mjs';
import { createExtTokensService } from '../src/service-ext-tokens.mjs';

test('signed-out resolution rejects before reading credential storage', async () => {
  const registry = createCredentialRegistry();
  registry.registerExtensionCredential({
    extensionId: 'alpha-tool', storageRef: 'HEL_EXT_ALPHA_TOKEN',
    envKey: 'ALPHA_API_TOKEN', allowlistedEnvNames: ['ALPHA_API_TOKEN'],
  });
  let reads = 0;
  const svc = createExtTokensService({
    registry, getCurrentSubject: () => null,
    store: { async read() { reads += 1; return { state: 'IAM_NOT_SIGNED_IN' }; } },
  });
  await assert.rejects(() => svc.resolveChildEnv({ extensionId: 'alpha-tool' }),
    (error) => error.code === 'IAM_NOT_SIGNED_IN');
  assert.equal(reads, 0);
});

test('service-ext-tokens projects sanitized states, enforces allowlist, and blocks OWNER_MISMATCH', async () => {
  const registry = createCredentialRegistry();
  registry.registerExtensionCredential({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    envKey: 'ALPHA_API_TOKEN',
    allowlistedEnvNames: ['ALPHA_API_TOKEN', 'ALPHA_HOST'],
    detectRiskAndExternal: ({ processEnv }) => ({
      envHitNames: processEnv.ALPHA_API_TOKEN ? ['ALPHA_API_TOKEN'] : [],
      plaintextRisk: Boolean(processEnv.SIMULATED_PLAINTEXT_RISK),
      riskDetails: processEnv.SIMULATED_PLAINTEXT_RISK ? { reason: 'plaintext-file' } : null,
    }),
  });

  let subject = 'emp-001';
  let processEnv = {
    ALPHA_API_TOKEN: 'env-alpha-token',
    ALPHA_HOST: 'https://alpha.corp.example',
    DEEPSEEK_API_KEY: 'must-never-leak',
  };
  const store = createExtTokenStore(createKeychainProvider(createMemoryBackend()));
  const svc = createExtTokensService({
    registry,
    store,
    getCurrentSubject: () => subject,
    getProcessEnv: () => processEnv,
  });

  // Unhosted with allowlisted env hit -> ENV_INHERITED; unrelated secret stripped.
  const initialStatuses = await svc.listProjectedStatuses();
  assert.equal(initialStatuses.length, 1);
  assert.equal(initialStatuses[0].state, 'ENV_INHERITED');
  assert.deepEqual(initialStatuses[0].envHitNames, ['ALPHA_API_TOKEN']);
  assert.equal(JSON.stringify(initialStatuses).includes('env-alpha-token'), false);

  const inheritedEnv = await svc.resolveChildEnv({ extensionId: 'alpha-tool' });
  assert.equal(inheritedEnv.state, 'ENV_INHERITED');
  assert.deepEqual(inheritedEnv.env, {
    ALPHA_API_TOKEN: 'env-alpha-token',
    ALPHA_HOST: 'https://alpha.corp.example',
  });
  assert.equal('DEEPSEEK_API_KEY' in inheritedEnv.env, false);

  // Explicit save overrides env at child-process boundary, never leaks in projections.
  const saved = await svc.saveToken({ extensionId: 'alpha-tool', token: 'hosted-alpha-999' });
  assert.equal(saved.state, 'HOSTED_ACTIVE');
  assert.equal(saved.hosted, true);
  assert.equal(JSON.stringify(saved).includes('hosted-alpha-999'), false);

  const hostedEnv = await svc.resolveChildEnv({ extensionId: 'alpha-tool' });
  assert.equal(hostedEnv.state, 'HOSTED_ACTIVE');
  assert.equal(hostedEnv.env.ALPHA_API_TOKEN, 'hosted-alpha-999');
  assert.equal(hostedEnv.env.ALPHA_HOST, 'https://alpha.corp.example');
  assert.equal('DEEPSEEK_API_KEY' in hostedEnv.env, false);

  // Switching employee subject triggers OWNER_MISMATCH and refuses child execution.
  subject = 'emp-002';
  processEnv = { ...processEnv, SIMULATED_PLAINTEXT_RISK: '1' };
  const mismatchStatuses = await svc.listProjectedStatuses();
  assert.equal(mismatchStatuses[0].state, 'OWNER_MISMATCH');
  assert.equal(mismatchStatuses[0].ownerMismatch, true);
  assert.equal(mismatchStatuses[0].plaintextRisk, true);
  assert.equal(JSON.stringify(mismatchStatuses).includes('hosted-alpha-999'), false);

  await assert.rejects(
    () => svc.resolveChildEnv({ extensionId: 'alpha-tool' }),
    (err) => err instanceof ExtTokenStoreError && err.code === 'OWNER_MISMATCH',
  );

  // Signed out is distinct from a different owner: still fail closed, but the
  // user copy is "sign in again", not "another employee's credentials remain".
  subject = null;
  const signedOutStatuses = await svc.listProjectedStatuses();
  assert.equal(signedOutStatuses[0].state, 'IAM_NOT_SIGNED_IN');
  assert.equal(signedOutStatuses[0].signedOut, true);
  assert.equal(signedOutStatuses[0].ownerMismatch, false);
  await assert.rejects(
    () => svc.resolveChildEnv({ extensionId: 'alpha-tool' }),
    (err) => err instanceof ExtTokenStoreError && err.code === 'IAM_NOT_SIGNED_IN',
  );

  subject = 'emp-002';
  // Clearing mismatched token restores ENV_INHERITED cleanly.
  const cleared = await svc.clearToken({ extensionId: 'alpha-tool' });
  assert.equal(cleared.state, 'ENV_INHERITED');

  // Signed out save is rejected cleanly.
  subject = null;
  await assert.rejects(
    () => svc.saveToken({ extensionId: 'alpha-tool', token: 'x' }),
    (err) => err instanceof ExtTokenStoreError && err.code === 'IAM_NOT_SIGNED_IN',
  );
});

test('a sign-out while the token read is pending never releases the hosted token', async () => {
  const registry = createCredentialRegistry();
  registry.registerExtensionCredential({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    envKey: 'ALPHA_API_TOKEN',
    allowlistedEnvNames: ['ALPHA_API_TOKEN'],
  });

  const backend = createMemoryBackend();
  const credentials = createKeychainProvider(backend);
  const session = { subject: 'emp-001', epoch: 'session-1' };
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let gated = false;
  const delayed = {
    ...credentials,
    pin: typeof credentials.pin === 'function' ? credentials.pin.bind(credentials) : undefined,
    async readRecord(key) {
      // 只拦解析路径：保存本身也要读（状态投影），拦早了会死锁。
      if (gated) await gate;
      return credentials.readRecord(key);
    },
  };
  const store = createExtTokenStore(delayed);
  const svc = createExtTokensService({
    registry,
    store,
    getCurrentSubject: () => session.subject,
    getSessionRef: () => (session.subject ? { subject: session.subject, epoch: session.epoch } : null),
    getProcessEnv: () => ({}),
  });

  await svc.saveToken({ extensionId: 'alpha-tool', token: 'hosted-alpha-777' });
  gated = true;

  const pending = svc.resolveChildEnv({ extensionId: 'alpha-tool' });
  // 读存储期间用户登出：epoch 与 subject 同时失效。
  session.subject = null;
  session.epoch = 'session-2';
  releaseRead();
  await assert.rejects(pending, (error) => error instanceof ExtTokenStoreError && error.code === 'IAM_NOT_SIGNED_IN');
});

test('a switched account mid-read is treated as signed out instead of returning the old token', async () => {
  const registry = createCredentialRegistry();
  registry.registerExtensionCredential({
    extensionId: 'alpha-tool',
    storageRef: 'HEL_EXT_ALPHA_TOKEN',
    envKey: 'ALPHA_API_TOKEN',
    allowlistedEnvNames: ['ALPHA_API_TOKEN'],
  });
  const credentials = createKeychainProvider(createMemoryBackend());
  const session = { subject: 'emp-001', epoch: 'session-1' };
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let gated = false;
  const delayed = {
    ...credentials,
    async readRecord(key) {
      if (gated) await gate;
      return credentials.readRecord(key);
    },
  };
  const store = createExtTokenStore(delayed);
  const svc = createExtTokensService({
    registry,
    store,
    getCurrentSubject: () => session.subject,
    getSessionRef: () => (session.subject ? { subject: session.subject, epoch: session.epoch } : null),
    getProcessEnv: () => ({}),
  });
  await svc.saveToken({ extensionId: 'alpha-tool', token: 'hosted-alpha-888' });
  gated = true;

  const pending = svc.resolveChildEnv({ extensionId: 'alpha-tool' });
  session.subject = 'emp-002';
  session.epoch = 'session-9';
  releaseRead();
  await assert.rejects(pending, (error) => error instanceof ExtTokenStoreError && error.code === 'IAM_NOT_SIGNED_IN');
});
