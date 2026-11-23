import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateProcessRules, factsFromArguments } from '../src/process-rules.mjs';

test('PR acceptance rule checks creation, not comment text, at either severity', () => {
  // `op` 来自调用参数，正文来自 `exec.content` 快照（门禁里由 factsFromContent 提供）：
  // 这里手工合并成判定用的 facts，避免再假设"参数里带 body"。
  const evaluate = (args, severity, contentFacts = {}) => evaluateProcessRules({
    rules: ['pr-acceptance-section'], facts: { ...factsFromArguments(args), ...contentFacts },
    severities: { 'pr-acceptance-section': severity },
  });
  for (const severity of ['soft', 'hard']) {
    assert.equal(evaluate({ op: 'comment' }, severity, { prBody: 'ordinary comment' }).deny.length, 0);
    assert.equal(evaluate({ op: 'comment' }, severity, { prBody: 'ordinary comment' }).confirm.length, 0);
    assert.equal(evaluate({ op: 'create' }, severity, { prBody: '# Acceptance\nVerified' }).deny.length, 0);
    assert.equal(evaluate({ op: 'create' }, severity, { prBody: '# Acceptance\nVerified' }).confirm.length, 0);
    const missing = evaluate({ op: 'create' }, severity, { prBody: 'no heading' });
    assert.equal(missing[severity === 'hard' ? 'deny' : 'confirm'].length, 1);
  }
});
