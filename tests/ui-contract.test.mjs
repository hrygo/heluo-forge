// r15 企业 IAM UI 的跨包契约（TECHNICAL §4.1/§10）。
//
// 浏览器半不经过打包器，两端各写一份常量，最容易悄悄漂移：改了一侧的端点、
// 忘了另一侧，页面就会 404 而单元测试全绿。这里把"必须逐字一致"的几处钉死：
//   1. 两个浏览器半都能被 Loader 装进页面（真执行，见 scripts/check-client-module.mjs）；
//   2. 分区 id/order 唯一且与设计表一致（无容器：`devops-readiness` 29 / `gitee` 50 / `devops` 60；
//      装容器：`forge-engineering` 30，DevOps/Gitee 各一个子条目 10/20）；
//   3. 挂载一律两段式 `slots.inject('settings.section', ...)`，name 逐字；
//   4. 客户端端点/请求头常量与各自 `src/http.mjs` 的导出逐字一致；
//   5. `?refresh=1` 只有一处拼法，且只在 devops 客户端（Gitee 分区不发探测请求）。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CLI_ROUTE_PATH, CLI_REQUEST_HEADER } from '../packages/forge-devops/src/http.mjs';
import { GITEE_CONFIG_ROUTE, GITEE_REQUEST_HEADER } from '../packages/forge-gitee/src/http.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const CLIENTS = ['packages/forge-gitee/client.js', 'packages/forge-devops/client.js'];

const EXPECTED_SECTIONS = [
  { id: 'devops-readiness', order: 29 },
  { id: 'gitee', order: 50 },
  { id: 'devops', order: 60 },
];

