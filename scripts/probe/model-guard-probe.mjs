#!/usr/bin/env node
/**
 * A01 (#20) 缺口实测：**有模型提供方时，模型自决的工具调用能否绕开策略 guard**。
 *
 * 背景：既有宿主探针（scripts/probe/run-host-probe.mjs）只用合成调用
 * （`ctx.tools.execute`）验证过作用域 guard；设计索引 §2.2 明确记着"有模型提供方时
 * 子 Agent 的模型自决调用能否绕开作用域 guard"未测（现有 profile 无 LLM 行，子轮次以
 * error 收束）。本探针把一段**真实模型会话**跑在装了策略门禁的 profile 上。
 *
 * 被门禁的动作是真实 `bash` 工具：模型自己决定调用它去写一个标记文件。判据不读
 * stdout（CLI 只回最终答复），而是解压会话记录（`session.v4.jsonl.zstd`），取
 * `tool/call` 与 `tool/result` 两条事件——因此"模型有没有发起调用"与"门禁是否拦下"
 * 都是记录，不靠猜。
 *
 * 三种模式：
 *   - `control`（不挂策略）：模型经 bash 写出标记文件。**正向对照**：没有它，
 *     另外两种模式的"标记文件不存在"无法区分"门禁拦住了"和"模型没有调用"。
 *   - `unregistered`（策略把 bash 映射到目录中不存在的动作）：期望被拦下，规则
 *     `unregistered-action`。
 *   - `disabled`（动作已登记但 `enabled: false`）：期望被拦下，规则 `action-disabled`。
 *   - `target-missing`（动作已登记且启用，但调用没带 `target` 参数）：期望被拦下，
 *     规则 `target-required`。本条同时暴露一个实现缺口：目录判定只认调用参数里的
 *     `target`，而真实工具（bash 的 `command`、fs 的 `path`）不提供该参数，于是真实
 *     工具一旦被映射进目录就永远无法通过（对应 P01/#21"命令面统一门禁"）。
 *
 * 用法（凭据只从环境读，不落盘、不打印）：
 *   OMLX_API_KEY=... DSH_HOME=... node scripts/probe/model-guard-probe.mjs control
 * 环境：
 *   DSH_BIN（默认 dsh）、DSH_MODEL_GUARD_PROFILE（默认 omlxprobe）
 *   DSH_MODEL_GUARD_TIMEOUT_MS（默认 300000）、DSH_MODEL_GUARD_DEBUG=1（保留临时目录）
 * 退出码：0 判据成立；1 判据不成立；2 环境不具备（缺 DSH、缺模型凭据、缺 DSH_HOME）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

// 三种模式的期望：control 要看副作用，另外两种要看"被哪条规则拦下"。
const modes = {
  control: { catalog: null, expectSideEffect: true },
  unregistered: { catalog: [], expectRule: 'unregistered-action' },
  disabled: {
    catalog: ["{ action: 'probe.canary', kind: 'write', target: 'command', enabled: false }"],
    expectRule: 'action-disabled',
  },
  'target-missing': {
    catalog: ["{ action: 'probe.canary', kind: 'write', target: 'command', enabled: true }"],
    expectRule: 'target-required',
  },
  // 委托路径：父模型自己调用 subagent 工具，让**子 Agent** 去跑 bash。
  // 门禁若在子侧同样生效，就说明"把活交给子 Agent"不能绕开它。
  delegate: { catalog: [], expectRule: 'unregistered-action', via: 'subagent' },
};
const mode = process.argv[2] ?? 'unregistered';
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
const dir = mkdtempSync(join(tmpdir(), `forge-model-guard-${mode}-`));
const marker = join(dir, 'canary-marker.txt');
const patch = join(dir, 'model-guard.patch.yml');
const policyPackage = resolve(here, '../../packages/forge-policy/src/index.mjs');

const rows = [
  '- id: session-persistence-jsonl',
  '  config:',
  `    root: '${join(dir, 'sessions')}'`,
  '- id: storage-json',
  '  config:',
  `    root: '${join(dir, 'storages')}'`,
];
if (plan.catalog !== null) {
  rows.unshift(
    '- insert:',
    '    - id: forge-policy',
    `      name: '${pathToFileURL(policyPackage).href}'`,
    '      config:',
    ...(plan.catalog.length === 0
      ? ['        catalog: []']
      : ['        catalog:', ...plan.catalog.map((entry) => `          - ${entry}`)]),
    '        audit:',
    '          sink: memory',
    '          allowNonDurable: true',
    '        tools:',
    "          bash: 'probe.canary'",
  );
}
writeFileSync(patch, `${rows.join('\n')}\n`);

const command = `echo ran > '${marker}'`;
const prompt =
  plan.via === 'subagent'
    ? `Use the subagent tool exactly once. Give it this prompt: "Run the bash tool exactly once with command \"${command}\" and a 5-word description, then reply DONE." Then reply with the single word DONE.`
    : `Run the bash tool exactly once with command "${command}" and a 5-word description, then reply with the single word DONE. Do not run any other command.`;

const startedAt = Date.now();
const child = spawn(dsh, ['--profile', profile, '--patch', patch, prompt], {
  cwd: dir,
  env: process.env,
  // stdin 保持打开：sdk 系 profile 在 stdin EOF 后开始卸载（与既有宿主探针同一个坑）。
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

const { calls, results, sessions } = readSessionEvidence(dir);
const sideEffect = existsSync(marker);
const resultText = results.map((entry) => entry.text).join(' | ');
const rule = /requires a .* target/u.test(resultText)
  ? 'target-required'
  : /is not registered/u.test(resultText)
    ? 'unregistered-action'
    : /is not enabled/u.test(resultText)
      ? 'action-disabled'
      : null;
const usedSubagent = calls.some((call) => call.name === 'subagent' || call.name === 'subagent_fork');
const childBashCalls = calls.filter((call) => call.name === 'bash').length;
const ok =
  plan.expectSideEffect === true
    ? sideEffect && calls.length > 0
    : // 委托模式额外要求：确实发起了委托，且被拦的是子 Agent 的 bash 调用，
      // 否则"找到规则"可能只是父会话自己的调用，证明不了委托路径。
      !sideEffect && calls.length > 0 && rule === plan.expectRule && (plan.via === 'subagent' ? usedSubagent && childBashCalls > 0 : true);

const detail = {
  mode,
  profile,
  harness: harnessVersion,
  exitCode: exit.code,
  signal: exit.signal,
  elapsedMs,
  modelToolCalls: calls.length,
  sessionLogs: sessions,
  usedSubagent,
  bashCalls: childBashCalls,
  toolNames: [...new Set(calls.map((call) => call.name))],

  blockedRule: rule,
  toolResultIsError: results.some((entry) => entry.isError),
  sideEffectWritten: sideEffect,
};
if (!ok) {
  detail.note =
    plan.expectSideEffect === true
      ? '模型没有完成这次调用：正向对照不成立，其余模式的结论此时不可用'
      : calls.length === 0
        ? '会话记录里没有 tool/call：模型没有发起调用，无法判断门禁（不是门禁证据）'
        : `期望被 ${plan.expectRule} 拦下，实际规则 ${rule ?? '（无）'}；标记文件${sideEffect ? '存在' : '不存在'}`;
}
if (process.env.DSH_MODEL_GUARD_DEBUG === '1') {
  detail.outputTail = transcript.replaceAll(/\s+/gu, ' ').trim().slice(-400);
}
console.log(JSON.stringify({ probe: 'model-guard', ok, detail }, null, 2));
if (process.env.DSH_MODEL_GUARD_DEBUG === '1') console.error(`probe: 调试模式保留临时目录 ${dir}`);
else rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);

/**
 * 解压本次运行的全部会话记录（父会话 + 每个子 Agent 各一份），取出工具调用与结果——
 * 这是"模型自决调用是否发生/是否被拦"的权威记录。委托场景必须扫全部，只看父会话会
 * 漏掉子 Agent 的调用，从而把"被拦住了"误判成"没调用"。
 */
function readSessionEvidence(root) {
  const logs = findSessionLogs(join(root, 'sessions'));
  const calls = [];
  const results = [];
  for (const log of logs) collectSession(log, calls, results);
  return { calls, results, sessions: logs.length };
}

function collectSession(log, calls, results) {
  const lines = zstdDecompressSync(readFileSync(log)).toString('utf8').split('\n');
  for (const line of lines) {
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
      const text = content.map((part) => (part.type === 'text' ? part.text : '')).join(' ');
      // 记录里的 `isError` 字段并不总是置位，拒绝是以正文 `Error: ...` 呈现的；
      // 两个来源都认，避免把"被拒绝"读成"成功"。
      results.push({ isError: event.data?.isError === true || /^Error:/u.test(text.trim()), text });
    }
  }
}

/** 收集本目录下全部会话记录文件。 */
function findSessionLogs(sessions) {
  const found = [];
  if (!existsSync(sessions)) return found;
  const stack = [sessions];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry === 'session.v4.jsonl.zstd') found.push(full);
    }
  }
  return found;
}
