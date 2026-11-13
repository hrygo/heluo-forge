import assert from 'node:assert/strict';
import test from 'node:test';

import { HOST_PATH, SECRETS } from '../scripts/lib/sensitive-patterns.mjs';

const hits = (text) => HOST_PATH.test(text);

// Every fixture below is assembled at run time. This file is scanned by the
// same repository and local scanners it covers, so a stored literal example of a
// host path, a cloud key id or an address would be reported by them.
const U = (...parts) => ['', 'Users', ...parts].join('/');
const HOME = (path) => ['', 'home', path].join('/');
const WIN = (...parts) => ['C:', 'Users', ...parts].join('\\');
const WIN_ESCAPED = (...parts) => ['C:', 'Users', ...parts].join('\\\\');
const PEM = ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----'].join(' ');
const KEY_ID = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const URL_WITH_PASSWORD = ['https://user', ':', 'secret', '@', 'corp.example', '/path'].join('');

test('host path: POSIX user and home prefixes are reported', () => {
  assert.equal(hits(U('example/work/repo')), true);
  assert.equal(hits(`cp ${HOME('example/.npmrc')} .`), true);
});

test('host path: a Windows path with single separators is reported', () => {
  // A plain (unescaped) Windows path is what a log, a `.env` value or a shell
  // transcript carries; missing it left the artifact scan blind on Windows.
  assert.equal(hits(WIN('example\\work\\repo')), true);
  assert.equal(hits(`D:${U('example/cache')}`), true);
});

test('host path: an escaped Windows path is still reported', () => {
  // JSON/JS string literals double the separator; the rule must not regress on
  // the form the previous regex happened to accept.
  assert.equal(hits(WIN_ESCAPED('example\\\\work')), true);
});

test('host path: relative paths and ordinary words are not reported', () => {
  assert.equal(hits(['Users', 'example'].join('/')), false);
  assert.equal(hits('the Users directory'), false);
  assert.equal(hits(`https://corp.example${U('example')}`), false);
});

test('secrets: the shared rule set still covers the documented carriers', () => {
  const probe = (text) => SECRETS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  assert.deepEqual(probe(PEM), ['private key block']);
  assert.deepEqual(probe(`token ghp_${'a'.repeat(30)}`), ['GitHub token']);
  assert.deepEqual(probe(`key sk-${'a'.repeat(30)}`), ['API secret key']);
  assert.deepEqual(probe(`id ${KEY_ID}`), ['cloud access key']);
  assert.deepEqual(probe(URL_WITH_PASSWORD), ['URL with embedded password']);
  assert.deepEqual(probe('nothing sensitive here'), []);
});
