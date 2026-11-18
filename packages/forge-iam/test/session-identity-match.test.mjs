// The UserInfo display projection is bound to the session that produced it
// (issue #160). That binding must be decided by the session identity alone.
//
// `grantIdentity` also carries protocol-level fields (version, resource,
// authContext). Two observations of one session may legitimately disagree on
// those — the same reason the grant comparison elsewhere drops the refresh
// marker before comparing. A grant that changes shape must therefore not
// silently drop a projection the user is still entitled to see: a silent drop
// shows up as a display bug with no error to trace.
//
// Each case below is written so that comparing the whole identity instead of
// the session quartet turns it red, per AGENTS.md §5 ("判据必须会失败").

import test from 'node:test';
import assert from 'node:assert/strict';
import { sameSessionIdentity } from '../src/session-identity.mjs';

const SESSION = Object.freeze({
  version: 1,
  issuer: 'https://iam.corp.example/oidc',
  clientId: 'client-id',
  resource: 'uag-gateway',
  subject: '000001',
  obtainedAt: '2026-11-13T08:00:00.000Z',
  sessionInstanceId: 'session-instance-id',
});

test('fields outside the session do not change the session identity', () => {
  const reshaped = {
    ...SESSION,
    version: 2,
    obtainedAt: '2026-11-13T09:30:00.000Z',
    resource: undefined,
    authContext: { mode: 'confidential', method: 'client_secret_post' },
  };
  assert.equal(sameSessionIdentity(SESSION, reshaped), true);
});

test('a different session instance is a different session', () => {
  assert.equal(sameSessionIdentity(SESSION, { ...SESSION, sessionInstanceId: 'another-session' }), false);
});

test('a different subject is a different session', () => {
  assert.equal(sameSessionIdentity(SESSION, { ...SESSION, subject: '000002' }), false);
});

test('a different issuer is a different session', () => {
  assert.equal(sameSessionIdentity(SESSION, { ...SESSION, issuer: 'https://other.corp.example/oidc' }), false);
});

test('a different client is a different session', () => {
  assert.equal(sameSessionIdentity(SESSION, { ...SESSION, clientId: 'other-client' }), false);
});

test('a record without a session instance never matches', () => {
  const anonymous = { ...SESSION, sessionInstanceId: undefined };
  assert.equal(sameSessionIdentity(SESSION, anonymous), false);
  assert.equal(sameSessionIdentity(anonymous, SESSION), false);
  assert.equal(sameSessionIdentity(anonymous, { ...anonymous }), false);
});

test('a missing or malformed identity never matches', () => {
  assert.equal(sameSessionIdentity(SESSION, undefined), false);
  assert.equal(sameSessionIdentity(undefined, SESSION), false);
  assert.equal(sameSessionIdentity(SESSION, null), false);
  assert.equal(sameSessionIdentity(SESSION, 'not-a-record'), false);
});
