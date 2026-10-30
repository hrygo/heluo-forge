/**
 * T2 命令行配置（AC-3 / AC-5 / AC-9 / AC-10）：三层优先级、来源归属、逐字段校验、脱敏描述。
 *
 * 这些用例是"配置页能存什么"与"工具面能说什么"的机器证据：
 *   - 优先级矩阵：同一环境两次解析结论一致，任何一层单独存在都能被正确归属；
 *   - 非法值：逐字段报错且**不回落下一层**（静默换路径比直接失败更危险）；
 *   - 脱敏：`describeCliAccess()` 的结果里连一个路径/endpoint 字符都不许出现。
 *
 * 全部离线：`fs` 用假实现，`platform` 显式注入（Windows 行为只能这样覆盖，真机属 NOT RUN）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CLI_FIELDS,
  CLI_ORIGINS,
  CLI_ORIGIN_LABELS,
  CLI_PAGE_HINT,
  CLI_REASONS,
  CLI_SEARCH_CATEGORIES,
  buildCliPatch,
  cliGuidance,
  deriveSourceType,
  describeCliAccess,
  resolveCliAccess,
  validateCliField,
} from '../src/cli-config.mjs';
// AC-4/r8：入口形态的唯一真源在 `entry-form.mjs`，校验侧只消费它的判定（源码静态断言见文件末尾）。
// 因此这里不再 import 任何后缀表——本文件用「6 形态同等放行」证明保存口已无后缀门槛（AC-1）。
import { ENV_KEYS } from '../src/runtime-config.mjs';

const WIN = 'win32';
const POSIX = 'linux';

/** 三个不同层的 dop 路径：谁赢必须由**值本身**证明，不能只看 origin 字段。 */
const CONF_DOP = 'C:\\conf\\dop.exe';
const ENV_DOP = 'C:\\env\\dop.exe';
const DISC_DOP = 'C:\\disc\\dop.exe';
const WIN_GH = 'C:\\disc\\gh.exe';
const WIN_CMD = 'C:\\tools\\dop.cmd';
const WIN_BAT = 'C:\\tools\\dop.bat';
const WIN_SH = 'C:\\tools\\dop.sh';
const WIN_DIR = 'C:\\heluo';
const WIN_MISSING = 'C:\\missing\\dop.exe';
const POSIX_DOP = '/opt/corp/dop';
const POSIX_NOEXEC = '/opt/corp/notes';
/* AC-1 的 6 种「能存」形态。第一行正是本次报障值：npm 在 Windows 上生成的命令 shim，没有后缀。 */
/* npm 全局 bin 目录的两种写法：无后缀 shim 与同名 .cmd（r8 报障的现场形态，路径用占位目录）。 */
const WIN_SHIM_NOEXT = 'C:\\npm-global\\dop';
const WIN_NPM_CMD = 'C:\\npm-global\\dop.cmd';
const WIN_PS1 = 'C:\\tools\\dop.ps1';
const WIN_GH_PS1 = 'C:\\tools\\gh.ps1';
const WIN_EXE_UPPER = 'C:\\tools\\DOP.EXE';
/* 存在但不是普通文件（管道/设备）：形态放开了也不该让它过。 */
const WIN_OTHER = 'C:\\tools\\dop-fifo';
/* POSIX 上的包装脚本：即使执行位齐全也不可直接启动（r3 口径，PRD 要求 POSIX 不动）。 */
const POSIX_CMD = '/opt/corp/dop.cmd';
/* 形状非法的路径（含控制字符）：无 fs 的解析期也必须 fail closed，用它做「层非法」的样本。 */
const WIN_CTRL = 'C:\\tools\\dop\u0000.exe';
/* 正斜杠写法：Windows API 接受，保存时不得擅自改成反斜杠。 */
const WIN_SLASH_CMD = 'C:/tools/dop.cmd';
const ENDPOINT = 'https://dop.corp.example/api';
/* 内嵌凭据的样例用拼接构造，避免在仓库里出现"看起来像真凭据"的字面量。 */
const CRED_ENDPOINT = ['https', '://svc:', 'pw', '@dop.corp.example/api'].join('');
const BAD_SCHEME = ['ftp', '://dop.corp.example/api'].join('');

/** 只实现本模块真正用到的同步面：`statSync`（零 IO、确定性）。 */
function fakeFs(entries) {
  return {
    statSync(target) {
      const hit = entries[target];
      if (hit === undefined) {
        const error = new Error(`ENOENT: ${target}`);
        error.code = 'ENOENT';
        throw error;
      }
      return {
        isFile: () => hit.kind === 'file',
        isDirectory: () => hit.kind === 'dir',
        mode: hit.mode ?? 0o755,
      };
    },
  };
}

