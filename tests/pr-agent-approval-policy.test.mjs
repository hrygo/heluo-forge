import assert from 'node:assert/strict';
import test from 'node:test';
import { hasIndependentApprovalGate } from '../scripts/pr-agent-approval-policy.mjs';

const revision = { baseRef: 'main', base: 'b'.repeat(40) };
const codeOwnersPath = '.github/CODEOWNERS';
const protectionPath = '/branches/main/protection';
const activeRulesPage = (page) => `/rules/branches/main?per_page=100&page=${page}`;
const directoryPath = `/contents/.github?ref=${revision.base}`;
const contentPath = `/contents/${codeOwnersPath}?ref=${revision.base}`;
const parserPath = `/codeowners/errors?ref=${revision.base}`;
const codeOwners = '* @maintainer @another-maintainer\n';
const humanLogins = 'maintainer,another-maintainer';
const fileEntry = { path: codeOwnersPath, type: 'file', sha: 'c'.repeat(40) };
const emptyActorLists = { users: [], teams: [], apps: [] };
const reviewRules = {
  required_approving_review_count: 1,
  require_code_owner_reviews: true,
  dismiss_stale_reviews: true,
  require_last_push_approval: false,
};
const protection = {
  enforce_admins: { enabled: true },
  required_pull_request_reviews: reviewRules,
  required_status_checks: { strict: false },
};

function pullRequestRule(parameters = {}) {
  return { type: 'pull_request', parameters: {
    required_approving_review_count: 1,
    require_last_push_approval: false,
    ...parameters,
  } };
}

function githubClients(options = {}) {
  const calls = [];
  const source = Buffer.from(options.source ?? codeOwners);
  const contents = {
    ...fileEntry,
    size: source.length,
    encoding: 'base64',
    content: source.toString('base64'),
  };
  const evidence = new Map([
    [directoryPath, options.directory ?? [fileEntry]],
    [contentPath, options.contents ?? contents],
    [parserPath, options.parser ?? { errors: [] }],
  ]);
  const approver = {
    async get(path) {
      calls.push(['approver', path]);
      if (path === protectionPath) {
        if (options.protection instanceof Error) throw options.protection;
        return options.protection ?? protection;
      }
      const rulesPages = options.rulesPages ?? [[]];
      const index = rulesPages.findIndex((_, i) => path === activeRulesPage(i + 1));
      assert.notEqual(index, -1);
      if (rulesPages[index] instanceof Error) throw rulesPages[index];
      return rulesPages[index];
    },
  };
  const github = {
    async get(path) {
      calls.push(['github', path]);
      assert.ok(evidence.has(path));
      const response = evidence.get(path);
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { github, approver, calls };
}

test('requires live protection and the checked base revision’s catch-all of configured human code owners', async () => {
  const { github, approver, calls } = githubClients({ source: `# 人工批准\n\n${codeOwners}` });
  assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), true);
  assert.equal(calls.length, 5);
  assert.deepEqual(new Set(calls.map(([client, path]) => `${client} ${path}`)), new Set([
    `approver ${protectionPath}`, `approver ${activeRulesPage(1)}`,
    `github ${directoryPath}`, `github ${contentPath}`, `github ${parserPath}`,
  ]));
});

test('requires every catch-all owner to be in the configured human allowlist', async () => {
  const { github, approver } = githubClients({ source: '* @maintainer @forge-review-service\n' });
  assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), false);
});

test('matches human logins case-insensitively and accepts horizontal spacing around CSV entries', async () => {
  const { github, approver } = githubClients({ source: '* @Maintainer @another-maintainer\n' });
  assert.equal(await hasIndependentApprovalGate(github, approver, revision,
    ' MAINTAINER,\tAnother-Maintainer , unused-maintainer '), true);
});

