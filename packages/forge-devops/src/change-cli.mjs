#!/usr/bin/env node
/** Human-triggered diagnostic read entry; not a task delegation or login service. */
import { closeSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createGate, createAuditBarrier, compileCatalog } from '@heluo/forge-policy';
import { createDopReader, renderBriefingHtml, renderBriefingText, ChangeBriefingError } from './change-briefing.mjs';

const HELP = `河洛 · 变更只读简报
  heluo-change demo [--out report.html] [--json]
  heluo-change demo --scenario denied|malformed|timeout
  heluo-change view DEMO100001 --cli /approved/path/dop --audit-file new-audit.jsonl [--out report.html] [--json]

仅执行 dop change view <ID> -j，不登录、不写回、不调用 done。
实源读取使用企业 CLI 自有登录状态，必须显式选择新审计文件。
报告含业务内容，仅保存至获准目录；无 --out 时只输出到终端。
Windows 仅支持原生 CLI，不经 cmd/bat 或 Shell。\n`;

function options(argv) {
  const [mode, ...rest] = argv;
  if (mode === undefined || mode === '--help' || mode === 'help') return { help: true };
  if (!['demo', 'view'].includes(mode)) throw new ChangeBriefingError('INVALID_COMMAND');
  const result = { mode, scenario: 'success', json: false };
  const args = [...rest];
  if (mode === 'view') result.changeId = args.shift();
  const seen = new Set();
  while (args.length) {
    const option = args.shift();
    if (seen.has(option)) throw new ChangeBriefingError('INVALID_OPTIONS');
    seen.add(option);
    if (option === '--json') { result.json = true; continue; }
    const field = { '--out': 'out', '--cli': 'cli', '--audit-file': 'auditFile', '--scenario': 'scenario' }[option];
    if (!field || !args.length || args[0].startsWith('--')) throw new ChangeBriefingError('INVALID_OPTIONS');
    result[field] = args.shift();
  }
  if (mode === 'demo' && (result.cli || result.auditFile)) throw new ChangeBriefingError('INVALID_OPTIONS');
  if (mode === 'view' && (seen.has('--scenario') || !result.cli || !result.auditFile || !/^[A-Z]{2,6}\d+$/u.test(result.changeId ?? ''))) throw new ChangeBriefingError('LIVE_REQUIRES_ID_CLI_AND_AUDIT');
  if (!['success', 'denied', 'malformed', 'timeout'].includes(result.scenario)) throw new ChangeBriefingError('INVALID_SCENARIO');
  if (result.auditFile && result.out && resolve(result.auditFile) === resolve(result.out)) throw new ChangeBriefingError('INVALID_OPTIONS');
  if (mode === 'view' && (/\.(cmd|bat)$/iu.test(result.cli) || !/^(?:\/|[A-Za-z]:[\\/])/u.test(result.cli))) throw new ChangeBriefingError('NATIVE_ABSOLUTE_CLI_REQUIRED');
  return result;
}

/** Minimal ambient CLI setup; never forward the entire gateway/tool environment. */
export function cliEnvironment(source = process.env) {
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];
  return Object.fromEntries(allowed.filter((key) => typeof source[key] === 'string').map((key) => [key, source[key]]));
}

/** Shared policy and necessary audit; absent sink means zero subprocess calls. */
export async function readChangeReport({ changeId, reader, sink, allowNonDurable = false, mode = 'live' }) {
  const audit = createAuditBarrier({ sink, allowNonDurable });
  const gate = createGate({ catalog: compileCatalog([{ action: 'change.read', kind: 'read', target: 'change', enabled: true }]), audit });
  const exec = { name: 'change.read', arguments: { target: changeId }, callId: randomUUID() };
  try {
    const result = await gate.executeAction({}, 'change.read', exec, () => reader.read({ action: 'change.read', target: changeId }));
    if (result?.kind === 'error') throw new ChangeBriefingError('POLICY_DENIED');
    if (audit.isDegraded()) throw new ChangeBriefingError('AUDIT_SETTLEMENT_FAILED');
    return { mode, observedAt: result.observed_at, auditMode: allowNonDurable ? '显式本地演示 / 非持久内存' : '本地独占审计文件 / 最小字段 / fsync', status: result.status, facts: result.facts };
  } finally { gate.dispose(); }
}

export async function main(argv = process.argv.slice(2), io = process) {
  let auditFd, reportFd;
  try {
    const input = options(argv);
    if (input.help) { io.stdout.write(HELP); return 0; }
    // Reserve explicit paths before any business read; never overwrite or follow
    // an existing final symlink. No default output in the project or home.
    if (input.out) reportFd = openSync(resolve(input.out), 'ax', 0o600);
    let sink;
    if (input.mode === 'demo') sink = { durable: false, append() {} };
    else {
      auditFd = openSync(resolve(input.auditFile), 'ax', 0o600);
      sink = { durable: true, append(record) {
        writeFileSync(auditFd, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
        fsyncSync(auditFd);
      } };
    }
    const changeId = input.mode === 'demo' ? 'DEMO100001' : input.changeId;
    const reader = createDopReader(input.mode === 'demo' ? {
      executable: process.execPath,
      prefixArgs: [fileURLToPath(new URL('./demo-dop.mjs', import.meta.url))],
      env: { ...cliEnvironment(), HELUO_DEMO_CASE: input.scenario },
      timeoutMs: input.scenario === 'timeout' ? 500 : 10000,
    } : { executable: input.cli, env: cliEnvironment() });
    const report = await readChangeReport({ changeId, reader, sink, allowNonDurable: input.mode === 'demo', mode: input.mode });
    if (reportFd !== undefined) {
      writeFileSync(reportFd, renderBriefingHtml(report), { encoding: 'utf8' });
      fsyncSync(reportFd);
    }
    io.stdout.write(input.json ? `${JSON.stringify(report, null, 2)}\n` : renderBriefingText(report));
    if (input.out && !input.json) io.stdout.write(`HTML 已保存至显式选择的输出文件。\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ChangeBriefingError || error?.name === 'DopProcessError' ? error.code : error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'LOCAL_IO_FAILED';
    io.stderr.write(`只读查询未完成：${code}。没有执行任何业务写入。使用 --help 查看入口。\n`);
    return 1;
  } finally {
    if (reportFd !== undefined) closeSync(reportFd);
    if (auditFd !== undefined) closeSync(auditFd);
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
