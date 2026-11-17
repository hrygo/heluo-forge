import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson, verifyEnvelope } from '../src/org-policy.mjs';
import { evaluateProcessRules } from '../src/process-rules.mjs';

test('documented signed envelope sets PR acceptance severity', () => {
  const envelope = {
    schema: 'heluo.policy.org.v1', policy_version: '2026.11.1', issued_by: 'iam-subject-example',
    issued_at: '2026-11-16T00:00:00Z',
    caps: { 'gitee.git.push': 'confirm', 'gitee.review.publish': 'allow' },
    content_rules: [{ id: 'ORG-AK-001', pattern: '<正则>', severity: 'hard', paths: ['.*'] }],
    process_rules: { pr_requires_acceptance_section: 'hard', require_durable_audit: false },
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, Buffer.from(canonicalJson(envelope)), privateKey).toString('base64');
  const result = verifyEnvelope({ envelope, signature, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) });
  assert.equal(result.state, 'verified');
  assert.equal(evaluateProcessRules({ rules: ['pr-acceptance-section'], facts: { prBody: 'no section' }, severities: result.processRules }).deny.length, 1);
});
