import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
const macosWorkflow = readFileSync(new URL('../.github/workflows/check-macos.yml', import.meta.url), 'utf8');

// Keep each platform check context explicit so branch protection can match it.
const platforms = new Map([
  ['native-linux-x64', ['SQLite and IAM (linux-x64, ubuntu-24.04)', 'ubuntu-24.04', 'sqlite']],
  ['native-linux-arm64', ['SQLite and IAM (linux-arm64, ubuntu-24.04-arm)', 'ubuntu-24.04-arm', 'sqlite']],
  ['native-win32-x64', ['SQLite and IAM (win32-x64, windows-2025)', 'ubuntu-24.04', 'windows-aggregate']],
  ['native-win32-x64-credentials', ['SQLite credentials (win32-x64, windows-2025)', 'windows-2025', 'credentials']],
  ['native-win32-x64-iam', ['IAM (win32-x64, windows-2025)', 'windows-2025', 'iam']],
  ['native-win32-arm64', ['SQLite and IAM (win32-arm64, windows-11-arm)', 'windows-11-arm', 'sqlite']],
  ['native-linux-x64-next', ['SQLite and IAM (linux-x64, ubuntu-26.04)', 'ubuntu-26.04', 'sqlite']],
  ['document-macos-15', ['SQLite and IAM (darwin-arm64, macos-15)', 'macos-15', 'sqlite', '2']],
  ['sensitive-scan', ['sensitive scan and IAM callback (win32-x64)', 'windows-2025', 'sensitive']],
]);

const windowsTestPaths = [
  'tests/sensitive-scan.test.mjs',
  'tests/sensitive-scan-team.test.mjs',
  'tests/sensitive-scan-full-distribution.test.mjs',
  'tests/sensitive-scan-parent-tree.test.mjs',
  'tests/sensitive-scan-legacy-install.test.mjs',
  'tests/sensitive-scan-managed-upgrade.test.mjs',
  'tests/sensitive-scan-windows-paths.test.mjs',
  'tests/sensitive-scan-post-rewrite.test.mjs',
  'tests/sensitive-scan-server-merge.test.mjs',
  'tests/sensitive-scan-pre-push.test.mjs',
  'tests/plugin-patch-layers.test.mjs',
  'packages/forge-iam/test/callback-port.test.mjs',
];

const iamReadTestPaths = [
  'packages/forge-iam/test/read-paths-matrix.test.mjs',
  'packages/forge-iam/test/cli-session.test.mjs',
  'packages/forge-iam/test/bridge-real-provider.test.mjs',
  'packages/forge-iam/test/cli-reader.test.mjs',
  'packages/forge-iam/test/gateway-save-confirmation.test.mjs',
  'packages/forge-iam/test/gateway-sqlite-regression.test.mjs',
  'packages/forge-iam/test/session-read-lock-recovery.test.mjs',
  'packages/forge-iam/test/pending-binding-sqlite.test.mjs',
  'packages/forge-iam/test/session-renewal-log.test.mjs',
  'packages/forge-iam/test/renewal-resume.test.mjs',
  'packages/forge-iam/test/client-auth-refresh.test.mjs',
  'packages/forge-iam/test/callback-port.test.mjs',
  'packages/forge-iam/test/signout-sqlite-crash.test.mjs',
  'packages/forge-iam/test/userinfo.test.mjs',
];

