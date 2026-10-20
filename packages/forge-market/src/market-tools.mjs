import { filterEntries, normalizeEntry, sortEntries } from './catalog.mjs';
import { planInstall } from './installer.mjs';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function tool(name, description, parameters, handler) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      const value = await handler(args ?? {});
      return json(value);
    },
  };
}

export function buildMarketTools(client, options = {}) {
  const allowedHosts = options.allowedHosts ?? [];

  return [
    tool(
      'market_search',
      'Search the enterprise plugin market by keyword and return entries sorted by stars, then downloads.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'keyword matched against name, title, summary and scenarios' },
          sort: { type: 'string', enum: ['stars', 'downloads'], description: 'sort key, defaults to stars' },
          limit: { type: 'integer', description: 'maximum entries to return, defaults to 20' },
        },
        additionalProperties: false,
      },
      async ({ query = '', sort = 'stars', limit = 20 }) => {
        const raw = await client.list();
        const entries = (raw?.entries ?? raw ?? []).map((item) => normalizeEntry(item)).filter((r) => r.ok).map((r) => r.entry);
        const matched = sortEntries(filterEntries(entries, query), sort).slice(0, Math.max(1, limit));
        return { total: matched.length, entries: matched };
      },
    ),
    tool(
      'market_detail',
      'Return one market entry with its versions, engines requirement and repository address.',
      {
        type: 'object',
        properties: { name: { type: 'string', description: 'exact package name, e.g. @heluo/forge-gateway' } },
        required: ['name'],
        additionalProperties: false,
      },
      async ({ name }) => {
        const raw = await client.detail(name);
        return normalizeEntry(raw?.entry ?? raw);
      },
    ),
    tool(
      'market_submit',
      'Submit a plugin for review: the repository must belong to the enterprise group and carry a semver tag.',
      {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'repository address inside the enterprise group' },
          tag: { type: 'string', description: 'release tag such as v0.1.0' },
          title: { type: 'string' },
          summary: { type: 'string' },
          scenarios: { type: 'array', items: { type: 'string' } },
        },
        required: ['repo', 'tag', 'title'],
        additionalProperties: false,
      },
      async ({ repo, tag, title, summary = '', scenarios = [] }) => {
        if (!/^v\d+\.\d+\.\d+$/.test(String(tag))) return { ok: false, reason: 'bad-tag' };
        if (!allowedHosts.length) return { ok: false, reason: 'no-allowed-host' };
        let host;
        try {
          host = new URL(repo).host;
        } catch {
          return { ok: false, reason: 'bad-repo' };
        }
        if (!allowedHosts.includes(host)) return { ok: false, reason: 'host-not-allowed' };
        const result = await client.submit({ repo, tag, title, summary, scenarios });
        return { ok: true, state: result?.state ?? 'pending' };
      },
    ),
    tool(
      'market_plan_install',
      'Resolve the tag and repository for one entry and version, without downloading anything.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'exact package name' },
          version: { type: 'string', description: 'version to plan for, defaults to the latest listed' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async ({ name, version }) => {
        const raw = await client.detail(name);
        const normalized = normalizeEntry(raw?.entry ?? raw);
        if (!normalized.ok) return normalized;
        return planInstall(normalized.entry, version, allowedHosts);
      },
    ),
  ];
}
