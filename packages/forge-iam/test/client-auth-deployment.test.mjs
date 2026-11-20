import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { apply as applyCredentials } from '@heluo/forge-credentials-keychain';
import { apply as applyIam } from '../src/index.mjs';
import { GRANT_KEY } from '../src/store.mjs';
import { authorization, signIn } from './support/client-auth-service.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';

const cli = fileURLToPath(new URL('../bin/heluo-forge.mjs', import.meta.url));
const secret = 'fixture secret:密+码';
const ref = 'enterprise-oidc';

async function command(directory, args, input) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { HELUO_FORGE_STORE_DIRECTORY: directory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

async function deployment(t, { method, authMode, useDiscovery = false, wrapSecretSource } = {}) {
  const mock = await startMockOidc({
    clientAuthMethod: method, clientSecret: secret, allowPublicCodeExchange: authMode === 'public', accessTtl: 60,
  });
  const home = await mkdtemp(join(tmpdir(), 'forge-iam-client-auth-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const storeDirectory = join(home, 'credentials');
  const log = join(home, 'logs', 'forge-iam-session-renewal.jsonl');
  const services = new Map();
  const context = {
    get: (name) => services.get(name),
    provide(name, value) { services.set(name, value); return () => services.delete(name); },
    effect: (activate) => activate(),
    inject(names, activate) {
      if (names.every((name) => services.has(name))) {
        return activate(Object.fromEntries(names.map((name) => [name, services.get(name)])));
      }
    },
  };
  // Advance only the Host's renewal slot. SQLite and HTTP retain real timers.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const setTimeout = globalThis.setTimeout;
  let firstRenewal;
  t.mock.method(globalThis, 'setTimeout', (fire, delay, ...args) => {
    const timer = setTimeout(fire, delay, ...args);
    if (delay === 59_000 && !firstRenewal) firstRenewal = { fire, timer };
    return timer;
  });
  const stopCredentials = applyCredentials(context, { storeDirectory });
  if (wrapSecretSource) {
    services.set('iam-client-secret-source', wrapSecretSource(services.get('iam-client-secret-source')));
  }
  let stopIam;
  async function events(predicate) {
    const deadline = performance.now() + 5000;
    do {
      const lines = await readFile(log, 'utf8').catch((cause) => {
        if (cause.code === 'ENOENT') return '';
        throw cause;
      });
      const rows = lines.split('\n').slice(0, -1).map(JSON.parse);
      if (rows.some(predicate)) return rows;
      await setImmediate();
    } while (performance.now() < deadline);
    assert.fail('expected IAM session renewal event');
  }
  t.after(async () => {
    try {
      if (stopIam) {
        await stopIam();
        await events((row) => row.event === 'host-stop');
      }
    } finally {
      await stopCredentials();
      await mock.close();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
  const endpoints = useDiscovery ? { discoveryUrl: `${mock.issuer}/.well-known/openid-configuration` } : mock.endpoints;
  stopIam = applyIam(context, {
    ...endpoints, clientId: mock.clientId, callbackPort: 0, refreshSkewSeconds: 1,
    ...(authMode === 'confidential' ? { authMode, clientAuthMethod: method, clientSecretRef: ref, allowInsecureClientAuthHttp: true } : {}),
  });
  const service = services.get('iam');
  const args = ['client-secret', 'set', '--issuer', mock.issuer, '--client-id', mock.clientId, '--method', method, '--ref', ref];
  return {
    service, mock, events, args, storeDirectory, credentials: services.get('credentials'),
    readGrant: async () => (await services.get('credentials').readRecord(GRANT_KEY))?.payload,
    setSecret: (input, commandArgs = args) => command(storeDirectory, commandArgs, input),
    auth: (...commandArgs) => command(storeDirectory, ['auth', ...commandArgs]),
    async renew() {
      const rows = await events((row) => row.event === 'renewal-scheduled');
      const scheduled = rows.find((row) => row.event === 'renewal-scheduled');
      assert.ok(firstRenewal, 'expected the timer set for the first scheduled renewal');
      t.mock.timers.setTime(scheduled.dueAtMs + 1);
      clearTimeout(firstRenewal.timer);
      firstRenewal.fire();
    },
  };
}

test('the enterprise endpoint rejects a public session at its first scheduled refresh without replay', async (t) => {
  const app = await deployment(t, { method: 'client_secret_post', authMode: 'public' });
  await signIn(app);
  assert.equal(app.mock.counts.token, 1);
  await app.renew();
  const rows = await app.events((row) => row.event === 'renewal-failed');
  const failure = rows.find((row) => row.event === 'refresh-failed');
  assert.equal(failure.stage, 'token-endpoint');
  assert.equal(failure.httpStatus, 401);
  assert.equal(failure.oauthErrorResponse, 'empty');
  assert.equal(failure.clientAuthMethod, 'none');
  assert.equal(failure.code, 'IAM_REAUTH_REQUIRED');
  assert.equal(app.service.getView().state, 'error');
  const pending = await app.readGrant();
  assert.equal(pending.refreshOperation.state, 'pending');
  await assert.rejects(() => app.service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(app.mock.counts.token, 2);
  assert.equal(app.mock.counts.refresh, 0);

  await signIn(app);
  const restored = await app.readGrant();
  assert.notEqual(restored.sessionInstanceId, pending.sessionInstanceId);
  assert.equal(restored.refreshOperation, undefined);
  assert.equal(app.service.getView().state, 'ready');
  assert.equal(app.mock.counts.token, 3);
  assert.equal(app.mock.counts.refresh, 0);
});

test('logs a nonstandard code exchange 401 without copying the provider response', async (t) => {
  const fetch = globalThis.fetch;
  let sentAuthorization;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (init?.method !== 'POST' || new URL(url).pathname !== '/token') return fetch(url, init);
    sentAuthorization = init.headers.authorization;
    return new Response('<html>synthetic-private-exchange-response</html>', { status: 401 });
  });
  const app = await deployment(t, { method: 'client_secret_basic', authMode: 'confidential' });
  const saved = await app.setSecret(secret);
  assert.equal(saved.code, 0, saved.stderr);
  const callback = await authorization(app.service);
  await assert.rejects(() => app.service.handleCallback(callback), { code: 'IAM_HTTP_ERROR' });
  const rows = await app.events((row) => row.event === 'code-exchange-failed');
  const failure = rows.find((row) => row.event === 'code-exchange-failed');
  assert.equal(failure.stage, 'token-endpoint');
  assert.equal(failure.httpStatus, 401);
  assert.equal(failure.clientAuthMethod, 'client_secret_basic');
  assert.equal(failure.oauthErrorResponse, 'nonstandard');
  assert.equal(failure.oauthError, undefined);
  const content = JSON.stringify(rows);
  assert.equal(sentAuthorization?.startsWith('Basic '), true);
  assert.equal(content.includes(sentAuthorization), false);
  assert.equal(content.includes(new URL(callback).searchParams.get('code')), false);
  assert.equal(content.includes('synthetic-private-exchange-response'), false);
  assert.equal(content.includes(secret), false);
});

test('logs a refresh 401 and the method that was used even after the client secret rotates', async (t) => {
  const fetch = globalThis.fetch;
  let rotateSecret;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init?.method !== 'POST' || new URL(url).pathname !== '/token') return fetch(url, init);
    const form = new URLSearchParams(init.body);
    if (form.get('grant_type') !== 'refresh_token') return fetch(url, init);
    assert.equal(form.has('client_secret'), true);
    await rotateSecret();
    return new Response(null, { status: 401 });
  });
  const app = await deployment(t, { method: 'client_secret_post', authMode: 'confidential' });
  rotateSecret = async () => {
    const saved = await app.setSecret('synthetic-rotated-client-secret');
    assert.equal(saved.code, 0, saved.stderr);
  };
  const saved = await app.setSecret(secret);
  assert.equal(saved.code, 0, saved.stderr);
  await signIn(app);
  await app.renew();
  const rows = await app.events((row) => row.event === 'refresh-failed');
  const failure = rows.find((row) => row.event === 'refresh-failed');
  assert.equal(failure.code, 'IAM_CLIENT_AUTH_CHANGED');
  assert.equal(failure.causeCode, 'IAM_HTTP_ERROR');
  assert.equal(failure.httpStatus, 401);
  assert.equal(failure.clientAuthMethod, 'client_secret_post');
  assert.equal(failure.oauthErrorResponse, 'empty');
  const content = JSON.stringify(rows);
  assert.equal(content.includes(secret), false);
  assert.equal(content.includes('synthetic-rotated-client-secret'), false);
});

test('scheduled confidential renewal tolerates a SQLite writer after persisting its claim', async (t) => {
  const app = await deployment(t, { method: 'client_secret_basic', authMode: 'confidential' });
  const provisioned = await app.setSecret(secret);
  assert.equal(provisioned.code, 0, provisioned.stderr);
  await signIn(app);

  const writer = new DatabaseSync(join(app.storeDirectory, 'credentials.sqlite'));
  let locked = false;
  let lockedAfterClaim = false;
  let releaseTimer;
  const release = () => {
    if (!locked) return;
    writer.exec('ROLLBACK');
    locked = false;
  };
  t.after(() => {
    clearTimeout(releaseTimer);
    release();
    writer.close();
  });
  const modifyRecord = app.credentials.modifyRecord.bind(app.credentials);
  t.mock.method(app.credentials, 'modifyRecord', async (...args) => {
    const result = await modifyRecord(...args);
    if (!lockedAfterClaim && result?.payload.refreshOperation?.state === 'pending') {
      writer.exec('BEGIN EXCLUSIVE');
      locked = lockedAfterClaim = true;
      releaseTimer = setTimeout(release, 25);
    }
    return result;
  });

  await app.renew();
  const rows = await app.events((row) => ['refresh-committed', 'renewal-failed'].includes(row.event));
  assert.equal(lockedAfterClaim, true);
  assert.ok(rows.some((row) => row.event === 'refresh-committed'), JSON.stringify(rows.filter((row) => row.event === 'refresh-failed')));
  assert.equal(app.mock.counts.refresh, 1);
  assert.equal((await app.readGrant()).refreshOperation.state, 'complete');
});

for (const operation of ['getAccessToken', 'scheduled renewal']) {
  test(`confidential ${operation} tolerates a writer after successful client auth validation`, async (t) => {
    let armWriter;
    let receivedRefresh = false;
    let preparedReads = 0;
    let requesting = false;
    if (operation === 'scheduled renewal') {
      const fetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        const response = await fetch(url, init);
        if (new URLSearchParams(init?.body).get('grant_type') === 'refresh_token') receivedRefresh = response.ok;
        return response;
      });
    }
    const app = await deployment(t, {
      method: 'client_secret_post', authMode: 'confidential',
      wrapSecretSource: (port) => ({
        ...port,
        async retryRead(snapshot, check) {
          const result = await port.retryRead(snapshot, check);
          // The second preparation check returns the pin to the token consumer.
          if (receivedRefresh || (requesting && ++preparedReads === 2)) armWriter();
          return result;
        },
      }),
    });
    const provisioned = await app.setSecret(secret);
    assert.equal(provisioned.code, 0, provisioned.stderr);
    await signIn(app);
    const initial = await app.readGrant();

    const writer = new DatabaseSync(join(app.storeDirectory, 'credentials.sqlite'));
    let locked = false;
    let lockObserved = false;
    let timer;
    const release = () => {
      if (!locked) return;
      writer.exec('ROLLBACK');
      locked = false;
    };
    armWriter = () => {
      if (lockObserved) return;
      writer.exec('BEGIN EXCLUSIVE');
      locked = lockObserved = true;
      timer = setTimeout(release, 25);
    };
    t.after(() => { clearTimeout(timer); release(); writer.close(); });

    if (operation === 'getAccessToken') {
      requesting = true;
      assert.equal(await app.service.getAccessToken(), initial.accessToken);
      assert.equal(app.mock.counts.refresh, 0);
    } else {
      await app.renew();
      const rows = await app.events((row) => ['refresh-committed', 'renewal-failed'].includes(row.event));
      assert.ok(rows.some((row) => row.event === 'refresh-committed'),
        JSON.stringify(rows.filter((row) => row.event === 'refresh-failed')));
      assert.equal(app.mock.counts.refresh, 1);
      assert.equal((await app.readGrant()).refreshOperation.state, 'complete');
    }
    assert.equal(lockObserved, true);
    assert.equal(app.service.getView().state, 'ready');
  });
}

