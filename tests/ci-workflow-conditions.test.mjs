import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');

// These names are also the individual check contexts used by branch protection.
const platforms = new Map([
  ['native-linux-x64', ['native keychain (linux-x64)', 'ubuntu-24.04', 'sqlite']],
  ['native-linux-arm64', ['native keychain (linux-arm64)', 'ubuntu-24.04-arm', 'sqlite']],
  ['native-win32-x64', ['native keychain (win32-x64)', 'windows-2022', 'sqlite']],
  ['native-win32-arm64', ['native keychain (win32-arm64)', 'windows-11-arm', 'sqlite']],
  ['native-linux-x64-next', ['native keychain (linux-x64, ubuntu-26.04)', 'ubuntu-26.04', 'sqlite']],
  ['native-win32-x64-next', ['native keychain (win32-x64, windows-2025)', 'windows-2025', 'sqlite']],
  ['document-macos-15', ['document backend (macos-15)', 'macos-15', 'sqlite']],
  ['document-macos-15-intel', ['document backend (macos-15-intel)', 'macos-15-intel', 'sqlite']],
  ['sensitive-scan', ['sensitive scan (win32-x64)', 'windows-2022', 'sensitive']],
  ['forge-iam-callback', ['iam callback (win32-x64)', 'windows-2022', 'callback']],
]);

const platformEnvironment = new Map([
  ['native-linux-x64', { NAME: 'linux-x64', PLATFORM: 'linux', ARCH: 'x64' }],
  ['native-linux-arm64', { NAME: 'linux-arm64', PLATFORM: 'linux', ARCH: 'arm64' }],
  ['native-win32-x64', { NAME: 'win32-x64', PLATFORM: 'win32', ARCH: 'x64' }],
  ['native-win32-arm64', { NAME: 'win32-arm64', PLATFORM: 'win32', ARCH: 'arm64' }],
  ['native-linux-x64-next', { NAME: 'linux-x64, ubuntu-26.04', PLATFORM: 'linux', ARCH: 'x64' }],
  ['native-win32-x64-next', { NAME: 'win32-x64, windows-2025', PLATFORM: 'win32', ARCH: 'x64' }],
  ['document-macos-15', { PLATFORM: 'darwin', ARCH: 'arm64' }],
  ['document-macos-15-intel', { PLATFORM: 'darwin', ARCH: 'x64' }],
]);

// Only the workflow's job-level mappings are needed here. Do not interpret
// nested keys, shell scripts or comments as jobs or YAML aliases.
function jobsOf(source) {
  const offset = source.search(/^jobs:[ \t]*$/mu);
  if (offset < 0) return new Map();
  const text = source.slice(offset);
  const headers = [...text.matchAll(/^  ([a-z][a-z0-9-]*):(?:[ \t]+&[\w-]+)?[ \t]*$/gmu)];
  return new Map(headers.map((header, index) => [
    header[1],
    text.slice(header.index, headers[index + 1]?.index ?? text.length),
  ]));
}

function field(job, key) {
  return new RegExp(`^    ${key}:[ \\t]*([^\\r\\n]*)$`, 'mu').exec(job ?? '')?.[1].trim();
}

function stepField(step, key) {
  return new RegExp(`^ {8}${key}:[ \\t]*([^\\r\\n]*)$`, 'mu').exec(step ?? '')?.[1].trim();
}

function jobEnvironment(job, key) {
  return valueWithoutQuotes(new RegExp(`^ {6}FORGE_CI_${key}:[ \\t]*([^\\r\\n]*)$`, 'mu').exec(job ?? '')?.[1].trim());
}

function expressionBody(value) {
  const condition = (value ?? '').trim();
  return condition.startsWith('${{') && condition.endsWith('}}') ? condition.slice(3, -2).trim() : condition;
}

