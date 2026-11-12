import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAesGcmCipher } from '../src/cipher.mjs';

const key = Buffer.alloc(32, 0x5a);
const context = { kind: 'record', id: 'heluo-iam/session', owner: 'E1001', kid: 'k1' };
const cipher = createAesGcmCipher({ byId: (kid) => kid === 'k1' ? key : undefined });
const errorCode = (code) => (error) => error.code === code && !error.message.includes('E1001');

test('round trips arbitrary nonempty bytes and emits the specified envelope', () => {
  for (const size of [1, 2, 32, 257, 4096]) {
    const plaintext = randomBytes(size);
    const envelope = cipher.seal({ ...context, plaintext });
    assert.ok(Buffer.isBuffer(envelope));
    assert.deepEqual(envelope.subarray(0, 7), Buffer.from([0x48, 0x46, 0x53, 0x45, 1, 1, 2]));
    assert.equal(envelope.subarray(7, 9).toString('ascii'), 'k1');
    assert.equal(envelope.length, 7 + 2 + 12 + 16 + size);
    assert.deepEqual(cipher.open({ ...context, envelope }), plaintext);
  }
});

test('accepts byte arrays for plaintext and envelope', () => {
  const envelope = cipher.seal({ ...context, plaintext: new Uint8Array([0, 255, 128]) });
  assert.deepEqual(cipher.open({ ...context, envelope: new Uint8Array(envelope) }), Buffer.from([0, 255, 128]));
});

test('each encryption chooses a new IV', () => {
  const plaintext = Buffer.from('value');
  const a = cipher.seal({ ...context, plaintext });
  const b = cipher.seal({ ...context, plaintext });
  assert.notDeepEqual(a.subarray(9, 21), b.subarray(9, 21));
});

test('rejects context and row kid mismatches with one error', () => {
  const envelope = cipher.seal({ ...context, plaintext: Buffer.from('value') });
  for (const change of [{ kind: 'ref' }, { id: 'another' }, { owner: 'E1002' }, { kid: 'k2' }]) {
    assert.throws(() => cipher.open({ ...context, ...change, envelope }), errorCode('CRED_DECRYPT_FAILED'));
  }
});

test('rejects tampered header, IV, tag and ciphertext and all truncations', () => {
  const envelope = cipher.seal({ ...context, plaintext: Buffer.from('value') });
  for (const offset of [0, 4, 5, 6, 7, 9, 21, 37]) {
    const modified = Buffer.from(envelope);
    modified[offset] ^= 1;
    assert.throws(() => cipher.open({ ...context, envelope: modified }), errorCode('CRED_DECRYPT_FAILED'));
  }
  for (let length = 0; length < envelope.length; length++) {
    assert.throws(() => cipher.open({ ...context, envelope: envelope.subarray(0, length) }), errorCode('CRED_DECRYPT_FAILED'));
  }
});

test('unknown key and invalid key material fail without leaking input', () => {
  const envelope = cipher.seal({ ...context, plaintext: Buffer.from('value') });
  for (const material of [undefined, Buffer.alloc(31), Buffer.alloc(33), 'not a key']) {
    const broken = createAesGcmCipher({ byId: () => material });
    assert.throws(() => broken.open({ ...context, envelope }), errorCode('CRED_KEY_UNAVAILABLE'));
    assert.throws(() => broken.seal({ ...context, plaintext: Buffer.from('value') }), errorCode('CRED_KEY_UNAVAILABLE'));
  }
});

test('unexpected key provider errors are not disguised as unavailable keys', () => {
  const unexpected = new TypeError('synthetic programming error');
  const broken = createAesGcmCipher({ byId: () => { throw unexpected; } });
  assert.throws(() => broken.seal({ ...context, plaintext: Buffer.from('value') }), (error) => error === unexpected);
});

test('rejects empty plaintext, malformed context and malformed envelope', () => {
  for (const change of [
    { plaintext: Buffer.alloc(0) }, { plaintext: 'value' }, { kind: 'other' },
    { id: '' }, { owner: undefined }, { kid: '' }, { kid: 'é' }, { kid: 'x'.repeat(256) },
  ]) {
    assert.throws(() => cipher.seal({ ...context, plaintext: Buffer.from('value'), ...change }));
  }
  assert.throws(() => cipher.open({ ...context, envelope: 'bad' }), errorCode('CRED_DECRYPT_FAILED'));
});
