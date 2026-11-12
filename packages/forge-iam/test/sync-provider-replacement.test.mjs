import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const config = {
  issuer: 'https://iam.corp.example', authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'test', redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

async function seed(credentials, subject = 'old-user') {
  await createGrantStore(credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: config.issuer, subject, clientId: config.clientId,
    refreshToken: `${subject}-refresh`, accessToken: `${subject}-access`, scope: 'openid',
    obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(now + 3600000).toISOString(),
  });
}

function pauseRead(credentials, fail = false) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const read = credentials.readRecord.bind(credentials);
  let paused = false;
  credentials.readRecord = async (key) => {
    const record = await read(key);
    if (key === GRANT_KEY && !paused) {
      paused = true;
      entered.resolve();
      await released.promise;
      if (fail) throw new Error('synthetic read failure');
    }
    return record;
  };
  return { entered: entered.promise, release: released.resolve };
}

for (const [cached, replacement] of [false, true].flatMap((cached) =>
  ['empty', 'different-user', 'unavailable', 'throwing', 'invalid'].map((replacement) => [cached, replacement]))) {
  test(`sync rejects an old read after replacement with ${replacement}, cached=${cached}`, async (t) => {
    const old = new MemoryCredentials();
    await seed(old);
    const next = new MemoryCredentials();
    if (replacement === 'different-user') await seed(next, 'new-user');
    let current = old;
    let lookupThrows = false;
    const service = createIamService(config, {
      now: () => now,
      getCredentials: () => {
        if (lookupThrows) throw new Error('synthetic lookup failure');
        return current;
      },
      fetch: async () => { throw new Error('unexpected network access'); },
    });
    if (cached) assert.equal((await service.syncFromStore()).principal, 'old-user');
    const gate = pauseRead(old);
    t.after(() => { gate.release(); return service.dispose(); });
    const pending = service.syncFromStore();
    await gate.entered;
    current = replacement === 'unavailable' ? undefined : replacement === 'invalid' ? {} : next;
    lookupThrows = replacement === 'throwing';
    gate.release();
    const result = await pending;
    assert.equal(result.signedIn, false);
    assert.equal(result.principal, null);
    assert.equal(service.getPrincipal(), undefined);
    if (replacement === 'different-user') {
      assert.equal((await service.syncFromStore()).principal, 'new-user');
    }
  });
}

for (const fail of [false, true]) {
  test(`a late ${fail ? 'failed' : 'successful'} old sync preserves a newer provider session`, async (t) => {
    const old = new MemoryCredentials();
    await seed(old);
    const next = new MemoryCredentials();
    await seed(next, 'new-user');
    let current = old;
    const service = createIamService(config, { now: () => now, getCredentials: () => current });
    const gate = pauseRead(old, fail);
    t.after(() => { gate.release(); return service.dispose(); });
    const pending = service.syncFromStore();
    await gate.entered;
    current = next;
    assert.equal((await service.syncFromStore()).principal, 'new-user');
    gate.release();
    assert.equal((await pending).principal, 'new-user');
    assert.deepEqual(service.getPrincipal(), { issuer: config.issuer, subject: 'new-user' });
  });

  test(`a late ${fail ? 'failed' : 'successful'} sync cannot revive a disposed service`, async (t) => {
    const credentials = new MemoryCredentials();
    await seed(credentials);
    const service = createIamService(config, { now: () => now, credentials });
    const gate = pauseRead(credentials, fail);
    t.after(() => { gate.release(); return service.dispose(); });
    const pending = service.syncFromStore();
    await gate.entered;
    await service.dispose();
    gate.release();
    assert.equal((await pending).state, 'signed-out');
    assert.equal(service.getPrincipal(), undefined);
    assert.equal((await createGrantStore(credentials).read()).grant.subject, 'old-user');
  });

  test(`a late ${fail ? 'failed' : 'successful'} sync cannot overwrite a newer sign-in`, async (t) => {
    const credentials = new MemoryCredentials();
    await seed(credentials);
    const service = createIamService(config, {
      now: () => now, credentials, verifyAtomicStore: (candidate) => candidate === credentials,
      getOrigin: () => 'http://127.0.0.1:4567',
      fetch: async () => { throw new Error('unexpected network access'); },
    });
    const gate = pauseRead(credentials, fail);
    t.after(() => { gate.release(); return service.dispose(); });
    const pending = service.syncFromStore();
    await gate.entered;
    assert.equal((await service.startSignIn()).view.state, 'authenticating');
    gate.release();
    const result = await pending;
    assert.equal(result.state, 'authenticating');
    assert.equal(result.error, null);
    assert.equal(result.principal, null);
  });
}

test('provider recheck cannot publish after synchronous disposal', async (t) => {
  const credentials = new MemoryCredentials();
  await seed(credentials);
  let checks = 0;
  let service;
  service = createIamService(config, {
    now: () => now,
    getCredentials: () => {
      if (++checks === 2) void service.dispose();
      return credentials;
    },
  });
  t.after(() => service.dispose());
  const result = await service.syncFromStore();
  assert.equal(result.state, 'signed-out');
  assert.equal(result.principal, null);
});

