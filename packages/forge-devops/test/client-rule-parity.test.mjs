/**
 * 跨面字段规则等值（R2-1 的常驻门禁）。
 *
 * 背景：`client.js` 是浏览器侧半（`__ModuleLoader__` IIFE，不进 node 模块图），**不能 import
 * `src/*.mjs`**，所以页面那份 `validateField` 必然是服务端规则的内联副本。副本与服务端的边界
 * 只要差一个字符，界面就退化成「失焦放行、点保存才 422」——R2-1 正是如此：页面
 * `OWNER_PATTERN` 无上界、服务端 `{0,38}`，40 字符的组织名在 blur 时毫无提示。
 *
 * 做法：从**已交付的** `client.js` 源码里切出那份规则（不重写、不复述），与服务端
 * **保存期判定**（路径类字段 → `buildCliPatch`，其余 → `validateConfigField`）跑同一张矩阵，
 * 逐条比对方向。任何一侧改边界都会先红在这里；`ghOwner` 的 39/40/45 是边界三连，
 * 另有显式断言钉住 R2-1 的两个端点（39 合法 / 40 非法）。
 *
 * 判定口径（与 QA 探针 `qa-r3-rule-parity.mjs` 一致，避免两套判据各自漂移）：
 *   - 路径类的存在性 / 是否目录 / 执行位是**保存期职责**（`fs: null` 只比形态），不算漂移；
 *   - 漂移只有两种：页面放行而服务端因格式规则拒绝（page-loose），页面拦住而服务端接受（page-strict）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLI_FIELDS, buildCliPatch } from '../src/cli-config.mjs';
import { validateConfigField } from '../src/runtime-config.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'client.js');
const SOURCE = readFileSync(CLIENT_FILE, 'utf8');

/* ------------------------------------------------------------------------- *
 * 从已交付源码里「拆」出页面规则（不重写、不复述）                             *
 * ------------------------------------------------------------------------- */

/** 切出 `const NAME = …;` 的定义行。 */
function sliceClientConst(name) {
  const hit = new RegExp(`^\\s*const ${name} = .*?;\\s*$`, 'mu').exec(SOURCE);
  assert.ok(hit, `client.js 里找不到 const ${name}（页面规则被改名或删除，本门禁失效）`);
  return hit[0].trim();
}

/** 切出函数定义（按花括号配对截到闭合处）。 */
function sliceClientFunction(header) {
  const start = SOURCE.indexOf(header);
  assert.ok(start >= 0, `client.js 里找不到 ${header}（页面校验函数被改名或删除，本门禁失效）`);
  let depth = 0;
  for (let index = SOURCE.indexOf('{', start); index < SOURCE.length; index += 1) {
    const char = SOURCE[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, index + 1);
    }
  }
  throw new Error(`${header} 的花括号不配对`);
}

// eslint-disable-next-line no-new-func
const pageValidateField = new Function(
  [
    sliceClientConst('SOURCE_TYPES'),
    sliceClientConst('OWNER_PATTERN'),
    sliceClientConst('WRAPPER_PATTERN'),
    sliceClientConst('MAX_PATH_LENGTH'),
    sliceClientConst('TIMEOUT_MIN'),
    sliceClientConst('TIMEOUT_MAX'),
    sliceClientConst('normalize'),
    sliceClientFunction('function validateField('),
    'return validateField;',
  ].join('\n'),
)();

/** 4096 / 4097 字符的 `.exe` 路径：长度上界的合法与越界两侧（与 MAX_PATH_LENGTH 等值）。 */
const PATH_PREFIX = 'C:\\tools\\';
const pathOfLength = (length) => `${PATH_PREFIX}${'a'.repeat(length - PATH_PREFIX.length - '.exe'.length)}.exe`;
const PATH_AT_LIMIT = pathOfLength(4096);
const PATH_OVER_LIMIT = pathOfLength(4097);

/* ------------------------------------------------------------------------- *
 * 服务端保存期判定：按字段形状选面（与 http 保存路径同源）                     *
 * ------------------------------------------------------------------------- */

const PATH_FIELDS = new Set(['dopBin', 'ghBin']);
/** 已声明的保存期职责：不是格式规则，页面不判不算漂移。 */
const DELEGATED_REASON = /找不到这个文件|这是目录|不是可直接执行的文件/u;

function serverVerdict(field, value) {
  if (PATH_FIELDS.has(field)) {
    // fs: null → 跳过存在性 / 目录 / 执行位，只留形态判定（包装脚本、Win32 后缀）。
    const built = buildCliPatch({ current: {}, patch: { [field]: value }, platform: 'win32', fs: null });
    return built.ok === true ? { ok: true, message: '' } : { ok: false, message: built.errors?.[field] ?? '' };
  }
  const result = validateConfigField(field, value);
  return result.ok === true ? { ok: true, message: '' } : { ok: false, message: result.message };
}

/** sourceType 在页面上是两项分段控件，可达输入域只有两个小写值。 */
function reachableValue(field, value) {
  return field === 'sourceType' ? String(value).toLowerCase() : value;
}

