import { spawn as nodeSpawn } from 'node:child_process';

/**
 * Run one command to completion and report what happened: `{ code, stdout,
 * stderr }`. A command that cannot start, or that exceeds `timeout`, resolves
 * with a non-zero code rather than throwing, so callers branch on one shape.
 * The command is never run through a shell. What a command prints is kept up
 * to `MAX_CAPTURE` per stream, the end first: an error is at the end, and a
 * command that talks too much must not take the shell's memory with it.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{timeout?: number, env?: object, input?: string, cwd?: string, spawn?: Function}} [options]
 *   `spawn` is an injection point for tests.
 */
export const MAX_CAPTURE = 1024 * 1024;

export function runCommand(command, args, { timeout, env, input, cwd, spawn: spawnImpl = nodeSpawn } = {}) {
  return new Promise((settle) => {
    let timer;
    let stdout = '';
    let stderr = '';
    const finish = (code) => {
      clearTimeout(timer);
      settle({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    };
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      stderr = `the command could not be started (${error?.code ?? error?.message ?? 'UNKNOWN'})`;
      finish(1);
      return;
    }
    if (timeout !== undefined) {
      timer = setTimeout(() => {
        stderr = keepEnd(`${stderr}the command did not finish within ${timeout} ms and was killed`);
        child.kill('SIGKILL');
      }, timeout);
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = keepEnd(stdout + chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = keepEnd(stderr + chunk);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', (error) => {
      stderr = keepEnd(stderr + (error?.message ?? ''));
      finish(1);
    });
    child.on('close', finish);
  });
}

const keepEnd = (text) => (text.length > MAX_CAPTURE ? text.slice(-MAX_CAPTURE) : text);

/**
 * The `exec` handed to the installer when it must use the embedded runtime:
 * the Electron binary runs as Node with the pinned CLI entry ahead of the
 * arguments. The installer is given that same binary as `--dsh`, and any other
 * command it tries is refused, so no dsh from elsewhere can be reached.
 *
 * @param {{command: string, entry: string, env?: object, spawn?: Function}} input
 */
export function embeddedExec({ command, entry, env = {}, spawn: spawnImpl = nodeSpawn }) {
  return (bin, args, options = {}) => {
    if (bin !== command) {
      return Promise.resolve({ code: 1, stdout: '', stderr: 'the embedded runtime runs only from the shell' });
    }
    return runCommand(command, [entry, ...args], {
      timeout: options.timeout,
      cwd: options.cwd,
      input: options.input,
      env: { ...env, ...options.env, ELECTRON_RUN_AS_NODE: '1' },
      spawn: spawnImpl,
    });
  };
}
