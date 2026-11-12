import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_CODES, LAYER_CODES, SELF_CODES, UNREACHABLE_SYSCALLS, USER_CODE_BY_INTERNAL, USER_FACING_CODES, classifyFailure, failureCode, gatewayCode, squash, statusOf } from '../src/gateway-failure.mjs';
import { ERROR_STATUS } from '../src/error-contract.mjs';
import { MESSAGES } from '../src/managed-models.mjs';

// The tables are the compatibility surface. These invariants keep them honest:
// a key that can never match, or a value that is not a registered code, would
// silently reintroduce the misreporting this module exists to prevent.

test('every table key is already squashed, so lookup can reach it', () => {
  for (const key of [...Object.keys(LAYER_CODES), ...Object.keys(BODY_CODES)]) {
    assert.equal(squash(key), key, `${key} must be stored in its lookup form`);
    assert.notEqual(key, '');
  }
});

test('every mapped code is a registered message', () => {
  for (const [key, code] of [...Object.entries(LAYER_CODES), ...Object.entries(BODY_CODES)]) {
    assert.ok(Object.hasOwn(MESSAGES, code), `${key} -> ${code}`);
  }
  for (const code of SELF_CODES) assert.ok(Object.hasOwn(MESSAGES, code), code);
});

test('every layer vocabulary reaches its code through a failure', () => {
  for (const [key, code] of Object.entries(LAYER_CODES)) {
    assert.equal(classifyFailure({ code: key }), code, key);
    // The model layer emits camelCase as well: FreeUsageLimitError, RateLimitError.
    assert.equal(classifyFailure({ code: key.toUpperCase() }), code, key);
  }
});

test('every body vocabulary reaches its code through a response body', () => {
  for (const [key, code] of Object.entries(BODY_CODES)) {
    assert.equal(classifyFailure({ responseBody: JSON.stringify({ error: { code: key } }) }), code, key);
    assert.equal(classifyFailure({ responseBody: JSON.stringify({ error: { type: key } }) }), code, key);
    assert.equal(classifyFailure({ message: `429: ${JSON.stringify({ code: key })}` }), code, key);
  }
});

test('a self code passes through untouched', () => {
  for (const code of SELF_CODES) assert.equal(classifyFailure({ code }), code);
});

test('an RFC 9457 type is matched on its last segment', () => {
  assert.equal(classifyFailure({ responseBody: '{"type":"https://errors.example.test/prob/quota-exceeded"}' }), 'ENTERPRISE_GATEWAY_QUOTA_EXHAUSTED');
});

