import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from '@heluo/forge-credentials-keychain';
import { BRIDGE_REF } from '../src/bridge.mjs';
import { apply } from '../src/index.mjs';
import { createIamService as createService } from '../src/service.mjs';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/heluo-forge.mjs', import.meta.url));
const config = {
  issuer: 'https://iam.corp.example', authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'fixture', redirectUri: 'http://127.0.0.1:4567/iam/callback',
};
const grant = { kind: 'grant', payload: {
  version: 1, issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
  refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
  obtainedAt: '2026-01-01T00:00:00.000Z', accessExpiresAt: '2099-01-01T00:00:00.000Z',
} };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = createCredentialStore({ directory });
  const provider = createKeychainProvider(backend);
  const adapter = createJointStore(backend, namespacePrefixes());
  t.after(() => provider.close());
  await provider.modifyRecord('heluo-iam/session', () => grant);
  return { directory, provider, adapter };
}

function serviceFor(provider, adapter) {
  return createService(config, {
    credentials: provider,
    verifyAtomicStore: (value) => value === provider,
    getGatewayAtomicStore: () => adapter,
    verifyGatewayAtomicStore: (value, current) => value === provider && current === adapter,
  });
}

function host(provider, adapter) {
  const registered = [];
  const trust = { verify: (candidate) => candidate === provider, adapter: () => adapter };
  const provided = { credentials: provider, 'iam-atomic-store': trust };
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:4567',
    register(route) { registered.push(route); return () => {}; },
  };
  provided.webServer = webServer;
  const ctx = {
    get: (name) => provided[name],
    provide(name, value) { provided[name] = value; return () => { delete provided[name]; }; },
    effect(fn) { return fn(); },
    inject(names, fn) {
      if (!names.every((name) => provided[name] !== undefined)) return () => {};
      return fn(provided);
    },
  };
  const dispose = apply(ctx, config);
  const handler = registered.find((route) => route.kind === 'prefix').handler;
  return { handler, dispose };
}

async function waitForCapability(provider) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const value = (await provider.resolve(BRIDGE_REF))?.value;
    if (value) return value;
    await delay(10);
  }
  assert.fail('Host did not initialize the bridge capability');
}