function valueWithoutQuotes(value) {
  return value?.replace(/^(['"])(.*)\1$/u, '$2');
}

function needsChanges(job) {
  const needs = field(job, 'needs') ?? '';
  return needs.replace(/[\[\]'" ]/gu, '').split(',').includes('changes');
}

function resolveIf(source, job) {
  let condition = field(job, 'if') ?? '';
  if (condition.startsWith('*')) {
    const anchor = condition.slice(1);
    if (!/^[\w-]+$/u.test(anchor)) throw new Error('invalid condition alias');
    const definitions = [...source.matchAll(new RegExp(`^    if:[ \\t]*&${anchor}[ \\t]+([^\\r\\n]+)$`, 'gmu'))];
    if (definitions.length !== 1) throw new Error('condition alias is missing or ambiguous');
    condition = definitions[0][1].trim();
  }
  condition = condition.replace(/^&[\w-]+[ \t]+/u, '').trim();
  return expressionBody(condition);
}

function stepsOf(source, job) {
  const steps = field(job, 'steps');
  if (steps === undefined) return '';
  if (!steps.startsWith('*')) return job.slice(job.search(/^    steps:/mu));
  const anchor = steps.slice(1);
  if (!/^[\w-]+$/u.test(anchor)) return '';
  const definitions = [...jobsOf(source).values()].filter((candidate) => field(candidate, 'steps') === `&${anchor}`);
  return definitions.length === 1 ? definitions[0].slice(definitions[0].search(/^    steps:/mu)) : '';
}

function stepBlocks(steps) {
  const matches = [...steps.matchAll(/^      - (?:name|id):[^\r\n]*$/gmu)];
  return matches.map((match, index) => steps.slice(match.index, matches[index + 1]?.index ?? steps.length));
}

// Evaluate the small expression subset used by job conditions. Parsing rather
// than eval keeps the source as data, and makes each scenario test the actual
// Boolean expression, including its parentheses and operators.
function expressionValue(expression, scenario, { caseInsensitive = true } = {}) {
  const tokens = [];
  let remaining = expression.trim();
  while (remaining) {
    const space = /^\s+/u.exec(remaining);
    if (space) { remaining = remaining.slice(space[0].length); continue; }
    const token = /^(?:&&|\|\||!=|==|[!()]|'(?:''|[^'])*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_.]*)/u.exec(remaining);
    if (!token) throw new Error(`unsupported expression near ${remaining.slice(0, 30)}`);
    tokens.push(token[0]);
    remaining = remaining.slice(token[0].length);
  }
  let at = 0;
  const take = (token) => tokens[at] === token && (++at > 0);
  function primary() {
    if (take('!')) return !Boolean(primary());
    if (take('(')) {
      const value = or();
      if (!take(')')) throw new Error('missing closing parenthesis');
      return value;
    }
    const token = tokens[at++];
    if (token === undefined) throw new Error('missing expression operand');
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token.startsWith('"')) return token.slice(1, -1);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'needs.changes.result') return scenario.result;
    if (token === 'needs.changes.outputs.run_platforms') return scenario.output;
    if (token === 'github.event_name') return scenario.event;
    if (token === 'env.FORGE_CI_NAME') return scenario.name;
    if (['cancelled', 'always', 'success', 'failure'].includes(token)) {
      if (!take('(') || !take(')')) throw new Error(`invalid status function ${token}`);
      if (token === 'cancelled') return scenario.cancelled;
      if (token === 'always') return true;
      if (token === 'success') return scenario.result === 'success';
      return scenario.result === 'failure';
    }
    throw new Error(`unsupported expression operand ${token}`);
  }
  function equality() {
    let value = primary();
    const equal = (left, right) => caseInsensitive && typeof left === 'string' && typeof right === 'string'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
    if (take('==')) value = equal(value, primary());
    else if (take('!=')) value = !equal(value, primary());
    return value;
  }
  function and() {
    let value = equality();
    while (take('&&')) { const right = equality(); value = Boolean(value) && Boolean(right); }
    return value;
  }
  function or() {
    let value = and();
    while (take('||')) { const right = and(); value = Boolean(value) || Boolean(right); }
    return value;
  }
  const value = or();
  if (at !== tokens.length) throw new Error(`unexpected expression token ${tokens[at]}`);
  return Boolean(value);
}

