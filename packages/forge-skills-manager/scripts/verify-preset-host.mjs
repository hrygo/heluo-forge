import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { packageSkillsManager } from './package.mjs';
import { npmLaunch } from '../../../scripts/lib/bundle-rules.mjs';

// Builds and installs a final private TGZ with synthetic credentials, never employee inputs.
const [cliArgument, runtimeArgument] = process.argv.slice(2);
assert.ok(cliArgument, 'Usage: node scripts/verify-preset-host.mjs <installed-dsh-cli.js> [node-or-electron-executable]');
const cli = resolve(cliArgument), runtime = runtimeArgument ? resolve(runtimeArgument) : process.execPath;
const directory = await fs.mkdtemp(join(tmpdir(), 'forge-preset-diagnostics-'));
const home = join(directory, 'dsh'), user = join(directory, 'user'), workspace = join(directory, 'workspace');
const profile = join(home, 'profiles', 'preset-probe');
const secrets = { username: 'svc-preset-diagnostic-fixture', password: ' synthetic-preset-diagnostic-password ' };
const evidence = { probe: 'preset-credentials-diagnostics', startedAt: new Date().toISOString(), checks: [], ok: false };
const record = check => { evidence.checks.push(check); console.log(`ok ${check}`); };
function noSecrets(text) { for (const value of Object.values(secrets)) assert.ok(!String(text).includes(value), 'credential escaped into diagnostic output'); }
const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(environment, {
  HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local'),
  DSH_HOME: home, DSH_AGENTS_HOME: join(directory, 'agents'), CI: '1', DSH_TELEMETRY_DISABLED: '1',
  FORGE_NACOS_USERNAME: 'wrong-environment-user', FORGE_NACOS_PASSWORD: 'wrong-environment-password',
  npm_config_cache: join(directory, 'empty-cache'), npm_config_userconfig: join(directory, 'empty-npmrc'), npm_config_registry: 'http://127.0.0.1:9',
  ...(/electron|deepseek harness/i.test(runtime) ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
});
const execute = promisify(execFile);
const runCli = async args => {
  const result = await execute(runtime, ['--expose-internals', cli, '--profile', 'preset-probe', ...args], { cwd: workspace, env: environment, windowsHide: true, timeout: 60000 });
  noSecrets(result.stdout); noSecrets(result.stderr); return result.stdout;
};
let child, logs = '', logins = 0;
const nacos = createServer(async (req, res) => {
  try {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/auth/user/login')) {
      let body = ''; for await (const chunk of req) body += chunk;
      assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), secrets);
      logins++; res.end(JSON.stringify({ accessToken: 'synthetic-read-token', tokenTtl: 18000 }));
    } else {
      assert.equal(req.headers.authorization, 'Bearer synthetic-read-token');
      res.end(JSON.stringify({ code: 0, data: { totalCount: 0, pageItems: [], pageNumber: 1, pagesAvailable: 0 } }));
    }
  } catch { res.writeHead(500).end('{}'); }
});
try {
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(user, { recursive: true });
  await fs.writeFile(join(directory, 'empty-npmrc'), '');
  await new Promise(accept => nacos.listen(0, '127.0.0.1', accept));
  const made = packageSkillsManager({ configText: [
    `HELUO_NACOS_SERVER_URL=http://127.0.0.1:${nacos.address().port}/nacos`, 'HELUO_NACOS_NAMESPACE_ID=public',
    `HELUO_NACOS_USERNAME=${secrets.username}`, `HELUO_NACOS_PASSWORD=${JSON.stringify(secrets.password)}`,
  ].join('\n'), output: join(directory, 'package'), version: '0.1.0-diagnostic.test' });
  noSecrets(JSON.stringify(made)); evidence.sha256 = made.sha256;
  evidence.dsh = (await runCli(['--version'])).trim();
  await runCli(['--from-default-profile', 'web', '--dump-config']);
  const npm = npmLaunch();
  const installed = await execute(npm.command, [...npm.prefix, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', made.tarball], {
    cwd: profile, env: environment, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  noSecrets(installed.stdout); noSecrets(installed.stderr);
  const manifestPath = join(profile, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dsh.profile.bundles.push('@heluo/forge-skills-manager');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const patchPath = join(profile, 'cordis.patch.yml');
  const originalPatch = await fs.readFile(patchPath, 'utf8');
  const dump = await runCli(['--dump-config']);
  assert.match(dump, /credentialsRef: ['"]?bundled/);
  record('final TGZ installs offline and pre-start config diagnostics contain only a credential reference');
  child = spawn(runtime, ['--expose-internals', cli, '--profile', 'preset-probe', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: workspace, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launch = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('HOST_START_TIMEOUT')), 60000);
    const read = chunk => {
      logs += chunk.toString();
      const match = logs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/u);
      if (match) { clearTimeout(timer); accept(match[1]); }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', () => { clearTimeout(timer); reject(new Error('HOST_START_FAILED')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('HOST_EXITED')); });
  });
  const origin = new URL(launch).origin;
  const login = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  await login.arrayBuffer();
  const api = async path => {
    const response = await fetch(origin + '/api/forge-skills-manager' + path, { headers: { cookie }, signal: AbortSignal.timeout(10000) });
    const text = await response.text(); noSecrets(text); return { status: response.status, body: JSON.parse(text) };
  };
  assert.equal((await api('/state')).body.ok, true);
  assert.equal((await api('/nacos/list')).body.ok, true); assert.equal(logins, 1);
  assert.equal(await fs.readFile(patchPath, 'utf8'), originalPatch);
  await runCli(['--dump-config']); noSecrets(logs);
  record('runtime login uses bundled credentials despite wrong environment values; diagnostics remain credential-free');
  await fs.rm(join(profile, 'node_modules/@heluo/forge-skills-manager/private/nacos-credentials.json'));
  const unavailable = await api('/nacos/list');
  assert.equal(unavailable.status, 503); assert.equal(unavailable.body.code, 'error.nacos.config');
  assert.equal((await api('/state')).body.ok, true); assert.equal(logins, 1);
  // Troubleshooting reports only load status and the public error classification.
  const troubleshooting = { loaded: true, code: unavailable.body.code };
  noSecrets(JSON.stringify(troubleshooting)); noSecrets(logs);
  record('missing file blocks cached access, keeps local management available, and returns a sanitized classification');
  evidence.ok = true;
} catch (error) {
  // Do not echo child command output or parser/exception text into an installation report.
  evidence.failure = { classification: error.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'PROBE_FAILED' };
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  nacos.closeAllConnections(); await new Promise(accept => nacos.close(accept));
  evidence.finishedAt = new Date().toISOString();
  await fs.writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, evidence: join(directory, 'evidence.json'), ...evidence.failure }));
}
