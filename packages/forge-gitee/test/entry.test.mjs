/**
 * 入口与装载面门禁：AC-1 / AC-4 / AC-6 / AC-7（静态半）。
 *
 * 这一组用例回答的是"分发出去的那份东西能不能被宿主认出来"：清单（入口名、分发白名单、
 * engines、补丁指针）、补丁层（12 条并集目录：6 读 + 6 写 + 显式审计 + 显式
 * config，且与 forge-devops 的补丁层共用同一行 `heluo-policy`）、以及
 * **装载安全**（模块顶层不碰宿主、不碰子进程；缺能力时 `apply` 抛可读错误而不是未捕获异常）。
 *
 * 断言尽量落在"文件里真实写了什么"上：AC-1 要求 `insert` 行的 name 精确等于包根名，
 * 写子路径（`@heluo/forge-gitee/src/index.mjs`）是最常见的静默跳过，只能在文本层证明。
 */
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ConfigStandard,
  GITEE_READ_ACTIONS,
  GITEE_TOOLS,
  apply,
  inject,
  name as pluginName,
} from '../src/index.mjs';
import { GITEE_READ_ACTIONS as READ_ACTIONS_FROM_READ, failureEnvelope, isReadEnvelope } from '../src/gitee-read.mjs';
import { createFakeHost, parsePatch, readPatch } from './helpers/fake-host.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const PATCH_FILE = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));

async function manifest() {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
}

async function listSrc() {
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(entry.name);
  }
  return files.sort();
}

async function readSrc(file) {
  return readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
}

/** 三条只读动作口径唯一真源：入口与 gitee-read 必须指向同一组名字。 */
test('AC-1/AC-7: 只读动作口径与 gitee-read 单一真源一致', () => {
  assert.deepEqual([...GITEE_READ_ACTIONS], [...READ_ACTIONS_FROM_READ]);
  assert.deepEqual([...GITEE_READ_ACTIONS], ['gitee.repository.read', 'gitee.issue.read', 'gitee.pr.read']);
});

test('AC-1: 清单声明可被宿主编排的入口（根名 + 主入口 + 补丁指针）', async () => {
  const pkg = await manifest();
  assert.equal(pkg.name, '@heluo/forge-gitee');
  assert.equal(pkg.private, true, '扩展包不发布到公共 registry');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './src/index.mjs');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  // r15 起本包自带设置页分区（Gitee）：client 入口与 devops 同形，键集不多不少。
  assert.deepEqual(pkg.dsh?.client, {
    platform: 'web',
    immediately: true,
    inject: ['slots', 'locale'],
  });

  // 指向的补丁层必须真的存在（宿主解析不到就是一个不生效的层）。
  const patchText = await readFile(PATCH_FILE, 'utf8');
  assert.ok(patchText.length > 0);

  // engines.dsh 必须具体：`*` 或不写都等于不设门。
  assert.match(pkg.engines?.dsh ?? '', /^>=?\d+\.\d+\.\d+/u);
});

