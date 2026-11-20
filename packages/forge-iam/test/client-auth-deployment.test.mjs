import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { apply as applyCredentials } from '@heluo/forge-credentials-keychain';
import { apply as applyIam } from '../src/index.mjs';
import { GRANT_KEY } from '../src/store.mjs';
import { signIn } from './support/client-auth-service.mjs';
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

async function deployment(t, { method, authMode }) {
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
  stopIam = applyIam(context, {
    ...mock.endpoints, clientId: mock.clientId, callbackPort: 0, refreshSkewSeconds: 1,
    ...(authMode === 'confidential' ? { authMode, clientAuthMethod: method, clientSecretRef: ref } : {}),
  });
  const service = services.get('iam');
  const args = ['client-secret', 'set', '--issuer', mock.issuer, '--client-id', mock.clientId, '--method', method, '--ref', ref];
  return {
    service, mock, events, args,
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
  assert.equal(failure.code, 'IAM_REAUTH_REQUIRED');
  assert.equal(app.service.getView().state, 'error');
  assert.equal((await app.readGrant()).refreshOperation.state, 'pending');
  await assert.rejects(() => app.service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
  assert.equal(app.mock.counts.token, 2);
  assert.equal(app.mock.counts.refresh, 0);
});

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

for (const method of ['client_secret_basic', 'client_secret_post']) {
  test(`the composed confidential Host uses ${method} at both grants and completes scheduled renewal`, async (t) => {
    const app = await deployment(t, { method, authMode: 'confidential' });
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
    const refreshed = await app.service.syncFromStore();
    assert.equal(refreshed.canSignIn, true);
    await assert.rejects(() => app.service.getAccessToken());
    assert.equal(app.mock.counts.token, 2);
    await signIn(app);
    assert.equal(app.service.getView().state, 'ready');
    assert.equal(app.mock.counts.token, 3);
  });
}
