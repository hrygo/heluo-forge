import test from 'node:test';
import assert from 'node:assert/strict';
import { createIamService } from '../src/service.mjs';
import { GRANT_KEY } from '../src/store.mjs';
import { confidentialHarness, authorization, signIn, hold } from './support/client-auth-service.mjs';

for (const failure of ['missing-source', 'missing-verifier', 'false', 'promise-true', 'promise-reject', 'throw', 'self-report']) {
  test(`actual confidential start with ${failure} has no source read, auth URL or credential POST`, async (t) => {
    const h = await confidentialHarness(t);
    if (failure === 'missing-source') h.options.getClientSecretSource = () => undefined;
    else if (failure === 'missing-verifier') delete h.options.verifyClientSecretSource;
    else if (failure === 'false') h.options.verifyClientSecretSource = () => false;
    else if (failure === 'promise-true') h.options.verifyClientSecretSource = () => Promise.resolve(true);
    else if (failure === 'promise-reject') h.options.verifyClientSecretSource = () => Promise.reject(new Error('synthetic-private-error'));
    else if (failure === 'throw') h.options.verifyClientSecretSource = () => { throw new Error('synthetic-private-error'); };
    else h.options.getClientSecretSource = () => ({ ...h.fixture.source, trusted: true, keychain: true });
    await assert.rejects(h.service.startSignIn(), (error) => error.code === 'IAM_CLIENT_AUTH_UNVERIFIED'
      && !JSON.stringify(error).includes('synthetic-private-error'));
    assert.equal(h.fixture.counts.read, 0);
    assert.equal(h.mock.counts.token, 0);
    assert.equal(h.mock.counts.revoke, 0);
    assert.equal(await h.record(), undefined);
  });
}

for (const method of ['client_secret_basic', 'client_secret_post']) {
  test(`actual ${method} code, V2 hydration, usable AT and access-token revocation complete`, async (t) => {
    const h = await confidentialHarness(t, method);
    await signIn(h);
    const grant = await h.record();
    assert.equal(grant.version, 2);
    assert.deepEqual(grant.authContext, { mode: 'confidential', method, secretRef: h.config.clientSecretRef,
      secretRevision: h.fixture.snapshot().revision });
    assert.equal(JSON.stringify(grant).includes(h.fixture.snapshot().value), false);
    const reads = h.fixture.counts.read;
    h.service.getView(); h.service.getPrincipal();
    assert.equal(h.fixture.counts.read, reads);
    assert.equal(await h.service.resolveToken(), grant.accessToken);
    assert.equal(h.mock.counts.token, 1);
    const restored = createIamService(h.config, h.options); t.after(() => restored.dispose());
    assert.equal((await restored.hydrate()).state, 'ready');
    const result = await restored.signOut();
    assert.equal(result.revocation, 'ok');
    assert.equal(h.mock.counts.revoke, 1);
    assert.equal((await h.record()).type, 'heluo-iam-session-tombstone');
  });

  test(`actual ${method} refresh is singleflight, rotates RT and retains the full V2 identity`, async (t) => {
    const h = await confidentialHarness(t, method, { config: { refreshSkewSeconds: 7200 } });
    await signIn(h);
    const before = await h.record();
    const tokens = await Promise.all([h.service.resolveToken(), h.service.resolveToken()]);
    assert.equal(tokens[0], tokens[1]);
    assert.equal(h.mock.counts.refresh, 1);
    const after = await h.record();
    assert.equal(after.version, 2);
    assert.deepEqual(after.authContext, before.authContext);
    assert.equal(after.sessionInstanceId, before.sessionInstanceId);
    assert.equal(after.refreshOperation.state, 'complete');
    assert.notEqual(after.refreshToken, before.refreshToken);
  });

  test(`actual ${method} callback failure performs only original-context authenticated cleanup`, async (t) => {
    const h = await confidentialHarness(t, method, { fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/token')) { const body = await response.json(); delete body.id_token; return Response.json(body); }
      return response;
    } });
    const callback = await authorization(h.service);
    await assert.rejects(h.service.handleCallback(callback), { code: 'IAM_ID_TOKEN_INVALID' });
    assert.equal(h.mock.counts.token, 1);
    assert.equal(h.mock.counts.revoke, 1);
    assert.equal(await h.record(), undefined);
  });
}

