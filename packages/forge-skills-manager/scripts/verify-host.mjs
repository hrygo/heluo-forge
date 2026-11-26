import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { zipSync, strToU8 } from 'fflate';
import { execNpm } from '../../../scripts/lib/bundle-rules.mjs';
import { verifyBundle } from '../../../scripts/verify-enterprise-bundle.mjs';

const [cliArgument, tarballArgument] = process.argv.slice(2);
assert.ok(cliArgument && tarballArgument, 'Usage: node scripts/verify-host.mjs <installed-dsh-cli.js> <tarball>');
const cli = resolve(cliArgument), tarball = resolve(tarballArgument);
const verdict = verifyBundle(tarball);
assert.equal(verdict.ok, true, verdict.errors.join('\n'));
assert.equal(verdict.summary.entryName, '@heluo/forge-skills-manager', 'use the independently built Skill Manager tarball');
const directory = await fs.mkdtemp(join(tmpdir(), 'forge-skills-host-'));
const home = join(directory, 'dsh'), user = join(directory, 'user'), workspace = join(directory, 'workspace');
const profile = join(home, 'profiles', 'manager-probe');
const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(environment, {
  HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData', 'Roaming'), LOCALAPPDATA: join(user, 'AppData', 'Local'),
  DSH_HOME: home, DSH_AGENTS_HOME: join(directory, 'agents'), DSH_TELEMETRY_DISABLED: '1', CI: '1',
  npm_config_cache: join(directory, 'npm-cache'), npm_config_userconfig: join(directory, 'empty-npmrc'),
  npm_config_registry: 'http://127.0.0.1:9',
});
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(user, { recursive: true });
await fs.writeFile(join(directory, 'empty-npmrc'), '');
const evidence = { probe: 'skills-manager-real-host', startedAt: new Date().toISOString(), node: process.version,
  dsh: '', entry: verdict.summary.entryName, sha256: verdict.summary.sha256,
  scope: 'local real CLI and HTTP; synthetic Nacos; enterprise permissions and desktop GUI unverified', checks: [], ok: false };
const record = name => { evidence.checks.push(name); console.log(`ok ${name}`); };
const runCli = args => execFileSync(process.execPath, ['--expose-internals', cli, ...args], { cwd: workspace, env: environment, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const prefix = '/api/forge-skills-manager';
const names = ['receipt-skill', 'pending-skill'];
const downloads = new Map();
let releaseDownload, enteredDownload, child, origin, cookie;
const pendingEntered = new Promise(accept => { enteredDownload = accept; });
const pendingRelease = new Promise(accept => { releaseDownload = accept; });
const nacos = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.endsWith('/auth/user/login')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      assert.equal(form.get('username'), 'svc-ci');
      assert.equal(form.get('password'), 'synthetic-password');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accessToken: 'synthetic-read-token', tokenTtl: 18000 }));
      return;
    }
    assert.equal(req.headers.authorization, 'Bearer synthetic-read-token');
    const name = url.searchParams.get('skillName');
    if (url.pathname.endsWith('/skills/list')) {
      const selected = name ? names.filter(item => item === name) : names;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { totalCount: selected.length, pageNumber: 1, pagesAvailable: 1,
        pageItems: selected.map(item => ({ name: item, description: 'Synthetic probe', namespaceId: 'public', downloadCount: 1, enable: true, labels: { latest: '1.0.0' } })) } }));
      return;
    }
    assert.ok(url.pathname.endsWith('/skills/version/download') && names.includes(name));
    downloads.set(name, (downloads.get(name) ?? 0) + 1);
    if (name === 'pending-skill') { enteredDownload(); await pendingRelease; }
    res.setHeader('content-type', 'application/zip');
    res.end(zipSync({ [`${name}/SKILL.md`]: strToU8(`---\nname: ${name}\ndescription: Synthetic probe\n---\nSynthetic instructions.\n`),
      [`${name}/assets/binary.dat`]: new Uint8Array([0, 255, 17]) }));
  } catch {
    res.writeHead(500).end('synthetic fixture rejected the request');
  }
});
await new Promise(accept => nacos.listen(0, '127.0.0.1', accept));
const config = { nacos: { serverUrl: `http://127.0.0.1:${nacos.address().port}/nacos`, namespaceId: 'public',
  username: 'svc-ci', password: 'synthetic-password' } };
