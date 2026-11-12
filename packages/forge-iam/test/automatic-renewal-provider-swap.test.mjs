import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createGrantStore } from '../src/store.mjs';
import { createIamService } from '../src/service.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

class CountedCredentials extends MemoryCredentials {
  reads = 0;
  writes = 0;

  async readRecord(key) {
    if (key === 'heluo-iam/session') this.reads += 1;
    return super.readRecord(key);
  }

  async modifyRecord(key, ...args) {
    if (key === 'heluo-iam/session') this.writes += 1;
    return super.modifyRecord(key, ...args);
  }
}

for (const swap of ['before the timer', 'between provider checks']) test(`an old recovery timer cannot touch a replacement provider ${swap}`, async (t) => {
  const first = new CountedCredentials();
  const second = new CountedCredentials();
  let current = first;
  let swapOnNextCheck = false;
  let keyRequests = 0;
  let refreshPosts = 0;
  const started = Promise.withResolvers();
  const now = Date.now();
  const issuer = 'https://iam.corp.example';
  const grant = (subject, refreshToken, ttl) => ({
    version: 1, issuer, subject, clientId: 'dsh', refreshToken, scope: 'openid',
    obtainedAt: new Date(now).toISOString(), refreshExpiresAt: new Date(now + ttl).toISOString(),
  });
  await createGrantStore(first).write(grant('E1001', 'refresh-a', 2400));
  await createGrantStore(second).write(grant('E2002', 'refresh-b', 120_000));
  const service = createIamService({ issuer, authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`, clientId: 'dsh',
    redirectUri: 'http://127.0.0.1:4567/iam/callback', refreshSkewSeconds: 1 }, {
    getCredentials: () => {
      if (swapOnNextCheck) {
        swapOnNextCheck = false;
        current = second;
        return first;
      }
      return current;
    },
    getOrigin: () => 'http://127.0.0.1:4567',
    verifyAtomicStore: (candidate) => candidate === first || candidate === second,
    fetch: async (url, init) => {
      if (String(url).endsWith('/jwks')) {
        keyRequests += 1;
        if (keyRequests === 1) { started.resolve(); throw new Error('synthetic outage'); }
        return Response.json({ keys: [] });
      }
      if (init?.method === 'POST') {
        refreshPosts += 1;
        return Response.json({ access_token: 'new-access', token_type: 'Bearer',
          expires_in: 30, refresh_token: 'new-refresh' });
      }
      throw new Error('unexpected request');
    },
  });
  t.after(() => service.dispose());
  await service.hydrate();
  await started.promise;
  await delay(30);
  second.reads = 0;
  second.writes = 0;
  if (swap === 'before the timer') current = second;
  else swapOnNextCheck = true;
  await delay(1600);
  assert.equal(refreshPosts, 0);
  assert.equal(second.reads, 0);
  assert.equal(second.writes, 0);
});
