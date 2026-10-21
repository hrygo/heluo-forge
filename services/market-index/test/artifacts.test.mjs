import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_IDS, buildSnapshot, serializeArtifact, validateSnapshot } from '../generator/artifacts.mjs';

const T0 = '2026-10-21T06:00:00Z';
const T1 = '2026-10-21T06:10:00Z';
const REF = { url: 'https://evidence.corp.example/check.json', digest: `sha256:${'a'.repeat(64)}` };
const INTEGRITY = `sha256:${'b'.repeat(64)}`;

const checks = () => CHECK_IDS.map((id) => ({ id, result: 'pass', checkedAt: T0, evidenceRefs: [REF] }));

const candidate = (overrides = {}) => ({
  name: '@heluo/forge-example',
  version: '1.0.0',
  registryId: 'corp-prod',
  origin: 'internal',
  integrity: INTEGRITY,
  checks: checks(),
  provenance: { group: 'heluo', repo: 'forge-example', commit: 'c'.repeat(40), buildRef: REF },
  ...overrides,
});

const build = (overrides = {}) =>
  buildSnapshot({
    registryId: 'corp-prod',
    matrixId: 'matrix-win-kylin',
    policyRevision: 'rev-2026-10-21-1',
    generation: 3,
    generatedAt: T0,
    expiresAt: T1,
    revision: {
      allowlistRevision: 'allow-1',
      baselineRevision: 'base-1',
      riskRevision: 'risk-1',
      generatorRevision: 'gen-1',
    },
    nativeIndexBytes: Buffer.from('{"format":1}\n'),
    candidates: [candidate()],
    indexUrl: 'https://market.corp.example/index.json',
    policyUrl: 'https://market.corp.example/policy.json',
    evidenceUrl: 'https://market.corp.example/evidence.json',
    ...overrides,
  });

const validate = (snapshot, extra = {}) =>
  validateSnapshot({
    policy: snapshot.policy,
    evidence: snapshot.evidence,
    current: snapshot.current,
    policyBytes: snapshot.bytes.policy,
    evidenceBytes: snapshot.bytes.evidence,
    now: Date.parse(T0),
    ...extra,
  });

const codes = (result) => result.errors.map((entry) => entry.code);
const clone = (value) => structuredClone(value);

test('组装出可校验的 allow 快照', () => {
  const snapshot = build();
  assert.equal(snapshot.policy.entries[0].decision, 'allow');
  assert.deepEqual(validate(snapshot), { ok: true, errors: [] });
  assert.match(snapshot.current.snapshot.policyDigest, /^sha256:[0-9a-f]{64}$/);
});

test('检查失败或缺失时拒绝该版本', () => {
  const failed = checks().map((check) => (check.id === 'self-contained' ? { ...check, result: 'fail', reason: 'has-dependencies' } : check));
  const denied = build({ candidates: [candidate({ checks: failed })] });
  assert.equal(denied.policy.entries[0].decision, 'deny');
  assert.ok(denied.policy.entries[0].reasons.includes('fail:self-contained:has-dependencies'));
  assert.equal(validate(denied).ok, true);

  const partial = build({ candidates: [candidate({ checks: checks().filter((check) => check.id !== 'matrix-smoke') })] });
  assert.equal(partial.policy.entries[0].decision, 'deny');
  assert.ok(partial.policy.entries[0].reasons.includes('missing-check:matrix-smoke'));
});

test('缺少完整性时拒绝且不写 integrity', () => {
  const snapshot = build({ candidates: [candidate({ integrity: undefined })] });
  assert.equal(snapshot.policy.entries[0].decision, 'deny');
  assert.equal(snapshot.policy.entries[0].integrity, undefined);
  assert.equal(validate(snapshot).ok, true);
});

test('公共头不一致被拒绝', () => {
  const snapshot = build();
  const evidence = clone(snapshot.evidence);
  evidence.policyRevision = 'other';
  assert.ok(codes(validateSnapshot({ ...snapshot, evidence, now: Date.parse(T0) })).includes('snapshot-header-mismatch'));
});

test('摘要互指不一致被拒绝', () => {
  const snapshot = build();
  const current = clone(snapshot.current);
  current.snapshot.policyDigest = `sha256:${'d'.repeat(64)}`;
  const withBytes = (overrides) =>
    validateSnapshot({
      policy: overrides.policy ?? snapshot.policy,
      evidence: snapshot.evidence,
      current: overrides.current ?? snapshot.current,
      policyBytes: snapshot.bytes.policy,
      evidenceBytes: snapshot.bytes.evidence,
      now: Date.parse(T0),
    });
  assert.ok(codes(withBytes({ current })).includes('snapshot-digest-mismatch'));

  const index = clone(snapshot.current);
  index.snapshot.nativeIndexDigest = `sha256:${'e'.repeat(64)}`;
  assert.ok(codes(withBytes({ current: index })).includes('snapshot-digest-mismatch'));
});

