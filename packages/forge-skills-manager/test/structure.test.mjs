import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { structuralProblems } from '../scripts/structure.mjs';

const files = Object.fromEntries(await Promise.all(['index', 'core', 'installations', 'nacos', 'providers', 'http', 'client', 'nacos-ui', 'nacos-detail', 'nacos-styles'].map(async name => [name + '.ts', await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')])));
files['bundle.js'] = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

test('plugin structure: thin assembly, injected axes, one client bundle and owned symbols', async () => {
  assert.deepEqual(structuralProblems(files), []);
  assert.deepEqual((await readdir(new URL('../locale/', import.meta.url))).sort(), ['en.json', 'zh.json']);
  assert.doesNotMatch(files['index.ts'], /tools\.register|create_skill/);
});

for (const [title, file, mutate] of [
  ['entry state', 'index.ts', text => text + '\nlet cache = new Map();'],
  ['axis import', 'providers.ts', text => text + '\nimport { state } from "./core.js";'],
  ['axis parser shortcut', 'nacos.ts', text => text + '\nimport { parseSkillDoc } from "./core.js";'],
  ['missing anchors', 'client.ts', text => text.replace('§3', 'section-three')],
  ['missing bundle anchors', 'bundle.js', text => text.replace('§3', 'section-three')],
  ['misplaced owned symbol', 'client.ts', text => text.replace('var localeService:', 'var moved:') + '\nlet localeService: unknown;'],
  ['bypassed IO adapter', 'client.ts', text => text + '\nfunction bypass() { return fetch("/private"); }'],
  ['second error body reader', 'client.ts', text => text + '\nfunction bypass(response: Response) { return response.json(); }'],
  ['client persistence', 'client.ts', text => text + '\nlocalStorage.setItem("skills", "enabled");'],
  ['second bundle', 'bundle.js', text => text + '\nwindow.__ModuleLoader__.load({});'],
  ['public discovery', 'nacos-ui.ts', text => text + '\nconst endpoint = "https://skills.sh";'],
  ['second detail network owner', 'nacos-detail.ts', text => text + '\nfetch("/private");'],
  ['detail persistence', 'nacos-detail.ts', text => text + '\nlocalStorage.setItem("skill", "enabled");'],
  ['external Markdown dependency', 'bundle.js', text => text + '\nrequire("react-markdown");'],
  ['private React internals', 'bundle.js', text => text + '\nReact.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;'],
]) test(`structure guard rejects mutation: ${title}`, () => {
  assert.ok(structuralProblems({ ...files, [file]: mutate(files[file]) }).length > 0);
});

test('bundled Markdown only uses public Host React APIs', () => {
  assert.equal(/__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED|decode-named-character-reference\/index\.dom\.js/.test(files['bundle.js']), false);
});
