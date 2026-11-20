import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIRM_CODES,
  CONFIRM_LABELS,
  CONFIRM_REASONS,
  buildConfirmationCard,
  readConfirmationAnswer,
} from '../src/confirm.mjs';

const card = () => buildConfirmationCard({ action: 'gitee.git.push', target: 'corp.example/repo', args: { branch: 'feat/x' } });

test('one card carries the action, the target and a fixed pair of labels', () => {
  const { questions, allowLabel, denyLabel } = card();
  assert.equal(questions.length, 1);
  assert.equal(allowLabel, '允许本次写入');
  assert.equal(denyLabel, '取消本次写入');
  const [question] = questions;
  assert.equal(question.id, 'forge-policy-action');
  assert.equal(question.header, CONFIRM_REASONS.action);
  assert.match(question.question, /corp\.example\/repo/u, 'the target location is shown');
  assert.match(question.question, /feat\/x/u, 'the branch is shown so the human can tell calls apart');
  assert.match(question.detail, /不选择视为取消/u);
  assert.doesNotMatch(question.detail, /动作确认/u, '标题已经说了这是什么确认，正文不重复');
  assert.deepEqual(question.options.map((option) => option.label), [allowLabel, denyLabel]);
  assert.deepEqual(question.options.map((option) => option.description), ['只放行这一次调用', '拒绝本次调用，不执行']);
  assert.equal(Object.isFrozen(questions), true);
  assert.equal(Object.isFrozen(question), true);
});

test('merged reasons become one question each, action before content', () => {
  const merged = buildConfirmationCard({
    action: 'gitee.issue.write',
    target: 'corp.example/repo',
    // 故意倒序传入：顺序由卡片自己决定，调用方说了不算。
    reasons: ['content', 'action', 'nope', { reason: 'content' }],
  });
  assert.deepEqual(merged.questions.map((question) => question.id), ['forge-policy-action', 'forge-policy-content']);
  assert.deepEqual(merged.questions.map((question) => question.header), [CONFIRM_REASONS.action, CONFIRM_REASONS.content]);
  assert.equal(new Set(merged.questions.map((question) => question.question)).size, merged.questions.length);
  assert.equal(buildConfirmationCard({ action: 'gitee.git.push' }).questions.length, 1, 'no reasons still asks the action itself');
  assert.equal(buildConfirmationCard({ action: 'gitee.git.push', reasons: [] }).questions[0].id, 'forge-policy-action');
  assert.equal(buildConfirmationCard({ action: 'gitee.git.push', reasons: ['unknown'] }).questions[0].id, 'forge-policy-action');
});

test('the card never carries a path, a token or the raw arguments', () => {
  const secret = 'ghp_'.concat('A'.repeat(36));
  const unixPath = ['', 'Users', 'someone', 'work', 'secret-repo'].join('/');
  const winPath = ['C:', 'Users', 'someone', 'x'].join('\\');
  const pathCard = buildConfirmationCard({
    action: 'gitee.issue.write',
    target: unixPath,
    args: { title: 'hello', body: 'body text', token: secret, path: winPath },
  });
  const serialized = JSON.stringify(pathCard);
  assert.doesNotMatch(serialized, /secret-repo/u, 'absolute paths are hidden');
  assert.doesNotMatch(serialized, /someone/u, 'user names inside paths are hidden');
  assert.doesNotMatch(serialized, new RegExp(secret, 'u'), 'tokens never reach the card');
  assert.doesNotMatch(serialized, /body text/u, 'the raw arguments never reach the card');
  assert.match(serialized, /目标（已隐藏）/u, 'the human still sees that a target exists');

  const noTarget = buildConfirmationCard({ action: 'gitee.git.push' });
  assert.doesNotMatch(JSON.stringify(noTarget), /undefined|null/u);
});

