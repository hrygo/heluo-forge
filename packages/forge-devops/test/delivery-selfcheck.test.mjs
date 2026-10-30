/**
 * T8 交付自检（结构性，跨模块）。
 *
 * 定位：T1–T7 各自测自己的语义；本文件只核对「任务之间」的契约——
 *   1. 蓝图层声明的成员是否真的存在且可导入（禁止发明成员名，接口契约硬缺陷）；
 *   2. 半落地装配（import 指向不存在的模块）、两套词表混用、禁项通道复活、shell 拼串；
 *   3. 清单/补丁/环境注入/产物落盘/入口格式等跨文件一致性（单模块测试看不到）；
 *   4. 交付卫生：文档与源码不含本机绝对路径、凭据与日志目录引用；
 *   5. r3（CLI 路径自动发现）增量，就地扩展而非新建检查器：`cli-discovery` 零子进程、
 *      配置页客户端不打印/不持久化路径、工具面不把取值型 access 字段拼进 `detail`、
 *      补丁层与 README 无绝对路径样例且口径改为「配置页优先」、清单声明客户端半
 *      （`dsh.client` + `./client` 导出 + 发布白名单含 `client.js`），以及
 *      「零回退」的三个可核对形式（9 个工具、`READ_REASONS` 不加码、只读面语义不变）。
 *
 * dev 阶段按依赖分波产出，T8 可能先于部分任务执行：模块文件缺失时记为 DEFERRED
 * （诊断信息带归属任务），文件一旦落地立刻转为硬断言——自检随交付推进逐条生效，
 * 不靠「跳过即通过」假装完成。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SRC_DIR = path.join(PACKAGE_ROOT, 'src');
const CLIENT_FILE = path.join(PACKAGE_ROOT, 'client.js');
/** 基线需求（r1）与本需求（r3）各一个自包含任务夹；两个夹都不许出现本机路径。 */
const TASK_DOC_SETS = [
  {
    dir: path.join(REPO_ROOT, 'docs', 'teamflow', '20261028-r1-devops-change-flow'),
    docs: ['PRD.md', 'TECHNICAL.md'],
    label: 'r1',
  },
  {
    dir: path.join(REPO_ROOT, 'docs', 'teamflow', '20261029-r3-cli-path-autodiscovery'),
    docs: ['PRD.md', 'DESIGN.md', 'TECHNICAL.md'],
    label: 'r3',
  },
];

/** 蓝图（TECHNICAL §11 + 架构蓝图）声明的模块与成员。多导出允许，缺导出即缺陷。 */
const MODULE_CONTRACTS = [
  { file: 'runtime-config.mjs', task: 'T1', exports: ['resolveRuntimeConfig', 'describeRuntimeConfig', 'ENV_KEYS'] },
  { file: 'cli-runner.mjs', task: 'T1', exports: ['createCliRunner'] },
  { file: 'dop-adapter.mjs', task: 'T2', exports: ['createDopAdapter', 'DOP_COMMANDS'] },
  { file: 'gh-adapter.mjs', task: 'T2', exports: ['createGhAdapter', 'GH_COMMANDS'] },
  { file: 'policy-guard.mjs', task: 'T5', exports: ['createPolicyGuard', 'GUARD_STATUSES'] },
  { file: 'change-context.mjs', task: 'T3', exports: ['normalizeChangeRecord', 'firstReleaseInfo', 'buildContextCard', 'renderContextCard'] },
  { file: 'repository-resolver.mjs', task: 'T3', exports: ['resolveBuildingRepository'] },
  { file: 'clarify.mjs', task: 'T4', exports: ['createClarifySheet', 'validateClarifySheet', 'bumpClarifyVersion', 'clarifyRevisionId', 'HARD_GATE_KINDS', 'CLARIFY_REASONS'] },
  { file: 'plan.mjs', task: 'T4', exports: ['buildDeliveryPlan', 'validatePlan', 'renderPlan'] },
  { file: 'actions.mjs', task: 'T5', exports: ['ACTION_STATUSES', 'idempotencyKey', 'createIssueIdempotent', 'commentIssueIdempotent', 'createPrIdempotent', 'commentPrIdempotent', 'writeClarification'] },
  { file: 'review.mjs', task: 'T6', exports: ['MODEL_TIERS', 'assertModelRecorded', 'buildReviewRecord', 'recordHumanConfirmation', 'reviewStaleness', 'renderReview'] },
  { file: 'report.mjs', task: 'T6', exports: ['buildReport', 'validateReport', 'issueCloseReadiness', 'renderReport'] },
  { file: 'commit-message.mjs', task: 'T6', exports: ['assertCommitMessage'] },
  { file: 'artifacts.mjs', task: 'T7', exports: ['ARTIFACT_KINDS', 'artifactPath', 'renderFrontMatter', 'writeArtifact'] },
  { file: 'entry.mjs', task: 'T7', exports: ['ENTRY_NAME', 'ENTRY_HELP', 'parseChangeId', 'registerEntry'] },
  // r8 增量：入口形态单点模块。它被保存侧、发现侧与两个适配器共读，成员名一旦漂移，
  // 最先崩的是运行期（适配器起不来），所以这里按蓝图 §3.1 逐字核对。
  {
    file: 'entry-form.mjs',
    task: 'T1(r8)',
    exports: [
      'WRAPPER_SUFFIXES',
      'ENTRY_FORMS',
      'wrapperSuffixOf',
      'entryFormOf',
      'isDirectlyExecutable',
      'describeSpawnFailure',
      'redactPathLike',
    ],
  },
  // r3 增量：四个新模块 + 三处增量导出。`landedWith` 表示该成员随同波次的另一文件落地，
  // 文件先于同波次落地时记 DEFERRED（不是静默放行：gate 文件一出现即转为硬断言）。
  {
    file: 'cli-discovery.mjs',
    task: 'T1(r3)',
    exports: ['WRAPPER_SUFFIXES', 'DISCOVERY_TIERS', 'candidateExecutableNames', 'parsePathVar', 'candidateDirs', 'isDirectlyExecutable', 'discoverTool', 'discoverCli'],
  },
  {
    file: 'cli-config.mjs',
    task: 'T2(r3)',
    exports: ['CLI_FIELDS', 'CLI_ORIGINS', 'CLI_REASONS', 'resolveCliAccess', 'describeCliAccess', 'validateCliField', 'buildCliPatch', 'cliGuidance'],
  },
  {
    file: 'runtime-config.mjs',
    task: 'T2(r3)',
    exports: ['validateConfigField', 'ConfigStandard'],
    landedWith: 'cli-config.mjs',
  },
  { file: 'cli-access.mjs', task: 'T3(r3)', exports: ['createCliAccess'] },
  { file: 'http.mjs', task: 'T3(r3)', exports: ['CLI_API_PREFIX', 'CLI_REQUEST_HEADER', 'createCliApi', 'toNodeRoute'] },
  {
    file: 'index.mjs',
    task: 'T4(r3)',
    exports: ['Config', 'apply'],
    // T4 同时拥有 index.mjs 与 package.json：清单声明 dsh.client 即 T4 已落地。
    gate: () => Boolean(JSON.parse(read(pkgPath('package.json'))).dsh?.client),
  },
];

