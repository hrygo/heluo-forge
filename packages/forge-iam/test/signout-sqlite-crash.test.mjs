import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
import { accessTokenOf } from '../src/cli-session.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { createIamService } from './support/trusted-service.mjs';
import { createClientSecretFixture } from './support/client-secret-source.mjs';

const grant = {
  version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: 'https://iam.corp.example', subject: 'synthetic-old-user', clientId: 'test',
  refreshToken: 'synthetic-old-refresh', accessToken: 'synthetic-old-access', scope: 'openid',
  obtainedAt: '2026-01-01T00:00:00.000Z', accessExpiresAt: '2099-01-01T00:00:00.000Z',
};
const options = { verifyAtomicStore: () => true };
const config = {
  issuer: grant.issuer, clientId: grant.clientId,
  authorizationEndpoint: `${grant.issuer}/authorize`, tokenEndpoint: `${grant.issuer}/token`,
  jwksUri: `${grant.issuer}/jwks`, revocationEndpoint: `${grant.issuer}/revoke`,
  redirectUri: 'http://127.0.0.1:4567/iam/callback',
};

function open(directory) {
  const backend = createCredentialStore({ directory });
  const credentials = createKeychainProvider(backend);
  return { backend, credentials, store: createGrantStore(credentials, options) };
}

