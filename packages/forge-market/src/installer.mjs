import { createHash } from 'node:crypto';

export const ALLOWED_PREFIXES = ['package.json', 'cordis.patch.yml', 'README.md', 'src/', 'ui/', 'locale/', 'lib/'];

export function digestOf(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function planInstall(entry, version, allowedHosts = []) {
  const versions = entry?.versions ?? [];
  const usable = versions.filter((item) => item?.revoked !== true && item !== undefined);
  const chosen = version
    ? versions.find((item) => item?.version === version || item === version)
    : usable[usable.length - 1];
  if (!chosen) return { ok: false, reason: 'no-version' };
  const resolved = typeof chosen === 'string' ? { version: chosen, tag: `v${chosen}` } : chosen;
  if (!resolved.version) return { ok: false, reason: 'no-version' };
  if (resolved.revoked === true) return { ok: false, reason: 'version-revoked' };
  // 版本号非法时标签也会错，直接报出来，不要让用户面对一个 404 下载失败。
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(resolved.version))) {
    return { ok: false, reason: 'bad-version', detail: resolved.version };
  }
  if (!entry?.repo && !resolved.archiveUrl) return { ok: false, reason: 'no-repo' };
  const target = resolved.archiveUrl || entry.repo;
  let url;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, reason: 'bad-repo' };
  }
  if (allowedHosts.length && !allowedHosts.includes(url.host)) return { ok: false, reason: 'host-not-allowed' };
  return {
    ok: true,
    plan: {
      name: entry.name,
      version: resolved.version,
      repo: entry.repo,
      tag: resolved.tag || `v${resolved.version}`,
      archiveUrl: resolved.archiveUrl || '',
      revoked: resolved.revoked === true,
    },
  };
}

export function verifyDigest(bytes, expected) {
  if (!expected) return { ok: false, reason: 'no-digest' };
  return digestOf(bytes) === expected ? { ok: true } : { ok: false, reason: 'digest-mismatch' };
}

export function checkArchivePaths(paths) {
  const bad = [];
  const write = [];
  const skipped = [];
  for (const path of paths) {
    const normalized = String(path).replace(/\\/g, '/');
    // 越界路径一律拒绝：这是安全问题，不是格式问题。
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
      bad.push(path);
      continue;
    }
    // 仓库里会有 LICENSE、docs/、测试等；只写白名单内的文件，其余跳过并如实上报。
    if (ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) write.push(path);
    else skipped.push(path);
  }
  if (bad.length) return { ok: false, reason: 'unsafe-path', detail: bad };
  return { ok: true, write, skipped };
}