test('declines missing, empty, or malformed human login configuration without using credentials', async (t) => {
  const cases = [
    ['missing', undefined],
    ['wrong type', ['maintainer', 'another-maintainer']],
    ['empty', ''],
    ['whitespace only', ' \t '],
    ['leading comma', `,${humanLogins}`],
    ['trailing comma', `${humanLogins},`],
    ['blank entry', `${humanLogins}, ,other-maintainer`],
    ['CODEOWNERS syntax', `${humanLogins},@other-maintainer`],
    ['team syntax', `${humanLogins},example/maintainers`],
    ['bot syntax', `${humanLogins},reviewer[bot]`],
    ['leading or trailing hyphen', `${humanLogins},-maintainer,maintainer-`],
    ['consecutive hyphens', `${humanLogins},other--maintainer`],
    ['too long', `${humanLogins},${'a'.repeat(40)}`],
    ['line break', `${humanLogins}\n`],
    ['non-ASCII character', `${humanLogins},\u212Aelvin`],
  ];
  for (const [name, configuredHumanLogins] of cases) {
    await t.test(name, async () => {
      const { github, approver, calls } = githubClients();
      assert.equal(await hasIndependentApprovalGate(github, approver, revision, configuredHumanLogins), false);
      assert.deepEqual(calls, []);
    });
  }
});

test('accepts the documented empty dismissal lists in the protected branch response', async () => {
  const { github, approver } = githubClients({ protection: {
    ...protection,
    required_pull_request_reviews: {
      ...reviewRules,
      dismissal_restrictions: { url: 'https://api.github.com/repos/example/repository/dismissal_restrictions', ...emptyActorLists },
    },
  } });
  assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), true);
});

test('declines approval under custom or unknown review dismissal restrictions', async (t) => {
  const cases = [
    ['restricted to users', { ...emptyActorLists, users: [{ login: 'maintainer' }] }],
    ['restricted to teams', { ...emptyActorLists, teams: [{ slug: 'maintainers' }] }],
    ['restricted to apps', { ...emptyActorLists, apps: [{ slug: 'another-app' }] }],
    ['missing actor lists', { users: [], teams: [] }],
    ['invalid actor lists', null],
  ];
  for (const [name, restrictions] of cases) {
    await t.test(name, async () => {
      const { github, approver, calls } = githubClients({ protection: {
        ...protection,
        required_pull_request_reviews: { ...reviewRules, dismissal_restrictions: restrictions },
      } });
      assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), false);
      assert.deepEqual(calls, [['approver', protectionPath]]);
    });
  }
});

test('declines approval when the protected branch or effective native review rule cannot be established', async (t) => {
  const cases = [
    ['admin enforcement disabled', { ...protection, enforce_admins: { enabled: false } }],
    ['required reviews missing', { ...protection, required_pull_request_reviews: null }],
    ['no required approvals', { ...protection, required_pull_request_reviews: { ...reviewRules, required_approving_review_count: 0 } }],
    ['multiple required approvals', { ...protection, required_pull_request_reviews: { ...reviewRules, required_approving_review_count: 2 } }],
    ['no required code owner', { ...protection, required_pull_request_reviews: { ...reviewRules, require_code_owner_reviews: false } }],
    ['stale approval dismissal disabled', { ...protection, required_pull_request_reviews: { ...reviewRules, dismiss_stale_reviews: false } }],
    ['last push approval enabled', { ...protection, required_pull_request_reviews: { ...reviewRules, require_last_push_approval: true } }],
    ['last push approval unknown', { ...protection, required_pull_request_reviews: { ...reviewRules, require_last_push_approval: undefined } }],
    ['pull request bypass granted', { ...protection, required_pull_request_reviews: {
      ...reviewRules, bypass_pull_request_allowances: { users: [], teams: [], apps: [{ id: 42 }] },
    } }],
    ['protection inaccessible', new Error('403')],
  ];
  for (const [name, result] of cases) {
    await t.test(name, async () => {
      const { github, approver, calls } = githubClients({ protection: result });
      assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), false);
      assert.deepEqual(calls, [['approver', protectionPath]]);
    });
  }
});

