#!/usr/bin/env node
// `heluo-forge auth …`: read-only identity and token access for scripts.
//
// Identity and token commands open the credential store read-only and never refresh tokens
// itself. Without a Host URL it reads the current, unexpired access token.
// With a Host URL it requests a token over the loopback bridge; the Host may
// refresh the session, and the CLI checks the returned token against the store.

import { parseArgs } from 'node:util';
import {
  accessTokenOf, classifySessionRecord, EXIT, isBridgeReadableSession, isSameBridgeSession, sessionFromRecord, SESSION_RECORD_KEY,
} from '../src/cli-session.mjs';
import { BRIDGE_REF } from '../src/bridge.mjs';
import { ERROR_STATUS } from '../src/error-contract.mjs';
import { sessionView } from '../src/session-read.mjs';

const USAGE = `用法：
  heluo-forge auth whoami [--json]   输出当前身份与登录状态
  heluo-forge auth token             输出当前可用的访问令牌（CLI 不直接刷新）
  heluo-forge client-secret set --issuer URL --client-id ID --method METHOD --ref REF
                                     从标准输入读取密钥并写入专用凭据记录
  heluo-forge client-secret replace --issuer URL --client-id ID --method METHOD --ref REF
                                     --old-issuer URL --old-client-id ID --old-method METHOD
                                     从标准输入读取密钥，按旧绑定更正同一引用

环境变量：
  HELUO_FORGE_IAM_URL                 运行中的 DSH 地址（如 http://127.0.0.1:49196）；设置后
                                      auth token 经回环桥向 Host 取票，由 Host 按需刷新
  HELUO_FORGE_STORE_DIRECTORY         凭据存储目录（默认与插件一致）
  HELUO_FORGE_KEYCHAIN_SERVICE        凭据命名空间的 service，默认 heluo-forge
  HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX 凭据命名空间的 account 前缀，默认 iam
`;

function fail(code, message, json) {
  if (json) process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
}

function credentialError(error) {
  if (error?.code === 'CRED_STORE_PATH_CONFLICT') {
    return { code: 'CRED_STORE_PATH_CONFLICT', message: '凭据存储目录不可用或存在冲突，请核对 Host 和 CLI 的存储目录设置。' };
  }
  const code = error?.code === 'CRED_KEY_UNAVAILABLE' || error?.code === 'CRED_DECRYPT_FAILED'
    ? error.code : 'IAM_CREDENTIALS_UNAVAILABLE';
  return { code, message: '凭据存储不可用或读取失败' };
}

async function openReader() {
  try {
    const keychain = await import('@heluo/forge-credentials-keychain');
    const reader = await keychain.openCredentialReader(storeOptions());
    return { reader };
  } catch (error) {
    return { error: credentialError(error) };
  }
}

function storeOptions() {
  return {
    directory: process.env.HELUO_FORGE_STORE_DIRECTORY || undefined,
    service: process.env.HELUO_FORGE_KEYCHAIN_SERVICE || 'heluo-forge',
    accountPrefix: process.env.HELUO_FORGE_KEYCHAIN_ACCOUNT_PREFIX || 'iam',
  };
}

async function provisionClientSecret(operation, args) {
  const replacing = operation === 'replace';
  const stringOption = { type: 'string' };
  const options = { issuer: stringOption, 'client-id': stringOption, method: stringOption, ref: stringOption };
  if (replacing) Object.assign(options, { 'old-issuer': stringOption, 'old-client-id': stringOption, 'old-method': stringOption });
  const requiredCount = Object.keys(options).length;
  let scope;
  let previousBinding;
  try {
    const { values, tokens } = parseArgs({ args, tokens: true, options });
    if (tokens.length === requiredCount && Object.keys(values).length === requiredCount) {
      scope = { issuer: values.issuer, clientId: values['client-id'], method: values.method, ref: values.ref };
      if (replacing) {
        previousBinding = { issuer: values['old-issuer'], clientId: values['old-client-id'], method: values['old-method'] };
      }
    }
  } catch { /* Only the fixed usage is shown. */ }
  if (!scope || process.stdin.isTTY) {
    process.stderr.write(USAGE);
    return EXIT.USAGE;
  }
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    const { setIamClientSecret } = await import('@heluo/forge-credentials-keychain');
    await setIamClientSecret(scope, value, { ...storeOptions(), previousBinding });
  } catch (error) {
    if (error.code === 'IAM_CLIENT_SECRET_BINDING_MISMATCH') {
      fail(error.code, replacing ? '未找到与旧绑定一致的 IAM 客户端密钥记录' : '该凭据引用已绑定其他 IAM 客户端配置', false);
    } else {
      fail('IAM_CLIENT_SECRET_PROVISION_FAILED', '无法预置密钥，请核对输入、客户端登记与凭据存储', false);
    }
    return EXIT.UNAVAILABLE;
  }
  process.stdout.write(replacing ? '已更正 IAM 客户端密钥绑定。\n' : '已预置 IAM 客户端密钥。\n');
  return EXIT.OK;
}

function sessionClientSecretBinding(record) {
  const { grant } = classifySessionRecord(record);
  if (grant?.version !== 2) return undefined;
  const { method, secretRef: ref, secretRevision: revision } = grant.authContext;
  return { issuer: grant.issuer, clientId: grant.clientId, ref, method, revision };
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
  if (args[0] === 'client-secret' && ['set', 'replace'].includes(args[1])) {
    return provisionClientSecret(args[1], args.slice(2));
  }
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
    const hostUrl = process.env.HELUO_FORGE_IAM_URL;
    const useBridge = args[1] === 'token' && Boolean(hostUrl);
    let stored;
    try {
      stored = useBridge ? { record: await reader.readRecord(SESSION_RECORD_KEY) }
        : await reader.readIamSession(sessionClientSecretBinding);
    } catch (error) {
      const failure = credentialError(error);
      fail(failure.code, failure.message, json);
      return EXIT.UNAVAILABLE;
    }
    const { record, clientSecretCurrent } = stored;

    if (args[1] === 'whoami') {
      const session = clientSecretCurrent ? sessionFromRecord(record) : sessionView(undefined, 'error');
      if (json) process.stdout.write(`${JSON.stringify(session)}\n`);
      else if (session.principal) process.stdout.write(`${session.principal.subject} (${session.principal.issuer ?? 'unknown issuer'})\n`);
      else process.stdout.write('未登录\n');
      return EXIT.OK;
    }

    if (useBridge) {
      if (!isBridgeReadableSession(record)) {
        const code = accessTokenOf(record).code;
        fail(code, '当前没有可用的访问令牌', json);
        return code === 'IAM_NOT_SIGNED_IN' ? EXIT.NOT_SIGNED_IN : EXIT.REAUTH_REQUIRED;
      }
      const fromHost = await tokenFromHost(reader, hostUrl);
      if (fromHost.ok) {
        let confirmed;
        try {
          confirmed = await reader.readIamSession(sessionClientSecretBinding);
        } catch (error) {
          const failure = credentialError(error);
          fail(failure.code, failure.message, json);
          return EXIT.UNAVAILABLE;
        }
        const { record: latest } = confirmed;
        const current = accessTokenOf(latest);
        if (!confirmed.clientSecretCurrent || !isSameBridgeSession(record, latest) || !current.ok || current.token !== fromHost.token) {
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

    const result = clientSecretCurrent ? accessTokenOf(record) : { ok: false, code: 'IAM_REAUTH_REQUIRED' };
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
