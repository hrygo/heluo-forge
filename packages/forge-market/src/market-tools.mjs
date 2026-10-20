import { readCache, writeCache } from './cache.mjs';
import { filterEntries, normalizeEntry, pickUpdate, sortEntries } from './catalog.mjs';
import { downloadArchive, installPlugin } from './install.mjs';
import { planInstall } from './installer.mjs';
import { persistFiles } from './persist.mjs';
import { buildRegistrationRow, registrationInstructions, renderPatch } from './registration.mjs';
import { extractTarball } from './tarball.mjs';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function tool(name, description, parameters, handler) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => json(value).content },
    async execute(args) {
      try {
        return json(await handler(args ?? {}));
      } catch (error) {
        const reason = typeof error?.code === 'string' ? error.code : 'internal';
        return json({ ok: false, reason, detail: String(error?.message ?? error) });
      }
    },
  };
}

export function buildMarketTools(client, options = {}) {
  const allowedHosts = options.allowedHosts ?? [];
  const deps = {
    download: (repo, tag, archiveUrl) =>
      downloadArchive(archiveUrl || `${repo.replace(/\/$/, '')}/archive/refs/tags/${tag}.tar.gz`),
    extract: async (bytes) => extractTarball(bytes),
    ...options.install,
  };

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
        const cachePath = options.cachePath;
        let entries;
        let source = 'service';
        let stale = false;
        try {
          const raw = await client.list();
          entries = (raw?.entries ?? raw ?? []).map((item) => normalizeEntry(item)).filter((r) => r.ok).map((r) => r.entry);
          if (cachePath) await writeCache(cachePath, entries);
        } catch (error) {
          const cached = await readCache(cachePath);
          if (!cached.ok) return { ok: false, reason: error?.code ?? 'service-unavailable' };
          entries = cached.entries;
          source = 'cache';
          stale = cached.stale;
        }
        const matched = sortEntries(filterEntries(entries, query), sort).slice(0, Math.max(1, limit));
        return { total: matched.length, source, stale, entries: matched };
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
          name: { type: 'string', description: 'package name, e.g. @heluo/forge-gateway' },
          repo: { type: 'string', description: 'repository address inside the enterprise group' },
          tag: { type: 'string', description: 'release tag such as v0.1.0' },
          summary: { type: 'string' },
          scenarios: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'repo', 'tag'],
        additionalProperties: false,
      },
      async ({ name, repo, tag, summary = '', scenarios = [] }) => {
        if (!/^v\d+\.\d+\.\d+$/.test(String(tag))) return { ok: false, reason: 'bad-tag' };
        if (!allowedHosts.length) return { ok: false, reason: 'no-allowed-host' };
        let host;
        try {
          host = new URL(repo).host;
        } catch {
          return { ok: false, reason: 'bad-repo' };
        }
        if (!allowedHosts.includes(host)) return { ok: false, reason: 'host-not-allowed' };
        const result = await client.submit({ name, repo, tag, summary, scenarios });
        return { ok: true, state: result?.state ?? 'pending' };
      },
    ),
    tool(
      'market_diagnostics',
      'List repositories the index refused, with the reason codes, so a maintainer can fix them.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const raw = await client.unindexed();
        const entries = Array.isArray(raw?.entries) ? raw.entries : [];
        return {
          total: entries.length,
          entries: entries.map((item) => ({
            repo: String(item?.repo ?? ''),
            name: String(item?.name ?? ''),
            errors: Array.isArray(item?.errors) ? item.errors.map(String) : [],
          })),
        };
      },
    ),
    tool(
      'market_check_update',
      'Compare an installed version with the latest listed one; changes nothing.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'exact package name' },
          installedVersion: { type: 'string', description: 'version currently installed on this machine' },
        },
        required: ['name', 'installedVersion'],
        additionalProperties: false,
      },
      async ({ name, installedVersion }) => {
        const raw = await client.detail(name);
        const normalized = normalizeEntry(raw?.entry ?? raw);
        if (!normalized.ok) return normalized;
        return pickUpdate(normalized.entry, installedVersion);
      },
    ),
    tool(
      'market_registration',
      'Return the loader row and instructions needed to register an installed plugin in a profile.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'installed package name, e.g. @heluo/forge-market' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async ({ name }) => {
        const built = buildRegistrationRow({ name }, options.registration ?? {});
        if (!built.ok) return built;
        return { ok: true, row: built.row, patch: renderPatch(built.row), steps: registrationInstructions(built.row) };
      },
    ),
    tool(
      'market_install',
      'Download one entry from the enterprise group, verify its digest, unpack it and return the loader row needed to register it.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'exact package name' },
          version: { type: 'string', description: 'version to install, defaults to the latest listed' },
          digest: { type: 'string', description: 'expected sha256 digest returned by the service' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async ({ name, version, digest }) => {
        const raw = await client.detail(name);
        const normalized = normalizeEntry(raw?.entry ?? raw);
        if (!normalized.ok) return normalized;
        const planned = planInstall(normalized.entry, version, allowedHosts);
        if (!planned.ok) return planned;

        // 服务知道归档地址与摘要，也只有在它这里才能把下载计到条目上。
        let plan = planned.plan;
        let expectedDigest = digest;
        if (typeof client.downloadInfo === 'function') {
          try {
            const info = await client.downloadInfo(plan.name, plan.version);
            if (info?.url) {
              const host = new URL(info.url).host;
              if (!allowedHosts.length || allowedHosts.includes(host)) {
                plan = { ...plan, archiveUrl: info.url };
                expectedDigest = digest || info.digest || undefined;
              }
            }
          } catch {
            // 服务不提供下载信息时退回按仓库与标签推导。
          }
        }

        const result = await installPlugin(plan, { ...deps, expectedDigest });
        if (!result.ok) return result;

        const built = buildRegistrationRow(result.installed, options.registration ?? {});
        const registration = built.ok
          ? { row: built.row, patch: renderPatch(built.row), steps: registrationInstructions(built.row) }
          : { error: built.reason };
        if (!options.targetDir) return { ...result, registration };

        const persisted = await persistFiles(result.installed.files ?? [], options.targetDir);
        return persisted.ok
          ? { ...result, registration, persisted }
          : { ok: false, reason: persisted.reason, detail: persisted.detail };
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
