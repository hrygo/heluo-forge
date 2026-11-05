/**
 * TK2 唯一子进程出口（AC-23）与凭据面（AC-22 / r10）。
 *
 * 这个文件守的是"没有第二条执行路径"：`run()`（gitee CLI）与 `runGit()`（本地 git）
 * 共用同一个 `execFile` 站点——入参白名单、`shell:false`、超时、1 MiB 上限、环境白名单、
 * 令牌脱敏、落盘凭据策略（warn 只告警 / block 在**起进程之前**阻断）与静态出口唯一性。
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
  GIT_INVOCATION_KEYS,
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
    authEnv: ['GH_TOKEN'],
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

test('GITEE_TOKEN 是本 CLI 的认证模型：不点名 authEnv 也继承，其它凭据变量仍不继承（规格 §1.3）', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({
    execFile,
    env: {
      GITEE_TOKEN: OTHER_TOKEN,
      GH_TOKEN: TOKEN_VALUE,
      GITHUB_TOKEN: ['other', 'platform', 'secret'].join('-'),
    },
  });
  await runner.run({ bin: 'gh', args: ['issue', 'list'] });

  assert.ok(ENV_ALLOWLIST.includes('GITEE_TOKEN'), 'GITEE_TOKEN 必须在白名单里');
  const childEnv = calls[0].options.env;
  assert.equal(childEnv.GITEE_TOKEN, OTHER_TOKEN, '按 CLI 文档设了变量就该被看见');
  assert.equal(childEnv.GH_TOKEN, undefined, '别家 CLI 的令牌变量仍不继承');
  assert.equal(childEnv.GITHUB_TOKEN, undefined);
  assert.equal(calls[0].args.includes(OTHER_TOKEN), false, '凭据绝不进 argv');
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

test('装配期校验：注入点/超时/上限/时钟/环境/凭据名/凭据策略不合法就直接报错（fail closed）', () => {
  const cases = [
    [{ execFile: 'gh' }, 'execFile 非函数'],
    [{ timeoutMs: 0 }, '超时非正'],
    [{ timeoutMs: 1.5 }, '超时非整数'],
    [{ maxOutputBytes: -1 }, '上限非正'],
    [{ now: 42 }, '时钟非函数'],
    [{ env: 'not-an-object' }, 'env 非对象'],
    [{ authEnv: ['bad name'] }, '凭据名非法'],
    [{ persistentTokenPolicy: 'strict' }, '凭据策略非法'],
    [{ readFile: 42 }, '读文件注入点非函数'],
  ];
  for (const [options, label] of cases) {
    assert.throws(() => createGiteeRunner(options), GiteeCliError, label);
  }
  // r10：空凭据名是合法配置（不注入任何凭据变量），构造期不再拒绝。
  assert.equal(typeof createGiteeRunner({ execFile: () => {}, authEnv: [] }).run, 'function');
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
  const runner = createGiteeRunner({ execFile, env: { GH_TOKEN: token }, authEnv: ['GH_TOKEN'] });
  const result = await runner.run({ bin: 'gh', args: ['api', 'user'] });
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
  assert.match(result.stdout, /\*\*\*/);
});

test('sourceTokens 在子进程输出里重复出现时全部替换（split/join 不做单次替换）', async () => {
  const { execFile } = fakeExecFile(() => ({ stdout: `${TOKEN_VALUE}|${TOKEN_VALUE}\n` }));
  const runner = createGiteeRunner({ execFile, env: { GH_TOKEN: TOKEN_VALUE }, authEnv: ['GH_TOKEN'] });
  const result = await runner.run({ bin: 'gh', args: ['version'] });
  assert.equal(result.stdout, '***|***\n');
});