function runsAfterNeeds(condition, scenario) {
  // GitHub implicitly adds success() when there is no status function.
  if (!/\b(?:always|cancelled|success|failure)\s*\(/u.test(condition) && scenario.result !== 'success') return false;
  return expressionValue(condition, scenario);
}

function shellGuardProblems(step) {
  const errors = [];
  const resultVar = /^ {10}([A-Z_][A-Z0-9_]*):[ \t]*\$\{\{\s*needs\.changes\.result\s*\}\}[ \t]*$/mu.exec(step)?.[1];
  const outputVar = /^ {10}([A-Z_][A-Z0-9_]*):[ \t]*\$\{\{\s*needs\.changes\.outputs\.run_platforms\s*\}\}[ \t]*$/mu.exec(step)?.[1];
  if (!resultVar || !outputVar) return ['verify: classification guard must receive result and output from needs'];
  if (/^ {8}if:/mu.test(step)) errors.push('verify: classification guard step must not be conditionally skipped');
  const script = /^ {8}run:[ \t]*\|[ \t]*\n((?: {10}[^\n]*\n|[ \t]*\n)*)/mu.exec(step)?.[1] ?? '';
  const branch = /^\s*if\s+([^\n]+);\s*then\s*\n([\s\S]*?)^\s*fi\s*$/mu.exec(script);
  if (!branch || branch[0].trim() !== script.trim() || !/^\s*exit\s+1\s*$/mu.test(branch[2])
    || /^\s*(?:if|case|else|elif|exit\s+0|return)\b/mu.test(branch[2])) {
    return [...errors, 'verify: classification guard must exit 1 on the invalid branch'];
  }
  const condition = branch[1]
    .replaceAll(`"$${resultVar}"`, 'needs.changes.result')
    .replaceAll(`"$${outputVar}"`, 'needs.changes.outputs.run_platforms')
    .replaceAll('[[', '(').replaceAll(']]', ')');
  const cases = [
    ['success', 'true', false], ['success', 'false', false],
    ['success', '', true], ['success', 'invalid', true], ['success', 'FALSE', true], ['success', 'True', true],
    ['failure', 'true', true], ['failure', 'false', true], ['', 'false', true],
    ['skipped', '', true], ['cancelled', '', true],
  ];
  try {
    for (const [result, output, rejected] of cases) {
      if (expressionValue(condition, { result, output, cancelled: false }, { caseInsensitive: false }) !== rejected) {
        errors.push(`verify: classification guard is unsafe for ${result}/${output || '(empty)'}`);
      }
    }
  } catch (error) {
    errors.push(`verify: cannot interpret classification guard: ${error.message}`);
  }
  return errors;
}

function changesGuardProblems(steps, classifier, full, outputExpression) {
  const errors = [];
  const guard = steps.find((step) => /^ {10}[A-Z_][A-Z0-9_]*:[ \t]*\$\{\{\s*steps\.[^\n]+\|\|\s*steps\./mu.test(step)
    && /^\s*case\s+/mu.test(step));
  if (!guard) return ['changes: missing platform output validation'];
  if (steps.indexOf(guard) <= Math.max(steps.indexOf(classifier), steps.indexOf(full)) || /^ {8}if:/mu.test(guard)) {
    errors.push('changes: platform output validation must follow both paths unconditionally');
  }
  const env = /^ {10}([A-Z_][A-Z0-9_]*):[ \t]*(\$\{\{[^\n]+\}\})[ \t]*$/mu.exec(guard);
  if (!env || env[2].replaceAll(/\s+/gu, '') !== outputExpression.replaceAll(/\s+/gu, '')) {
    return [...errors, 'changes: platform output validation must inspect the final output'];
  }
  const script = /^ {8}run:[ \t]*\|[ \t]*\n((?: {10}[^\n]*\n|[ \t]*\n)*)/mu.exec(guard)?.[1] ?? '';
  const caseMatch = new RegExp(`^\\s*case\\s+["']?\\$${env[1]}["']?\\s+in\\s*\\n([\\s\\S]*?)^\\s*esac\\s*$`, 'mu').exec(script);
  const caseBlock = caseMatch?.[1] ?? '';
  const arms = [...caseBlock.matchAll(/(?:^|\s)([^\s()]+)\s*\)\s*([\s\S]*?);;/gu)];
  const accepted = arms.filter((arm) => arm[1] !== '*');
  const fallback = arms.find((arm) => arm[1] === '*');
  const acceptedValues = accepted.flatMap((arm) => arm[1].split('|')).sort();
  const commands = fallback?.[2].split(/[;\n]/u).map((part) => part.trim()).filter(Boolean) ?? [];
  if (!caseMatch || caseMatch[0].trim() !== script.trim() || arms.length !== accepted.length + 1 || arms.at(-1) !== fallback
    || acceptedValues.join(',') !== 'false,true'
    || accepted.some((arm) => !/^\s*:?\s*$/u.test(arm[2]))
    || commands.at(-1) !== 'exit 1' || commands.slice(0, -1).some((command) => !/^(?:echo|printf)\b/u.test(command))) {
    errors.push('changes: platform output validation must accept only exact true/false and exit 1 otherwise');
  }
  return errors;
}

export function workflowProblems(source) {
  const errors = [];
  const jobs = jobsOf(source);
  const events = /^on:[ \t]*\n([\s\S]*?)(?=^[^\s#]|$(?![\s\S]))/mu.exec(source)?.[1] ?? '';
  for (const event of ['push', 'pull_request', 'merge_group', 'workflow_dispatch']) {
    if (!new RegExp(`^  ${event}:`, 'mu').test(events)) errors.push(`trigger: missing ${event}`);
  }
  if (!/^  merge_group:[\s\S]*?^    types:\s*\[[^\]]*\bchecks_requested\b/mu.test(events)) {
    errors.push('trigger: merge_group must request checks');
  }
  if (/^\s+paths(?:-ignore)?:/mu.test(events)) errors.push('trigger: workflow must not use path filters');

  const changes = jobs.get('changes');
  if (!changes) errors.push('changes: missing classification job');
  else {
    if (field(changes, 'if') !== undefined) errors.push('changes: classification job must run on every event');
    const output = /^ {6}run_platforms:[ \t]*\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.run_platforms\s*\|\|\s*steps\.([A-Za-z0-9_-]+)\.outputs\.run_platforms\s*\}\}[ \t]*$/mu.exec(changes);
    const steps = stepBlocks(stepsOf(source, changes));
    const classifier = steps.find((candidate) => output && stepField(candidate, 'id') === output[1]);
    const full = steps.find((candidate) => output && stepField(candidate, 'id') === output[2]);
    if (!output || !classifier || !full || classifier === full) {
      errors.push('changes: output must combine the classifier and non-PR full paths');
    } else {
      errors.push(...changesGuardProblems(steps, classifier, full, output[0].split(/:[ \t]*/u).slice(1).join(':')));
      if (!/^ {8}run:[ \t]*node\s+scripts\/ci-classify-changes\.mjs[ \t]*$/mu.test(classifier)) {
        errors.push('changes: PR path must run the classifier');
      }
      if (!/^ {8}run:[ \t]*echo[ \t]+['"]run_platforms=true['"][ \t]*>>[ \t]*"\$GITHUB_OUTPUT"[ \t]*$/mu.test(full)) {
        errors.push('changes: non-PR full output must be true');
      }
      try {
        for (const event of ['pull_request', 'push', 'merge_group', 'workflow_dispatch']) {
          const scenario = { event, result: 'success', output: '', cancelled: false };
          const classifyRuns = expressionValue(expressionBody(stepField(classifier, 'if')), scenario);
          const fullRuns = expressionValue(expressionBody(stepField(full, 'if')), scenario);
          if (classifyRuns !== (event === 'pull_request') || fullRuns !== (event !== 'pull_request')) {
            errors.push(`changes: incorrect classification path for ${event}`);
          }
        }
      } catch (error) { errors.push(`changes: invalid event conditions: ${error.message}`); }
    }
  }

  const verify = jobs.get('verify');
  if (!verify) errors.push('verify: missing required job');
  else {
    if (valueWithoutQuotes(field(verify, 'name')) !== 'verify (ubuntu-x64)') errors.push('verify: required display name changed');
    if (!needsChanges(verify)) errors.push('verify: must depend on changes');
    try {
      const condition = resolveIf(source, verify);
      for (const result of ['success', 'failure', 'skipped', 'cancelled', '']) {
        for (const output of ['true', 'false', '']) {
          if (!runsAfterNeeds(condition, { result, output, cancelled: false })) {
            errors.push(`verify: must run after changes ${result}/${output || '(empty)'}`);
          }
        }
      }
      if (runsAfterNeeds(condition, { result: 'success', output: 'true', cancelled: true })) errors.push('verify: must honor workflow cancellation');
    } catch (error) { errors.push(`verify: unsafe job condition: ${error.message}`); }
    const steps = stepBlocks(stepsOf(source, verify));
    const guard = steps.findIndex((step) => step.includes('needs.changes.result') && step.includes('needs.changes.outputs.run_platforms'));
    if (guard < 0) errors.push('verify: missing classification guard');
    else errors.push(...shellGuardProblems(steps[guard]));
    const fullCheck = steps.findIndex((step) => /^ {8}run:[ \t]*node[ \t]+--run[ \t]+check[ \t]*$/mu.test(step));
    if (fullCheck < 0 || /^ {8}if:/mu.test(steps[fullCheck] ?? '') || guard < 0 || fullCheck <= guard) {
      errors.push('verify: full check must run unconditionally after a valid classification');
    }
  }

  // The changes job rejects every other spelling before it can report success.
  // GitHub string equality is case-insensitive, unlike the shell case guard.
  const cases = [
    ['success', 'false', false], ['success', 'true', true],
    ['success', '', true], ['success', 'invalid', true],
    ['failure', 'false', true], ['failure', 'true', true], ['failure', 'FALSE', true], ['failure', 'True', true], ['', 'false', true],
    ['skipped', '', true], ['cancelled', '', true],
  ];
  for (const [id, [name, runner, kind]] of platforms) {
    const job = jobs.get(id);
    if (!job) { errors.push(`${id}: missing platform job`); continue; }
    if (valueWithoutQuotes(field(job, 'name')) !== name) errors.push(`${id}: display name changed`);
    if (valueWithoutQuotes(field(job, 'runs-on')) !== runner) errors.push(`${id}: runner changed`);
    for (const [key, expected] of Object.entries(platformEnvironment.get(id) ?? {})) {
      if (jobEnvironment(job, key) !== expected) errors.push(`${id}: FORGE_CI_${key} must match the runner`);
    }
    if (!needsChanges(job)) errors.push(`${id}: must depend on changes`);
    try {
      const condition = resolveIf(source, job);
      for (const [result, output, expected] of cases) {
        if (runsAfterNeeds(condition, { result, output, cancelled: false }) !== expected) {
          errors.push(`${id}: unsafe condition for ${result}/${output || '(empty)'}`);
        }
      }
      if (runsAfterNeeds(condition, { result: 'success', output: 'true', cancelled: true })) errors.push(`${id}: must honor workflow cancellation`);
    } catch (error) { errors.push(`${id}: unsafe job condition: ${error.message}`); }
    const steps = stepsOf(source, job);
    const required = {
      sqlite: 'node --test packages/forge-credentials-keychain/test/*.test.mjs',
      sensitive: 'node --test tests/sensitive-scan.test.mjs',
      callback: 'node --test packages/forge-iam/test/callback-port.test.mjs',
    }[kind];
    const blocks = stepBlocks(steps);
    const tests = blocks.filter((step) => step.includes(required));
    if (tests.length !== 1 || stepField(tests[0], 'if') !== undefined) errors.push(`${id}: platform tests must run unconditionally`);
    if (kind === 'sqlite' && !steps.includes('packages/forge-iam/test/read-paths-matrix.test.mjs')) errors.push(`${id}: IAM read paths must be covered`);
    if (kind === 'sqlite') {
      const install = blocks.filter((step) => step.startsWith('      - name: Install the artifact offline\n'));
      if (install.length !== 1 || stepField(install[0], 'if') !== undefined || !install[0].includes('node scripts/probe/installed-credential-smoke.mjs')) errors.push(`${id}: installed SQLite smoke must run unconditionally`);
    }

  }
  return errors;
}

function replaceJob(source, id, transform) {
  const job = jobsOf(source).get(id);
  assert.ok(job, `mutation requires job ${id}`);
  const changed = transform(job);
  assert.notEqual(changed, job, `mutation did not change job ${id}`);
  return source.replace(job, changed);
}

test('workflow preserves every required context and fails closed when classification is uncertain', () => {
  assert.deepEqual(workflowProblems(workflow), []);
});

test('GitHub condition comparisons and shell guards use their actual case rules', () => {
  assert.equal(expressionValue("'FALSE' == 'false'", {}), true);
  assert.equal(expressionValue("'FALSE' == 'false'", {}, { caseInsensitive: false }), false);
});

test('workflow guards reject deleted gates, inverted conditions and missing classification', () => {
  assert.deepEqual(workflowProblems(workflow), []);
  const mutants = [
    ['classification job', workflow.replace(/^  changes:/mu, '  changed:'), /changes: missing classification job/u],
    ['classification output', replaceJob(workflow, 'changes', (job) => job.replace('steps.full.outputs.run_platforms', 'steps.full.outputs.missing')), /changes: output must combine/u],
    ['fallback branch', replaceJob(workflow, 'changes', (job) => job.replace("if: github.event_name != 'pull_request'", "if: github.event_name == 'pull_request'")), /changes: incorrect classification path/u],
    ['fallback output', replaceJob(workflow, 'changes', (job) => job.replace('run_platforms=true', 'run_platforms=false')), /changes: non-PR full output must be true/u],
    ['case-sensitive validation', replaceJob(workflow, 'changes', (job) => job.replace('true|false) ;;', 'true|false|FALSE) ;;')), /changes: platform output validation must accept only/u],
    ['case wildcard bypass', replaceJob(workflow, 'changes', (job) => job.replace('            true|false) ;;', '            F*) ;;\n            true|false) ;;')), /changes: platform output validation must accept only/u],
    ['case validation exit', replaceJob(workflow, 'changes', (job) => job.replace('exit 1 ;;', 'echo ignored ;;')), /changes: platform output validation must accept only/u],
    ['platform dependency', replaceJob(workflow, 'native-win32-x64', (job) => job.replace(/^    needs:.*\n/mu, '')), /native-win32-x64: must depend/u],
    ['platform condition', replaceJob(workflow, 'native-win32-x64', (job) => job.replace(/^    if:.*$/mu, "    if: ${{ !cancelled() && needs.changes.outputs.run_platforms == 'false' }}")), /native-win32-x64: unsafe condition/u],
    ['platform OS', replaceJob(workflow, 'native-linux-arm64', (job) => job.replace('FORGE_CI_PLATFORM: linux', 'FORGE_CI_PLATFORM: darwin')), /native-linux-arm64: FORGE_CI_PLATFORM/u],
    ['platform arch', replaceJob(workflow, 'native-linux-arm64', (job) => job.replace('FORGE_CI_ARCH: arm64', 'FORGE_CI_ARCH: x64')), /native-linux-arm64: FORGE_CI_ARCH/u],
    ['platform name', replaceJob(workflow, 'native-linux-arm64', (job) => job.replace('FORGE_CI_NAME: linux-arm64', 'FORGE_CI_NAME: linux-x64')), /native-linux-arm64: FORGE_CI_NAME/u],
    ['document arch', replaceJob(workflow, 'document-macos-15-intel', (job) => job.replace('FORGE_CI_ARCH: x64', 'FORGE_CI_ARCH: arm64')), /document-macos-15-intel: FORGE_CI_ARCH/u],
    ['installed SQLite smoke removed', replaceJob(workflow, 'native-linux-x64', (job) => job.replace('node scripts/probe/installed-credential-smoke.mjs', 'node missing.mjs')), /native-linux-x64: installed SQLite smoke must run unconditionally/u],
    ['sqlite tests skipped', replaceJob(workflow, 'native-linux-x64', (job) => job.replace('      - name: Run credential backend tests\n', '      - name: Run credential backend tests\n        if: ${{ false }}\n')), /native-linux-x64: platform tests must run unconditionally/u],
    ['Windows scan skipped', replaceJob(workflow, 'sensitive-scan', (job) => job.replace('      - name: Run portable sensitive-scan tests\n', '      - name: Run portable sensitive-scan tests\n        if: ${{ false }}\n')), /sensitive-scan: platform tests must run unconditionally/u],
    ['Windows callback skipped', replaceJob(workflow, 'forge-iam-callback', (job) => job.replace('      - name: Run loopback callback tests\n', '      - name: Run loopback callback tests\n        if: ${{ false }}\n')), /forge-iam-callback: platform tests must run unconditionally/u],
    ['verify skipped on failure', replaceJob(workflow, 'verify', (job) => job.replace(/^    if:.*$/mu, "    if: ${{ !cancelled() && needs.changes.result == 'success' }}")), /verify: must run after changes failure/u],
    ['verify guard exit', replaceJob(workflow, 'verify', (job) => job.replace(/^([ \t]+)exit 1$/mu, '$1echo skipped')), /verify: classification guard must exit 1/u],
    ['verify guard inversion', replaceJob(workflow, 'verify', (job) => job.replace('"$CLASSIFICATION_RESULT" !=', '"$CLASSIFICATION_RESULT" ==')), /verify: classification guard is unsafe/u],
    ['full verify', replaceJob(workflow, 'verify', (job) => job.replace('run: node --run check', 'run: node scripts/check-docs.mjs')), /verify: full check/u],
    ['workflow path filter', workflow.replace(/^  pull_request:$/mu, '  pull_request:\n    paths-ignore: ["docs/**"]'), /trigger: workflow must not use path filters/u],
    ['merge queue trigger', workflow.replace('types: [checks_requested]', 'types: [other]'), /trigger: merge_group must request checks/u],
    ['manual trigger', workflow.replace(/^  workflow_dispatch:$/mu, '  ignored_dispatch:'), /trigger: missing workflow_dispatch/u],
  ];
  for (const [label, mutated, expected] of mutants) {
    assert.notEqual(mutated, workflow, `${label} mutation must change the source`);
    assert.match(workflowProblems(mutated).join('\n'), expected, `${label} mutation must be detected`);
  }
});
