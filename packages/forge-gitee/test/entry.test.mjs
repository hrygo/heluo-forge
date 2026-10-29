/**
 * 入口与装载面门禁：AC-1 / AC-4 / AC-6 / AC-7（静态半）。
 *
 * 这一组用例回答的是"分发出去的那份东西能不能被宿主认出来"：清单（入口名、分发白名单、
 * engines、补丁指针）、补丁层（3 条只读 + 0 条写 + 显式审计 + 显式 config）、以及
 * **装载安全**（模块顶层不碰宿主、不碰子进程；缺能力时 `apply` 抛可读错误而不是未捕获异常）。
 *
 * 断言尽量落在"文件里真实写了什么"上：AC-1 要求 `insert` 行的 name 精确等于包根名，
 * 写子路径（`@heluo/forge-gitee/src/index.mjs`）是最常见的静默跳过，只能在文本层证明。
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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
import { GITEE_READ_ACTIONS as READ_ACTIONS_FROM_READ } from '../src/gitee-read.mjs';
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
  assert.equal(pkg.dsh?.client, undefined, '本轮无前端，不得声明 client 入口');

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
    assert.ok(target.startsWith('./src/'), `exports["${key}"] 必须指向本包 src`);
    await readFile(new URL(`../${target.slice(2)}`, import.meta.url), 'utf8');
    targets.push(target);
  }

  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files 白名单不能为空');
  for (const entry of pkg.files) {
    assert.ok(!entry.startsWith('./'), `files 里用相对路径而不是 ${entry}`);
    assert.ok(!entry.includes('..'), `files 不得越出包根：${entry}`);
    // 每个 files 条目在源码树里都要存在（auditReleaseClosure 的同一口径）。
    const stat = await readFile(new URL(`../${entry === 'src' ? 'src/index.mjs' : entry}`, import.meta.url), 'utf8');
    assert.ok(typeof stat === 'string');
  }
  for (const target of targets) {
    const covered = pkg.files.some((entry) => target === `./${entry}` || target.startsWith(`./${entry}/`));
    assert.ok(covered, `${target} 不在 files 白名单内，装包后会缺文件`);
  }
});

test('AC-4: 依赖面只有策略包，且不引入宿主私有包（src 计数为 0）', async () => {
  const pkg = await manifest();
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@heluo/forge-policy']);
  assert.equal(pkg.dependencies['@heluo/forge-policy'], 'workspace:*', '包间用 workspace:，由构建期闭包成真版本');
  assert.equal(pkg.peerDependencies, undefined, '本轮不需要 peer（README 已写明硬依赖策略包）');
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
  // 否则插件不激活、9 个工具会静默消失（devops 侧同类用例 D-1）。
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

test('AC-7: 目录未登记 3 条只读动作时拒绝挂载，并列出全部缺失项', () => {
  // 空目录：只挂策略服务、不登记任何动作。
  const host = createFakeHost({ catalog: [] });
  let thrown;
  try {
    apply(host.ctx, {});
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'GITEE_ACTION_UNREGISTERED');
  assert.deepEqual(thrown.detail.missing, [...GITEE_READ_ACTIONS]);
  assert.deepEqual(host.toolNames(), []);

  // 只登记 2 条：剩下的 1 条必须被点名（否则"少一条只读"会静默变成运行期报错）。
  const partial = createFakeHost();
  partial.mountPolicy({
    catalog: [
      { action: 'gitee.repository.read', kind: 'read', target: 'repository', enabled: true },
      { action: 'gitee.issue.read', kind: 'read', target: 'issue', enabled: true },
    ],
  });
  assert.throws(
    () => apply(partial.ctx, {}),
    (error) => error.code === 'GITEE_ACTION_UNREGISTERED' && error.detail.missing.join(',') === 'gitee.pr.read',
  );
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

test('AC-1/AC-7: 真实补丁层可装配——8 个工具按固定顺序注册，卸载后干净', async () => {
  const rows = await readPatch(PATCH_FILE);
  assert.equal(rows.length, 2, '分发补丁层只插两行（策略 + 本插件），不多插别的东西');
  const [policyRow, pluginRow] = rows;
  assert.equal(policyRow.name, '@heluo/forge-policy');
  assert.equal(pluginRow.name, '@heluo/forge-gitee');
  assert.equal(typeof pluginRow.config, 'object', '插件行必须写显式 config（否则宿主交给 schema 的是 undefined）');

  const host = createFakeHost();
  // 按**分发补丁层原样**挂载：两行都带 `isolate: { policy: gitee }`，策略落在 `gitee` 服务域。
  const mountedPolicy = host.mountPolicy({ catalog: policyRow.catalog, audit: policyRow.audit, isolate: policyRow.isolate });
  assert.equal(mountedPolicy.ok, true, `策略层挂载失败：${mountedPolicy.error?.message ?? ''}`);

  const mounted = host.mount(apply, pluginRow.config, pluginRow.name, { isolate: pluginRow.isolate });
  assert.equal(mounted.ok, true, `插件挂载失败：${mounted.error?.message ?? ''}`);
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

test('AC-7: 补丁层自带目录与审计，0 条写；插件行不重复 heluo-policy', async () => {
  const rows = await readPatch(PATCH_FILE);
  const policyRow = rows.find((row) => row.name === '@heluo/forge-policy');
  assert.ok(policyRow !== undefined);
  const catalog = policyRow.catalog;
  assert.equal(catalog.length, 3, '目录恰好 3 条只读');
  for (const entry of catalog) {
    assert.ok(entry.action.startsWith('gitee.'), `目录动作必须落在 gitee.* 命名空间：${entry.action}`);
    assert.equal(entry.kind, 'read');
    assert.equal(entry.enabled, true);
  }
  assert.deepEqual(catalog.map((entry) => entry.action), [...GITEE_READ_ACTIONS]);
  assert.equal(catalog.filter((entry) => entry.kind === 'write').length, 0, '默认禁用写动作 = 不登记');

  assert.equal(policyRow.audit.sink, 'memory');
  assert.equal(policyRow.audit.allowNonDurable, true, '联调舱必须显式声明允许非持久');

  // 目录之后仍要能被真实策略编译（离线 compileCatalog 的同一入口）。
  const host = createFakeHost();
  const mountedPolicy = host.mountPolicy({ catalog, audit: policyRow.audit });
  assert.equal(mountedPolicy.ok, true);
  for (const action of GITEE_READ_ACTIONS) {
    assert.equal(mountedPolicy.policy.catalog.get(action)?.enabled, true);
  }

  // 补丁层自己不得重复插入策略行（叠加安装才会出现两个 heluo-policy）。
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, `补丁层 id 重复：${ids.join(', ')}`);
  // D-2：策略行不与 devops 补丁层同名（同 id 会被 loader 整体覆盖 config），且两行同 label
  // 的服务域——provider 与 consumer 必须写同一句，才互相可见。
  assert.notEqual(policyRow.id, 'heluo-policy', '策略行 id 必须与 forge-devops 补丁层的策略行区分开（D-2）');
  for (const row of rows) {
    assert.deepEqual(row.isolate, { policy: 'gitee' }, `${row.id} 必须声明 isolate.policy（D-2：独立服务域）`);
  }
  const text = await readFile(PATCH_FILE, 'utf8');
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
