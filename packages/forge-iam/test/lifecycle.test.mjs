import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { apply } from '../src/index.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const configured = {
  issuer: 'https://iam.corp.example',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
  redirectUri: 'http://127.0.0.1:9/iam/callback',
};

/** Minimal Cordis context: provide/effect/inject plus a framework-style unload. */
function fakeContext(credentials = new MemoryCredentials(), options = {}) {
  const provided = new Map();
  const effects = [];
  const routes = [];
  return {
    provided,
    effects,
    routes,
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'connection') return { userId: 'local-operator' };
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
    inject(deps, callback) {
      if (!deps.includes('webServer') || options.noWebServer) return undefined;
      const host = {
        webServer: {
          getOrigin: () => 'http://127.0.0.1:9',
          // The real host webserver returns a disposer function, not a disposable object.
          register(route) {
            routes.push(route);
            return () => {
              routes.splice(routes.indexOf(route), 1);
            };
          },
        },
      };
      const dispose = callback(host);
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

test('lifecycle: apply provides ctx.iam, unload removes it, and a second apply works', async () => {
  const ctx = fakeContext();
  apply(ctx, configured);
  const first = ctx.provided.get('iam');
  assert.ok(first, 'apply must provide ctx.iam');
  await ctx.unload();
  assert.equal(ctx.provided.has('iam'), false, 'unload must unprovide ctx.iam');
  await assert.rejects(() => first.resolveToken(), (error) => error.code === 'IAM_DISPOSED');

  apply(ctx, configured);
  const second = ctx.provided.get('iam');
  assert.ok(second);
  assert.notEqual(second, first, 'a re-applied plugin must get a fresh service');
  assert.equal(second.getView().state, 'signed-out');
  await ctx.unload();
});

test('lifecycle: unload removes the routes and the webServer fiber it injected', async () => {
  const ctx = fakeContext();
  apply(ctx, configured);
  assert.ok(ctx.routes.length > 0, 'a web server must receive the IAM routes');
  assert.ok(ctx.routes.length > 0);
  await ctx.unload();
  assert.equal(ctx.routes.length, 0, 'unload must dispose the routes the plugin registered');
});

test('lifecycle: an unusable credentials backend fails closed and still unloads', async () => {
  const broken = {
    readRecord: async () => {
      throw new Error('backend unavailable');
    },
    modifyRecord: async () => {
      throw new Error('backend unavailable');
    },
    resolve: async () => undefined,
  };
  const ctx = fakeContext(broken);
  apply(ctx, configured);
  const service = ctx.provided.get('iam');
  const view = service.getView();
  assert.equal(view.state !== 'ready', true, 'a broken backend must not report a signed-in view');
  assert.equal(view.canSignIn, true, 'the user can still start a sign-in');
  await ctx.unload();
  assert.equal(ctx.provided.has('iam'), false);
});

test('lifecycle: disposing a sign-in attempt releases its timer so the process can exit', async () => {
  const startedAt = Date.now();
  const { stdout } = await run(process.execPath, [join(here, 'support', 'attempt-exit-worker.mjs'), '--attempt-exit'], {
    timeout: 20_000,
    encoding: 'utf8',
  });
  const elapsed = Date.now() - startedAt;
  const result = JSON.parse(stdout.trim());
  assert.equal(result.state, 'authenticating');
  assert.equal(result.disposed, true);
  // The attempt timeout is 30 s; a leaked timer would keep the child alive for it.
  assert.ok(elapsed < 10_000, `child took ${elapsed}ms, so the attempt timer was not released`);
});
