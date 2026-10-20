import { readCache, writeCache } from './cache.mjs';
import { normalizeEntry, sortEntries } from './catalog.mjs';

export async function loadCatalog(client, cachePath) {
  try {
    const raw = await client.list();
    const entries = (raw?.entries ?? raw ?? [])
      .map((item) => normalizeEntry(item))
      .filter((result) => result.ok)
      .map((result) => result.entry);
    if (cachePath) await writeCache(cachePath, entries);
    return { status: 200, body: { source: 'service', entries: sortEntries(entries) } };
  } catch {
    const cached = await readCache(cachePath);
    if (!cached.ok) return { status: 503, body: { source: 'none', error: 'service-unavailable' } };
    return { status: 200, body: { source: 'cache', stale: cached.stale, entries: sortEntries(cached.entries) } };
  }
}

export async function loadDetail(client, name) {
  try {
    const raw = await client.detail(name);
    const normalized = normalizeEntry(raw?.entry ?? raw);
    if (!normalized.ok) return { status: 404, body: { error: 'not-found', detail: normalized.detail } };
    return { status: 200, body: normalized.entry };
  } catch (error) {
    const status = error?.status === 404 ? 404 : 503;
    return { status, body: { error: status === 404 ? 'not-found' : 'service-unavailable' } };
  }
}

export function createMarketRoutes({ client, cachePath }) {
  return async function handle(req, res) {
    try {
      await route(req, res);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'internal' }));
      }
    }
  };

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(payload);
    };

    if (req.method !== 'GET') return send(405, { error: 'method-not-allowed' });

    if (url.pathname === '/api/forge-market/catalog') {
      const result = await loadCatalog(client, cachePath);
      return send(result.status, result.body);
    }

    const detail = url.pathname.match(/^\/api\/forge-market\/detail\/(.+)$/);
    if (detail) {
      const result = await loadDetail(client, decodeURIComponent(detail[1]));
      return send(result.status, result.body);
    }

    return send(404, { error: 'not-found' });
  }
}
