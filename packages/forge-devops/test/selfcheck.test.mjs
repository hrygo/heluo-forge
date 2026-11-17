/**
 * T6(r18) 启动自检（用户点击触发）：固定 argv、单行摘要、结构化报告、脱敏描述。
 *
 * 自检存在的理由：`ready=true` 只说明"入口已解析到能按本插件方式启动的**程序**"，
 * 不说明"它在这台机器上真跑得起来"（缺依赖 / 被隔离 / 架构不符）。两件事之间必须有人问，
 * 而且要在配置页里问——不能让用户点开业务命令才发现（内网现场）。
 *
 * 这些用例把三条边界钉成事实：
 *   1. **数据不是异常**：超时、起不来、非零退出都返回报告（`reason` 是枚举，页面不解析字符串）；
 *   2. **固定 argv**：只跑 `--version`，调用方给什么都不会被当成命令（自检不能变成通用通道）；
 *   3. **不碰装配期**：`createSelfCheck()` 不启动任何东西，只有 `check()` 才动。
 *
 * 全部离线：`run` 是注入的假实现，`now` 是假时钟；真机上的"能不能启动"仍是 NOT RUN。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SELFCHECK_ARGS,
  SELFCHECK_CONTRACT,
  SELFCHECK_OUTPUT_LIMIT,
  SELFCHECK_PURPOSE,
  SELFCHECK_REASONS,
  SELFCHECK_STATES,
  SELFCHECK_TIMEOUT_MS,
  createSelfCheck,
  createSelfCheckRunner,
  describeSelfCheck,
} from '../src/selfcheck.mjs';

const MODULE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'selfcheck.mjs');
/* 合成路径：本机路径字面量与真实盘符会触发仓库检查器。 */
const BIN = ['', 'opt', 'corp', 'dop'].join('/');
const SHIM = ['', 'opt', 'corp', 'dop.cmd'].join('/');
const clock = () => 1_700_000_000_000;

/** 假 `run`：记录每次调用，按队列返回结果；队列耗尽后返回可用的缺省值。 */
function makeRun(...outcomes) {
  const calls = [];
  const queue = [...outcomes];
  const run = async (request) => {
    calls.push(request);
    if (queue.length === 0) return { exitCode: 0, stdout: 'dop version 9.9.9', stderr: '', durationMs: 1 };
    return queue.shift();
  };
  return { run, calls };
}

test('常量契约：版本号、固定 argv、8s 超时、200 字符上限与两套冻结枚举', () => {
  assert.equal(SELFCHECK_CONTRACT, 1, '报告契约版本变了必须递增（页面按它判形状）');
  assert.deepEqual([...SELFCHECK_ARGS], ['--version'], '永远只问版本：不读项目、不写盘、不碰远端');
  assert.ok(Object.isFrozen(SELFCHECK_ARGS), 'argv 不许被调用方改写');
  assert.equal(SELFCHECK_PURPOSE, 'selfcheck');
  assert.equal(SELFCHECK_TIMEOUT_MS, 8_000, '自检挡在配置页交互前面，必须短于业务调用的 20s');
  assert.equal(SELFCHECK_OUTPUT_LIMIT, 200);
  assert.deepEqual(Object.values(SELFCHECK_REASONS), [
    'no-entry',
    'not-spawnable',
    'spawn-failed',
    'timed-out',
    'nonzero-exit',
    'ok',
  ]);
  assert.deepEqual(Object.values(SELFCHECK_STATES), ['pass', 'fail', 'not-run'], '状态词与 readiness 同一套，页面上不出现第二套"成没成"');
  for (const table of [SELFCHECK_REASONS, SELFCHECK_STATES]) assert.ok(Object.isFrozen(table), '枚举不许运行期改写');
});

