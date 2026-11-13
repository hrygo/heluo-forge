import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { apply } from '../src/index.mjs';
import { createManagedModelRuntime } from '../src/managed-models.mjs';
import { createServiceGateway } from '../src/service-gateway.mjs';
import { createIamService } from '../src/service.mjs';
import { createGatewayCredentialStore, createGrantStore, GATEWAY_RECORD_KEY, GRANT_KEY } from '../src/store.mjs';
import { createAtomicGatewayFixture, seedGateway } from './support/atomic-gateway.mjs';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const config = {
  issuer: 'https://iam.corp.example', clientId: 'synthetic-client',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
};
const input = { key: 'synthetic-new-key', deviceLabel: 'test-device' };

async function setup(t, { existing = false, gatewayBaseURL, serviceConfig = config } = {}) {
  const fixture = createAtomicGatewayFixture();
  await createGrantStore(fixture.credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    issuer: config.issuer, clientId: config.clientId, subject: 'synthetic-subject',
    accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', scope: 'openid',
    obtainedAt: new Date(now - 60000).toISOString(), accessExpiresAt: new Date(now + 3600000).toISOString(),
  });
  if (existing) seedGateway(fixture.credentials, {
    value: 'synthetic-existing-key', ownerSubject: 'synthetic-subject', enteredAt: new Date(now).toISOString(),
    ...(gatewayBaseURL ? { baseURL: gatewayBaseURL } : {}),
  });
  const service = createIamService(serviceConfig, {
    credentials: fixture.credentials, now: () => now, ...fixture.options,
    fetch: async () => { throw new Error('unexpected network'); },
  });
  t.after(() => service.dispose());
  return { ...fixture, service };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation did not settle promptly')), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('a completed save bypasses an older read and its late result cannot overwrite the committed view', async (t) => {
  const f = await setup(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const describe = f.credentials.describe.bind(f.credentials);
  let first = true;
  f.credentials.describe = async (...args) => {
    const snapshot = await describe(...args);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return snapshot;
  };
  t.after(release.resolve);
  const oldRead = f.service.loadGatewayCredential({ force: true });
  await entered.promise;
  const save = f.service.saveGatewayCredential(input);
  try {
    const view = await promptly(save);
    const generation = f.pair().record.payload.writeOperationId;
    assert.equal(f.adapter.commits, 1);
    assert.equal(view.gatewayCredential.state, 'configured');
    assert.equal(view.gatewayCredential.generation, generation);
    release.resolve();
    assert.equal(await oldRead, null);
    assert.equal(f.service.getView().gatewayCredential.generation, generation);
    assert.equal(JSON.stringify(view).includes(input.key), false);
  } finally { release.resolve(); await Promise.allSettled([oldRead, save]); }
});

