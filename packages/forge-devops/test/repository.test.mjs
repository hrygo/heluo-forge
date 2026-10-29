import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_SOURCES,
  RESOLVE_REASONS,
  RESOLVE_STATUSES,
  resolveBuildingRepository,
} from '../src/repository-resolver.mjs';

/** 承建系统声明（归一化后的 Change 形状；raw dop 的 `sub_systems` 读法另有用例）。 */
const change = (subSystems, changeId = 'ARD222222') => ({ changeId, title: '信用卡积分兑换功能', subSystems });

const POINTS_REPOS = [
  { nameWithOwner: 'miniceM/points-mall', description: '信用卡积分兑换与积分商城', topics: ['points', 'mall'] },
  { nameWithOwner: 'miniceM/devops-demo', description: 'SDD 端到端演示', topics: ['sdd'] },
];

test('单一候选即 resolved，且命中双方都留证据', () => {
  const result = resolveBuildingRepository({
    change: change([{ code: 'CARD.points-mall', name: '信用卡中心.积分商城子系统' }]),
    visibleRepos: POINTS_REPOS,
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.selected, 'miniceM/points-mall');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].evidence, [
    { kind: 'repo.name', value: 'miniceM/points-mall', source: EVIDENCE_SOURCES.REPOSITORIES },
    { kind: 'sub_system.code', value: 'points-mall', source: EVIDENCE_SOURCES.SUB_SYSTEMS },
  ]);
});

test('中文承建系统名命中仓库描述（CJK 按包含；两位 ASCII 词不参与判定）', () => {
  const result = resolveBuildingRepository({
    change: change([{ code: 'X1', name: '积分商城' }]),
    visibleRepos: [{ nameWithOwner: 'miniceM/points-mall', description: '信用卡积分商城首期' }],
  });

  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.candidates[0].evidence, [
    { kind: 'repo.description', value: '信用卡积分商城首期', source: EVIDENCE_SOURCES.REPOSITORIES },
    { kind: 'sub_system.name', value: '积分商城', source: EVIDENCE_SOURCES.SUB_SYSTEMS },
  ]);
});

test('多候选 → blocked/MULTIPLE_CANDIDATES，候选按仓库名排序且全部附证据', () => {
  const result = resolveBuildingRepository({
    change: change([{ code: 'CARD.points-mall', name: '积分商城' }]),
    visibleRepos: [
      { nameWithOwner: 'zeta/points-mall' },
      { nameWithOwner: 'acme/points-mall' },
    ],
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.selected, null);
  assert.deepEqual(result.reasons, [RESOLVE_REASONS.MULTIPLE_CANDIDATES]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.repo), ['acme/points-mall', 'zeta/points-mall']);
  result.candidates.forEach((candidate) => assert.ok(candidate.evidence.length >= 2, `${candidate.repo} 必须带证据`));
});

test('可见仓库都不命中 → blocked/NO_CANDIDATE，不自选', () => {
  const result = resolveBuildingRepository({
    change: change([{ code: 'CARD.points-mall', name: '信用卡中心.积分商城子系统' }]),
    visibleRepos: [{ nameWithOwner: 'miniceM/devops-demo', description: 'SDD 端到端演示' }],
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.reasons, [RESOLVE_REASONS.NO_CANDIDATE]);
  assert.deepEqual(result.candidates, []);
});

test('平台没给 sub_systems → blocked/NO_SUB_SYSTEMS（不拿标题去搜索）', () => {
  const result = resolveBuildingRepository({ change: change([]), visibleRepos: POINTS_REPOS });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.reasons, [RESOLVE_REASONS.NO_SUB_SYSTEMS]);
  assert.deepEqual(result.candidates, []);
});

