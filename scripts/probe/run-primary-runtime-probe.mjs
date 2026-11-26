#!/usr/bin/env node
/**
 * 内置运行时接入探针（CORP-DSH-PLAN-026 §3 #9，CORP-DSH-DESIGN-025）。
 *
 * 回答一个问题：桌面壳随包携带的运行时，能否在不修改上游的前提下到达 `web` profile 的 agent。
 * 在临时 `DSH_HOME` 里引导 `web` profile，把探针插件挂在末尾，在宿主进程内核对
 * `load_workspace_dependencies` 的注册、可见性、首次调用的安装、Office 技能的指向，
 * 以及 agent 自己的 shell 能否用返回的 Python 跑起 Office 库；再跑一组不带解锁的基线作对照。
 *
 * 解锁有两种交付方式，探针默认用第一种，给出 `--bundle` 时用第二种：
 *   - `--patch` 覆盖层携带两行，原文取自 `packages/forge-enterprise/cordis.patch.yml`；
 *   - 安装给出的企业底座包，由它的补丁层交付这两行（与首启安装器同一条路径）。
 *
 * 用法：
 *   node scripts/probe/run-primary-runtime-probe.mjs --resources <暂存好的 resources 目录> \
 *     [--electron <应用二进制：以 Node 模式运行 dsh>] [--bundle <heluo-forge-enterprise-*.tgz>] \
 *     [--keep] [--out <path>]
 *   node scripts/probe/run-primary-runtime-probe.mjs --app <打出来的 .app> \
 *     [--bundle <heluo-forge-enterprise-*.tgz>] [--keep] [--out <path>]
 *   resources 由 scripts/stage-desktop-payload.mjs 与 scripts/stage-primary-runtime.mjs 暂存，
 *   其中已有 `dsh/node_modules` 与 `primary-runtime/runtime.json`。给出 `--app` 时以打出来的应用包为准：
 *   dsh 闭包与载荷取自包内，并用应用自己的 Electron（Node 模式）与 app.asar 里的壳入口运行，
 *   与桌面壳的启动方式一致；目前只认 macOS 的 .app。
 * 退出码：0 全部通过；1 有失败项；2 前置条件不具备。
 *
 * 不外联：不接真实模型或网关；web 服务器只绑 127.0.0.1 上的空闲端口。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DSH_ENTRY_PARTS, PRIMARY_RUNTIME_DIR } from '../../services/forge-desktop/src/layout.mjs';
import { RUNTIME_ROWS } from '../../packages/forge-enterprise/src/reflow.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const plugin = pathToFileURL(resolve(here, 'primary-runtime-probe-plugin.mjs')).href;
const enterprisePatch = join(repo, 'packages', 'forge-enterprise', 'cordis.patch.yml');
const PROFILE = 'web';
const INSTALL_ROOT = ['dsh-runtimes', 'dsh-primary-runtime'];
const TIMEOUT_MS = 180_000;
const TOOL = 'load_workspace_dependencies';


/** 通用底座补丁层里的顶层行，按 id 原文取出：探针测的就是随包交付的那两行。 */
function rowsOf(text, ids) {
  const lines = text.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^- id: (.+)$/u.exec(lines[index]);
    if (match === null || !ids.includes(match[1].trim())) continue;
    const block = [lines[index]];
    for (let next = index + 1; next < lines.length && !/^- /u.test(lines[next]); next += 1) block.push(lines[next]);
    blocks.push(block.join('\n').trimEnd());
  }
  return blocks;
}

function parseArguments(argv) {
  const options = { resources: undefined, app: undefined, electron: undefined, bundle: undefined, keep: false, out: undefined };
  const valued = new Map([['--resources', 'resources'], ['--app', 'app'], ['--electron', 'electron'], ['--bundle', 'bundle'], ['--out', 'out']]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep') {
      options.keep = true;
      continue;
    }
    if (!valued.has(argument) || argv[index + 1] === undefined) {
      console.error(`probe: 无法识别的参数 ${argument}（--help 查看文件头部的用法）`);
      process.exit(2);
    }
    options[valued.get(argument)] = argv[index + 1];
    index += 1;
  }
  return options;
}

/** 一个空闲的本机端口：web 服务器的默认端口是固定的，探针必须自己指定。 */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

