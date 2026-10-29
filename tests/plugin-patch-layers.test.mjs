/**
 * 分发补丁层的**跨包**约束（D-2 的永久门禁）。
 *
 * 两个 bundle 各自带一行 `@heluo/forge-policy`，装进同一个 profile 就变成两行。loader 按
 * `id` 覆盖 config、宿主按服务名 provide 单实例——只要有一处没对齐，就出现"后装的那个把
 * 先装的顶掉、先装的插件掉线、但宿主只留一行 warning"的情形（r4 QA 的 D-2 实际形态）。
 *
 * 判据（全部静态，纯文件扫描，不装包不起进程）：
 *  1. 同一层内行 id 唯一、策略行至多一行（自己跟自己撞车同样是配置被覆盖）；
 *  2. AC-13 要求共存的 provider 对（`forge-devops` × `forge-gitee`）策略行 id 必须不同，
 *     且各自只为自己的插件行提供目录；
 *  3. 任何一层只要某行写了 `isolate`，同层的策略行与插件行就必须是**同一个 label**，否则
 *     插件会去另一个服务域找自己那份目录（表现是"装上了但没有工具"）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');

/** 所有声明了补丁层的包（包目录下的 cordis.patch.yml）。 */
function bundles() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, 'cordis.patch.yml'))
    .filter((path) => {
      try {
        readFileSync(path, 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .map((path) => ({ name: path.split('/').slice(-2, -1)[0], path, text: readFileSync(path, 'utf8') }));
}

/** 解析出 `[{ id, name, isolate }]`——只认本仓库补丁层用到的那几个键。 */
function rowsOf(text) {
  const parsed = [];
  let current = null;
  for (const line of text.split('\n')) {
    const row = /^ {4}- id: (\S+)\s*$/u.exec(line);
    if (row !== null) {
      current = { id: row[1], name: null, isolate: undefined, catalog: [] };
      parsed.push(current);
      continue;
    }
    if (current === null) continue;
    const name = /^ {6}name: '([^']+)'\s*$/u.exec(line);
    if (name !== null) {
      current.name = name[1];
      continue;
    }
    const catalogEntry = /^\s+- \{ action: '([^']+)'/u.exec(line);
    if (catalogEntry !== null) {
      current.catalog.push(catalogEntry[1]);
      continue;
    }
    const inline = /^ {6}isolate:\s*\{(.*)\}\s*$/u.exec(line);
    if (inline !== null) {
      current.isolate = {};
      for (const chunk of inline[1].split(',')) {
        const pair = /^\s*([A-Za-z][\w]*):\s*(.+?)\s*$/u.exec(chunk);
        if (pair !== null) current.isolate[pair[1]] = pair[2].replace(/^'|'$/gu, '');
      }
      continue;
    }
    // 分块写法：`isolate:` 换行后跟 `  policy: gitee`
    if (/^ {6}isolate:\s*$/u.test(line)) {
      current.isolate = {};
      continue;
    }
    const blockPair = /^ {8}([A-Za-z][\w]*): (.+?)\s*$/u.exec(line);
    if (blockPair !== null && current.isolate !== undefined) {
      current.isolate[blockPair[1]] = blockPair[2].replace(/^'|'$/gu, '');
    }
  }
  return parsed;
}

const POLICY_NAME = '@heluo/forge-policy';
const layersByName = () => new Map(bundles().map((bundle) => [bundle.name, rowsOf(bundle.text)]));
const policyRowOf = (rows) => rows.find((row) => row.name === POLICY_NAME);
const pluginRowsOf = (rows) => rows.filter((row) => row.name !== POLICY_NAME);

