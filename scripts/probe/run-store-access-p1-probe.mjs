/**
 * 步骤 0 P1 探针驱动：企业装配下的 IAM 存档/取票拦截取证。
 *
 * 与 P0 探针的区别：不注册任何判定插件，改用真实补丁层挂载
 * `@heluo/forge-credentials-keychain`（提供 `credentials-store-location`）与
 * `@heluo/forge-policy`（两条规则全开），只追加一个派发工具调用的探针插件。
 *
 * 用法：
 *   node scripts/probe/run-store-access-p1-probe.mjs [--label 名称] [--patch 补丁.yml]...
 *
 * 默认补丁层为 `packages/forge-enterprise/cordis.patch.yml`（企业装配）。
 * 退出码：0 全部通过；1 有失败；2 环境/引导失败。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const plugin = join(here, 'store-access-p1-plugin.mjs');
const dsh = process.env.DSH_BIN ?? 'dsh';
const harness = process.env.DSH_HOST_PROBE_HARNESS ?? `dsh ${spawnSync(dsh, ['-V'], { encoding: 'utf8' }).stdout.trim()}`;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function args(name) {
  const out = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1] !== undefined) out.push(process.argv[index + 1]);
  }
  return out;
}

const label = arg('--label', 'enterprise');
const patches = args('--patch').length > 0
  ? args('--patch').map((path) => resolve(path))
  : [join(repo, 'packages', 'forge-enterprise', 'cordis.patch.yml')];

const dir = mkdtempSync(join(tmpdir(), 'forge-p1-'));
const home = join(dir, 'home');
const profile = 'p1';
const storeDir = join(dir, 'store');
const dbPath = join(storeDir, 'credentials.sqlite');
const keyDir = `${storeDir}.keys`;
const out = join(dir, 'probe-raw.json');
mkdirSync(storeDir, { recursive: true });
mkdirSync(keyDir, { recursive: true });
writeFileSync(join(dir, 'outside.txt'), 'outside-ok\n');

// 独立 DSH_HOME，从 sdk 模板引导；不碰用户 profile。
const bootstrap = spawnSync(dsh, ['--profile', profile, '--from-default-profile', 'sdk', '--dump-config'], {
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home },
});
if (bootstrap.status !== 0 || !existsSync(join(home, 'profiles', profile))) {
  console.error(`probe: 无法引导 ${profile} profile：${String(bootstrap.stderr ?? '').trim().slice(0, 400)}`);
  process.exit(2);
}

// 补丁层按包名插入 `@heluo/*`；把本仓库的包链进 profile 的 node_modules。
const scope = join(home, 'profiles', profile, 'node_modules', '@heluo');
mkdirSync(scope, { recursive: true });
for (const pkg of ['forge-policy', 'forge-credentials-keychain', 'forge-iam', 'forge-engineering', 'forge-devops', 'forge-gitee', 'forge-market', 'forge-brand']) {
  const source = join(repo, 'packages', pkg);
  if (existsSync(source)) cpSync(source, join(scope, pkg), { recursive: true, dereference: false });
}

const overlay = join(dir, 'probe-overlay.yml');
writeFileSync(
  overlay,
  [
    ...(args('--keychain-default').length > 0 ? [] : [
      '# 让 keychain 使用临时目录：CLI 与 Host 的目录真源在探针里指向同一处。',
      '- id: heluo-credentials-keychain',
      '  config:',
      `    storeDirectory: '${storeDir}'`,
    ]),
    ...(args('--enable-rules').length > 0 ? [
      '# 探针显式打开两条规则（默认启用未执行：P1-D 未通过）。',
      '- id: heluo-policy',
      '  config:',
      '    rules:',
      '      denyIamStoreAccess: true',
      '      denyIamTokenAccess: true',
    ] : []),
    '- insert:',
    '    - id: forge-store-access-p1-probe',
    `      name: '${pathToFileURL(plugin).href}'`,
    '',
  ].join('\n'),
);

const TIMEOUT_MS = 120_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const env = {
  ...process.env,
  DSH_HOME: home,
  HELUO_FORGE_STORE_DIRECTORY: storeDir,
  DSH_HOST_PROBE_DIR: dir,
  DSH_HOST_PROBE_OUT: out,
  DSH_HOST_PROBE_HARNESS: harness,
  DSH_HOST_PROBE_LABEL: label,
  DSH_HOST_PROBE_REPO: repo,
  DSH_HOST_PROBE_STORE: JSON.stringify({ storeDir, dbPath, keyDir }),
};

const argv = ['--profile', profile, ...patches.flatMap((path) => ['--patch', path]), '--patch', overlay];
const child = spawn(dsh, argv, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env });
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => (stdout += chunk));
child.stderr.on('data', (chunk) => (stderr += chunk));
const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  if (existsSync(out)) {
    child.stdin.end();
    break;
  }
  const raced = await Promise.race([exited.then(() => 'exited'), sleep(200).then(() => 'tick')]);
  if (raced === 'exited') break;
}
const exit = await Promise.race([exited, sleep(10_000).then(() => undefined)]);
if (exit === undefined) {
  child.kill('SIGKILL');
  await exited;
}

if (!existsSync(out)) {
  console.error(`probe: 没有产出 ${out}`);
  console.error(String(stderr).trim().slice(-2000));
  process.exit(2);
}

const report = JSON.parse(await (await import('node:fs/promises')).readFile(out, 'utf8'));
report.label = label;
report.patches = patches;
report.dir = dir;
report.exit = exit?.code ?? null;
report.stderrTail = String(stderr).trim().slice(-4000);
writeFileSync(join(dir, 'probe-report.json'), JSON.stringify(report, null, 2));

if (report.crashed !== undefined) {
  console.error(`probe: 崩溃：${report.crashed}`);
  process.exit(1);
}

for (const check of report.checks) {
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.id}`);
  if (!check.ok) console.log(`     ${JSON.stringify(check.detail).slice(0, 400)}`);
}
console.log(`\n${label}: ${report.passed}/${report.checks.length} passed (exit ${report.exit})`);
process.exit(report.failed === 0 ? 0 : 1);
