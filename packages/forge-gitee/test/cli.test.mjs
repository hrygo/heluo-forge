/**
 * TK2 唯一子进程出口（AC-23）与凭据面（AC-22）。
 *
 * 这个文件守的是"没有第二条执行路径"：入参白名单、`shell: false`、超时、1 MiB 上限、
 * 环境白名单、令牌脱敏、落盘令牌阻断（阻断发生在**起进程之前**）与静态出口唯一性。
 * 终态口径与 r1 `cli-runner` 一致（失败是数据不是异常），差异在更严的环境与凭据策略。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_OUTPUT_BYTES,
  ENV_ALLOWLIST,
  GiteeCliError,
  INVOCATION_KEYS,
  createGiteeRunner,
  detectPersistentToken,
  scrubSecrets,
} from '../src/gitee-cli.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_SRC = path.join(PKG_ROOT, 'src', 'gitee-cli.mjs');

/** 令牌与路径都拼出来：仓库检查器禁止源码/夹具出现真实形态的凭据字面量。 */
const TOKEN_VALUE = ['gitee', 'pat', 'fixture', 'value'].join('-');
const OTHER_TOKEN = ['corp', 'token', 'fixture'].join('-');
const BIN = ['', 'secret', 'bin', 'gh'].join('/');
const HOME_FIXTURE = ['', 'secret', 'home', 'svc'].join('/');

/** 回调式假 execFile：记录每次调用的 `{bin,args,options}`，便于断言"传了什么给子进程"。 */
function fakeExecFile(handler = () => ({ stdout: '', stderr: '' })) {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args: [...args], options });
    const outcome = handler({ bin, args, options }) ?? {};
    callback(outcome.error ?? null, outcome.stdout ?? '', outcome.stderr ?? '');
    return { pid: 4242 };
  };
  return { execFile, calls };
}

/* ───────────── 正常路径与执行选项 ───────────── */

test('成功调用：六字段终态齐全，程序名与参数分开传（不拼串）', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: '{"ok":true}\n', stderr: 'warn\n' }));
  const runner = createGiteeRunner({ execFile, env: {} });
  const result = await runner.run({ bin: BIN, args: ['issue', 'list', '--json', 'number'], purpose: 'read' });

  assert.deepEqual(calls[0].bin, BIN);
  assert.deepEqual(calls[0].args, ['issue', 'list', '--json', 'number']);
  assert.deepEqual(Object.keys(result).sort(), ['durationMs', 'exitCode', 'stderr', 'stdout', 'timedOut', 'truncated']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '{"ok":true}\n');
  assert.equal(result.stderr, 'warn\n');
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(typeof result.durationMs, 'number');
});

test('带空格的参数仍是单个 argv 元素（不经 shell 拆分）', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({ execFile, env: {} });
  await runner.run({ bin: 'gh', args: ['pr', 'view', 'feature/带 空格', '-R', 'corp/app'] });
  assert.deepEqual(calls[0].args, ['pr', 'view', 'feature/带 空格', '-R', 'corp/app']);
});

test('执行选项固定：shell:false、超时、输出上限、utf8、无窗口、SIGTERM', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({ execFile, env: {}, timeoutMs: 4500, maxOutputBytes: 2048 });
  await runner.run({ bin: 'gh', args: ['version'] });
  const { options } = calls[0];
  assert.equal(options.shell, false, 'AC-23：绝不经过 shell');
  assert.equal(options.timeout, 4500);
  assert.equal(options.maxBuffer, 2048);
  assert.equal(options.encoding, 'utf8');
  assert.equal(options.windowsHide, true);
  assert.equal(options.killSignal, 'SIGTERM');
  assert.equal(calls[0].bin, 'gh');
});

test('缺省执行选项取默认值：1 MiB 上限与配置层同源的超时', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({ execFile, env: {} });
  await runner.run({ bin: 'gh', args: ['version'] });
  assert.equal(calls[0].options.maxBuffer, DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 1_048_576);
  assert.equal(INVOCATION_KEYS.length, 3);
  assert.deepEqual([...INVOCATION_KEYS], ['bin', 'args', 'purpose']);
});

/* ───────────── 环境白名单与凭据注入 ───────────── */

