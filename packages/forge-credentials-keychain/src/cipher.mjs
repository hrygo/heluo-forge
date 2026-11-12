import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('HFSE');
const HEADER_LENGTH = 7;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function failure(code) {
  const error = new Error(code === 'CRED_KEY_UNAVAILABLE' ? 'Credential key unavailable' : 'Credential decryption failed');
  error.code = code;
  return error;
}

function validContext({ kind, id, owner, kid }) {
  return (kind === 'ref' || kind === 'record')
    && typeof id === 'string' && id.length > 0 && !id.includes('|')
    && typeof owner === 'string'
    && typeof kid === 'string' && /^[A-Za-z0-9._-]{1,255}$/.test(kid);
}

function keyFor(provider, kid) {
  const key = provider.byId(kid);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw failure('CRED_KEY_UNAVAILABLE');
  return key;
}

function aad({ kind, id, owner, kid }) {
  return Buffer.from(`HFSE|1|${kind}|${id}|${owner}|${kid}`, 'utf8');
}

export function createAesGcmCipher(keyProvider) {
  return Object.freeze({
    seal(input) {
      if (!input || !validContext(input) || !(input.plaintext instanceof Uint8Array) || input.plaintext.length === 0) {
        throw failure('CRED_DECRYPT_FAILED');
      }
      const key = keyFor(keyProvider, input.kid);
      const kid = Buffer.from(input.kid, 'ascii');
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
      cipher.setAAD(aad(input));
      const encrypted = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
      return Buffer.concat([MAGIC, Buffer.from([1, 1, kid.length]), kid, iv, cipher.getAuthTag(), encrypted]);
    },
    open(input) {
      if (!input || !validContext(input) || !(input.envelope instanceof Uint8Array)) throw failure('CRED_DECRYPT_FAILED');
      const envelope = Buffer.from(input.envelope);
      if (envelope.length < HEADER_LENGTH + IV_LENGTH + TAG_LENGTH + 2
        || !envelope.subarray(0, 4).equals(MAGIC) || envelope[4] !== 1 || envelope[5] !== 1) {
        throw failure('CRED_DECRYPT_FAILED');
      }
      const kidLength = envelope[6];
      const ivOffset = HEADER_LENGTH + kidLength;
      const tagOffset = ivOffset + IV_LENGTH;
      const dataOffset = tagOffset + TAG_LENGTH;
      if (kidLength === 0 || envelope.length <= dataOffset
        || !envelope.subarray(HEADER_LENGTH, ivOffset).equals(Buffer.from(input.kid, 'ascii'))) {
        throw failure('CRED_DECRYPT_FAILED');
      }
      const key = keyFor(keyProvider, input.kid);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(ivOffset, tagOffset), { authTagLength: TAG_LENGTH });
        decipher.setAAD(aad(input));
        decipher.setAuthTag(envelope.subarray(tagOffset, dataOffset));
        return Buffer.concat([decipher.update(envelope.subarray(dataOffset)), decipher.final()]);
      } catch {
        throw failure('CRED_DECRYPT_FAILED');
      }
    },
  });
}
