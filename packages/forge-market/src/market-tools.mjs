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
