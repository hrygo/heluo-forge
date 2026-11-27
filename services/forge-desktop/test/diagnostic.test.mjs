/**
 * Tests of what the shell tells about a failure: the installer's verdict as it
 * is repeated, the entry written to the log, what the status page is given,
 * and the rules the page itself keeps.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DIAGNOSTIC_LOG_PARTS,
  REASON_LIMIT,
  REMEDY_LIMIT,
  appendDiagnostic,
  clipped,
  diagnosticLogPath,
  failureRecord,
  firstRunDone,
  firstRunStopped,
  installerVerdict,
  statusQuery,
} from '../src/diagnostic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POSIX = process.platform !== 'win32';

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-diagnostic-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const AT = new Date('2026-11-25T12:00:00.000Z');

/** An installer verdict as the shell's error about the first run carries it. */
const DETAILS = Object.freeze({
  code: 'IAM_DISCOVERY_FAILED',
  reason: 'init: 读取 IAM Discovery 失败（fetch failed）：https://idp.corp.example/x',
  next: '确认这台机器能访问企业 IAM 后重试；密钥文件仍保留。',
  lines: ['企业插件初始化', 'profile：web'],
  warnings: ['warn: 一条警告'],
});

test('the verdict repeats the installer: its code, reason, remedy, and only the strings it printed', () => {
  assert.deepEqual(installerVerdict({ ...DETAILS, lines: [...DETAILS.lines, { not: 'a string' }, undefined], env: { TOKEN: 'x' } }), {
    code: DETAILS.code,
    reason: DETAILS.reason,
    remedy: DETAILS.next,
    lines: DETAILS.lines,
    warnings: DETAILS.warnings,
  });
  // Line breaks in what the installer said are folded: the page gets one line, the log stays readable.
  assert.equal(installerVerdict({ ...DETAILS, reason: 'first line\n\tsecond   line  ' }).reason, 'first line second line');
});

test('反向：没有结论时什么都不编造', () => {
  const empty = { code: 'UNKNOWN', reason: '', remedy: '', lines: [], warnings: [] };
  for (const missing of [undefined, null, {}, { code: '' }, { lines: 'not a list', warnings: 42 }]) {
    assert.deepEqual(installerVerdict(missing), empty);
  }
});

test('a line is cut to its limit, and only when it is longer', () => {
  assert.equal(clipped('short', 10), 'short');
  assert.equal(clipped('  a  b\n c\t', 10), 'a b c');
  assert.equal(clipped('x'.repeat(REASON_LIMIT), REASON_LIMIT).length, REASON_LIMIT);
  const cut = clipped('x'.repeat(REASON_LIMIT + 300), REASON_LIMIT);
  assert.equal(cut.length, REASON_LIMIT);
  assert.ok(cut.endsWith('…') && cut.startsWith('x'));
  // What is kept is the beginning: the code and the cause come first in what the installer prints.
  // Twenty-nine characters and the ellipsis make the limit of thirty.
  assert.equal(clipped('IAM_CLIENT_SECRET_PROVISION_FAILED: the store refused it', 30), 'IAM_CLIENT_SECRET_PROVISION_F…');
});

test('the status page is given the verdict; where the installer said nothing the shell\'s guidance stands in', () => {
  const verdict = installerVerdict(DETAILS);
  const fallback = '回到企业网络后从托盘菜单重试。';
  assert.deepEqual(statusQuery({ state: 'initializing' }), { state: 'initializing' });
  assert.deepEqual(statusQuery({ state: 'failed', code: 'ASSETS_INVALID', fallback }), { state: 'failed', code: 'ASSETS_INVALID', remedy: fallback });
  // A package refused before the installer ran has no verdict and no log line about one.
  assert.deepEqual(statusQuery({ state: 'failed', code: 'ASSETS_NOT_FOUND', verdict: null, fallback, log: '/data/logs/first-run.log' }), {
    state: 'failed',
    code: 'ASSETS_NOT_FOUND',
    remedy: fallback,
    log: '/data/logs/first-run.log',
  });
  assert.deepEqual(statusQuery({ state: 'failed', code: 'FIRST_RUN_FAILED', verdict, fallback, log: '/data/logs/first-run.log' }), {
    state: 'failed',
    code: 'FIRST_RUN_FAILED',
    installer: 'IAM_DISCOVERY_FAILED',
    reason: DETAILS.reason,
    remedy: DETAILS.next,
    log: '/data/logs/first-run.log',
  });
  // The installer's remedy wins over the generic guidance; an installer without one defers to it.
  assert.equal(statusQuery({ state: 'failed', code: 'FIRST_RUN_FAILED', verdict, fallback }).remedy, DETAILS.next);
  const silent = installerVerdict({ code: 'VERIFY_FAILED', reason: 'init: 安装后核验失败' });
  assert.deepEqual(statusQuery({ state: 'failed', code: 'FIRST_RUN_FAILED', verdict: silent, fallback }), {
    state: 'failed',
    code: 'FIRST_RUN_FAILED',
    installer: 'VERIFY_FAILED',
    reason: 'init: 安装后核验失败',
    remedy: fallback,
  });
  // Nothing is added for what neither said, and an empty log path is not a path.
  assert.deepEqual(statusQuery({ state: 'failed', code: 'FIRST_RUN_FAILED', verdict: installerVerdict(undefined), fallback: '', log: '' }), {
    state: 'failed',
    code: 'FIRST_RUN_FAILED',
    installer: 'UNKNOWN',
  });
});

