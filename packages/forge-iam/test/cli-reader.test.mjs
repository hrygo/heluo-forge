import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/heluo-forge.mjs', import.meta.url));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-cli-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls');
  const stub = `import { appendFileSync } from 'node:fs';
const mark = value => appendFileSync(process.env.TEST_READER_LOG, JSON.stringify(value) + '\\n');
let reads = 0;
const error = code => Object.assign(new Error('sensitive-placeholder'), {code});
export async function openCredentialReader(options) {
  mark({open:options});
  if (process.env.TEST_OPEN_ERROR) throw error(process.env.TEST_OPEN_ERROR);
  return {
    async readRecord(key) { mark({read:key}); if (process.env.TEST_READ_ERROR) throw error(process.env.TEST_READ_ERROR); reads++; if (reads > 1 && process.env.TEST_RECHECK_ERROR) throw error(process.env.TEST_RECHECK_ERROR); return JSON.parse((reads > 1 && process.env.TEST_RECORD_AFTER !== undefined ? process.env.TEST_RECORD_AFTER : process.env.TEST_RECORD) || 'null'); },
    async resolve(key) { mark({resolve:key}); if (process.env.TEST_RESOLVE_ERROR) throw error(process.env.TEST_RESOLVE_ERROR); return {value:'placeholder-capability'}; },
    async close() { mark({close:true}); },
  };
}`;
  const loader = `import { registerHooks } from 'node:module';
const stub = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@heluo/forge-credentials-keychain') return {url: stub, shortCircuit:true};
  return nextResolve(specifier, context);
}});`;
  const hook = join(directory, 'hook.mjs');
  await writeFile(hook, loader);
  const env = { ...process.env, TEST_READER_LOG: log, HELUO_FORGE_STORE_DIRECTORY: directory,
    HELUO_FORGE_KEYCHAIN_SERVICE: 'fixture-service', HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX: 'fixture-prefix', ...options };
  delete env.HELUO_FORGE_IAM_URL;
  return { directory, env, log, async cli(...args) { return run(process.execPath, ['--import', hook, bin, 'auth', ...args], { env }); } };
}

const grant = { kind: 'grant', payload: { version: 1, clientId: 'fixture', scope: 'openid', obtainedAt: '2026-01-01T00:00:00.000Z', subject: 'E1001', issuer: 'https://iam.corp.example',
  refreshToken: 'placeholder-refresh', accessToken: 'placeholder-access', accessExpiresAt: '2099-01-01T00:00:00.000Z' } };

test('CLI opens the shared reader with its namespace, preserves output and closes it', async (t) => {
  const f = await fixture(t, { TEST_RECORD: JSON.stringify(grant) });
  const whoami = await f.cli('whoami', '--json');
  assert.equal(JSON.parse(whoami.stdout).principal.subject, 'E1001');
  assert.doesNotMatch(whoami.stdout, /placeholder-access|placeholder-refresh/);
  assert.equal((await f.cli('token')).stdout, 'placeholder-access\n');
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], { open: { directory: f.directory, service: 'fixture-service', accountPrefix: 'fixture-prefix' } });
  assert.equal(calls.filter((x) => x.close).length, 2);
});

test('offline key and decrypt errors preserve codes without exposing exception text', async (t) => {
  for (const [field, code] of [['TEST_OPEN_ERROR', 'CRED_KEY_UNAVAILABLE'], ['TEST_READ_ERROR', 'CRED_DECRYPT_FAILED'], ['TEST_READ_ERROR', 'SECRET_UNTRUSTED_CODE']]) {
    const f = await fixture(t, { [field]: code });
    await assert.rejects(f.cli('whoami', '--json'), (error) => {
      assert.equal(error.code, 4);
      assert.equal(JSON.parse(error.stderr).error.code, code.startsWith('CRED_') ? code : 'IAM_CREDENTIALS_UNAVAILABLE');
      assert.doesNotMatch(error.stderr, /sensitive-placeholder|SECRET_UNTRUSTED_CODE/);
      return true;
    });
    if (field === 'TEST_READ_ERROR') assert.match(await readFile(f.log, 'utf8'), /"close":true/);
  }
});

test('bridge retains Host access and capability and closes reader', async (t) => {
  const f = await fixture(t, { TEST_RECORD: JSON.stringify(grant) });
  let received;
  const server = createServer((req, res) => { received = req.headers.authorization; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ token: 'placeholder-access' })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  f.env.HELUO_FORGE_IAM_URL = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await f.cli('token')).stdout, 'placeholder-access\n');
  assert.equal(received, 'Bearer placeholder-capability');
  assert.match(await readFile(f.log, 'utf8'), /"close":true/);
});

