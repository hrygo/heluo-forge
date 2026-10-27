import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

const MESSAGES = Object.freeze({
  BAD_CHANGE_ID: 'The change ID is invalid.',
  CLI_NOT_FOUND: 'The DevOps CLI executable was not found.',
  CLI_FAILED: 'The DevOps CLI process failed.',
  AUTH_FAILED: 'The DevOps CLI authentication failed.',
  CLI_TIMEOUT: 'The DevOps CLI exceeded its time limit.',
  CLI_CANCELLED: 'The DevOps CLI request was cancelled.',
  OUTPUT_LIMIT: 'The DevOps CLI exceeded its output limit.',
  INVALID_JSON: 'The DevOps CLI did not return a JSON object.',
  INVALID_OPTIONS: 'The DevOps CLI runner options are invalid.',
});

/** Deliberately excludes raw process output, paths, causes, and caller-supplied messages. */
export class DopProcessError extends Error {
  constructor(code) {
    const safeCode = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'INVALID_OPTIONS';
    super(MESSAGES[safeCode]);
    this.name = 'DopProcessError';
    this.code = safeCode;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isText = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const optionKeys = new Set(['changeId', 'executable', 'prefixArgs', 'cwd', 'env', 'timeoutMs', 'maxOutputBytes', 'signal']);
const credentialFlag = /^--?(?:[^=]*(?:token|secret|password|credential|authorization|api[-_]?key)|auth)(?:=|$)/i;

function validateOptions(options) {
  try {
    if (!isRecord(options) || Object.keys(options).some((key) => !optionKeys.has(key))) {
      throw new DopProcessError('INVALID_OPTIONS');
    }
    const {
      changeId, executable = 'dop', prefixArgs = [], cwd, env,
      timeoutMs = 10000, maxOutputBytes = 262144, signal,
    } = options;
    // Equality also rejects the final newline accepted by JavaScript's `$` anchor.
    if (typeof changeId !== 'string' || changeId.match(/^[A-Z]{2,6}\d+$/)?.[0] !== changeId) {
      throw new DopProcessError('BAD_CHANGE_ID');
    }
    if (!isText(executable) || (cwd !== undefined && !isText(cwd))
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || !Array.isArray(prefixArgs) || !Array.from(prefixArgs).every(isText)) {
      throw new DopProcessError('INVALID_OPTIONS');
    }
    // Test-only escape hatch: Node runs an absolute fixture file, never `-e` or CLI flags.
    if (prefixArgs.length > 0 && (executable !== process.execPath || !isAbsolute(prefixArgs[0])
      || prefixArgs.some((arg) => credentialFlag.test(arg)))) {
      throw new DopProcessError('INVALID_OPTIONS');
    }
    const childEnv = Object.create(null);
    if (env === undefined) {
      // Do not inherit credentials, NODE_OPTIONS, HOME, or other ambient configuration.
      for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT']) {
        if (typeof process.env[key] === 'string') childEnv[key] = process.env[key];
      }
    } else {
      if (!isRecord(env)) throw new DopProcessError('INVALID_OPTIONS');
      for (const [key, value] of Object.entries(env)) {
        if (!isText(key) || key.includes('=') || typeof value !== 'string' || value.includes('\0')) {
          throw new DopProcessError('INVALID_OPTIONS');
        }
        childEnv[key] = value;
      }
    }
    return { changeId, executable, prefixArgs: [...prefixArgs], cwd, env: childEnv, timeoutMs, maxOutputBytes, signal };
  } catch (error) {
    if (error instanceof DopProcessError) throw error;
    throw new DopProcessError('INVALID_OPTIONS');
  }
}

/**
 * Execute only `dop change view <ID> -j`, once, without a shell or inherited credentials.
 * `prefixArgs` is reserved for trusted process.execPath fixture scripts, not CLI options.
 * stdout and stderr share one byte budget; stderr is scanned, never retained or returned.
 * Explicit env is the caller's responsibility and replaces (does not merge) the environment.
 */
export async function runDopChange(options = {}) {
  const { changeId, executable, prefixArgs, cwd, env, timeoutMs, maxOutputBytes, signal } = validateOptions(options);
  if (signal?.aborted) throw new DopProcessError('CLI_CANCELLED');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, [...prefixArgs, 'change', 'view', changeId, '-j'], {
        cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new DopProcessError(error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'CLI_FAILED'));
      return;
    }

    let failure;
    let outputBytes = 0;
    const stdout = [];
    let authFailed = false;
    let stderrTail = '';
    const terminate = (code) => {
      if (failure) return;
      failure = code;
      // POSIX: terminate the whole dedicated process group, not only the CLI
      // wrapper. Windows: bounded native taskkill, never a shell. A malicious
      // executable escaping its own group is outside this trusted CLI boundary.
      if (child.pid && process.platform === 'win32') {
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', timeout: 1000 });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited; still close local streams. */ }
      }
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => terminate('CLI_TIMEOUT'), timeoutMs);
    const onAbort = () => terminate('CLI_CANCELLED');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const capture = (chunk, isStderr) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate('OUTPUT_LIMIT');
        return;
      }
      if (isStderr) {
        const text = stderrTail + chunk.toString('latin1');
        authFailed ||= /401|403/.test(text);
        stderrTail = text.slice(-2);
      } else {
        stdout.push(chunk);
      }
    };
    child.stdout.on('data', (chunk) => capture(chunk, false));
    child.stderr.on('data', (chunk) => capture(chunk, true));
    child.stdout.on('error', () => terminate('CLI_FAILED'));
    child.stderr.on('error', () => terminate('CLI_FAILED'));
    child.on('error', (error) => terminate(error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'CLI_FAILED'));
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (failure || authFailed || exitCode !== 0) {
        reject(new DopProcessError(failure ?? (authFailed ? 'AUTH_FAILED' : 'CLI_FAILED')));
        return;
      }
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(stdout)));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new DopProcessError('INVALID_JSON');
        }
        resolve(parsed);
      } catch {
        reject(new DopProcessError('INVALID_JSON'));
      }
    });
  });
}