test('反向：交给状态页的每一段都是一行且有上限', () => {
  const long = installerVerdict({ code: 'X', reason: `a\n${'r'.repeat(REASON_LIMIT + 50)}`, next: `b\n${'n'.repeat(REMEDY_LIMIT + 50)}` });
  const query = statusQuery({ state: 'failed', code: 'FIRST_RUN_FAILED', verdict: long });
  assert.equal(query.reason.length, REASON_LIMIT);
  assert.equal(query.remedy.length, REMEDY_LIMIT);
  for (const [key, value] of Object.entries(query)) {
    assert.equal(typeof value, 'string', `${key} is text`);
    assert.equal(/[\r\n]/u.test(value), false, `${key} is one line`);
  }
});

test('the log entry of a stopped first run is the installer\'s account, whole and in order', () => {
  const entry = firstRunStopped({ at: AT, code: 'FIRST_RUN_FAILED', verdict: installerVerdict(DETAILS) });
  assert.equal(
    entry,
    [
      '=== 2026-11-25T12:00:00.000Z 企业配置初始化：失败 ===',
      '错误码：FIRST_RUN_FAILED（安装器 IAM_DISCOVERY_FAILED）',
      `原因：${DETAILS.reason}`,
      `处理：${DETAILS.next}`,
      '回显：',
      '  企业插件初始化',
      '  profile：web',
      '警告：',
      '  warn: 一条警告',
    ].join('\n'),
  );
  // What the installer did not say is marked as such, not left out as if it had been read.
  const bare = firstRunStopped({ at: AT, code: 'FIRST_RUN_FAILED', verdict: installerVerdict({ code: 'PNPM_REQUIRED' }) });
  assert.equal(bare, '=== 2026-11-25T12:00:00.000Z 企业配置初始化：失败 ===\n错误码：FIRST_RUN_FAILED（安装器 PNPM_REQUIRED）\n原因：（安装器未给出）\n处理：（安装器未给出）');
});

test('the log entry of a refused package is the shell\'s own account, with what was wrong in the package', () => {
  const error = Object.assign(new Error('the employee package is not intact'), { details: { problems: ['TARBALL does not match its digest', 'installer/x.mjs is missing'] } });
  assert.equal(
    firstRunStopped({ at: AT, code: 'ASSETS_INVALID', verdict: null, error }),
    [
      '=== 2026-11-25T12:00:00.000Z 企业配置初始化：失败 ===',
      '错误码：ASSETS_INVALID',
      '说明：the employee package is not intact',
      '问题：',
      '  TARBALL does not match its digest',
      '  installer/x.mjs is missing',
    ].join('\n'),
  );
  // Without problems there is no list of them, and without an error nothing is invented.
  assert.equal(firstRunStopped({ at: AT, code: 'ASSETS_NOT_FOUND', error: new Error('no employee package was found') }), '=== 2026-11-25T12:00:00.000Z 企业配置初始化：失败 ===\n错误码：ASSETS_NOT_FOUND\n说明：no employee package was found');
});

test('the log entry of a completed first run carries the installer\'s conclusion and output', () => {
  const outcome = { code: 0, lines: ['状态：已安装同版本 1.2.3-corp.1，本次不写入', { not: 'a string' }], warnings: [], result: { ok: true, status: 'already-installed' } };
  assert.equal(
    firstRunDone({ at: AT, outcome }),
    '=== 2026-11-25T12:00:00.000Z 企业配置初始化：完成 ===\n安装器结论：already-installed（退出码 0）\n回显：\n  状态：已安装同版本 1.2.3-corp.1，本次不写入',
  );
  assert.equal(firstRunDone({ at: AT, outcome: undefined }), '=== 2026-11-25T12:00:00.000Z 企业配置初始化：完成 ===\n安装器结论：UNKNOWN（退出码 UNKNOWN）');
});

