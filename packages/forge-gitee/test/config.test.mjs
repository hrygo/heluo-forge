/**
 * TK2 运行时配置（AC-7 / AC-22）：四个扁平键、一份校验规则、脱敏描述。
 *
 * 这些用例是"装配层能拒绝启动"的唯一依据：只要有一条放松，插件就会在没配置
 * `host` 的机器上把请求打到猜测的主机，或者把令牌写进可展示的配置描述里。
 * 断言尽量锁**结论**（进出值、issue 路径）而不是提示语原文，改文案不应让用例失效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_KEYS,
  CONFIG_REASONS,
  ConfigStandard,
  DEFAULT_AUTH_ENV,
  DEFAULT_CLI_PATH,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  describeGiteeConfig,
  resolveGiteeConfig,
  validateGiteeConfig,
} from '../src/runtime-config.mjs';
import { createGiteeRunner, DEFAULT_MAX_OUTPUT_BYTES } from '../src/gitee-cli.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(PKG_ROOT, 'src');

/** 路径与令牌都拼出来：仓库检查器禁止源码出现 `scheme://user:pass@` 一类的字面量。 */
const CLI_PATH = ['', 'secret', 'bin', 'forge-gitee'].join('/');
const TOKEN_VALUE = ['gitee', 'pat', 'fixture', 'value'].join('-');
const HOST = 'gitee.corp.example';

test('CONFIG_KEYS 恰好四个扁平键、互不重复、顺序固定（PRD T5：不做 Web 配置页）', () => {
  assert.ok(Object.isFrozen(CONFIG_KEYS));
  assert.deepEqual([...CONFIG_KEYS], ['cliPath', 'host', 'timeoutMs', 'authEnv']);
  assert.equal(new Set(CONFIG_KEYS).size, CONFIG_KEYS.length);
});

test('默认值只有非机密项：cliPath=gh、超时 20s、区间 1s–10min、默认凭据变量 GH_TOKEN', () => {
  assert.equal(DEFAULT_CLI_PATH, 'gh');
  assert.equal(DEFAULT_TIMEOUT_MS, 20_000);
  assert.equal(MIN_TIMEOUT_MS, 1_000);
  assert.equal(MAX_TIMEOUT_MS, 600_000);
  assert.ok(MIN_TIMEOUT_MS < DEFAULT_TIMEOUT_MS && DEFAULT_TIMEOUT_MS < MAX_TIMEOUT_MS);
  assert.deepEqual([...DEFAULT_AUTH_ENV], ['GH_TOKEN']);
  assert.ok(Object.isFrozen(DEFAULT_AUTH_ENV));
  assert.deepEqual({ ...CONFIG_REASONS }, {
    INVALID: 'GITEE_CONFIG_INVALID',
    AUTH_MISSING: 'AUTH_MISSING',
    PERSISTENT: 'GITEE_PERSISTENT_TOKEN',
  });
});

/* ───────────── 校验：一份规则，三个入口（补丁层 / 宿主 loader / resolve） ───────────── */

test('缺省配置是零配置：undefined/null/{} 都合法（否则宿主传 undefined 时整条 entry 不激活）', () => {
  for (const input of [undefined, null, {}]) {
    assert.deepEqual(validateGiteeConfig(input), { value: {} }, String(input));
  }
});

test('未知配置键被拒绝，只报键名不回显值', () => {
  const result = validateGiteeConfig({ cliPath: 'gh', giteeHost: ['leak', 'value'].join('-') });
  assert.equal('value' in result, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), [['giteeHost']]);
  assert.match(result.issues[0].message, /giteeHost/);
  assert.equal(result.issues[0].message.includes('leak'), false, '错误信息不回显配置值');
});

test('非对象与数组输入返回 issues，绝不抛错', () => {
  for (const input of ['gh', 42, true, [], ['gh']]) {
    const result = validateGiteeConfig(input);
    assert.equal('value' in result, false, String(input));
    assert.equal(result.issues.length, 1, String(input));
    assert.deepEqual(result.issues[0].path, [], String(input));
    assert.equal(typeof result.issues[0].message, 'string');
  }
});

test('cliPath 归一化：去空白，PATH 名与绝对路径都接受（不猜路径、也不拦显式路径）', () => {
  assert.deepEqual(validateGiteeConfig({ cliPath: '  gh  ' }), { value: { cliPath: 'gh' } });
  assert.deepEqual(validateGiteeConfig({ cliPath: CLI_PATH }), { value: { cliPath: CLI_PATH } });
});

