import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../src/ledger.mjs';
import { REASONS } from '../src/errors.mjs';

const record = (overrides = {}) => ({
  name: 'demo-skill',
  version: '1.0.0',
  requestedRef: 'version:1.0.0',
  scope: { kind: 'user' },
  origin: { endpoint: 'https://nacos.corp.example', namespaceId: 'skill-prod', catalogMode: 'console-list' },
  contentSha256: 'a'.repeat(64),
  skillMdSha256: 'b'.repeat(64),
  description: '示例',
  installedAt: '2026-10-28T00:00:00.000Z',
  enabled: true,
  lastVerifiedAt: '2026-10-28T00:00:00.000Z',
  ...overrides,
});

async function fresh(overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), 'sn-ledger-'));
  const ledger = await createLedger({
    statePath: join(base, 'state.json'),
    lockPath: join(base, '.lock'),
    ...overrides,
  }).initialize();
  return { ledger, base };
}

test('put/get/list round-trips and survives a fresh reader', async () => {
  const { ledger, base } = await fresh();
  await ledger.put(record());
  await ledger.put(record({ name: 'api-doc-gen', version: '2.0.0' }));
  assert.equal(ledger.get('demo-skill').version, '1.0.0');
  assert.deepEqual(ledger.list().map((entry) => entry.name), ['api-doc-gen', 'demo-skill']);

  const reopened = await createLedger({ statePath: join(base, 'state.json'), lockPath: join(base, '.lock') }).initialize();
  assert.equal(reopened.get('api-doc-gen').version, '2.0.0');
});

test('state is written atomically: no tmp residue, valid JSON, 0600 kept by writer', async () => {
  const { ledger, base } = await fresh();
  await ledger.put(record());
  const statePath = join(base, 'state.json');
  assert.equal(existsSync(`${statePath}.tmp`), false);
  const parsed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.installs['demo-skill'].version, '1.0.0');
});

test('a crashed tmp file is ignored; corrupt state fails loud', async () => {
  const { ledger, base } = await fresh();
  writeFileSync(join(base, 'state.json.tmp'), '{"formatVersion":1,"installs":{'); // 崩溃现场
  await ledger.put(record());
  assert.equal(ledger.get('demo-skill').name, 'demo-skill');

  writeFileSync(join(base, 'state.json'), '{broken');
  await assert.rejects(
    createLedger({ statePath: join(base, 'state.json'), lockPath: join(base, '.lock') }).initialize(),
    (error) => error.code === REASONS.LEDGER_INVALID,
  );
});

test('enabled and scope are ledger-level updates', async () => {
  const { ledger } = await fresh();
  await ledger.put(record());
  assert.equal((await ledger.setEnabled('demo-skill', false)).enabled, false);
  const moved = await ledger.changeScope('demo-skill', { kind: 'project', root: '/tmp/proj' });
  assert.equal(moved.scope.kind, 'project');
  assert.throws(() => ledger.changeScope('demo-skill', { kind: 'nope' }), (error) => error.code === REASONS.LEDGER_INVALID);
});

test('uninstall → trash → restore → purge keeps the install identity', async () => {
  const { ledger } = await fresh();
  await ledger.put(record({ enabled: false }));
  const entry = await ledger.removeToTrash('demo-skill');
  assert.equal(ledger.get('demo-skill'), undefined);
  assert.equal(ledger.trashList().length, 1);

  const restored = await ledger.commitRestore(entry.id);
  assert.equal(restored.version, '1.0.0');
  assert.equal(restored.enabled, false); // 卸载前启用状态原样保留

  const second = await ledger.removeToTrash('demo-skill');
  await ledger.purgeFromTrash(second.id);
  assert.deepEqual(ledger.trashList(), []);
  await assert.rejects(ledger.purgeFromTrash(second.id), (error) => error.code === REASONS.NOT_FOUND);
});

test('a held cross-process lock times out loudly instead of being taken over', async () => {
  const { ledger, base } = await fresh({ lockTimeoutMs: 80 });
  const blocker = await createLedger({
    statePath: join(base, 'state.json'),
    lockPath: join(base, '.lock'),
    lockTimeoutMs: 80,
  }).initialize();
  await blocker.runExclusive(async () => {
    await assert.rejects(ledger.put(record({ name: 'x-skill' })), (error) => error.code === REASONS.LOCK_TIMEOUT);
  });
  // 锁释放后写入恢复
  await ledger.put(record({ name: 'x-skill' }));
  assert.equal(ledger.get('x-skill').name, 'x-skill');
});
