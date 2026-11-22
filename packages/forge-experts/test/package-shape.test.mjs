import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const patchText = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8');
const localeEn = JSON.parse(readFileSync(join(pkgDir, 'locale/en.json'), 'utf8'));
const localeZh = JSON.parse(readFileSync(join(pkgDir, 'locale/zh.json'), 'utf8'));

function checkManifest(pkg) {
  assert.equal(pkg.name, '@heluo/forge-experts');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines?.dsh ?? '', /^>=\d+\.\d+\.\d+/u);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(pkg.scripts?.[script], undefined, `must not declare install-time script ${script}`);
  }
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  for (const required of ['src', 'client.js', 'locale', 'icon.svg', 'cordis.patch.yml', 'README.md']) {
    assert.ok(Array.isArray(pkg.files) && pkg.files.includes(required), `files must include ${required}`);
    assert.ok(existsSync(join(pkgDir, required)), `declared file ${required} must exist`);
  }
  const peers = Object.keys(pkg.peerDependencies ?? {});
  assert.deepEqual(peers, ['react']);
  assert.equal(pkg.peerDependenciesMeta?.react?.optional, true);
}

function checkPatchLayer(text) {
  assert.match(text, /id:\s*forge-experts/u);
  assert.match(text, /name:\s*'@heluo\/forge-experts'/u);
  assert.match(text, /managementEnabled:\s*false/u);
  assert.match(text, /dispatchEnabled:\s*false/u);
  assert.doesNotMatch(text, /^\s+isolate:/mu);
  assert.doesNotMatch(text, /^\s+(permission|sandbox):/mu);
}

function keyTree(obj, prefix = '') {
  return Object.keys(obj).sort().flatMap((k) => {
    const val = obj[k];
    const next = prefix ? `${prefix}.${k}` : k;
    return val && typeof val === 'object' && !Array.isArray(val) ? keyTree(val, next) : [next];
  });
}

test('package manifest, files, and locale parity satisfy bundle closure rules', () => {
  checkManifest(manifest);
  assert.deepEqual(keyTree(localeEn), keyTree(localeZh));
});

test('cordis.patch.yml keeps management and dispatch disabled by default without isolate', () => {
  checkPatchLayer(patchText);
});

test('P9 mutation proof: package-shape guards fail when violated', () => {
  const withPostinstall = { ...manifest, scripts: { ...manifest.scripts, postinstall: 'echo bad' } };
  assert.throws(() => checkManifest(withPostinstall), /postinstall/u);

  const nonOptionalPeer = { ...manifest, peerDependenciesMeta: { react: { optional: false } } };
  assert.throws(() => checkManifest(nonOptionalPeer));

  const enabledPatch = patchText.replace('managementEnabled: false', 'managementEnabled: true');
  assert.throws(() => checkPatchLayer(enabledPatch));

  const isolatedPatch = `${patchText}      isolate: { policy: experts }\n`;
  assert.throws(() => checkPatchLayer(isolatedPatch));
});
