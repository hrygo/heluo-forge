import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHANGE_SOURCE_TYPES,
  CONTEXT_REASONS,
  CONTEXT_STATUSES,
  ContextError,
  NATIVE_ALIASES,
  RELEASE_RULE,
  aliasChangeRecord,
  buildContextCard,
  firstReleaseInfo,
  normalizeChangeRecord,
  renderContextCard,
} from '../src/change-context.mjs';
import { DevopsReadError, READ_REASONS } from '../src/read.mjs';
import { RESOLVE_REASONS, resolveBuildingRepository } from '../src/repository-resolver.mjs';

const AT = '2026-10-28T10:00:00+08:00';

/**
 * 原生字段夹具：按 UAT 报告描述的形状构造（`code`/`state`/`summary`/`userStory` + 缺 `acceptance_criteria`），
 * **非企业环境导出**，取证只能记 `sourceType: 'mock'`（夹具文件内的 `_fixture` 也这样标）。
 */
const NATIVE_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/dop-change-native.json', import.meta.url), 'utf8'));

/** 夹具内联：dop 输出夹具归 T2 所有（`test/fixtures/`），这里只放本模块要吃的契约样本。 */
const ARD123456 = {
  id: 'ARD123456',
  title: '用户测试demo',
  status: 'open',
  type: 'feature',
  owner: 'zhangsan',
  description: '用户测试 demo - 用于验证 oh-my-sdd 端到端流程',
  created_at: '2026-07-06T10:00:00+08:00',
  acceptance_criteria: ['可以走完 SDD 5 环流程', 'openspec/specs/ 被 archive merge 更新', 'gh issue + PR 自动关联'],
  sub_systems: [{ code: 'ARD.ard-sdk', name: '智能研发平台.AI原生框架套件' }],
  user_stories: [
    {
      id: '1001',
      code: 'US-95376',
      title: '用户测试 demo 故事',
      type: 'feature',
      state: 'open',
      stage: '开发中',
      team: '智能研发平台',
      assignee: { name: '李四' },
      business_owner: '王五',
      release_info: {
        release_num: 'R20260620001',
        release_name: '用户测试 demo 排期',
        release_date: '2026-06-20',
        release_stage: 'dev',
      },
    },
  ],
};

const ARD222222 = {
  id: 'ARD222222',
  title: '信用卡积分兑换功能',
  status: 'open',
  type: 'feature',
  owner: 'lisi',
  description: '用户可以使用信用卡积分兑换商品/服务',
  created_at: '2026-07-06T11:00:00+08:00',
  acceptance_criteria: ['用户在 app 看到积分余额', '可选择商品兑换', '兑换成功后扣减积分'],
  sub_systems: [{ code: 'CARD.points-mall', name: '信用卡中心.积分商城子系统' }],
  user_stories: [
    { id: '2001', code: 'US-10001', title: '积分余额查询', state: 'open', stage: '待开发', release_info: null },
    {
      id: '2002',
      code: 'US-10002',
      title: '积分兑换商品',
      state: 'open',
      stage: '待开发',
      release_info: {
        release_num: 'R20260620002',
        release_name: '积分商城首期上线',
        release_date: '2026-07-31',
        release_stage: 'ga',
      },
    },
  ],
};

const DOP_SOURCE = { kind: 'dop', command: 'dop change view ARD222222 --json', at: AT, sourceRevision: 'dop:abcdef123456', sourceType: 'mock' };
const GH_SOURCE = { kind: 'gh', command: 'gh repo list --limit 100 ---jsonson nameWithOwner', at: AT, sourceRevision: 'gh:2026-10-28T09:00:00+08:00', sourceType: 'mock' };

const normalize = (raw = ARD222222) => normalizeChangeRecord(raw, { at: AT });
const buildingOf = (change, visibleRepos) => resolveBuildingRepository({ change, visibleRepos });
const READY_REPOS = [{ nameWithOwner: 'acme/points-mall', description: '积分商城首期' }];
const reject = (fn, code) =>
  assert.throws(fn, (error) => error instanceof ContextError && error.code === code, `期望 ${code}`);

