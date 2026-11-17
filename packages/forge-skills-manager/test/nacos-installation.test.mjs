import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHttp } from '../lib/http.js';
import { createNacosClient } from '../lib/nacos.js';
import { createInstallationManager } from '../lib/installations.js';
import { fakeNacos, nacosConfig } from '../spec/fixtures/nacos.mjs';

test('Nacos HTTP install keeps resources, starts disabled, preserves legacy records and survives trash/restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-nacos-install-'));
  process.env.DSH_HOME = join(directory, 'dsh');
  process.env.HOME = process.env.USERPROFILE = join(directory, 'user');
  process.env.TEST_NACOS_USER = 'svc-ci';
  process.env.TEST_NACOS_PASSWORD = 'synthetic-password';
  const local = await import('../lib/core.js');
  const fixture = fakeNacos();
  const nacos = createNacosClient(nacosConfig, fixture.fetcher);
  const installations = createInstallationManager({ local });
  const routes = new Map(), cleanups = [];
  const providers = { getPresetRootsCached: async () => [], getPresetRootsOnMiss: async () => [], afterWrite() {} };
  const prefix = '/api/forge-skills-manager';
  const ctx = { connection: { fetch: { register(route) {
    routes.set(route.path, route); return () => routes.delete(route.path);
  } } }, sessions: { list: () => [] }, get() {}, effect(fn) { cleanups.push(fn()); } };
  const post = async (path, value) => {
    const response = await routes.get(prefix + path).fetch(new Request('http://localhost' + prefix + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-skills-manager': '1' }, body: JSON.stringify(value),
    }));
    return { status: response.status, ...await response.json() };
  };
  const find = async () => (await local.state()).roots.find(root => root.key === 'dsh').skills.find(skill => skill.name === 'example-skill');
  try {
    await mkdir(local.managerHomePath(), { recursive: true });
    const recordFile = join(local.managerHomePath(), 'repositories.json');
    await writeFile(recordFile, JSON.stringify({ version: 1, repositories: [], installs: [], catalogInstalls: ['skillsh:corp/example'] }));
    installHttp(ctx, { local, nacos, installations, providers, log() {} });
    assert.ok(![...routes.keys()].some(path => /repositories|catalog|upload-to|nacos\/upload/.test(path)));
    const selection = { skillName: 'example-skill', version: '1.0.0' };
    assert.equal((await post('/nacos/install', { ...selection, root: 'agents' })).status, 400);
    assert.equal(fixture.calls.length, 0, 'rejected target makes no network request');
    assert.equal((await post('/nacos/install', { ...selection, workspace: join(directory, 'unregistered') })).ok, false);
    assert.equal(fixture.calls.length, 0);
    assert.equal((await post('/nacos/install', selection)).status, 200);
    assert.equal((await find()).enabled, false, 'HTTP policy cannot be replaced by request-body enabled flags');
    const installed = join(process.env.DSH_HOME, 'skills', 'example-skill');
    assert.deepEqual([...await readFile(join(installed, 'assets', 'binary.dat'))], [0, 255, 17]);
    assert.equal(await readFile(join(installed, 'scripts', 'example.txt'), 'utf8'), 'resource');
    assert.ok(JSON.parse(await readFile(recordFile, 'utf8')).catalogInstalls.includes('skillsh:corp/example'));
    assert.equal((await post('/nacos/install', selection)).status, 409, 'duplicates cannot overwrite files');
    assert.equal((await post('/enable', { root: 'dsh', name: 'example-skill' })).ok, true);
    assert.equal((await find()).enabled, true);
    assert.equal((await post('/disable', { root: 'dsh', name: 'example-skill' })).ok, true);
    assert.equal((await post('/delete', { root: 'dsh', name: 'example-skill' })).ok, true);
    const [trash] = await local.listTrash();
    assert.ok(trash);
    assert.equal((await post('/trash-restore', { id: trash.id })).ok, true);
    assert.equal((await find()).enabled, false, 'restoration does not silently enable a download');
    assert.deepEqual([...await readFile(join(installed, 'assets', 'binary.dat'))], [0, 255, 17]);
  } finally {
    cleanups.forEach(fn => fn?.());
    await rm(directory, { recursive: true, force: true });
  }
});
