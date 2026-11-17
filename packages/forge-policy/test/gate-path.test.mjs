import assert from 'node:assert/strict';
import test from 'node:test';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../src/gate.mjs';

// 内置分类里没有任何动作绑定路径参数，所以编译出来的目录条目都不带 `path`；
// 受保护路径检查因此不会自动触发（见文档「受保护路径检查是目标能力」）。
// 这里直接构造带 `path` 绑定的目录条目，锁定门禁在该绑定存在时的行为：
// 命中受保护根即拒，没有配置根也拒，绝不降级为放行。
const ACTION = 'demo.path.write';
const ROOT = tmpdir();
const CATALOG = new Map([[ACTION, Object.freeze({ action: ACTION, path: 'target' })]]);

function gateWith(protectedRoots) {
  return createGate({ catalog: CATALOG, tools: { demo_write: ACTION }, protectedRoots });
}

function writeExec() {
  return {
    name: 'demo_write',
    arguments: { target: join(ROOT, 'secret.txt') },
    callId: 'c1',
    signal: new AbortController().signal,
  };
}

test('目录条目声明路径参数后，命中受保护路径在确认前硬拒绝', async () => {
  const gate = gateWith([{ raw: ROOT, root: ROOT }]);
  const decision = await gate.preExecute({}, writeExec(), () => Promise.resolve({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /targets the protected path/u);
});

test('声明了路径参数却没有任何受保护根时关闭，不降级为放行', async () => {
  const gate = gateWith([]);
  const decision = await gate.preExecute({}, writeExec(), () => Promise.resolve({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /no protected root is configured/u);
});