test('2026-07-06 字段契约全覆盖映射（含关联人对象与排期）', () => {
  const change = normalizeChangeRecord(ARD123456, { at: AT, sourceType: 'mock', expectedId: 'ARD123456' });

  assert.equal(change.changeId, 'ARD123456');
  assert.equal(change.title, '用户测试demo');
  assert.equal(change.status, 'open');
  assert.equal(change.type, 'feature');
  assert.equal(change.owner, 'zhangsan');
  assert.equal(change.description, '用户测试 demo - 用于验证 oh-my-sdd 端到端流程');
  assert.equal(change.createdAt, '2026-07-06T10:00:00+08:00');
  assert.deepEqual(change.acceptanceCriteria, [
    { index: 1, text: '可以走完 SDD 5 环流程' },
    { index: 2, text: 'openspec/specs/ 被 archive merge 更新' },
    { index: 3, text: 'gh issue + PR 自动关联' },
  ]);
  assert.deepEqual(change.subSystems, [{ code: 'ARD.ard-sdk', name: '智能研发平台.AI原生框架套件' }]);
  assert.deepEqual(change.userStories, [
    {
      id: '1001',
      code: 'US-95376',
      title: '用户测试 demo 故事',
      type: 'feature',
      state: 'open',
      stage: '开发中',
      team: '智能研发平台',
      assignee: '李四',
      businessOwner: '王五',
      releaseInfo: {
        releaseNum: 'R20260620001',
        releaseName: '用户测试 demo 排期',
        releaseDate: '2026-06-20',
        releaseStage: 'dev',
      },
    },
  ]);
  assert.deepEqual(change.missingFields, []);
  assert.equal(change.observedAt, AT);
  assert.equal(change.sourceType, 'mock');
  assert.match(change.sourceRevision, /^dop:[0-9a-f]{12}$/);
  assert.equal(change.raw, ARD123456);
});

test('release_info 取首个非空：ARD222222 跳过空排期与 ARD123456 单故事全非空走同一函数', () => {
  const change = normalize(ARD222222);
  assert.equal(change.releaseInfo.storyId, 'US-10002');
  assert.equal(change.releaseInfo.rule, RELEASE_RULE);
  assert.deepEqual(change.releaseInfo.value, {
    releaseNum: 'R20260620002',
    releaseName: '积分商城首期上线',
    releaseDate: '2026-07-31',
    releaseStage: 'ga',
  });
  assert.equal(change.releaseInfo.value, change.releaseInfo.releaseInfo, 'value 与 releaseInfo 必须是同一份数据');
  assert.equal(change.userStories[0].releaseInfo, null);

  const single = normalize(ARD123456);
  assert.equal(single.releaseInfo.storyId, 'US-95376');
  assert.equal(single.releaseInfo.value.releaseNum, 'R20260620001');
});

test('release_info 全空则无排期（不取第一项凑数；wrapper 的改名也不吸收）', () => {
  assert.equal(firstReleaseInfo([]), null);
  assert.equal(
    firstReleaseInfo([
      { id: 'S1', release_info: {} },
      { id: 'S2', release_info: { release_num: '  ', release_name: '' } },
    ]),
    null,
  );
  assert.equal(firstReleaseInfo([{ code: 'Y', release: { number: 'R1', name: '排期' } }]), null);

  const change = normalizeChangeRecord(
    {
      ...ARD222222,
      user_stories: [
        { id: 'S1', title: '无排期一', release_info: null },
        { id: 'S2', title: '无排期二', release_info: { release_num: '  ', release_name: '' } },
      ],
    },
    { at: AT },
  );
  assert.equal(change.releaseInfo, null);
  assert.equal(change.userStories[0].releaseInfo, null);
});

test('必填字段缺失或类型错误即拒绝（不猜、不补默认值）', () => {
  reject(() => normalizeChangeRecord(null), CONTEXT_REASONS.RECORD_INVALID);
  reject(() => normalizeChangeRecord({}), CONTEXT_REASONS.RECORD_INVALID);
  reject(() => normalizeChangeRecord({ ...ARD123456, id: undefined }), CONTEXT_REASONS.RECORD_INVALID);
  reject(() => normalizeChangeRecord({ ...ARD123456, title: 42 }), CONTEXT_REASONS.RECORD_INVALID);
  reject(() => normalizeChangeRecord({ ...ARD123456, status: undefined }), CONTEXT_REASONS.RECORD_INVALID);
  // 降级不是放松：description 给了就必须是字符串；acceptance_criteria 给了就必须是字符串数组。
  reject(() => normalizeChangeRecord({ ...ARD123456, description: 42 }), CONTEXT_REASONS.RECORD_INVALID);
  reject(() => normalizeChangeRecord({ ...ARD123456, acceptance_criteria: '可以走完 SDD 5 环流程' }), CONTEXT_REASONS.RECORD_INVALID);
  reject(() => normalizeChangeRecord({ ...ARD123456, acceptance_criteria: ['可以走完', 2] }), CONTEXT_REASONS.RECORD_INVALID);
});

