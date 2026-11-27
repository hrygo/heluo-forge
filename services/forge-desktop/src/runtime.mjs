import { ShellError } from './errors.mjs';
import { addressInUse, findLaunchUrl, repeatable } from './launch-url.mjs';

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

const tail = (text) => (text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text);

// The end of a stream, starting at a whole line: no address is cut in two where the kept part begins.
const keptEnd = (text) => {
  if (text.length <= OUTPUT_TAIL) return text;
  const from = text.indexOf('\n', text.length - OUTPUT_TAIL);
  // A single line longer than the tail has no safe start left: drop it so a cut
  // URL cannot leave its query or fragment parameters exposed without a scheme.
  return from === -1 ? '' : text.slice(from + 1);
};

/** The end of one stream: a string that is replaced whole, never appended to in place. */
const tailBox = () => {
  let text = '';
  return {
    assign: (next) => {
      text = next;
    },
    current: () => text,
  };
};

/**
 * Owns the lifecycle of the web profile's process: one phase at a time, every
 * transition observable, and nothing reported that has not happened. The end
 * of what the process printed is kept, because a start that failed is
 * explained by it.
 *
 * @param {{ spawn: () => ProcessHandle, findLaunchUrl?: Function, startTimeoutMs?: number,
 *   stopGraceMs?: number, outputGraceMs?: number, setTimer?: Function, clearTimer?: Function, onEvent?: Function }} input
 *   Everything but `spawn` is an injection point for tests. `outputGraceMs`
 *   bounds how long the verdict of a failed start waits for the rest of the
 *   process's output.
 */
