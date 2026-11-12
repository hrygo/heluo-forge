import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyDiscovery } from '../scripts/lib/private-bundle.mjs';

const BASE = {
  discoveryUrl: 'https://iam.example.test/.well-known/openid-configuration',
  issuer: 'https://iam.example.test',
  clientId: 'DSH',
  allowInsecureHttp: false,
};

const DOCUMENT = {
  issuer: 'https://iam.example.test',
  authorization_endpoint: 'https://iam.example.test/authorize',
  token_endpoint: 'https://iam.example.test/token',
  jwks_uri: 'https://iam.example.test/jwks',
};

function stub(body, { status = 200, json } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: json ?? (async () => body),
    };
  };
  return { fetchImpl, calls };
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the check to reject');
}

test('no discovery URL means nothing to check', async () => {
  const result = await verifyDiscovery({ ...BASE, discoveryUrl: undefined }, { fetchImpl: () => assert.fail('must not fetch') });
  assert.deepEqual(result, { checked: false, reason: 'no-discovery-url' });
});

test('a matching document is accepted and returns the endpoints', async () => {
  const { fetchImpl, calls } = stub(DOCUMENT);
  const result = await verifyDiscovery(BASE, { fetchImpl });
  assert.equal(result.checked, true);
  assert.equal(result.issuer, DOCUMENT.issuer);
  assert.deepEqual(result.endpoints, {
    authorization_endpoint: DOCUMENT.authorization_endpoint,
    token_endpoint: DOCUMENT.token_endpoint,
    jwks_uri: DOCUMENT.jwks_uri,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
});

test('trailing slashes on issuer are normalized', async () => {
  const { fetchImpl } = stub({ ...DOCUMENT, issuer: 'https://iam.example.test/' });
  const result = await verifyDiscovery(BASE, { fetchImpl });
  assert.equal(result.checked, true);
});

test('an issuer mismatch is rejected', async () => {
  const { fetchImpl } = stub({ ...DOCUMENT, issuer: 'https://other.example.test' });
  const error = await rejected(verifyDiscovery(BASE, { fetchImpl }));
  assert.equal(error.code, 'DISCOVERY_ISSUER_MISMATCH');
});

test('a non-2xx response is rejected', async () => {
  const { fetchImpl } = stub({}, { status: 503 });
  const error = await rejected(verifyDiscovery(BASE, { fetchImpl }));
  assert.equal(error.code, 'DISCOVERY_HTTP');
});

test('a non-JSON response is rejected', async () => {
  const { fetchImpl } = stub(null, { json: async () => { throw new Error('bad json'); } });
  const error = await rejected(verifyDiscovery(BASE, { fetchImpl }));
  assert.equal(error.code, 'DISCOVERY_INVALID');
});

test('a document missing jwks_uri is rejected', async () => {
  const { fetchImpl } = stub({ ...DOCUMENT, jwks_uri: undefined });
  const error = await rejected(verifyDiscovery(BASE, { fetchImpl }));
  assert.match(error.message, /jwks_uri/u);
});

test('a configured endpoint that differs from discovery is rejected', async () => {
  const { fetchImpl } = stub(DOCUMENT);
  const error = await rejected(
    verifyDiscovery({ ...BASE, tokenEndpoint: 'https://iam.example.test/other-token' }, { fetchImpl }),
  );
  assert.equal(error.code, 'DISCOVERY_ENDPOINT_MISMATCH');
});

test('an unreachable discovery endpoint is rejected with the reason', async () => {
  const fetchImpl = async () => {
    const error = new Error('connect ECONNREFUSED');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  };
  const error = await rejected(verifyDiscovery(BASE, { fetchImpl }));
  assert.equal(error.code, 'DISCOVERY_UNREACHABLE');
  assert.match(error.message, /ECONNREFUSED/u);
});

test('plaintext endpoints are rejected unless insecure HTTP is allowed', async () => {
  const { fetchImpl } = stub({ ...DOCUMENT, jwks_uri: 'http://iam.example.test/jwks' });
  const error = await rejected(verifyDiscovery(BASE, { fetchImpl }));
  assert.equal(error.code, 'DISCOVERY_INVALID');
  const allowed = await verifyDiscovery(
    { ...BASE, allowInsecureHttp: true, issuer: 'http://iam.example.test', discoveryUrl: 'http://iam.example.test/.well-known/openid-configuration' },
    { fetchImpl: stub({ ...DOCUMENT, issuer: 'http://iam.example.test', authorization_endpoint: 'http://iam.example.test/authorize', token_endpoint: 'http://iam.example.test/token', jwks_uri: 'http://iam.example.test/jwks' }).fetchImpl },
  );
  assert.equal(allowed.checked, true);
});
