import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientSecretFixture } from './support/client-secret-source.mjs';
import { prepareClientAuthentication, assertClientAuthCurrent, buildClientAuthRequest } from '../src/client-auth.mjs';
import { refreshTokens } from '../src/oidc.mjs';

const secret = 'SYNTHETIC_CLIENT_PRIVATE';
function fixed(code) {
  return (error) => {
    assert.equal(error.code, code);
    for (const value of [secret, Buffer.from(secret).toString('base64')]) {
      assert.equal(JSON.stringify(error).includes(value), false);
      assert.equal(String(error.stack).includes(value), false);
    }
    assert.deepEqual(error.details, {});
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
}

test('public preparation never even accesses private source or verifier properties', async () => {
  let reads = 0;
  const options = Object.defineProperties({}, {
    getClientSecretSource: { get() { reads++; throw new Error(secret); } },
    verifyClientSecretSource: { get() { reads++; throw new Error(secret); } },
  });
  const operation = await prepareClientAuthentication({ clientId: 'public-client' }, options);
  assert.deepEqual(operation.pin, { mode: 'public', method: 'none' });
  assert.equal(assertClientAuthCurrent(operation), true);
  assert.equal(reads, 0);
});

test('accepted source gets exactly the frozen three-field binding and original snapshot identity', async () => {
  const f = createClientSecretFixture({});
  const original = f.snapshot();
  let currentCalls = 0;
  const source = {
    read: async (binding) => {
      assert.deepEqual(binding, f.binding); assert.equal(Object.isFrozen(binding), true); return original;
    },
    isCurrent(snapshot) { assert.equal(snapshot === original, true); currentCalls++; return true; },
  };
  const options = { ...f.options, getClientSecretSource: () => source,
    verifyClientSecretSource: (credentials, candidate, scope) => credentials === f.options.credentials
      && candidate === source && Object.isFrozen(scope) && scope.method === f.config.clientAuthMethod };
  const operation = await prepareClientAuthentication(f.config, options);
  assert.equal(currentCalls > 0, true);
  assert.equal(Object.isFrozen(operation.pin), true);
  assert.deepEqual(operation.pin, { mode: 'confidential', method: f.config.clientAuthMethod,
    ...f.binding, revision: original.revision });
  assert.equal(JSON.stringify(operation).includes(secret), false);
  assert.equal(assertClientAuthCurrent(operation), true);
});

for (const failure of ['missing-getter', 'missing-verifier', 'false', 'throw', 'promise-true', 'promise-reject',
  'self-report', 'other-credentials', 'other-source', 'other-issuer', 'other-client', 'other-ref', 'other-method']) {
  test(`untrusted source cannot read a snapshot: ${failure}`, async () => {
    const f = createClientSecretFixture({});
    const options = { ...f.options };
    const config = { ...f.config };
    if (failure === 'missing-getter') delete options.getClientSecretSource;
    else if (failure === 'missing-verifier') delete options.verifyClientSecretSource;
    else if (failure === 'false') options.verifyClientSecretSource = () => false;
    else if (failure === 'throw') options.verifyClientSecretSource = () => { throw new Error(secret); };
    else if (failure === 'promise-true') options.verifyClientSecretSource = () => Promise.resolve(true);
    else if (failure === 'promise-reject') options.verifyClientSecretSource = () => Promise.reject(new Error(secret));
    else if (failure === 'self-report') {
      options.getClientSecretSource = () => ({ trusted: true, keychain: true, atomic: true, read: f.source.read, isCurrent: f.source.isCurrent });
      delete options.verifyClientSecretSource;
    } else if (failure === 'other-credentials') options.credentials = {};
    else if (failure === 'other-source') options.getClientSecretSource = () => ({ ...f.source });
    else if (failure === 'other-issuer') options.issuer = 'https://other.corp.example';
    else if (failure === 'other-client') config.clientId = 'other-client';
    else if (failure === 'other-ref') config.clientSecretRef = 'other-ref';
    else config.clientAuthMethod = 'client_secret_post';
    await assert.rejects(prepareClientAuthentication(config, options), fixed('IAM_CLIENT_AUTH_UNVERIFIED'));
    assert.equal(f.counts.read, 0);
  });
}

for (const failure of ['missing', 'throw', 'wrong-binding', 'empty-value', 'empty-revision', 'array', 'async-current', 'throw-current']) {
  test(`snapshot/current contract fails closed without private details: ${failure}`, async () => {
    const f = createClientSecretFixture({});
    let original = { ...f.snapshot() };
    if (failure === 'missing') original = undefined;
    else if (failure === 'wrong-binding') original.clientId = 'wrong';
    else if (failure === 'empty-value') original.value = '';
    else if (failure === 'empty-revision') original.revision = '';
    else if (failure === 'array') original = [];
    const source = {
      async read() { if (failure === 'throw') throw new Error(secret); return original; },
      isCurrent() {
        if (failure === 'async-current') return Promise.reject(new Error(secret));
        if (failure === 'throw-current') throw new Error(secret);
        return true;
      },
    };
    const options = { ...f.options, getClientSecretSource: () => source, verifyClientSecretSource: () => true };
    await assert.rejects(prepareClientAuthentication(f.config, options), fixed(
      failure.endsWith('current') ? 'IAM_CLIENT_AUTH_CHANGED' : 'IAM_CLIENT_AUTH_UNVERIFIED'));
  });
}

for (const field of ['issuer', 'clientId', 'ref', 'revision', 'value']) {
  test(`mutating original snapshot ${field} cannot change the private request or pin`, async () => {
    const f = createClientSecretFixture({});
    const raw = { ...f.snapshot() };
    const source = { read: async () => raw, isCurrent: (snapshot) => snapshot === raw };
    const operation = await prepareClientAuthentication(f.config, { ...f.options,
      getClientSecretSource: () => source, verifyClientSecretSource: () => true });
    const pinBefore = JSON.stringify(operation.pin);
    const requestBefore = buildClientAuthRequest('synthetic-client', new URLSearchParams({ grant_type: 'refresh_token' }), operation);
    raw[field] += '-changed';
    assert.throws(() => assertClientAuthCurrent(operation), fixed('IAM_CLIENT_AUTH_CHANGED'));
    assert.equal(JSON.stringify(operation.pin), pinBefore);
    const requestAfter = buildClientAuthRequest('synthetic-client', new URLSearchParams({ grant_type: 'refresh_token' }), operation);
    assert.deepEqual(requestAfter, requestBefore);
  });
}

for (const change of ['rotation', 'removal', 'source', 'credentials', 'credential-getter', 'verifier']) {
  test(`a previously prepared operation is invalid after ${change}`, async () => {
    const f = createClientSecretFixture({});
    const options = { ...f.options };
    let currentCredentials = options.credentials;
    options.getCredentials = () => currentCredentials;
    const operation = await prepareClientAuthentication(f.config, options);
    if (change === 'rotation') f.replace('SYNTHETIC_NEW_PRIVATE');
    else if (change === 'removal') f.remove();
    else if (change === 'source') options.getClientSecretSource = () => ({ ...f.source });
    else if (change === 'credentials') options.credentials = {};
    else if (change === 'credential-getter') currentCredentials = {};
    else options.verifyClientSecretSource = () => false;
    assert.throws(() => assertClientAuthCurrent(operation), fixed('IAM_CLIENT_AUTH_CHANGED'));
  });
}

test('replacement during the real asynchronous source read invalidates its late result', async () => {
  const f = createClientSecretFixture({});
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let current;
  const source = { async read() { entered.resolve(); await gate.promise; return f.snapshot(); }, isCurrent: () => true };
  current = source;
  const pending = prepareClientAuthentication(f.config, { ...f.options, getClientSecretSource: () => current,
    verifyClientSecretSource: () => true });
  await entered.promise;
  current = { ...source };
  gate.resolve();
  await assert.rejects(pending, fixed('IAM_CLIENT_AUTH_CHANGED'));
});

for (const kind of ['source', 'credentials']) {
  for (const phase of ['initial', 'after-read', 'after-current', 'dispatch']) {
    for (const result of ['resolve', 'reject']) {
      test(`invalid async ${kind} getter ${phase} ${result} is consumed without authorizing a read or POST`, async (t) => {
        const f = createClientSecretFixture({});
        let changed = phase === 'initial';
        let reads = 0; let requests = 0; let unhandled = 0;
        const onUnhandled = () => { unhandled++; };
        process.on('unhandledRejection', onUnhandled);
        t.after(() => process.off('unhandledRejection', onUnhandled));
        const source = { async read() { reads++; if (phase === 'after-read') changed = true; return f.snapshot(); },
          isCurrent(snapshot) { if (phase === 'after-current') changed = true; return snapshot === f.snapshot(); } };
        const invalid = (value) => changed
          ? result === 'resolve' ? Promise.resolve(value) : Promise.reject(new Error(secret)) : value;
        const options = { ...f.options,
          getClientSecretSource: () => kind === 'source' ? invalid(source) : source,
          getCredentials: () => kind === 'credentials' ? invalid(f.options.credentials) : f.options.credentials,
          verifyClientSecretSource: () => true };
        if (phase === 'dispatch') {
          const operation = await prepareClientAuthentication(f.config, options);
          changed = true;
          await assert.rejects(refreshTokens({ tokenEndpoint: 'https://iam.corp.example/token', refreshToken: 'synthetic-refresh',
            clientId: f.config.clientId, clientAuthentication: operation,
            fetchImpl: async () => { requests++; } }), fixed('IAM_CLIENT_AUTH_CHANGED'));
        } else {
          await assert.rejects(prepareClientAuthentication(f.config, options),
            fixed(phase === 'initial' ? 'IAM_CLIENT_AUTH_UNVERIFIED' : 'IAM_CLIENT_AUTH_CHANGED'));
        }
        await new Promise(setImmediate);
        assert.equal(reads, phase === 'initial' ? 0 : 1);
        assert.equal(requests, 0);
        assert.equal(unhandled, 0);
      });
    }
  }
}

test('a previous non-secret pin cannot be used after a source revision changes', async () => {
  const f = createClientSecretFixture({});
  const first = await prepareClientAuthentication(f.config, f.options);
  f.replace(secret);
  await assert.rejects(prepareClientAuthentication(f.config, { ...f.options, expectedPin: first.pin }),
    fixed('IAM_CLIENT_AUTH_CONTEXT_INVALID'));
});
