import { assertCredentialValue } from './text.mjs';

const METHOD = new Set(['client_secret_basic', 'client_secret_post']);
const REF = /^[a-z][a-z0-9-]*$/u;
const recordKey = (ref) => `iam-client-secret/${ref}`;
const validBinding = ({ issuer, clientId, ref, method }) =>
  typeof ref === 'string' && REF.test(ref) && METHOD.has(method)
  && typeof issuer === 'string' && issuer.length > 0 && typeof clientId === 'string' && clientId.length > 0;
const matches = (payload, scope) => payload?.issuer === scope.issuer && payload.clientId === scope.clientId
  && payload.method === scope.method;

export function createIamClientSecretSource(backend, { recordPrefix }) {
  const snapshots = new WeakMap();
  return Object.freeze({
    async read(scope) {
      if (!validBinding(scope)) return undefined;
      const pinned = await backend.pinRecord(`${recordPrefix}${recordKey(scope.ref)}`);
      if (!pinned) return undefined;
      let record;
      try { record = JSON.parse(pinned.value); }
      catch {
        throw Object.assign(new Error('stored IAM client secret record is invalid'), { code: 'KEYCHAIN_RECORD_INVALID' });
      }
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

export async function storeIamClientSecret(provider, scope, value) {
  const issuer = typeof scope.issuer === 'string' && URL.canParse(scope.issuer) ? new URL(scope.issuer) : undefined;
  if (!validBinding(scope) || !issuer || !['https:', 'http:'].includes(issuer.protocol)
    || issuer.username || issuer.password || /[?#]/u.test(issuer.href)) {
    throw Object.assign(new Error('invalid IAM client secret binding'), { code: 'IAM_CLIENT_SECRET_CONFIG_INVALID' });
  }
  assertCredentialValue(value);
  await provider.modifyRecord(recordKey(scope.ref), (record) => {
    if (record !== undefined && (record.kind !== 'grant' || !matches(record.payload, scope))) {
      throw Object.assign(new Error('IAM client secret reference already has a different binding'),
        { code: 'IAM_CLIENT_SECRET_BINDING_MISMATCH' });
    }
    return { kind: 'grant', payload: { issuer: scope.issuer, clientId: scope.clientId, method: scope.method, value } };
  });
}
