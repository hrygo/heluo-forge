import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexSrc = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
const scopeSrc = readFileSync(new URL('../src/scope.mjs', import.meta.url), 'utf8');
const catalogSrc = readFileSync(new URL('../src/catalog.mjs', import.meta.url), 'utf8');
const preferencesSrc = readFileSync(new URL('../src/preferences.mjs', import.meta.url), 'utf8');
const mentionsSrc = readFileSync(new URL('../src/mentions.mjs', import.meta.url), 'utf8');
const selectionSrc = readFileSync(new URL('../src/selection.mjs', import.meta.url), 'utf8');
const dispatchSrc = readFileSync(new URL('../src/dispatch.mjs', import.meta.url), 'utf8');
const delegraClientSrc = readFileSync(new URL('../src/delegra-client.mjs', import.meta.url), 'utf8');
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

function assertIsolatedMentionsGate(source) {
  assert.match(source, /if \(options\?\.isolatedMentionsPreview === true\)\s*\{\s*disposers\.push\(mountIsolatedMentionsSource\(ctx\)\);/u);
}

function assertRoutesSecurityGuards(source) {
  assert.match(source, /connectionRejection\(req, ports\.getConnection\)/u);
  assert.match(source, /if \(!hasMutationHeader\(req\)\)/u);
  assert.doesNotMatch(source, /openStorageDomain\(/u);
}

/**
 * Host seam guards (verified against the shipped DSH 0.2.x runtime):
 * - Cordis accepts only a service-name array / name -> config map for `inject`;
 * - `webServer.register` takes one WebRoute object;
 * - `storageDomain.open(DomainSpec)` returns a Domain whose `table(name)` yields
 *   a KvTable (sync `get`, `put`), and
 * - cleanup is collected through `ctx.effect`, never a `dispose` event.
 */
function assertHostIntegrationContracts(indexSource, preferencesSource, clientSource) {
  assert.match(indexSource, /export const inject = \[/u, 'inject must be an array of service names');
  assert.doesNotMatch(indexSource, /export const inject = \{/u, 'an object inject makes Cordis wait for a service named after its key');
  assert.match(indexSource, /register\(\{\s*kind: 'prefix',\s*path: API_PREFIX,\s*handler: host\.handleRequest,?\s*\}\)/u, 'routes are registered with one WebRoute object');
  assert.doesNotMatch(indexSource, /register\(API_PREFIX, host\.handleRequest\)/u, 'positional register(path, handler) does not exist');
  assert.match(preferencesSource, /PREFERENCES_DOMAIN_SPEC/u, 'the store opens an explicit DomainSpec');
  assert.match(preferencesSource, /\.table\(PREFERENCES_TABLE\)/u, 'records are reached through Domain.table(name)');
  assert.match(preferencesSource, /table\.put\(/u, 'durable writes use KvTable.put(key, value)');
  assert.match(preferencesSource, /table\.get\(key\)/u, 'reads use the synchronous KvTable.get(key)');
  assert.doesNotMatch(preferencesSource, /\.get\(PREFERENCES_TABLE/u, 'a flat domain.get(table, key) does not exist');
  assert.doesNotMatch(preferencesSource, /\.set\(PREFERENCES_TABLE/u, 'a flat domain.set(table, key, value) does not exist');
  for (const [label, source] of [['host', indexSource], ['client', clientSource]]) {
    assert.match(source, /ctx\.effect\?\.\(/u, `${label} teardown must be registered as a ctx.effect`);
    assert.doesNotMatch(source, /on\??\.\(\s*'dispose'/u, `${label} must not rely on a 'dispose' event Cordis never emits`);
  }
}

test('host contracts: inject array, WebRoute registration, Domain.table storage API, ctx.effect teardown', () => {
  assertHostIntegrationContracts(indexSrc, preferencesSrc, clientSrc);
});

test('P2: src/index.mjs holds zero mutable business state and all business axes have zero cross-imports', () => {
  assertIndexPureAssembly(indexSrc);
  assertNoCrossAxisImports({
    scope: scopeSrc,
    catalog: catalogSrc,
    preferences: preferencesSrc,
    mentions: mentionsSrc,
    selection: selectionSrc,
    dispatch: dispatchSrc,
    'delegra-client': delegraClientSrc,
    routes: routesSrc,
  });
});

test('P1 / P3 / P5 / P7: client.js is a single bundle with a single error reader and gated @ trigger registration', () => {
  assertSingleErrorReaderInClient(clientSrc);
  assertIsolatedMentionsGate(clientSrc);
  assert.doesNotMatch(clientSrc, /localStorage/u);
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
    preferences: preferencesSrc,
    mentions: `import { createCatalogService } from './catalog.mjs';\n${mentionsSrc}`,
    routes: routesSrc,
  }));
  assert.throws(() => assertSingleErrorReaderInClient(`${clientSrc}\nconst dup = res.body?.error?.code;\n`));
  assert.throws(() => assertSingleErrorReaderInClient(`import './src/scope.mjs';\n${clientSrc}`));
  assert.throws(() => assertIsolatedMentionsGate(clientSrc.replace('if (options?.isolatedMentionsPreview === true)', 'if (true)')));
  assert.throws(() => assertRoutesSecurityGuards(routesSrc.replaceAll('if (!hasMutationHeader(req))', 'if (false)')));

  const groupedInject = indexSrc.replace("export const inject = ['webServer', 'connection', 'storageDomain', 'iam'];", "export const inject = { required: ['webServer'] };");
  assert.notEqual(groupedInject, indexSrc, 'mutation must rewrite the inject declaration');
  assert.throws(() => assertHostIntegrationContracts(groupedInject, preferencesSrc, clientSrc));

  const positionalRoute = indexSrc.replace(/register\(\{\s*kind: 'prefix',\s*path: API_PREFIX,\s*handler: host\.handleRequest,?\s*\}\)/u, 'register(API_PREFIX, host.handleRequest)');
  assert.notEqual(positionalRoute, indexSrc, 'mutation must rewrite the route registration');
  assert.throws(() => assertHostIntegrationContracts(positionalRoute, preferencesSrc, clientSrc));

  const flatStorage = preferencesSrc.replace('.table(PREFERENCES_TABLE)', '.get(PREFERENCES_TABLE)');
  assert.notEqual(flatStorage, preferencesSrc, 'mutation must rewrite the storage access');
  assert.throws(() => assertHostIntegrationContracts(indexSrc, flatStorage, clientSrc));

  const disposeEvent = indexSrc.replace('ctx.effect?.(() => async () => {', "ctx.on?.('dispose', async () => {");
  assert.notEqual(disposeEvent, indexSrc, 'mutation must rewrite the teardown registration');
  assert.throws(() => assertHostIntegrationContracts(disposeEvent, preferencesSrc, clientSrc));
});
