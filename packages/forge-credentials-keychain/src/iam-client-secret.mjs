import { assertCredentialValue, IAM_CLIENT_SECRET_RECORD_SCOPE } from './text.mjs';

const METHOD = new Set(['client_secret_basic', 'client_secret_post']);
const REF = /^[a-z][a-z0-9-]*$/u;
const recordKey = (recordPrefix, ref) => `${recordPrefix}${IAM_CLIENT_SECRET_RECORD_SCOPE}/${ref}`;
const validBinding = ({ issuer, clientId, ref, method }) =>
  typeof ref === 'string' && REF.test(ref) && METHOD.has(method)
  && typeof issuer === 'string' && issuer.length > 0 && typeof clientId === 'string' && clientId.length > 0;
const matches = (payload, scope) => payload?.issuer === scope.issuer && payload.clientId === scope.clientId
  && payload.method === scope.method;
const bindingMismatch = () => Object.assign(new Error('stored IAM client secret does not match the expected binding'),
  { code: 'IAM_CLIENT_SECRET_BINDING_MISMATCH' });

function decodeRecord(value) {
  try { return JSON.parse(value); }
  catch {
    throw Object.assign(new Error('stored IAM client secret record is invalid'), { code: 'KEYCHAIN_RECORD_INVALID' });
  }
}

export function createIamClientSecretSource(records, { recordPrefix }) {
  const snapshots = new WeakMap();
  return Object.freeze({
    async read(scope) {
      if (!validBinding(scope)) return undefined;
      const pinned = await records.pin(recordKey(recordPrefix, scope.ref));
      if (!pinned) return undefined;
      const record = decodeRecord(pinned.value);
      const payload = record?.payload;
      if (record?.kind !== 'grant' || !matches(payload, scope) || Object.keys(payload).length !== 4
        || typeof payload.value !== 'string' || !payload.value.length) return undefined;
      const snapshot = Object.freeze({
        issuer: scope.issuer, clientId: scope.clientId, ref: scope.ref, revision: pinned.revision, value: payload.value,
      });
      snapshots.set(snapshot, pinned.isCurrent);
      return snapshot;
    },
    isCurrent(snapshot) { return snapshots.get(snapshot)?.() === true; },
  });
}

export async function storeIamClientSecret(records, { recordPrefix }, scope, value, previousBinding) {
  const { issuer, clientId, method, ref } = scope;
  const binding = { issuer, clientId, method, ref };
  const url = typeof issuer === 'string' && URL.canParse(issuer) ? new URL(issuer) : undefined;
  const replacing = previousBinding !== undefined;
  const expected = replacing ? { ...previousBinding, ref } : binding;
  if (!validBinding(binding) || !url || !['https:', 'http:'].includes(url.protocol)
    || url.username || url.password || /[?#]/u.test(url.href)
    || (replacing && !validBinding(expected))) {
    throw Object.assign(new Error('invalid IAM client secret binding'), { code: 'IAM_CLIENT_SECRET_CONFIG_INVALID' });
  }
  assertCredentialValue(value);
  const key = recordKey(recordPrefix, ref);
  // A failed repair must not initialize a new store. Recheck the binding under the write lock.
  if (replacing && (await records.pin(key)) === undefined) throw bindingMismatch();
  await records.modify(key, (tx) => {
    const raw = tx.get();
    const record = raw === undefined ? undefined : decodeRecord(raw);
    if ((replacing || record !== undefined)
      && (record?.kind !== 'grant' || !matches(record.payload, expected))) throw bindingMismatch();
    tx.set(JSON.stringify({ kind: 'grant', payload: { issuer, clientId, method, value } }));
  });
}
