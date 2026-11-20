import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, on } from 'node:events';
import { appendFile, link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { apply } from '../src/index.mjs';
import { OidcError } from '../src/oidc.mjs';
import { createSessionRenewalLogger, renewalErrorFields } from '../src/session-renewal-log.mjs';
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

const parseRows = (content) => content.split('\n').slice(0, -1).map(JSON.parse);
const loggerUrl = new URL('../src/session-renewal-log.mjs', import.meta.url).href;
const lockSuffix = '.lock.sqlite';
const maxFileBytes = 1024 * 1024;
const seedRow = '{"event":"host-start"}\n';
const fullGeneration = seedRow.repeat(Math.floor(maxFileBytes / Buffer.byteLength(seedRow)));

function logProcess(home, role) {
  const source = `
    import fs, { appendFile } from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { DatabaseSync } from 'node:sqlite';
    const [home, role] = process.argv.slice(1);
    process.on('message', (message) => {
      if (message === 'stop') process.disconnect();
      if (Number.isInteger(message)) log('renewal-fired', { renewalId: message });
    });
    // Both branches use real IO. The messages expose the competing write at
    // the point where a writer can first reach rename or hit the kernel lock.
    const rename = fs.rename;
    fs.rename = async (...args) => {
      const released = new Promise((resolve) => process.once('message', resolve));
      process.send('rotate');
      await released;
      await rename(...args);
    };
    syncBuiltinESMExports();
    const exec = DatabaseSync.prototype.exec;
    let contentionReported = false;
    DatabaseSync.prototype.exec = function (sql) {
      try { return exec.call(this, sql); }
      catch (error) {
        if (!contentionReported && sql === 'BEGIN IMMEDIATE' && error.errcode === 5) {
          contentionReported = true;
          process.send('contended');
        }
        throw error;
      }
    };
    const { createSessionRenewalLogger } = await import(${JSON.stringify(loggerUrl)});
    const log = createSessionRenewalLogger({
      home,
      async append(...args) {
        await appendFile(...args);
        process.send('appended');
      },
      warn: () => process.send('warned'),
    });
    log('renewal-fired', { renewalId: role === 'first' ? 1 : 2 });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, home, role], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const closed = once(child, 'close');
  const messages = on(child, 'message', { close: ['close'] });
  return {
    child, closed,
    async next() {
      const { value, done } = await messages.next();
      assert.equal(done, false, `${role} process exited before reporting its next phase`);
      return value[0];
    },
    async stop() {
      child.send('stop');
      assert.deepEqual(await closed, [0, null]);
    },
  };
}

async function readLog(path) {
  return readFile(path, 'utf8').catch((cause) => {
    if (cause.code === 'ENOENT') return '';
    throw cause;
  });
}

async function isolatedLog(t) {
  const home = await mkdtemp(join(tmpdir(), 'forge-iam-log-'));
  const children = [];
  t.after(async () => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    try { await Promise.all(children.map(({ closed }) => closed)); }
    finally { await rm(home, { recursive: true, force: true }); }
  });
  const directory = join(home, 'logs');
  const name = 'forge-iam-session-renewal.jsonl';
  const path = join(directory, name);
  const waitFor = (renewalId) => until(() => readLog(path), (content) => (
    parseRows(content).some((row) => row.renewalId === renewalId)
  ), `expected log entry ${renewalId}`);
  return { home, directory, name, path, waitFor, startProcess(role, processHome = home) {
    const writer = logProcess(processHome, role);
    children.push(writer);
    return writer;
  } };
}

test('the shared log rotates to one bounded archive and preserves complete recent lines', async (t) => {
  const { home, directory, name, path, waitFor } = await isolatedLog(t);
  const maxFileBytes = 600;
  const first = createSessionRenewalLogger({ home, maxFileBytes });
  const second = createSessionRenewalLogger({ home, maxFileBytes });
  for (let renewalId = 1; renewalId <= 24; renewalId++) {
    const log = renewalId % 2 ? first : second;
    log('renewal-fired', { renewalId });
  }
  const current = await waitFor(24);
  const previous = await readLog(`${path}.1`);
  for (const content of [current, previous]) {
    assert.ok(content.endsWith('\n'));
    assert.ok(Buffer.byteLength(content) <= maxFileBytes);
  }
  const retained = [...parseRows(previous), ...parseRows(current)].map((row) => row.renewalId);
  assert.deepEqual(retained, Array.from({ length: retained.length }, (_, i) => 25 - retained.length + i));
  assert.deepEqual((await readdir(directory)).sort(), [name, `${name}.1`, `${name}${lockSuffix}`]);
});

test('oversized legacy active and archived logs are discarded before appending', async (t) => {
  const { home, directory, name, path, waitFor } = await isolatedLog(t);
  await mkdir(directory);
  const legacy = '{"event":"legacy"}\n'.repeat(1000);
  await writeFile(path, legacy);
  await writeFile(`${path}.1`, legacy);
  const log = createSessionRenewalLogger({ home, maxFileBytes: 512 });
  log('renewal-fired', { renewalId: 1 });
  const current = await waitFor(1);
  assert.ok(Buffer.byteLength(current) <= 512);
  assert.deepEqual(parseRows(current).map((row) => row.renewalId), [1]);
  assert.deepEqual((await readdir(directory)).sort(), [name, `${name}${lockSuffix}`]);
});

async function assertConcurrentRollover(t, redirected) {
  const { home, directory, name, path, startProcess } = await isolatedLog(t);
  await mkdir(directory);
  await writeFile(path, fullGeneration);
  await writeFile(`${path}.1`, seedRow);

  const secondHome = redirected ? join(home, 'redirected') : home;
  if (redirected) {
    await mkdir(secondHome);
    await symlink(directory, join(secondHome, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const first = startProcess('first');
  assert.equal(await first.next(), 'rotate');
  const second = startProcess('second', secondHome);
  const phase = await second.next();
  assert.ok(['rotate', 'contended'].includes(phase), `unexpected second process phase: ${phase}`);
  first.child.send('release');
  assert.equal(await first.next(), 'appended');
  if (phase === 'rotate') second.child.send('release');
  assert.equal(await second.next(), 'appended');
  await Promise.all([first.stop(), second.stop()]);

  const archive = await readLog(`${path}.1`);
  assert.equal(Buffer.byteLength(archive), Buffer.byteLength(fullGeneration));
  assert.ok(archive === fullGeneration);
  const current = await readLog(path);
  assert.ok(Buffer.byteLength(current) <= maxFileBytes);
  assert.deepEqual(parseRows(current).map((row) => row.renewalId), [1, 2]);
  assert.equal(new Set(parseRows(current).map((row) => row.pid)).size, 2);
  assert.deepEqual((await readdir(directory)).sort(), [name, `${name}.1`, `${name}${lockSuffix}`]);
  assert.equal((await readFile(`${path}${lockSuffix}`)).length, 0);
}

test('two processes preserve the same full generation when both approach rollover', { timeout: 15_000 },
  (t) => assertConcurrentRollover(t, false));

test('two processes preserve the same full generation through a redirected log directory', { timeout: 15_000 },
  (t) => assertConcurrentRollover(t, true));

test('a busy writer drops a diagnostic and a killed lock owner allows later appends', { timeout: 15_000 }, async (t) => {
  const { directory, path, startProcess } = await isolatedLog(t);
  await mkdir(directory);
  await writeFile(path, fullGeneration);
  const first = startProcess('first');
  assert.equal(await first.next(), 'rotate');
  const second = startProcess('second');
  assert.equal(await second.next(), 'contended');
  assert.equal(await second.next(), 'warned');
  assert.ok(await readLog(path) === fullGeneration);
  assert.equal(await readLog(`${path}.1`), '');

  assert.equal(first.child.kill('SIGKILL'), true);
  assert.deepEqual(await first.closed, [null, 'SIGKILL']);
  second.child.send(3);
  assert.equal(await second.next(), 'rotate');
  second.child.send('release');
  assert.equal(await second.next(), 'appended');
  await second.stop();
  assert.ok(await readLog(`${path}.1`) === fullGeneration);
  assert.deepEqual(parseRows(await readLog(path)).map((row) => row.renewalId), [3]);
});

test('aliased log files are preserved and block logging until the path is repaired', async (t) => {
  const { home, directory, path, waitFor } = await isolatedLog(t);
  await mkdir(directory);
  const target = join(home, 'ordinary-file');
  const content = 'synthetic file';
  await writeFile(target, content);
  for (const suffix of [lockSuffix, '', '.1']) {
    const alias = `${path}${suffix}`;
    await link(target, alias);
    let warned = false;
    const log = createSessionRenewalLogger({ home, warn: () => { warned = true; } });
    log('renewal-fired', { renewalId: 1 });
    await until(() => warned, Boolean, 'expected invalid log path warning');
    assert.equal(await readLog(path), suffix ? '' : content);
    assert.equal(await readLog(alias), content);
    await rm(alias);
  }
  createSessionRenewalLogger({ home })('renewal-fired', { renewalId: 2 });
  assert.deepEqual(parseRows(await waitFor(2)).map((row) => row.renewalId), [2]);
  assert.equal(await readLog(target), content);
});

test('an unexpected SQLite journal is preserved and prevents log writes', async (t) => {
  const { home, directory, path } = await isolatedLog(t);
  await mkdir(directory);
  const journal = `${path}${lockSuffix}-journal`;
  await writeFile(journal, 'synthetic unexpected journal');
  let warned = false;
  const log = createSessionRenewalLogger({ home, warn: () => { warned = true; } });
  log('renewal-fired', { renewalId: 1 });
  await until(async () => warned || await readLog(path), Boolean, 'expected the diagnostic or path warning');
  assert.equal(await readLog(journal), 'synthetic unexpected journal');
  assert.equal(await readLog(path), '');
  assert.equal(warned, true);
});

test('Hosts sharing a path drop new events while the bounded write queue is full and recover after draining', async (t) => {
  const { home, path, waitFor } = await isolatedLog(t);
  let writing = false;
  const release = Promise.withResolvers();
  const warnings = [];
  const options = {
    home, maxPending: 3,
    append: async (...args) => {
      writing = true;
      await release.promise;
      await appendFile(...args);
    },
    async warn() {
      warnings.push('log warning');
      throw new Error('synthetic warning sink failure');
    },
  };
  const first = createSessionRenewalLogger(options);
  const second = createSessionRenewalLogger(options);
  try {
    first('renewal-fired', { renewalId: 1 });
    await until(async () => writing || await readLog(path), Boolean, 'expected first write to start');
    assert.equal(writing, true);
    for (let renewalId = 2; renewalId <= 20; renewalId++) {
      second('renewal-fired', { renewalId });
    }
  } finally {
    release.resolve();
  }
  const content = await waitFor(3);
  assert.deepEqual(parseRows(content).map((row) => row.renewalId), [1, 2, 3]);
  assert.deepEqual(warnings, ['log warning']);
  // The empty slot is available once an earlier append settles.
  second('renewal-fired', { renewalId: 21 });
  const final = await waitFor(21);
  assert.deepEqual(parseRows(final).map((row) => row.renewalId), [1, 2, 3, 21]);
});

async function startHost(t, { credentials = new MemoryCredentials(), fetchJwks, fetchToken, failLog = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'forge-iam-renewal-'));
  if (failLog) await writeFile(join(home, 'logs'), 'not a directory');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const path = join(home, 'logs', 'forge-iam-session-renewal.jsonl');
  const events = (predicate) => until(async () => parseRows(await readLog(path)),
    (rows) => rows.some(predicate), 'expected renewal diagnostic was not written');
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

test('a non-2xx token response whose body times out retains the HTTP status and pending claim', async (t) => {
  const controller = new AbortController();
  const host = await startHost(t, { fetchToken: ({ signal }) => {
    const body = new ReadableStream({
      start(stream) {
        signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
      },
    });
    void setImmediate().then(() => controller.abort(new Error('synthetic-private-response-timeout')));
    return new Response(body, { status: 429 });
  } });
  const realTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => ms === 5000 ? controller.signal : realTimeout(ms));
  t.mock.timers.tick(900);
  const rows = await host.events((row) => row.event === 'refresh-failed');
  const failure = rows.find((row) => row.event === 'refresh-failed');
  assert.equal(failure.stage, 'token-endpoint');
  assert.equal(failure.causeCode, 'IAM_HTTP_ERROR');
  assert.equal(failure.httpStatus, 429);
  assert.equal(failure.timedOut, true);
  assert.equal(failure.oauthError, undefined);
  assert.equal(failure.requestUnsent, undefined);
  assert.equal((await host.credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
  assert.equal(host.posts(), 1);
  assert.doesNotMatch(JSON.stringify(rows), /synthetic-private-response-timeout/);
});

test('an invalid ID token yields its exact validation code without logging the token or permitting another POST', async (t) => {
  const malformed = 'synthetic-private-id-token';
  const host = await startHost(t, { fetchToken: () => Response.json({ ...rotated, id_token: malformed }) });
  t.mock.timers.tick(900);
  const rows = await host.events((row) => row.event === 'refresh-failed');
  const failure = rows.find((row) => row.event === 'refresh-failed');
  assert.equal(failure.stage, 'validate-response');
  assert.equal(failure.causeCode, 'IAM_ID_TOKEN_INVALID');
  assert.equal(failure.code, 'IAM_REAUTH_REQUIRED');
  assert.equal((await host.credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
  assert.equal(host.posts(), 1);
  assert.doesNotMatch(JSON.stringify(rows), /synthetic-private-id-token/);
});

test('only exact known ID token validation codes pass the diagnostic allowlist', () => {
  for (const code of [
    'IAM_ID_TOKEN_INVALID', 'IAM_ID_TOKEN_SIGNATURE', 'IAM_ID_TOKEN_ISSUER', 'IAM_ID_TOKEN_AUDIENCE',
    'IAM_ID_TOKEN_NONCE', 'IAM_ID_TOKEN_EXPIRED',
  ]) {
    const cause = new OidcError(code, 'synthetic-private-detail');
    assert.deepEqual(renewalErrorFields(cause), { causeCode: code });
  }
  const unknown = new OidcError('IAM_ID_TOKEN_SYNTHETIC_UNKNOWN', 'synthetic-private-detail');
  assert.deepEqual(renewalErrorFields(unknown), { causeCode: 'IAM_INTERNAL' });
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

for (const [response, oauthError, oauthErrorResponse, httpStatus = 401] of [
  [() => Response.json({ error: 'invalid_grant', error_description: 'synthetic-private-response' }, { status: 401 }), 'invalid_grant'],
  [() => Response.json({ error: 'invalid_grant' }, { status: 400 }), 'invalid_grant', undefined, 400],
  [() => Response.json({ error: 'invalid_client' }, { status: 401 }), 'invalid_client'],
  [() => new Response(null, { status: 401 }), undefined, 'empty'],
  [() => new Response('  \n', { status: 401 }), undefined, 'empty'],
  [() => new Response('synthetic-private-response', { status: 401 }), undefined, 'nonstandard'],
  [() => Response.json({ error: 'synthetic-private-response' }, { status: 401 }), undefined, 'nonstandard'],
  [() => new Response(new ReadableStream({ start(body) { body.error(new Error('synthetic-private-response')); } }), { status: 401 }),
    undefined, 'unreadable'],
]) {
  test(`logs token HTTP ${httpStatus} ${oauthError ?? oauthErrorResponse} with the request method and keeps pending`, async (t) => {
    const host = await startHost(t, { fetchToken: response });
    t.mock.timers.tick(900);
    await until(() => host.iam.getView(), (view) => view.state === 'error', 'expected session failure');
    const rows = await host.events((row) => row.event === 'refresh-failed');
    const failure = rows.find((row) => row.event === 'refresh-failed');
    assert.equal(failure.reason, 'rejected');
    assert.equal(failure.code, 'IAM_REAUTH_REQUIRED');
    assert.equal(failure.oauthError, oauthError);
    assert.equal(failure.oauthErrorResponse, oauthErrorResponse);
    assert.equal(failure.httpStatus, httpStatus);
    assert.equal(failure.clientAuthMethod, 'none');
    assert.ok(rows.some((row) => row.event === 'refresh-stage' && row.stage === 'token-endpoint'
      && row.clientAuthMethod === 'none'));
    assert.equal((await host.credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
    assert.equal(host.posts(), 1);
    assert.doesNotMatch(JSON.stringify(rows), /synthetic-private-response/);
  });
}

test('logs an unchanged refresh token as a response validation failure and keeps pending', async (t) => {
  const host = await startHost(t, { fetchToken: () => Response.json({ ...rotated, refresh_token: original.refreshToken }) });
  t.mock.timers.tick(900);
  const rows = await host.events((row) => row.event === 'refresh-failed');
  const failure = rows.find((row) => row.event === 'refresh-failed');
  assert.equal(failure.reason, 'rotation-unchanged');
  assert.equal(failure.code, 'IAM_REAUTH_REQUIRED');
  assert.equal(failure.httpStatus, undefined);
  assert.equal(failure.oauthErrorResponse, undefined);
  assert.equal(failure.clientAuthMethod, undefined);
  assert.equal((await host.credentials.readRecord(GRANT_KEY)).payload.refreshOperation.state, 'pending');
  assert.equal(host.posts(), 1);
});
