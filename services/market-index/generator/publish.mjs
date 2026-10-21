// P2 的可离线部分：本地静态发布器——不可变代次目录、current 原子切换、代际防陈旧、轻量续期。
// 不连接企业 CI/托管；单写与原子 rename 的实际设施能力仍属 P0 待证事实。
// 并发安全依赖"单写 owner"这一前提：本模块不做跨进程锁，两个 writer 同时通过 base 检查的竞态
// 仍需企业 CI 的互斥/取消能力兜底，不能把本地 rename 当成分布式原子性证明。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildSnapshot, validateSnapshot } from './artifacts.mjs';
import { readSnapshot } from './generate.mjs';

const FILE_NAMES = { index: 'index.json', policy: 'policy.json', evidence: 'evidence.json', current: 'current.json' };
const MAX_LEASE_MS = 15 * 60 * 1000;

export class PublishError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}:${detail}` : code);
    this.code = code;
    this.detail = detail;
    this.name = 'PublishError';
  }
}

const generationDir = (root, generation) => join(root, 'generations', `g${generation}`);
const tmpDir = (root, generation) => join(root, 'generations', `.g${generation}.${randomBytes(4).toString('hex')}.tmp`);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new PublishError('current-unreadable', path);
  }
}

export async function readCurrent(root) {
  return readJson(join(root, FILE_NAMES.current));
}

async function writeGeneration(root, result) {
  const target = generationDir(root, result.snapshot.current.generation);
  const tmp = tmpDir(root, result.snapshot.current.generation);
  await mkdir(tmp, { recursive: true });
  try {
    await writeFile(join(tmp, FILE_NAMES.index), result.indexBytes);
    for (const key of ['policy', 'evidence', 'current']) {
      await writeFile(join(tmp, FILE_NAMES[key]), result.snapshot.bytes[key]);
    }
    const check = await readSnapshot(tmp, { now: Date.parse(result.snapshot.current.generatedAt) });
    if (!check.ok) throw new PublishError('snapshot-invalid', check.errors[0]?.code ?? 'unknown');
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    if (error instanceof PublishError) throw error;
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') throw new PublishError('generation-exists', String(result.snapshot.current.generation));
    throw new PublishError('generation-write-failed', String(error?.message ?? error));
  }
}

async function switchCurrent(root, bytes) {
  const path = join(root, FILE_NAMES.current);
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

/**
 * 发布一份完整快照。要求代次严格递增，且与调用方读到的 baseGeneration 一致；
 * 任一不符即拒绝，不覆盖已存在的代次目录、不切 current。
 */
export async function publishSnapshot(root, result, { expectBaseGeneration = null } = {}) {
  const incoming = result.snapshot.current.generation;
  if (!Number.isInteger(incoming) || incoming < 1) throw new PublishError('generation-invalid');

  const current = await readCurrent(root);
  const base = current?.generation ?? 0;
  if (expectBaseGeneration !== null && expectBaseGeneration !== base) {
    throw new PublishError('stale-base-generation', `${expectBaseGeneration} != ${base}`);
  }
  if (incoming <= base) throw new PublishError('stale-generation', `${incoming} <= ${base}`);

  await writeGeneration(root, result);
  await switchCurrent(root, result.snapshot.bytes.current);
  return { generation: incoming, policyRevision: result.snapshot.current.policyRevision, baseGeneration: base };
}

async function readGeneration(root, generation) {
  const directory = generationDir(root, generation);
  const [indexBytes, policyBytes, evidenceBytes, currentBytes] = await Promise.all([
    readFile(join(directory, FILE_NAMES.index)),
    readFile(join(directory, FILE_NAMES.policy)),
    readFile(join(directory, FILE_NAMES.evidence)),
    readFile(join(directory, FILE_NAMES.current)),
  ]);
  return {
    indexBytes,
    policy: JSON.parse(policyBytes.toString('utf8')),
    evidence: JSON.parse(evidenceBytes.toString('utf8')),
    current: JSON.parse(currentBytes.toString('utf8')),
  };
}

/**
 * 轻量续期：复用当前代次的索引字节与候选证据，只提升 generation、刷新 generatedAt/expiresAt。
 * 输入 revision 必须与当前代次一致；否则拒绝，走拒绝快照路径。
 */
export async function renewCurrent(root, { now = new Date(), leaseMs = 5 * 60 * 1000, expectedInputs } = {}) {
  const current = await readCurrent(root);
  if (!current) throw new PublishError('current-missing');
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!(nowMs >= Date.parse(current.generatedAt) && nowMs < Date.parse(current.expiresAt))) {
    throw new PublishError('current-not-live');
  }
  const generation = await readGeneration(root, current.generation);

  if (!(leaseMs > 0 && leaseMs <= MAX_LEASE_MS)) throw new PublishError('lease-invalid', String(leaseMs));
  const inputs = generation.evidence.inputs;
  if (expectedInputs !== undefined && JSON.stringify(expectedInputs) !== JSON.stringify(inputs)) {
    throw new PublishError('inputs-changed');
  }

  const generatedAt = now instanceof Date ? now.toISOString() : String(now);
  const expiresAt = new Date(Date.parse(generatedAt) + leaseMs).toISOString();

  const snapshot = buildSnapshot({
    registryId: generation.policy.registryId,
    matrixId: generation.policy.matrixId,
    policyRevision: generation.policy.policyRevision,
    generation: current.generation + 1,
    generatedAt,
    expiresAt,
    revision: inputs,
    nativeIndexBytes: generation.indexBytes,
    candidates: generation.evidence.candidates,
    revocations: generation.policy.revocations ?? [],
    indexUrl: current.snapshot.indexUrl,
    policyUrl: current.snapshot.policyUrl,
    evidenceUrl: current.snapshot.evidenceUrl,
    installEnabled: current.installEnabled,
  });

  const result = { indexBytes: generation.indexBytes, snapshot };
  const receipt = await publishSnapshot(root, result, { expectBaseGeneration: current.generation });
  return { ...receipt, expiresAt };
}

/** 按 current 指针读回已发布代次并复核。 */
export async function readPublished(root, { now = Date.now() } = {}) {
  const current = await readCurrent(root);
  if (!current) throw new PublishError('current-missing');
  return readSnapshot(generationDir(root, current.generation), { now });
}

/**
 * 拒绝快照：空可安装索引 + installEnabled=false，仍走同一代次与原子切换。
 * 用于源失败、撤回或输入无效时先关闭安装。
 */
export function buildRejection({ base, indexUrl, now = new Date(), leaseMs = 5 * 60 * 1000, reason = 'rejected', revocation }) {
  const urls = base.urls ?? {};
  indexUrl = indexUrl ?? urls.indexUrl;
  const policyUrl = base.policyUrl ?? urls.policyUrl;
  const evidenceUrl = base.evidenceUrl ?? urls.evidenceUrl;
  if (!(leaseMs > 0 && leaseMs <= MAX_LEASE_MS)) throw new PublishError('lease-invalid', String(leaseMs));
  const generatedAt = now instanceof Date ? now.toISOString() : String(now);
  const header = {
    registryId: base.registryId,
    matrixId: base.matrixId,
    policyRevision: base.policyRevision,
    generation: base.generation,
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + leaseMs).toISOString(),
    revision: base.revision,
    nativeIndexBytes: Buffer.from(`${JSON.stringify({ format: 1, title: { en: 'Enterprise Plugin Market' }, metadata: {}, plugins: [] }, null, 2)}\n`),
    candidates: [],
    revocations: revocation ? [revocation] : [],
    indexUrl,
    policyUrl,
    evidenceUrl,
    installEnabled: false,
  };
  const snapshot = buildSnapshot(header);
  return { indexBytes: header.nativeIndexBytes, snapshot, reason };
}