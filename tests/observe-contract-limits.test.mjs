import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBoundedBuffer, createBoundedExporter } from '../packages/forge-policy/src/observe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 有界缓冲只按 event_id 与字节数记账，不重新校验投影；这里用最小合法事件即可。
const event = { schema_version: 'forge.observation.v1', event_id: 'evt-contract-1' };

// D2（责任方 2026-10-24 确认）：限额写在契约里，代码默认值必须与契约一致；
// 这一组断言的作用是**防漂移**——改默认值而不同步契约时会先在这里失败。
test('D2: the bounded buffer defaults match the confirmed contract limits', () => {
  const stats = createBoundedBuffer().stats();
  assert.equal(stats.maxEvents, 1000);
  assert.equal(stats.maxBytes, 4 * 1024 * 1024);
  assert.equal(stats.ttlMs, 24 * 60 * 60 * 1000);
});

test('D2: the export backoff stays capped at five minutes even if the server hint is absurd', async () => {
  const buffer = createBoundedBuffer();
  buffer.add(event);
  let clock = 0;
  let sends = 0;
  const exporter = createBoundedExporter({
    buffer,
    enabled: true,
    now: () => clock,
    random: () => 0,
    send: async (batch) => {
      sends += 1;
      if (sends === 1) return { status: 429, retryAfterMs: 999_999_000 };
      return { status: 200, ack: batch.map((event) => event.event_id) };
    },
  });

  const first = await exporter.exportOnce();
  assert.equal(first.status, 'backoff');
  assert.equal(first.delayMs, 300_000, '一个荒谬的服务端提示也必须被 5 分钟封顶');

  clock = 299_999;
  assert.equal((await exporter.exportOnce()).reason, 'BACKOFF', '封顶前不得重试');
  clock = 300_001;
  assert.equal((await exporter.exportOnce()).status, 'sent', '封顶之后应恢复投递');
  assert.equal(sends, 2);
});

test('D2: the contract states the confirmed values and their confirmation date', async () => {
  const contract = await readFile(join(root, 'docs/contracts/metrics-events.md'), 'utf8');
  for (const fragment of ['1000 条', '4 MiB', '24 小时', '5 分钟', '经责任方 2026-10-24 确认']) {
    assert.ok(contract.includes(fragment), `契约应写明「${fragment}」`);
  }
});
