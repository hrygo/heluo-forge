/**
 * T1 子进程出口（§5.5）：唯一出口、有界、可注入。
 *
 * 一半用例用假 `execFile` 断言 argv/选项/归一化，另一半用真实子进程跑通端到端
 * （成功、非零退出、超时），确认"注入可测"没有把真实路径漏掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCliRunner, DEFAULT_MAX_OUTPUT_BYTES } from '../src/cli-runner.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOP_BIN = '/secret/bin/dop';

/** 回调式假 execFile：记录一次调用，按脚本回放结果。 */
function fakeExecFile(handler) {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args: [...args], options });
    handler({ bin, args, options }, callback);
    return { pid: 4242 };
  };
  return { execFile, calls };
}

test('成功调用返回五字段，且 argv 与程序名分开传（不拼串）', async () => {
  const { execFile, calls } = fakeExecFile((_call, callback) => {
    callback(null, '{"ok":true}', '');
  });
  const runner = createCliRunner({ execFile, env: { GH_HOST: 'corp.example' } });
  const result = await runner.run({
    bin: DOP_BIN,
    args: ['change', 'view', 'ARD123456', '-j'],
    purpose: '读取变更',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, DOP_BIN);
  assert.deepEqual(calls[0].args, ['change', 'view', 'ARD123456', '-j']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '{"ok":true}');
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.durationMs >= 0);
});

test('带空格的参数仍是单个 argv 元素（没有 shell 展开）', async () => {
  const { execFile, calls } = fakeExecFile((_call, callback) => callback(null, '', ''));
  const runner = createCliRunner({ execFile });
  await runner.run({ bin: 'gh', args: ['issue', 'create', '--title', '门禁 回读 $HOME `id`'] });
  assert.deepEqual(calls[0].args, ['issue', 'create', '--title', '门禁 回读 $HOME `id`']);
});

test('执行选项固定：shell:false、超时、输出上限、utf8、无窗口', async () => {
  const { execFile, calls } = fakeExecFile((_call, callback) => callback(null, '', ''));
  const runner = createCliRunner({ execFile, timeoutMs: 5_000, maxOutputBytes: 4096, env: { GH_HOST: 'corp.example' } });
  await runner.run({ bin: 'gh', args: ['repo', 'view', 'acme/demo'] });

  const options = calls[0].options;
  assert.equal(options.shell, false, '不允许经过 shell');
  assert.equal(options.timeout, 5_000);
  assert.equal(options.maxBuffer, 4096);
  assert.equal(options.encoding, 'utf8');
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.GH_HOST, 'corp.example', 'env 覆盖项进入子进程环境');
  assert.equal(typeof options.env.PATH, 'string', '覆盖项叠加在进程环境之上，不整体替换');
});

test('非零退出：exitCode 取数值并保留 stderr（失败是数据不是异常）', async () => {
  const { execFile } = fakeExecFile((_call, callback) => {
    const error = Object.assign(new Error('命令失败'), { code: 2, exitCode: 2 });
    callback(error, '', 'boom');
  });
  const runner = createCliRunner({ execFile });
  const result = await runner.run({ bin: DOP_BIN, args: ['change', 'view', 'ARD000000', '-j'] });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, 'boom');
  assert.equal(result.timedOut, false);
});

test('超时（killed + 无退出码）归一化为 timedOut', async () => {
  const { execFile } = fakeExecFile((_call, callback) => {
    const error = Object.assign(new Error('killed'), { killed: true, code: null, signal: 'SIGTERM' });
    callback(error, '', '');
  });
  const runner = createCliRunner({ execFile, timeoutMs: 1_000 });
  const result = await runner.run({ bin: 'gh', args: ['repo', 'list'] });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});

test('ETIMEDOUT 与显式 timedOut 标记同样识别为超时', async () => {
  const byCode = fakeExecFile((_call, callback) => {
    callback(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), '', '');
  });
  const first = await createCliRunner({ execFile: byCode.execFile }).run({ bin: 'gh', args: [] });
  assert.equal(first.timedOut, true);

  const byFlag = fakeExecFile((_call, callback) => {
    callback(Object.assign(new Error('timeout'), { timedOut: true }), '', '');
  });
  const second = await createCliRunner({ execFile: byFlag.execFile }).run({ bin: 'gh', args: [] });
  assert.equal(second.timedOut, true);
  assert.equal(second.exitCode, null);
});

test('起不来（ENOENT）不吞原因：exitCode null 且 stderr 带消息', async () => {
  const { execFile } = fakeExecFile((_call, callback) => {
    callback(Object.assign(new Error('spawn dop ENOENT'), { code: 'ENOENT' }), '', '');
  });
  const runner = createCliRunner({ execFile });
  const result = await runner.run({ bin: DOP_BIN, args: ['change', 'view', 'ARD123456', '-j'] });
  assert.equal(result.exitCode, null);
  assert.equal(result.stderr, 'spawn dop ENOENT');
  assert.equal(result.timedOut, false);
});