function assertCompatiblePendingMarker(operation) {
  assert.deepEqual(Object.keys(operation).sort(), ['id', 'state', 'version']);
  assert.equal(operation.version, 1);
  assert.equal(operation.state, 'pending');
  assert.match(operation.id, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
}

test('SQLite restart fences sign-out interrupted during revoke until an explicit retry', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-sqlite-signout-crash-'));
  const directory = join(root, 'store');
  const cleanups = [];
  const own = (cleanup) => cleanups.push(cleanup);
  t.after(async () => {
    const errors = [];
    while (cleanups.length) {
      try { await cleanups.pop()(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed');
    await rm(root, { recursive: true, force: true });
  });
  const first = open(directory);
  own(() => first.backend.close());
  await first.store.write(grant);
  await first.backend.close();

  const script = `
    import { createCredentialStore, createKeychainProvider } from '@heluo/forge-credentials-keychain';
    import { createIamService } from ${JSON.stringify(new URL('../src/service.mjs', import.meta.url).href)};
    const backend = createCredentialStore({ directory: process.argv[1] });
    const credentials = createKeychainProvider(backend);
    const service = createIamService(${JSON.stringify(config)}, { credentials, verifyAtomicStore: () => true, fetch: async () => {
      process.send('revoke-entered');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    } });
    await service.signOut();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
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
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ended = once(child, 'exit');
  const message = once(child, 'message', { signal: AbortSignal.timeout(5000) });
  const result = await Promise.race([
    message.then(([value]) => ({ value })),
    ended.then(([code, signal]) => ({ code, signal })),
  ]);
  assert.equal(result.value, 'revoke-entered', `child ended before callback: ${stderr}`);
  assert.equal(child.kill('SIGKILL'), true);
  const [, signal] = await ended;
  assert.equal(signal, 'SIGKILL');

  const reopened = open(directory);
  own(() => reopened.backend.close());
  const pending = await reopened.credentials.readRecord(GRANT_KEY);
  assertCompatiblePendingMarker(pending.payload.signOutOperation);
  assert.deepEqual(await reopened.store.read(), { ok: false, reason: 'sign-out-pending' });
  assert.deepEqual(accessTokenOf(pending), { ok: false, code: 'IAM_INVALID_GRANT' });
  let callbacks = 0;
  assert.deepEqual(await reopened.store.signOutSnapshot(grant, async () => { callbacks++; }), { ok: true, decision: 'pending' });
  assert.equal(callbacks, 0);

  const service = createIamService(config, { credentials: reopened.credentials, fetch: async (url) => {
    callbacks++;
    assert.equal(new URL(url).searchParams.get('access_token'), grant.accessToken);
    return Response.json({ result: false, errcode: 2002 });
  } });
  own(() => service.dispose());
  assert.equal((await service.signOut()).revocation, 'ok');
  assert.equal(callbacks, 1);
  assert.deepEqual(await reopened.store.read(), { ok: true, grant: null });

  const replacement = { ...grant, subject: 'synthetic-new-user', accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh' };
  await reopened.store.write(replacement);
  assert.deepEqual((await reopened.store.read()).grant, replacement);
  assert.deepEqual(await reopened.store.signOutSnapshot(grant, async () => { callbacks++; }), { ok: true, decision: 'replaced' });
  assert.equal(callbacks, 1);
  assert.deepEqual((await reopened.store.read()).grant, replacement);
});

test('a new Host retries the persisted sign-out only at its original protocol and endpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-sqlite-signout-retry-'));
  const directory = join(root, 'store');
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = open(directory);
  const configured = { ...config, gatewayResource: 'https://resource.corp.example' };
  await first.store.write({ ...grant, resource: configured.gatewayResource });
  const requests = [];
  const firstService = createIamService(configured, { credentials: first.credentials, fetch: async (url, init) => {
    requests.push([new URL(url).pathname, init.method, new URL(url).searchParams.get('access_token')]);
    return new Response(null, { status: 204 });
  } });
  try {
    assert.equal((await firstService.signOut()).revocation, 'unknown');
  } finally {
    await firstService.dispose();
    await first.backend.close();
  }

  const reopened = open(directory);
  const pending = await reopened.credentials.readRecord(GRANT_KEY);
  const allow = async (url, init) => {
    requests.push([new URL(url).pathname, init.method, new URL(url).searchParams.get('access_token')]);
    assert.deepEqual(await reopened.credentials.readRecord(GRANT_KEY), pending);
    return Response.json({ result: false, errcode: 2002 });
  };
  try {
    for (const change of [{ revocationEndpoint: `${grant.issuer}/other` }, { revocationMode: 'rfc7009' },
      { revocationEndpoint: '' }, { gatewayResource: '' }]) {
      const service = createIamService({ ...configured, ...change }, { credentials: reopened.credentials, fetch: allow });
      try {
        assert.equal((await service.signOut()).revocation, 'unknown');
        assert.deepEqual(await reopened.credentials.readRecord(GRANT_KEY), pending);
      } finally { await service.dispose(); }
    }
    const service = createIamService(configured, { credentials: reopened.credentials, fetch: allow });
    try {
      await service.hydrate();
      await assert.rejects(service.resolveToken());
      assert.equal(accessTokenOf(pending).ok, false);
      assert.equal(requests.length, 1);
      assert.equal((await service.signOut()).revocation, 'ok');
      assert.equal((await service.signOut()).revocation, 'skipped');
      assert.deepEqual(await reopened.store.read(), { ok: true, grant: null });
    } finally { await service.dispose(); }
  } finally { await reopened.backend.close(); }
  assert.deepEqual(requests, [
    ['/revoke', 'GET', grant.accessToken], ['/revoke', 'GET', grant.accessToken],
  ]);
});

test('RFC 7009 sign-out authenticates under the stored pin and revokes only the refresh token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-sqlite-signout-rfc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = open(join(root, 'store'));
  const fixture = createClientSecretFixture(opened.credentials, { issuer: grant.issuer, clientId: grant.clientId });
  const pinned = fixture.snapshot();
  const confidential = { ...grant, version: 2, authContext: {
    mode: 'confidential', method: fixture.config.clientAuthMethod,
    secretRef: fixture.config.clientSecretRef, secretRevision: pinned.revision,
  } };
  const calls = [];
  let marker;
  const service = createIamService({ ...config, ...fixture.config, revocationMode: 'rfc7009' }, {
    ...fixture.options, fetch: async (url, init) => {
      marker = (await opened.credentials.readRecord(GRANT_KEY)).payload.signOutOperation;
      calls.push({ target: new URL(url).pathname, method: init.method,
        authorization: Boolean(init.headers.authorization), fields: Object.fromEntries(new URLSearchParams(init.body)) });
      return new Response(null, { status: 200 });
    },
  });
  try {
    await opened.store.write(confidential);
    fixture.replace();
    assert.equal((await service.signOut()).revocation, 'unknown');
    assert.equal(calls.length, 0);
    fixture.restore(pinned);
    assert.equal((await service.signOut()).revocation, 'ok');
    assertCompatiblePendingMarker(marker);
    assert.deepEqual(calls, [{ target: '/revoke', method: 'POST', authorization: true,
      fields: { token: grant.refreshToken, token_type_hint: 'refresh_token' } }]);
    assert.deepEqual(await opened.store.read(), { ok: true, grant: null });
  } finally {
    await service.dispose();
    await opened.backend.close();
  }
});

test('a legacy pending sign-out recovers only through an explicitly configured issuer-origin D1 endpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-sqlite-signout-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = open(join(root, 'store'));
  try {
    await opened.store.write(grant);
    await opened.store.signOutSnapshot(grant, () => { throw new Error('interrupted legacy revoke'); });
    const pending = await opened.credentials.readRecord(GRANT_KEY);
    assert.equal(pending.payload.signOutOperation.version, 1);
    let calls = 0;
    const fetch = async () => { calls++; return Response.json({ result: true }); };
    for (const change of [{ revocationEndpoint: 'https://other.corp.example/revoke' }, { revocationMode: 'rfc7009' }]) {
      const service = createIamService({ ...config, ...change }, { credentials: opened.credentials, fetch });
      try {
        assert.equal((await service.signOut()).revocation, 'unknown');
        assert.deepEqual(await opened.credentials.readRecord(GRANT_KEY), pending);
      } finally { await service.dispose(); }
    }
    assert.equal(calls, 0);
    const service = createIamService(config, { credentials: opened.credentials, fetch });
    try {
      assert.equal((await service.signOut()).revocation, 'ok');
      assert.equal(calls, 1);
      assert.deepEqual(await opened.store.read(), { ok: true, grant: null });
    } finally { await service.dispose(); }
  } finally { await opened.backend.close(); }
});

test('concurrent Hosts can confirm the same pending revoke and commit only one tombstone', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-sqlite-signout-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'store');
  const first = open(directory);
  const other = open(directory);
  const simultaneous = Promise.withResolvers();
  let requests = 0;
  let writes = 0;
  const fetch = async () => {
    if (++requests === 2) simultaneous.resolve();
    await simultaneous.promise;
    return Response.json({ result: true });
  };
  const services = [first, other].map(({ credentials }) => createIamService(config, { credentials, fetch }));
  try {
    await first.store.write(grant);
    await first.store.signOutSnapshot(grant, () => { throw new Error('interrupted revoke'); });
    for (const { credentials } of [first, other]) {
      const modifyRecord = credentials.modifyRecord.bind(credentials);
      credentials.modifyRecord = (key, mutate) => modifyRecord(key, (current) => {
        const next = mutate(current);
        if (next?.payload?.type === 'heluo-iam-session-tombstone') writes++;
        return next;
      });
    }
    const results = await Promise.all(services.map((service) => service.signOut()));
    assert.deepEqual(results.map((result) => result.revocation).sort(), ['ok', 'unknown']);
    assert.equal(requests, 2);
    assert.equal(writes, 1);
    assert.deepEqual(await first.store.read(), { ok: true, grant: null });
  } finally {
    simultaneous.resolve();
    await Promise.all(services.map((service) => service.dispose()));
    await Promise.all([first.backend.close(), other.backend.close()]);
  }
});

test('a delayed confirmation from an expired revoke cannot clear a replacement session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-sqlite-signout-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = open(join(root, 'store'));
  const late = Promise.withResolvers();
  let signal;
  const service = createIamService({ ...config, httpTimeoutMs: 30 }, { credentials: opened.credentials,
    fetch: async (_, init) => { signal = init.signal; return late.promise; },
  });
  try {
    await opened.store.write(grant);
    assert.equal((await service.signOut()).revocation, 'unknown');
    assert.equal(signal?.aborted, true);
    assert.equal((await opened.credentials.readRecord(GRANT_KEY)).payload.signOutOperation.state, 'pending');
    const replacement = { ...grant, sessionInstanceId: Buffer.alloc(32, 6).toString('base64url') };
    await opened.store.write(replacement);
    late.resolve(Response.json({ result: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await opened.store.read(), { ok: true, grant: replacement });
  } finally {
    late.resolve(Response.json({ result: true }));
    await service.dispose();
    await opened.backend.close();
  }
});

for (const sameLogin of [false, true]) {
  test(`a Host signing out of its adopted login ${sameLogin ? 'honors its rotation' : 'preserves a peer replacement even on retry'}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'forge-sqlite-signout-adopted-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, 'store');
    const opened = open(directory);
    const peer = open(directory);
    const requests = [];
    const service = createIamService(config, { credentials: opened.credentials, fetch: async (url) => {
      requests.push(new URL(url).searchParams.get('access_token'));
      return Response.json({ result: true });
    } });
    try {
      await opened.store.write(grant);
      assert.equal((await service.hydrate()).state, 'ready');
      const replacement = { ...grant, accessToken: 'synthetic-peer-access', refreshToken: 'synthetic-peer-refresh',
        ...(sameLogin ? {} : { sessionInstanceId: Buffer.alloc(32, 8).toString('base64url') }) };
      await peer.store.write(replacement);
      if (sameLogin) {
        assert.equal((await service.signOut()).revocation, 'ok');
        assert.deepEqual(requests, [replacement.accessToken]);
        assert.deepEqual(await peer.store.read(), { ok: true, grant: null });
      } else {
        assert.equal((await service.signOut()).revocation, 'unknown');
        assert.equal((await service.signOut()).revocation, 'unknown');
        assert.deepEqual(requests, []);
        assert.deepEqual(await peer.store.read(), { ok: true, grant: replacement });
      }
    } finally {
      await service.dispose();
      await Promise.all([opened.backend.close(), peer.backend.close()]);
    }
  });
}

for (const missing of ['endpoint', 'access token']) {
  test(`a bound local-only sign-out with no ${missing} can resume after a failed commit`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'forge-sqlite-signout-local-only-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, 'store');
    const first = open(directory);
    const configured = missing === 'endpoint' ? { ...config, revocationEndpoint: '' } : config;
    const saved = missing === 'access token' ? { ...grant, accessToken: null, accessExpiresAt: null } : grant;
    let requests = 0;
    const fetch = async () => { requests++; return Response.json({ result: true }); };
    const firstService = createIamService(configured, { credentials: first.credentials, fetch });
    try {
      await first.store.write(saved);
      const modifyRecord = first.credentials.modifyRecord.bind(first.credentials);
      first.credentials.modifyRecord = (key, mutate) => modifyRecord(key, (current) => {
        const next = mutate(current);
        if (next?.payload?.type === 'heluo-iam-session-tombstone') throw new Error('interrupted local exit');
        return next;
      });
      assert.equal((await firstService.signOut()).revocation, 'unknown');
      assertCompatiblePendingMarker((await first.credentials.readRecord(GRANT_KEY)).payload.signOutOperation);
    } finally {
      await firstService.dispose();
      await first.backend.close();
    }
    const reopened = open(directory);
    const service = createIamService(configured, { credentials: reopened.credentials, fetch });
    try {
      assert.equal((await service.signOut()).revocation, 'skipped');
      assert.deepEqual(await reopened.store.read(), { ok: true, grant: null });
      assert.equal(requests, 0);
    } finally {
      await service.dispose();
      await reopened.backend.close();
    }
  });
}
