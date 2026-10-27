#!/usr/bin/env node
/** User-provided local DOP mock + explicit gh repository. No profile/remote writes. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDopReader } from '../../packages/forge-devops/src/change-briefing.mjs';
import { cliEnvironment, readChangeReport } from '../../packages/forge-devops/src/change-cli.mjs';
import { compileCatalog, createAuditBarrier, createGate } from '../../packages/forge-policy/src/index.mjs';

export function parseRehearsalArgs(args) {
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--cli-dir', '--repo', '--targets', '--out'].includes(key) || key in options || !args.length || args[0].startsWith('--')) throw new Error('INVALID_OPTIONS');
    options[key] = args.shift();
  }
  if (Object.keys(options).length !== 4 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(options['--repo'])) throw new Error('EXPLICIT_REPOSITORY_REQUIRED');
  const targets = options['--targets'].split(',').map((item) => {
    const match = /^([A-Z]{2,6}\d+):([1-9]\d*)$/u.exec(item);
    if (!match || match[0] !== item || !Number.isSafeInteger(Number(match[2]))) throw new Error('INVALID_TARGET');
    return { changeId: match[1], issueNumber: Number(match[2]) };
  });
  if (targets.length > 10 || new Set(targets.map((t) => t.changeId)).size !== targets.length || new Set(targets.map((t) => t.issueNumber)).size !== targets.length) throw new Error('DUPLICATE_OR_EXCESS_TARGETS');
  return { cliDir: resolve(options['--cli-dir']), repo: options['--repo'], targets, output: resolve(options['--out']) };
}

const escape = (value) => String(value).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (url, label) => `<a href="${escape(url)}" rel="noreferrer">${escape(label)}</a>`;

export function renderTraceHtml(summary) {
  const sections = summary.changes.map(({ facts, issue, closingPullRequests }) => `<section><div class="tag">DOP：用户提供的本地 mock</div><h2>${escape(facts.id)} · ${escape(facts.title)}</h2><p>${escape(facts.description)}</p><div class="grid"><div><h3>DOP 独立验收项</h3><ol>${facts.acceptance.map((a) => `<li>${escape(a)}</li>`).join('')}</ol><h3>仓库 Issue 的验收声明</h3><pre>${escape(issue.body)}</pre></div><aside><h3>可核对的事实</h3><dl><dt>DOP 变更状态</dt><dd>${escape(facts.platformStatus)}</dd><dt>子系统（不从变更前缀推导）</dt><dd>${escape(facts.subsystems.map((s) => `${s.code} · ${s.name}`).join('；') || '未提供')}</dd><dt>故事数</dt><dd>${facts.stories.length}</dd><dt>首个非空排期</dt><dd>${escape(facts.release?.number ?? '未提供')} · ${escape(facts.release?.name ?? '')}</dd><dt>真实 GitHub Issue</dt><dd>${link(issue.url, `#${issue.number}`)} · ${escape(issue.state)}</dd><dt>平台返回的关闭 PR</dt><dd>${closingPullRequests.length ? closingPullRequests.map((pr) => `${link(pr.url, `#${pr.number}`)} · ${escape(pr.state)}<br><code>${escape(pr.headRefOid)}</code>`).join('<br>') : '未返回关闭此 Issue 的 PR；不等于仓库没有其他相关 PR'}</dd></dl></aside></div><p class="note">状态分源记录：DOP ${escape(facts.platformStatus)} / Issue ${escape(issue.state)}；不隐式同步。DOP 与 Issue 中的验收项分开展示，不静默合并。已有关闭/合并是历史状态，不是本轮业务验收结论。需求版本未返回：不伪造版本，也不因此开放冻结或写操作。</p></section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>河洛 · 已连接测试环境的只读追溯</title><style>body{margin:0;background:#f4f6fa;color:#182a40;font:16px/1.75 system-ui,sans-serif}main{max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:34px}h2{font-size:25px}.brand{color:#246b61;letter-spacing:.15em}.lead{color:#536579}section{margin:24px 0;background:white;border:1px solid #dbe2ec;border-radius:14px;padding:28px}.grid{display:grid;grid-template-columns:2fr 1fr;gap:30px}.tag{color:#825900;font-size:13px}a{color:#176e66}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fb;padding:18px;font:14px/1.8 system-ui}dt{font-size:13px;color:#64748b}dd{margin:0 0 16px;overflow-wrap:anywhere}code{font-size:12px;overflow-wrap:anywhere}.note{border-left:4px solid #cea240;padding-left:15px;color:#5d563e}li{margin:8px 0}@media(max-width:720px){.grid{display:block}h1{font-size:27px}}</style></head><body><main><div class="brand">河洛 HELUO FORGE / CONNECTED READ-ONLY</div><h1>你的测试环境，已经读通</h1><p class="lead">本机 DOP mock → 需求与排期 → 用户显式指定仓库 → 真实 gh Issue / PR 追溯</p><section><h2>本轮实际连接</h2><p>测试仓库：${link(summary.repository.url, summary.repository.nameWithOwner)}，默认分支 ${escape(summary.repository.defaultBranchRef.name)}。仓库映射依据为本轮用户明确指定，不从变更号、目录或正文猜测。</p><p>成功读取 ${summary.changes.length} 个 DOP 变更；完成固定目标错误、mock 查询失败、必要审计缺失等 ${summary.negativeChecks.length} 个负向检查。所有查询经本地必要审计；无登录、建单、done、评论、合并、CI 触发或遥测。</p><p>企业 Gitee 的 gh 完整兼容性采用用户本轮确认；本次实际远端是 GitHub，不冒称访问了内网 Gitee。</p></section>${sections}<section><h2>测试边界</h2><p>DOP 数据来自用户提供的 mock CLI；仓库、Issue 和 PR 来自真实 GitHub 只读查询。这里只复用本地 policy 判定/审计核心，不宣称已接入 DSH profile 的 IAM、角色或组织开关。</p><p>观察时间：${escape(summary.observedAt)}。原始 CLI 日志不进入报告；必要审计不保存业务正文。当前报告包含获准测试数据，请勿当作平台全量清单或生产验收。</p></section></main></body></html>`;
}

export async function runRehearsal(options, dependencies = {}) {
  mkdirSync(options.output, { mode: 0o700 }); // A new directory only; no overwrite.
  const fd = openSync(join(options.output, 'audit.jsonl'), 'ax', 0o600);
  const records = [];
  const sink = { durable: true, append(record) { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); records.push(record); } };
  const env = { ...cliEnvironment(), PATH: `${options.cliDir}${delimiter}${process.env.PATH ?? ''}`, OMS_MOCK_DOP_LOG: join(options.output, 'mock-cli.local.log') };
  // The explicit CLI directory is a trust boundary: never fall through to an
  // unrelated ambient `dop` when the supplied path is missing or misspelled.
  const readDop = dependencies.readDop ?? ((extra = {}) => createDopReader({ executable: join(options.cliDir, 'dop'), env: { ...env, ...extra } }));
  const gh = dependencies.gh ?? ((args) => {
    let stdout;
    try { stdout = execFileSync('gh', args, { env: cliEnvironment(), shell: false, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 262144, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error('GH_READ_FAILED'); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); }
    catch { throw new Error('GH_INVALID_JSON'); }
  });
  const audit = createAuditBarrier({ sink });
  const gate = createGate({ catalog: compileCatalog(['repository.read', 'issue.read', 'pr.read'].map((action) => ({ action, kind: 'read', target: 'repository', enabled: true }))), audit });
  async function readGh(action, target, args) {
    const result = await gate.executeAction({}, action, { name: action, arguments: { target }, callId: randomUUID() }, async () => ({ value: await gh(args) }));
    if (result.kind === 'error' || audit.isDegraded()) throw new Error('GH_AUDIT_FAILED');
    return result.value;
  }
  try {
    const repository = await readGh('repository.read', options.repo, ['repo', 'view', options.repo, '--json', 'nameWithOwner,url,isPrivate,defaultBranchRef']);
    assert.equal(repository.nameWithOwner.toLowerCase(), options.repo.toLowerCase(), 'REPOSITORY_MISMATCH');
    // This rehearsal's explicitly authorized remote is GitHub. Do not let
    // returned metadata silently retarget links to another repository or host.
    assert.equal(typeof repository.url, 'string', 'REPOSITORY_URL_MISSING');
    assert.equal(repository.url.toLowerCase(), `https://github.com/${options.repo}`.toLowerCase(), 'REPOSITORY_URL_MISMATCH');
    assert.equal(typeof repository.defaultBranchRef?.name, 'string', 'DEFAULT_BRANCH_MISSING');
    const changes = [];
    for (const { changeId, issueNumber } of options.targets) {
      const report = await readChangeReport({ changeId, reader: readDop(), sink, mode: 'demo' });
      const issue = await readGh('issue.read', `${options.repo}#${issueNumber}`, ['issue', 'view', String(issueNumber), '--repo', options.repo, '--json', 'number,title,body,state,url,closedByPullRequestsReferences']);
      assert.equal(issue.number, issueNumber, 'ISSUE_MISMATCH');
      assert.equal(issue.url, `${repository.url}/issues/${issueNumber}`, 'ISSUE_REPOSITORY_MISMATCH');
      assert.ok(typeof issue.body === 'string' && new RegExp(`(?:^|\\n)[ \\-]*DOP change:[ \\t]*${changeId}(?=\\s|$)`, 'u').test(issue.body), 'ISSUE_CHANGE_LINK_MISSING');
      assert.ok(Array.isArray(issue.closedByPullRequestsReferences) && issue.closedByPullRequestsReferences.length <= 10, 'INVALID_CLOSING_REFS');
      const closingPullRequests = [];
      for (const ref of issue.closedByPullRequestsReferences) {
        assert.ok(Number.isSafeInteger(ref.number) && ref.number > 0, 'INVALID_PR_NUMBER');
        assert.equal(ref.url, `${repository.url}/pull/${ref.number}`, 'CROSS_REPOSITORY_PR');
        const pr = await readGh('pr.read', `${options.repo}#${ref.number}`, ['pr', 'view', String(ref.number), '--repo', options.repo, '--json', 'number,title,state,url,headRefOid,baseRefName,mergedAt']);
        assert.equal(pr.url, ref.url, 'PR_REPOSITORY_MISMATCH');
        assert.equal(pr.number, ref.number, 'PR_MISMATCH');
        assert.ok(typeof pr.headRefOid === 'string' && /^[a-f0-9]{40,64}$/u.test(pr.headRefOid), 'PR_REVISION_MISSING');
        closingPullRequests.push(pr);
      }
      const facts = { ...report.facts, repository: { url: repository.url, basis: 'explicit current-user mapping' }, fieldStates: { ...report.facts.fieldStates, repository: 'user-confirmed' }, limitations: report.facts.limitations.filter((s) => !s.startsWith('仓库映射')) };
      changes.push({ facts, issue, closingPullRequests });
    }
    const firstId = options.targets[0].changeId;
    const negativeChecks = [];
    await assert.rejects(() => readChangeReport({ changeId: firstId, reader: readDop({ OMS_MOCK_DOP_FAIL_GET: '1' }), sink, mode: 'demo' }), { code: 'CLI_FAILED' });
    negativeChecks.push('mock query failure is not a success');
    await assert.rejects(() => readChangeReport({ changeId: 'ZZZZZZ999999', reader: readDop(), sink, mode: 'demo' }), { code: 'CLI_FAILED' });
    negativeChecks.push('unknown explicit change is refused');
    let calls = 0;
    await assert.rejects(() => readChangeReport({ changeId: firstId, reader: { read() { calls++; } } }), { code: 'POLICY_DENIED' });
    assert.equal(calls, 0);
    negativeChecks.push('missing necessary audit means zero adapter calls');
    assert.equal(records.filter((r) => r.phase === 'begin').length, records.filter((r) => r.phase === 'settle').length, 'UNSETTLED_AUDIT');
    const summary = { observedAt: new Date().toISOString(), source: 'user-provided local DOP mock + real gh repository reads', repository, changes, negativeChecks, remoteWrites: 0, auditRecords: records.length };
    writeFileSync(join(options.output, 'trace.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(options.output, 'index.html'), renderTraceHtml(summary), { flag: 'wx', mode: 0o600 });
    return summary;
  } finally { gate.dispose(); closeSync(fd); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summary = await runRehearsal(parseRehearsalArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ changes: summary.changes.map((c) => ({ id: c.facts.id, issue: c.issue.number, issueState: c.issue.state, release: c.facts.release?.number, closingPRs: c.closingPullRequests.map((p) => p.number) })), negativeChecks: summary.negativeChecks.length, auditRecords: summary.auditRecords, remoteWrites: 0 }, null, 2));
  } catch { console.error('REHEARSAL_FAILED: explicit inputs, read results or audit could not be verified; no remote write was requested.'); process.exitCode = 1; }
}