const fileCount = (directory) => readdirSync(directory, { withFileTypes: true }).reduce((count, entry) => count + 1 + (entry.isDirectory() ? fileCount(join(directory, entry.name)) : 0), 0);
/** 一次派发的全部文字：结果正文，加上出错时的错误说明。 */
const textOf = (hit) => [hit?.text, hit?.error?.message].filter((part) => typeof part === 'string').join(' ');

const options = parseArguments(process.argv.slice(2));
if (options.app !== undefined && options.electron !== undefined) {
  console.error('probe: --app 与 --electron 不能同用：应用包用自己的 Electron');
  process.exit(2);
}
if (options.app === undefined && typeof options.resources !== 'string') {
  console.error('probe: 需要 --resources <暂存好的 resources 目录> 或 --app <打出来的 .app>');
  process.exit(2);
}

/** 以打出来的应用包为准时的各个位置：可执行文件名取自 Info.plist。 */
function packagedApp(appPath) {
  if (process.platform !== 'darwin') {
    console.error('probe: --app 目前只支持 macOS 的 .app');
    process.exit(2);
  }
  const contents = join(resolve(appPath), 'Contents');
  const plist = join(contents, 'Info.plist');
  if (!existsSync(plist)) {
    console.error(`probe: 不是 macOS 的 .app（没有 ${plist}）`);
    process.exit(2);
  }
  const executable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/u.exec(readFileSync(plist, 'utf8'))?.[1];
  if (executable === undefined) {
    console.error('probe: Info.plist 里没有 CFBundleExecutable');
    process.exit(2);
  }
  return { command: join(contents, 'MacOS', executable), resources: join(contents, 'Resources'), archive: join(contents, 'Resources', 'app.asar') };
}

const packaged = options.app === undefined ? undefined : packagedApp(options.app);
const resources = packaged?.resources ?? resolve(options.resources);
// 在应用包里，壳的入口在 app.asar 之内；普通 Node 进程看不到归档内部，所以只核对归档本身在不在。
const dsh = packaged === undefined ? join(resources, ...DSH_ENTRY_PARTS) : join(resources, 'app.asar', 'src', 'embedded-cli.mjs');
const payload = join(resources, PRIMARY_RUNTIME_DIR);
const command = packaged?.command ?? options.electron ?? process.execPath;
const missing = [
  ...(packaged === undefined ? [[dsh, 'dsh 入口（先跑 scripts/stage-desktop-payload.mjs）']] : [[packaged.archive, '应用包里的 app.asar']]),
  [join(payload, 'runtime.json'), '内置运行时载荷（先跑 scripts/stage-primary-runtime.mjs）'],
  [enterprisePatch, '通用底座补丁层'],
  ...(!existsSync(command) ? [[command, '运行 dsh 的可执行文件']] : []),
  ...(options.bundle !== undefined && !existsSync(options.bundle) ? [[options.bundle, '企业底座包']] : []),
].filter(([path]) => !existsSync(path));
if (missing.length > 0) {
  for (const [path, what] of missing) console.error(`probe: 缺少${what}：${path}`);
  process.exit(2);
}
const nodeMode = command === process.execPath ? {} : { ELECTRON_RUN_AS_NODE: '1' };
// 两个 id 取自检测器模块，与通用底座的守护用例同源。
const unlock = rowsOf(readFileSync(enterprisePatch, 'utf8'), RUNTIME_ROWS);
if (unlock.length !== RUNTIME_ROWS.length) {
  console.error(`probe: 通用底座补丁层里找不到 ${RUNTIME_ROWS.join('、')} 两行`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'forge-primary-runtime-probe-'));
