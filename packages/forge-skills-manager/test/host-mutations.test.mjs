import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHttp } from '../lib/http.js';
import { createInstallOperations } from '../lib/install-operations.js';
import { createInstallationManager } from '../lib/installations.js';
import { notifyChatCatalog } from '../lib/notifications.js';

const prefix = '/api/forge-skills-manager';
const deferred = () => {
  let resolve;
  const promise = new Promise(fulfill => { resolve = fulfill; });
  return { promise, resolve };
};
function host({ path = join(tmpdir(), 'forge-host-' + randomUUID()), local = {}, installations = {}, nacos = {}, afterWrite } = {}) {
  const routes = new Map();
  const cleanups = [];
  const operations = createInstallOperations();
  const context = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    sessions: { list: () => [] }, get() {}, logger: { warn() {} },
    effect(effect) { cleanups.push(effect()); },
  };
  let notifications = 0;
  installHttp(context, {
    local: { userRoots: () => [], projectRoots: async () => [], ...local }, nacos, operations,
    installations: { managerPath: path, recoverLocal: async () => ({ warnings: [] }), sources: async () => ({}), ...installations },
    providers: { afterWrite() { notifications++; afterWrite?.(); }, getPresetRootsCached: async () => [], getPresetRootsOnMiss: async () => [] }, log() {},
  });
  const request = (path, body, id, extra = {}) => new Request('http://localhost' + prefix + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-skills-manager': '1', ...(id === undefined ? {} : { 'x-dsh-skills-operation': id }) },
    body: JSON.stringify(body), ...extra,
  });
  const send = request => routes.get(new URL(request.url).pathname).fetch(request);
  const post = (path, body, id, extra) => send(request(path, body, id, extra));
  const status = async id => (await (await routes.get(prefix + '/operation-status').fetch(new Request('http://localhost' + prefix + '/operation-status?operationId=' + id))).json()).data;
  const dispose = () => Promise.all(cleanups.splice(0).reverse().map(cleanup => cleanup?.()));
  return { routes, request, send, post, status, dispose, operations, notifications: () => notifications };
}

test('ordinary POST lost response is confirmed without repeating the mutation and binds the route and body', async () => {
  let calls = 0;
  const result = { ok: true, name: 'example-skill', root: 'dsh' };
  const fixture = host({ local: { createSkill: async () => { calls++; return result; } } });
  try {
    const id = randomUUID();
    const body = { name: 'example-skill', description: 'Fixture', body: 'Fixture' };
    await fixture.post('/create', body, id);
    assert.deepEqual(await fixture.status(id), { state: 'succeeded', result });
    const replay = await fixture.post('/create', { body: 'Fixture', description: 'Fixture', name: 'example-skill' }, id);
    assert.deepEqual((await replay.json()).data, result);
    assert.equal(calls, 1);
    assert.equal(fixture.notifications(), 1);
    assert.equal((await fixture.post('/create', { ...body, body: 'changed' }, id)).status, 400);
    assert.equal((await fixture.post('/skill-note', body, id)).status, 400);
    assert.deepEqual(await fixture.status(randomUUID()), { state: 'pending' });
    assert.equal((await fixture.post('/create', body, 'invalid')).status, 400);
    assert.equal(calls, 1);
  } finally { await fixture.dispose(); }
});