const FILE_FS = fakeFs({
  [CONF_DOP]: { kind: 'file' },
  [ENV_DOP]: { kind: 'file' },
  [DISC_DOP]: { kind: 'file' },
  [WIN_GH]: { kind: 'file' },
  [WIN_CMD]: { kind: 'file' },
  [WIN_BAT]: { kind: 'file' },
  [WIN_SH]: { kind: 'file' },
  [WIN_SHIM_NOEXT]: { kind: 'file' },
  [WIN_NPM_CMD]: { kind: 'file' },
  [WIN_PS1]: { kind: 'file' },
  [WIN_GH_PS1]: { kind: 'file' },
  [WIN_EXE_UPPER]: { kind: 'file' },
  [WIN_OTHER]: { kind: 'other' },
  [WIN_SLASH_CMD]: { kind: 'file' },
  [WIN_DIR]: { kind: 'dir' },
  [POSIX_DOP]: { kind: 'file', mode: 0o755 },
  [POSIX_CMD]: { kind: 'file', mode: 0o755 },
  [POSIX_NOEXEC]: { kind: 'file', mode: 0o644 },
});

function discoveryOf({ dop = [], gh = [], searched = ['PATH', 'candidate-dirs'] } = {}) {
  const shape = (tool, found) => ({
    tool,
    found: found.map((path) => ({ path, tier: 'PATH' })),
    rejected: [],
    searched,
    scannedDirs: 2,
    truncated: false,
    elapsedMs: 1,
  });
  return { dop: shape('dop', dop), gh: shape('gh', gh) };
}

const resolve = (options) => resolveCliAccess({ platform: WIN, ...options });

test('常量表：字段与 ENV_KEYS 同键，五种 origin 各有中文标签，原因码与蓝图一致', () => {
  assert.deepEqual(Array.from(CLI_FIELDS), Object.keys(ENV_KEYS));
  assert.deepEqual(Array.from(CLI_FIELDS), ['dopBin', 'dopEndpoint', 'ghBin', 'ghOwner', 'sourceType', 'timeoutMs']);
  assert.deepEqual(Object.values(CLI_ORIGINS), ['config', 'env', 'discovered', 'default', 'missing']);
  assert.deepEqual(Object.values(CLI_REASONS), [
    'CLI_NOT_FOUND',
    'CLI_CONFIG_INVALID',
    'CLI_CONFIG_CONFLICT',
    'CLI_CONFIG_UNAVAILABLE',
  ]);
  // origin 文案只有一份：五个枚举值必须一一对应，页面 Tag / 指引 / 状态面共用它。
  assert.deepEqual(Object.keys(CLI_ORIGIN_LABELS).sort(), Object.values(CLI_ORIGINS).sort());
  assert.deepEqual(
    Object.values(CLI_ORIGIN_LABELS),
    ['配置', '环境变量', '自动发现', '基线缺省', '未找到'],
  );
  for (const table of [CLI_FIELDS, CLI_ORIGINS, CLI_REASONS, CLI_ORIGIN_LABELS]) {
    assert.ok(Object.isFrozen(table), '常量表不允许运行时改写');
  }
  // AC-1 改名：指引里的入口名与页面 nav/title 逐字同源，写死旧名会让工具失败提示指向不存在的入口。
  assert.equal(CLI_PAGE_HINT, '设置 → 企业 DevOps', '指引必须指向配置页（AC-1/AC-5/AC-12）');
  assert.equal(CLI_PAGE_HINT.includes('DevOps 变更流程'), false, '旧名必须零残留');
});

test('零配置 + 自动发现命中：ready 且两层路径字段都记 discovered（AC-1）', () => {
  const access = resolve({ config: {}, env: {}, discovery: discoveryOf({ dop: [DISC_DOP], gh: [WIN_GH] }) });
  assert.equal(access.ready, true);
  assert.equal(access.reason, null);
  assert.equal(access.entries.dopBin.origin, CLI_ORIGINS.DISCOVERED);
  assert.equal(access.entries.dopBin.value, DISC_DOP);
  assert.equal(access.entries.dopBin.tool, 'dop');
  assert.equal(access.entries.ghBin.value, WIN_GH);
  assert.equal(access.entries.ghBin.tool, 'gh');
  assert.deepEqual(access.value, {
    dopBin: DISC_DOP,
    dopEndpoint: undefined,
    ghBin: WIN_GH,
    ghOwner: undefined,
    sourceType: 'enterprise',
    timeoutMs: 20_000,
  });
  assert.deepEqual(Array.from(access.searched), ['config', 'env', 'PATH', 'candidate-dirs']);
});

test('3×3 优先级矩阵（dopBin）：配置 > 环境变量 > 自动发现，逐组合断言赢家与 origin', () => {
  const cases = [
    { config: false, env: false, found: false, origin: CLI_ORIGINS.MISSING, value: null },
    { config: false, env: false, found: true, origin: CLI_ORIGINS.DISCOVERED, value: DISC_DOP },
    { config: false, env: true, found: false, origin: CLI_ORIGINS.ENV, value: ENV_DOP },
    { config: false, env: true, found: true, origin: CLI_ORIGINS.ENV, value: ENV_DOP },
    { config: true, env: false, found: false, origin: CLI_ORIGINS.CONFIG, value: CONF_DOP },
    { config: true, env: false, found: true, origin: CLI_ORIGINS.CONFIG, value: CONF_DOP },
    { config: true, env: true, found: false, origin: CLI_ORIGINS.CONFIG, value: CONF_DOP },
    { config: true, env: true, found: true, origin: CLI_ORIGINS.CONFIG, value: CONF_DOP },
  ];
  for (const item of cases) {
    const label = `config=${item.config} env=${item.env} discovered=${item.found}`;
    const access = resolve({
      config: item.config ? { dopBin: CONF_DOP } : {},
      env: item.env ? { [ENV_KEYS.dopBin]: ENV_DOP } : {},
      discovery: discoveryOf({ dop: item.found ? [DISC_DOP] : [] }),
    });
    assert.equal(access.entries.dopBin.origin, item.origin, label);
    assert.equal(access.entries.dopBin.value, item.value, label);
    assert.equal(access.ready, item.origin !== CLI_ORIGINS.MISSING, label);
  }
});