test('租约窗口与在线时间', () => {
  assert.throws(() => build({ expiresAt: '2026-10-21T06:20:00Z' }), /current-lease-invalid/);
  assert.throws(() => build({ expiresAt: T0 }), /current-lease-invalid/);

  const snapshot = build();
  assert.ok(codes(validateSnapshot({ ...snapshot, now: Date.parse(T1) })).includes('current-not-live'));
  assert.ok(codes(validateSnapshot({ ...snapshot, now: Date.parse('2026-10-21T05:59:59Z') })).includes('current-not-live'));
});

test('allow 缺 integrity、检查不全由二次校验拦下', () => {
  const noIntegrity = build();
  delete noIntegrity.policy.entries[0].integrity;
  assert.ok(codes(validate(noIntegrity)).includes('policy-allow-without-integrity'));

  const missingCheck = build();
  missingCheck.evidence.candidates[0].checks = missingCheck.evidence.candidates[0].checks.slice(1);
  assert.ok(codes(validate(missingCheck)).includes('checks-incomplete'));
});

test('未知字段与非法布尔被拒绝', () => {
  const extra = build();
  extra.policy.extra = true;
  assert.ok(codes(validate(extra)).includes('unknown-field'));

  const flag = build();
  flag.current.installEnabled = 'yes';
  assert.ok(codes(validate(flag)).includes('install-enabled-invalid'));
});

test('来源证据按 origin 校验', () => {
  const missing = build();
  delete missing.evidence.candidates[0].provenance.buildRef;
  assert.ok(codes(validate(missing)).includes('provenance-missing'));

  const badCommit = build();
  badCommit.evidence.candidates[0].provenance.commit = 'short';
  assert.ok(codes(validate(badCommit)).includes('provenance-invalid'));

  const mirror = build({
    candidates: [
      candidate({
        origin: 'public-mirror',
        provenance: {
          upstream: 'https://registry.npmjs.org/example',
          scanRef: REF,
          licenseRef: REF,
        },
      }),
    ],
  });
  assert.equal(validate(mirror).ok, true, JSON.stringify(validate(mirror).errors));
});

test('快照地址必须同源', () => {
  const snapshot = build();
  const current = clone(snapshot.current);
  current.snapshot.policyUrl = 'https://other.corp.example/policy.json';
  const result = validateSnapshot({
    policy: snapshot.policy,
    evidence: snapshot.evidence,
    current,
    now: Date.parse(T0),
  });
  assert.ok(codes(result).includes('url-not-same-origin'));
});

test('引用地址与摘要格式', () => {
  const snapshot = build();
  snapshot.evidence.candidates[0].checks[0].evidenceRefs = [{ url: 'http://x/', digest: `sha256:${'a'.repeat(64)}` }];
  assert.ok(codes(validate(snapshot)).includes('url-invalid'));
});

test('重复候选与空 revision 被拒绝', () => {
  const duplicate = build();
  duplicate.evidence.candidates.push(clone(duplicate.evidence.candidates[0]));
  assert.ok(codes(validate(duplicate)).includes('candidate-duplicate'));

  const empty = build();
  empty.evidence.inputs.riskRevision = '';
  assert.ok(codes(validate(empty)).includes('revision-empty'));
});

test('deny 必须有原因，allow 不写原因', () => {
  const snapshot = build({ candidates: [candidate({ checks: checks().filter((check) => check.id !== 'display') })] });
  assert.equal(snapshot.policy.entries[0].decision, 'deny');
  assert.ok(snapshot.policy.entries[0].reasons.length > 0);

  const broken = build();
  broken.policy.entries[0].reasons = [];
  broken.policy.entries[0].decision = 'deny';
  assert.ok(codes(validate(broken)).includes('policy-deny-without-reason'));
});

test('序列化稳定，摘要对应原始字节', () => {
  const snapshot = build();
  assert.equal(serializeArtifact(snapshot.policy), snapshot.bytes.policy);
  const again = build();
  assert.equal(again.bytes.policy, snapshot.bytes.policy);
  assert.equal(again.current.snapshot.policyDigest, snapshot.current.snapshot.policyDigest);
});