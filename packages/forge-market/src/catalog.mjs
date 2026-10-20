const REQUIRED = ['name', 'title', 'version'];

export function normalizeEntry(raw) {
  const missing = REQUIRED.filter((key) => !raw?.[key]);
  if (missing.length) return { ok: false, reason: 'missing-fields', detail: missing };
  return {
    ok: true,
    entry: {
      name: String(raw.name),
      title: String(raw.title),
      summary: String(raw.summary ?? ''),
      scenarios: Array.isArray(raw.scenarios) ? raw.scenarios.map(String) : [],
      maintainer: String(raw.maintainer ?? ''),
      repo: String(raw.repo ?? ''),
      version: String(raw.version),
      versions: Array.isArray(raw.versions) ? raw.versions.map(String) : [String(raw.version)],
      engines: String(raw.engines?.dsh ?? ''),
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