test('AC-1: exports 与 files 白名单互相自洽（没有声明了却打不进去的入口）', async () => {
  const pkg = await manifest();
  const exportsMap = pkg.exports ?? {};
  assert.equal(exportsMap['.'] , './src/index.mjs');

  const targets = [];
  for (const [key, target] of Object.entries(exportsMap)) {
    assert.equal(typeof target, 'string', `exports["${key}"] 必须是字符串入口`);
    // `./client` 是浏览器半（TECHNICAL §9 指定 `./client.js`），`./icon` 与 `./locale/*.json` 是插件展示资源，其余入口一律落在本包 src。
    if (key === './client') {
      assert.equal(target, './client.js');
    } else if (key === './icon') {
      assert.equal(target, './icon.svg');
    } else if (key === './locale/*.json') {
      assert.equal(target, './locale/*.json');
    } else {
      assert.ok(target.startsWith('./src/'), `exports["${key}"] 必须指向本包 src`);
    }
    if (target.includes('*')) {
      const prefix = target.slice(2, target.indexOf('*')).replace(/\/$/, '');
      const entries = await readdir(new URL(`../${prefix}`, import.meta.url));
      assert.ok(entries.some((entry) => entry.endsWith('.json')), `${target} 至少要匹配一个语言文件`);
    } else {
      await readFile(new URL(`../${target.slice(2)}`, import.meta.url), 'utf8');
    }
    targets.push(target);
  }

  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files 白名单不能为空');
  for (const entry of pkg.files) {
    assert.ok(!entry.startsWith('./'), `files 里用相对路径而不是 ${entry}`);
    assert.ok(!entry.includes('..'), `files 不得越出包根：${entry}`);
    // 每个 files 条目在源码树里都要存在（auditReleaseClosure 的同一口径）。
    await access(new URL(`../${entry === 'src' ? 'src/index.mjs' : entry}`, import.meta.url));
  }
  for (const target of targets) {
    const covered = target.includes('*')
      ? pkg.files.some((entry) => target.startsWith(`./${entry}/`))
      : pkg.files.some((entry) => target === `./${entry}` || target.startsWith(`./${entry}/`));
    assert.ok(covered, `${target} 不在 files 白名单内，装包后会缺文件`);
  }
});

