import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { createIamService } from './support/trusted-service.mjs';

// C: the view must answer "can this session still renew itself" before the user
// loses a request to IAM_REAUTH_REQUIRED. A session whose sliding refresh window
// has lapsed is terminal; it is not the same state as a renewable lapse.

async function serviceWith(t, grant, options = {}) {
  const oidc = await startMockOidc({ accessTtl: 60 });
  const credentials = new MemoryCredentials();
  const clock = { wall: Date.now() };
  oidc.refreshTokens.set('synthetic-refresh', { subject: 'E1001' });
  if (grant) {
    await createGrantStore(credentials).write({
      version: 1, sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
      issuer: oidc.issuer, subject: 'E1001', clientId: oidc.clientId,
      refreshToken: 'synthetic-refresh', scope: 'openid',
      obtainedAt: new Date(clock.wall).toISOString(),
      ...grant(clock.wall),
    });
  }
  const service = createIamService({
    ...oidc.endpoints, clientId: oidc.clientId,
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
  }, { ...options, credentials, now: () => clock.wall });
  t.after(async () => { await service.dispose(); await oidc.close(); });
  return { service, oidc, clock };
}

test('a renewable session reports the renewal window it still has', async (t) => {
  const { service } = await serviceWith(t, (clock) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(clock + 60_000).toISOString(),
    refreshExpiresAt: new Date(clock + 3_600_000).toISOString(),
  }));
  const view = await service.hydrate();
  assert.equal(view.state, 'ready');
  assert.equal(view.renewal, 'available');
  assert.equal(view.refreshExpiresAt, new Date(JSON.parse(JSON.stringify(view)).refreshExpiresAt).toISOString());
});

test('a lapsed refresh window is reported as unrenewable before the access token dies', async (t) => {
  const { service, oidc, clock } = await serviceWith(t, (now) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(now + 60_000).toISOString(),
    refreshExpiresAt: new Date(now - 1).toISOString(),
  }));
  // The access token still works, so the session is not expired yet — but it
  // cannot survive the next minute, and the view has to say so.
  const ready = await service.hydrate();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.renewal, 'unavailable');
  assert.equal(oidc.counts.refresh, 0, 'nothing can be renewed, so nothing is attempted');

  clock.wall += 20_000;
  assert.equal(await service.getAccessToken(), 'synthetic-access', 'the early renewal window cannot cut short a valid AT');
  assert.equal(service.getView().state, 'ready');
  assert.equal(oidc.counts.refresh, 0);
  clock.wall += 40_000;
  const expired = service.notifyView();
  assert.equal(expired.state, 'expired');
  assert.equal(expired.error, null, 'a lapsed renewal is a state, not a request failure');
  assert.equal(expired.renewal, 'unavailable');
  await assert.rejects(service.getAccessToken(), { code: 'IAM_REAUTH_REQUIRED' });
});

test('a session without a stored grant reports no renewal at all', async (t) => {
  const { service } = await serviceWith(t, null);
  const view = await service.hydrate();
  assert.equal(view.state, 'signed-out');
  assert.equal(view.renewal, 'none');
  assert.equal(view.refreshExpiresAt, null);
});

test('a renewed session keeps reporting an available renewal window', async (t) => {
  const { service, oidc } = await serviceWith(t, (clock) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(clock - 1).toISOString(),
    refreshExpiresAt: new Date(clock + 3_600_000).toISOString(),
  }));
  await service.hydrate();
  const token = await service.getAccessToken();
  assert.notEqual(token, 'synthetic-access');
  assert.equal(oidc.counts.refresh, 1);
  assert.equal(service.getView().renewal, 'available');
});

test('view and first watch frame project expiry even before any timer or notification runs', async (t) => {
  const { service, clock } = await serviceWith(t, (now) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(now + 60_000).toISOString(),
    refreshExpiresAt: new Date(now - 1).toISOString(),
  }));
  const ready = await service.hydrate();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.sampledAt, clock.wall);
  assert.equal(Object.hasOwn({ ...ready }, 'sampledAt'), false);
  clock.wall += 60_000;
  const watch = service.watch();
  try {
    const expired = service.getView();
    assert.equal(expired.state, 'expired');
    assert.equal(expired.sampledAt, clock.wall);
    const first = (await watch.next()).value;
    assert.equal(first.state, 'expired');
    assert.equal(first.sampledAt, clock.wall);
    assert.equal(service.getView().renewal, 'unavailable');
  } finally {
    await watch.return();
  }
});

