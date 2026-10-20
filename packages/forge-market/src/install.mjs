import { checkArchivePaths, digestOf, verifyDigest } from './installer.mjs';
import { checkEngines } from './policy.mjs';
import { patchPluginNames, patchRelativeTargets, validatePatch } from './validate.mjs';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export async function downloadArchive(url, { fetchImpl = globalThis.fetch, timeoutMs = 30000, maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, reason: 'download-failed', detail: response.status };

    // 先看声明长度，避免为明显过大的归档分配内存。
    const declared = Number(response.headers?.get?.('content-length') ?? 0);
    if (declared > maxBytes) return { ok: false, reason: 'archive-too-large', detail: declared };

    const reader = response.body?.getReader?.();
    if (!reader) return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) };

    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel?.();
        return { ok: false, reason: 'archive-too-large', detail: total };
      }
      chunks.push(Buffer.from(value));
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export async function installPlugin(plan, deps = {}) {
  const { download, extract, expectedDigest, onInstalled, dshVersion } = deps;
  if (!plan?.repo || !plan?.tag) return { ok: false, reason: 'bad-plan' };
  if (plan.revoked) return { ok: false, reason: 'version-revoked' };
  if (typeof download !== 'function' || typeof extract !== 'function') return { ok: false, reason: 'missing-dependency' };

  let fetched;
  try {
    fetched = await download(plan.repo, plan.tag, plan.archiveUrl);
  } catch (error) {
    return { ok: false, reason: 'download-failed', detail: String(error?.message ?? error) };
  }
  if (!fetched?.ok) return { ok: false, reason: fetched?.reason ?? 'download-failed' };

  const bytes = fetched.bytes;
  if (expectedDigest) {
    const digest = verifyDigest(bytes, expectedDigest);
    if (!digest.ok) return { ok: false, reason: digest.reason };
  } else if (fetched.digest && digestOf(bytes) !== fetched.digest) {
    return { ok: false, reason: 'digest-mismatch' };
  }

  let extracted;
  try {
    extracted = await extract(bytes);
  } catch (error) {
    return { ok: false, reason: 'extract-failed', detail: String(error?.message ?? error) };
  }
  if (!extracted?.ok) return { ok: false, reason: extracted?.reason ?? 'extract-failed' };

  const paths = extracted.files.map((file) => file.path);
  const safe = checkArchivePaths(paths);
  if (!safe.ok) return { ok: false, reason: safe.reason, detail: safe.detail };

  const allowed = new Set(safe.write ?? paths);
  const kept = extracted.files.filter((file) => allowed.has(file.path));
  const manifest = kept.find((file) => file.path === 'package.json');
  if (!manifest) return { ok: false, reason: 'missing-manifest' };
  let pkg;
  try {
    pkg = JSON.parse(manifest.bytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad-manifest' };
  }
  if (pkg.name !== plan.name) return { ok: false, reason: 'name-mismatch', detail: pkg.name };
  if (plan.version && pkg.version && pkg.version !== plan.version) {
    return { ok: false, reason: 'version-mismatch', detail: pkg.version };
  }

  // engines.dsh 是硬门槛：不兼容的版本装上去比起装不上更糟。
  const engines = String(pkg.engines?.dsh ?? '');
  if (dshVersion && engines) {
    const verdict = checkEngines(engines, dshVersion);
    if (!verdict.compatible) {
      return { ok: false, reason: 'incompatible-dsh', detail: { requires: engines, running: dshVersion, why: verdict.reason } };
    }
  }

  // 行名指向别的包时，装上去也挂不起来；这里比挂载失败早一步报出来。
  const patch = kept.find((file) => file.path === 'cordis.patch.yml');
  if (patch) {
    const patchText = patch.bytes.toString('utf8');
    // 安装路径同样要过内容规则：不能只在提交自检时检查。
    const patchErrors = validatePatch(patchText);
    if (patchErrors.length) return { ok: false, reason: patchErrors[0].code, detail: patchErrors };

    const declared = patchPluginNames(patchText);
    if (declared.length && !declared.includes(pkg.name)) {
      return { ok: false, reason: 'patch-name-mismatch', detail: declared };
    }
    for (const target of patchRelativeTargets(patchText)) {
      if (!kept.some((file) => file.path === target.slice(2))) {
        return { ok: false, reason: 'patch-missing-target', detail: target };
      }
    }
  }

  const installed = { name: pkg.name, version: pkg.version, tag: plan.tag, files: kept, paths: kept.map((file) => file.path) };
  if (typeof onInstalled === 'function') await onInstalled(installed);
  return { ok: true, installed };
}
