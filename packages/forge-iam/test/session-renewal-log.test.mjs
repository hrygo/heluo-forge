import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { apply } from '../src/index.mjs';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const start = Date.parse('2030-01-01T00:00:00.000Z');
const issuer = 'https://iam.corp.example';
const config = {
  issuer, clientId: 'synthetic-client', authorizationEndpoint: `${issuer}/authorize`,
  tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`, refreshSkewSeconds: 1,
};
const original = {
  version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
  issuer, clientId: config.clientId, subject: 'synthetic-subject', scope: 'openid',
  obtainedAt: new Date(start).toISOString(), accessExpiresAt: new Date(start + 1800).toISOString(),
  refreshExpiresAt: new Date(start + 120_000).toISOString(),
  accessToken: 'synthetic-original-access', refreshToken: 'synthetic-original-refresh',
};
const rotated = {
  access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh',
  token_type: 'Bearer', expires_in: 7200, refresh_expires_in: 7300,
};

async function until(read, accept, message) {
  const deadline = performance.now() + 5000;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await setImmediate();
  } while (performance.now() < deadline);
  assert.fail(message);
}

async function startHost(t, { credentials = new MemoryCredentials(), fetchJwks, fetchToken, failLog = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'forge-iam-renewal-'));
  if (failLog) await writeFile(join(home, 'logs'), 'not a directory');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const path = join(home, 'logs', 'forge-iam-session-renewal.jsonl');
  const events = (predicate) => until(async () => {
    const content = await readFile(path, 'utf8').catch((cause) => {
      if (cause.code === 'ENOENT') return '';
      throw cause;
    });
    return content.split('\n').slice(0, -1).map(JSON.parse);
  }, (rows) => rows.some(predicate), 'expected renewal diagnostic was not written');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === config.jwksUri) return fetchJwks?.() ?? Response.json({ keys: [] });
    assert.equal(url, config.tokenEndpoint);
    assert.equal(init.method, 'POST');
    posts++;
    return fetchToken?.(init) ?? Response.json(rotated);
  });
  await createGrantStore(credentials).write(original);
  let trusted = true;
  const services = new Map(Object.entries({
    credentials,
    'iam-atomic-store': { verify: (instance) => trusted && instance === credentials },
  }));
  const warnings = [];
  const stop = apply({
    logger: { warn: (message) => warnings.push(message) },
    get(name) { return services.get(name); },
    provide(name, value) { services.set(name, value); return () => services.delete(name); },
    effect(activate) { return activate(); },
    inject([name, ...others], activate) {
      if (!others.length && services.has(name)) return activate({ [name]: services.get(name) });
    },
  }, config);
  let stopped = false;
  const stopHost = async () => {
    if (stopped) return;
    stopped = true;
    if (failLog) await rm(join(home, 'logs'));
    await stop();
    await events((row) => row.event === 'host-stop');
  };
  t.after(async () => {
    try { await stopHost(); }
    finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
  const iam = services.get('iam');
  await until(() => iam.getView(), (view) => view.state === 'ready', 'Host did not hydrate');
  return { iam, credentials, stop: stopHost, events, warnings, posts: () => posts, revokeTrust: () => { trusted = false; } };
}

test('a token endpoint timeout is distinct from an IAM rejection and keeps pending', async (t) => {
  const timeout = AbortSignal.timeout;
  const host = await startHost(t, { fetchToken: ({ signal }) => signal.throwIfAborted() });
  t.mock.method(AbortSignal, 'timeout', (ms) => ms === 5000
    ? AbortSignal.abort(new Error('synthetic-private-timeout')) : timeout(ms));
  t.mock.timers.tick(900);
  const rows = await host.events((row) => row.event === 'refresh-failed');
  const failure = rows.find((row) => row.event === 'refresh-failed');
  assert.equal(failure.stage, 'token-endpoint');
  assert.equal(failure.causeCode, 'IAM_UNREACHABLE');
  assert.equal(failure.code, 'IAM_REAUTH_REQUIRED');
  assert.equal(failure.timedOut, true);
  assert.equal(failure.requestUnsent, undefined);
  assert.equal((await host.credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
  assert.equal(host.posts(), 1);
  assert.doesNotMatch(JSON.stringify(rows), /synthetic-private-timeout/);
});

test('a failed local log write preserves refresh and gives a fixed warning', async (t) => {
  const host = await startHost(t, { failLog: true });
  t.mock.timers.tick(900);
  await until(() => host.iam.getView(), (view) => view.state === 'ready' && view.accessExpiresAt !== original.accessExpiresAt,
    'refresh did not finish');
  await until(() => host.warnings, (lines) => lines.length > 0, 'expected a log write warning');
  assert.deepEqual(host.warnings, ['forge-iam: session renewal diagnostic could not be written']);
  assert.equal(host.posts(), 1);
});

test('Host logs the scheduled refresh through confirmed commit without identity or credential data', async (t) => {
  const host = await startHost(t);
  t.mock.timers.tick(900);
  await until(() => host.iam.getView(), (view) => view.state === 'ready' && view.accessExpiresAt !== original.accessExpiresAt,
    'refresh did not finish');
  assert.equal(host.posts(), 1);
  await host.stop();

  const rows = await host.events((row) => row.event === 'host-stop');
  assert.equal(rows[0].event, 'host-start');
  assert.ok(rows[0].pluginVersion);
  assert.equal(new Set(rows.map(({ hostId }) => hostId)).size, 1);
  const firstTimer = rows.find((row) => row.event === 'renewal-scheduled');
  assert.equal(firstTimer.dueAtMs, start + 900);
  const attempt = rows.filter((row) => row.renewalId === firstTimer.renewalId);
  assert.deepEqual(attempt.filter((row) => row.event === 'refresh-stage').map((row) => row.stage),
    ['discovery', 'jwks', 'claim', 'token-endpoint', 'validate-response', 'commit']);
  assert.ok(attempt.some((row) => row.event === 'renewal-fired' && row.lateMs === 0));
  assert.ok(attempt.some((row) => row.event === 'refresh-committed'
    && row.refreshExpiresAtMs === start + 900 + 7_300_000));
  const recorded = JSON.stringify(rows);
  for (const privateValue of [issuer, original.subject, original.clientId, original.sessionInstanceId,
    original.accessToken, original.refreshToken, rotated.access_token, rotated.refresh_token]) {
    assert.equal(recorded.includes(privateValue), false);
  }
});

test('a transient JWKS failure records the safe preflight retry while the grant stays usable', async (t) => {
  const host = await startHost(t, { fetchJwks: () => Response.json({}, { status: 503 }) });
  t.mock.timers.tick(900);
  const rows = await host.events((row) => row.event === 'renewal-scheduled' && row.backoff === true);
  assert.equal(host.posts(), 0);
  assert.equal(host.iam.getView().state, 'ready');
  const retry = rows.find((row) => row.event === 'refresh-retry');
  assert.equal(retry.reason, 'preflight');
  assert.equal(retry.stage, 'jwks');
  assert.equal(retry.httpStatus, 503);
});

test('a scheduled renewal records when the atomic-store verifier no longer trusts the provider', async (t) => {
  const host = await startHost(t);
  host.revokeTrust();
  t.mock.timers.tick(900);
  const rows = await host.events((row) => row.event === 'renewal-blocked');
  const blocked = rows.find((row) => row.event === 'renewal-blocked');
  assert.equal(blocked.reason, 'atomic-store-unverified');
  assert.ok(rows.some((row) => row.event === 'renewal-fired' && row.renewalId === blocked.renewalId));
  assert.equal(host.posts(), 0);
});

test('logs a credential read lock timeout before any claim or token request', async (t) => {
  const credentials = new MemoryCredentials();
  const host = await startHost(t, { credentials });
  const readRecord = credentials.readRecord.bind(credentials);
  let reads = 0;
  t.mock.method(credentials, 'readRecord', async (key) => {
    if (key === GRANT_KEY && ++reads === 1) {
      throw Object.assign(new Error('synthetic-private-path'), { code: 'CRED_LOCK_TIMEOUT' });
    }
    return readRecord(key);
  });
  t.mock.timers.tick(900);
  assert.equal((await until(() => host.iam.getView(), (view) => view.state === 'unreachable', 'expected read backoff')).error,
    'IAM_CREDENTIALS_UNAVAILABLE');
  assert.equal(host.posts(), 0);
  assert.deepEqual((await readRecord(GRANT_KEY)).payload, original);

  const rows = await host.events((row) => row.event === 'refresh-retry' && row.reason === 'read-lock-timeout');
  const retry = rows.find((row) => row.event === 'refresh-retry');
  assert.equal(retry.stage, 'store-read');
  assert.equal(retry.code, 'IAM_CREDENTIALS_UNAVAILABLE');
  assert.equal(retry.causeCode, 'CRED_LOCK_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(rows), /synthetic-private-path/);
});

for (const [response, reason, oauthError] of [
  [() => Response.json({ error: 'invalid_grant', error_description: 'synthetic-private-response' }, { status: 401 }), 'rejected', 'invalid_grant'],
  [() => Response.json({ ...rotated, refresh_token: original.refreshToken }), 'rotation-unchanged', undefined],
]) {
  test(`logs ${oauthError ?? reason} and preserves the pending grant without retry`, async (t) => {
    const host = await startHost(t, { fetchToken: response });
    t.mock.timers.tick(900);
    await until(() => host.iam.getView(), (view) => view.state === 'error', 'expected session failure');
    const rows = await host.events((row) => row.event === 'refresh-failed');
    const failure = rows.find((row) => row.event === 'refresh-failed');
    assert.equal(failure.reason, reason);
    assert.equal(failure.code, 'IAM_REAUTH_REQUIRED');
    assert.equal(failure.oauthError, oauthError);
    assert.equal(failure.httpStatus, oauthError ? 401 : undefined);
    assert.equal((await host.credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
    assert.equal(host.posts(), 1);
    assert.doesNotMatch(JSON.stringify(rows), /synthetic-private-response/);
  });
}
