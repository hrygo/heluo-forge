import assert from 'node:assert/strict';
import test from 'node:test';
import { hasIndependentApprovalGate } from '../scripts/pr-agent-approval-policy.mjs';

const revision = { baseRef: 'main', base: 'b'.repeat(40) };
const codeOwnersPath = '.github/CODEOWNERS';
const protectionPath = '/branches/main/protection';
const directoryPath = `/contents/.github?ref=${revision.base}`;
const contentPath = `/contents/${codeOwnersPath}?ref=${revision.base}`;
const parserPath = `/codeowners/errors?ref=${revision.base}`;
const codeOwners = '* @maintainer @another-maintainer\n';
const fileEntry = { path: codeOwnersPath, type: 'file', sha: 'c'.repeat(40) };
const reviewRules = {
  required_approving_review_count: 1,
  require_code_owner_reviews: true,
  dismiss_stale_reviews: true,
};
const protection = {
  enforce_admins: { enabled: true },
  required_pull_request_reviews: reviewRules,
  required_status_checks: { strict: false },
};

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
      assert.equal(path, protectionPath);
      if (options.protection instanceof Error) throw options.protection;
      return options.protection ?? protection;
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

test('requires live protection and the checked base revision’s catch-all of individual code owners', async () => {
  const { github, approver, calls } = githubClients({ source: `# 人工批准\n\n${codeOwners}` });
  assert.equal(await hasIndependentApprovalGate(github, approver, revision), true);
  assert.equal(calls.length, 4);
  assert.deepEqual(new Set(calls.map(([client, path]) => `${client} ${path}`)), new Set([
    `approver ${protectionPath}`, `github ${directoryPath}`, `github ${contentPath}`, `github ${parserPath}`,
  ]));
});

test('declines approval when the protected branch or effective native review rule cannot be established', async (t) => {
  const cases = [
    ['admin enforcement disabled', { ...protection, enforce_admins: { enabled: false } }],
    ['required reviews missing', { ...protection, required_pull_request_reviews: null }],
    ['no required approvals', { ...protection, required_pull_request_reviews: { ...reviewRules, required_approving_review_count: 0 } }],
    ['no required code owner', { ...protection, required_pull_request_reviews: { ...reviewRules, require_code_owner_reviews: false } }],
    ['stale approval dismissal disabled', { ...protection, required_pull_request_reviews: { ...reviewRules, dismiss_stale_reviews: false } }],
    ['pull request bypass granted', { ...protection, required_pull_request_reviews: {
      ...reviewRules, bypass_pull_request_allowances: { users: [], teams: [], apps: [{ id: 42 }] },
    } }],
    ['protection inaccessible', new Error('403')],
  ];
  for (const [name, result] of cases) {
    await t.test(name, async () => {
      const { github, approver, calls } = githubClients({ protection: result });
      assert.equal(await hasIndependentApprovalGate(github, approver, revision), false);
      assert.deepEqual(calls, [['approver', protectionPath]]);
    });
  }
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
      assert.equal(await hasIndependentApprovalGate(github, approver, revision), false);
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
      assert.equal(await hasIndependentApprovalGate(github, approver, revision), false);
    });
  }
});

test('declines incomplete or non-main revisions without using credentials', async () => {
  const { github, approver, calls } = githubClients();
  assert.equal(await hasIndependentApprovalGate(github, approver, { ...revision, baseRef: 'release' }), false);
  assert.equal(await hasIndependentApprovalGate(github, approver, { ...revision, base: 'main' }), false);
  assert.deepEqual(calls, []);
});
