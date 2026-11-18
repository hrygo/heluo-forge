import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHttp } from '../lib/http.js';
import { createNacosClient } from '../lib/nacos.js';
import { createInstallationManager } from '../lib/installations.js';
import { createInstallOperations } from '../lib/install-operations.js';
import { fakeNacos, nacosConfig, useNacosEnvironment } from '../spec/fixtures/nacos.mjs';

const selection = { skillName: 'example-skill', version: '1.0.0' };

async function harness(context) {
  useNacosEnvironment(context);
  const directory = await mkdtemp(join(tmpdir(), 'forge-download-state-'));
  const previous = Object.fromEntries(['DSH_HOME', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]));
  process.env.DSH_HOME = join(directory, 'dsh');
  process.env.HOME = process.env.USERPROFILE = join(directory, 'user');
  const local = await import('../lib/core.js');
  const fixture = fakeNacos();
  const nacos = createNacosClient(nacosConfig, fixture.fetcher);
  const registered = [], routes = new Map(), cleanups = [];
  const prefix = '/api/forge-skills-manager';
  const ctx = { connection: { fetch: { register(route) {
    routes.set(route.path, route); return () => routes.delete(route.path);
  } } }, get: key => key === 'workspaceRegistry' ? { list: () => registered.map(path => ({ path })) } : undefined,
  effect(fn) { cleanups.push(fn()); } };
  const manager = overrides => createInstallationManager({ local: { ...local, ...overrides }, registeredWorkspaces: () => registered });
  function mount(installations = manager()) {
    cleanups.splice(0).forEach(cleanup => cleanup?.());
    installHttp(ctx, { local, nacos, installations, operations: createInstallOperations(), log() {},
      providers: { getPresetRootsCached: async () => [], getPresetRootsOnMiss: async () => [], afterWrite() {} } });
    return installations;
  }
  mount();
  context.after(async () => {
    cleanups.forEach(cleanup => cleanup?.());
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  async function request(path, body) {
    const response = await routes.get(prefix + path).fetch(new Request('http://localhost' + prefix + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-skills-manager': '1' }, body: JSON.stringify(body),
    }));
    return { status: response.status, ...await response.json() };
  }
  const list = () => request('/nacos/list');
  const states = async () => {
    const response = await list();
    assert.equal(response.status, 200);
    return response.data.items[0].installations;
  };
  const install = async target => {
    const response = await request('/nacos/install', { ...selection, ...target });
    assert.equal(response.status, 200, JSON.stringify(response));
  };
  return { directory, local, fixture, nacos, registered, mount, manager, request, list, states, install,
    installed: join(process.env.DSH_HOME, 'skills', selection.skillName), recordFile: join(local.managerHomePath(), 'repositories.json') };
}

test('download badges use persisted exact-source/version records, survive Host remount and track local edits/removal', async context => {
  const ui = await harness(context);
  await mkdir(ui.installed, { recursive: true });
  await writeFile(join(ui.installed, 'SKILL.md'), 'Untracked same-name skill');
  assert.deepEqual(await ui.states(), [], 'a matching name is not installation provenance');
  await rm(ui.installed, { recursive: true });
  await ui.install();
  assert.deepEqual(await ui.states(), [{ state: 'downloaded' }]);
  ui.mount();
  assert.deepEqual(await ui.states(), [{ state: 'downloaded' }], 'fresh manager reads durable records');
  const detail = await ui.request('/nacos/detail', selection);
  assert.deepEqual(detail.data.installations, [{ state: 'downloaded' }]);
  const downloads = () => ui.fixture.calls.filter(call => call.url.pathname.endsWith('/skills/version/download')).length;
  const before = downloads();
  await ui.states(); await ui.states();
  assert.equal(downloads(), before, 'list projection does not download remote resources');
  await ui.request('/enable', { root: 'dsh', name: selection.skillName });
  assert.deepEqual(await ui.states(), [{ state: 'downloaded' }], 'enabled state is independent');
  await writeFile(join(ui.installed, 'scripts', 'example.txt'), 'User edits');
  assert.deepEqual(await ui.states(), [{ state: 'modified' }]);
  ui.fixture.state.version = '2.0.0';
  assert.deepEqual(await ui.states(), [], 'old version is not the current version');
  ui.fixture.state.version = selection.version;
  const differentSource = createNacosClient({ ...nacosConfig, namespaceId: 'another' }, ui.fixture.fetcher);
  assert.deepEqual(Object.keys(await ui.manager().catalogInstallations([differentSource.identity(selection)])), []);
  const differentServer = createNacosClient({ ...nacosConfig, serverUrl: 'https://other.corp.example/nacos' });
  assert.notEqual(differentServer.identity(selection), ui.nacos.identity(selection));
  await rm(ui.installed, { recursive: true });
  assert.deepEqual(await ui.states(), [], 'removed resources do not retain a downloaded badge');
});

test('download state separates global and registered projects and follows trash/restore', async context => {
  const ui = await harness(context);
  const project = join(ui.directory, 'project');
  await mkdir(project);
  ui.registered.push(project);
  await ui.install();
  await ui.install({ workspace: project });
  const workspace = await realpath(project);
  assert.deepEqual(await ui.states(), [{ state: 'downloaded' }, { workspace, state: 'downloaded' }]);
  assert.equal((await ui.request('/delete', { root: 'dsh', name: selection.skillName })).ok, true);
  assert.deepEqual(await ui.states(), [{ workspace, state: 'downloaded' }]);
  const [trash] = await ui.local.listTrash();
  assert.equal((await ui.request('/trash-restore', { id: trash.id })).ok, true);
  assert.deepEqual(await ui.states(), [{ state: 'downloaded' }, { workspace, state: 'downloaded' }]);
  ui.registered.length = 0;
  assert.deepEqual(await ui.states(), [{ state: 'downloaded' }, { workspace, state: 'unavailable' }], 'lost project registration does not fall back to global');
});

test('unconfirmed records and unreadable state never become downloaded or an empty successful projection', async context => {
  const ui = await harness(context);
  await ui.install();
  const data = JSON.parse(await readFile(ui.recordFile, 'utf8'));
  data.catalogInstalls[0].complete = false;
  await writeFile(join(ui.installed, 'scripts', 'example.txt'), 'Incomplete write');
  await writeFile(ui.recordFile, JSON.stringify(data));
  assert.deepEqual(await ui.states(), [{ state: 'pending' }]);
  data.catalogInstalls[0].complete = true;
  await writeFile(ui.recordFile, JSON.stringify(data));
  ui.mount(ui.manager({ checkedRepositoryRootDefinition: async () => ({ ok: false, code: 'error.root.unsafe', error: 'Synthetic unavailable root' }) }));
  assert.deepEqual(await ui.states(), [{ state: 'unavailable' }]);
  ui.mount(ui.manager({ checkedRepositoryRootDefinition: async () => { throw new ReferenceError('Synthetic programming defect'); } }));
  await assert.rejects(ui.list(), ReferenceError);
  ui.mount();
  await writeFile(ui.recordFile, '{invalid');
  const corrupt = await ui.list();
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.data, undefined);
});
