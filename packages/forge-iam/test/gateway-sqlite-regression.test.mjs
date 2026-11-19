import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { join } from 'node:path';
import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from '@heluo/forge-credentials-keychain';
import { createManagedModelRuntime } from '../src/managed-models.mjs';
import { createIamRoutes } from '../src/routes.mjs';
import { createIamService } from '../src/service.mjs';
import { refreshBaseId } from '../src/session-identity.mjs';
import { createGrantStore, createModelSelectionStore, GATEWAY_REF, MODEL_SELECTION_KEY } from '../src/store.mjs';

const config = {
  issuer: 'https://iam.corp.example', authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'fixture', redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

test('SQLite save does not wait for or publish a pre-commit gateway read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-gateway-read-race-'));
  const directory = join(root, 'store');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'credentials.json'), 'synthetic-legacy-document');
  await writeFile(join(directory, 'credentials.key'), 'synthetic-legacy-key');
  const backend = createCredentialStore({ directory });
  const credentials = createKeychainProvider(backend);
  const adapter = createJointStore(backend, namespacePrefixes());
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let server;
  let service;
  t.after(async () => {
    release.resolve();
    if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await service?.dispose();
    await credentials.close();
    await rm(root, { recursive: true, force: true });
  });

  await credentials.modifyRecord('heluo-iam/session', () => ({ kind: 'grant', payload: {
    version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
    issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
    refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
    obtainedAt: '2026-01-01T00:00:00.000Z', accessExpiresAt: '2099-01-01T00:00:00.000Z',
  } }));
  service = createIamService(config, {
    credentials,
    verifyAtomicStore: (value) => value === credentials,
    getGatewayAtomicStore: () => adapter,
    verifyGatewayAtomicStore: (value, current) => value === credentials && current === adapter,
  });
  await service.hydrate();

  const describe = credentials.describe.bind(credentials);
  let pause = true;
  credentials.describe = async (ref) => {
    const snapshot = await describe(ref);
    if (ref === 'ENTERPRISE_STATIC_KEY' && pause) {
      pause = false;
      entered.resolve();
      await release.promise;
    }
    return snapshot;
  };
  const oldRead = service.loadGatewayCredential({ force: true });
  await entered.promise;

  const handler = createIamRoutes(service, { getConnection: () => ({ requestRejection: () => undefined }) });
  server = createServer((req, res) => { handler(req, res).catch(() => res.destroy()); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/forge-iam/credential`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-forge-iam-request': '1' },
    body: JSON.stringify({ key: 'synthetic-gateway-key', baseURL: 'https://gateway.corp.example/v1' }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const { view } = await response.json();
  assert.equal(view.gatewayCredential.state, 'configured');
  assert.equal((await credentials.resolve('ENTERPRISE_STATIC_KEY')).value, 'synthetic-gateway-key');

  release.resolve();
  await oldRead;
  assert.equal(service.getView().gatewayCredential.state, 'configured');
  assert.equal(await readFile(join(directory, 'credentials.json'), 'utf8'), 'synthetic-legacy-document');
  assert.equal(await readFile(join(directory, 'credentials.key'), 'utf8'), 'synthetic-legacy-key');
});

async function verifyColdModelCatalogue(t, { observesPending = false, replacesPending = false, replaceDuring } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-gateway-cold-models-'));
  const backend = createCredentialStore({ directory });
  const peerBackend = observesPending || replaceDuring ? createCredentialStore({ directory }) : null;
  const credentials = createKeychainProvider(backend);
  const peer = peerBackend && createGrantStore(createKeychainProvider(peerBackend));
  const adapter = createJointStore(backend, namespacePrefixes());
  const baseURL = 'https://gateway.corp.example/v1';
  const modelConfig = { ...config, defaultProvider: 'enterprise', managedModels: { baseURL } };
  const key = 'synthetic-gateway-key';
  const subject = 'synthetic-user';
  let iamRequests = 0;
  let catalogueReads = 0;
  const sawPending = Promise.withResolvers();
  const replaceHere = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  const waitForReplacement = async (stage) => {
    if (stage !== replaceDuring) return;
    replaceHere.resolve();
    await releaseRead.promise;
  };
  let server, runtime, writer, service, registeredAdapter;
  const publishedModels = [];
  t.after(async () => {
    releaseRead.resolve();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await runtime?.dispose();
    await service?.dispose();
    await writer?.dispose();
    await credentials.close();
    await peerBackend?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const options = {
    credentials,
    verifyAtomicStore: candidate => candidate === credentials,
    getGatewayAtomicStore: () => adapter,
    verifyGatewayAtomicStore: (candidate, current) => candidate === credentials && current === adapter,
    async fetch() { iamRequests++; throw new Error('Unexpected IAM request for a fresh token'); },
    logRenewal(event, fields) {
      if (event === 'session-state' && fields.code === 'IAM_REAUTH_REQUIRED') sawPending.resolve();
    },
  };

  const now = Date.now();
  const grant = {
    version: 1, sessionInstanceId: Buffer.alloc(32, 9).toString('base64url'),
    issuer: config.issuer, clientId: config.clientId, subject, scope: 'openid',
    accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
    obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(now + 600_000).toISOString(),
    refreshExpiresAt: new Date(now + 1_200_000).toISOString(),
  };
  await createGrantStore(credentials).write(grant);
  writer = createIamService(modelConfig, options);
  await writer.hydrate();
  await writer.saveGatewayCredential({ key, baseURL });
  await writer.dispose();
  const operationId = Buffer.alloc(32, 12).toString('base64url');
  const marker = { version: 1, id: operationId, base: refreshBaseId(grant, operationId) };
  if (observesPending) await peer.write({ ...grant, refreshOperation: { ...marker, state: 'pending' } });
  const savedModel = replaceDuring === 'seed-adapter' ? 'seed-model'
    : replaceDuring === 'directory-adapter' ? 'cold-model' : undefined;
  const selectionStore = createModelSelectionStore(credentials);
  if (savedModel) {
    await selectionStore.save({
      subject,
      models: { [savedModel]: {} },
      defaultModelId: savedModel,
      ...(replaceDuring === 'seed-adapter' ? { manual: [{ id: savedModel }] } : {}),
    });
  }
  const initialSelection = await selectionStore.read();

  service = createIamService(modelConfig, { ...options, getManagedModelRuntime: () => runtime });
  runtime = createManagedModelRuntime({
    host: {
      llm: { registerAdapter(_providers, adapter) { registeredAdapter = adapter; } },
      on() {},
      emit() { publishedModels.push((runtime?.getView().models ?? []).map(({ id }) => id)); },
    },
    iam: service,
    config: modelConfig,
    async createAdapter({ config: adapterConfig }) {
      const [model] = adapterConfig.managedModels.models;
      await waitForReplacement(model.id === 'seed-model' ? 'seed-adapter' : 'directory-adapter');
      return {};
    },
    async requestHeaders() {
      await waitForReplacement('headers');
      return {};
    },
    async fetch(input, init) {
      assert.equal(input, `${baseURL}/models`);
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), `Bearer ${key}`);
      assert.equal(headers.has('x-iam-token'), false);
      catalogueReads++;
      await waitForReplacement('response');
      return Response.json({ data: [{ id: 'cold-model' }] });
    },
  });
  await runtime.ready;
  assert.equal(service.getView().state, 'signed-out');
  assert.equal(catalogueReads, 0);

  const handler = createIamRoutes(service, { getConnection: () => ({ requestRejection: () => undefined }) });
  server = createServer((req, res) => { handler(req, res).catch(() => res.destroy()); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const request = fetch(`http://127.0.0.1:${server.address().port}/api/forge-iam/models`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (observesPending) {
    await Promise.race([
      sawPending.promise,
      request.then(() => assert.fail('the catalogue returned before the durable refresh receipt')),
    ]);
    await peer.write(replacesPending ? {
      ...grant,
      sessionInstanceId: Buffer.alloc(32, 13).toString('base64url'),
    } : {
      ...grant,
      accessToken: 'synthetic-rotated-access',
      refreshToken: 'synthetic-rotated-refresh',
      refreshOperation: { ...marker, state: 'complete' },
    });
  }
  if (replaceDuring) {
    await Promise.race([
      replaceHere.promise,
      request.then(() => assert.fail('the catalogue returned before its recheck')),
    ]);
    await peer.write({ ...grant, sessionInstanceId: Buffer.alloc(32, 16).toString('base64url') });
    releaseRead.resolve();
  }
  const response = await request;
  const body = await response.json();
  if (replaceDuring) {
    assert.equal(response.status, 409);
    assert.equal(body.error.code, 'IAM_MODEL_CONTEXT_CHANGED');
    assert.deepEqual(runtime.getView().models, []);
    assert.deepEqual(await registeredAdapter.listModels('enterprise'), []);
    assert.equal(publishedModels.some((models) => models.length > 0), false);
    assert.deepEqual(await selectionStore.read(), initialSelection);
    assert.equal(catalogueReads, ['headers', 'seed-adapter'].includes(replaceDuring) ? 0 : 1);
    assert.equal(iamRequests, 0);
    return;
  }
  if (replacesPending) {
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'IAM_RENEWAL_UNCONFIRMED');
    assert.equal(catalogueReads, 0);
    assert.equal(iamRequests, 0);
    return;
  }
  assert.equal(response.status, 200, body.error?.code);
  assert.deepEqual(body.models.map(model => model.id), ['cold-model']);
  assert.equal(body.view.principal, subject);
  assert.equal(body.view.gatewayCredential.matchesAccount, true);
  assert.equal(catalogueReads, 1);
  assert.equal(iamRequests, 0);
}