test('cliPath 拒绝包装脚本、URL、开关式写法、换行与超长值（execFile 只起真正可执行文件）', () => {
  const cases = [
    ['gh.cmd', '包装脚本'],
    ['gh.bat', '包装脚本'],
    ['gh.ps1', '包装脚本'],
    ['gh.vbs', '包装脚本'],
    ['gh.com', '包装脚本'],
    [['https://cli', 'corp', 'gh'].join('/'), 'URL'],
    ['-gh', '开关'],
    ['gh\n--host=evil', '控制字符'],
    [`gh${'x'.repeat(4100)}`, '长度'],
    [42, '类型'],
    [true, '类型'],
  ];
  for (const [raw, label] of cases) {
    const result = validateGiteeConfig({ cliPath: raw });
    assert.equal('value' in result, false, `${label}: ${String(raw)}`);
    assert.deepEqual(result.issues.map((issue) => issue.path), [['cliPath']], label);
  }
});

test('host 归一化为小写、允许端口；拒绝协议/路径/空格/下划线/首点/超长/非字符串', () => {
  assert.deepEqual(validateGiteeConfig({ host: ' Gitee.Corp.Example ' }), { value: { host: HOST } });
  assert.deepEqual(validateGiteeConfig({ host: 'gitee.corp.example:8443' }), {
    value: { host: 'gitee.corp.example:8443' },
  });
  const rejected = [
    ['https://gitee.corp.example', '协议'],
    [['gitee.corp.example', 'api'].join('/'), '路径'],
    ['gitee corp', '空格'],
    ['gitee_corp', '下划线'],
    ['.gitee.corp', '首点'],
    [`${'a'.repeat(250)}.example`, '超长'],
    [42, '类型'],
  ];
  for (const [raw, label] of rejected) {
    const result = validateGiteeConfig({ host: raw });
    assert.equal('value' in result, false, `${label}: ${String(raw)}`);
    assert.deepEqual(result.issues.map((issue) => issue.path), [['host']], label);
  }
});

test('timeoutMs 接受数字与数字串（含边界），拒绝 0/小数/越界/非数字', () => {
  assert.deepEqual(validateGiteeConfig({ timeoutMs: 45_000 }), { value: { timeoutMs: 45_000 } });
  assert.deepEqual(validateGiteeConfig({ timeoutMs: ' 45000 ' }), { value: { timeoutMs: 45_000 } });
  assert.deepEqual(validateGiteeConfig({ timeoutMs: MIN_TIMEOUT_MS }), { value: { timeoutMs: MIN_TIMEOUT_MS } });
  assert.deepEqual(validateGiteeConfig({ timeoutMs: MAX_TIMEOUT_MS }), { value: { timeoutMs: MAX_TIMEOUT_MS } });
  for (const raw of [0, -1, 12.5, '12.5', MIN_TIMEOUT_MS - 1, MAX_TIMEOUT_MS + 1, 'abc', true, {}]) {
    const result = validateGiteeConfig({ timeoutMs: raw });
    assert.equal('value' in result, false, String(raw));
    assert.deepEqual(result.issues.map((issue) => issue.path), [['timeoutMs']], String(raw));
  }
});

test('authEnv 接受单值或数组、去重保序；拒绝空数组、非法名、非字符串与超过上限', () => {
  assert.deepEqual(validateGiteeConfig({ authEnv: ' GITEE_TOKEN ' }), {
    value: { authEnv: ['GITEE_TOKEN'] },
  });
  assert.deepEqual(validateGiteeConfig({ authEnv: ['B_TOKEN', 'A_TOKEN', 'B_TOKEN'] }), {
    value: { authEnv: ['B_TOKEN', 'A_TOKEN'] },
  });

  const rejected = [
    [[], '空数组'],
    [['bad name'], '非法名'],
    [['1TOKEN'], '数字开头'],
    [[]],
    [[42], '非字符串'],
    [Array.from({ length: 9 }, (_item, index) => `T${index}_TOKEN`), '超过上限'],
    [42, '类型'],
  ];
  for (const [raw, label] of rejected) {
    const result = validateGiteeConfig({ authEnv: raw });
    assert.equal('value' in result, false, String(label));
    assert.deepEqual(result.issues.map((issue) => issue.path), [['authEnv']], String(label));
  }
  const illegalName = validateGiteeConfig({ authEnv: ['bad name'] });
  assert.equal(illegalName.issues[0].message.includes('bad name'), false, '不回显用户输入');
});