// QA Q-1 门禁（缺陷类别：必填字段只校验"类型"、不校验"非空"）。
// 必填 = 存在 + 非空字符串；空标题/空状态不是"平台没给"而是"读不出是哪条"，
// 必须在入口拒——否则空串只会进 missingFields，卡片仍判 ready 继续流转。
test('必填字段为空串即拒绝：空标题/空状态不得降级成 missingFields 继续流转', () => {
  const bad = [
    { code: 'A1', title: '', status: 'open' },
    { code: 'A1', title: '有标题但空状态', status: '' },
    { id: 'A1', title: '   ', status: 'open' },
    { id: 'A1', title: '有标题', status: '  ' },
  ];
  for (const record of bad) {
    reject(() => normalizeChangeRecord(record, { sourceType: 'mock' }), CONTEXT_REASONS.RECORD_INVALID);
  }
  // 反向：非空必填照旧放行，且多余空白被 trim 掉（不是把合法记录一起拒掉）。
  const ok = normalizeChangeRecord({ code: 'A1', title: ' 有标题 ', status: 'open ' }, { sourceType: 'mock' });
  assert.deepEqual([ok.changeId, ok.title, ok.status], ['A1', '有标题', 'open']);
  // 不变量：必填字段永远不会出现在 missingFields（那里只记"平台没给"）。
  const sparse = normalizeChangeRecord({ id: 'A2', title: 't', status: 'open' }, { sourceType: 'mock' });
  assert.ok(!sparse.missingFields.includes('title'));
  assert.ok(!sparse.missingFields.includes('status'));
});

test('description / acceptance_criteria 缺失只降级：进 missingFields，不拒绝整条记录', () => {
  const noDescription = normalizeChangeRecord({ ...ARD123456, description: undefined }, { at: AT });
  assert.equal(noDescription.changeId, 'ARD123456');
  assert.equal(noDescription.description, '');
  assert.ok(noDescription.missingFields.includes('description'));
  assert.ok(!noDescription.missingFields.includes('acceptance_criteria'));

  const noCriteria = normalizeChangeRecord({ id: 'ARD888888', title: '缺验收条件的记录', status: 'open' }, { at: AT });
  assert.deepEqual(noCriteria.acceptanceCriteria, []);
  assert.ok(noCriteria.missingFields.includes('acceptance_criteria'));
  // 既有「平台未提供」渲染分支直接接住降级，不新增卡片机制。
  const rendered = renderContextCard(buildContextCard({ change: noCriteria, building: buildingOf(noCriteria, null) }));
  assert.ok(rendered.includes('平台未提供 `acceptance_criteria`'));
});

test('expectedId 核对读到的就是请求的那条；sourceType 只认 mock/enterprise', () => {
  reject(() => normalizeChangeRecord(ARD123456, { at: AT, expectedId: 'ARD222222' }), CONTEXT_REASONS.ID_MISMATCH);
  reject(() => normalizeChangeRecord(ARD123456, { at: AT, sourceType: 'prod' }), CONTEXT_REASONS.RECORD_INVALID);
  assert.equal(normalizeChangeRecord(ARD123456, { at: AT, expectedId: 'ARD123456' }).changeId, 'ARD123456');
  assert.deepEqual(CHANGE_SOURCE_TYPES, ['mock', 'enterprise']);
  assert.match(normalize(ARD222222).sourceRevision, /^dop:/);
});

test('可选字段缺失进 missingFields（"平台没给"和"我们没读"分得开）', () => {
  const change = normalizeChangeRecord({
    id: 'ARD999999',
    title: '稀疏记录',
    status: 'open',
    description: '只给必填',
    acceptance_criteria: ['只有一条验收'],
  });

  assert.deepEqual(change.missingFields, ['type', 'owner', 'created_at', 'sub_systems', 'user_stories']);
});