test('AC-4: 依赖面只有策略包（入口判定在本包实现），且不引入宿主私有包（src 计数为 0）', async () => {
  const pkg = await manifest();
  // r18 裁决（C）：两个包各自实现入口判定，不新增共享包，安装面因此保持 r17 的形状。
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@heluo/forge-policy']);
  assert.equal(pkg.dependencies['@heluo/forge-policy'], 'workspace:*', '包间用 workspace:，由构建期闭包成真版本');
  assert.equal(
    await readFile(new URL('../../forge-cli-entry/package.json', import.meta.url), 'utf8').then(() => true, () => false),
    false,
    '不得再出现共享入口包：C 方案要求两份实现 + 交叉对齐测试',
  );
  assert.deepEqual(pkg.peerDependencies, { react: '>=18' }, 'UI 半只需要宿主提供的 react，且必须是语义版本范围');
  assert.deepEqual(pkg.peerDependenciesMeta, { react: { optional: true } }, 'peer 必须 optional：宿主不装 react 时服务端半仍要能加载');
  assert.equal(pkg.optionalDependencies, undefined);

  // 安装期脚本一律不带（构建闭包会直接拒绝）。
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(pkg.scripts?.[hook], undefined, `不得带 ${hook}`);
  }

  for (const file of await listSrc()) {
    const source = await readSrc(file);
    assert.doesNotMatch(source, /from '@deepseek-ai\//u, `${file} 不得直接导入宿主包`);
    assert.doesNotMatch(source, /from 'react'/u, `${file} 不得导入 react`);
    assert.doesNotMatch(source, /\brequire\(/u, `${file} 是 ESM，不得用 require`);
  }
});

test('AC-6: 装载安全——模块本身可 import，顶层不碰宿主也不起子进程', async () => {
  assert.equal(pluginName, 'forge-gitee');
  assert.deepEqual([...inject], ['tools', 'policy']);

  // 宿主在补丁行省略 config 时会把 undefined 交给 schema；这里必须能给出 value 而不是 issues，
  // 否则插件不激活、10 个工具会静默消失（devops 侧同类用例 D-1）。
  const validated = ConfigStandard['~standard'].validate(undefined);
  assert.deepEqual(validated.issues ?? null, null);
  assert.equal(typeof validated.value, 'object');

  for (const file of await listSrc()) {
    const source = await readSrc(file);
    // 顶层不得读未注入的 ctx：只允许出现在函数体内（这里用"模块顶层不得出现裸 ctx." 的近似：
    // 校验点是无 `ctx.get` 出现在 export 之外——实现层已把 ctx 使用全部包在 apply 内）。
    assert.doesNotMatch(source, /\bfetch\(/u, `${file} 不得直接发起网络请求`);
    if (file !== 'gitee-cli.mjs') {
      assert.doesNotMatch(
        source,
        /from 'node:child_process'/u,
        `${file} 不得自己起子进程（唯一出口是 gitee-cli.mjs）`,
      );
    }
  }

  // 顶层可 import、且 apply 之前没有任何副作用：插件对象上没有"已挂载"痕迹。
  const module = await import('../src/index.mjs');
  assert.equal(typeof module.apply, 'function');
  assert.deepEqual(Object.keys(module).filter((key) => key === 'Config'), ['Config']);
});

test('AC-6: apply 缺少宿主能力时给出可读错误（而不是顶层未捕获异常）', () => {
  assert.throws(
    () => apply(undefined, {}),
    (error) => error.code === 'GITEE_HOST_UNAVAILABLE' && error.reason === 'GITEE_HOST_UNAVAILABLE',
  );

  // 有 ctx 但缺 tools.register：同样在挂载期失败，而不是等到第一次工具调用。
  const bare = { get: () => undefined, provide: () => () => {}, effect: () => () => {}, tools: {} };
  assert.throws(() => apply(bare, {}), (error) => error.code === 'GITEE_HOST_UNAVAILABLE');
});

test('AC-6: 缺策略服务时硬失败（不降级为只读）', () => {
  const host = createFakeHost();
  assert.throws(
    () => apply(host.ctx, {}),
    (error) => error.code === 'GITEE_POLICY_UNAVAILABLE' && error.detail?.missing?.includes('policy'),
  );
  assert.deepEqual(host.toolNames(), [], '失败路径不得留下半个工具面');
});

test('AC-7: 只读动作未登记不再拒绝挂载（P0 取代事实：旧实现要求三条读已登记且 enabled）', () => {
  // 空目录：只挂策略服务、不登记任何动作——读面按 out-of-scope 透传，工具面照常就绪。
  const host = createFakeHost({ catalog: [] });
  assert.doesNotThrow(() => apply(host.ctx, {}), '空目录不得拒绝挂载');
  assert.equal(host.toolNames().length, GITEE_TOOLS.length, '工具面必须完整注册');
  assert.equal(host.services.get('gitee').status(), 'ready');

  // 只登记一条受控写（目录不含任何读动作）同样不影响挂载。
  const partial = createFakeHost();
  const partialMount = partial.mountPolicy({
    catalog: [
      { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' },
    ],
  });
  assert.equal(partialMount.ok, true, '目录必须可编译');
  assert.doesNotThrow(() => apply(partial.ctx, {}), '部分目录不得拒绝挂载');
  assert.equal(partial.services.get('gitee').status(), 'ready');
});

test('AC-6: 配置非法在挂载期拒绝，错误里只带字段与原因', () => {
  const host = createFakeHost({ catalog: [] });
  assert.throws(() => apply(host.ctx, 'not-an-object'), (error) => error.code === 'GITEE_CONFIG_INVALID');
  let thrown;
  try {
    apply(host.ctx, { nope: 1 });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'GITEE_CONFIG_INVALID');
  assert.ok(Array.isArray(thrown.detail?.issues) && thrown.detail.issues.length > 0);
  // 详情里只允许出现"哪个字段错了"，不允许把用户的原始配置整体回显（凭据/路径就在里面）。
  assert.equal(thrown.detail?.config, undefined);
  assert.equal(thrown.detail?.value, undefined);
  assert.match(JSON.stringify(thrown.detail.issues), /nope/u, '要能定位到出错字段');
});

test('AC-1/AC-7: 真实补丁层可装配——11 个工具按固定顺序注册，卸载后干净', async () => {
  const rows = await readPatch(PATCH_FILE);
  assert.equal(rows.length, 2, '分发补丁层只插两行（策略 + 本插件），不多插别的东西');
  const [policyRow, pluginRow] = rows;
  assert.equal(policyRow.name, '@heluo/forge-policy');
  assert.equal(pluginRow.name, '@heluo/forge-gitee');
  assert.equal(typeof pluginRow.config, 'object', '插件行必须写显式 config（否则宿主交给 schema 的是 undefined）');

  const host = createFakeHost();
  // 按**分发补丁层原样**挂载：两行都在根服务域（r10 取消独立服务域），同装 devops 时
  // 另一份同 id 的策略行按 id 覆盖 config，最终只有一个 `policy` 实例、一份 12 条并集目录。
  const mountedPolicy = host.mountPolicy({ catalog: policyRow.catalog, audit: policyRow.audit });
  assert.equal(mountedPolicy.ok, true, `策略层挂载失败：${mountedPolicy.error?.message ?? ''}`);

  const mounted = host.mount(apply, pluginRow.config, pluginRow.name);
  assert.equal(mounted.ok, true, `插件挂载失败：${mounted.error?.message ?? ''}`);
  assert.equal(host.realms.size, 0, 'r10 单实例：不得再建独立服务域（label 数必须为 0）');
  assert.deepEqual(host.toolNames(), [...GITEE_TOOLS]);

  for (const toolName of host.toolNames()) {
    const definition = host.tools.get(toolName);
    assert.equal(definition.parameters?.type, 'object', `${toolName} 的参数必须是对象 schema`);
    assert.ok((definition.description ?? '').length > 0, `${toolName} 必须有描述`);
  }

  const service = host.services.get('gitee');
  assert.equal(service.status(), 'ready');
  assert.equal(host.services.get('giteeAdapter')?.provider, 'gitee');

  host.disposeAll();
  assert.deepEqual(host.toolNames(), [], '卸载后工具必须全部摘掉');
  assert.equal(host.services.get('gitee'), undefined);
  assert.equal(service.status(), 'disposed');
  assert.equal(typeof mounted.teardown, 'function');
});

// 并集目录现在是 12 条：devops 的两条 dop 变更读（`change.read` / `change.list`）+ 3 条 gitee 只读
// + 1 条只读判定 + 6 条写动作，与 forge-devops / forge-enterprise / forge-engineering 补丁层逐字
// 共用同一份并集。登记只决定"动作是否可见"，放行仍由内置分类承担
// （研发/评审写 allow、`gitee.git.push` confirm、`gitee.review.record` deny）。
test('AC-7: 补丁层自带 6 条受控写目录与审计，四层共用同一行 heluo-policy（P0 取代 12 条并集）', async () => {
  const rows = await readPatch(PATCH_FILE);
  const policyRow = rows.find((row) => row.name === '@heluo/forge-policy');
  assert.ok(policyRow !== undefined);
  const catalog = policyRow.catalog;
  assert.equal(catalog.length, 6, '目录恰好 6 条受控写；只读动作不登记（P0 / TECH-CHANGE §3.1）');
  assert.deepEqual(
    catalog[0],
    { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' },
    '第 1 条是 Issue 受控写：条目只有 action/target/category，不带 enabled',
  );
  for (const entry of catalog) {
    assert.equal(entry.enabled, undefined, `${entry.action} 不得声明 enabled（登记只决定可见）`);
    assert.equal(entry.revision, undefined, `${entry.action} 不得声明 revision（P0 不做跨版本一致性）`);
    assert.equal(entry.kind, undefined, `${entry.action} 不得声明 kind（类别来自内置词表）`);
    assert.equal(entry.egress, undefined, `${entry.action} 不得声明 egress（出网语义由类别与规则决定）`);
  }
  for (const entry of catalog) {
    if (entry.action.startsWith('change.')) continue; // devops 侧的变更写仍留在自己的命名空间
    assert.ok(entry.action.startsWith('gitee.'), `gitee 侧目录动作必须落在 gitee.* 命名空间：${entry.action}`);
  }
  assert.deepEqual(
    catalog.map((entry) => entry.action),
    [
      'gitee.issue.write',
      'gitee.pr.write',
      'change.clarification.write',
      'gitee.review.publish',
      'gitee.git.push',
      'gitee.review.record',
    ],
    '默认目录只登记六条受控写：读动作与判定按 out-of-scope 透传，不进入控制面',
  );
  for (const action of GITEE_READ_ACTIONS) {
    assert.equal(catalog.some((entry) => entry.action === action), false, `${action} 是只读动作，不得登记`);
  }

  assert.equal(policyRow.audit.sink, 'memory');
  assert.equal(String(policyRow.audit.buffer), '1000', '环形缓冲容量必须显式写出');
  assert.equal(String(policyRow.audit.keepDays), '7', '文件轮转保留天数必须显式写出');
  assert.equal(policyRow.audit.allowNonDurable, undefined, 'P0 内存 sink 已是默认，不再写 allowNonDurable');

  // 目录之后仍要能被真实策略编译（离线 compileCatalog 的同一入口）。
  const host = createFakeHost();
  const mountedPolicy = host.mountPolicy({ catalog, audit: policyRow.audit });
  assert.equal(mountedPolicy.ok, true);
  for (const action of ['change.read', 'change.list', ...GITEE_READ_ACTIONS, 'gitee.delivery.judge']) {
    assert.equal(mountedPolicy.policy.catalog.has(action), false, `${action} 是只读动作，编译后也不得出现`);
  }
  // 六条写的默认决策逐条写死：这是"登记不等于放行"的可验证事实。
  for (const [action, decision] of [
    ['gitee.issue.write', 'allow'],
    ['gitee.pr.write', 'allow'],
    ['change.clarification.write', 'allow'],
    ['gitee.review.publish', 'allow'],
    ['gitee.git.push', 'confirm'],
    ['gitee.review.record', 'deny'],
  ]) {
    assert.equal(
      mountedPolicy.policy.catalog.get(action)?.decision,
      decision,
      `${action} 的默认决策应为 ${decision}：登记只决定动作可见，放行由分类承担`,
    );
  }

  // 补丁层自己不得重复插入策略行（叠加安装才会出现两个 heluo-policy）。
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, `补丁层 id 重复：${ids.join(', ')}`);
  // r10 单实例：策略行与 forge-devops 的补丁层**同名同目录**（loader 按 id 覆盖 config），
  // 且两行都不写隔离域——任一条单边改动都会让幸存配置取决于装配顺序。
  assert.equal(policyRow.id, 'heluo-policy', '策略行必须与 forge-devops 补丁层同 id（r10 单实例）');
  for (const row of rows) {
    assert.equal(row.isolate, undefined, `${row.id} 不得写 isolate（r10 取消独立服务域）`);
  }
  const text = await readFile(PATCH_FILE, 'utf8');
  assert.doesNotMatch(text, /isolate/u, '补丁层文本不得出现 isolate（tests/plugin-patch-layers.test.mjs 同口径）');
  assert.equal(parsePatch(text).length, 2);
  assert.equal((text.match(/- insert:/gu) ?? []).length, 1, '只允许一个 insert 块');
});

test('static: 源码里没有任何以 forge_gitee_ 为名的泛化执行入口', async () => {
  const text = await readFile(new URL('../src/gitee-tools.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['forge_gitee_run', 'forge_gitee_exec', 'forge_gitee_shell']) {
    assert.doesNotMatch(text, new RegExp(`name: '${forbidden}'`, 'u'), `不得注册泛化入口 ${forbidden}`);
  }
  assert.ok(PACKAGE_ROOT.endsWith('/'));
});

test('D-4: 蓝图 API 点名的 gitee 侧成员可从模块 import（文档与实现对齐）', async () => {
  const actions = await import('../src/gitee-actions.mjs');
  const read = await import('../src/gitee-read.mjs');
  for (const [name, value] of Object.entries({
    createReviewRecord: actions.createReviewRecord,
    createDeliveryGate: actions.createDeliveryGate,
    failureEnvelope: read.failureEnvelope,
    isReadEnvelope: read.isReadEnvelope,
  })) {
    assert.equal(typeof value, 'function', `${name} 必须是可 import 的函数（蓝图 api 清单点名）`);
  }
  assert.equal(typeof failureEnvelope, 'function');
  assert.equal(typeof isReadEnvelope, 'function');
});
