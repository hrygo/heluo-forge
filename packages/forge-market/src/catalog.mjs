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
    revoked: raw?.revoked === true,
  };
}

export function normalizeEntry(raw) {
  const missing = REQUIRED.filter((key) => !raw?.[key]);
  if (missing.length) return { ok: false, reason: 'missing-fields', detail: missing };
  const versions = (Array.isArray(raw.versions) && raw.versions.length ? raw.versions : [raw.version]).map(normalizeVersion);

  // 有更新的可用版本即视为「被替代」；撤回的版本不参与比较。
  const usable = versions.filter((item) => !item.revoked);
  const newest = usable[usable.length - 1] ?? versions[versions.length - 1];
  for (const item of versions) {
    item.superseded = usable.some((other) => compareVersions(other.version, item.version) > 0);
  }
  const latest = newest;
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
      latest: latest.version,
      engines: String(latest.engines || raw.engines?.dsh || ''),
      downloads: Number(raw.downloads ?? 0) || 0,
      stars: Number(raw.stars ?? 0) || 0,
    },
  };
}

export function sortEntries(entries, key = 'stars') {
  const rank = (entry) => (key === 'downloads' ? entry.downloads : key === 'updated' ? entry.updatedAt ?? 0 : entry.stars);
  // 同级用包名兜底，且按码位比较：localeCompare 依赖运行环境的区域设置，
  // 不同机器可能给出不同顺序，排序就不再可复现。
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return [...entries].sort((a, b) => rank(b) - rank(a) || byName(a, b));
}

export function filterEntries(entries, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    [entry.name, entry.title, entry.summary, ...entry.scenarios].join(' ').toLowerCase().includes(needle),
  );
}

function parseVersion(value) {
  const [core = '', ...rest] = String(value ?? '').split('-');
  const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return { numbers, pre: rest.join('-') };
}

function comparePrerelease(left, right) {
  // 没有预发布标记的大于有标记的：1.0.0 > 1.0.0-rc.1。
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const a = left.split('.');
  const b = right.split('.');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number.parseInt(x, 10);
    const ny = Number.parseInt(y, 10);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return comparePrerelease(left.pre, right.pre);
}

export function pickUpdate(entry, installedVersion) {
  if (!installedVersion) return { updateAvailable: false, reason: 'no-installed-version' };

  const versions = (entry?.versions ?? []).filter((item) => item?.version);
  const usable = versions.filter((item) => item.revoked !== true);
  const latest = usable[usable.length - 1]?.version;
  if (!latest) return { updateAvailable: false, reason: 'no-latest-version' };

  const installed = versions.find((item) => item.version === installedVersion);
  if (installed?.revoked === true) {
    return { updateAvailable: true, installed: String(installedVersion), latest, reason: 'installed-revoked' };
  }

  const order = compareVersions(latest, installedVersion);
  return {
    updateAvailable: order > 0,
    installed: String(installedVersion),
    latest,
    reason: order > 0 ? null : 'up-to-date',
  };
}
