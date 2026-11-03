/**
 * 分发补丁层的**跨包**约束（D-2 的永久门禁）。
 *
 * 两个 bundle 各自带一行 `@heluo/forge-policy`，装进同一个 profile 就变成两行。loader 按
 * `id` 覆盖 config、宿主按服务名 provide 单实例——r4 时代用 `isolate` 把两者隔到不同服务域，
 * 结果是同装后模型看到两套读面、两套事实（r4 QA 的 D-2 实际形态）。r10 按平台切库后判据翻转：
 *
 *  1. 同一层内行 id 唯一、策略行至多一行（自己跟自己撞车同样是配置被覆盖）；
 *  2. 两个 coexist bundle（`forge-devops` × `forge-gitee`）必须插**同一个** `id: heluo-policy`，
 *     且 `config.catalog` **逐字相同**：同 id ⇒ loader 只保留一份，目录是两边读动作的并集，
 *     任一插件单独装也能自洽；单边编辑会让幸存配置取决于装配顺序，所以由静态门禁守死；
 *  3. 两侧都**不得**再出现 `isolate`（含 `heluo-policy-gitee` 这类派生 id）：单实例是设计，
 *     不是妥协——`isolate` 一回来就重新分裂服务域；
 *  4. 任何一层只要某行写了 `isolate`，同层的策略行与插件行就必须是同一个 label（历史回归项，
 *     防止未来的新 bundle 以「只隔插件不隔策略」的半套写法复活同一个缺陷）。
 *
 * 全部静态：纯文件扫描，不装包不起进程。
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

/** 解析出 `[{ id, name, isolate, catalog }]`——只认本仓库补丁层用到的那几个键。 */
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

/**
 * 策略行 `catalog:` 数组的**原始行**（已去行尾空白）。
 * 「逐字相同」只能按源码行比：解析成对象再比会放过 `target`/`egress` 这类语义差异。
 */