test('a cold model catalogue GET adopts the saved session and gateway without renewing a fresh token', verifyColdModelCatalogue);

test('a cold model catalogue GET waits for a same-login SQLite pending receipt without repeating refresh',
  (t) => verifyColdModelCatalogue(t, { observesPending: true }));

test('a cold model catalogue GET rejects a new same-subject login in place of the SQLite receipt',
  (t) => verifyColdModelCatalogue(t, { observesPending: true, replacesPending: true }));

test('model catalogue validates the durable login after gateway headers are ready',
  (t) => verifyColdModelCatalogue(t, { replaceDuring: 'headers' }));

test('model catalogue validates the durable login before publishing the directory response',
  (t) => verifyColdModelCatalogue(t, { replaceDuring: 'response' }));

test('a peer login during cached adapter construction cannot publish the seed models',
  (t) => verifyColdModelCatalogue(t, { replaceDuring: 'seed-adapter' }));

test('a peer login during directory adapter construction cannot publish the directory models',
  (t) => verifyColdModelCatalogue(t, { replaceDuring: 'directory-adapter' }));

for (const [scenario, title] of [
  ['local', 'waits for a same Host SQLite refresh across the old refresh deadline'],
  ['peer', 'waits for a peer Host SQLite refresh across the old refresh deadline'],
  ['complete', 'adopts a committed SQLite receipt after both old tokens expire'],
  ['untrusted', 'requires atomic trust to adopt a committed SQLite receipt after both old tokens expire'],
  ['untrusted-before-expiry', 'requires atomic trust for a committed SQLite receipt even before old refresh expiry'],
  ['elapsed', 'cannot start a new refresh once its SQLite grant has expired'],
  ['unmatched', 'rejects a pending SQLite receipt from a different grant baseline'],
]) {
  test(`an expired warm model catalogue ${title}`, { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-gateway-warm-renewal-'));
    const baseURL = 'https://gateway.corp.example/v1';
    const modelConfig = { ...config, defaultProvider: 'enterprise', managedModels: { baseURL } };
    const credentials = [];
    const services = [];
    const tokenRequested = Promise.withResolvers();
    const releaseToken = Promise.withResolvers();
    const joined = Promise.withResolvers();
    let clock = Date.now();
    let tokenPosts = 0;
    let catalogueReads = 0;
    let readerTrusted = true;
    let catalogueModel = 'synthetic-initial-model';
    let pending;
    let runtime, renewal, catalogue;
    t.after(async () => {
      releaseToken.resolve();
      await Promise.allSettled([renewal, catalogue]);
      await runtime?.dispose();
      for (const service of services) await service.dispose();
      for (const provider of credentials) await provider.close();
      await rm(directory, { recursive: true, force: true });
    });
    const grant = {
      version: 1, sessionInstanceId: Buffer.alloc(32, 21).toString('base64url'),
      issuer: config.issuer, clientId: config.clientId, subject: 'synthetic-user', scope: 'openid',
      accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
      obtainedAt: new Date(clock).toISOString(), accessExpiresAt: new Date(clock + 600_000).toISOString(),
      refreshExpiresAt: new Date(clock + 1_200_000).toISOString(),
    };
    function openHost(getManagedModelRuntime) {
      const backend = createCredentialStore({ directory });
      const provider = createKeychainProvider(backend);
      credentials.push(provider);
      const adapter = createJointStore(backend, namespacePrefixes());
      const service = createIamService(modelConfig, {
        credentials: provider, now: () => clock,
        verifyAtomicStore: candidate => candidate === provider && (getManagedModelRuntime === undefined || readerTrusted),
        getGatewayAtomicStore: () => adapter,
        verifyGatewayAtomicStore: (candidate, current) => candidate === provider && current === adapter,
        getManagedModelRuntime,
        logRenewal(event, fields) {
          if (fields.trigger === 'model' && (event === 'refresh-shared' || fields.stage === 'wait-for-peer')) joined.resolve();
        },
        async fetch(input, init) {
          if (input === config.jwksUri) return Response.json({ keys: [] });
          assert.equal(input, config.tokenEndpoint);
          assert.equal(init.method, 'POST');
          assert.equal(new URLSearchParams(init.body).get('refresh_token'), grant.refreshToken);
          tokenPosts++;
          tokenRequested.resolve();
          await releaseToken.promise;
          return Response.json({
            access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh',
            token_type: 'Bearer', expires_in: 600, refresh_expires_in: 1200,
          });
        },
      });
      services.push(service);
      return { service, store: createGrantStore(provider) };
    }
    const reader = openHost(() => runtime);
    const writer = scenario === 'local' ? reader : openHost();
    await reader.store.write(grant);
    await reader.service.hydrate();
    await reader.service.saveGatewayCredential({ key: 'synthetic-gateway-key', baseURL });
    if (writer !== reader) await writer.service.hydrate();
    runtime = createManagedModelRuntime({
      host: { llm: { registerAdapter() {} }, on() {}, emit() {} },
      iam: reader.service, config: modelConfig,
      createAdapter: async () => ({}), requestHeaders: async () => ({}),
      async fetch(input, init) {
        assert.equal(input, `${baseURL}/models`);
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-gateway-key');
        catalogueReads++;
        if (pending) {
          const current = (await reader.store.read()).grant;
          assert.equal(current.sessionInstanceId, grant.sessionInstanceId);
          assert.deepEqual(current.refreshOperation, { ...pending.refreshOperation, state: 'complete' });
        }
        return Response.json({ data: [{ id: catalogueModel }] });
      },
    });
    await runtime.ready;
    assert.deepEqual(runtime.getView().models.map(({ id }) => id), ['synthetic-initial-model']);

    catalogueModel = 'synthetic-renewed-model';
    const readsBeforeRenewal = catalogueReads;
    clock = Date.parse(grant.accessExpiresAt) + 1;
    if (scenario === 'elapsed') {
      clock = Date.parse(grant.refreshExpiresAt) + 1;
      await assert.rejects(reader.service.refreshGatewayModels(), { code: 'IAM_LOGIN_REQUIRED' });
      assert.deepEqual((await reader.store.read()).grant, grant);
      assert.equal(catalogueReads, readsBeforeRenewal);
      assert.equal(tokenPosts, 0);
      return;
    }
    if (scenario === 'unmatched') {
      clock = Date.parse(grant.refreshExpiresAt) + 1;
      const id = Buffer.alloc(32, 22).toString('base64url');
      const otherBaseline = { ...grant, scope: 'openid profile' };
      pending = { ...grant, refreshOperation: { version: 1, state: 'pending', id, base: refreshBaseId(otherBaseline, id) } };
      await writer.store.write(pending);
      await assert.rejects(reader.service.refreshGatewayModels(), { code: 'IAM_RENEWAL_UNCONFIRMED' });
      assert.deepEqual((await reader.store.read()).grant, pending);
      assert.equal(catalogueReads, readsBeforeRenewal);
      assert.equal(tokenPosts, 0);
      return;
    }
    renewal = writer.service.getAccessToken();
    await Promise.race([tokenRequested.promise, renewal.then(() => assert.fail('renewal returned before sending the request'))]);
    pending = (await reader.store.read()).grant;
    assert.equal(pending.refreshOperation.state, 'pending');
    assert.equal(pending.sessionInstanceId, grant.sessionInstanceId);
    if (scenario !== 'untrusted-before-expiry') clock = Date.parse(grant.refreshExpiresAt) + 1;
    if (scenario === 'complete' || scenario.startsWith('untrusted')) {
      releaseToken.resolve();
      await renewal;
      if (scenario.startsWith('untrusted')) {
        const receipt = (await reader.store.read()).grant;
        readerTrusted = false;
        await assert.rejects(reader.service.refreshGatewayModels(), { code: 'IAM_REAUTH_REQUIRED' });
        assert.equal(catalogueReads, readsBeforeRenewal);
        assert.equal(tokenPosts, 1);
        assert.deepEqual((await reader.store.read()).grant, receipt);
        return;
      }
      catalogue = reader.service.refreshGatewayModels();
    } else {
      catalogue = reader.service.refreshGatewayModels();
      await Promise.race([joined.promise, catalogue.then(() => assert.fail('the catalogue returned before joining the renewal'))]);
      assert.equal(catalogueReads, readsBeforeRenewal);
      releaseToken.resolve();
    }
    const [accessToken, result] = await Promise.all([renewal, catalogue]);
    assert.equal(accessToken, 'synthetic-rotated-access');
    assert.deepEqual(result.models.map(({ id }) => id), ['synthetic-renewed-model']);
    assert.equal(tokenPosts, 1);
    const durable = (await reader.store.read()).grant;
    assert.equal(durable.sessionInstanceId, grant.sessionInstanceId);
    assert.deepEqual(durable.refreshOperation, { ...pending.refreshOperation, state: 'complete' });
  });
}

