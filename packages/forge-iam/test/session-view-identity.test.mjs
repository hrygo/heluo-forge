// Regression for the sessionView identity contract (issue #160 after the #260
// merge): the UserInfo display projection is a Host-only field.
//
// `sessionView()` is shared by the Host service and the offline CLI. The Host
// passes the projected identity; the CLI reads a stored grant record, which
// carries no profile, so it must never gain one. This locks that boundary so a
// later refactor cannot widen PII into the CLI output by accident.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionView } from '../src/session-read.mjs';
import { sessionFromRecord } from '../src/cli-session.mjs';

const IDENTITY = Object.freeze({
  user_id: '000001',
  user_name: '张三',
  work_no: 'zhangsan',
});

test('the Host session view carries the projected identity', () => {
  const view = sessionView(
    { issuer: 'https://iam.corp.example/oidc', subject: '000001', signedIn: true },
    'ready',
    IDENTITY,
  );
  assert.deepEqual(view.identity, IDENTITY);
});

test('the session view omits identity when no profile is supplied', () => {
  const view = sessionView(
    { issuer: 'https://iam.corp.example/oidc', subject: '000001', signedIn: true },
    'ready',
  );
  assert.equal('identity' in view, false);
});

test('the offline CLI session never carries the identity projection', () => {
  const now = Date.now();
  const record = {
    kind: 'grant',
    payload: {
      version: 1,
      issuer: 'https://iam.corp.example/oidc',
      subject: '000001',
      clientId: 'client-id',
      refreshToken: 'refresh-token-value',
      scope: 'openid profile',
      obtainedAt: new Date(now).toISOString(),
      sessionInstanceId: Buffer.alloc(32, 7).toString('base64url'),
      accessToken: 'access-token-value',
      accessExpiresAt: new Date(now + 3_600_000).toISOString(),
    },
  };
  const view = sessionFromRecord(record);
  assert.equal(view.status, 'ready');
  assert.equal('identity' in view, false);
  assert.equal(JSON.stringify(view).includes('张三'), false);
});
