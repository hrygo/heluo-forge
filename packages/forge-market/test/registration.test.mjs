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
  assert.match(patch, /^- insert:\n    - id: heluo-forge-market\n/);
  assert.match(patch, /inject: \[tools\]/);
  assert.match(patch, /serviceUrl: https:\/\/plugins\.corp\.example/);
  assert.doesNotMatch(patch, /targetDir/);
});

test('instructions name both supported registration paths', () => {
  const { row } = buildRegistrationRow({ name: '@heluo/forge-market' }, { serviceUrl: 'x' });
  const text = registrationInstructions(row).join('\n');
  assert.match(text, /install_bundle/);
  assert.match(text, /dsh plugin --profile <profile> add <插件目录绝对路径>/);
  assert.doesNotMatch(text, /add file:/);
  assert.match(text, /heluo-forge-market/);
  assert.match(text, /不要手工改写 profile 的 package\.json/);
});

test('names that normalise alike get different row ids', () => {
  const id = (name) => buildRegistrationRow({ name, version: '1.0.0', tag: 'v1.0.0' }, { serviceUrl: 'https://p.example' });
  const dash = id('@heluo/foo-bar').row.id;
  const underscore = id('@heluo/foo_bar').row.id;
  const dot = id('@heluo/foo.bar').row.id;
  assert.equal(dash, 'heluo-foo-bar');
  assert.equal(new Set([dash, underscore, dot]).size, 3);
  for (const value of [underscore, dot]) assert.match(value, /^[a-z0-9][a-z0-9-]*$/);
});

test('an upper case name still yields a usable row id', () => {
  const built = buildRegistrationRow({ name: '@heluo/Foo', version: '1.0.0', tag: 'v1.0.0' }, { serviceUrl: 'https://p.example' });
  assert.equal(built.ok, true);
  assert.match(built.row.id, /^heluo-foo-[0-9a-f]{6}$/);
});

test('renderers accept the buildRegistrationRow envelope', () => {
  const built = buildRegistrationRow({ name: '@heluo/demo-a', version: '0.3.0' }, { serviceUrl: 'https://p.example' });
  assert.equal(built.ok, true);
  assert.match(renderPatch(built), /id: heluo-demo-a/);
  assert.ok(registrationInstructions(built).some((line) => line.includes('heluo-demo-a')));
});

test('renderers refuse a failed registration result', () => {
  const built = buildRegistrationRow({ name: '@heluo/demo-a' }, {});
  assert.equal(built.ok, false);
  assert.throws(() => renderPatch(built), /registration row required/);
  assert.throws(() => registrationInstructions({}), /registration row required/);
});
