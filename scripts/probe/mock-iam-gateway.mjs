#!/usr/bin/env node
/**
 * 独立模拟 IAM + 模型网关（本地 UAT / 目标机验证用测试资源）。
 *
 * 它只依赖 Node.js 标准库，供没有真实企业 IAM 的机器验证**已打包**的交付包：
 * 交付包仍按 issuer/gateway 打包，这里只在本机复现同样的地址与协议形态。
 * 不是企业服务，不校验真实主体，也不产生真实令牌；不要暴露到共享网络。
 *
 *   node scripts/probe/mock-iam-gateway.mjs
 *
 * 环境变量：
 *   MOCK_IAM_PORT     默认 5599（issuer 固定为 http://127.0.0.1:<port>）
 *   MOCK_GATEWAY_PORT 默认 5600（网关根路径 /v1）
 *   MOCK_CLIENT_ID    默认 heluo-local-uat
 *   MOCK_SUBJECT      默认 E1001
 *
 * 能力：Discovery、授权码 + PKCE S256、RS256 ID Token 与 JWKS、刷新轮换、撤销
 * （POST 表单与 D1 的 GET ?access_token= 两种），以及 /v1/models、流式对话。
 */

import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const IAM_PORT = Number(process.env.MOCK_IAM_PORT ?? 5599);
const GW_PORT = Number(process.env.MOCK_GATEWAY_PORT ?? 5600);
const ISSUER = `http://127.0.0.1:${IAM_PORT}`;
const CLIENT_ID = process.env.MOCK_CLIENT_ID ?? 'heluo-local-uat';
const SUBJECT = process.env.MOCK_SUBJECT ?? 'E1001';
if (!Number.isInteger(IAM_PORT) || !Number.isInteger(GW_PORT) || IAM_PORT < 1 || GW_PORT < 1) {
  throw new Error('MOCK_IAM_PORT / MOCK_GATEWAY_PORT 必须是 1-65535 的整数');
}
const b64 = (buf) => Buffer.from(buf).toString('base64url');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-key-1', use: 'sig', alg: 'RS256' };
const codes = new Map();
const access = new Map();
const refresh = new Map();

function signJwt(payload) {
  const header = { alg: 'RS256', kid: jwk.kid, typ: 'JWT' };
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), privateKey);
  return `${input}.${b64(signature)}`;
}

function idToken({ sub, nonce, accessToken }) {
  const now = Math.floor(Date.now() / 1000);
  const digest = createHash('sha256').update(accessToken, 'ascii').digest();
  return signJwt({
    iss: ISSUER, aud: CLIENT_ID, sub, iat: now, exp: now + 3600,
    nonce, at_hash: b64(digest.subarray(0, digest.length / 2)),
  });
}

function tokenResponse({ sub, nonce }, form) {
  const at = `at-${b64(randomBytes(18))}`;
  const rt = `rt-${b64(randomBytes(18))}`;
  access.set(at, { sub, exp: Date.now() + 3600_000 });
  refresh.set(rt, { sub, nonce });
  const body = {
    access_token: at, token_type: 'Bearer', expires_in: 3600,
    refresh_token: rt, scope: form.get('scope') ?? 'openid profile offline_access',
    id_token: idToken({ sub, nonce, accessToken: at }),
  };
  return body;
}

const send = (res, status, body, type = 'application/json') => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
const readRaw = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const readForm = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
  req.on('error', reject);
});
const pkce = (verifier) => b64(createHash('sha256').update(verifier).digest());

const iam = createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  if (url.pathname === '/.well-known/openid-configuration') {
    return send(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      revocation_endpoint: `${ISSUER}/revoke`,
      end_session_endpoint: `${ISSUER}/logout`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
  }
  if (url.pathname === '/jwks') return send(res, 200, { keys: [jwk] });
  if (url.pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');
    if (!redirectUri || !state || !challenge || url.searchParams.get('client_id') !== CLIENT_ID) {
      return send(res, 400, { error: 'invalid_request' });
    }
    const code = b64(randomBytes(16));
    codes.set(code, { challenge, redirectUri, nonce: url.searchParams.get('nonce'), sub: SUBJECT });
    const location = new URL(redirectUri);
    location.searchParams.set('code', code);
    location.searchParams.set('state', state);
    res.writeHead(302, { location: location.toString() });
    return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    const form = await readForm(req);
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      const entry = codes.get(form.get('code'));
      if (!entry) return send(res, 400, { error: 'invalid_grant' });
      if (form.get('client_id') !== CLIENT_ID) return send(res, 400, { error: 'invalid_client' });
      if (pkce(form.get('code_verifier') ?? '') !== entry.challenge) return send(res, 400, { error: 'invalid_grant' });
      codes.delete(form.get('code'));
      return send(res, 200, tokenResponse(entry, form));
    }
    if (grantType === 'refresh_token') {
      const entry = refresh.get(form.get('refresh_token'));
      if (!entry) return send(res, 400, { error: 'invalid_grant' });
      refresh.delete(form.get('refresh_token'));
      return send(res, 200, tokenResponse(entry, form));
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  }
  if (url.pathname === '/revoke' && req.method === 'GET') {
    // D1 provider shape: token as credential in the query, result flag in JSON.
    const token = url.searchParams.get('access_token') ?? '';
    access.delete(token);
    return send(res, 200, { result: true });
  }
  if (url.pathname === '/revoke' && req.method === 'POST') {
    const form = await readForm(req);
    access.delete(form.get('token'));
    refresh.delete(form.get('token'));
    return send(res, 200, {});
  }
  if (url.pathname === '/userinfo') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /u, '');
    const entry = access.get(token);
    if (!entry) return send(res, 401, { error: 'invalid_token' });
    return send(res, 200, { sub: entry.sub });
  }
  if (url.pathname === '/logout') {
    const target = url.searchParams.get('post_logout_redirect_uri');
    if (target) { res.writeHead(302, { location: target }); return res.end(); }
    return send(res, 200, 'logged out', 'text/plain');
  }
  send(res, 404, { error: 'not_found' });
});

const sse = (res, payload) => res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);

const gateway = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${GW_PORT}`);
  if (!url.pathname.startsWith('/v1/')) return send(res, 404, { error: 'not_found' });
  if (!req.headers.authorization?.startsWith('Bearer ')) {
    return send(res, 401, { error: { code: 'invalid_api_key', message: 'missing credential' } });
  }
  if (url.pathname === '/v1/models') {
    return send(res, 200, { object: 'list', data: [{ id: 'mock-chat-1', object: 'model', owned_by: 'mock' }] });
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = JSON.parse((await readRaw(req)) || '{}');
    const model = body.model ?? 'mock-chat-1';
    const reply = '这是本地模拟网关的回复：凭据与身份链路已打通。';
    if (body.stream !== true) {
      return send(res, 200, {
        id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const created = Math.floor(Date.now() / 1000);
    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created, model };
    sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    for (const piece of reply.match(/.{1,6}/gsu) ?? []) {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    }
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse(res, '[DONE]');
    return res.end();
  }
  send(res, 404, { error: 'not_found' });
});

iam.listen(IAM_PORT, '127.0.0.1', () => console.log(`mock IAM      ${ISSUER}`));
gateway.listen(GW_PORT, '127.0.0.1', () => console.log(`mock gateway  http://127.0.0.1:${GW_PORT}/v1`));

