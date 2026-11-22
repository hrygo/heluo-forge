import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexSrc = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
const scopeSrc = readFileSync(new URL('../src/scope.mjs', import.meta.url), 'utf8');
const catalogSrc = readFileSync(new URL('../src/catalog.mjs', import.meta.url), 'utf8');
const preferencesSrc = readFileSync(new URL('../src/preferences.mjs', import.meta.url), 'utf8');
const routesSrc = readFileSync(new URL('../src/routes.mjs', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function assertIndexPureAssembly(source) {
  for (const forbidden of ['let scopeEpoch', 'let viewVersion', 'new Map(', 'new Set(', 'handle.set(', 'handle.get(']) {
    assert.ok(!source.includes(forbidden), `src/index.mjs must remain a pure assembly point (found "${forbidden}")`);
  }
}

function assertNoCrossAxisImports(axisMap) {
  const names = Object.keys(axisMap);
  for (const [owner, source] of Object.entries(axisMap)) {
    const imported = [...source.matchAll(/from '\.\/([a-z-]+)\.mjs'/gu)].map((m) => m[1]);
    const illegal = imported.filter((target) => names.includes(target) && target !== owner);
    assert.deepEqual(illegal, [], `src/${owner}.mjs must not import sibling axis: ${illegal.join(', ')}`);
  }
}

function assertSingleErrorReaderInClient(source) {
  assert.match(source, /window\.__ModuleLoader__\.load\(/u);
  assert.doesNotMatch(source, /\bimport\s+.*src\//u);
  assert.doesNotMatch(source, /require\(['"]\.\/src\//u);
  const errorReads = source.match(/\.body\?\.error\?\.code/gu) ?? [];
  assert.equal(errorReads.length, 1, 'client.js must have exactly one error-code unpacker (P5)');
}

function assertRoutesSecurityGuards(source) {
  assert.match(source, /connectionRejection\(req, ports\.getConnection\)/u);
  assert.match(source, /if \(!hasMutationHeader\(req\)\)/u);
  assert.doesNotMatch(source, /openStorageDomain\(/u);
}

test('P2: src/index.mjs holds zero mutable business state and axes have zero cross-imports', () => {
  assertIndexPureAssembly(indexSrc);
  assertNoCrossAxisImports({
    scope: scopeSrc,
    catalog: catalogSrc,
    preferences: preferencesSrc,
    routes: routesSrc,
  });
});

test('P1 / P5 / P7: client.js is a single bundle with a single error reader and no direct host writes', () => {
  assertSingleErrorReaderInClient(clientSrc);
  assert.doesNotMatch(clientSrc, /localStorage/u);
  assert.doesNotMatch(clientSrc, /inputTriggers\.registerSource/u);
});

test('P6 / P8: routes enforce connection auth and CSRF header without touching storage directly', () => {
  assertRoutesSecurityGuards(routesSrc);
  assert.match(preferencesSrc, /openStorageDomain\(/u);
});

test('P9 mutation proofs: every structural guard fails when deliberately violated', () => {
  assert.throws(() => assertIndexPureAssembly(`${indexSrc}\nlet scopeEpoch = 1;\n`));
  assert.throws(() => assertNoCrossAxisImports({
    scope: scopeSrc,
    catalog: catalogSrc,
    preferences: `import { createCatalogService } from './catalog.mjs';\n${preferencesSrc}`,
    routes: routesSrc,
  }));
  assert.throws(() => assertSingleErrorReaderInClient(`${clientSrc}\nconst dup = res.body?.error?.code;\n`));
  assert.throws(() => assertSingleErrorReaderInClient(`import './src/scope.mjs';\n${clientSrc}`));
  assert.throws(() => assertRoutesSecurityGuards(routesSrc.replace('if (!hasMutationHeader(req))', 'if (false)')));
});
