import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHANGE_SOURCE_TYPES,
  CONTEXT_REASONS,
  CONTEXT_STATUSES,
  ContextError,
  EXTERNAL_REPO_FACT_REASON,
  NATIVE_ALIASES,
  RELEASE_RULE,
  aliasChangeRecord,
  buildContextCard,
  externalRepoFacts,
  firstReleaseInfo,
  normalizeChangeRecord,
  renderContextCard,
} from '../src/change-context.mjs';
import { DevopsReadError, READ_REASONS } from '../src/read.mjs';

const AT = '2026-10-28T10:00:00+08:00';

/**
 * 原生字段夹具：按 UAT 报告描述的形状构造（`code`/`state`/`summary`/`userStory` + 缺 `acceptance_criteria`），
 * **非企业环境导出**，取证只能记 `sourceType: 'mock'`（夹具文件内的 `_fixture` 也这样标）。
 */
const NATIVE_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/dop-change-native.json', import.meta.url), 'utf8'));

/**
 * 1.0.4 实测形状夹具：`changeType`/`created`/`subSystems{name,description}`/`assignee`/
 * `ReleaseInfo{name,stage}`/`storyAC`（富文本），字段名取自 `docs/contracts/dop-cli-spec.md` 并已脱敏，
 * **非企业环境导出**，取证只能记 `sourceType: 'mock'`。
 */
const SPEC_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/dop-change-spec-v1.json', import.meta.url), 'utf8'));

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
const SECOND_SOURCE = { kind: 'dop', command: 'dop change view ARD222222 --json --recheck', at: AT, sourceRevision: 'dop:abcdef654321', sourceType: 'mock' };

const normalize = (raw = ARD222222) => normalizeChangeRecord(raw, { at: AT });
/**
 * r10：承建仓库不再由本包判定，`building` 段只是**被别人回答的事实**。
 * 卡片的形状契约（status / selected / candidates / reasons / next_actions）仍然要逐条守住，
 * 所以这三档夹具直接构造卡片形状：resolved（集成方给的）、blocked（事实不全）、unknown（本包默认）。
 */
const buildingOf = () => externalRepoFacts();const buildingResolved = (repo = 'acme/points-mall') => ({
  status: 'resolved',
  selected: repo,
  candidates: [{ repo, evidence: [{ kind: 'repo.name', value: repo, source: 'gitee.repository_read' }] }],
  reasons: [],
  next_actions: [],
});
const buildingBlocked = (reason = 'NO_REPO_SCOPE') => ({
  status: 'blocked',
  selected: null,
  candidates: [],
  reasons: [reason],
  next_actions: [],
});
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
  const rendered = renderContextCard(buildContextCard({ change: noCriteria, building: buildingBlocked() }));
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

