import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../src/config.mjs';
import { createIamService } from '../src/service.mjs';
import {
  ACCESS_TOKEN_TYPE,
  MAX_EXCHANGED_TTL_SECONDS,
  TOKEN_EXCHANGE_GRANT_TYPE,
  createTokenExchangeService,
} from '../src/service-token-exchange.mjs';

const TARGETS = Object.freeze({
  delegra: Object.freeze({
    endpoint: 'https://delegra.corp.example/oauth/token-exchange',
    audience: 'delegra-prod-cn-01',
    resource: 'https://delegra.corp.example/api/v1/employee',
    maxTtlSeconds: 300,
  }),
});

test('validateConfig normalizes tokenExchangeTargets and rejects invalid endpoints or TTL > 300', () => {
  const ok = validateConfig({
    tokenExchangeTargets: {
      delegra: {
        endpoint: 'https://delegra.corp.example/oauth/token-exchange',
        audience: 'delegra-prod-cn-01',
        resource: 'https://delegra.corp.example/api/v1/employee/',
        maxTtlSeconds: 180,
      },
    },
  });
  assert.ok('value' in ok);
  assert.equal(ok.value.tokenExchangeTargets.delegra.resource, 'https://delegra.corp.example/api/v1/employee');
  assert.equal(ok.value.tokenExchangeTargets.delegra.maxTtlSeconds, 180);

  const badTtl = validateConfig({
    tokenExchangeTargets: {
      delegra: {
        endpoint: 'https://delegra.corp.example/oauth/token-exchange',
        audience: 'delegra-prod-cn-01',
        resource: 'https://delegra.corp.example/api/v1/employee',
        maxTtlSeconds: 301,
      },
    },
  });
  assert.ok('issues' in badTtl);
  assert.ok(badTtl.issues.some((i) => i.path.includes('tokenExchangeTargets.delegra.maxTtlSeconds')));

  const badUrl = validateConfig({
    tokenExchangeTargets: {
      delegra: {
        endpoint: 'not-a-url',
        audience: 'delegra-prod-cn-01',
        resource: 'ftp://invalid.example',
      },
    },
  });
  assert.ok('issues' in badUrl);
});

test('RFC 8693 exchange sends spec parameters, returns opaque handle with zero token leak, and enforces single-use scoped fetch', async () => {
  const nowMs = 1_700_000_000_000;
  const requests = [];
  const subjectToken = 'iam-subject-secret-token-xyz';
  const exchangedToken = 'delegra-exchanged-secret-token-abc';

  const svc = createTokenExchangeService({
    targets: TARGETS,
    now: () => nowMs,
    getSessionRef: () => ({
      issuer: 'https://iam.corp.example',
      subject: 'emp-10086',
      epoch: '1:0:sess-1:1',
      accessExpiresAt: nowMs + 600_000,
    }),
    resolveSubjectToken: async () => ({ accessToken: subjectToken }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url === TARGETS.delegra.endpoint) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: exchangedToken,
              token_type: 'Bearer',
              expires_in: 120,
              issued_token_type: ACCESS_TOKEN_TYPE,
              scope: 'experts:read',
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() { return { items: [] }; },
      };
    },
  });

  const handle = await svc.exchange({ target: 'delegra', scope: 'experts:read' });

  // Verify RFC 8693 form body sent to pinned endpoint.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, TARGETS.delegra.endpoint);
  assert.equal(requests[0].init.method, 'POST');
  const form = new URLSearchParams(requests[0].init.body);
  assert.equal(form.get('grant_type'), TOKEN_EXCHANGE_GRANT_TYPE);
  assert.equal(form.get('subject_token'), subjectToken);
  assert.equal(form.get('subject_token_type'), ACCESS_TOKEN_TYPE);
  assert.equal(form.get('audience'), 'delegra-prod-cn-01');
  assert.equal(form.get('resource'), 'https://delegra.corp.example/api/v1/employee');
  assert.equal(form.get('scope'), 'experts:read');

  // Opaque handle must expose zero raw token bytes through JSON or properties.
  const serialized = JSON.stringify(handle);
  assert.ok(!serialized.includes(subjectToken));
  assert.ok(!serialized.includes(exchangedToken));
  assert.equal(handle.isValid(), true);
  assert.equal(handle.expiresAt, nowMs + 120_000);
  assert.equal(svc.activeHandleCount(), 1);

  // Scoped fetch injects Bearer token, strips caller Authorization, and consumes single-use handle.
  const downstream = await handle.fetch('/experts?view=callable', {
    headers: { authorization: 'Bearer attacker-header' },
  });
  assert.equal(downstream.status, 200);
  assert.equal(requests[1].url, 'https://delegra.corp.example/api/v1/employee/experts?view=callable');
  assert.equal(requests[1].init.headers.get('authorization'), `Bearer ${exchangedToken}`);
  assert.equal(handle.isValid(), false);
  assert.equal(svc.activeHandleCount(), 0);

  // Second fetch on single-use handle must fail closed.
  await assert.rejects(
    () => handle.fetch('/experts?view=callable'),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_REJECTED',
  );
});

