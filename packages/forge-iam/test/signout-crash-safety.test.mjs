import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrantStore, GRANT_KEY } from '../src/store.mjs';
import { accessTokenOf, sessionFromRecord } from '../src/cli-session.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { validateGrant } from '../src/record.mjs';

const grant = { version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'), issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'test',
  refreshToken: 'placeholder-refresh', accessToken: 'placeholder-access', scope: 'openid',
  obtainedAt: '2026-01-01T00:00:00.000Z', accessExpiresAt: '2099-01-01T00:00:00.000Z' };
const options = { verifyAtomicStore: () => true };
function defer() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; }

test('interrupted revoke leaves a durable pending grant that cannot be observed as ready or resent', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials, options);
  await store.write(grant);
  let calls = 0;
  assert.deepEqual(await store.signOutSnapshot(grant, async () => { calls++; throw Error('simulated crash'); }), { ok: false });
  const record = await credentials.readRecord(GRANT_KEY);
  assert.equal(record.payload.signOutOperation.state, 'pending');
  assert.equal((await store.read()).ok, false);
  assert.notEqual(sessionFromRecord(record).status, 'ready');
  assert.notEqual(accessTokenOf(record).ok, true);
  assert.notEqual((await store.signOutSnapshot(grant, async () => { calls++; })).decision, 'cleared');
  assert.equal(calls, 1);
});

test('a repeated finish mutator fails closed without replaying revoke', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials, options);
  await store.write(grant);
  const modify = credentials.modifyRecord.bind(credentials);
  let phase = 0;
  let finishCalls = 0;
  let revocations = 0;
  credentials.modifyRecord = async (key, mutate) => {
    if (++phase !== 2) return modify(key, mutate);
    return modify(key, async (current) => {
      finishCalls += 1;
      await mutate(current);
      finishCalls += 1;
      return mutate(current);
    });
  };

  assert.deepEqual(await store.signOutSnapshot(grant, async () => { revocations++; }), { ok: false });
  assert.equal(finishCalls, 2);
  assert.equal(revocations, 1);
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.signOutOperation.state, 'pending');
  assert.deepEqual(await store.signOutSnapshot(grant, async () => { revocations++; }), { ok: true, decision: 'pending' });
  assert.equal(revocations, 1);
});

test('late replacement survives completion of an older sign-out', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials, options);
  await store.write(grant);
  const entered = defer(); const finish = defer();
  const pending = store.signOutSnapshot(grant, async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  const replacement = { ...grant, subject: 'E2002', accessToken: 'new-token' };
  await store.write(replacement);
  finish.resolve();
  assert.notEqual((await pending).decision, 'cleared');
  assert.equal((await store.read()).grant.subject, 'E2002');
});

test('sign-out marker has strict validated shape in both grant versions', () => {
  const marker = { version: 1, state: 'pending', id: Buffer.alloc(32, 1).toString('base64url') };
  const confidential = { ...grant, version: 2, authContext: { mode: 'confidential', method: 'client_secret_post', secretRef: 'a', secretRevision: 'b' } };
  for (const base of [grant, confidential]) {
    assert.equal(validateGrant({ ...base, signOutOperation: marker }).ok, true);
    for (const invalid of [null, {}, { ...marker, state: 'complete' }, { ...marker, extra: 1 }, { ...marker, id: 'short' }]) {
      assert.equal(validateGrant({ ...base, signOutOperation: invalid }).ok, false);
    }
  }
});