function catalogLines(text) {
  const lines = text.split('\n');
  const from = lines.findIndex((line) => /^ {8}catalog:\s*$/u.test(line));
  if (from === -1) return [];
  const out = [];
  for (const line of lines.slice(from + 1)) {
    if (!/^\s+- \{ action: '/u.test(line)) break;
    out.push(line.replace(/\s+$/u, ''));
  }
  return out;
}

const POLICY_NAME = '@heluo/forge-policy';
const SHARED_POLICY_ID = 'heluo-policy';
/** r10 并集目录：devops 的 dop 变更读 + gitee 的三条读 + 交付判定（不执行关闭/合并）。 */
const UNION_ACTIONS = [
  'change.read',
  'gitee.repository.read',
  'gitee.issue.read',
  'gitee.pr.read',
  'gitee.delivery.judge',
];
const layersByName = () => new Map(bundles().map((bundle) => [bundle.name, rowsOf(bundle.text)]));
const textsByName = () => new Map(bundles().map((bundle) => [bundle.name, bundle.text]));
const policyRowOf = (rows) => rows.find((row) => row.name === POLICY_NAME);
const pluginRowsOf = (rows) => rows.filter((row) => row.name !== POLICY_NAME);

/** 共存对的判据本体：正常用例与「门禁有牙」自证共用同一个谓词。 */
function assertSharedPolicyRow({ devops, gitee, devopsText, giteeText }) {
  const devopsPolicy = policyRowOf(devops);
  const giteePolicy = policyRowOf(gitee);
  assert.ok(devopsPolicy !== undefined, 'forge-devops 补丁层缺策略行');
  assert.ok(giteePolicy !== undefined, 'forge-gitee 补丁层缺策略行');
  assert.equal(
    devopsPolicy.id,
    SHARED_POLICY_ID,
    `forge-devops 策略行 id 必须是 ${SHARED_POLICY_ID}（r10 单实例：两包共用同一策略行）`,
  );
  assert.equal(
    giteePolicy.id,
    SHARED_POLICY_ID,
    `forge-gitee 策略行 id 必须是 ${SHARED_POLICY_ID}：同 id 才会被 loader 覆盖成一份，`
    + '写成 heluo-policy-gitee 之类会分裂成两个策略实例（D-2 复发）',
  );
  for (const [name, row] of [['forge-devops', devopsPolicy], ['forge-gitee', giteePolicy]]) {
    assert.equal(row.isolate, undefined, `${name} 的策略行不得写 isolate：r10 是单实例单目录`);
  }
  const devopsCatalog = catalogLines(devopsText);
  const giteeCatalog = catalogLines(giteeText);
  assert.deepEqual(
    giteeCatalog,
    devopsCatalog,
    '两份补丁层的 catalog 必须逐字相同：缺口由 loader 按 id 覆盖决定，单边编辑会让幸存配置取决于装配顺序',
  );
  assert.deepEqual(
    devopsCatalog.map((line) => /\{ action: '([^']+)'/u.exec(line)[1]),
    UNION_ACTIONS,
    `策略目录必须是 5 条并集（${UNION_ACTIONS.join(' / ')}）；写动作不入目录——push 默认未登记即拒绝`,
  );
  // 文本口径也要守：单行没有 isolate 还不够，注释里写回 isolate 同样会被下一步照抄成真实配置
  // （r4 的隔离域形态就是从示例里长出来的），所以这段文本级断言必须落在同一个谓词里。
  for (const [name, text] of [['forge-devops', devopsText], ['forge-gitee', giteeText]]) {
    assert.ok(
      !/isolate/u.test(text),
      `${name} 补丁层文本仍出现 isolate：两个 bundle 必须同处 root 域、共用一份策略实例`,
    );
  }
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

test('D-2: r10 共存对（forge-devops × forge-gitee）共用 heluo-policy，catalog 逐字相同', () => {
  const all = layersByName();
  const texts = textsByName();
  const devops = all.get('forge-devops');
  const gitee = all.get('forge-gitee');
  assert.ok(devops !== undefined && gitee !== undefined, '仓库里应有 forge-devops 与 forge-gitee 两个 bundle');

  const { devopsPolicy, giteePolicy } = assertSharedPolicyRow({
    devops,
    gitee,
    devopsText: texts.get('forge-devops'),
    giteeText: texts.get('forge-gitee'),
  });

  // 每层都要有自己的插件行；同 id 策略行 + 并集目录，任一插件单独装都能自洽。
  for (const [name, rows] of [['forge-devops', devops], ['forge-gitee', gitee]]) {
    const policyRow = policyRowOf(rows);
    assert.ok(policyRow.catalog.length > 0, `${name} 的策略行没有 catalog：插件将无目录可读`);
    assert.ok(pluginRowsOf(rows).length >= 1, `${name} 没有插件行`);
  }
  assert.equal(devopsPolicy.id, giteePolicy.id, '同一个策略行才只有一个实例（D-2）');
});

test('D-2: 不存在 heluo-policy-gitee 与 isolate 残留（单实例是设计，不是隔离域）', () => {
  const all = layersByName();
  const texts = textsByName();
  for (const name of ['forge-devops', 'forge-gitee']) {
    const rows = all.get(name);
    assert.ok(rows !== undefined, `缺 ${name} 补丁层`);
    for (const row of rows) {
      assert.ok(
        !row.id.startsWith('heluo-policy-gitee'),
        `${name} 仍有派生策略 id ${row.id}：r10 只允许 ${SHARED_POLICY_ID}`,
      );
      assert.equal(row.isolate, undefined, `${name} 的 ${row.id} 仍写 isolate：两个 bundle 必须落在同一个服务域`);
    }
    assert.ok(!/isolate/u.test(texts.get(name)), `${name} 补丁层文本仍出现 isolate（含注释口径）`);
  }
});

test('D-2 门禁有牙: 单边改一条目录或加回 isolate，判据必须失败（断言不是恒真）', () => {
  const all = layersByName();
  const texts = textsByName();
  const giteeRows = all.get('forge-gitee');
  const giteeText = texts.get('forge-gitee');

  const driftedCatalog = giteeText.replace(
    "          - { action: 'gitee.pr.read', kind: 'read', target: 'pull-request', enabled: true }\n",
    '',
  );
  assert.notEqual(driftedCatalog, giteeText, '自证前提：样例改写必须真的删掉一行目录');
  assert.throws(
    () =>
      assertSharedPolicyRow({
        devops: all.get('forge-devops'),
        gitee: giteeRows,
        devopsText: texts.get('forge-devops'),
        giteeText: driftedCatalog,
      }),
    /逐字相同/u,
  );

  const isolated = giteeText.replace('    - id: heluo-policy\n', '    - id: heluo-policy\n      isolate: { policy: gitee }\n');
  assert.notEqual(isolated, giteeText, '自证前提：样例改写必须真的加上 isolate');
  assert.throws(
    () =>
      assertSharedPolicyRow({
        devops: all.get('forge-devops'),
        gitee: giteeRows,
        devopsText: texts.get('forge-devops'),
        giteeText: isolated,
      }),
    /isolate/u,
  );
});

test('D-2: 未来若新增写了 isolate 的层，策略行与插件行必须同 label（历史回归项）', () => {
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

/**
 * D-1：gitee 回滚文档引用的插件行 id 必须是补丁层里真实存在的那个（`heluo-gitee`）。
 *
 * 包名与补丁层行 id 不是同一个东西：本包的行 id 是 `heluo-gitee`（见
 * `packages/forge-gitee/cordis.patch.yml`），照包名写成 `forge-gitee` 时人工回滚会删一条
 * 不存在的行、复核恒「通过」，真正的条目残留 → 冷启动 `entry not found`。
 */
function giteeRollbackIdProblems(text) {
  const problems = [];
  if (/id:\s*forge-gitee\b/u.test(text)) {
    problems.push('把插件行写成 `id: forge-gitee`：补丁层没有这个 id（真实 id 是 heluo-gitee）');
  }
  if (/`?forge-gitee`?\s*条目/u.test(text)) {
    problems.push('按「forge-gitee 条目」回滚：补丁层没有这个条目，删除与复核都会落空');
  }
  return problems;
}

/** D-5：所有携带 `heluo-policy` 的补丁层，策略目录必须与 devops 层逐字相同。 */
function assertUniformPolicyCatalogs(layers) {
  const policyLayers = layers.filter((bundle) => rowsOf(bundle.text).some((row) => row.name === POLICY_NAME));
  assert.ok(policyLayers.length >= 3, `应覆盖企业 / devops / gitee 三层携带策略行的补丁层，实际 ${policyLayers.length}`);
  const devopsLayer = policyLayers.find((bundle) => bundle.name === 'forge-devops');
  assert.ok(devopsLayer !== undefined, '缺少 forge-devops 补丁层，无法给出并集目录的基准');
  const expected = catalogLines(devopsLayer.text);
  assert.deepEqual(
    expected.map((line) => /\{ action: '([^']+)'/u.exec(line)[1]),
    UNION_ACTIONS,
    `基准目录必须是 5 条并集（${UNION_ACTIONS.join(' / ')}）`,
  );
  for (const layer of policyLayers) {
    assert.deepEqual(
      catalogLines(layer.text),
      expected,
      `${layer.name} 的策略行 catalog 必须与 devops 层逐字相同：同 id 覆盖后最后装配的一层会决定幸存目录，缺目录 = 空策略（fail-closed）`,
    );
  }
}

test('D-1: gitee 回滚文档引用真实插件行 id（heluo-gitee），不得写成包名 forge-gitee', () => {
  const docs = [
    join(packagesDir, 'forge-gitee', 'README.md'),
    join(root, 'docs', 'design', 'plugins', 'forge-gitee.md'),
  ];
  for (const path of docs) {
    const text = readFileSync(path, 'utf8');
    assert.deepEqual(giteeRollbackIdProblems(text), [], `${path} 的回滚段引用了不存在的插件行 id`);
    assert.match(text, /id: heluo-gitee/u, `${path} 的回滚段必须给出真实 id heluo-gitee`);
  }
  // 门禁有牙：把真实文档改回缺陷写法，判据必须命中（断言不是恒真）。
  const readme = readFileSync(docs[0], 'utf8');
  const broken = readme.replace('id: heluo-gitee', 'id: forge-gitee');
  assert.notEqual(broken, readme, '自证前提：样例改写必须真的命中一处 id');
  assert.ok(giteeRollbackIdProblems(broken).length > 0, '写回 `id: forge-gitee` 后判据必须能识别');
});

test('D-5: 企业 / devops / gitee 三层的策略目录逐字相同（企业层不得清空目录）', () => {
  const layers = bundles();
  assertUniformPolicyCatalogs(layers);

  // 门禁有牙：把企业层的 catalog 段删掉（等价于修复前的「只插行、不带 config」），判据必须失败。
  const enterprise = layers.find((bundle) => bundle.name === 'forge-enterprise');
  assert.ok(enterprise !== undefined, '缺少 forge-enterprise 补丁层');
  const strippedText = enterprise.text.replace(/^ {8}catalog:\n(?: {10}- .*\n)+/mu, '');
  assert.notEqual(strippedText, enterprise.text, '自证前提：样例改写必须真的删掉 catalog 段');
  assert.deepEqual(catalogLines(strippedText), [], '自证前提：删掉 catalog 段后解析结果为空');
  assert.throws(
    () => assertUniformPolicyCatalogs([...layers.filter((bundle) => bundle.name !== 'forge-enterprise'), { name: 'forge-enterprise', text: strippedText }]),
    /逐字相同/u,
    '缺目录的企业层排在最后时必须能让门禁失败',
  );
});

test('D-2: 补丁层文档不得再写「同 id 会重复挂载 / 不要叠加」（安装者会因此回避正常同装）', () => {
  const docs = [
    join(packagesDir, 'forge-devops', 'README.md'),
    join(root, 'docs', 'design', 'plugins', 'forge-devops.md'),
    join(packagesDir, 'forge-enterprise', 'README.md'),
    join(root, 'docs', 'design', 'plugins', 'forge-enterprise.md'),
  ];
  const forbidden = /不要再叠加|会被重复挂载|重复挂载同一个 id/u;
  for (const path of docs) {
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, forbidden, `${path} 仍把同 id 策略行描述成重复挂载：loader 是按 id 折叠成一个条目`);
  }
  // 门禁有牙：缺陷原文必须能被同一判据识别（断言不是恒真）。
  assert.match('若同一 profile 已 apply 企业层，不要再叠加本层，否则同一个 id 会被重复挂载。', forbidden);
});
