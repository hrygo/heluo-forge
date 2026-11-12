#!/usr/bin/env node
// `heluo-forge auth …`: read-only identity and token access for scripts.
//
// This entry point never refreshes and never writes. The IAM service owns the
// refresh token; under the confirmed rotation rule a second refresher would
// invalidate the running session, so the CLI only reports what the store holds
// and tells the user to sign in again when the access token has expired.

import { isDeepStrictEqual } from 'node:util';
import { accessTokenOf, classifySessionRecord, EXIT, sessionFromRecord, SESSION_RECORD_KEY } from '../src/cli-session.mjs';
import { BRIDGE_REF } from '../src/bridge.mjs';
import { validateGrant } from '../src/record.mjs';
import { grantIdentity } from '../src/service-helpers.mjs';
import { ERROR_STATUS } from '../src/error-contract.mjs';

const USAGE = `用法：
  heluo-forge auth whoami [--json]   输出当前身份与登录状态
  heluo-forge auth token             输出未过期的访问令牌（不刷新）

环境变量：
  HELUO_FORGE_IAM_URL                 运行中的 DSH 地址（如 http://127.0.0.1:49196）；设置后
                                      auth token 经 loopback 桥向 Host 取，过期也能拿到新票
  HELUO_FORGE_STORE_DIRECTORY        凭据存储目录（默认与插件一致）
  HELUO_FORGE_KEYCHAIN_SERVICE        凭据 service，默认 heluo-forge
  HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX 凭据 account 前缀，默认 iam
`;

function fail(code, message, json) {
  if (json) process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
}

function credentialError(error) {
  const code = error?.code === 'CRED_KEY_UNAVAILABLE' || error?.code === 'CRED_DECRYPT_FAILED'
    ? error.code : 'IAM_CREDENTIALS_UNAVAILABLE';
  return { code, message: '凭据存储不可用或读取失败' };
}

async function openReader() {
  try {
    const keychain = await import('@heluo/forge-credentials-keychain');
    const reader = await keychain.openCredentialReader({
      directory: process.env.HELUO_FORGE_STORE_DIRECTORY || undefined,
      service: process.env.HELUO_FORGE_KEYCHAIN_SERVICE || 'heluo-forge',
      accountPrefix: process.env.HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX || 'iam',
    });
    return { reader };
  } catch (error) {
    return { error: credentialError(error) };
  }
}

function activeSession(record) {
  return classifySessionRecord(record).state === 'active';
}

function bridgeReadableSession(record) {
  const session = classifySessionRecord(record);
  return session.state === 'active' || (session.state === 'pending' && session.operation === 'refresh'
    && typeof record.payload.sessionInstanceId === 'string');
}

function sameSession(before, after) {
  if (!bridgeReadableSession(before) || !activeSession(after)) return false;
  if (isDeepStrictEqual(before, after)) return true;
  const left = validateGrant(before.payload);
  const right = validateGrant(after.payload);
  if (!left.ok || !right.ok || typeof left.value.sessionInstanceId !== 'string'
    || left.value.sessionInstanceId !== right.value.sessionInstanceId) return false;
  const pending = left.value.refreshOperation;
  if (pending?.state === 'pending') {
    const completed = right.value.refreshOperation;
    if (completed?.state !== 'complete' || completed.version !== pending.version
      || completed.id !== pending.id || completed.base !== pending.base
      || left.value.refreshToken === right.value.refreshToken) return false;
  }
  return isDeepStrictEqual(grantIdentity(left.value), grantIdentity(right.value));
}

