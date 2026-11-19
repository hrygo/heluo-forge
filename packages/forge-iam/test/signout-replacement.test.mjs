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
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};
const grant = (subject, id, legacy = false) => ({
  version: 1, issuer: config.issuer, subject, clientId: config.clientId,
  ...(legacy ? {} : { sessionInstanceId: Buffer.alloc(32, id).toString('base64url') }),
  refreshToken: `${subject}-refresh`, accessToken: `${subject}-access`, scope: 'openid',
  obtainedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
});

test('RP logout can discover its optional endpoint after confirmed local sign-out', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const discovered = `${config.issuer}/end-session`;
  await store.write({ ...grant('synthetic-user', 1), idToken: 'synthetic-id-token-hint' });
  const requests = [];
  const service = createIamService({ ...config, logoutMode: 'rp', discoveryUrl: `${config.issuer}/discovery` }, {
    credentials, fetch: async (url) => {
      requests.push(new URL(url).pathname);
      if (requests.at(-1) === '/revoke') return Response.json({ result: true });
      assert.deepEqual(await store.read(), { ok: true, grant: null });
      return Response.json({ issuer: config.issuer, end_session_endpoint: discovered });
    },
  });
  t.after(() => service.dispose());
  const result = await service.signOut();
  assert.equal(result.revocation, 'ok');
  assert.equal(result.view.state, 'signed-out');
  assert.deepEqual(requests, ['/revoke', '/discovery']);
  const logout = new URL(result.logoutUrl);
  assert.equal(`${logout.origin}${logout.pathname}`, discovered);
  assert.equal(logout.searchParams.get('id_token_hint'), 'synthetic-id-token-hint');
});

for (const failure of ['a peer replaces the session', 'the confirmation read fails']) {
  test(`RP logout suppresses the optional URL while preserving local completion if ${failure}`, async (t) => {
    const credentials = new MemoryCredentials();
    const store = createGrantStore(credentials);
    await store.write({ ...grant('synthetic-user', 1), idToken: 'synthetic-id-token-hint' });
    const replacement = grant('synthetic-user', 2);
    const readRecord = credentials.readRecord.bind(credentials);
    const requests = [];
    const service = createIamService({ ...config, logoutMode: 'rp', discoveryUrl: `${config.issuer}/discovery` }, {
      credentials, fetch: async (url) => {
        const path = new URL(url).pathname;
        requests.push(path);
        if (path === '/revoke') return Response.json({ result: true });
        assert.deepEqual(await store.read(), { ok: true, grant: null });
        if (failure === 'a peer replaces the session') {
          await store.write(replacement);
        } else {
          credentials.readRecord = async (key) => {
            if (key === GRANT_KEY) throw new Error('synthetic confirmation read failure');
            return readRecord(key);
          };
        }
        return Response.json({ issuer: config.issuer, end_session_endpoint: `${config.issuer}/end-session` });
      },
    });
    t.after(() => service.dispose());
    const result = await service.signOut();
    assert.equal(result.revocation, 'ok');
    assert.equal(result.view.state, 'signed-out');
    assert.equal(result.logoutUrl, null);
    assert.deepEqual(requests, ['/revoke', '/discovery']);
    credentials.readRecord = readRecord;
    assert.deepEqual(await store.read(), { ok: true, grant: failure === 'a peer replaces the session' ? replacement : null });
  });
}

test('an unavailable discovery result cannot establish that revocation is unconfigured', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  const original = grant('synthetic-user', 1);
  await store.write(original);
  const requests = [];
  const service = createIamService({ ...config, revocationEndpoint: '', discoveryUrl: `${config.issuer}/discovery` }, {
    credentials, fetch: async (url) => {
      requests.push(new URL(url).pathname);
      return new Response(null, { status: 503 });
    },
  });
  t.after(() => service.dispose());
  const result = await service.signOut();
  assert.equal(result.revocation, 'unknown');
  assert.deepEqual(requests, ['/discovery']);
  assert.deepEqual(await store.read(), { ok: false, reason: 'sign-out-pending' });
});

test('malformed Discovery revocation metadata stays pending until genuine omission is confirmed', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write(grant('synthetic-user', 1));
  const configured = { ...config, revocationEndpoint: '', discoveryUrl: `${config.issuer}/discovery` };
  const requests = [];
  let document = { issuer: config.issuer, revocation_endpoint: null };
  const service = createIamService(configured, { credentials, fetch: async (url) => {
    requests.push(new URL(url).pathname);
    return Response.json(document);
  } });
  t.after(() => service.dispose());

  assert.equal((await service.signOut()).revocation, 'unknown');
  assert.deepEqual(await store.read(), { ok: false, reason: 'sign-out-pending' });
  document = { issuer: config.issuer };
  assert.equal((await service.signOut()).revocation, 'skipped');
  assert.deepEqual(await store.read(), { ok: true, grant: null });
  assert.deepEqual(requests, ['/discovery', '/discovery']);
});