test('原生字段别名只有一张表（code/state/summary/userStory），且契约键优先', () => {
  assert.deepEqual({ ...NATIVE_ALIASES }, { code: 'id', state: 'status', summary: 'description', userStory: 'user_stories' });

  const mixed = aliasChangeRecord({
    code: 'ARD123456',
    id: 'ARD123456',
    title: '契约标题',
    summary: '原生摘要',
    state: 'open',
    description: '',
  });
  assert.equal(mixed.title, '契约标题', '契约键有值时别名不得覆盖');
  assert.equal(mixed.description, '原生摘要', '契约键为空串时由 summary 兜底');
  assert.equal(mixed.status, 'open');

  // 纯函数：不改入参（调用方还要按原样派生 sourceRevision）。
  const source = { code: 'ARD1', state: 'open', summary: '摘要' };
  const aliased = aliasChangeRecord(source);
  assert.deepEqual(source, { code: 'ARD1', state: 'open', summary: '摘要' });
  assert.equal(aliased.id, 'ARD1');
  assert.equal(aliased.title, '摘要');
  assert.deepEqual(aliased.user_stories, undefined);
});

test('原生夹具归一（mock 形状）：变更内容、单对象 userStory 与排期可读，缺验收条件只降级', () => {
  const change = normalizeChangeRecord(NATIVE_FIXTURE, { at: AT, sourceType: 'mock' });

  assert.equal(change.changeId, 'ARD777777');
  assert.equal(change.title, '企业原生字段：积分兑换二期');
  assert.equal(change.status, 'open');
  assert.equal(change.description, '企业原生字段：积分兑换二期');
  assert.equal(change.userStories.length, 1, 'userStory 单对象必须转成单元素数组');
  assert.equal(change.userStories[0].code, 'US-20001');
  assert.equal(change.userStories[0].assignee, '李四');
  assert.equal(change.releaseInfo.storyId, 'US-20001');
  assert.equal(change.releaseInfo.value.releaseNum, 'R20260706001');
  assert.deepEqual(change.acceptanceCriteria, []);
  assert.ok(change.missingFields.includes('acceptance_criteria'));
  assert.match(change.sourceRevision, /^dop:/);

  const card = buildContextCard({ change, building: buildingOf(change, null), sources: [] });
  const rendered = renderContextCard(card);
  assert.match(rendered, /^# 上下文卡 — ARD777777/);
  assert.ok(rendered.includes('平台未提供 `acceptance_criteria`'));
  assert.ok(rendered.includes('US-20001'));
  assert.ok(rendered.includes('R20260706001'));
  // 仓库侧没给只阻断写动作，业务侧事实照常展示。
  assert.equal(card.status, 'blocked');
});

test('原生命名也不放松：缺 code 且缺 id、id 与 code 不一致都显式拒绝', () => {
  reject(() => normalizeChangeRecord({ state: 'open', summary: '没有编号' }, { at: AT }), CONTEXT_REASONS.RECORD_INVALID);
  reject(() => normalizeChangeRecord({ code: 'ARD1', state: 'open' }, { at: AT }), CONTEXT_REASONS.RECORD_INVALID);

  let captured = null;
  assert.throws(
    () => normalizeChangeRecord({ code: 'ARD2', id: 'ARD1', state: 'open', summary: '两键不一致' }, { at: AT }),
    (error) => {
      captured = error;
      return error instanceof ContextError && error.code === CONTEXT_REASONS.ID_MISMATCH;
    },
  );
  // 显式阻断而不是静默取一个：detail 同时带上两个值，人工可核。
  assert.equal(captured.detail.field, 'code');
  assert.equal(captured.detail.expectedId, 'ARD1');
  assert.equal(captured.detail.actualId, 'ARD2');
});

test('ready 卡：澄清单只带进度、假设从清单派生、raw 不外泄', () => {
  const change = normalize(ARD222222);
  const sheet = {
    changeId: 'ARD222222',
    version: 2,
    status: 'ready',
    gate: [{ id: 'Q-1', kind: 'acceptance-criteria' }],
    assumptions: [{ id: 'H-1', text: '先只做 app 端', basis: '需求未提 web', impactIfWrong: '需补 web 端' }],
    rejected: [],
    decisions: [],
    revisionId: 'ARD222222/2/abcdef12',
  };
  const card = buildContextCard({
    change,
    building: buildingOf(change, READY_REPOS),
    sources: [DOP_SOURCE, GH_SOURCE],
    clarify: sheet,
  });

  assert.equal(card.status, 'ready');
  assert.deepEqual(card.clarify, {
    version: 2,
    status: 'ready',
    gateCount: 1,
    assumptionCount: 1,
    revisionId: 'ARD222222/2/abcdef12',
  });
  assert.deepEqual(card.assumptions, [
    { id: 'H-1', text: '先只做 app 端', basis: '需求未提 web', impactIfWrong: '需补 web 端' },
  ]);
  assert.equal(card.change.raw, undefined);
  assert.deepEqual(CONTEXT_STATUSES, ['ready', 'blocked']);
});

test('失败注入：dop 读不到 → change=null 的 blocked 卡，未知项带 command 且在渲染里脱敏', () => {
  const change = normalize(ARD123456);
  const building = buildingOf(change, null);
  assert.deepEqual(building.reasons, [RESOLVE_REASONS.NO_REPO_SCOPE]);

  const failure = new DevopsReadError(READ_REASONS.COMMAND_FAILED, 'dop change view ARD123456 --json 退出码 1', {
    field: 'change',
    command: '/opt/corp/bin/dop change view ARD123456 --json --endpoint https://dop.internal.example/api',
    exitCode: 1,
    observedAt: AT,
  });
  const card = buildContextCard({ changeId: 'ARD123456', change: null, building, sources: [], unknowns: [failure] });

  assert.equal(card.status, 'blocked');
  assert.equal(card.change, null);
  assert.equal(card.unknowns.length, 1);
  assert.equal(card.unknowns[0].field, 'change');
  assert.equal(card.unknowns[0].reason, READ_REASONS.COMMAND_FAILED);
  assert.equal(card.unknowns[0].command, failure.detail.command);

  const rendered = renderContextCard(card);
  assert.ok(rendered.includes('## 未知项'));
  assert.ok(rendered.includes('`change`：`COMMAND_FAILED`'));
  assert.ok(rendered.includes('`dop change view ARD123456 --json --endpoint <env:FORGE_DEVOPS_DOP_ENDPOINT>`'));
  assert.ok(!rendered.includes('/opt/corp'), '绝对路径不得进卡片');
  assert.ok(!rendered.includes('dop.internal'), 'endpoint 不得进卡片');
  assert.ok(rendered.includes('读取失败'));

  reject(() => buildContextCard({ changeId: 'ARD123456', change: null, building }), CONTEXT_REASONS.UNKNOWN_INVALID);
});

test('多候选：卡标 blocked，渲染列出候选、依据与"写动作全部阻断"', () => {
  const change = normalize(ARD222222);
  const building = buildingOf(change, [{ nameWithOwner: 'zeta/points-mall' }, { nameWithOwner: 'acme/points-mall' }]);
  assert.deepEqual(building.reasons, [RESOLVE_REASONS.MULTIPLE_CANDIDATES]);

  const card = buildContextCard({ change, building, sources: [DOP_SOURCE, GH_SOURCE] });
  const rendered = renderContextCard(card);

  assert.equal(card.status, 'blocked');
  assert.ok(rendered.includes('写动作全部阻断'));
  assert.ok(rendered.includes('`MULTIPLE_CANDIDATES`'));
  assert.ok(rendered.includes('候选（按仓库名排序'));
  assert.ok(rendered.indexOf('`acme/points-mall`') < rendered.indexOf('`zeta/points-mall`'));
  assert.ok(rendered.includes('不按变更号文本推断仓库（AC-12）'));
});

test('sources 缺 provenance 即拒绝（种类/命令/时间或版本/产物类型四样都要）', () => {
  const change = normalize(ARD222222);
  const building = buildingOf(change, READY_REPOS);

  reject(
    () => buildContextCard({ change, building, sources: [{ kind: 'dop', command: 'change view X --json', sourceType: 'mock' }] }),
    CONTEXT_REASONS.SOURCE_INVALID,
  );
  reject(
    () => buildContextCard({ change, building, sources: [{ ...DOP_SOURCE, kind: 'file' }] }),
    CONTEXT_REASONS.SOURCE_INVALID,
  );
  reject(
    () => buildContextCard({ change, building, sources: [{ ...DOP_SOURCE, command: '  ' }] }),
    CONTEXT_REASONS.SOURCE_INVALID,
  );
  reject(
    () => buildContextCard({ change, building, sources: [{ ...DOP_SOURCE, sourceType: 'prod' }] }),
    CONTEXT_REASONS.SOURCE_INVALID,
  );
});

test('AC-22 渲染脱敏：endpoint 用环境变量占位、绝对路径只保留命令名', () => {
  const change = normalize(ARD222222);
  const card = buildContextCard({
    change,
    building: buildingOf(change, READY_REPOS),
    sources: [
      {
        kind: 'dop',
        command: '/opt/corp/bin/dop change view ARD222222 --json --endpoint=https://dop.corp.example/api',
        at: AT,
        sourceRevision: 'dop:abcdef123456',
        sourceType: 'mock',
      },
    ],
  });
  const rendered = renderContextCard(card);

  assert.ok(rendered.includes('`dop change view ARD222222 --json --endpoint <env:FORGE_DEVOPS_DOP_ENDPOINT>`'));
  assert.ok(!rendered.includes('dop.corp.example'));
  assert.ok(!rendered.includes('/opt/corp/bin'));
});

test('渲染确定：同卡两次渲染逐字相同，契约外字段与包装字段都不进卡', () => {
  const raw = { ...ARD222222, internal_note: 'secret-token-123', release: { number: 'R9' } };
  const change = normalize(raw);
  const card = buildContextCard({ change, building: buildingOf(change, READY_REPOS), sources: [DOP_SOURCE, GH_SOURCE] });
  const rendered = renderContextCard(card);

  assert.equal(rendered, renderContextCard(card));
  assert.ok(!rendered.includes('internal_note'));
  assert.ok(!rendered.includes('secret-token-123'));
  assert.ok(!rendered.includes('release_name'), '渲染用归一后的字段，不出现原始 snake_case 键');
  assert.equal(card.change.raw, undefined);
});

test('unknowns 三形态：Error / 读信封 / {field,reason,command}；无效形态拒绝', () => {
  const change = normalize(ARD222222);
  const building = buildingOf(change, READY_REPOS);
  const error = new DevopsReadError(READ_REASONS.COMMAND_TIMEOUT, 'dop 超时', { field: 'change', command: 'dop change view ARD222222 --json' });
  const envelope = {
    action: 'change.read',
    target_ref: 'ARD222222',
    status: 'unknown',
    error_code: READ_REASONS.COMMAND_TIMEOUT,
    detail: { command: 'gh repo list --limit 100' },
  };
  const plain = { field: 'repos', reason: RESOLVE_REASONS.NO_REPO_SCOPE, command: 'gh repo list' };

  const card = buildContextCard({ change, building, unknowns: [error, envelope, plain] });
  assert.deepEqual(card.unknowns, [
    { field: 'change', reason: READ_REASONS.COMMAND_TIMEOUT, command: 'dop change view ARD222222 --json' },
    { field: 'change.read', reason: READ_REASONS.COMMAND_TIMEOUT, command: 'gh repo list --limit 100' },
    { field: 'repos', reason: RESOLVE_REASONS.NO_REPO_SCOPE, command: 'gh repo list' },
  ]);

  reject(() => buildContextCard({ change, building, unknowns: [{}] }), CONTEXT_REASONS.UNKNOWN_INVALID);
  reject(() => buildContextCard({ change, building, unknowns: ['dop 挂了'] }), CONTEXT_REASONS.UNKNOWN_INVALID);
});

test('端到端主路径：normalize → resolve → build → render 跑到 ready 终态，失败注入变体到 blocked', () => {
  const change = normalize(ARD222222);
  const building = buildingOf(change, READY_REPOS);
  const card = buildContextCard({
    change,
    building,
    related: { issues: [{ number: 42, title: '积分兑换需求', state: 'open' }], prs: [] },
    sources: [DOP_SOURCE, GH_SOURCE],
  });
  const rendered = renderContextCard(card);

  assert.equal(building.status, 'resolved');
  assert.equal(card.status, 'ready');
  assert.match(rendered, /^# 上下文卡 — ARD222222/);
  assert.ok(rendered.includes('1. 用户在 app 看到积分余额'));
  assert.ok(rendered.includes('积分兑换商品（首个非空）'));
  assert.ok(rendered.includes('R20260620002'));
  assert.ok(rendered.includes('`resolved` → `acme/points-mall`'));
  assert.ok(rendered.includes('#42「积分兑换需求」'));
  assert.ok(rendered.includes('## 来源（可核对）'));

  const blockedChange = normalize(ARD123456);
  const blocked = buildContextCard({
    change: blockedChange,
    building: buildingOf(blockedChange, null),
    sources: [],
    unknowns: [{ field: 'repos', reason: RESOLVE_REASONS.NO_REPO_SCOPE, command: 'gh repo list' }],
  });
  const blockedRender = renderContextCard(blocked);

  assert.equal(blocked.status, 'blocked');
  assert.ok(blockedRender.includes('`blocked`（**只阻断写动作**'));
  assert.ok(blockedRender.includes('`NO_REPO_SCOPE`'));
  assert.ok(blockedRender.endsWith('不得手工开 Issue 绕过。'));
});