for (const scenario of ['released', 'busy', 'rotated', 'sign-out', 'prepare', 'after-response']) {
  test(`confidential renewal handles a pin read lock timeout when ${scenario}`, { timeout: 60_000 }, async (t) => {
    let lock;
    let release;
    let locked = false;
    let pending;
    let readTimeouts = 0;
    let rotated = false;
    let signOut;
    let app;
    if (scenario === 'after-response') {
      const fetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        const response = await fetch(url, init);
        if (new URLSearchParams(init?.body).get('grant_type') === 'refresh_token') lock();
        return response;
      });
    }
    app = await deployment(t, {
      method: 'client_secret_post', authMode: 'confidential',
      wrapSecretSource: (port) => ({
        ...port,
        async read(scope) {
          const snapshot = await port.read(scope);
          if (scenario === 'prepare' && pending && readTimeouts === 0) lock();
          return snapshot;
        },
        async retryRead(snapshot, check) {
          if (locked && readTimeouts === 1 && ['released', 'rotated', 'sign-out'].includes(scenario)) {
            release();
            if (scenario === 'rotated') {
              const result = await app.setSecret('synthetic-new-client-secret');
              assert.equal(result.code, 0, result.stderr);
              rotated = true;
            }
            if (scenario === 'sign-out') signOut = app.service.signOut();
          }
          try {
            return await port.retryRead(snapshot, () => {
              // Exhaust the real SQLite retry budget without sleeping or freezing its clock.
              if (locked) t.mock.timers.setTime(Date.now() + 5001);
              return check();
            });
          } catch (cause) {
            if (cause?.code === 'CRED_LOCK_TIMEOUT') readTimeouts++;
            throw cause;
          }
        },
      }),
    });
    const provisioned = await app.setSecret(secret);
    assert.equal(provisioned.code, 0, provisioned.stderr);
    await signIn(app);
    const original = await app.readGrant();

    const writer = new DatabaseSync(join(app.storeDirectory, 'credentials.sqlite'));
    lock = () => { writer.exec('BEGIN EXCLUSIVE'); locked = true; };
    release = () => { if (locked) writer.exec('ROLLBACK'); locked = false; };
    t.after(() => { release(); writer.close(); });
    const modify = app.credentials.modifyRecord.bind(app.credentials);
    t.mock.method(app.credentials, 'modifyRecord', async (...args) => {
      const result = await modify(...args);
      if (!pending && result?.payload.refreshOperation?.state === 'pending') {
        pending = structuredClone(result.payload);
        if (!['prepare', 'after-response'].includes(scenario)) lock();
      }
      return result;
    });

    let rows;
    try {
      await app.renew();
      rows = await app.events((row) => row.event === 'renewal-failed');
    } finally { release(); }
    assert.ok(pending);
    assert.equal(app.mock.counts.refresh, scenario === 'after-response' ? 1 : 0);
    if (scenario === 'released') {
      assert.ok(rows.some((row) => row.event === 'refresh-retry' && row.reason === 'request-unsent'
        && row.causeCode === 'CRED_LOCK_TIMEOUT'));
      assert.deepEqual(await app.readGrant(), original);
      assert.equal(app.service.getView().state, 'expired');
      await app.service.getAccessToken();
      assert.equal(app.mock.counts.refresh, 1);
      assert.equal((await app.readGrant()).refreshOperation.state, 'complete');
    } else if (scenario === 'sign-out') {
      assert.ok(signOut);
      assert.equal((await signOut).view.signedIn, false);
      assert.ok(rows.some((row) => row.event === 'refresh-failed' && row.code === 'IAM_DISPOSED'));
      assert.notDeepEqual(await app.readGrant(), original);
    } else {
      const failure = rows.find((row) => row.event === 'refresh-failed');
      const expectedCode = scenario === 'rotated' ? 'IAM_CLIENT_AUTH_CHANGED' : 'IAM_CREDENTIALS_UNAVAILABLE';
      assert.equal(failure.code, expectedCode);
      assert.equal(failure.causeCode, scenario === 'rotated' ? expectedCode : 'CRED_LOCK_TIMEOUT');
      assert.deepEqual(await app.readGrant(), pending);
      assert.equal(app.service.getView().state, 'error');
    }
    assert.equal(rotated, scenario === 'rotated');
    assert.equal(readTimeouts, scenario === 'busy' ? 2 : 1);
  });
}

