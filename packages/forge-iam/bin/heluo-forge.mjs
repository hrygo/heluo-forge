#!/usr/bin/env node
// `heluo-forge auth …`: read-only identity and token access for scripts.
//
// This entry point never refreshes and never writes. The IAM service owns the
// refresh token; under the confirmed rotation rule a second refresher would
// invalidate the running session, so the CLI only reports what the store holds
// and tells the user to sign in again when the access token has expired.

import { accessTokenOf, EXIT, sessionFromRecord, SESSION_RECORD_KEY } from '../src/cli-session.mjs';
import { BRIDGE_REF } from '../src/bridge.mjs';

const USAGE = `用法：
  heluo-forge auth whoami [--json]   输出当前身份与登录状态
  heluo-forge auth token             输出未过期的访问令牌（不刷新）

环境变量：
  HELUO_FORGE_IAM_URL                 运行中的 DSH 地址（如 http://127.0.0.1:49196）；设置后
                                      auth token 经 loopback 桥向 Host 取，过期也能拿到新票
  HELUO_FORGE_CREDENTIALS_FILE        明文文件后端路径（仅开发/试点）
  HELUO_FORGE_KEYCHAIN_SERVICE        钥匙串 service，默认 heluo-forge
  HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX 钥匙串 account 前缀，默认 iam
`;

function fail(code, message, json) {
  if (json) process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
}

async function openReader() {
  let keychain;
  try {
    keychain = await import('@heluo/forge-credentials-keychain');
  } catch {
    return undefined;
  }
  const service = process.env.HELUO_FORGE_KEYCHAIN_SERVICE || 'heluo-forge';
  const accountPrefix = process.env.HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX || 'iam';
  const file = process.env.HELUO_FORGE_CREDENTIALS_FILE;
  try {
    const backend = file
      ? keychain.createFileBackend({ path: file })
      : keychain.createNativeKeyringBackend({ service, enumeration: 'unsupported' });
    return keychain.createKeychainProvider(backend, { service, accountPrefix });
  } catch {
    return undefined;
  }
}

/** Ask the running Host for a token through the loopback bridge. */
async function tokenFromHost(reader, baseUrl) {
  const capability = (await reader.resolve(BRIDGE_REF).catch(() => undefined))?.value;
  if (typeof capability !== 'string' || capability.length === 0) {
    return { ok: false, code: 'IAM_CREDENTIALS_UNAVAILABLE' };
  }
  let response;
  try {
    response = await fetch(new URL('/api/forge-iam/bridge/token', baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${capability}` },
    });
  } catch {
    return { ok: false, code: 'IAM_HOST_UNREACHABLE' };
  }
  if (!response.ok) {
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

  const reader = await openReader();
  if (!reader) {
    fail('IAM_CREDENTIALS_UNAVAILABLE', '没有可用的凭据后端：配置 HELUO_FORGE_CREDENTIALS_FILE 或安装原生钥匙串模块', json);
    return EXIT.UNAVAILABLE;
  }

  let record;
  try {
    record = await reader.readRecord(SESSION_RECORD_KEY);
  } catch {
    fail('IAM_CREDENTIALS_UNAVAILABLE', '凭据后端读取失败', json);
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
    const fromHost = await tokenFromHost(reader, hostUrl);
    if (fromHost.ok) {
      process.stdout.write(`${fromHost.token}\n`);
      return EXIT.OK;
    }
    fail(fromHost.code, '无法从运行中的 DSH 取得令牌', json);
    return EXIT.UNAVAILABLE;
  }

  const result = accessTokenOf(record);
  if (!result.ok) {
    fail(result.code, result.code === 'IAM_REAUTH_REQUIRED' ? '访问令牌已过期，请回到 DSH 重新登录' : '当前没有可用的访问令牌', json);
    return result.code === 'IAM_REAUTH_REQUIRED' ? EXIT.REAUTH_REQUIRED : EXIT.NOT_SIGNED_IN;
  }
  process.stdout.write(`${result.token}\n`);
  return EXIT.OK;
}

main(process.argv).then(
  (code) => process.exit(code),
  () => {
    fail('IAM_CLI_FAILED', '命令执行失败', process.argv.includes('--json'));
    process.exit(EXIT.UNAVAILABLE);
  },
);
