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

test('a matching document is accepted without returning configuration values', async () => {
  const { fetchImpl, calls } = stub(DOCUMENT);
  const result = await verifyDiscovery(BASE, { fetchImpl });
  assert.equal(result.checked, true);
  assert.equal(result.revocationEndpoint, 'missing');
  assert.equal(JSON.stringify(result).includes('iam.example.test'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
});

test('issuer trailing slash must match the runtime exactly', async () => {
  const { fetchImpl } = stub({ ...DOCUMENT, issuer: 'https://iam.example.test/' });
  const error = await rejected(verifyDiscovery(BASE, { fetchImpl }));
  assert.equal(error.code, 'DISCOVERY_ISSUER_MISMATCH');
  assert.equal(error.message.includes('iam.example.test'), false);
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
  assert.equal(error.message.includes('iam.example.test'), false);
});

test('revocation source is reported without exposing its address', async () => {
  const revocation = 'https://iam.example.test/private-revoke';
  const discovered = await verifyDiscovery(BASE, { fetchImpl: stub({ ...DOCUMENT, revocation_endpoint: revocation }).fetchImpl });
  assert.equal(discovered.revocationEndpoint, 'discovered');
  assert.equal(JSON.stringify(discovered).includes(revocation), false);
  const explicit = await verifyDiscovery({ ...BASE, revocationEndpoint: revocation }, { fetchImpl: stub(DOCUMENT).fetchImpl });
  assert.equal(explicit.revocationEndpoint, 'configured');
  const invalid = await rejected(verifyDiscovery(BASE, { fetchImpl: stub({ ...DOCUMENT, revocation_endpoint: 'ftp://sensitive.example.test/revoke' }).fetchImpl }));
  assert.equal(invalid.code, 'DISCOVERY_INVALID');
  assert.equal(invalid.message.includes('sensitive.example.test'), false);
});

test('optional discovered endpoints must be valid when the runtime would consume them', async () => {
  for (const key of ['end_session_endpoint', 'userinfo_endpoint']) {
    const error = await rejected(verifyDiscovery(BASE, { fetchImpl: stub({ ...DOCUMENT, [key]: 'ftp://sensitive.example.test/endpoint' }).fetchImpl }));
    assert.equal(error.code, 'DISCOVERY_INVALID');
    assert.equal(error.message.includes('sensitive.example.test'), false);
  }
  const configured = await verifyDiscovery({ ...BASE, userInfoEndpoint: 'https://iam.example.test/userinfo' }, {
    fetchImpl: stub({ ...DOCUMENT, userinfo_endpoint: 'ftp://sensitive.example.test/ignored' }).fetchImpl,
  });
  assert.equal(configured.checked, true);
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
  const certificateError = await rejected(verifyDiscovery(BASE, {
    fetchImpl: async () => { throw Object.assign(new Error('private certificate detail'), { cause: { code: 'CERT_HAS_EXPIRED' } }); },
  }));
  assert.match(certificateError.message, /CERT_HAS_EXPIRED/u);
  assert.doesNotMatch(certificateError.message, /private certificate detail/u);
});

test('network failures and invalid endpoint values do not expose supplied URLs or messages', async () => {
  const marker = 'private-internal-address.example.test';
  const networkError = await rejected(verifyDiscovery(BASE, {
    fetchImpl: async () => { throw Object.assign(new Error(marker), { cause: { code: marker } }); },
  }));
  assert.equal(networkError.code, 'DISCOVERY_UNREACHABLE');
  assert.equal(networkError.message.includes(marker), false);
  const endpointError = await rejected(verifyDiscovery(BASE, {
    fetchImpl: stub({ ...DOCUMENT, token_endpoint: `ftp://${marker}/token` }).fetchImpl,
  }));
  assert.equal(endpointError.code, 'DISCOVERY_INVALID');
  assert.equal(endpointError.message.includes(marker), false);
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
