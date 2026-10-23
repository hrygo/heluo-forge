/**
 * A01 (#20) 宿主探针驱动。
 *
 * 在临时目录生成一层 patch 覆盖，把探针插件挂到目标 DSH 的 sdk profile
 * （stdio JSON-RPC 应用，stdin 关闭即退出），读取探针写入的拟定结果并打印报告。
 *
 * 用法：node scripts/probe/run-host-probe.mjs
 *   环境：DSH_BIN（默认 dsh）、DSH_HOST_PROBE_PROFILE（默认 sdk）
 * 退出码：0 全部通过；1 有失败项；2 探针未产出结果或环境不具备。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

const command = `${dsh} --profile ${profile} --patch ${patch}`;
console.log(`probe: ${harness} | node ${process.version} | ${process.platform}-${process.arch}`);
console.log(`probe: ${command}  (cwd ${dir})`);

const run = spawnSync(dsh, ['--profile', profile, '--patch', patch], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  timeout: 180_000,
  env: {
    ...process.env,
    DSH_HOST_PROBE_PATHS: JSON.stringify({ protectedDir, aliasLink, aliasReady }),
    DSH_HOST_PROBE_DIR: dir,
    DSH_HOST_PROBE_OUT: out,
    DSH_HOST_PROBE_HARNESS: harness,
  },
});

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
console.log(`probe: ${report.passed}/${report.checks?.length ?? 0} checks passed, ${report.blocked?.length ?? 0} blocked${report.crashed ? ` (crashed: ${report.crashed})` : ''}`);
console.log(`probe: evidence kept at ${out}`);
process.exit(report.failed === 0 && report.crashed === undefined ? 0 : 1);
