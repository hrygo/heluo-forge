/**
 * `repo-ref`：仓库引用语法的唯一真源（r6，TECH-CHANGE §3.2）。
 *
 * 这组用例把四件事钉死：
 * 1) 语法边界——2..3 段通过；1 段、4 段、空段、段内空白 / NUL、以连字符或 `.` 开头的段
 *    一律拒绝（放宽段数的收益，不能顺手把 `--flag` 之类放进 argv）；
 * 2) 目标形态——`#n` / `!n` 能剥出**完整**仓库路径（三段不折叠），链接与裸编号返回 `null`；
 * 3) 同一仓库比较——整串、去空白、大小写不敏感，**没有**裸名兜底；
 * 4) 候选内兜底——整串优先；裸名只在候选内唯一同名时命中，跨组同名返回 `ambiguous`
 *    而不是"第一个"（后者等于跨组串仓）。
 *
 * 另有一条静态断言：模块必须保持零依赖、零子进程、零 IO、零时钟——它是被门禁与适配器
 * 共用的纯函数层，一旦开始读环境就很难再离线复现同一判词。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REPO_REF_MAX_SEGMENTS,
  REPO_REF_MIN_SEGMENTS,
  REPO_REF_PATTERN,
  REPO_SEGMENT_SOURCE,
  isRepoRef,
  parseRepoRef,
  parseTargetRef,
  pickRepoRef,
  repoOfTarget,
  sameRepo,
} from '../src/repo-ref.mjs';

/** 合法引用：两段是历史形态，三段是企业 Gitee 命名空间；段内 `.`、`_`、`-` 与数字都允许。 */
const VALID_REFS = [
  'acme/demo',
  'org/group/repo',
  'a/b',
  'A1.b-c/D2_e-f',
  '123/456',
  'org/group/repo.name',
  'org/group/repo_name-1.2',
];

/** 非法引用：[标签, 输入]。每一条都必须在 `isRepoRef` 与 `parseRepoRef` 上同时被拒。 */
const INVALID_REFS = [
  ['1 段（缺仓库）', 'acme'],
  ['4 段（超过上限）', 'acme/demo/x/y'],
  ['5 段（链接形态的路径）', 'some.host/org/group/repo/issues/12'],
  ['空串', ''],
  ['纯空白', '   '],
  ['空段（中间双斜杠）', 'acme//demo'],
  ['空段（尾部斜杠）', 'acme/'],
  ['空段（首部斜杠）', '/demo'],
  ['段内空格（前）', 'acme /demo'],
  ['段内空格（后）', 'acme/de mo'],
  ['段内 NUL', 'acme/de\u0000mo'],
  ['段内换行', 'acme/de\nmo'],
  ['段内制表符', 'acme\t/demo'],
  ['首字符是连字符', '-bad/x'],
  ['`--` 前缀', '--yes/x'],
  ['首字符是点', '.hidden/x'],
  ['带 #n 的目标', 'acme/demo#12'],
  ['带 !n 的目标', 'org/group/repo!7'],
  ['链接', 'https://host.example/org/repo/issues/12'],
  ['裸编号', '12'],
  ['尾部空段带编号', 'acme/demo/#12'],
];

test('语法唯一真源：段数常量、段正则与整串正则一致（两段与三段都合法）', () => {
  assert.equal(REPO_REF_MIN_SEGMENTS, 2);
  assert.equal(REPO_REF_MAX_SEGMENTS, 3);
  assert.equal(REPO_SEGMENT_SOURCE, '[A-Za-z0-9][A-Za-z0-9._-]*');
  assert.ok(REPO_REF_PATTERN instanceof RegExp);
  assert.equal(REPO_REF_PATTERN.flags, 'u', '不得带 g：带 lastIndex 的正则会让同一输入两次判词不同');

  for (const value of VALID_REFS) {
    assert.equal(isRepoRef(value), true, `${value} 应合法`);
    assert.equal(REPO_REF_PATTERN.test(value), true, `${value} 应被整串命中`);
    const parsed = parseRepoRef(value);
    assert.notEqual(parsed, null, `${value} 应可解析`);
    assert.equal(parsed.path, value);
    assert.deepEqual(parsed.segments, value.split('/'), `${value} 的段拆分应与输入同序`);
  }
});

