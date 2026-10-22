import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createIamService, IamError } from '../src/index.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import { createGatewayCredentialStore, createGrantStore } from '../src/store.mjs';

const configured = {
  issuer: 'https://iam.corp.example',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
  redirectUri: 'http://127.0.0.1:9/iam/callback',
};

function fakeContext(credentials = new MemoryCredentials()) {
  const provided = new Map();
  const effects = [];
  return {
    provided,
    effects,
    get(name) {
      if (name === 'credentials') return credentials;
      return undefined;
    },
    provide(name, value) {
      provided.set(name, value);
      return () => provided.delete(name);
    },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
    /** Simulate a Cordis fiber unload: run collected effects in reverse order. */
    async unload() {
      for (const dispose of effects.splice(0).reverse()) {
        if (typeof dispose === 'function') await dispose();
        else await dispose?.dispose?.();
      }
    },
  };
}

test('apply registers ctx.iam without requiring a configured IAM', async () => {
  const ctx = fakeContext();
  const dispose = apply(ctx, {});
  const service = ctx.provided.get('iam');
  assert.ok(service);
  assert.equal(service.getView().state, 'unconfigured');
  assert.equal(service.getView().canSignIn, false);
  assert.equal(ctx.effects.length, 1);
  await dispose();
  assert.equal(ctx.provided.has('iam'), false);
});

test('unload runs the framework-owned teardown even though apply returns a cleanup', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z',
    obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  const gateway = createGatewayCredentialStore(credentials);
  await gateway.save({
    value: `uag-${'0123456789abcdef'.repeat(2)}`,
    ownerSubject: 'E1001',
    enteredAt: '2030-01-01T00:00:00.000Z',
    suggestedExpiry: '2030-04-01',
  });
  const ctx = fakeContext(credentials);
  // Cordis executes a plain function plugin with `new`, so the returned
  // cleanup is discarded and only the registered effect runs on unload.
  const discarded = new apply(ctx, configured);
  assert.equal(typeof discarded, 'function');
  const service = ctx.provided.get('iam');
  await service.hydrate();
  assert.equal(service.getView().state, 'ready');
  assert.equal(service.getView().gatewayCredential.state, 'configured');
  assert.deepEqual((await credentials.resolve('ENTERPRISE_STATIC_KEY'))?.value, `uag-${'0123456789abcdef'.repeat(2)}`);

  await ctx.unload();

  assert.equal(ctx.provided.has('iam'), false);
  assert.equal(service.getView().state, 'signed-out');
  assert.equal(service.getView().signedIn, false);
  assert.equal(service.getView().gatewayCredential, null);
  // Teardown is cleanup, not logout: the grant and the user's key must survive.
  assert.equal((await credentials.readRecord('heluo-iam/session'))?.kind, 'grant');
  assert.equal((await credentials.resolve('ENTERPRISE_STATIC_KEY'))?.value, `uag-${'0123456789abcdef'.repeat(2)}`);
});

test('unconfigured sign-in fails closed with the missing fields', async () => {
  const service = createIamService({}, { credentials: new MemoryCredentials() });
  await assert.rejects(
    () => service.startSignIn(),
    (error) => error instanceof IamError && error.code === 'IAM_UNCONFIGURED' && error.details.missing.includes('clientId'),
  );
});

test('an unauthenticated error callback cannot flip an unconfigured install', async () => {
  const service = createIamService({});
  await assert.rejects(
    () => service.handleCallback('http://127.0.0.1/iam/callback?error=access_denied'),
    (error) => error.code === 'IAM_STATE_MISMATCH',
  );
  assert.equal(service.getView().state, 'unconfigured');
  assert.equal(service.getView().configured, false);
});

test('configured sign-in without credential storage fails closed', async () => {
  const service = createIamService(configured);
  await assert.rejects(
    () => service.startSignIn(),
    (error) => error instanceof IamError && error.code === 'IAM_CREDENTIALS_UNAVAILABLE',
  );
});

test('configured sign-in builds a PKCE URL with explicit endpoints', async () => {
  const service = createIamService(configured, { credentials: new MemoryCredentials() });
  const started = await service.startSignIn();
  assert.equal(started.view.state, 'authenticating');
  assert.equal(started.view.canSignIn, false);
  const url = new URL(started.authorizationUrl);
  assert.equal(url.origin + url.pathname, 'https://iam.corp.example/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'dsh-desktop');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:9/iam/callback');
  assert.ok(url.searchParams.get('state'));
  assert.ok(url.searchParams.get('nonce'));
  assert.ok(url.searchParams.get('code_challenge'));
});

test('token resolution without a grant fails closed', async () => {
  const service = createIamService(configured, { credentials: new MemoryCredentials() });
  await assert.rejects(
    () => service.resolveToken(),
    (error) => error.code === 'IAM_NOT_SIGNED_IN',
  );
});

test('sign-out from signed-out is a no-op; cancel outside an attempt is a no-op', async () => {
  const service = createIamService(configured, { credentials: new MemoryCredentials() });
  const first = await service.signOut();
  assert.equal(first.view.state, 'signed-out');
  const second = await service.cancelSignIn();
  assert.equal(second.state, 'signed-out');
});

