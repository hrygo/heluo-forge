import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagerStateStore } from '../lib/manager-state.js';
import { createInstallationManager } from '../lib/installations.js';
import { createInstallOperations } from '../lib/install-operations.js';
import { randomUUID } from 'node:crypto';

test('state transactions retain concurrent edits, roll back rejected updates and recover after errors', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-state-transactions-'));
  const before = { ...process.env };
  process.env.DSH_HOME = join(directory, 'dsh');
  process.env.HOME = process.env.USERPROFILE = join(directory, 'user');
  const local = await import('../lib/core.js');
  try {
    for (const name of ['first-skill', 'second-skill']) {
      const created = await local.createSkill({ name, description: 'Fixture', body: 'Fixture' });
      assert.notEqual(created.ok, false, JSON.stringify(created));
    }
    const root = local.userRoots().find(item => item.key === 'dsh');
    const results = await Promise.all([
      local.setSkillEnabled(root, 'first-skill', false),
      local.setSkillEnabled(root, 'second-skill', false),
      local.setSkillNote('dsh', 'first-skill', 'kept note'),
      local.setEntryLocation('sidebar'),
      ...Array.from({ length: 8 }, (_, index) => local.createCategory('dsh', `category ${index}`)),
    ]);
    for (const result of results) assert.notEqual(result?.ok, false, JSON.stringify(result));
    const { state } = await local.readManagerState();
    assert.deepEqual(state.disabledSkills.dsh, ['first-skill', 'second-skill']);
    assert.equal(state.customNotes.dsh['first-skill'], 'kept note');
    assert.equal(state.entryLocation, 'sidebar');
    assert.equal(state.categories.dsh.length, 8);
    const file = join(directory, 'store.json');
    const empty = () => ({ ...structuredClone(state), sidebarEntry: false, entryLocation: 'settings' });
    const store = createManagerStateStore({ path: () => file, empty, fallback: empty, migrate: value => value, validate: () => true, normalize: value => value, writeRejected: () => ({ ok: false, error: 'locked' }) });
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    const first = store.update(async current => { entered(); await paused; current.entryLocation = 'both'; });
    await ready;
    const second = store.update(current => { current.sidebarEntry = true; });
    release();
    await Promise.all([first, second]);
    assert.equal((await store.read()).state.entryLocation, 'both');
    assert.equal((await store.read()).state.sidebarEntry, true);
    await store.update(current => { current.entryLocation = 'settings'; return { ok: false, error: 'rejected' }; });
    assert.equal((await store.read()).state.entryLocation, 'both');
    const defect = new ReferenceError('synthetic defect');
    await assert.rejects(store.update(() => { throw defect; }), error => error === defect);
    await store.update(current => { current.entryLocation = 'sidebar'; });
    assert.equal((await store.read()).state.entryLocation, 'sidebar');
    await fs.writeFile(file, '{');
    assert.equal((await store.read()).writable, false);
    assert.equal((await store.update(() => assert.fail('must fail closed'))).ok, false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('catalog recovery cannot erase a concurrent user disable', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-recovery-policy-'));
  const before = { ...process.env };
  process.env.DSH_HOME = join(directory, 'dsh');
  process.env.HOME = process.env.USERPROFILE = join(directory, 'user');
  const local = await import('../lib/core.js');
  const read = fs.readFile;
  let release;
  try {
    await local.createSkill({ name: 'other-skill', description: 'Fixture', body: 'Fixture' });
    const root = local.userRoots().find(item => item.key === 'dsh');
    const manager = createInstallationManager({ local });
    const pack = { name: 'catalog-skill', entries: [{ path: 'SKILL.md', data: Buffer.from('---\nname: catalog-skill\ndescription: Fixture\n---\nFixture').toString('base64') }] };
    await manager.installCatalog('nacos:' + 'a'.repeat(64), pack);
    const recordFile = join(local.managerHomePath(), 'repositories.json');
    const records = JSON.parse(await read(recordFile, 'utf8'));
    records.catalogInstalls[0].complete = false;
    await fs.writeFile(recordFile, JSON.stringify(records));
    const policy = JSON.parse(await read(local.managerStatePath(), 'utf8'));
    policy.enabledSkills.dsh = [];
    await fs.writeFile(local.managerStatePath(), JSON.stringify(policy));
    assert.equal(await manager.catalogReceipt('nacos:' + 'a'.repeat(64)), undefined);
    assert.equal(JSON.parse(await read(recordFile, 'utf8')).catalogInstalls[0].complete, false, 'receipt query cannot recover or write an intent');
    let entered, count = 0;
    const ready = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    fs.readFile = async function(path, ...options) {
      const result = await read.call(this, path, ...options);
      if (String(path) === local.managerStatePath() && ++count === 2) { entered(); await paused; }
      return result;
    };
    const recovery = manager.recoverLocal();
    await ready;
    let disabled = false;
    const disable = local.setSkillEnabled(root, 'other-skill', false).then(result => { disabled = true; assert.notEqual(result.ok, false); });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disabled, false, 'policy update waits for recovery transaction');
    release();
    await Promise.all([recovery, disable]);
    assert.ok((await local.readManagerState()).state.disabledSkills.dsh.includes('other-skill'));
    assert.equal((await manager.catalogReceipt('nacos:' + 'a'.repeat(64))).name, 'catalog-skill');
    await fs.appendFile(join(root.path, 'catalog-skill', 'SKILL.md'), '\nchanged');
    assert.equal(await manager.catalogReceipt('nacos:' + 'a'.repeat(64)), undefined, 'a record alone is not evidence for modified files');
  } finally {
    release?.();
    fs.readFile = read;
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an unconfirmed committed install becomes a receipt only after local recovery verifies it', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-install-receipt-'));
  const before = { ...process.env };
  process.env.DSH_HOME = join(directory, 'dsh');
  process.env.HOME = process.env.USERPROFILE = join(directory, 'user');
  const local = await import('../lib/core.js');
  const rename = fs.rename;
  try {
    const manager = createInstallationManager({ local });
    const operations = createInstallOperations();
    const operationId = randomUUID();
    const catalogId = 'nacos:' + 'b'.repeat(64);
    const pack = { name: 'receipt-skill', entries: [{ path: 'SKILL.md', data: Buffer.from('---\nname: receipt-skill\ndescription: Fixture\n---\nFixture').toString('base64') }] };
    let writes = 0;
    fs.rename = async function(source, target) {
      if (String(target) === join(local.managerHomePath(), 'repositories.json') && ++writes === 2) throw Object.assign(new Error('synthetic final write failure'), { code: 'EACCES' });
      return rename.call(this, source, target);
    };
    await assert.rejects(operations.run(operationId, 'receipt-target', () => manager.installCatalog(catalogId, pack, { disabledOnInstall: true }), () => manager.catalogReceipt(catalogId)), { code: 'error.repo.installState' });
    assert.equal((await operations.status(operationId)).state, 'pending');
    fs.rename = rename;
    await manager.recoverLocal();
    const outcome = await operations.status(operationId);
    assert.equal(outcome.state, 'succeeded');
    assert.equal(outcome.result.name, 'receipt-skill');
    assert.ok((await local.readManagerState()).state.disabledSkills.dsh.includes('receipt-skill'));
  } finally {
    fs.rename = rename;
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('upload preserves programming exceptions and classifies known filesystem errors', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'forge-import-errors-'));
  const before = { ...process.env };
  process.env.DSH_HOME = join(directory, 'dsh');
  process.env.HOME = process.env.USERPROFILE = join(directory, 'user');
  const local = await import('../lib/core.js');
  const copy = fs.cp;
  const input = { name: 'example-skill', entries: [{ path: 'SKILL.md', data: Buffer.from('---\nname: example-skill\ndescription: Fixture\n---\nFixture').toString('base64') }] };
  try {
    for (const defect of [new ReferenceError('missing dependency'), new TypeError('bad implementation')]) {
      fs.cp = async () => { throw defect; };
      await assert.rejects(local.importUploadedSkill(input), error => error === defect);
    }
    fs.cp = async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
    const result = await local.importUploadedSkill(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'error.import.failed');
  } finally {
    fs.cp = copy;
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
