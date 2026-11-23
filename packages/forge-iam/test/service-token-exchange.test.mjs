import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../src/config.mjs';
import { failureCode } from '../src/gateway-failure.mjs';
import { createIamService } from '../src/service.mjs';
import { createGrantStore } from '../src/store.mjs';
import { MemoryCredentials } from './support/memory-credentials.mjs';
import {
  ACCESS_TOKEN_TYPE,
  MAX_ACTIVE_HANDLES,
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

const IAM_CONFIG = Object.freeze({
  issuer: 'https://iam.corp.example',
  authorizationEndpoint: 'https://iam.corp.example/authorize',
  tokenEndpoint: 'https://iam.corp.example/token',
  jwksUri: 'https://iam.corp.example/jwks',
  clientId: 'dsh-desktop',
  gatewayResource: 'https://gateway.corp.example',
  redirectUri: 'http://127.0.0.1:9/iam/callback',
  tokenExchangeTargets: {
    delegra: TARGETS.delegra,
  },
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

  const plainScheme = 'http://';
  const cleartextRemote = validateConfig({
    tokenExchangeTargets: {
      delegra: {
        endpoint: `${plainScheme}delegra.corp.example/oauth/token-exchange`,
        audience: 'delegra-prod-cn-01',
        resource: `${plainScheme}delegra.corp.example/api/v1/employee`,
      },
    },
  });
  assert.ok('issues' in cleartextRemote);
  assert.ok(cleartextRemote.issues.some((i) => i.path.includes('tokenExchangeTargets.delegra.endpoint')));
  assert.ok(cleartextRemote.issues.some((i) => i.path.includes('tokenExchangeTargets.delegra.resource')));

  const loopbackHttp = validateConfig({
    tokenExchangeTargets: {
      local: {
        endpoint: `${plainScheme}127.0.0.1:8080/oauth/token-exchange`,
        audience: 'delegra-local',
        resource: `${plainScheme}localhost:8080/api/v1/employee`,
      },
      ipv6: {
        endpoint: `${plainScheme}[::1]:8080/oauth/token-exchange`,
        audience: 'delegra-local-v6',
        resource: `${plainScheme}[::1]:8080/api/v1/employee`,
      },
    },
  });
  assert.ok('value' in loopbackHttp);

  const longAudience = validateConfig({
    tokenExchangeTargets: {
      delegra: {
        endpoint: 'https://delegra.corp.example/oauth/token-exchange',
        audience: 'a'.repeat(256),
        resource: 'https://delegra.corp.example/api/v1/employee',
      },
    },
  });
  assert.ok('issues' in longAudience);
  assert.ok(longAudience.issues.some((i) => i.path.includes('tokenExchangeTargets.delegra.audience')));
});

test('RFC 8693 exchange sends spec parameters with redirect:error, returns opaque handle with zero token leak, and enforces single-use scoped fetch with redirect:manual', async () => {
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
      epoch: '1:0:sess-1',
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

  // Passing singleUse: false must still enforce single-use consumption.
  const handle = await svc.exchange({ target: 'delegra', scope: 'experts:read', singleUse: false });

  // Verify RFC 8693 form body and redirect:'error' sent to pinned endpoint.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, TARGETS.delegra.endpoint);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'error');
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

  // Scoped fetch injects Bearer token, strips caller credential headers, disables auto-redirect, and consumes single-use handle.
  const downstream = await handle.fetch('/experts?view=callable', {
    headers: {
      authorization: 'Bearer attacker-header',
      cookie: 'session=attacker',
      'proxy-authorization': 'Basic attacker',
    },
  });
  assert.equal(downstream.status, 200);
  assert.equal(requests[1].url, 'https://delegra.corp.example/api/v1/employee/experts?view=callable');
  assert.equal(requests[1].init.redirect, 'manual');
  assert.equal(requests[1].init.headers.get('authorization'), `Bearer ${exchangedToken}`);
  assert.equal(requests[1].init.headers.get('cookie'), null);
  assert.equal(requests[1].init.headers.get('proxy-authorization'), null);
  assert.equal(handle.isValid(), false);
  assert.equal(svc.activeHandleCount(), 0);

  // Second fetch on single-use handle must fail closed.
  await assert.rejects(
    () => handle.fetch('/experts?view=callable'),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_REJECTED',
  );
});

test('upstream expires_in exceeding limits or missing/invalid issued_token_type is rejected instead of clamped', async () => {
  let nowMs = 1_700_000_000_000;
  let iamRemainingMs = 600_000;
  let nextPayload = {
    access_token: 'exchanged-1',
    token_type: 'Bearer',
    expires_in: 3600,
    issued_token_type: ACCESS_TOKEN_TYPE,
  };

  const svc = createTokenExchangeService({
    targets: {
      delegra: { ...TARGETS.delegra, maxTtlSeconds: 180 },
    },
    now: () => nowMs,
    getSessionRef: () => ({
      issuer: 'https://iam.corp.example',
      subject: 'emp-10086',
      epoch: '1:0:sess-1',
      accessExpiresAt: nowMs + iamRemainingMs,
    }),
    resolveSubjectToken: async () => 'iam-subject-token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { return nextPayload; },
    }),
  });

  // Exceeds global 300s cap -> rejected.
  await assert.rejects(
    () => svc.exchange({ target: 'delegra' }),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_FAILED',
  );

  // Exceeds target maxTtlSeconds (180s) -> rejected.
  nextPayload = { access_token: 'exchanged-2', token_type: 'Bearer', expires_in: 240, issued_token_type: ACCESS_TOKEN_TYPE };
  await assert.rejects(
    () => svc.exchange({ target: 'delegra' }),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_FAILED',
  );

  // Exceeds IAM remaining TTL (90s) -> rejected.
  iamRemainingMs = 90_000;
  nextPayload = { access_token: 'exchanged-3', token_type: 'Bearer', expires_in: 120, issued_token_type: ACCESS_TOKEN_TYPE };
  await assert.rejects(
    () => svc.exchange({ target: 'delegra' }),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_FAILED',
  );

  // Missing issued_token_type -> rejected.
  nextPayload = { access_token: 'exchanged-4', token_type: 'Bearer', expires_in: 60 };
  await assert.rejects(
    () => svc.exchange({ target: 'delegra' }),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_FAILED',
  );

  // Non-access-token issued_token_type -> rejected.
  nextPayload = {
    access_token: 'exchanged-5',
    token_type: 'Bearer',
    expires_in: 60,
    issued_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
  };
  await assert.rejects(
    () => svc.exchange({ target: 'delegra' }),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_FAILED',
  );
  assert.equal(svc.activeHandleCount(), 0);

  // Compliant response (expires_in <= min(300, 180, 90) and access_token type) succeeds and expires deterministically.
  nextPayload = { access_token: 'exchanged-ok', token_type: 'Bearer', expires_in: 90, issued_token_type: ACCESS_TOKEN_TYPE };
  const handle = await svc.exchange({ target: 'delegra' });
  assert.equal(handle.expiresAt, nowMs + 90_000);
  assert.ok(handle.expiresAt <= nowMs + MAX_EXCHANGED_TTL_SECONDS * 1000);

  nowMs += 90_000;
  assert.equal(handle.isValid(), false);
  await assert.rejects(
    () => handle.fetch('/experts'),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_REJECTED',
  );
});