test('原生字段别名只有一张表，且契约键优先', () => {
  assert.deepEqual(
    { ...NATIVE_ALIASES },
    {
      code: 'id',
      state: 'status',
      summary: 'description',
      userStory: 'user_stories',
      changeType: 'type',
      created: 'created_at',
      subSystems: 'sub_systems',
      ReleaseInfo: 'release_info',
    },
    '只收 UAT 四键 + 1.0.4 实测四键；未取证的改名不进表',
  );

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

  const card = buildContextCard({ change, building: buildingBlocked(), sources: [] });
  const rendered = renderContextCard(card);
  assert.match(rendered, /^# 上下文卡 — ARD777777/);
  assert.ok(rendered.includes('平台未提供 `acceptance_criteria`'));
  assert.ok(rendered.includes('US-20001'));
  assert.ok(rendered.includes('R20260706001'));
  // 仓库侧没给只阻断写动作，业务侧事实照常展示。
  assert.equal(card.status, 'blocked');
});

test('1.0.4 实测形状归一：changeType/created/subSystems/ReleaseInfo/storyAC 都读得到', () => {
  const change = normalizeChangeRecord(SPEC_FIXTURE, { at: AT, sourceType: 'mock' });

  assert.equal(change.changeId, 'ARD900001');
  assert.equal(change.type, '代码开发', 'changeType 是类型，不该被判成"平台没给"');
  assert.equal(change.createdAt, '2026-11-01 09:20:11', 'created 是创建时间');
  assert.equal(change.owner, '示例用户', '没有 owner 时由 assignee 兜负责人');
  assert.deepEqual(
    change.subSystems,
    [
      { code: 'SYS.example-sdk', name: '示例研发平台.示例套件' },
      { code: 'SYS.example-gateway', name: '示例研发平台.示例网关' },
    ],
    '子系统项 {name, description} 归一成 {code, name}',
  );
  assert.deepEqual(change.acceptanceCriteria, [
    { index: 1, text: '重复回调 10 次仅入账 1 次；' },
    { index: 2, text: '幂等键缺失时拒绝入账并告警。' },
    { index: 3, text: '对账任务可补偿漏单。' },
  ], 'storyAC 的富文本按块级分隔切条');
  assert.equal(change.acceptanceCriteriaSource, 'story_ac');
  assert.equal(change.releaseInfo.storyId, 'US-900001');
  assert.equal(change.releaseInfo.value.releaseNum, 'R20261101001');
  assert.equal(change.releaseInfo.value.releaseName, '示例：回调幂等改造发布', 'ReleaseInfo.name 是发布名');
  assert.equal(change.releaseInfo.value.releaseStage, '已审批', 'ReleaseInfo.stage 是发布阶段');
  assert.deepEqual(change.missingFields, [], '审计字段齐全时不应有任何"平台没给"');
});

test('卡片不再谎称"平台未给"：验收条件带来源标注，承建系统与排期照常展示', () => {
  const change = normalizeChangeRecord(SPEC_FIXTURE, { at: AT, sourceType: 'mock' });
  const card = buildContextCard({ change, building: buildingBlocked(), sources: [] });
  const rendered = renderContextCard(card);

  assert.ok(!rendered.includes('平台未提供 `acceptance_criteria`'), '平台提供了验收条件，不得写成未提供');
  assert.ok(!rendered.includes('平台未给 `sub_systems`'), '平台给了子系统，不得写成未给');
  assert.ok(!rendered.includes('所有故事的 `release_info` 均为空'), '平台给了排期，不得写成全空');
  assert.ok(rendered.includes('来源：故事 `userStory.storyAC`'), '验收条件要标来源');
  assert.ok(rendered.includes('SYS.example-sdk'));
  assert.ok(rendered.includes('示例研发平台.示例套件'));
  assert.ok(rendered.includes('R20261101001'));
});

test('验收条件三个落点：契约字段 → 故事 storyAC → 平台回写的 aiAcceptanceCriteria', () => {
  const base = { id: 'ARD1', title: '标题', status: 'open', description: '描述' };

  const contract = normalizeChangeRecord({ ...base, acceptance_criteria: ['契约条目'], aiAcceptanceCriteria: '<p>AI 条目</p>' });
  assert.deepEqual(contract.acceptanceCriteria.map((item) => item.text), ['契约条目']);
  assert.equal(contract.acceptanceCriteriaSource, 'contract', '契约字段优先');

  const story = normalizeChangeRecord({ ...base, userStory: { storyAC: '<p>故事条目</p>' }, aiAcceptanceCriteria: '<p>AI 条目</p>' });
  assert.deepEqual(story.acceptanceCriteria.map((item) => item.text), ['故事条目']);
  assert.equal(story.acceptanceCriteriaSource, 'story_ac', '平台的原始验收条件优先于 AI 回写');

  const ai = normalizeChangeRecord({ ...base, aiAcceptanceCriteria: '<p>AI 条目一</p><p>AI 条目二</p>' });
  assert.deepEqual(ai.acceptanceCriteria.map((item) => item.text), ['AI 条目一', 'AI 条目二']);
  assert.equal(ai.acceptanceCriteriaSource, 'ai_ac');

  const none = normalizeChangeRecord(base);
  assert.deepEqual(none.acceptanceCriteria, []);
  assert.equal(none.acceptanceCriteriaSource, null);
  assert.ok(none.missingFields.includes('acceptance_criteria'));

});

test('只有小标题的行不算验收条件（`详细规则：` 这类）', () => {
  const base = { id: 'ARD1', title: '标题', status: 'open', description: '描述' };

  // 真实 storyAC 常写成「小标题：+ 正文」，小标题不该占一个验收条件编号。
  const mixed = normalizeChangeRecord({ ...base, userStory: { storyAC: '<p>详细规则：<br/>先退后付；</p><p>Rules:<br/>idempotent;</p>' } });
  assert.deepEqual(mixed.acceptanceCriteria, [
    { index: 1, text: '先退后付；' },
    { index: 2, text: 'idempotent;' },
  ], '中英文冒号结尾的小标题都丢掉，正文按原顺序重新编号');

  // 只有小标题时等于"平台没给验收条件"：宁可留空，也不把一句空话编成第 1 条。
  const onlyLabel = normalizeChangeRecord({ ...base, userStory: { storyAC: '<p>详细规则：<br/></p>' } });
  assert.deepEqual(onlyLabel.acceptanceCriteria, []);
  assert.equal(onlyLabel.acceptanceCriteriaSource, null);
  assert.ok(onlyLabel.missingFields.includes('acceptance_criteria'));
});

test('平台回写的 AI 验收标准单独展示，不顶替平台原始验收条件', () => {
  const base = { id: 'ARD1', title: '标题', status: 'open', description: '描述' };
  const change = normalizeChangeRecord({
    ...base,
    userStory: { storyAC: '<p>平台条目</p>' },
    aiAcceptanceCriteria: '<p>AI 条目一</p><p>AI 条目二</p>',
  });

  assert.equal(change.aiAcceptanceCriteria, 'AI 条目一\nAI 条目二', 'AI 验收标准保留原文（按行）');
  assert.deepEqual(change.acceptanceCriteria.map((item) => item.text), ['平台条目'], '平台原始验收条件优先');
  assert.equal(change.acceptanceCriteriaSource, 'story_ac');

  const card = buildContextCard({ change, building: buildingBlocked(), sources: [] });
  const rendered = renderContextCard(card);
  assert.ok(rendered.includes('1. 平台条目'));
  assert.ok(rendered.includes('AI 验收标准，平台已回写，供复核：AI 条目一 AI 条目二'), '卡片上要能看见上一次分析写了什么');

  // 平台没有原始验收条件时，AI 回写就是唯一来源：不再重复一行"AI 验收标准"。
  const aiOnly = normalizeChangeRecord({ ...base, aiAcceptanceCriteria: '<p>AI 条目</p>' });
  const aiOnlyText = renderContextCard(buildContextCard({ change: aiOnly, building: buildingBlocked(), sources: [] }));
  assert.ok(aiOnlyText.includes('来源：平台回写的 `aiAcceptanceCriteria`'));
  assert.ok(!aiOnlyText.includes('AI 验收标准，平台已回写，供复核'), '同一内容不重复展示');
});

test('负责人三级兜底：owner → assignee → createUser → manager', () => {
  const base = { id: 'ARD1', title: '标题', status: 'open' };
  assert.equal(normalizeChangeRecord({ ...base, owner: '契约负责人', assignee: { name: '负责人甲' } }).owner, '契约负责人');
  assert.equal(normalizeChangeRecord({ ...base, assignee: { name: '负责人甲' } }).owner, '负责人甲');
  assert.equal(normalizeChangeRecord({ ...base, createUser: { name: '创建人乙' } }).owner, '创建人乙');
  assert.equal(normalizeChangeRecord({ ...base, manager: { name: '经理丙' } }).owner, '经理丙');
  assert.equal(normalizeChangeRecord(base).owner, '');
  assert.ok(normalizeChangeRecord(base).missingFields.includes('owner'));
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
    building: buildingResolved(),
    sources: [DOP_SOURCE, SECOND_SOURCE],
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
  const building = buildingBlocked();
  assert.deepEqual(building.reasons, ['NO_REPO_SCOPE']);

  const failure = new DevopsReadError(READ_REASONS.COMMAND_FAILED, 'dop change view ARD123456 --json 退出码 1', {
    field: 'change',
    command: '/opt/corp/bin/dop change view ARD123456 --json --endpoint https://dop.example/api',
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
  assert.ok(!rendered.includes('dop.example'), 'endpoint 不得进卡片');
  assert.ok(rendered.includes('读取失败'));

  reject(() => buildContextCard({ changeId: 'ARD123456', change: null, building }), CONTEXT_REASONS.UNKNOWN_INVALID);
});

test('外部事实：unknown 卡标 blocked，渲染 REPO_FACTS_EXTERNAL 与下一步工具名，且不猜候选仓库', () => {
  const change = normalize(ARD222222);
  const building = buildingOf();
  assert.equal(building.status, 'unknown');
  assert.deepEqual(building.candidates, []);
  assert.deepEqual(building.reasons, [EXTERNAL_REPO_FACT_REASON]);

  const card = buildContextCard({ change, building, sources: [DOP_SOURCE, SECOND_SOURCE] });
  const rendered = renderContextCard(card);

  // 仓库事实外部化后不再单独把业务卡打成 blocked：dop 事实齐全即可推进，仓库段自己声明 unknown。
  assert.equal(card.status, 'ready');
  assert.ok(rendered.includes(EXTERNAL_REPO_FACT_REASON));
  assert.ok(rendered.includes('forge_gitee_repository_read'));
  assert.ok(rendered.includes('forge_gitee_issue_read'));
  assert.ok(!rendered.includes('- 候选'), 'unknown 时不列候选——本包不判定承建仓库');
  assert.ok(rendered.includes('AC-12'));
});

test('sources 缺 provenance 即拒绝（种类/命令/时间或版本/产物类型四样都要）', () => {
  const change = normalize(ARD222222);
  const building = buildingResolved();

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
    building: buildingResolved(),
    sources: [
      {
        kind: 'dop',
        command: '/opt/corp/bin/dop change view ARD222222 --json --endpoint=https://dop.example/api',
        at: AT,
        sourceRevision: 'dop:abcdef123456',
        sourceType: 'mock',
      },
    ],
  });
  const rendered = renderContextCard(card);

  assert.ok(rendered.includes('`dop change view ARD222222 --json --endpoint <env:FORGE_DEVOPS_DOP_ENDPOINT>`'));
  assert.ok(!rendered.includes('dop.example'));
  assert.ok(!rendered.includes('/opt/corp/bin'));
});

test('渲染确定：同卡两次渲染逐字相同，契约外字段与包装字段都不进卡', () => {
  const raw = { ...ARD222222, internal_note: 'secret-token-123', release: { number: 'R9' } };
  const change = normalize(raw);
  const card = buildContextCard({ change, building: buildingResolved(), sources: [DOP_SOURCE, SECOND_SOURCE] });
  const rendered = renderContextCard(card);

  assert.equal(rendered, renderContextCard(card));
  assert.ok(!rendered.includes('internal_note'));
  assert.ok(!rendered.includes('secret-token-123'));
  assert.ok(!rendered.includes('release_name'), '渲染用归一后的字段，不出现原始 snake_case 键');
  assert.equal(card.change.raw, undefined);
});

test('unknowns 三形态：Error / 读信封 / {field,reason,command}；无效形态拒绝', () => {
  const change = normalize(ARD222222);
  const building = buildingResolved();
  const error = new DevopsReadError(READ_REASONS.COMMAND_TIMEOUT, 'dop 超时', { field: 'change', command: 'dop change view ARD222222 --json' });
  const envelope = {
    action: 'change.read',
    target_ref: 'ARD222222',
    status: 'unknown',
    error_code: READ_REASONS.COMMAND_TIMEOUT,
    detail: { command: 'gh repo list --limit 100' },
  };
  const plain = { field: 'repos', reason: 'NO_REPO_SCOPE', command: 'gh repo list' };

  const card = buildContextCard({ change, building, unknowns: [error, envelope, plain] });
  assert.deepEqual(card.unknowns, [
    { field: 'change', reason: READ_REASONS.COMMAND_TIMEOUT, command: 'dop change view ARD222222 --json' },
    { field: 'change.read', reason: READ_REASONS.COMMAND_TIMEOUT, command: 'gh repo list --limit 100' },
    { field: 'repos', reason: 'NO_REPO_SCOPE', command: 'gh repo list' },
  ]);

  reject(() => buildContextCard({ change, building, unknowns: [{}] }), CONTEXT_REASONS.UNKNOWN_INVALID);
  reject(() => buildContextCard({ change, building, unknowns: ['dop 挂了'] }), CONTEXT_REASONS.UNKNOWN_INVALID);
});

test('端到端主路径：normalize → resolve → build → render 跑到 ready 终态，失败注入变体到 blocked', () => {
  const change = normalize(ARD222222);
  const building = buildingResolved();
  const card = buildContextCard({
    change,
    building,
    related: { issues: [{ number: 42, title: '积分兑换需求', state: 'open' }], prs: [] },
    sources: [DOP_SOURCE, SECOND_SOURCE],
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
    change: null,
    changeId: 'ARD123456',
    building: buildingOf(),
    sources: [],
    unknowns: [{ field: 'change', reason: READ_REASONS.COMMAND_FAILED, command: 'dop change view ARD123456 --json' }],
  });
  const blockedRender = renderContextCard(blocked);

  assert.equal(blocked.status, 'blocked');
  assert.ok(blockedRender.includes('`blocked`（**只阻断写动作**'));
  assert.ok(blockedRender.includes(EXTERNAL_REPO_FACT_REASON));
  assert.ok(blockedRender.endsWith('3. 事实恢复前不创建 Issue/PR、不写澄清记录。'));
});