test('形状兜底：未点名但形似凭据的串同样被抹掉（默认 authEnv 为空时也生效）', async () => {
  const shape = ['ghp', 'abcdefghijklmnopqrstuvwxyz012345'].join('_');
  const { execFile } = fakeExecFile(() => ({ stdout: `leaked ${shape}\n` }));
  const runner = createGiteeRunner({ execFile, env: {} });
  const result = await runner.run({ bin: 'gh', args: ['version'] });
  assert.equal(result.stdout.includes(shape), false);
  assert.equal(result.stdout, 'leaked ***\n');
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

test('detectPersistentToken：~/.gitee-cli/config.json 的 token 也被检出（JSON 布局，规格 §1.5）', () => {
  const giteeConfig = `${HOME_FIXTURE}/.gitee-cli/config.json`;
  const seen = [];
  const result = detectPersistentToken({
    env: { HOME: HOME_FIXTURE },
    readFile: (file) => {
      seen.push(file);
      return file === giteeConfig
        ? `{\n  "base_url": "http://corp.example.com/api/v8",\n  "token": "${TOKEN_VALUE}"\n}`
        : null;
    },
  });
  assert.ok(seen.includes(giteeConfig), '本 CLI 的落盘令牌位置必须在候选里');
  assert.equal(result.blocked, true, '只扫 YAML 会让这个令牌永远检测不到');
  assert.equal(result.reason, 'GITEE_PERSISTENT_TOKEN');
  assert.deepEqual(result.files, [giteeConfig], '只回文件名');
  assert.match(result.next_action, /gh auth login/);
  assert.equal(JSON.stringify(result).includes(TOKEN_VALUE), false, 'AC-22：不回显令牌值');

  // `"token": ""` 等于"没设置"（规格 §1.5 只存被显式 set 过的键）：不能当成命中。
  const emptyToken = detectPersistentToken({
    env: { HOME: HOME_FIXTURE },
    readFile: (file) => (file === giteeConfig ? '{\n  "token": ""\n}' : null),
  });
  assert.equal(emptyToken.blocked, false);

  // 解析不了的 JSON 不猜：半截文件自造的告警无法复现。
  const brokenJson = detectPersistentToken({
    env: { HOME: HOME_FIXTURE },
    readFile: (file) => (file === giteeConfig ? '{"token": "abc' : null),
  });
  assert.equal(brokenJson.blocked, false);

  // Windows 布局：HOME 与 USERPROFILE 都可能给出主目录，两边各看一次。
  const profile = ['', 'secret', 'users', 'svc'].join('/');
  const seenWindows = [];
  detectPersistentToken({
    env: { HOME: HOME_FIXTURE, USERPROFILE: profile },
    readFile: (file) => {
      seenWindows.push(file);
      return null;
    },
  });
  assert.ok(seenWindows.includes(`${profile}/.gitee-cli/config.json`), 'USERPROFILE 下的 config.json 也要扫');
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
    readFile: (file) => (file.endsWith('hosts.yml') ? `gitee.example:\n    ${tokenLine}: ${TOKEN_VALUE}\n` : null),
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'GITEE_PERSISTENT_TOKEN');
  assert.deepEqual(result.files, [`${HOME_FIXTURE}/.config/gh/hosts.yml`]);
  assert.match(result.next_action, /gh auth login/);
  assert.equal(JSON.stringify(result).includes(TOKEN_VALUE), false, 'AC-22：不回显令牌值');
});

test('落盘令牌默认只告警：run() 照常执行，credentialStatus 报 detected + policy warn', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: 'ok' }));
  const runner = createGiteeRunner({
    execFile,
    env: { HOME: HOME_FIXTURE, GH_TOKEN: TOKEN_VALUE },
    readFile: (file) => (file.endsWith('config.yml') ? `token: ${OTHER_TOKEN}\n` : null),
  });

  const result = await runner.run({ bin: 'gh', args: ['issue', 'list'] });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1, 'warn 不阻断');
  const status = runner.credentialStatus();
  assert.equal(status.blocked, true);
  assert.equal(status.policy, 'warn');
  assert.equal(status.enforced, false);
  assert.equal(JSON.stringify(status).includes(OTHER_TOKEN), false, 'AC-22：不回显令牌值');
});