test('only an exact, complete selection of the allow label allows', () => {
  const { questions, allowLabel, denyLabel } = card();
  const id = questions[0].id;
  const answer = (...selected) => ({ answers: [{ id, selected }] });
  const code = (value) => readConfirmationAnswer(value, { questions, allowLabel, denyLabel });

  assert.deepEqual(code(answer(allowLabel)), { decision: 'allow' });
  assert.deepEqual(code(answer(denyLabel)), { decision: 'deny', code: CONFIRM_CODES.DENIED });

  // 8 种畸形输入：全部按未确认处理，没有一个可以"猜成允许"。
  for (const [name, malformed] of Object.entries({
    'no answer at all': undefined,
    'a bare string': 'allow',
    'no answers array': {},
    'answers not an array': { answers: 'allow' },
    'an empty selection': answer(),
    'an unknown label': answer('yes'),
    'two labels': answer(allowLabel, denyLabel),
    'a non-string label': { answers: [{ id, selected: [1] }] },
  })) {
    assert.deepEqual(code(malformed), { decision: 'deny', code: CONFIRM_CODES.INVALID_ANSWER }, name);
  }
  // 前后缀与包含关系都不是"同一个标签"。
  for (const label of [`${allowLabel} `, ` ${allowLabel}`, allowLabel.slice(0, 2)]) {
    assert.equal(code(answer(label)).code, CONFIRM_CODES.INVALID_ANSWER, `label ${label} must not match`);
  }
  assert.equal(code(answer(`${allowLabel}。`)).code, CONFIRM_CODES.INVALID_ANSWER, 'trailing punctuation is not the label');
  // 题数或 id 对不上、带自定义文本，也一律拒绝。
  assert.equal(code({ answers: [{ id, selected: [allowLabel] }, { id: 'extra', selected: [allowLabel] }] }).code, CONFIRM_CODES.INVALID_ANSWER);
  assert.equal(code({ answers: [{ id: 'other', selected: [allowLabel] }] }).code, CONFIRM_CODES.INVALID_ANSWER);
  assert.equal(code({ answers: [{ id, selected: [allowLabel], custom: 'ok' }] }).code, CONFIRM_CODES.INVALID_ANSWER);
  assert.equal(code({ answers: [{ id, selected: [allowLabel] }], extra: true }).decision, 'allow', 'extra payload keys are harmless');
  assert.equal(readConfirmationAnswer(answer(allowLabel), {}).code, CONFIRM_CODES.INVALID_ANSWER, 'no expected questions means no allow');
});

test('a refusal on one question wins over an allow on another', () => {
  const { questions, allowLabel, denyLabel } = buildConfirmationCard({ action: 'gitee.git.push', reasons: ['action', 'content'] });
  const verdict = readConfirmationAnswer({
    answers: [
      { id: questions[0].id, selected: [allowLabel] },
      { id: questions[1].id, selected: [denyLabel] },
    ],
  }, { questions, allowLabel, denyLabel });
  assert.deepEqual(verdict, { decision: 'deny', code: CONFIRM_CODES.DENIED });
  const ok = readConfirmationAnswer({
    answers: [
      { id: questions[1].id, selected: [allowLabel] },
      { id: questions[0].id, selected: [allowLabel] },
    ],
  }, { questions, allowLabel, denyLabel });
  assert.deepEqual(ok, { decision: 'allow' }, 'answer order does not matter');
});

test('the six confirmation codes are the only outcomes', () => {
  assert.deepEqual(Object.values(CONFIRM_CODES).sort(), [
    'POLICY_CONFIRM_DELEGATED', 'POLICY_CONFIRM_DENIED', 'POLICY_CONFIRM_ERROR',
    'POLICY_CONFIRM_INVALID_ANSWER', 'POLICY_CONFIRM_TIMEOUT', 'POLICY_CONFIRM_UNAVAILABLE',
  ]);
  assert.equal(new Set(Object.values(CONFIRM_CODES)).size, 6);
  assert.deepEqual(CONFIRM_LABELS, { allow: '允许本次写入', deny: '取消本次写入' });
});