test('ghBin 矩阵：三层之外还有基线缺省 gh（origin=default），不是第四层', () => {
  const cases = [
    { config: false, env: false, found: false, origin: CLI_ORIGINS.DEFAULT, value: 'gh' },
    { config: false, env: false, found: true, origin: CLI_ORIGINS.DISCOVERED, value: WIN_GH },
    { config: false, env: true, found: false, origin: CLI_ORIGINS.ENV, value: 'gh-env' },
    { config: true, env: true, found: true, origin: CLI_ORIGINS.CONFIG, value: WIN_GH },
  ];
  for (const item of cases) {
    const access = resolve({
      config: item.config ? { dopBin: CONF_DOP, ghBin: WIN_GH } : { dopBin: CONF_DOP },
      env: item.env ? { [ENV_KEYS.ghBin]: 'gh-env' } : {},
      discovery: discoveryOf({ dop: [DISC_DOP], gh: item.found ? [WIN_GH] : [] }),
    });
    assert.equal(access.entries.ghBin.origin, item.origin);
    assert.equal(access.entries.ghBin.value, item.value);
  }
});

/**
 * 推导判据（AC-7/AC-8）：事实来源只在一处推导，页面与装配层都只消费结论。
 * 表驱动而不是逐条 `assert`：判据一改（例如改成"单 dop 即 enterprise"），四态表先红。
 */
const readyEntry = (origin, value) => ({ origin, value, overrides: [] });

test('deriveSourceType 四态表：dop 与 gh 都就绪才 enterprise，其余一律 mock（AC-7/AC-8）', () => {
  const cases = [
    {
      label: '双入口都来自配置层',
      dopBin: readyEntry(CLI_ORIGINS.CONFIG, CONF_DOP),
      ghBin: readyEntry(CLI_ORIGINS.CONFIG, WIN_GH),
      expected: 'enterprise',
    },
    {
      label: '双入口都来自自动发现（装好即企业，最常见）',
      dopBin: readyEntry(CLI_ORIGINS.DISCOVERED, DISC_DOP),
      ghBin: readyEntry(CLI_ORIGINS.DISCOVERED, WIN_GH),
      expected: 'enterprise',
    },
    {
      label: 'dop 配置 + gh 环境变量（层不同不影响判据）',
      dopBin: readyEntry(CLI_ORIGINS.CONFIG, CONF_DOP),
      ghBin: readyEntry(CLI_ORIGINS.ENV, 'C:\\env\\gh.exe'),
      expected: 'enterprise',
    },
    {
      label: '只有 dop，gh 停在基线缺省 gh（裸命令名不验证存在性）',
      dopBin: readyEntry(CLI_ORIGINS.DISCOVERED, DISC_DOP),
      ghBin: readyEntry(CLI_ORIGINS.DEFAULT, 'gh'),
      expected: 'mock',
    },
    {
      label: '只有 gh，dop 缺失',
      dopBin: readyEntry(CLI_ORIGINS.MISSING, null),
      ghBin: readyEntry(CLI_ORIGINS.DISCOVERED, WIN_GH),
      expected: 'mock',
    },
    {
      label: 'dop 非法（origin=config、value=null）不因"声明过"升级',
      dopBin: readyEntry(CLI_ORIGINS.CONFIG, null),
      ghBin: readyEntry(CLI_ORIGINS.DISCOVERED, WIN_GH),
      expected: 'mock',
    },
    {
      label: '入口值是空串同样不算就绪',
      dopBin: readyEntry(CLI_ORIGINS.ENV, ''),
      ghBin: readyEntry(CLI_ORIGINS.DISCOVERED, WIN_GH),
      expected: 'mock',
    },
    {
      label: '两个入口都没有',
      dopBin: readyEntry(CLI_ORIGINS.MISSING, null),
      ghBin: readyEntry(CLI_ORIGINS.DEFAULT, 'gh'),
      expected: 'mock',
    },
  ];
  for (const item of cases) {
    assert.equal(deriveSourceType({ dopBin: item.dopBin, ghBin: item.ghBin }), item.expected, item.label);
  }
  // 容错：入参不是 entries 形状时宁可少标，绝不在装配期抛错。
  assert.equal(deriveSourceType(null), 'mock');
  assert.equal(deriveSourceType({}), 'mock');
});