test('watch yields the current snapshot and terminates on abort', async () => {
  const service = createIamService(configured);
  const controller = new AbortController();
  const iterator = service.watch(controller.signal)[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.state, 'signed-out');

  controller.abort();
  const second = await iterator.next();
  assert.equal(second.done, true);
});

test('createIamService rejects invalid config instead of using raw defaults', () => {
  assert.throws(
    () => createIamService({ logoutMode: 'browser' }),
    (error) => error instanceof IamError && error.code === 'IAM_CONFIG_INVALID',
  );
});

test('invalid config is rejected synchronously', () => {
  const ctx = fakeContext();
  assert.throws(
    () => apply(ctx, { logoutMode: 'browser' }),
    (error) => error instanceof IamError && error.code === 'IAM_CONFIG_INVALID',
  );
  assert.equal(ctx.provided.size, 0);
});

test('a context without provide is rejected instead of silently doing nothing', () => {
  assert.throws(
    () => apply({}, configured),
    (error) => error instanceof IamError && error.code === 'IAM_HOST_UNAVAILABLE',
  );
});

test('a context without ctx.get still fails the exclusivity check closed', () => {
  let registered;
  const ctx = {
    provide(name, value) { if (name === 'iam') registered = value; },
    effect(callback) { return callback(); },
  };
  apply(ctx, configured);
  assert.equal(registered.getView().state, 'error');
  assert.equal(registered.getView().exclusive, 'exclusive-check-unavailable');
});
test('watch delivers a published transition', async () => {
  const service = createIamService(configured, { credentials: new MemoryCredentials() });
  const iterator = service.watch()[Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  await service.startSignIn();
  const event = await pending;
  assert.equal(event.done, false);
  assert.equal(event.value.state, 'authenticating');
  await iterator.return();
});

test('dispose wakes a watch caller waiting for the next snapshot', async () => {
  const service = createIamService(configured);
  const iterator = service.watch()[Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 0));
  service.dispose();
  const event = await pending;
  assert.equal(event.done, true);
});

test('abort between yields terminates the next iteration', async () => {
  const service = createIamService(configured);
  const controller = new AbortController();
  const iterator = service.watch(controller.signal)[Symbol.asyncIterator]();
  await iterator.next();
  controller.abort();
  const event = await iterator.next();
  assert.equal(event.done, true);
});
test('a late official account service flips the view to error and blocks sign-in', async () => {
  let official = false;
  const ctx = {
    get(name) {
      if (name === 'deepseekAccount') return official ? { id: 'official' } : undefined;
      return undefined;
    },
    provide() { return () => {}; },
    effect(callback) { return callback(); },
  };
  apply(ctx, configured);
  const service = ctx.provided?.get?.('iam') ?? undefined;
  // The helper above does not collect provides; build a collecting context.
  let registered;
  const collecting = {
    get: ctx.get,
    provide(name, value) { if (name === 'iam') registered = value; return () => {}; },
    effect(callback) { return callback(); },
  };
  apply(collecting, configured);
  assert.equal(registered.getView().state, 'signed-out');
  official = true;
  assert.equal(registered.getView().state, 'error');
  assert.equal(registered.getView().canSignIn, false);
  await assert.rejects(
    () => registered.startSignIn(),
    (error) => error.code === 'IAM_EXCLUSIVE_CONFLICT',
  );
  assert.equal(service, undefined);
});

test('the host disposer awaits a Cordis fiber instead of calling it', async () => {
  let disposed = false;
  const ctx = {
    get() { return undefined; },
    provide() { return () => {}; },
    effect(callback) { return callback(); },
    inject(_deps, callback) {
      callback({
        webServer: { register() { return () => {}; } },
        effect(register) { register(); },
      });
      return { dispose: async () => { disposed = true; } };
    },
  };
  const dispose = apply(ctx, configured);
  await dispose();
  assert.equal(disposed, true);
});
test('hydrate rejects a grant issued to another client', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'other-client',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z',
    obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  const service = createIamService(configured, { credentials });
  const view = await service.hydrate();
  assert.equal(view.state, 'error');
  assert.equal(view.error, 'IAM_GRANT_CONTEXT_MISMATCH');
});

test('hydrate clears stale in-memory state when the shared record disappears', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z',
    obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  const service = createIamService(configured, { credentials });
  assert.equal((await service.hydrate()).state, 'ready');
  await credentials.deleteRecord('heluo-iam/session');
  const view = await service.hydrate();
  assert.equal(view.state, 'signed-out');
  assert.equal(view.principal, null);
});

test('an expired session can start a fresh sign-in', async () => {
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2020-01-01T00:00:00.000Z', refreshExpiresAt: '2020-01-01T00:00:00.000Z',
    obtainedAt: '2020-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  const service = createIamService(configured, { credentials });
  await service.hydrate();
  assert.equal(service.getView().state, 'expired');
  const started = await service.startSignIn();
  assert.equal(started.view.state, 'authenticating');
});

