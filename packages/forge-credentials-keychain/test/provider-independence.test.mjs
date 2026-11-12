import assert from 'node:assert/strict';
import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { NAMESPACE_PATTERN } from '@heluo/forge-credentials-keychain/backend';
import { namespacePrefixes } from '../src/provider.mjs';
import { outsideRepositoryTmpAsync } from './support/tmp.mjs';

test('the public backend subpath retains its namespace grammar', () => {
  for (const value of ['heluo-forge', 'IAM_1.test', 'A']) assert.equal(NAMESPACE_PATTERN.test(value), true);
  for (const value of ['', 'a/b', 'a b', '中文']) assert.equal(NAMESPACE_PATTERN.test(value), false);
});

test('provider namespace parts keep their accepted names and rejection code', () => {
  assert.deepEqual(namespacePrefixes({ service: 'Corp_1.test', accountPrefix: 'iam-2' }), {
    namespace: 'Corp_1.test/iam-2',
    refPrefix: 'Corp_1.test/iam-2/ref/',
    recordPrefix: 'Corp_1.test/iam-2/record/',
  });
  for (const field of ['service', 'accountPrefix']) {
    for (const value of ['', 'a/b', 'a b', '中文', 42]) {
      assert.throws(() => namespacePrefixes({ [field]: value }), { code: 'KEYCHAIN_NAMESPACE_INVALID' });
    }
  }
});

test('provider can be imported and used without the concrete test backend module', async (t) => {
  const directory = await outsideRepositoryTmpAsync('forge-provider-independent-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of ['provider.mjs', 'text.mjs']) {
    await copyFile(new URL(`../src/${file}`, import.meta.url), join(directory, file));
  }
  const { createKeychainProvider } = await import(pathToFileURL(join(directory, 'provider.mjs')).href);
  const values = new Map();
  const backend = {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
    list: async (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)),
  };
  const provider = createKeychainProvider(backend, { service: 'custom-svc', accountPrefix: 'iam_1' });
  await provider.set('SYNTHETIC_REF', 'synthetic-value');
  assert.equal((await provider.resolve('SYNTHETIC_REF')).value, 'synthetic-value');
  assert.equal(values.get('custom-svc/iam_1/ref/SYNTHETIC_REF'), 'synthetic-value');
});