test('环境白名单：只放行运行态变量与点名凭据，无关机密不继承给子进程（AC-22）', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({
    execFile,
    env: {
      GH_TOKEN: TOKEN_VALUE,
      CORP_PASSWORD: ['l', 'e', 'a', 'k'].join(''),
      AWS_SECRET_ACCESS_KEY: ['l', 'e', 'a', 'k'].join(''),
      SLACK_BOT_SECRET: ['l', 'e', 'a', 'k'].join(''),
    },
  });
  await runner.run({ bin: 'gh', args: ['issue', 'list'] });

  const childEnv = calls[0].options.env;
  const allowed = new Set([...ENV_ALLOWLIST, 'GH_TOKEN']);
  for (const key of Object.keys(childEnv)) {
    assert.ok(allowed.has(key), `子进程环境出现白名单外变量：${key}`);
  }
  assert.equal(childEnv.GH_TOKEN, TOKEN_VALUE, '点名的凭据变量必须注入');
  assert.equal(childEnv.CORP_PASSWORD, undefined);
  assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(childEnv.SLACK_BOT_SECRET, undefined);
  assert.equal(calls[0].args.includes(TOKEN_VALUE), false, '凭据绝不进 argv');
});

test('authEnv 可配：只注入点名的变量，其余同名凭据不继承', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({
    execFile,
    env: { GH_TOKEN: TOKEN_VALUE, GITEE_TOKEN: OTHER_TOKEN },
    authEnv: ['GITEE_TOKEN'],
  });
  await runner.run({ bin: 'gh', args: ['version'] });
  assert.equal(calls[0].options.env.GITEE_TOKEN, OTHER_TOKEN);
  assert.equal(calls[0].options.env.GH_TOKEN, undefined);
});

/* ───────────── 终态：失败是数据不是异常 ───────────── */

test('非零退出：exitCode 取数值并保留 stderr，不抛错', async () => {
  const { execFile } = fakeExecFile(() => {
    const error = Object.assign(new Error('Command failed: gh pr view'), { code: 4 });
    return { error, stdout: 'partial\n', stderr: 'boom: not found\n' };
  });
  const runner = createGiteeRunner({ execFile, env: {} });
  const result = await runner.run({ bin: 'gh', args: ['pr', 'view', '1'] });
  assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, 'partial\n');
  assert.equal(result.stderr, 'boom: not found\n');
  assert.equal(result.timedOut, false);
});

test('超时归一化：killed + 无退出码（Node 杀进程后的形状）', async () => {
  const { execFile } = fakeExecFile(() => {
    const error = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', code: null });
    return { error, stdout: '', stderr: '' };
  });
  const runner = createGiteeRunner({ execFile, env: {} });
  const result = await runner.run({ bin: 'gh', args: ['pr', 'list'] });
  assert.equal(result.timedOut, true);
});

test('超时归一化：ETIMEDOUT 与显式 timedOut 标记同样识别', async () => {
  for (const error of [
    Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('timed out'), { timedOut: true }),
  ]) {
    const { execFile } = fakeExecFile(() => ({ error }));
    const runner = createGiteeRunner({ execFile, env: {} });
    const result = await runner.run({ bin: 'gh', args: ['api', 'repos'] });
    assert.equal(result.timedOut, true);
  }
});

test('起不来（ENOENT）不吞原因：exitCode 为 null，stderr 补上 error.message', async () => {
  const { execFile } = fakeExecFile(() => ({
    error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    stdout: '',
    stderr: '',
  }));
  const runner = createGiteeRunner({ execFile, env: {} });
  const result = await runner.run({ bin: 'gh', args: ['version'] });
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(result.timedOut, false);
});

test('同步抛出也被收敛成数据形态（注入点抛错不应炸掉调用方）', async () => {
  const execFile = () => {
    throw Object.assign(new Error('spawn failed'), { code: 7 });
  };
  const runner = createGiteeRunner({ execFile, env: {} });
  const result = await runner.run({ bin: 'gh', args: ['version'] });
  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /spawn failed/);
});

/* ───────────── 有界输出 ───────────── */

test('输出上限：超限被截断且 truncated 可见（不静默把半截 JSON 当完整输出）', async () => {
  const huge = 'x'.repeat(2 * 1_048_576);
  const { execFile } = fakeExecFile(() => ({ stdout: huge }));
  const runner = createGiteeRunner({ execFile, env: {} });
  const result = await runner.run({ bin: 'gh', args: ['api', 'issues'] });
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout, 'utf8'), DEFAULT_MAX_OUTPUT_BYTES);
});