test('清空是合法意图：空串/纯空白/null 视为该字段缺席，不产生 issue', () => {
  for (const raw of ['', '   ', null, undefined]) {
    assert.deepEqual(validateGiteeConfig({ cliPath: raw, host: raw, timeoutMs: raw, authEnv: raw }), {
      value: {},
    }, String(raw));
  }
});

test('多字段非法一次报全，path 逐条带字段名（用户一次改完，不用来回试）', () => {
  const result = validateGiteeConfig({ host: 42, timeoutMs: 0, cliPath: 'gh.cmd', authEnv: [] });
  assert.equal('value' in result, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), [['cliPath'], ['host'], ['timeoutMs'], ['authEnv']]);
});

/* ───────────── Standard Schema：宿主 loader 的入口 ───────────── */

test('ConfigStandard 只暴露 Standard Schema v1 校验面（无 toJSON：本轮不做配置页）', () => {
  assert.ok(Object.isFrozen(ConfigStandard));
  assert.deepEqual(Object.keys(ConfigStandard), ['~standard']);
  const standard = ConfigStandard['~standard'];
  assert.ok(Object.isFrozen(standard));
  assert.equal(standard.version, 1);
  assert.equal(standard.vendor, 'heluo');
  assert.equal(typeof standard.validate, 'function');
  assert.equal('toJSON' in ConfigStandard, false);
});

test('ConfigStandard.validate 与 validateGiteeConfig 逐例一致（一份规则，两个入口）', () => {
  const cases = [
    {},
    { cliPath: ' gh ' },
    { host: 'Gitee.Corp.Example' },
    { timeoutMs: '45000' },
    { authEnv: ['A_TOKEN', 'B_TOKEN'] },
    { host: 'gitee_corp' },
    { timeoutMs: 0 },
    { giteeHost: HOST },
    'gh',
  ];
  for (const input of cases) {
    assert.deepEqual(ConfigStandard['~standard'].validate(input), validateGiteeConfig(input), JSON.stringify(input));
  }
});

/* ───────────── resolve：显式 env、缺失清单、不回显 ───────────── */

test('resolve 默认结论：gh + 20s + GH_TOKEN，host 与令牌都进 missing（不猜主机）', () => {
  const resolved = resolveGiteeConfig({ config: {}, env: {} });
  assert.deepEqual({ ...resolved, authEnv: [...resolved.authEnv], missing: [...resolved.missing] }, {
    cliPath: 'gh',
    host: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    authEnv: ['GH_TOKEN'],
    tokenSource: null,
    missing: ['host', 'GH_TOKEN'],
  });
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(resolved.authEnv));
  assert.ok(Object.isFrozen(resolved.missing));
});

test('resolve 完整配置：四项就位、missing 为空，且返回值里没有令牌值', () => {
  const resolved = resolveGiteeConfig({
    config: {
      cliPath: CLI_PATH,
      host: 'Gitee.Corp.Example',
      timeoutMs: 45_000,
      authEnv: ['GITEE_TOKEN', 'GH_TOKEN'],
    },
    env: { GITEE_TOKEN: TOKEN_VALUE },
  });
  assert.equal(resolved.cliPath, CLI_PATH);
  assert.equal(resolved.host, HOST);
  assert.equal(resolved.timeoutMs, 45_000);
  assert.deepEqual([...resolved.authEnv], ['GITEE_TOKEN', 'GH_TOKEN']);
  assert.equal(resolved.tokenSource, 'GITEE_TOKEN', '先配先生效');
  assert.deepEqual([...resolved.missing], []);
  assert.equal(JSON.stringify(resolved).includes(TOKEN_VALUE), false, '令牌值不进返回值');
});

test('resolve 多候选变量：按顺序取第一个有值的，一个都没值时全部进 missing', () => {
  const withSecond = resolveGiteeConfig({ config: { authEnv: ['A_TOKEN', 'B_TOKEN'] }, env: { B_TOKEN: TOKEN_VALUE } });
  assert.equal(withSecond.tokenSource, 'B_TOKEN');
  assert.deepEqual([...withSecond.missing], ['host']);

  const none = resolveGiteeConfig({ config: { authEnv: ['A_TOKEN', 'B_TOKEN'] }, env: { A_TOKEN: '   ' } });
  assert.equal(none.tokenSource, null);
  assert.deepEqual([...none.missing], ['host', 'A_TOKEN', 'B_TOKEN'], '空白值等于没注入');
});

