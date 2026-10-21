import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIndexText } from '../validate-index.mjs';

const URL_BASE = 'https://aihub.example/plugin-index.json';

test('校验合法索引并统计插件与版本', () => {
  const text = JSON.stringify({
    format: 1,
    title: { en: 'Enterprise Plugins', zh: '企业插件' },
    plugins: [
      {
        name: '@heluo/a',
        versions: [
          { version: '1.1.0', publishTimestamp: 1760000000, source: { type: 'npm', registry: 'http://npm.corp.example/' } },
          { version: '1.0.0', publishTimestamp: 1750000000, source: { type: 'npm', registry: 'http://npm.corp.example/' } },
        ],
      },
    ],
  });
  const result = validateIndexText(text, URL_BASE);
  assert.equal(result.plugins, 1);
  assert.equal(result.versions, 2);
  assert.deepEqual(result.index.plugins[0].versions.map((entry) => entry.version), ['1.1.0', '1.0.0']);
});

test('拒绝缺 en、重复版本与 git source', () => {
  const base = { format: 1, title: { en: 'X' }, plugins: [] };
  assert.throws(() => validateIndexText(JSON.stringify({ ...base, title: { zh: 'X' } }), URL_BASE), /contain en/);

  const duplicate = {
    ...base,
    plugins: [{
      name: '@heluo/a',
      versions: [
        { version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' } },
        { version: '1.0.0', publishTimestamp: 2, source: { type: 'npm' } },
      ],
    }],
  };
  assert.throws(() => validateIndexText(JSON.stringify(duplicate), URL_BASE), /duplicates/);

  const git = {
    ...base,
    plugins: [{ name: '@heluo/a', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'git', url: 'https://git.corp/a/b', commit: 'a'.repeat(40) } }] }],
  };
  assert.throws(() => validateIndexText(JSON.stringify(git), URL_BASE), /must be npm/);
});
