import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_CODES, LAYER_CODES, SELF_CODES, UNREACHABLE_SYSCALLS, classifyFailure, gatewayCode, squash, statusOf } from '../src/gateway-failure.mjs';
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
