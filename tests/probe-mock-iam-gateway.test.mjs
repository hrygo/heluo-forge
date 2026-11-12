import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../scripts/probe/mock-iam-gateway.mjs', import.meta.url));
const CLIENT = 'test-client';
const REDIRECT = 'http://127.0.0.1:17321/iam/callback';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // 服务还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`模拟器未在 ${timeoutMs}ms 内就绪：${url}`);
}

const b64 = (value) => Buffer.from(value).toString('base64url');

test('模拟 IAM 与网关：Discovery、PKCE、ID Token 验签、模型列表与流式对话', { timeout: 30_000 }, async (t) => {
  const iamPort = await freePort();
  const gatewayPort = await freePort();
  const issuer = `http://127.0.0.1:${iamPort}`;
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, MOCK_IAM_PORT: String(iamPort), MOCK_GATEWAY_PORT: String(gatewayPort), MOCK_CLIENT_ID: CLIENT, MOCK_SUBJECT: 'E9001' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));

  const discovery = await (await waitFor(`${issuer}/.well-known/openid-configuration`)).json();
  assert.equal(discovery.issuer, issuer);
  assert.equal(discovery.token_endpoint, `${issuer}/token`);
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);

  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash('sha256').update(verifier).digest());
  const state = 'state-test';
  const nonce = 'nonce-test';
  const authUrl = new URL(discovery.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'openid profile offline_access',
  })) authUrl.searchParams.set(key, value);

  const authorize = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const location = new URL(authorize.headers.get('location'));
  assert.equal(location.searchParams.get('state'), state);
  assert.ok(location.origin.startsWith('http://127.0.0.1:17321'));
  const code = location.searchParams.get('code');
  assert.ok(code);

  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.refresh_token);

  const [header, payload, signature] = tokens.id_token.split('.');
  const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(decodedHeader.alg, 'RS256');
  assert.equal(claims.iss, issuer);
  assert.equal(claims.aud, CLIENT);
  assert.equal(claims.sub, 'E9001');
  assert.equal(claims.nonce, nonce);
  const jwks = await (await fetch(discovery.jwks_uri)).json();
  const jwk = jwks.keys.find((key) => key.kid === decodedHeader.kid);
  assert.ok(jwk, 'JWKS 应包含签名 key');
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  assert.ok(verifySignature('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));

  const gateway = `http://127.0.0.1:${gatewayPort}/v1`;
  const models = await fetch(`${gateway}/models`, { headers: { authorization: 'Bearer test-key', 'x-iam-token': tokens.access_token } });
  assert.equal(models.status, 200);
  assert.ok((await models.json()).data.some((model) => model.id === 'mock-chat-1'));

  const chat = await fetch(`${gateway}/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'x-iam-token': tokens.access_token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-chat-1', stream: true, messages: [{ role: 'user', content: 'ping' }] }),
  });
  assert.equal(chat.status, 200);
  const reader = chat.body.getReader();
  const { value } = await reader.read();
  const firstChunk = new TextDecoder().decode(value);
  assert.match(firstChunk, /chat\.completion\.chunk/u);
  await reader.cancel();

  const refreshed = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT }),
  });
  assert.equal(refreshed.status, 200);
  assert.notEqual((await refreshed.json()).refresh_token, tokens.refresh_token);
});
