// P1 离线生成流程：清单 + 包清单 → 原生索引 + policy/evidence/current。
// 只做本地夹具与契约校验，不读企业 registry、不执行包内代码、不发布。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateManifest } from './manifest.mjs';
import { buildMarketIndex, parseMarketIndex } from './index-format.mjs';
import { inspectPackage, tarballIntegrity } from './package-check.mjs';
import { buildSnapshot, CHECK_IDS, digestBytes, validateSnapshot } from './artifacts.mjs';

const FILE_NAMES = { index: 'index.json', policy: 'policy.json', evidence: 'evidence.json', current: 'current.json' };
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value, max = 2048) => typeof value === 'string' && value.length > 0 && value.length <= max;

function requireText(value, name) {
  if (!text(value, 512)) throw new Error(`baseline-${name}-invalid`);
  return value;
}

function decide(checks, integrity) {
  if (!integrity) return { allow: false, reasons: ['missing-integrity'] };
  const byId = new Map(checks.map((entry) => [entry.id, entry]));
  const reasons = [];
  for (const id of CHECK_IDS) {
    const entry = byId.get(id);
    if (!entry) reasons.push(`missing-check:${id}`);
    else if (entry.result !== 'pass') reasons.push(`${entry.result}:${id}${entry.reason ? `:${entry.reason}` : ''}`);
  }
  return { allow: reasons.length === 0, reasons };
}

function onceChecks(list, path) {
  const seen = new Set();
  for (const entry of list) {
    if (!isRecord(entry) || !text(entry.id)) throw new Error(`external-check-invalid:${path}`);
    if (seen.has(entry.id)) throw new Error(`external-check-duplicate:${entry.id}`);
    seen.add(entry.id);
  }
  return list;
}

/**
 * 生成一份完整快照。输入全部来自夹具：
 * { manifest, baseline{registryId,matrixId,policyRevision,generation,generatedAt,expiresAt,revision,urls},
 *   packages[{ manifest, files, origin, versionBytes, publishTimestamp, provenance, externalChecks, expectedIntegrity }] }
 */
export function generateSnapshot(input) {
  if (!isRecord(input)) throw new Error('generate-input-invalid');
  const { manifest, baseline, packages } = input;
  if (!isRecord(baseline) || !Array.isArray(packages)) throw new Error('generate-input-invalid');

  const checked = validateManifest(manifest);
  if (!checked.ok) throw new Error(`manifest-invalid:${checked.errors[0]?.code}`);
  const normalized = checked.manifest;

  const registryId = requireText(baseline.registryId, 'registry');
  const matrixId = requireText(baseline.matrixId, 'matrix');
  const registry = normalized.registries.find((entry) => entry.id === registryId);
  if (!registry) throw new Error('baseline-registry-unknown');

  const urls = baseline.urls;
  if (!isRecord(urls)) throw new Error('baseline-urls-invalid');

  const plugins = [];
  const candidates = [];
  const seenNames = new Set();

  for (const pkg of packages) {
    if (!isRecord(pkg) || !isRecord(pkg.manifest)) throw new Error('generate-package-invalid');
    const name = pkg.manifest.name;
    if (seenNames.has(name)) throw new Error(`package-duplicate:${name}`);
    seenNames.add(name);
    const allowed = normalized.packages.find((entry) => entry.name === name);
    if (!allowed) throw new Error(`package-not-allowlisted:${name}`);
    if (allowed.registryId !== registryId) throw new Error(`package-registry-mismatch:${name}`);
    if (!text(pkg.manifest.version, 64)) throw new Error(`package-version-invalid:${name}`);
    if (!Number.isInteger(pkg.publishTimestamp) || pkg.publishTimestamp < 0) throw new Error(`package-timestamp-invalid:${name}`);
    if (!(pkg.versionBytes instanceof Uint8Array)) throw new Error(`package-bytes-invalid:${name}`);

    const integrity = tarballIntegrity(pkg.versionBytes);
    if (pkg.expectedIntegrity !== undefined && pkg.expectedIntegrity !== integrity) {
      throw new Error(`package-integrity-mismatch:${name}`);
    }

    const baseChecks = inspectPackage({
      manifest: pkg.manifest,
      files: pkg.files ?? [],
      peerBaseline: pkg.peerBaseline ?? null,
      origin: allowed.origin,
      checkedAt: baseline.generatedAt,
    });
    const external = onceChecks(pkg.externalChecks ?? [], name);
    const supplied = new Set([...baseChecks, ...external].map((entry) => entry.id));
    const checks = [...baseChecks, ...external];

    if (!supplied.has('integrity')) {
      checks.push({ id: 'integrity', result: 'pass', reason: '', checkedAt: baseline.generatedAt, evidenceRefs: [] });
    }
    if (!supplied.has('provenance')) {
      checks.push({
        id: 'provenance',
        result: isRecord(pkg.provenance) ? 'pass' : 'fail',
        reason: isRecord(pkg.provenance) ? '' : 'provenance-missing',
        checkedAt: baseline.generatedAt,
        evidenceRefs: [],
      });
    }

    const decision = decide(checks, integrity);
    plugins.push({
      name,
      title: pkg.display?.title ?? name,
      ...(pkg.display?.description === undefined ? {} : { description: pkg.display.description }),
      ...(pkg.display?.icon === undefined ? {} : { icon: pkg.display.icon }),
      versions: [
        {
          version: pkg.manifest.version,
          publishTimestamp: pkg.publishTimestamp,
          source: { type: 'npm', registry: registry.url },
          ...(text(pkg.manifest.engines?.dsh) ? { engines: { dsh: pkg.manifest.engines.dsh } } : {}),
        },
      ],
    });
    candidates.push({
      name,
      version: pkg.manifest.version,
      registryId,
      origin: allowed.origin,
      ...(decision.allow ? { integrity } : {}),
      checks,
      provenance: pkg.provenance,
    });
  }

  // 索引只放 allow 版本；与 policy 的 allow 集合必须一一对应。
  const allowedNames = new Set(candidates.filter((entry) => decide(entry.checks, entry.integrity).allow).map((entry) => entry.name));
  const index = buildMarketIndex({
    title: baseline.indexTitle ?? { en: 'Enterprise Plugin Market', zh: '企业插件市场' },
    plugins: plugins.filter((entry) => allowedNames.has(entry.name)),
    indexUrl: urls.indexUrl,
  });
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);

  const snapshot = buildSnapshot({
    registryId,
    matrixId,
    policyRevision: requireText(baseline.policyRevision, 'policy-revision'),
    generation: baseline.generation,
    generatedAt: baseline.generatedAt,
    expiresAt: baseline.expiresAt,
    revision: baseline.revision,
    nativeIndexBytes: indexBytes,
    candidates,
    revocations: baseline.revocations ?? [],
    indexUrl: urls.indexUrl,
    policyUrl: urls.policyUrl,
    evidenceUrl: urls.evidenceUrl,
    installEnabled: baseline.installEnabled ?? true,
  });

  const allowedEntries = snapshot.policy.entries.filter((entry) => entry.decision === 'allow');
  const indexVersions = index.plugins.flatMap((entry) => entry.versions.map((version) => `${entry.name}@${version.version}`));
  if (allowedEntries.length !== indexVersions.length) throw new Error('index-policy-mismatch');
  for (const entry of allowedEntries) {
    if (!indexVersions.includes(`${entry.name}@${entry.version}`)) throw new Error(`index-policy-mismatch:${entry.name}`);
  }

  return { manifest: normalized, index, indexBytes, snapshot };
}