test('fresh Host initializes the shared capability before a real CLI bridge request', async (t) => {
  const { directory, provider, adapter } = await fixture(t);
  const app = host(provider, adapter);
  t.after(() => app.dispose());
  const server = createServer((req, res) => { void app.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await waitForCapability(provider);
  const url = `http://127.0.0.1:${server.address().port}`;
  const rejected = await fetch(`${url}/api/forge-iam/bridge/token`, { method: 'POST', headers: { authorization: 'Bearer invalid' } });
  assert.equal(rejected.status, 401);
  const result = await run(process.execPath, [bin, 'auth', 'token'], {
    env: { HELUO_FORGE_STORE_DIRECTORY: directory, HELUO_FORGE_IAM_URL: url }, timeout: 5000,
  });
  assert.equal(result.stdout, 'synthetic-access\n');
  assert.equal(result.stderr, '');
});

test('concurrent Host instances initialize one capability in the shared store', async (t) => {
  const { directory, provider: first, adapter: firstAdapter } = await fixture(t);
  const secondBackend = createCredentialStore({ directory });
  const second = createKeychainProvider(secondBackend);
  const secondAdapter = createJointStore(secondBackend, namespacePrefixes());
  t.after(() => second.close());
  const services = [serviceFor(first, firstAdapter), serviceFor(second, secondAdapter)];
  t.after(async () => { for (const service of services) await service.dispose(); });
  const values = await Promise.all(services.flatMap((service) => [service.bridgeCapability(), service.bridgeCapability()]));
  assert.equal(new Set(values).size, 1);
  assert.equal((await first.resolve(BRIDGE_REF)).value, values[0]);
  assert.equal((await second.resolve(BRIDGE_REF)).value, values[0]);
});

test('separate Host processes converge after both observe an empty ref', { timeout: 10_000 }, async (t) => {
  const { directory, provider } = await fixture(t);
  const credentialModule = import.meta.resolve('@heluo/forge-credentials-keychain');
  const serviceModule = new URL('../src/service.mjs', import.meta.url).href;
  const source = `
    import { createHash } from 'node:crypto';
    import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from ${JSON.stringify(credentialModule)};
    import { createIamService } from ${JSON.stringify(serviceModule)};
    const backend = createCredentialStore({ directory: process.argv[1] });
    const credentials = createKeychainProvider(backend);
    const joint = createJointStore(backend, namespacePrefixes());
    let release;
    const gate = new Promise(r => { release = r; });
    let first = true;
    const adapter = {
      async snapshot(scope) {
        const pair = await joint.snapshot(scope);
        if (first) { first = false; process.send({ type: 'read' }); await gate; }
        return pair;
      },
      compareAndSwap(...args) { return joint.compareAndSwap(...args); },
    };
    const service = createIamService(${JSON.stringify(config)}, {
      credentials, verifyAtomicStore: value => value === credentials,
      getGatewayAtomicStore: () => adapter,
      verifyGatewayAtomicStore: (value, current) => value === credentials && current === adapter,
    });
    process.on('message', async message => {
      if (message === 'start') {
        try {
          const value = await service.bridgeCapability();
          process.send({ type: 'done', digest: createHash('sha256').update(value).digest('hex') });
        } catch { process.send({ type: 'failed' }); }
        await service.dispose(); await credentials.close(); process.disconnect();
      } else if (message === 'release') release();
    });
    process.send({ type: 'ready' });
  `;
  function worker() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { NODE_NO_WARNINGS: '1' },
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const wait = (type) => new Promise((resolve, reject) => {
      const onMessage = (message) => { if (message.type === type) { child.off('message', onMessage); resolve(message); } };
      child.on('message', onMessage);
      child.once('exit', (code) => reject(new Error(`bridge worker exited before ${type}: ${code}`)));
      child.once('error', reject);
    });
    return { child, ready: wait('ready'), read: wait('read'), done: wait('done') };
  }
  const workers = [worker(), worker()];
  await Promise.all(workers.map((item) => item.ready));
  workers.forEach((item) => item.child.send('start'));
  await Promise.all(workers.map((item) => item.read));
  workers.forEach((item) => item.child.send('release'));
  const values = await Promise.all(workers.map((item) => item.done));
  assert.equal(values[0].digest, values[1].digest);
  assert.ok((await provider.resolve(BRIDGE_REF))?.value);
});

test('a failed joint creation leaves neither value; a later invocation can create it', async (t) => {
  const { provider, adapter: actual } = await fixture(t);
  let fail = true;
  const adapter = { ...actual, compareAndSwap(...args) {
    if (fail) throw new Error('synthetic write failure');
    return actual.compareAndSwap(...args);
  } };
  const service = serviceFor(provider, adapter);
  t.after(() => service.dispose());
  await assert.rejects(service.bridgeCapability());
  assert.equal(await provider.resolve(BRIDGE_REF), undefined);
  assert.equal((await provider.readRecord('heluo-iam/bridge-capability')) === undefined, true);
  fail = false;
  const recovered = await service.bridgeCapability();
  assert.equal((await provider.resolve(BRIDGE_REF)).value, recovered);
  const conflicting = Buffer.alloc(32, 9).toString('base64url');
  await provider.set(BRIDGE_REF, conflicting);
  await assert.rejects(service.bridgeCapability());
  assert.equal((await provider.resolve(BRIDGE_REF)).value, conflicting);
});

for (const interruption of ['replace provider', 'dispose service']) {
  test(`bridge initialization stops if callers ${interruption} during a read`, async (t) => {
    const { provider: first, adapter: firstAdapter } = await fixture(t);
    const secondDirectory = await mkdtemp(join(tmpdir(), 'forge-bridge-replacement-'));
    t.after(() => rm(secondDirectory, { recursive: true, force: true }));
    const secondBackend = createCredentialStore({ directory: secondDirectory });
    const second = createKeychainProvider(secondBackend);
    const secondAdapter = createJointStore(secondBackend, namespacePrefixes());
    t.after(() => second.close());
    let current = first;
    let entered; const started = new Promise((resolve) => { entered = resolve; });
    let release; const gate = new Promise((resolve) => { release = resolve; });
    const gatedAdapter = { ...firstAdapter, async snapshot(scope) {
      const pair = await firstAdapter.snapshot(scope);
      entered(); await gate;
      return pair;
    } };
    const adapterFor = (value) => value === first ? gatedAdapter : value === second ? secondAdapter : undefined;
    const service = createService(config, {
      getCredentials: () => current, verifyAtomicStore: (value) => value === current,
      getGatewayAtomicStore: adapterFor,
      verifyGatewayAtomicStore: (value, adapter) => value === current && adapter === adapterFor(value),
    });
    t.after(() => service.dispose());
    const pending = service.bridgeCapability();
    await started;
    if (interruption === 'replace provider') current = second;
    else await service.dispose();
    release();
    await assert.rejects(pending);
    assert.equal(await first.resolve(BRIDGE_REF), undefined);
    assert.equal(await first.readRecord('heluo-iam/bridge-capability'), undefined);
    if (interruption === 'replace provider') {
      const value = await service.bridgeCapability();
      assert.equal((await second.resolve(BRIDGE_REF)).value, value);
    }
  });
}

test('an untrusted or unavailable provider does not authorize the bridge', async (t) => {
  const { provider } = await fixture(t);
  const service = createService(config, { credentials: provider, verifyAtomicStore: () => false });
  t.after(() => service.dispose());
  await assert.rejects(service.bridgeCapability());
  assert.equal(await provider.resolve(BRIDGE_REF), undefined);
});
