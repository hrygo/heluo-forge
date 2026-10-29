/**
 * T1 运行时配置（AC-22）：env 注入、fail closed、不回显值。
 *
 * 这些用例是装配层拒绝启动的唯一依据：只要有一条放松，插件就会在未配置的机器上
 * 用猜测的路径去调 dop——那是把「不可用」伪装成「可用」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_REASONS,
  DEFAULT_GH_BIN,
  DEFAULT_SOURCE_TYPE,
  DEFAULT_TIMEOUT_MS,
  ENV_KEYS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  SOURCE_TYPES,
  describeRuntimeConfig,
  resolveRuntimeConfig,
} from '../src/runtime-config.mjs';
import { createCliRunner } from '../src/cli-runner.mjs';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const DOP_BIN = '/secret/bin/dop';
const ENDPOINT = 'https://secret-endpoint.example/dop';

test('ENV_KEYS 点名六个环境变量且互不重复（文档表格与代码同源）', () => {
  const names = Object.values(ENV_KEYS);
  assert.deepEqual(names, [
    'FORGE_DEVOPS_DOP_BIN',
    'FORGE_DEVOPS_DOP_ENDPOINT',
    'FORGE_DEVOPS_GH_BIN',
    'FORGE_DEVOPS_GH_OWNER',
    'FORGE_DEVOPS_SOURCE_TYPE',
    'FORGE_DEVOPS_TIMEOUT_MS',
  ]);
  assert.equal(new Set(names).size, names.length);
  assert.ok(Object.isFrozen(ENV_KEYS), 'ENV_KEYS 是常量表，不允许运行时改写');
});

test('未配置任何变量：fail closed 并点名 DOP_BIN（不猜默认路径）', () => {
  const result = resolveRuntimeConfig({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, CONFIG_REASONS.MISSING);
  assert.deepEqual(result.missing, ['FORGE_DEVOPS_DOP_BIN']);
  assert.equal(result.value, undefined, '失败结果不得夹带半成品配置');
});

test('未配置时也不接受 undefined 入参（防御式默认）', () => {
  const result = resolveRuntimeConfig(undefined);
  assert.equal(result.ok, false);
  assert.equal(result.reason, CONFIG_REASONS.MISSING);
});

test('最小配置即可用：其余取非机密默认值（gh 走 PATH、来源 mock、超时 20s）', () => {
  const result = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: DOP_BIN });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value).sort(), [
    'dopBin',
    'dopEndpoint',
    'ghBin',
    'ghOwner',
    'sourceType',
    'timeoutMs',
  ]);
  assert.equal(result.value.dopBin, DOP_BIN);
  assert.equal(result.value.dopEndpoint, undefined);
  assert.equal(result.value.ghBin, DEFAULT_GH_BIN);
  assert.equal(result.value.ghOwner, undefined);
  assert.equal(result.value.sourceType, DEFAULT_SOURCE_TYPE);
  assert.equal(result.value.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.deepEqual(SOURCE_TYPES, ['mock', 'enterprise']);
});

test('完整配置原样传递，并去掉首尾空白', () => {
  const result = resolveRuntimeConfig({
    FORGE_DEVOPS_DOP_BIN: `  ${DOP_BIN}  `,
    FORGE_DEVOPS_DOP_ENDPOINT: ENDPOINT,
    FORGE_DEVOPS_GH_BIN: ' /usr/local/bin/gh ',
    FORGE_DEVOPS_GH_OWNER: 'acme',
    FORGE_DEVOPS_SOURCE_TYPE: 'enterprise',
    FORGE_DEVOPS_TIMEOUT_MS: '45000',
  });
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.value }, {
    dopBin: DOP_BIN,
    dopEndpoint: ENDPOINT,
    ghBin: '/usr/local/bin/gh',
    ghOwner: 'acme',
    sourceType: 'enterprise',
    timeoutMs: 45_000,
  });
});

test('空串与纯空白等价于未配置（不把空值当合法路径）', () => {
  const missing = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: '   ' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['FORGE_DEVOPS_DOP_BIN']);

  const ok = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: DOP_BIN, FORGE_DEVOPS_DOP_ENDPOINT: '  ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.dopEndpoint, undefined, '空 endpoint 等于没给，不拼该参数');
});

test('describeRuntimeConfig 只给「已配/未配」布尔位，不回显路径与 endpoint', () => {
  const result = resolveRuntimeConfig({
    FORGE_DEVOPS_DOP_BIN: DOP_BIN,
    FORGE_DEVOPS_DOP_ENDPOINT: ENDPOINT,
    FORGE_DEVOPS_GH_OWNER: 'acme',
  });
  const described = describeRuntimeConfig(result.value);
  assert.deepEqual({ ...described }, {
    dopBin: true,
    dopEndpoint: true,
    ghBin: true,
    ghOwner: true,
    sourceType: 'mock',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  const text = JSON.stringify(described);
  assert.ok(!text.includes(DOP_BIN), '不得回显 dop 路径');
  assert.ok(!text.includes('secret-endpoint.example'), '不得回显 endpoint');
  assert.ok(!text.includes('acme'), '组织名同样按值处理，不外泄');
});

test('describeRuntimeConfig 接受 resolve 结果或裸 value', () => {
  const resolved = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: DOP_BIN });
  assert.deepEqual({ ...describeRuntimeConfig(resolved) }, { ...describeRuntimeConfig(resolved.value) });
});

test('describeRuntimeConfig 对未配置/空值返回全 false 与 null 枚举', () => {
  for (const input of [undefined, {}, { ok: false, reason: 'CONFIG_MISSING', missing: [ENV_KEYS.dopBin] }]) {
    const described = describeRuntimeConfig(input);
    assert.equal(described.dopBin, false);
    assert.equal(described.dopEndpoint, false);
    assert.equal(described.ghBin, false);
    assert.equal(described.ghOwner, false);
    assert.equal(described.sourceType, null);
    assert.equal(described.timeoutMs, null);
  }
});

test('sourceType 归一化为小写，只接受 mock/enterprise', () => {
  const upper = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: DOP_BIN, FORGE_DEVOPS_SOURCE_TYPE: ' Enterprise ' });
  assert.equal(upper.ok, true);
  assert.equal(upper.value.sourceType, 'enterprise');

  const bogus = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: DOP_BIN, FORGE_DEVOPS_SOURCE_TYPE: 'prod' });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.reason, CONFIG_REASONS.INVALID);
  assert.deepEqual(bogus.invalid, ['FORGE_DEVOPS_SOURCE_TYPE']);
});

test('timeoutMs 非数字/越界一律 CONFIG_INVALID（不静默回落默认值）', () => {
  for (const raw of ['abc', '0', '-1', '12.5', String(MAX_TIMEOUT_MS + 1), String(MIN_TIMEOUT_MS - 1)]) {
    const result = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: DOP_BIN, FORGE_DEVOPS_TIMEOUT_MS: raw });
    assert.equal(result.ok, false, `timeoutMs=${raw} 应被拒绝`);
    assert.equal(result.reason, CONFIG_REASONS.INVALID);
    assert.deepEqual(result.invalid, ['FORGE_DEVOPS_TIMEOUT_MS']);
  }
});

test('timeoutMs 合法边界：1000 与 600000 通过', () => {
  for (const raw of [String(MIN_TIMEOUT_MS), String(MAX_TIMEOUT_MS)]) {
    const result = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: DOP_BIN, FORGE_DEVOPS_TIMEOUT_MS: raw });
    assert.equal(result.ok, true, `timeoutMs=${raw} 应被接受`);
    assert.equal(result.value.timeoutMs, Number(raw));
  }
});

test('endpoint 非法（相对地址 / 非 http(s) / 内嵌凭据）→ CONFIG_INVALID', () => {
  // 内嵌凭据的样例用拼接构造：仓库检查器禁止源码出现 "scheme://user:pass@" 字面量，
  // 这里的 `join(':')` 是本意，不是可以合并回字面量的冗余。
  const withCredentials = ['https://user', 'pass@dop.example/api'].join(':');
  for (const endpoint of ['dop.example/api', 'ftp://dop.example/api', withCredentials]) {
    const result = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: DOP_BIN, FORGE_DEVOPS_DOP_ENDPOINT: endpoint });
    assert.equal(result.ok, false, `endpoint=${endpoint} 应被拒绝`);
    assert.deepEqual(result.invalid, ['FORGE_DEVOPS_DOP_ENDPOINT']);
  }
});

test('ghOwner 非法（带斜杠 / 空白 / 连字符开头）→ CONFIG_INVALID', () => {
  for (const owner of ['acme/demo', 'ac me', '-acme']) {
    const result = resolveRuntimeConfig({ FORGE_DEVOPS_DOP_BIN: DOP_BIN, FORGE_DEVOPS_GH_OWNER: owner });
    assert.equal(result.ok, false, `ghOwner=${owner} 应被拒绝`);
    assert.deepEqual(result.invalid, ['FORGE_DEVOPS_GH_OWNER']);
  }
});

test('缺失优先于非法：一次只报一类，先让用户补必须项', () => {
  const result = resolveRuntimeConfig({ FORGE_DEVOPS_SOURCE_TYPE: 'prod', FORGE_DEVOPS_TIMEOUT_MS: '0' });
  assert.equal(result.reason, CONFIG_REASONS.MISSING);
  assert.deepEqual(result.missing, ['FORGE_DEVOPS_DOP_BIN']);
});

test('只认显式 env：进程环境不会被隐式读取', () => {
  const key = ENV_KEYS.dopBin;
  const previous = process.env[key];
  process.env[key] = DOP_BIN;
  try {
    const result = resolveRuntimeConfig({});
    assert.equal(result.ok, false, '显式传入的 env 是唯一来源，装配层负责把环境传进来');
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('超时默认值只有一份：配置层默认即 runner 实际使用的值', async () => {
  let seen;
  const execFile = (_bin, _args, options, callback) => {
    seen = options;
    callback(null, '', '');
  };
  await createCliRunner({ execFile }).run({ bin: 'gh', args: ['repo', 'view', 'acme/demo'] });
  assert.equal(seen.timeout, DEFAULT_TIMEOUT_MS, '两处默认值不得分叉');
});

test('源码不含本机绝对路径、URL 字面量与凭据形态（AC-22 静态纪律）', () => {
  const offenders = [];
  for (const file of ['runtime-config.mjs', 'cli-runner.mjs']) {
    const text = readFileSync(path.join(SRC_DIR, file), 'utf8');
    if (/\/Users\/|\/home\/|\/opt\/|[A-Za-z]:\\\\/.test(text)) offenders.push(`${file}: 绝对路径`);
    if (/https?:\/\//.test(text)) offenders.push(`${file}: URL 字面量`);
    if (/\b(password|passwd|token|secret)\s*[:=]\s*['"]/i.test(text)) offenders.push(`${file}: 凭据字面量`);
  }
  assert.deepEqual(offenders, [], `路径与 endpoint 必须环境注入：${offenders.join('; ')}`);
});