test('构造期防御：缺 run / now 非函数抛 TypeError；timeoutMs 归一化但不越界', () => {
  assert.throws(() => createSelfCheck({}), TypeError, '没有 runner 就必须显式失败，不能"先跑再说"');
  assert.throws(() => createSelfCheck({ run: 'cli-runner' }), TypeError);
  assert.throws(() => createSelfCheck({ run: async () => ({}), now: 'later' }), TypeError);

  const { run } = makeRun();
  assert.equal(createSelfCheck({ run }).timeoutMs, SELFCHECK_TIMEOUT_MS, '缺省 8s');
  assert.equal(createSelfCheck({ run, timeoutMs: -5 }).timeoutMs, 1, '负数归一到 1ms（不静默变成"无限等"）');
  assert.equal(createSelfCheck({ run, timeoutMs: Number.NaN }).timeoutMs, SELFCHECK_TIMEOUT_MS, '非有限值回落缺省');
  assert.equal(createSelfCheck({ run, timeoutMs: 12.9 }).timeoutMs, 12);
  assert.deepEqual([...createSelfCheck({ run }).args], ['--version'], '自检器只认固定 argv，没有可配置命令');
  assert.ok(Object.isFrozen(createSelfCheck({ run })), '自检器实例冻结：装配后不许替换 run');
});

test('OK：exit 0 → pass，摘要取 stdout 首行，run 收到的正是固定 argv（AC-1）', async () => {
  const fake = makeRun({ exitCode: 0, stdout: 'dop version 1.2.3\nextra line', stderr: 'warn', durationMs: 12.7 });
  const checker = createSelfCheck({ run: fake.run, now: clock });
  const report = await checker.check({ bin: BIN, form: 'native' });

  assert.deepEqual(fake.calls, [{ bin: BIN, args: ['--version'], purpose: SELFCHECK_PURPOSE }], '唯一一次调用、唯一一组参数');
  assert.equal(report.reason, SELFCHECK_REASONS.OK);
  assert.equal(report.state, SELFCHECK_STATES.PASS);
  assert.equal(report.ok, true);
  assert.equal(report.started, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.durationMs, 12, '实测耗时向下取整');
  assert.equal(report.at, 1_700_000_000_000, '时间戳来自注入的 now');
  assert.equal(report.argv, '--version');
  assert.equal(report.output, 'dop version 1.2.3', '成功时只说版本，不把 stderr 的告警混进来');
  assert.equal(report.form, 'native');
  assert.equal(report.contract, SELFCHECK_CONTRACT);
  assert.ok(Object.isFrozen(report), '报告是数据：下游不许改它');
});

test('SPAWN_FAILED：exitCode 为 null → 没启动起来，state=fail（AC-5）', async () => {
  const fake = makeRun({ exitCode: null, stderr: 'spawn ENOENT\nat ...', durationMs: 3 });
  const report = await createSelfCheck({ run: fake.run, now: clock }).check({ bin: BIN });

  assert.equal(report.reason, SELFCHECK_REASONS.SPAWN_FAILED);
  assert.equal(report.state, SELFCHECK_STATES.FAIL);
  assert.equal(report.ok, false);
  assert.equal(report.started, false, '压根没启动，不能报"跑过但失败"');
  assert.equal(report.output, 'spawn ENOENT', '失败时摘 stderr 首行（给一句能查的话）');
  assert.equal(report.exitCode, null);
  assert.equal('form' in report, false, '没给形态就不编造这个键');
});

test('NONZERO_EXIT：非 0 退出 → 结构化失败，退出码原样保留（AC-5）', async () => {
  const fake = makeRun({ exitCode: 2, stdout: 'out\nmore', stderr: 'unknown flag\n' });
  const report = await createSelfCheck({ run: fake.run, now: clock }).check({ bin: BIN, form: 'native' });

  assert.equal(report.reason, SELFCHECK_REASONS.NONZERO_EXIT);
  assert.equal(report.state, SELFCHECK_STATES.FAIL);
  assert.equal(report.exitCode, 2, '页面要能显示"退出码 2"，不是一句"失败了"');
  assert.equal(report.started, true);
  assert.equal(report.output, 'unknown flag', '失败分支优先 stderr');
});