test('scoped fetch rejects cross-origin, out-of-resource-root, and percent-encoded traversal URLs without invoking transport', async () => {
  const nowMs = 1_700_000_000_000;
  let outboundCalls = 0;

  const svc = createTokenExchangeService({
    targets: TARGETS,
    now: () => nowMs,
    getSessionRef: () => ({
      issuer: 'https://iam.corp.example',
      subject: 'emp-10086',
      epoch: '1:0:sess-1',
      accessExpiresAt: nowMs + 300_000,
    }),
    resolveSubjectToken: async () => 'iam-subject-token',
    fetchImpl: async (url) => {
      if (url === TARGETS.delegra.endpoint) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: 'exchanged-2',
              token_type: 'Bearer',
              expires_in: 60,
              issued_token_type: ACCESS_TOKEN_TYPE,
            };
          },
        };
      }
      outboundCalls += 1;
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });

  const handle = await svc.exchange({ target: 'delegra' });
  for (const bad of [
    'https://evil.example/api/v1/employee/experts',
    'https://delegra.corp.example/api/v1/admin/secrets',
    '/foo/%2e%2e/%2e%2e/admin',
    '/%2e%2e/admin',
    '/%ZZ',
  ]) {
    await assert.rejects(
      () => handle.fetch(bad),
      (err) => err.code === 'IAM_TOKEN_EXCHANGE_INVALID',
      `expected IAM_TOKEN_EXCHANGE_INVALID for ${bad}`,
    );
  }
  assert.equal(outboundCalls, 0);
  handle.dispose();
});

