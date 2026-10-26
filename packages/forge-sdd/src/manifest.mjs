/**
 * 交付清单（freeze）的形状与 HARD/SOFT 校验。
 *
 * 清单是"这次交付包含哪些产物、在哪个版本上冻结、测试覆盖到哪个版本"的唯一声明。
 * 校验只看清单声明的事实，不按文件名猜业务范围。
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize, sep } from 'node:path';

export class SddManifestError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'SddManifestError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const MANIFEST_VERSION = 1;
const STAGES = new Set(['spec', 'implementation', 'archive']);
const TEST_STATES = new Set(['passed', 'failed', 'not-run', 'timeout']);
const ARTIFACT_KINDS = new Set(['spec', 'implementation', 'archive']);

/** Hash raw artifact bytes; strings retain UTF-8 compatibility. @param {string | Buffer} content @returns {string} */
export function fingerprint(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** @param {{path: string, unitId?: string}} artifact @param {{unitId: string}} manifest */
export function resolveArtifactPath(artifact, manifest, root = '.') {
  const raw = artifact?.path;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new SddManifestError('artifact path is required', 'SDD_MANIFEST_INVALID', { artifact });
  }
  if (isAbsolute(raw)) {
    throw new SddManifestError(`artifact path "${raw}" must be relative to the manifest root`, 'SDD_PATH_ABSOLUTE', { path: raw });
  }
  const normalized = normalize(raw);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..${sep}`)) {
    throw new SddManifestError(`artifact path "${raw}" escapes the manifest root`, 'SDD_PATH_TRAVERSAL', { path: raw });
  }
  void manifest;
  return join(root, normalized);
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/**
 * Structural validation. Returns findings instead of throwing so the CLI can
 * report every locatable problem at once.
 *
 * @param {unknown} manifest parsed manifest
 * @returns {{findings: object[], stage: string | undefined}}
 */
export function inspectManifest(manifest) {
  const findings = [];
  const add = (severity, rule, message, locator = undefined) => findings.push({ severity, rule, message, ...(locator ? { locator } : {}) });
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    add('HARD', 'manifest-shape', 'manifest must be a JSON object');
    return { findings, stage: undefined };
  }
  if (manifest.version !== MANIFEST_VERSION) {
    add('HARD', 'manifest-version', `manifest version ${manifest.version ?? '(missing)'} is not supported (expected ${MANIFEST_VERSION})`, 'version');
  }
  if (typeof manifest.changeId !== 'string' || manifest.changeId.trim().length === 0) {
    add('HARD', 'change-id-missing', 'changeId is required; a delivery number cannot be inferred from filenames', 'changeId');
  }
  if (typeof manifest.unitId !== 'string' || manifest.unitId.trim().length === 0) {
    add('HARD', 'unit-id-missing', 'unitId is required', 'unitId');
  }
  if (typeof manifest.revision !== 'string' || manifest.revision.trim().length === 0) {
    add('HARD', 'revision-missing', 'revision is required', 'revision');
  }
  if (typeof manifest.testedRevision !== 'string' || manifest.testedRevision.trim().length === 0) {
    add('HARD', 'tested-revision-missing', 'testedRevision is required', 'testedRevision');
  }
  if (typeof manifest.revision === 'string' && manifest.revision.trim().length > 0
    && typeof manifest.testedRevision === 'string' && manifest.testedRevision.trim().length > 0
    && manifest.testedRevision !== manifest.revision) {
    add('HARD', 'test-revision-mismatch', `testedRevision ${manifest.testedRevision} does not cover delivery revision ${manifest.revision}`, 'testedRevision');
  }
  if (manifest.stage !== undefined && !STAGES.has(manifest.stage)) {
    add('HARD', 'stage-unknown', `stage "${manifest.stage}" is not one of spec, implementation, archive`, 'stage');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    add('HARD', 'artifacts-missing', 'at least one artifact is required', 'artifacts');
    return { findings, stage: manifest.stage };
  }
  for (const artifact of manifest.artifacts) {
    const locator = typeof artifact?.path === 'string' ? artifact.path : '(unnamed artifact)';
    try {
      resolveArtifactPath(artifact, manifest);
    } catch (error) {
      add('HARD', error.code === 'SDD_PATH_TRAVERSAL' ? 'path-traversal' : 'path-invalid', error.message, locator);
    }
    if (typeof artifact?.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
      add('HARD', 'fingerprint-missing', `artifact "${locator}" needs a sha256 fingerprint`, locator);
    }
    if (artifact?.kind !== undefined && !ARTIFACT_KINDS.has(artifact.kind)) {
      add('HARD', 'artifact-kind-unknown', `artifact "${locator}" kind must be spec, implementation or archive`, locator);
    }
    if (typeof manifest.unitId === 'string' && artifact?.unitId !== undefined && artifact.unitId !== manifest.unitId) {
      add('HARD', 'foreign-unit-artifact', `artifact "${locator}" belongs to unit "${artifact.unitId}", not "${manifest.unitId}"`, locator);
    }
  }
  for (const path of findDuplicates(manifest.artifacts.map((artifact) => artifact?.path))) {
    add('HARD', 'artifact-duplicate', `artifact "${path}" is listed more than once`, path);
  }
  if (manifest.testEvidence !== undefined) {
    if (!Array.isArray(manifest.testEvidence)) {
      add('HARD', 'test-evidence-shape', 'testEvidence must be an array', 'testEvidence');
    } else {
      for (const evidence of manifest.testEvidence) {
        const locator = typeof evidence?.ref === 'string' ? evidence.ref : '(unnamed evidence)';
        if (!TEST_STATES.has(evidence?.state)) {
          add('HARD', 'test-state-unknown', `test evidence "${locator}" state must be passed, failed, not-run or timeout`, locator);
          continue;
        }
        if (evidence.state !== 'passed') {
          add('HARD', 'test-not-passed', `test evidence "${locator}" is ${evidence.state}; it is not a pass`, locator);
        }
        if (evidence.state === 'passed' && typeof evidence.testedRevision === 'string' && typeof manifest.testedRevision === 'string' && evidence.testedRevision !== manifest.testedRevision) {
          add('HARD', 'test-revision-mismatch', `test evidence "${locator}" covers ${evidence.testedRevision}, not ${manifest.testedRevision}`, locator);
        }
      }
    }
  }
  if (manifest.stage !== undefined) {
    const kinds = new Set(manifest.artifacts.map((artifact) => artifact?.kind).filter((kind) => kind !== undefined));
    if (!kinds.has('spec') || !kinds.has('implementation')) {
      add('HARD', 'atomic-delivery', 'a staged delivery must include both spec and implementation artifacts in one manifest', 'artifacts');
    }
    if (!kinds.has('archive')) {
      add('SOFT', 'archive-missing', 'no archive artifact: archive linkage is a soft expectation', 'artifacts');
    }
  }
  return { findings, stage: manifest.stage };
}

/** HARD rules always run; SOFT rules only when the manifest declares a stage. */
export function blockingFindings(findings) {
  return findings.filter((finding) => finding.severity === 'HARD');
}
