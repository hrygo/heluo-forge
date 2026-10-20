import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketTools } from '../src/market-tools.mjs';

const entries = [
  { name: '@heluo/a', title: '网关', summary: '接入网关', version: '0.1.0', stars: 3, downloads: 1, repo: 'https://gitee.corp.example/g/a' },
  { name: '@heluo/b', title: '品牌', summary: '外观', version: '0.2.0', stars: 9, downloads: 5, repo: 'https://gitee.corp.example/g/b' },
];

const client = {
  list: async () => ({ entries }),
  detail: async (name) => entries.find((entry) => entry.name === name),
};

const call = async (tools, name, args) => {
  const found = tools.find((item) => item.name === name);
  const result = await found.execute(args);
  return JSON.parse(result.content[0].text);
};

test('search sorts by stars and filters by keyword', async () => {
  const tools = buildMarketTools(client);
  const all = await call(tools, 'market_search', {});
  assert.deepEqual(all.entries.map((e) => e.name), ['@heluo/b', '@heluo/a']);
  const filtered = await call(tools, 'market_search', { query: '网关' });
  assert.deepEqual(filtered.entries.map((e) => e.name), ['@heluo/a']);
});

test('search falls back to the cache when the service fails', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeCache } = await import('../src/cache.mjs');

  const dir = await mkdtemp(join(tmpdir(), 'forge-market-tools-'));
  const cachePath = join(dir, 'catalog.json');
  try {
    await writeCache(cachePath, entries, { now: Date.now() });
    const failing = { list: async () => { throw Object.assign(new Error('down'), { code: 'service-unavailable' }); } };
    const tools = buildMarketTools(failing, { cachePath });
    const result = await call(tools, 'market_search', {});
    assert.equal(result.source, 'cache');
    assert.equal(result.entries.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detail normalizes the entry', async () => {
  const tools = buildMarketTools(client);
  const result = await call(tools, 'market_detail', { name: '@heluo/b' });
  assert.equal(result.entry.stars, 9);
});

test('plan resolves the tag and enforces the host allowlist', async () => {
  const ok = await call(buildMarketTools(client), 'market_plan_install', { name: '@heluo/a' });
  assert.equal(ok.plan.tag, 'v0.1.0');
  const blocked = await call(buildMarketTools(client, { allowedHosts: ['other.example'] }), 'market_plan_install', { name: '@heluo/a' });
  assert.equal(blocked.reason, 'host-not-allowed');
});

test('exposes exactly the documented tools', () => {
  const tools = buildMarketTools(client);
  assert.deepEqual(tools.map((t) => t.name), [
    'market_search',
    'market_detail',
    'market_submit',
    'market_verify',
    'market_diagnostics',
    'market_check_update',
    'market_registration',
    'market_install',
    'market_plan_install',
  ]);
});

test('install runs the pipeline with injected download and extract', async () => {
  const files = [
    { path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/a', version: '0.1.0' })) },
    { path: 'cordis.patch.yml', bytes: Buffer.from('insert: []\n') },
  ];
  const tools = buildMarketTools(client, {
    allowedHosts: ['gitee.corp.example'],
    registration: { serviceUrl: 'https://plugins.corp.example' },
    install: {
      download: async () => ({ ok: true, bytes: Buffer.from('x') }),
      extract: async () => ({ ok: true, files }),
    },
  });
  const result = await call(tools, 'market_install', { name: '@heluo/a' });
  assert.equal(result.ok, true);
  assert.equal(result.installed.version, '0.1.0');
  assert.match(result.registration.patch, /id: heluo-a/);
  assert.equal(result.registration.row.config.serviceUrl, 'https://plugins.corp.example');
});

test('install refuses a host outside the allowlist', async () => {
  const tools = buildMarketTools(client, { allowedHosts: ['other.example'] });
  const result = await call(tools, 'market_install', { name: '@heluo/a' });
  assert.equal(result.reason, 'host-not-allowed');
});

test('submit validates tag, host and reports the review state', async () => {
  const { makeTarball } = await import('./support/tar.mjs');
  const archive = makeTarball([
    ['package.json', JSON.stringify({ name: '@heluo/a', version: '0.1.0', engines: { dsh: '>=0.2.1' } })],
    ['cordis.patch.yml', 'insert: []\n'],
    ['README.md', '## 用途\n\nx\n\n## 维护人\n\ny\n'],
  ]);
  let submitted;
  const submitClient = {
    ...client,
    submit: async (payload) => {
      submitted = payload;
      return { state: 'pending' };
    },
  };
  const tools = buildMarketTools(submitClient, {
    allowedHosts: ['gitee.corp.example'],
    fetchImpl: () => Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(archive) }),
  });
  const payload = { name: '@heluo/a', repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0' };

  assert.deepEqual(await call(tools, 'market_submit', payload), { ok: true, state: 'pending' });
  assert.equal(submitted.tag, 'v0.1.0');
  assert.equal(submitted.name, '@heluo/a');
  assert.equal((await call(tools, 'market_submit', { ...payload, tag: '0.1.0' })).reason, 'bad-tag');
  assert.equal((await call(tools, 'market_submit', { ...payload, repo: 'https://evil.example/x' })).reason, 'host-not-allowed');
});

