import { createHash } from 'node:crypto';

const ALLOWED_PREFIXES = ['package.json', 'cordis.patch.yml', 'README.md', 'src/', 'ui/', 'locale/', 'lib/'];

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
  for (const path of paths) {
    const normalized = String(path).replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
      bad.push(path);
      continue;
    }
    if (!ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) bad.push(path);
  }
  return bad.length ? { ok: false, reason: 'unsafe-path', detail: bad } : { ok: true };
}