test('an endpoint-only V1 marker can resume by Discovery only at its original endpoint', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials, { verifyAtomicStore: () => true });
  const saved = grant('synthetic-user', 1);
  await store.write(saved);
  assert.deepEqual(await store.signOutSnapshot(saved, () => { throw new Error('unconfirmed synthetic revoke'); }, undefined, {
    revocationContext: { mode: 'access_token_query', endpoint: config.revocationEndpoint, resource: null },
  }), { ok: false });
  const pending = await credentials.readRecord(GRANT_KEY);
  const configured = { ...config, revocationEndpoint: '', discoveryUrl: `${config.issuer}/discovery` };
  for (const matching of [false, true]) {
    const requests = [];
    const service = createIamService(configured, { credentials, fetch: async (url) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path === '/discovery') {
        return Response.json({ issuer: config.issuer,
          revocation_endpoint: matching ? config.revocationEndpoint : `${config.issuer}/different-revoke` });
      }
      return Response.json({ result: true });
    } });
    try {
      assert.equal((await service.signOut()).revocation, matching ? 'ok' : 'unknown');
      assert.deepEqual(requests, matching ? ['/discovery', '/revoke'] : ['/discovery']);
      if (!matching) assert.deepEqual(await credentials.readRecord(GRANT_KEY), pending);
    } finally { await service.dispose(); }
  }
  assert.deepEqual(await store.read(), { ok: true, grant: null });
});

test('a cold discovery-only Host must verify the issuer before marking sign-out pending', async () => {
  const credentials = new MemoryCredentials();
  const saved = grant('synthetic-user', 1);
  const store = createGrantStore(credentials);
  await store.write(saved);
  const configured = { ...config, issuer: '', revocationEndpoint: '', discoveryUrl: `${config.issuer}/discovery` };
  for (const discovery of [null, { issuer: 'https://different.corp.example', revocation_endpoint: config.revocationEndpoint }]) {
    const requests = [];
    const service = createIamService(configured, { credentials, fetch: async (url) => {
      requests.push(new URL(url).pathname);
      assert.deepEqual(await store.read(), { ok: true, grant: saved });
      return discovery ? Response.json(discovery) : new Response(null, { status: 503 });
    } });
    try {
      assert.equal((await service.signOut()).revocation, 'unknown');
      assert.deepEqual(await store.read(), { ok: true, grant: saved });
      assert.deepEqual(requests, ['/discovery']);
    } finally { await service.dispose(); }
  }
});

for (const replaced of [true, false]) {
  test(`a cold discovery-only Host ${replaced ? 'preserves a replacement' : 'can finish the original sign-out'} after an outage`, async (t) => {
    const credentials = new MemoryCredentials();
    const store = createGrantStore(credentials);
    const saved = grant('synthetic-user', 1);
    await store.write(saved);
    const configured = { ...config, issuer: '', revocationEndpoint: '', discoveryUrl: `${config.issuer}/discovery` };
    const requests = [];
    let discoveryAvailable = false;
    const service = createIamService(configured, { credentials, fetch: async (url) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path === '/discovery') {
        return discoveryAvailable ? Response.json({ issuer: config.issuer, revocation_endpoint: config.revocationEndpoint })
          : new Response(null, { status: 503 });
      }
      return Response.json({ result: true });
    } });
    t.after(() => service.dispose());
    assert.equal((await service.signOut()).revocation, 'unknown');
    assert.deepEqual(await store.read(), { ok: true, grant: saved });
    discoveryAvailable = true;
    if (replaced) {
      const replacement = grant('synthetic-user', 2);
      await store.write(replacement);
      assert.equal((await service.signOut()).revocation, 'unknown');
      assert.deepEqual(requests, ['/discovery']);
      assert.deepEqual(await store.read(), { ok: true, grant: replacement });
    } else {
      assert.equal((await service.signOut()).revocation, 'ok');
      assert.deepEqual(requests, ['/discovery', '/discovery', '/revoke']);
      assert.deepEqual(await store.read(), { ok: true, grant: null });
    }
  });
}

