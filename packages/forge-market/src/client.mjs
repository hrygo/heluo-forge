export class MarketError extends Error {
  constructor(code, status, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.status = status;
  }
}

export function createServiceClient({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 5000, token = '' } = {}) {
  if (!baseUrl) throw new MarketError('no-service-url', 0);

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      if (response.status === 401) throw new MarketError('unauthorized', 401);
      if (response.status === 403) throw new MarketError('forbidden', 403);
      if (response.status === 404) throw new MarketError('not-found', 404);
      if (response.status >= 500) throw new MarketError('service-unavailable', response.status);
      if (!response.ok) throw new MarketError('bad-response', response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof MarketError) throw error;
      if (error?.name === 'AbortError') throw new MarketError('timeout', 0);
      throw new MarketError('network', 0, error?.message);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    list: () => request('/api/plugins'),
    detail: (name) => request(`/api/plugins/${encodeURIComponent(name)}`),
    submit: (payload) => request('/api/plugins', { method: 'POST', body: JSON.stringify(payload) }),
    mine: () => request('/api/plugins?mine=1'),
    metrics: (name) => request(`/api/metrics?plugin=${encodeURIComponent(name)}`),
    unindexed: () => request('/api/admin/unindexed'),
  };
}