test('TIMED_OUT：超时优先生效，且 started=true（它确实启动过）', async () => {
  const timedOut = makeRun({ timedOut: true, exitCode: null, stderr: 'still running' });
  const report = await createSelfCheck({ run: timedOut.run, now: clock }).check({ bin: BIN });

  assert.equal(report.reason, SELFCHECK_REASONS.TIMED_OUT);
  assert.equal(report.state, SELFCHECK_STATES.FAIL);
  assert.equal(report.started, true, '超时说明进程起来了，只是没在预算内结束');
  assert.equal(report.exitCode, null);
  assert.equal(report.output, 'still running');

  // 即使 runner 同时给了退出码，超时仍是"没等到结论"，覆盖别的判定。
  const both = makeRun({ timedOut: true, exitCode: 1, stderr: 'lag' });
  const report2 = await createSelfCheck({ run: both.run, now: clock }).check({ bin: BIN });
  assert.equal(report2.reason, SELFCHECK_REASONS.TIMED_OUT);
});

test('NO_ENTRY：没有入口即 not-run，且根本不调 run（自检不是"试探"）', async () => {
  const fake = makeRun();
  const checker = createSelfCheck({ run: fake.run, now: clock });
  for (const entry of [{}, { bin: '' }, { bin: '   ' }, { bin: null }]) {
    const report = await checker.check(entry);
    assert.equal(report.reason, SELFCHECK_REASONS.NO_ENTRY, JSON.stringify(entry));
    assert.equal(report.state, SELFCHECK_STATES.NOT_RUN);
    assert.equal(report.started, false);
    assert.equal(report.ok, false);
    assert.equal(report.output, '');
    assert.equal(report.durationMs, 0);
  }
  assert.deepEqual(fake.calls, [], '没有入口就不该产生任何子进程');
});

test('NOT_SPAWNABLE：解析阶段已判定"起不来"时直接给结果，不把 shim 交给 execFile（AC-4/AC-9）', async () => {
  const fake = makeRun();
  const report = await createSelfCheck({ run: fake.run, now: clock }).check({ bin: SHIM, form: 'wrapper', spawnable: false });

  assert.equal(report.reason, SELFCHECK_REASONS.NOT_SPAWNABLE);
  assert.equal(report.state, SELFCHECK_STATES.FAIL);
  assert.equal(report.started, false);
  assert.equal(report.exitCode, null);
  assert.equal(report.form, 'wrapper', '把形态带回去，页面才能解释"为什么不能启动"');
  assert.deepEqual(fake.calls, [], '已知起不来就不要真跑一次（也避免把壳当程序执行）');
});

test('摘要纪律：单行、去控制字符、超 200 字符截断加省略号', async () => {
  const long = 'v'.repeat(SELFCHECK_OUTPUT_LIMIT + 50);
  const messy = makeRun({ exitCode: 0, stdout: `\n\n  dop\tversion 3  \r\n`, durationMs: 0 });
  assert.equal(
    (await createSelfCheck({ run: messy.run, now: clock }).check({ bin: BIN })).output,
    'dop version 3',
    '取首个非空行并去首尾空白：报告要能直接贴进一句话',
  );

  const truncated = makeRun({ exitCode: 0, stdout: long });
  const report = await createSelfCheck({ run: truncated.run, now: clock }).check({ bin: BIN });
  assert.equal(report.output.length, SELFCHECK_OUTPUT_LIMIT + 1, '上限 + 一个省略号');
  assert.equal(report.output.endsWith('…'), true);
  assert.equal(report.output.startsWith('v'.repeat(SELFCHECK_OUTPUT_LIMIT)), true);

  const binary = makeRun({ exitCode: 0, stdout: 'a\u0000b\u001b[0m c' });
  assert.equal(
    (await createSelfCheck({ run: binary.run, now: clock }).check({ bin: BIN })).output,
    'a b [0m c',
    '控制字符替换成空格：不让终端转义序列进入页面/日志',
  );

  const empty = makeRun({ exitCode: 0, stdout: '', stderr: 'ignored' });
  assert.equal(
    (await createSelfCheck({ run: empty.run, now: clock }).check({ bin: BIN })).output,
    '',
    '没输出就是空串，不拿 stderr 凑数',
  );
});