for (const sameSubject of [false, true]) {
  test(`SQLite model settings keep the original login across a queued ${sameSubject ? 'manual save after same-subject login' : 'enabled-set save after account replacement'}`, { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-model-settings-race-'));
    const backend = createCredentialStore({ directory });
    const peerBackend = createCredentialStore({ directory });
    const { recordPrefix } = namespacePrefixes();
    const writerEntered = Promise.withResolvers();
    const releasePeer = Promise.withResolvers();
    let countWrites = false;
    const credentials = createKeychainProvider({
      ...backend,
      transaction(id, mutate) {
        const operation = backend.transaction(id, mutate);
        if (countWrites && id === `${recordPrefix}${MODEL_SELECTION_KEY}`) writerEntered.resolve();
        return operation;
      },
    });
    const peerCredentials = createKeychainProvider(peerBackend);
    const peerGrantStore = createGrantStore(peerCredentials);
    const peerSelectionStore = createModelSelectionStore(peerCredentials);
    const adapter = createJointStore(backend, namespacePrefixes());
    const baseURL = 'https://gateway.corp.example/v1';
    const modelConfig = { ...config, defaultProvider: 'enterprise', managedModels: { baseURL } };
    let runtime, service, mutation, replacing, refreshRequest;
    const rebuilding = Promise.withResolvers();
    const releaseRebuild = Promise.withResolvers();
    let pauseRebuild = false;
    let iamRequests = 0;
    let catalogueReads = 0;
    let catalogueExtra = [];
    t.after(async () => {
      releasePeer.resolve();
      releaseRebuild.resolve();
      await Promise.allSettled([mutation, replacing, refreshRequest]);
      await runtime?.dispose();
      await service?.dispose();
      await credentials.close();
      await peerCredentials.close();
      await rm(directory, { recursive: true, force: true });
    });

    const now = Date.now();
    const original = {
      version: 1, sessionInstanceId: Buffer.alloc(32, 14).toString('base64url'),
      issuer: config.issuer, clientId: config.clientId, subject: 'synthetic-original', scope: 'openid',
      accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
      obtainedAt: new Date(now).toISOString(), accessExpiresAt: new Date(now + 600_000).toISOString(),
      refreshExpiresAt: new Date(now + 1_200_000).toISOString(),
    };
    const replacement = {
      ...original, sessionInstanceId: Buffer.alloc(32, 15).toString('base64url'),
      subject: sameSubject ? original.subject : 'synthetic-replacement',
    };
    await createGrantStore(credentials).write(original);
    service = createIamService(modelConfig, {
      credentials,
      verifyAtomicStore: candidate => candidate === credentials,
      getGatewayAtomicStore: () => adapter,
      verifyGatewayAtomicStore: (candidate, current) => candidate === credentials && current === adapter,
      getManagedModelRuntime: () => runtime,
      async fetch() { iamRequests++; throw new Error('Unexpected IAM request for a fresh token'); },
    });
    await service.hydrate();
    await service.saveGatewayCredential({ key: 'synthetic-gateway-key', baseURL });
    runtime = createManagedModelRuntime({
      host: { llm: { registerAdapter() {} }, on() {}, emit() {} },
      iam: service,
      config: modelConfig,
      async createAdapter() {
        if (pauseRebuild) {
          rebuilding.resolve();
          pauseRebuild = false;
          await releaseRebuild.promise;
        }
        return {};
      },
      requestHeaders: async () => ({}),
      async fetch() {
        catalogueReads++;
        return Response.json({ data: [
          { id: 'synthetic-original-model' }, { id: 'synthetic-replacement-model' }, ...catalogueExtra,
        ] });
      },
    });
    await runtime.ready;
    assert.deepEqual(runtime.getView().enabled, ['synthetic-original-model']);
    const resolve = credentials.resolve.bind(credentials);
    let gatewayResolutions = 0;
    credentials.resolve = async (ref) => {
      if (ref === GATEWAY_REF) gatewayResolutions++;
      return resolve(ref);
    };
    const skipped = await service.updateManualModel({ action: 'remove', id: 'synthetic-missing-model' });
    assert.equal(skipped.persisted, false);
    assert.equal(gatewayResolutions, 0, 'a warm local-only action reuses the gateway summary');

    // A different writer's saved selection must survive the queued settings operation.
    const expected = await peerSelectionStore.save({
      subject: replacement.subject, models: { 'synthetic-replacement-model': {} },
      defaultModelId: 'synthetic-replacement-model',
    });
    const peerLocked = Promise.withResolvers();
    replacing = peerGrantStore.mutate(async () => {
      peerLocked.resolve();
      await releasePeer.promise;
      return replacement;
    });
    await peerLocked.promise;
    countWrites = true;
    mutation = sameSubject
      ? service.updateManualModel({ action: 'add', id: 'synthetic-uncommitted-manual' })
      : service.updateModelOptions({ 'synthetic-original-model': {} });
    const rejection = assert.rejects(mutation, { code: 'IAM_MODEL_CONTEXT_CHANGED' });
    await Promise.race([writerEntered.promise, rejection.then(() => assert.fail('the mutation did not reach the SQLite write lock'))]);
    releasePeer.resolve();
    await replacing;
    await rejection;
    assert.equal((await peerGrantStore.read()).grant.sessionInstanceId, replacement.sessionInstanceId);
    assert.deepEqual(await peerSelectionStore.read(), expected);
    assert.deepEqual(runtime.getView().enabled, ['synthetic-original-model']);
    assert.equal(runtime.getView().models.some(({ id }) => id === 'synthetic-uncommitted-manual'), false);

    // The warm GET cannot publish the old catalogue. A subsequent request
    // after session reconciliation uses the replacement's durable settings.
    const before = catalogueReads;
    await assert.rejects(service.refreshGatewayModels(), { code: 'IAM_MODEL_CONTEXT_CHANGED' });
    assert.equal(catalogueReads, before);
    await service.syncFromStore();
    if (!sameSubject) await service.saveGatewayCredential({ key: 'synthetic-new-gateway-key', baseURL });
    const fresh = await service.refreshGatewayModels();
    assert.equal(fresh.models.some(({ id }) => id === 'synthetic-replacement-model'), true);
    assert.deepEqual(runtime.getView().enabled, ['synthetic-replacement-model']);
    const changed = await service.updateManualModel({ action: 'add', id: 'synthetic-current-manual' });
    assert.equal(changed.persisted, true);
    assert.deepEqual((await peerSelectionStore.read()).selection.manual.map(({ id }) => id), ['synthetic-current-manual']);

    pauseRebuild = true;
    mutation = service.updateModelOptions({ 'synthetic-original-model': {} });
    const rebuilt = sameSubject ? assert.rejects(mutation, { code: 'IAM_MODEL_CONTEXT_CHANGED' }) : mutation;
    await Promise.race([rebuilding.promise, rebuilt.then(() => assert.fail('the settings change did not reach adapter construction'))]);
    // The selection has committed under the current login; publication waits
    // for its adapter. A concurrent refresh must not use or overwrite that view.
    assert.deepEqual((await peerSelectionStore.read()).selection.models, { 'synthetic-original-model': {} });
    catalogueExtra = [{ id: 'synthetic-new-catalogue-model' }];
    const queued = Promise.withResolvers();
    const refresh = runtime.refresh;
    runtime.refresh = (settings) => {
      const result = refresh(settings);
      queued.resolve();
      return result;
    };
    const readsBeforeWait = catalogueReads;
    refreshRequest = service.refreshGatewayModels();
    const refreshed = sameSubject ? assert.rejects(refreshRequest, { code: 'IAM_MODEL_CONTEXT_CHANGED' }) : refreshRequest;
    await Promise.race([queued.promise, refreshed.then(() => assert.fail('the catalogue did not reach the runtime'))]);
    await nextTurn();
    assert.equal(catalogueReads, readsBeforeWait, 'the catalogue waits while the settings adapter is building');

    if (sameSubject) {
      await peerGrantStore.write({ ...replacement, sessionInstanceId: Buffer.alloc(32, 17).toString('base64url') });
      releaseRebuild.resolve();
      await Promise.all([rebuilt, refreshed]);
      assert.equal(catalogueReads, readsBeforeWait);
      assert.deepEqual(runtime.getView().enabled, ['synthetic-replacement-model']);
    } else {
      releaseRebuild.resolve();
      const [saved, catalogue] = await Promise.all([rebuilt, refreshed]);
      assert.equal(saved.persisted, true);
      assert.equal(catalogueReads, readsBeforeWait + 1);
      assert.ok(catalogue.models.some(({ id }) => id === 'synthetic-new-catalogue-model'));
      assert.ok(runtime.getView().models.some(({ id }) => id === 'synthetic-new-catalogue-model'));
      assert.deepEqual(runtime.getView().enabled, ['synthetic-original-model']);
    }
    assert.equal(iamRequests, 0);
  });
}