test('application rejections never become success receipts and unknown mutations remain pending', async () => {
  let result = { ok: false, code: 'error.root.unsafe', error: 'unsafe target' };
  let failure;
  let calls = 0;
  const fixture = host({ local: { setEntryLocation: async () => { calls++; if (failure) throw failure; return result; }, createSkill: async () => result } });
  try {
    const rejected = randomUUID();
    assert.equal((await fixture.post('/create', { name: 'example-skill' }, rejected)).status, 400);
    assert.deepEqual(await fixture.status(rejected), { state: 'rejected', result, code: result.code, error: result.error });
    assert.equal(fixture.notifications(), 0);
    const noCode = randomUUID();
    result = { ok: false };
    const response = await (await fixture.post('/create', {}, noCode)).json();
    assert.equal(response.code, 'error.proto.rejected');
    assert.equal(response.outcome, 'rejected');
    assert.equal((await fixture.status(noCode)).code, 'error.proto.rejected');
    const pending = randomUUID();
    result = { ok: false, code: 'error.repo.installState', error: 'unconfirmed' };
    assert.equal((await (await fixture.post('/create', {}, pending)).json()).outcome, 'pending');
    assert.deepEqual(await fixture.status(pending), { state: 'pending' });
    for (const [index, defect] of [new ReferenceError('after write'), new TypeError('state storage'), Object.assign(new TypeError('coded state defect'), { code: 'error.repo.state' })].entries()) {
      failure = defect;
      const id = randomUUID();
      await assert.rejects(fixture.post('/sidebar-entry', { location: ['both', 'sidebar', 'settings'][index] }, id), error => error === defect);
      assert.deepEqual(await fixture.status(id), { state: 'pending' });
    }
    assert.equal((await (await fixture.post('/sidebar-entry', { location: 'both' }, randomUUID())).json()).outcome, 'pending');
    assert.equal(calls, 3, 'a fresh UUID cannot repeat the same uncertain target');
  } finally { await fixture.dispose(); }
});

test('unknown body readers and provenance defects propagate; malformed JSON remains a known rejection', async () => {
  let reads = 0;
  const defect = new TypeError('provenance reader');
  const root = { path: tmpdir(), get skills() { if (++reads > 1) throw defect; return []; } };
  const fixture = host({ local: { state: async () => ({ roots: [root], warnings: [] }) } });
  try {
    const invalidOrigin = fixture.request('/create', {}, randomUUID());
    invalidOrigin.headers.set('origin', ':invalid');
    assert.equal((await fixture.send(invalidOrigin)).status, 403);
    const originRequest = fixture.request('/create', {}, randomUUID());
    originRequest.headers.set('origin', 'https://corp.example');
    const originalURL = globalThis.URL;
    try {
      globalThis.URL = class extends originalURL {
        constructor(value, ...args) { if (value === 'https://corp.example') throw defect; super(value, ...args); }
      };
      await assert.rejects(fixture.send(originRequest), error => error === defect);
    } finally { globalThis.URL = originalURL; }
    for (const error of [new ReferenceError('body reader'), new TypeError('body stream')]) {
      const request = fixture.request('/create', {}, randomUUID());
      request.text = async () => { throw error; };
      await assert.rejects(fixture.send(request), caught => caught === error);
    }
    const malformed = fixture.request('/create', {}, randomUUID());
    malformed.text = async () => '{';
    assert.equal((await (await fixture.send(malformed)).json()).code, 'error.proto.invalidJson');
    await assert.rejects(fixture.routes.get(prefix + '/state').fetch(new Request('http://localhost' + prefix + '/state')), caught => caught === defect);
  } finally { await fixture.dispose(); }
});

test('catalog notification defects stay visible after a commit and leave the mutation pending', async () => {
  const defect = new ReferenceError('catalog notification');
  let writes = 0;
  const fixture = host({ local: { createSkill: async () => { writes++; return { name: 'example-skill' }; } }, afterWrite: () => { throw defect; } });
  try {
    const id = randomUUID();
    await assert.rejects(fixture.post('/create', { name: 'example-skill' }, id), error => error === defect);
    assert.equal(writes, 1);
    assert.deepEqual(await fixture.status(id), { state: 'pending' });
    assert.equal((await (await fixture.post('/create', { name: 'example-skill' }, randomUUID())).json()).outcome, 'pending');
    assert.equal(writes, 1);
    for (const context of [
      {},
      { emit() { throw defect; } },
      { get() { throw defect; } },
    ]) assert.throws(() => notifyChatCatalog(context, Object.keys(context).length ? undefined : () => { throw defect; }), error => error === defect);
    const expected = Object.assign(new Error('catalog unavailable'), { code: 'error.repo.state' });
    const events = [];
    notifyChatCatalog({ emit: event => events.push(event) }, () => { throw expected; });
    assert.deepEqual(events, ['commands/change']);
  } finally { await fixture.dispose(); }
});

