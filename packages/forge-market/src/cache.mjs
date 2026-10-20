import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export async function readCache(path, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!path) return { ok: false, reason: 'no-path' };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(parsed?.entries)) return { ok: false, reason: 'bad-cache' };
    const age = now - Number(parsed.savedAt ?? 0);
    return { ok: true, entries: parsed.entries, savedAt: parsed.savedAt ?? 0, stale: age > ttlMs };
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'bad-cache' };
  }
}

export async function writeCache(path, entries, { now = Date.now() } = {}) {
  if (!path) return { ok: false, reason: 'no-path' };
  if (!Array.isArray(entries)) return { ok: false, reason: 'bad-entries' };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ savedAt: now, entries }, null, 2));
    return { ok: true, count: entries.length };
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
}
