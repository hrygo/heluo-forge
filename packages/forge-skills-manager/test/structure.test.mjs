import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { structuralProblems } from '../scripts/structure.mjs';

const sources = (await readdir(new URL('../src/', import.meta.url))).filter(name => name.endsWith('.ts'));
const files = Object.fromEntries(await Promise.all(sources.map(async name => [name, await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')])));
files['bundle.js'] = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const baselineProblems = structuralProblems(files);
const problemCounts = problems => {
  const counts = new Map();
  for (const problem of problems) {
    const key = problem.replace(/\.ts:\d+:/g, '.ts:');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

test('plugin structure: thin assembly, injected axes, one client bundle and owned symbols', async () => {
  assert.deepEqual(structuralProblems(files), []);
  assert.deepEqual((await readdir(new URL('../locale/', import.meta.url))).sort(), ['en.json', 'zh.json']);
  assert.doesNotMatch(files['index.ts'], /tools\.register|create_skill/);
});

for (const [title, file, mutate, expected] of [
  ['entry state', 'index.ts', text => text + '\nlet cache = new Map();'],
  ['state inside assembly', 'index.ts', text => text.replace(' const log =', ' let hiddenSessionState = new Map();\n const log =')],
  ['constant state inside assembly', 'index.ts', text => text.replace(' const log =', ' const hiddenSessionState = new Map();\n const log =')],
  ['state transition inside assembly', 'index.ts', text => text.replace(' installHttp(ctx,', ' local.setEntryLocation("sidebar");\n installHttp(ctx,')],
  ['axis import', 'providers.ts', text => text + '\nimport { state } from "./core.js";'],
  ['axis parser shortcut', 'nacos.ts', text => text + '\nimport { parseSkillDoc } from "./core.js";'],
  ['previously missed pure IO helper in actual client', 'client.ts', text => text.replace('/*! §2', 'function pureAgain() { const send = callApi; return send("/state"); }\n/*! §2'), /client layer §1.*§2 callApi/],
  ['previously missed decoder in actual Nacos view', 'nacos-ui.ts', text => text + '\nfunction decodeAgain(error:any){return error.code||error.error}', /raw API failure read outside/],
  ['previously missed duplicate owner in actual Nacos axis', 'nacos.ts', text => text + '\nimport {createInstallOperations} from "./install-operations.js"; const duplicate = createInstallOperations();', /factory createInstallOperations belongs to index.ts/],
  ['missing anchors', 'client.ts', text => text.replace('§3', 'section-three')],
  ['missing bundle anchors', 'bundle.js', text => text.replace('§3', 'section-three')],
  ['misplaced owned symbol', 'client.ts', text => text.replace('var localeService:', 'var moved:') + '\nlet localeService: unknown;'],
  ['bypassed IO adapter', 'client.ts', text => text + '\nfunction bypass() { return fetch("/private"); }'],
  ['second error body reader', 'client.ts', text => text + '\nfunction bypass(response: Response) { return response.json(); }'],
  ['client persistence', 'client.ts', text => text + '\nlocalStorage.setItem("skills", "enabled");'],
  ['Nacos persistence', 'nacos-ui.ts', text => text + '\nlocalStorage.setItem("skills", "enabled");'],
  ['Nacos error body reader', 'nacos-ui.ts', text => text + '\nfunction bypass(response: Response) { return response.json(); }'],
  ['Nacos network alias', 'nacos-ui.ts', text => text + '\nconst bypass = fetch;'],
  ['split view persistence', 'sidebar-entry.ts', text => text + '\nwindow["localStorage"].setItem("skills", "enabled");'],
  ['policy write bypass', 'core.ts', text => text + '\nwriteFileAtomically(managerStatePath(), "{}");'],
  ['policy write alias', 'core.ts', text => text + '\nconst policyFile = managerStatePath(); fs.writeFile(policyFile, "{}");'],
  ['second bundle', 'bundle.js', text => text + '\nwindow.__ModuleLoader__.load({});'],
  ['public discovery', 'nacos-ui.ts', text => text + '\nconst endpoint = "https://skills.sh";'],
  ['second detail network owner', 'nacos-detail.ts', text => text + '\nfetch("/private");'],
  ['detail persistence', 'nacos-detail.ts', text => text + '\nlocalStorage.setItem("skill", "enabled");'],
  ['external Markdown dependency', 'bundle.js', text => text + '\nrequire("react-markdown");'],
  ['private React internals', 'bundle.js', text => text + '\nReact.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;'],
]) test(`structure guard rejects mutation: ${title}`, () => {
  const changed = mutate(files[file]);
  assert.notEqual(changed, files[file], 'mutation must change the source');
  const original = problemCounts(baselineProblems);
  const mutated = problemCounts(structuralProblems({ ...files, [file]: changed }));
  assert.ok([...mutated].some(([problem, count]) => count > (original.get(problem) ?? 0) && (!expected || expected.test(problem))), 'mutation must add its own violation');
});

function fixture() {
  const anchors = [1, 2, 3, 4, 5].map(section => `/*! §${section} fixture */`);
  return {
    'index.ts': 'export function apply() {}',
    'core.ts': 'import { createManagerStateStore } from "./manager-state.js"; const managerState = createManagerStateStore();',
    'installations.ts': '', 'nacos.ts': '', 'providers.ts': '', 'http.ts': '',
    'manager-state.ts': 'export function createManagerStateStore() { return { update() {} }; }',
    'install-operations.ts': 'export function createInstallOperations() { return { enqueue() {} }; } export const operationLimit = 32;',
    'client-operations.ts': 'export function createClientOperations(send) { return { request: send }; }',
    'api-errors.ts': `export function readApiFailure(payload) { return { code: payload.code, message: payload.error, outcome: payload.outcome }; }
      export function normalizeApiFailure(payload) { return { details: readApiFailure(payload) }; }
      export function failureDetails(payload) { return payload.details; }
      export function isConfirmedRejection(payload) { return payload.details.outcome === "rejected"; }
      export function decodeOperationOutcome(payload) { const details = readApiFailure(payload); return { details }; }`,
    'nacos-ui.ts': 'export function createNacosUI() { return {}; }',
    'nacos-detail.ts': '', 'nacos-styles.ts': '',
    'client.ts': `import { normalizeApiFailure } from "./api-errors.js";
      import { createClientOperations } from "./client-operations.js";
      import { createNacosUI } from "./nacos-ui.js";
      ${anchors[0]}
      const DICT = {};
      function projection(value) { return value.name; }
      ${anchors[1]}
      function parseApiResponse(response) { return response.json(); }
      function callApi(path) { return fetch(path).then(parseApiResponse); }
      ${anchors[2]}
      let localeService;
      const clientMutations = createClientOperations(callApi);
      const useRepositoryUI = createNacosUI({ Modal: Modal });
      ${anchors[3]}
      function Modal(props) { return props.children; }
      function SkillManagerView() { return clientMutations.request("/state"); }
      ${anchors[4]}
      export function apply() {}`,
    'bundle.js': `window.__ModuleLoader__.load({});\n${anchors.join('\n')}`,
  };
}

const inSection = (text, section, insertion) => text.replace(`/*! §${section + 1}`, `${insertion}\n/*! §${section + 1}`);

test('valid layer dependencies, injected view callbacks, normalized failures and core storage support are accepted', () => {
  assert.deepEqual(structuralProblems(fixture()), []);
});

for (const [title, file, insertion, expected, section] of [
  ['previously missed pure callApi invocation', 'client.ts', 'function pureAgain() { return callApi("/state"); }', /client layer §1.*§2 callApi/, 1],
  ['pure callApi alias chain', 'client.ts', 'function pureAgain() { const first = callApi; const second = first; return second("/state"); }', /client layer §1.*§2 callApi/, 1],
  ['pure callApi assignment alias', 'client.ts', 'function pureAgain() { let send; send = callApi; return send("/state"); }', /client layer §1.*§2 callApi/, 1],
  ['pure locale state dependency', 'client.ts', 'function pureAgain() { return localeService; }', /client layer §1.*§3 localeService/, 1],
  ['IO calls view', 'client.ts', 'function ioAgain() { return SkillManagerView(); }', /client layer §2.*§4 SkillManagerView/, 2],
  ['injected view may not execute during state assembly', 'client.ts', 'const eagerView = createNacosUI({ Modal: Modal() });', /client layer §3.*§4 Modal/, 3],
  ['pure mutation owner import', 'client.ts', 'const otherMutations = createClientOperations(callApi);', /client layer §1.*§3 createClientOperations/, 1],
  ['misplaced meaningful projection', 'client.ts', 'function normalizeSkillQuery(query) { return String(query); }', /symbol normalizeSkillQuery outside its section/, 3],
  ['misplaced client mutation owner', 'client.ts', 'const clientMutations = createClientOperations(callApi);', /symbol clientMutations outside its section/, 4],
  ['previously missed Nacos second decoder', 'nacos-ui.ts', 'function decodeAgain(error:any){return error.code||error.error}', /raw API failure read outside/],
  ['bracket failure fields', 'nacos-ui.ts', 'function readAgain(payload) { return payload["code"] || payload["error"]; }', /raw API failure read outside/],
  ['cast failure alias', 'nacos-ui.ts', 'function readAgain(payload) { const item = payload as any; const copy = item; return copy.code; }', /raw API failure read outside/],
  ['failure destructuring alias', 'nacos-ui.ts', 'function readAgain(payload) { const { code: other } = payload; return other; }', /raw API failure destructure outside/],
  ['caught arbitrary identifier', 'nacos-ui.ts', 'try {} catch (problem) { const alias = problem; alias.error; }', /raw API failure read outside/],
  ['catch callback arbitrary identifier', 'nacos-ui.ts', 'Promise.reject().catch(problem => problem.code);', /raw API failure read outside/],
  ['decoder arbitrary parameter identifier', 'nacos-ui.ts', 'function decodeFailureAgain(value) { return value.error; }', /raw API failure read outside/],
  ['failure outcome probe', 'nacos-ui.ts', 'function readAgain(error) { return "outcome" in error; }', /raw API failure probe outside/],
  ['status response raw failure', 'nacos-ui.ts', 'async function check() { const outcome = await api("/status"); return outcome.error; }', /raw API failure read outside/],
  ['decoder name spoof in a view', 'nacos-ui.ts', 'function readApiFailure(payload) { return payload.code; }', /raw API failure read outside/],
  ['second decoder in pure module', 'api-errors.ts', 'function decodeAgain(payload) { return payload.code; }', /raw API failure read outside/],
  ['outcome helper must delegate raw reads', 'api-errors.ts', 'function decodeOperationOutcomeAgain(payload) { return payload.error; }', /raw API failure read outside/],
  ['response bracket json', 'nacos-ui.ts', 'function readAgain(response) { return response["json"](); }', /error body reader outside adapter/],
  ['previously missed duplicate writable owner', 'nacos.ts', 'import {createInstallOperations} from "./install-operations.js"; const duplicate = createInstallOperations();', /factory createInstallOperations belongs to index.ts/],
  ['aliased owner factory', 'nacos.ts', 'import {createInstallOperations as make} from "./install-operations.js"; const duplicate = make();', /factory createInstallOperations belongs to index.ts/],
  ['namespace owner factory', 'nacos.ts', 'import * as support from "./install-operations.js"; const make = support.createInstallOperations; make();', /factory createInstallOperations belongs to index.ts/],
  ['namespace owner factory assignment alias', 'nacos.ts', 'import * as support from "./install-operations.js"; let make; make = support["createInstallOperations"]; make();', /factory createInstallOperations belongs to index.ts/],
  ['dynamic owner factory', 'nacos.ts', 'async function duplicate() { const support = await import("./install-operations.js"); support.createInstallOperations(); }', /factory createInstallOperations belongs to index.ts/],
  ['dynamic destructured owner factory', 'nacos.ts', 'async function duplicate() { const { createInstallOperations: make } = await import("./install-operations.js"); make(); }', /factory createInstallOperations belongs to index.ts/],
  ['owner factory reexport', 'nacos.ts', 'export {createInstallOperations as make} from "./install-operations.js";', /factory createInstallOperations belongs to index.ts/],
  ['owner factory wildcard reexport', 'nacos.ts', 'export * from "./install-operations.js";', /factory createInstallOperations belongs to index.ts/],
  ['storage factory wrong axis', 'nacos.ts', 'import {createManagerStateStore} from "./manager-state.js"; createManagerStateStore();', /factory createManagerStateStore belongs to core.ts/],
  ['storage factory repeated by core', 'core.ts', 'const otherState = createManagerStateStore();', /duplicate writable owner: createManagerStateStore/],
  ['entry cannot authorize a factory by name alone', 'index.ts', 'function createInstallOperations() { return new Map(); } export function apply() { const hidden = createInstallOperations(); }', /entry owns state/],
  ['cross axis dynamic import', 'nacos.ts', 'async function duplicate() { return import("./core.js"); }', /nacos.ts imports axis core.ts/],
  ['cross axis named reexport', 'nacos.ts', 'export {state} from "./core.js";', /nacos.ts imports axis core.ts/],
  ['cross axis wildcard reexport', 'nacos.ts', 'export * from "./core.js";', /nacos.ts imports axis core.ts/],
  ['cross axis mixed type and runtime import', 'nacos.ts', 'import {type View, state} from "./core.js";', /nacos.ts imports axis core.ts/],
  ['cross axis normalized relative path', 'nacos.ts', 'export * from "./support/../core.js";', /nacos.ts imports axis core.ts/],
  ['pure module imports state owner', 'api-errors.ts', 'import { createClientOperations } from "./client-operations.js";', /client module layer §1 depends on §3/],
  ['pure module dynamically imports view', 'api-errors.ts', 'const view = import("./nacos-ui.js");', /client module layer §1 depends on §4/],
  ['pure module reexports view', 'api-errors.ts', 'export * from "./nacos-ui.js";', /client module layer §1 depends on §4/],
]) test(`structural boundary rejects: ${title}`, () => {
  const candidate = fixture();
  candidate[file] = section ? inSection(candidate[file], section, insertion) : candidate[file] + '\n' + insertion;
  assert.ok(structuralProblems(candidate).some(problem => expected.test(problem)), `expected ${expected}`);
});

for (const [title, file, insertion, section] of [
  ['ordinary local data error display', 'nacos-ui.ts', 'function display(selection) { return selection.error; }'],
  ['normalized error details', 'nacos-ui.ts', 'function display(error) { return error.details.code + error.details.params; }'],
  ['normalized helper output', 'nacos-ui.ts', 'function display(payload) { const details = normalizeApiFailure(payload).details; return details.code; }'],
  ['normalized outcome details', 'api-errors.ts', 'function decodeAgain(payload) { const details = readApiFailure(payload); return details.code; }'],
  ['error code construction', 'nacos-ui.ts', 'function failure() { const error = new Error(); error.code = "error.proto.nonJson"; return error; }'],
  ['support pure helper import', 'nacos.ts', 'import { operationLimit } from "./install-operations.js";'],
  ['support namespace helper use', 'nacos.ts', 'import * as support from "./install-operations.js"; const limit = support.operationLimit;'],
  ['host entry instantiates its factory', 'index.ts', 'import { createInstallOperations } from "./install-operations.js"; export function apply() { const operations = createInstallOperations(); }'],
  ['cross axis type import', 'nacos.ts', 'import type {View} from "./core.js";'],
  ['cross axis inline type import', 'nacos.ts', 'import {type View} from "./core.js";'],
  ['cross axis type reexport', 'nacos.ts', 'export type {View} from "./core.js";'],
  ['cross axis inline type reexport', 'nacos.ts', 'export {type View} from "./core.js";'],
  ['cross axis import type query', 'nacos.ts', 'type View = typeof import("./core.js");'],
  ['callApi name shadowed by a parameter', 'client.ts', 'function project(callApi) { return callApi(); }', 1],
  ['factory name shadowed by a parameter', 'client.ts', 'function project(createClientOperations) { return createClientOperations(); }', 1],
  ['callApi name shadowed by a local function', 'client.ts', 'function project() { function callApi() { return 1; } return callApi(); }', 1],
  ['ordinary data code property', 'client.ts', 'function project(value) { return value.code; }', 1],
]) test(`structural boundary accepts: ${title}`, () => {
  const candidate = fixture();
  candidate[file] = section ? inSection(candidate[file], section, insertion) : candidate[file] + '\n' + insertion;
  assert.deepEqual(structuralProblems(candidate), []);
});

test('client traversal follows runtime reexports and dynamic imports', () => {
  for (const dependency of ['export * from "./extra-view.js";', 'const extra = import("./extra-view.js");']) {
    const candidate = fixture();
    candidate['nacos-ui.ts'] += '\n' + dependency;
    candidate['extra-view.ts'] = 'function decodeAgain(error) { return error.code; }';
    assert.ok(structuralProblems(candidate).some(problem => /extra-view.ts.*raw API failure read/.test(problem)));
  }
});

test('bundled Markdown only uses public Host React APIs', () => {
  assert.equal(/__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED|decode-named-character-reference\/index\.dom\.js/.test(files['bundle.js']), false);
});
