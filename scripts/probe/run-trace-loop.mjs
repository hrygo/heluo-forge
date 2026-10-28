#!/usr/bin/env node
/**
 * Issue → PR 闭环判定（只读，不执行任何写动作）。
 *
 * 用法：
 *   node scripts/probe/run-trace-loop.mjs \
 *     --cli-dir <含 dop 与 gh 的目录> \
 *     --repo  <HOST/OWNER/REPO> \
 *     --targets <变更号>:<Issue号>[,...] \
 *     --out    <新建目录> \
 *     [--acceptance <验收记录.json>]
 *
 * 验收记录格式（人工/平台填写，模型不得代填）：
 *   { "ARD123456": { "verified": true, "by": "svc-pmo", "at": "2026-06-21T00:00:00Z", "evidence": "记录编号" } }
 *
 * 输出：loop.json、index.html、plan.json（写动作计划，未执行）、audit.jsonl（0600，新目录独占）。
 */
import assert from 'node:assert/strict';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDopReader } from '../../packages/forge-devops/src/change-briefing.mjs';
import { cliEnvironment, readChangeReport } from '../../packages/forge-devops/src/change-cli.mjs';
import { createGhReader } from '../../packages/forge-devops/src/host-readers.mjs';
import { assessIssueClosure, buildWriteSteps, renderLoopHtml } from '../../packages/forge-devops/src/trace-loop.mjs';
import { compileCatalog, createAuditBarrier, createGate } from '../../packages/forge-policy/src/index.mjs';

export function parseLoopArgs(args) {
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--cli-dir', '--repo', '--targets', '--out', '--acceptance'].includes(key) || key in options || !args.length || args[0].startsWith('--')) throw new Error('INVALID_OPTIONS');
    options[key] = args.shift();
  }
  const required = ['--cli-dir', '--repo', '--targets', '--out'];
  if (!required.every((key) => key in options)) throw new Error('INVALID_OPTIONS');
  const repo = options['--repo'];
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repo)) throw new Error('EXPLICIT_REPOSITORY_REQUIRED');
  const targets = options['--targets'].split(',').map((item) => {
    const match = /^([A-Z]{2,6}\d+):([1-9]\d*)$/u.exec(item);
    if (!match || match[0] !== item) throw new Error('INVALID_TARGET');
    return { changeId: match[1], issueNumber: Number(match[2]), host: repo.split('/')[0] };
  });
  if (targets.length > 10
    || new Set(targets.map((t) => t.changeId)).size !== targets.length
    || new Set(targets.map((t) => t.issueNumber)).size !== targets.length) throw new Error('DUPLICATE_OR_EXCESS_TARGETS');
  return {
    cliDir: resolve(options['--cli-dir']), repo, targets,
    output: resolve(options['--out']),
    acceptance: options['--acceptance'] ? resolve(options['--acceptance']) : null,
  };
}

function readAcceptance(path) {
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_ACCEPTANCE');
  return parsed;
}

export async function runLoop(options, dependencies = {}) {
  mkdirSync(options.output, { mode: 0o700 }); // 新目录独占；不覆盖既有输出。
  const fd = openSync(join(options.output, 'audit.jsonl'), 'ax', 0o600);
  const records = [];
  const sink = { durable: true, append(record) { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); records.push(record); } };
  const env = cliEnvironment();
  const host = options.targets[0].host;
  const readDop = dependencies.readDop ?? ((extra = {}) => createDopReader({ executable: join(options.cliDir, 'dop'), env: { ...env, ...extra } }));
  const gh = dependencies.gh ?? createGhReader({ executable: join(options.cliDir, 'gh'), allowedHost: host, env });
  const audit = createAuditBarrier({ sink });
  const gate = createGate({ catalog: compileCatalog(['repository.read', 'issue.read', 'pr.read'].map((action) => ({ action, kind: 'read', target: 'repository', enabled: true }))), audit });
  async function readGh(action, target) {
    const result = await gate.executeAction({}, action, { name: action, arguments: { target }, callId: randomUUID() }, async () => ({ value: await gh.read({ action, target }) }));
    if (result.kind === 'error' || audit.isDegraded()) throw new Error('GH_AUDIT_FAILED');
    return result.value;
  }
  try {
    const acceptance = readAcceptance(options.acceptance);
    const repository = await readGh('repository.read', options.repo);
    assert.equal(repository.facts.url.toLowerCase(), `https://${options.repo}`.toLowerCase(), 'REPOSITORY_MISMATCH');
    const assessments = [];
    for (const { changeId, issueNumber } of options.targets) {
      const report = await readChangeReport({ changeId, reader: readDop(), sink, mode: 'demo' });
      const issue = await readGh('issue.read', `${options.repo}#${issueNumber}`);
      assert.equal(issue.facts.number, issueNumber, 'ISSUE_MISMATCH');
      const pullRequests = [];
      for (const ref of issue.facts.closingPullRequests) {
        pullRequests.push((await readGh('pr.read', `${options.repo}#${ref.number}`)).facts);
      }
      const assessment = assessIssueClosure({
        changeId, issue: issue.facts, pullRequests, repositoryUrl: repository.facts.url,
        acceptance: acceptance[changeId] ?? null,
      });
      const plan = buildWriteSteps({ changeId, repository: options.repo, issueBody: `- DOP change: ${changeId}` });
      assessments.push({ change: report.facts, issue: issue.facts, assessment, plan });
    }
    // 负向：未知变更号必须停止，而不是给出空判定。
    await assert.rejects(() => readChangeReport({ changeId: 'ZZZZZZ999999', reader: readDop(), sink, mode: 'demo' }), { code: 'CLI_FAILED' });
    assert.equal(records.filter((r) => r.phase === 'begin').length, records.filter((r) => r.phase === 'settle').length, 'UNSETTLED_AUDIT');
    const summary = {
      observedAt: new Date().toISOString(),
      repository: { nameWithOwner: repository.facts.nameWithOwner, url: repository.facts.url },
      assessments, remoteWrites: 0, executedWriteSteps: 0, auditRecords: records.length,
    };
    writeFileSync(join(options.output, 'loop.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(options.output, 'plan.json'), `${JSON.stringify(assessments.map((a) => a.plan), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(options.output, 'index.html'), renderLoopHtml(assessments.length === 1 ? assessments[0].assessment : { ...assessments[0].assessment, changeId: `${options.targets.length} targets`, checks: assessments.flatMap((a) => a.assessment.checks), mergedPullRequests: assessments.flatMap((a) => a.assessment.mergedPullRequests), closable: assessments.every((a) => a.assessment.closable), blockers: assessments.flatMap((a) => a.assessment.blockers) }, assessments[0].plan), { flag: 'wx', mode: 0o600 });
    return summary;
  } finally { gate.dispose(); closeSync(fd); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summary = await runLoop(parseLoopArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      repository: summary.repository.nameWithOwner,
      results: summary.assessments.map((a) => ({ change: a.change.id, issue: a.issue.number, closable: a.assessment.closable, blockers: a.assessment.blockers })),
      remoteWrites: summary.remoteWrites, executedWriteSteps: summary.executedWriteSteps, auditRecords: summary.auditRecords,
    }, null, 2));
  } catch { console.error('LOOP_ASSESSMENT_FAILED: explicit inputs, read results or audit could not be verified; no write was requested.'); process.exitCode = 1; }
}
