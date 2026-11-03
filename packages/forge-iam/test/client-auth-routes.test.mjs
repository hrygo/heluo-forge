import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createIamRoutes } from '../src/routes.mjs';
import { GRANT_KEY } from '../src/store.mjs';
import { confidentialHarness, signIn } from './support/client-auth-service.mjs';

async function request(handler, method, path, body) {
  const req = new EventEmitter();
  req.method = method; req.url = path;
  req.headers = { 'x-forge-iam-request': '1', 'content-type': 'application/json',
    host: '127.0.0.1:4567', origin: 'http://127.0.0.1:4567', 'sec-fetch-site': 'same-origin' };
  req.destroy = () => {};
  const res = { statusCode: 0, headers: {}, headersSent: false, text: '',
    setHeader(name, value) { this.headers[name] = value; }, end(value) { this.text = value; this.headersSent = true; } };
  setImmediate(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  await handler(req, res);
  return res;
}

for (const [code, status] of [['IAM_CLIENT_AUTH_UNVERIFIED', 503], ['IAM_CLIENT_AUTH_CHANGED', 409], ['IAM_CLIENT_AUTH_CONTEXT_INVALID', 401]]) {
  test(`registered HTTP handler maps real confidential ${code} to ${status} without raw material`, async (t) => {
    const h = await confidentialHarness(t);
    let seen = 0;
    const handler = createIamRoutes(h.service, { getOrigin: () => 'http://127.0.0.1:4567', getConnection: () => ({
      requestRejection({ headers }) { seen++; assert.equal(headers['x-forge-iam-request'], '1'); return undefined; },
    }) });
    if (code === 'IAM_CLIENT_AUTH_UNVERIFIED') h.options.verifyClientSecretSource = () => false;
    else {
      await signIn(h);
      if (code === 'IAM_CLIENT_AUTH_CHANGED') h.fixture.replace();
      else {
        const grant = structuredClone(await h.record()); grant.authContext.method = 'client_secret_post';
        await h.credentials.modifyRecord(GRANT_KEY, () => ({ kind: 'grant', payload: grant }));
      }
    }
    const body = { key: `uag-${'a'.repeat(32)}` };
    const res = code === 'IAM_CLIENT_AUTH_UNVERIFIED'
      ? await request(handler, 'POST', '/api/forge-iam/sign-in')
      : await request(handler, 'PUT', '/api/forge-iam/credential', body);
    assert.equal(res.statusCode, status);
    assert.equal(JSON.parse(res.text).error.code, code);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(seen, 1);
    const component = (value) => new URLSearchParams([['', value]]).toString().slice(1);
    const secret = h.fixture.snapshot().value;
    const basic = Buffer.from(`${component(h.mock.clientId)}:${component(secret)}`).toString('base64');
    for (const privateValue of [secret, basic, body.key]) assert.equal(res.text.includes(privateValue), false);
    assert.equal(h.mock.counts.refresh, 0);
    assert.equal(h.mock.counts.revoke, 0);
    if (code === 'IAM_CLIENT_AUTH_UNVERIFIED') { assert.equal(h.fixture.counts.read, 0); assert.equal(h.mock.counts.token, 0); }
  });
}
