/**
 * #97 宿主探针驱动（forge-skill-nacos）。
 *
 * 流程：起本地仿 Nacos → 备好临时 `$DSH_HOME`（.credentials.yaml 预写
 * `skill-nacos/probe-cred` grant 记录与测试项目目录）→ 生成一层 patch 把
 * 目标插件（file URL 直指源码）与探针插件挂到 sdk profile → 等
 * `--dump-config` 级别的组合加载完成后由探针写结果文件 → 打印报告。
 *
 * 隔离：子进程 DSH_HOME 指向临时目录，台账与受管目录不落用户主目录；
 * 会话与存储根同样覆盖到临时目录。stdin 保持打开直到结果落盘（同
 * run-host-probe 的 sdk 卸载语义）。
 *
 * 用法：node scripts/probe/run-skill-nacos-probe.mjs
 *   环境：DSH_BIN（默认 dsh）、DSH_SKILL_NACOS_PROBE_PROFILE（默认 sdk）
 * 退出码：0 全部通过；1 有失败项；2 探针未产出结果或环境不具备。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockNacos, skillPackage } from '../../packages/forge-skill-nacos/test/helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, '../../packages/forge-skill-nacos/src/index.mjs');
const probePlugin = resolve(here, 'skill-nacos-probe-plugin.mjs');
const dsh = process.env.DSH_BIN ?? 'dsh';
const profile = process.env.DSH_SKILL_NACOS_PROBE_PROFILE ?? 'sdk';

const version = spawnSync(dsh, ['--version'], { encoding: 'utf8' });
if (version.error !== undefined) {
  console.error(`probe: 无法执行 ${dsh}（${version.error.message}）；本探针需要目标环境已安装 DSH`);
  process.exit(2);
}
const harness = String(version.stdout ?? '').trim();

const SKILLS = [
  {
    name: 'code-review-std',
    description: '提交前代码评审标准流程',
    versions: [{ version: '1.5.0', status: 'online', updateTime: 2, zip: skillPackage('code-review-std', { version: '1.5.0', description: '提交前代码评审标准流程', extra: [{ path: 'checklist.md', data: '# 评审清单\n' }] }) }],
  },
  { name: 'api-doc-gen', description: '接口文档生成', versions: [{ version: '2.0.0', status: 'online', updateTime: 1, zip: skillPackage('api-doc-gen', { version: '2.0.0' }) }] },
];
const server = await startMockNacos({ skills: SKILLS });

const dir = mkdtempSync(join(tmpdir(), 'forge-skill-nacos-probe-'));
const out = join(dir, 'probe-raw.json');
const dshHome = join(dir, 'home');
const projectRoot = join(dir, 'project');
const insideProject = join(projectRoot, 'src');
mkdirSync(join(projectRoot, '.git'), { recursive: true });
mkdirSync(insideProject, { recursive: true });
writeFileSync(join(projectRoot, '.git', 'config'), '[core]\n', 'utf8');
mkdirSync(join(dshHome, '.dsh'), { recursive: true }); // 占位，避免宿主对空 home 的路径差异
writeFileSync(join(dshHome, '.credentials.yaml'), [
  'version: 1',
  'records:',
  '  skill-nacos/probe-cred:',
  '    kind: grant',
  '    payload:',
  '      username: nacos',
  '      password: nacos',
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600 });

const patch = join(dir, 'probe.patch.yml');
writeFileSync(patch, [
  '- insert:',
  '    - id: forge-skill-nacos',
  `      name: '${pathToFileURL(plugin).href}'`,
  '      config:',
  `        endpoint: '${server.url}'`,
  "        namespaceId: 'skill-prod'",
  "        credentialRecordId: 'probe-cred'",
  '        catalogRefreshIntervalMs: 0',
  '    - id: forge-skill-nacos-probe',
  `      name: '${pathToFileURL(probePlugin).href}'`,
  '- id: session-persistence-jsonl',
  '  config:',
  `    root: '${join(dir, 'sessions')}'`,
  '- id: storage-json',
  '  config:',
  `    root: '${join(dir, 'storages')}'`,
  '',
].join('\n'));

const command = `${dsh} --profile ${profile} --patch ${patch}`;
console.log(`probe: ${harness} | node ${process.version} | ${process.platform}-${process.arch}`);
console.log(`probe: ${command}  (cwd ${dir})`);
console.log(`probe: mock nacos ${server.url} | DSH_HOME ${dshHome}`);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const TIMEOUT_MS = 180_000;

async function runHarness() {
  const child = spawn(dsh, ['--profile', profile, '--patch', patch], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_SKILL_NACOS_PROBE_OUT: out,
      DSH_SKILL_NACOS_PROBE_PROJECT_ROOT: projectRoot,
      DSH_SKILL_NACOS_PROBE_INSIDE: insideProject,
      DSH_SKILL_NACOS_PROBE_OUTSIDE: join(dir, 'elsewhere'),
      DSH_SKILL_NACOS_PROBE_HARNESS: harness,
    },
  });
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
    return { status: null, signal: 'timeout', stdout, stderr };
  }
  return { status: exit.code, signal: exit.signal, stdout, stderr };
}

const run = await runHarness();
await server.close();

let report;
try {
  report = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(out, 'utf8')));
} catch (error) {
  console.error(`probe: 未读到拟定结果（${error.message}）`);
  console.error(`probe: dsh exit ${run.status} signal ${run.signal}`);
  if (run.stdout?.trim()) console.error(`--- stdout ---\n${run.stdout.trim().slice(-4000)}`);
  if (run.stderr?.trim()) console.error(`--- stderr ---\n${run.stderr.trim().slice(-4000)}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(2);
}

console.log(`probe: ${report.probe} on ${report.harness} (node ${report.env?.node}, ${report.env?.platform})`);
for (const item of report.checks ?? []) {
  console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.id}`);
  if (!item.ok) console.log(`     ${JSON.stringify(item.detail)}`);
}
const hostWarnings = (run.stderr ?? '').split('\n').filter((line) => /warn|error|fail/i.test(line) && !/ExperimentalWarning|deprecat/i.test(line)).slice(-10);
if (hostWarnings.length > 0) console.log(`probe: host warnings:\n  ${hostWarnings.join('\n  ')}`);
console.log(`probe: ${report.passed}/${report.checks?.length ?? 0} checks passed`);
console.log(`probe: evidence kept at ${out}`);
process.exit(report.failed === 0 ? 0 : 1);
