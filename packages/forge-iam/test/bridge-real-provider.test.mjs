import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createCredentialStore, createJointStore, createKeychainProvider, namespacePrefixes } from '@heluo/forge-credentials-keychain';
import { BRIDGE_REF } from '../src/bridge.mjs';
import { apply } from '../src/index.mjs';
import { createIamService as createService } from '../src/service.mjs';
import { refreshBaseId } from '../src/service-helpers.mjs';

const bin = fileURLToPath(new URL('../bin/heluo-forge.mjs', import.meta.url));
const config = {
  issuer: 'https://iam.corp.example', authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token', jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'fixture', redirectUri: 'http://127.0.0.1:4567/iam/callback',
};
const grant = { kind: 'grant', payload: {
  version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: config.issuer, subject: 'synthetic-user', clientId: config.clientId,
  refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', scope: 'openid',
  obtainedAt: '2026-01-01T00:00:00.000Z', accessExpiresAt: '2099-01-01T00:00:00.000Z',
} };

function ownDirectories(t, directory) {
  const cleanups = [];
  const directories = [directory];
  t.after(async () => {
    const errors = [];
    while (cleanups.length) {
      try { await cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed');
    for (const path of directories.reverse()) {
      try { await rm(path, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'test directory cleanup failed');
  });
  return { own: (cleanup) => cleanups.push(cleanup), addDirectory: (path) => directories.push(path) };
}

function ownChild(own, child) {
  const closed = new Promise((resolve) => {
    let error;
    child.once('error', (cause) => { error = cause; });
    child.once('close', (code, signal) => resolve({ code, signal, error }));
  });
  own(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const result = await closed;
    if (result.error) throw result.error;
  });
  return closed;
}

function startCli(own, directory, url, extraEnv = {}) {
  const child = spawn(process.execPath, [bin, 'auth', 'token'], {
    env: { HELUO_FORGE_STORE_DIRECTORY: directory, HELUO_FORGE_IAM_URL: url, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = ownChild(own, child);
  return { closed, stdout: () => stdout, stderr: () => stderr };
}

function createRouteServer(own, handler) {
  const errors = [];
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => { errors.push(error); res.destroy(); });
  });
  own(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (errors.length) throw new AggregateError(errors, 'test route failed');
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forge-bridge-'));
  const directory = join(root, 'store');
  const { own } = ownDirectories(t, root);
  const backend = createCredentialStore({ directory });
  const provider = createKeychainProvider(backend);
  const adapter = createJointStore(backend, namespacePrefixes());
  own(() => provider.close());
  await provider.modifyRecord('heluo-iam/session', () => grant);
  return { root, directory, provider, adapter, own };
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
  return { handler, dispose, service: provided.iam };
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
  const { directory, provider, adapter, own } = await fixture(t);
  const app = host(provider, adapter);
  own(() => app.dispose());
  const server = createRouteServer(own, app.handler);
  const url = await listen(server);
  await waitForCapability(provider);
  const rejected = await fetch(`${url}/api/forge-iam/bridge/token`, { method: 'POST', headers: { authorization: 'Bearer invalid' } });
  assert.equal(rejected.status, 401);
  const cli = startCli(own, directory, url);
  const result = await cli.closed;
  if (result.error) throw result.error;
  assert.equal(result.code, 0, cli.stderr());
  assert.equal(cli.stdout(), 'synthetic-access\n');
  assert.equal(cli.stderr(), '');
});

test('Host and CLI retain an existing SQLite session after upgrade with legacy documents present', async (t) => {
  const { directory, provider: original, own } = await fixture(t);
  await original.close();
  const keyPath = join(`${directory}.keys`, 'keyring.json');
  const keyBefore = await readFile(keyPath);
  for (const name of ['credentials.json', 'credentials.key']) {
    await writeFile(join(directory, name), `synthetic-${name}`);
  }

  const backend = createCredentialStore({ directory });
  const provider = createKeychainProvider(backend);
  const adapter = createJointStore(backend, namespacePrefixes());
  own(() => provider.close());
  const app = host(provider, adapter);
  own(() => app.dispose());
  const server = createRouteServer(own, app.handler);
  const url = await listen(server);
  await waitForCapability(provider);
  const cli = startCli(own, directory, url);
  const result = await cli.closed;
  if (result.error) throw result.error;
  assert.equal(result.code, 0, cli.stderr());
  assert.equal(cli.stdout(), 'synthetic-access\n');
  assert.deepEqual(await provider.readRecord('heluo-iam/session'), grant);
  assert.deepEqual(await readFile(keyPath), keyBefore);
  for (const name of ['credentials.json', 'credentials.key']) {
    assert.equal(await readFile(join(directory, name), 'utf8'), `synthetic-${name}`);
  }
});

test('Host and CLI share a custom store with a separate sibling key directory', async (t) => {
  const { root, directory, provider, adapter, own } = await fixture(t);
  const app = host(provider, adapter);
  own(() => app.dispose());
  const server = createRouteServer(own, app.handler);
  const url = await listen(server);
  await waitForCapability(provider);
  const home = join(root, 'cli-home');
  const dataHome = join(root, 'cli-data');
  const configHome = join(root, 'cli-config');
  const localAppData = join(root, 'cli-local');
  const cli = startCli(own, directory, url, {
    HOME: home, USERPROFILE: home, XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome, LOCALAPPDATA: localAppData,
  });
  const result = await cli.closed;
  if (result.error) throw result.error;
  assert.equal(result.code, 0, cli.stderr());
  assert.equal(cli.stdout(), 'synthetic-access\n');
  assert.equal(cli.stderr(), '');
  assert.equal((await stat(join(directory, 'credentials.sqlite'))).isFile(), true);
  assert.equal((await stat(join(`${directory}.keys`, 'keyring.json'))).isFile(), true);
  await assert.rejects(stat(join(directory, 'keyring.json')), { code: 'ENOENT' });
  for (const path of [home, dataHome, configHome, localAppData]) {
    await assert.rejects(stat(path), { code: 'ENOENT' });
  }
});

test('Host and CLI reject a legacy SQLite keyring without changing either file', async (t) => {
  const { directory, provider: original, own } = await fixture(t);
  await original.close();
  await rename(join(`${directory}.keys`, 'keyring.json'), join(directory, 'keyring.json'));
  await rmdir(`${directory}.keys`);
  const database = await readFile(join(directory, 'credentials.sqlite'));
  const keyring = await readFile(join(directory, 'keyring.json'));

  const backend = createCredentialStore({ directory });
  const provider = createKeychainProvider(backend);
  const adapter = createJointStore(backend, namespacePrefixes());
  own(() => provider.close());
  const service = serviceFor(provider, adapter);
  own(() => service.dispose());
  assert.notEqual((await service.hydrate()).state, 'ready');
  await assert.rejects(provider.readRecord('heluo-iam/session'), { code: 'CRED_LEGACY_STORE' });
  const cli = startCli(own, directory, 'http://127.0.0.1:9');
  const result = await cli.closed;
  if (result.error) throw result.error;
  assert.notEqual(result.code, 0, cli.stderr());
  assert.equal(cli.stdout(), '');
  assert.deepEqual(await readFile(join(directory, 'credentials.sqlite')), database);
  assert.deepEqual(await readFile(join(directory, 'keyring.json')), keyring);
  assert.equal((await stat(join(directory, 'keyring.json'))).isFile(), true);
  await assert.rejects(stat(`${directory}.keys`), { code: 'ENOENT' });
});

test('Host rejects a same-kid key mismatch before writing bridge capability', async (t) => {
  const { directory, provider, adapter, own } = await fixture(t);
  const rotator = createCredentialStore({ directory });
  own(() => rotator.close());
  await rotator.rotate('k2');
  await rotator.close();

  const keyPath = join(`${directory}.keys`, 'keyring.json');
  const original = await readFile(keyPath, 'utf8');
  const wrong = JSON.parse(original);
  const bytes = Buffer.from(wrong.keys.k2, 'base64');
  bytes[0] ^= 1;
  wrong.keys.k2 = bytes.toString('base64');
  await writeFile(keyPath, JSON.stringify(wrong), { mode: 0o600 });
  // The active key binding is authenticated before any session is read.
  await assert.rejects(provider.readRecord('heluo-iam/session'), { code: 'CRED_DECRYPT_FAILED' });

  const failures = [];
  const observed = Object.freeze({
    async snapshot(...args) {
      try { return await adapter.snapshot(...args); }
      catch (error) { failures.push(error); throw error; }
    },
    async compareAndSwap(...args) {
      try { return await adapter.compareAndSwap(...args); }
      catch (error) { failures.push(error); throw error; }
    },
  });
  const app = host(provider, observed);
  own(() => app.dispose());
  await assert.rejects(app.service.bridgeCapability(), (error) => {
    assert.equal(error.code, 'IAM_CREDENTIALS_UNAVAILABLE');
    assert.doesNotMatch(error.message, /synthetic-access|synthetic-refresh/u);
    return true;
  });
  assert.ok(failures.length > 0, 'the joint store must reject the wrong key binding');
  assert.ok(failures.every((error) => error.code === 'CRED_DECRYPT_FAILED'));

  await writeFile(keyPath, original, { mode: 0o600 });
  assert.deepEqual(await provider.readRecord('heluo-iam/session'), grant);
  assert.equal(await provider.readRecord('heluo-iam/bridge-capability'), undefined);
  assert.equal(await provider.resolve(BRIDGE_REF), undefined);
  assert.match(await app.service.bridgeCapability(), /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(await provider.readRecord('heluo-iam/session'), grant);
});

test('CLI waits through the same pending refresh and outputs only the rotated Host token', { timeout: 10_000 }, async (t) => {
  const { directory, provider, adapter, own } = await fixture(t);
  const app = host(provider, adapter);
  own(() => app.dispose());
  await app.service.hydrate();
  await waitForCapability(provider);

  const writer = createKeychainProvider(createCredentialStore({ directory }));
  own(() => writer.close());
  const initial = { ...grant.payload, sessionInstanceId: Buffer.alloc(32, 1).toString('base64url') };
  const id = Buffer.alloc(32, 2).toString('base64url');
  const operation = { version: 1, state: 'pending', id, base: refreshBaseId(initial, id) };
  const pending = { kind: 'grant', payload: { ...initial, refreshOperation: operation } };
  await writer.modifyRecord('heluo-iam/session', () => pending);

  let requested = false;
  let pendingReads = 0;
  let observed;
  const observedPending = new Promise((resolve) => { observed = resolve; });
  const readRecord = provider.readRecord.bind(provider);
  provider.readRecord = async (key) => {
    const value = await readRecord(key);
    if (requested && key === 'heluo-iam/session' && value?.payload?.refreshOperation?.state === 'pending') {
      if (++pendingReads === 2) observed();
    }
    return value;
  };
  const server = createRouteServer(own, (req, res) => {
    if (req.url === '/api/forge-iam/bridge/token') requested = true;
    return app.handler(req, res);
  });
  const url = await listen(server);
  const cli = startCli(own, directory, url);
  await Promise.race([
    observedPending,
    cli.closed.then((result) => { throw new Error(`CLI exited before Host observed pending: ${result.code ?? result.signal}`); }),
  ]);
  assert.equal(cli.stdout(), '');
  assert.equal(app.service.getView().error, 'IAM_REAUTH_REQUIRED');

  await writer.modifyRecord('heluo-iam/session', (current) => {
    assert.deepEqual(current, pending);
    return { kind: 'grant', payload: { ...initial, refreshToken: 'synthetic-rotated-refresh',
      accessToken: 'synthetic-rotated-access', refreshOperation: { ...operation, state: 'complete' } } };
  });
  const result = await cli.closed;
  if (result.error) throw result.error;
  assert.equal(result.code, 0, cli.stderr());
  assert.equal(cli.stdout(), 'synthetic-rotated-access\n');
  assert.equal(cli.stderr(), '');
});

test('identified V1 pending refresh returns the rotated token through real Host and CLI', { timeout: 10_000 }, async (t) => {
  const { directory, provider, adapter, own } = await fixture(t);
  const app = host(provider, adapter);
  own(() => app.dispose());
  await app.service.hydrate();
  await waitForCapability(provider);

  const writer = createKeychainProvider(createCredentialStore({ directory }));
  own(() => writer.close());
  const initial = { ...grant.payload };
  const id = Buffer.alloc(32, 2).toString('base64url');
  const operation = { version: 1, state: 'pending', id, base: refreshBaseId(initial, id) };
  const pending = { kind: 'grant', payload: { ...initial, refreshOperation: operation } };
  await writer.modifyRecord('heluo-iam/session', () => pending);

  let requested = false;
  let pendingReads = 0;
  let observed;
  const observedPending = new Promise((resolve) => { observed = resolve; });
  const readRecord = provider.readRecord.bind(provider);
  provider.readRecord = async (key) => {
    const value = await readRecord(key);
    if (requested && key === 'heluo-iam/session' && value?.payload?.refreshOperation?.state === 'pending') {
      if (++pendingReads === 2) observed();
    }
    return value;
  };
  const server = createRouteServer(own, (req, res) => {
    if (req.url === '/api/forge-iam/bridge/token') requested = true;
    return app.handler(req, res);
  });
  const url = await listen(server);
  const cli = startCli(own, directory, url);
  await Promise.race([
    observedPending,
    cli.closed.then((result) => { throw new Error(`CLI exited before Host observed pending: ${result.code ?? result.signal}`); }),
  ]);
  assert.equal(cli.stdout(), '');
  assert.equal(app.service.getView().error, 'IAM_REAUTH_REQUIRED');

  await writer.modifyRecord('heluo-iam/session', (current) => {
    assert.deepEqual(current, pending);
    return { kind: 'grant', payload: { ...initial, refreshToken: 'synthetic-rotated-refresh',
      accessToken: 'synthetic-rotated-access', refreshOperation: { ...operation, state: 'complete' } } };
  });
  const result = await cli.closed;
  if (result.error) throw result.error;
  assert.equal(result.code, 0, cli.stderr());
  assert.equal(cli.stdout(), `${(await provider.readRecord('heluo-iam/session')).payload.accessToken}\n`);
  assert.equal(cli.stdout(), 'synthetic-rotated-access\n');
  assert.equal(cli.stderr(), '');
});

for (const resource of ['https://gateway.corp.example', null]) test(`identified V1 Host refresh rejects changed identity after removing resource ${String(resource)}`, { timeout: 10_000 }, async (t) => {
  const { directory, provider, adapter, own } = await fixture(t);
  const initial = { ...grant.payload, resource, accessExpiresAt: '2020-01-01T00:00:00.000Z' };

  let requests = 0;
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url) === config.jwksUri) return Response.json({ keys: [] });
    if (String(url) === config.tokenEndpoint && init.method === 'POST') {
      assert.equal(requests, 1, 'refresh must follow the CLI bridge request');
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.has('resource'), false);
      posts++;
      return Response.json({ access_token: 'synthetic-rotated-access', token_type: 'Bearer', expires_in: 3600,
        refresh_token: 'synthetic-rotated-refresh' });
    }
    throw new Error('unexpected synthetic endpoint');
  });
  const app = host(provider, adapter);
  own(() => app.dispose());
  const server = createRouteServer(own, (req, res) => {
    if (req.url === '/api/forge-iam/bridge/token') requests++;
    return app.handler(req, res);
  });
  const url = await listen(server);
  await app.service.hydrate();
  await waitForCapability(provider);
  await provider.modifyRecord('heluo-iam/session', () => ({ kind: 'grant', payload: initial }));
  const cli = startCli(own, directory, url);
  const result = await cli.closed;
  if (result.error) throw result.error;
  const stored = await provider.readRecord('heluo-iam/session');
  assert.equal(posts, 1, `Host performs exactly one refresh POST; requests=${requests}, exit=${result.code}, signal=${result.signal}, stderr=${cli.stderr()}`);
  assert.equal(Object.hasOwn(stored.payload, 'resource'), false);
  assert.equal(stored.payload.refreshOperation.state, 'complete');
  assert.equal(stored.payload.accessToken, 'synthetic-rotated-access');
  assert.equal(stored.payload.refreshToken, 'synthetic-rotated-refresh');
  assert.equal(result.code, 4, cli.stderr());
  assert.equal(cli.stdout(), '');
  assert.match(cli.stderr(), /IAM_CREDENTIALS_UNAVAILABLE/);
});