for (const [resetStore, missing] of [false, true].flatMap((resetStore) =>
  ['unavailable', 'throwing', 'invalid'].map((missing) => [resetStore, missing]))) {
  test(`sync drops cached identity when the provider is ${missing} before it begins, resetStore=${resetStore}`, async (t) => {
    const credentials = new MemoryCredentials();
    await seed(credentials);
    let current = credentials;
    let lookupThrows = false;
    const service = createIamService(config, {
      now: () => now,
      getCredentials: () => {
        if (lookupThrows) throw new Error('synthetic lookup failure');
        return current;
      },
    });
    t.after(() => service.dispose());
    assert.equal((await service.syncFromStore()).principal, 'old-user');
    current = missing === 'invalid' ? {} : undefined;
    lookupThrows = missing === 'throwing';
    if (resetStore) await service.loadGatewayCredential({ force: true });
    const result = await service.syncFromStore();
    assert.equal(result.signedIn, false);
    assert.equal(result.principal, null);
    assert.equal(service.getPrincipal(), undefined);
    assert.equal((await createGrantStore(credentials).read()).grant.subject, 'old-user');
  });
}

for (const [existing, fail] of [false, true].flatMap((existing) => [false, true].map((fail) => [existing, fail]))) {
  test(`a late same-provider sync preserves a newer adopted session, existing=${existing}, fail=${fail}`, async (t) => {
    const credentials = new MemoryCredentials();
    if (existing) await seed(credentials);
    const service = createIamService(config, { now: () => now, credentials });
    const gate = pauseRead(credentials, fail);
    t.after(() => { gate.release(); return service.dispose(); });
    const pending = service.syncFromStore();
    await gate.entered;
    await seed(credentials, 'new-user');
    assert.equal((await service.syncFromStore()).principal, 'new-user');
    gate.release();
    assert.equal((await pending).principal, 'new-user');
    assert.equal(service.getPrincipal().subject, 'new-user');
    assert.equal((await createGrantStore(credentials).read()).grant.subject, 'new-user');
  });
}

test('a revoked intermediate provider cannot leave a previous provider identity cached', async (t) => {
  const old = new MemoryCredentials();
  await seed(old);
  const intermediate = new MemoryCredentials();
  let current = old;
  const service = createIamService(config, { now: () => now, getCredentials: () => current });
  const gate = pauseRead(intermediate);
  t.after(() => { gate.release(); return service.dispose(); });
  assert.equal((await service.syncFromStore()).principal, 'old-user');
  current = intermediate;
  const pending = service.syncFromStore();
  await gate.entered;
  current = undefined;
  gate.release();
  assert.equal((await pending).signedIn, false);
  assert.equal(service.getPrincipal(), undefined);
  assert.equal((await createGrantStore(old).read()).grant.subject, 'old-user');
});

test('an older sync cannot revive a grant after a newer sync confirms it absent', async (t) => {
  const credentials = new MemoryCredentials();
  await seed(credentials);
  const service = createIamService(config, { now: () => now, credentials });
  const gate = pauseRead(credentials);
  t.after(() => { gate.release(); return service.dispose(); });
  const pending = service.syncFromStore();
  await gate.entered;
  await credentials.deleteRecord(GRANT_KEY);
  assert.equal((await service.syncFromStore()).signedIn, false);
  gate.release();
  assert.equal((await pending).signedIn, false);
  assert.equal(service.getPrincipal(), undefined);
});

test('starting another read does not starve a still-current completed sync', async (t) => {
  const credentials = new MemoryCredentials();
  await seed(credentials);
  const gates = [0, 1].map(() => ({ entered: Promise.withResolvers(), released: Promise.withResolvers() }));
  const read = credentials.readRecord.bind(credentials);
  let reads = 0;
  credentials.readRecord = async (key) => {
    const record = await read(key);
    if (key === GRANT_KEY) {
      const gate = gates[reads++];
      if (gate) { gate.entered.resolve(); await gate.released.promise; }
    }
    return record;
  };
  const service = createIamService(config, { now: () => now, credentials });
  t.after(() => { for (const gate of gates) gate.released.resolve(); return service.dispose(); });
  const first = service.syncFromStore();
  await gates[0].entered.promise;
  const second = service.syncFromStore();
  await gates[1].entered.promise;
  gates[0].released.resolve();
  assert.equal((await first).principal, 'old-user');
  gates[1].released.resolve();
  assert.equal((await second).principal, 'old-user');
});

test('a failed read on the current provider still fails closed', async (t) => {
  const credentials = new MemoryCredentials();
  await seed(credentials);
  const service = createIamService(config, { now: () => now, credentials });
  t.after(() => service.dispose());
  await service.syncFromStore();
  credentials.readRecord = async () => { throw new Error('synthetic read failure'); };
  const result = await service.syncFromStore();
  assert.equal(result.state, 'error');
  assert.equal(result.error, 'IAM_CREDENTIALS_UNAVAILABLE');
  assert.equal(result.principal, null);
});

test('a stable provider still publishes the valid session', async (t) => {
  const credentials = new MemoryCredentials();
  await seed(credentials);
  const service = createIamService(config, { now: () => now, credentials });
  t.after(() => service.dispose());
  const result = await service.syncFromStore();
  assert.equal(result.state, 'ready');
  assert.equal(result.principal, 'old-user');
});