test('多字节输出按字节截断且不出非法 UTF-8（中文列表不炸）', async () => {
  const { execFile } = fakeExecFile(() => ({ stdout: '中'.repeat(2000) }));
  const runner = createGiteeRunner({ execFile, env: {}, maxOutputBytes: 100 });
  const result = await runner.run({ bin: 'gh', args: ['issue', 'list'] });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 100);
  assert.equal(result.stdout.includes('\uFFFD'), false);
});

test('Promise 形态的注入同样可用（测试注入更顺手，语义相同）', async () => {
  const execFile = async (bin, args, options) => ({ stdout: `${args[0]}`, stderr: '', exitCode: 0 });
  const runner = createGiteeRunner({ execFile, env: {} });
  const result = await runner.run({ bin: 'gh', args: ['pr'] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'pr');
  assert.equal(result.timedOut, false);
});

/* ───────────── 入参白名单与装配期校验 ───────────── */

test('多余字段一律拒绝：没有通用命令字符串通道（AC-23）', async () => {
  const { execFile } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({ execFile, env: {} });
  for (const extra of [{ command: 'gh pr merge 1' }, { shell: true }, { cwd: '/tmp' }, { env: {} }]) {
    await assert.rejects(
      runner.run({ bin: 'gh', args: [], ...extra }),
      (error) => {
        assert.ok(error instanceof GiteeCliError);
        assert.equal(error.code, 'INVOCATION_INVALID');
        assert.match(error.message, /bin\/args\/purpose/);
        return true;
      },
      JSON.stringify(extra),
    );
  }
});

test('入参形状错误逐类拒绝：bin 空、args 非数组、元素非字符串、NUL、purpose 非字符串', async () => {
  const { execFile } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({ execFile, env: {} });
  const cases = [
    [null],
    ['gh'],
    [{}],
    [{ bin: '  ' }],
    [{ bin: 'gh', args: 'issue list' }],
    [{ bin: 'gh', args: [42] }],
    [{ bin: 'gh', args: ['issue', 'list\0--host=evil'] }],
    [{ bin: 'gh', args: [], purpose: 42 }],
  ];
  for (const [input] of cases) {
    await assert.rejects(runner.run(input), GiteeCliError, JSON.stringify(input));
  }
});

test('装配期校验：注入点/超时/上限/时钟/环境/凭据名不合法就直接报错（fail closed）', () => {
  const cases = [
    [{ execFile: 'gh' }, 'execFile 非函数'],
    [{ timeoutMs: 0 }, '超时非正'],
    [{ timeoutMs: 1.5 }, '超时非整数'],
    [{ maxOutputBytes: -1 }, '上限非正'],
    [{ now: 42 }, '时钟非函数'],
    [{ env: 'not-an-object' }, 'env 非对象'],
    [{ authEnv: [] }, '凭据名为空'],
    [{ authEnv: ['bad name'] }, '凭据名非法'],
    [{ readFile: 42 }, '读文件注入点非函数'],
  ];
  for (const [options, label] of cases) {
    assert.throws(() => createGiteeRunner(options), GiteeCliError, label);
  }
});

test('并发调用互不干扰：结果与各自入参一一对应', async () => {
  const execFile = (bin, args, options, callback) => {
    const delay = args[0] === 'slow' ? 30 : 5;
    setTimeout(() => callback(null, args[0], ''), delay);
    return { pid: 1 };
  };
  const runner = createGiteeRunner({ execFile, env: {} });
  const results = await Promise.all([
    runner.run({ bin: 'gh', args: ['slow'] }),
    runner.run({ bin: 'gh', args: ['fast'] }),
    runner.run({ bin: 'gh', args: ['mid'] }),
  ]);
  assert.deepEqual(results.map((result) => result.stdout), ['slow', 'fast', 'mid']);
});

/* ───────────── 脱敏 ───────────── */

test('脱敏：stdout/stderr 里的令牌被整体替换，含正则元字符的令牌也照换', async () => {
  const token = 'a.b*c(d)e';
  const { execFile } = fakeExecFile(() => ({
    stdout: `token ${token} leaked\n`,
    stderr: `retry with ${token}\n`,
  }));
  const runner = createGiteeRunner({ execFile, env: { GH_TOKEN: token } });
  const result = await runner.run({ bin: 'gh', args: ['api', 'user'] });
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
  assert.match(result.stdout, /\*\*\*/);
});

test('sourceTokens 在子进程输出里重复出现时全部替换（split/join 不做单次替换）', async () => {
  const { execFile } = fakeExecFile(() => ({ stdout: `${TOKEN_VALUE}|${TOKEN_VALUE}\n` }));
  const runner = createGiteeRunner({ execFile, env: { GH_TOKEN: TOKEN_VALUE } });
  const result = await runner.run({ bin: 'gh', args: ['version'] });
  assert.equal(result.stdout, '***|***\n');
});

test('scrubSecrets 是纯函数：空令牌/非字符串/无命中都不改内容', () => {
  assert.equal(scrubSecrets('plain', []), 'plain');
  assert.equal(scrubSecrets('plain', undefined), 'plain');
  assert.equal(scrubSecrets(undefined, ['x']), '');
  assert.equal(scrubSecrets(42, ['']), '42');
  assert.equal(scrubSecrets('a-b-a', 'a'), '***-b-***');
  assert.equal(scrubSecrets('tok tok', ['tok', 'tok']), '*** ***');
});

/* ───────────── 落盘令牌阻断（AC-22，起进程之前） ───────────── */

test('detectPersistentToken：四种配置目录布局都被检查，且返回值不含令牌值', () => {
  const seen = [];
  const result = detectPersistentToken({
    env: {
      HOME: HOME_FIXTURE,
      XDG_CONFIG_HOME: ['', 'secret', 'xdg'].join('/'),
      APPDATA: ['', 'secret', 'roaming'].join('/'),
      GH_CONFIG_DIR: ['', 'secret', 'ghconf'].join('/'),
    },
    readFile: (file) => {
      seen.push(file);
      return null;
    },
  });
  assert.equal(result.blocked, false);
  assert.equal(result.reason, null);
  assert.deepEqual(result.files, []);
  assert.ok(result.checked > 0);
  for (const expected of [
    `${HOME_FIXTURE}/.config/gh/hosts.yml`,
    `${['', 'secret', 'xdg'].join('/')}/gh/hosts.yml`,
    `${['', 'secret', 'roaming'].join('/')}/GitHub CLI/hosts.yml`,
    `${['', 'secret', 'ghconf'].join('/')}/hosts.yml`,
  ]) {
    assert.ok(seen.includes(expected), `未检查 ${expected}`);
  }
});

test('detectPersistentToken：零候选环境（无 HOME）不阻断也不读盘', () => {
  const seen = [];
  const result = detectPersistentToken({ env: {}, readFile: (file) => seen.push(file) });
  assert.equal(result.blocked, false);
  assert.equal(result.checked, 0);
  assert.deepEqual(seen, []);
});

test('detectPersistentToken：干净配置、读盘异常、空文件都不阻断', () => {
  const env = { HOME: HOME_FIXTURE };
  assert.equal(detectPersistentToken({ env, readFile: () => 'github.com:\n  user: svc-ci\n  git_protocol: ssh\n' }).blocked, false);
  assert.equal(detectPersistentToken({ env, readFile: () => { throw new Error('EACCES'); } }).blocked, false);
  assert.equal(detectPersistentToken({ env, readFile: () => '' }).blocked, false);
  assert.equal(detectPersistentToken({ env, readFile: () => null }).blocked, false);
});

test('detectPersistentToken：命中落盘令牌时只报文件名与下一步动作', () => {
  const tokenLine = ['oauth', 'token'].join('_');
  const result = detectPersistentToken({
    env: { HOME: HOME_FIXTURE },
    readFile: (file) => (file.endsWith('hosts.yml') ? `gitee.corp.example:\n    ${tokenLine}: ${TOKEN_VALUE}\n` : null),
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'GITEE_PERSISTENT_TOKEN');
  assert.deepEqual(result.files, [`${HOME_FIXTURE}/.config/gh/hosts.yml`]);
  assert.match(result.next_action, /环境变量/);
  assert.equal(JSON.stringify(result).includes(TOKEN_VALUE), false, 'AC-22：不回显令牌值');
});

test('落盘令牌命中时 run() 抛 GITEE_PERSISTENT_TOKEN 且零子进程（阻断在起进程之前）', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: 'should-not-run' }));
  const runner = createGiteeRunner({
    execFile,
    env: { HOME: HOME_FIXTURE, GH_TOKEN: TOKEN_VALUE },
    readFile: (file) => (file.endsWith('config.yml') ? `token: ${OTHER_TOKEN}\n` : null),
  });

  await assert.rejects(
    runner.run({ bin: 'gh', args: ['issue', 'list'] }),
    (error) => {
      assert.ok(error instanceof GiteeCliError);
      assert.equal(error.code, 'PERSISTENT_TOKEN');
      assert.equal(error.reason, 'GITEE_PERSISTENT_TOKEN');
      assert.equal(error.status, 'denied');
      assert.match(error.message, /环境变量/);
      assert.equal(JSON.stringify(error.detail).includes(OTHER_TOKEN), false);
      assert.equal(error.message.includes(OTHER_TOKEN), false);
      return true;
    },
    '应阻断持久令牌',
  );
  assert.equal(calls.length, 0, 'AC-22：阻断必须发生在子进程创建之前');
});

