/**
 * 步骤 0 探针驱动：在 dev profile（从 sdk 模板引导，独立 DSH_HOME）上取证
 * IAM 存档访问的两类事实，数据全部为临时目录里的合成 SQLite 库。
 *
 * 轮次 A（P0-A / P0-B）：装探针判定，派发 read/write/edit/bash/terminal_send/run_code，
 *   断言拒绝生效、工具体零执行、库未改动。
 * 轮次 B/C/D（P0-C）：不装判定，改由执行环境判定，记录 `read-only`、
 *   `workspace-write`、`danger-full-access` 三种模式对存档目录与工作区的读/写结果。
 *
 * 用法：node scripts/probe/run-store-access-p0-probe.mjs
 *   环境：DSH_BIN（默认 dsh）、DSH_HOST_PROBE_PROFILE（默认 dev）
 * 退出码：0 断言全通过；1 有失败项；2 环境不具备或探针未产出结果。
 */
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, 'store-access-p0-plugin.mjs');
const dsh = process.env.DSH_BIN ?? 'dsh';
const profile = process.env.DSH_HOST_PROBE_PROFILE ?? 'dev';
const MODES = ['read-only', 'workspace-write', 'danger-full-access'];

const version = spawnSync(dsh, ['--version'], { encoding: 'utf8' });
if (version.error !== undefined) {
  console.error(`probe: 无法执行 ${dsh}（${version.error.message}）；本探针需要目标环境已安装 DSH`);
  process.exit(2);
}
const harness = String(version.stdout ?? '').trim();

const dir = mkdtempSync(join(tmpdir(), 'forge-store-p0-'));
const home = join(dir, 'dsh-home');
const workspace = join(dir, 'workspace');
const storeDir = join(dir, 'iam-store');
const keyDir = `${storeDir}.keys`;
const dbPath = join(storeDir, 'credentials.sqlite');
// 执行环境轮用独立 store：放在用户主目录下的合成目录，贴近真实存档位置（$TMPDIR 可能被算进可写根）。
const envStoreRoot = mkdtempSync(join(homedir(), '.forge-p0-sandbox-'));
const envStoreDir = join(envStoreRoot, 'iam-store');
const envDbPath = join(envStoreDir, 'credentials.sqlite');
mkdirSync(workspace, { recursive: true });
mkdirSync(storeDir, { recursive: true });
mkdirSync(keyDir, { recursive: true });
writeFileSync(join(keyDir, 'keyring.json'), JSON.stringify({ probe: 'synthetic-keyring' }, null, 2));
writeFileSync(join(storeDir, 'index-state.json'), JSON.stringify({ probe: 'synthetic-index' }));
writeFileSync(join(workspace, 'inside.txt'), 'inside-ok\n');
writeFileSync(join(dir, 'outside.txt'), 'outside-ok\n');