export function createRuntime({
  spawn,
  findLaunchUrl: findUrl = findLaunchUrl,
  startTimeoutMs = 60_000,
  stopGraceMs = 5_000,
  outputGraceMs = 1_000,
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
  // The last process the runtime killed whose exit has not been observed yet.
  let retiring = null;
  // Where the current process's streams keep their end; empty before the first process.
  let printed = { stdout: tailBox(), stderr: tailBox() };

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
    // Where each stream keeps its end: what a start that failed printed is the record of how far it got.
    const out = tailBox();
    const err = tailBox();
    printed = { stdout: out, stderr: err };
    let settled = false;
    let resolveStart;
    let rejectStart;
    let timer;

    // The moment the verdict of the start is known: from then on nothing the process prints counts.
    const decide = () => {
      settled = true;
      clearTimer(timer);
      launch = null;
    };
    const deliver = (code, message) => {
      cancelStart = null;
      starting = null;
      // A stop that came first is not undone by the verdict.
      rejectStart(phase === 'starting' ? failWith(code, message) : new ShellError(code, message));
    };
    const failStart = (code, message) => {
      if (settled) return;
      decide();
      deliver(code, message);
    };
    /**
     * The verdict of a process that is gone or killed: decided now, delivered
     * once its pipes are read to the end (and, on timeout, its exit is seen) or
     * `outputGraceMs` has passed. The report it wrote before it left may still
     * be in them, and the class of the failure is read from that report.
     */
    const failAfterOutput = (verdict, { waitExit = false } = {}) => {
      if (settled) return;
      decide();
      let grace;
      const drained = waitExit ? Promise.all([outputRead, handle.exited.catch(() => {})]) : outputRead;
      const read = Promise.race([drained, new Promise((resolve) => {
        grace = setTimer(resolve, outputGraceMs);
      })]);
      void read.then(() => {
        clearTimer(grace);
        deliver(...verdict());
      });
    };
    const portConflictVerdict = () => (addressInUse(err.current()) ? ['PORT_CONFLICT', 'the web profile could not bind its port'] : null);
    const settleReady = (lines) => {
      let url;
      try {
        url = findUrl(lines);
      } catch (error) {
        // An address the shell may not load is not waited out: the
        // service is stopped now, or it would keep listening where it is.
        handle.kill('SIGKILL');
        retiring = handle;
        failStart(error?.code ?? 'LAUNCH_URL_REJECTED', error?.message ?? 'the web profile announced an address the shell may not load');
        return;
      }
      if (url === null) return;
      settled = true;
      clearTimer(timer);
      launch = url;
      lastFailure = null;
      starting = null;
      cancelStart = null;
      enter('ready');
      resolveStart({ ...url });
    };
    // Read a stream to its end. Reading continues after readiness on purpose:
    // a pipe nobody drains would block the web profile on its next line. Each
    // stream keeps its end in `keep`; the scanned one is looked at line by line.
    const watch = async (stream, keep, scan) => {
      // One decoder per stream, in streaming mode: a character split across
      // two chunks is joined, not replaced.
      const decoder = new TextDecoder();
      // For the announcement: the text after the last newline, which is not a
      // whole line yet. Only whole lines are looked at, so an address cut in
      // two by the pipe is never taken for complete.
      let rest = '';
      try {
        for await (const chunk of stream) {
          const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
          keep.assign(keptEnd(`${keep.current()}${text}`));
          if (!scan || settled) continue;
          rest = tail(`${rest}${text}`);
          const cut = rest.lastIndexOf('\n');
          // Each line is looked at once, when it is complete.
          if (cut === -1) continue;
          const lines = rest.slice(0, cut + 1);
          rest = rest.slice(cut + 1);
          settleReady(lines);
        }
        // A stream that ends may leave an announcement without its newline.
        if (scan && !settled && rest.trim() !== '') settleReady(`${rest}\n`);
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
      if (retiring === handle) retiring = null;
      if (phase === 'stopping') {
        launch = null;
        lastFailure = null;
        clearTimer(forceTimer);
        stopping = null;
        enter('stopped');
        finishStop();
        return;
      }
      if (phase === 'starting') {
        failAfterOutput(() => portConflictVerdict() ?? ['EXITED_BEFORE_READY', `the web profile exited (code ${info.code ?? info.signal ?? 'unknown'})`]);
        return;
      }
      const left = `the web profile exited (code ${info.code ?? info.signal ?? 'unknown'})`;
      if (phase === 'ready') failWith('EXITED', left);
      // Any other phase is `failed` by the deadline or `stopped`: this exit is expected.
    });

    // Both streams are read from here on; `outputRead` settles once both have ended.
    const outputRead = Promise.all([watch(handle.output, out, true), watch(handle.errors, err, false)]);
    timer = setTimer(() => {
      // Past the deadline the process may not linger and announce later.
      handle.kill('SIGKILL');
      retiring = handle;
      failAfterOutput(
        () => portConflictVerdict() ?? ['START_TIMEOUT', `the web profile did not announce its address within ${startTimeoutMs} ms`],
        { waitExit: true },
      );
    }, startTimeoutMs);
    return starting;
  }

  function start() {
    if (phase === 'ready') return Promise.resolve({ ...launch });
    if (starting !== null) return starting;
    if (phase === 'stopping') {
      return Promise.reject(new ShellError('STOPPING', 'the web profile is stopping; it can be started again once it has exited'));
    }
    // A process the runtime killed may still be letting go of its port. The
    // next one starts once its exit has been seen, or it would fail for a
    // reason that belongs to the previous start.
    if (retiring !== null) return (starting = retiring.exited.then(begin));
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

  /**
   * The phase and what may be said about it. The launch address itself is not
   * part of it — it carries a token — and neither is the query of any address
   * or the value of any token in `output`, the end of what the process printed.
   */
  function snapshot() {
    return {
      phase,
      origin: phase === 'ready' ? launch.origin : null,
      failure: lastFailure === null ? null : { code: lastFailure.code, message: lastFailure.message },
      exit: lastExit,
      output: { stdout: repeatable(printed.stdout.current()), stderr: repeatable(printed.stderr.current()) },
    };
  }

  return { start, stop, snapshot };
}