const checks = [];
const record = (id, ok, detail) => {
  checks.push({ id, ok: ok === true, detail });
  console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${id}`);
  if (ok !== true) console.log(`     ${JSON.stringify(detail).slice(0, 700)}`);
};

/** 引导 profile，必要时安装企业底座包，再带探针启动一次；返回探针写出的事实。 */
function launch(home, { unlocked, label }) {
  const work = join(dir, label);
  mkdirSync(work, { recursive: true });
  const env = { ...process.env, ...nodeMode, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', npm_config_prefer_offline: 'true' };
  const bootstrap = spawnSync(command, [dsh, '--profile', PROFILE, '--dump-config'], { encoding: 'utf8', env, cwd: work });
  if (bootstrap.status !== 0 || !existsSync(join(home, 'profiles', PROFILE))) {
    return { ok: false, why: `profile 引导失败 exit=${bootstrap.status}: ${(bootstrap.stderr ?? '').slice(-400)}` };
  }
  if (unlocked && options.bundle !== undefined) {
    const installed = spawnSync(command, [dsh, 'plugin', '--profile', PROFILE, 'add', resolve(options.bundle)], { encoding: 'utf8', env, cwd: work });
    record('bundle-installed', installed.status === 0, `exit=${installed.status} ${(installed.stderr || installed.stdout || '').slice(-400)}`);
    const bundles = JSON.parse(readFileSync(join(home, 'profiles', PROFILE, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? [];
    record('bundle-listed-last', bundles.at(-1) === '@heluo/forge-enterprise', bundles);
  }
  // 给出 --bundle 时两行由企业底座包交付，覆盖层里只留探针插件。
  const overlay = join(work, 'probe.patch.yml');
  writeFileSync(overlay, `# 内置运行时探针的覆盖层（合成数据，不外联）。\n${unlocked && options.bundle === undefined ? `${unlock.join('\n\n')}\n` : ''}- insert:\n    - id: forge-primary-runtime-probe\n      name: '${plugin}'\n`);
  const out = join(work, 'probe-raw.json');
  return freePort().then(
    (port) =>
      new Promise((resolveLaunch) => {
        const child = spawn(command, [dsh, '--profile', PROFILE, '--patch', overlay, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
          cwd: work,
          env: {
            ...env,
            DSH_PERMISSION_MODE: 'danger-full-access',
            HELUO_RUNTIME_PROBE_OUT: out,
            HELUO_RUNTIME_PROBE_DIR: work,
            HELUO_RUNTIME_PROBE_MODULES: join(resources, ...DSH_ENTRY_PARTS.slice(0, 2)),
            ...(unlocked ? { DSH_PRIMARY_RUNTIME: payload } : {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (part) => {
          stderr += part;
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolveLaunch({ ok: true, code, stderr, facts: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined });
        });
      }),
  );
}

async function scenario({ unlocked, label }) {
  const home = mkdtempSync(join(dir, 'home-'));
  const root = join(home, ...INSTALL_ROOT);
  const first = await launch(home, { unlocked, label });
  if (!first.ok) {
    record(`${label}: profile 引导`, false, first.why);
    return;
  }
  const facts = first.facts ?? {};
  const load = facts.load ?? {};
  const skill = facts.skill ?? {};
  const bash = facts.bash ?? {};
  record(`${label}: 探针在宿主内运行`, facts.fatal === undefined && first.code === 0, `exit=${first.code} fatal=${facts.fatal ?? '-'} stderr=${first.stderr.slice(-300)}`);
  record(`${label}: 建出带默认 preset 的真实 agent 会话`, facts.compositionError === undefined && facts.agentCreateError === undefined && facts.presetMounted === true, {
    compositionError: facts.compositionError,
    agentCreateError: facts.agentCreateError,
    preset: facts.preset,
    presetMounted: facts.presetMounted,
  });
  record(`${label}: Loader 对这两行没有告警`, !/workspace-dependencies|skill-office|not found|mismatch/iu.test(first.stderr), first.stderr.split('\n').filter((line) => /workspace-dependencies|skill-office|not found|mismatch/iu.test(line)).slice(0, 4));
  if (!unlocked) {
    record('基线：工具没有注册，对 agent 不可见', facts.hostSeesTool === false && facts.agentSeesTool === false, { hostSeesTool: facts.hostSeesTool, agentSeesTool: facts.agentSeesTool });
    record('基线：agent 的调用被拒', load.isError === true, textOf(load).slice(0, 200));
    record('基线：Office 技能指向用户自己的 Python', skill.isError === false && !/load_workspace_dependencies/u.test(textOf(skill)) && /Python/u.test(textOf(skill)), textOf(skill).slice(0, 300));
    record('基线：Harness home 下没有安装任何东西', !existsSync(join(home, ...INSTALL_ROOT.slice(0, 1))));
    return;
  }
  record('解锁：工具在宿主层注册', facts.hostSeesTool === true, { hostSeesTool: facts.hostSeesTool, primaryRuntime: facts.primaryRuntime });
  record('解锁：工具对 agent 可见', facts.agentSeesTool === true);
  record('解锁：agent 的调用成功', load.isError === false && /"python"/u.test(textOf(load)), textOf(load).slice(0, 300));
  record('解锁：首次调用把载荷安装到 Harness home', typeof facts.python === 'string' && facts.python.startsWith(`${root}/`) && existsSync(join(root, 'runtime.json')), { python: facts.python, root });
  if (existsSync(join(root, 'runtime.json'))) {
    record('解锁：安装后的 runtime.json 与暂存的一致', JSON.stringify(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8'))) === JSON.stringify(JSON.parse(readFileSync(join(payload, 'runtime.json'), 'utf8'))));
    record('解锁：安装后的解释器别名是相对链接', ['python', 'python3'].every((name) => lstatSync(join(root, 'dependencies', 'python', 'bin', name)).isSymbolicLink()));
  }
  record('解锁：报出 node、pnpm 与各发行包版本', /"node"/u.test(textOf(load)) && /"pnpm"/u.test(textOf(load)) && /"numpy"\s*:\s*"[^"]+"/u.test(textOf(load)), textOf(load).slice(0, 600));
  record('解锁：再次调用返回相同路径', facts.loadAgain?.text === load.text, textOf(facts.loadAgain).slice(0, 200));
  record('解锁：Office 技能把模型指向内置依赖', skill.isError === false && /load_workspace_dependencies/u.test(textOf(skill)) && !/python3` or `python` on PATH/u.test(textOf(skill)), textOf(skill).slice(0, 300));
  record('解锁：agent 的 shell 用内置 Python 跑起 Office 库', /PROBE_PY_OK \d+\.\d+\.\d+ /u.test(textOf(bash)), textOf(bash).slice(0, 400));
  if (typeof facts.python === 'string' && existsSync(facts.python)) {
    let output = '';
    try {
      output = execFileSync(facts.python, ['-I', '-B', '-c', "import sys, numpy, pandas; print(sys.version.split()[0], numpy.__version__, pandas.__version__)"], { encoding: 'utf8' }).trim();
    } catch (error) {
      output = `FAILED ${error?.message}`;
    }
    record('解锁：安装后的解释器导入的是锁定的库', /^3\.\d+\.\d+ \S+ \S+$/u.test(output), output);
  }
  const before = existsSync(root) ? lstatSync(root).mtimeMs : undefined;
  const again = await launch(home, { unlocked, label: `${label}-again` });
  record('解锁：之后的会话复用已安装的载荷', again.ok && again.facts?.load?.isError === false && existsSync(root) && lstatSync(root).mtimeMs === before, `status=${again.facts?.load?.isError} mtime ${before} -> ${existsSync(root) ? lstatSync(root).mtimeMs : 'gone'}`);
}

const stagedFiles = fileCount(payload);
if (packaged !== undefined) {
  // 壳以应用二进制作 Node 运行一切；它自己得先能这样启动。
  const asNode = spawnSync(command, ['-p', 'process.version'], { encoding: 'utf8', env: { ...process.env, ...nodeMode } });
  record('应用二进制可作为 Node 运行', asNode.status === 0 && /^v\d+\.\d+\.\d+$/u.test(asNode.stdout?.trim() ?? ''), `${asNode.status} ${(asNode.stderr ?? '').slice(-200)}`.trim());
}
await scenario({ unlocked: true, label: 'unlocked' });
await scenario({ unlocked: false, label: 'baseline' });
record('暂存的载荷没有被写入，也没有变大', fileCount(payload) === stagedFiles, `${stagedFiles} -> ${fileCount(payload)}`);

const failed = checks.filter((check) => !check.ok).length;
const summary = {
  probe: 'forge-primary-runtime-probe',
  mode: options.bundle === undefined ? 'patch' : 'bundle',
  runner: packaged !== undefined ? 'packaged-app' : options.electron === undefined ? 'node' : 'electron',
  env: { node: process.version, platform: `${process.platform}-${process.arch}` },
  checks,
  passed: checks.length - failed,
  failed,
};
if (typeof options.out === 'string') writeFileSync(resolve(options.out), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`probe: ${summary.passed}/${checks.length} checks passed（mode=${summary.mode} runner=${summary.runner}）`);
if (options.keep) console.log(`probe: evidence kept at ${dir}`);
else rmSync(dir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
