/**
 * 跨面字段规则等值（R2-1 的常驻门禁 · r5 收窄后口径）。
 *
 * 背景：`client.js` 是浏览器侧半（`__ModuleLoader__` IIFE，不进 node 模块图），**不能 import
 * `src/*.mjs`**，所以页面那份 `validateField` 必然是服务端规则的内联副本。副本与服务端的边界
 * 只要差一个字符，界面就退化成「失焦放行、点保存才 422」——R2-1 正是如此：页面
 * `OWNER_PATTERN` 无上界、服务端 `{0,38}`，40 字符的组织名在 blur 时毫无提示。
 *
 * r5 之后页面只可编辑三键（`PAGE_FIELDS`：dop 入口 / gh 入口 / 超时），隐藏三键
 * （dopEndpoint / ghOwner / sourceType）不进 DOM、不进 staged、不发送。于是「等值」拆成两条
 * 不变量，缺一条都会让收窄变成事故：
 *   1. **三键等值**：页面规则与服务端保存期判定逐条同判（漂移只有 page-loose / page-strict 两种）；
 *   2. **隐藏三键不对称**：页面恒 null（没有规则、也不渲染），服务端**仍严**——
 *      页面收窄不是服务端放宽；删页面规则时顺手删掉服务端边界，只会让保存把非法值写进配置。
 *
 * r8 又把「三键等值」收窄了一次：入口路径在**页面侧**只剩长度上界，后缀/包装脚本形态不再拦截
 * （原来 `.cmd`/`.bat`/`.ps1` 在 blur 就被拒，服务端现在一律可存）。所以矩阵里不再有「后缀差异」
 * 这一类：形态样本两侧必须同判，页面也不再拥有任何后缀词表——那条规则回到服务端唯一真源
 * `src/entry-form.mjs`，页面复制第二份就是分叉的开始（AC-4/AC-7）。
 *
 * 做法：从**已交付的** `client.js` 源码里切出那份规则（不重写、不复述），与服务端
 * **保存期判定**（路径类字段 → `buildCliPatch`，其余 → `validateConfigField`）跑同一张矩阵。
 *
 * 判定口径（与 QA 探针 `qa-r3-rule-parity.mjs` 一致，避免两套判据各自漂移）：
 *   - 路径类的存在性 / 是否目录 / 执行位是**保存期职责**（`fs: null` 只比格式规则），不算漂移；
 *   - 漂移只有两种：页面放行而服务端因格式规则拒绝（page-loose），页面拦住而服务端接受（page-strict）。
 *   - r8 后格式规则只剩长度一条：矩阵里所有形态样本两侧同判，`delegated` 必须为空（见最后一条用例）。
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

/** 页面可编辑面：与 client.js 同源，本门禁据此把矩阵拆成「页面判 / 页面不判」两段。 */
// eslint-disable-next-line no-new-func
const PAGE_FIELDS = new Function(`${sliceClientConst('PAGE_FIELDS')}\nreturn PAGE_FIELDS;`)();

// eslint-disable-next-line no-new-func
const pageValidateField = new Function(
  [
    sliceClientConst('MAX_PATH_LENGTH'),
    sliceClientConst('TIMEOUT_MIN'),
    sliceClientConst('TIMEOUT_MAX'),
    sliceClientConst('normalize'),
    sliceClientFunction('function validateField('),
    'return validateField;',
  ].join('\n'),
)();

/**
 * 4096 / 4097 字符的入口路径：长度上界的合法与越界两侧（与 MAX_PATH_LENGTH 等值）。
 * `.exe` 只是让样本看起来像真实入口；r8 后后缀**不承担任何规则含义**（换成 `.cmd` 或裸名同判）。
 */
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
    // fs: null → 跳过存在性 / 目录 / 执行位，只留格式规则（r8 后入口只剩长度上界）。
    const built = buildCliPatch({ current: {}, patch: { [field]: value }, platform: 'win32', fs: null });
    return built.ok === true ? { ok: true, message: '' } : { ok: false, message: built.errors?.[field] ?? '' };
  }
  const result = validateConfigField(field, value);
  return result.ok === true ? { ok: true, message: '' } : { ok: false, message: result.message };
}

/**
 * 取值矩阵：六个字段的合法与非法两侧（服务端契约面，一条都不能少）。
 * 页面只为其中三键背书——另三键由「页面恒 null / 服务端仍严」那条用例守着。
 */