test('推导落 default 槽位、显式声明优先：配置 > 环境变量 > 推导（AC-7 三种覆盖态）', () => {
  // ① 双发现 → enterprise；origin 仍是 default、overrides 为空（推导不压任何层）
  const derived = resolve({ config: {}, env: {}, discovery: discoveryOf({ dop: [DISC_DOP], gh: [WIN_GH] }) });
  assert.equal(derived.entries.sourceType.origin, CLI_ORIGINS.DEFAULT);
  assert.equal(derived.entries.sourceType.value, 'enterprise');
  assert.deepEqual(Array.from(derived.entries.sourceType.overrides), []);
  assert.equal(derived.entries.sourceType.tool, undefined, 'sourceType 不是路径字段，不带 tool');
  assert.equal(derived.value.sourceType, 'enterprise', '推导要经 Access.value 到装配层才有用');

  // ② 只有 dop → mock：gh 停在裸命令名，不许标成企业实测
  const onlyDop = resolve({ config: {}, env: {}, discovery: discoveryOf({ dop: [DISC_DOP] }) });
  assert.equal(onlyDop.entries.ghBin.origin, CLI_ORIGINS.DEFAULT);
  assert.equal(onlyDop.entries.sourceType.value, 'mock', '缺 gh 不许标成企业实测（AC-8）');

  // ③ 环境变量压过推导：入口不齐也照用用户声明
  const envDeclared = resolve({
    config: {},
    env: { [ENV_KEYS.sourceType]: 'enterprise' },
    discovery: discoveryOf({ dop: [DISC_DOP] }),
  });
  assert.equal(envDeclared.entries.sourceType.origin, CLI_ORIGINS.ENV);
  assert.equal(envDeclared.entries.sourceType.value, 'enterprise');

  // ④ 配置层压过环境变量与推导，压制关系留痕
  const configDeclared = resolve({
    config: { sourceType: 'mock' },
    env: { [ENV_KEYS.sourceType]: 'enterprise' },
    discovery: discoveryOf({ dop: [DISC_DOP], gh: [WIN_GH] }),
  });
  assert.equal(configDeclared.entries.sourceType.origin, CLI_ORIGINS.CONFIG);
  assert.equal(configDeclared.entries.sourceType.value, 'mock', '显式 mock 压过"看起来像企业"的环境');
  assert.deepEqual(Array.from(configDeclared.entries.sourceType.overrides), [CLI_ORIGINS.ENV]);

  // ⑤ 显式值非法时不推导、不回落：仍是 CLI_CONFIG_INVALID + 该字段 value=null
  const bad = resolve({
    config: { sourceType: 'prod' },
    env: {},
    discovery: discoveryOf({ dop: [DISC_DOP], gh: [WIN_GH] }),
  });
  assert.equal(bad.entries.sourceType.origin, CLI_ORIGINS.CONFIG);
  assert.equal(bad.entries.sourceType.value, null);
  assert.deepEqual(bad.invalid.map((item) => item.field), ['sourceType']);
});

test('dopBin 永不出现 default：三层都没有即 CLI_NOT_FOUND（fail closed）', () => {
  const access = resolve({ config: {}, env: {}, discovery: discoveryOf({}) });
  assert.equal(access.ready, false);
  assert.equal(access.reason, CLI_REASONS.NOT_FOUND);
  assert.equal(access.entries.dopBin.origin, CLI_ORIGINS.MISSING);
  assert.equal(access.entries.dopBin.value, null);
  assert.equal(access.value, null, '不 ready 时不得夹带半成品配置');
  assert.equal(access.guidance.includes('未找到 dop'), true);
});

test('无发现层可言的字段：sourceType/timeoutMs 取 default，dopEndpoint/ghOwner 记 missing', () => {
  const access = resolve({ config: { dopBin: CONF_DOP }, env: {}, discovery: discoveryOf({ dop: [DISC_DOP] }) });
  assert.deepEqual(
    {
      sourceType: [access.entries.sourceType.origin, access.entries.sourceType.value],
      timeoutMs: [access.entries.timeoutMs.origin, access.entries.timeoutMs.value],
      dopEndpoint: [access.entries.dopEndpoint.origin, access.entries.dopEndpoint.value],
      ghOwner: [access.entries.ghOwner.origin, access.entries.ghOwner.value],
    },
    {
      sourceType: [CLI_ORIGINS.DEFAULT, 'mock'],
      timeoutMs: [CLI_ORIGINS.DEFAULT, 20_000],
      dopEndpoint: [CLI_ORIGINS.MISSING, null],
      ghOwner: [CLI_ORIGINS.MISSING, null],
    },
  );
  // 发现层不参与非路径字段：给了也不许取
  assert.equal(access.entries.dopEndpoint.origin, CLI_ORIGINS.MISSING);
});

