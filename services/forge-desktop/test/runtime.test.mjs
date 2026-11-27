/**
 * State machine tests of the desktop shell's runtime: every transition of the
 * design's §7, driven by a controllable process and hand-fired timers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ShellError } from '../src/errors.mjs';
import { createRuntime } from '../src/runtime.mjs';

const TOKEN = 'process-token-7f3a9c';
const ORIGIN = 'http://127.0.0.1:43210';
const ANNOUNCE = `dsh web: ${ORIGIN}/?token=${TOKEN}\n`;

/** Timers the test fires by hand: nothing here depends on wall-clock time. */
function manualTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer(fn, ms) {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fire(ms) {
      for (const [id, timer] of timers) {
        if (timer.ms === ms) {
          timers.delete(id);
          timer.fn();
          return true;
        }
      }
      return false;
    },
    armed: () => [...timers.values()].map((timer) => timer.ms),
  };
}

/** An async iterable the test pushes to, like a pipe nobody else reads. */
function pipe() {
  const values = [];
  const waiters = [];
  let ended = false;
  return {
    push(value) {
      const settle = waiters.shift();
      if (settle !== undefined) settle({ value, done: false });
      else values.push(value);
    },
    end() {
      ended = true;
      for (const settle of waiters.splice(0)) settle({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (values.length > 0) return Promise.resolve({ value: values.shift(), done: false });
          return ended ? Promise.resolve({ value: undefined, done: true }) : new Promise((settle) => waiters.push(settle));
        },
      };
    },
  };
}

/** A web profile process the test controls: what it prints, when it exits, how it was asked to. */
function fakeProcess() {
  const stdout = pipe();
  const stderr = pipe();
  let settleExit;
  const handle = {
    kills: [],
    kill(signal) {
      handle.kills.push(signal);
    },
    exited: new Promise((resolve) => {
      settleExit = resolve;
    }),
    output: stdout,
    errors: stderr,
  };
  return {
    handle,
    say: (text) => stdout.push(text),
    complain: (text) => stderr.push(text),
    exit: (info = { code: 0, signal: null }) => {
      stdout.end();
      stderr.end();
      settleExit(info);
    },
    // The exit is seen while its pipes are still open: what it wrote may not be read yet.
    gone: (info = { code: 1, signal: null }) => settleExit(info),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ShellError, `expected ShellError, got ${error?.message}`);
    assert.equal(error.code, code, error.message);
    assert.equal(error.message.includes(TOKEN), false, 'a failure repeated the token');
    return true;
  });
}

function fixture({ process: fake = fakeProcess(), startTimeoutMs = 60_000, stopGraceMs = 5_000 } = {}) {
  const timers = manualTimers();
  const events = [];
  let spawns = 0;
  const runtime = createRuntime({
    spawn: () => {
      spawns += 1;
      return fake.handle;
    },
    startTimeoutMs,
    stopGraceMs,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onEvent: (event) => events.push(event),
  });
  return { runtime, fake, timers, events, spawns: () => spawns };
}

test('start waits for the announcement, then stays ready on the same process', async () => {
  const { runtime, fake, timers, events, spawns } = fixture();
  const starting = runtime.start();
  assert.equal(runtime.snapshot().phase, 'starting');
  // Asked again while starting: the same wait, not a second process.
  assert.equal(runtime.start(), starting);
  assert.deepEqual(timers.armed(), [60_000], 'the start deadline is armed');
  fake.say('booting the web profile\n');
  await flush();
  assert.equal(runtime.snapshot().phase, 'starting');
  fake.say(ANNOUNCE);
  const launch = await starting;
  assert.equal(launch.origin, ORIGIN);
  assert.equal(launch.href, `${ORIGIN}/?token=${TOKEN}`);
  assert.equal(runtime.snapshot().phase, 'ready');
  assert.equal(runtime.snapshot().origin, ORIGIN);
  // Asked again while ready: the current address, still from the one process.
  assert.deepEqual(await runtime.start(), launch);
  assert.equal(spawns(), 1);
  // The deadline is disarmed once ready, and nothing was killed to get there.
  assert.deepEqual(timers.armed(), []);
  assert.deepEqual(fake.handle.kills, []);
  assert.deepEqual(events.map((event) => event.phase), ['starting', 'ready']);
  assert.equal(JSON.stringify({ events, snapshot: runtime.snapshot() }).includes(TOKEN), false);
});

