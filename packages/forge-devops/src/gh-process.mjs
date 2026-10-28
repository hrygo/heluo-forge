import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

const MESSAGES = Object.freeze({
  BAD_TARGET: 'The repository or issue/PR reference is invalid.',
  CLI_NOT_FOUND: 'The repository CLI executable was not found.',
  CLI_FAILED: 'The repository CLI process failed.',
  AUTH_FAILED: 'The repository CLI authentication failed.',
  CLI_TIMEOUT: 'The repository CLI exceeded its time limit.',
  CLI_CANCELLED: 'The repository CLI request was cancelled.',
  OUTPUT_LIMIT: 'The repository CLI exceeded its output limit.',
  INVALID_JSON: 'The repository CLI did not return a JSON object.',
  INVALID_OPTIONS: 'The repository CLI runner options are invalid.',
});

/** Deliberately excludes raw process output, paths, causes, and caller-supplied messages. */
export class GhProcessError extends Error {
  constructor(code) {
    const safeCode = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'INVALID_OPTIONS';
    super(MESSAGES[safeCode]);
    this.name = 'GhProcessError';
    this.code = safeCode;
  }
}

const REPO_FIELDS = 'nameWithOwner,url,isPrivate,defaultBranchRef';
const ISSUE_FIELDS = 'number,title,body,state,url,closedByPullRequestsReferences';
const PR_FIELDS = 'number,title,state,url,headRefOid,baseRefName,mergedAt,commits';

export const GH_JSON_FIELDS = Object.freeze({
  repo: REPO_FIELDS,
  issue: ISSUE_FIELDS,
  pr: PR_FIELDS,
});

const isRecord = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isText = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const optionKeys = new Set(['executable', 'prefixArgs', 'allowedHost', 'args', 'cwd', 'env', 'timeoutMs', 'maxOutputBytes', 'signal']);
const credentialFlag = /^--?(?:[^=]*(?:token|secret|password|credential|authorization|api[-_]?key)|auth)(?:=|$)/i;
const repoPart = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const issueNumber = /^[1-9]\d*$/u;

function assertRepo(value, allowedHost) {
  if (typeof value !== 'string' || value.includes('\0')) throw new GhProcessError('BAD_TARGET');
  const parts = value.split('/');
  if (parts.length !== 3 || !parts.every((part) => repoPart.test(part))) throw new GhProcessError('BAD_TARGET');
  if (typeof allowedHost === 'string' && allowedHost.length > 0
    && parts[0].toLowerCase() !== allowedHost.toLowerCase()) throw new GhProcessError('BAD_TARGET');
  return parts;
}

function validateArgs(args, allowedHost) {
  if (!Array.isArray(args) || args.length === 0 || !args.every(isText)) throw new GhProcessError('BAD_TARGET');
  const [group, verb] = args;
  if ((group !== 'repo' && group !== 'issue' && group !== 'pr') || verb !== 'view') {
    throw new GhProcessError('BAD_TARGET');
  }
  if (group === 'repo') {
    if (args.length !== 5 || args[3] !== '--json' || args[4] !== REPO_FIELDS) throw new GhProcessError('BAD_TARGET');
    assertRepo(args[2], allowedHost);
    return;
  }
  if (args.length !== 7 || !issueNumber.test(args[2]) || args[3] !== '--repo'
    || args[5] !== '--json') throw new GhProcessError('BAD_TARGET');
  assertRepo(args[4], allowedHost);
  if (args[6] !== (group === 'issue' ? ISSUE_FIELDS : PR_FIELDS)) throw new GhProcessError('BAD_TARGET');
}

function validateOptions(options) {
  try {
    if (!isRecord(options) || Object.keys(options).some((key) => !optionKeys.has(key))) {
      throw new GhProcessError('INVALID_OPTIONS');
    }
    const {
      executable = 'gh', prefixArgs = [], allowedHost, args, cwd, env,
      timeoutMs = 10000, maxOutputBytes = 262144, signal,
    } = options;
    if (!isText(executable) || (cwd !== undefined && !isText(cwd))
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || !Array.isArray(prefixArgs) || !Array.from(prefixArgs).every(isText)) {
      throw new GhProcessError('INVALID_OPTIONS');
    }
    if (allowedHost !== undefined && (!isText(allowedHost) || allowedHost.includes('/'))) {
      throw new GhProcessError('INVALID_OPTIONS');
    }
    // Test-only escape hatch: Node runs an absolute fixture file, never `-e` or CLI flags.
    if (prefixArgs.length > 0 && (executable !== process.execPath || !isAbsolute(prefixArgs[0])
      || prefixArgs.some((arg) => credentialFlag.test(arg)))) {
      throw new GhProcessError('INVALID_OPTIONS');
    }
    // Production path (no fixture prefix): require an absolute native executable so
    // the call can never resolve an unrelated ambient `gh` through PATH.
    if (prefixArgs.length === 0 && !isAbsolute(executable)) {
      throw new GhProcessError('INVALID_OPTIONS');
    }
    validateArgs(args, allowedHost);
    const childEnv = Object.create(null);
    if (env === undefined) {
      for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT']) {
        if (typeof process.env[key] === 'string') childEnv[key] = process.env[key];
      }
    } else {
      if (!isRecord(env)) throw new GhProcessError('INVALID_OPTIONS');
      for (const [key, value] of Object.entries(env)) {
        if (!isText(key) || key.includes('=') || typeof value !== 'string' || value.includes('\0')) {
          throw new GhProcessError('INVALID_OPTIONS');
        }
        childEnv[key] = value;
      }
    }
    return { executable, prefixArgs: [...prefixArgs], args: [...args], cwd, env: childEnv, timeoutMs, maxOutputBytes, signal };
  } catch (error) {
    if (error instanceof GhProcessError) throw error;
    throw new GhProcessError('INVALID_OPTIONS');
  }
}

/**
 * Execute only fixed read-only `gh` argv (repo/issue/pr view with exact --json
 * fields), once, without a shell or inherited credentials. stdout and stderr
 * share one byte budget; stderr is scanned, never retained or returned.
 * Explicit env is the caller's responsibility and replaces (does not merge) the environment.
 */
export async function runGh(options = {}) {
  const { executable, prefixArgs, args, cwd, env, timeoutMs, maxOutputBytes, signal } = validateOptions(options);
  if (signal?.aborted) throw new GhProcessError('CLI_CANCELLED');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, [...prefixArgs, ...args], {
        cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new GhProcessError(error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'CLI_FAILED'));
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
        reject(new GhProcessError(failure ?? (authFailed ? 'AUTH_FAILED' : 'CLI_FAILED')));
        return;
      }
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(stdout)));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new GhProcessError('INVALID_JSON');
        }
        resolve(parsed);
      } catch {
        reject(new GhProcessError('INVALID_JSON'));
      }
    });
  });
}