/** Ask the running Host for a token through the loopback bridge. */
async function tokenFromHost(reader, baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password) return { ok: false, code: 'IAM_HOST_UNREACHABLE' };
  } catch { return { ok: false, code: 'IAM_HOST_UNREACHABLE' }; }
  let capability;
  try { capability = (await reader.resolve(BRIDGE_REF))?.value; }
  catch (error) { return { ok: false, code: credentialError(error).code }; }
  if (typeof capability !== 'string' || capability.length === 0) {
    return { ok: false, code: 'IAM_CREDENTIALS_UNAVAILABLE' };
  }
  let response;
  try {
    response = await fetch(new URL('/api/forge-iam/bridge/token', url), {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${capability}` },
    });
  } catch {
    return { ok: false, code: 'IAM_HOST_UNREACHABLE' };
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = body?.error?.code;
    if (typeof code === 'string' && Object.hasOwn(ERROR_STATUS, code) && ERROR_STATUS[code] === response.status) {
      return { ok: false, code };
    }
    return { ok: false, code: response.status === 401 ? 'IAM_BRIDGE_UNAUTHORIZED' : 'IAM_HOST_REJECTED' };
  }
  const body = await response.json().catch(() => ({}));
  if (typeof body?.token !== 'string' || body.token.length === 0) {
    return { ok: false, code: 'IAM_HOST_REJECTED' };
  }
  return { ok: true, token: body.token, expiresAt: body.expiresAt ?? null };
}

async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  if (args[0] !== 'auth' || (args[1] !== 'whoami' && args[1] !== 'token')) {
    process.stderr.write(USAGE);
    return EXIT.USAGE;
  }

  const opened = await openReader();
  if (opened.error) {
    fail(opened.error.code, opened.error.message, json);
    return EXIT.UNAVAILABLE;
  }
  const reader = opened.reader;

  try {
    let record;
    try {
      record = await reader.readRecord(SESSION_RECORD_KEY);
    } catch (error) {
      const failure = credentialError(error);
      fail(failure.code, failure.message, json);
      return EXIT.UNAVAILABLE;
    }

    if (args[1] === 'whoami') {
      const session = sessionFromRecord(record);
      if (json) process.stdout.write(`${JSON.stringify(session)}\n`);
      else if (session.principal) process.stdout.write(`${session.principal.subject} (${session.principal.issuer ?? 'unknown issuer'})\n`);
      else process.stdout.write('未登录\n');
      return EXIT.OK;
    }

    const hostUrl = process.env.HELUO_FORGE_IAM_URL;
    if (typeof hostUrl === 'string' && hostUrl.length > 0) {
      if (!bridgeReadableSession(record)) {
        const code = accessTokenOf(record).code;
        fail(code, '当前没有可用的访问令牌', json);
        return code === 'IAM_NOT_SIGNED_IN' ? EXIT.NOT_SIGNED_IN : EXIT.REAUTH_REQUIRED;
      }
      const fromHost = await tokenFromHost(reader, hostUrl);
      if (fromHost.ok) {
        let latest;
        try { latest = await reader.readRecord(SESSION_RECORD_KEY); }
        catch (error) {
          const failure = credentialError(error);
          fail(failure.code, failure.message, json);
          return EXIT.UNAVAILABLE;
        }
        const current = accessTokenOf(latest);
        if (!sameSession(record, latest) || !current.ok || current.token !== fromHost.token) {
          fail('IAM_CREDENTIALS_UNAVAILABLE', '凭据存储不可用或读取失败', json);
          return EXIT.UNAVAILABLE;
        }
        process.stdout.write(`${fromHost.token}\n`);
        return EXIT.OK;
      }
      fail(fromHost.code, '无法从运行中的 DSH 取得令牌', json);
      return ['IAM_REAUTH_REQUIRED', 'IAM_INVALID_GRANT'].includes(fromHost.code) ? EXIT.REAUTH_REQUIRED
        : fromHost.code === 'IAM_NOT_SIGNED_IN' ? EXIT.NOT_SIGNED_IN : EXIT.UNAVAILABLE;
    }

    const result = accessTokenOf(record);
    if (!result.ok) {
      fail(result.code, result.code === 'IAM_REAUTH_REQUIRED' ? '访问令牌已过期，请回到 DSH 重新登录' : '当前没有可用的访问令牌', json);
      return result.code === 'IAM_NOT_SIGNED_IN' ? EXIT.NOT_SIGNED_IN : EXIT.REAUTH_REQUIRED;
    }
    process.stdout.write(`${result.token}\n`);
    return EXIT.OK;
  } finally {
    try { await reader.close(); } catch { /* Do not expose storage details. */ }
  }
}

main(process.argv).then(
  (code) => process.exit(code),
  () => {
    fail('IAM_CLI_FAILED', '命令执行失败', process.argv.includes('--json'));
    process.exit(EXIT.UNAVAILABLE);
  },
);
