/**
 * A01 (#20) 宿主探针驱动。
 *
 * 在临时目录生成一层 patch 覆盖，把探针插件挂到目标 DSH 的 sdk profile
 * （stdio JSON-RPC 应用，stdin 关闭即退出），读取探针写入的拟定结果并打印报告。
 *
 * 关键点：sdk profile 在 stdin EOF 后开始卸载，探针跑到中途就会撞上
 * "cannot create effect on inactive context"。因此这里用管道保持 stdin 打开，
 * 等探针写出拟定结果后再关闭 stdin，让宿主自行退出。
 *
 * 用法：node scripts/probe/run-host-probe.mjs
 *   环境：DSH_BIN（默认 dsh）、DSH_HOST_PROBE_PROFILE（默认 sdk）
 * 退出码：0 全部通过；1 有失败项；2 探针未产出结果或环境不具备。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, 'host-probe-plugin.mjs');
const dsh = process.env.DSH_BIN ?? 'dsh';
const profile = process.env.DSH_HOST_PROBE_PROFILE ?? 'sdk';

const version = spawnSync(dsh, ['--version'], { encoding: 'utf8' });
if (version.error !== undefined) {
  console.error(`probe: 无法执行 ${dsh}（${version.error.message}）；本探针需要目标环境已安装 DSH`);
  process.exit(2);
}
const harness = String(version.stdout ?? '').trim();

const dir = mkdtempSync(join(tmpdir(), 'forge-host-probe-'));
const out = join(dir, 'probe-raw.json');
const patch = join(dir, 'probe.patch.yml');
const policyPackage = resolve(here, '../../packages/forge-policy/src/index.mjs');
const bundlePatch = resolve(here, '../../packages/forge-enterprise/cordis.patch.yml');
const protectedDir = resolve(dir, 'protected');
const aliasLink = resolve(dir, 'alias');
mkdirSync(protectedDir, { recursive: true });
writeFileSync(resolve(protectedDir, 'credentials.env'), 'probe-canary-value\n');
let aliasReady = true;
try {
  symlinkSync(protectedDir, aliasLink, 'dir');
} catch {
  aliasReady = false;
}
const gatewayCatalog = [
  "{ action: 'probe.read', kind: 'read', target: 'probe-target', enabled: true }",
  "{ action: 'probe.write', kind: 'write', target: 'probe-target' }",
  "{ action: 'probe.confirm', kind: 'confirm', target: 'probe-target', enabled: true }",
  "{ action: 'probe.fs.read', kind: 'read', target: 'file', enabled: true, path: 'path' }",
];
writeFileSync(
  patch,
  [
    '- insert:',
    "    - id: forge-policy",
    `      name: '${pathToFileURL(policyPackage).href}'`,
    '      config:',
    '        catalog:',
    ...gatewayCatalog.map((entry) => `          - ${entry}`),
    '        audit:',
    '          sink: memory',
    '          allowNonDurable: true',
    '        protectedPaths:',
    `          - '${protectedDir}/**'`,
    '        tools:',
    "          probe_gate_path: 'probe.fs.read'",
    "          probe_gate_read: 'probe.read'",
    "          probe_gate_write: 'probe.write'",
    "          probe_gate_unknown: 'probe.unknown'",
    "          probe_gate_confirm: 'probe.confirm'",
    '    - id: forge-host-probe',
    `      name: '${pathToFileURL(plugin).href}'`,
    '',
  ].join('\n'),
);

// 官方行禁用来自企业组合包自身的补丁文件（不是探针里的副本），基线对照可关掉这一层。
const disableOfficial = process.env.DSH_HOST_PROBE_DISABLE_OFFICIAL !== '0';
const patchArgs = disableOfficial ? ['--patch', patch, '--patch', bundlePatch] : ['--patch', patch];
const command = `${dsh} --profile ${profile} ${patchArgs.join(' ')}`;
console.log(`probe: ${harness} | node ${process.version} | ${process.platform}-${process.arch}`);
console.log(`probe: ${command}  (cwd ${dir})`);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const TIMEOUT_MS = 180_000;

/** 保持 stdin 打开直到探针写出结果，再让宿主退出。 */
async function runHarness() {
  const child = spawn(dsh, ['--profile', profile, ...patchArgs], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_HOST_PROBE_PATHS: JSON.stringify({ protectedDir, aliasLink, aliasReady }),
      DSH_HOST_PROBE_DIR: dir,
      DSH_HOST_PROBE_OUT: out,
      DSH_HOST_PROBE_HARNESS: harness,
      // AC6 傍路检查：即便环境里有官方 API Key，官方模型两条路也应不可用（值本身不记录）。
      DEEPSEEK_API_KEY: 'probe-dummy-key-not-a-real-credential',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  let closed = false;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(out)) {
      closed = true;
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
    return { status: null, signal: 'timeout', stdout, stderr, closed };
  }
  return { status: exit.code, signal: exit.signal, stdout, stderr, closed };
}

const run = await runHarness();