test('accepts compatible active rules from multiple rulesets', async () => {
  const { github, approver } = githubClients({ rulesPages: [[
    { type: 'required_status_checks' },
    pullRequestRule({ required_approving_review_count: 0 }),
    pullRequestRule({
      require_extra_approval_for_unattributed_changes: false,
      required_reviewers: [{ minimum_approvals: 0 }],
      dismissal_restriction: { enabled: false },
    }),
  ]] });
  assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), true);
});

test('declines incompatible or unverifiable active rules', async (t) => {
  const cases = [
    ['multiple required approvals', [pullRequestRule({ required_approving_review_count: 2 })]],
    ['last push approval enabled', [pullRequestRule({ require_last_push_approval: true })]],
    ['last push approval unknown', [pullRequestRule({ require_last_push_approval: undefined })]],
    ['required approval count unknown', [pullRequestRule({ required_approving_review_count: '1' })]],
    ['review parameters unknown', [{ type: 'pull_request' }]],
    ['extra approval for unattributed changes', [pullRequestRule({ require_extra_approval_for_unattributed_changes: true })]],
    ['additional required reviewers', [pullRequestRule({ required_reviewers: [{ minimum_approvals: 1 }] })]],
    ['reviewer approval requirement unknown', [pullRequestRule({ required_reviewers: [{}] })]],
    ['custom dismissal restrictions', [pullRequestRule({ dismissal_restriction: { enabled: true } })]],
    ['unidentified rule', [{}]],
    ['malformed response', { rules: [] }],
    ['rules endpoint inaccessible', new Error('403')],
  ];
  for (const [name, rules] of cases) {
    await t.test(name, async () => {
      const { github, approver, calls } = githubClients({ rulesPages: [rules] });
      assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), false);
      assert.deepEqual(calls, [['approver', protectionPath], ['approver', activeRulesPage(1)]]);
    });
  }
});

test('checks active rules beyond the first page', async () => {
  const { github, approver, calls } = githubClients({ rulesPages: [
    Array.from({ length: 100 }, () => ({ type: 'required_status_checks' })),
    [pullRequestRule({ required_approving_review_count: 2 })],
  ] });
  assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), false);
  assert.deepEqual(calls, [['approver', protectionPath], ['approver', activeRulesPage(1)], ['approver', activeRulesPage(2)]]);
});

test('declines coverage gaps and owner forms outside the individual catch-all', async (t) => {
  const cases = [
    ['missing catch-all', '/scripts/ @maintainer\n'],
    ['ownerless override', `${codeOwners}/scripts/\n`],
    ['unproven per-path coverage', `${codeOwners}/scripts/ @maintainer\n`],
    ['App actor', '* @reviewer[bot]\n'],
    ['team membership', '* @example/maintainers\n'],
    ['email alias', `* ${['approver', 'corp.example'].join('@')}\n`],
  ];
  for (const [name, source] of cases) {
    await t.test(name, async () => {
      const { github, approver } = githubClients({ source });
      assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), false);
    });
  }
});

test('declines unknown or contradictory CODEOWNERS evidence', async (t) => {
  const cases = [
    ['CODEOWNERS missing', { directory: [] }],
    ['aliased CODEOWNERS', { directory: [{ ...fileEntry, type: 'symlink' }] }],
    ['content differs from directory entry', { directory: [{ ...fileEntry, sha: 'd'.repeat(40) }] }],
    ['file inaccessible', { contents: new Error('404') }],
    ['GitHub reports an invalid owner', { parser: { errors: [{ kind: 'Invalid owner' }] } }],
    ['unexpected response from parser', { parser: {} }],
    ['parser inaccessible', { parser: new Error('403') }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const { github, approver } = githubClients(options);
      assert.equal(await hasIndependentApprovalGate(github, approver, revision, humanLogins), false);
    });
  }
});

test('declines incomplete or non-main revisions without using credentials', async () => {
  const { github, approver, calls } = githubClients();
  assert.equal(await hasIndependentApprovalGate(github, approver, { ...revision, baseRef: 'release' }, humanLogins), false);
  assert.equal(await hasIndependentApprovalGate(github, approver, { ...revision, base: 'main' }, humanLogins), false);
  assert.deepEqual(calls, []);
});