test('concurrent Host instances initialize one capability in the shared store', async (t) => {
  const { directory, provider: first, adapter: firstAdapter, own } = await fixture(t);
  const secondBackend = createCredentialStore({ directory });
  const second = createKeychainProvider(secondBackend);
  const secondAdapter = createJointStore(secondBackend, namespacePrefixes());
  own(() => second.close());
  const services = [serviceFor(first, firstAdapter), serviceFor(second, secondAdapter)];
  for (const service of services) own(() => service.dispose());
  const values = await Promise.all(services.flatMap((service) => [service.bridgeCapability(), service.bridgeCapability()]));
  assert.equal(new Set(values).size, 1);
  assert.equal((await first.resolve(BRIDGE_REF)).value, values[0]);
  assert.equal((await second.resolve(BRIDGE_REF)).value, values[0]);
});

test('separate Host processes converge after both observe an empty ref', { timeout: 10_000 }, async (t) => {
  const { directory, provider, own } = await fixture(t);
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
    const closed = ownChild(own, child);
    const wait = (type) => new Promise((resolve) => {
      const onMessage = (message) => {
        if (message.type === type || message.type === 'failed') {
          child.off('message', onMessage);
          resolve(message.type === type ? { value: message } : { error: new Error(`bridge worker failed before ${type}`) });
        }
      };
      child.on('message', onMessage);
      closed.then((result) => {
        child.off('message', onMessage);
        resolve({ error: result.error ?? new Error(`bridge worker exited before ${type}: ${result.code}`) });
      });
    });
    return { child, closed, ready: wait('ready'), read: wait('read'), done: wait('done') };
  }
  async function waitAll(workers, type) {
    const results = await Promise.all(workers.map((item) => item[type]));
    for (const result of results) if (result.error) throw result.error;
    return results.map((result) => result.value);
  }
  const workers = [worker(), worker()];
  await waitAll(workers, 'ready');
  workers.forEach((item) => item.child.send('start'));
  await waitAll(workers, 'read');
  workers.forEach((item) => item.child.send('release'));
  const values = await waitAll(workers, 'done');
  assert.equal(values[0].digest, values[1].digest);
  assert.ok((await provider.resolve(BRIDGE_REF))?.value);
  for (const result of await Promise.all(workers.map((item) => item.closed))) {
    if (result.error) throw result.error;
    assert.equal(result.code, 0);
  }
});

