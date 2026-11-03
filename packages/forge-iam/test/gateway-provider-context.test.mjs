import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { createGrantStore, createGatewayCredentialStore, GRANT_KEY, GATEWAY_RECORD_KEY, GATEWAY_REF } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { createAtomicGatewayFixture, gatewayAtomicOptions, seedLegacyGateway } from './support/atomic-gateway.mjs';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const config = {
  issuer: 'https://iam.corp.example', clientId: 'test',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};
const value = `uag-${'a'.repeat(32)}`;

async function seedGrant(credentials, subject = 'old-user', clientId = config.clientId) {
  await createGrantStore(credentials).write({
    version: 1, issuer: config.issuer, subject, clientId,
    refreshToken: `${subject}-refresh`, accessToken: `${subject}-access`, scope: 'openid',
    obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(now + 3600000).toISOString(),
  });
}
async function seedKey(credentials, subject) {
  seedLegacyGateway(credentials, { value, ownerSubject: subject,
    enteredAt: new Date(now).toISOString(), deviceLabel: subject });
}
function pause(credentials, method, fail = false, key = GATEWAY_RECORD_KEY) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const original = credentials[method].bind(credentials);
  let armed = true;
  let calls = 0;
  credentials[method] = async (...args) => {
    calls++;
    const result = await original(...args);
    if (armed && (method !== 'readRecord' || args[0] === key)) {
      armed = false;
      entered.resolve();
      await released.promise;
      if (fail) throw new Error('synthetic gateway read failure');
    }
    return result;
  };
  return { entered: entered.promise, release: released.resolve, calls: () => calls };
}
function fixture(t, credentials, atomicFixtures = []) {
  let current = credentials;
  const service = createIamService(config, { ...gatewayAtomicOptions(...atomicFixtures), now: () => now, getCredentials: () => {
    if (current === 'throw') throw new Error('synthetic lookup failure');
    return current;
  }, fetch: async () => { throw new Error('unexpected network access'); } });
  t.after(() => service.dispose());
  return { service, replace: (next) => { current = next; } };
}

for (const method of ['readRecord', 'resolve', 'describe']) {
  for (const fail of [false, true]) {
    test(`gateway ${method} ${fail ? 'failure' : 'success'} from an old provider cannot publish over the replacement`, async (t) => {
      const old = new MemoryCredentials();
      const next = new MemoryCredentials();
      await seedKey(old, 'old-user');
      await seedKey(next, 'new-user');
      const { service, replace } = fixture(t, old);
      const gate = pause(old, method, fail);
      t.after(gate.release);
      const first = service.loadGatewayCredential({ force: true });
      await gate.entered;
      replace(next);
      const second = service.loadGatewayCredential({ force: true });
      gate.release();
      assert.equal(await first, null);
      assert.equal((await second).ownerSubject, 'new-user');
      assert.equal(service.getView().gatewayCredential.ownerSubject, 'new-user');
    });
  }
}

for (const method of ['readRecord', 'resolve', 'describe']) {
  test(`gateway ${method} completion checks the live provider without another entry rebinding it`, async (t) => {
    const old = new MemoryCredentials();
    const next = new MemoryCredentials();
    await seedKey(old, 'old-user');
    await seedKey(next, 'new-user');
    const { service, replace } = fixture(t, old);
    const gate = pause(old, method);
    t.after(gate.release);
    let nextResolves = 0;
    const resolve = next.resolve.bind(next);
    next.resolve = async (...args) => { nextResolves++; return resolve(...args); };
    const pending = service.loadGatewayCredential({ force: true });
    await gate.entered;
    replace(next);
    gate.release();
    assert.equal(await pending, null);
    assert.equal(service.getView().gatewayCredential, null);
    assert.equal(nextResolves, 0);
    assert.equal((await service.loadGatewayCredential({ force: true })).ownerSubject, 'new-user');
  });
}

for (const replacement of ['valid', 'unavailable', 'throw', 'invalid']) {
  test(`a warm gateway cache is not reused after provider replacement with ${replacement}`, async (t) => {
    const old = new MemoryCredentials();
    const next = new MemoryCredentials();
    await seedKey(old, 'old-user');
    await seedKey(next, 'new-user');
    const { service, replace } = fixture(t, old);
    assert.equal((await service.loadGatewayCredential()).ownerSubject, 'old-user');
    replace(replacement === 'valid' ? next : replacement === 'unavailable' ? undefined
      : replacement === 'invalid' ? {} : 'throw');
    const result = await service.loadGatewayCredential();
    if (replacement === 'valid') assert.equal(result.ownerSubject, 'new-user');
    else assert.equal(result, null);
    assert.notEqual(service.getView().gatewayCredential?.ownerSubject, 'old-user');
  });
}

test('an old gateway finalizer cannot release the newer provider singleflight guard', async (t) => {
  const old = new MemoryCredentials();
  const next = new MemoryCredentials();
  await seedKey(old, 'old-user');
  await seedKey(next, 'new-user');
  const { service, replace } = fixture(t, old);
  const firstGate = pause(old, 'readRecord');
  const secondGate = pause(next, 'readRecord');
  t.after(() => { firstGate.release(); secondGate.release(); });
  const first = service.loadGatewayCredential({ force: true });
  await firstGate.entered;
  replace(next);
  const second = service.loadGatewayCredential({ force: true });
  firstGate.release();
  await first;
  assert.equal(secondGate.calls(), 1);
  const third = service.loadGatewayCredential({ force: true });
  assert.equal(secondGate.calls(), 1);
  secondGate.release();
  assert.equal((await second).ownerSubject, 'new-user');
  assert.equal((await third).ownerSubject, 'new-user');
});

