#!/usr/bin/env node
/**
 * #15 / D4 宿主管线端到端证据：把 `@heluo/forge-devops` 真的挂进宿主 profile，
 * 让模型自决调用只读工具，用**会话记录 + 适配器调用日志**两头对证。
 *
 * 断言（每个模式各自判定）：
 *   with-reader：模型调用 `forge_devops_issue_read` 经**策略门禁**到达适配器一次，
 *                适配器日志与工具结果都带上同一 `target` 与 `source_revision`；
 *   no-reader：  没有适配器时工具**可见地拒绝**（结果含 NO_READER），适配器日志为空，
 *                且不存在任何写工具调用。
 *
 * 用法：DSH_HOME=<临时 profile 目录> OMLX_API_KEY=<凭据> node scripts/probe/devops-read-probe.mjs [with-reader|no-reader]
 * 退出码：0 断言成立；1 断言不成立；2 环境不具备。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const dsh = process.env.DSH_BIN ?? 'dsh';
const profile = process.env.DSH_DEVOPS_PROFILE ?? 'omlxprobe';
const mode = process.argv[2] ?? 'with-reader';
if (!['with-reader', 'no-reader'].includes(mode)) {
  console.error('probe: 模式只支持 with-reader / no-reader');
  process.exit(2);
}
if (process.env.OMLX_API_KEY === undefined || process.env.OMLX_API_KEY.length === 0) {
  console.error('probe: 需要 OMLX_API_KEY（本机 oMLX 凭据；不写进仓库、不打印）');
  process.exit(2);
}
if (process.env.DSH_HOME === undefined) {
  console.error('probe: 需要 DSH_HOME 指向承载 oMLX provider 的临时 profile 目录');
  process.exit(2);
}

const target = 'group/repo#1';
const devopsPackage = resolve(here, '../../packages/forge-devops/src/index.mjs');
const policyPackage = resolve(here, '../../packages/forge-policy/src/index.mjs');
const readerPackage = resolve(here, 'devops-reader-probe-plugin.mjs');
const dir = mkdtempSync(join(tmpdir(), `forge-devops-read-${mode}-`));
const readerLog = join(dir, 'reader-calls.jsonl');
const patch = join(dir, 'devops-read.patch.yml');

const readActions = [
  "          - { action: 'change.read', kind: 'read', target: 'change', enabled: true }",
  "          - { action: 'repository.read', kind: 'read', target: 'repository', enabled: true }",
  "          - { action: 'issue.read', kind: 'read', target: 'issue', enabled: true }",
  "          - { action: 'pr.read', kind: 'read', target: 'pull-request', enabled: true }",
];
const mountReader = mode === 'with-reader';
const rows = [
  '- id: session-persistence-jsonl',
  '  config:',
  `    root: '${join(dir, 'sessions')}'`,
  '- id: storage-json',
  '  config:',
  `    root: '${join(dir, 'storages')}'`,
  '- insert:',
  '    - id: forge-policy',
  `      name: '${pathToFileURL(policyPackage).href}'`,
  '      config:',
  '        catalog:',
  ...readActions,
  '        audit:',
  '          sink: memory',
  '          allowNonDurable: true',
  '        tools:',
  "          forge_devops_change_read: 'change.read'",
  "          forge_devops_repository_read: 'repository.read'",
  "          forge_devops_issue_read: 'issue.read'",
  "          forge_devops_pr_read: 'pr.read'",
];
if (mountReader) {
  rows.push('    - id: probe-devops-reader', `      name: '${pathToFileURL(readerPackage).href}'`);
}
rows.push('    - id: forge-devops', `      name: '${pathToFileURL(devopsPackage).href}'`);
writeFileSync(patch, `${rows.join('\n')}\n`);

const prompt =
  `Call the tool forge_devops_issue_read exactly once with target "${target}" and a 5-word description, ` +
  'then reply with the single word DONE. Do not call any other tool.';

const startedAt = Date.now();
const child = spawn(dsh, ['--profile', profile, '--patch', patch, prompt], {
  env: { ...process.env, PROBE_READER_LOG: readerLog },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let transcript = '';
child.stdout.on('data', (chunk) => (transcript += chunk));
child.stderr.on('data', (chunk) => (transcript += chunk));
child.stdin.end();
const exit = await new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));

const readerCalls = existsSync(readerLog)
  ? readFileSync(readerLog, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  : [];
const { calls, results } = readSessionEvidence(join(dir, 'sessions'));
const resultText = results.map((entry) => entry.text).join('\n');
const devopsCalls = calls.filter((call) => String(call.name ?? '').startsWith('forge_devops_'));
const writeLikeCalls = calls.filter((call) => /write|create|update|close|publish|record/u.test(String(call.name ?? '')));
const passedThroughGate = readerCalls.length === 1 && readerCalls[0].action === 'issue.read' && readerCalls[0].target === target;

const ok =
  mode === 'with-reader'
    ? passedThroughGate && resultText.includes('probe-rev-1') && devopsCalls.length === 1 && writeLikeCalls.length === 0
    : readerCalls.length === 0 && resultText.includes('NO_READER') && devopsCalls.length === 1 && writeLikeCalls.length === 0;

const detail = {
  probe: 'devops-read',
  mode,
  ok,
  harness: String(spawnSync(dsh, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim() || dsh,
  exitCode: exit.code,
  signal: exit.signal,
  elapsedMs: Date.now() - startedAt,
  readerCalls,
  devopsToolCalls: devopsCalls.map((call) => ({ name: call.name, target: call.arguments?.target })),
  writeLikeToolCalls: writeLikeCalls.map((call) => call.name),
  resultMentionsSourceRevision: resultText.includes('probe-rev-1'),
  resultMentionsNoReader: resultText.includes('NO_READER'),
  // 失败时最需要看的两件事：模型到底传了什么实参、门禁回了什么话。
  callArguments: calls.map((call) => ({ name: call.name, arguments: call.arguments })),
  resultHead: resultText.replaceAll(/\s+/gu, ' ').trim().slice(0, 300),
};
if (process.env.DSH_DEVOPS_DEBUG === '1') {
  detail.outputTail = transcript.replaceAll(/\s+/gu, ' ').trim().slice(-400);
  console.error(`probe: 调试模式保留临时目录 ${dir}`);
} else {
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(detail, null, 2));
process.exit(ok ? 0 : 1);

/** 扫本次运行的全部会话记录（父 + 子 Agent），取出工具调用与结果。 */
function readSessionEvidence(root) {
  const calls = [];
  const results = [];
  if (!existsSync(root)) return { calls, results };
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry !== 'session.v4.jsonl.zstd') continue;
      const lines = zstdDecompressSync(readFileSync(full)).toString('utf8').split('\n');
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
          results.push({ text: content.map((part) => (part.type === 'text' ? part.text : '')).join(' ') });
        }
      }
    }
  }
  return { calls, results };
}
