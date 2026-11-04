import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_RETRY_POLICY,
  THINKING_LEVELS,
  normalizeGatewayBaseURL,
  validateManagedModels,
  parseCapacity,
  formatCapacity,
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

test('applyModelOptions overlays custom options on raw model lists', () => {
  const raw = [
    { id: 'model-a', name: 'Raw A', contextWindow: 32768, maxTokens: 4096, input: ['text'] },
    { id: 'model-b', name: 'Raw B', contextWindow: 65536, maxTokens: 8192, input: ['text'] },
  ];
  const options = {
    'model-a': {
      name: 'Custom A',
      contextWindow: '128K',
      maxTokens: '16K',
      inputModalities: ['text', 'image'],
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
    },
  };

  const overlaid = applyModelOptions(raw, options);
  assert.equal(overlaid.length, 2);

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

  // Model B untouched
  assert.equal(overlaid[1].name, 'Raw B');
  assert.equal(overlaid[1].contextWindow, 65536);
  assert.equal(overlaid[1].maxTokens, 8192);
  assert.equal(overlaid[1].hasCustomMaxTokens, false);
  assert.deepEqual(overlaid[1].inputModalities, ['text']);
  assert.equal(overlaid[1].reasoning, false);
});