test('a process that exits before announcing has failed, by the reason its output gives', async () => {
  const gone = fixture();
  const starting = gone.runtime.start();
  gone.fake.exit({ code: 1, signal: null });
  await rejectsCode(starting, 'EXITED_BEFORE_READY');
  assert.equal(gone.runtime.snapshot().phase, 'failed');
  assert.equal(gone.runtime.snapshot().failure.code, 'EXITED_BEFORE_READY');
  assert.deepEqual(gone.runtime.snapshot().exit, { code: 1, signal: null });

  const taken = fixture();
  const waiting = taken.runtime.start();
  taken.fake.complain('Error: listen EADDRINUSE: address already in use 127.0.0.1:43210\n');
  taken.fake.exit({ code: 1, signal: null });
  await rejectsCode(waiting, 'PORT_CONFLICT');
  // The class is reported; the line itself is not.
  assert.equal(taken.runtime.snapshot().failure.message.includes('127.0.0.1:43210'), false);
});

test('past the deadline the process is killed; what is still in its pipes is read, and a late announcement counts for nothing', async () => {
  const { runtime, fake, timers } = fixture({ startTimeoutMs: 1000 });
  const starting = runtime.start();
  assert.deepEqual(timers.armed(), [1000]);
  timers.fire(1000);
  assert.deepEqual(fake.handle.kills, ['SIGKILL']);
  // Decided at the deadline, delivered once its pipes are read: they may hold its last lines.
  assert.equal(runtime.snapshot().phase, 'starting');
  assert.deepEqual(timers.armed(), [1000], 'the wait for the rest of its output is bounded');
  // An address it prints now is kept as output, never taken as the address.
  fake.say(ANNOUNCE);
  fake.exit({ code: null, signal: 'SIGKILL' });
  await rejectsCode(starting, 'START_TIMEOUT');
  assert.equal(runtime.snapshot().phase, 'failed');
  assert.equal(runtime.snapshot().failure.code, 'START_TIMEOUT');
  assert.equal(runtime.snapshot().origin, null);
  assert.deepEqual(timers.armed(), [], 'nothing is left armed once the verdict is delivered');
  // Anything it still prints, and its exit, change nothing.
  fake.say(ANNOUNCE);
  fake.exit({ code: null, signal: 'SIGKILL' });
  await flush();
  assert.equal(runtime.snapshot().phase, 'failed');
  assert.equal(runtime.snapshot().origin, null);
});

test('pipes that stay open past the exit do not keep the verdict waiting', async () => {
  const { runtime, fake, timers } = fixture();
  const starting = runtime.start();
  fake.complain('Error: listen EADDRINUSE: address already in use 127.0.0.1:43210\n');
  // The process is gone; something it started still holds its pipes open.
  fake.gone({ code: 1, signal: null });
  await flush();
  assert.equal(runtime.snapshot().phase, 'starting');
  assert.deepEqual(timers.armed(), [1000]);
  timers.fire(1000);
  await rejectsCode(starting, 'PORT_CONFLICT');
  assert.deepEqual(timers.armed(), []);
  // The class is reported; the line itself is not.
  assert.equal(runtime.snapshot().failure.message.includes('127.0.0.1:43210'), false);
});

test('the last lines a failed process wrote are read before its verdict, and are part of what is kept', async () => {
  const gone = fixture();
  const starting = gone.runtime.start();
  gone.fake.gone({ code: 1, signal: null });
  // Its report was still in the pipes when the exit was seen.
  gone.fake.complain('dsh: startup failed: 1 required plugins did not activate\n');
  gone.fake.handle.output.end();
  gone.fake.handle.errors.end();
  await rejectsCode(starting, 'EXITED_BEFORE_READY');
  const { failure, exit, output } = gone.runtime.snapshot();
  assert.equal(failure.code, 'EXITED_BEFORE_READY');
  assert.deepEqual(exit, { code: 1, signal: null });
  assert.equal(output.stdout, '');
  assert.equal(output.stderr, 'dsh: startup failed: 1 required plugins did not activate\n');
});

