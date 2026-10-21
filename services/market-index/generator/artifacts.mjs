// policy / evidence / current 的组装与一致性校验（DESIGN-012 §3.5）。
// 只处理已冻结的契约：不代跑检查、不读企业源；检查结论由调用方以夹具提供。

import { createHash } from 'node:crypto';

export const CHECK_IDS = Object.freeze([
  'package-shape',
  'self-contained',
  'peer-baseline',
  'matrix-smoke',
  'provenance',
  'integrity',
  'display',
]);

const ORIGINS = new Set(['public-mirror', 'internal']);
const DECISIONS = new Set(['allow', 'deny']);
const RESULTS = new Set(['pass', 'fail', 'unknown']);
const MAX_LEASE_MS = 15 * 60 * 1000;

const POLICY_KEYS = new Set(['schemaVersion', 'policyRevision', 'generation', 'matrixId', 'generatedAt', 'registryId', 'nativeIndexDigest', 'entries', 'revocations']);
const EVIDENCE_KEYS = new Set(['schemaVersion', 'policyRevision', 'generation', 'matrixId', 'generatedAt', 'registryId', 'nativeIndexDigest', 'inputs', 'candidates']);
const CURRENT_KEYS = new Set(['schemaVersion', 'policyRevision', 'generation', 'matrixId', 'generatedAt', 'registryId', 'installEnabled', 'expiresAt', 'snapshot']);
const SNAPSHOT_KEYS = new Set(['indexUrl', 'policyUrl', 'evidenceUrl', 'nativeIndexDigest', 'policyDigest', 'evidenceDigest']);
const ENTRY_KEYS = new Set(['name', 'version', 'integrity', 'decision', 'reasons']);
const REVOCATION_KEYS = new Set(['name', 'version', 'reason']);
const CANDIDATE_KEYS = new Set(['name', 'version', 'registryId', 'origin', 'integrity', 'checks', 'provenance']);
const CHECK_KEYS = new Set(['id', 'result', 'reason', 'checkedAt', 'evidenceRefs']);
const REF_KEYS = new Set(['url', 'digest']);
const INPUT_KEYS = new Set(['allowlistRevision', 'baselineRevision', 'riskRevision', 'generatorRevision']);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v, max = 2048) => typeof v === 'string' && v.length > 0 && v.length <= max;
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** 对原始字节计算 SRI 摘要；产物落盘后再读回应使用同一函数。 */
export const digestBytes = (bytes) => {
  if (!(bytes instanceof Uint8Array)) throw new Error('digest-bytes-invalid');
  return digestOf(bytes);
};

