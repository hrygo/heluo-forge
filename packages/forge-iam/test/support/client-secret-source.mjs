import { randomUUID } from 'node:crypto';

/** Synthetic, per-test memory only. Admin controls are not handed to the service. */
export function createClientSecretFixture(credentials, {
  issuer = 'https://iam.corp.example', clientId = 'synthetic-client', ref = 'fixture-client',
  method = 'client_secret_basic', value = 'SYNTHETIC_CLIENT_PRIVATE',
} = {}) {
  const binding = Object.freeze({ issuer, clientId, ref });
  const counts = { read: 0, current: 0, verify: 0 };
  let current;
  let marker;
  let boundSource;
  let readBarrier;
  const changed = () => { marker = Object.freeze({}); };
  const replace = (next = value) => {
    changed();
    current = next === undefined ? undefined : Object.freeze({ ...binding, revision: randomUUID(), value: next });
    return current;
  };
  replace(value);
  const source = Object.freeze({
    async read(expected) {
      counts.read++;
      const captured = current;
      if (readBarrier) await readBarrier();
      return Object.keys(binding).every((key) => expected[key] === binding[key]) ? captured : undefined;
    },
    isCurrent(snapshot) { counts.current++; return current !== undefined && snapshot === current; },
  });
  boundSource = source;
  const getClientSecretSource = () => boundSource;
  const getClientSecretBindingScope = () => boundSource && current ? marker : undefined;
  const options = {
    credentials, issuer, getClientSecretSource, getClientSecretBindingScope,
    verifyClientSecretSource(candidateCredentials, candidateSource, scope) {
      counts.verify++;
      return candidateCredentials === credentials && candidateSource === source
        && Object.keys(scope).sort().join(',') === 'clientId,issuer,method,ref'
        && Object.keys(binding).every((key) => scope[key] === binding[key]) && scope.method === method;
    },
  };
  return { source, options, counts, binding, config: { clientId, authMode: 'confidential', clientAuthMethod: method, clientSecretRef: ref },
    snapshot: () => current, replace,
    remove() { changed(); current = undefined; },
    restore(snapshot) { changed(); current = snapshot; },
    bind(next) { changed(); boundSource = next; },
    setReadBarrier(barrier) { readBarrier = barrier; },
    acceptsWitnessBinding(candidate, scope, readers) {
      return candidate === boundSource && candidate === source && current !== undefined
        && readers.getClientSecretSource === getClientSecretSource
        && readers.getClientSecretBindingScope === getClientSecretBindingScope
        && scope.mode === 'confidential' && scope.method === method
        && Object.keys(binding).every((key) => scope[key] === binding[key]);
    } };

}