test('session epoch change invalidates handles, in-flight fetch, and in-flight response.json() parsing', async () => {
  const nowMs = 1_700_000_000_000;
  let epoch = '1:0:sess-1';
  let releaseExchange;
  let releaseJson;

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
        async json() {
          if (releaseJson === 'wait') {
            await new Promise((resolve) => { releaseJson = resolve; });
          }
          return {
            access_token: 'exchanged-3',
            token_type: 'Bearer',
            expires_in: 120,
            issued_token_type: ACCESS_TOKEN_TYPE,
          };
        },
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

  // Session ending while fetch is in-flight must discard response and reject.
  epoch = '2:0:sess-2';
  releaseExchange = 'wait';
  const inflight = svc.exchange({ target: 'delegra' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  epoch = '3:0:sess-3';
  releaseExchange();
  await assert.rejects(
    () => inflight,
    (err) => err.code === 'IAM_NOT_SIGNED_IN',
  );
  assert.equal(svc.activeHandleCount(), 0);

  // Session changing while response.json() is pending must also reject without storing token.
  epoch = '4:0:sess-4';
  releaseExchange = null;
  releaseJson = 'wait';
  const inflightBody = svc.exchange({ target: 'delegra' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  epoch = '4:0:sess-5';
  releaseJson();
  await assert.rejects(
    () => inflightBody,
    (err) => err.code === 'IAM_NOT_SIGNED_IN',
  );
  assert.equal(svc.activeHandleCount(), 0);
});

test('signed-in createIamService restores ISO accessExpiresAt grant, enforces single-use via public API, and invalidates handle on cross-host sessionInstanceId re-login', async () => {
  const fixedNow = Date.parse('2030-01-01T00:00:00.000Z');
  const credentials = new MemoryCredentials();
  const store = createGrantStore(credentials);
  await store.write({
    version: 1,
    sessionInstanceId: Buffer.alloc(32, 1).toString('base64url'),
    issuer: IAM_CONFIG.issuer,
    subject: 'emp-10086',
    clientId: IAM_CONFIG.clientId,
    refreshToken: 'refresh-1',
    accessToken: 'iam-access-token-1',
    accessExpiresAt: '2030-01-01T00:10:00.000Z',
    obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid',
    resource: IAM_CONFIG.gatewayResource,
  });

  const calls = [];
  const iam = createIamService(IAM_CONFIG, {
    credentials,
    now: () => fixedNow,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === TARGETS.delegra.endpoint) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: 'delegra-exchanged-1',
              token_type: 'Bearer',
              expires_in: 120,
              issued_token_type: ACCESS_TOKEN_TYPE,
              scope: 'experts:read',
            };
          },
        };
      }
      return { ok: true, status: 200, async json() { return { items: [] }; } };
    },
  });

  const view = await iam.hydrate();
  assert.equal(view.state, 'ready');

  // Public entry point must succeed with hydrated ISO accessExpiresAt and ignore singleUse: false.
  const h1 = await iam.exchangeAudienceCredential({ target: 'delegra', singleUse: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TARGETS.delegra.endpoint);
  assert.equal(h1.isValid(), true);

  const res = await h1.fetch('/experts');
  assert.equal(res.status, 200);
  assert.equal(h1.isValid(), false);
  await assert.rejects(
    () => h1.fetch('/experts'),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_REJECTED',
  );

  // Issue a fresh handle, then simulate another Host re-logging in as the same
  // (issuer, subject) with a new sessionInstanceId and adopting it via syncFromStore().
  const h2 = await iam.exchangeAudienceCredential({ target: 'delegra' });
  assert.equal(h2.isValid(), true);

  await store.write({
    version: 1,
    sessionInstanceId: Buffer.alloc(32, 2).toString('base64url'),
    issuer: IAM_CONFIG.issuer,
    subject: 'emp-10086',
    clientId: IAM_CONFIG.clientId,
    refreshToken: 'refresh-2',
    accessToken: 'iam-access-token-2',
    accessExpiresAt: '2030-01-01T00:10:00.000Z',
    obtainedAt: '2030-01-01T00:00:00.000Z',
    scope: 'openid',
    resource: IAM_CONFIG.gatewayResource,
  });
  await iam.syncFromStore();

  assert.equal(h2.isValid(), false);
  await assert.rejects(
    () => h2.fetch('/experts'),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_REJECTED',
  );

  await iam.dispose();
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
      epoch: '1:0:sess-1',
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

  assert.equal(failureCode({ code: 'IAM_TOKEN_EXCHANGE_INVALID' }), 'ENTERPRISE_REQUEST_UNSUPPORTED');
});

test('activeHandles enforces MAX_ACTIVE_HANDLES cap and recovers after dispose', async () => {
  const nowMs = 1_700_000_000_000;
  let seq = 0;

  const svc = createTokenExchangeService({
    targets: TARGETS,
    now: () => nowMs,
    getSessionRef: () => ({
      issuer: 'https://iam.corp.example',
      subject: 'emp-10086',
      epoch: '1:0:sess-1',
      accessExpiresAt: nowMs + 600_000,
    }),
    resolveSubjectToken: async () => 'iam-subject-token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        seq += 1;
        return {
          access_token: `exchanged-${seq}`,
          token_type: 'Bearer',
          expires_in: 120,
          issued_token_type: ACCESS_TOKEN_TYPE,
        };
      },
    }),
  });

  const handles = [];
  for (let i = 0; i < MAX_ACTIVE_HANDLES; i += 1) {
    handles.push(await svc.exchange({ target: 'delegra' }));
  }
  assert.equal(svc.activeHandleCount(), MAX_ACTIVE_HANDLES);

  await assert.rejects(
    () => svc.exchange({ target: 'delegra' }),
    (err) => err.code === 'IAM_TOKEN_EXCHANGE_FAILED',
  );

  handles[0].dispose();
  assert.equal(svc.activeHandleCount(), MAX_ACTIVE_HANDLES - 1);
  const replacement = await svc.exchange({ target: 'delegra' });
  assert.equal(replacement.isValid(), true);
  svc.revokeAll();
  assert.equal(svc.activeHandleCount(), 0);
});