test('非法引用一律拒绝：段数越界、空段、段内空白 / NUL、危险前缀都不放行', () => {
  for (const [label, value] of INVALID_REFS) {
    assert.equal(isRepoRef(value), false, `${label} 应被拒：${JSON.stringify(value)}`);
    assert.equal(parseRepoRef(value), null, `${label} 应解析失败：${JSON.stringify(value)}`);
  }
});

test('非字符串输入不抛错，只判非法（不靠异常当判词）', () => {
  for (const value of [null, undefined, 42, 0, {}, [], { repo: 'acme/demo' }, () => 'acme/demo']) {
    assert.equal(isRepoRef(value), false);
    assert.equal(parseRepoRef(value), null);
    assert.equal(repoOfTarget(value), null);
    assert.equal(parseTargetRef(value), null);
  }
});

test('首尾空白按全仓 text() 约定忽略，段内空白仍然拒绝', () => {
  assert.deepEqual(parseRepoRef('  org/group/repo  '), { path: 'org/group/repo', segments: ['org', 'group', 'repo'] });
  assert.equal(isRepoRef('\tacme/demo\n'), true, '首尾空白等价于无空白');
  assert.equal(isRepoRef('acme/de mo'), false);
  assert.equal(parseRepoRef('acme/de\u0000mo'), null, 'NUL 不属于空白，trim() 不会把它吃掉');
});

test('parseRepoRef 每次返回独立对象，不共享段数组（调用方可以随意改）', () => {
  const first = parseRepoRef('org/group/repo');
  const second = parseRepoRef('org/group/repo');
  assert.notEqual(first, second);
  assert.notEqual(first.segments, second.segments);
  first.segments.push('tampered');
  assert.deepEqual(parseRepoRef('org/group/repo').segments, ['org', 'group', 'repo']);
});

test('repoOfTarget：剥 #n / !n 得到完整仓库路径，不带编号的引用原样返回，链接/裸编号/1 段裸名为 null', () => {
  assert.equal(repoOfTarget('acme/demo#12'), 'acme/demo');
  assert.equal(repoOfTarget('acme/demo!12'), 'acme/demo');
  assert.equal(repoOfTarget('org/group/repo#7'), 'org/group/repo', '三段必须完整返回，不折成 group/repo');
  assert.equal(repoOfTarget('org/group/repo!7'), 'org/group/repo');
  assert.equal(repoOfTarget('  acme/demo#12  '), 'acme/demo');
  assert.equal(repoOfTarget('acme/demo'), 'acme/demo');
  assert.equal(repoOfTarget('org/group/repo'), 'org/group/repo');

  for (const target of [
    '12',
    '#12',
    'https://host.example/org/repo/issues/12',
    'https://host.example/org/repo/issues/12#issuecomment-1',
    'acme/demo#',
    'acme/demo#12x',
    'acme/demo#12#13',
    'acme//demo#1',
    'acme/demo/x/y#1',
    'acme',
  ]) {
    assert.equal(repoOfTarget(target), null, `${target} 不应取到仓库`);
  }
});

test('parseTargetRef：2..3 段 + 尾部 #n / !n 才能解析出 { repo, number }', () => {
  assert.deepEqual(parseTargetRef('acme/demo#12'), { repo: 'acme/demo', number: 12 });
  assert.deepEqual(parseTargetRef('acme/demo!9'), { repo: 'acme/demo', number: 9 });
  assert.deepEqual(parseTargetRef('org/group/repo#123'), { repo: 'org/group/repo', number: 123 });
  assert.deepEqual(parseTargetRef('  org/group/repo!1  '), { repo: 'org/group/repo', number: 1 });

  for (const target of [
    'acme/demo',
    'org/group/repo',
    '12',
    'acme/demo#',
    'acme/demo#1234567890',
    'acme/demo#12x',
    'acme/demo#12#13',
    'acme//demo#1',
    'acme/demo/x/y#1',
    'https://host.example/org/repo/pull/12',
  ]) {
    assert.equal(parseTargetRef(target), null, `${target} 不应解析成评论目标`);
  }
});

test('sameRepo：整串、去空白、大小写不敏感，且没有裸名兜底', () => {
  assert.equal(sameRepo('acme/demo', 'acme/demo'), true);
  assert.equal(sameRepo('Acme/Demo', 'acme/demo'), true);
  assert.equal(sameRepo('  org/group/repo  ', 'ORG/GROUP/REPO'), true);
  assert.equal(sameRepo('org/group/repo', 'group/repo'), false, '三段与两段不是同一个仓库');
  assert.equal(sameRepo('acme/demo', 'demo'), false, '裸名不在这里兜底（候选范围在 pickRepoRef）');
  assert.equal(sameRepo('acme/demo', 'acme/other'), false);
  assert.equal(sameRepo('', ''), false);
  assert.equal(sameRepo(null, 'acme/demo'), false);
  assert.equal(sameRepo('acme/demo', undefined), false);
});