test('expires_in is strictly clamped to min(300s, IAM remaining TTL) and expires deterministically', async () => {
  let nowMs = 1_700_000_000_000;
  let iamRemainingMs = 600_000;

  const svc = createTokenExchangeService({
    targets: TARGETS,
    now: () => nowMs,
    getSessionRef: () => ({
      issuer: 'https://iam.corp.example',
      subject: 'emp-10086',
      epoch: '1:0:sess-1:1',
      accessExpiresAt: nowMs + iamRemainingMs,
    }),
    resolveSubjectToken: async () => 'iam-subject-token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { access_token: 'exchanged-1', token_type: 'Bearer', expires_in: 3600 };
      },
    }),
  });

  // Upstream claims 3600s -> clamped to MAX_EXCHANGED_TTL_SECONDS (300s).
  const h1 = await svc.exchange({ target: 'delegra' });
  assert.equal(h1.expiresAt, nowMs + MAX_EXCHANGED_TTL_SECONDS * 1000);
  h1.dispose();
  assert.equal(h1.isValid(), false);

  // IAM remaining TTL is 90s -> clamped to 90s (never extends beyond IAM token).
  iamRemainingMs = 90_000;
  const h2 = await svc.exchange({ target: 'delegra' });
  assert.equal(h2.expiresAt, nowMs + 90_000);

  nowMs += 90_000;
  assert.equal(h2.isValid(), false);
  await assert.rejects(
    () => h2.fetch('/experts'),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_REJECTED',
  );
});

test('scoped fetch rejects cross-origin and out-of-resource-root URLs without invoking transport', async () => {
  const nowMs = 1_700_000_000_000;
  let outboundCalls = 0;

  const svc = createTokenExchangeService({
    targets: TARGETS,
    now: () => nowMs,
    getSessionRef: () => ({
      issuer: 'https://iam.corp.example',
      subject: 'emp-10086',
      epoch: '1:0:sess-1:1',
      accessExpiresAt: nowMs + 300_000,
    }),
    resolveSubjectToken: async () => 'iam-subject-token',
    fetchImpl: async (url) => {
      if (url === TARGETS.delegra.endpoint) {
        return {
          ok: true,
          status: 200,
          async json() { return { access_token: 'exchanged-2', token_type: 'Bearer', expires_in: 60 }; },
        };
      }
      outboundCalls += 1;
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });

  const handle = await svc.exchange({ target: 'delegra' });
  await assert.rejects(
    () => handle.fetch('https://evil.example/api/v1/employee/experts'),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_INVALID',
  );
  await assert.rejects(
    () => handle.fetch('https://delegra.corp.example/api/v1/admin/secrets'),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_INVALID',
  );
  assert.equal(outboundCalls, 0);
  handle.dispose();
});

test('session epoch change invalidates both in-flight exchange and already-issued handles', async () => {
  const nowMs = 1_700_000_000_000;
  let epoch = '1:0:sess-1:1';
  let releaseExchange;

  const svc = createTokenExchangeService({
    targets: TARGETS,
    now: () => nowMs,
    getSessionRef: () => (epoch
      ? { issuer: 'https://iam.corp.example', subject: 'emp-10086', epoch, accessExpiresAt: nowMs + 300_000 }
      : null),
    resolveSubjectToken: async () => 'iam-subject-token',
    fetchImpl: async () => {
      if (releaseExchange === 'wait') {
        await new Promise((resolve) => { releaseExchange = resolve; });
      }
      return {
        ok: true,
        status: 200,
        async json() { return { access_token: 'exchanged-3', token_type: 'Bearer', expires_in: 120 }; },
      };
    },
  });

  // Handle issued before sign-out becomes invalid immediately when session ends.
  const handle = await svc.exchange({ target: 'delegra' });
  assert.equal(handle.isValid(), true);
  epoch = null;
  assert.equal(handle.isValid(), false);
  await assert.rejects(
    () => handle.fetch('/experts'),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_REJECTED',
  );

  // Session ending while exchange is in-flight must discard response and reject.
  epoch = '2:0:sess-2:1';
  releaseExchange = 'wait';
  const inflight = svc.exchange({ target: 'delegra' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  epoch = '3:0:sess-3:1';
  releaseExchange();
  await assert.rejects(
    () => inflight,
    (err) => err.code === 'IAM_NOT_SIGNED_IN',
  );
  assert.equal(svc.activeHandleCount(), 0);
});

test('fail-closed errors redact secrets and createIamService exposes exchangeAudienceCredential', async () => {
  const nowMs = 1_700_000_000_000;
  const secret = 'iam-super-secret-subject-token';

  const svc = createTokenExchangeService({
    targets: TARGETS,
    now: () => nowMs,
    getSessionRef: () => ({
      issuer: 'https://iam.corp.example',
      subject: 'emp-10086',
      epoch: '1:0:sess-1:1',
      accessExpiresAt: nowMs + 300_000,
    }),
    resolveSubjectToken: async () => secret,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async json() { return { error: 'access_denied', token_echo: secret }; },
    }),
  });

  await assert.rejects(
    () => svc.exchange({ target: 'unknown-target' }),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_UNCONFIGURED',
  );

  await assert.rejects(
    () => svc.exchange({ target: 'delegra' }),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_REJECTED' && !String(err.message).includes(secret),
  );

  const iam = createIamService({
    tokenExchangeTargets: {
      delegra: TARGETS.delegra,
    },
  });
  assert.equal(iam.listTokenExchangeTargets().length, 1);
  assert.equal(iam.listTokenExchangeTargets()[0].id, 'delegra');
  await assert.rejects(
    () => iam.exchangeAudienceCredential({ target: 'delegra' }),
    (err) => err.code === 'IAM_NOT_SIGNED_IN',
  );
  await iam.dispose();
});
