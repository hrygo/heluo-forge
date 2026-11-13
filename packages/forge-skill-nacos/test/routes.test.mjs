import assert from 'node:assert/strict';
import test from 'node:test';
import { registerClientRoutes, ROUTE_PREFIX } from '../src/routes.mjs';
import { REASONS } from '../src/errors.mjs';

/** 捕获 prefix 注册的 handler，直接以假 req/res 驱动。 */
function fakeWebServer() {
  const registrations = [];
  return {
    registrations,
    register(entry) {
      registrations.push(entry);
      return () => { registrations.splice(registrations.indexOf(entry), 1); };
    },
  };
}

function fakeResponse() {
  const state = { status: undefined, body: undefined };
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers; },
    end(body) { state.body = body; },
  };
}

function request(path, { method = 'GET', origin, host = '127.0.0.1:3080', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url: path,
    headers: { host, ...(origin !== undefined ? { origin } : {}) },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () => Promise.resolve(index < chunks.length
          ? { done: false, value: chunks[index += 1] - 1 === -1 ? chunks[0] : chunks[index - 1] }
          : { done: true }),
      };
    },
  };
}

function serviceStub(overrides = {}) {
  return {
    status: () => ({ endpoint: 'https://nacos.corp.example', namespaceId: 'skill-prod', catalogMode: 'console-list', cache: { count: 1, complete: true } }),
    searchCatalog: async () => ({ items: [{ name: 'demo', description: 'd', latestVersion: '1.0.0', installed: null }], total: 1, page: 1, pageSize: 20, stale: false }),
    showSkill: async (name) => ({ meta: { name }, local: null }),
    listInstalled: () => [],
    install: async (input) => ({ ok: true, txId: 't', name: input.name, version: input.ref?.version ?? '1.0.0', contentSha256: 'a'.repeat(64) }),
    disable: async (name) => ({ name, enabled: false }),
    changeScope: async (input) => ({ name: input.name, scope: { kind: input.to } }),
    ...overrides,
  };
}

function mounted(service) {
  const webServer = fakeWebServer();
  const effects = [];
  const ctx = { webServer, effect: (fn) => effects.push(fn) };
  const registered = registerClientRoutes(ctx, service);
  return { registered, webServer, effects };
}

test('routes mount only when a webServer service exists', () => {
  const without = registerClientRoutes({}, serviceStub());
  assert.equal(without, false);

  const { registered, webServer } = mounted(serviceStub());
  assert.equal(registered, true);
  assert.equal(webServer.registrations.length, 1);
  assert.equal(webServer.registrations[0].kind, 'prefix');
  assert.equal(webServer.registrations[0].path, ROUTE_PREFIX);
});

test('GET status and catalog answer through the prefix handler', async () => {
  const { webServer } = mounted(serviceStub());
  const handler = webServer.registrations[0].handler;

  const okStatus = fakeResponse();
  await handler(request(`${ROUTE_PREFIX}/status`), okStatus);
  assert.equal(okStatus.state.status, 200);
  assert.equal(JSON.parse(okStatus.state.body).result.namespaceId, 'skill-prod');

  const okCatalog = fakeResponse();
  await handler(request(`${ROUTE_PREFIX}/catalog?keyword=demo&page=1&pageSize=20`), okCatalog);
  assert.deepEqual(JSON.parse(okCatalog.state.body).result.items.map((item) => item.name), ['demo']);

  const notFound = fakeResponse();
  await handler(request(`${ROUTE_PREFIX}/nope`), notFound);
  assert.equal(notFound.state.status, 404);
});

test('cross-origin writes are rejected before reaching the service', async () => {
  let touched = false;
  const { webServer } = mounted(serviceStub({ install: async () => { touched = true; } }));
  const handler = webServer.registrations[0].handler;
  const res = fakeResponse();
  await handler(request(`${ROUTE_PREFIX}/action`, { method: 'POST', origin: 'https://evil.example', body: { op: 'install', name: 'x' } }), res);
  assert.equal(res.state.status, 403);
  assert.equal(JSON.parse(res.state.body).code, REASONS.FORBIDDEN);
  assert.equal(touched, false);
});

test('POST action forwards to the service with the same semantics', async () => {
  const calls = [];
  const { webServer } = mounted(serviceStub({
    install: async (input) => { calls.push(['install', input]); return { ok: true, name: input.name, version: '1.5.0', txId: 't1', contentSha256: 'b'.repeat(64) }; },
  }));
  const handler = webServer.registrations[0].handler;
  const res = fakeResponse();
  await handler(request(`${ROUTE_PREFIX}/action`, {
    method: 'POST', origin: 'http://127.0.0.1:3080',
    body: { op: 'install', name: 'code-review-std', version: '1.5.0', scope: 'user' },
  }), res);
  assert.equal(res.state.status, 200);
  assert.equal(JSON.parse(res.state.body).result.version, '1.5.0');
  assert.deepEqual(calls[0][1], { name: 'code-review-std', ref: { version: '1.5.0' }, scope: 'user', enable: true });
});

test('service failures map to error envelope, not crashes', async () => {
  const { webServer } = mounted(serviceStub({
    install: async () => { const error = new Error('同名冲突'); error.code = REASONS.NAME_CONFLICT; throw error; },
  }));
  const handler = webServer.registrations[0].handler;
  const res = fakeResponse();
  await handler(request(`${ROUTE_PREFIX}/action`, { method: 'POST', body: { op: 'install', name: 'x' } }), res);
  assert.equal(res.state.status, 400);
  assert.equal(JSON.parse(res.state.body).code, REASONS.NAME_CONFLICT);
});