// 真实合成库：records 里有 canary 明文，future_table 模拟后续新增的表。
const seed = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("create table records (ref text primary key, value text not null)");
db.exec("create table future_table (id integer primary key, payload text)");
db.exec("insert into records (ref, value) values ('canary', 'canary-record-value'), ('session', 'synthetic-session')");
db.exec("insert into future_table (payload) values ('future-row')");
db.close();`,
  ],
  { encoding: 'utf8' },
);
if (seed.status !== 0) {
  console.error(`probe: 合成库创建失败：${seed.stderr.trim()}`);
  process.exit(2);
}

// 复制一份到 /tmp 下的环境轮 store：judge=false 轮只观察沙箱行为，不碰判定轮的库。
mkdirSync(envStoreDir, { recursive: true });
mkdirSync(`${envStoreDir}.keys`, { recursive: true });
cpSync(dbPath, envDbPath);
cpSync(join(storeDir, 'index-state.json'), join(envStoreDir, 'index-state.json'));
cpSync(join(keyDir, 'keyring.json'), join(`${envStoreDir}.keys`, 'keyring.json'));

// dev profile 从 sdk 模板引导（独立 DSH_HOME，不碰用户 profile）。
const bootstrap = spawnSync(dsh, ['--profile', profile, '--from-default-profile', 'sdk', '--dump-config'], {
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home },
});
if (bootstrap.status !== 0 || !existsSync(join(home, 'profiles', profile))) {
  console.error(`probe: 无法引导 ${profile} profile：${String(bootstrap.stderr ?? '').trim().slice(0, 400)}`);
  process.exit(2);
}

const patch = join(dir, 'probe.patch.yml');
writeFileSync(
  patch,
  ['- insert:', '    - id: forge-store-access-p0-probe', `      name: '${pathToFileURL(plugin).href}'`, ''].join('\n'),
);

const TIMEOUT_MS = 120_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function runPass({ tag, judge, mode, cwd, store }) {
  const out = join(dir, `probe-raw-${tag}.json`);
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_HOST_PROBE_DIR: dir,
    DSH_HOST_PROBE_OUT: out,
    DSH_HOST_PROBE_HARNESS: harness,
    DSH_HOST_PROBE_STORE: JSON.stringify(store),
    DSH_PERMISSION_MODE: mode,
    DSH_HOST_PROBE_NO_JUDGE: judge ? '0' : '1',
  };
  const child = spawn(dsh, ['--profile', profile, '--patch', patch], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
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
    try {
    return JSON.parse(readFileSync(out, 'utf8'));
  } catch (error) {
    console.error(`probe[${tag}]: 未读到结果（${error.message}）；exit ${exit?.code} signal ${exit?.signal}`);
    if (stdout.trim()) console.error(`--- stdout ---\n${stdout.trim().slice(0, 2000)}`);
    if (stderr.trim()) console.error(`--- stderr ---\n${stderr.trim().slice(0, 2000)}`);
    return undefined;
  }
}

console.log(`probe: ${harness} | node ${process.version} | ${process.platform}-${process.arch}`);

const judgement = await runPass({ tag: 'p0', judge: true, mode: MODES[1], cwd: dir, store: { storeDir, dbPath, keyDir } });
if (judgement === undefined) process.exit(2);
console.log(`\n== 轮次 A：探针判定（mode ${MODES[1]}）==`);
for (const check of judgement.checks ?? []) {
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.id}`);
  if (!check.ok) console.log(`     ${JSON.stringify(check.detail)}`);
}
for (const item of judgement.blocked ?? []) console.log(`blocked ${item.id}: ${item.reason}`);
console.log(`probe: denials=${judgement.denials ?? 0}, ${judgement.passed}/${judgement.checks?.length ?? 0} checks passed`);

const observations = [];
for (const mode of MODES) {
  const pass = await runPass({ tag: `env-${mode}`, judge: false, mode, cwd: workspace, store: { storeDir: envStoreDir, dbPath: envDbPath, keyDir: `${envStoreDir}.keys` } });
  if (pass === undefined) process.exit(2);
  observations.push(...(pass.observations ?? []));
}

console.log('\n== 轮次 B/C/D：执行环境（不装判定）==');
const byId = new Map();
for (const row of observations) {
  const cells = byId.get(row.id) ?? new Map();
  cells.set(row.mode, row);
  byId.set(row.id, cells);
}
const width = Math.max(...[...byId.keys()].map((id) => id.length));
console.log(`${'observation'.padEnd(width)}  ${MODES.map((mode) => mode.padEnd(18)).join(' ')}`);
for (const [id, cells] of byId) {
  const line = MODES.map((mode) => {
    const row = cells.get(mode);
    if (row === undefined) return '—'.padEnd(18);
    const text = String(row.text ?? '');
    const sandboxDenied = /Operation not permitted|file access denied/u.test(text);
    const verdict = sandboxDenied
      ? 'denied'
      : row.refusedBinary === true
        ? 'refused-binary'
        : row.fileCreated === true
          ? 'allowed+file'
          : row.isError === true
            ? 'denied'
            : 'allowed';
    const leak = row.canaryLeaked === true ? '+canary' : '';
    const index = row.textHasIndex === true ? '+text' : '';
    return `${verdict}${leak}${index}`.padEnd(18);
  });
  console.log(`${id.padEnd(width)}  ${line.join(' ')}`);
}
const keep = join(dir, 'probe-evidence');
writeFileSync(keep, JSON.stringify({ harness, judgement, observations }, null, 2));
rmSync(envStoreRoot, { recursive: true, force: true });
console.log(`\nprobe: evidence at ${keep}`);
process.exit((judgement.failed ?? 0) === 0 && (judgement.passed ?? 0) > 0 ? 0 : 1);