for (const flow of ['code', 'refresh']) {
  test(`${flow} stale HTTP errors cannot replace the local client-auth-changed classification`, async (t) => {
    const gate = hold(); t.after(gate.release);
    const h = await confidentialHarness(t, 'client_secret_basic', { config: { refreshSkewSeconds: 7200 }, fetch: async (url, init) => {
      const response = await fetch(url, init);
      const kind = new URLSearchParams(init?.body).get('grant_type');
      if (kind === (flow === 'code' ? 'authorization_code' : 'refresh_token')) {
        await gate.pause(); return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return response;
    } });
    let pending;
    if (flow === 'code') pending = h.service.handleCallback(await authorization(h.service));
    else { await signIn(h); pending = h.service.resolveToken(); }
    const observed = pending.catch((error) => error);
    await gate.entered; h.fixture.replace(); gate.release();
    assert.equal((await observed).code, 'IAM_CLIENT_AUTH_CHANGED');
    assert.equal(h.mock.counts.revoke, 0);
    assert.equal(h.mock.counts.refresh, flow === 'refresh' ? 1 : 0);
    if (flow === 'refresh') assert.equal((await h.record()).refreshOperation.state, 'pending');
  });
}

test('a cancelled old callback cannot publish over a new confidential login and revision', async (t) => {
  const gate = hold(); t.after(gate.release); let first = true;
  const h = await confidentialHarness(t, 'client_secret_post', { fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/token') && first) { first = false; await gate.pause(); }
    return response;
  } });
  const old = h.service.handleCallback(await authorization(h.service)); const observed = old.catch((error) => error);
  await gate.entered; await h.service.cancelSignIn(); h.fixture.replace();
  await signIn(h);
  const current = structuredClone(await h.record());
  gate.release(); assert.equal((await observed) instanceof Error, true);
  assert.equal(h.service.getView().state, 'ready');
  assert.deepEqual(await h.record(), current);
  assert.equal(h.mock.counts.token, 2);
  assert.equal(h.mock.counts.revoke, 0);
});

for (const change of ['revision', 'source', 'credentials']) {
  test(`start-to-callback ${change} change cannot borrow a replacement with identical auth fields`, async (t) => {
    const h = await confidentialHarness(t);
    let currentSource = h.fixture.source; let credentials = h.credentials;
    const accepted = new Set([currentSource]);
    h.options.getClientSecretSource = () => currentSource;
    h.options.getCredentials = () => credentials;
    h.options.verifyClientSecretSource = (candidate, source, scope) => candidate === h.credentials && accepted.has(source)
      && scope.issuer === h.mock.issuer && scope.clientId === h.mock.clientId
      && scope.ref === h.config.clientSecretRef && scope.method === h.config.clientAuthMethod;
    const callback = await authorization(h.service);
    if (change === 'revision') h.fixture.replace();
    else if (change === 'source') { currentSource = Object.freeze({ ...currentSource }); accepted.add(currentSource); }
    else credentials = Object.create(Object.getPrototypeOf(h.credentials));
    await assert.rejects(h.service.handleCallback(callback));
    assert.equal(h.mock.counts.token, 0);
    assert.equal(h.mock.counts.revoke, 0);
    assert.equal(await h.record(), undefined);
    assert.equal(h.service.getView().signedIn, false);
  });
}

for (const change of ['rotation', 'cancel', 'dispose']) {
  test(`a code response after ${change} is not adopted or revoked using a new context`, async (t) => {
    const gate = hold(); t.after(gate.release);
    const h = await confidentialHarness(t, 'client_secret_basic', { fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/token')) await gate.pause();
      return response;
    } });
    const callback = await authorization(h.service);
    const pending = h.service.handleCallback(callback); const observed = pending.catch((error) => error);
    await gate.entered;
    if (change === 'rotation') h.fixture.replace();
    else if (change === 'cancel') await h.service.cancelSignIn();
    else await h.service.dispose();
    gate.release();
    assert.equal((await observed) instanceof Error, true);
    assert.equal(h.mock.counts.token, 1);
    assert.equal(h.mock.counts.revoke, 0);
    assert.equal(await h.record(), undefined);
    assert.equal(h.service.getView().signedIn, false);
  });
}

for (const field of ['method', 'secretRef', 'secretRevision']) {
  test(`confidential valid AT with a mismatched ${field} cannot hydrate or be returned`, async (t) => {
    const h = await confidentialHarness(t); await signIn(h);
    const grant = structuredClone(await h.record());
    grant.authContext[field] = field === 'method' ? 'client_secret_post' : 'different';
    await h.credentials.modifyRecord(GRANT_KEY, () => ({ kind: 'grant', payload: grant }));
    const restored = createIamService(h.config, h.options); t.after(() => restored.dispose());
    assert.notEqual((await restored.hydrate()).state, 'ready');
    await assert.rejects(restored.resolveToken());
    assert.deepEqual(await h.record(), grant);
    assert.equal(h.mock.counts.refresh, 0);
  });
}

test('sign-out revokes the access token without a client secret even after the source disappears', async (t) => {
  const h = await confidentialHarness(t); await signIn(h);
  const grant = structuredClone(await h.record());
  h.fixture.remove();
  const cold = createIamService(h.config, h.options); t.after(() => cold.dispose());
  const reads = h.fixture.counts.read;
  assert.equal((await cold.signOut()).revocation, 'ok');
  assert.equal((await h.record()).type, 'heluo-iam-session-tombstone');
  assert.equal(h.mock.lastRevokeAccess.set.token, grant.accessToken);
  assert.equal(h.mock.lastRevokeAccess.set.authorization, null);
  assert.equal(h.fixture.counts.read, reads, 'no client-secret read is needed');
});