test('statuses map the way the HTTP semantics say', () => {
  for (const [status, code] of [[400, 'ENTERPRISE_GATEWAY_REQUEST_REJECTED'], [401, 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED'], [403, 'ENTERPRISE_GATEWAY_FORBIDDEN'], [404, 'ENTERPRISE_GATEWAY_REQUEST_REJECTED'], [429, 'ENTERPRISE_GATEWAY_RATE_LIMIT'], [500, 'ENTERPRISE_GATEWAY_UNAVAILABLE'], [503, 'ENTERPRISE_GATEWAY_UNAVAILABLE']]) {
    assert.equal(gatewayCode(status), code, String(status));
    assert.equal(classifyFailure({ statusCode: status }), code, String(status));
  }
});

test('the status is found wherever the SDK puts it', () => {
  for (const shape of [{ status: 429 }, { statusCode: 429 }, { response: { status: 429 } }, { cause: { status: 429 } }, { cause: { statusCode: 429 } }]) {
    assert.equal(statusOf(shape), 429, JSON.stringify(shape));
  }
  assert.equal(statusOf({ status: '429' }), undefined);
});

test('a body that cannot be parsed changes nothing', () => {
  for (const responseBody of ['not json', '{"error":', '', 'x'.repeat(9000)]) {
    assert.equal(classifyFailure({ responseBody }), 'ENTERPRISE_GATEWAY_CALL_FAILED', responseBody.slice(0, 12));
  }
});

test('only socket evidence is called unreachable', () => {
  for (const syscall of UNREACHABLE_SYSCALLS) {
    assert.equal(classifyFailure({ cause: { code: syscall } }), 'ENTERPRISE_GATEWAY_UNAVAILABLE', syscall);
  }
  assert.equal(classifyFailure({ code: 'SOMETHING_NEW' }), 'ENTERPRISE_GATEWAY_CALL_FAILED');
});

test('the V2.1 vocabulary maps to distinct local codes and outranks the status', () => {
  const cases = {
    invalid_api_key: 'ENTERPRISE_GATEWAY_CREDENTIAL_REJECTED',
    invalid_iam_token: 'ENTERPRISE_GATEWAY_IAM_TOKEN_REJECTED',
    credential_revoked: 'ENTERPRISE_GATEWAY_CREDENTIAL_REVOKED',
    credential_suspended: 'ENTERPRISE_GATEWAY_CREDENTIAL_SUSPENDED',
    iam_token_mismatch: 'ENTERPRISE_GATEWAY_IDENTITY_MISMATCH',
    model_not_allowed: 'ENTERPRISE_MODEL_NOT_ALLOWED',
    client_not_recognized: 'ENTERPRISE_GATEWAY_CLIENT_NOT_RECOGNIZED',
    budget_exhausted: 'ENTERPRISE_GATEWAY_BUDGET_EXHAUSTED',
    rpm_limit_exceeded: 'ENTERPRISE_GATEWAY_RATE_LIMIT',
    tpm_limit_exceeded: 'ENTERPRISE_GATEWAY_RATE_LIMIT',
    gateway_overloaded: 'ENTERPRISE_GATEWAY_UNAVAILABLE',
  };
  for (const [wire, code] of Object.entries(cases)) {
    assert.equal(classifyFailure({ responseBody: JSON.stringify({ error: { code: wire } }) }), code, wire);
  }
  // The body code must win: a 401 carrying invalid_iam_token is not a bad key,
  // and a 403 carrying iam_token_mismatch is not a model permission problem.
  assert.equal(classifyFailure({ status: 401, responseBody: JSON.stringify({ error: { code: 'invalid_iam_token' } }) }), 'ENTERPRISE_GATEWAY_IAM_TOKEN_REJECTED');
  assert.equal(classifyFailure({ status: 403, responseBody: JSON.stringify({ error: { code: 'iam_token_mismatch' } }) }), 'ENTERPRISE_GATEWAY_IDENTITY_MISMATCH');
  assert.equal(classifyFailure({ status: 429, responseBody: JSON.stringify({ error: { code: 'budget_exhausted' } }) }), 'ENTERPRISE_GATEWAY_BUDGET_EXHAUSTED');
});

test('every IAM and credential code maps to a registered user code', () => {
  // Plan CORP-DSH-PLAN-018: an internal code that reaches the failure object is
  // a user-facing defect. Enumerating ERROR_STATUS keeps a new code from
  // silently inheriting ENTERPRISE_GATEWAY_CALL_FAILED.
  const internal = Object.keys(ERROR_STATUS).filter(code => /^(IAM_|CRED_)/u.test(code));
  assert.ok(internal.length > 0);
  for (const code of internal) {
    assert.ok(Object.hasOwn(USER_CODE_BY_INTERNAL, code), `${code} must map to a user code`);
    const user = USER_CODE_BY_INTERNAL[code];
    assert.ok(USER_FACING_CODES.has(user), `${code} -> ${user} must be user-facing`);
    assert.ok(Object.hasOwn(MESSAGES, user), `${code} -> ${user} must have a message`);
    assert.ok(Object.hasOwn(ERROR_STATUS, user), `${code} -> ${user} must have a status`);
    assert.equal(failureCode({ code }), user, code);
  }
});

test('a known IAM or credential code never lands on the unknown-failure bucket', () => {
  for (const code of Object.keys(ERROR_STATUS)) {
    if (!/^(IAM_|CRED_)/u.test(code)) continue;
    assert.notEqual(failureCode({ code }), 'ENTERPRISE_GATEWAY_CALL_FAILED', code);
  }
  // Only genuinely unknown evidence still falls back.
  assert.equal(failureCode({ code: 'SOMETHING_NEW' }), 'ENTERPRISE_GATEWAY_CALL_FAILED');
  assert.equal(failureCode(new Error('no evidence at all')), 'ENTERPRISE_GATEWAY_CALL_FAILED');
});

test('a user code passes through the failure mapping untouched', () => {
  for (const code of SELF_CODES) assert.equal(failureCode({ code }), code);
  for (const code of ['IAM_LOGIN_REQUIRED', 'IAM_GATEWAY_CREDENTIAL_REQUIRED', 'IAM_MODEL_CONTEXT_CHANGED', 'IAM_GATEWAY_URL_INVALID']) {
    assert.equal(failureCode({ code }), code);
  }
  assert.equal(failureCode({ code: 'IAM_GATEWAY_BINDING_CHANGED' }), 'IAM_MODEL_CONTEXT_CHANGED');
});
