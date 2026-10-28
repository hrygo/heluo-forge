#!/usr/bin/env node
/**
 * Issue #100: real DSH llm/stream -> pi-ai -> loopback wire probe.
 * Run: node scripts/probe/issue100-user-agent-probe.mjs
 * Optional DSH_BIN selects the installed executable. The test uses an isolated
 * temporary profile, synthetic credentials and a loopback model endpoint. The
 * plugin's TCP guard applies only after activation and is not OS-wide isolation.
 * Failure preserves the synthetic profile; success removes only that fresh root.
 * Exit 0 means collection succeeded, not gateway acceptance. The comparison of
 * the formerly proposed fixed UA is diagnostic, not the current target rule.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expected = 'DeepSeekHarness/1 (heluo-forge; proto=1)';
const instance = randomBytes(16).toString('hex');
const version = '1.2.3';
export const name = 'issue100-user-agent-probe';
export const inject = ['llm'];

// This same file is loaded as a plugin by the real host; no mock LLM service.
export function apply(ctx) {
  const port = Number(process.env.PROBE_PORT);
  if (process.env.ISSUE100_PROBE !== 'synthetic-loopback-only' || !Number.isInteger(port) || port < 1 || port > 65535 || !process.env.PROBE_RESULT) throw new Error('issue100: isolated probe environment required');
  let hookCalls = 0;
  const originalConnect = Socket.prototype.connect;
  const guardedConnect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === 'object' && first !== null ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
    if (options.host !== '127.0.0.1' || Number(options.port) !== port || options.path) throw new Error('issue100: blocked non-mock TCP connection');
    return originalConnect.apply(this, args);
  };
  Socket.prototype.connect = guardedConnect;
  ctx.on('dispose', () => { if (Socket.prototype.connect === guardedConnect) Socket.prototype.connect = originalConnect; });
  const guardInstalled = Socket.prototype.connect === guardedConnect;
  ctx.on('llm/stream', (_options, next) => { hookCalls += 1; return next(); });
  setTimeout(async () => {
    const chunks = [];
    try {
      for await (const chunk of ctx.llm.stream({ provider: 'issue100-loopback', model: 'synthetic-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) chunks.push(chunk);
      await writeFile(process.env.PROBE_RESULT, JSON.stringify({ hookCalls, guardInstalled, chunks }));
    } catch (error) {
      await writeFile(process.env.PROBE_RESULT, JSON.stringify({ hookCalls, error: String(error?.stack ?? error), chunks }));
    }
  }, 500);
}

async function main() {
  const dsh = process.env.DSH_BIN ?? 'dsh';
  const v = spawnSync(dsh, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: 10000 });
  const pinned = (await readFile(new URL('../../.dsh-version', import.meta.url), 'utf8')).trim();
  if (v.error || v.status !== 0 || v.stdout.trim() !== pinned) throw new Error(`Expected installed DSH ${pinned}; version check: ${v.error?.message ?? v.stdout.trim() ?? v.status}`);
  const tempParent = await realpath(tmpdir());
  const dir = await mkdtemp(join(tempParent, 'issue100-host-probe-'));
  const identity = await stat(dir);
  const home = join(dir, 'home');
  await mkdir(home);
  const result = join(dir, 'result.json');
  const patch = join(dir, 'probe.patch.yml');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, DSH_HOME: join(home, '.dsh'), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: dir, PROBE_RESULT: result, ISSUE100_PROBE: 'synthetic-loopback-only', ISSUE100_SYNTHETIC_KEY: 'synthetic-loopback-key', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  let wire = null;
  const server = createServer((req, res) => {
    wire = { method: req.method, path: req.url, userAgent: req.headers['user-agent'] ?? null, instance: req.headers['x-dsh-instance'] ?? null, version: req.headers['x-dsh-version'] ?? null, syntheticAuth: req.headers.authorization === 'Bearer synthetic-loopback-key' };
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"id":"probe","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"probe","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  let success = false;
  try {
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
    const port = server.address().port;
    env.PROBE_PORT = String(port);
    const self = pathToFileURL(resolve(fileURLToPath(import.meta.url))).href;
    await writeFile(patch, `- id: session-telemetry-otel\n  disabled: true\n- id: deepseek-account\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: web-search-deepseek\n  disabled: true\n- id: web-deepseek-api\n  disabled: true\n- id: llm-pi-ai\n  config:\n    providers:\n      issue100-loopback:\n        api: openai-completions\n        baseURL: 'http://127.0.0.1:${port}/v1'\n        apiKeyEnv: ISSUE100_SYNTHETIC_KEY\n        headers:\n          user-agent: '${expected}'\n          X-DSH-Instance: '${instance}'\n          X-DSH-Version: '${version}'\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n        models:\n          - id: synthetic-model\n- insert:\n    - id: issue100-probe\n      name: '${self}'\n`);
    const child = spawn(dsh, ['--profile', 'issue100', '--from-default-profile', 'sdk', '--patch', patch], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(ok => { child.once('error', error => ok({ error: error.message })); child.once('exit', (code, signal) => ok({ code, signal })); });
    let report;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { report = JSON.parse(await readFile(result, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (await Promise.race([exited.then(() => true), new Promise(ok => setTimeout(() => ok(false), 100))])) break;
    }
    child.stdin.end();
    let exit = await Promise.race([exited, new Promise(ok => setTimeout(() => ok(null), 5000))]);
    if (!exit) { child.kill('SIGKILL'); exit = await exited; }
    const finish = report?.chunks?.find(chunk => chunk.type === 'finish');
    const comparisons = { hookInvoked: (report?.hookCalls ?? 0) > 0, configuredUserAgentPreserved: wire ? wire.userAgent === expected : null, instancePreserved: wire ? wire.instance === instance : null, versionPreserved: wire ? wire.version === version : null };
    const outcome = { dsh: v.stdout.trim(), configured: { userAgent: expected, instance, version }, wire, comparisons, hookCalls: report?.hookCalls ?? null, guardInstalled: report?.guardInstalled ?? false, finish: finish?.reason ?? null, error: report?.error ?? null, exit, evidenceDirectory: dir, networkLimit: 'After plugin activation, the Node TCP socket guard restricts connections to the mock address and port; it is not an OS-wide network sandbox and does not cover earlier startup or non-TCP/native networking.' };
    success = Boolean(wire && wire.method === 'POST' && wire.path === '/v1/chat/completions' && wire.syntheticAuth && wire.instance === instance && wire.version === version && report?.hookCalls > 0 && report?.guardInstalled === true && finish?.reason?.kind === 'stop' && exit.code === 0);
    console.log(JSON.stringify(outcome, null, 2));
    if (!success) { console.error('Probe incomplete; synthetic evidence retained. Host output follows:\n' + stdout + '\n' + stderr); process.exitCode = 2; }
  } finally {
    await new Promise(ok => server.close(() => ok()));
    if (success) {
      const actual = await realpath(dir);
      const current = await lstat(dir);
      if (dirname(actual) !== tempParent || actual !== dir || !basename(actual).startsWith('issue100-host-probe-') || !current.isDirectory() || current.isSymbolicLink() || current.uid !== identity.uid || (process.getuid && current.uid !== process.getuid()) || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error(`Refusing unsafe cleanup: ${dir}`);
      await rm(actual, { recursive: true });
      console.log('cleanup: removed only the verified freshly created temporary root');
    } else console.error(`Synthetic evidence retained: ${dir}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`probe: ${error.stack ?? error}`); process.exitCode = 2; });
}
