import test from 'node:test';
import assert from 'node:assert/strict';
import {
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

test('normalizeGatewayBaseURL allows all HTTP and HTTPS addresses with OpenAI-compatible path suffix', () => {
  assert.equal(normalizeGatewayBaseURL('https://gateway.example/v1'), 'https://gateway.example/v1');
  assert.equal(normalizeGatewayBaseURL('https://gateway.example'), 'https://gateway.example/v1');
  assert.equal(normalizeGatewayBaseURL('https://gateway.example///'), 'https://gateway.example/v1');

  // All HTTP addresses are permitted
  assert.equal(normalizeGatewayBaseURL('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1');
  assert.equal(normalizeGatewayBaseURL('http://localhost:3000/v1'), 'http://localhost:3000/v1');
  assert.equal(normalizeGatewayBaseURL('http://example.com/v1'), 'http://example.com/v1');
  assert.equal(normalizeGatewayBaseURL('http://192.0.2.10:8000'), 'http://192.0.2.10:8000/v1');

  // Rejects embedded credentials, search, hash, or non-http(s) protocols
  const credentialUrl = new URL('https://gateway.example/v1');
  credentialUrl.username = 'synthetic-user';
  credentialUrl.password = 'synthetic-password';
  assert.throws(() => normalizeGatewayBaseURL(credentialUrl));
  assert.throws(() => normalizeGatewayBaseURL('https://gateway.example/v1?token=123'));
  assert.throws(() => normalizeGatewayBaseURL('https://gateway.example/v1#hash'));
  assert.throws(() => normalizeGatewayBaseURL('ftp://gateway.example'));
  assert.throws(() => normalizeGatewayBaseURL('ws://gateway.example'));
  assert.throws(() => normalizeGatewayBaseURL('not-a-url'));
});

test('validateManagedModels handles empty and valid configuration objects', () => {
  assert.deepEqual(validateManagedModels(null), { value: null });
  assert.deepEqual(validateManagedModels(undefined), { value: null });
  assert.deepEqual(validateManagedModels({ baseURL: 'https://gateway.corp.example' }), {
    value: { baseURL: 'https://gateway.corp.example/v1' },
  });
  assert.deepEqual(validateManagedModels({ baseURL: 'http://corp.example' }), {
    value: { baseURL: 'http://corp.example/v1' },
  });

  const invalid = validateManagedModels({ baseURL: 'ftp://corp.example' });
  assert.ok(Array.isArray(invalid.issues));
  assert.equal(invalid.issues[0].path[0], 'managedModels');
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
  assert.equal(overlaid[1].reasoning, false);

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

  // Reversed bounds are automatically normalized
  const reversed = buildReasoningEffortRange('max', 'medium');
  assert.deepEqual(reversed, {
    off: null,
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