const MATRIX = [
  ['dopBin', 'C:\\tools\\dop.exe', 'win32 原生入口'],
  ['dopBin', 'C:\\tools\\dop.cmd', 'npm 生成的 .cmd shim（r8 起可存）'],
  ['dopBin', 'C:\\tools\\dop.bat', '.bat 包装脚本'],
  ['dopBin', 'C:\\tools\\dop.ps1', '.ps1 脚本'],
  ['dopBin', 'C:\\npm-global\\dop', 'npm 生成的无后缀裸名 shim'],
  ['dopBin', '/usr/local/bin/dop', 'POSIX 绝对路径（win32 上无后缀）'],
  ['dopBin', 'C:\\tools\\DOP.EXE', '大写后缀（win32 折叠后同一形态）'],
  ['dopBin', 'C:\\tools\\missing.exe', '形态合法、存在性由保存期判'],
  ['dopBin', PATH_AT_LIMIT, '4096 字符（长度上界内）'],
  ['dopBin', PATH_OVER_LIMIT, '4097 字符（超长度上界）'],
  ['ghBin', 'gh', '裸命令名（默认值形态）'],
  ['ghBin', 'C:\\tools\\gh.cmd', 'npm shim（gh 与 dop 同口径）'],
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
  ['sourceType', 'ENTERPRISE', '大写（服务端 lowercases 后接受）'],
  ['sourceType', 'prod', '非法取值'],
  ['timeoutMs', '1000', '下界'],
  ['timeoutMs', '600000', '上界'],
  ['timeoutMs', '999', '低于下界'],
  ['timeoutMs', '600001', '高于上界'],
  ['timeoutMs', '12.5', '非整数'],
];

test('矩阵覆盖全部六个字段，且三键在页面直面、另三键在服务端直面', () => {
  const covered = new Set(MATRIX.map(([field]) => field));
  assert.deepEqual([...covered].sort(), [...CLI_FIELDS].sort(), `矩阵没有覆盖全部字段：${[...covered].join(',')}`);
  // 页面可编辑面是服务端字段表的真子集，且恰好三键（收窄在页面，词表不动）。
  assert.deepEqual(PAGE_FIELDS, ['dopBin', 'ghBin', 'timeoutMs'], `页面只收敛到三键，实际 ${PAGE_FIELDS.join(',')}`);
  for (const field of PAGE_FIELDS) {
    assert.ok(CLI_FIELDS.includes(field), `PAGE_FIELDS 里的 ${field} 不在服务端 CLI_FIELDS（页面会提交服务端不认的键）`);
  }
  const hidden = CLI_FIELDS.filter((field) => !PAGE_FIELDS.includes(field));
  assert.deepEqual(hidden.sort(), ['dopEndpoint', 'ghOwner', 'sourceType'], `隐藏三键必须正好是这三个，实际 ${hidden.join(',')}`);
});

test('隐藏三键：页面恒 null（无规则、不渲染），服务端仍逐条拒收（收窄 ≠ 放宽）', () => {
  const hiddenRows = MATRIX.filter(([field]) => !PAGE_FIELDS.includes(field));
  assert.ok(hiddenRows.length >= 10, `矩阵必须覆盖隐藏三键的边界样本（实际 ${hiddenRows.length} 条）`);
  // 页面连这些字段的输入框都没有：留着页面规则就是维护一份没人能触发的判定。
  for (const [field, raw, label] of hiddenRows) {
    assert.equal(pageValidateField(field, String(raw)), null, `页面不得为隐藏字段 ${field} 保留规则：${label}`);
  }
  // 服务端的边界一条都不能跟着消失（这些正是「删页面规则时顺手删掉」的高危项）。
  const serverCases = [
    ['ghOwner', 'hrygo', true, '正常组织名'],
    ['ghOwner', 'a'.repeat(39), true, '39 字符上界内'],
    ['ghOwner', 'a'.repeat(40), false, '40 字符越界'],
    ['ghOwner', 'a'.repeat(45), false, '45 字符越界'],
    ['ghOwner', '-bad', false, '首字符连字符'],
    ['ghOwner', 'has_underscore', false, '含下划线'],
    ['dopEndpoint', 'https://devops.corp.example/api', true, '正常地址'],
    ['dopEndpoint', 'http://devops.corp.example:8080/api', true, '带端口'],
    ['dopEndpoint', 'devops.corp.example/api', false, '缺协议'],
    ['dopEndpoint', 'ftp://devops.corp.example', false, '非 http 协议'],
    ['sourceType', 'mock', true, '合法取值'],
    ['sourceType', 'prod', false, '非法取值'],
  ];
  for (const [field, value, expected, label] of serverCases) {
    const verdict = serverVerdict(field, value);
    assert.equal(verdict.ok, expected, `服务端 ${field}=${label} 应${expected ? '接受' : '拒收'}：${verdict.message}`);
  }
});

test('同类边界：路径长度 4096 放行、4097 失焦即拒（与服务端同判）', () => {
  // 同一类缺陷的第二处：服务端 `MAX_PATH_LENGTH` 有上界、页面原来没有，粘进整段日志照样要等 422。
  assert.equal(pageValidateField('dopBin', PATH_AT_LIMIT), null, '页面必须放行 4096 字符的路径');
  assert.equal(pageValidateField('dopBin', PATH_OVER_LIMIT), 'error.pathLength', '页面必须在 blur 时拒掉超长路径');
  assert.equal(buildCliPatch({ current: {}, patch: { dopBin: PATH_AT_LIMIT }, platform: 'win32', fs: null }).ok, true);
  assert.equal(buildCliPatch({ current: {}, patch: { dopBin: PATH_OVER_LIMIT }, platform: 'win32', fs: null }).ok, false);
});

