import { ShellError } from './errors.mjs';
import { addressInUse, findLaunchUrl } from './launch-url.mjs';

/**
 * The web profile's process as the runtime needs to see it:
 * - `kill(signal)` asks it to exit;
 * - `exited` settles once it has, with `{ code, signal }`;
 * - `output` and `errors` are async iterables of what it prints.
 *
 * @typedef {{ kill(signal?: string): void,
 *   exited: Promise<{ code?: number | null, signal?: string | null }>,
 *   output: AsyncIterable<string | Uint8Array>, errors: AsyncIterable<string | Uint8Array> }} ProcessHandle
 */

const OUTPUT_TAIL = 64 * 1024;
const decoder = new TextDecoder();

/**
 * Owns the lifecycle of the web profile's process: one phase at a time, every
 * transition observable, and nothing reported that has not happened.
 *
 * @param {{ spawn: () => ProcessHandle, findLaunchUrl?: Function, startTimeoutMs?: number,
 *   stopGraceMs?: number, setTimer?: Function, clearTimer?: Function, onEvent?: Function }} input
 *   Everything but `spawn` is an injection point for tests.
 */
export function createRuntime({
  spawn,
  findLaunchUrl: findUrl = findLaunchUrl,
  startTimeoutMs = 60_000,
  stopGraceMs = 5_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onEvent = () => {},
} = {}) {
  let phase = 'idle';
  let child = null;
  let launch = null;
  let lastFailure = null;
  let lastExit = null;
  let starting = null;
  let stopping = null;
  let cancelStart = null;
  let finishStop = null;
  let forceTimer;

  function enter(next, code) {
    phase = next;
    onEvent({ type: 'phase', phase: next, ...(code === undefined ? {} : { code }) });
  }

  function failWith(code, message) {
    lastFailure = { code, message };
    enter('failed', code);
    return new ShellError(code, message);
  }

  function begin() {
    enter('starting');
    let handle;
    try {
      handle = spawn();
    } catch (error) {
      return Promise.reject(failWith('SPAWN_FAILED', `the web profile could not be started (${error?.code ?? 'UNKNOWN'})`));
    }
    child = handle;
    let output = '';
    let errors = '';
    let settled = false;
    let resolveStart;
    let rejectStart;
    let timer;

    const failStart = (code, message) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      launch = null;
      starting = null;
      cancelStart = null;
      rejectStart(failWith(code, message));
    };
    const tail = (text) => (text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text);
    // Read a stream to its end. Reading continues after readiness on purpose:
    // a pipe nobody drains would block the web profile on its next line.
    const watch = async (stream, assign, current, scan) => {
      try {
        for await (const chunk of stream) {
          const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
          assign(tail(`${current()}${text}`));
          if (!scan || settled) continue;
          let url;
          try {
            url = findUrl(output);
          } catch (error) {
            // An address the shell may not load is not waited out: the
            // service is stopped now, or it would keep listening where it is.
            handle.kill('SIGKILL');
            failStart(error?.code ?? 'LAUNCH_URL_REJECTED', error?.message ?? 'the web profile announced an address the shell may not load');
            return;
          }
          if (url !== null) {
            settled = true;
            clearTimer(timer);
            launch = url;
            lastFailure = null;
            starting = null;
            cancelStart = null;
            enter('ready');
            resolveStart({ ...url });
          }
        }
      } catch {
        // A stream that breaks is not a verdict; the exit handling below is.
      }
    };

    // The executor runs at once, so the settle functions exist before any
    // timer or exit can reach them.
    starting = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    cancelStart = () => failStart('STOPPED', 'the web profile was stopped before it was ready');

    handle.exited.then((info = {}) => {
      lastExit = { code: info.code ?? null, signal: info.signal ?? null };
      if (child === handle) child = null;
      if (phase === 'stopping') {
        launch = null;
        lastFailure = null;
        clearTimer(forceTimer);
        stopping = null;
        enter('stopped');
        finishStop();
        return;
      }
      const left = `the web profile exited (code ${info.code ?? info.signal ?? 'unknown'})`;
      if (phase === 'starting') {
        const taken = addressInUse(errors);
        failStart(taken ? 'PORT_CONFLICT' : 'EXITED_BEFORE_READY', taken ? 'the web profile could not bind its port' : left);
        return;
      }
      if (phase === 'ready') failWith('EXITED', left);
      // Any other phase is `failed` by the deadline or `stopped`: this exit is expected.
    });

    timer = setTimer(() => {
      // Past the deadline the process may not linger and announce later.
      handle.kill('SIGKILL');
      failStart('START_TIMEOUT', `the web profile did not announce its address within ${startTimeoutMs} ms`);
    }, startTimeoutMs);
    void watch(handle.output, (text) => { output = text; }, () => output, true);
    void watch(handle.errors, (text) => { errors = text; }, () => errors, false);
    return starting;
  }

  function start() {
    if (phase === 'ready') return Promise.resolve({ ...launch });
    if (phase === 'starting') return starting;
    if (phase === 'stopping') {
      return Promise.reject(new ShellError('STOPPING', 'the web profile is stopping; it can be started again once it has exited'));
    }
    return begin();
  }

  function stop() {
    if (stopping !== null) return stopping;
    if (cancelStart !== null) cancelStart();
    const handle = child;
    if (handle === null) {
      launch = null;
      if (phase !== 'stopped') enter('stopped');
      return Promise.resolve();
    }
    enter('stopping');
    stopping = new Promise((resolve) => {
      finishStop = resolve;
    });
    handle.kill('SIGTERM');
    forceTimer = setTimer(() => handle.kill('SIGKILL'), stopGraceMs);
    return stopping;
  }

  /** The phase and what may be said about it. The launch address itself is not part of it: it carries a token. */
  function snapshot() {
    return {
      phase,
      origin: phase === 'ready' ? launch.origin : null,
      failure: lastFailure === null ? null : { code: lastFailure.code, message: lastFailure.message },
      exit: lastExit,
    };
  }

  return { start, stop, snapshot };
}