test('confirmed, failed, unknown and skipped revoke have explicit durable outcomes', async (t) => {
  const { createIamService } = await import('./support/trusted-service.mjs');
  for (const [name, fetch, endpoint, cleared] of [
    ['confirmed', async () => Response.json({ result: true }), 'https://iam.corp.example/revoke', true],
    ['unconfirmed 204', async () => new Response(null, { status: 204 }), 'https://iam.corp.example/revoke', false],
    ['failed', async () => Response.json({ result: false, errcode: 1001 }), 'https://iam.corp.example/revoke', false],
    ['timeout', async () => { throw new Error('timeout'); }, 'https://iam.corp.example/revoke', false],
    ['skipped', async () => { throw new Error('must not be called'); }, undefined, true],
  ]) {
    await t.test(name, async (t) => {
      const credentials = new MemoryCredentials();
      await createGrantStore(credentials).write(grant);
      let calls = 0;
      const countedFetch = async (...args) => { calls++; return fetch(...args); };
      const service = createIamService({ issuer: grant.issuer, authorizationEndpoint: `${grant.issuer}/authorize`,
        tokenEndpoint: `${grant.issuer}/token`, jwksUri: `${grant.issuer}/jwks`, clientId: grant.clientId,
        redirectUri: 'http://127.0.0.1:4567/iam/callback', ...(endpoint ? { revocationEndpoint: endpoint } : {}) }, { credentials, fetch: countedFetch });
      t.after(() => service.dispose());
      const result = await service.signOut();
      const raw = await credentials.readRecord(GRANT_KEY);
      if (cleared) {
        assert.equal(raw.payload.type, 'heluo-iam-session-tombstone');
        assert.equal(result.revocation, name === 'skipped' ? 'skipped' : 'ok');
      } else {
        assert.equal(raw.payload.signOutOperation.state, 'pending');
        assert.equal(result.revocation, name === 'failed' ? 'failed' : 'unknown');
        assert.equal(result.view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
        await assert.rejects(service.resolveToken());
        assert.notEqual(service.getView().state, 'ready');
        const callsBeforeRetry = calls;
        assert.equal((await service.signOut()).view.error, 'IAM_CREDENTIALS_CLEAR_FAILED');
        assert.equal(calls, callsBeforeRetry);
        assert.deepEqual(await credentials.readRecord(GRANT_KEY), raw);
      }
    });
  }
});

test('actual process death after pending commit leaves restart fenced and cannot resend', async (t) => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FileCredentials } = await import('./support/file-credentials.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'forge-signout-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentials = new FileCredentials(dir);
  const store = createGrantStore(credentials, options);
  await store.write(grant);
  const code = `import { createGrantStore } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
import { FileCredentials } from ${JSON.stringify(new URL('./support/file-credentials.mjs', import.meta.url).href)};
const s = createGrantStore(new FileCredentials(process.argv[1]), { verifyAtomicStore: () => true });
await s.signOutSnapshot(${JSON.stringify(grant)}, async () => { process.stdout.write('revoked\\n'); await new Promise(() => {}); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('close', () => reject(new Error('child ended before revoke'))); });
  child.kill('SIGKILL');
  assert.equal((await ended).signal, 'SIGKILL');
  const raw = await credentials.readRecord(GRANT_KEY);
  assert.equal(raw.payload.signOutOperation.state, 'pending');
  assert.equal((await store.read()).ok, false);
  assert.equal(accessTokenOf(raw).ok, false);
  let calls = 0;
  await store.signOutSnapshot(grant, async () => { calls++; });
  assert.equal(calls, 0);
});

test('abort timeout leaves sign-out pending', async (t) => {
  const { createIamService } = await import('./support/trusted-service.mjs');
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write(grant);
  const service = createIamService({ issuer: grant.issuer, authorizationEndpoint: `${grant.issuer}/authorize`,
    tokenEndpoint: `${grant.issuer}/token`, jwksUri: `${grant.issuer}/jwks`, clientId: grant.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', revocationEndpoint: `${grant.issuer}/revoke`, httpTimeoutMs: 30 }, {
    credentials, fetch: async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  t.after(() => service.dispose());
  const result = await service.signOut();
  assert.equal(result.revocation, 'unknown');
  assert.equal((await credentials.readRecord(GRANT_KEY)).payload.signOutOperation.state, 'pending');
});