test('an administrator can replace the exact misbound client secret before first login', async (t) => {
  const method = 'client_secret_post';
  const app = await deployment(t, { method, authMode: 'confidential' });
  const mistakenIssuer = `${app.mock.issuer}/.well-known/openid-configuration`;
  const misbound = app.args.map((arg) => arg === app.mock.issuer ? mistakenIssuer : arg);
  const replacement = [
    'client-secret', 'replace', ...app.args.slice(2),
    '--old-issuer', mistakenIssuer, '--old-client-id', app.mock.clientId, '--old-method', method,
  ];

  const provisioned = await app.setSecret(secret, misbound);
  assert.equal(provisioned.code, 0, provisioned.stderr);
  await assert.rejects(() => app.service.startSignIn(), { code: 'IAM_CLIENT_AUTH_UNVERIFIED' });
  const ordinaryWrite = await app.setSecret(secret);
  assert.equal(ordinaryWrite.code, 4);
  assert.match(ordinaryWrite.stderr, /IAM_CLIENT_SECRET_BINDING_MISMATCH/);

  for (const [option, value] of [['--old-client-id', 'other-client'], ['--old-method', 'client_secret_basic']]) {
    const mismatched = [...replacement];
    mismatched[mismatched.indexOf(option) + 1] = value;
    const refused = await app.setSecret(secret, mismatched);
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, /IAM_CLIENT_SECRET_BINDING_MISMATCH/);
  }

  const attempts = await Promise.all([
    app.setSecret(secret, replacement),
    app.setSecret(secret, replacement),
  ]);
  assert.deepEqual(attempts.map(({ code }) => code).sort(), [0, 4], attempts.map(({ stderr }) => stderr).join('\n'));
  assert.match(attempts.find(({ code }) => code === 4).stderr, /IAM_CLIENT_SECRET_BINDING_MISMATCH/);
  assert.ok(attempts.every(({ stdout, stderr }) => !stdout.includes(secret) && !stderr.includes(secret)));
  await signIn(app);
  assert.equal(app.service.getView().state, 'ready');
  assert.equal(app.mock.counts.token, 1);
});