test('a throwing client becomes a structured failure, not a crash', async () => {
  const exploding = { list: () => { throw new Error('boom'); }, detail: () => { throw new Error('boom'); } };
  const tools = buildMarketTools(exploding);
  const result = JSON.parse((await tools.find((t) => t.name === 'market_detail').execute({ name: '@heluo/a' })).content[0].text);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'internal');
  assert.match(result.detail, /boom/);
});

test('check_update answers without touching the service state', async () => {
  const tools = buildMarketTools(client);
  const result = await call(tools, 'market_check_update', { name: '@heluo/b', installedVersion: '0.1.0' });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latest, '0.2.0');
});

test('submit refuses to run without a host allowlist', async () => {
  const tools = buildMarketTools(client);
  const result = await call(tools, 'market_submit', { name: '@heluo/a', repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0' });
  assert.equal(result.reason, 'no-allowed-host');
});

test('submit rejects a repository address it cannot parse', async () => {
  const tools = buildMarketTools(client, { allowedHosts: ['gitee.corp.example'] });
  const result = await call(tools, 'market_submit', { name: '@heluo/a', repo: 'not a url', tag: 'v0.1.0' });
  assert.equal(result.reason, 'bad-repo');
});

test('diagnostics lists refused repositories with their codes', async () => {
  const diagClient = {
    ...client,
    unindexed: async () => ({ entries: [{ repo: 'https://gitee.corp.example/g/bad', name: '@heluo/bad', errors: ['missing-file', 'bad-tag'] }] }),
  };
  const tools = buildMarketTools(diagClient);
  const result = await call(tools, 'market_diagnostics', {});
  assert.equal(result.total, 1);
  assert.deepEqual(result.entries[0].errors, ['missing-file', 'bad-tag']);
});

test('diagnostics tolerates a service that returns nothing', async () => {
  const tools = buildMarketTools({ ...client, unindexed: async () => ({}) });
  assert.deepEqual(await call(tools, 'market_diagnostics', {}), { total: 0, entries: [] });
});

test('install prefers the archive the service resolves', async () => {
  let requested;
  const serviceClient = {
    ...client,
    downloadInfo: async () => ({ url: 'https://gitee.corp.example/g/a/archive/refs/tags/v0.1.0.tar.gz', digest: '' }),
  };
  const tools = buildMarketTools(serviceClient, {
    allowedHosts: ['gitee.corp.example'],
    install: {
      download: async (repo, tag, archiveUrl) => { requested = archiveUrl; return { ok: true, bytes: Buffer.from('x') }; },
      extract: async () => ({ ok: true, files: [{ path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/a', version: '0.1.0' })) }] }),
    },
  });
  const result = await call(tools, 'market_install', { name: '@heluo/a' });
  assert.equal(result.ok, true);
  assert.match(requested, /archive\/refs\/tags\/v0\.1\.0\.tar\.gz$/);
});

test('install still works when the service has no download info', async () => {
  const tools = buildMarketTools(client, {
    allowedHosts: ['gitee.corp.example'],
    install: {
      download: async (repo, tag) => ({ ok: true, bytes: Buffer.from('x'), usedTag: tag }),
      extract: async () => ({ ok: true, files: [{ path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/a', version: '0.1.0' })) }] }),
    },
  });
  assert.equal((await call(tools, 'market_install', { name: '@heluo/a' })).ok, true);
});

test('install reports a revoked version from the service as such', async () => {
  const revoking = {
    ...client,
    downloadInfo: async () => { throw Object.assign(new Error('revoked'), { code: 'version-revoked' }); },
  };
  const tools = buildMarketTools(revoking, {
    allowedHosts: ['gitee.corp.example'],
    install: {
      download: async () => ({ ok: true, bytes: Buffer.from('x') }),
      extract: async () => ({ ok: true, files: [{ path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/a', version: '0.1.0' })) }] }),
    },
  });
  const result = await call(tools, 'market_install', { name: '@heluo/a' });
  assert.equal(result.reason, 'version-revoked');
});

test('verify reports the failing step instead of a bare refusal', async () => {
  const { makeTarball } = await import('./support/tar.mjs');
  const archive = makeTarball([
    ['package.json', JSON.stringify({ name: '@heluo/demo', version: '0.1.0', engines: { dsh: '>=0.2.1' } })],
    ['cordis.patch.yml', 'insert: []\n'],
    ['README.md', '## 用途\n\nx\n\n## 维护人\n\ny\n'],
  ]);
  const tools = buildMarketTools(client, {
    allowedHosts: ['gitee.corp.example'],
    fetchImpl: () => Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(archive) }),
  });
  const result = await call(tools, 'market_verify', { repo: 'https://gitee.corp.example/g/demo', tag: 'v0.1.0' });
  assert.equal(result.ok, true);
  assert.ok(result.steps.some((step) => step.step === 'validate' && step.ok));
});

test('verify refuses a repository outside the allowlist without fetching', async () => {
  let called = false;
  const tools = buildMarketTools(client, { allowedHosts: ['gitee.corp.example'], fetchImpl: () => { called = true; } });
  const result = await call(tools, 'market_verify', { repo: 'https://evil.example/g/demo', tag: 'v0.1.0' });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('submit refuses a package that fails its own preflight', async () => {
  const { makeTarball } = await import('./support/tar.mjs');
  const thin = makeTarball([['package.json', JSON.stringify({ name: '@heluo/a', version: '0.1.0' })]]);
  let submitted = false;
  const submitClient = { ...client, submit: async () => { submitted = true; return { state: 'pending' }; } };
  const tools = buildMarketTools(submitClient, {
    allowedHosts: ['gitee.corp.example'],
    fetchImpl: () => Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(thin) }),
  });
  const result = await call(tools, 'market_submit', { name: '@heluo/a', repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0' });
  assert.equal(result.reason, 'verification-failed');
  assert.equal(submitted, false);
});

test('a service rejection reaches the caller with its own code', async () => {
  const rejecting = { ...client, submit: async () => { throw Object.assign(new Error('bad-tag'), { code: 'bad-tag', body: { error: 'bad-tag' } }); } };
  const tools = buildMarketTools(rejecting, {
    allowedHosts: ['gitee.corp.example'],
    preflight: false,
  });
  const result = await call(tools, 'market_submit', { name: '@heluo/a', repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0' });
  assert.equal(result.reason, 'bad-tag');
  assert.deepEqual(result.server, { error: 'bad-tag' });
});

test('each failure carries the next action, not just a code', async () => {
  const reasonOf = async (error) => {
    const tools = buildMarketTools({ list: () => { throw error; }, detail: () => { throw error; } });
    return (await call(tools, 'market_search', {})).action;
  };
  assert.equal(await reasonOf(Object.assign(new Error('x'), { code: 'unauthorized' })), 're-login');
  assert.equal(await reasonOf(Object.assign(new Error('x'), { code: 'forbidden' })), 'request-access');
  assert.equal(await reasonOf(Object.assign(new Error('x'), { code: 'service-unavailable' })), 'retry');
  assert.equal(await reasonOf(new Error('boom')), 'contact-admin');

  const tools = buildMarketTools(client, { preflight: false });
  const revoked = await buildMarketTools({ ...client, submit: async () => { throw Object.assign(new Error('r'), { code: 'version-revoked' }); } }, { allowedHosts: ['gitee.corp.example'], preflight: false });
  const result = await call(revoked, 'market_submit', { name: '@heluo/a', repo: 'https://gitee.corp.example/g/a', tag: 'v0.1.0' });
  assert.equal(result.action, 'choose-another-version');
  assert.ok(tools);
});

test('two packages land in separate directories', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'forge-market-two-'));
  try {
    const two = {
      ...client,
      detail: async (name) => ({ name, version: '0.1.0', repo: 'https://gitee.corp.example/g/x' }),
    };
    const tools = buildMarketTools(two, {
      allowedHosts: ['gitee.corp.example'],
      targetDir: dir,
      install: {
        download: async () => ({ ok: true, bytes: Buffer.from('x') }),
        extract: async ({}) => ({ ok: true, files: [{ path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/a', version: '0.1.0' })) }] }),
      },
    });
    assert.equal((await call(tools, 'market_install', { name: '@heluo/a' })).ok, true);
    assert.equal(JSON.parse(await readFile(join(dir, 'heluo-a', 'package.json'), 'utf8')).name, '@heluo/a');

    const second = buildMarketTools(two, {
      allowedHosts: ['gitee.corp.example'],
      targetDir: dir,
      install: { download: async () => ({ ok: true, bytes: Buffer.from('x') }), extract: async () => ({ ok: true, files: [{ path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/b', version: '0.1.0' })) }] }) },
    });
    const b = await call(second, 'market_install', { name: '@heluo/b' });
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(JSON.parse(await readFile(join(dir, 'heluo-a', 'package.json'), 'utf8')).name, '@heluo/a');
    assert.equal(JSON.parse(await readFile(join(dir, 'heluo-b', 'package.json'), 'utf8')).name, '@heluo/b');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('update check reads the version that was installed', async () => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'forge-market-read-'));
  try {
    await mkdir(join(dir, 'heluo-a'), { recursive: true });
    await writeFile(join(dir, 'heluo-a', 'package.json'), JSON.stringify({ name: '@heluo/a', version: '0.0.9' }));
    const tools = buildMarketTools(client, { targetDir: dir });
    const result = await call(tools, 'market_check_update', { name: '@heluo/a' });
    assert.equal(result.installed, '0.0.9');
    assert.equal(result.updateAvailable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the registration row reports the version that was installed', async () => {
  const tools = buildMarketTools(client, {
    allowedHosts: ['gitee.corp.example'],
    install: {
      download: async () => ({ ok: true, bytes: Buffer.from('x') }),
      extract: async () => ({ ok: true, files: [{ path: 'package.json', bytes: Buffer.from(JSON.stringify({ name: '@heluo/a', version: '0.1.0' })) }] }),
    },
  });
  const result = await call(tools, 'market_install', { name: '@heluo/a' });
  assert.equal(result.ok, true);
  assert.equal(result.registration.version, result.installed.version);
  assert.equal(result.registration.tag, result.installed.tag);
});

test('registration confirms the version that is actually installed', async () => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'forge-market-reg-'));
  try {
    await mkdir(join(dir, 'heluo-a'), { recursive: true });
    await writeFile(join(dir, 'heluo-a', 'package.json'), JSON.stringify({ name: '@heluo/a', version: '0.1.0' }));
    const tools = buildMarketTools(client, { targetDir: dir, registration: { serviceUrl: 'https://plugins.corp.example' } });

    const good = await call(tools, 'market_registration', { name: '@heluo/a', version: '0.1.0' });
    assert.equal(good.ok, true);
    assert.deepEqual(good.verified, { checked: true, version: '0.1.0' });

    const wrong = await call(tools, 'market_registration', { name: '@heluo/a', version: '0.9.9' });
    assert.equal(wrong.reason, 'not-installed');
    assert.equal(wrong.found, '0.1.0');

    const missing = await call(tools, 'market_registration', { name: '@heluo/zzz', version: '0.1.0' });
    assert.equal(missing.reason, 'not-installed');

    const noTarget = buildMarketTools(client, { registration: { serviceUrl: 'https://plugins.corp.example' } });
    const unchecked = await call(noTarget, 'market_registration', { name: '@heluo/a', version: '0.1.0' });
    assert.deepEqual(unchecked.verified, { checked: false, reason: 'no-target' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('search says where the entries came from', async () => {
  const localTools = buildMarketTools({ kind: 'local', list: client.list });
  assert.equal((await call(localTools, 'market_search', {})).source, 'local');
  assert.equal((await call(buildMarketTools(client), 'market_search', {})).source, 'service');
});

test('search tells the caller when it truncated', async () => {
  const many = { list: async () => ({ entries: Array.from({ length: 5 }, (_, i) => ({ name: `@heluo/p${i}`, version: '0.1.0', repo: 'https://gitee.corp.example/g/p' })) }) };
  const tools = buildMarketTools(many);
  const page = await call(tools, 'market_search', { limit: 2 });
  assert.equal(page.total, 5);
  assert.equal(page.returned, 2);
  assert.equal(page.truncated, true);
  const all = await call(tools, 'market_search', { limit: 50 });
  assert.equal(all.truncated, false);
  assert.equal(all.returned, 5);
});

test('search clamps a nonsensical limit instead of returning nothing', async () => {
  const tools = buildMarketTools(client);
  assert.equal((await call(tools, 'market_search', { limit: 0 })).returned, 1);
  assert.equal((await call(tools, 'market_search', { limit: -3 })).returned, 1);
  assert.equal((await call(tools, 'market_search', { limit: Number.NaN })).total, 2);
});

test('search survives without a cache or a target directory', async () => {
  const failing = { list: async () => { throw Object.assign(new Error('down'), { code: 'service-unavailable' }); } };
  const result = await call(buildMarketTools(failing), 'market_search', {});
  assert.equal(result.reason, 'service-unavailable');
  assert.equal(result.action, 'retry');
});
