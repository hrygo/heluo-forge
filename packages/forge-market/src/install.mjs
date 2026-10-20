import { checkArchivePaths, digestOf, verifyDigest } from './installer.mjs';

export async function downloadArchive(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, reason: 'download-failed', detail: response.status };
    return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export async function installPlugin(plan, deps = {}) {
  const { download, extract, expectedDigest, onInstalled } = deps;
  if (!plan?.repo || !plan?.tag) return { ok: false, reason: 'bad-plan' };
  if (typeof download !== 'function' || typeof extract !== 'function') return { ok: false, reason: 'missing-dependency' };

  const fetched = await download(plan.repo, plan.tag);
  if (!fetched?.ok) return { ok: false, reason: fetched?.reason ?? 'download-failed' };

  const bytes = fetched.bytes;
  if (expectedDigest) {
    const digest = verifyDigest(bytes, expectedDigest);
    if (!digest.ok) return { ok: false, reason: digest.reason };
  } else if (fetched.digest && digestOf(bytes) !== fetched.digest) {
    return { ok: false, reason: 'digest-mismatch' };
  }

  const extracted = await extract(bytes);
  if (!extracted?.ok) return { ok: false, reason: extracted?.reason ?? 'extract-failed' };

  const paths = extracted.files.map((file) => file.path);
  const safe = checkArchivePaths(paths);
  if (!safe.ok) return { ok: false, reason: safe.reason, detail: safe.detail };

  const manifest = extracted.files.find((file) => file.path === 'package.json');
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

  const installed = { name: pkg.name, version: pkg.version, tag: plan.tag, files: extracted.files, paths };
  if (typeof onInstalled === 'function') await onInstalled(installed);
  return { ok: true, installed };
}
