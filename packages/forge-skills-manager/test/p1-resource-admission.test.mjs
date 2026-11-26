import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { createNacosClient } from '../lib/nacos.js';
import { createInstallOperations } from '../lib/install-operations.js';
import { createInstallationManager } from '../lib/installations.js';
import { installHttp } from '../lib/http.js';
import { readZip, ZipReadError } from '../lib/zip.js';
import { skillDocument } from '../spec/fixtures/nacos.mjs';

const selected = { skillName: 'example-skill', version: '1.0.0' };
const goodZip = (level = 6) => Buffer.from(zipSync({
  'example-skill/SKILL.md': strToU8(skillDocument(selected.skillName)),
  'example-skill/resource.bin': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
}, { level }));
function corrupt(kind) {
  const bytes = goodZip(0);
  for (let offset = 0; offset < bytes.length - 46; offset++) {
    const signature = bytes.readUInt32LE(offset);
    if (kind === 'crc' && signature === 0x04034b50) {
      const length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
      if (bytes.toString('utf8', offset + 30, offset + 30 + length).endsWith('resource.bin')) {
        bytes[offset + 30 + length + extra] ^= 0xff; return bytes;
      }
    }
    if (kind === 'length' && signature === 0x02014b50) {
      const length = bytes.readUInt16LE(offset + 28);
      if (bytes.toString('utf8', offset + 46, offset + 46 + length).endsWith('resource.bin')) {
        bytes.writeUInt32LE(1, offset + 24); return bytes;
      }
    }
  }
  throw new Error('corruption fixture did not find resource');
}
async function harness(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-p1-admission-'));
  const previous = Object.fromEntries(['DSH_HOME', 'HOME', 'USERPROFILE'].map(k => [k, process.env[k]]));
  process.env.DSH_HOME = join(directory, 'dsh');
  process.env.HOME = process.env.USERPROFILE = join(directory, 'user');
  const local = await import('../lib/core.js');
  const state = { online: true, archive: goodZip(), versionsInList: false, downloads: [], details: 0, beforeDownload: null, versions: null };
  const meta = () => ({ name: selected.skillName, namespaceId: 'public', description: 'synthetic', enable: true,
    labels: { latest: selected.version }, versions: state.versions ?? [{ version: selected.version, status: state.online ? 'online' : 'offline' }, { version: '2.0.0', status: 'online' }] });
  const fetcher = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/auth/user/login')) return Response.json({ accessToken: 'synthetic-token', tokenTtl: 3600 });
    if (u.pathname.endsWith('/skills/list')) {
      const item = meta(); if (!state.versionsInList) delete item.versions;
      return Response.json({ code: 0, data: { totalCount: 1, pageItems: [item] } });
    }
    if (u.pathname === '/nacos/v3/admin/ai/skills') { state.details++; return Response.json({ code: 0, data: meta() }); }
    if (u.pathname === '/nacos/v3/client/ai/skills') {
      assert.equal(u.searchParams.get('name'), selected.skillName);
      assert.equal(u.searchParams.get('version'), selected.version);
      state.downloads.push('client');
      state.beforeDownload?.();
      return state.online ? new Response(state.archive) : new Response('', { status: 404 });
    }
    if (u.pathname.endsWith('/version/download')) { state.downloads.push('admin'); return new Response(state.archive); }
    throw new Error('unexpected API');
  };
  const nacos = createNacosClient({ serverUrl: 'https://nacos.corp.example/nacos', namespaceId: 'public', username: 'svc-ci', password: 'synthetic-password' }, fetcher);
  const routes = new Map(), cleanups = [], prefix = '/api/forge-skills-manager';
  const operations = createInstallOperations();
  installHttp({ connection: { fetch: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path); } } },
    sessions: { list: () => [] }, get() {}, effect(fn) { cleanups.push(fn()); } }, {
    local, nacos, operations, installations: createInstallationManager({ local }), log() {},
    providers: { afterWrite() {}, getPresetRootsCached: async () => [], getPresetRootsOnMiss: async () => [] },
  });
  t.after(async () => {
    for (const fn of cleanups.reverse()) await fn?.();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    for (const [k, value] of Object.entries(previous)) { if (value === undefined) delete process.env[k]; else process.env[k] = value; }
  });
  const request = async (path, body) => {
    const response = await routes.get(prefix + path).fetch(new Request('http://localhost' + prefix + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-skills-manager': '1' }, body: JSON.stringify(body),
    }));
    return { status: response.status, ...await response.json() };
  };
  const snapshot = async () => {
    const files = {};
    async function walk(path) {
      for (const item of await fs.readdir(path, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
        const target = join(path, item.name);
        if (item.isDirectory()) await walk(target);
        else files[target.slice(directory.length)] = (await fs.readFile(target)).toString('base64');
      }
    }
    await walk(process.env.DSH_HOME); return files;
  };
  // Preserve an existing local skill, policy and provenance while refusing a new resource.
  await local.createSkill({ name: 'existing-skill', description: 'synthetic', body: 'Keep me' });
  await fs.mkdir(local.managerHomePath(), { recursive: true });
  await fs.writeFile(join(local.managerHomePath(), 'repositories.json'), JSON.stringify({ version: 1, repositories: [], installs: [], catalogInstalls: [] }));
  return { state, local, nacos, request, snapshot, operations };
}