const read = (file) => readFileSync(file, 'utf8');
const pkgPath = (...segments) => path.join(PACKAGE_ROOT, ...segments);
const srcFiles = () => readdirSync(SRC_DIR).filter((file) => file.endsWith('.mjs')).sort();
const srcText = (file) => read(path.join(SRC_DIR, file));
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const deferred = (t, file, task, detail) => {
  t.diagnostic(`DEFERRED ${file} ← ${task}${detail ? `：${detail}` : ''}`);
  return true;
};
const load = (file) => import(new URL(`../src/${file}`, import.meta.url).href);
/** r3 装配是否已落地：T4 拥有 index.mjs 与清单，`dsh.client` 出现即该波次已合入。 */
const r3Landed = () => Boolean(JSON.parse(read(pkgPath('package.json'))).dsh?.client);

test('交付文档存在且不含本机绝对路径、凭据', () => {
  for (const { dir, docs, label } of TASK_DOC_SETS) {
    for (const name of docs) {
      const file = path.join(dir, name);
      assert.ok(existsSync(file), `${label} 任务夹缺 ${name}`);
      const text = read(file);
      assert.ok(!/\/Users\/[A-Za-z][\w.-]*\//.test(text), `${label}/${name} 出现本机绝对路径（AC-10：路径不落文档）`);
      assert.ok(!/\/home\/[a-z][\w.-]*\//.test(text), `${label}/${name} 出现本机绝对路径（AC-10）`);
      assert.ok(!/[A-Za-z]:\\+Users\\+/i.test(text), `${label}/${name} 出现 Windows 本机绝对路径（AC-10）`);
      assert.ok(!/ghp_[A-Za-z0-9]{16,}/.test(text), `${label}/${name} 出现 GitHub 令牌片段（凭据不得进文档）`);
      assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY/.test(text), `${label}/${name} 出现私钥块`);
    }
  }
});

test('源码不含本机绝对路径、凭据、日志目录与硬编码 endpoint', () => {
  for (const file of srcFiles()) {
    const text = srcText(file);
    assert.ok(!/\/Users\/[A-Za-z]/.test(text), `${file} 出现本机绝对路径（AC-22）`);
    assert.ok(!/ghp_[A-Za-z0-9]{16,}/.test(text), `${file} 出现令牌片段`);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY/.test(text), `${file} 出现私钥块`);
    assert.ok(!/logs\/teamflow/.test(text), `${file} 不得引用运行日志目录（logs 是暂存，不进交付）`);
    assert.ok(!/https?:\/\//.test(text), `${file} 出现硬编码 URL/endpoint（AC-22：endpoint 由环境注入）`);
  }
});

test('相对 import 闭合：src 内每个本地导入都有对应文件（半落地装配即红）', () => {
  for (const file of srcFiles()) {
    for (const match of srcText(file).matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.resolve(SRC_DIR, match[1]);
      assert.ok(existsSync(target), `${file} 导入了不存在的模块 ${match[1]}`);
    }
  }
});

test('既有只读面语义不变：4 个读动作、4 个读状态、4 个只读工具', async () => {
  const readModule = await load('read.mjs');
  const toolsModule = await load('tools.mjs');
  assert.deepEqual(Array.from(readModule.READ_ACTIONS), ['change.read', 'repository.read', 'issue.read', 'pr.read']);
  for (const status of ['succeeded', 'failed', 'partial', 'unknown']) {
    assert.ok(readModule.READ_STATUSES.includes(status), `读状态词表缺 ${status}`);
  }
  assert.deepEqual(Object.keys(toolsModule.READ_TOOLS).sort(), [
    'forge_devops_change_read',
    'forge_devops_issue_read',
    'forge_devops_pr_read',
    'forge_devops_repository_read',
  ]);
});

test('蓝图接口契约：已落地模块导出全部声明成员（未落地记 DEFERRED + 归属任务）', async (t) => {
  let landed = 0;
  for (const contract of MODULE_CONTRACTS) {
    if (!existsSync(pkgPath('src', contract.file))) {
      deferred(t, contract.file, contract.task, '本波次尚未产出');
      continue;
    }
    if (contract.landedWith && !existsSync(pkgPath('src', contract.landedWith))) {
      deferred(t, contract.file, contract.task, `增量随 ${contract.landedWith} 同波次落地`);
      continue;
    }
    if (contract.gate && !contract.gate()) {
      deferred(t, contract.file, contract.task, '同波次清单声明尚未落地');
      continue;
    }
    const module = await load(contract.file);
    const missing = contract.exports.filter((key) => module[key] === undefined);
    assert.deepEqual(missing, [], `${contract.file} 缺蓝图声明成员：${missing.join(', ')}（归属 ${contract.task}）`);
    landed += 1;
  }
  t.diagnostic(`已落地 ${landed}/${MODULE_CONTRACTS.length} 个流程模块`);
});

test('包清单与补丁层一致：声明即存在、策略先行、insert 行用包根名', (t) => {
  const manifest = JSON.parse(read(pkgPath('package.json')));
  assert.equal(manifest.name, '@heluo/forge-devops');
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.engines?.dsh, '清单必须声明 engines.dsh（AGENTS.md §4）');
  const patchDeclared = manifest.dsh?.bundle?.patch;
  const patchFile = pkgPath('cordis.patch.yml');
  if (!patchDeclared) {
    assert.ok(!existsSync(patchFile), '存在 cordis.patch.yml 但清单未声明 dsh.bundle.patch');
    deferred(t, 'cordis.patch.yml', 'T1', '清单尚未声明 dsh.bundle.patch');
    return;
  }
  assert.equal(patchDeclared, './cordis.patch.yml', 'dsh.bundle.patch 必须指向包内补丁层（仓规只认 ./ 形式）');
  assert.ok(existsSync(patchFile), `清单声明了 ${patchDeclared} 但文件不存在`);
  assert.ok(manifest.files.includes('cordis.patch.yml'), '发布文件清单必须含补丁层');
  assert.ok(manifest.dependencies?.['@heluo/forge-policy'], '策略是硬依赖：单安装单元必须自带闭包（AC-2/3）');
  const yaml = read(patchFile);
  // 只看 insert 的 `- id:` 行：文件头部注释里两个包名都会出现，按整段文本 indexOf 比顺序会误判。
  const insertIds = [...yaml.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(
    insertIds,
    ['heluo-policy', 'forge-devops'],
    '补丁层只插这两个 id 且顺序必须策略先行、devops 在后（硬依赖）',
  );
  for (const match of yaml.matchAll(/^\s*name:\s*(\S+)\s*$/gm)) {
    assert.ok(!/^@[^/]+\/[^/]+\/.+/.test(match[1]), `insert 行 name 必须用包根名：${match[1]}`);
  }
});

test('环境注入 fail closed：未配置点名字段，describe 不回显值', async (t) => {
  if (!existsSync(pkgPath('src', 'runtime-config.mjs'))) return deferred(t, 'runtime-config.mjs', 'T1', '无法验证 AC-22');
  const { resolveRuntimeConfig, describeRuntimeConfig } = await load('runtime-config.mjs');
  const empty = resolveRuntimeConfig({});
  assert.equal(empty.ok, false, '未注入时不得给出可用配置（fail closed）');
  assert.equal(empty.reason, 'CONFIG_MISSING');
  assert.ok(Array.isArray(empty.missing), 'missing 必须是字段名数组');
  assert.ok(empty.missing.includes('FORGE_DEVOPS_DOP_BIN'), `missing 必须点名 FORGE_DEVOPS_DOP_BIN，实际 ${empty.missing}`);
  const resolved = resolveRuntimeConfig({
    FORGE_DEVOPS_DOP_BIN: '/secret/bin/dop',
    FORGE_DEVOPS_DOP_ENDPOINT: 'https://secret-endpoint.example/dop',
    FORGE_DEVOPS_GH_OWNER: 'acme',
  });
  if (resolved.ok !== true) {
    t.diagnostic(`SKIP describe：最小注入未解析成功（${resolved.reason}），由 T1 自测覆盖`);
    return;
  }
  const described = JSON.stringify(describeRuntimeConfig(resolved.value));
  assert.ok(!described.includes('/secret/bin/dop'), 'describeRuntimeConfig 回显了 dop 路径（AC-22）');
  assert.ok(!described.includes('secret-endpoint.example'), 'describeRuntimeConfig 回显了 endpoint（AC-22）');
  assert.match(described, /dopBin|DOP_BIN/, 'describe 需给出「已配/未配」布尔位');
});

test('dop 适配器：固定 argv、未注入 endpoint 不拼参、无写通道', async (t) => {
  if (!existsSync(pkgPath('src', 'dop-adapter.mjs'))) return deferred(t, 'dop-adapter.mjs', 'T2', 'argv 契约无法验证');
  const { createDopAdapter } = await load('dop-adapter.mjs');
  const calls = [];
  const runner = {
    run: async ({ bin, args }) => {
      calls.push({ bin, args: [...args] });
      return { exitCode: 0, stdout: '{}', stderr: '', durationMs: 1, timedOut: false };
    },
  };
  const adapter = createDopAdapter({ runner, dopBin: '/opt/corp/dop', dopEndpoint: undefined });
  assert.equal(typeof adapter.readChange, 'function');
  assert.equal(typeof adapter.listChanges, 'function');
  for (const forbidden of ['done', 'create', 'update', 'delete', 'close']) {
    assert.ok(!(forbidden in adapter), `dop 适配器不得有 ${forbidden} 通道（§5.3 禁项）`);
  }
  await adapter.readChange({ changeId: 'ARD123456' });
  const call = calls.at(-1);
  assert.equal(call.bin, '/opt/corp/dop');
  assert.deepEqual(call.args.slice(0, 3), ['change', 'view', 'ARD123456'], '固定命令面 change view <id>');
  assert.ok(call.args.includes('--json'), '必须要求结构化输出 --json');
  assert.ok(!call.args.includes('-j'), '不得用短名 -j：内网真 CLI 只认 --json（2026-10 实测）');
  assert.ok(!call.args.includes('--endpoint'), '未注入 endpoint 不得拼该参数');

  const withEndpoint = createDopAdapter({ runner, dopBin: '/opt/corp/dop', dopEndpoint: 'https://dop.example/api' });
  await withEndpoint.readChange({ changeId: 'ARD123456' });
  assert.ok(calls.at(-1).args.includes('--endpoint'), '注入 endpoint 时必须显式传递');
});

test('gh 适配器：读写命令面固定、无 merge/close/release/workflow/api 通道', async (t) => {
  if (!existsSync(pkgPath('src', 'gh-adapter.mjs'))) return deferred(t, 'gh-adapter.mjs', 'T2', 'argv 契约无法验证');
  const { createGhAdapter } = await load('gh-adapter.mjs');
  const calls = [];
  const runner = {
    run: async ({ bin, args }) => {
      calls.push({ bin, args: [...args] });
      return { exitCode: 0, stdout: '{"number":1,"state":"open"}', stderr: '', durationMs: 1, timedOut: false };
    },
  };
  const gh = createGhAdapter({ runner, ghBin: 'gh' });
  for (const forbidden of ['merge', 'close', 'release', 'workflow', 'api', 'delete', 'edit']) {
    assert.ok(!(forbidden in gh), `gh 适配器不得有 ${forbidden} 通道（AC-19 禁项）`);
  }
  await gh.readRepository({ repo: 'acme/demo' });
  assert.equal(calls.at(-1).bin, 'gh');
  assert.deepEqual(calls.at(-1).args.slice(0, 3), ['repo', 'view', 'acme/demo']);
  await gh.listOpenIssues({ repo: 'acme/demo' });
  const listArgs = calls.at(-1).args;
  assert.deepEqual(listArgs.slice(0, 2), ['issue', 'list']);
  assert.equal(listArgs[listArgs.indexOf('--state') + 1], 'open', 'open 对象清单必须只查 open');
  assert.ok(listArgs.includes('--limit') && listArgs.includes('100'), '清单需固定上限');
  await gh.createIssue({ repo: 'acme/demo', title: '门禁回读', body: '正文' });
  const createArgs = calls.at(-1).args;
  assert.deepEqual(createArgs.slice(0, 2), ['issue', 'create']);
  assert.ok(createArgs.includes('--title') && createArgs.includes('--body'), '建 Issue 必须显式带标题与正文');
  await gh.commentIssue({ target: 'acme/demo#12', body: '审查记录' });
  assert.deepEqual(calls.at(-1).args.slice(0, 3), ['issue', 'comment', 'acme/demo#12']);
});

test('子进程出口不允许 shell 拼串、不允许同步 exec（跨模块安全底线）', (t) => {
  const offenders = [];
  for (const file of srcFiles()) {
    const text = srcText(file);
    if (/shell\s*:\s*true/.test(text)) offenders.push(`${file}: shell:true`);
    if (/execSync\s*\(/.test(text)) offenders.push(`${file}: execSync`);
    if (/['"`]sh['"`]\s*,\s*['"`]-c['"`]/.test(text)) offenders.push(`${file}: sh -c`);
    if (/child_process['"`]\s*\)\s*;?\s*\n?\s*const\s*\{[^}]*\bexec\b(?!File)/.test(text)) offenders.push(`${file}: 引入 exec`);
  }
  assert.deepEqual(offenders, [], `只允许 execFile + shell:false：${offenders.join('; ')}`);
  if (!existsSync(pkgPath('src', 'cli-runner.mjs'))) deferred(t, 'cli-runner.mjs', 'T1', '出口实现未落地，仅保留静态断言');
});

test('固定 argv 白名单：禁项在代码里不存在（不靠运行时拦截）', () => {
  const banned = [
    [/['"`]pr['"`]\s*,\s*['"`]merge['"`]/, 'pr merge'],
    [/['"`]pr['"`]\s*,\s*['"`]close['"`]/, 'pr close'],
    [/['"`]issue['"`]\s*,\s*['"`]close['"`]/, 'issue close'],
    [/['"`]change['"`]\s*,\s*['"`]done['"`]/, 'change done'],
    [/['"`]change['"`]\s*,\s*['"`]create['"`]/, 'change create'],
    [/['"`]gh['"`]\s*,\s*['"`]api['"`]/, 'gh api'],
    [/['"`]workflow['"`]/, 'workflow'],
    [/['"`]release['"`]/, 'release'],
  ];
  const hits = [];
  for (const file of srcFiles()) {
    const text = srcText(file);
    for (const [pattern, label] of banned) {
      if (pattern.test(text)) hits.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(hits, [], `禁项不得出现在命令面代码中：${hits.join('; ')}`);
});

test('门禁唯一真源：未登记动作零下游调用，拒绝可见', async (t) => {
  if (!existsSync(pkgPath('src', 'policy-guard.mjs'))) return deferred(t, 'policy-guard.mjs', 'T5', '门禁适配未落地');
  const { createPolicyGuard, GUARD_STATUSES } = await load('policy-guard.mjs');
  assert.ok(Array.from(GUARD_STATUSES).includes('denied'), 'GUARD_STATUSES 必须含 denied');
  let downstream = 0;
  const openPolicy = {
    catalog: new Map([['issue.create_or_update', { action: 'issue.create_or_update', kind: 'write', enabled: true }]]),
    executeAction: async (ctx, action, exec, operation) => operation(),
  };
  const openGuard = createPolicyGuard({ policy: openPolicy });
  const allowed = await openGuard.execute(
    { ctx: {}, action: 'issue.create_or_update', target: 'acme/demo', egress: 'platform-write' },
    async () => {
      downstream += 1;
      return { status: 'done' };
    },
  );
  const allowedStatus = allowed?.status ?? allowed?.value?.status;
  assert.equal(allowedStatus, 'done', `门禁放行后应返回下游结果，实际 ${JSON.stringify(allowed)}`);

  const deniedPolicy = {
    catalog: new Map(),
    executeAction: async () => {
      throw new Error('未登记动作不得进入策略执行');
    },
  };
  const deniedGuard = createPolicyGuard({ policy: deniedPolicy });
  const before = downstream;
  const denied = await deniedGuard.execute(
    { ctx: {}, action: 'pr.create_or_update', target: 'acme/demo', egress: 'platform-write' },
    async () => {
      downstream += 1;
      return { status: 'done' };
    },
  );
  assert.equal(denied?.status, 'denied', `未登记动作必须 denied，实际 ${JSON.stringify(denied)}`);
  assert.equal(downstream, before, '被拒绝时下游零调用（AC-5）');
});

test('两套词表不混用：平台动作四态与流程态分离', async (t) => {
  if (!existsSync(pkgPath('src', 'actions.mjs'))) return deferred(t, 'actions.mjs', 'T5', '状态词表无法验证');
  const { ACTION_STATUSES } = await load('actions.mjs');
  assert.deepEqual(Array.from(ACTION_STATUSES), ['done', 'failed', 'denied', 'unknown']);
  for (const flow of ['blocked', 'skipped', 'stale', 'pending', 'ready']) {
    assert.ok(!ACTION_STATUSES.includes(flow), `流程态 ${flow} 不得混入平台动作词表（§7.1）`);
  }
  const text = srcText('actions.mjs');
  assert.match(text, /READBACK_MISMATCH/, '回读不一致必须有可见原因 READBACK_MISMATCH（§7.7 第 7 行）');
  assert.match(text, /reused/, '命中已有 open 对象必须标 reused 并复用（§7.7 第 8 行）');
  assert.match(text, /denied/, '四状态中的 denied 必须有产出点（dop 无澄清写命令，§5.3）');
});

test('幂等键：同标题不同空白/大小写同键，对象类型与变更号不同则异键', async (t) => {
  if (!existsSync(pkgPath('src', 'actions.mjs'))) return deferred(t, 'actions.mjs', 'T5', '幂等键无法验证');
  const { idempotencyKey } = await load('actions.mjs');
  const key = idempotencyKey({ change: 'ARD123456', objectType: 'issue', title: ' Fix   Gate. ' });
  assert.match(String(key), /^[0-9a-f]{16}$/, `幂等键应为 16 位十六进制，实际 ${key}`);
  assert.equal(idempotencyKey({ change: 'ARD123456', objectType: 'issue', title: 'fix gate' }), key);
  assert.notEqual(idempotencyKey({ change: 'ARD123456', objectType: 'pr', title: 'fix gate' }), key);
  assert.notEqual(idempotencyKey({ change: 'ARD999999', objectType: 'issue', title: 'fix gate' }), key);
});

test('入口只收变更号：格式非法早退，命令对模型不可调用', async (t) => {
  if (!existsSync(pkgPath('src', 'entry.mjs'))) return deferred(t, 'entry.mjs', 'T7', '入口未落地');
  const { ENTRY_NAME, parseChangeId } = await load('entry.mjs');
  assert.equal(ENTRY_NAME, 'devops-change');
  const text = srcText('entry.mjs');
  assert.match(text, /modelInvocable\s*:\s*false/, '命令必须 modelInvocable:false（AC-10）');
  const ok = parseChangeId('ARD123456');
  assert.equal(ok.ok, true);
  assert.equal(ok.changeId, 'ARD123456');
  for (const bad of ['', '   ', 'ARD 123456', '见附件']) {
    const result = parseChangeId(bad);
    assert.equal(result.ok, false, `非法输入「${bad}」必须早退`);
    assert.equal(result.reason, 'MISSING_OR_INVALID');
    assert.match(String(result.expectedFormat), /变更号/, '早退必须给出期望格式');
  }
});

test('产物落盘：kind 枚举、front matter 六字段定序、路径逃逸拒绝', async (t) => {
  if (!existsSync(pkgPath('src', 'artifacts.mjs'))) return deferred(t, 'artifacts.mjs', 'T7', '唯一落盘出口未落地');
  const { ARTIFACT_KINDS, artifactPath, renderFrontMatter } = await load('artifacts.mjs');
  const kinds = Array.isArray(ARTIFACT_KINDS) ? ARTIFACT_KINDS : Object.values(ARTIFACT_KINDS);
  for (const kind of ['context', 'clarify', 'plan', 'review', 'report']) {
    assert.ok(kinds.includes(kind), `产物 kind 缺 ${kind}（§4.4）`);
  }
  const root = path.join(path.sep, 'tmp', 'forge-devops-selfcheck');
  const file = artifactPath({ repoRoot: root, changeId: 'ARD123456', kind: 'report' });
  assert.ok(file.startsWith(root), `产物必须落在目标仓库内：${file}`);
  assert.ok(file.split(path.sep).join('/').endsWith('.dsh-devops/ARD123456/report.md'), `产物路径不符：${file}`);
  const header = renderFrontMatter({
    changeId: 'ARD123456',
    kind: 'report',
    generatedAt: '2026-10-28T12:00:00.000Z',
    sourceType: 'mock',
    sourceRevision: 'dop:abcdef123456',
    commit: 'abcdef1',
  });
  const order = ['change', 'kind', 'generatedAt', 'sourceType', 'sourceRevision', 'commit'];
  const positions = order.map((field) => header.indexOf(`${field}:`));
  positions.forEach((position, index) => assert.ok(position >= 0, `front matter 缺字段 ${order[index]}`));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    'front matter 六字段必须定序（§4.4）',
  );
  assert.equal(header.trimEnd().endsWith('---'), true, 'front matter 需以 --- 收尾');
  const escapeRejected =
    throws(() => artifactPath({ repoRoot: root, changeId: '../evil', kind: 'report' })) ||
    throws(() => artifactPath({ repoRoot: root, changeId: 'ARD123456', kind: '../evil' }));
  assert.ok(escapeRejected, '产物路径逃逸必须拒绝（§7.7 第 10 行）');
});

test('提交信息前缀：不合规拒绝且不改写', async (t) => {
  if (!existsSync(pkgPath('src', 'commit-message.mjs'))) return deferred(t, 'commit-message.mjs', 'T6', '提交信息校验未落地');
  const { assertCommitMessage } = await load('commit-message.mjs');
  const good = assertCommitMessage({ changeId: 'ARD123456', message: '[ARD123456] 门禁回读改为 unknown' });
  assert.equal(good.ok, true);
  for (const message of ['门禁回读改为 unknown', '[ARD999999] 错号', '[ARD123456]']) {
    const result = assertCommitMessage({ changeId: 'ARD123456', message });
    assert.equal(result.ok, false, `不合规提交信息必须拒绝：${message}`);
    assert.equal(result.reason, 'PREFIX_MISSING');
    assert.match(String(result.expectedFormat), /^\[ARD123456\]/, '拒绝时必须给出期望格式');
  }
});

test('审查分栏：人工栏只由确认函数写，commit 变化判 stale', async (t) => {
  if (!existsSync(pkgPath('src', 'review.mjs'))) return deferred(t, 'review.mjs', 'T6', '审查记录未落地');
  const { MODEL_TIERS, assertModelRecorded, buildReviewRecord, recordHumanConfirmation, reviewStaleness } = await load('review.mjs');
  for (const tier of ['deepseek-v4-pro', 'gpt-6.1-sol', 'gpt-6-astra', 'muse-spark-1.3-contributor']) {
    assert.ok(Array.from(MODEL_TIERS).includes(tier), `模型档位缺 ${tier}（§7.5）`);
  }
  assert.doesNotThrow(() =>
    assertModelRecorded({ modelName: 'muse-spark-1.3-contributor', degraded: false, note: '' }),
  );
  assert.throws(
    () => assertModelRecorded({ modelName: 'unknown-model', degraded: false, note: '' }),
    '档外模型未标 degraded 必须拒绝记录',
  );
  const review = buildReviewRecord({
    changeId: 'ARD123456',
    commit: 'abcdef1',
    model: { modelName: 'muse-spark-1.3-contributor', degraded: false },
    findings: ['门禁回读缺失'],
    risks: ['弱网重试'],
    opinion: '可以提测',
    conclusion: 'approve',
  });
  assert.equal(review.model.name, 'muse-spark-1.3-contributor', '模型记录在顶层 model{name,tier,degraded}（§4.3）');
  assert.deepEqual(review.humanColumn, [], 'AI 结论不得预填人工确认栏（AC-18）');
  const confirmed = recordHumanConfirmation(review, {
    by: 'hosea',
    at: '2026-10-28T12:00:00.000Z',
    commit: 'abcdef1',
    decision: 'confirmed',
    note: '已看过风险项',
  });
  assert.equal(confirmed.humanColumn.at(-1).by, 'hosea');
  assert.deepEqual(confirmed.aiColumn, review.aiColumn, '人工确认不得改写 AI 栏');
  assert.equal(reviewStaleness(confirmed, 'abcdef1'), 'current');
  assert.equal(reviewStaleness(confirmed, 'deadbee9'), 'stale');
});

test('报告：关闭就绪只判定不执行，证据项字段齐全', async (t) => {
  if (!existsSync(pkgPath('src', 'report.mjs'))) return deferred(t, 'report.mjs', 'T6', '报告模块未落地');
  const { issueCloseReadiness } = await load('report.mjs');
  const readiness = issueCloseReadiness({ criteria: [], prs: [], pending: [], humanConfirmed: false });
  assert.equal(typeof readiness?.ready, 'boolean', 'issueCloseReadiness 必须给出 ready 布尔判定');
  assert.ok(Array.isArray(readiness.missing), 'issueCloseReadiness 必须给出 missing 清单');
  assert.equal(readiness.ready, false, '无证据、无人工确认时不得判定为可关闭');
  assert.deepEqual(Object.keys(readiness).sort(), ['missing', 'ready'], '只判定不执行：返回值不得带动作句柄（AC-19）');
});

test('工具面 9 个：名字与动作映射唯一真源，写工具须 confirm', async (t) => {
  const toolsText = srcText('tools.mjs');
  if (!toolsText.includes('forge_devops_change_context')) {
    return deferred(t, 'tools.mjs', 'T7', '聚合工具与写工具尚未加入工具面');
  }
  const expected = [
    'forge_devops_change_read',
    'forge_devops_repository_read',
    'forge_devops_issue_read',
    'forge_devops_pr_read',
    'forge_devops_change_context',
    'forge_devops_issue_write',
    'forge_devops_pr_write',
    'forge_devops_clarify_write',
    'forge_devops_artifact_write',
  ];
  const found = new Set(toolsText.match(/forge_devops_[a-z_]+/g) ?? []);
  assert.equal(found.size, 9, `工具面应为 9 个，实际识别到 ${found.size}：${[...found].join(', ')}`);
  for (const name of expected) assert.ok(found.has(name), `工具面缺 ${name}（§5.2）`);
  assert.match(toolsText, /confirm/, '写工具必须要求 confirm{repo,object}（§5.2）');
  for (const action of ['issue.create_or_update', 'pr.create_or_update', 'change.clarification.write']) {
    assert.ok(toolsText.includes(action), `工具→动作映射表缺写动作 ${action}（§5.2）`);
  }
  const noCommandFace = srcFiles().filter((file) => /no-command-face/.test(srcText(file)));
  assert.ok(noCommandFace.length > 0, "commands 服务缺失时入口状态必须是 'no-command-face'（§7.7 第 12 行）");
  const { buildDevopsTools } = await load('tools.mjs');
  assert.equal(typeof buildDevopsTools, 'function');
});

test('装配只做装配：顶层不读环境变量，策略仍是硬依赖', () => {
  const indexText = srcText('index.mjs');
  assert.ok(!/process\.env/.test(indexText), 'index.mjs 顶层不得读取环境变量（配置由 rawConfig 注入）');
  assert.ok(!/logs\/teamflow/.test(indexText), '装配层不得引用运行日志目录');
  assert.match(indexText, /inject\s*=\s*\[[^\]]*['"]policy['"]/, '策略服务仍是硬依赖（inject 含 policy）');
  assert.match(indexText, /['"]tools['"]/, '工具面依赖需显式声明');
});

test('装配层组合根：index 生产流程协作者并以服务键提供，flow 组合 runner 与两个适配器（D-1）', () => {
  const indexText = srcText('index.mjs');
  assert.match(indexText, /createPolicyGuard/u, '门禁适配必须由装配层创建（蓝图：配置→runner→适配器→guard→service）');
  assert.match(indexText, /createDevopsFlow/u, '流程协作者必须在包内生产，不能只靠宿主注入');
  assert.match(indexText, /provide\(\s*FLOW_KEY/u, '流程协作者要以 devopsFlow 服务键提供，宿主与工具面才能取到');
  const flowText = srcText('flow.mjs');
  for (const name of ['createCliRunner', 'createDopAdapter', 'createGhAdapter']) {
    assert.match(flowText, new RegExp(name, 'u'), `flow.mjs 未组合 ${name}：流程模块会重新变成孤儿`);
  }
});

test('交付卫生：日志与产物目录必须被忽略（未补记 DEFERRED 到 T1）', (t) => {
  const ignoreFile = path.join(REPO_ROOT, '.gitignore');
  assert.ok(existsSync(ignoreFile), '仓库根缺 .gitignore');
  const ignore = read(ignoreFile);
  const missing = ['logs/', '.dsh-devops/'].filter((entry) => !new RegExp(`(^|\\n)\\s*/?${entry.replace('.', '\\.')}`, 'i').test(ignore));
  if (missing.length > 0) {
    deferred(t, '.gitignore', 'T1', `缺 ${missing.join('、')}（R6：运行日志与本地产物不得进提交）`);
  }
});

// ---------------------------------------------------------------------------
// r3 · CLI 路径自动发现：就地扩展上面的扫描口径（不新建检查器）
// ---------------------------------------------------------------------------

/** 样例里不允许出现的形态：本机用户目录（真实身份）与运行日志目录。通用盘符样例不在此列。 */
const MACHINE_PATH_PATTERNS = [
  [/\/Users\/[A-Za-z][\w.-]*\//, 'POSIX 本机用户目录'],
  [/\/home\/[a-z][\w.-]*\//, 'POSIX 本机用户目录'],
  [/[A-Za-z]:\\+Users\\+/i, 'Windows 本机用户目录'],
];

test('r3 补丁层与 README 无本机路径样例；补丁层不写死 endpoint（AC-10）', () => {
  const scanned = [
    { name: 'cordis.patch.yml', hardcodedEndpoint: true },
    { name: 'README.md', hardcodedEndpoint: false },
  ];
  for (const { name, hardcodedEndpoint } of scanned) {
    const text = read(pkgPath(name));
    const hits = MACHINE_PATH_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
    if (hardcodedEndpoint && /https?:\/\//.test(text)) hits.push('硬编码 endpoint');
    assert.deepEqual(hits, [], `${name} 出现 ${hits.join('、')}：示例只能用通用形态或 corp.example，补丁层不写默认值`);
  }
});

test('r3 工具面不把取值型 access 字段拼进错误 detail（AC-10 回显边界）', () => {
  // 取值型字段：命中路径、endpoint 实值、移动端快照。它们只允许出现在 GET 响应体与页面 DOM。
  const VALUE_CARRIERS = /(?:\bdopBin\b|\bghBin\b|\bdopEndpoint\b|access\.entries|\bentries\s*\[|\.snapshot\s*\()/;
  const leaks = [];
  for (const file of srcFiles()) {
    const text = srcText(file);
    for (const match of text.matchAll(/\bdetail\s*:/g)) {
      const window = text.slice(match.index, match.index + 220);
      if (VALUE_CARRIERS.test(window)) leaks.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.deepEqual(leaks, [], `detail 里出现取值型 access 字段（绝对路径/endpoint 会外泄到工具输出）：${leaks.join(', ')}`);
  const toolHits = ['dopBin', 'ghBin', 'dopEndpoint', 'access.'].filter((key) => srcText('tools.mjs').includes(key));
  assert.deepEqual(toolHits, [], `工具面只认脱敏描述，不得接触 access 快照：${toolHits.join(', ')}`);
});

test('r3 cli-discovery 零子进程：发现只走注入的 fs，不执行任何命令（AC-2、AC-4）', (t) => {
  const file = 'cli-discovery.mjs';
  if (!existsSync(pkgPath('src', file))) return deferred(t, file, 'T1(r3)', '发现模块尚未产出');
  const text = srcText(file);
  const spawners = [
    [/child_process/, 'child_process'],
    [/\bexecSync\b/, 'execSync'],
    [/\bexecFile\b/, 'execFile'],
    [/\bspawn(?:Sync)?\b/, 'spawn'],
    [/shell\s*:\s*true/, 'shell:true'],
  ];
  const hits = spawners.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  assert.deepEqual(hits, [], `${file} 不得执行子进程（发现必须在装配期完成且零命令）：${hits.join('; ')}`);
});

test('r3 字段规则唯一出口：cli-config 复用 runtime-config 的校验，且自身零 IO、零宿主依赖（AC-3）', (t) => {
  if (!existsSync(pkgPath('src', 'cli-config.mjs'))) return deferred(t, 'cli-config.mjs', 'T2(r3)', '三层合并模块尚未产出');
  const text = srcText('cli-config.mjs');
  assert.match(
    text,
    /import\s*\{[^}]*\bvalidateConfigField\b[^}]*\}\s*from\s*'\.\/runtime-config\.mjs'/,
    'cli-config 必须 import validateConfigField：环境变量层与页面层若各写一套规则，迟早漂移',
  );
  // 纯函数留一个只管合并与文案的模块：fs / platform / pathModule 全部由调用方注入，才能离线矩阵化。
  for (const dep of ['node:child_process', 'node:fs', 'node:os', 'node:path', 'node:net', 'node:http']) {
    assert.ok(!text.includes(dep), `cli-config 不得直接依赖 ${dep}（应由入参注入，保持纯函数可测）`);
  }
});

test('r8 入口形态单点定义：全仓只有 entry-form 声明 WRAPPER_SUFFIXES，其余模块全是消费者（AC-4）', (t) => {
  const gate = 'entry-form.mjs';
  if (!existsSync(pkgPath('src', gate))) return deferred(t, gate, 'T1(r8)', '入口形态单点模块尚未产出');
  const declaredIn = srcFiles().filter((name) => /export\s+const\s+WRAPPER_SUFFIXES\b/.test(srcText(name)));
  assert.deepEqual(
    declaredIn,
    [gate],
    `WRAPPER_SUFFIXES 只能有一处定义（否则保存侧与发现侧会各自演进）：${declaredIn.join(', ')}`,
  );
  // 「可直接启动」的判定同样只能有一份实现：保存侧 import 复用，发现侧再导出。
  const execDeclaredIn = srcFiles().filter((name) => /export\s+function\s+isDirectlyExecutable\b/.test(srcText(name)));
  assert.deepEqual(
    execDeclaredIn,
    [gate],
    `isDirectlyExecutable 只能有一处实现（AC-4 的硬要求）：${execDeclaredIn.join(', ')}`,
  );
  assert.ok(
    !/export\s+function\s+isDirectlyExecutable\b/.test(srcText('cli-config.mjs')),
    'cli-config 不得自带可执行判定，只能消费 entry-form',
  );
  // 校验侧必须 import 复用判定，不得再抄一张后缀表或自己写后缀规则。
  assert.match(
    srcText('cli-config.mjs'),
    /import\s*\{[^}]*\bisDirectlyExecutable\b[^}]*\}\s*from\s*'\.\/entry-form\.mjs'/,
    'cli-config 必须 import entry-form 的入口形态判定，不得自带一份副本',
  );
  assert.ok(
    !/\.cmd['"]?\s*,\s*['"]\.bat/u.test(srcText('cli-config.mjs')),
    'cli-config 不得再内联一张 .cmd/.bat 后缀表',
  );
  // 发现侧必须是「再导出」而不是重新声明：既有调用方与测试的 import 面保持不动。
  // 两种等价写法都接受——`export { … } from './entry-form.mjs'`，或 import 后再 export。
  const discoveryText = srcText('cli-discovery.mjs');
  const reExportsDirectly = /export\s*\{[^}]*\bisDirectlyExecutable\b[^}]*\}\s*from\s*'\.\/entry-form\.mjs'/.test(discoveryText);
  const importsThenExports =
    /import\s*\{[^}]*\bisDirectlyExecutable\b[^}]*\}\s*from\s*'\.\/entry-form\.mjs'/.test(discoveryText) &&
    /export\s*\{[^}]*\bisDirectlyExecutable\b[^}]*\}/.test(discoveryText);
  assert.ok(
    reExportsDirectly || importsThenExports,
    'cli-discovery 必须从 entry-form 再导出形态判定（契约面不变，定义只有一份）',
  );
  assert.ok(
    !/export\s+function\s+wrapperSuffixOf\b/.test(discoveryText),
    'wrapperSuffixOf 也不得在发现模块重新实现（唯一定义在 entry-form.mjs）',
  );
});

test('r3 配置页客户端不打印、不持久化路径（AC-10、AC-7）', (t) => {
  if (!existsSync(CLIENT_FILE)) return deferred(t, 'client.js', 'T5(r3)', '配置页尚未产出');
  const text = read(CLIENT_FILE);
  const offenders = [];
  if (/\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(/.test(text)) offenders.push('console.*（路径会被打印进宿主控制台）');
  if (/\b(?:localStorage|sessionStorage)\b/.test(text)) offenders.push('web storage（路径会被持久化出配置页）');
  if (/document\.cookie/.test(text)) offenders.push('document.cookie');
  for (const [pattern, label] of MACHINE_PATH_PATTERNS.slice(0, 3)) {
    if (pattern.test(text)) offenders.push(`${label}字面量`);
  }
  assert.deepEqual(offenders, [], `客户端只允许把路径渲染进本页 DOM，不得打印或持久化：${offenders.join('; ')}`);
});

test('r3 settings.section 注册一律经 slots.inject 等父条目声明（D-2 全仓类面）', (t) => {
  if (!existsSync(CLIENT_FILE)) return deferred(t, 'client.js', 'T5(r3)', '配置页尚未产出');
  // 缺陷类别：往父条目声明的槽位里**裸注册**。宿主在槽位晚于 apply 声明时直接抛
  // `slot "..." is not declared`，整片分区消失。全仓每个 client.js 都要先等声明。
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const clients = readdirSync(packagesDir)
    .map((name) => path.join(packagesDir, name, 'client.js'))
    .filter((file) => existsSync(file));
  const offenders = [];
  for (const file of clients) {
    const text = read(file);
    if (!/name:\s*'settings\.section'/u.test(text)) continue; // 不往该槽位注册的客户端无关
    if (!/slots\.inject\(\s*'settings\.section'/u.test(text)) {
      offenders.push(`${path.relative(REPO_ROOT, file)}：注册 settings.section 但未用 slots.inject 等声明`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});

test('r3 清单声明客户端半：dsh.client + ./client 导出 + 发布白名单含 client.js（否则安装后 404）', (t) => {
  const manifest = JSON.parse(read(pkgPath('package.json')));
  const declared = Boolean(manifest.dsh?.client);
  if (!existsSync(CLIENT_FILE) && !declared) return deferred(t, 'client.js', 'T5(r3)', '客户端半尚未产出');
  assert.ok(existsSync(CLIENT_FILE), '清单声明了 dsh.client 但包内没有 client.js');
  assert.equal(manifest.exports?.['./client'], './client.js', '必须导出 ./client 供宿主装载页面');
  assert.equal(manifest.dsh?.client?.platform, 'web', 'dsh.client.platform 必须是 web');
  const inject = manifest.dsh?.client?.inject ?? [];
  for (const slot of ['slots', 'locale']) assert.ok(inject.includes(slot), `dsh.client.inject 缺 ${slot}（缺一项宿主就不装配客户端半）`);
  assert.ok(manifest.files?.includes('client.js'), '发布白名单必须含 client.js（否则安装后页面 404）');
});

test('r3 文档口径 UI 优先：README 配置页在前、六键表齐全、补丁注释同步改写（AC-12）', (t) => {
  if (!r3Landed()) return deferred(t, 'README.md', 'T4/T6(r3)', 'r3 装配尚未落地，文档口径检查随波次生效');
  const readme = read(pkgPath('README.md'));
  const pageAt = readme.indexOf('配置页');
  const envAt = readme.indexOf('环境变量');
  assert.ok(pageAt >= 0, 'README 必须给出配置页进入路径（AC-12：不设环境变量也能装好可用）');
  assert.ok(envAt === -1 || pageAt < envAt, `README 必须配置页在前、环境变量降为 CI 兜底（配置页@${pageAt}、环境变量@${envAt}）`);
  for (const field of ['dopBin', 'dopEndpoint', 'ghBin', 'ghOwner', 'sourceType', 'timeoutMs']) {
    assert.ok(readme.includes(field), `README 配置项表缺 ${field}（六键表）`);
  }
  assert.match(read(pkgPath('cordis.patch.yml')), /配置页/, '补丁层注释口径必须改为「配置页优先、环境变量兜底」（旧口径会持续误导运维）');
});

test('r3 零回退：READ_REASONS 不加码，只读面语义与工具数不变（AC-14）', async () => {
  const readModule = await load('read.mjs');
  const baselineReasons = [
    'COMMAND_FAILED',
    'COMMAND_TIMEOUT',
    'MALFORMED_RESULT',
    'MISSING_SOURCE_REVISION',
    'MISSING_TARGET',
    'NO_READER',
    'NO_STRUCTURED_STATUS',
    'POLICY_ACTION_UNREGISTERED',
    'POLICY_DENIED',
    'POLICY_REQUIRED',
    'UNKNOWN_ACTION',
  ];
  assert.deepEqual(
    Object.keys(readModule.READ_REASONS).sort(),
    baselineReasons,
    '本次需求不得新增只读原因码：细因放 detail.reason（cli-discovery 未命中仍是 NO_READER）',
  );
  const toolsText = srcText('tools.mjs');
  assert.equal(new Set(toolsText.match(/forge_devops_[a-z_]+/g) ?? []).size, 9, '工具面仍是 9 个（配置页只写配置，不新增工具）');
  const indexText = srcText('index.mjs');
  assert.match(indexText, /NO_READER/, '未命中仍以 NO_READER 失败（fail closed 不变）');
});