test('仓库清单不可得与清单为空要分开报（NO_REPO_SCOPE / NO_VISIBLE_REPOS）', () => {
  const subSystems = change([{ code: 'CARD.points-mall' }]);

  const noScope = resolveBuildingRepository({ change: subSystems, visibleRepos: null });
  assert.equal(noScope.status, 'blocked');
  assert.deepEqual(noScope.reasons, [RESOLVE_REASONS.NO_REPO_SCOPE]);

  const empty = resolveBuildingRepository({ change: subSystems, visibleRepos: [] });
  assert.equal(empty.status, 'blocked');
  assert.deepEqual(empty.reasons, [RESOLVE_REASONS.NO_VISIBLE_REPOS]);
});

test('explicit 只能在候选里挑：命中即 resolved，多候选时用作消歧', () => {
  const subSystems = change([{ code: 'CARD.points-mall' }]);
  const repos = [{ nameWithOwner: 'zeta/points-mall' }, { nameWithOwner: 'acme/points-mall' }];

  const picked = resolveBuildingRepository({ change: subSystems, visibleRepos: repos, explicit: 'acme/points-mall' });
  assert.equal(picked.status, 'resolved');
  assert.equal(picked.selected, 'acme/points-mall');

  const bare = resolveBuildingRepository({ change: subSystems, visibleRepos: repos, explicit: 'ZETA/POINTS-MALL' });
  assert.equal(bare.status, 'resolved');
  assert.equal(bare.selected, 'zeta/points-mall');
});

test('explicit 越界（候选之外）→ blocked/EXPLICIT_NOT_CANDIDATE，不引入新仓库', () => {
  const result = resolveBuildingRepository({
    change: change([{ code: 'CARD.points-mall' }]),
    visibleRepos: [{ nameWithOwner: 'acme/points-mall' }],
    explicit: 'other/handwritten-repo',
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.reasons, [RESOLVE_REASONS.EXPLICIT_NOT_CANDIDATE]);
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates.map((candidate) => candidate.repo), ['acme/points-mall']);
});

test('缺少变更记录（无承建系统可依据）→ blocked/MISSING_CHANGE', () => {
  const result = resolveBuildingRepository({ change: null, visibleRepos: POINTS_REPOS });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.reasons, [RESOLVE_REASONS.MISSING_CHANGE]);
});

test('AC-12：仓库与变更号同名也不被推断（不按变更号文本找仓库）', () => {
  const result = resolveBuildingRepository({
    change: change([{ code: 'ARD.ard-sdk', name: '智能研发平台.AI原生框架套件' }], 'ARD123456'),
    visibleRepos: [{ nameWithOwner: 'group/ARD123456', description: '与变更号同名的仓库' }],
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.reasons, [RESOLVE_REASONS.NO_CANDIDATE]);
  assert.deepEqual(result.candidates, []);
});

test('topics 命中记 repo.topic 证据；纯字符串仓库清单同样可用', () => {
  const result = resolveBuildingRepository({
    change: change([{ code: 'CARD.points' }]),
    visibleRepos: [{ nameWithOwner: 'acme/mall', topics: ['points'] }],
  });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.candidates[0].evidence, [
    { kind: 'repo.topic', value: 'points', source: EVIDENCE_SOURCES.REPOSITORIES },
    { kind: 'sub_system.code', value: 'points', source: EVIDENCE_SOURCES.SUB_SYSTEMS },
  ]);

  const asStrings = resolveBuildingRepository({
    change: change([{ code: 'CARD.points-mall' }]),
    visibleRepos: ['acme/points-mall'],
  });
  assert.equal(asStrings.status, 'resolved');
  assert.equal(asStrings.selected, 'acme/points-mall');
});

test('raw dop 记录的 sub_systems 读法可用；状态词表只有 resolved/blocked', () => {
  const result = resolveBuildingRepository({
    change: { id: 'ARD222222', sub_systems: [{ code: 'CARD.points-mall', name: '积分商城' }] },
    visibleRepos: ['acme/points-mall'],
  });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(RESOLVE_STATUSES, ['resolved', 'blocked']);
  assert.ok(RESOLVE_STATUSES.includes(result.status));
});
