import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from '@heluo/forge-credentials-keychain';
import { createIamRoutes } from '../src/routes.mjs';
import { createIamService } from '../src/service.mjs';

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