/** 落盘：四个文件按原始字节写出，摘要仍然成立。 */
export async function writeSnapshot(directory, result) {
  await mkdir(directory, { recursive: true });
  const paths = { index: join(directory, FILE_NAMES.index) };
  await writeFile(paths.index, result.indexBytes);
  for (const key of ['policy', 'evidence', 'current']) {
    const path = join(directory, FILE_NAMES[key]);
    await writeFile(path, result.snapshot.bytes[key]);
    paths[key] = path;
  }
  return paths;
}

/** 读回并复核：字节摘要、公共头、allow 集合与索引一致。 */
export async function readSnapshot(directory, { now = Date.now() } = {}) {
  const [indexBytes, policyBytes, evidenceBytes, currentBytes] = await Promise.all([
    readFile(join(directory, FILE_NAMES.index)),
    readFile(join(directory, FILE_NAMES.policy)),
    readFile(join(directory, FILE_NAMES.evidence)),
    readFile(join(directory, FILE_NAMES.current)),
  ]);
  const snapshot = {
    policy: JSON.parse(policyBytes.toString('utf8')),
    evidence: JSON.parse(evidenceBytes.toString('utf8')),
    current: JSON.parse(currentBytes.toString('utf8')),
  };
  const validation = validateSnapshot({ ...snapshot, policyBytes, evidenceBytes, now });
  if (!validation.ok) return { ok: false, errors: validation.errors, snapshot };

  let index;
  try {
    index = parseMarketIndex(JSON.parse(indexBytes.toString('utf8')), snapshot.current.snapshot.indexUrl);
  } catch (error) {
    return { ok: false, errors: [{ code: 'index-format-invalid', path: 'index', detail: String(error?.message ?? error) }], snapshot };
  }
  const indexDigest = digestBytes(indexBytes);
  if (indexDigest !== snapshot.current.snapshot.nativeIndexDigest) {
    return { ok: false, errors: [{ code: 'snapshot-digest-mismatch', path: 'index' }], snapshot };
  }
  const allowed = snapshot.policy.entries.filter((entry) => entry.decision === 'allow').map((entry) => `${entry.name}@${entry.version}`);
  const listed = (index.plugins ?? []).flatMap((entry) => (entry.versions ?? []).map((version) => `${entry.name}@${version.version}`));
  if (allowed.length !== listed.length || allowed.some((key) => !listed.includes(key))) {
    return { ok: false, errors: [{ code: 'index-policy-mismatch', path: 'index' }], snapshot };
  }
  return { ok: true, errors: [], index, snapshot };
}

export { FILE_NAMES };