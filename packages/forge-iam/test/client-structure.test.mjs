import assert from 'node:assert/strict';
import test from 'node:test';

import { analyseClient, readClientSource } from './support/client-source.mjs';

// These baselines freeze the client's current DRY/SOLID debt so that it can only
// shrink. Each entry is keyed by the enclosing top-level function, so inserting
// lines is free while moving a violation into a new function fails the guard.
// Lower a baseline only inside the unit that removes the violation (U2-U4 in
// docs/plans/2026-11-05-forge-iam-structure.md); never raise one.
// view.state is read in exactly one place: the derivation.
const STATE_READ_BASELINE = { deriveSessionUi: 2 };
// modelAccess.state too; a local `access` alias counts, so the guard cannot be dodged.
const MODEL_STATE_READ_BASELINE = { deriveModelUi: 2 };
// Credential state is never read directly: deriveGatewayUi(credential) owns it.
const GATEWAY_STATE_READ_BASELINE = {};

// Storage is centralised: every access lives in createClientStore().
const STORAGE_BASELINE = { createClientStore: 5 };

// One reader: resultCode(). Everything else asks resultNotice(result).
const RAW_RESULT_CODE_BASELINE = { resultCode: 1 };

// Props a render entry may still receive. The target is four named groups
// (`{ h, ui, model, actions }`); U4 lowers every entry to it.
// 计数含显式 key（`prop: value`），与实际入参数量一致。
const RENDER_ARITY_BASELINE = {
  renderAccountCard: 26,
  renderGatewayCard: 16,
  renderModelItem: 21,
  renderModelsCard: 12, // 34 → 12: 目录数据与动作整体传入（catalogue）
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

test('view.state is read only by deriveSessionUi()', () => {
  assert.deepEqual(
    analysed.violations.stateReads,
    STATE_READ_BASELINE,
    'read a derived flag (deriveSessionUi(view).ready) instead of touching view.state here',
  );
});

test('modelAccess.state is read only by deriveModelUi()', () => {
  assert.deepEqual(
    analysed.violations.modelStateReads,
    MODEL_STATE_READ_BASELINE,
    'read a derived flag (deriveModelUi(view).ready) instead of modelAccess.state here',
  );
});

test('credential state is read only through deriveGatewayUi()', () => {
  assert.deepEqual(
    analysed.violations.gatewayStateReads,
    GATEWAY_STATE_READ_BASELINE,
    'call deriveGatewayUi(credential).configured instead of comparing gateway.state here',
  );
});

test('storage access stays inside createClientStore()', () => {
  assert.deepEqual(
    analysed.violations.storageSites,
    STORAGE_BASELINE,
    'touch storage only inside createClientStore(): use clientStore.marker/modelOptions/models elsewhere',
  );
});

test('responses are unwrapped in one place: resultCode()', () => {
  assert.deepEqual(
    analysed.violations.rawResultCode,
    RAW_RESULT_CODE_BASELINE,
    'read a response code through resultNotice(result)/resultCode(result) instead of result.body?.error?.code',
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

test('error texts are one table, not a branch chain', () => {
  assert.match(
    source,
    /const ERROR_NOTICE = Object\.freeze\(Object\.assign\(Object\.create\(null\), \{/,
    'ERROR_NOTICE must stay a frozen prototype-less table',
  );
  assert.doesNotMatch(source, /if \(code === '/, 'add a row to ERROR_NOTICE instead of another if-branch');
});