test('a failed joint creation leaves neither value; a later invocation can create it', async (t) => {
  const { provider, adapter: actual, own } = await fixture(t);
  let fail = true;
  const adapter = { ...actual, compareAndSwap(...args) {
    if (fail) throw new Error('synthetic write failure');
    return actual.compareAndSwap(...args);
  } };
  const service = serviceFor(provider, adapter);
  own(() => service.dispose());
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
    const { root, provider: first, adapter: firstAdapter, own } = await fixture(t);
    const secondDirectory = join(root, 'replacement');
    const secondBackend = createCredentialStore({ directory: secondDirectory });
    const second = createKeychainProvider(secondBackend);
    const secondAdapter = createJointStore(secondBackend, namespacePrefixes());
    own(() => second.close());
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
    own(() => service.dispose());
    const pending = service.bridgeCapability();
    const outcome = pending.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    own(async () => {
      release();
      if ((await outcome).ok) throw new Error('interrupted bridge initialization unexpectedly succeeded');
    });
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
  const { provider, own } = await fixture(t);
  const service = createService(config, { credentials: provider, verifyAtomicStore: () => false });
  own(() => service.dispose());
  await assert.rejects(service.bridgeCapability());
  assert.equal(await provider.resolve(BRIDGE_REF), undefined);
});
