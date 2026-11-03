import { validateConfig } from './config.mjs';
import { IamError } from './errors.mjs';

// Operations may hold short-lived material; provenance deliberately cannot.
const operations = new WeakMap();
const provenances = new WeakMap();
const snapshotFields = ['issuer', 'clientId', 'ref', 'revision', 'value'];
const fail = (code) => new IamError(code, {
  IAM_CONFIG_INVALID: 'IAM client authentication configuration is invalid',
  IAM_CLIENT_AUTH_UNVERIFIED: 'IAM client authentication is not verified',
  IAM_CLIENT_AUTH_CHANGED: 'IAM client authentication changed',
  IAM_CLIENT_AUTH_CONTEXT_INVALID: 'IAM client authentication context is invalid',
}[code]);
function synchronousValue(getter) {
  const value = getter();
  if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); return undefined; }
  return value;
}
function literalTrue(value) {
  if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
  return value === true;
}
export function assertClientAuthConfigured(config, options) {
  if (config.authMode !== 'confidential') return;
  try {
    if (typeof options.getClientSecretSource === 'function' && typeof options.verifyClientSecretSource === 'function') return;
  } catch { /* no private exception text */ }
  throw fail('IAM_CLIENT_AUTH_UNVERIFIED');
}

// Separate activation: no snapshot, secret, HTTP material or material closure.
function captureProvenance(config, options, context) {
  const expected = context.expectedProvenance;
  try {
    const credentials = context.credentials ?? options.credentials;
    const getter = options.getClientSecretSource;
    const verifier = options.verifyClientSecretSource;
    const credentialGetter = options.getCredentials;
    if (!credentials || typeof getter !== 'function' || typeof verifier !== 'function') throw 0;
    const source = synchronousValue(getter);
    const scope = Object.freeze({ issuer: context.issuer ?? options.issuer, clientId: config.clientId,
      ref: config.clientSecretRef, method: config.clientAuthMethod });
    if (!source || ['issuer', 'clientId', 'ref'].some((key) => typeof scope[key] !== 'string' || !scope[key].length)
      || !literalTrue(verifier(credentials, source, scope))
      || (credentialGetter !== undefined && (typeof credentialGetter !== 'function' || synchronousValue(credentialGetter) !== credentials))) throw 0;
    if (expected !== undefined) {
      const old = provenances.get(expected);
      if (!old || old.credentials !== credentials || old.source !== source || old.getter !== getter
        || old.verifier !== verifier || old.credentialGetter !== credentialGetter
        || Object.keys(scope).some((key) => old.scope[key] !== scope[key])) throw 0;
      assertClientAuthProvenance(expected);
      return expected;
    }
    const handle = Object.freeze({});
    provenances.set(handle, Object.freeze({ credentials, source, getter, verifier, credentialGetter, scope, options }));
    return handle;
  } catch { throw fail(expected === undefined ? 'IAM_CLIENT_AUTH_UNVERIFIED' : 'IAM_CLIENT_AUTH_CHANGED'); }
}
export function assertClientAuthProvenance(handle) {
  const data = provenances.get(handle);
  try {
    if (data && (data.options.credentials === undefined || data.options.credentials === data.credentials)
      && data.options.getClientSecretSource === data.getter && data.options.verifyClientSecretSource === data.verifier
      && data.options.getCredentials === data.credentialGetter && synchronousValue(data.getter) === data.source
      && (data.credentialGetter === undefined || synchronousValue(data.credentialGetter) === data.credentials)
      && literalTrue(data.verifier(data.credentials, data.source, data.scope))) return true;
  } catch { /* fixed changed below */ }
  throw fail('IAM_CLIENT_AUTH_CHANGED');
}
function copySnapshot(original, binding) {
  if (!original || typeof original !== 'object' || Array.isArray(original)
    || Reflect.ownKeys(original).length !== snapshotFields.length) return undefined;
  const copy = Object.fromEntries(snapshotFields.map((key) => [key, original[key]]));
  if (snapshotFields.some((key) => typeof copy[key] !== 'string' || !copy[key].length)
    || Object.keys(binding).some((key) => copy[key] !== binding[key])) return undefined;
  return Object.freeze(copy);
}
function guardedMaterial(provenance, original, copy, guard) {
  const localGuard = () => { if (guard && !literalTrue(guard())) throw fail('IAM_CLIENT_AUTH_CHANGED'); };
  return () => {
    localGuard();
    try {
      assertClientAuthProvenance(provenance);
      const data = provenances.get(provenance);
      const unchanged = () => snapshotFields.every((key) => original[key] === copy[key]);
      if (!unchanged() || !literalTrue(data.source.isCurrent(original))) throw 0;
      assertClientAuthProvenance(provenance);
      if (!unchanged()) throw 0;
    } catch { throw fail('IAM_CLIENT_AUTH_CHANGED'); }
    localGuard();
    return true;
  };
}
/** IAM-002 private source/mock seam; context is local lifecycle state, not config. */
export async function prepareClientAuthentication(rawConfig, options = {}, context = {}) {
  const checked = validateConfig(rawConfig);
  if (checked.issues) throw fail('IAM_CONFIG_INVALID');
  const config = checked.value;
  if (config.authMode === 'public') {
    const pin = Object.freeze({ mode: 'public', method: 'none' });
    const operation = Object.freeze({ pin });
    operations.set(operation, { clientId: config.clientId, method: 'none', assertCurrent: () => true });
    return operation;
  }
  const provenance = captureProvenance(config, options, context);
  const { source, scope } = provenances.get(provenance);
  const binding = Object.freeze({ issuer: scope.issuer, clientId: scope.clientId, ref: scope.ref });
  let original;
  try { original = await source.read(binding); }
  catch {
    if (context.guard) context.guard();
    assertClientAuthProvenance(provenance);
    throw fail('IAM_CLIENT_AUTH_UNVERIFIED');
  }
  if (context.guard && !literalTrue(context.guard())) throw fail('IAM_CLIENT_AUTH_CHANGED');
  assertClientAuthProvenance(provenance);
  let copy;
  try { copy = copySnapshot(original, binding); } catch { /* no source exception retention */ }
  if (!copy) throw fail('IAM_CLIENT_AUTH_UNVERIFIED');
  const pin = Object.freeze({ mode: 'confidential', method: scope.method, ...binding, revision: copy.revision });
  const expectedPin = context.expectedPin ?? options.expectedPin;
  if (expectedPin && Object.keys(pin).some((key) => expectedPin[key] !== pin[key])) {
    throw fail(context.expectedProvenance === undefined ? 'IAM_CLIENT_AUTH_CONTEXT_INVALID' : 'IAM_CLIENT_AUTH_CHANGED');
  }
  const assertCurrent = guardedMaterial(provenance, original, copy, context.guard);
  assertCurrent();
  const operation = Object.freeze({ pin, provenance });
  operations.set(operation, { clientId: scope.clientId, method: scope.method, secret: copy.value, assertCurrent });
  return operation;
}
export function clientAuthDescriptor(operation) {
  return operation === undefined ? undefined : Object.freeze({ pin: operation.pin, provenance: operation.provenance });
}
export function clientAuthContext(pin) {
  return { mode: 'confidential', method: pin.method, secretRef: pin.ref, secretRevision: pin.revision };
}
export function grantAuthPin(grant) {
  return grant?.version === 2 ? Object.freeze({ mode: 'confidential', method: grant.authContext.method,
    issuer: grant.issuer, clientId: grant.clientId, ref: grant.authContext.secretRef, revision: grant.authContext.secretRevision }) : undefined;
}
export function assertGrantAuthBinding(config, grant) {
  if (!grant) return;
  if (config.authMode === 'public' ? grant.version !== 1
    : grant.version !== 2 || grant.authContext?.mode !== 'confidential'
      || grant.authContext.method !== config.clientAuthMethod || grant.authContext.secretRef !== config.clientSecretRef) {
    throw fail('IAM_CLIENT_AUTH_CONTEXT_INVALID');
  }
}
export function assertClientAuthCurrent(operation) {
  if (operation === undefined) return true;
  const material = operations.get(operation);
  if (!material) throw fail('IAM_CLIENT_AUTH_UNVERIFIED');
  return material.assertCurrent();
}
function formComponent(value) { return new URLSearchParams([['', value]]).toString().slice(1); }
/** Pure construction over private operation material; no source I/O. */
export function buildClientAuthRequest(clientId, input, operation) {
  const material = operation === undefined ? { method: 'none', clientId } : operations.get(operation);
  if (!material) throw fail('IAM_CLIENT_AUTH_UNVERIFIED');
  if (material.clientId !== clientId) throw fail('IAM_CLIENT_AUTH_CONTEXT_INVALID');
  const form = new URLSearchParams(input);
  if (form.has('client_id') || form.has('client_secret')) throw fail('IAM_CONFIG_INVALID');
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (material.method === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${formComponent(clientId)}:${formComponent(material.secret)}`, 'utf8').toString('base64')}`;
  } else {
    form.set('client_id', clientId);
    if (material.method === 'client_secret_post') form.set('client_secret', material.secret);
  }
  return { headers, body: form.toString() };
}
