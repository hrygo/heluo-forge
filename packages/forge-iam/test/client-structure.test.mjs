import assert from 'node:assert/strict';
import test from 'node:test';

import { analyseClient, readClientSource } from './support/client-source.mjs';

// These baselines freeze the client's current DRY/SOLID debt so that it can only
// shrink. Each entry is keyed by the enclosing top-level function, so inserting
// lines is free while moving a violation into a new function fails the guard.
// Lower a baseline only inside the unit that removes the violation (U2-U4 in
// docs/plans/2026-11-05-forge-iam-structure.md); never raise one.
const STATE_COMPARISON_BASELINE = {
  getLauncherStatus: 5,
  IamLauncher: 1,
  IamLauncherMenu: 1,
  Onboarding: 11,
  Panel: 3,
  renderAccountCard: 5,
  renderJourneyBar: 3,
  renderOnboardingStepDetail: 3,
  SignedOutBanner: 5,
};

const STORAGE_BASELINE = {
  Panel: 4,
  purgeModelCache: 3,
  readCachedModels: 1,
  readMarker: 1,
  readModelOptions: 1,
  writeCachedModels: 1,
  writeMarker: 1,
};

const RAW_ERROR_UNWRAP_BASELINE = {
  IamLauncher: 1,
  Onboarding: 2,
  Panel: 7,
  SignedOutBanner: 2,
};

// Props a render entry may still receive. The target is four named groups
// (`{ h, ui, model, actions }`); U4 lowers every entry to it.
const RENDER_ARITY_BASELINE = {
  renderAccountCard: 26,
  renderGatewayCard: 16,
  renderModelItem: 21,
  renderModelsCard: 34,
};

const source = readClientSource();
const analysed = analyseClient(source);

test('every responsibility has an anchor and the index covers the file', () => {
  const names = analysed.anchors.map(anchor => anchor.name);
  assert.equal(new Set(names).size, names.length, `duplicate anchor: ${names.join(', ')}`);
  assert.equal(names[0], '1', 'the file must open with the wrapper anchor');
  assert.equal(names.at(-1), '17', 'the file must close with the export anchor');
  for (const anchor of analysed.anchors) {
    assert.ok(anchor.line > 3, `anchor §${anchor.name} must sit inside factory()`);
    assert.ok(anchor.title.trim().length > 1, `anchor §${anchor.name} needs a title`);
  }
  assert.match(source, /\/\/ 1 包装与共享常量 \/ 2 样式表/, 'the header index must list the sections');
});

test('state comparisons only shrink: no new view.state literal checks', () => {
  assert.deepEqual(
    analysed.violations.stateComparisons,
    STATE_COMPARISON_BASELINE,
    'a state comparison appeared in a new place: derive a flag with deriveSessionUi/deriveModelUi instead of comparing view.state here',
  );
});

test('storage access only shrink: localStorage stays in the storage helpers', () => {
  assert.deepEqual(
    analysed.violations.storageSites,
    STORAGE_BASELINE,
    'access localStorage through createClientStore() instead of touching window.localStorage',
  );
});

test('error unwrapping only shrink: no new errorNotice(result.body?.error?.code) site', () => {
  assert.deepEqual(
    analysed.violations.rawErrorUnwrap,
    RAW_ERROR_UNWRAP_BASELINE,
    'unwrap responses with expectOk(result) instead of reading result.body?.error?.code at the call site',
  );
});

test('render entries stay within the recorded prop budget', () => {
  const actual = {};
  for (const name of Object.keys(RENDER_ARITY_BASELINE)) actual[name] = analysed.renderParams[name]?.length;
  assert.deepEqual(actual, RENDER_ARITY_BASELINE, 'a render entry changed its prop list: pass the { h, ui, model, actions } groups instead');
});

test('the client stays one loadable module', () => {
  assert.equal((source.match(/window\.__ModuleLoader__\.load\(/g) ?? []).length, 1, 'only one module entry is supported per package');
  assert.doesNotMatch(source, /^\s*import\s/m, 'the client bundle cannot use static import');
  assert.doesNotMatch(source, /^\s*export\s/m, 'the client bundle cannot use static export');
  assert.match(source, /ctx\.slots\.inject\('settings\.section'/, 'the panel slot registration must stay');
  assert.match(source, /ctx\.slots\.inject\('settings\.launcher'/, 'the launcher slot registration must stay');
});
