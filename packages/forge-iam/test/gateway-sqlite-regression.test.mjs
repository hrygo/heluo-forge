import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from '@heluo/forge-credentials-keychain';
import { createManagedModelRuntime } from '../src/managed-models.mjs';
import { createIamRoutes } from '../src/routes.mjs';
import { createIamService } from '../src/service.mjs';
import { refreshBaseId } from '../src/session-identity.mjs';
import { createGrantStore } from '../src/store.mjs';

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

async function verifyColdModelCatalogue(t, { observesPending = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-gateway-cold-models-'));
  const backend = createCredentialStore({ directory });
  const peerBackend = observesPending ? createCredentialStore({ directory }) : null;
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
  let server, runtime, writer, service;
  t.after(async () => {
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
  if (peer) await peer.write({ ...grant, refreshOperation: { ...marker, state: 'pending' } });

  service = createIamService(modelConfig, { ...options, getManagedModelRuntime: () => runtime });
  runtime = createManagedModelRuntime({
    host: { llm: { registerAdapter() {} }, on() {}, emit() {} },
    iam: service,
    config: modelConfig,
    createAdapter: async () => ({}),
    requestHeaders: async () => ({}),
    async fetch(input, init) {
      assert.equal(input, `${baseURL}/models`);
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), `Bearer ${key}`);
      assert.equal(headers.has('x-iam-token'), false);
      catalogueReads++;
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
  if (peer) {
    await Promise.race([
      sawPending.promise,
      request.then(() => assert.fail('the catalogue returned before the durable refresh receipt')),
    ]);
    await peer.write({
      ...grant,
      accessToken: 'synthetic-rotated-access',
      refreshToken: 'synthetic-rotated-refresh',
      refreshOperation: { ...marker, state: 'complete' },
    });
  }
  const response = await request;
  const body = await response.json();
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
