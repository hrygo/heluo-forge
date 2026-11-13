import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KeychainProviderError,
  STORAGE_REF_PATTERN,
  validateStorageRef,
} from '../src/index.mjs';

test('validateStorageRef accepts valid environment-variable grammar references', () => {
  assert.equal(STORAGE_REF_PATTERN.test('HEL_EXT_ALPHA_TOKEN'), true);
  assert.equal(validateStorageRef('HEL_EXT_ALPHA_TOKEN'), 'HEL_EXT_ALPHA_TOKEN');
  assert.equal(validateStorageRef('_INTERNAL_2'), '_INTERNAL_2');
});

test('validateStorageRef rejects invalid or injection-prone storage references', () => {
  for (const bad of ['', '123_BAD', 'bad-ref', 'bad/ref', 'bad ref', null, undefined, 42]) {
    assert.throws(
      () => validateStorageRef(bad),
      (err) => err instanceof KeychainProviderError && err.code === 'KEYCHAIN_REF_INVALID',
    );
  }
});