test('反向：只有安装器说过的话进日志；结论之外的任何字段都不被重复', () => {
  const verdict = installerVerdict({ ...DETAILS, env: { HELUO_IAM_CLIENT_SECRET: 'synthetic-secret-value' }, secret: 'synthetic-secret-value', token: 'synthetic-token-value' });
  const text = [firstRunStopped({ at: AT, code: 'FIRST_RUN_FAILED', verdict }), firstRunDone({ at: AT, outcome: { ...verdict, result: { status: 'installed', secret: 'synthetic-secret-value' } } })].join('\n');
  for (const value of ['synthetic-secret-value', 'synthetic-token-value', 'HELUO_IAM_CLIENT_SECRET', '[object Object]']) {
    assert.equal(text.includes(value), false, `${value} must not reach the log`);
  }
});

test('a failure that ends the application is recorded with its code and the shell\'s account of it', () => {
  assert.equal(failureRecord({ at: AT, code: 'START_TIMEOUT', message: 'the web profile did not announce\nits address within 60000 ms' }), '=== 2026-11-25T12:00:00.000Z 应用未能启动 ===\n错误码：START_TIMEOUT\n说明：the web profile did not announce its address within 60000 ms');
  assert.equal(failureRecord({ at: AT, code: 'UNKNOWN', message: undefined }), '=== 2026-11-25T12:00:00.000Z 应用未能启动 ===\n错误码：UNKNOWN\n说明：');
  assert.equal(failureRecord({ at: 'not a date', code: 'X', message: 'm' }).startsWith('=== not a date 应用未能启动 ==='), true);
});

/** A web profile that exited while starting, as the runtime reports it. */
const SERVICE = Object.freeze({
  phase: 'failed',
  origin: null,
  failure: { code: 'EXITED_BEFORE_READY', message: 'the web profile exited (code 1)' },
  exit: { code: 1, signal: null },
  output: {
    stdout: '',
    stderr: 'dsh: startup failed: 1 required plugins did not activate\n\nFailed plugins (1):\n  web-runtime (required)\n',
  },
});

test('the record of a service that failed carries how it ended and the end of what it printed', () => {
  assert.equal(
    failureRecord({ at: AT, code: 'EXITED_BEFORE_READY', message: SERVICE.failure.message, service: SERVICE }),
    [
      '=== 2026-11-25T12:00:00.000Z 应用未能启动 ===',
      '错误码：EXITED_BEFORE_READY',
      '说明：the web profile exited (code 1)',
      '退出码：1',
      '本机服务标准错误（尾部）：',
      '  dsh: startup failed: 1 required plugins did not activate',
      '  Failed plugins (1):',
      '  web-runtime (required)',
    ].join('\n'),
  );
  // A process that was killed has no code: the signal is said instead. A stream that printed nothing has no section.
  const killed = { ...SERVICE, exit: { code: null, signal: 'SIGKILL' }, output: { stdout: 'dsh web: booting\n', stderr: '' } };
  assert.equal(
    failureRecord({ at: AT, code: 'START_TIMEOUT', message: 'm', service: killed }),
    '=== 2026-11-25T12:00:00.000Z 应用未能启动 ===\n错误码：START_TIMEOUT\n说明：m\n退出信号：SIGKILL\n本机服务标准输出（尾部）：\n  dsh web: booting',
  );
  // A start that timed out has not seen the process end: nothing is said about how it ended.
  const pending = { ...SERVICE, exit: null, output: { stdout: '', stderr: 'still loading\n' } };
  assert.equal(
    failureRecord({ at: AT, code: 'START_TIMEOUT', message: 'm', service: pending }),
    '=== 2026-11-25T12:00:00.000Z 应用未能启动 ===\n错误码：START_TIMEOUT\n说明：m\n本机服务标准错误（尾部）：\n  still loading',
  );
  // Nothing printed and nothing ended: the record is the one written without a service.
  const silent = { ...SERVICE, exit: null, output: { stdout: '', stderr: '' } };
  assert.equal(failureRecord({ at: AT, code: 'SPAWN_FAILED', message: 'm', service: silent }), '=== 2026-11-25T12:00:00.000Z 应用未能启动 ===\n错误码：SPAWN_FAILED\n说明：m');
});

