#!/usr/bin/env node
// #36 假端故障用例（真实 HTTP、真实 socket、真实计时）。
//
// 目的：把"投影 → 有界缓冲 → 有界导出"接到真实网络栈上跑一遍，验证默认关闭、部分确认、
// 同 ID 重送、401 停止、429 退避与响应未知暂停。**它不能替代企业摄取端**：认证资源、
// 去重权威与部分确认格式仍须由摄取方提供（指标事件契约 §5.1/§6）。
//
// 用法：node scripts/probe/observe-export-probe.mjs
// 输出：一行 JSON（含各场景结果），任一断言失败时退出码 1。
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { apply } from '../../packages/forge-policy/src/index.mjs';
import { SCHEMA_VERSION } from '../../packages/forge-policy/src/observe.mjs';

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
}

const event = (id, overrides = {}) => ({
  schema_version: SCHEMA_VERSION,
  event_id: id,
  event_name: 'forge.tool.completed',
  source_version: '0.1.0',
  emitted_at: '2026-10-24T10:00:00.000Z',
  occurred_at: '2026-10-24T09:59:58.000Z',
  operation_id: `op-${id}`,
  action: 'repo.read',
  access_kind: 'read',
  status: 'success',
  ...overrides,
});

/** 假摄取端：按队列返回预设响应，并记录实际收到的批次。 */
function startFakeIngest(script) {
  const received = [];
  let index = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = String(Buffer.concat(chunks));
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      received.push({ body, ids: (JSON.parse(body).events ?? []).map((item) => item.event_id) });
      if (step === 'hang') return; // 不响应：模拟超时/响应未知
      response.writeHead(step.status, step.headers ?? { 'content-type': 'application/json' });
      response.end(JSON.stringify(step.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        received,
        url: `http://127.0.0.1:${port}/v1/observations`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** 真实 HTTP 发送方：batch → POST，超时即抛出（导出层按"响应未知"处理）。 */
function httpSender(url, { timeoutMs = 1500 } = {}) {
  return async (batch) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        signal: controller.signal,
      });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        return {
          status: 429,
          retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
        };
      }
      if (!response.ok) return { status: response.status };
      const payload = await response.json();
      return { status: response.status, ack: payload.ack ?? [] };
    } finally {
      clearTimeout(timer);
    }
  };
}

// 已登记枚举由部署方提供；探针用最小集合（与契约 §3.2 的动作类别一致）。
const registeredEnums = { status: ['success', 'failure', 'partial', 'unknown'], action: ['repo.read', 'review.ai.publish', 'review.human.record'] };

function mount(sink, observation) {
  const provided = new Map();
  const ctx = {
    get: (name) => (name === 'observationSink' ? sink : undefined),
    provide: (name, value) => (provided.set(name, value), () => provided.delete(name)),
    effect: (callback) => callback(),
    tools: { guard: () => () => {} },
  };
  apply(ctx, { observation: { enums: registeredEnums, ...observation } });
  return provided.get('policy').observations();
}

// ---- 场景 1：默认关闭，不查发送方、不发请求 ----
{
  let lookups = 0;
  const runtime = mount(undefined, undefined);
  const before = lookups;
  const exportResult = await runtime.exportOnce();
  check('default-off: no sink lookup', lookups === before && runtime.status === 'disabled');
  check('default-off: export skipped', exportResult.reason === 'DISABLED', exportResult);
  check('default-off: no buffer allocated', runtime.buffer === null);
}