test('覆盖关系可解释：配置压过环境变量/自动发现、环境变量压过自动发现都要留痕（AC-3/AC-7）', () => {
  const overConfig = resolve({
    config: { dopBin: CONF_DOP },
    env: { [ENV_KEYS.dopBin]: ENV_DOP },
    discovery: discoveryOf({ dop: [DISC_DOP] }),
  });
  assert.deepEqual(Array.from(overConfig.entries.dopBin.overrides), [CLI_ORIGINS.ENV, CLI_ORIGINS.DISCOVERED]);

  const overEnv = resolve({
    config: {},
    env: { [ENV_KEYS.dopBin]: ENV_DOP },
    discovery: discoveryOf({ dop: [DISC_DOP] }),
  });
  assert.deepEqual(Array.from(overEnv.entries.dopBin.overrides), [CLI_ORIGINS.DISCOVERED]);

  const clean = resolve({ config: { dopBin: CONF_DOP }, env: {}, discovery: discoveryOf({}) });
  assert.deepEqual(Array.from(clean.entries.dopBin.overrides), [], '下层没有值就没有"被覆盖"可报');
});

test('配置层非法：CLI_CONFIG_INVALID，且不回落环境变量/自动发现（不静默换路径）', () => {
  // 解析期不读盘（fs 缺失），所以"非法"只能来自形状：含控制字符的路径谁都救不回来。
  // 包装脚本不再是非法值（AC-1）——这条分支的样本必须换掉，否则测的是已被删除的规则。
  const access = resolve({
    config: { dopBin: WIN_CTRL },
    env: { [ENV_KEYS.dopBin]: ENV_DOP },
    discovery: discoveryOf({ dop: [DISC_DOP] }),
  });
  assert.equal(access.ready, false);
  assert.equal(access.reason, CLI_REASONS.INVALID);
  assert.equal(access.value, null);
  assert.deepEqual(access.invalid.map((item) => [item.field, item.origin]), [['dopBin', CLI_ORIGINS.CONFIG]]);
  assert.equal(access.invalid[0].message, '不能包含换行或控制字符');
  assert.equal(access.entries.dopBin.value, null);
  assert.match(access.guidance, /命令行配置不可用（dopBin：/);
});

test('环境变量层非法同样 fail closed，origin 记 env（不是 config）', () => {
  const access = resolve({
    config: {},
    env: { [ENV_KEYS.dopBin]: WIN_CTRL },
    discovery: discoveryOf({ dop: [DISC_DOP] }),
  });
  assert.equal(access.ready, false);
  assert.equal(access.reason, CLI_REASONS.INVALID);
  assert.equal(access.invalid[0].origin, CLI_ORIGINS.ENV);
  assert.equal(access.entries.dopBin.origin, CLI_ORIGINS.ENV);
});

test('非路径字段的非法值也拒：endpoint/owner/sourceType/timeoutMs 逐字段进 invalid', () => {
  const access = resolve({
    config: { dopBin: CONF_DOP, dopEndpoint: BAD_SCHEME, ghOwner: '-acme', sourceType: 'prod', timeoutMs: 999 },
    env: {},
    discovery: discoveryOf({}),
  });
  assert.equal(access.ready, false);
  assert.equal(access.reason, CLI_REASONS.INVALID);
  assert.deepEqual(
    access.invalid.map((item) => item.field),
    ['dopEndpoint', 'ghOwner', 'sourceType', 'timeoutMs'],
  );
  assert.match(access.guidance, /命令行配置不可用/);
});

test('接受 resolveRuntimeConfig 信封作为配置层；ok:false 信封视为未配置', () => {
  const envelope = { ok: true, value: { dopBin: CONF_DOP, sourceType: 'enterprise', timeoutMs: 30_000 } };
  const ready = resolve({ config: envelope, env: {}, discovery: discoveryOf({}) });
  assert.equal(ready.ready, true);
  assert.equal(ready.entries.dopBin.origin, CLI_ORIGINS.CONFIG);
  assert.equal(ready.entries.sourceType.value, 'enterprise');

  const missing = resolve({
    config: { ok: false, reason: 'CONFIG_MISSING', missing: ['FORGE_DEVOPS_DOP_BIN'] },
    env: {},
    discovery: discoveryOf({ dop: [DISC_DOP] }),
  });
  assert.equal(missing.ready, true, '配置层不可用不等于发现层不可用');
  assert.equal(missing.entries.dopBin.origin, CLI_ORIGINS.DISCOVERED);
});

test('searched 只报真正查过的类别：无发现层则只有配置与环境变量', () => {
  const noDiscovery = resolve({ config: {}, env: {} });
  assert.deepEqual(Array.from(noDiscovery.searched), [CLI_SEARCH_CATEGORIES.CONFIG, CLI_SEARCH_CATEGORIES.ENV]);

  const singularTier = discoveryOf({ searched: ['PATH', 'candidate-dir'] });
  assert.deepEqual(Array.from(resolve({ config: {}, env: {}, discovery: singularTier }).searched), [
    'config',
    'env',
    'PATH',
    'candidate-dirs',
  ]);

  const silent = discoveryOf({});
  for (const tool of ['dop', 'gh']) delete silent[tool].searched;
  assert.deepEqual(Array.from(resolve({ config: {}, env: {}, discovery: silent }).searched), [
    'config',
    'env',
    'PATH',
    'candidate-dirs',
  ]);
});

