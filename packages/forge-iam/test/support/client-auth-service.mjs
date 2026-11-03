import assert from 'node:assert/strict';
import { createIamService } from '../../src/service.mjs';
import { GRANT_KEY } from '../../src/store.mjs';
import { MemoryCredentials } from './memory-credentials.mjs';
import { startMockOidc } from './mock-oidc.mjs';
import { createClientSecretFixture } from './client-secret-source.mjs';

export async function confidentialHarness(t, method = 'client_secret_basic', { config: extraConfig, credentials = new MemoryCredentials(), ...extraOptions } = {}) {
  const value = 'fixture secret:密+码';
  const mock = await startMockOidc({ clientId: 'fixture: 客+户', clientSecret: value, clientAuthMethod: method });
  t.after(() => mock.close());
  const fixture = createClientSecretFixture(credentials, { issuer: mock.issuer, clientId: mock.clientId, method, value });
  const config = { ...mock.endpoints, ...fixture.config, redirectUri: 'http://127.0.0.1:4567/iam/callback',
    allowInsecureHttp: true, httpTimeoutMs: 2000, ...extraConfig };
  const options = { ...fixture.options, verifyAtomicStore: (candidate) => candidate === credentials, ...extraOptions };
  const service = createIamService(config, options);
  t.after(() => service.dispose());
  return { fixture, mock, config, options, service, credentials, record: async () => (await credentials.readRecord(GRANT_KEY))?.payload };
}

export async function authorization(service) {
  const started = await service.startSignIn();
  const url = new URL(started.authorizationUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('client_secret'), false);
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return response.headers.get('location');
}

export async function signIn(harness) {
  const callback = await authorization(harness.service);
  const result = await harness.service.handleCallback(callback);
  assert.equal(result.state, 'ready');
  return result;
}

export function hold() {
  const entered = Promise.withResolvers(); const released = Promise.withResolvers();
  return { entered: entered.promise, release: released.resolve, async pause() { entered.resolve(); await released.promise; } };
}
