import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const config = {
  issuer: 'https://iam.example',
  authorizationEndpoint: 'https://iam.example/authorize',
  tokenEndpoint: 'https://iam.example/token',
  jwksUri: 'https://iam.example/jwks',
  clientId: 'test',
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

function fakeCredentials() {
  const credentials = new MemoryCredentials();
  credentials.crossProcessLock = true;
  credentials.durable = true;
  credentials.kind = 'keychain';
  credentials.transaction = async (fn) => fn();
  return credentials;
}

// Minimal host: only the services this plugin reads, plus provide/effect.
function makeCtx(services) {
  const provided = { ...services };
  const ctx = {
    // Cordis throws when a *mounted* service is read without injecting it, and
    // returns undefined for a service nobody provides.
    get: (name) => {
      if (name in provided) throw new Error(`cannot get property "${name}" without inject`);
      return undefined;
    },
    provide: (name, value) => { provided[name] = value; return () => { delete provided[name]; }; },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
    inject: (names, fn) => {
      if (!names.every((name) => provided[name] !== undefined)) return () => {};
      const off = fn({ ...provided });
      return () => { if (typeof off === 'function') off(); };
    },
  };
  return { ctx, provided };
}

test('a trust service bound to the exact instance lets sign-in past the gate', async () => {
  const credentials = fakeCredentials();
  const adapter = Object.freeze({ snapshot: async () => ({ record: undefined, value: undefined }), compareAndSwap: async () => ({ ok: false }) });
  const trust = Object.freeze({ verify: (candidate) => candidate === credentials, adapter: () => adapter });
  const webServer = { getOrigin: () => 'http://127.0.0.1:4567', register: () => () => {} };
  const { ctx, provided } = makeCtx({ credentials, 'iam-atomic-store': trust, webServer });

  apply(ctx, config);
  const result = await provided.iam.startSignIn();
  assert.ok(String(result?.authorizationUrl ?? '').startsWith('https://iam.example/authorize'));
});

test('a trust service bound to another instance still fails closed', async () => {
  const credentials = fakeCredentials();
  const other = fakeCredentials();
  const trust = Object.freeze({ verify: (candidate) => candidate === other, adapter: () => ({}) });
  const { ctx, provided } = makeCtx({ credentials, 'iam-atomic-store': trust });

  apply(ctx, config);
  await assert.rejects(provided.iam.startSignIn(), { code: 'IAM_ATOMIC_STORE_UNVERIFIED' });
});

test('without the trust service the gate stays closed', async () => {
  const { ctx, provided } = makeCtx({ credentials: fakeCredentials() });
  apply(ctx, config);
  await assert.rejects(provided.iam.startSignIn(), { code: 'IAM_ATOMIC_STORE_UNVERIFIED' });
});