test('client secret replacement refuses an absent record and an incomplete old binding', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'forge-iam-client-secret-replace-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'credentials');
  const issuer = 'https://iam.corp.example';
  const clientId = 'fixture-client';
  const method = 'client_secret_basic';
  const replacement = [
    'client-secret', 'replace', '--issuer', issuer, '--client-id', clientId, '--method', method, '--ref', ref,
    '--old-issuer', issuer, '--old-client-id', clientId, '--old-method', method,
  ];
  assert.equal((await command(directory, replacement.slice(0, -2), secret)).code, 64);
  const absent = await command(directory, replacement, secret);
  assert.equal(absent.code, 4);
  assert.match(absent.stderr, /IAM_CLIENT_SECRET_BINDING_MISMATCH/);
  await assert.rejects(() => stat(directory), { code: 'ENOENT' });
  await assert.rejects(() => stat(`${directory}.keys`), { code: 'ENOENT' });
});

test('client secret commands diagnose invalid arguments and empty input without initializing storage', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'forge-iam-client-secret-usage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'credentials');
  const issuer = 'https://iam.corp.example';
  const clientId = 'fixture-client';
  const method = 'client_secret_basic';
  const binding = ['--issuer', issuer, '--client-id', clientId, '--method', method, '--ref', ref];
  const set = ['client-secret', 'set', ...binding];
  const replace = ['client-secret', 'replace', ...binding,
    '--old-issuer', issuer, '--old-client-id', clientId, '--old-method', method];
  for (const [args, flag, value] of [[set, '--issuer', ''], [replace, '--old-client-id', ' ']]) {
    args[args.indexOf(flag) + 1] = value;
    const result = await command(directory, args, secret);
    assert.equal(result.code, 64, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(`选项 ${flag} 需要非空值`));
    assert.ok(!result.stderr.includes(secret));
  }

  const invalid = await command(directory, ['client-secret', 'set', ...binding, '--fixture-unrecognized=synthetic-arg'], secret);
  assert.equal(invalid.code, 64);
  assert.match(invalid.stderr, /参数格式有误/u);
  assert.doesNotMatch(invalid.stderr, /synthetic-arg/u);

  const empty = await command(directory, ['client-secret', 'set', ...binding], '');
  assert.equal(empty.code, 4);
  assert.match(empty.stderr, /标准输入缺少密钥内容/u);
  await assert.rejects(() => stat(directory), { code: 'ENOENT' });
  await assert.rejects(() => stat(`${directory}.keys`), { code: 'ENOENT' });
});

