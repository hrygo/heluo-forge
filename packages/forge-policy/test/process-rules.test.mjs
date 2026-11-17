import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateProcessRules, factsFromArguments } from '../src/process-rules.mjs';

test('PR acceptance rule checks creation, not comment text, at either severity', () => {
  const evaluate = (args, severity) => evaluateProcessRules({
    rules: ['pr-acceptance-section'], facts: factsFromArguments(args),
    severities: { 'pr-acceptance-section': severity },
  });
  for (const severity of ['soft', 'hard']) {
    assert.equal(evaluate({ op: 'comment', body: 'ordinary comment' }, severity).deny.length, 0);
    assert.equal(evaluate({ op: 'comment', body: 'ordinary comment' }, severity).confirm.length, 0);
    assert.equal(evaluate({ op: 'create', body: '# Acceptance\nVerified' }, severity).deny.length, 0);
    assert.equal(evaluate({ op: 'create', body: '# Acceptance\nVerified' }, severity).confirm.length, 0);
    const missing = evaluate({ body: 'no heading' }, severity);
    assert.equal(missing[severity === 'hard' ? 'deny' : 'confirm'].length, 1);
  }
});
