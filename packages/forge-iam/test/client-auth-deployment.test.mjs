import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    await assert.rejects(() => app.service.getAccessToken());
    assert.equal(app.mock.counts.token, 2);
  });
}