export function serializeArtifact(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function httpsUrl(value) {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function validateRef(ref, path, errors) {
  if (!isRecord(ref)) {
    errors.push({ code: 'ref-invalid', path });
    return;
  }
  for (const key of Object.keys(ref)) {
    if (!REF_KEYS.has(key)) errors.push({ code: 'unknown-field', path: `${path}.${key}` });
  }
  if (!httpsUrl(ref.url)) errors.push({ code: 'url-invalid', path: `${path}.url` });
  if (!DIGEST.test(ref.digest ?? '')) errors.push({ code: 'digest-invalid', path: `${path}.digest` });
}

function validateCheck(check, path, errors) {
  if (!isRecord(check)) {
    errors.push({ code: 'check-invalid', path });
    return;
  }
  for (const key of Object.keys(check)) {
    if (!CHECK_KEYS.has(key)) errors.push({ code: 'unknown-field', path: `${path}.${key}` });
  }
  if (!CHECK_IDS.includes(check.id)) errors.push({ code: 'check-id-invalid', path: `${path}.id`, detail: String(check.id) });
  if (!RESULTS.has(check.result)) errors.push({ code: 'check-result-invalid', path: `${path}.result` });
  if (!RFC3339.test(check.checkedAt ?? '') || Number.isNaN(Date.parse(check.checkedAt))) {
    errors.push({ code: 'timestamp-invalid', path: `${path}.checkedAt` });
  }
  if ((check.result === 'fail' || check.result === 'unknown') && !text(check.reason)) {
    errors.push({ code: 'check-reason-missing', path: `${path}.reason` });
  }
  if (check.reason !== undefined && typeof check.reason !== 'string') {
    errors.push({ code: 'check-reason-invalid', path: `${path}.reason` });
  }
  const refs = check.evidenceRefs;
  if (!Array.isArray(refs)) {
    errors.push({ code: 'ref-invalid', path: `${path}.evidenceRefs` });
  } else {
    refs.forEach((ref, index) => validateRef(ref, `${path}.evidenceRefs[${index}]`, errors));
  }
}

function validateProvenance(origin, provenance, path, errors) {
  if (!isRecord(provenance)) {
    errors.push({ code: 'provenance-missing', path });
    return;
  }
  const required = origin === 'internal' ? ['group', 'repo', 'commit', 'buildRef'] : ['upstream', 'scanRef', 'licenseRef'];
  const allowed = new Set(required);
  for (const key of Object.keys(provenance)) {
    if (!allowed.has(key)) errors.push({ code: 'unknown-field', path: `${path}.${key}` });
  }
  for (const key of required) {
    if (provenance[key] === undefined) {
      errors.push({ code: 'provenance-missing', path: `${path}.${key}` });
    }
  }
  if (origin === 'internal') {
    for (const key of ['group', 'repo']) {
      if (provenance[key] !== undefined && !text(provenance[key])) errors.push({ code: 'provenance-invalid', path: `${path}.${key}` });
    }
    if (provenance.commit !== undefined && !COMMIT.test(provenance.commit)) {
      errors.push({ code: 'provenance-invalid', path: `${path}.commit` });
    }
    if (provenance.buildRef !== undefined) validateRef(provenance.buildRef, `${path}.buildRef`, errors);
  } else if (origin === 'public-mirror') {
    if (provenance.upstream !== undefined && !httpsUrl(provenance.upstream)) {
      errors.push({ code: 'url-invalid', path: `${path}.upstream` });
    }
    for (const key of ['scanRef', 'licenseRef']) {
      if (provenance[key] !== undefined) validateRef(provenance[key], `${path}.${key}`, errors);
    }
  }
}

function validateCandidate(candidate, header, path, errors) {
  if (!isRecord(candidate)) {
    errors.push({ code: 'candidate-invalid', path });
    return;
  }
  for (const key of Object.keys(candidate)) {
    if (!CANDIDATE_KEYS.has(key)) errors.push({ code: 'unknown-field', path: `${path}.${key}` });
  }
  if (!text(candidate.name, 214)) errors.push({ code: 'candidate-invalid', path: `${path}.name` });
  if (!SEMVER.test(candidate.version ?? '')) errors.push({ code: 'version-invalid', path: `${path}.version` });
  if (candidate.registryId !== header.registryId) errors.push({ code: 'candidate-registry-mismatch', path: `${path}.registryId` });
  if (!ORIGINS.has(candidate.origin)) errors.push({ code: 'candidate-origin-invalid', path: `${path}.origin` });
  if (candidate.integrity !== undefined && !DIGEST.test(candidate.integrity)) {
    errors.push({ code: 'digest-invalid', path: `${path}.integrity` });
  }
  if (!Array.isArray(candidate.checks)) {
    errors.push({ code: 'checks-invalid', path: `${path}.checks` });
  } else {
    const seen = new Set();
    candidate.checks.forEach((check, index) => {
      const checkPath = `${path}.checks[${index}]`;
      validateCheck(check, checkPath, errors);
      if (check?.id && seen.has(check.id)) errors.push({ code: 'check-duplicate', path: `${checkPath}.id` });
      if (check?.id) seen.add(check.id);
    });
  }
  validateProvenance(candidate.origin, candidate.provenance, `${path}.provenance`, errors);
}

function validatePolicyEntry(entry, path, errors) {
  if (!isRecord(entry)) {
    errors.push({ code: 'policy-entry-invalid', path });
    return;
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) errors.push({ code: 'unknown-field', path: `${path}.${key}` });
  }
  if (!text(entry.name, 214)) errors.push({ code: 'policy-entry-invalid', path: `${path}.name` });
  if (!SEMVER.test(entry.version ?? '')) errors.push({ code: 'version-invalid', path: `${path}.version` });
  if (!DECISIONS.has(entry.decision)) errors.push({ code: 'policy-entry-invalid', path: `${path}.decision` });
  if (!Array.isArray(entry.reasons) || entry.reasons.some((reason) => !text(reason))) {
    errors.push({ code: 'policy-entry-invalid', path: `${path}.reasons` });
  } else if (entry.decision === 'deny' && entry.reasons.length === 0) {
    errors.push({ code: 'policy-deny-without-reason', path: `${path}.reasons` });
  } else if (entry.decision === 'allow' && entry.reasons.length > 0) {
    errors.push({ code: 'policy-allow-with-reason', path: `${path}.reasons` });
  }
  if (entry.integrity !== undefined && !DIGEST.test(entry.integrity)) {
    errors.push({ code: 'digest-invalid', path: `${path}.integrity` });
  }
  if (entry.decision === 'allow' && !DIGEST.test(entry.integrity ?? '')) {
    errors.push({ code: 'policy-allow-without-integrity', path: `${path}.integrity` });
  }
}

/**
 * 组装快照：由候选检查结果决定 allow/deny，输出 policy、evidence、current 及其原始字节。
 * 任何结构问题直接抛错，不产出半份快照。
 */
export function buildSnapshot(input) {
  const {
    registryId,
    matrixId,
    policyRevision,
    generation,
    generatedAt,
    expiresAt,
    revision,
    nativeIndexBytes,
    candidates,
    revocations = [],
    indexUrl,
    policyUrl,
    evidenceUrl,
    installEnabled = true,
  } = input;

  if (!text(registryId, 128) || !text(matrixId, 128) || !text(policyRevision, 512)) throw new Error('snapshot-header-invalid');
  if (!Number.isInteger(generation) || generation < 1) throw new Error('snapshot-generation-invalid');
  if (!RFC3339.test(generatedAt) || !RFC3339.test(expiresAt)) throw new Error('snapshot-timestamp-invalid');
  if (!isRecord(revision)) throw new Error('snapshot-revision-invalid');
  for (const key of INPUT_KEYS) {
    if (!text(revision[key], 512)) throw new Error(`snapshot-revision-invalid:${key}`);
  }
  if (!Array.isArray(candidates)) throw new Error('snapshot-candidates-invalid');
  if (!(nativeIndexBytes instanceof Uint8Array)) throw new Error('snapshot-index-bytes-invalid');
  for (const [key, value] of Object.entries({ indexUrl, policyUrl, evidenceUrl })) {
    if (!httpsUrl(value)) throw new Error(`snapshot-url-invalid:${key}`);
  }

  const entries = [];
  const evidenceCandidates = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !Array.isArray(candidate.checks)) throw new Error('snapshot-candidate-invalid');
    const reasons = [];
    if (!DIGEST.test(candidate.integrity ?? '')) reasons.push('missing-integrity');
    const byId = new Map(candidate.checks.map((check) => [check.id, check]));
    for (const id of CHECK_IDS) {
      const check = byId.get(id);
      if (!check) reasons.push(`missing-check:${id}`);
      else if (check.result !== 'pass') reasons.push(`${check.result}:${id}${check.reason ? `:${check.reason}` : ''}`);
    }
    entries.push({
      name: candidate.name,
      version: candidate.version,
      ...(candidate.integrity ? { integrity: candidate.integrity } : {}),
      decision: reasons.length === 0 ? 'allow' : 'deny',
      reasons,
    });
    evidenceCandidates.push({
      name: candidate.name,
      version: candidate.version,
      registryId: candidate.registryId,
      origin: candidate.origin,
      ...(candidate.integrity ? { integrity: candidate.integrity } : {}),
      checks: candidate.checks,
      provenance: candidate.provenance,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  evidenceCandidates.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const nativeIndexDigest = digestOf(nativeIndexBytes);
  const header = {
    schemaVersion: 1,
    policyRevision,
    generation,
    matrixId,
    generatedAt,
    registryId,
  };

  const policy = { ...header, nativeIndexDigest, entries, revocations };
  const evidence = { ...header, nativeIndexDigest, inputs: { ...revision }, candidates: evidenceCandidates };
  const policyBytes = serializeArtifact(policy);
  const evidenceBytes = serializeArtifact(evidence);
  const current = {
    ...header,
    installEnabled,
    expiresAt,
    snapshot: {
      indexUrl,
      policyUrl,
      evidenceUrl,
      nativeIndexDigest,
      policyDigest: digestOf(policyBytes),
      evidenceDigest: digestOf(evidenceBytes),
    },
  };
  const currentBytes = serializeArtifact(current);

  const result = { policy, evidence, current, bytes: { policy: policyBytes, evidence: evidenceBytes, current: currentBytes } };
  const validation = validateSnapshot({ ...result, now: Date.parse(generatedAt) });
  if (!validation.ok) throw new Error(`snapshot-invalid:${validation.errors[0]?.code}`);
  return result;
}

/**
 * 校验一组已存在的快照（可带原始字节）：
 * 公共头一致、摘要互指、entry 与 candidate 对齐、租约窗口、来源与检查完整。
 */
export function validateSnapshot({ policy, evidence, current, policyBytes, evidenceBytes, now = Date.now() }) {
  const errors = [];
  const headerFields = ['schemaVersion', 'policyRevision', 'generation', 'matrixId', 'generatedAt', 'registryId'];

  for (const [name, value, keys] of [['policy', policy, POLICY_KEYS], ['evidence', evidence, EVIDENCE_KEYS], ['current', current, CURRENT_KEYS]]) {
    if (!isRecord(value)) {
      errors.push({ code: 'snapshot-missing', path: name });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!keys.has(key)) errors.push({ code: 'unknown-field', path: `${name}.${key}` });
    }
    if (value.schemaVersion !== 1) errors.push({ code: 'schema-version-unsupported', path: `${name}.schemaVersion` });
    if (!text(value.policyRevision, 512)) errors.push({ code: 'policy-revision-invalid', path: `${name}.policyRevision` });
    if (!Number.isInteger(value.generation) || value.generation < 1) errors.push({ code: 'generation-invalid', path: `${name}.generation` });
    if (!text(value.matrixId, 128)) errors.push({ code: 'matrix-invalid', path: `${name}.matrixId` });
    if (!text(value.registryId, 128)) errors.push({ code: 'registry-invalid', path: `${name}.registryId` });
    if (!RFC3339.test(value.generatedAt ?? '') || Number.isNaN(Date.parse(value.generatedAt))) {
      errors.push({ code: 'timestamp-invalid', path: `${name}.generatedAt` });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  for (const field of headerFields) {
    if (policy[field] !== evidence[field] || policy[field] !== current[field]) {
      errors.push({ code: 'snapshot-header-mismatch', path: field });
    }
  }

  if (!DIGEST.test(policy.nativeIndexDigest ?? '')) errors.push({ code: 'digest-invalid', path: 'policy.nativeIndexDigest' });
  if (policy.nativeIndexDigest !== evidence.nativeIndexDigest) errors.push({ code: 'snapshot-digest-mismatch', path: 'evidence.nativeIndexDigest' });

  const snap = current.snapshot;
  if (!isRecord(snap)) {
    errors.push({ code: 'snapshot-missing', path: 'current.snapshot' });
  } else {
    for (const key of Object.keys(snap)) {
      if (!SNAPSHOT_KEYS.has(key)) errors.push({ code: 'unknown-field', path: `current.snapshot.${key}` });
    }
    for (const key of ['indexUrl', 'policyUrl', 'evidenceUrl']) {
      if (!httpsUrl(snap[key])) errors.push({ code: 'url-invalid', path: `current.snapshot.${key}` });
    }
    for (const key of ['nativeIndexDigest', 'policyDigest', 'evidenceDigest']) {
      if (!DIGEST.test(snap[key] ?? '')) errors.push({ code: 'digest-invalid', path: `current.snapshot.${key}` });
    }
    // 三个地址必须同源：跨源会让快照的字节与摘要关系无法由单一托管方保证。
    const origins = ['indexUrl', 'policyUrl', 'evidenceUrl']
      .filter((key) => httpsUrl(snap[key]))
      .map((key) => new URL(snap[key]).origin);
    if (new Set(origins).size > 1) errors.push({ code: 'url-not-same-origin', path: 'current.snapshot' });
    if (snap.nativeIndexDigest !== policy.nativeIndexDigest) errors.push({ code: 'snapshot-digest-mismatch', path: 'current.snapshot.nativeIndexDigest' });
    if (policyBytes !== undefined && snap.policyDigest !== digestOf(policyBytes)) {
      errors.push({ code: 'snapshot-digest-mismatch', path: 'current.snapshot.policyDigest' });
    }
    if (evidenceBytes !== undefined && snap.evidenceDigest !== digestOf(evidenceBytes)) {
      errors.push({ code: 'snapshot-digest-mismatch', path: 'current.snapshot.evidenceDigest' });
    }
  }

  if (typeof current.installEnabled !== 'boolean') errors.push({ code: 'install-enabled-invalid', path: 'current.installEnabled' });
  if (!RFC3339.test(current.expiresAt ?? '') || Number.isNaN(Date.parse(current.expiresAt))) {
    errors.push({ code: 'timestamp-invalid', path: 'current.expiresAt' });
  } else {
    const start = Date.parse(policy.generatedAt);
    const end = Date.parse(current.expiresAt);
    const lease = end - start;
    if (!(lease > 0 && lease <= MAX_LEASE_MS)) errors.push({ code: 'current-lease-invalid', path: 'current.expiresAt' });
    if (!(now >= start && now < end)) errors.push({ code: 'current-not-live', path: 'current.expiresAt' });
  }

  if (!Array.isArray(policy.entries)) {
    errors.push({ code: 'policy-entries-invalid', path: 'policy.entries' });
  } else {
    const seen = new Set();
    policy.entries.forEach((entry, index) => {
      const path = `policy.entries[${index}]`;
      validatePolicyEntry(entry, path, errors);
      const key = `${entry?.name}@${entry?.version}`;
      if (seen.has(key)) errors.push({ code: 'policy-entry-duplicate', path });
      seen.add(key);
    });
  }

  if (!Array.isArray(policy.revocations)) {
    errors.push({ code: 'revocations-invalid', path: 'policy.revocations' });
  } else {
    policy.revocations.forEach((item, index) => {
      const path = `policy.revocations[${index}]`;
      if (!isRecord(item)) {
        errors.push({ code: 'revocation-invalid', path });
        return;
      }
      for (const key of Object.keys(item)) {
        if (!REVOCATION_KEYS.has(key)) errors.push({ code: 'unknown-field', path: `${path}.${key}` });
      }
      if (!text(item.name, 214)) errors.push({ code: 'revocation-invalid', path: `${path}.name` });
      if (item.version !== undefined && !SEMVER.test(item.version)) errors.push({ code: 'version-invalid', path: `${path}.version` });
      if (!text(item.reason)) errors.push({ code: 'revocation-invalid', path: `${path}.reason` });
    });
  }

  if (!isRecord(evidence.inputs)) {
    errors.push({ code: 'revision-empty', path: 'evidence.inputs' });
  } else {
    for (const key of Object.keys(evidence.inputs)) {
      if (!INPUT_KEYS.has(key)) errors.push({ code: 'unknown-field', path: `evidence.inputs.${key}` });
    }
    for (const key of INPUT_KEYS) {
      if (!text(evidence.inputs[key], 512)) errors.push({ code: 'revision-empty', path: `evidence.inputs.${key}` });
    }
  }

  if (!Array.isArray(evidence.candidates)) {
    errors.push({ code: 'candidates-invalid', path: 'evidence.candidates' });
  } else {
    const seen = new Set();
    evidence.candidates.forEach((candidate, index) => {
      const path = `evidence.candidates[${index}]`;
      validateCandidate(candidate, policy, path, errors);
      const key = `${candidate?.name}@${candidate?.version}`;
      if (seen.has(key)) errors.push({ code: 'candidate-duplicate', path });
      seen.add(key);
    });
    if (Array.isArray(policy.entries)) {
      const evidenceKeys = new Set(evidence.candidates.map((item) => `${item?.name}@${item?.version}`));
      for (const entry of policy.entries) {
        const key = `${entry?.name}@${entry?.version}`;
        if (!evidenceKeys.has(key)) errors.push({ code: 'candidate-mismatch', path: `policy.entries:${key}` });
        const candidate = evidence.candidates.find((item) => `${item?.name}@${item?.version}` === key);
        if (candidate && entry.decision === 'allow') {
          if (!DIGEST.test(candidate.integrity ?? '')) errors.push({ code: 'policy-allow-without-integrity', path: `evidence.candidates:${key}` });
          const byId = new Map((candidate.checks ?? []).map((check) => [check.id, check]));
          for (const id of CHECK_IDS) {
            const check = byId.get(id);
            if (!check || check.result !== 'pass') {
              errors.push({ code: 'checks-incomplete', path: `evidence.candidates:${key}.checks:${id}` });
            }
          }
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}