test('describeSelfCheck：只出状态/原因/耗时/退出码与一行版本，零路径零 stderr 细节（AC-10）', async () => {
  const report = await createSelfCheck({ run: makeRun({ exitCode: 2, stderr: 'unknown flag --nope' }).run, now: clock })
    .check({ bin: BIN, form: 'native' });
  const described = describeSelfCheck(report);

  assert.equal(described.state, SELFCHECK_STATES.FAIL);
  assert.equal(described.reason, SELFCHECK_REASONS.NONZERO_EXIT);
  assert.equal(described.exitCode, 2);
  assert.equal(described.argv, '--version');
  assert.equal(described.form, 'native');
  assert.deepEqual(Object.keys(described).sort(), [
    'argv', 'durationMs', 'exitCode', 'form', 'ok', 'output', 'reason', 'started', 'state',
  ], '脱敏描述没有路径字段，也不透传 at/contract（那是报告内部事实）');
  // 报告本身可以带入口路径（主机内），但描述里不许把它当成字段回传——这是"能不能进工具输出"的分界线。
  // 注意：`output` 是 CLI 自己打印的一行，内容由对方决定；这里说的是不出现 `bin`/`resolvedFrom` 之类字段。
  assert.equal(JSON.stringify(described).includes(BIN), false, '脱敏描述不得含入口路径字段');
  assert.equal(JSON.stringify(described).includes(SHIM), false);
  assert.equal('bin' in described, false);
  assert.equal('resolvedFrom' in described, false);
  assert.equal('at' in described, false);
  assert.equal(JSON.stringify(describeSelfCheck(null)).includes('no-entry'), true, '非对象输入按"没跑"处理，不抛错');
  assert.equal(describeSelfCheck({}).state, SELFCHECK_STATES.NOT_RUN);
  assert.ok(describeSelfCheck(report) !== report || Object.isFrozen(described), '描述是新对象或冻结值');
});

test('装配期零执行：createSelfCheck / createSelfCheckRunner 不启动任何东西', async () => {
  const fake = makeRun();
  const checker = createSelfCheck({ run: fake.run, now: clock });
  assert.deepEqual(fake.calls, [], '构造自检器不得跑子进程（打开设置页不能变成一次外部执行）');

  const runner = createSelfCheckRunner({ processEnv: {} });
  assert.equal(typeof runner.check, 'function', '缺省装配交出一个可点的检查器');
  assert.equal(typeof runner.timeoutMs, 'number');
  assert.deepEqual(fake.calls, [], '装配完成也不执行');

  await checker.check({ bin: BIN });
  assert.equal(fake.calls.length, 1, '只有显式 check() 才动');
});

test('源码纪律：只经 cli-runner 这一条子进程通道，argv 写死，不自带 shell', () => {
  const text = readFileSync(MODULE_FILE, 'utf8');
  const banned = [
    [/from\s*'node:child_process'/, 'node:child_process'],
    [/\bexecSync\s*\(/, 'execSync'],
    [/\bexecFile\s*\(/, 'execFile'],
    [/\bspawn(?:Sync)?\s*\(/, 'spawn'],
    [/\bshell\s*:\s*true/, 'shell:true'],
  ];
  const hits = banned.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  assert.deepEqual(hits, [], `自检不得自己开子进程通道（必须复用 cli-runner）：${hits.join('; ')}`);
  const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./cli-runner.mjs'], `唯一依赖是本包的唯一子进程通道：${imports.join(', ')}`);
  assert.match(text, /export const SELFCHECK_ARGS = Object\.freeze\(\['--version'\]\)/, '固定 argv 必须是写死的常量');
  assert.equal(/args\s*:\s*\[\.\.\.(?!SELFCHECK_ARGS)/.test(text), false, '不得把调用方传入的数组当命令');
});
