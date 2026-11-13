import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MANUAL_MODELS,
  mergeAvailableModels,
  NO_RETRY_POLICY,
  THINKING_LEVELS,
  REASONING_EFFORT_LEVELS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  normalizeGatewayBaseURL,
  validateManagedModels,
  parseCapacity,
  formatCapacity,
  buildReasoningEffortRange,
  getReasoningEffortBounds,
  buildThinkingLevelMap,
  applyModelOptions,
} from '../src/model-options.mjs';

test('NO_RETRY_POLICY complies with ResolvedNormalRetryPolicy contract', () => {
  assert.equal(NO_RETRY_POLICY.mode, 'normal');
  assert.equal(NO_RETRY_POLICY.maxRetries, 0);
  assert.ok(Array.isArray(NO_RETRY_POLICY.retryableCodes));
  assert.equal(NO_RETRY_POLICY.retryableCodes.length, 0);
  assert.ok(Object.isFrozen(NO_RETRY_POLICY));
  assert.ok(Object.isFrozen(NO_RETRY_POLICY.retryableCodes));
});

test('normalizeGatewayBaseURL keeps the path verbatim and accepts HTTP for any host', () => {
  assert.equal(normalizeGatewayBaseURL('https://gateway.example/v1'), 'https://gateway.example/v1');
  assert.equal(normalizeGatewayBaseURL('https://gateway.example'), 'https://gateway.example');
  assert.equal(normalizeGatewayBaseURL('https://gateway.example///'), 'https://gateway.example');
  assert.equal(normalizeGatewayBaseURL('https://gateway.example/aig/v1/'), 'https://gateway.example/aig/v1');

  assert.equal(normalizeGatewayBaseURL('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(normalizeGatewayBaseURL('http://localhost:3000/v1'), 'http://localhost:3000/v1');
  assert.equal(normalizeGatewayBaseURL('http://[::1]:9000'), 'http://[::1]:9000');
  assert.equal(normalizeGatewayBaseURL('http://example.com/v1'), 'http://example.com/v1');
  assert.equal(normalizeGatewayBaseURL('http://192.0.2.10:8000'), 'http://192.0.2.10:8000');
  assert.equal(normalizeGatewayBaseURL('http://[2001:db8::1]:8000/v1/'), 'http://[2001:db8::1]:8000/v1');

  // Rejects embedded credentials, search, hash, or non-http(s) protocols
  const credentialUrl = new URL('https://gateway.example/v1');
  credentialUrl.username = 'synthetic-user';
  credentialUrl.password = 'synthetic-password';
  assert.throws(() => normalizeGatewayBaseURL(credentialUrl));
  assert.throws(() => normalizeGatewayBaseURL('https://gateway.example/v1?token=123'));
  assert.throws(() => normalizeGatewayBaseURL('https://gateway.example/v1#hash'));
  assert.throws(() => normalizeGatewayBaseURL('https://gateway.example/v1?'));
  assert.throws(() => normalizeGatewayBaseURL('https://gateway.example/v1#'));
  assert.equal(normalizeGatewayBaseURL('https://gateway.example/a%3Fb%23c'), 'https://gateway.example/a%3Fb%23c');
  assert.throws(() => normalizeGatewayBaseURL('ftp://gateway.example'));
  assert.throws(() => normalizeGatewayBaseURL('ws://gateway.example'));
  assert.throws(() => normalizeGatewayBaseURL('not-a-url'));
});

test('validateManagedModels handles empty and valid configuration objects', () => {
  assert.deepEqual(validateManagedModels(null), { value: null });
  assert.deepEqual(validateManagedModels(undefined), { value: null });
  assert.deepEqual(validateManagedModels({ baseURL: 'https://gateway.corp.example' }), {
    value: { baseURL: 'https://gateway.corp.example' },
  });
  assert.deepEqual(validateManagedModels({ baseURL: 'http://corp.example' }), {
    value: { baseURL: 'http://corp.example' },
  });
  const invalid = validateManagedModels({ baseURL: 'ftp://corp.example' });
  assert.ok(Array.isArray(invalid.issues));
  assert.equal(invalid.issues[0].path[0], 'managedModels');
});

test('validateManagedModels points to the invalid field', () => {
  assert.deepEqual(validateManagedModels({}).issues[0].path, ['managedModels', 'baseURL']);
  assert.match(validateManagedModels({}).issues[0].message, /required/u);
  assert.deepEqual(validateManagedModels({ baseURL: 'ftp://corp.example' }).issues[0].path, ['managedModels', 'baseURL']);
  assert.doesNotMatch(validateManagedModels({ baseURL: 'ftp://corp.example' }).issues[0].message, /\/v1\/models/u);
  assert.deepEqual(validateManagedModels({ baseURL: 'https://corp.example', other: true }).issues[0].path, ['managedModels']);
});

test('validateManagedModels propagates unexpected exceptions', () => {
  const cause = new TypeError('synthetic unexpected getter failure');
  assert.throws(() => validateManagedModels({ get baseURL() { throw cause; } }), error => error === cause);
});

test('parseCapacity handles numeric and string representations (K / M / pure numbers)', () => {
  assert.equal(parseCapacity(32768), 32768);
  assert.equal(parseCapacity('32768'), 32768);
  assert.equal(parseCapacity('32k'), 32000);
  assert.equal(parseCapacity('32K'), 32000);
  assert.equal(parseCapacity('128k'), 128000);
  assert.equal(parseCapacity('1m'), 1000000);
  assert.equal(parseCapacity('1.5M'), 1500000);

  // Invalid cases
  assert.equal(parseCapacity(undefined), undefined);
  assert.equal(parseCapacity(null), undefined);
  assert.equal(parseCapacity(''), undefined);
  assert.equal(parseCapacity('   '), undefined);
  assert.equal(parseCapacity('abc'), undefined);
  assert.equal(parseCapacity(-100), undefined);
  assert.equal(parseCapacity(0), undefined);
});

test('formatCapacity formats numeric values into compact K / M representation', () => {
  assert.equal(formatCapacity(128000), '128K');
  assert.equal(formatCapacity(1000000), '1M');
  assert.equal(formatCapacity(2000000), '2M');
  assert.equal(formatCapacity(4096), '4096');
  assert.equal(formatCapacity(0), '');
  assert.equal(formatCapacity(-1), '');
  assert.equal(formatCapacity(undefined), '');
});

test('buildThinkingLevelMap correctly maps levels and disables unused with null', () => {
  assert.equal(buildThinkingLevelMap(null), undefined);
  assert.equal(buildThinkingLevelMap(undefined), undefined);
  assert.equal(buildThinkingLevelMap('low'), undefined);
  assert.equal(buildThinkingLevelMap({}), undefined);
  assert.equal(buildThinkingLevelMap({ off: 'off' }), undefined); // only off enabled

  const map = buildThinkingLevelMap({ low: 'low', high: 'high' });
  assert.ok(map);
  assert.equal(map.low, 'low');
  assert.equal(map.high, 'high');
  assert.equal(map.off, null);

  // "off" never becomes a wire value: omission is how an OpenAI-compatible request means it.
  const withOff = buildThinkingLevelMap({ off: 'off', low: 'low' });
  assert.equal(withOff.off, null);
  assert.equal(withOff.low, 'low');
  assert.equal(map.medium, null);
  assert.equal(map.minimal, null);
});

test('applyModelOptions overlays custom options on raw model lists and defaults to 200K context window and 64K maxTokens', () => {
  assert.deepEqual(THINKING_LEVELS, ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(DEFAULT_CONTEXT_WINDOW, 200000);
  assert.equal(DEFAULT_MAX_TOKENS, 64000);
  const raw = [
    { id: 'model-a', name: 'Raw A', input: ['text'] },
    { id: 'model-b', name: 'Raw B', contextWindow: 65536, maxTokens: 8192, input: ['text'] },
    { id: 'model-c', name: 'Raw C', input: ['text'] },
  ];
  const options = {
    'model-a': {
      name: 'Custom A',
      contextWindow: '128K',
      maxTokens: '16K',
      inputModalities: ['text', 'image'],
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
    },
    'model-c': {},
  };

  const overlaid = applyModelOptions(raw, options);
  assert.equal(overlaid.length, 3);

  // Model A customized
  assert.equal(overlaid[0].name, 'Custom A');
  assert.equal(overlaid[0].contextWindow, 128000);
  assert.equal(overlaid[0].maxTokens, 16000);
  assert.equal(overlaid[0].hasCustomMaxTokens, true);
  assert.deepEqual(overlaid[0].inputModalities, ['text', 'image']);
  assert.equal(overlaid[0].reasoning, true);
  assert.ok(overlaid[0].thinkingLevelMap);
  assert.equal(overlaid[0].thinkingLevelMap.low, 'low');
  assert.equal(overlaid[0].thinkingLevelMap.off, null);

  // Model B untouched with explicit raw capacity
  assert.equal(overlaid[1].name, 'Raw B');
  assert.equal(overlaid[1].contextWindow, 65536);
  assert.equal(overlaid[1].maxTokens, 8192);
  assert.equal(overlaid[1].hasCustomMaxTokens, false);
  assert.deepEqual(overlaid[1].inputModalities, ['text']);
  assert.equal(overlaid[1].reasoning, true);

  // Model C uses 200K context window and 64K maxTokens default
  assert.equal(overlaid[2].contextWindow, 200000);
  assert.equal(overlaid[2].maxTokens, 64000);
  assert.equal(formatCapacity(overlaid[2].contextWindow), '200K');
  assert.equal(formatCapacity(overlaid[2].maxTokens), '64K');
});

test('buildReasoningEffortRange and getReasoningEffortBounds support lower and upper bound selection', () => {
  assert.deepEqual(REASONING_EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(buildReasoningEffortRange('off', 'off'), undefined);
  assert.equal(buildReasoningEffortRange('', ''), undefined);

  // Contiguous range from low to xhigh
  const range = buildReasoningEffortRange('low', 'xhigh');
  assert.deepEqual(range, {
    off: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
  });
  const bounds = getReasoningEffortBounds(range);
  assert.deepEqual(bounds, {
    enabled: true,
    lower: 'low',
    upper: 'xhigh',
    levels: ['low', 'medium', 'high', 'xhigh'],
  });

  // Range starting from off to high
  const withOff = buildReasoningEffortRange('off', 'high');
  assert.deepEqual(withOff, {
    off: 'off',
    low: 'low',
    medium: 'medium',
    high: 'high',
  });
  assert.deepEqual(getReasoningEffortBounds(withOff), {
    enabled: true,
    lower: 'off',
    upper: 'high',
    levels: ['off', 'low', 'medium', 'high'],
  });

  // Reversed bounds are automatically normalized and 'max' key does not collapse lower bounds
  const reversed = buildReasoningEffortRange('max', 'medium');
  assert.deepEqual(reversed, {
    off: null,
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  });
  assert.deepEqual(getReasoningEffortBounds(reversed), {
    enabled: true,
    lower: 'medium',
    upper: 'max',
    levels: ['medium', 'high', 'xhigh', 'max'],
  });
  assert.deepEqual(buildThinkingLevelMap(reversed), {
    off: null,
    minimal: null,
    low: null,
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  });

  // Shorthand { lower, upper } in buildThinkingLevelMap pins minimal to null
  const thinkingMap = buildThinkingLevelMap({ lower: 'low', upper: 'medium' });
  assert.deepEqual(thinkingMap, {
    off: null,
    minimal: null,
    low: 'low',
    medium: 'medium',
    high: null,
    xhigh: null,
    max: null,
  });
});

test('default thinking range is off through high and explicit options take precedence', () => {
  const [defaultModel, customModel, disabledModel, suppliedModel] = applyModelOptions([
    { id: 'default' }, { id: 'custom' }, { id: 'disabled', reasoning: true },
    { id: 'supplied', reasoningEfforts: { low: 'low', xhigh: 'xhigh' } },
  ], { custom: { reasoningEfforts: { high: 'high' } }, disabled: { reasoningEfforts: { off: 'off' } } });
  assert.deepEqual(defaultModel.reasoningEfforts, { off: 'off', low: 'low', medium: 'medium', high: 'high' });
  assert.equal(defaultModel.thinkingLevelMap.off, null);
  assert.equal(defaultModel.thinkingLevelMap.xhigh, null);
  assert.deepEqual(customModel.reasoningEfforts, { high: 'high' });
  assert.equal(disabledModel.reasoning, false);
  assert.equal(disabledModel.thinkingLevelMap, undefined);
  assert.deepEqual(suppliedModel.reasoningEfforts, { low: 'low', xhigh: 'xhigh' });
});

test('mergeAvailableModels merges catalog and manual lists without mutation and keeps gateway priority', () => {
  assert.equal(MAX_MANUAL_MODELS, 100);
  const catalog = Object.freeze([
    Object.freeze({ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 16384 }),
    Object.freeze({ id: 'deepseek-r1', name: 'DeepSeek R1' }),
  ]);
  const manual = Object.freeze([
    Object.freeze({ id: 'gpt-4o', addedAt: '2026-11-13T00:00:00.000Z' }),
    Object.freeze({ id: 'custom-model@v1', addedAt: '2026-11-13T00:01:00.000Z' }),
    Object.freeze({ id: 'custom-model@v1', addedAt: '2026-11-13T00:02:00.000Z' }),
  ]);

  const merged = mergeAvailableModels(catalog, manual);
  assert.deepEqual(merged, [
    { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 16384, source: 'gateway', hasManualEntry: true },
    { id: 'deepseek-r1', name: 'DeepSeek R1', source: 'gateway' },
    { id: 'custom-model@v1', name: 'custom-model@v1', source: 'manual', addedAt: '2026-11-13T00:01:00.000Z' },
  ]);

  // Empty and undefined inputs are handled safely.
  assert.deepEqual(mergeAvailableModels(undefined, undefined), []);
  assert.deepEqual(mergeAvailableModels([], [{ id: 'only-manual' }]), [
    { id: 'only-manual', name: 'only-manual', source: 'manual' },
  ]);
  assert.deepEqual(mergeAvailableModels([{ id: 'gateway-only', hasManualEntry: true }], []), [
    { id: 'gateway-only', source: 'gateway' },
  ], '网关元数据不能伪造手动声明');

  // Ids the model-id contract rejects are dropped on both sides, not carried
  // into the enabled set or the adapter.
  const oversized = 'x'.repeat(201);
  const filtered = mergeAvailableModels(
    [{ id: '' }, { id: 42 }, { id: oversized }, { id: 'kept-gateway' }],
    [{ id: '' }, { id: null }, { id: oversized }, { id: 'kept-manual' }],
  );
  assert.deepEqual(filtered.map((item) => item.id), ['kept-gateway', 'kept-manual']);
});