test('offline exact latest is absent from discovery and rejected by detail/install without local writes', async t => {
  const ui = await harness(t); ui.state.online = false;
  const before = await ui.snapshot();
  for (const inline of [false, true]) {
    ui.state.versionsInList = inline;
    assert.equal((await ui.nacos.list()).items.length, 0);
  }
  assert.equal((await ui.request('/nacos/detail', selected)).code, 'error.nacos.notFound');
  const id = randomUUID();
  const response = await ui.request('/nacos/install', { ...selected, operationId: id });
  assert.equal(response.code, 'error.nacos.notFound');
  assert.equal((await ui.operations.status(id)).state, 'rejected');
  assert.deepEqual(await ui.snapshot(), before);
  ui.state.online = true;
  assert.equal((await ui.request('/nacos/install', { ...selected, operationId: randomUUID() })).status, 200);
  assert.ok(ui.state.downloads.every(api => api === 'client'));
});

for (const kind of ['crc', 'length', 'truncated']) test(`${kind} ZIP is refused by detail, install and local upload`, async t => {
  const ui = await harness(t); const before = await ui.snapshot();
  const bytes = kind === 'truncated' ? goodZip().subarray(0, 30) : corrupt(kind);
  ui.state.archive = bytes;
  assert.equal((await ui.request('/nacos/detail', selected)).code, 'error.nacos.package');
  const id = randomUUID();
  assert.equal((await ui.request('/nacos/install', { ...selected, operationId: id })).code, 'error.nacos.package');
  assert.equal((await ui.operations.status(id)).state, 'rejected');
  const response = await ui.request('/upload', { root: 'dsh', zip: bytes.toString('base64') });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'error.upload.zipInvalid', JSON.stringify(response));
  assert.deepEqual(await ui.snapshot(), before);
});

test('a version taken offline after metadata validation cannot install via Client API', async t => {
  const ui = await harness(t); const before = await ui.snapshot();
  ui.state.beforeDownload = () => { ui.state.online = false; };
  const id = randomUUID();
  assert.equal((await ui.request('/nacos/install', { ...selected, operationId: id })).code, 'error.nacos.notFound');
  assert.equal((await ui.operations.status(id)).state, 'rejected');
  assert.deepEqual(await ui.snapshot(), before);
  assert.deepEqual(ui.state.downloads, ['client']);
});

test('other online versions and missing/unknown selected status do not authorize the selected version', async t => {
  const ui = await harness(t);
  for (const versions of [[], [{ version: '2.0.0', status: 'online' }], [{ version: selected.version }], [{ version: selected.version, status: 'UNKNOWN' }]]) {
    ui.state.versions = versions;
    for (const inline of [true, false]) {
      ui.state.versionsInList = inline;
      assert.deepEqual((await ui.nacos.list()).items, []);
      await assert.rejects(ui.nacos.detail(selected), { code: 'error.nacos.notFound' });
    }
  }
  assert.deepEqual(ui.state.downloads, []);
});

test('shared ZIP reader enforces entry, cumulative and count budgets including filtered entries', async () => {
  const bytes = zipSync({ 'a.bin': new Uint8Array(8), 'b.bin': new Uint8Array(8) });
  for (const options of [{ maxEntryBytes: 7 }, { maxTotalBytes: 15 }, { maxTotalBytes: 15, filter: () => false }, { maxEntries: 1 }]) {
    await assert.rejects(readZip(bytes, options), e => e instanceof ZipReadError && e.reason === (options.maxEntries ? 'entries' : 'size'));
  }
  // A deflated stream whose directory understates its output must also fail.
  const lied = Buffer.from(zipSync({ 'large.bin': new Uint8Array(1 << 20) }));
  for (let i = 0; i < lied.length - 46; i++) if (lied.readUInt32LE(i) === 0x02014b50) { lied.writeUInt32LE(1, i + 24); break; }
  await assert.rejects(readZip(lied, { maxEntryBytes: 64, maxTotalBytes: 64 }), ZipReadError);
  assert.deepEqual(Object.keys(await readZip(bytes, { maxEntryBytes: 8, maxTotalBytes: 16, maxEntries: 2 })), ['a.bin', 'b.bin']);
});

test('both stored and deflated valid resource archives preserve binary contents', async t => {
  const ui = await harness(t);
  for (const level of [0, 6]) {
    ui.state.archive = goodZip(level);
    const detail = await ui.nacos.detail(selected);
    assert.deepEqual(detail.files.sort(), ['SKILL.md', 'resource.bin']);
  }
  assert.equal((await ui.request('/nacos/install', { ...selected, operationId: randomUUID() })).status, 200);
  assert.deepEqual([...await fs.readFile(join(process.env.DSH_HOME, 'skills/example-skill/resource.bin'))], [1, 2, 3, 4, 5, 6, 7, 8]);
});
