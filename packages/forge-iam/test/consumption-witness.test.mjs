import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { readFile } from 'node:fs/promises';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createClientSecretFixture } from './support/client-secret-source.mjs';
import { authorization, signIn, hold } from './support/client-auth-service.mjs';

// This binder owns the actual getCredentials slot. No second signedIn state.
function providerBinder(initial) {
  let current = initial;
  let marker = Object.freeze({});
  const getCredentials = () => current;
  const getCredentialsBindingScope = () => current ? marker : undefined;
  return {
    getCredentials, getCredentialsBindingScope,
    bind(next) { marker = Object.freeze({}); current = next; },
    accepts(candidate, readers) {
      return candidate === current && current !== undefined
        && readers.getCredentials === getCredentials
        && readers.getCredentialsBindingScope === getCredentialsBindingScope;
    },
  };
}

async function harness(t, mode = 'public', extra = {}) {
  const method = mode === 'public' ? undefined : mode;
  const value = 'synthetic witness fixture';
  const mock = await startMockOidc({ ...(method ? { clientSecret: value, clientAuthMethod: method } : {}) });
  t.after(() => mock.close());
  const credentials = new MemoryCredentials();
  const binder = providerBinder(credentials);
  const fixture = method ? createClientSecretFixture(credentials, { issuer: mock.issuer, clientId: mock.clientId, method, value }) : undefined;
  const config = { ...mock.endpoints, clientId: mock.clientId, ...fixture?.config,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', ...extra.config };
  let source;
  let registeredIam;
  let unregistered = 0;
  const options = { ...fixture?.options, getCredentials: binder.getCredentials,
    getCredentialsBindingScope: binder.getCredentialsBindingScope,
    getOrigin: () => 'http://127.0.0.1:4567',
    verifyAtomicStore: (candidate) => candidate === credentials,
    verifyWitnessBindings(candidate, secretSource, scope, readers) {
      const common = binder.accepts(candidate, readers) && Object.isFrozen(scope) && Object.isFrozen(readers)
        && scope.issuer === mock.issuer && scope.clientId === mock.clientId;
      if (method) return common && fixture.acceptsWitnessBinding(secretSource, scope, readers)
        && Object.keys(scope).sort().join(',') === 'clientId,issuer,method,mode,ref'
        && Object.keys(readers).sort().join(',') === 'getClientSecretBindingScope,getClientSecretSource,getCredentials,getCredentialsBindingScope';
      return common && secretSource === undefined && scope.mode === 'public' && scope.method === 'none'
        && Object.keys(scope).sort().join(',') === 'clientId,issuer,method,mode'
        && Object.keys(readers).sort().join(',') === 'getCredentials,getCredentialsBindingScope';
    },
    registerWitness(iam, witness) { registeredIam = iam; source = witness; return () => { unregistered++; }; },
    ...extra.options };
  const service = createIamService(config, options);
  t.after(() => service.dispose());
  return { service, mock, credentials, fixture, binder, config, options,
    get source() { assert.ok(source, 'actual factory must register its witness source'); return source; },
    get registeredIam() { return registeredIam; }, get unregistered() { return unregistered; } };
}

for (const mode of ['public', 'client_secret_basic', 'client_secret_post']) {
  test(`actual ${mode} factory witnesses only successfully adopted sessions, restore and refresh`, async (t) => {
    const h = await harness(t, mode, { config: { refreshSkewSeconds: 7200 } });
    assert.equal(h.registeredIam, h.service);
    assert.equal(h.source.capture(), undefined);
    await signIn(h);
    const original = h.source.capture();
    assert.ok(original);
    assert.deepEqual(Object.keys(original).sort(), ['issuer', 'pin', 'subject']);
    assert.ok(Object.isFrozen(original)); assert.ok(Object.isFrozen(original.pin));
    assert.deepEqual(Object.keys(original.pin), []);
    assert.equal(original.issuer, h.mock.issuer);
    assert.equal(original.subject, h.service.getPrincipal().subject);
    assert.equal(h.source.isCurrent(original), true);
    assert.equal(h.source.isCurrent({ ...original }), false);
    assert.equal(h.source.isCurrent(Object.freeze({ ...original, pin: Object.freeze({}) })), false);
    const restored = createIamService(h.config, h.options); t.after(() => restored.dispose());
    const restoredSource = h.source;
    assert.equal(restoredSource.capture(), undefined);
    await restored.hydrate();
    assert.ok(restoredSource.capture());
    assert.equal(restoredSource.isCurrent(original), false);
    await restored.resolveToken();
    assert.equal(h.mock.counts.refresh, 1);
    assert.ok(restoredSource.capture());
  });
}

test('public witness path does not even access either secret-source option property', async (t) => {
  const h = await harness(t);
  for (const key of ['getClientSecretSource', 'getClientSecretBindingScope']) {
    Object.defineProperty(h.options, key, { get() { assert.fail(`public accessed ${key}`); } });
  }
  await signIn(h);
  const original = h.source.capture(); assert.ok(original);
  assert.equal(h.source.isCurrent(original), true);
});

test('provider same-object ABA invalidates cached ready without a sync or a new witness', async (t) => {
  const h = await harness(t); await signIn(h);
  const original = h.source.capture(); assert.ok(original);
  h.binder.bind(undefined); h.binder.bind(h.credentials);
  assert.equal(h.service.getView().state, 'ready');
  assert.equal(h.source.isCurrent(original), false);
  assert.equal(h.source.capture(), undefined);
  await h.service.syncFromStore();
  const next = h.source.capture(); assert.ok(next);
  assert.notEqual(next.pin, original.pin);
  assert.equal(h.source.isCurrent(original), false);
});

for (const flow of ['callback', 'hydrate', 'resolve']) {
  test(`${flow} fixes provider scope before its first adoption await, never retrospectively endorses ABA`, async (t) => {
    const h = await harness(t);
    const callback = await authorization(h.service);
    if (flow !== 'callback') await h.service.handleCallback(callback);
    let target = h.service;
    if (flow === 'hydrate') { target = createIamService(h.config, h.options); t.after(() => target.dispose()); }
    const gate = hold(); t.after(gate.release);
    let pending;
    if (flow === 'callback') {
      const originalFetch = globalThis.fetch;
      h.options.fetch = originalFetch; // factory fetch is fixed; hold the actual store commit instead
      const modify = h.credentials.modifyRecord.bind(h.credentials);
      h.credentials.modifyRecord = async (...args) => { await gate.pause(); return modify(...args); };
      pending = target.handleCallback(callback);
    } else {
      const read = h.credentials.readRecord.bind(h.credentials);
      let first = true;
      h.credentials.readRecord = async (...args) => { if (first) { first = false; await gate.pause(); } return read(...args); };
      pending = flow === 'hydrate' ? target.hydrate() : target.resolveToken();
    }
    await gate.entered;
    h.binder.bind(undefined); h.binder.bind(h.credentials);
    gate.release(); await pending;
    assert.equal(target.getView().state, 'ready', 'missing witness signal must not change original service semantics');
    assert.equal(h.source.capture(), undefined, 'fresh marker after await cannot endorse old adoption chain');
  });
}

for (const change of ['rotate', 'remove-restore', 'unbind-rebind']) {
  test(`actual secret controller ${change} invalidates old ready, including same snapshot/revision restore`, async (t) => {
    const h = await harness(t, 'client_secret_basic'); await signIn(h);
    const original = h.source.capture(); assert.ok(original);
    const snapshot = h.fixture.snapshot();
    if (change === 'rotate') h.fixture.replace(snapshot.value);
    else if (change === 'remove-restore') { h.fixture.remove(); h.fixture.restore(snapshot); }
    else {
      h.fixture.bind(undefined);
      assert.equal(h.options.getClientSecretSource(), undefined, 'controller must actually unbind its source');
      assert.equal(h.options.getClientSecretBindingScope(), undefined);
      h.fixture.bind(h.fixture.source);
    }
    assert.equal(h.service.getView().state, 'ready');
    assert.equal(h.source.isCurrent(original), false);
    assert.equal(h.source.capture(), undefined);
  });
}

test('secret marker is sampled after concrete recognition and before source.read awaits', async (t) => {
  const h = await harness(t, 'client_secret_basic');
  const callback = await authorization(h.service);
  const gate = hold(); t.after(gate.release);
  h.fixture.setReadBarrier(() => gate.pause());
  const pending = h.service.handleCallback(callback);
  await gate.entered;
  const snapshot = h.fixture.snapshot(); h.fixture.remove(); h.fixture.restore(snapshot);
  gate.release(); await pending;
  assert.equal(h.service.getView().state, 'ready');
  assert.equal(h.source.capture(), undefined);
});

for (const mode of ['public', 'client_secret_basic']) {
  const keys = ['getCredentials', 'getCredentialsBindingScope', ...(mode === 'public' ? [] : ['getClientSecretSource', 'getClientSecretBindingScope'])];
  for (const key of keys) {
    test(`${mode} registry rejects forged ${key} function even with the exact same return value`, async (t) => {
      const h = await harness(t, mode);
      const reader = h.options[key]; h.options[key] = () => reader();
      await signIn(h);
      assert.equal(h.source.capture(), undefined);
    });
    test(`${mode} ${key} replacement withdraws old witness even when marker and instance match`, async (t) => {
      const h = await harness(t, mode); await signIn(h);
      const original = h.source.capture(); assert.ok(original);
      const reader = h.options[key]; h.options[key] = () => reader();
      assert.equal(h.source.isCurrent(original), false);
      h.options[key] = reader;
      assert.equal(h.source.isCurrent(original), false, 'observed replacement cannot revive a pin');
      assert.equal(h.source.capture(), undefined);
    });
  }
}

for (const result of ['false', 'boxed-true', 'promise-true', 'promise-reject', 'throw']) {
  test(`witness verifier ${result} is fail-closed without changing successful IAM login`, async (t) => {
    const h = await harness(t);
    h.options.verifyWitnessBindings = () => {
      if (result === 'boxed-true') return new Boolean(true);
      if (result === 'promise-true') return Promise.resolve(true);
      if (result === 'promise-reject') return Promise.reject(new Error('synthetic-private-error'));
      if (result === 'throw') throw new Error('synthetic-private-error');
      return false;
    };
    await signIn(h);
    assert.equal(h.source.capture(), undefined);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

for (const result of ['missing', 'undefined', 'mutable', 'nonempty', 'promise', 'reject', 'throw', 'property-throw']) {
  test(`binding getter ${result} cannot endorse cached ready or authorize adoption`, async (t) => {
    const h = await harness(t); await signIn(h);
    const original = h.source.capture(); assert.ok(original);
    if (result === 'missing') delete h.options.getCredentialsBindingScope;
    else if (result === 'property-throw') Object.defineProperty(h.options, 'getCredentialsBindingScope', { get() { throw new Error('synthetic-private-error'); } });
    else h.options.getCredentialsBindingScope = () => {
      if (result === 'mutable') return {};
      if (result === 'nonempty') return Object.freeze({ trusted: true });
      if (result === 'promise') return Promise.resolve(Object.freeze({}));
      if (result === 'reject') return Promise.reject(new Error('synthetic-private-error'));
      if (result === 'throw') throw new Error('synthetic-private-error');
      return undefined;
    };
    assert.equal(h.source.isCurrent(original), false);
    assert.equal(h.source.capture(), undefined);
    await h.service.syncFromStore();
    assert.equal(h.service.getView().state, 'ready');
    assert.equal(h.source.capture(), undefined);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

for (const action of ['cancelSignIn', 'signOut', 'dispose']) {
  test(`${action} invalidates a ready witness synchronously before the first await`, async (t) => {
    const h = await harness(t, 'client_secret_basic'); await signIn(h);
    const source = h.source; const original = source.capture(); assert.ok(original);
    const pending = h.service[action]();
    assert.equal(source.isCurrent(original), false);
    assert.equal(source.capture(), undefined);
    await pending;
    if (action === 'dispose') {
      assert.equal(h.unregistered, 1);
      await h.service.dispose(); assert.equal(h.unregistered, 1);
    }
  });
}

test('marker churn alone never creates a session or repairs old ready; revalidation is required', async (t) => {
  const h = await harness(t);
  h.binder.bind(h.credentials);
  assert.equal(h.source.capture(), undefined);
  await signIn(h);
  const original = h.source.capture(); assert.ok(original);
  h.binder.bind(h.credentials);
  assert.equal(h.source.capture(), undefined);
  assert.equal(h.source.isCurrent(original), false);
  await h.service.syncFromStore();
  const next = h.source.capture(); assert.ok(next);
  assert.notEqual(next.pin, original.pin);
});

test('expiry is checked synchronously, and no clock rollback revives the old witness', async (t) => {
  let clock = Date.now();
  const h = await harness(t, 'public', { options: { now: () => clock } }); await signIn(h);
  const original = h.source.capture(); assert.ok(original);
  const before = clock;
  clock = Date.parse(h.service.getView().accessExpiresAt);
  assert.equal(h.source.isCurrent(original), false);
  assert.equal(h.source.capture(), undefined);
  clock = before;
  assert.equal(h.source.isCurrent(original), false);
  assert.equal(h.source.capture(), undefined);
});

test('V1 without session identity is not restored and is left unchanged', async (t) => {
  const h = await harness(t); await signIn(h);
  const record = h.credentials.records.get('heluo-iam/session');
  delete record.payload.sessionInstanceId;
  const before = structuredClone(record);
  const restored = createIamService(h.config, h.options); t.after(() => restored.dispose());
  await restored.hydrate();
  assert.equal(restored.getView().state, 'error');
  assert.equal(h.source.capture(), undefined);
  assert.deepEqual(h.credentials.records.get('heluo-iam/session'), before);
});

test('missing witness opt-in never probes private binding getter properties in ordinary service paths', async (t) => {
  const h = await harness(t);
  const options = { credentials: h.credentials, getOrigin: () => 'http://127.0.0.1:4567', verifyAtomicStore: (candidate) => candidate === h.credentials };
  for (const key of ['getCredentialsBindingScope', 'getClientSecretBindingScope', 'verifyWitnessBindings']) {
    Object.defineProperty(options, key, { get() { assert.fail(`ordinary path probed ${key}`); } });
  }
  const service = createIamService(h.config, options); t.after(() => service.dispose());
  await signIn({ service }); await service.hydrate(); await service.resolveToken(); await service.signOut();
});

test('untrusted confidential source is rejected before any witness binding marker is sampled', async (t) => {
  const h = await harness(t, 'client_secret_basic');
  h.options.verifyClientSecretSource = () => false;
  let sampled = 0;
  h.options.getClientSecretBindingScope = () => { sampled++; return Object.freeze({}); };
  await assert.rejects(h.service.startSignIn(), { code: 'IAM_CLIENT_AUTH_UNVERIFIED' });
  assert.equal(sampled, 0);
  assert.equal(h.fixture.counts.read, 0);
  assert.equal(h.source.capture(), undefined);
});

test('a throwing active-state check cannot leak an exception through the read-only witness', async (t) => {
  const h = await harness(t); await signIn(h);
  const original = h.source.capture(); assert.ok(original);
  h.options.recheckExclusive = () => { throw new Error('synthetic-private-error'); };
  assert.equal(h.source.isCurrent(original), false);
  assert.equal(h.source.capture(), undefined);
});

test('a synchronous recheck that rebinds the provider cannot return a stale current witness', async (t) => {
  const h = await harness(t); await signIn(h);
  const original = h.source.capture(); assert.ok(original);
  let once = true;
  h.options.recheckExclusive = () => { if (once) { once = false; h.binder.bind(h.credentials); } return { ok: true }; };
  assert.equal(h.source.isCurrent(original), false);
  assert.equal(h.source.capture(), undefined);
});

for (const flow of ['hydrate', 'refresh']) {
  test(`${flow} fixes secret scope before initial grant read, not merely before later source.read`, async (t) => {
    const h = await harness(t, 'client_secret_basic', { config: { refreshSkewSeconds: 7200 } });
    await signIn(h);
    let target = h.service;
    if (flow === 'hydrate') { target = createIamService(h.config, h.options); t.after(() => target.dispose()); }
    const gate = hold(); t.after(gate.release);
    const read = h.credentials.readRecord.bind(h.credentials);
    let first = true;
    h.credentials.readRecord = async (...args) => { if (first) { first = false; await gate.pause(); } return read(...args); };
    const pending = flow === 'hydrate' ? target.hydrate() : target.resolveToken();
    await gate.entered;
    const snapshot = h.fixture.snapshot(); h.fixture.remove(); h.fixture.restore(snapshot);
    gate.release(); await pending;
    assert.equal(target.getView().state, 'ready');
    assert.equal(h.source.capture(), undefined);
    assert.equal(h.mock.counts.refresh, flow === 'refresh' ? 1 : 0);
  });
}

for (const mode of ['public', 'client_secret_basic']) {
  test(`${mode} start freezes binding before metadata await and callback cannot rehabilitate it`, async (t) => {
    const h = await harness(t, mode);
    const pending = h.service.startSignIn();
    h.binder.bind(undefined); h.binder.bind(h.credentials);
    const started = await pending;
    const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
    assert.equal(response.status, 302);
    await h.service.handleCallback(response.headers.get('location'));
    assert.equal(h.service.getView().state, 'ready');
    assert.equal(h.source.capture(), undefined);
  });
}

test('callback cannot repair an unverified start stage by acquiring a newly available marker', async (t) => {
  const h = await harness(t);
  const originalVerifier = h.options.verifyWitnessBindings;
  h.options.verifyWitnessBindings = () => false;
  const callback = await authorization(h.service);
  h.options.verifyWitnessBindings = originalVerifier;
  await h.service.handleCallback(callback);
  assert.equal(h.service.getView().state, 'ready');
  assert.equal(h.source.capture(), undefined);
});

test('capture/current never read a secret snapshot or invoke IAM-002 snapshot current', async (t) => {
  const h = await harness(t, 'client_secret_basic'); await signIn(h);
  const before = { ...h.fixture.counts };
  const original = h.source.capture(); assert.ok(original);
  assert.equal(h.source.isCurrent(original), true);
  assert.equal(h.source.isCurrent(original), true);
  assert.equal(h.fixture.counts.read, before.read);
  assert.equal(h.fixture.counts.current, before.current);
});

test('successful new login cannot rescue an original witness from the old session', async (t) => {
  const h = await harness(t, 'client_secret_post'); await signIn(h);
  const original = h.source.capture(); assert.ok(original);
  await h.service.signOut(); await signIn(h);
  const next = h.source.capture(); assert.ok(next);
  assert.equal(next.subject, original.subject);
  assert.notEqual(next.pin, original.pin);
  assert.equal(h.source.isCurrent(original), false);
  assert.equal(h.source.isCurrent(next), true);
});

for (const result of ['promise', 'throw']) {
  test(`invalid registration ${result} cannot leave an authorizing source`, async (t) => {
    const h = await harness(t);
    let source;
    const service = createIamService(h.config, { ...h.options, registerWitness(iam, candidate) {
      source = candidate;
      if (result === 'throw') throw new Error('synthetic-private-error');
      return Promise.reject(new Error('synthetic-private-error'));
    } });
    t.after(() => service.dispose());
    await signIn({ service });
    assert.equal(source.capture(), undefined);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test('explicit isolated-testing subpath exports the actual factory inside the existing package files', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./isolated-testing'], './src/isolated-testing.mjs');
  assert.ok(manifest.files.includes('src'));
  const testing = await import('@heluo/forge-iam/isolated-testing');
  assert.deepEqual(Object.keys(testing).sort(), ['createIamService', 'createIamViewConsumer', 'createIamViewObserver']);
  assert.equal(testing.createIamService, createIamService);
});
