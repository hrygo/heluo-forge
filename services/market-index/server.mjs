import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

// 只读参考实现：读目录 JSON，按 DESIGN-012 §5 的端点表应答。
// 不做 Gitee 扫描、评审流与持久化；部署前须置于网关之后并补鉴权。

export async function loadCatalog(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  if (!Array.isArray(entries)) throw new Error('catalog has no entries');
  return entries;
}

function matches(entry, query) {
  if (!query) return true;
  const needle = String(query).toLowerCase();
  return [entry.name, entry.title, entry.summary, ...(entry.scenarios ?? [])].join(' ').toLowerCase().includes(needle);
}

export function createMarketApp({ entries = [], reviews = [], audit = [], seen = new Map(), today = () => new Date().toISOString().slice(0, 10) } = {}) {
  // 目录文件可能不写这些字段；对外一律给出确定的形状。
  entries = entries.map((entry) => ({ maintainer: '', scenarios: [], ...entry }));
  const byName = () => new Map(entries.map((entry) => [entry.name, entry]));

  // 计数按（条目, 机器哈希, 日）去重：同一天重复安装不重复计数，
  // 缺少机器哈希时按（条目, 日）计一次，避免匿名重复上报把数字刷高。
  const countDownload = (entry, machine) => {
    const key = `${entry.name}|${machine || 'anonymous'}|${today()}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    entry.downloads = (entry.downloads ?? 0) + 1;
    return true;
  };

  const publish = (review) => {
    const version = String(review.tag ?? '').replace(/^v/, '');
    const existing = entries.find((entry) => entry.name === review.name);
    if (existing) {
      existing.status = 'listed';
      if (!existing.versions?.some((item) => item.version === version)) {
        existing.versions = [...(existing.versions ?? []), { version, tag: review.tag }];
      }
      return;
    }
    entries.push({
      name: review.name,
      title: review.title || review.name,
      summary: review.summary ?? '',
      scenarios: review.scenarios ?? [],
      maintainer: '',
      repo: review.repo,
      status: 'listed',
      version,
      versions: [{ version, tag: review.tag }],
      stars: 0,
      downloads: 0,
    });
  };

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/plugins' && req.method === 'GET') {
      const query = url.searchParams.get('q') ?? '';
      const sort = url.searchParams.get('sort') === 'downloads' ? 'downloads' : 'stars';
      const matched = entries
        .filter((entry) => matches(entry, query))
        .sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0) || String(a.name).localeCompare(String(b.name)));
      return send(200, { entries: matched });
    }

    if (url.pathname === '/api/plugins' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'bad-json' });
      }
      const missing = ['name', 'repo', 'tag'].filter((key) => !payload[key]);
      if (missing.length) return send(400, { error: 'missing-fields', detail: missing });
      if (!/^v\d+\.\d+\.\d+$/.test(payload.tag)) return send(400, { error: 'bad-tag' });
      reviews.push({
        name: payload.name,
        repo: payload.repo,
        tag: payload.tag,
        title: payload.title ?? '',
        summary: payload.summary ?? '',
        scenarios: Array.isArray(payload.scenarios) ? payload.scenarios.map(String) : [],
        state: 'pending',
      });
      return send(202, { state: 'pending' });
    }

    if (url.pathname === '/api/admin/review' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'bad-json' });
      }
      const actions = { approve: 'listed', reject: 'rejected', revoke: 'revoked' };
      if (!actions[payload.action]) return send(400, { error: 'bad-action' });

      if (payload.action === 'revoke' && payload.version) {
        const target = entries.find((item) => item.name === payload.name);
        const version = target?.versions?.find((item) => item.version === payload.version);
        if (!version) return send(404, { error: 'no-version' });
        version.revoked = true;
        audit.push({ name: payload.name, action: 'revoke-version', version: payload.version, at: new Date().toISOString() });
        return send(200, { name: payload.name, version: payload.version, state: 'revoked' });
      }

      const review = reviews.find((item) => item.name === payload.name && item.state === 'pending');
      const entry = entries.find((item) => item.name === payload.name);
      if (!review && !entry) return send(404, { error: 'not-found' });

      const state = actions[payload.action];
      if (review) review.state = state;
      if (payload.action === 'approve') publish(review ?? { name: entry.name, repo: entry.repo, tag: entry.tag ?? `v${entry.version}` });
      if (payload.action === 'revoke' && entry) {
        entry.status = 'revoked';
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
      }
      if (payload.action === 'reject' && entry) entry.status = 'rejected';
      audit.push({ name: payload.name, action: payload.action, reason: payload.reason ?? '', at: new Date().toISOString() });
      return send(200, { name: payload.name, state });
    }

    if (url.pathname === '/api/admin/unindexed' && req.method === 'GET') {
      return send(200, { entries: [] });
    }

    const detail = url.pathname.match(/^\/api\/plugins\/([^/]+)$/);
    if (detail && req.method === 'GET') {
      const entry = byName().get(decodeURIComponent(detail[1]));
      return entry ? send(200, { entry }) : send(404, { error: 'not-found' });
    }

    const download = url.pathname.match(/^\/api\/plugins\/([^/]+)\/versions\/([^/]+)\/download$/);
    if (download && req.method === 'GET') {
      const entry = byName().get(decodeURIComponent(download[1]));
      if (!entry) return send(404, { error: 'not-found' });
      const version = entry.versions?.find((item) => item.version === decodeURIComponent(download[2]));
      if (!version) return send(404, { error: 'no-version' });
      if (version.revoked) return send(409, { error: 'version-revoked', version: version.version });
      const counted = countDownload(entry, String(req.headers['x-machine-hash'] ?? ''));
      const asset = version.archiveUrl || `${entry.repo}/archive/refs/tags/${version.tag}.tar.gz`;
      return send(200, { name: entry.name, version: version.version, tag: version.tag, url: asset, digest: version.digest ?? '', counted });
    }

    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      const entry = byName().get(url.searchParams.get('plugin') ?? '');
      if (!entry) return send(404, { error: 'not-found' });
      return send(200, { downloads: entry.downloads ?? 0, stars: entry.stars ?? 0 });
    }

    return send(404, { error: 'not-found' });
  };
}

export function startMarketService({ catalogFile, port = 8080, host = '127.0.0.1' } = {}) {
  return loadCatalog(catalogFile).then((entries) => {
    const app = createMarketApp({ entries });
    const server = createServer((req, res) => {
      app(req, res).catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'internal' }));
        }
      });
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const port = Number(get('--port', process.env.PORT ?? 8080));
  const catalogFile = get('--catalog', process.env.CATALOG_FILE);
  if (!catalogFile) {
    console.error('usage: node server.mjs --catalog <file> [--port 8080]');
    process.exit(1);
  }
  startMarketService({ catalogFile, port }).then(() => console.log(`market-index listening on ${port}`));
}
