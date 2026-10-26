/**
 * 交付清单的冻结与校验：原子写入、`O_EXCL` 串行、版本一致性。
 *
 * 指纹一致只证明文件未被改动，不证明业务正确；显式变更后必须重新冻结。
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { blockingFindings, fingerprint, inspectManifest, MANIFEST_VERSION, SddManifestError } from './manifest.mjs';

function readFileOrUndefined(path, encoding = undefined) {
  try {
    return readFileSync(path, encoding);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function loadManifest(path) {
  const text = readFileOrUndefined(path, 'utf8');
  if (text === undefined) {
    throw new SddManifestError(`manifest "${path}" does not exist`, 'SDD_MANIFEST_MISSING', { path });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SddManifestError(`manifest "${path}" is not valid JSON: ${error.message}`, 'SDD_MANIFEST_INVALID', { path });
  }
}

/**
 * Freeze the given artifacts atomically. A held lock refuses the freeze; a
 * failing run leaves neither a partial manifest nor the previous one replaced.
 *
 * @param {{freezePath: string, unitId: string, changeId: string, revision: string,
 *   testedRevision: string, requirementRevision?: string, stage?: string,
 *   artifacts: {path: string, kind?: string, unitId?: string}[], testEvidence?: object[],
 *   root?: string, now?: () => Date, lockPath?: string}} input
 */
export function freeze(input) {
  const { freezePath, root = '.', artifacts } = input;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new SddManifestError('freeze needs at least one artifact', 'SDD_FREEZE_NO_ARTIFACTS');
  }
  const lockPath = input.lockPath ?? `${freezePath}.lock`;
  mkdirSync(dirname(freezePath), { recursive: true });
  let lockFd;
  try {
    lockFd = openSync(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new SddManifestError(
        `another freeze holds the lock "${lockPath}"; remove it manually after confirming no freeze is running`,
        'SDD_LOCK_HELD',
        { lockPath },
      );
    }
    throw error;
  }
  const temporary = `${freezePath}.tmp-${process.pid}`;
  try {
    writeFileSync(lockFd, `${process.pid}\n`);
    const entries = [];
    for (const artifact of artifacts) {
      const absolute = `${root}/${artifact.path}`.replace(/\/+/gu, '/');
      const bytes = readFileOrUndefined(absolute);
      if (bytes === undefined) {
        throw new SddManifestError(`artifact "${artifact.path}" does not exist`, 'SDD_ARTIFACT_MISSING', { path: artifact.path });
      }
      entries.push({
        path: artifact.path,
        sha256: fingerprint(bytes),
        kind: artifact.kind,
        unitId: artifact.unitId ?? input.unitId,
      });
    }
    const manifest = {
      version: MANIFEST_VERSION,
      unitId: input.unitId,
      changeId: input.changeId,
      revision: input.revision,
      testedRevision: input.testedRevision,
      requirementRevision: input.requirementRevision,
      stage: input.stage,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      artifacts: entries,
      testEvidence: input.testEvidence ?? [],
    };
    const { findings } = inspectManifest(manifest);
    const blocking = blockingFindings(findings);
    if (blocking.length > 0) {
      throw new SddManifestError(
        `refusing to freeze an invalid manifest: ${blocking.map((finding) => `${finding.rule} (${finding.locator ?? '-'})`).join(', ')}`,
        'SDD_FREEZE_INVALID',
        { findings: blocking },
      );
    }
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporary, freezePath);
    return manifest;
  } finally {
    rmSync(temporary, { force: true });
    if (lockFd !== undefined) closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
}

/**
 * Verify a frozen manifest against the working tree.
 *
 * The legacy readText injection still accepts UTF-8 strings for text fixtures;
 * binary-aware readers must return Buffer, as the default reader does.
 *
 * @param {{manifest: object, root?: string, currentRevision?: string, readText?: (path: string) => string | Buffer | undefined}} input
 */
export function verifyManifest(input) {
  const { manifest, root = '.', currentRevision } = input;
  const read = input.readText ?? readFileOrUndefined;
  const { findings, stage } = inspectManifest(manifest);
  const results = [...findings];
  for (const artifact of Array.isArray(manifest?.artifacts) ? manifest.artifacts : []) {
    const absolute = `${root}/${artifact?.path}`.replace(/\/+/gu, '/');
    const text = read(absolute);
    const locator = artifact?.path;
    if (text === undefined) {
      results.push({ severity: 'HARD', rule: 'artifact-missing', message: `artifact "${locator}" is missing`, locator });
      continue;
    }
    if (fingerprint(text) !== artifact?.sha256) {
      results.push({
        severity: 'HARD',
        rule: 'fingerprint-mismatch',
        message: `artifact "${locator}" changed after the freeze; re-freeze explicitly`,
        locator,
      });
    }
  }
  if (currentRevision !== undefined && manifest?.revision !== undefined && manifest.revision !== currentRevision) {
    results.push({
      severity: 'HARD',
      rule: 'revision-drift',
      message: `manifest was frozen at ${manifest.revision} but the repository is at ${currentRevision}; the freeze is stale`,
      locator: 'revision',
    });
  }
  const blocking = blockingFindings(results);
  return {
    ok: blocking.length === 0,
    stage,
    severity: stage === undefined ? 'hard-only' : 'staged',
    findings: results,
    blocking,
    // 指纹只证明文件未被改动，不证明业务正确（AC2）。
    notes: [
      '指纹一致只证明文件未被改动，不证明业务正确',
      '本地结论标注为未经 CI 验证，不替代 CI 权威结论',
    ],
  };
}
