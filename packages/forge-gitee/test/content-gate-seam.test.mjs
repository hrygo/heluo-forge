/**
 * D86 组合接缝：CLI 出口脱敏 → readRange 分类 → 策略内容闸。
 *
 * 单包用例各自守住了"脱敏"和"内容闸"，但真正的故障在接缝：git 子进程输出先被
 * 公共出口脱敏，readRange 若一律把 redacted 当"读不到"，Gitee 推送里可确认的
 * 令牌命中就永远进不了确认卡。这里用假子进程把三段真实实现串起来：
 * 1. 出口按类别脱敏后的提交正文 → readRange 返回 redactions → 策略弹两题卡并执行；
 * 2. 未被脱敏的私钥 → 策略 HARD 拒绝、零执行、不弹卡；
 * 3. 无法分类的脱敏 → 按未完整扫描记账，不阻断但审计留痕。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIRM_LABELS, apply } from '@heluo/forge-policy';

import { createGiteeGitAdapter } from '../src/gitee-git.mjs';

const CATALOG = [{ action: 'gitee.git.push', target: 'repository', category: 'remote-write' }];
const PEM = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const SHA = '9'.repeat(40);

const answering = () => ({
  calls: [],
  ask(request) {
    this.calls.push(request);
    return Promise.resolve({
      answers: request.questions.map((question) => ({ id: question.id, selected: [CONFIRM_LABELS.allow] })),
    });
  },
});

/** 假 git：只回答 readRange 需要的四条只读命令。 */
function fakeGit(show) {
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false, truncated: false });
  return {
    runGit: async ({ args }) => {
      if (args[0] === 'rev-parse') return ok(`${SHA}\n`);
      if (args[0] === 'merge-base') return ok(`${'0'.repeat(40)}\n`);
      if (args[0] === 'rev-list') return ok(`${SHA}\n`);
      return show();
    },
  };
}

function mountPolicy(channel) {
  const services = new Map(), listeners = new Map(), guards = [];
  services.set('iam', { getView: () => ({ signedIn: true, principal: { subject: 'svc-seam-test' } }) });
  if (channel !== undefined) services.set('userQuestions', channel);
  const ctx = {
    get: (key) => services.get(key),
    provide: (key, value) => (services.set(key, value), () => services.delete(key)),
    effect: (callback) => callback(),
    on: (event, listener) => (listeners.set(event, listener), () => listeners.delete(event)),
    tools: { guard: (callback) => (guards.push(callback), () => guards.splice(guards.indexOf(callback), 1)) },
    logger: { warn() {} },
  };
  const dispose = apply(ctx, {
    audit: { sink: 'memory' },
    rules: { contentGate: true, confirmPush: true },
    catalog: CATALOG,
    tools: { forge_gitee_write: 'gitee.git.push' },
  });
  return { policy: services.get('policy'), ctx, dispose, guards, listeners };
}

/** 与真实 push 工具一致：正文不在 arguments，只有惰性 content() 通道。 */
function pushExecution(content, callId = 'call-seam') {
  return {
    name: 'forge_gitee_write',
    arguments: { target: 'corp.example/repo', branch: 'feat/x', remote: 'origin' },
    callId,
    agent: { kind: 'agent' },
    content,
  };
}

test('接缝：出口脱敏的令牌经 readRange 分类后仍形成内容确认，并真正执行', async () => {
  const channel = answering();
  const h = mountPolicy(channel);
  const adapter = createGiteeGitAdapter({
    runner: fakeGit(() => ({
      exitCode: 0,
      stdout: 'fix: 加配置\u0000+token=***',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false,
      redacted: true,
      redactionKinds: ['token'],
    })),
    cwd: '/tmp/offline-repo',
  });
  let ran = 0;
  const exec = pushExecution(() => adapter.readRange({ remote: 'origin', branch: 'feat/x' }));
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec, async () => (ran++, { ok: true }));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, 1, '可确认的命中不应被当成"读不到"而拒绝');
  assert.deepEqual(channel.calls[0].questions.map((question) => question.id), [
    'forge-policy-action',
    'forge-policy-content',
  ]);
  const records = h.policy.auditRecords();
  assert.deepEqual(records[0].ruleIds, ['BUILTIN-TOKEN']);
  assert.equal(records[0].contentSkipped, undefined, '分类成功的脱敏不记为未扫全');
  h.dispose();
});

test('接缝：未被脱敏的私钥照旧 HARD 拒绝，零执行、不弹卡', async () => {
  const channel = answering();
  const h = mountPolicy(channel);
  const adapter = createGiteeGitAdapter({
    runner: fakeGit(() => ({
      exitCode: 0,
      stdout: `fix: 加密钥\u0000+${PEM}`,
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false,
    })),
    cwd: '/tmp/offline-repo',
  });
  let ran = 0;
  const exec = pushExecution(() => adapter.readRange({ remote: 'origin', branch: 'feat/x' }));
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec, async () => (ran++, { ok: true }));
  assert.equal(ran, 0);
  assert.equal(channel.calls.length, 0);
  assert.equal(result.code, 'POLICY_CONTENT_HARD');
  assert.doesNotMatch(result.text, /PRIVATE KEY/u);
  h.dispose();
});

test('接缝：无法分类的脱敏按未完整扫描记账，放行但审计可追溯', async () => {
  const channel = answering();
  const h = mountPolicy(channel);
  const adapter = createGiteeGitAdapter({
    runner: fakeGit(() => ({
      exitCode: 0,
      stdout: 'fix: 一条\u0000+key=***',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false,
      redacted: true,
      redactionKinds: ['unknown'],
    })),
    cwd: '/tmp/offline-repo',
  });
  let ran = 0;
  const exec = pushExecution(() => adapter.readRange({ remote: 'origin', branch: 'feat/x' }));
  const result = await h.policy.executeAction(h.ctx, 'gitee.git.push', exec, async () => (ran++, { ok: true }));
  // readRange 对无法分类的脱敏仍抛 READBACK_UNAVAILABLE；策略按 D48 放行并告警。
  assert.equal(ran, 1);
  assert.equal(result.code, undefined);
  const records = h.policy.auditRecords();
  assert.deepEqual(records.map((record) => record.phase), ['asked', 'answered', 'begin', 'settle']);
  for (const record of records.slice(0, 3)) {
    assert.deepEqual(record.contentSkipped, ['content:unreadable']);
  }
  h.dispose();
});
