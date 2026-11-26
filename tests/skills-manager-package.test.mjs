import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parsePackageConfig, readPackageConfig, packageSkillsManager } from '../packages/forge-skills-manager/scripts/package.mjs';
import { buildBundle } from '../scripts/build-enterprise-bundle.mjs';
import { readBundleEntries } from '../scripts/lib/bundle-archive.mjs';
import { execNpm } from '../scripts/lib/bundle-rules.mjs';
import { checkNacosRelease } from '../scripts/lib/nacos-release.mjs';
import { verifyBundle } from '../scripts/verify-enterprise-bundle.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const configuration = (url = 'http://nacos.corp.example/nacos') => [
  `HELUO_NACOS_SERVER_URL=${url}`, 'HELUO_NACOS_NAMESPACE_ID=public',
  'HELUO_NACOS_USERNAME=svc-ci', 'HELUO_NACOS_PASSWORD=" synthetic password "',
].join('\n');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const readPreset = text => ({ nacos: Object.fromEntries([...text.matchAll(/^\s+(serverUrl|namespaceId|username|password|timeoutMs): (.+)$/gmu)].map(([, key, value]) => [key, JSON.parse(value)])) });

test('standalone preset requires all four Nacos fields and rejects unrelated inputs without values in errors', () => {
  assert.equal(parsePackageConfig(configuration()).nacos.password, ' synthetic password ');
  for (const key of ['SERVER_URL', 'NAMESPACE_ID', 'USERNAME', 'PASSWORD']) {
    assert.throws(() => parsePackageConfig(configuration().split('\n').filter(line => !line.startsWith(`HELUO_NACOS_${key}=`)).join('\n')), { code: 'CONFIG_INVALID' });
  }
  for (const line of ['HELUO_IAM_CLIENT_ID=synthetic-hidden-value', 'HELUO_IAM_CLIENT_SECRET=synthetic-hidden-value', 'HELUO_NACOS_USERNAME_ENV=synthetic-hidden-value', 'HELUO_NACOS_TIMEOUT_MS=synthetic-hidden-value', 'HELUO_NACOS_PASSWORD=synthetic-hidden-value']) {
    assert.throws(() => parsePackageConfig(configuration() + '\n' + line), error => !error.message.includes('synthetic-hidden-value'));
  }
  const withUserInfo = new URL('http://nacos.corp.example');
  withUserInfo.username = 'svc-ci';
  withUserInfo.password = 'synthetic-hidden-value';
  for (const value of ['ftp://nacos.corp.example', withUserInfo.href, 'http://nacos.corp.example/?token=synthetic-hidden-value']) {
    assert.throws(() => parsePackageConfig(configuration(value)), { code: 'CONFIG_INVALID' });
  }
});

test('standalone runtime matching accepts its root runtime and rejects changed bytes', () => {
  const runtime = readFileSync(join(repo, 'packages/forge-skills-manager/lib/nacos.js'));
  const options = { installed: true, runtimePath: 'lib/nacos.js', fail };
  const result = checkNacosRelease([{ path: 'lib/nacos.js', content: runtime }], parsePackageConfig(configuration()), options);
  assert.deepEqual(result.embeddedSecrets, ['nacos.password']);
  assert.throws(() => checkNacosRelease([{ path: 'lib/nacos.js', content: Buffer.from('changed') }], parsePackageConfig(configuration()), options), { code: 'NACOS_RUNTIME_MISMATCH' });
});