test('an indefinitely stalled post-commit read reports unknown without repeating or deleting the write', async (t) => {
  const f = await setup(t, { existing: true });
  await f.service.hydrate();
  assert.equal(f.service.getView().gatewayCredential.state, 'configured');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const read = f.credentials.readRecord.bind(f.credentials);
  let committed = false;
  f.adapter.afterCommit = () => { committed = true; };
  f.credentials.readRecord = async (key) => {
    if (key === GATEWAY_RECORD_KEY && committed) { entered.resolve(); await release.promise; }
    return read(key);
  };
  t.after(release.resolve);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled;
  const save = f.service.saveGatewayCredential(input).then(
    (view) => { settled = { view }; }, (error) => { settled = { error }; },
  );
  try {
    await entered.promise;
    t.mock.timers.tick(15000);
    await nextTurn();
    assert.equal(settled?.error?.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    assert.equal(f.adapter.attempts, 1);
    assert.equal(f.adapter.commits, 1);
    assert.equal(f.pair().value, input.key);
    assert.notEqual(f.service.getView().gatewayCredential?.state, 'configured');
    release.resolve();
    await nextTurn();
    assert.notEqual(f.service.getView().gatewayCredential?.state, 'configured');
  } finally { release.resolve(); await save; }
});

test('an empty post-commit read cannot report success or change the committed pair', async (t) => {
  const f = await setup(t, { existing: true });
  await f.service.hydrate();
  assert.equal(f.service.getView().gatewayCredential.state, 'configured');
  const read = f.credentials.readRecord.bind(f.credentials);
  let committed = false;
  f.adapter.afterCommit = () => { committed = true; };
  f.credentials.readRecord = async (key) => key === GATEWAY_RECORD_KEY && committed ? undefined : read(key);
  await assert.rejects(f.service.saveGatewayCredential(input), { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
  assert.equal(f.adapter.attempts, 1);
  assert.equal(f.adapter.commits, 1);
  assert.equal(f.pair().value, input.key);
  assert.notEqual(f.service.getView().gatewayCredential?.state, 'configured');
});

test('a newer gateway generation cannot confirm an earlier committed save', async (t) => {
  const f = await setup(t, { existing: true });
  f.adapter.afterCommit = async () => {
    f.adapter.afterCommit = null;
    await createGatewayCredentialStore(f.credentials, f.options).save({
      value: 'synthetic-later-key', ownerSubject: 'synthetic-subject', enteredAt: new Date(now).toISOString(),
    });
  };
  await assert.rejects(f.service.saveGatewayCredential(input), { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
  assert.equal(f.adapter.attempts, 2);
  assert.equal(f.adapter.commits, 2);
  assert.equal(f.pair().value, 'synthetic-later-key');
  assert.notEqual(f.service.getView().gatewayCredential?.state, 'configured');
});

test('a changed stored identity after commit cannot confirm the old identity save', async (t) => {
  const f = await setup(t, { existing: true });
  f.adapter.afterCommit = async () => {
    await createGrantStore(f.credentials).write({
      version: 1, sessionInstanceId: Buffer.alloc(32, 8).toString('base64url'),
      issuer: config.issuer, clientId: config.clientId, subject: 'synthetic-other-subject',
      accessToken: 'synthetic-other-access', refreshToken: 'synthetic-other-refresh', scope: 'openid',
      obtainedAt: new Date(now - 60000).toISOString(), accessExpiresAt: new Date(now + 3600000).toISOString(),
    });
  };
  await assert.rejects(f.service.saveGatewayCredential(input), { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
  assert.equal(f.adapter.commits, 1);
  assert.equal(f.pair().value, input.key);
  assert.notEqual(f.service.getView().gatewayCredential?.state, 'configured');
});

test('a gateway replacement while the post-commit identity read waits cannot confirm an old generation', async (t) => {
  const f = await setup(t, { existing: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const read = f.credentials.readRecord.bind(f.credentials);
  let pause = true;
  f.credentials.readRecord = async (key) => {
    const record = await read(key);
    if (key === GRANT_KEY && f.adapter.commits > 0 && pause) {
      pause = false;
      entered.resolve();
      await release.promise;
    }
    return record;
  };
  t.after(release.resolve);
  const save = f.service.saveGatewayCredential(input).then(() => null, (error) => error);
  await entered.promise;
  try {
    await createGatewayCredentialStore(f.credentials, f.options).save({
      value: 'synthetic-later-key', ownerSubject: 'synthetic-subject', enteredAt: new Date(now).toISOString(),
    });
    release.resolve();
    assert.equal((await promptly(save))?.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    assert.equal(f.adapter.commits, 2);
    assert.equal(f.pair().value, 'synthetic-later-key');
    assert.notEqual(f.service.getView().gatewayCredential?.state, 'configured');
  } finally { release.resolve(); await save; }
});

test('a gateway saved while a clear reads storage cannot confirm an obsolete empty state', async (t) => {
  const f = await setup(t, { existing: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const describe = f.credentials.describe.bind(f.credentials);
  let pause = true;
  f.credentials.describe = async (...args) => {
    const result = await describe(...args);
    if (f.adapter.commits > 0 && pause) { pause = false; entered.resolve(); await release.promise; }
    return result;
  };
  t.after(release.resolve);
  const clear = f.service.clearGatewayCredential().then(() => null, (error) => error);
  await entered.promise;
  try {
    await createGatewayCredentialStore(f.credentials, f.options).save({
      value: 'synthetic-later-key', ownerSubject: 'synthetic-subject', enteredAt: new Date(now).toISOString(),
    });
    release.resolve();
    assert.equal((await promptly(clear))?.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    assert.equal(f.adapter.commits, 2);
    assert.equal(f.pair().value, 'synthetic-later-key');
    assert.notEqual(f.service.getView().gatewayCredential?.state, 'unconfigured');
  } finally { release.resolve(); await clear; }
});

test('a joined gateway read settles on confirmation timeout and a later read can recover', async (t) => {
  const f = await setup(t, { existing: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const read = f.credentials.readRecord.bind(f.credentials);
  let pause = true;
  f.credentials.readRecord = async (key) => {
    if (key === GATEWAY_RECORD_KEY && f.adapter.commits > 0 && pause) {
      pause = false;
      entered.resolve();
      await release.promise;
    }
    return read(key);
  };
  t.after(release.resolve);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let saveResult;
  let readResult = 'pending';
  const save = f.service.saveGatewayCredential(input).then(() => null, (error) => error)
    .then((result) => { saveResult = result; });
  try {
    await entered.promise;
    const joined = f.service.loadGatewayCredential({ force: true }).then((result) => { readResult = result; }, (error) => { readResult = error; });
    t.mock.timers.tick(15000);
    await nextTurn();
    assert.equal(saveResult?.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    assert.equal(readResult, null);
    const refreshed = await f.service.loadGatewayCredential({ force: true });
    assert.equal(refreshed.generation, f.pair().record.payload.writeOperationId);
    release.resolve();
    await joined;
    await nextTurn();
    assert.equal(f.service.getView().gatewayCredential.generation, refreshed.generation);
    assert.equal(f.adapter.commits, 1);
  } finally { release.resolve(); await save; }
});

test('a failed joined confirmation does not discard a newly adopted account', async (t) => {
  const f = await setup(t, { existing: true });
  await f.service.hydrate();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const read = f.credentials.readRecord.bind(f.credentials);
  let pause = true;
  f.credentials.readRecord = async (key) => {
    if (key === GATEWAY_RECORD_KEY && f.adapter.commits > 0 && pause) {
      pause = false; entered.resolve(); await release.promise;
    }
    return read(key);
  };
  t.after(release.resolve);
  const save = f.service.saveGatewayCredential(input).then(() => null, (error) => error);
  await entered.promise;
  await createGrantStore(f.credentials).write({
    version: 1, sessionInstanceId: Buffer.alloc(32, 8).toString('base64url'),
    issuer: config.issuer, clientId: config.clientId, subject: 'synthetic-other-subject',
    accessToken: 'synthetic-other-access', refreshToken: 'synthetic-other-refresh', scope: 'openid',
    obtainedAt: new Date(now - 60000).toISOString(), accessExpiresAt: new Date(now + 3600000).toISOString(),
  });
  const sync = f.service.syncFromStore();
  try {
    await nextTurn();
    release.resolve();
    assert.equal((await promptly(save))?.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    const view = await promptly(sync);
    assert.equal(view.state, 'ready');
    assert.equal(view.principal, 'synthetic-other-subject');
    assert.notEqual(view.gatewayCredential?.matchesAccount, true);
  } finally { release.resolve(); await Promise.allSettled([save, sync]); }
});

test('an earlier commit receipt arriving late does not erase a newer confirmed gateway view', async (t) => {
  const f = await setup(t, { existing: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.adapter.afterCommit = async () => {
    if (f.adapter.commits === 1) { entered.resolve(); await release.promise; }
  };
  t.after(release.resolve);
  const first = f.service.saveGatewayCredential(input).then(() => null, (error) => error);
  await entered.promise;
  try {
    const second = await promptly(f.service.saveGatewayCredential({ key: 'synthetic-later-key' }));
    const generation = second.gatewayCredential.generation;
    release.resolve();
    assert.equal((await promptly(first))?.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    assert.equal(f.adapter.commits, 2);
    assert.equal(f.pair().value, 'synthetic-later-key');
    assert.equal(f.service.getView().gatewayCredential.generation, generation);
  } finally { release.resolve(); await first; }
});

for (const newerPublication of [false, true]) {
  test(`a reentrant auth change ${newerPublication ? 'preserves a newer publication' : 'withdraws this operation\'s publication'}`, async () => {
    let authEpoch = 0;
    const grant = {
      version: 1, issuer: config.issuer, clientId: config.clientId,
      subject: 'synthetic-subject', sessionInstanceId: 'synthetic-session',
    };
    const targetStore = { async read() { return { ok: true, grant }; } };
    let payload;
    const targetGatewayStore = {
      async save(data, { guard }) {
        assert.equal(guard(), true);
        const { value: _value, ...metadata } = data;
        payload = { ...metadata, writeOperationId: 'synthetic-own-generation' };
        // Model a later operation having published while this receipt waited.
        provider.gatewayEpoch += 1;
        provider.gatewaySummary = { state: 'configured', generation: 'synthetic-prior-generation' };
        return { credential: payload };
      },
      async read() { return { ok: true, credential: payload }; },
      async resolve() { return { value: 'synthetic-key' }; },
      async describe() { return { configured: true }; },
    };
    const provider = {
      gatewayStore: targetGatewayStore, storeCredentials: {}, gatewayLoadedAt: 0,
      gatewayLoading: null, gatewaySummary: null, gatewayEpoch: 0,
      require() { return targetStore; }, ensure() { return targetStore; },
    };
    const ctx = {
      disposed: false, state: 'ready', lastGrant: grant,
      assertExclusive() {}, knownIssuer() { return grant.issuer; }, notify() {},
      view() { return { gatewayCredential: provider.gatewaySummary }; },
    };
    const gateway = createServiceGateway({
      config: {}, ctx, provider,
      grants: { assertGrantContext() {}, async prepareAuthentication() {}, ownerOf() { return targetStore; } },
      now: () => now, configured: true, getAuthEpoch: () => authEpoch,
      isSigningOut: () => false, bumpGeneration() {},
      selection: { inFlight: false, schedule() {
        authEpoch += 1;
        if (newerPublication) {
          provider.gatewayEpoch += 1;
          provider.gatewaySummary = { state: 'configured', generation: 'synthetic-newer-generation' };
        }
      } },
    });
    await assert.rejects(gateway.saveCredential({ key: 'synthetic-key' }), { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
    if (newerPublication) assert.equal(provider.gatewaySummary?.generation, 'synthetic-newer-generation');
    else assert.equal(provider.gatewaySummary, null);
  });
}

for (const operation of ['save', 'clear']) {
  test(`an unknown ${operation} result fences a read begun before its commit`, async (t) => {
    const f = await setup(t, { existing: true });
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const describe = f.credentials.describe.bind(f.credentials);
    let pause = true;
    f.credentials.describe = async (...args) => {
      const snapshot = await describe(...args);
      if (pause) { pause = false; entered.resolve(); await release.promise; }
      return snapshot;
    };
    t.after(release.resolve);
    const oldRead = f.service.loadGatewayCredential({ force: true });
    await entered.promise;
    f.adapter.afterCommit = () => { throw new Error('synthetic lost receipt'); };
    const mutation = operation === 'save' ? f.service.saveGatewayCredential(input) : f.service.clearGatewayCredential();
    try {
      await assert.rejects(mutation, { code: 'IAM_GATEWAY_WRITE_UNKNOWN' });
      release.resolve();
      assert.equal(await oldRead, null);
      assert.equal(f.adapter.commits, 1);
      assert.equal(f.pair().value, operation === 'save' ? input.key : undefined);
      assert.notEqual(f.service.getView().gatewayCredential?.state, 'configured');
    } finally { release.resolve(); await Promise.allSettled([oldRead, mutation]); }
  });
}

test('a lost earlier receipt cannot erase a later confirmed gateway view', async (t) => {
  const f = await setup(t, { existing: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.adapter.afterCommit = async () => {
    if (f.adapter.commits === 1) { entered.resolve(); await release.promise; throw new Error('synthetic lost receipt'); }
  };
  t.after(release.resolve);
  const first = f.service.saveGatewayCredential(input).then(() => null, (error) => error);
  await entered.promise;
  try {
    const second = await promptly(f.service.saveGatewayCredential({ key: 'synthetic-later-key' }));
    const generation = second.gatewayCredential.generation;
    release.resolve();
    assert.equal((await promptly(first))?.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    assert.equal(f.adapter.commits, 2);
    assert.equal(f.pair().value, 'synthetic-later-key');
    assert.equal(f.service.getView().gatewayCredential.generation, generation);
  } finally { release.resolve(); await first; }
});

test('saving a key at the same address does not abort a model answer already in progress', async (t) => {
  const baseURL = 'https://gateway.corp.example/v1';
  const serviceConfig = { ...config, defaultProvider: 'enterprise', managedModels: { baseURL } };
  const f = await setup(t, { existing: true, gatewayBaseURL: baseURL, serviceConfig });
  await f.service.hydrate();
  await f.service.loadGatewayCredential({ force: true });
  const releaseStream = Promise.withResolvers();
  const releaseConfirmation = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let adapter;
  let transportSignal;
  const host = {
    llm: { registerAdapter(_providers, registered) { adapter = registered; return () => {}; } },
    on() { return () => {}; }, emit() {},
  };
  const runtime = createManagedModelRuntime({
    host, iam: f.service, config: serviceConfig,
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'enterprise-chat' }] })),
    requestHeaders: async () => ({}),
    createAdapter: async () => ({
      async prepareCall(provider, model) {
        return { model: { provider, id: model }, async *stream({ signal }) {
          transportSignal = signal;
          yield { type: 'text', text: 'started' };
          await releaseStream.promise;
          if (signal.aborted) throw new Error('request aborted');
          yield { type: 'finish', reason: { kind: 'stop' } };
        } };
      },
    }),
  });
  t.after(async () => { releaseStream.resolve(); releaseConfirmation.resolve(); await runtime.dispose(); });
  await runtime.ready;
  const request = { provider: 'enterprise', model: 'enterprise-chat', messages: [] };
  const prepared = await adapter.prepareCall(request.provider, request.model);
  const stream = prepared.stream(request);
  assert.equal((await stream.next()).value.text, 'started');
  const read = f.credentials.readRecord.bind(f.credentials);
  let pause = true;
  f.credentials.readRecord = async (key) => {
    if (key === GATEWAY_RECORD_KEY && f.adapter.commits > 0 && pause) {
      pause = false; entered.resolve(); await releaseConfirmation.promise;
    }
    return read(key);
  };
  const save = f.service.saveGatewayCredential({ ...input, baseURL });
  try {
    await entered.promise;
    await nextTurn();
    assert.equal(transportSignal.aborted, false);
    releaseStream.resolve();
    assert.equal((await stream.next()).value.reason.kind, 'stop');
    releaseConfirmation.resolve();
    await save;
  } finally { releaseStream.resolve(); releaseConfirmation.resolve(); await Promise.allSettled([save]); }
});

test('host debug diagnostics contain only fixed gateway stages and elapsed time', async (t) => {
  const f = await setup(t);
  const events = [];
  const services = new Map();
  const trusted = { verify: (value) => value === f.credentials, adapter: () => f.adapter };
  const ctx = {
    credentials: f.credentials, 'iam-atomic-store': trusted,
    logger: { debug: (message) => events.push(message) },
    get: () => undefined,
    provide(name, value) { services.set(name, value); return () => services.delete(name); },
    effect(callback) { return callback(); },
  };
  const teardown = apply(ctx, config);
  t.after(teardown);
  await services.get('iam').saveGatewayCredential(input);
  assert.deepEqual(events.map((event) => event.replace(/ \d+ms$/, '')), [
    'forge-iam: gateway-save start', 'forge-iam: gateway-save grant-read',
    'forge-iam: gateway-save authentication-ready', 'forge-iam: gateway-save write-start',
    'forge-iam: gateway-save write-confirmed', 'forge-iam: gateway-save confirmation-start',
    'forge-iam: gateway-save confirmation-confirmed',
  ]);
  for (const event of events) assert.match(event, /^forge-iam: gateway-save [a-z-]+ \d+ms$/);
  assert.equal(JSON.stringify(events).includes('synthetic'), false);
  assert.equal(JSON.stringify(events).includes('corp.example'), false);
});

test('a failing diagnostic logger cannot change a confirmed mutation', async (t) => {
  const f = await setup(t);
  const services = new Map();
  const trusted = { verify: (value) => value === f.credentials, adapter: () => f.adapter };
  const ctx = {
    credentials: f.credentials, 'iam-atomic-store': trusted,
    logger: { debug: () => { throw new Error('diagnostic unavailable'); } },
    get: () => undefined,
    provide(name, value) { services.set(name, value); return () => services.delete(name); },
    effect(callback) { return callback(); },
  };
  const teardown = apply(ctx, config);
  t.after(teardown);
  const view = await services.get('iam').saveGatewayCredential(input);
  assert.equal(view.gatewayCredential.generation, f.pair().record.payload.writeOperationId);
  assert.equal(f.adapter.commits, 1);
});

test('an asynchronously rejecting host logger is consumed by the diagnostic boundary', async (t) => {
  const f = await setup(t);
  const services = new Map();
  const trusted = { verify: (value) => value === f.credentials, adapter: () => f.adapter };
  let rejectionsObserved = 0;
  const ctx = {
    credentials: f.credentials, 'iam-atomic-store': trusted,
    logger: { debug() {
      const rejected = Promise.reject(new Error('synthetic-private-exception'));
      // Keep the test runner independent of an unhandled rejection in the red
      // case; count whether the diagnostic boundary also consumes that promise.
      rejected.catch(() => {});
      const then = rejected.then.bind(rejected);
      rejected.then = (...args) => { rejectionsObserved += 1; return then(...args); };
      return rejected;
    } },
    get: () => undefined,
    provide(name, value) { services.set(name, value); return () => services.delete(name); },
    effect(callback) { return callback(); },
  };
  const teardown = apply(ctx, config);
  t.after(teardown);
  await services.get('iam').saveGatewayCredential(input);
  await nextTurn();
  assert.equal(rejectionsObserved, 7);
  assert.equal(f.adapter.commits, 1);
});

test('a later clear supersedes an in-flight confirmation of a committed save', async (t) => {
  const f = await setup(t, { existing: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const read = f.credentials.readRecord.bind(f.credentials);
  let pause = false;
  f.adapter.afterCommit = () => { if (f.adapter.commits === 1) pause = true; };
  f.credentials.readRecord = async (key) => {
    if (key === GATEWAY_RECORD_KEY && pause) { pause = false; entered.resolve(); await release.promise; }
    return read(key);
  };
  t.after(release.resolve);
  const save = f.service.saveGatewayCredential(input).then(() => null, (error) => error);
  await entered.promise;
  const joined = f.service.loadGatewayCredential({ force: true });
  const clear = f.service.clearGatewayCredential();
  try {
    const view = await promptly(clear);
    assert.equal(view.gatewayCredential.state, 'unconfigured');
    assert.equal(await promptly(joined), null);
    assert.equal((await promptly(save))?.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    release.resolve();
    assert.equal(f.adapter.commits, 2);
    assert.equal(f.pair().value, undefined);
    assert.equal(f.service.getView().gatewayCredential.state, 'unconfigured');
  } finally { release.resolve(); await Promise.allSettled([save, clear, joined]); }
});

test('a later save supersedes an in-flight confirmation without a stale success', async (t) => {
  const f = await setup(t, { existing: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const read = f.credentials.readRecord.bind(f.credentials);
  let pause = false;
  f.adapter.afterCommit = () => { if (f.adapter.commits === 1) pause = true; };
  f.credentials.readRecord = async (key) => {
    if (key === GATEWAY_RECORD_KEY && pause) { pause = false; entered.resolve(); await release.promise; }
    return read(key);
  };
  t.after(release.resolve);
  const first = f.service.saveGatewayCredential(input).then(() => null, (error) => error);
  await entered.promise;
  const second = f.service.saveGatewayCredential({ key: 'synthetic-later-key' });
  try {
    const view = await promptly(second);
    assert.equal(view.gatewayCredential.generation, f.pair().record.payload.writeOperationId);
    release.resolve();
    assert.equal((await first)?.code, 'IAM_GATEWAY_WRITE_UNKNOWN');
    assert.equal(f.adapter.commits, 2);
    assert.equal(f.pair().value, 'synthetic-later-key');
    assert.equal(f.service.getView().gatewayCredential.generation, view.gatewayCredential.generation);
  } finally { release.resolve(); await Promise.allSettled([first, second]); }
});
