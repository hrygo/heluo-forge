import { readCache, writeCache } from './cache.mjs';
import { filterEntries, normalizeEntry, pickUpdate, sortEntries } from './catalog.mjs';
import { downloadArchive, installPlugin } from './install.mjs';
import { planInstall } from './installer.mjs';
import { readFile } from 'node:fs/promises';
import { checkRemote } from './live-check.mjs';
import { packageDirFor, persistFiles } from './persist.mjs';
import { buildRegistrationRow, registrationInstructions, renderPatch } from './registration.mjs';
import { extractTarball } from './tarball.mjs';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

// 把错误翻译成下一步动作，避免让用户自己猜"搜索失败"是什么意思。
export function nextAction(reason) {
  switch (reason) {
    case 'unauthorized':
      return 're-login';
    case 'forbidden':
    case 'scope-not-allowed':
      return 'request-access';
    case 'service-unavailable':
    case 'timeout':
    case 'network':
    case 'download-failed':
      return 'retry';
    case 'version-revoked':
      return 'choose-another-version';
    case 'verification-failed':
    case 'bad-tag':
    case 'bad-manifest':
    case 'missing-manifest':
    case 'missing-engines':
    case 'missing-section':
    case 'install-script':
      return 'fix-the-package';
    default:
      return 'contact-admin';
  }
}

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
        const payload = { ok: false, reason, action: nextAction(reason), detail: String(error?.message ?? error) };
        if (error?.body) payload.server = error.body;
        return json(payload);
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
          if (!cached.ok) {
            const reason = typeof error?.code === 'string' ? error.code : 'internal';
            return { ok: false, reason, action: nextAction(reason) };
          }
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

        // 提交前先自检：不合格的包不该占一次评审。
        if (options.preflight !== false) {
          const verdict = await checkRemote({ repo, tag, allowedHosts, fetchImpl: options.fetchImpl });
          if (!verdict.ok) return { ok: false, reason: 'verification-failed', steps: verdict.steps };
        }

        const result = await client.submit({ name, repo, tag, summary, scenarios });
        return { ok: true, state: result?.state ?? 'pending' };
      },
    ),
    tool(
      'market_verify',
      'Fetch one repository archive and report, step by step, whether it would pass format validation. Reads only.',
      {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'repository address inside the enterprise group' },
          tag: { type: 'string', description: 'release tag such as v0.1.0' },
          digest: { type: 'string', description: 'expected sha256 digest, if the service provided one' },
        },
        required: ['repo', 'tag'],
        additionalProperties: false,
      },
      async ({ repo, tag, digest }) =>
        checkRemote({ repo, tag, digest, allowedHosts, fetchImpl: options.fetchImpl }),
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
        let installed = installedVersion;
        if (!installed && options.targetDir) {
          try {
            const manifest = JSON.parse(await readFile(`${packageDirFor(options.targetDir, name)}/package.json`, 'utf8'));
            installed = manifest.version;
          } catch {
            installed = undefined;
          }
        }
        const raw = await client.detail(name);
        const normalized = normalizeEntry(raw?.entry ?? raw);
        if (!normalized.ok) return normalized;
        return pickUpdate(normalized.entry, installed);
      },
    ),
    tool(
      'market_registration',
      'Return the loader row and instructions needed to register an installed plugin in a profile.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'installed package name, e.g. @heluo/forge-market' },
          version: { type: 'string', description: 'installed version to confirm against the target directory' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async ({ name, version }) => {
        const built = buildRegistrationRow({ name }, options.registration ?? {});
        if (!built.ok) return built;

        // 给了版本就核对：登记一条指向未安装版本的行，比不登记更难查。
        let verified;
        if (version) {
          if (!options.targetDir) {
            verified = { checked: false, reason: 'no-target' };
          } else {
            let found;
            try {
              found = JSON.parse(await readFile(`${packageDirFor(options.targetDir, name)}/package.json`, 'utf8')).version;
            } catch {
              found = undefined;
            }
            if (found !== version) return { ok: false, reason: 'not-installed', expected: version, found };
            verified = { checked: true, version };
          }
        }

        return {
          ok: true,
          row: built.row,
          patch: renderPatch(built.row),
          steps: registrationInstructions(built.row),
          version,
          verified,
        };
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
          } catch (error) {
            // 撤回是明确结论，不能退回按仓库与标签推导；其余情况才降级。
            if (error?.code === 'version-revoked') return { ok: false, reason: 'version-revoked' };
          }
        }

        const result = await installPlugin(plan, { ...deps, expectedDigest });
        if (!result.ok) return result;

        const built = buildRegistrationRow(result.installed, options.registration ?? {});
        const directory = options.targetDir ? packageDirFor(options.targetDir, result.installed.name) : undefined;
        // 登记行与实装版本绑定：装 0.2.0 却按 0.1.0 排障是最难查的一类问题。
        // 即使没有 serviceUrl 无法生成行，版本与目录仍要返回。
        const registration = {
          ...(built.ok
            ? { row: built.row, patch: renderPatch(built.row), steps: registrationInstructions(built.row) }
            : { error: built.reason }),
          version: result.installed.version,
          tag: result.installed.tag,
          directory,
        };
        if (!options.targetDir) return { ...result, registration };

        const persisted = await persistFiles(result.installed.files ?? [], packageDirFor(options.targetDir, result.installed.name));
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
