// macOS Security-framework spike adapter (Security CLI transport).
//
// 这是**验证用**适配器，不是生产方案：它用 `/usr/bin/security` 走真实系统钥匙串，
// 用来在本地把 backend 契约、失败语义与"无明文落盘"跑通；Windows Credential Manager
// 与 UOS/麒麟 Secret Service 的审核适配器仍未实现，生产选型（如 @napi-rs/keyring）
// 待实测与评审，见 docs/design/plugins/forge-iam.md §4.3。
//
// 2026-10-24 在 macOS 上实测到的 CLI 语义（darwin-arm64，/usr/bin/security）：
// - `find-generic-password` 命中 → 退出码 0，stdout 为口令；未命中 → 退出码 44。
// - `add-generic-password -U` 新建或覆盖同名条目；口令经 stdin 双次输入即可写入，
//   **不必**出现在 argv 里（实测：`printf '%s\n%s\n' v v | security add-generic-password -s S -a A -U -w`）。
// - `delete-generic-password` 命中 → 0；未命中 → 44（幂等语义）。
// - `list` 未实现：`dump-keychain` 输出不是稳定接口，枚举一律报错而不是返回空表，
//   以免把"读不到"伪装成"没有记录"（迁移因此在此适配器下不可用）。

import { spawnSync } from 'node:child_process';

import { KeychainBackendError } from './backend.mjs';

/** 未命中条目时 `security` 的退出码（实测）。 */
export const SECURITY_ITEM_NOT_FOUND = 44;
export const SECURITY_CLI_DEFAULT_PATH = '/usr/bin/security';

function defaultRunner(securityPath, timeoutMs) {
  return (args, input) => {
    const result = spawnSync(securityPath, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (result.error !== undefined) {
      return { status: null, stdout: '', stderr: String(result.error.message ?? result.error), timedOut: true };
    }
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
}

/** 探测系统钥匙串可用性（只读；不写入任何条目）。 */
export function probeSecurityCli({ securityPath = SECURITY_CLI_DEFAULT_PATH, runner, timeoutMs = 10_000 } = {}) {
  const run = runner ?? defaultRunner(securityPath, timeoutMs);
  const result = run(['list-keychains']);
  return {
    available: result.status === 0,
    securityPath,
    status: result.status,
    // 只记录"有几条搜索列表"，不记录字面路径（可能含用户名）。
    keychainCount: result.status === 0 ? result.stdout.split('\n').filter((line) => line.trim().length > 0).length : 0,
    reason: result.status === 0 ? undefined : (result.stderr || 'security CLI unavailable').trim(),
  };
}

function redact(text, secret) {
  return typeof secret === 'string' && secret.length > 0 ? text.split(secret).join('[redacted]') : text;
}

/**
 * @param {{service?: string, securityPath?: string, runner?: Function, timeoutMs?: number,
 *   secretTransport?: 'stdin' | 'argv', allowArgvSecret?: boolean}} [options]
 */
export function createSecurityCliBackend(options = {}) {
  const service = options.service ?? 'heluo-forge';
  const securityPath = options.securityPath ?? SECURITY_CLI_DEFAULT_PATH;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const transport = options.secretTransport ?? 'stdin';
  const allowArgvSecret = options.allowArgvSecret === true;
  const run = options.runner ?? defaultRunner(securityPath, timeoutMs);

  const invoke = (args, input) => {
    const result = run(args, input);
    if (result.timedOut === true) {
      throw new KeychainBackendError('KEYCHAIN_BACKEND_TIMEOUT', `security ${args[0]} timed out; no fallback is performed`);
    }
    return result;
  };

  return {
    kind: 'security-cli',
    available: true,
    durable: true,
    /** 非生产适配器：组合层必须显式开启才允许使用。 */
    unvetted: true,
    production: false,
    service,

    async get(key) {
      const result = invoke(['find-generic-password', '-s', service, '-a', key, '-w']);
      if (result.status === SECURITY_ITEM_NOT_FOUND) return undefined;
      if (result.status !== 0) {
        throw new KeychainBackendError('KEYCHAIN_BACKEND_FAILED', `security find-generic-password failed (${result.status}): ${result.stderr.trim()}`);
      }
      return result.stdout.replace(/\n$/u, '');
    },

    async set(key, value) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new KeychainBackendError('KEYCHAIN_EMPTY_VALUE', 'refusing to store an empty credential');
      }
      if (transport === 'argv') {
        if (!allowArgvSecret) {
          throw new KeychainBackendError(
            'KEYCHAIN_ARGV_SECRET_NOT_ALLOWED',
            'storing a credential through argv exposes it to same-host process listing; set allowArgvSecret only for disposable test values',
          );
        }
        const result = invoke(['add-generic-password', '-s', service, '-a', key, '-w', value, '-U']);
        if (result.status !== 0) {
          throw new KeychainBackendError('KEYCHAIN_BACKEND_FAILED', `security add-generic-password failed (${result.status}): ${redact(result.stderr, value).trim()}`);
        }
        return;
      }
      // stdin 传输：CLI 会两次询问，第二次为复核；值不出现在 argv。
      const input = `${value}\n${value}\n`;
      const result = invoke(['add-generic-password', '-s', service, '-a', key, '-U', '-w'], input);
      if (result.status !== 0) {
        throw new KeychainBackendError('KEYCHAIN_BACKEND_FAILED', `security add-generic-password failed (${result.status}): ${redact(result.stderr, value).trim()}`);
      }
    },

    async delete(key) {
      const result = invoke(['delete-generic-password', '-s', service, '-a', key]);
      if (result.status === 0 || result.status === SECURITY_ITEM_NOT_FOUND) return;
      throw new KeychainBackendError('KEYCHAIN_BACKEND_FAILED', `security delete-generic-password failed (${result.status}): ${result.stderr.trim()}`);
    },

    async list() {
      throw new KeychainBackendError(
        'KEYCHAIN_LIST_UNSUPPORTED',
        'Security CLI transport cannot enumerate items reliably; migration stays unavailable instead of reporting an empty store',
      );
    },

    async close() {},
  };
}
