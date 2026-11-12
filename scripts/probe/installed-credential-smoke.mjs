#!/usr/bin/env node
// Exercise the installed package using synthetic values and a temporary store.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('usage: installed-credential-smoke.mjs <package-directory>');
const { createCredentialStore } = await import(pathToFileURL(join(resolve(process.argv[2]), 'src/index.mjs')).href);
const directory = await mkdtemp(join(tmpdir(), 'forge-installed-credential-'));
let store;
try {
  store = createCredentialStore({ directory });
  await store.set('heluo-forge/iam/ref/SYNTHETIC', 'synthetic-value');
  await store.close();
  store = createCredentialStore({ directory, readOnly: true });
  assert.equal(await store.get('heluo-forge/iam/ref/SYNTHETIC'), 'synthetic-value');
  await store.close();
  store = undefined;
  console.log('synthetic SQLite round trip passed');
} finally {
  await store?.close();
  await rm(directory, { recursive: true, force: true });
}