test('反向：进日志的服务输出有界，日志这一道口上再抹一次地址参数', () => {
  // The bounds are the contract: the last sixty lines, eight KiB to a stream, six hundred characters to a line.
  const stdout = `${Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n')}\n`;
  // Thirty lines past the length of a line: together they are past the bytes of a stream.
  const stderr = `${Array.from({ length: 30 }, () => 'e'.repeat(700)).join('\n')}\nhttp://127.0.0.1:43210/?token=synthetic-token-value\n`;
  const entry = failureRecord({ at: AT, code: 'START_TIMEOUT', message: 'm', service: { ...SERVICE, exit: null, output: { stdout, stderr } } });
  const [head, rest] = entry.split('本机服务标准错误（尾部）：\n');
  const [errText, outText] = rest.split('本机服务标准输出（尾部）：\n');
  assert.equal(head, '=== 2026-11-25T12:00:00.000Z 应用未能启动 ===\n错误码：START_TIMEOUT\n说明：m\n');
  // What was dropped is said, then the end of it. A line cut to six hundred characters ends in an ellipsis, so it
  // is 602 bytes: eight KiB hold thirteen of them and the last line (29 bytes), not a fourteenth of them.
  const errLines = errText.replace(/\n$/u, '').split('\n');
  assert.equal(errLines[0], '  …（更早的输出已省略）');
  assert.equal(errLines.at(-1), '  http://127.0.0.1:43210/?…');
  assert.ok(errLines.slice(1, -1).every((line) => line === `  ${'e'.repeat(599)}…`));
  assert.equal(errLines.length, 15);
  const outLines = outText.split('\n');
  assert.equal(outLines[0], '  …（更早的输出已省略）');
  assert.equal(outLines[1], '  line 40');
  assert.equal(outLines.at(-1), '  line 99');
  assert.equal(outLines.length, 61);
  assert.equal(entry.includes('synthetic-token-value'), false, 'the query of an address never reaches the log, whatever handed it over');
});

test('the log is created where it is needed, readable by its owner only, and appended to', { skip: !POSIX }, (t) => {
  const root = temp(t);
  const log = diagnosticLogPath(join(root, 'userData'));
  assert.equal(log, join(root, 'userData', ...DIAGNOSTIC_LOG_PARTS));
  assert.equal(existsSync(log), false);
  assert.equal(appendDiagnostic(log, 'first'), true);
  assert.equal(appendDiagnostic(log, 'second'), true);
  assert.equal(readFileSync(log, 'utf8'), 'first\nsecond\n');
  assert.equal(statSync(log).mode & 0o777, 0o600, 'the log holds what the installer printed: its owner reads it, nobody else');
  assert.equal(statSync(dirname(log)).mode & 0o777, 0o700);
});

test('反向：写不进的日志不抛错，只报告没写上', (t) => {
  const root = temp(t);
  // A file where the log's directory would be: the directory cannot be created.
  const blocked = join(root, 'occupied');
  writeFileSync(blocked, 'not a directory');
  assert.equal(appendDiagnostic(join(blocked, 'logs', 'first-run.log'), 'entry'), false);
  assert.equal(readFileSync(blocked, 'utf8'), 'not a directory', 'what blocked the path is left as it was');
  assert.equal(appendDiagnostic(undefined, 'entry'), false);
  assert.equal(appendDiagnostic(logPathUnderFile(root), ''), false);
});

function logPathUnderFile(root) {
  mkdirSync(join(root, 'dir'));
  return join(root, 'dir', '..', 'occupied', 'x.log');
}

/** Kept pure so the mutation case below proves each rule fails. */
export function statusPageProblems(source) {
  const problems = [];
  // Everything the shell sends is read, and only ever as text.
  for (const name of ['installer', 'reason', 'remedy', 'log']) {
    if (!source.includes(`query.get('${name}')`)) problems.push(`the status page must read "${name}"`);
  }
  if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/u.test(source)) problems.push('the status page must show text only, never markup or code');
  // Nothing from outside, and no capability: the page is the shell's own file.
  if (/<a\b|https?:\/\/|<script[^>]*\bsrc=|preload|require\(/u.test(source)) problems.push('the status page must stay local and without shell capability');
  return problems;
}

test('状态页约束：读取明细并只以文本显示，无外链、无脚本能力（变异证明）', async () => {
  const page = await readFileSync(join(HERE, '..', 'resources', 'status.html'), 'utf8');
  assert.deepEqual(statusPageProblems(page), []);
  const variants = [
    [page.replace("query.get('reason')", "query.get('cause')"), /must read "reason"/],
    [page.replace("query.get('remedy')", "query.get('fix')"), /must read "remedy"/],
    [page.replace("query.get('log')", "query.get('file')"), /must read "log"/],
    [page.replace("query.get('installer')", "query.get('code')"), /must read "installer"/],
    [page.replace("document.getElementById(textId).textContent = text;", "document.getElementById(textId).innerHTML = text;"), /must show text only/],
    [page.replace('</footer>', '<a href="https://corp.example/help">帮助</a></footer>'), /must stay local/],
    [page.replace('<script>', '<script src="./status.js">'), /must stay local/],
  ];
  for (const [variant, pattern] of variants) {
    const problems = statusPageProblems(variant);
    assert.ok(problems.length > 0, 'a mutated page must produce at least one problem');
    assert.match(problems.join('\n'), pattern);
  }
});
