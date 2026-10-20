import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistrationRow, registrationInstructions, renderPatch } from '../src/registration.mjs';

test('derives a stable row id from the package name', () => {
  const result = buildRegistrationRow({ name: '@heluo/forge-market' }, { serviceUrl: 'https://plugins.corp.example' });
  assert.equal(result.ok, true);
  assert.equal(result.row.id, 'heluo-forge-market');
  assert.deepEqual(result.row.inject, ['tools']);
});

test('requires a scoped name and a service url', () => {
  assert.equal(buildRegistrationRow({ name: 'forge-market' }, { serviceUrl: 'x' }).reason, 'bad-name');
  assert.equal(buildRegistrationRow({ name: '@heluo/x' }, {}).reason, 'no-service-url');
});

test('renders a patch document that keeps the dialect shape', () => {
  const { row } = buildRegistrationRow({ name: '@heluo/forge-market' }, {
    serviceUrl: 'https://plugins.corp.example',
    allowedHosts: ['gitee.corp.example'],
  });
  const patch = renderPatch(row);
  assert.match(patch, /^insert:\n  - id: heluo-forge-market\n/);
  assert.match(patch, /inject: \[tools\]/);
  assert.match(patch, /serviceUrl: https:\/\/plugins\.corp\.example/);
  assert.doesNotMatch(patch, /targetDir/);
});

test('instructions name both supported registration paths', () => {
  const { row } = buildRegistrationRow({ name: '@heluo/forge-market' }, { serviceUrl: 'x' });
  const text = registrationInstructions(row).join('\n');
  assert.match(text, /install_bundle/);
  assert.match(text, /dsh plugin --profile <profile> add file:/);
  assert.match(text, /heluo-forge-market/);
  assert.match(text, /不要手工改写 profile 的 package\.json/);
});