test('the snapshot keeps the end of both streams, bounded, with the query of every address cut out', async () => {
  const { runtime, fake } = fixture();
  const starting = runtime.start();
  fake.say('booting the web profile\n');
  fake.complain(
    `dsh: startup failed: could not reach ${ORIGIN}/?token=${TOKEN}\n` // the launch address, as printed
      + '  {"error":"get http:\\/\\/127.0.0.1:43210\\/?token=process-token-7f3a9c failed"}\n' // the same, inside a JSON line
      + '  issuer http://iam.corp.example/esc-sso/oidc/.well-known/openid-configuration has no query\n'
      // An address whose start was cut off before it keeps no token either; a fragment goes like a query.
      + `  cut at its start: 43210/?token=${TOKEN}\n`
      + '  fragment https://idp.corp.example/cb#session=1\n',
  );
  await flush();
  const { output } = runtime.snapshot();
  assert.equal(output.stdout, 'booting the web profile\n');
  assert.equal(
    output.stderr,
    `dsh: startup failed: could not reach ${ORIGIN}/?…\n`
      + '  {"error":"get http:\\/\\/127.0.0.1:43210\\/?… failed"}\n'
      + '  issuer http://iam.corp.example/esc-sso/oidc/.well-known/openid-configuration has no query\n'
      + '  cut at its start: 43210/?token=…\n'
      + '  fragment https://idp.corp.example/cb#…\n',
  );
  assert.equal(JSON.stringify(runtime.snapshot()).includes(TOKEN), false);

  // Each stream keeps its end, and no more than the tail: what failed is at the end.
  for (let index = 0; index < 1500; index += 1) {
    fake.say(`out ${index} ${'x'.repeat(200)}\n`);
    fake.complain(`err ${index} ${'y'.repeat(200)}\n`);
  }
  await flush();
  const kept = runtime.snapshot().output;
  assert.ok(kept.stdout.length <= 64 * 1024, `stdout keeps ${kept.stdout.length} characters`);
  assert.ok(kept.stderr.length <= 64 * 1024, `stderr keeps ${kept.stderr.length} characters`);
  // What is kept begins at a whole line: no address is cut in two where it starts.
  assert.match(kept.stdout, /^out \d+ x{200}\n/u);
  assert.match(kept.stdout, /out 1499 x{200}\n$/u);
  assert.match(kept.stderr, /err 1499 y{200}\n$/u);

  const stopping = runtime.stop();
  await rejectsCode(starting, 'STOPPED');
  fake.exit();
  await stopping;
});

test('an announcement anywhere but loopback is refused at once and the process is stopped', async () => {
  const { runtime, fake } = fixture();
  const starting = runtime.start();
  fake.say('dsh web: http://0.0.0.0:43210/?token=another-token-1b2c\n');
  await rejectsCode(starting, 'LAUNCH_URL_REJECTED');
  assert.deepEqual(fake.handle.kills, ['SIGKILL']);
  assert.equal(runtime.snapshot().failure.message.includes('another-token-1b2c'), false);
});