/** 共存对的判据本体：正常用例与"门禁有牙"自证共用同一个谓词。 */
function assertCoexistingPolicyIds({ devops, gitee }) {
  const devopsPolicy = policyRowOf(devops);
  const giteePolicy = policyRowOf(gitee);
  assert.ok(devopsPolicy !== undefined, 'forge-devops 补丁层缺策略行');
  assert.ok(giteePolicy !== undefined, 'forge-gitee 补丁层缺策略行');
  assert.notEqual(
    devopsPolicy.id,
    giteePolicy.id,
    `两个共存 bundle 的策略行同 id "${devopsPolicy.id}"：loader 会按 id 覆盖 config，先装的那层插件会掉线（D-2）`,
  );
  return { devopsPolicy, giteePolicy };
}

test('D-2: 同一层内行 id 唯一且至多一行策略（自己覆盖自己也是 config 被覆盖）', () => {
  const all = layersByName();
  assert.ok(all.size >= 2, `至少要有两个 bundle 才能验共存，实际 ${all.size}`);
  for (const [name, rows] of all) {
    const ids = rows.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, `${name} 行 id 重复：${ids.join(', ')}`);
    const policyRows = rows.filter((row) => row.name === POLICY_NAME);
    assert.ok(policyRows.length <= 1, `${name} 插了 ${policyRows.length} 行 ${POLICY_NAME}，同层重复 Provide 会互相覆盖`);
  }
});

test('D-2: AC-13 的共存对（forge-devops × forge-gitee）策略行 id 必须不同', () => {
  const all = layersByName();
  const devops = all.get('forge-devops');
  const gitee = all.get('forge-gitee');
  assert.ok(devops !== undefined && gitee !== undefined, '仓库里应有 forge-devops 与 forge-gitee 两个 bundle');

  const devopsPolicy = policyRowOf(devops);
  const giteePolicy = policyRowOf(gitee);
  assertCoexistingPolicyIds({ devops, gitee });

  // 共存时两边都要有自己的目录入口——"共用一行"不是这个仓库的形态（并层是另一条路径）。
  for (const [name, rows] of [['forge-devops', devops], ['forge-gitee', gitee]]) {
    const policyRow = policyRowOf(rows);
    assert.ok(policyRow.catalog.length > 0, `${name} 的策略行没有 catalog：插件将无目录可读`);
    assert.ok(pluginRowsOf(rows).length >= 1, `${name} 没有插件行`);
  }
  assert.ok(devopsPolicy !== undefined && giteePolicy !== undefined);
});

test('D-2 门禁有牙: 把 gitee 策略行 id 改回 heluo-policy，判据必须失败（断言不是恒真）', () => {
  const all = layersByName();
  const mutated = {
    devops: all.get('forge-devops'),
    // 修 D-2 前的真实形态就是两行同 id（loader 按 id 覆盖 config），这里原地复现。
    gitee: all.get('forge-gitee').map((row) => (row.name === POLICY_NAME ? { ...row, id: 'heluo-policy' } : row)),
  };
  assert.throws(() => assertCoexistingPolicyIds(mutated), /同 id/u);
});

test('D-2: 写了 isolate 的层，策略行与插件行必须同 label（否则插件找不到自己那份目录）', () => {
  for (const [name, rows] of layersByName()) {
    const policyRow = policyRowOf(rows);
    if (policyRow === undefined) continue; // 不提供策略的 bundle（如聚合层）不在本条范围内
    for (const pluginRow of pluginRowsOf(rows)) {
      const policyLabel = policyRow.isolate?.policy;
      const pluginLabel = pluginRow.isolate?.policy;
      if (policyLabel === undefined && pluginLabel === undefined) continue; // root 域共用，合法
      assert.equal(
        pluginLabel,
        policyLabel,
        `${name}: 策略行 label=${String(policyLabel)} 与插件行 ${pluginRow.id} label=${String(pluginLabel)} 不一致，`
        + '插件会去另一个服务域找 policy（表现为装上但没有工具）',
      );
    }
    if (policyRow.isolate?.policy !== undefined) {
      assert.equal(Object.keys(policyRow.isolate).length, 1, `${name} 只应隔离 policy 一个服务名`);
    }
  }
});
