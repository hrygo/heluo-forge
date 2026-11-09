import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');

// Restored bytes are untrusted: CI must fetch/restore upstream tarballs through
// the integrity-checking staging command, even when its npm cache is warm.
function nativeCacheProblems(source) {
  const cache = /      - name: Restore the staged addons\n([\s\S]*?)(?=\n      - name:)/u.exec(source)?.[1] ?? '';
  const stage = /      - name: Stage the pinned addons\n([\s\S]*?)(?=\n      - name:|\n      #)/u.exec(source)?.[1] ?? '';
  const problems = [];
  if (!cache.includes('path: ${{ runner.temp }}/forge-native-npm-cache') || cache.includes('packages/forge-credentials-keychain/vendor')) {
    problems.push('the cache must contain npm cache data, not the staged vendor tree');
  }
  if (!stage.includes('npm_config_cache: ${{ runner.temp }}/forge-native-npm-cache') || !stage.includes("npm_config_prefer_offline: 'true'")) {
    problems.push('the staging command must use the restored npm cache');
  }
  const fetchCommand = 'node scripts/fetch-native-keyring.mjs --registry https://registry.npmjs.org';
  if (!/^          node scripts\/fetch-native-keyring\.mjs --registry https:\/\/registry\.npmjs\.org$/mu.test(stage)
      || !/^          node scripts\/fetch-native-keyring\.mjs --check$/mu.test(stage)
      || !/^          git diff --exit-code -- packages\/forge-credentials-keychain\/vendor\/CHECKSUMS\.json$/mu.test(stage)
      || stage.indexOf(`${fetchCommand}\n`) > stage.indexOf('node scripts/fetch-native-keyring.mjs --check')) {
    problems.push('every run must stage verified tarballs and check the layout and committed record');
  }
  return problems;
}

test('native CI revalidates source tarballs even on a cache hit', () => {
  assert.deepEqual(nativeCacheProblems(workflow), []);
});

test('the native CI policy catches restoring the staged record or skipping staging', () => {
  const poisonedCache = workflow.replace('path: ${{ runner.temp }}/forge-native-npm-cache', 'path: packages/forge-credentials-keychain/vendor');
  assert.match(nativeCacheProblems(poisonedCache).join('\n'), /not the staged vendor tree/u);
  const skippedStaging = workflow.replace('          node scripts/fetch-native-keyring.mjs --registry https://registry.npmjs.org\n', '            node scripts/fetch-native-keyring.mjs --registry https://registry.npmjs.org\n');
  assert.match(nativeCacheProblems(skippedStaging).join('\n'), /every run must stage/u);
  const skippedRecordComparison = workflow.replace('          git diff --exit-code -- packages/forge-credentials-keychain/vendor/CHECKSUMS.json\n', '');
  assert.match(nativeCacheProblems(skippedRecordComparison).join('\n'), /committed record/u);
});

test('the macOS document-backend job does not retain checkout credentials', () => {
  const job = /  document-macos-15:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]+:\n|$)/u.exec(workflow)?.[1] ?? '';
  const checkoutWithoutCredentials = /uses: actions\/checkout@[a-f0-9]+[^\n]*\n\s+with:\n\s+persist-credentials: false/u;
  assert.match(job, checkoutWithoutCredentials);
  assert.doesNotMatch(job.replace('persist-credentials: false', 'persist-credentials: true'), checkoutWithoutCredentials);
});
