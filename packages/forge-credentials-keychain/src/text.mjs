/** Grammar for a credential service or namespace segment. */
export const NAMESPACE_PATTERN = /^[A-Za-z0-9._-]+$/;
export const IAM_CLIENT_SECRET_RECORD_SCOPE = 'iam-client-secret';

export function isIamClientSecretRecordKey(key) {
  return key.startsWith(`${IAM_CLIENT_SECRET_RECORD_SCOPE}/`);
}

/** Reject text that cannot make a lossless UTF-8 round trip. */
export function assertWellFormed(value) {
  if (typeof value === 'string' && !value.isWellFormed()) {
    throw Object.assign(new Error('invalid credential text'), { code: 'CRED_STORE_INVALID' });
  }
}

export function assertCredentialValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error('invalid credential value'), { code: 'CRED_STORE_INVALID' });
  }
  assertWellFormed(value);
}