test('hydrate removes the V0.3 access-token mirror once', async () => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z', obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  await credentials.set('ENTERPRISE_ACCESS_TOKEN', 'access-old');
  const service = createIamService(configured, { credentials });
  await service.hydrate();
  assert.equal(await credentials.resolve('ENTERPRISE_ACCESS_TOKEN'), undefined);
  assert.equal(service.getView().state, 'ready');
});

test('saving a gateway credential requires a signed-in account', async () => {
  const service = createIamService(configured, { credentials: new MemoryCredentials() });
  await service.hydrate();
  await assert.rejects(
    () => service.saveGatewayCredential({ key: `uag-${'a'.repeat(32)}` }),
    (error) => error instanceof IamError && error.code === 'IAM_NOT_SIGNED_IN',
  );
});

test('saving and clearing a gateway credential keeps IAM sign-in intact', async () => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z', obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  const service = createIamService(configured, { credentials });
  await service.hydrate();
  const value = `uag-${'b'.repeat(32)}`;

  const saved = await service.saveGatewayCredential({ key: value, deviceLabel: '工作站-01' });
  assert.equal(saved.gatewayCredential.state, 'configured');
  assert.equal(saved.gatewayCredential.ownerSubject, 'E1001');
  assert.equal(saved.gatewayCredential.deviceLabel, '工作站-01');
  assert.equal(saved.gatewayCredential.suggestedExpiry.length, 10);
  assert.equal((await credentials.resolve('ENTERPRISE_STATIC_KEY')).value, value);

  const cleared = await service.clearGatewayCredential();
  assert.equal(cleared.gatewayCredential.state, 'unconfigured');
  assert.equal(await credentials.resolve('ENTERPRISE_STATIC_KEY'), undefined);
  assert.equal(cleared.state, 'ready');
  assert.equal((await credentials.readRecord('heluo-iam/session'))?.kind, 'grant');
});

test('a credential entered by another account is removed on sign-in', async () => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z', obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  await createGatewayCredentialStore(credentials).save({
    value: `uag-${'c'.repeat(32)}`,
    ownerSubject: 'E1002',
    enteredAt: '2030-01-01T00:00:00.000Z',
  });
  const service = createIamService(configured, { credentials });
  await service.hydrate();
  assert.equal(await credentials.resolve('ENTERPRISE_STATIC_KEY'), undefined);
  assert.equal(service.getView().gatewayCredential.state, 'unconfigured');
});

test('a stored value without owner metadata is dropped on sign-in', async () => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z', obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  await credentials.set('ENTERPRISE_STATIC_KEY', `uag-${'f'.repeat(32)}`);
  const service = createIamService(configured, { credentials });
  await service.hydrate();
  assert.equal(await credentials.resolve('ENTERPRISE_STATIC_KEY'), undefined);
  assert.equal(service.getView().gatewayCredential.state, 'unconfigured');
});

test('a stored gateway credential belongs to the signed-in account in the view', async () => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z', obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  await createGatewayCredentialStore(credentials).save({
    value: `uag-${'d'.repeat(32)}`,
    ownerSubject: 'E1001',
    enteredAt: '2030-01-01T00:00:00.000Z',
  });
  const service = createIamService(configured, { credentials });
  await service.hydrate();
  assert.equal(service.getView().gatewayCredential.state, 'configured');
  assert.equal(service.getView().gatewayCredential.matchesAccount, true);
});

test('a grant with an old audience still loads when no gateway audience is configured', async () => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z', obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://legacy-gateway.corp.example',
  });
  const { gatewayResource, ...withoutAudience } = configured;
  const service = createIamService(withoutAudience, { credentials });
  await service.hydrate();
  assert.equal(service.getView().state, 'ready');
});

test('a grant issued for another audience is rejected while an audience is configured', async () => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z', obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://other-gateway.corp.example',
  });
  const service = createIamService(configured, { credentials });
  await service.hydrate();
  assert.equal(service.getView().state, 'error');
  assert.equal(service.getView().error, 'IAM_GRANT_CONTEXT_MISMATCH');
});

test('sign-out keeps the gateway credential but clears its session match', async () => {
  const credentials = new MemoryCredentials();
  await createGrantStore(credentials).write({
    version: 1, issuer: 'https://iam.corp.example', subject: 'E1001', clientId: 'dsh-desktop',
    refreshToken: 'refresh-old', accessToken: 'access-old',
    accessExpiresAt: '2030-01-01T00:05:00.000Z', obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid', resource: 'https://gateway.corp.example',
  });
  await createGatewayCredentialStore(credentials).save({
    value: `uag-${'e'.repeat(32)}`,
    ownerSubject: 'E1001',
    enteredAt: '2030-01-01T00:00:00.000Z',
  });
  const service = createIamService(configured, { credentials });
  await service.hydrate();
  assert.equal(service.getView().gatewayCredential.matchesAccount, true);

  await service.signOut();

  const view = service.getView();
  assert.equal(view.state, 'signed-out');
  assert.equal(view.gatewayCredential.state, 'configured');
  assert.equal(view.gatewayCredential.matchesAccount, false);
  assert.equal((await credentials.resolve('ENTERPRISE_STATIC_KEY'))?.value, `uag-${'e'.repeat(32)}`);
});
