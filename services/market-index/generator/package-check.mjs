// 发布包结构与自包含检查（DESIGN-012 §3.3、DESIGN-007 §6.1）。
// 输入是"已解包的真实包"清单（package.json + tar 文件列表），不联网、不执行包内代码。
// 结论只是候选证据：matrix smoke、integrity、provenance 仍需真实环境补齐。

import { createHash } from 'node:crypto';

const RUNTIME_DEP_FIELDS = ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const SAFE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value, max = 2048) => typeof value === 'string' && value.length > 0 && value.length <= max;

function check(id, result, reason = '') {
  return { id, result, reason };
}

function normalizeFiles(files) {
  const set = new Set(['package.json']);
  const unsafe = [];
  for (const entry of Array.isArray(files) ? files : []) {
    if (typeof entry !== 'string' || entry.length === 0) {
      unsafe.push(String(entry));
      continue;
    }
    const path = entry.replace(/^\.\//, '');
    if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) unsafe.push(entry);
    else set.add(path);
  }
  return { set, unsafe };
}

function exportTargets(exportsField) {
  const targets = [];
  const walk = (value) => {
    if (typeof value === 'string') targets.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) Object.values(value).forEach(walk);
  };
  walk(exportsField);
  return targets;
}

function hasRuntimeDeps(manifest) {
  const found = [];
  for (const field of RUNTIME_DEP_FIELDS) {
    const value = manifest[field];
    if (value === undefined) continue;
    const count = Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : -1;
    if (count !== 0) found.push(field);
  }
  return found;
}

function inspectShape(manifest, fileSet, unsafe) {
  const reasons = [];
  if (!SAFE_NAME.test(manifest.name ?? '')) reasons.push('name-invalid');
  if (!SEMVER.test(manifest.version ?? '')) reasons.push('version-invalid');
  if (!text(manifest.engines?.dsh)) reasons.push('engines-dsh-missing');

  const patch = manifest.dsh?.bundle?.patch;
  if (!text(patch)) reasons.push('patch-missing');
  else if (!fileSet.has(patch.replace(/^\.\//, ''))) reasons.push('patch-not-in-files');

  const targets = [manifest.main, ...exportTargets(manifest.exports)].filter((target) => typeof target === 'string');
  for (const target of targets) {
    if (target.startsWith('./') || !target.startsWith('.')) {
      if (target.includes('*')) continue;
      const path = target.replace(/^\.\//, '');
      if (!fileSet.has(path)) reasons.push(`export-not-in-files:${path}`);
    }
  }
  if (unsafe.length > 0) reasons.push('unsafe-file-path');

  return check('package-shape', reasons.length === 0 ? 'pass' : 'fail', reasons.join(','));
}

function inspectSelfContained(manifest, fileSet) {
  const reasons = [];
  const runtime = hasRuntimeDeps(manifest);
  for (const field of runtime) reasons.push(`runtime-dependency:${field}`);

  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  for (const name of LIFECYCLE_SCRIPTS) {
    if (scripts[name] !== undefined) reasons.push(`lifecycle-script:${name}`);
  }
  // pnpm 对「有 binding.gyp 或 gypfile」的包会尝试本地构建；首版不接受终端编译。
  if (manifest.gypfile === true || fileSet.has('binding.gyp')) reasons.push('terminal-build:node-gyp');

  return check('self-contained', reasons.length === 0 ? 'pass' : 'fail', reasons.join(','));
}

function inspectPeer(manifest, peerBaseline) {
  const peers = isRecord(manifest.peerDependencies) ? Object.keys(manifest.peerDependencies) : [];
  if (peers.length === 0) return check('peer-baseline', 'pass', '');
  if (!Array.isArray(peerBaseline)) {
    return check('peer-baseline', 'unknown', 'peer-baseline-unavailable');
  }
  const allowed = new Set(peerBaseline);
  const outside = peers.filter((name) => !allowed.has(name));
  return check(
    'peer-baseline',
    outside.length === 0 ? 'pass' : 'fail',
    outside.length === 0 ? '' : `peer-outside-baseline:${outside.join(',')}`,
  );
}

function inspectDisplay(manifest, fileSet, origin) {
  // 内部包必须有完整显示资源；第三方允许明确 fallback，但结构仍要存在。
  const reasons = [];
  const exportsField = isRecord(manifest.exports) ? manifest.exports : {};
  const iconExport = exportsField['./icon'];
  if (iconExport === undefined) reasons.push('icon-export-missing');
  else {
    const iconPath = typeof iconExport === 'string' ? iconExport.replace(/^\.\//, '') : null;
    if (iconPath && !iconPath.includes('*') && !fileSet.has(iconPath)) reasons.push('icon-not-in-files');
  }
  const localeKeys = Object.keys(exportsField).filter((key) => key.startsWith('./locale/'));
  if (localeKeys.length === 0) reasons.push('locale-export-missing');
  const metaPresent = isRecord(manifest.meta) && Object.keys(manifest.meta).length > 0;
  if (!metaPresent) reasons.push('meta-missing');

  if (reasons.length === 0) return check('display', 'pass', '');
  if (origin === 'public-mirror') return check('display', 'pass', `fallback:${reasons.join(',')}`);
  return check('display', 'fail', reasons.join(','));
}

/**
 * 对真实包清单做结构、自包含、peer 与显示检查。
 * origin=public-mirror 时 display 缺资源记为 pass+fallback；其他缺项仍是 fail。
 */
export function inspectPackage({ manifest, files, peerBaseline = null, origin = 'internal', checkedAt = new Date().toISOString() }) {
  if (!isRecord(manifest)) throw new Error('manifest-invalid');
  const { set, unsafe } = normalizeFiles(files);
  const checks = [
    inspectShape(manifest, set, unsafe),
    inspectSelfContained(manifest, set),
    inspectPeer(manifest, peerBaseline),
    inspectDisplay(manifest, set, origin),
  ];
  return checks.map((entry) => ({ ...entry, checkedAt, evidenceRefs: [] }));
}

/** 计算包字节的 SRI 值；只用于已下载的真实 tarball。 */
export function tarballIntegrity(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('tarball-bytes-invalid');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}