test('Host publishes natural access expiry to existing watchers while idle', async (t) => {
  const { service, oidc, clock } = await serviceWith(t, (now) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(now + 60_000).toISOString(),
    refreshExpiresAt: new Date(now - 1).toISOString(),
  }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal((await service.hydrate()).state, 'ready');
  const controller = new AbortController();
  const watch = service.watch(controller.signal);
  assert.equal((await watch.next()).value.state, 'ready');
  let expired;
  const received = watch.next().then(({ value }) => { expired = value; });
  try {
    clock.wall += 60_000;
    t.mock.timers.tick(60_000);
    await new Promise(setImmediate);
    assert.equal(expired?.state, 'expired');
    assert.equal(expired.renewal, 'unavailable');
    assert.equal(oidc.counts.refresh, 0);
  } finally {
    controller.abort();
    await received;
    await watch.return();
  }
});

test('Host publishes the renewal cutoff to existing watchers after access expiry', async (t) => {
  const { service, oidc, clock } = await serviceWith(t, (now) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(now - 30_000).toISOString(),
    refreshExpiresAt: new Date(now + 60_000).toISOString(),
  }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await service.hydrate();
  const controller = new AbortController();
  const watch = service.watch(controller.signal);
  assert.equal((await watch.next()).value.renewal, 'available');
  let terminal;
  const received = watch.next().then(({ value }) => { terminal = value; });
  try {
    clock.wall += 60_000;
    t.mock.timers.tick(60_000);
    await new Promise(setImmediate);
    assert.equal(terminal?.state, 'expired');
    assert.equal(terminal.renewal, 'unavailable');
    assert.equal(terminal.canSignIn, true);
    assert.equal(oidc.counts.refresh, 0);
  } finally {
    controller.abort();
    await received;
    await watch.return();
  }
});

test('Host publishes a renewal cutoff crossed while building an expired view', async (t) => {
  let onReadModelView;
  const { service, oidc, clock } = await serviceWith(t, (now) => ({
    accessToken: 'synthetic-access',
    accessExpiresAt: new Date(now - 30_000).toISOString(),
    refreshExpiresAt: new Date(now + 60_000).toISOString(),
  }), {
    getManagedModelRuntime: () => ({
      getView() {
        onReadModelView?.();
        return { managed: true, state: 'unconfigured', models: [] };
      },
    }),
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hydrated = await service.hydrate();
  const cutoff = Date.parse(hydrated.refreshExpiresAt);
  const controller = new AbortController();
  const watch = service.watch(controller.signal);
  let received;
  try {
    const initial = (await watch.next()).value;
    assert.equal(initial.state, 'expired');
    assert.equal(initial.renewal, 'available');

    // Advance wall time without running the existing timer, then cross the
    // cutoff between the next view's clock sample and its publication.
    clock.wall = cutoff - 1;
    onReadModelView = () => { clock.wall = cutoff; };
    service.notifyView();
    onReadModelView = undefined;
    const published = (await watch.next()).value;
    assert.equal(published.state, 'expired');
    assert.equal(published.renewal, 'available');
    assert.equal(published.sampledAt, cutoff - 1);

    let terminal;
    received = watch.next().then(({ value }) => { terminal = value; });
    t.mock.timers.tick(1);
    await new Promise(setImmediate);
    assert.equal(terminal?.renewal, 'unavailable');
    assert.equal(terminal.state, 'expired');
    assert.equal(terminal.canSignIn, true);
    assert.equal(oidc.counts.refresh, 0);

    let republished = false;
    received = watch.next().then(({ done }) => { republished = !done; });
    clock.wall += 60_000;
    t.mock.timers.tick(60_000);
    await new Promise(setImmediate);
    assert.equal(republished, false);
  } finally {
    controller.abort();
    await received;
    await watch.return();
  }
});