test('the CLI reads a private file, supports dry-run, and never prints configuration values', () => {
  const work = mkdtempSync(join(tmpdir(), 'forge-skills-preset-cli-'));
  try {
    const file = join(work, 'private.env'); writeFileSync(file, configuration(), { mode: 0o600 });
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
Set-Acl -LiteralPath $env:FORGE_SKILLS_TEST_FILE -AclObject $acl
`], { env: { ...process.env, FORGE_SKILLS_TEST_FILE: file, PSModulePath: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }, stdio: 'pipe', windowsHide: true });
    }
    assert.equal(readPackageConfig(file), configuration());
    const output = join(work, 'output');
    const text = execFileSync(process.execPath, [join(repo, 'packages/forge-skills-manager/scripts/package.mjs'), '--config', file, '--version', '0.1.0-cli.test', '--output', output, '--dry-run'], { encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
    assert.equal(JSON.parse(text).written, false); assert.equal(existsSync(output), false);
    assert.equal(text.includes('synthetic password'), false); assert.equal(text.includes('http://nacos.corp.example'), false);
    assert.throws(() => packageSkillsManager({ configText: configuration(), output: join(repo, 'dist-preset-forbidden'), version: '0.1.0-cli.test' }), /outside/);
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }
});

test('private TGZ carries working Nacos credentials and installs offline without enterprise, IAM or profile config', async () => {
  const work = mkdtempSync(join(tmpdir(), 'forge-skills-preset-test-'));
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/auth/user/login')) {
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      assert.equal(form.get('username'), 'svc-ci'); assert.equal(form.get('password'), ' synthetic password ');
      res.end(JSON.stringify({ accessToken: 'synthetic-read-token', tokenTtl: 1000 }));
    } else { assert.equal(req.headers.authorization, 'Bearer synthetic-read-token'); res.end(JSON.stringify({ code: 0, data: { pageItems: [], totalCount: 0, pagesAvailable: 0, pageNumber: 1 } })); }
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  try {
    const configText = configuration(`http://127.0.0.1:${server.address().port}/nacos`);
    const output = join(work, 'private');
    const preview = packageSkillsManager({ configText, output, version: '0.1.0-corp.test', dryRun: true });
    assert.equal(preview.written, false); assert.equal(existsSync(output), false);
    const made = packageSkillsManager({ configText, output, version: '0.1.0-corp.test' });
    assert.equal(made.written, true); assert.equal(verifyBundle(made.tarball).ok, true);
    assert.equal(JSON.stringify(made).includes('synthetic password'), false);
    assert.equal(readFileSync(join(output, 'packaging-receipt.json'), 'utf8').includes('synthetic password'), false);
    const entries = readBundleEntries(made.tarball, { withContent: true });
    assert.ok(!entries.some(e => e.path.includes('forge-enterprise') || e.path.includes('forge-iam') || e.path.includes('.env')));
    const config = readPreset(entries.find(e => e.path === 'cordis.patch.yml').content.toString());
    assert.deepEqual(config, parsePackageConfig(configText));
    const neutral = buildBundle({ entry: '@heluo/forge-skills-manager', destination: join(work, 'neutral') });
    const before = readBundleEntries(neutral.tarball, { withContent: true });
    // Negative control: the former neutral-only flow fails the exact preset assertion.
    const oldConfig = readPreset(before.find(e => e.path === 'cordis.patch.yml').content.toString());
    assert.throws(() => assert.deepEqual(oldConfig, config), { code: 'ERR_ASSERTION' });
    for (const entry of before.filter(e => !['package.json', 'cordis.patch.yml'].includes(e.path))) {
      const after = entries.find(e => e.path === entry.path);
      assert.deepEqual(after.content, entry.content); assert.equal(after.mode, entry.mode);
    }
    const project = join(work, 'install'); mkdirSync(project);
    writeFileSync(join(work, 'empty-npmrc'), '');
    execNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', made.tarball], {
      cwd: project, env: { ...process.env, npm_config_cache: join(work, 'empty-cache'), npm_config_userconfig: join(work, 'empty-npmrc'), npm_config_registry: 'http://127.0.0.1:9' }, stdio: 'pipe', timeout: 60000,
    });
    const installed = join(project, 'node_modules', '@heluo', 'forge-skills-manager');
    assert.equal(existsSync(join(project, 'node_modules', '@heluo', 'forge-enterprise')), false);
    assert.equal(existsSync(join(project, 'node_modules', '@heluo', 'forge-iam')), false);
    assert.deepEqual(readPreset(readFileSync(join(installed, 'cordis.patch.yml'), 'utf8')), config);
    const { createNacosClient } = await import(pathToFileURL(join(installed, 'lib/nacos.js')).href);
    const client = createNacosClient(config.nacos);
    assert.deepEqual((await client.list()).items, []);
    assert.throws(() => packageSkillsManager({ configText, output, version: '0.1.0-corp.test' }), { code: 'OUTPUT_EXISTS' });
    assert.throws(() => packageSkillsManager({ configText, output: join(work, 'same-version'), version: '0.1.0' }), { code: 'VERSION_UNCHANGED' });
    const unsafe = join(work, 'unsafe.env'); writeFileSync(unsafe, configText, { mode: 0o644 });
    assert.throws(() => readPackageConfig(unsafe), { code: 'CONFIG_PERMISSIONS' });
  } finally {
    server.closeAllConnections(); await new Promise(accept => server.close(accept));
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});