test('落盘令牌 + block 策略：run()/runGit() 都抛 GITEE_PERSISTENT_TOKEN 且零子进程', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: 'should-not-run' }));
  const runner = createGiteeRunner({
    execFile,
    env: { HOME: HOME_FIXTURE, GH_TOKEN: TOKEN_VALUE },
    persistentTokenPolicy: 'block',
    readFile: (file) => (file.endsWith('config.yml') ? `token: ${OTHER_TOKEN}\n` : null),
  });

  for (const invoke of [
    () => runner.run({ bin: 'gh', args: ['issue', 'list'] }),
    () => runner.runGit({ args: ['status', '--short'], purpose: 'git.status' }),
  ]) {
    await assert.rejects(
      invoke(),
      (error) => {
        assert.ok(error instanceof GiteeCliError);
        assert.equal(error.code, 'PERSISTENT_TOKEN');
        assert.equal(error.reason, 'GITEE_PERSISTENT_TOKEN');
        assert.equal(error.status, 'denied');
        assert.equal(error.detail.policy, 'block');
        assert.match(error.message, /gh auth login/);
        assert.equal(JSON.stringify(error.detail).includes(OTHER_TOKEN), false);
        assert.equal(error.message.includes(OTHER_TOKEN), false);
        return true;
      },
      '应阻断持久令牌',
    );
  }
  assert.equal(calls.length, 0, 'AC-22：阻断必须发生在子进程创建之前');
});

/* ───────────── runGit：本地 git 与 gitee CLI 共用唯一出口 ───────────── */

test('runGit 起进程参数：bin=git、cwd、GIT_TERMINAL_PROMPT=0、shell:false、同一套超时与上限', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: ' M src/a.mjs\n' }));
  const runner = createGiteeRunner({ execFile, env: { HOME: HOME_FIXTURE }, gitCwd: HOME_FIXTURE });
  const result = await runner.runGit({ args: ['status', '--short'], purpose: 'git.status' });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'git');
  assert.deepEqual(calls[0].args, ['status', '--short']);
  assert.equal(calls[0].options.cwd, HOME_FIXTURE);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[0].options.timeout, runner.describe().timeoutMs);
  assert.equal(calls[0].options.maxBuffer, DEFAULT_MAX_OUTPUT_BYTES);

  // 调用点可以逐次覆盖 cwd（每个仓库一个工作区），但不会自带 bin/argv 拼接。
  await runner.runGit({ args: ['rev-parse', 'HEAD'], cwd: BIN });
  assert.equal(calls[1].options.cwd, BIN);
});

test('runGit 入参白名单：拒未知键、拒空/非字符串 args、拒 NUL、拒 null 字节', async () => {
  const { execFile, calls } = fakeExecFile(() => ({ stdout: '' }));
  const runner = createGiteeRunner({ execFile, env: {} });
  const bad = [
    [{ args: ['status'], bin: 'git' }, '未知键 bin'],
    [{ args: ['status'], shell: true }, '未知键 shell'],
    [{ args: [] }, '空 argv'],
    [{ args: 'status' }, '非数组'],
    [{ args: ['status', 42] }, '非字符串'],
    [{ args: ['status', ''] }, '空串参数'],
    [{ args: ['commit', '-m', 'a\u0000b'] }, 'NUL'],
    [{ args: ['status'], cwd: '' }, '空 cwd'],
    [{ args: ['status'], purpose: 42 }, 'purpose 非字符串'],
  ];
  for (const [input, label] of bad) {
    await assert.rejects(runner.runGit(input), GiteeCliError, label);
  }
  assert.equal(calls.length, 0, '校验失败必须零子进程');
  assert.deepEqual([...GIT_INVOCATION_KEYS], ['args', 'purpose', 'cwd']);
  assert.deepEqual([...INVOCATION_KEYS], ['bin', 'args', 'purpose']);
});

test('runGit 也走脱敏与截断：输出里的点名令牌被抹掉，超过 1 MiB 标记 truncated', async () => {
  const token = OTHER_TOKEN;
  const big = 'x'.repeat(DEFAULT_MAX_OUTPUT_BYTES + 512);
  const { execFile } = fakeExecFile((request) => (
    request.args.includes('big') ? { stdout: big } : { stdout: `token ${token}\n` }
  ));
  const runner = createGiteeRunner({ execFile, env: { GH_TOKEN: token }, authEnv: ['GH_TOKEN'] });

  const small = await runner.runGit({ args: ['log', '-1'], purpose: 'git.log' });
  assert.equal(small.stdout.includes(token), false);
  assert.equal(small.stdout, 'token ***\n');

  const capped = await runner.runGit({ args: ['big'], purpose: 'git.big' });
  assert.equal(capped.truncated, true);
  assert.ok(capped.stdout.length <= DEFAULT_MAX_OUTPUT_BYTES);
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