test('剖白描述（describeCliAccess）：origin/布尔/枚举，零路径零 endpoint 零值（AC-10）', () => {
  const access = resolve({
    config: { dopBin: CONF_DOP, dopEndpoint: ENDPOINT, ghOwner: 'acme', sourceType: 'enterprise', timeoutMs: 30_000 },
    env: {},
    discovery: discoveryOf({ dop: [CONF_DOP], gh: [WIN_GH] }),
  });
  const described = describeCliAccess(access);
  const json = JSON.stringify(described);

  for (const secret of [CONF_DOP, WIN_GH, ENDPOINT, 'acme', 'corp.example']) {
    assert.equal(json.includes(secret), false, `脱敏描述不得出现 ${secret} 这样的值`);
  }
  assert.equal(json.includes('.exe'), false, '连可执行文件名片段都不给');
  assert.equal(/[A-Za-z]:\\/.test(json), false, '不得出现盘符路径形态');
  assert.equal(described.ready, true);
  assert.equal(described.reason, null);
  assert.deepEqual(
    Object.fromEntries(Object.entries(described.entries).map(([field, entry]) => [field, entry.origin])),
    {
      dopBin: 'config',
      dopEndpoint: 'config',
      ghBin: 'discovered',
      ghOwner: 'config',
      sourceType: 'config',
      timeoutMs: 'config',
    },
  );
  assert.equal(described.entries.dopBin.configured, true);
  assert.equal(described.entries.ghOwner.configured, true, '只给"配没配"，不给配了什么');
  assert.equal(described.sourceType, 'enterprise');
  assert.equal(described.timeoutMs, 30_000);
  // 覆盖关系照样可以脱敏说明：配置压过自动发现（AC-3 要求"压制可见"，AC-10 要求"值不可见"）
  assert.deepEqual(Array.from(described.entries.dopBin.overrides), ['discovered']);
});

test('剖白描述对未就绪态同样零泄漏，并保留可读指引', () => {
  const access = resolve({ config: { dopBin: WIN_CTRL }, env: {}, discovery: discoveryOf({}) });
  const described = describeCliAccess(access);
  const json = JSON.stringify(described);
  assert.equal(json.includes('CLI_CONFIG_INVALID'), true, '失败原因是类别码/类别名，不是路径');
  assert.equal(json.includes('C:\\tools'), false, '非法输入值不得随描述外泄');
  assert.equal(described.ready, false);
  assert.equal(described.invalid[0].field, 'dopBin');
  assert.equal(described.invalid[0].origin, CLI_ORIGINS.CONFIG);
  assert.match(described.guidance, /企业 DevOps/);
  // 描述结果本身也能喂给 cliGuidance（两个函数的入参同形）
  assert.equal(cliGuidance(described), described.guidance);
});

test('同一环境两次解析结论一致（AC-3 的可重复性）', () => {
  const input = {
    config: { dopBin: CONF_DOP },
    env: { [ENV_KEYS.ghOwner]: 'acme' },
    discovery: discoveryOf({ dop: [DISC_DOP], gh: [WIN_GH] }),
    platform: WIN,
  };
  assert.deepEqual(resolveCliAccess(input), resolveCliAccess(input));
});

test('12 条非法值：逐字段可读原因，且 message 不回显用户输入（AC-2/AC-9/AC-10）', () => {
  const cases = [
    { field: 'dopBin', value: WIN_MISSING, platform: WIN, expected: '找不到这个文件' },
    // AC-2 文案：不再点名 `.exe`（win32 上本体未必带 `.exe`），但必须说清"这是目录"并给出本体名。
    { field: 'dopBin', value: WIN_DIR, platform: WIN, expected: '这是目录，需要指向 dop 的可执行文件本体' },
    { field: 'ghBin', value: WIN_DIR, platform: WIN, expected: '这是目录，需要指向 gh 的可执行文件本体' },
    // 形态放开了，「存在但不是普通文件」仍然是硬错（管道/设备/套接字）。
    { field: 'dopBin', value: WIN_OTHER, platform: WIN, expected: '不是可直接执行的文件' },
    { field: 'dopBin', value: 42, platform: WIN, expected: '需要一个文本值' },
    { field: 'dopBin', value: WIN_CTRL, platform: WIN, expected: '不能包含换行或控制字符' },
    // POSIX 口径不动：包装脚本仍然不可直接启动，执行位仍然是门槛（文案保持原样）。
    { field: 'dopBin', value: POSIX_NOEXEC, platform: POSIX, expected: '不是可直接执行的文件（缺少执行位）' },
    { field: 'dopBin', value: POSIX_CMD, platform: POSIX, expected: '不是可直接执行的文件' },
    { field: 'dopEndpoint', value: BAD_SCHEME, platform: WIN, expected: '需要 http 或 https 地址，且地址里不能带用户名密码' },
    { field: 'dopEndpoint', value: CRED_ENDPOINT, platform: WIN, expected: '需要 http 或 https 地址，且地址里不能带用户名密码' },
    { field: 'ghOwner', value: '-acme', platform: WIN, expected: '只能是字母、数字和连字符，且不能以连字符开头' },
    { field: 'timeoutMs', value: 999, platform: WIN, expected: '请输入 1000–600000 之间的整数（毫秒）' },
    { field: 'timeoutMs', value: '1000.5', platform: WIN, expected: '请输入 1000–600000 之间的整数（毫秒）' },
    { field: 'sourceType', value: 'prod', platform: WIN, expected: '只能取 mock 或 enterprise' },
    { field: 'dopbin', value: CONF_DOP, platform: WIN, expected: '未知配置项：dopbin' },
  ];
  assert.ok(cases.length >= 12);
  for (const item of cases) {
    const verdict = validateCliField({ field: item.field, value: item.value, platform: item.platform, fs: FILE_FS });
    assert.equal(verdict.ok, false, `${item.field}=${String(item.value)}`);
    assert.equal(verdict.message, item.expected, `${item.field}=${String(item.value)}`);
    assert.equal(String(verdict.message).includes(String(item.value)), false, '错误信息不得回显输入值');
  }
  // 后缀不再是拒收理由：同一批非法值里不许再出现"请指向 .exe / 只接受 .exe"这类把用户引向猜后缀的话。
  for (const item of cases) {
    assert.equal(/\.exe/.test(String(item.expected)), false, `${item.field} 的文案不得点名后缀形态`);
  }
});