/** 取值矩阵：六个字段的合法与非法两侧，ghOwner 覆盖 39/40/45 边界三连。 */
const MATRIX = [
  ['dopBin', 'C:\\tools\\dop.exe', 'win32 正常 .exe'],
  ['dopBin', 'C:\\tools\\dop.cmd', '包装脚本'],
  ['dopBin', 'C:\\tools\\dop.bat', '包装脚本'],
  ['dopBin', '/usr/local/bin/dop', 'win32 上无 .exe 后缀'],
  ['dopBin', 'C:\\tools\\missing.exe', '只查存在性的形态'],
  ['dopBin', PATH_AT_LIMIT, '4096 字符（长度上界内）'],
  ['dopBin', PATH_OVER_LIMIT, '4097 字符（超长度上界）'],
  ['ghBin', 'gh', '裸命令名（默认值形态）'],
  ['ghBin', 'C:\\tools\\gh.ps1', '包装脚本'],
  ['dopEndpoint', 'https://devops.corp.example/api', '正常地址'],
  ['dopEndpoint', 'http://devops.corp.example:8080/api', '带端口'],
  ['dopEndpoint', 'devops.corp.example/api', '缺协议'],
  ['dopEndpoint', 'ftp://devops.corp.example', '非 http 协议'],
  ['ghOwner', 'hrygo', '正常组织名'],
  ['ghOwner', 'a'.repeat(39), '39 字符（上界内）'],
  ['ghOwner', 'a'.repeat(40), '40 字符（越界）'],
  ['ghOwner', 'a'.repeat(45), '45 字符（越界）'],
  ['ghOwner', '-bad', '首字符是连字符'],
  ['ghOwner', 'has_underscore', '含下划线'],
  ['sourceType', 'mock', '合法'],
  ['sourceType', 'ENTERPRISE', '大写（分段控件不可达，按可达域比较）'],
  ['sourceType', 'prod', '非法取值'],
  ['timeoutMs', '1000', '下界'],
  ['timeoutMs', '600000', '上界'],
  ['timeoutMs', '999', '低于下界'],
  ['timeoutMs', '600001', '高于上界'],
  ['timeoutMs', '12.5', '非整数'],
];

test('矩阵覆盖全部六个字段（有人缩小矩阵也先红）', () => {
  const covered = new Set(MATRIX.map(([field]) => field));
  assert.deepEqual([...covered].sort(), [...CLI_FIELDS].sort(), `矩阵没有覆盖全部字段：${[...covered].join(',')}`);
});

test('R2-1 边界：ghOwner 39 字符放行、40 字符失焦即拒（页面与服务端同判）', () => {
  assert.equal(pageValidateField('ghOwner', 'a'.repeat(39)), null, '页面必须放行 39 字符（GitHub 上限）');
  assert.equal(pageValidateField('ghOwner', 'a'.repeat(40)), 'error.owner', '页面必须在 blur 时拒掉 40 字符，不能留到保存');
  assert.equal(validateConfigField('ghOwner', 'a'.repeat(39)).ok, true, '服务端必须接受 39 字符');
  assert.equal(validateConfigField('ghOwner', 'a'.repeat(40)).ok, false, '服务端必须拒绝 40 字符');
});

test('同类边界：路径长度 4096 放行、4097 失焦即拒（与服务端同判）', () => {
  // 同一类缺陷的第二处：服务端 `MAX_PATH_LENGTH` 有上界、页面原来没有，粘进整段日志照样要等 422。
  assert.equal(pageValidateField('dopBin', PATH_AT_LIMIT), null, '页面必须放行 4096 字符的路径');
  assert.equal(pageValidateField('dopBin', PATH_OVER_LIMIT), 'error.pathLength', '页面必须在 blur 时拒掉超长路径');
  assert.equal(buildCliPatch({ current: {}, patch: { dopBin: PATH_AT_LIMIT }, platform: 'win32', fs: null }).ok, true);
  assert.equal(buildCliPatch({ current: {}, patch: { dopBin: PATH_OVER_LIMIT }, platform: 'win32', fs: null }).ok, false);
});

test('页面字段规则与服务端保存期判定在矩阵上等值（无 page-loose / page-strict 漂移）', () => {
  const drift = [];
  const delegated = [];
  for (const [field, raw, label] of MATRIX) {
    const value = reachableValue(field, raw);
    const pageKey = pageValidateField(field, value);
    const server = serverVerdict(field, value);
    const pageOk = pageKey === null;
    const serverOk = server.ok === true;
    if (pageOk === serverOk) continue;
    if (pageOk && PATH_FIELDS.has(field) && DELEGATED_REASON.test(server.message)) {
      // 页面放行、服务端因存在性/执行位拒绝：已声明的保存期职责（422 路径已由 T5 用例覆盖）。
      delegated.push(`${field} ${label}`);
      continue;
    }
    drift.push(
      `${pageOk ? 'page-loose' : 'page-strict'} ${field} ${label}：page=${pageOk ? 'ok' : pageKey} server=${serverOk ? 'ok' : server.message}`,
    );
  }
  assert.deepEqual(drift, [], `页面规则与服务端判定出现漂移（失焦无提示 / 保存才 422）：\n  ${drift.join('\n  ')}`);
  assert.deepEqual(
    delegated,
    // 只允许这一条：Win32 的「必须 .exe」依赖平台事实，浏览器半看不到平台，只能由服务端在保存时判。
    ['dopBin win32 上无 .exe 后缀'],
    '已声明的保存期委托只应有平台相关这一条，新出现的要按漂移处理',
  );
});

test('双语文案与规则同源：ghOwner 的说明与错误句都带上界（用户能自查）', () => {
  // 文案是用户唯一可见的规则说明：上界只写在正则里，用户仍会把 40 字符粘进来。
  for (const [key, expected, what] of [
    ['field.ghOwner.hint', 2, '说明'],
    ['error.owner', 2, '错误句'],
  ]) {
    const hits = [...SOURCE.matchAll(new RegExp(`'${key}':\\s*'([^']+)'`, 'gu'))].map((hit) => hit[1]);
    assert.equal(hits.length, expected, `缺文案 ${key}（应为 zh/en 各一条，实际 ${hits.length} 条）`);
    for (const text of hits) assert.match(text, /39/u, `${key} 的${what}必须写明 39 上界，否则用户无法自查：${text}`);
  }
});