test('unload rejects queued writes, drains an in-flight local commit, and gates the replacement Host', async () => {
  const path = join(tmpdir(), 'forge-host-reload-' + randomUUID());
  const entered = deferred(), release = deferred();
  const writes = [];
  const old = host({ path, local: { setEntryLocation: async location => { writes.push('old started'); entered.resolve(); await release.promise; writes.push('old committed'); return location; } } });
  const runningId = randomUUID(), queuedId = randomUUID();
  const running = old.post('/sidebar-entry', { location: 'both' }, runningId);
  await entered.promise;
  const queued = old.post('/sidebar-entry', { location: 'sidebar' }, queuedId);
  await new Promise(setImmediate);
  const savedRoute = old.routes.get(prefix + '/sidebar-entry');
  let drained = false;
  const disposal = old.dispose().then(() => { drained = true; });
  assert.equal((await (await queued).json()).outcome, 'rejected');
  assert.equal(drained, false);
  const current = host({ path, local: { setEntryLocation: async location => { writes.push('new committed'); return location; } } });
  try {
    const next = current.post('/sidebar-entry', { location: 'settings' }, randomUUID());
    await new Promise(setImmediate);
    assert.deepEqual(writes, ['old started']);
    assert.deepEqual(await current.status(runningId), { state: 'pending' });
    release.resolve();
    assert.equal((await running).status, 200);
    await disposal;
    assert.equal((await next).status, 200);
    assert.deepEqual(writes, ['old started', 'old committed', 'new committed']);
    assert.equal((await current.status(runningId)).state, 'succeeded');
    assert.equal((await current.status(queuedId)).state, 'rejected');
    const stale = await savedRoute.fetch(old.request('/sidebar-entry', { location: 'both' }, randomUUID()));
    assert.equal((await stale.json()).outcome, 'rejected');
  } finally { release.resolve(); await current.dispose(); }
});

test('unload aborts remote downloads before installation admission', async () => {
  const entered = deferred();
  let signal, installs = 0;
  const fixture = host({
    nacos: { load: async (_body, combined) => { signal = combined; entered.resolve(); await new Promise((_, reject) => combined.addEventListener('abort', () => reject(Object.assign(new Error('cancelled download'), { code: 'error.nacos.cancelled', statusCode: 499 })), { once: true })); } },
    installations: { installCatalog: async () => { installs++; } },
  });
  const id = randomUUID();
  const downloading = fixture.post('/nacos/install', { skillName: 'example-skill', version: '1.0.0', operationId: id });
  await entered.promise;
  await fixture.dispose();
  assert.equal(signal.aborted, true);
  assert.equal((await (await downloading).json()).outcome, 'rejected');
  assert.equal(installs, 0);
  assert.equal((await fixture.operations.status(id)).state, 'rejected');
});

test('installation state readers preserve unknown filesystem defects and classify known read failures', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-installation-read-'));
  const file = join(directory, 'repositories.json');
  const original = fs.readFile;
  const manager = createInstallationManager({ local: { managerHomePath: () => directory } });
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, repositories: [], installs: [] }));
    for (const defect of [new ReferenceError('installation reader'), new TypeError('installation storage')]) {
      fs.readFile = async (...args) => { if (String(args[0]) === file) throw defect; return original(...args); };
      await assert.rejects(manager.sources(), error => error === defect);
    }
    fs.readFile = async () => { throw Object.assign(new Error('unreadable fixture'), { code: 'EACCES' }); };
    await assert.rejects(manager.sources(), { code: 'error.repo.state' });
    fs.readFile = original;
    await fs.writeFile(file, '{');
    await assert.rejects(manager.sources(), { code: 'error.repo.state' });
  } finally { fs.readFile = original; await fs.rm(directory, { recursive: true, force: true }); }
});