test('AC-1 六形态放行：win32 只判「存在且是普通文件」，且原值逐字（大小写/斜杠/后缀都不动）', () => {
  const saveable = [
    [WIN_SHIM_NOEXT, '无后缀（npm 在 Windows 上生成的命令 shim，本次报障值）'],
    [WIN_NPM_CMD, '.cmd 包装脚本'],
    [WIN_CMD, '.cmd（普通目录下的相对常规写法）'],
    [WIN_PS1, '.ps1'],
    [WIN_BAT, '.bat'],
    [CONF_DOP, '.exe 原生入口'],
    [WIN_EXE_UPPER, '大写 .EXE（不因大小写被拒）'],
    [WIN_SH, '其它后缀（.sh）同样可存：win32 不看后缀'],
  ];
  for (const [value, label] of saveable) {
    // ① 字段校验：与保存路径结论一致（都 ok），值原样返回
    assert.deepEqual(validateCliField({ field: 'dopBin', value, platform: WIN, fs: FILE_FS }), {
      ok: true,
      value,
    }, label);
    // ② 保存补丁：写进用户层的必须是原值逐字（不补后缀、不改大小写、不换斜杠）
    assert.deepEqual(
      buildCliPatch({ current: {}, patch: { dopBin: value }, platform: WIN, fs: FILE_FS }),
      { ok: true, next: { dopBin: value } },
      label,
    );
    // ③ 保存成功后该字段来源仍是配置层（AC-1 的 origin='config'），不是被自动发现顶掉
    const access = resolve({ config: { dopBin: value }, env: {}, discovery: discoveryOf({ dop: [DISC_DOP] }) });
    assert.equal(access.ready, true, label);
    assert.equal(access.entries.dopBin.origin, CLI_ORIGINS.CONFIG, label);
    assert.equal(access.entries.dopBin.value, value, label);
  }

  // 逐字回写的边界：首尾空白按既有规则去掉，中间字符一个不动（`/` 不转 `\`，`C:` 不改大小写）。
  assert.deepEqual(
    buildCliPatch({ current: {}, patch: { dopBin: `  ${WIN_SLASH_CMD}  ` }, platform: WIN, fs: FILE_FS }),
    { ok: true, next: { dopBin: WIN_SLASH_CMD } },
    '只去首尾空白，不把 / 换成 \\',
  );
  // gh 同理：目录/后缀都不拦，只有"找不到/是目录/不是普通文件"才拦。
  assert.deepEqual(validateCliField({ field: 'ghBin', value: WIN_GH_PS1, platform: WIN, fs: FILE_FS }), {
    ok: true,
    value: WIN_GH_PS1,
  });
});

test('合法值：归一化（去空白/小写/数字）与"清空即回落"都视为 ok', () => {
  const accept = (field, value, platform = WIN) =>
    validateCliField({ field, value, platform, fs: FILE_FS });

  assert.deepEqual(accept('dopBin', `  ${CONF_DOP}  `), { ok: true, value: CONF_DOP });
  assert.deepEqual(accept('ghBin', 'gh'), { ok: true, value: 'gh' }, '裸命令名走 PATH，不要求 .exe');
  assert.deepEqual(accept('dopBin', POSIX_DOP, POSIX), { ok: true, value: POSIX_DOP });
  assert.deepEqual(accept('dopBin', '   '), { ok: true, value: null });
  assert.deepEqual(accept('dopBin', null), { ok: true, value: null });
  assert.deepEqual(accept('timeoutMs', '15000'), { ok: true, value: 15_000 });
  assert.deepEqual(accept('sourceType', ' Enterprise '), { ok: true, value: 'enterprise' });
  assert.deepEqual(accept('dopEndpoint', ENDPOINT), { ok: true, value: ENDPOINT });
  assert.deepEqual(accept('ghOwner', 'acme-corp'), { ok: true, value: 'acme-corp' });
  // 无 fs 时只做形状判定：路径存在性是"保存"环节的责任，解析环节不读盘
  assert.deepEqual(validateCliField({ field: 'dopBin', value: WIN_MISSING, platform: WIN }), {
    ok: true,
    value: WIN_MISSING,
  });
});