test('输出上限：超限被截断且 truncated 可见（不静默当作完整输出）', async () => {
  const { execFile } = fakeExecFile((_call, callback) => callback(null, '0123456789ABC', ''));
  const runner = createCliRunner({ execFile, maxOutputBytes: 8 });
  const result = await runner.run({ bin: 'gh', args: ['issue', 'list'] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '01234567');
  assert.equal(result.truncated, true);
});

test('多字节输出按字节截断不抛异常', async () => {
  const { execFile } = fakeExecFile((_call, callback) => callback(null, '中文', ''));
  const runner = createCliRunner({ execFile, maxOutputBytes: 4 });
  const result = await runner.run({ bin: 'gh', args: [] });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.startsWith('中'));
});

test('Promise 形态的注入同样可用（测试与装配都能换成异步实现）', async () => {
  const execFile = async (bin, args) => ({ exitCode: 0, stdout: `${bin}:${args.length}`, stderr: '' });
  const runner = createCliRunner({ execFile });
  const result = await runner.run({ bin: 'gh', args: ['a', 'b'] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'gh:2');
  assert.equal(result.timedOut, false);
});

test('允许多余字段一律拒绝：没有通用命令字符串通道', async () => {
  const { execFile, calls } = fakeExecFile((_call, callback) => callback(null, '', ''));
  const runner = createCliRunner({ execFile });
  for (const bad of [
    { bin: 'sh', args: ['-c', 'gh repo list'], command: 'gh repo list' },
    { bin: 'gh', args: [], shell: true },
    { bin: 'gh', args: [], timeout: 1 },
  ]) {
    await assert.rejects(() => runner.run(bad), TypeError);
  }
  assert.equal(calls.length, 0, '非法调用零下游调用');
});

test('入参形状错误一律 TypeError', async () => {
  const { execFile } = fakeExecFile((_call, callback) => callback(null, '', ''));
  const runner = createCliRunner({ execFile });
  for (const bad of [
    'gh repo list',
    null,
    {},
    { bin: '' },
    { bin: '   ' },
    { bin: 'gh', args: 'repo list' },
    { bin: 'gh', args: [1] },
    { bin: 'gh', args: ['a\0b'] },
    { bin: 'gh', args: [], purpose: 42 },
  ]) {
    await assert.rejects(() => runner.run(bad), TypeError, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('装配期校验：注入非函数、超时与上限非正整数都直接报错', () => {
  assert.throws(() => createCliRunner({ execFile: 'execFile' }), TypeError);
  assert.throws(() => createCliRunner({ timeoutMs: 0 }), TypeError);
  assert.throws(() => createCliRunner({ timeoutMs: 1.5 }), TypeError);
  assert.throws(() => createCliRunner({ maxOutputBytes: 0 }), TypeError);
  assert.throws(() => createCliRunner({ env: { GH_HOST: 1 } }), TypeError);
  const ok = createCliRunner({ env: { GH_HOST: undefined } });
  assert.deepEqual(Object.keys(ok), ['run'], 'runner 只暴露 run，没有别的出口');
});

test('并发调用互不干扰', async () => {
  const execFile = (bin, _args, _options, callback) => {
    const delay = bin === 'slow' ? 15 : 1;
    setTimeout(() => callback(null, `out:${bin}`, ''), delay);
  };
  const runner = createCliRunner({ execFile });
  const [slow, fast] = await Promise.all([
    runner.run({ bin: 'slow', args: [] }),
    runner.run({ bin: 'fast', args: [] }),
  ]);
  assert.equal(slow.stdout, 'out:slow');
  assert.equal(fast.stdout, 'out:fast');
});

test('默认上限就是 1 MiB（有界默认值）', () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 1_048_576);
});

test('端到端：真实子进程的成功、非零退出与超时三种终态', async () => {
  const runner = createCliRunner({ timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });

  const ok = await runner.run({
    bin: process.execPath,
    args: ['-e', 'process.stdout.write("ready")'],
    purpose: 'e2e-success',
  });
  assert.equal(ok.exitCode, 0, `成功路径应 exit 0，stderr=${ok.stderr}`);
  assert.equal(ok.stdout, 'ready');
  assert.equal(ok.timedOut, false);

  const failed = await runner.run({
    bin: process.execPath,
    args: ['-e', 'process.stderr.write("bad input"); process.exit(3)'],
    purpose: 'e2e-failure',
  });
  assert.equal(failed.exitCode, 3, `非零退出应原样给出，实际 ${failed.exitCode}`);
  assert.equal(failed.stderr, 'bad input');
  assert.equal(failed.timedOut, false);

  const slowRunner = createCliRunner({ timeoutMs: 150 });
  const timedOut = await slowRunner.run({
    bin: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 5000)'],
    purpose: 'e2e-timeout',
  });
  assert.equal(timedOut.timedOut, true, '超时必须在终态可见');
  assert.equal(timedOut.exitCode, null);
});

test('本模块源码只用 execFile（无 shell 拼串、无同步 exec）', () => {
  const text = readFileSync(path.join(PKG_ROOT, 'src', 'cli-runner.mjs'), 'utf8');
  assert.ok(!/shell\s*:\s*true/.test(text));
  assert.ok(!/execSync\s*\(/.test(text));
  assert.ok(!/['"`]sh['"`]\s*,\s*['"`]-c['"`]/.test(text));
  assert.ok(/execFile/.test(text));
});