test('offline signed-out and expired sessions retain CLI status and exit codes', async (t) => {
  const signedOut = await fixture(t);
  assert.equal(JSON.parse((await signedOut.cli('whoami', '--json')).stdout).status, 'signed-out');
  await assert.rejects(signedOut.cli('token'), (error) => error.code === 2 && /IAM_NOT_SIGNED_IN/.test(error.stderr));
  const expired = await fixture(t, { TEST_RECORD: JSON.stringify({ ...grant, payload: { ...grant.payload, accessExpiresAt: '2000-01-01T00:00:00.000Z' } }) });
  await assert.rejects(expired.cli('token'), (error) => error.code === 3 && /IAM_REAUTH_REQUIRED/.test(error.stderr) && error.stdout === '');
});

test('bridge rejection does not fall back to stored access token', async (t) => {
  const f = await fixture(t, { TEST_RECORD: JSON.stringify(grant) });
  const server = createServer((req, res) => { res.writeHead(401); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  f.env.HELUO_FORGE_IAM_URL = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(f.cli('token'), (error) => error.code === 4 && /IAM_BRIDGE_UNAUTHORIZED/.test(error.stderr) && error.stdout === '');
});

test('bridge preserves documented IAM errors without exposing an untrusted response body', async (t) => {
  const f = await fixture(t, { TEST_RECORD: JSON.stringify(grant) });
  let response;
  const server = createServer((_req, res) => {
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: response.code, message: 'sensitive-placeholder' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  f.env.HELUO_FORGE_IAM_URL = `http://127.0.0.1:${server.address().port}`;
  for (const [status, code, exitCode, expected] of [
    [401, 'IAM_REAUTH_REQUIRED', 3, 'IAM_REAUTH_REQUIRED'],
    [401, 'IAM_INVALID_GRANT', 3, 'IAM_INVALID_GRANT'],
    [401, 'IAM_NOT_SIGNED_IN', 2, 'IAM_NOT_SIGNED_IN'],
    [503, 'IAM_CREDENTIALS_UNAVAILABLE', 4, 'IAM_CREDENTIALS_UNAVAILABLE'],
    [503, 'SENSITIVE_UNTRUSTED', 4, 'IAM_HOST_REJECTED'],
    [503, 'IAM_REAUTH_REQUIRED', 4, 'IAM_HOST_REJECTED'],
  ]) {
    response = { status, code };
    await assert.rejects(f.cli('token', '--json'), (error) => {
      assert.equal(error.code, exitCode);
      assert.equal(error.stdout, '');
      assert.equal(JSON.parse(error.stderr).error.code, expected);
      assert.doesNotMatch(error.stderr, /sensitive-placeholder|SENSITIVE_UNTRUSTED/);
      return true;
    });
  }
});

test('reader defaults are delegated to the package without legacy backend options', async (t) => {
  const f = await fixture(t);
  delete f.env.HELUO_FORGE_STORE_DIRECTORY;
  delete f.env.HELUO_FORGE_KEYCHAIN_SERVICE;
  delete f.env.HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX;
  f.env.HELUO_FORGE_CREDENTIALS_FILE = '/unused';
  f.env.HELUO_FORGE_ALLOW_UNVETTED = '1';
  await f.cli('whoami');
  const [first] = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(first, { open: { service: 'heluo-forge', accountPrefix: 'iam' } });
});

test('bridge capability read preserves safe storage error and closes reader', async (t) => {
  const f = await fixture(t, { TEST_RECORD: JSON.stringify(grant), TEST_RESOLVE_ERROR: 'CRED_DECRYPT_FAILED' });
  f.env.HELUO_FORGE_IAM_URL = 'http://127.0.0.1:1';
  await assert.rejects(f.cli('token', '--json'), (error) => {
    assert.equal(error.code, 4);
    assert.equal(JSON.parse(error.stderr).error.code, 'CRED_DECRYPT_FAILED');
    assert.doesNotMatch(error.stderr, /sensitive-placeholder/);
    return true;
  });
  assert.match(await readFile(f.log, 'utf8'), /"close":true/);
});


test('bridge refuses a pending sign-out before contacting Host', async (t) => {
  const pending = { ...grant, payload: { ...grant.payload, signOutOperation: { state: 'pending' } } };
  const f = await fixture(t, { TEST_RECORD: JSON.stringify(pending) });
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.end(JSON.stringify({ token: 'synthetic-stale' })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  f.env.HELUO_FORGE_IAM_URL = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(f.cli('token'), (error) => error.stdout === '' && error.code !== 0);
  assert.equal(calls, 0);
});

test('bridge rechecks stored session before returning Host token', async (t) => {
  const cases = [
    ['pending', JSON.stringify({ ...grant, payload: { ...grant.payload, signOutOperation: { state: 'pending' } } })],
    ['deleted', 'null'],
    ['replaced', JSON.stringify({ ...grant, payload: { ...grant.payload, subject: 'new-subject' } })],
    ['unavailable', undefined],
  ];
  for (const [name, after] of cases) await t.test(name, async (t) => {
    const f = await fixture(t, { TEST_RECORD: JSON.stringify(grant), ...(after === undefined ? { TEST_RECHECK_ERROR: 'CRED_DECRYPT_FAILED' } : { TEST_RECORD_AFTER: after }) });
    let calls = 0;
    const server = createServer((_req, res) => { calls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ token: 'synthetic-stale' })); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    f.env.HELUO_FORGE_IAM_URL = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(f.cli('token'), (error) => error.stdout === '' && error.code !== 0);
    assert.equal(calls, 1);
  });
});

test('bridge rejects unsafe URL and redirects without disclosing capability', async (t) => {
  const f = await fixture(t, { TEST_RECORD: JSON.stringify(grant) });
  let requests = 0;
  const sink = createServer((_req, res) => { requests++; res.end(); });
  await new Promise((resolve) => sink.listen(0, '0.0.0.0', resolve));
  t.after(() => new Promise((resolve) => sink.close(resolve)));
  const port = sink.address().port;
  const withUserinfo = new URL(`http://127.0.0.1:${port}`);
  withUserinfo.username = 'user';
  withUserinfo.password = 'pass';
  for (const url of [`http://0.0.0.0:${port}`, withUserinfo.href, `file:///tmp/no-bridge`]) {
    f.env.HELUO_FORGE_IAM_URL = url;
    await assert.rejects(f.cli('token'), (error) => error.stdout === '' && error.code !== 0);
  }
  assert.equal(requests, 0);
  const redirect = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${port}/target` }); res.end(); });
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => redirect.close(resolve)));
  f.env.HELUO_FORGE_IAM_URL = `http://127.0.0.1:${redirect.address().port}`;
  await assert.rejects(f.cli('token'), (error) => error.stdout === '' && error.code !== 0);
  assert.equal(requests, 0);
});

test('bridge accepts a verified refresh of the same session only when Host returns its current token', async (t) => {
  const identity = { version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'fixture',
    scope: 'openid', obtainedAt: '2026-01-01T00:00:00.000Z', sessionInstanceId: Buffer.alloc(32, 7).toString('base64url') };
  const before = { kind: 'grant', payload: { ...identity, accessToken: 'synthetic-old', refreshToken: 'synthetic-old-refresh', accessExpiresAt: '2020-01-01T00:00:00.000Z' } };
  const after = { kind: 'grant', payload: { ...before.payload, accessToken: 'synthetic-new', refreshToken: 'synthetic-new-refresh', accessExpiresAt: '2099-01-01T00:00:00.000Z',
    refreshOperation: { version: 1, state: 'complete', id: Buffer.alloc(32, 3).toString('base64url'), base: Buffer.alloc(32, 4).toString('base64url') } } };
  let token = 'synthetic-new';
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ token })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const valid = await fixture(t, { TEST_RECORD: JSON.stringify(before), TEST_RECORD_AFTER: JSON.stringify(after) });
  valid.env.HELUO_FORGE_IAM_URL = url;
  assert.equal((await valid.cli('token')).stdout, 'synthetic-new\n');
  for (const [name, changed, returned] of [
    ['stale host token', after, 'synthetic-old'],
    ['session replaced', { ...after, payload: { ...after.payload, sessionInstanceId: Buffer.alloc(32, 8).toString('base64url') } }, 'synthetic-new'],
    ['identity changed', { ...after, payload: { ...after.payload, issuer: 'https://other.corp.example' } }, 'synthetic-new'],
    ['refresh pending', { ...after, payload: { ...after.payload, refreshOperation: { state: 'pending' } } }, 'synthetic-new'],
    ['sign-out pending', { ...after, payload: { ...after.payload, signOutOperation: { state: 'pending' } } }, 'synthetic-new'],
    ['malformed completed refresh', { ...after, payload: { ...after.payload, refreshOperation: { state: 'complete' } } }, 'synthetic-new'],
    ['expired latest', { ...after, payload: { ...after.payload, accessExpiresAt: '2020-01-01T00:00:00.000Z' } }, 'synthetic-new'],
    ['no identity proof', { ...after, payload: { ...after.payload, sessionInstanceId: undefined } }, 'synthetic-new'],
  ]) await t.test(name, async (t) => {
    token = returned;
    const f = await fixture(t, { TEST_RECORD: JSON.stringify(before), TEST_RECORD_AFTER: JSON.stringify(changed) });
    f.env.HELUO_FORGE_IAM_URL = url;
    await assert.rejects(f.cli('token'), (error) => error.stdout === '' && error.code !== 0);
  });
});

test('invalid grant and malformed refresh marker are refused before contacting bridge', async (t) => {
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.end(JSON.stringify({ token: 'placeholder-access' })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const valid = { ...grant.payload, version: 1, clientId: 'fixture', scope: 'openid', obtainedAt: '2026-01-01T00:00:00.000Z' };
  for (const payload of [{ ...valid, clientId: undefined }, { ...valid, refreshOperation: { state: 'broken' } }]) {
    const f = await fixture(t, { TEST_RECORD: JSON.stringify({ kind: 'grant', payload }) });
    f.env.HELUO_FORGE_IAM_URL = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(f.cli('token'), (error) => error.code !== 0 && error.stdout === '');
    assert.notEqual(JSON.parse((await f.cli('whoami', '--json')).stdout).status, 'ready');
  }
  assert.equal(calls, 0);
});