test('buildCliPatch：意图合并、null 即回落、逐字段报错且一字段不写（AC-9/AC-15）', () => {
  const current = { ghOwner: 'acme', timeoutMs: 20_000 };

  const merged = buildCliPatch({
    current,
    patch: { dopBin: CONF_DOP, timeoutMs: '30000', dopEndpoint: '' },
    platform: WIN,
    fs: FILE_FS,
  });
  assert.deepEqual(merged, { ok: true, next: { ghOwner: 'acme', timeoutMs: 30_000, dopBin: CONF_DOP } });
  assert.deepEqual(current, { ghOwner: 'acme', timeoutMs: 20_000 }, '纯函数：current 不得被改写');

  const cleared = buildCliPatch({ current, patch: { dopBin: null, ghOwner: null }, platform: WIN, fs: FILE_FS });
  assert.deepEqual(cleared, { ok: true, next: { timeoutMs: 20_000 } });

  const emptied = buildCliPatch({ current: { dopBin: CONF_DOP }, patch: { dopBin: null }, platform: WIN, fs: FILE_FS });
  assert.deepEqual(emptied, { ok: true, next: {} }, '清空后不留空值噪声');

  const bad = buildCliPatch({
    current,
    patch: { dopBin: WIN_MISSING, dopEndpoint: BAD_SCHEME, timeoutMs: 99, ghOwner: 'acme' },
    platform: WIN,
    fs: FILE_FS,
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors), ['dopBin', 'dopEndpoint', 'timeoutMs']);
  assert.equal(bad.errors.ghOwner, undefined, '合法字段不报错');

  const unknown = buildCliPatch({ current, patch: { dopbin: CONF_DOP }, platform: WIN, fs: FILE_FS });
  assert.deepEqual(unknown, { ok: false, errors: { dopbin: '未知配置项：dopbin' } });

  const notObject = buildCliPatch({ current, patch: 'dop', platform: WIN, fs: FILE_FS });
  assert.equal(notObject.ok, false);
  assert.equal(typeof notObject.errors.fields, 'string');
});

test('指引文案：类别名 + 指向配置页，不含路径/endpoint/环境变量名（AC-5/AC-10）', () => {
  const notFound = cliGuidance(resolve({ config: {}, env: {}, discovery: discoveryOf({}) }));
  assert.match(notFound, /^未找到 dop · 已查 配置、环境变量、PATH、候选目录 · 请到「设置 → 企业 DevOps」指定位置$/);
  assert.equal(/[A-Za-z]:\\/.test(notFound), false, '工具面文案不得出现盘符路径');
  assert.equal(/FORGE_DEVOPS_/.test(notFound), false, '环境变量名只进次级说明，不进主句');

  const invalid = cliGuidance(resolve({ config: { dopBin: WIN_CTRL }, env: {}, discovery: discoveryOf({}) }));
  assert.match(invalid, /^命令行配置不可用（dopBin：不能包含换行或控制字符）· 请到「设置 → 企业 DevOps」修正$/);
  assert.equal(invalid.includes('C:\\tools'), false, '校验失败的细节只给字段名与原因，不给用户输入值');
  assert.equal(/\.exe/.test(invalid), false, '拒绝原因不再把用户引向"猜后缀"');
});

test('ready 态指引用 origin 标签说话（不写死中文层名）', () => {
  const ready = resolve({ config: {}, env: {}, discovery: discoveryOf({ dop: [DISC_DOP] }) });
  assert.equal(cliGuidance(ready), '命令行工具已就绪（dop 来自自动发现 · gh 来自基线缺省）');
  assert.equal(cliGuidance(null), cliGuidance({ ready: false, reason: null }));
});

test('源码静态纪律：无 node:fs 导入、无子进程、无 URL 字面量、不读 process.env', () => {
  const source = readFileSync(new URL('../src/cli-config.mjs', import.meta.url), 'utf8');
  assert.equal(/from\s+'node:fs'/.test(source), false, 'fs 只能注入，不能自取（发现是唯一读盘环节）');
  assert.equal(/child_process/.test(source), false, '零子进程');
  assert.equal(/https?:\/\//.test(source), false, 'endpoint 只能来自配置/环境，不写死');
  assert.equal(/process\.env/.test(source), false, '环境变量表由调用方显式传入');
  assert.equal(/logs\/teamflow/.test(source), false, '运行日志目录不进交付源码');
  // AC-4（保存侧的一半）：入口形态判定只消费 entry-form，本文件不得再自带后缀规则。
  assert.match(source, /import \{ isDirectlyExecutable \} from '\.\/entry-form\.mjs'/u, '判定必须来自单点模块');
  assert.equal(/WRAPPER_SUFFIXES|wrapperSuffixOf|WRAPPER_MESSAGE/.test(source), false, '不得自带后缀表/后缀拒收文案');
  assert.equal(/endsWith\(\s*'\.exe'\s*\)/i.test(source), false, '不得再按 .exe 结尾判可执行');
  assert.equal(/\.cmd\s*\/\s*\.bat/.test(source), false, '不得再按包装脚本后缀拒收（AC-1）');
});