test('a committed replacement during Discovery survives sign-out and its in-memory retry', async (t) => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write(grant('synthetic-user', 1));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const requests = [];
  const service = createIamService({ ...config, revocationEndpoint: '', discoveryUrl: `${config.issuer}/discovery` }, {
    credentials, fetch: async (url) => {
      requests.push(new URL(url).pathname);
      entered.resolve();
      await release.promise;
      return Response.json({ issuer: config.issuer, revocation_endpoint: config.revocationEndpoint });
    },
  });
  t.after(() => { release.resolve(); return service.dispose(); });
  const signOut = service.signOut();
  await Promise.race([entered.promise, signOut.then(() => assert.fail('Discovery did not start'))]);
  const replacement = grant('synthetic-user', 2);
  await store.write(replacement);
  release.resolve();
  assert.equal((await signOut).revocation, 'unknown');
  assert.equal((await service.signOut()).revocation, 'unknown');
  assert.deepEqual(requests, ['/discovery']);
  assert.deepEqual(await store.read(), { ok: true, grant: replacement });
});

test('a revocation confirmation cannot finish under a replacement atomic binding for the same provider', async (t) => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write(grant('synthetic-user', 1));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let binding = {};
  const service = createIamService(config, {
    credentials, getAtomicStoreBinding: () => binding,
    fetch: async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ result: true });
    },
  });
  t.after(() => { release.resolve(); return service.dispose(); });
  const signOut = service.signOut();
  await Promise.race([entered.promise, signOut.then(() => assert.fail('revocation never started'))]);
  const pending = await credentials.readRecord(GRANT_KEY);
  binding = {};
  release.resolve();
  assert.equal((await signOut).revocation, 'unknown');
  assert.deepEqual(await credentials.readRecord(GRANT_KEY), pending);
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
      return Response.json({ result: true });
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
      let committing = false;
      const result = await modify(key, async (current) => {
        const next = await mutate(current);
        if (next?.payload?.type === 'heluo-iam-session-tombstone') {
          committing = true;
          writes++;
          if (failure === 'before-commit') throw new Error('synthetic failure');
        }
        return next;
      });
      if (committing && failure === 'after-commit') throw new Error('synthetic lost receipt');
      if (committing && failure === 'wrong-receipt') return undefined;
      return result;
    };
    const service = createIamService(config, { credentials, fetch: async () => {
      revocations++;
      return Response.json({ result: true });
    } });
    t.after(() => service.dispose());
    const result = await service.signOut();
    assert.equal(result.revocation, 'unknown');
    assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
    assert.equal(result.logoutUrl, null);
    assert.equal(writes, 1);
    assert.equal(revocations, 1);
    const stored = await store.read();
    if (failure === 'before-commit') {
      assert.equal(stored.ok, false);
      assert.equal((await credentials.readRecord(GRANT_KEY)).payload.signOutOperation.state, 'pending');
    } else assert.equal(stored.grant, null);
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
      fetch: async (url) => {
        revoked.push(new URL(String(url)).searchParams.get('access_token'));
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
    assert.deepEqual(revoked, ['old-user-access']);
    assert.equal((await createGrantStore(old).read()).ok, false);
    assert.equal((await old.readRecord(GRANT_KEY)).payload.signOutOperation.state, 'pending');
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
    fetch: async () => Response.json({ result: true }),
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
    const old = grant('old-user', 1);
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
    const service = createIamService(config, { credentials, fetch: async (url) => {
      revoked.push(new URL(String(url)).searchParams.get('access_token'));
      return Response.json({ result: true });
    } });
    t.after(() => service.dispose());
    await service.signOut();
    assert.deepEqual(await credentials.readRecord(GRANT_KEY), { kind: 'grant', payload: replacement });
    assert.equal((await store.read()).ok, !legacy);
    assert.deepEqual(revoked, ['old-user-access']);
  });

  test(`sign-out does not revoke a ${legacy ? 'legacy' : 'identified'} replacement before it acquires the lock`, async (t) => {
    const credentials = new MemoryCredentials();
    const store = createGrantStore(credentials);
    await store.write(grant('old-user', 1));
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
    const service = createIamService(config, { credentials, fetch: async (url) => {
      revoked.push(new URL(String(url)).searchParams.get('access_token'));
      return Response.json({ result: true });
    } });
    t.after(() => { release(); service.dispose(); });
    const signOut = service.signOut();
    await Promise.race([entered, signOut.then(() => { throw new Error('sign-out completed before the gate'); })]);
    const replacement = grant('new-user', 2, legacy);
    if (legacy) await credentials.modifyRecord(GRANT_KEY, () => ({ kind: 'grant', payload: replacement }));
    else await store.write(replacement);
    release();
    const result = await signOut;
    assert.equal(result.revocation, 'unknown');
    assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
    assert.deepEqual(await credentials.readRecord(GRANT_KEY), { kind: 'grant', payload: replacement });
    assert.equal((await store.read()).ok, !legacy);
    assert.deepEqual(revoked, []);
  });
}