test('resolve 不抛错：非法配置按未配置处理，落进 missing（原因由 validateGiteeConfig 给出）', () => {
  const resolved = resolveGiteeConfig({ config: { host: 42, timeoutMs: 0, cliPath: 'gh.cmd' }, env: {} });
  assert.equal(resolved.cliPath, DEFAULT_CLI_PATH);
  assert.equal(resolved.host, null);
  assert.equal(resolved.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.deepEqual([...resolved.missing], ['host', 'GH_TOKEN']);
});

test('resolve 只认显式 env：坏 env（非对象）按空处理，不读进程环境', () => {
  const resolved = resolveGiteeConfig({ config: {}, env: 'not-an-object' });
  assert.equal(resolved.tokenSource, null);
  assert.deepEqual([...resolved.missing], ['host', 'GH_TOKEN']);
});

/* ───────────── describe：可展示形态 ───────────── */

test('describe 只给枚举/数字/变量名：不含令牌值，也不含绝对路径', () => {
  const resolved = resolveGiteeConfig({
    config: { cliPath: CLI_PATH, host: HOST, timeoutMs: 45_000 },
    env: { GH_TOKEN: TOKEN_VALUE },
  });
  const text = describeGiteeConfig(resolved);
  assert.equal(typeof text, 'string');
  assert.equal(text.includes('\n'), false, '单行，便于日志与状态栏');
  assert.match(text, /host=gitee\.corp\.example/);
  assert.match(text, /timeoutMs=45000/);
  assert.match(text, /token=已注入\(GH_TOKEN\)/);
  assert.match(text, /cliPath=…\/forge-gitee/, '路径类值只留文件名');
  assert.equal(text.includes(TOKEN_VALUE), false, 'AC-22：令牌值零出现');
  assert.equal(text.includes('/secret'), false, 'AC-22：绝对路径不出现');
  assert.match(text, /missing=-/);
});

test('describe 对空配置给出"未配置/未注入"，且缺项照 resolve 的清单呈现', () => {
  const text = describeGiteeConfig(resolveGiteeConfig({ config: {}, env: {} }));
  assert.match(text, /cliPath=gh/);
  assert.match(text, /host=未配置/);
  assert.match(text, /token=未注入/);
  assert.match(text, /authEnv=GH_TOKEN/);
  assert.match(text, /missing=host,GH_TOKEN/);
});

test('describe 接受裸配置、resolve 结果与缺省入参（三种入口同一结论）', () => {
  const bare = { cliPath: 'gh', host: HOST, timeoutMs: 45_000, authEnv: ['GH_TOKEN'] };
  const resolved = resolveGiteeConfig({ config: bare, env: { GH_TOKEN: TOKEN_VALUE } });
  assert.equal(describeGiteeConfig(bare), describeGiteeConfig({ value: bare }));
  assert.equal(typeof describeGiteeConfig(undefined), 'string');
  assert.equal(describeGiteeConfig(resolved).includes(TOKEN_VALUE), false);
});

/* ───────────── 静态纪律与跨模块同源 ───────────── */

test('源码静态纪律：无本机绝对路径、URL 字面量、凭据字面量与隐式进程环境读取（AC-22）', () => {
  const text = readFileSync(path.join(SRC_DIR, 'runtime-config.mjs'), 'utf8');
  assert.doesNotMatch(text, /\/Users\/|\/home\/|\/opt\//);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.doesNotMatch(text, /\b(password|passwd|token|secret)\s*[:=]\s*['"]/i);
  assert.doesNotMatch(text, /process\.env/);
});

test('默认超时只有一份：配置层默认即 runner 实际使用的值（两处漂移会立刻红灯）', async () => {
  const calls = [];
  const execFile = (bin, args, options, callback) => {
    calls.push({ bin, args: [...args], options });
    callback(null, '', '');
    return { pid: 1 };
  };
  const runner = createGiteeRunner({ execFile, env: {} });
  await runner.run({ bin: 'gh', args: ['version'], purpose: 'parity' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, DEFAULT_TIMEOUT_MS);
  assert.equal(calls[0].options.maxBuffer, DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(resolveGiteeConfig({ config: {}, env: {} }).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 1_048_576);
});
