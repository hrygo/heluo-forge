import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as iam from '@heluo/forge-iam';
import * as manager from '@heluo/forge-skills-manager';

// Use the manager's pinned development SDK; the repository test owns the
// cross-package IAM contract, while the manager's own verify stays independent.
const managerRequire = createRequire(new URL('../packages/forge-skills-manager/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(managerRequire.resolve('@deepseek-ai/cordis')).href);

test('an independently mounted manager scope can dynamically inject the same Host IAM service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-manager-iam-'));
  const keys = ['DSH_HOME', 'DSH_AGENTS_HOME', 'HOME', 'USERPROFILE'];
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = join(directory, key); });
  const ctx = new Context();
  const routes = new Map();
  ctx.provide('connection', { fetch: { register(route) {
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  } } });
  ctx.provide('skills', { registerProvider: () => () => {} });
  ctx.provide('sessions', { list: () => [] });
  let binding, bound;
  try {
    const managerFiber = ctx.plugin({ ...manager, apply(scope, config) {
      manager.apply(scope, config);
      // Exercise future IAM consumption in the actual manager scope; no IAM
      // business feature or package dependency is needed for this host contract.
      binding = scope.inject(['iam'], services => {
        bound = services.iam;
        services.effect(() => () => { bound = undefined; });
      });
    } });
    await managerFiber.await();
    assert.ok(routes.has('/api/forge-skills-manager/state'), 'IAM is not required to activate manager');
    assert.equal(bound, undefined);
    const provider = ctx.plugin(iam);
    await provider.await();
    await binding.await();
    const first = bound;
    assert.equal(first, ctx.get('iam'));
    assert.equal(typeof first.getPrincipal, 'function');
    assert.notEqual(first.getView(), undefined);
    await provider.dispose();
    await binding.await();
    assert.equal(bound, undefined, 'unloaded IAM is not retained');
    assert.ok(routes.has('/api/forge-skills-manager/state'), 'manager remains mounted without IAM');
    const replacement = ctx.plugin(iam);
    await replacement.await();
    await binding.await();
    assert.equal(bound, ctx.get('iam'));
    assert.notEqual(bound, first, 'replacement IAM is visible in the same manager scope');
    await managerFiber.dispose();
    assert.equal(routes.size, 0);
    assert.equal(bound, undefined);
    assert.equal(typeof ctx.get('iam').getView, 'function', 'removing manager preserves IAM');
  } finally {
    await ctx.fiber.dispose();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    // IAM diagnostics drain asynchronously; Windows may briefly retain the
    // SQLite log lock after the Host has finished disposing its services.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});