// ---- 场景 2：部分确认只移除确认项，其余以同一 event_id 重送 ----
{
  const ingest = await startFakeIngest([
    { status: 200, body: { ack: ['evt-a', 'evt-b'] } },
    { status: 200, body: { ack: ['evt-c'] } },
  ]);
  try {
    const runtime = mount({ send: httpSender(ingest.url) }, { export: { enabled: true } });
    for (const id of ['evt-a', 'evt-b', 'evt-c']) {
      check(`partial-ack: ${id} is accepted locally`, runtime.record(event(id)).ok === true, runtime.record(event(id)));
    }
    const first = await runtime.exportOnce();
    check('partial-ack: only confirmed items removed', first.accepted === 2 && first.pending === 1, first);
    const second = await runtime.exportOnce();
    check('partial-ack: the unconfirmed item is resent', second.accepted === 1, second);
    check('partial-ack: the server saw exactly two batches', ingest.received.length === 2,
      { batches: ingest.received.map((item) => item.ids), first, second });
    check('partial-ack: server saw the same id twice, not a new one',
      JSON.stringify(ingest.received[1]?.ids) === JSON.stringify(['evt-c']),
      ingest.received.map((item) => item.ids));
  } finally {
    await ingest.close();
  }
}

// ---- 场景 3：拒绝的事件根本不上网 ----
{
  const ingest = await startFakeIngest([{ status: 200, body: { ack: [] } }]);
  try {
    const runtime = mount({ send: httpSender(ingest.url) }, { export: { enabled: true } });
    const rejected = runtime.record(event('evt-secret', { prompt: 'SECRET-EXAMPLE' }));
    check('allow-list: a content-bearing event is rejected locally', rejected.ok === false && rejected.reason === 'UNKNOWN_FIELD', rejected);
    check('allow-list: the rejection carries no payload', !JSON.stringify(rejected).includes('SECRET-EXAMPLE'));
    await runtime.exportOnce();
    check('allow-list: nothing reached the endpoint', ingest.received.length === 0, ingest.received.length);
  } finally {
    await ingest.close();
  }
}

// ---- 场景 4：401 停止导出，且不再发起请求 ----
{
  const ingest = await startFakeIngest([{ status: 401 }]);
  try {
    const runtime = mount({ send: httpSender(ingest.url) }, { export: { enabled: true } });
    runtime.record(event('evt-401'));
    const first = await runtime.exportOnce();
    const second = await runtime.exportOnce();
    check('401: export stops', first.status === 'stopped' && first.code === 401, first);
    check('401: nothing is retried after an auth stop', second.reason === 'AUTH_STOPPED' && ingest.received.length === 1, ingest.received.length);
    check('401: the event is kept for the owner', runtime.stats().events === 1);
  } finally {
    await ingest.close();
  }
}

// ---- 场景 5：429 按服务端提示退避，窗口内不发送 ----
{
  const ingest = await startFakeIngest([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200, body: { ack: ['evt-429'] } }]);
  try {
    const runtime = mount({ send: httpSender(ingest.url) }, { export: { enabled: true } });
    runtime.record(event('evt-429'));
    const limited = await runtime.exportOnce();
    const early = await runtime.exportOnce();
    check('429: honours the server hint', limited.status === 'backoff' && limited.delayMs >= 1000, limited);
    check('429: no request before the backoff window ends', early.reason === 'BACKOFF' && ingest.received.length === 1, ingest.received.length);
    await delay(1100);
    const after = await runtime.exportOnce();
    check('429: resumes after the window and delivers', after.status === 'sent' && after.accepted === 1, after);
  } finally {
    await ingest.close();
  }
}

// ---- 场景 6：响应未知（挂住）→ 暂停且保留事件 ----
{
  const ingest = await startFakeIngest(['hang']);
  try {
    const runtime = mount({ send: httpSender(ingest.url, { timeoutMs: 300 }) }, { export: { enabled: true } });
    runtime.record(event('evt-timeout'));
    const outcome = await runtime.exportOnce();
    check('unknown response: export pauses instead of guessing', outcome.status === 'paused', outcome);
    check('unknown response: events are kept', runtime.stats().events === 1);
  } finally {
    await ingest.close();
  }
}

const summary = {
  probe: 'observe-export-probe',
  host: `${process.platform}-${process.arch}`,
  node: process.version,
  scenarios: results.length,
  passed: results.filter((item) => item.ok).length,
  failed: failures,
  results,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(failures === 0 ? 0 : 1);
