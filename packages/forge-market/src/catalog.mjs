const REQUIRED = ['name', 'version'];

export function normalizeVersion(raw) {
  if (typeof raw === 'string') return { version: raw, tag: `v${raw}` };
  const version = String(raw?.version ?? '');
  return {
    version,
    tag: String(raw?.tag ?? (version ? `v${version}` : '')),
    archiveUrl: raw?.archiveUrl ? String(raw.archiveUrl) : '',
    engines: String(raw?.engines ?? ''),
    submittedAt: raw?.submittedAt ? String(raw.submittedAt) : '',
  };
}

export function normalizeEntry(raw) {
  const missing = REQUIRED.filter((key) => !raw?.[key]);
  if (missing.length) return { ok: false, reason: 'missing-fields', detail: missing };
  const versions = (Array.isArray(raw.versions) && raw.versions.length ? raw.versions : [raw.version]).map(normalizeVersion);
  const latest = versions[versions.length - 1];
  return {
    ok: true,
    entry: {
      name: String(raw.name),
      title: String(raw.title ?? raw.name),
      summary: String(raw.summary ?? ''),
      scenarios: Array.isArray(raw.scenarios) ? raw.scenarios.map(String) : [],
      maintainer: String(raw.maintainer ?? ''),
      repo: String(raw.repo ?? ''),
      status: String(raw.status ?? 'listed'),
      version: latest.version,
      versions,
      engines: String(latest.engines || raw.engines?.dsh || ''),
      downloads: Number(raw.downloads ?? 0) || 0,
      stars: Number(raw.stars ?? 0) || 0,
    },
  };
}

export function sortEntries(entries, key = 'stars') {
  const rank = (entry) => (key === 'downloads' ? entry.downloads : key === 'updated' ? entry.updatedAt ?? 0 : entry.stars);
  return [...entries].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
}

export function filterEntries(entries, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    [entry.name, entry.title, entry.summary, ...entry.scenarios].join(' ').toLowerCase().includes(needle),
  );
}

export function compareVersions(a, b) {
  const parse = (value) => String(value ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function pickUpdate(entry, installedVersion) {
  if (!installedVersion) return { updateAvailable: false, reason: 'no-installed-version' };
  const latest = entry?.versions?.[entry.versions.length - 1]?.version ?? entry?.version;
  if (!latest) return { updateAvailable: false, reason: 'no-latest-version' };
  const order = compareVersions(latest, installedVersion);
  return {
    updateAvailable: order > 0,
    installed: String(installedVersion),
    latest: String(latest),
    reason: order > 0 ? null : 'up-to-date',
  };
}