for (const method of ['client_secret_basic', 'client_secret_post']) {
  test(`the confidential Host uses ${method} with HTTP Discovery and completes scheduled renewal`, async (t) => {
    const app = await deployment(t, { method, authMode: 'confidential', useDiscovery: true });
    await assert.rejects(() => app.service.startSignIn(), { code: 'IAM_CLIENT_AUTH_UNVERIFIED' });
    assert.equal(app.mock.counts.authorize, 0);
    assert.equal(app.mock.counts.token, 0);

    const provisioned = await app.setSecret(secret);
    assert.equal(provisioned.code, 0, provisioned.stderr);
    assert.equal(provisioned.stderr, '');
    assert.ok(!provisioned.stdout.includes(secret));
    await signIn(app);
    const first = await app.readGrant();
    assert.equal(first.version, 2);
    assert.equal(first.authContext.method, method);
    assert.equal(first.authContext.secretRef, ref);
    assert.ok(!JSON.stringify(first).includes(secret));

    await app.renew();
    const rows = await app.events((row) => row.event === 'refresh-committed');
    assert.ok(rows.some((row) => row.event === 'refresh-stage' && row.stage === 'token-endpoint'
      && row.clientAuthMethod === method));
    assert.equal(app.service.getView().state, 'ready');
    assert.equal(app.mock.counts.token, 2);
    assert.equal(app.mock.counts.refresh, 1);
    const current = await app.readGrant();
    assert.notEqual(current.refreshToken, first.refreshToken);
    assert.equal(current.refreshOperation.state, 'complete');
    assert.equal(await app.service.getAccessToken(), current.accessToken);
    const offline = await app.auth('token');
    assert.equal(offline.code, 0, offline.stderr);
    assert.equal(offline.stdout, `${current.accessToken}\n`);
    assert.ok(!JSON.stringify(rows).includes(secret));
    assert.ok(!JSON.stringify(rows).includes(ref));
    assert.ok(!JSON.stringify(rows).includes(first.authContext.secretRevision));

    const wrongBinding = app.args.map((arg) => arg === app.mock.clientId ? 'other-client' : arg);
    assert.notEqual((await app.setSecret(secret, wrongBinding)).code, 0);
    assert.equal((await app.auth('token')).code, 0);
    assert.equal((await app.setSecret(secret)).code, 0);
    const outdated = await app.auth('token');
    assert.equal(outdated.code, 3);
    assert.equal(outdated.stdout, '');
    assert.match(outdated.stderr, /IAM_REAUTH_REQUIRED/);
    assert.match(outdated.stderr, /客户端密钥.*重新登录/u);
    const identity = await app.auth('whoami');
    assert.equal(identity.code, 0);
    assert.equal(identity.stderr, '');
    assert.match(identity.stdout, /客户端密钥.*重新登录/u);
    const identityJson = await app.auth('whoami', '--json');
    assert.equal(JSON.parse(identityJson.stdout).status, 'error');
    assert.ok(![outdated.stderr, identity.stdout, identityJson.stdout].some((output) =>
      output.includes(secret) || output.includes(current.accessToken)));
    const refreshed = await app.service.syncFromStore();
    assert.equal(refreshed.canSignIn, true);
    await assert.rejects(() => app.service.getAccessToken());
    assert.equal(app.mock.counts.token, 2);
    await signIn(app);
    assert.equal(app.service.getView().state, 'ready');
    assert.equal(app.mock.counts.token, 3);
  });
}