const patch = join(profile, 'cordis.patch.yml');
const writePatch = disabled => fs.writeFile(patch, `- id: heluo-skills-manager\n  disabled: ${disabled}\n  config: ${JSON.stringify(config)}\n`);

async function start() {
  child = spawn(process.execPath, ['--expose-internals', cli, '--profile', 'manager-probe', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: workspace, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const launch = await new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('Host startup timed out: ' + logs.replace(/([?&]token=)[^\s&"']+/gu, '$1[redacted]').slice(-6000))), 60000);
    const read = chunk => {
      logs = (logs + chunk.toString()).slice(-50000);
      const match = logs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/u);
      if (match) { clearTimeout(timeout); accept(match[1]); }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Host exited before readiness (${code}): ` + logs.replace(/([?&]token=)[^\s&"']+/gu, '$1[redacted]').slice(-6000))); });
  });
  origin = new URL(launch).origin;
  const response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 303);
  cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  await response.arrayBuffer();
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill();
  await ended;
  child = undefined;
}
async function api(path, value) {
  const response = await fetch(origin + prefix + path, { method: value === undefined ? 'GET' : 'POST',
    headers: { cookie, origin, 'content-type': 'application/json', 'x-dsh-skills-manager': '1' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
async function snapshot() { return api('/state'); }
async function status(id) { return api('/nacos/install-status?operationId=' + id); }
async function waitForRoute(expected) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await fetch(origin + prefix + '/state', { headers: { cookie }, signal: AbortSignal.timeout(10000) });
    const observed = response.status;
    await response.arrayBuffer();
    if (observed === expected) return;
    await delay(100);
  }
  assert.fail(`Live manager route did not reach HTTP ${expected}`);
}
const selection = name => ({ skillName: name, version: '1.0.0' });
const hashes = async () => Object.fromEntries(await Promise.all(['receipt-skill', 'pending-skill', 'local-skill'].map(async name => {
  const path = join(home, 'skills', name, 'SKILL.md');
  return [name, createHash('sha256').update(await fs.readFile(path)).digest('hex')];
})));

try {
  evidence.dsh = runCli(['--version']).trim();
  runCli(['--profile', 'manager-probe', '--from-default-profile', 'web', '--dump-config']);
  execNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], { cwd: profile, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  const manifestPath = join(profile, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.dsh.profile.bundles.push(verdict.summary.entryName);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writePatch(false);
  const dump = runCli(['--profile', 'manager-probe', '--dump-config']);
  assert.equal((dump.match(/name: ['"]?@heluo\/forge-skills-manager['"]?/g) ?? []).length, 1);
  record('offline profile installation and one composed manager row');
  await start();
  assert.equal((await fetch(origin + prefix + '/state')).status, 401);
  assert.equal((await api('/nacos/list?page=1')).items.length, 2);
  record('real CLI boot and authenticated Connection routes');
  for (const invalid of [{ ...selection('receipt-skill'), root: 'agents' }, { ...selection('receipt-skill'), workspace: join(directory, 'unregistered') }]) {
    const denied = await fetch(origin + prefix + '/nacos/install', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-dsh-skills-manager': '1' }, body: JSON.stringify(invalid) });
    assert.equal((await denied.json()).ok, false);
    assert.equal(downloads.size, 0);
  }
  const reserved = await fetch(origin + prefix + '/create', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-dsh-skills-manager': '1' },
    body: JSON.stringify({ name: 'enterprise-issue-delivery', description: 'Synthetic rejected override', body: 'Synthetic rejected override' }) });
  assert.equal((await reserved.json()).code, 'error.enterprise.reserved');
  record('unregistered and forbidden destinations are rejected before download; formal enterprise name cannot be replaced');
  const lostId = randomUUID();
  await new Promise((accept, reject) => {
    const outgoing = request(origin + prefix + '/nacos/install', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-dsh-skills-manager': '1' } }, response => {
      const statusCode = response.statusCode;
      response.destroy();
      if (statusCode === 200) accept();
      else reject(new Error(`Install returned HTTP ${statusCode}`));
    });
    outgoing.setTimeout(20000, () => outgoing.destroy(new Error('Install request timed out')));
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify({ ...selection('receipt-skill'), operationId: lostId }));
  });
  assert.equal((await status(lostId)).state, 'succeeded');
  await api('/nacos/install', { ...selection('receipt-skill'), operationId: lostId });
  assert.equal(downloads.get('receipt-skill'), 1);
  assert.equal((await snapshot()).roots.find(root => root.key === 'dsh').skills.find(skill => skill.name === 'receipt-skill').enabled, false);
  assert.deepEqual([...await fs.readFile(join(home, 'skills', 'receipt-skill', 'assets', 'binary.dat'))], [0, 255, 17]);
  record('discarded install response reconciles without another download; resources retained and default disabled');
  const pendingId = randomUUID();
  const installing = api('/nacos/install', { ...selection('pending-skill'), operationId: pendingId });
  await Promise.race([pendingEntered, installing.then(() => { throw new Error('Install completed without reaching the pending fixture'); })]);
  assert.equal((await status(pendingId)).state, 'pending');
  const duplicate = await fetch(origin + prefix + '/nacos/install', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-dsh-skills-manager': '1' },
    body: JSON.stringify({ ...selection('pending-skill'), operationId: randomUUID() }) });
  const rejection = await duplicate.json();
  assert.equal(rejection.outcome, 'pending');
  assert.equal(rejection.code, 'error.repo.installState');
  assert.equal(downloads.get('pending-skill'), 1);
  releaseDownload(); await installing;
  assert.equal((await status(pendingId)).state, 'succeeded');
  record('pending download blocks a second request and exposes a read-only receipt');
  await api('/create', { name: 'local-skill', description: 'Synthetic local skill', body: 'Synthetic local instructions.' });
  const mutationId = randomUUID();
  const mutationBody = { root: 'dsh', name: 'local-skill', note: 'synthetic lost response note' };
  const mutationHeaders = { cookie, origin, 'content-type': 'application/json', 'x-dsh-skills-manager': '1', 'x-dsh-skills-operation': mutationId };
  await new Promise((accept, reject) => {
    const outgoing = request(origin + prefix + '/skill-note', { method: 'POST', headers: mutationHeaders }, response => {
      const statusCode = response.statusCode;
      response.destroy();
      if (statusCode === 200) accept();
      else reject(new Error(`Mutation returned HTTP ${statusCode}`));
    });
    outgoing.setTimeout(20000, () => outgoing.destroy(new Error('Mutation request timed out')));
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify(mutationBody));
  });
  const mutationReceipt = await api('/operation-status?operationId=' + mutationId);
  assert.equal(mutationReceipt.state, 'succeeded');
  assert.equal(JSON.parse(await fs.readFile(join(home, 'skills-manager', 'state.json'), 'utf8')).customNotes.dsh['local-skill'], mutationBody.note);
  const changedMutation = await fetch(origin + prefix + '/skill-note', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ ...mutationBody, note: 'synthetic rejected replay' }) });
  assert.equal(changedMutation.status, 400);
  assert.equal((await changedMutation.json()).outcome, 'rejected');
  assert.equal(JSON.parse(await fs.readFile(join(home, 'skills-manager', 'state.json'), 'utf8')).customNotes.dsh['local-skill'], mutationBody.note);
  record('discarded local mutation response has a read-only success receipt and rejects changed replay');
  await Promise.all([
    api('/disable', { root: 'dsh', name: 'local-skill' }), api('/skill-note', { root: 'dsh', name: 'local-skill', note: 'synthetic retained note' }),
    api('/sidebar-entry', { location: 'sidebar' }), ...Array.from({ length: 6 }, (_, index) => api('/category-create', { root: 'dsh', name: `Synthetic category ${index}` })),
  ]);
  const policyPath = join(home, 'skills-manager', 'state.json');
  const state = JSON.parse(await fs.readFile(policyPath, 'utf8'));
  assert.ok(state.disabledSkills.dsh.includes('local-skill'));
  assert.equal(state.customNotes.dsh['local-skill'], 'synthetic retained note');
  assert.equal(state.categories.dsh.length, 6);
  assert.equal(state.entryLocation, 'sidebar');
  record('concurrent HTTP policy, note, category and entry writes are retained');
  const before = await hashes();
  await stop();
  const recordPath = join(home, 'skills-manager', 'repositories.json');
  const records = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  records.catalogInstalls.find(item => typeof item === 'object' && item.name === 'receipt-skill').complete = false;
  await fs.writeFile(recordPath, JSON.stringify(records));
  await start(); await snapshot();
  assert.equal(JSON.parse(await fs.readFile(recordPath, 'utf8')).catalogInstalls.find(item => item.name === 'receipt-skill').complete, true);
  assert.equal((await status(lostId)).state, 'pending');
  assert.deepEqual(await hashes(), before);
  assert.ok(JSON.parse(await fs.readFile(policyPath, 'utf8')).disabledSkills.dsh.includes('local-skill'));
  record('process restart verifies local recovery, preserves user disable and keeps unknown runtime receipt pending');
  const livePid = child.pid;
  await writePatch(true); await waitForRoute(404);
  for (const path of ['/state', '/nacos/list', '/nacos/install-status?operationId=' + lostId]) {
    const response = await fetch(origin + prefix + path, { headers: { cookie } });
    assert.equal(response.status, 404); await response.arrayBuffer();
  }
  assert.deepEqual(await hashes(), before);
  assert.equal(child.pid, livePid);
  record('live disable removes manager routes without restarting Host or deleting user files');
  await writePatch(false); await waitForRoute(200);
  assert.equal((await snapshot()).roots.find(root => root.key === 'dsh').skills.filter(skill => skill.name === 'local-skill').length, 1);
  assert.deepEqual(await hashes(), before);
  assert.equal(child.pid, livePid);
  record('live reactivation registers one working route set without restarting Host');
  await stop();
  execNpm(['uninstall', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', verdict.summary.entryName], { cwd: profile, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  const uninstalled = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  uninstalled.dsh.profile.bundles = uninstalled.dsh.profile.bundles.filter(name => name !== verdict.summary.entryName);
  await fs.writeFile(manifestPath, JSON.stringify(uninstalled, null, 2));
  await fs.writeFile(patch, '[]\n');
  await start();
  const absent = await fetch(origin + prefix + '/state', { headers: { cookie } });
  assert.equal(absent.status, 404); await absent.arrayBuffer();
  assert.deepEqual(await hashes(), before);
  assert.equal(JSON.parse(await fs.readFile(policyPath, 'utf8')).customNotes.dsh['local-skill'], 'synthetic retained note');
  record('offline uninstall removes manager routes without deleting skills, policy or notes');
  evidence.ok = true;
} catch (error) {
  evidence.failure = { name: error.name, code: error.code ?? null, message: String(error.message).replace(/([?&]token=)[^\s&"']+/gu, '$1[redacted]') };
  process.exitCode = 1;
} finally {
  releaseDownload();
  await stop();
  nacos.closeAllConnections();
  await new Promise(accept => nacos.close(accept));
  evidence.finishedAt = new Date().toISOString();
  await fs.writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, evidence: join(directory, 'evidence.json'), ...(evidence.failure ? { failure: evidence.failure } : {}) }));
}
