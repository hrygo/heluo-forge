import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/**
 * Minimal OIDC authorization server for offline tests. It implements discovery,
 * authorization-code + PKCE S256, token refresh rotation, JWKS, and revocation.
 * It is a test double only; no production behavior is derived from it.
 */
export async function startMockOidc({
  clientId = 'dsh-desktop',
  subject = 'E1001',
  accessTtl = 3600,
  // Test-only fault injection: hold the token response long enough for a client
  // timeout, or rotate the refresh token and then drop the connection so the
  // client never learns the new value.
  refreshDelayMs = 0,
  dropRefreshResponse = false,
} = {}) {
  // Mutable at runtime so a test can flip a fault between two worker runs.
  const control = { refreshDelayMs, dropRefreshResponse };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-1', use: 'sig', alg: 'RS256' };
  const codes = new Map();
  const refreshTokens = new Map();
  const revoked = new Set();
  const counts = { discovery: 0, authorize: 0, jwks: 0, token: 0, refresh: 0, revoke: 0 };
  let accessCounter = 0;
  let issuer;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/revoke`,
        });
      }
      if (url.pathname === '/jwks') {
        counts.jwks += 1;
        return json(res, 200, { keys: [jwk] });
      }
      if (url.pathname === '/authorize') {
        counts.authorize += 1;
        const state = url.searchParams.get('state');
        const nonce = url.searchParams.get('nonce');
        const challenge = url.searchParams.get('code_challenge');
        const redirectUri = url.searchParams.get('redirect_uri');
        if (url.searchParams.get('client_id') !== clientId || !state || !nonce || !challenge || !redirectUri) {
          return json(res, 400, { error: 'invalid_request' });
        }
        const code = randomUUID();
        codes.set(code, { nonce, challenge, redirectUri });
        const location = new URL(redirectUri);
        location.searchParams.set('code', code);
        location.searchParams.set('state', state);
        res.statusCode = 302;
        res.setHeader('location', location.href);
        res.end();
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        counts.token += 1;
        const form = await parseBody(req);
        if (form.get('client_id') !== clientId) return json(res, 400, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          const entry = codes.get(form.get('code'));
          if (!entry) return json(res, 400, { error: 'invalid_grant' });
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (challenge !== entry.challenge || form.get('redirect_uri') !== entry.redirectUri) {
            return json(res, 400, { error: 'invalid_grant' });
          }
          codes.delete(form.get('code'));
          const access = `access-${++accessCounter}`;
          const refresh = `refresh-${randomUUID()}`;
          refreshTokens.set(refresh, { subject });
          return json(res, 200, {
            access_token: access,
            token_type: 'Bearer',
            expires_in: accessTtl,
            refresh_token: refresh,
            scope: 'openid profile offline_access',
            id_token: signIdToken({ nonce: entry.nonce, subject }),
          });
        }
        if (form.get('grant_type') === 'refresh_token') {
          const old = form.get('refresh_token');
          if (!old || !refreshTokens.has(old) || revoked.has(old)) return json(res, 400, { error: 'invalid_grant' });
          refreshTokens.delete(old);
          const refresh = `refresh-${randomUUID()}`;
          refreshTokens.set(refresh, { subject });
          counts.refresh += 1;
          if (control.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, control.refreshDelayMs));
          if (control.dropRefreshResponse) {
            res.destroy();
            return undefined;
          }
          return json(res, 200, {
            access_token: `access-${++accessCounter}`,
            token_type: 'Bearer',
            expires_in: accessTtl,
            refresh_token: refresh,
            scope: 'openid profile offline_access',
            id_token: signIdToken({ subject }),
          });
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/revoke' && req.method === 'POST') {
        counts.revoke += 1;
        const form = await parseBody(req);
        const token = form.get('token');
        if (token) revoked.add(token);
        res.statusCode = 200;
        res.end();
        return;
      }
      json(res, 404, { error: 'not_found' });
    } catch {
      json(res, 500, { error: 'server_error' });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  issuer = `http://127.0.0.1:${address.port}`;

  function signIdToken({ nonce, subject: sub = subject }) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: issuer,
      sub,
      aud: clientId,
      exp: now + 300,
      iat: now,
      ...(nonce ? { nonce } : {}),
    })).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
  }

  return {
    issuer,
    clientId,
    endpoints: {
      issuer,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      jwksUri: `${issuer}/jwks`,
      revocationEndpoint: `${issuer}/revoke`,
    },
    refreshTokens,
    revoked,
    counts,
    control,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