test('页面入口规则只剩长度：后缀/包装脚本形态一律放行，且页面无后缀词表（AC-7）', () => {
  // r8 的核心回归：这七种形态过去有三种在 blur 就被拒（`.cmd`/`.bat`/`.ps1`），
  // 用户只能「先猜后缀、报错、再回来改」。现在页面只判长度——形态与可执行性归服务端保存期
  // （唯一真源 `src/entry-form.mjs`），页面不复制第二份规则（AC-4）。
  const SHAPES = [
    'C:\\tools\\dop.exe',
    'C:\\tools\\dop.cmd',
    'C:\\tools\\dop.bat',
    'C:\\tools\\dop.ps1',
    'C:\\npm-global\\dop',
    'C:\\tools\\DOP.EXE',
    'D:\\tools\\dop.vbs',
  ];
  for (const value of SHAPES) {
    assert.equal(pageValidateField('dopBin', value), null, `页面不得再按后缀拦入口路径：${value}`);
    const server = serverVerdict('dopBin', value);
    assert.equal(server.ok, true, `服务端保存期也不得按后缀拒收（${value}）：${server.message}`);
  }
  // 拦住的只有长度：这条边界不能随「删后缀」一起被删掉（R2-1 的同类缺陷）。
  assert.equal(pageValidateField('dopBin', PATH_OVER_LIMIT), 'error.pathLength', '超长度仍要在 blur 就拒');
  // 页面规则与源码里都不得残留后缀判定，也不得再引用已删除的 i18n 键。
  assert.ok(!/WRAPPER_PATTERN|wrapperScript/u.test(String(pageValidateField)), '页面 validateField 不得残留后缀判定');
  assert.ok(!/WRAPPER_PATTERN|wrapperScript/u.test(SOURCE), 'client.js 不得残留 WRAPPER_PATTERN / error.wrapperScript');
  // i18n 成对删除：悬空键会让界面露出裸键；留下的那条入口错误句仍必须 zh/en 各一条。
  const count = (key) => [...SOURCE.matchAll(new RegExp(`'${key}':\\s*'`, 'gu'))].length;
  assert.equal(count('error.wrapperScript'), 0, 'error.wrapperScript 必须随后缀拦截一起成对删除');
  assert.equal(count('error.pathLength'), 2, 'error.pathLength 是入口字段唯一的错误句，zh/en 各一条');
});

test('页面三键规则与服务端保存期判定在矩阵上等值（无 page-loose / page-strict 漂移）', () => {
  const drift = [];
  const delegated = [];
  for (const [field, raw, label] of MATRIX) {
    // 隐藏三键走上面那条不对称用例：页面没有规则，等值比较在这里没有意义。
    if (!PAGE_FIELDS.includes(field)) continue;
    const value = String(raw);
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
  // r8：格式规则两侧完全同判，不再有「页面放行 / 服务端按后缀拒收」这一类委托。
  // 存在性 / 目录 / 执行位仍是保存期职责，但它们在 fs:null 下不参与判定，本矩阵看不到。
  assert.deepEqual(
    delegated,
    [],
    'r8 去掉后缀门槛后：形态样本两侧必须同判；再出现「页面放行、服务端按格式拒收」就是新漂移',
  );
});

test('双语文案与规则同源：超时说明与错误句都写清 1000–600000，入口指引不再要求找 .exe', () => {
  // 文案是用户唯一可见的规则说明：边界只写在代码里，用户仍会填 999 或 12.5。
  for (const [key, what] of [
    ['field.timeoutMs.hint', '说明'],
    ['error.timeout', '错误句'],
  ]) {
    const hits = [...SOURCE.matchAll(new RegExp(`'${key}':\\s*'([^']+)'`, 'gu'))].map((hit) => hit[1]);
    assert.equal(hits.length, 2, `缺文案 ${key}（应为 zh/en 各一条，实际 ${hits.length} 条）`);
    for (const text of hits) {
      assert.ok(text.includes('1000'), `${key} 的${what}必须写明 1000 下界，否则用户无法自查：${text}`);
      assert.ok(text.includes('600000'), `${key} 的${what}必须写明 600000 上界，否则用户无法自查：${text}`);
    }
  }
  // 「去掉 .exe」只动用户可见文案：指引句按字段插值工具名，且不再让用户去挑 .exe 文件。
  const helps = [...SOURCE.matchAll(/'entry\.hint\.help':\s*'([^']+)'/gu)].map((hit) => hit[1]);
  assert.equal(helps.length, 2, `缺文案 entry.hint.help（应为 zh/en 各一条，实际 ${helps.length} 条）`);
  for (const text of helps) {
    assert.ok(text.includes('{tool}'), `指引句必须按字段插值工具名（dop 卡不能写成 gh）：${text}`);
    assert.ok(!/\.exe/u.test(text), `指引句不得再要求用户找 .exe 文件：${text}`);
  }
});
