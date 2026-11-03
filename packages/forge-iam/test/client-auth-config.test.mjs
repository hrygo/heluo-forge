import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, validateConfig } from '../src/config.mjs';
import { createIamService } from '../src/service.mjs';
import { apply } from '../src/index.mjs';
import { createClientSecretFixture } from './support/client-secret-source.mjs';

const configured = {
  issuer: 'https://iam.corp.example', clientId: 'synthetic-client',
  authorizationEndpoint: 'https://iam.corp.example/authorize', tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks', redirectUri: 'http://127.0.0.1:9/iam/callback',
};
const confidential = { ...configured, authMode: 'confidential', clientAuthMethod: 'client_secret_basic', clientSecretRef: 'fixture-client' };

for (const input of [{}, { authMode: 'public' }, { authMode: 'public', clientAuthMethod: 'none' }]) {
  test(`public normalization is explicit, secret-ref-free and repeatable: ${JSON.stringify(input)}`, () => {
    const first = validateConfig(input);
    assert.equal(first.issues, undefined);
    assert.equal(first.value.authMode, 'public');
    assert.equal(first.value.clientAuthMethod, 'none');
    assert.equal(Object.hasOwn(first.value, 'clientSecretRef'), false);
    assert.deepEqual(validateConfig(first.value), first);
    assert.equal(Config['~standard'].validate(input) instanceof Promise, false);
  });
}
for (const method of ['client_secret_basic', 'client_secret_post']) {
  test(`confidential ${method} requires and retains only the explicit tagged configuration`, () => {
    const first = validateConfig({ ...confidential, clientAuthMethod: method });
    assert.equal(first.issues, undefined);
    assert.equal(first.value.clientAuthMethod, method);
    assert.equal(first.value.clientSecretRef, 'fixture-client');
    assert.deepEqual(validateConfig(first.value), first);
  });
}
for (const [name, input] of [
  ['public undefined ref', { clientSecretRef: undefined }], ['public null ref', { clientSecretRef: null }],
  ['public empty ref', { clientSecretRef: '' }], ['public nonempty ref', { clientSecretRef: 'fixture-client' }],
  ['secret method without mode', { clientAuthMethod: 'client_secret_basic' }],
  ['confidential missing method', { authMode: 'confidential', clientSecretRef: 'fixture-client' }],
  ['confidential missing ref', { authMode: 'confidential', clientAuthMethod: 'client_secret_basic' }],
  ['confidential empty ref', { ...confidential, clientSecretRef: '' }],
  ['confidential null ref', { ...confidential, clientSecretRef: null }],
  ['confidential none', { ...confidential, clientAuthMethod: 'none' }],
  ['unknown mode', { authMode: 'pkce' }], ['other mode', { authMode: 'aigs' }],
  ['null mode', { authMode: null }], ['unknown method', { clientAuthMethod: 'automatic' }],
  ['raw camel secret', { clientSecret: 'SYNTHETIC_CONFIG_PRIVATE' }],
  ['raw wire secret', { client_secret: 'SYNTHETIC_CONFIG_PRIVATE' }],
  ['Authorization', { Authorization: 'Basic SYNTHETIC_CONFIG_PRIVATE' }],
  ['authorization', { authorization: 'Basic SYNTHETIC_CONFIG_PRIVATE' }],
  ['header override', { headers: { authorization: 'Basic SYNTHETIC_CONFIG_PRIVATE' } }],
  ['body override', { body: { client_secret: 'SYNTHETIC_CONFIG_PRIVATE' } }],
  ['PKCE disabled', { pkce: false }], ['PKCE plain', { pkceMethod: 'plain' }],
  ['challenge plain', { codeChallengeMethod: 'plain' }], ['explicit disable', { disablePkce: true }],
]) {
  test(`invalid authentication configuration cannot silently become public: ${name}`, () => {
    const result = validateConfig(input);
    assert.equal(Array.isArray(result.issues), true);
    assert.equal(result.value, undefined);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_CONFIG_PRIVATE'), false);
  });
}

test('throwing private composition properties fail fixed before any secret read or POST', () => {
  const touched = { getters: 0, reads: 0, fetch: 0 };
  const credentials = { resolve() { touched.reads++; }, readRecord() { touched.reads++; } };
  const options = {
    credentials, fetch() { touched.fetch++; throw new Error('must not send'); },
    get getClientSecretSource() { touched.getters++; throw new Error('must not inspect'); },
    get verifyClientSecretSource() { touched.getters++; throw new Error('must not inspect'); },
    verifyAtomicStore: () => true, allowConfidential: true,
  };
  assert.throws(() => createIamService(confidential, options), { code: 'IAM_CLIENT_AUTH_UNVERIFIED' });
  assert.deepEqual(touched, { getters: 1, reads: 0, fetch: 0 });
});

test('trusted confidential composition constructs without reading a secret before an operation', async (t) => {
  const f = createClientSecretFixture({});
  let getters = 0; let requests = 0;
  const options = { ...f.options, verifyAtomicStore: () => true,
    getClientSecretSource: () => { getters++; return f.source; }, fetch: async () => { requests++; } };
  const service = createIamService(confidential, options); t.after(() => service.dispose());
  assert.equal(getters, 0);
  assert.equal(f.counts.read, 0);
  assert.equal(f.counts.verify, 0);
  assert.equal(requests, 0);
});

test('real apply without private composition cannot discover or use a hidden confidential source', () => {
  const touched = { reads: 0, secretGets: 0, effects: 0 };
  const credentials = { resolve() { touched.reads++; }, readRecord() { touched.reads++; } };
  const ctx = {
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'clientSecretSource') { touched.secretGets++; throw new Error('hidden source'); }
      return undefined;
    },
    provide() { touched.effects++; }, effect() { touched.effects++; },
  };
  assert.throws(() => apply(ctx, confidential), { code: 'IAM_CLIENT_AUTH_UNVERIFIED' });
  assert.deepEqual(touched, { reads: 0, secretGets: 0, effects: 0 });
});