function loadClientModules() {
  const stdout = execFileSync(process.execPath, [join(root, 'scripts/check-client-module.mjs'), ...CLIENTS], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

test('两个浏览器半都能被 Loader 装载：导出 apply/inject，注册 settings.section', () => {
  const report = loadClientModules();
  assert.equal(report.failed, 0, 'scripts/check-client-module.mjs 必须全部通过');
  assert.equal(report.checked.length, 2);
  for (const entry of report.checked) {
    assert.match(entry.id, /^@heluo\/forge-(gitee|devops)$/u, `${entry.file} 的 loader id 不对`);
    assert.ok(entry.sections.length >= 1, `${entry.file} 没有注册任何分区`);
    for (const section of entry.sections) {
      assert.equal(section.name, 'settings.section', `${entry.file} 必须注册到 settings.section`);
      assert.equal(section.component, true, `${section.id} 必须带组件`);
    }
  }
});

test('分区 id 与 order 与设计表逐字一致，且互不重复（AC-13）', () => {
  const report = loadClientModules();
  const sections = report.checked.flatMap((entry) => entry.sections.map((section) => ({ ...section, file: entry.file })));
  assert.deepEqual(
    sections.map(({ id, order }) => ({ id, order })).sort((left, right) => left.order - right.order),
    EXPECTED_SECTIONS,
  );
  assert.equal(new Set(sections.map((section) => section.id)).size, sections.length, '分区 id 不得重复');
  assert.equal(new Set(sections.map((section) => section.order)).size, sections.length, '分区 order 不得重复');
  // 企业身份分区属于 forge-iam（order 30），r15 不得新增第二个身份入口。
  assert.equal(sections.some((section) => section.id === 'forge-iam'), false, '不得注册第二个企业身份分区');
});

test('挂载一律两段式 slots.inject，不在 apply 里直接 register（AC-16）', () => {
  for (const file of CLIENTS) {
    const source = read(file);
    const injectsSection = source.includes("ctx.slots.inject('settings.section'") || source.includes('ctx.slots.inject(SECTION_SLOT');
    assert.ok(injectsSection, `${file} 必须两段式挂载 settings.section`);
    if (source.includes('ctx.slots.inject(SECTION_SLOT')) {
      assert.ok(source.includes("const SECTION_SLOT = 'settings.section';"), `${file} 的 SECTION_SLOT 必须逐字为 settings.section`);
    }
    assert.ok(
      source.includes("name: 'settings.section'") || source.includes('name: SECTION_SLOT'),
      `${file} 的注册项 name 必须逐字为 settings.section`,
    );
    assert.equal(/ctx\.slots\.register\(\s*['"]/u.test(source), false, `${file} 不得直接 register 槽位名`);
    assert.equal(/id:\s*['"]forge-iam['"]/u.test(source), false, `${file} 不得注册第二个企业身份入口`);
  }
});

test('客户端端点与请求头常量与各自 src/http.mjs 逐字一致（AC-11）', () => {
  const gitee = read('packages/forge-gitee/client.js');
  assert.ok(gitee.includes(`const CLI_ENDPOINT = '${GITEE_CONFIG_ROUTE}';`), 'Gitee 客户端端点必须等于 GITEE_CONFIG_ROUTE');
  assert.ok(gitee.includes(`const REQUEST_HEADER = '${GITEE_REQUEST_HEADER}';`), 'Gitee 客户端请求头必须等于 GITEE_REQUEST_HEADER');

  const devops = read('packages/forge-devops/client.js');
  assert.ok(devops.includes(`const CLI_ENDPOINT = '${CLI_ROUTE_PATH}';`), 'DevOps 客户端端点必须等于 CLI_ROUTE_PATH');
  assert.ok(devops.includes(`'${CLI_REQUEST_HEADER}': '1'`), 'DevOps 客户端请求头必须等于 CLI_REQUEST_HEADER');
});

test('?refresh=1 只有一处拼法，且只在 devops 客户端（AC-10）', () => {
  const devops = read('packages/forge-devops/client.js');
  const occurrences = devops.split('`${CLI_ENDPOINT}?refresh=1`').length - 1;
  assert.equal(occurrences, 1, '?refresh=1 只能由 refreshUrl() 一处拼出');
  assert.ok(devops.includes('const refreshUrl = () =>'), 'refreshUrl 必须是唯一入口');

  const gitee = read('packages/forge-gitee/client.js');
  assert.equal(gitee.includes('`${CLI_ENDPOINT}?refresh=1`'), false, 'Gitee 分区不得发起任何探测请求');
});

test('Gitee 客户端不读 package.json（版本由服务端快照投影）', () => {
  for (const file of CLIENTS) {
    const source = read(file);
    // 只查"真的去读文件"的写法：注释里提到 package.json 不算。
    assert.equal(/require\(\s*['"][^'"]*package\.json/u.test(source), false, `${file} 不得在浏览器半 require package.json`);
    assert.equal(/from\s+['"][^'"]*package\.json['"]/u.test(source), false, `${file} 不得在浏览器半 import package.json`);
    assert.equal(/readFileSync|node:fs/u.test(source), false, `${file} 不得在浏览器半访问文件系统`);
  }
});

// ---------------------------------------------------------------------------
// r16：就绪面板的跨层契约（AC-4/AC-6）。四层证据、来源类型、三层来源的键名
// 在 src/readiness.mjs 与浏览器半各写一份，改了一侧忘了另一侧，页面就会把
// 枚举当未知渲染——所以这里逐字比对常量，而不是只看"有没有 readiness 字样"。
// ---------------------------------------------------------------------------

import {
  EVIDENCE_LAYERS,
  EVIDENCE_REASONS,
  EVIDENCE_STATES,
  READINESS_SOURCE_TYPES,
} from '../packages/forge-devops/src/readiness.mjs';

const EVIDENCE_STATE_KEYS = ['pass', 'fail', 'notRun'];

test('r16：客户端四层证据 / 来源类型 / 证据原因与 src/readiness.mjs 常量逐字一致', () => {
  const devops = read('packages/forge-devops/client.js');
  for (const layer of EVIDENCE_LAYERS) {
    assert.ok(devops.includes(`'readiness.evidence.layer.${layer}'`), `缺四层证据文案：${layer}`);
  }
  assert.deepEqual(EVIDENCE_LAYERS, ['file', 'executable', 'target', 'readonly'], '四层顺序是契约，不得重排');
  for (const sourceType of READINESS_SOURCE_TYPES) {
    assert.ok(devops.includes(`'readiness.check.sourceType.${sourceType}'`), `缺来源类型文案：${sourceType}`);
  }
  for (const reason of Object.values(EVIDENCE_REASONS)) {
    assert.ok(devops.includes(`'readiness.evidence.reason.${reason}'`), `缺证据原因文案：${reason}`);
  }
  for (const key of EVIDENCE_STATE_KEYS) {
    assert.ok(devops.includes(`'readiness.evidence.state.${key}'`), `缺证据状态文案：${key}`);
  }
  assert.deepEqual(Object.values(EVIDENCE_STATES), ['pass', 'fail', 'not-run'], '证据状态三值固定');
});

test('r16：三层来源键名两侧同源（AC-6）', () => {
  const devops = read('packages/forge-devops/client.js');
  for (const key of ['layers.title', 'layers.inherited', 'layers.override', 'layers.effective', 'layers.origin']) {
    assert.ok(devops.includes(`'readiness.${key}'`), `缺三层来源文案：${key}`);
  }
  const access = read('packages/forge-devops/src/cli-access.mjs');
  assert.ok(access.includes('layers: projectLayers(row)'), 'DevOps 快照必须投影 layers 键名');
  assert.ok(access.includes('readAt:'), 'DevOps 快照必须带 readAt');
});

test('r16：Gitee 分区不发就绪探测，也不重复实现四项/四层（AC-4）', () => {
  const gitee = read('packages/forge-gitee/client.js');
  assert.equal(gitee.includes('readiness.evidence'), false, 'Gitee 分区不实现四层证据');
  assert.equal(gitee.includes('/api/forge-iam/view'), false, 'Gitee 分区不读企业身份');
  assert.equal(gitee.includes('检查 Gitee'), false, 'Gitee 分区没有自己的检查按钮');
});

// ---------------------------------------------------------------------------
// 研发容器子槽位（设计 §6.3）：容器在场时 devops/gitee 各注册一个条目并撤掉
// 自己的独立分区；容器缺席（ADR-0012 单包安装）时保留原有分区。检查器把
// `heluo.engineering.tab` 的两种时序各跑一遍，分别给出 sections / tabs。
// ---------------------------------------------------------------------------

const CONTAINER_CLIENTS = ['packages/forge-gitee/client.js', 'packages/forge-devops/client.js', 'packages/forge-enterprise/client.js'];

let cachedContainerReport;
/** 检查器要真跑 `apply`（每个 client 四种声明时序），只跑一次并复用结果。 */
function loadContainerReport() {
  if (cachedContainerReport !== undefined) return cachedContainerReport;
  const stdout = execFileSync(process.execPath, [join(root, 'scripts/check-client-module.mjs'), ...CONTAINER_CLIENTS], {
    cwd: root,
    encoding: 'utf8',
  });
  cachedContainerReport = JSON.parse(stdout);
  return cachedContainerReport;
}

test('容器在场时：devops 与 gitee 只注册容器条目，不再各占侧栏分区', () => {
  const report = loadContainerReport();
  assert.equal(report.failed, 0, 'scripts/check-client-module.mjs 必须全部通过');
  const byId = new Map(report.checked.map((entry) => [entry.id, entry]));
  const gitee = byId.get('@heluo/forge-gitee');
  const devops = byId.get('@heluo/forge-devops');
  assert.deepEqual(gitee.containerSections, [], 'Gitee 注册容器条目后不得再注册 settings.section');
  assert.deepEqual(devops.containerSections, [], 'DevOps 注册容器条目后不得再注册 settings.section');
  assert.deepEqual(gitee.tabs.map(({ id, order }) => ({ id, order })), [{ id: 'gitee', order: 20 }]);
  // 就绪检查与配置面板合并为一个容器条目：两个独立分区收进同一个 order 10。
  assert.deepEqual(devops.tabs.map(({ id, order }) => ({ id, order })), [{ id: 'devops', order: 10 }]);
  for (const tab of [...gitee.tabs, ...devops.tabs]) {
    assert.equal(tab.name, 'heluo.engineering.tab');
    assert.ok(tab.component, `${tab.id} 容器条目必须带组件`);
  }
});

test('容器后到：独立分区先撤再挂容器条目，侧栏只留一个入口', () => {
  const report = loadContainerReport();
  assert.equal(report.failed, 0, 'scripts/check-client-module.mjs 必须全部通过');
  assert.equal(report.failed, 0, 'scripts/check-client-module.mjs 必须全部通过');
  const byId = new Map(report.checked.map((entry) => [entry.id, entry]));
  for (const id of ['@heluo/forge-gitee', '@heluo/forge-devops']) {
    const entry = byId.get(id);
    const lateSections = entry.late.filter((item) => item.name === 'settings.section');
    const lateTabs = entry.late.filter((item) => item.name === 'heluo.engineering.tab');
    assert.deepEqual(lateSections, [], `${id} 容器晚于 apply 声明时不得残留独立分区（否则侧栏两份入口）`);
    assert.equal(lateTabs.length, 1, `${id} 容器晚到时应正好注册一个容器条目`);
  }
});

test('容器运行期塌陷：独立分区补回来，入口不会整块消失', () => {
  const report = loadContainerReport();
  assert.equal(report.failed, 0, 'scripts/check-client-module.mjs 必须全部通过');
  const byId = new Map(report.checked.map((entry) => [entry.id, entry]));
  for (const id of ['@heluo/forge-gitee', '@heluo/forge-devops']) {
    const entry = byId.get(id);
    const sections = entry.collapse.filter((item) => item.name === 'settings.section');
    const tabs = entry.collapse.filter((item) => item.name === 'heluo.engineering.tab');
    assert.deepEqual(tabs, [], `${id} 容器塌陷后容器条目必须撤掉`);
    assert.ok(sections.length > 0, `${id} 容器塌陷后必须把独立分区补回来`);
  }
});

test('容器缺席时：devops/gitee 保留独立分区与 order（ADR-0012 单包可用）', () => {
  const report = loadContainerReport();
  const byId = new Map(report.checked.map((entry) => [entry.id, entry]));
  const sectionsOf = (id) => byId.get(id).sections.map(({ id: sectionId, order }) => ({ id: sectionId, order }));
  assert.deepEqual(sectionsOf('@heluo/forge-gitee'), [{ id: 'gitee', order: 50 }]);
  assert.deepEqual(sectionsOf('@heluo/forge-devops'), [
    { id: 'devops', order: 60 },
    { id: 'devops-readiness', order: 29 },
  ]);
});

test('容器塌陷后再回来：声明 epoch 重跑回调，仍只有一个容器条目', () => {
  const report = loadContainerReport();
  assert.equal(report.failed, 0, 'scripts/check-client-module.mjs 必须全部通过');
  const byId = new Map(report.checked.map((entry) => [entry.id, entry]));
  for (const id of ['@heluo/forge-gitee', '@heluo/forge-devops']) {
    const entry = byId.get(id);
    const tabs = entry.redeclare.filter((item) => item.name === 'heluo.engineering.tab');
    const sections = entry.redeclare.filter((item) => item.name === 'settings.section');
    assert.equal(tabs.length, 1, `${id} 容器回归后必须正好一个容器条目`);
    assert.deepEqual(sections, [], `${id} 容器回归后不得残留独立分区`);
  }
});

test('跨客户端分区序唯一：企业账号 -10 / 容器 30 / Gitee 50 / DevOps 60 与子条目 10/20', () => {
  // 用检查器真跑出来的注册项，不解析源码文本：`order` 在容器里是常量（`SECTION_ORDER`），
  // 文本正则会被常量与排序比较器误导。企业账号不走检查器（它不注入 locale），单点读一次。
  const report = loadContainerReport();
  const collected = [];
  for (const entry of report.checked) {
    for (const item of entry.sections) collected.push({ slot: 'settings.section', id: item.id, order: item.order, file: entry.file });
    for (const item of entry.tabs) collected.push({ slot: 'heluo.engineering.tab', id: item.id, order: item.order, file: entry.file });
  }
  const iamOrder = /id: 'forge-iam',\s*\n\s*order: (-?\d+)/u.exec(read('packages/forge-iam/client.js'));
  assert.ok(iamOrder !== null, '企业账号分区必须显式声明 order');
  collected.push({ slot: 'settings.section', id: 'forge-iam', order: Number(iamOrder[1]), file: 'packages/forge-iam/client.js' });

  const bySlot = new Map();
  for (const row of collected) {
    if (!bySlot.has(row.slot)) bySlot.set(row.slot, []);
    bySlot.get(row.slot).push(row);
  }
  assert.deepEqual([...bySlot.keys()].sort(), ['heluo.engineering.tab', 'settings.section']);
  for (const [slot, rows] of bySlot) {
    const values = rows.map(({ order }) => order);
    assert.equal(new Set(values).size, values.length, `${slot} 的分区 order 撞号：${JSON.stringify(rows)}`);
  }
  const sectionOrders = bySlot.get('settings.section').map(({ order }) => order);
  assert.ok(sectionOrders.includes(-10), `企业账号必须排最前（-10），实际 ${JSON.stringify(sectionOrders)}`);
  assert.ok(sectionOrders.includes(30), `研发容器必须是 settings.section 的 30，实际 ${JSON.stringify(sectionOrders)}`);
});

test('容器自身：forge-engineering（order 30）声明子槽位并注册同名图标', () => {
  const report = loadContainerReport();
  const enterprise = report.checked.find((entry) => entry.id === '@heluo/forge-enterprise');
  assert.ok(enterprise, '客户浏览器半必须能被装载');
  assert.equal(enterprise.container, true, '容器必须在 children 里声明 heluo.engineering.tab');
  assert.deepEqual(enterprise.sections.map(({ id, order }) => ({ id, order })), [{ id: 'forge-engineering', order: 30 }]);
  assert.deepEqual(enterprise.tabs, [], '容器不得往自己的子槽位注册条目');
  assert.deepEqual(enterprise.icons, ['forge-engineering'], '图标条目 id 必须与分区 id 一致');
});