async function installationFixture(task) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-host-install-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, 'dsh');
  const local = await import('../lib/core.js');
  const manager = createInstallationManager({ local });
  const id = 'nacos:' + 'c'.repeat(64);
  const pack = { name: 'example-skill', entries: [{ path: 'SKILL.md', data: Buffer.from('---\nname: example-skill\ndescription: Fixture\n---\nFixture').toString('base64') }] };
  const fixture = host({ local, installations: manager, path: manager.managerPath, nacos: { load: async () => ({ id, pack }) } });
  try { await task({ directory, local, manager, fixture }); }
  finally {
    await fixture.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('unload during catalog final commit drains it and a replacement manager preserves the committed installation', async () => {
  await installationFixture(async ({ local, manager, fixture }) => {
    const entered = deferred(), finish = deferred();
    const rename = fs.rename;
    let commits = 0;
    const file = join(manager.managerPath, 'repositories.json');
    fs.rename = async (...args) => {
      if (String(args[1]) === file && ++commits === 2) { entered.resolve(); await finish.promise; }
      return rename(...args);
    };
    const operationId = randomUUID();
    const installing = fixture.post('/nacos/install', { skillName: 'example-skill', version: '1.0.0', operationId });
    let current;
    try {
      await entered.promise;
      const disposal = fixture.dispose();
      const nextManager = createInstallationManager({ local });
      current = host({ path: nextManager.managerPath, local, installations: nextManager });
      const next = current.post('/skill-note', { root: 'dsh', name: 'example-skill', note: 'preserved after reload' }, randomUUID());
      await new Promise(setImmediate);
      assert.equal(commits, 2);
      assert.equal((await fixture.operations.status(operationId)).state, 'pending');
      finish.resolve();
      assert.equal((await installing).status, 200);
      await disposal;
      assert.equal((await next).status, 200);
      assert.equal((await current.operations.status(operationId)).state, 'succeeded');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(saved.catalogInstalls[0].complete, true);
      assert.equal(await fs.readFile(join(process.env.DSH_HOME, 'skills', 'example-skill', 'SKILL.md'), 'utf8'), '---\nname: example-skill\ndescription: Fixture\n---\nFixture');
      assert.equal((await local.readManagerState()).state.customNotes.dsh['example-skill'], 'preserved after reload');
    } finally {
      finish.resolve();
      fs.rename = rename;
      await installing.catch(() => undefined);
      await current?.dispose();
    }
  });
});

test('unknown final catalog storage failure leaves files and intent pending without a rollback', async () => {
  await installationFixture(async ({ local, manager, fixture }) => {
    const rename = fs.rename;
    const defect = new TypeError('final storage defect');
    const file = join(manager.managerPath, 'repositories.json');
    let commits = 0;
    fs.rename = async (...args) => {
      if (String(args[1]) === file && ++commits === 2) throw defect;
      return rename(...args);
    };
    const operationId = randomUUID();
    try {
      await assert.rejects(fixture.post('/nacos/install', { skillName: 'example-skill', version: '1.0.0', operationId }), error => error === defect);
      assert.equal((await fixture.operations.status(operationId)).state, 'pending');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(saved.catalogInstalls[0].complete, false);
      assert.equal((await fs.stat(join(process.env.DSH_HOME, 'skills', 'example-skill', 'SKILL.md'))).isFile(), true);
      assert.equal(commits, 2);
      fs.rename = rename;
      await manager.recoverLocal();
      assert.equal((await fixture.operations.status(operationId)).state, 'succeeded');
      assert.deepEqual((await local.readManagerState()).state.disabledSkills.dsh, ['example-skill']);
    } finally { fs.rename = rename; }
  });
});

for (const provenance of ['catalog', 'repository']) test(`a partially committed ${provenance} restore verifies recovered provenance and exact files before unlocking local mutations`, async () => {
  await installationFixture(async ({ local, manager, fixture }) => {
    const { clientModule } = await import('../spec/fixtures/client-module.mjs');
    const { createClientOperations, normalizeApiFailure } = clientModule;
    const root = local.userRoots().find(item => item.key === 'dsh');
    const skillFile = join(root.path, 'example-skill', 'SKILL.md');
    await fixture.post('/nacos/install', { skillName: 'example-skill', version: '1.0.0', operationId: randomUUID() });
    await fs.appendFile(skillFile, '\nlocal edits before trash');
    const original = await fs.readFile(skillFile, 'utf8');
    const file = join(manager.managerPath, 'repositories.json');
    let trashed;
    if (provenance === 'catalog') trashed = await manager.trashSkill(root, 'example-skill');
    else {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      const record = { ...data.catalogInstalls[0], id: 'legacy-fixture', path: 'skills/example-skill', commit: 'a'.repeat(40) };
      const id = `${Date.now()}-${randomUUID()}`;
      trashed = await local.deleteSkill(root, 'example-skill', undefined, { repositoryTrash: { id, repository: { id: record.id, path: record.path } } });
      data.installs = [{ ...record, trashId: id }];
      delete data.catalogInstalls;
      await fs.writeFile(file, JSON.stringify(data));
    }
    const rename = fs.rename;
    let commits = 0, restoredMoves = 0;
    let fail = true;
    fs.rename = async (...args) => {
      if (String(args[1]) === file && ++commits >= 2 && fail) throw Object.assign(new Error('restore confirmation denied'), { code: 'EACCES' });
      if (String(args[1]) === join(root.path, 'example-skill')) restoredMoves++;
      return rename(...args);
    };
    const controller = createClientOperations(async (path, options) => {
      if (!options) return fixture.status(new URL('http://localhost' + path).searchParams.get('operationId'));
      const response = await fixture.post(path, JSON.parse(options.body), new Headers(options.headers).get('x-dsh-skills-operation'));
      const payload = await response.json();
      if (!payload.ok) throw normalizeApiFailure(payload);
      return payload.data;
    });
    const body = { id: trashed.id };
    const request = (path, body) => controller.request(path, { method: 'POST', body: JSON.stringify(body) });
    try {
      await assert.rejects(request('/trash-restore', body));
      const operationId = controller.getSnapshot().id;
      assert.equal((await controller.confirm()).state, 'pending');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal((provenance === 'catalog' ? saved.catalogInstalls : saved.installs)[0].trashId, trashed.id, 'status query must not run recovery');
      await assert.rejects(request('/skill-note', { root: 'dsh', name: 'example-skill', note: 'blocked while uncertain' }));
      assert.equal((await fixture.post('/trash-restore', body, randomUUID())).status, 409);
      assert.equal(restoredMoves, 1);
      fail = false;
      const refreshed = await fixture.routes.get(prefix + '/state').fetch(new Request('http://localhost' + prefix + '/state'));
      assert.equal(refreshed.status, 200, 'reopening the management view runs the normal local recovery');

      const recoveredState = await fs.readFile(file, 'utf8');
      const changedSource = JSON.parse(recoveredState);
      (provenance === 'catalog' ? changedSource.catalogInstalls : changedSource.installs)[0].id = provenance === 'catalog' ? 'nacos:' + 'd'.repeat(64) : 'different-repository';
      await fs.writeFile(file, JSON.stringify(changedSource));
      assert.equal((await controller.confirm()).state, 'pending', 'matching files cannot confirm a different source identity');
      await fs.writeFile(file, recoveredState);
      await fs.appendFile(skillFile, '\nchanged after recovery');
      assert.equal((await controller.confirm()).state, 'pending', 'a complete record alone cannot confirm changed files');
      await fs.writeFile(skillFile, original);
      const outcome = await controller.confirm();
      assert.equal(outcome.state, 'succeeded');
      assert.equal(outcome.result.id, trashed.id);
      assert.equal(controller.getSnapshot(), null);
      assert.equal((await fixture.status(operationId)).state, 'succeeded');
      await request('/skill-note', { root: 'dsh', name: 'example-skill', note: 'available after recovery' });
      assert.equal((await local.readManagerState()).state.customNotes.dsh['example-skill'], 'available after recovery');
      const retry = await fixture.post('/trash-restore', body, randomUUID());
      assert.equal((await retry.json()).code, 'error.trash.notFound', 'a new UUID reaches the operation after the target unlocks');
      assert.equal(restoredMoves, 1, 'verification never repeats the restore');
    } finally { fs.rename = rename; }
  });
});

test('confirmed failure to persist the first catalog intent rejects before copying files and releases the target', async () => {
  await installationFixture(async ({ local, manager, fixture }) => {
    const writeFile = fs.writeFile;
    const file = join(manager.managerPath, 'repositories.json');
    let fail = true;
    fs.writeFile = async (...args) => {
      if (String(args[0]).startsWith(file + '.') && fail) throw Object.assign(new Error('intent write denied'), { code: 'EACCES' });
      return writeFile(...args);
    };
    const request = { skillName: 'example-skill', version: '1.0.0' };
    try {
      const firstId = randomUUID();
      const response = await fixture.post('/nacos/install', { ...request, operationId: firstId });
      const payload = await response.json();
      assert.equal(response.ok, false, JSON.stringify(payload));
      assert.equal(payload.outcome, 'rejected', JSON.stringify(payload));
      assert.deepEqual(await fixture.operations.status(firstId), { state: 'rejected', code: 'error.repo.state', error: '安装意图未写入，技能文件未复制；恢复磁盘写入后重试' });
      await assert.rejects(fs.stat(join(process.env.DSH_HOME, 'skills', 'example-skill', 'SKILL.md')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
      fail = false;
      const retryId = randomUUID();
      const retried = await fixture.post('/nacos/install', { ...request, operationId: retryId });
      assert.equal(retried.status, 200, JSON.stringify(await retried.clone().json()));
      assert.equal((await fixture.operations.status(retryId)).state, 'succeeded');
      assert.equal((await fs.stat(join(process.env.DSH_HOME, 'skills', 'example-skill', 'SKILL.md'))).isFile(), true);
    } finally { fs.writeFile = writeFile; }
  });
});

for (const failure of ['unreadable-state', 'committed-intent']) test(`an uncertain first catalog intent remains pending with ${failure}`, async () => {
  await installationFixture(async ({ manager, fixture }) => {
    const writeFile = fs.writeFile, readFile = fs.readFile, rm = fs.rm;
    const file = join(manager.managerPath, 'repositories.json');
    await fs.mkdir(manager.managerPath, { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, repositories: [], installs: [] }));
    let attempted = false;
    const denied = () => Object.assign(new Error('intent verification denied'), { code: 'EACCES' });
    fs.writeFile = async (...args) => {
      if (String(args[0]).startsWith(file + '.')) {
        attempted = true;
        if (failure === 'unreadable-state') throw denied();
      }
      return writeFile(...args);
    };
    fs.readFile = async (...args) => {
      if (failure === 'unreadable-state' && attempted && String(args[0]) === file) throw denied();
      return readFile(...args);
    };
    fs.rm = async (...args) => {
      if (failure === 'committed-intent' && String(args[0]).startsWith(file + '.')) throw denied();
      return rm(...args);
    };
    const request = { skillName: 'example-skill', version: '1.0.0' };
    try {
      const operationId = randomUUID();
      const response = await fixture.post('/nacos/install', { ...request, operationId });
      assert.equal((await response.json()).outcome, 'pending');
      assert.deepEqual(await fixture.operations.status(operationId), { state: 'pending' });
      assert.equal((await fixture.post('/nacos/install', { ...request, operationId: randomUUID() })).status, 409);
      await assert.rejects(fs.stat(join(process.env.DSH_HOME, 'skills', 'example-skill', 'SKILL.md')), { code: 'ENOENT' });
      if (failure === 'committed-intent') {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(saved.catalogInstalls[0].complete, false, 'an intent committed before cleanup failed must be retained');
      }
    } finally { fs.writeFile = writeFile; fs.readFile = readFile; fs.rm = rm; }
  });
});

test('independent installation managers share admission for the same persistent directory', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-manager-admission-'));
  const entered = deferred(), finish = deferred();
  const calls = [];
  const local = setter => ({
    managerHomePath: () => directory,
    createWorkspaceIndex: () => ({}),
    listTrash: async () => [],
    restoreTrash: setter,
  });
  const old = createInstallationManager({ local: local(async () => { calls.push('old started'); entered.resolve(); await finish.promise; calls.push('old committed'); return { ok: true }; }) });
  const first = old.restoreTrash('fixture');
  await entered.promise;
  const module = await import('../lib/installations.js?generation=' + randomUUID());
  const current = module.createInstallationManager({ local: local(async () => { calls.push('new committed'); return { ok: true }; }) });
  const next = current.restoreTrash('fixture');
  try {
    await new Promise(setImmediate);
    assert.deepEqual(calls, ['old started']);
    finish.resolve();
    await Promise.all([first, next]);
    assert.deepEqual(calls, ['old started', 'old committed', 'new committed']);
  } finally { finish.resolve(); await fs.rm(directory, { recursive: true, force: true }); }
});