// 组合层对照：同一条 patch 的 --dump-config 结果里，profile 中存在的官方行必须落
// `disabled: true`；profile 中不存在的 id 必须出现 Loader 的 "not found" 警告（警告 ≠ 已禁用）。
const officialIds = ['deepseek-account', 'ui-settings-account', 'llm-deepseek-account', 'llm-deepseek'];
const dumpBase = spawnSync(dsh, ['--profile', profile, '--dump-config'], { encoding: 'utf8' });
const dumpPatched = spawnSync(dsh, ['--profile', profile, ...patchArgs, '--dump-config'], { encoding: 'utf8' });
const baseText = String(dumpBase.stdout ?? '');
const patchedText = String(dumpPatched.stdout ?? '');
const patchedWarnings = String(dumpPatched.stderr ?? '');
const entriesOf = (text) => {
  const map = new Map();
  let current;
  for (const line of text.split('\n')) {
    const matched = /^- id: (.+?)\s*$/u.exec(line);
    if (matched !== null) {
      current = matched[1];
      map.set(current, []);
      continue;
    }
    if (line.startsWith('#')) current = undefined;
    else if (current !== undefined && /^\s+\S/u.test(line)) map.get(current).push(line.trim());
  }
  return map;
};
const baseEntries = entriesOf(baseText);
const patchedEntries = entriesOf(patchedText);
const composition = officialIds.map((id) => {
  const present = baseEntries.has(id);
  const disabledInPatched = (patchedEntries.get(id) ?? []).includes('disabled: true');
  const warned = patchedWarnings.includes(`entry "${id}" not found`);
  return { id, presentInProfile: present, disabledInPatched, warnedWhenAbsent: !present && warned };
});
const compositionOk = composition.every((entry) =>
  entry.presentInProfile ? entry.disabledInPatched : entry.warnedWhenAbsent,
);

// 行级独立性：打上补丁后 disabled 状态发生变化的行必须**只有**被补丁命中的那些行。
const isDisabled = (entries, id) => (entries.get(id) ?? []).some((line) => line === 'disabled: true');
const stateOf = (entries, id) => (entries.has(id) ? isDisabled(entries, id) : undefined);
const changedRows = [...new Set([...baseEntries.keys(), ...patchedEntries.keys()])].filter(
  (id) => stateOf(baseEntries, id) !== stateOf(patchedEntries, id),
);
const matchedIds = composition.filter((entry) => entry.presentInProfile).map((entry) => entry.id);
// 补丁自己 insert 的新行是预期新增；除"命中行"与"新增行"外，任何既有行都不许变状态。
const addedRows = [...patchedEntries.keys()].filter((id) => !baseEntries.has(id));
const unexpectedRows = changedRows.filter((id) => !matchedIds.includes(id) && !addedRows.includes(id));
const independenceOk = unexpectedRows.length === 0;

let report;
try {
  report = JSON.parse(readFileSync(out, 'utf8'));
} catch (error) {
  console.error(`probe: 未读到拟定结果（${error.message}）`);
  console.error(`probe: dsh exit ${run.status} signal ${run.signal}`);
  if (run.stdout?.trim()) console.error(`--- stdout ---\n${run.stdout.trim()}`);
  if (run.stderr?.trim()) console.error(`--- stderr ---\n${run.stderr.trim()}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(2);
}

console.log(`probe: ${report.probe} on ${report.harness} (node ${report.env?.node}, ${report.env?.platform})`);
for (const check of report.checks ?? []) {
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.id}`);
  if (!check.ok) console.log(`     ${JSON.stringify(check.detail)}`);
}
for (const item of report.blocked ?? []) {
  console.log(`blocked ${item.id}: ${item.reason}`);
  console.log(`     ${JSON.stringify(item.evidence)}`);
}
console.log('probe: 官方行禁用（组合层，--dump-config 对照）');
for (const entry of composition) {
  const satisfied = entry.presentInProfile ? entry.disabledInPatched : entry.warnedWhenAbsent;
  const state = entry.presentInProfile
    ? `disabled: true ${entry.disabledInPatched ? '已落地' : '未落地'}`
    : `profile 中不存在，警告 ${entry.warnedWhenAbsent ? '已出现' : '缺失'}`;
  console.log(`${satisfied ? 'ok  ' : 'FAIL'} ${entry.id}: ${state}`);
}
console.log(`probe: composition ${compositionOk ? 'ok' : 'FAIL'}`);
console.log(
  `probe: 行级独立性 ${independenceOk ? 'ok' : 'FAIL'}（命中 ${matchedIds.length} 行，补丁新增 ${addedRows.length} 行，被意外改动的既有行：${unexpectedRows.join(', ') || '无'}）`,
);
console.log(`probe: ${report.passed}/${report.checks?.length ?? 0} checks passed, ${report.blocked?.length ?? 0} blocked${report.crashed ? ` (crashed: ${report.crashed})` : ''}`);
console.log(`probe: evidence kept at ${out}`);
process.exit(report.failed === 0 && report.crashed === undefined && compositionOk && independenceOk ? 0 : 1);