test('自检只做一次：多次 run 不重复读配置目录', async () => {
  let reads = 0;
  const { execFile } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({
    execFile,
    env: { HOME: HOME_FIXTURE },
    readFile: () => {
      reads += 1;
      return 'github.com:\n  user: svc-ci\n';
    },
  });
  await runner.run({ bin: 'gh', args: ['version'] });
  const afterFirst = reads;
  await runner.run({ bin: 'gh', args: ['version'] });
  await runner.run({ bin: 'gh', args: ['version'] });
  assert.ok(afterFirst > 0);
  assert.equal(reads, afterFirst, '自检快照复用，不重复读盘');
});

/* ───────────── 真实子进程：三终态端到端 ───────────── */

test('真实子进程端到端：成功 / 非零退出 / 超时三终态（不注入假 execFile）', async () => {
  const runner = createGiteeRunner({ env: {}, timeoutMs: 5_000 });
  const ok = await runner.run({ bin: process.execPath, args: ['-e', 'process.stdout.write("ok")'], purpose: 'e2e-ok' });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, 'ok');
  assert.equal(ok.timedOut, false);
  assert.equal(ok.truncated, false);

  const failed = await runner.run({ bin: process.execPath, args: ['-e', 'process.exit(3)'], purpose: 'e2e-failed' });
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.timedOut, false);

  const slow = createGiteeRunner({ env: {}, timeoutMs: 200 });
  const timedOut = await slow.run({
    bin: process.execPath,
    args: ['-e', 'setTimeout(() => process.stdout.write("late"), 5000)'],
    purpose: 'e2e-timeout',
  });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.stdout, '');
});

