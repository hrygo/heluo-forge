#!/usr/bin/env node
/**
 * #25/#26 read-host probe runner (model-free, no profile mutation).
 *
 * Builds a throwaway patch layer over a real DSH profile: policy + devops +
 * probe plugin. The probe provides fixed native CLI readers and dispatches
 * the four read tools through the host pipeline, then writes a JSON report.
 *
 * Usage:
 *   node scripts/probe/run-read-host-probe.mjs --dop /abs/dop --gh /abs/gh \
 *     --host gitee.corp.example --out /new/dir/report.json [--profile sdk]
 * Exit codes: 0 pass; 1 assertion failure; 2 environment not ready.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function parseProbeArgs(args) {
  const options = {};
  const rest = [...args];
  while (rest.length) {
    const key = rest.shift();
    if (!['--dop', '--gh', '--host', '--out', '--profile'].includes(key) || key in options || !rest.length || rest[0].startsWith('--')) {
      throw new Error('INVALID_OPTIONS');
    }
    options[key] = rest.shift();
  }
  if (!options['--dop'] || !options['--gh'] || !options['--host'] || !options['--out']) throw new Error('INVALID_OPTIONS');
  for (const key of ['--dop', '--gh', '--out']) {
    if (!isAbsolute(options[key])) throw new Error('ABSOLUTE_PATH_REQUIRED');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(options['--host'])) throw new Error('BAD_HOST');
  return {
    dop: resolve(options['--dop']), gh: resolve(options['--gh']),
    host: options['--host'], out: resolve(options['--out']),
    profile: options['--profile'] ?? 'sdk',
  };
}

const dsh = process.env.DSH_BIN ?? 'dsh';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let options;
  try {
    options = parseProbeArgs(process.argv.slice(2));
  } catch {
    console.error('probe: usage --dop ABS --gh ABS --host HOST --out NEW-FILE [--profile sdk]');
    process.exit(2);
  }
  if (existsSync(options.out)) {
    console.error('probe: refusing to overwrite an existing report file');
    process.exit(2);
  }
  try {
    const report = await runReadHostProbe(options);
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks?.map((c) => ({ id: c.id, ok: c.ok })) }, null, 2));
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(`probe: ${error?.message ?? error}`);
    process.exit(error?.code === 'ENV' ? 2 : 1);
  }
}

export async function runReadHostProbe(options) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-read-host-'));
  const out = join(dir, 'report.json');
  const patch = join(dir, 'read-host.patch.yml');
  const policyPackage = resolve(here, '../../packages/forge-policy/src/index.mjs');
  const devopsPackage = resolve(here, '../../packages/forge-devops/src/index.mjs');
  const probePackage = resolve(here, 'read-host-probe-plugin.mjs');
  const rows = [
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: '${join(dir, 'sessions')}'`,
    '- id: storage-json',
    '  config:',
    `    root: '${join(dir, 'storages')}'`,
    '- insert:',
    '    - id: forge-policy',
    `      name: '${pathToFileURL(policyPackage).href}'`,
    '      config:',
    '        catalog:',
    "          - { action: 'change.read', kind: 'read', target: 'change', enabled: true }",
    "          - { action: 'repository.read', kind: 'read', target: 'repository', enabled: true }",
    "          - { action: 'issue.read', kind: 'read', target: 'issue', enabled: true }",
    "          - { action: 'pr.read', kind: 'read', target: 'pull-request', enabled: true }",
    '        audit:',
    '          sink: memory',
    '          allowNonDurable: true',
    '        tools:',
    "          forge_devops_change_read: 'change.read'",
    "          forge_devops_repository_read: 'repository.read'",
    "          forge_devops_issue_read: 'issue.read'",
    "          forge_devops_pr_read: 'pr.read'",
    '    - id: forge-devops',
    `      name: '${pathToFileURL(devopsPackage).href}'`,
    '    - id: read-host-probe',
    `      name: '${pathToFileURL(probePackage).href}'`,
    '',
  ];
  writeFileSync(patch, `${rows.join('\n')}`, { mode: 0o600 });
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  mkdirSync(join(dir, 'storages'), { recursive: true });

  // Same-trust throwaway host: it inherits the caller's environment, but the
  // fixture CLIs themselves always run with an explicit minimal env (see the
  // probe plugin), so no ambient credential reaches a subprocess.
  const child = spawn(dsh, ['--profile', options.profile, '--patch', patch], {
    cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      DSH_READ_PROBE_DOP: options.dop, DSH_READ_PROBE_GH: options.gh,
      DSH_READ_PROBE_HOST: options.host, DSH_READ_PROBE_OUT: out,
    },
  });
  let stdout = '';
  let stderr = '';
  // Bounded tails only; the probe report carries the verdict, not host logs.
  const tail = (current, chunk) => `${current}${chunk}`.slice(-8192);
  child.stdout.on('data', (chunk) => (stdout = tail(stdout, chunk)));
  child.stderr.on('data', (chunk) => (stderr = tail(stderr, chunk)));
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  const deadline = Date.now() + 120000;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  let sawReport = false;
  while (Date.now() < deadline) {
    if (existsSync(out)) { sawReport = true; child.stdin.end(); break; }
    const raced = await Promise.race([exited.then(() => 'exited'), sleep(200).then(() => 'tick')]);
    if (raced === 'exited') break;
  }
  const exit = await Promise.race([exited, sleep(10000).then(() => undefined)]);
  if (exit === undefined) {
    // Settle path: terminate the whole dedicated process group on POSIX so a
    // hung host cannot leave fixture grandchildren behind (cf. gh-process).
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    child.kill('SIGKILL');
    await exited;
    rmSync(dir, { recursive: true, force: true });
    const error = new Error('probe host did not settle in time');
    error.code = 'ENV';
    throw error;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(sawReport ? out : options.out, 'utf8'));
  } catch {
    rmSync(dir, { recursive: true, force: true });
    const error = new Error(`probe produced no report (exit ${exit.code ?? exit.signal}; stderr ${stderr.slice(-300)}; stdout ${stdout.slice(-300)})`);
    error.code = 'ENV';
    throw error;
  }
  try {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    const error = new Error('refusing to overwrite the selected report file');
    error.code = 'ENV';
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return report;
}
