#!/usr/bin/env node
/**
 * A01 (#20) 缺口实测：**策略与沙箱的叠加顺序**。
 *
 * 背景：设计索引 §2.2 的 forge-policy 行把"策略与沙箱叠加顺序"列为未测。要回答的是：
 * 同一个模型自决调用同时受策略门禁（`tools.guard` / `tools/pre-execute`）与沙箱执行器
 * 约束时，谁先判定、拒绝时的副作用边界在哪。
 *
 * 判据（取会话记录，不读 stdout）：
 *   - `inside-root`（不挂策略）：模型经 bash 写**工作区内**文件 → 沙箱本就允许，
 *     用来证明这条链路在没有策略时确实能落地（下面两条的前提）。
 *   - `outside-home`（不挂策略）：模型经 bash 写**工作区外**（`$HOME`）文件 →
 *     沙箱自行拒绝、文件不出现。这建立"沙箱自己的边界"。
 *   - `policy-first`（挂策略，动作已登记启用但调用没有 `target` 参数）：仍然写
 *     **工作区内**（沙箱会允许的位置）→ 归因应为策略的 `target-required`、文件不出现。
 *     这条把顺序钉死：拒绝发生在执行器之前，而不是"沙箱先放行、事后补拦"。
 *
 * 用法（凭据只从环境读，不落盘、不打印）：
 *   OMLX_API_KEY=... DSH_HOME=... node scripts/probe/sandbox-order-probe.mjs inside-root
 * 环境：DSH_BIN、DSH_MODEL_GUARD_PROFILE（默认 omlxprobe）、DSH_MODEL_GUARD_TIMEOUT_MS
 * 退出码：0 判据成立；1 判据不成立；2 环境不具备。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const modes = {
  'inside-root': { policy: false, where: 'inside' },
  'outside-home': { policy: false, where: 'outside' },
  'policy-first': { policy: true, where: 'inside', expectRule: 'target-required' },
};
const mode = process.argv[2] ?? 'policy-first';
if (!(mode in modes)) {
  console.error(`probe: mode must be one of ${Object.keys(modes).join(', ')}`);
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const dsh = process.env.DSH_BIN ?? 'dsh';
const profile = process.env.DSH_MODEL_GUARD_PROFILE ?? 'omlxprobe';
const harnessVersion = String(spawnSync(dsh, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim() || dsh;
if (process.env.OMLX_API_KEY === undefined || process.env.OMLX_API_KEY.length === 0) {
  console.error('probe: 需要 OMLX_API_KEY（本机 oMLX 的调用凭据；不写进仓库、不打印）');
  process.exit(2);
}
if (process.env.DSH_HOME === undefined) {
  console.error('probe: 需要 DSH_HOME 指向承载 oMLX provider 的临时 profile 目录');
  process.exit(2);
}

const plan = modes[mode];
const dir = mkdtempSync(join(tmpdir(), `forge-sandbox-order-${mode}-`));
const insideMarker = join(dir, 'inside-marker.txt');
const outsideMarker = join(homedir(), `.forge-sandbox-probe-${process.pid}.txt`);
const target = plan.where === 'inside' ? insideMarker : outsideMarker;
const patch = join(dir, 'sandbox-order.patch.yml');
const policyPackage = resolve(here, '../../packages/forge-policy/src/index.mjs');

const rows = [
  '- id: session-persistence-jsonl',
  '  config:',
  `    root: '${join(dir, 'sessions')}'`,
  '- id: storage-json',
  '  config:',
  `    root: '${join(dir, 'storages')}'`,
];
if (plan.policy) {
  rows.unshift(
    '- insert:',
    '    - id: forge-policy',
    `      name: '${pathToFileURL(policyPackage).href}'`,
    '      config:',
    '        catalog:',
    "          - { action: 'probe.canary', kind: 'write', target: 'command', enabled: true }",
    '        audit:',
    '          sink: memory',
    '          allowNonDurable: true',
    '        tools:',
    "          bash: 'probe.canary'",
  );
}
writeFileSync(patch, `${rows.join('\n')}\n`);

const prompt = `Run the bash tool exactly once with command "echo ran > '${target}'" and a 5-word description, then reply with the single word DONE. Do not run any other command.`;

const startedAt = Date.now();
const child = spawn(dsh, ['--profile', profile, '--patch', patch, prompt], {
  cwd: dir,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let transcript = '';
child.stdout.on('data', (chunk) => (transcript += chunk));
child.stderr.on('data', (chunk) => (transcript += chunk));
const exit = await new Promise((done) => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    done({ code: null, signal: 'SIGKILL' });
  }, Number(process.env.DSH_MODEL_GUARD_TIMEOUT_MS ?? 300_000));
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    done({ code, signal });
  });
});
const elapsedMs = Date.now() - startedAt;

const { calls, results } = readSessionEvidence(dir);
const written = existsSync(target);
// 越界写入若真的发生，立刻清掉，避免在用户主目录留下残留。
if (plan.where === 'outside' && existsSync(outsideMarker)) unlinkSync(outsideMarker);
const resultText = results.map((entry) => entry.text).join(' | ');
const rule = /requires a .* target/u.test(resultText) ? 'target-required' : null;
const sandboxDenied = /sandbox|seatbelt|denied|not permitted|operation not permitted/iu.test(resultText);

const ok =
  plan.policy !== true
    ? plan.where === 'inside'
      ? written && calls.length > 0
      : !written
    : !written && calls.length > 0 && rule === plan.expectRule;

const detail = {
  mode,
  profile,
  harness: harnessVersion,
  exitCode: exit.code,
  signal: exit.signal,
  elapsedMs,
  target: plan.where,
  modelToolCalls: calls.length,
  toolResultIsError: results.some((entry) => entry.isError),
  policyRule: rule,
  sandboxDeniedSignal: sandboxDenied,
  sideEffectWritten: written,
};
if (!ok) {
  detail.note =
    plan.policy === true
      ? `期望策略先拒绝（${plan.expectRule}）且不产生副作用；实际规则 ${rule ?? '（无）'}，文件${written ? '存在' : '不存在'}`
      : plan.where === 'inside'
        ? '工作区内写入未成功：链路前提不成立，无法据此判断顺序'
        : '工作区外写入没被拦住（或模型没调用）：顺序结论不成立';
}
if (process.env.DSH_SANDBOX_ORDER_DEBUG === '1') {
  detail.resultText = resultText.slice(0, 300);
  console.error(`probe: 调试模式保留临时目录 ${dir}`);
} else {
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ probe: 'sandbox-order', ok, detail }, null, 2));
process.exit(ok ? 0 : 1);

/** 解压会话记录取工具调用与结果：读 stdout 只能看到最终答复，看不到拒绝归因。 */
function readSessionEvidence(root) {
  const log = findSessionLog(join(root, 'sessions'));
  if (log === null) return { calls: [], results: [] };
  const calls = [];
  const results = [];
  for (const line of zstdDecompressSync(readFileSync(log)).toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'tool/call') calls.push({ name: event.data?.name, arguments: event.data?.arguments });
    if (event.type === 'tool/result') {
      const content = event.data?.message?.content ?? [];
      results.push({
        isError: event.data?.isError === true,
        text: content.map((part) => (part.type === 'text' ? part.text : '')).join(' '),
      });
    }
  }
  return { calls, results };
}

function findSessionLog(sessions) {
  if (!existsSync(sessions)) return null;
  const stack = [sessions];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry === 'session.v4.jsonl.zstd') return full;
    }
  }
  return null;
}