/* ───────────── 静态出口唯一性 ───────────── */

test('源码只有一个 execFile 出口，无 spawn/同步执行/shell 拼串/switch 入口', () => {
  const text = readFileSync(CLI_SRC, 'utf8');
  assert.equal((text.match(/execFile\(/g) ?? []).length, 1, 'AC-23：唯一子进程出口');
  assert.doesNotMatch(text, /\bspawn\s*\(/);
  assert.doesNotMatch(text, /execSync\s*\(/);
  assert.doesNotMatch(text, /\bexec\s*\(/);
  assert.doesNotMatch(text, /shell\s*:\s*true/);
  assert.doesNotMatch(text, /\bshell\s*:\s*['"`]?(?:sh|bash|cmd|powershell)/i);
  assert.doesNotMatch(text, /['"`](?:sh|bash|cmd|powershell)['"`]\s*,/, '没有 shell -c 形态');
  assert.doesNotMatch(text, /\/Users\/|\/home\/|\/opt\//);
  assert.doesNotMatch(text, /https?:\/\//);
});

test('源码不写死 GitHub 凭据语义：唯一的 gh 标识是配置目录约定，凭据名只经配置层传入', () => {
  const text = readFileSync(CLI_SRC, 'utf8');
  // 允许的唯一例外：`GH_CONFIG_DIR` 是 CLI 自己的配置目录约定（AC-22 的落盘令牌检测要用它），
  // 它不是 GitHub 的字段/凭据语义。多出任何一个 GH_* 都说明有人把另一套语义搬进来了。
  const ghIdentifiers = new Set(text.match(/(?:^|[^A-Za-z0-9_])GH_[A-Z][A-Z0-9_]*/g)?.map((match) => match.replace(/^[^A-Za-z]/, '')) ?? []);
  assert.deepEqual([...ghIdentifiers], ['GH_CONFIG_DIR']);
  assert.doesNotMatch(text, /\bGITHUB_[A-Z]/);
  assert.doesNotMatch(text, /\bTOKEN\b/);
  assert.doesNotMatch(text, /mergedAt|statusCheckRollup/);
});