test('gateway matching does not borrow the cached IAM subject from another provider', async (t) => {
  const old = new MemoryCredentials();
  const next = new MemoryCredentials();
  await seedGrant(old);
  await seedKey(next, 'old-user');
  const { service, replace } = fixture(t, old);
  await service.hydrate();
  replace(next);
  assert.equal((await service.loadGatewayCredential({ force: true })).matchesAccount, false);
});

for (const replacement of ['empty', 'new-user', 'wrong-client']) {
  test(`saving a gateway credential uses the current provider grant, replacement=${replacement}`, async (t) => {
    const oldAtomic = createAtomicGatewayFixture();
    const nextAtomic = createAtomicGatewayFixture();
    const old = oldAtomic.credentials;
    const next = nextAtomic.credentials;
    await seedGrant(old);
    if (replacement !== 'empty') await seedGrant(next, 'new-user', replacement === 'wrong-client' ? 'another-client' : config.clientId);
    const { service, replace } = fixture(t, old, [oldAtomic, nextAtomic]);
    await service.hydrate();
    replace(next);
    if (replacement === 'new-user') {
      await service.saveGatewayCredential({ key: value });
      assert.equal((await createGatewayCredentialStore(next).read()).credential.ownerSubject, 'new-user');
    } else {
      await assert.rejects(service.saveGatewayCredential({ key: value }), { code: replacement === 'empty' ? 'IAM_NOT_SIGNED_IN' : 'IAM_GRANT_CONTEXT_MISMATCH' });
      assert.equal(await next.resolve(GATEWAY_REF), undefined);
      assert.equal((await createGatewayCredentialStore(next).read()).credential, null);
    }
    assert.equal(await old.resolve(GATEWAY_REF), undefined);
  });
}

test('saving a gateway credential does not reuse a stale subject on the same provider', async (t) => {
  const atomic = createAtomicGatewayFixture();
  const { credentials } = atomic;
  await seedGrant(credentials);
  const { service } = fixture(t, credentials, [atomic]);
  await service.hydrate();
  await seedGrant(credentials, 'new-user');
  await service.saveGatewayCredential({ key: value });
  assert.equal((await createGatewayCredentialStore(credentials).read()).credential.ownerSubject, 'new-user');
});

for (const change of ['provider', 'dispose']) {
  test(`a late clear cannot report success after ${change}`, async (t) => {
    const oldAtomic = createAtomicGatewayFixture();
    const nextAtomic = createAtomicGatewayFixture();
    const old = oldAtomic.credentials;
    const next = nextAtomic.credentials;
    for (const [atomic, subject] of [[oldAtomic, 'old-user'], [nextAtomic, 'new-user']]) {
      await createGatewayCredentialStore(atomic.credentials, atomic.options).save({ value, ownerSubject: subject,
        enteredAt: new Date(now).toISOString(), deviceLabel: subject });
    }
    const { service, replace } = fixture(t, old, [oldAtomic, nextAtomic]);
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    oldAtomic.adapter.afterCommit = async () => { entered.resolve(); await released.promise; };
    const gate = { entered: entered.promise, release: released.resolve };
    t.after(gate.release);
    const pending = service.clearGatewayCredential().then(() => null, (error) => error);
    await gate.entered;
    if (change === 'provider') { replace(next); await service.loadGatewayCredential({ force: true }); }
    else await service.dispose();
    gate.release();
    assert.equal((await pending)?.code, change === 'dispose' ? 'IAM_DISPOSED' : 'IAM_CREDENTIALS_UNAVAILABLE');
    assert.equal((await next.resolve(GATEWAY_REF)).value, value);
    assert.equal((await createGatewayCredentialStore(next).read()).credential.ownerSubject, 'new-user');
  });
}

for (const change of ['provider', 'dispose', 'signout']) {
  test(`a save awaiting the grant cannot write after ${change}`, async (t) => {
    const oldAtomic = createAtomicGatewayFixture();
    const old = oldAtomic.credentials;
    const next = new MemoryCredentials();
    await seedGrant(old);
    const { service, replace } = fixture(t, old, [oldAtomic]);
    const gate = pause(old, 'readRecord', false, GRANT_KEY);
    t.after(gate.release);
    const pending = service.saveGatewayCredential({ key: value }).then(() => null, (error) => error);
    await gate.entered;
    if (change === 'provider') {
      replace(next);
      await service.loadGatewayCredential({ force: true });
    } else if (change === 'dispose') await service.dispose();
    else await service.signOut();
    gate.release();
    const error = await pending;
    assert.equal(error?.code, change === 'dispose' ? 'IAM_DISPOSED'
      : change === 'provider' ? 'IAM_CREDENTIALS_UNAVAILABLE' : 'IAM_REAUTH_REQUIRED');
    assert.equal(await old.resolve(GATEWAY_REF), undefined);
    assert.equal(await next.resolve(GATEWAY_REF), undefined);
    assert.equal(oldAtomic.adapter.attempts, 0, 'an obsolete grant read must never reach gateway CAS');
  });
}
