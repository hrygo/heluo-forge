import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_COMMAND_DESCRIPTION,
  AUDIT_COMMAND_HINT,
  AUDIT_COMMAND_NAME,
  registerAuditCommand,
} from '../src/audit-command.mjs';
import { AUDIT_EMPTY_COPY, AUDIT_UNREADABLE_COPY } from '../src/audit-query.mjs';

// P3 · `/policy-audit [N]` 注册与只读行为：命令只读审计源，不写审计、不改策略状态。
function harness({ audit, commands = true } = {}) {
  const registered = new Map();
  const ctx = {
    get(name) {
      if (name !== 'commands') return undefined;
      if (commands === false) return undefined;
      return {
        register(definition) {
          registered.set(definition.name, definition);
          return () => registered.delete(definition.name);
        },
      };
    },
  };
  const dispose = registerAuditCommand(ctx, { audit });
  return { ctx, registered, dispose };
}

function records() {
  return [
    { observedAt: Date.UTC(2026, 10, 23, 2), action: 'gitee.issue.write', decision: 'allow', phase: 'begin' },
    { observedAt: Date.UTC(2026, 10, 23, 1), action: 'gitee.issue.write', decision: 'allow', phase: 'begin' },
  ];
}

test('the command is registered with its documented shape and disposed as one', () => {
  const { registered, dispose } = harness({ audit: { read: async () => ({ records: [] }) } });
  assert.deepEqual([...registered.keys()], [AUDIT_COMMAND_NAME]);
  const definition = registered.get(AUDIT_COMMAND_NAME);
  assert.equal(definition.name, 'policy-audit');
  assert.equal(definition.description, AUDIT_COMMAND_DESCRIPTION);
  assert.equal(definition.input.hint, AUDIT_COMMAND_HINT);
  assert.equal(typeof definition.handler, 'function');
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(registered.size, 0);
});

test('a host without a commands service gets a no-op registration', () => {
  for (const options of [
    { audit: { read: async () => ({ records: [] }) }, commands: false },
    { commands: false },
  ]) {
    const { registered, dispose } = harness(options);
    assert.equal(registered.size, 0);
    assert.equal(typeof dispose, 'function');
    assert.doesNotThrow(() => dispose());
  }
});

test('the argument defaults to twenty records and never writes', async () => {
  const limits = [];
  const audit = {
    read: async ({ limit }) => {
      limits.push(limit);
      return { records: records(), corrupt: 0, missing: false, unreadable: false };
    },
    record() {
      throw new Error('the read-only command must not write audit records');
    },
  };
  const { registered } = harness({ audit });
  const result = await registered.get(AUDIT_COMMAND_NAME).handler({ rawInput: '' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /^最近 2 条审计记录（新 → 旧）/u);
  assert.deepEqual(limits, [20]);
});

test('a numeric argument is honoured and a too-large one is clamped with a note', async () => {
  const limits = [];
  const audit = {
    read: async ({ limit }) => {
      limits.push(limit);
      return { records: records() };
    },
  };
  const { registered } = harness({ audit });
  const handler = registered.get(AUDIT_COMMAND_NAME).handler;

  assert.equal((await handler({ rawInput: '7' })).kind, 'success');
  const clamped = await handler({ rawInput: '9999' });
  assert.equal(clamped.kind, 'success');
  assert.equal(clamped.text.split('\n').at(-1), '超过上限，只显示最近 200 条。');
  assert.deepEqual(limits, [7, 200]);
});

test('a non-numeric argument falls back to twenty with an explanation', async () => {
  const limits = [];
  const audit = {
    read: async ({ limit }) => {
      limits.push(limit);
      return { records: records() };
    },
  };
  const { registered } = harness({ audit });
  const result = await registered.get(AUDIT_COMMAND_NAME).handler({ rawInput: 'abc' });
  assert.equal(result.kind, 'success');
  assert.equal(result.text.split('\n').at(-1), '条数需为 1–200 的整数，已回退为 20。');
  assert.deepEqual(limits, [20]);
});

test('an unreadable sink becomes a readable error without a path or errno', async () => {
  const { registered } = harness({
    audit: { read: async () => ({ records: [], corrupt: 0, missing: false, unreadable: true }) },
  });
  const result = await registered.get(AUDIT_COMMAND_NAME).handler({ rawInput: '5' });
  assert.deepEqual(result, { kind: 'error', text: AUDIT_UNREADABLE_COPY });

  const thrown = harness({
    audit: { read: async () => { throw new Error('EACCES: permission denied, scandir /private/logs'); } },
  });
  const failed = await thrown.registered.get(AUDIT_COMMAND_NAME).handler({ rawInput: '5' });
  assert.deepEqual(failed, { kind: 'error', text: AUDIT_UNREADABLE_COPY });
  assert.equal(failed.text.includes('EACCES'), false);
  assert.equal(failed.text.includes('/private'), false);
});

test('a missing audit source reports the empty-state hint, not a zero-row success', async () => {
  for (const audit of [undefined, { read: async () => ({ records: [], missing: true }) }]) {
    const { registered } = harness({ audit });
    const result = await registered.get(AUDIT_COMMAND_NAME).handler({ rawInput: '' });
    assert.deepEqual(result, { kind: 'error', text: AUDIT_EMPTY_COPY });
  }
});

test('the handler tolerates a missing invocation object', async () => {
  const { registered } = harness({ audit: { read: async () => ({ records: [] }) } });
  const result = await registered.get(AUDIT_COMMAND_NAME).handler(undefined);
  assert.equal(result.kind, 'error');
});
