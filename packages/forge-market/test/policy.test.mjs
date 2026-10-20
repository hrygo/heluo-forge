import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEngines, checkInstall, parseEngines, parsePackageName, satisfiesRange } from '../src/policy.mjs';

const policy = {
  registryUrl: 'https://npm.corp.example/',
  allowedScopes: ['@heluo'],
  allowPrerelease: false,
  allowInstallScripts: false,
  pinned: { '@heluo/forge-gateway': '0.3.0' },
};

test('parses a scoped package name', () => {
  assert.deepEqual(parsePackageName('@heluo/forge-gateway'), { scope: '@heluo', name: 'forge-gateway' });
  assert.equal(parsePackageName('lodash'), null);
  assert.equal(parsePackageName('@heluo'), null);
});

test('blocks unknown scope, prerelease and install scripts', () => {
  const ok = { name: '@heluo/forge-gateway', version: '0.3.0', prerelease: false, hasInstallScript: false };
  assert.deepEqual(checkInstall(ok, policy), { allowed: true, reason: null });
  assert.equal(checkInstall({ ...ok, name: '@other/x' }, policy).reason, 'scope-not-allowed');
  assert.equal(checkInstall({ ...ok, prerelease: true }, policy).reason, 'prerelease-blocked');
  assert.equal(checkInstall({ ...ok, hasInstallScript: true }, policy).reason, 'install-script-blocked');
  assert.equal(checkInstall({ ...ok, version: '0.4.0' }, policy).reason, 'version-pinned');
});

test('refuses to install without a registry', () => {
  assert.equal(checkInstall({ name: '@heluo/x', version: '1.0.0' }, { allowedScopes: ['@heluo'] }).reason, 'no-registry');
});

test('compares engines.dsh against the running version', () => {
  assert.equal(checkEngines('>=0.2.1', '0.2.1').compatible, true);
  assert.equal(checkEngines('>=0.2.1', '0.3.0').compatible, true);
  assert.equal(checkEngines('>=0.2.1', '0.1.9').reason, 'requires-newer-dsh');
  assert.equal(checkEngines('', '0.2.1').reason, 'missing-engines');
});

test('parses the documented engines forms', () => {
  assert.deepEqual(parseEngines('>=0.2.1'), { op: '>=', major: 0, minor: 2, patch: 1 });
  assert.deepEqual(parseEngines('^0.2.1'), { op: '^', major: 0, minor: 2, patch: 1 });
  assert.deepEqual(parseEngines('~0.2.1'), { op: '~', major: 0, minor: 2, patch: 1 });
  assert.deepEqual(parseEngines('0.2.1'), { op: '=', major: 0, minor: 2, patch: 1 });
  assert.equal(parseEngines('*'), null);
  assert.equal(parseEngines('latest'), null);
});

test('caret stays inside the declared minor for 0.x', () => {
  const range = parseEngines('^0.2.1');
  assert.equal(satisfiesRange(range, { major: 0, minor: 2, patch: 9 }), true);
  assert.equal(satisfiesRange(range, { major: 0, minor: 3, patch: 0 }), false);
});

test('tilde stays inside the declared minor', () => {
  const range = parseEngines('~0.2.1');
  assert.equal(satisfiesRange(range, { major: 0, minor: 2, patch: 9 }), true);
  assert.equal(satisfiesRange(range, { major: 0, minor: 3, patch: 0 }), false);
});

test('checkEngines separates too old from outside the range', () => {
  assert.deepEqual(checkEngines('^0.2.1', '0.2.3'), { compatible: true, reason: null });
  assert.equal(checkEngines('^0.2.1', '0.3.0').reason, 'outside-range');
  assert.equal(checkEngines('>=0.4.0', '0.2.1').reason, 'requires-newer-dsh');
});
