import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from './support/trusted-service.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const config = {
  issuer: 'https://iam.example', authorizationEndpoint: 'https://iam.example/authorize',
  tokenEndpoint: 'https://iam.example/token', jwksUri: 'https://iam.example/jwks',
  revocationEndpoint: 'https://iam.example/revoke', clientId: 'test',
  redirectUri: 'http://127.0.0.1:4567/iam/callback', allowInsecureHttp: true,
  refreshSkewSeconds: 7200,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const failure of ['throws', 'skips-mutator']) {
  test(`sign-out will not delete after the locked read ${failure}`, async (t) => {
    const credentials = new MemoryCredentials();
    await createGrantStore(credentials).write({
      version: 1, issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
      refreshToken: 'synthetic-old-refresh', accessToken: 'synthetic-old-access', scope: 'openid',
      obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    let deletions = 0;
    let revocations = 0;
    credentials.modifyRecord = async () => {
      if (failure === 'throws') throw new Error('synthetic provider failure');
      return undefined;
    };
    credentials.deleteRecord = async () => { deletions++; };
    const service = createIamService(config, { credentials, fetch: async () => {
      revocations++;
      return new Response(null, { status: 204 });
    } });
    t.after(() => service.dispose());
    const result = await service.signOut();
    assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
    assert.equal(result.revocation, 'unknown');
    assert.equal(deletions, 0);
    assert.equal(revocations, 0);
  });
}

test('sign-out observing an in-flight refresh preserves pending and reports unknown', async (t) => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
    refreshToken: 'synthetic-old-refresh', accessToken: 'synthetic-old-access', scope: 'openid',
    obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const entered = deferred();
  const release = deferred();
  let revocations = 0;
  const fetch = async (url) => {
    if (String(url).endsWith('/jwks')) return Response.json({ keys: [] });
    if (String(url).endsWith('/token')) {
      entered.resolve();
      await release.promise;
      return Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (String(url).endsWith('/revoke')) { revocations++; return new Response(null, { status: 204 }); }
    throw new Error('unexpected mock request');
  };
  const refreshing = createIamService(config, { credentials, fetch });
  const signingOut = createIamService(config, { credentials, fetch });
  t.after(() => { release.resolve(); refreshing.dispose(); signingOut.dispose(); });
  const refresh = refreshing.resolveToken();
  await Promise.race([
    entered.promise,
    refresh.then(() => { throw new Error('refresh completed before reaching the mock endpoint'); }),
  ]);
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
  const result = await signingOut.signOut();
  assert.equal(result.view.state, 'error');
  assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
  assert.equal(result.revocation, 'unknown');
  assert.equal(revocations, 0);
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
  release.resolve();
  assert.equal(await refresh, 'synthetic-new-access');
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'complete');
});