const platformEnvironment = new Map([
  ['native-linux-x64', { PLATFORM: 'linux', ARCH: 'x64' }],
  ['native-linux-arm64', { PLATFORM: 'linux', ARCH: 'arm64' }],
  ['native-win32-x64-credentials', { PLATFORM: 'win32', ARCH: 'x64', SUITE: 'credentials' }],
  ['native-win32-x64-iam', { PLATFORM: 'win32', ARCH: 'x64', SUITE: 'iam' }],
  ['native-win32-arm64', { PLATFORM: 'win32', ARCH: 'arm64' }],
  ['native-linux-x64-next', { PLATFORM: 'linux', ARCH: 'x64' }],
  ['document-macos-15', { PLATFORM: 'darwin', ARCH: 'arm64' }],
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

function dependencies(job) {
  const needs = field(job, 'needs') ?? '';
  return needs.replace(/[\[\]'" ]/gu, '').split(',').filter(Boolean);
}

function needsChanges(job) {
  return dependencies(job).includes('changes');
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

function directNodeTest(step, requiredPaths, allowedPath) {
  const args = (stepField(step, 'run') ?? '').split(/\s+/u);
  const paths = args.slice(2);
  return args[0] === 'node' && args[1] === '--test'
    && paths.every((path) => allowedPath.test(path))
    && requiredPaths.every((path) => paths.includes(path));
}

function unconditionalStep(step) {
  return stepField(step, 'if') === undefined && stepField(step, 'continue-on-error') === undefined;
}

function installedSmoke(step) {
  const script = /^ {8}run:[ \t]*\|[ \t]*\n((?: {10}[^\n]*\n|[ \t]*\n)*)/mu.exec(step)?.[1];
  if (!script) return false;
  const lines = script.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const smoke = 'node scripts/probe/installed-credential-smoke.mjs "$PACKAGE"';
  return lines[0] === 'set -euo pipefail' && lines.at(-1) === smoke
    && lines.filter((line) => line === smoke).length === 1
    && !lines.slice(0, -1).some((line) => /^(?:exit|return|exec)(?:\s|;|$)/u.test(line));
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
    if (token === 'needs.changes.outputs.run_macos') return scenario.macos;
    if (token === 'github.event_name') return scenario.event;
    if (token === 'github.repository') return scenario.repository;
    if (token === 'github.event.pull_request.head.repo.full_name') return scenario.headRepo;
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

// Pull requests are accepted only from branches inside this repository: the review,
// re-sign and forced-replay flow assumes a branch that branch protection and the
// commit hooks control. The condition must keep same-repository pull requests and
// every non-PR event on the normal path.
function forkGuardProblems(steps) {
  // Step names share the line with the list dash, so match the block prefix.
  const step = steps.find((candidate) => candidate.startsWith('      - name: Reject fork pull requests\n'));
  if (!step) return ['verify: missing fork pull request rejection'];
  const errors = [];
  if (stepField(step, 'continue-on-error') !== undefined) errors.push('verify: fork rejection must not tolerate failure');
  const checkout = steps.findIndex((candidate) => stepField(candidate, 'uses')?.startsWith('actions/checkout@'));
  const index = steps.indexOf(step);
  if (index !== 0 || checkout < 0 || index >= checkout) {
    errors.push('verify: fork rejection must precede the checkout');
  }
  const script = /^ {8}run:[ \t]*\|[ \t]*\n((?: {10}[^\n]*\n|[ \t]*\n)*)/mu.exec(step)?.[1] ?? '';
  const lines = script.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (lines.at(-1) !== 'exit 1' || !lines.slice(0, -1).every((line) => /^(?:echo|printf)\b/u.test(line))) {
    errors.push('verify: fork rejection must explain the reason and exit 1');
  }
  if (!/CONTRIBUTING\.md#/u.test(script)) errors.push('verify: fork rejection must point at the contribution guide');
  try {
    const condition = expressionBody(stepField(step, 'if'));
    const scenarios = [
      ['pull_request', 'other/fork', true],
      // A deleted or moved fork head has no repo, and must stay on the rejection side.
      ['pull_request', undefined, true],
      ['pull_request', 'owner/repo', false],
      ['push', undefined, false],
      ['merge_group', undefined, false],
      ['workflow_dispatch', undefined, false],
    ];
    for (const [event, headRepo, expected] of scenarios) {
      const actual = expressionValue(condition, { event, headRepo, repository: 'owner/repo', result: 'success', output: 'true', cancelled: false });
      if (actual !== expected) errors.push(`verify: fork rejection is wrong for ${event}/${headRepo ?? '(no head)'}`);
    }
  } catch (error) { errors.push(`verify: cannot interpret the fork rejection condition: ${error.message}`); }
  return errors;
}

export function workflowProblems(source, { optionalMacOS = false } = {}) {
  const errors = [];
  const jobs = jobsOf(source);
  const events = /^on:[ \t]*\n([\s\S]*?)(?=^[^\s#]|$(?![\s\S]))/mu.exec(source)?.[1] ?? '';
  const requiredEvents = ['push', 'merge_group', 'workflow_dispatch', optionalMacOS ? 'workflow_call' : 'pull_request'];
  for (const event of requiredEvents) {
    if (!new RegExp(`^  ${event}:`, 'mu').test(events)) errors.push(`trigger: missing ${event}`);
  }
  if (!/^  push:\n    branches: \[main\]$/mu.test(events)) errors.push('trigger: push must target main');
  if (!/^  merge_group:[\s\S]*?^    types:\s*\[[^\]]*\bchecks_requested\b/mu.test(events)) {
    errors.push('trigger: merge_group must request checks');
  }
  if (/^\s+paths(?:-ignore)?:/mu.test(events)) errors.push('trigger: workflow must not use path filters');
  if (optionalMacOS && /^  pull_request:/mu.test(events)) {
    errors.push('trigger: macOS pull request runs must come through the shared classifier');
  }

  const changes = jobs.get('changes');
  if (optionalMacOS) {
    if (changes) errors.push('changes: optional macOS must not repeat classification');
  } else if (!changes) errors.push('changes: missing classification job');
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
      if (!full.includes("echo 'run_platforms=true' >> \"$GITHUB_OUTPUT\"")) {
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
  if (optionalMacOS) {
    if (verify) errors.push('verify: must run in repository checks');
  } else if (!verify) errors.push('verify: missing required job');
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
    const shards = jobs.get('verify-shards');
    const shardSteps = stepBlocks(stepsOf(source, shards));
    const result = steps.find((step) => stepField(step, 'run') === 'test "$SHARDS_RESULT" = success');
    if (!dependencies(verify).includes('verify-shards') || !result || !unconditionalStep(result)
      || !result.includes('SHARDS_RESULT: $' + '{{ needs.verify-shards.result }}')) {
      errors.push('verify: all shards must succeed');
    }
    const staticCheck = shardSteps.find((step) => stepField(step, 'run') === 'node --run check:static');
    const link = shardSteps.find((step) => stepField(step, 'run') === 'node scripts/link-workspace.mjs');
    const testStep = shardSteps.find((step) => stepField(step, 'run') === 'node --run test:unit -- --test-shard=$' + '{{ matrix.shard }}/2');
    if (!shards || dependencies(shards).length !== 0 || field(shards, 'if') !== undefined
      || field(shards, 'continue-on-error') !== undefined || field(shards, 'runs-on') !== 'ubuntu-24.04'
      || !/^ {8}shard: \[1, 2\]$/mu.test(shards) || !staticCheck || stepField(staticCheck, 'if') !== 'matrix.shard == 2'
      || stepField(staticCheck, 'continue-on-error') !== undefined || !link || stepField(link, 'if') !== 'matrix.shard == 1'
      || !testStep || !unconditionalStep(testStep) || shardSteps.indexOf(testStep) <= Math.max(shardSteps.indexOf(staticCheck), shardSteps.indexOf(link))) {
      errors.push('verify: full check must run in two independent shards');
    }
    errors.push(...forkGuardProblems(shardSteps));
  }

  // The changes job rejects every other spelling before it can report success.
  // GitHub string equality is case-insensitive, unlike the shell case guard.
  const cases = [
    ['success', 'false', false], ['success', 'true', true],
    ['success', '', true], ['success', 'invalid', true],
    ['failure', 'false', true], ['failure', 'true', true], ['failure', 'FALSE', true], ['failure', 'True', true], ['', 'false', true],
    ['skipped', '', true], ['cancelled', '', true],
  ];
  for (const [id, [name, runner, kind, macosTimeout]] of platforms) {
    const job = jobs.get(id);
    if ((macosTimeout !== undefined) !== optionalMacOS) {
      if (job) errors.push(`${id}: platform job is in the wrong workflow`);
      continue;
    }
    if (!job) { errors.push(`${id}: missing platform job`); continue; }
    if (valueWithoutQuotes(field(job, 'name')) !== name) errors.push(`${id}: display name changed`);
    if (valueWithoutQuotes(field(job, 'runs-on')) !== runner) errors.push(`${id}: runner changed`);
    const continueOnError = field(job, 'continue-on-error');
    if (optionalMacOS) {
      if (continueOnError !== 'true') errors.push(`${id}: macOS job must allow failure`);
      if (field(job, 'timeout-minutes') !== macosTimeout) errors.push(`${id}: macOS execution timeout changed`);
    } else if (continueOnError !== undefined && continueOnError !== 'false') {
      errors.push(`${id}: only macOS jobs may allow failure`);
    }
    for (const [key, expected] of Object.entries(platformEnvironment.get(id) ?? {})) {
      if (jobEnvironment(job, key) !== expected) errors.push(`${id}: FORGE_CI_${key} must match the runner`);
    }
    if (jobEnvironment(job, 'SUITE') !== platformEnvironment.get(id)?.SUITE) errors.push(`${id}: unexpected suite`);
    if (optionalMacOS) {
      if (dependencies(job).length || field(job, 'if') !== undefined) errors.push(`${id}: optional job uses workflow path filters`);
    } else if (id === 'native-win32-arm64') {
      if (dependencies(job).length) errors.push(`${id}: must run independently of classification`);
      try {
        const condition = resolveIf(source, job);
        for (const event of ['pull_request', 'push', 'merge_group', 'workflow_dispatch']) {
          const scenario = { event, result: 'success', output: 'true', cancelled: false };
          const expected = event === 'push' || event === 'workflow_dispatch';
          if (runsAfterNeeds(condition, scenario) !== expected) errors.push(`${id}: incorrect trigger for ${event}`);
          if (runsAfterNeeds(condition, { ...scenario, cancelled: true })) errors.push(`${id}: must honor workflow cancellation`);
        }
      } catch (error) { errors.push(`${id}: unsafe job condition: ${error.message}`); }
    } else {
      if (!needsChanges(job)) errors.push(`${id}: must depend on changes`);
      try {
        const condition = resolveIf(source, job);
        const forwardJob = id === 'native-linux-x64-next';
        for (const [result, output, expected] of cases) {
          const scenario = { event: 'pull_request', result, output, cancelled: false };
          if (runsAfterNeeds(condition, scenario) !== (!forwardJob && expected)) {
            errors.push(`${id}: unsafe condition for ${result}/${output || '(empty)'}`);
          }
        }
        for (const event of ['push', 'merge_group', 'workflow_dispatch']) {
          const scenario = { event, result: 'success', output: 'true', cancelled: false };
          if (runsAfterNeeds(condition, scenario) !== (!forwardJob || event === 'workflow_dispatch')) {
            errors.push(`${id}: incorrect trigger for ${event}`);
          }
          if (runsAfterNeeds(condition, { ...scenario, cancelled: true })) errors.push(`${id}: must honor workflow cancellation`);
        }
      } catch (error) { errors.push(`${id}: unsafe job condition: ${error.message}`); }
    }
    const blocks = stepBlocks(stepsOf(source, job));
    if (kind === 'windows-aggregate') {
      const expected = ['native-win32-x64-credentials', 'native-win32-x64-iam'];
      const result = blocks.find((step) => stepField(step, 'run') === 'test "$CREDENTIALS_RESULT" = success && test "$IAM_RESULT" = success');
      if (expected.some((id) => !dependencies(job).includes(id)) || !result || !unconditionalStep(result)
        || !result.includes('CREDENTIALS_RESULT: $' + '{{ needs.native-win32-x64-credentials.result }}')
        || !result.includes('IAM_RESULT: $' + '{{ needs.native-win32-x64-iam.result }}')) {
        errors.push(`${id}: both Windows test jobs must succeed`);
      }
    } else if (['sqlite', 'credentials', 'iam'].includes(kind)) {
      const requiredStep = (step, condition) => !!step && stepField(step, 'if') === (optionalMacOS ? undefined : condition)
        && stepField(step, 'continue-on-error') === undefined;
      const backend = blocks.filter((step) => stepField(step, 'run') === 'node --test packages/forge-credentials-keychain/test/*.test.mjs');
      if (backend.length !== 1 || !requiredStep(backend[0], "env.FORGE_CI_SUITE != 'iam'")) errors.push(`${id}: platform tests must run unconditionally for their suite`);
      const iamPath = /^packages\/forge-iam\/test\/[a-z0-9-]+\.test\.mjs$/u;
      const iam = blocks.filter((step) => directNodeTest(step, iamReadTestPaths, iamPath));
      if (iam.length !== 1 || !requiredStep(iam[0], "env.FORGE_CI_SUITE != 'credentials'")) errors.push(`${id}: IAM read paths and CLI tests must run unconditionally for their suite`);
      const install = blocks.filter((step) => step.startsWith('      - name: Install and test the artifact offline\n'));
      if (install.length !== 1 || !requiredStep(install[0], "env.FORGE_CI_SUITE != 'iam'") || !installedSmoke(install[0])) errors.push(`${id}: installed SQLite smoke must run unconditionally for its suite`);
    } else if (kind === 'sensitive') {
      const allowedPath = /^(?:tests\/[a-z0-9-]+\.test\.mjs|packages\/forge-iam\/test\/[a-z0-9-]+\.test\.mjs)$/u;
      const suite = blocks.filter((step) => directNodeTest(step, windowsTestPaths, allowedPath));
      if (suite.length !== 1 || !unconditionalStep(suite[0])) errors.push(`${id}: Windows scan and callback tests must run together unconditionally`);
      // 该作业不装依赖；插件装配图现在会 import 同仓兄弟包，必须先建 workspace 链接。
      const link = blocks.findIndex((step) => /^ {8}run:[ \t]*node[ \t]+scripts\/link-workspace\.mjs[ \t]*$/mu.test(step));
      const suiteIndex = blocks.indexOf(suite[0]);
      if (link < 0 || suiteIndex < 0 || link > suiteIndex) errors.push(`${id}: Windows suite needs workspace links before the tests`);
    }
  }
  if (jobs.has('forge-iam-callback')) errors.push('forge-iam-callback: callback tests must not run in a separate job');
  return errors;
}

function replaceJob(source, id, transform) {
  const job = jobsOf(source).get(id);
  assert.ok(job, `mutation requires job ${id}`);
  const changed = transform(job);
  assert.notEqual(changed, job, `mutation did not change job ${id}`);
  return source.replace(job, changed);
}

test('workflow keeps platform contexts fixed and fails closed when classification is uncertain', () => {
  assert.deepEqual(workflowProblems(workflow), []);
});

test('verify rejects a pull request whose head is another repository', () => {
  const steps = stepBlocks(stepsOf(workflow, jobsOf(workflow).get('verify-shards')));
  const step = steps.find((candidate) => candidate.startsWith('      - name: Reject fork pull requests\n'));
  assert.ok(step, 'verify must reject fork pull requests');

  // Removing the step would accept a head outside the repository's branch surface.
  const removed = replaceJob(workflow, 'verify-shards', (job) => job.replace(step, ''));
  assert.match(workflowProblems(removed).join('\n'), /verify: missing fork pull request rejection/u);

  // Comparing against anything but the repository name would also reject same-repository PRs.
  const widened = replaceJob(workflow, 'verify-shards', (job) => job.replace(
    'github.event.pull_request.head.repo.full_name != github.repository',
    "github.event.pull_request.head.repo.full_name != ''",
  ));
  assert.match(workflowProblems(widened).join('\n'), /verify: fork rejection is wrong for pull_request\/owner\/repo/u);

  // continue-on-error would turn the rejection into a passing required check.
  const tolerated = replaceJob(workflow, 'verify-shards', (job) => job.replace(
    '      - name: Reject fork pull requests\n',
    '      - name: Reject fork pull requests\n        continue-on-error: true\n',
  ));
  assert.match(workflowProblems(tolerated).join('\n'), /verify: fork rejection must not tolerate failure/u);

  const late = replaceJob(workflow, 'verify-shards', (job) => job.replace(step, '').replace(
    '      - name: Set up Node.js\n',
    step + '      - name: Set up Node.js\n',
  ));
  assert.match(workflowProblems(late).join('\n'), /verify: fork rejection must precede the checkout/u);
});

test('repository checks do not depend on macOS runner availability', () => {
  for (const [id, job] of jobsOf(workflow)) {
    assert.doesNotMatch(field(job, 'runs-on') ?? '', /^macos-/u, `${id} must run in the optional workflow`);
  }
});

test('macOS shares the complete PR diff and remains independent of required jobs', () => {
  const jobs = jobsOf(workflow);
  const caller = jobs.get('macos');
  assert.equal(field(caller, 'uses'), './.github/workflows/check-macos.yml');
  assert.deepEqual(dependencies(caller), ['changes']);
  const condition = resolveIf(workflow, caller);
  const runs = (event, result, macos, cancelled = false) => runsAfterNeeds(condition, { event, result, macos, cancelled });
  assert.equal(runs('pull_request', 'success', 'true'), true);
  assert.equal(runs('pull_request', 'success', 'false'), false);
  assert.equal(runs('pull_request', 'failure', 'false'), true);
  assert.equal(runs('pull_request', 'success', 'true', true), false);
  for (const event of ['push', 'merge_group', 'workflow_dispatch']) {
    assert.equal(runs(event, 'success', 'true'), false, event);
  }
  const classification = jobs.get('changes');
  const output = '$' + '{{ steps.classify.outputs.run_macos || steps.full.outputs.run_macos }}';
  assert.ok(classification.includes('      run_macos: ' + output));
  assert.match(classification, /echo 'run_macos=true' >> "\$GITHUB_OUTPUT"/u);
  const guard = stepBlocks(stepsOf(workflow, classification)).find((step) => step.includes('name: Validate macOS decision'));
  assert.ok(guard && unconditionalStep(guard));
  assert.ok(guard.includes('RUN_MACOS: ' + output));
  assert.match(guard, /case "\$RUN_MACOS" in\n\s+true\|false\) ;;\n\s+\*\)[^\n]+exit 1 ;;/u);
  assert.match(macosWorkflow, /^  workflow_call:$/mu);
  assert.match(macosWorkflow, /^  push:\n    branches: \[main\]$/mu);
  assert.match(macosWorkflow, /^  merge_group:\n    types: \[checks_requested\]$/mu);
  assert.doesNotMatch(macosWorkflow, /^  pull_request:|^\s+paths(?:-ignore)?:/mu);
  assert.ok([...jobs.values()].every((job) => !dependencies(job).includes('macos')));
  const withPathFilter = macosWorkflow.replace('  workflow_call:', '  pull_request:\n    paths:\n      - packages/**');
  assert.match(workflowProblems(withPathFilter, { optionalMacOS: true }).join('\n'), /trigger: workflow must not use path filters/u);
});

test('primary workloads start independently and use the selected platform images', () => {
  const jobs = jobsOf(workflow);
  assert.ok(jobs.has('verify-shards'));
  assert.equal(field(jobs.get('verify-shards'), 'needs'), undefined);
  assert.match(field(jobs.get('verify'), 'needs'), /\bverify-shards\b/u);
  assert.doesNotMatch(workflow, /runs-on: windows-2022/u);
  assert.doesNotMatch(macosWorkflow, /macos-15-intel|^  changes:/mu);
});

test('macOS runs one optional Apple Silicon job with its execution timeout', () => {
  const options = { optionalMacOS: true };
  assert.deepEqual(workflowProblems(macosWorkflow, options), []);

  const cases = [
    ['document-macos-15', 'continue-on-error: true', 'continue-on-error: false', /document-macos-15: macOS job must allow failure/u],
    ['document-macos-15', 'timeout-minutes: 2', 'timeout-minutes: 1', /document-macos-15: macOS execution timeout changed/u],
    ['document-macos-15', 'FORGE_CI_ARCH: arm64', 'FORGE_CI_ARCH: x64', /document-macos-15: FORGE_CI_ARCH/u],
  ];
  for (const [id, before, after, problem] of cases) {
    const mutated = replaceJob(macosWorkflow, id, (job) => job.replace(before, after));
    assert.match(workflowProblems(mutated, options).join('\n'), problem);
  }

  const armJob = jobsOf(macosWorkflow).get('document-macos-15');
  assert.match(workflowProblems(workflow + '\n' + armJob).join('\n'), /document-macos-15: platform job is in the wrong workflow/u);
});

test('workflow rejects legacy platform names and duplicate contexts', () => {
  const legacy = [
    ['native-linux-x64', 'native keychain (linux-x64)'],
    ['native-linux-arm64', 'native keychain (linux-arm64)'],
    ['native-win32-x64', 'native keychain (win32-x64)'],
    ['native-win32-arm64', 'native keychain (win32-arm64)'],
    ['document-macos-15', 'document backend (macos-15)'],
  ];
  for (const [id, oldName] of legacy) {
    const [name, runner] = platforms.get(id);
    const optionalMacOS = runner.startsWith('macos-');
    const source = optionalMacOS ? macosWorkflow : workflow;
    const mutated = replaceJob(source, id, (job) => job.replace(`name: ${name}`, `name: ${oldName}`));
    assert.match(workflowProblems(mutated, { optionalMacOS }).join('\n'), new RegExp(`${id}: display name changed`, 'u'));
  }
  const [name] = platforms.get('native-linux-arm64');
  const [duplicate] = platforms.get('native-linux-x64');
  const mutated = replaceJob(workflow, 'native-linux-arm64', (job) => job.replace(`name: ${name}`, `name: ${duplicate}`));
  assert.match(workflowProblems(mutated).join('\n'), /native-linux-arm64: display name changed/u);
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
    ['runner', replaceJob(workflow, 'native-linux-arm64', (job) => job.replace('runs-on: ubuntu-24.04-arm', 'runs-on: ubuntu-24.04')), /native-linux-arm64: runner changed/u],
    ['platform OS', replaceJob(workflow, 'native-linux-arm64', (job) => job.replace('FORGE_CI_PLATFORM: linux', 'FORGE_CI_PLATFORM: darwin')), /native-linux-arm64: FORGE_CI_PLATFORM/u],
    ['platform arch', replaceJob(workflow, 'native-linux-arm64', (job) => job.replace('FORGE_CI_ARCH: arm64', 'FORGE_CI_ARCH: x64')), /native-linux-arm64: FORGE_CI_ARCH/u],
    ['Windows job allowed to fail', replaceJob(workflow, 'native-win32-x64-credentials', (job) => job.replace('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    continue-on-error: true\n')), /native-win32-x64-credentials: only macOS jobs may allow failure/u],
    ['installed SQLite smoke removed', replaceJob(workflow, 'native-linux-x64', (job) => job.replace('node scripts/probe/installed-credential-smoke.mjs', 'node missing.mjs')), /native-linux-x64: installed SQLite smoke must run unconditionally/u],
    ['sqlite tests skipped', replaceJob(workflow, 'native-linux-x64', (job) => job.replace("if: env.FORGE_CI_SUITE != 'iam'", 'if: $' + '{{ false }}' )), /native-linux-x64: platform tests must run unconditionally/u],
    ['real IAM bridge removed', replaceJob(workflow, 'native-linux-x64', (job) => job.replace('packages/forge-iam/test/bridge-real-provider.test.mjs', 'packages/forge-iam/test/other.test.mjs')), /native-linux-x64: IAM read paths and CLI tests must run unconditionally/u],
    ['real IAM bridge skipped', replaceJob(workflow, 'native-linux-x64', (job) => job.replace("if: env.FORGE_CI_SUITE != 'credentials'", 'if: $' + '{{ false }}' )), /native-linux-x64: IAM read paths and CLI tests must run unconditionally/u],
    ['real IAM bridge echoed', replaceJob(workflow, 'native-linux-x64', (job) => job.replace('run: node --test packages/forge-iam/test/read-paths-matrix.test.mjs', 'run: echo node --test packages/forge-iam/test/read-paths-matrix.test.mjs')), /native-linux-x64: IAM read paths and CLI tests must run unconditionally/u],
    ['Windows scan skipped', replaceJob(workflow, 'sensitive-scan', (job) => job.replace('      - name: Test Windows sensitive scan and IAM callback\n', '      - name: Test Windows sensitive scan and IAM callback\n        if: ${{ false }}\n')), /sensitive-scan: Windows scan and callback tests must run together unconditionally/u],
    ['verify skipped on failure', replaceJob(workflow, 'verify', (job) => job.replace(/^    if:.*$/mu, "    if: ${{ !cancelled() && needs.changes.result == 'success' }}")), /verify: must run after changes failure/u],
    ['verify guard exit', replaceJob(workflow, 'verify', (job) => job.replace(/^([ \t]+)exit 1$/mu, '$1echo skipped')), /verify: classification guard must exit 1/u],
    ['verify guard inversion', replaceJob(workflow, 'verify', (job) => job.replace('"$CLASSIFICATION_RESULT" !=', '"$CLASSIFICATION_RESULT" ==')), /verify: classification guard is unsafe/u],
    ['full verify', replaceJob(workflow, 'verify-shards', (job) => job.replace('run: node --run check:static', 'run: node scripts/check-docs.mjs')), /verify: full check/u],
    ['missing verification shard result', replaceJob(workflow, 'verify', (job) => job.replace('test "$SHARDS_RESULT" = success', 'true')), /verify: all shards must succeed/u],
    ['missing shard', replaceJob(workflow, 'verify-shards', (job) => job.replace('shard: [1, 2]', 'shard: [1]')), /verify: full check/u],
    ['serialized shards', replaceJob(workflow, 'verify-shards', (job) => job.replace('    timeout-minutes:', '    needs: changes\n    timeout-minutes:')), /verify: full check/u],
    ['incorrect unit command', replaceJob(workflow, 'verify-shards', (job) => job.replace('node --run test:unit', 'echo')), /verify: full check/u],
    ['missing Windows job result', replaceJob(workflow, 'native-win32-x64', (job) => job.replace(' && test "$IAM_RESULT" = success', '')), /native-win32-x64: both Windows test jobs must succeed/u],
    ['Windows suite reassigned', replaceJob(workflow, 'native-win32-x64-iam', (job) => job.replace('SUITE: iam', 'SUITE: credentials')), /native-win32-x64-iam: FORGE_CI_SUITE/u],
    ['Windows ARM64 runs for a PR', replaceJob(workflow, 'native-win32-arm64', (job) => job.replace("github.event_name == 'push'", "github.event_name == 'pull_request'")), /native-win32-arm64: incorrect trigger for pull_request/u],
    ['Windows ARM64 skips manual validation', replaceJob(workflow, 'native-win32-arm64', (job) => job.replace(" || github.event_name == 'workflow_dispatch'", '')), /native-win32-arm64: incorrect trigger for workflow_dispatch/u],
    ['workflow path filter', workflow.replace(/^  pull_request:$/mu, '  pull_request:\n    paths-ignore: ["docs/**"]'), /trigger: workflow must not use path filters/u],
    ['push on all branches', workflow.replace('    branches: [main]\n', ''), /trigger: push must target main/u],
    ['merge queue trigger', workflow.replace('types: [checks_requested]', 'types: [other]'), /trigger: merge_group must request checks/u],
    ['manual trigger', workflow.replace(/^  workflow_dispatch:$/mu, '  ignored_dispatch:'), /trigger: missing workflow_dispatch/u],
  ];
  for (const [label, mutated, expected] of mutants) {
    assert.notEqual(mutated, workflow, `${label} mutation must change the source`);
    assert.match(workflowProblems(mutated).join('\n'), expected, `${label} mutation must be detected`);
  }
});

const executionMutations = [
  ['credential tests echoed',
    workflow.replace('run: node --test packages/forge-credentials-keychain/test/*.test.mjs', 'run: echo node --test packages/forge-credentials-keychain/test/*.test.mjs'),
    /native-linux-x64: platform tests must run unconditionally/u],
  ['CLI session test removed',
    workflow.replace(' packages/forge-iam/test/cli-session.test.mjs', ''),
    /native-linux-x64: IAM read paths and CLI tests must run unconditionally/u],
  ['CLI credential reader test removed',
    workflow.replace(' packages/forge-iam/test/cli-reader.test.mjs', ''),
    /native-win32-arm64: IAM read paths and CLI tests must run unconditionally/u],
  ['gateway save confirmation test removed',
    workflow.replace(' packages/forge-iam/test/gateway-save-confirmation.test.mjs', ''),
    /native-linux-x64: IAM read paths and CLI tests must run unconditionally/u],
  ['gateway SQLite regression test removed',
    workflow.replace(' packages/forge-iam/test/gateway-sqlite-regression.test.mjs', ''),
    /native-linux-x64: IAM read paths and CLI tests must run unconditionally/u],
  ['SQLite session recovery test removed',
    workflow.replace(' packages/forge-iam/test/session-read-lock-recovery.test.mjs', ''),
    /native-win32-x64-iam: IAM read paths and CLI tests must run unconditionally/u],
  ['SQLite pending trust binding test removed',
    workflow.replace(' packages/forge-iam/test/pending-binding-sqlite.test.mjs', ''),
    /native-win32-arm64: IAM read paths and CLI tests must run unconditionally/u],
  ['cross-process renewal log test removed',
    workflow.replace(' packages/forge-iam/test/session-renewal-log.test.mjs', ''),
    /native-win32-arm64: IAM read paths and CLI tests must run unconditionally/u],
  ['resume timer test removed',
    workflow.replace(' packages/forge-iam/test/renewal-resume.test.mjs', ''),
    /native-win32-arm64: IAM read paths and CLI tests must run unconditionally/u],
  ['client authentication refresh test removed',
    workflow.replace(' packages/forge-iam/test/client-auth-refresh.test.mjs', ''),
    /native-win32-x64-iam: IAM read paths and CLI tests must run unconditionally/u],
  ['native callback test removed',
    workflow.replace(' packages/forge-iam/test/callback-port.test.mjs', ''),
    /native-win32-arm64: IAM read paths and CLI tests must run unconditionally/u],
  ['sign-out crash recovery test removed',
    workflow.replace(' packages/forge-iam/test/signout-sqlite-crash.test.mjs', ''),
    /native-win32-arm64: IAM read paths and CLI tests must run unconditionally/u],
  ['UserInfo polling regression test removed',
    workflow.replace(' packages/forge-iam/test/userinfo.test.mjs', ''),
    /native-win32-arm64: IAM read paths and CLI tests must run unconditionally/u],
  ['IAM read paths moved to a comment',
    workflow.replace('node --test packages/forge-iam/test/read-paths-matrix.test.mjs ', 'node --test ')
      .replace('        run: node --test packages/forge-iam/test/cli-session.test.mjs', '        # packages/forge-iam/test/read-paths-matrix.test.mjs\n        run: node --test packages/forge-iam/test/cli-session.test.mjs'),
    /native-linux-x64: IAM read paths and CLI tests must run unconditionally/u],
  ['installed smoke echoed',
    workflow.replace('node scripts/probe/installed-credential-smoke.mjs "$PACKAGE"', 'echo node scripts/probe/installed-credential-smoke.mjs "$PACKAGE"'),
    /native-linux-x64: installed SQLite smoke must run unconditionally/u],
  ['installed smoke conditionally skipped',
    workflow.replace('          node scripts/probe/installed-credential-smoke.mjs "$PACKAGE"', '          if false; then\n            node scripts/probe/installed-credential-smoke.mjs "$PACKAGE"\n          fi'),
    /native-linux-x64: installed SQLite smoke must run unconditionally/u],
];

for (const [label, mutated, expected] of executionMutations) {
  test(`workflow guards reject ${label}`, () => {
    assert.notEqual(mutated, workflow, `${label} mutation must change the source`);
    assert.match(workflowProblems(mutated).join('\n'), expected);
  });
}

test('Windows scan and callback run together in one unconditional Node test step', () => {
  const jobs = jobsOf(workflow);
  const scan = jobs.get('sensitive-scan');
  const steps = stepBlocks(stepsOf(workflow, scan));
  const commands = steps.filter((step) => /^node --test tests\/sensitive-scan\.test\.mjs(?:\s|$)/u.test(stepField(step, 'run') ?? ''));
  assert.equal(commands.length, 1);
  assert.equal(stepField(commands[0], 'if'), undefined);
  assert.ok((stepField(commands[0], 'run') ?? '').split(/\s+/u).includes('packages/forge-iam/test/callback-port.test.mjs'));
  assert.equal(jobs.has('forge-iam-callback'), false);
  assert.equal(valueWithoutQuotes(field(scan, 'name')), 'sensitive scan and IAM callback (win32-x64)');
});

const windowsSuiteError = /sensitive-scan: Windows scan and callback tests must run together unconditionally/u;
const windowsLinkError = /sensitive-scan: Windows suite needs workspace links before the tests/u;
const windowsExecutionMutations = [
  ['plugin patch layers removed', workflow.replace(' tests/plugin-patch-layers.test.mjs', '')],
  ['callback removed', replaceJob(workflow, 'sensitive-scan', (job) => job.replace(' packages/forge-iam/test/callback-port.test.mjs', ''))],
  ['callback moved to a comment', replaceJob(workflow, 'sensitive-scan', (job) => job.replace(' packages/forge-iam/test/callback-port.test.mjs', '')
    .replace('        run: node --test tests/sensitive-scan.test.mjs', '        # packages/forge-iam/test/callback-port.test.mjs\n        run: node --test tests/sensitive-scan.test.mjs'))],
  ['scan test moved to a comment', workflow.replace(' tests/sensitive-scan-team.test.mjs', '')
    .replace('        run: node --test tests/sensitive-scan.test.mjs', '        # tests/sensitive-scan-team.test.mjs\n        run: node --test tests/sensitive-scan.test.mjs')],
  ['suite echoed', workflow.replace('run: node --test tests/sensitive-scan.test.mjs', 'run: echo node --test tests/sensitive-scan.test.mjs')],
  ['suite conditionally skipped', workflow.replace('        run: node --test tests/sensitive-scan.test.mjs', '        if: ${{ false }}\n        run: node --test tests/sensitive-scan.test.mjs')],
  ['suite allowed to fail', workflow.replace('        run: node --test tests/sensitive-scan.test.mjs', '        continue-on-error: true\n        run: node --test tests/sensitive-scan.test.mjs')],
];

for (const [label, mutated] of windowsExecutionMutations) {
  test(`workflow guards reject Windows ${label}`, () => {
    assert.notEqual(mutated, workflow, `${label} mutation must change the source`);
    assert.match(workflowProblems(mutated).join('\n'), windowsSuiteError);
  });
}

// 只改 sensitive-scan 作业自己的链接步骤：`*native_steps` 模板里也有同名步骤，
// 裸字符串替换会先命中模板，派生出的变异体依旧有链接步骤，守卫因此测试不到。
const sensitiveLinkStep = '      - name: Link workspace packages\n        run: node scripts/link-workspace.mjs\n      - name: Test Windows sensitive scan and IAM callback';
const windowsLinkMutations = [
  ['workspace link removed', workflow.replace(sensitiveLinkStep, '      - name: Test Windows sensitive scan and IAM callback')],
  ['workspace link moved after the suite', workflow
    .replace(sensitiveLinkStep, '      - name: Test Windows sensitive scan and IAM callback')
    .replace('packages/forge-iam/test/callback-port.test.mjs\n', 'packages/forge-iam/test/callback-port.test.mjs\n      - name: Link workspace packages\n        run: node scripts/link-workspace.mjs\n')],
];

for (const [label, mutated] of windowsLinkMutations) {
  test(`workflow guards reject Windows ${label}`, () => {
    assert.notEqual(mutated, workflow, `${label} mutation must change the source`);
    assert.match(workflowProblems(mutated).join('\n'), windowsLinkError);
  });
}
