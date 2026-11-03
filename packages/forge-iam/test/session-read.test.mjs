// Step 1 of the cross-module read surface (DESIGN-002 §5.5): the session must
// carry identity and freshness for any caller, and must never carry a token.
// The assertions therefore look for the exact stored secrets, not just field
// names: a leak through a nested field would still fail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIamService } from './support/trusted-service.mjs';
import { FileCredentials } from './support/file-credentials.mjs';
import { startMockOidc } from './support/mock-oidc.mjs';
import { validateConfig } from '../src/config.mjs';

const RECORD_KEY = 'heluo-iam/session';

function configFor(mock) {
  return validateConfig({
    ...mock.endpoints,
    clientId: mock.clientId,
    gatewayResource: 'https://gateway.corp.example',
    redirectUri: 'http://127.0.0.1:4567/iam/callback',
    allowInsecureHttp: true,
    refreshSkewSeconds: 60,
    attemptTimeoutSeconds: 30,
    httpTimeoutMs: 5000,
  }).value;
}

async function signedIn(t) {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const directory = await mkdtemp(join(tmpdir(), 'forge-iam-session-'));
  const credentials = new FileCredentials(directory);
  const service = createIamService(configFor(mock), { credentials });
  const started = await service.startSignIn();
  const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  await service.handleCallback(response.headers.get('location'));
  return { service, credentials, mock };
}

test('a signed-out service reports no principal and no token', async (t) => {
  const mock = await startMockOidc();
  t.after(() => mock.close());
  const directory = await mkdtemp(join(tmpdir(), 'forge-iam-session-'));
  const service = createIamService(configFor(mock), { credentials: new FileCredentials(directory) });
  const session = service.getSession();
  assert.equal(session.status, 'signed-out');
  assert.equal(session.signedIn, false);
  assert.equal(session.principal, undefined);
  assert.equal(session.accessExpiresAt, null);
  assert.equal(session.scope, null);
  assert.doesNotMatch(JSON.stringify(session), /token|eyJ/iu);
});

test('after sign-in the session carries identity and freshness but no token', async (t) => {
  const { service, credentials } = await signedIn(t);
  const grant = (await credentials.readRecord(RECORD_KEY))?.payload;
  assert.equal(typeof grant?.accessToken, 'string');

  const session = service.getSession();
  assert.equal(session.status, 'ready');
  assert.equal(session.signedIn, true);
  assert.deepEqual(session.principal, { issuer: grant.issuer, subject: grant.subject });
  assert.equal(session.accessExpiresAt, grant.accessExpiresAt);
  assert.equal(session.scope, grant.scope ?? null);

  const serialized = JSON.stringify(session);
  assert.equal(serialized.includes(grant.accessToken), false);
  assert.equal(serialized.includes(grant.refreshToken), false);
  assert.doesNotMatch(serialized, /eyJ/u);
});
