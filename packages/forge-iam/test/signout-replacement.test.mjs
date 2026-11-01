import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from './support/trusted-service.mjs';
import { createIamService as createRawIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY, GATEWAY_RECORD_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const config = {
  issuer: 'https://iam.example', authorizationEndpoint: 'https://iam.example/authorize',
  tokenEndpoint: 'https://iam.example/token', jwksUri: 'https://iam.example/jwks',
  revocationEndpoint: 'https://iam.example/revoke', clientId: 'test',
  redirectUri: 'http://127.0.0.1:4567/iam/callback', allowInsecureHttp: true,
};
const grant = (subject, id, legacy = false) => ({
  version: 1, issuer: config.issuer, subject, clientId: config.clientId,
  ...(legacy ? {} : { sessionInstanceId: Buffer.alloc(32, id).toString('base64url') }),
  refreshToken: `${subject}-refresh`, accessToken: `${subject}-access`, scope: 'openid',
  obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
});

for (const initial of ['absent', 'tombstone', 'wrong-kind', 'invalid-grant']) {
  test(`sign-out handles ${initial} without blind deletion`, async (t) => {
    const credentials = new MemoryCredentials();
    const tombstone = { kind: 'grant', payload: { version: 1, type: 'heluo-iam-session-tombstone' } };
    const original = initial === 'tombstone' ? tombstone : initial === 'wrong-kind'
      ? { kind: 'api-key', key: 'synthetic' } : initial === 'invalid-grant'
        ? { kind: 'grant', payload: { version: 99 } } : undefined;
    if (original) await credentials.modifyRecord(GRANT_KEY, async () => original);
    let revocations = 0;
    let deletes = 0;
    credentials.deleteRecord = async () => { deletes++; };
    const service = createIamService(config, { credentials, fetch: async () => {
      revocations++;
      return new Response(null, { status: 204 });
    } });
    t.after(() => service.dispose());
    const result = await service.signOut();
    assert.equal(result.revocation, original && initial !== 'tombstone' ? 'unknown' : 'skipped');
    assert.equal(result.view.error, original && initial !== 'tombstone' ? 'IAM_CREDENTIALS_CLEAR_FAILED' : null);
    assert.deepEqual(await credentials.readRecord(GRANT_KEY), original);
    assert.equal(revocations, 0);
    assert.equal(deletes, 0);
    if (initial === 'tombstone') {
      await createGrantStore(credentials).write(grant('new-user', 2));
      assert.equal((await createGrantStore(credentials).read()).grant.subject, 'new-user');
    }
  });
}

for (const failure of ['before-commit', 'after-commit', 'wrong-receipt']) {
  test(`sign-out reports unknown on ${failure}`, async (t) => {
    const credentials = new MemoryCredentials();
    const store = createGrantStore(credentials);
    await store.write(grant('old-user', 1));
    const modify = credentials.modifyRecord.bind(credentials);
    let writes = 0;
    let revocations = 0;
    credentials.modifyRecord = async (key, mutate) => {
      const result = await modify(key, async (current) => {
        const next = await mutate(current);
        if (next?.payload?.type === 'heluo-iam-session-tombstone') {
          writes++;
          if (failure === 'before-commit') throw new Error('synthetic failure');
        }
        return next;
      });
      if (failure === 'after-commit') throw new Error('synthetic lost receipt');
      if (failure === 'wrong-receipt') return undefined;
      return result;
    };
    const service = createIamService(config, { credentials, fetch: async () => {
      revocations++;
      return new Response(null, { status: 204 });
    } });
    t.after(() => service.dispose());
    const result = await service.signOut();
    assert.equal(result.revocation, 'unknown');
    assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
    assert.equal(result.logoutUrl, null);
    assert.equal(writes, 1);
    assert.equal(revocations, 1);
    const stored = await store.read();
    assert.equal(stored.grant?.subject ?? null, failure === 'before-commit' ? 'old-user' : null);
  });
}

for (const [interruption, status] of [['provider-replaced', 204], ['provider-replaced', 503], ['dispose', 204], ['dispose', 503]]) {
  test(`sign-out does not commit after ${interruption} during revocation (${status})`, async (t) => {
    const old = new MemoryCredentials();
    const next = new MemoryCredentials();
    await createGrantStore(old).write(grant('old-user', 1));
    await createGrantStore(next).write(grant('new-user', 2));
    let current = old;
    let enter;
    let release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const revoked = [];
    const service = createRawIamService(config, {
      getCredentials: () => current,
      verifyAtomicStore: (candidate) => candidate === old || candidate === next,
      fetch: async (_url, init) => {
        revoked.push(new URLSearchParams(init.body).get('token'));
        enter();
        await gate;
        return new Response(null, { status });
      },
    });
    t.after(() => { release(); service.dispose(); });
    const pending = service.signOut();
    await Promise.race([entered, pending.then(() => { throw new Error('sign-out completed before revocation'); })]);
    if (interruption === 'dispose') await service.dispose();
    else current = next;
    release();
    if (interruption === 'dispose') {
      await assert.rejects(pending, { code: 'IAM_DISPOSED' });
    } else {
      const result = await pending;
      assert.equal(result.revocation, 'unknown');
      assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
    }
    assert.deepEqual(revoked, ['old-user-refresh']);
    assert.equal((await createGrantStore(old).read()).grant.subject, 'old-user');
    assert.equal((await createGrantStore(next).read()).grant.subject, 'new-user');
  });
}

test('sign-out reports unknown if the provider changes before the result is published', async (t) => {
  const old = new MemoryCredentials();
  const next = new MemoryCredentials();
  await createGrantStore(old).write(grant('old-user', 1));
  await createGrantStore(next).write(grant('new-user', 2));
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const read = old.readRecord.bind(old);
  old.readRecord = async (key) => {
    const value = await read(key);
    if (key === GATEWAY_RECORD_KEY) { enter(); await gate; }
    return value;
  };
  let current = old;
  const service = createRawIamService(config, {
    getCredentials: () => current,
    verifyAtomicStore: (candidate) => candidate === old || candidate === next,
    fetch: async () => new Response(null, { status: 204 }),
  });
  t.after(() => { release(); service.dispose(); });
  const pending = service.signOut();
  await Promise.race([entered, pending.then(() => { throw new Error('sign-out completed before the gateway read'); })]);
  current = next;
  release();
  const result = await pending;
  assert.equal(result.revocation, 'unknown');
  assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
  assert.equal((await createGrantStore(next).read()).grant?.subject, 'new-user');
});

for (const legacy of [false, true]) {
  test(`sign-out cannot delete a later ${legacy ? 'legacy' : 'identified'} login after its locked operation`, async (t) => {
    const credentials = new MemoryCredentials();
    const store = createGrantStore(credentials);
    const old = grant('old-user', 1, legacy);
    const replacement = grant('new-user', 2, legacy);
    await store.write(old);
    const originalModify = credentials.modifyRecord.bind(credentials);
    let inject = true;
    credentials.modifyRecord = async (key, mutate) => {
      const result = await originalModify(key, mutate);
      if (inject && key === GRANT_KEY) {
        inject = false;
        await originalModify(key, async () => ({ kind: 'grant', payload: replacement }));
      }
      return result;
    };
    const revoked = [];
    const service = createIamService(config, { credentials, fetch: async (_url, init) => {
      revoked.push(new URLSearchParams(init.body).get('token'));
      return new Response(null, { status: 204 });
    } });
    t.after(() => service.dispose());
    await service.signOut();
    assert.equal((await store.read()).grant?.subject, 'new-user');
    assert.deepEqual(revoked, ['old-user-refresh']);
  });

  test(`sign-out does not revoke a ${legacy ? 'legacy' : 'identified'} replacement before it acquires the lock`, async (t) => {
    const credentials = new MemoryCredentials();
    const store = createGrantStore(credentials);
    await store.write(grant('old-user', 1, legacy));
    let enter;
    let release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const read = credentials.readRecord.bind(credentials);
    let first = true;
    credentials.readRecord = async (key) => {
      const value = await read(key);
      if (first && key === GRANT_KEY) { first = false; enter(); await gate; }
      return value;
    };
    const revoked = [];
    const service = createIamService(config, { credentials, fetch: async (_url, init) => {
      revoked.push(new URLSearchParams(init.body).get('token'));
      return new Response(null, { status: 204 });
    } });
    t.after(() => { release(); service.dispose(); });
    const signOut = service.signOut();
    await Promise.race([entered, signOut.then(() => { throw new Error('sign-out completed before the gate'); })]);
    await store.write(grant('new-user', 2, legacy));
    release();
    const result = await signOut;
    assert.equal(result.revocation, 'unknown');
    assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
    assert.equal((await store.read()).grant?.subject, 'new-user');
    assert.deepEqual(revoked, []);
  });
}