test('pickRepoRef 整串优先：命中整串时不再看裸名候选', () => {
  const selected = pickRepoRef(['acme/demo', 'other/demo'], 'acme/demo');
  assert.deepEqual(selected, { selected: 'acme/demo', ambiguous: [] });
  assert.deepEqual(pickRepoRef(['acme/demo', 'other/demo'], 'ACME/DEMO'), { selected: 'acme/demo', ambiguous: [] });
  assert.deepEqual(pickRepoRef(['org/group/repo', 'org/group/repo2'], ' org/group/repo '), {
    selected: 'org/group/repo',
    ambiguous: [],
  });
});

test('pickRepoRef 裸名兜底：候选内唯一同名才命中，返回候选原串', () => {
  assert.deepEqual(pickRepoRef(['acme/demo', 'acme/other'], 'demo'), { selected: 'acme/demo', ambiguous: [] });
  assert.deepEqual(pickRepoRef(['org/group/repo', 'x/other'], 'REPO'), { selected: 'org/group/repo', ambiguous: [] });
  assert.deepEqual(pickRepoRef(['org/group/repo', 'x/other'], 'org/group/repo'), {
    selected: 'org/group/repo',
    ambiguous: [],
  });
});

test('pickRepoRef 跨组同名 → selected:null 且列出全部同名候选（不猜“第一个”）', () => {
  const result = pickRepoRef(['org2/demo', 'org1/demo'], 'demo');
  assert.deepEqual(result, { selected: null, ambiguous: ['org2/demo', 'org1/demo'] });

  const three = pickRepoRef(['a/x/demo', 'b/y/demo', 'c/z/other'], 'demo');
  assert.deepEqual(three, { selected: null, ambiguous: ['a/x/demo', 'b/y/demo'] });
});

test('pickRepoRef 无命中 / 输入带斜杠 / 空显式值都不做跨仓库兜底', () => {
  assert.deepEqual(pickRepoRef(['acme/demo'], 'other'), { selected: null, ambiguous: [] });
  assert.deepEqual(pickRepoRef(['acme/demo'], 'group/demo'), { selected: null, ambiguous: [] }, '带斜杠即整串语义');
  assert.deepEqual(pickRepoRef(['acme/demo'], ''), { selected: null, ambiguous: [] });
  assert.deepEqual(pickRepoRef(['acme/demo'], null), { selected: null, ambiguous: [] });
  assert.deepEqual(pickRepoRef([], 'demo'), { selected: null, ambiguous: [] });
  assert.deepEqual(pickRepoRef(null, 'demo'), { selected: null, ambiguous: [] }, '候选不可得时不得编造候选');
});

test('pickRepoRef 候选去重与非法候选：大小写重复只算一个，非法引用不参与匹配', () => {
  assert.deepEqual(pickRepoRef(['Org/Demo', 'org/demo'], 'demo'), { selected: 'Org/Demo', ambiguous: [] });
  assert.deepEqual(pickRepoRef(['a/demo/x/y', 'acme/demo'], 'demo'), { selected: 'acme/demo', ambiguous: [] });
  assert.deepEqual(pickRepoRef(['acme/demo#1', null, '  acme/other  '], 'demo'), { selected: null, ambiguous: [] });
});

test('零依赖纯函数：不 import、不 spawn、不读 IO、不读时钟（离线判词唯一的前提）', () => {
  const source = readFileSync(new URL('../src/repo-ref.mjs', import.meta.url), 'utf8');
  assert.ok(!/^\s*import\b/m.test(source), 'repo-ref 不得 import（它是被适配器与门禁共用的最底层）');
  for (const dependency of ['child_process', 'node:fs', 'node:os', 'node:path', 'node:process']) {
    assert.ok(!source.includes(dependency), `repo-ref 不得依赖 ${dependency}`);
  }
  assert.ok(!/\bDate\.now\b|\bnew Date\s*\(|\bMath\.random\b/.test(source), '判词不得依赖时钟或随机数');
  assert.ok(!/shell\s*:\s*true|\bexecSync\b|\bexecFile\b|\bspawn\b/.test(source), '零子进程');
});
