import test from 'node:test';
import assert from 'node:assert/strict';
import { accessTokenOf, isBridgeReadableSession, sessionFromRecord } from '../src/cli-session.mjs';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const instance = Buffer.alloc(32, 1).toString('base64url');
const grant = {
  version: 1, issuer: 'https://iam.corp.example', subject: 'synthetic-user', clientId: 'synthetic-client',
  scope: 'openid', obtainedAt: '2030-01-01T00:00:00.000Z', refreshToken: 'synthetic-refresh',
  accessToken: 'synthetic-access', accessExpiresAt: '2099-01-01T00:00:00.000Z',
};

for (const [name, extra] of [
  ['public', {}],
  ['confidential', { version: 2, authContext: { mode: 'confidential', method: 'client_secret_basic',
    secretRef: 'synthetic-ref', secretRevision: 'synthetic-revision' } }],
]) {
  test(`${name} sessions without an instance ID are rejected without changing stored data`, async () => {
    for (const pending of [false, true]) {
      const legacy = { ...grant, ...extra, ...(pending ? { refreshOperation: {
        version: 1, state: 'pending', id: instance, base: instance,
      } } : {}) };
      for (const payload of [legacy, JSON.stringify(legacy)]) {
        const record = { kind: 'grant', payload };
        const credentials = new MemoryCredentials();
        credentials.records.set(GRANT_KEY, structuredClone(record));
        const store = createGrantStore(credentials, { verifyAtomicStore: (candidate) => candidate === credentials });
        assert.equal((await store.read()).ok, false);
        assert.equal(sessionFromRecord(record).status, 'error');
        assert.equal(accessTokenOf(record).ok, false);
        assert.equal(isBridgeReadableSession(record), false);
        await assert.rejects(store.mutate(() => ({ ...legacy, sessionInstanceId: instance })));
        await assert.rejects(store.write({ ...legacy, sessionInstanceId: instance }));
        assert.equal((await store.signOutSnapshot(legacy, () => assert.fail('must not revoke'))).ok, false);
        assert.deepEqual(await credentials.readRecord(GRANT_KEY), record);
      }
    }
  });
}

test('Host does not restore, refresh, or sign out a legacy session', async (t) => {
  const credentials = new MemoryCredentials();
  const record = { kind: 'grant', payload: { ...grant, accessExpiresAt: '2020-01-01T00:00:00.000Z' } };
  credentials.records.set(GRANT_KEY, structuredClone(record));
  let requests = 0;
  const service = createIamService({ issuer: grant.issuer, clientId: grant.clientId,
    authorizationEndpoint: `${grant.issuer}/authorize`, tokenEndpoint: `${grant.issuer}/token`,
    jwksUri: `${grant.issuer}/jwks`, redirectUri: 'http://127.0.0.1:4567/iam/callback' }, {
    credentials, verifyAtomicStore: (candidate) => candidate === credentials,
    fetch: async () => { requests++; throw new Error('unexpected network request'); },
  });
  t.after(() => service.dispose());
  await service.hydrate();
  assert.notEqual(service.getView().state, 'ready');
  await assert.rejects(service.resolveToken());
  await service.signOut();
  assert.equal(requests, 0);
  assert.deepEqual(await credentials.readRecord(GRANT_KEY), record);
});