test('a process that exits while ready takes the address with it; a later start runs a new process', async () => {
  const first = fakeProcess();
  const second = fakeProcess();
  const made = [first, second];
  const timers = manualTimers();
  const runtime = createRuntime({
    spawn: () => made.shift().handle,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const ready = runtime.start();
  first.say(ANNOUNCE);
  await ready;
  first.exit({ code: 7, signal: null });
  await flush();
  assert.equal(runtime.snapshot().phase, 'failed');
  assert.equal(runtime.snapshot().failure.code, 'EXITED');
  assert.equal(runtime.snapshot().origin, null, 'a dead process has no address to give');
  // A later start runs a new process; it is the new process that gives the address.
  const again = runtime.start();
  assert.equal(runtime.snapshot().phase, 'starting');
  second.say(ANNOUNCE);
  assert.equal((await again).origin, ORIGIN);
  assert.equal(made.length, 0);
});

test('stopping asks once, waits for the exit, and is idempotent', async () => {
  const { runtime, fake, timers } = fixture();
  const ready = runtime.start();
  fake.say(ANNOUNCE);
  await ready;
  let stopped = false;
  const pending = runtime.stop();
  const stopping = pending.then(() => {
    stopped = true;
  });
  // Asked again while stopping: the same wait, not a second kill.
  assert.equal(runtime.stop(), pending);
  assert.equal(runtime.snapshot().phase, 'stopping');
  assert.deepEqual(fake.handle.kills, ['SIGTERM']);
  // Not stopped until the process is gone: starting again meanwhile is refused.
  assert.equal(stopped, false);
  await rejectsCode(runtime.start(), 'STOPPING');
  assert.deepEqual(timers.armed(), [5_000]);
  fake.exit({ code: 0, signal: 'SIGTERM' });
  await stopping;
  assert.equal(runtime.snapshot().phase, 'stopped');
  assert.equal(runtime.snapshot().origin, null);
  assert.equal(runtime.snapshot().failure, null);
  assert.deepEqual(timers.armed(), [], 'the force timer is disarmed once the process has exited');
  // Stopping what is already stopped is done at once.
  await runtime.stop();
  assert.equal(runtime.snapshot().phase, 'stopped');
});

test('a process that ignores the request is forced after the grace period', async () => {
  const { runtime, fake, timers } = fixture({ stopGraceMs: 2_000 });
  const ready = runtime.start();
  fake.say(ANNOUNCE);
  await ready;
  const stopping = runtime.stop();
  assert.deepEqual(fake.handle.kills, ['SIGTERM']);
  timers.fire(2_000);
  assert.deepEqual(fake.handle.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(runtime.snapshot().phase, 'stopping');
  fake.exit({ code: null, signal: 'SIGKILL' });
  await stopping;
  assert.equal(runtime.snapshot().phase, 'stopped');
});

test('a process whose exit cannot be observed leaves the stop pending, never "stopped"', async () => {
  const { runtime, fake, timers } = fixture();
  const ready = runtime.start();
  fake.say(ANNOUNCE);
  await ready;
  let settled = false;
  void runtime.stop().then(() => {
    settled = true;
  });
  timers.fire(5_000);
  await flush();
  assert.equal(settled, false);
  assert.equal(runtime.snapshot().phase, 'stopping');
});

test('stopping during the start settles the start and waits for the exit', async () => {
  const { runtime, fake, timers } = fixture();
  const starting = runtime.start();
  const stopping = runtime.stop();
  await rejectsCode(starting, 'STOPPED');
  assert.equal(runtime.snapshot().phase, 'stopping');
  assert.deepEqual(timers.armed(), [5_000], 'the start deadline is disarmed, the grace timer is armed');
  fake.exit({ code: 0, signal: 'SIGTERM' });
  await stopping;
  assert.equal(runtime.snapshot().phase, 'stopped');
  assert.equal(runtime.snapshot().failure, null);
});

test('a process that cannot be started fails without a phase left hanging', async () => {
  const runtime = createRuntime({
    spawn: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  await rejectsCode(runtime.start(), 'SPAWN_FAILED');
  assert.equal(runtime.snapshot().phase, 'failed');
  await runtime.stop();
  assert.equal(runtime.snapshot().phase, 'stopped');
});

test('what the process prints after readiness is still read, so its pipe never fills', async () => {
  const { runtime, fake } = fixture();
  const ready = runtime.start();
  fake.say(ANNOUNCE);
  await ready;
  for (let index = 0; index < 50; index += 1) fake.say(`${'log line '.repeat(200)}\n`);
  await flush();
  assert.equal(runtime.snapshot().phase, 'ready');
  assert.equal(runtime.snapshot().origin, ORIGIN);
});

test('an announcement cut in two by the pipe is taken only once its line is complete', async () => {
  const { runtime, fake } = fixture();
  const starting = runtime.start();
  fake.say(`dsh web: ${ORIGIN}/?to`);
  await flush();
  // Half an address is not an address: taking it would load the wrong port or path.
  assert.equal(runtime.snapshot().phase, 'starting');
  fake.say(`ken=${TOKEN}\n`);
  assert.equal((await starting).href, `${ORIGIN}/?token=${TOKEN}`);
});

test('a character split across two chunks is decoded whole', async () => {
  const seen = [];
  const fake = fakeProcess();
  const runtime = createRuntime({
    spawn: () => fake.handle,
    findLaunchUrl: (text) => {
      seen.push(text);
      return null;
    },
  });
  const starting = runtime.start();
  const bytes = Buffer.from('启动日志：就绪\n');
  fake.handle.output.push(bytes.subarray(0, 1));
  fake.handle.output.push(bytes.subarray(1));
  await flush();
  assert.deepEqual(seen, ['启动日志：就绪\n']);
  const stopping = runtime.stop();
  await rejectsCode(starting, 'STOPPED');
  fake.exit();
  await stopping;
});

test('an announcement that never gets its newline is taken when the stream ends', async () => {
  const { runtime, fake } = fixture();
  const starting = runtime.start();
  fake.say(`dsh web: ${ORIGIN}/?token=${TOKEN}`);
  await flush();
  assert.equal(runtime.snapshot().phase, 'starting');
  fake.handle.output.end();
  assert.equal((await starting).origin, ORIGIN);
});

test('each line is looked at once: the scanning grows with what is printed, not with its square', async () => {
  const scanned = [];
  const fake = fakeProcess();
  const runtime = createRuntime({
    spawn: () => fake.handle,
    findLaunchUrl: (text) => {
      scanned.push(text.length);
      return null;
    },
  });
  const starting = runtime.start();
  let printed = 0;
  for (let index = 0; index < 300; index += 1) {
    const line = `log line ${index}\n`;
    printed += line.length;
    fake.say(line);
  }
  await flush();
  assert.equal(scanned.reduce((sum, length) => sum + length, 0), printed);
  const stopping = runtime.stop();
  await rejectsCode(starting, 'STOPPED');
  fake.exit();
  await stopping;
});

test('after a start that was killed, the next one waits until that process is seen to exit', async () => {
  const first = fakeProcess();
  const second = fakeProcess();
  const made = [first, second];
  const timers = manualTimers();
  let spawns = 0;
  const runtime = createRuntime({
    spawn: () => {
      spawns += 1;
      return made.shift().handle;
    },
    startTimeoutMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const starting = runtime.start();
  timers.fire(1000);
  // Its pipes stay open: the bounded wait for the rest of its output ends first.
  timers.fire(1000);
  await rejectsCode(starting, 'START_TIMEOUT');
  // Asked again at once: the killed process may still be letting go of its port.
  const again = runtime.start();
  await flush();
  assert.equal(spawns, 1, 'a second process was started before the first was seen to exit');
  assert.equal(runtime.start(), again, 'asked a third time: the same wait');
  first.exit({ code: null, signal: 'SIGKILL' });
  await flush();
  assert.equal(spawns, 2);
  assert.equal(runtime.snapshot().phase, 'starting');
  second.say(ANNOUNCE);
  assert.equal((await again).origin, ORIGIN);
});

test('the same after an address the shell may not load', async () => {
  const first = fakeProcess();
  const second = fakeProcess();
  const made = [first, second];
  let spawns = 0;
  const runtime = createRuntime({
    spawn: () => {
      spawns += 1;
      return made.shift().handle;
    },
  });
  const starting = runtime.start();
  first.say('dsh web: http://0.0.0.0:43210/?token=elsewhere-1b2c\n');
  await rejectsCode(starting, 'LAUNCH_URL_REJECTED');
  const again = runtime.start();
  await flush();
  assert.equal(spawns, 1);
  first.exit({ code: null, signal: 'SIGKILL' });
  await flush();
  assert.equal(spawns, 2);
  second.say(ANNOUNCE);
  assert.equal((await again).origin, ORIGIN);
});
