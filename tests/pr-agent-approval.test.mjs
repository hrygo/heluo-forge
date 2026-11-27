import assert from 'node:assert/strict';
import { test } from 'node:test';

import { publishApproval, readApprovalReceipt, reconcileMainApprovals } from '../scripts/pr-agent-approval.mjs';

const repository = 'corp/example';
const owner = { id: 107, login: 'maintainer', type: 'User' };
const contributor = { id: 108, login: 'contributor', type: 'User' };
const approvalBot = { id: 117, login: 'luoshen[bot]', type: 'Bot' };
const appSlug = 'luoshen';
const usersPath = '/users';
const botProfile = `${usersPath}/${encodeURIComponent(approvalBot.login)}`;
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const otherSha = 'c'.repeat(40);
const ownerFile = '.github/CODEOWNERS';
const ownerBlob = 'd'.repeat(40);
const owners = Buffer.from('* @maintainer\n');
const baseRef = 'main';
const revision = { prNumber: 42, head, base, baseRef };
const pull = '/pulls/42';
const reviewPath = `${pull}/reviews`;
const basePath = '/git/ref/heads/main';

function fakeGitHub() {
  const state = {
    pr: {
      number: 42,
      state: 'open',
      draft: false,
      user: { ...contributor },
      head: { sha: head, repo: { full_name: repository } },
      base: { ref: baseRef, repo: { full_name: repository } },
      title: 'UNTRUSTED PR TEXT',
    },
    base,
    account: { ...approvalBot },
    installation: { total_count: 1, repositories: [{ full_name: repository }] },
    protection: { enforce_admins: { enabled: true }, required_pull_request_reviews: {
      require_code_owner_reviews: true, dismiss_stale_reviews: true, required_approving_review_count: 1,
    } },
    permissions: new Map([[owner.login, { user: owner, permission: 'admin' }]]),
    reviews: [],
    nextReviewId: 300,
    timeline: [],
    calls: [],
    writes: [],
  };
  const github = {
    repository,
    serverUrl: 'https://github.test',
    async getAccount(login) {
      assert.equal(login, approvalBot.login);
      state.calls.push(botProfile);
      return structuredClone(state.account);
    },
    async get(path) {
      state.calls.push(path);
      const injected = state.beforeGet?.(path);
      if (injected !== undefined) return injected;
      if (path === pull) return structuredClone(state.pr);
      if (path === '/pulls?state=open&per_page=100&page=1') return [{ number: 42 }];
      const [route, query] = path.split('?');
      if ([`ref=${base}`, `ref=${otherSha}`].includes(query)) {
        if (route === '/contents/.github') return [{ path: ownerFile, type: 'file', sha: ownerBlob }];
        if (route === `/contents/${ownerFile}`) return {
          path: ownerFile, type: 'file', sha: ownerBlob, encoding: 'base64', size: owners.length, content: owners.toString('base64'),
        };
        if (route === '/codeowners/errors') return { errors: [] };
      }
      const permission = /^\/collaborators\/([a-zA-Z0-9_-]+)\/permission$/u.exec(path);
      if (permission) {
        const access = state.permissions.get(permission[1]);
        if (!access) throw Object.assign(new Error('Permission not found'), { status: 404 });
        return structuredClone(access);
      }
      if (path === basePath) {
        return { ref: `refs/heads/${baseRef}`, object: { type: 'commit', sha: state.base } };
      }
      const page = /^\/pulls\/42\/reviews\?per_page=100&page=(\d+)$/u.exec(path);
      if (page) return structuredClone(state.reviews.slice(100 * (Number(page[1]) - 1), 100 * Number(page[1])));
      const timeline = /^\/issues\/42\/timeline\?per_page=100&page=(\d+)$/u.exec(path);
      if (timeline) return structuredClone(state.timeline.slice(100 * (Number(timeline[1]) - 1), 100 * Number(timeline[1])));
      const review = /^\/pulls\/42\/reviews\/(\d+)$/u.exec(path);
      if (review) return structuredClone(state.reviews.find(({ id }) => id === Number(review[1])));
      assert.fail(`Unexpected GET ${path}`);
    },
  };
  const approver = {
    async get(path) {
      assert.equal(path, '/branches/main/protection');
      state.calls.push(path);
      return structuredClone(state.protection);
    },
    async getInstallationRepositories() {
      state.calls.push('/installation/repositories');
      return structuredClone(state.installation);
    },
    async post(path, data) {
      state.calls.push(`POST ${path}`);
      state.writes.push({ method: 'POST', path, data });
      assert.equal(path, reviewPath);
      if (state.failPost) throw new Error('POST timed out');
      const review = { id: state.nextReviewId++, user: approvalBot, commit_id: data.commit_id, body: data.body, state: 'APPROVED' };
      if (!state.hideApproval) state.reviews.push(review);
      state.afterPost?.(review);
      return structuredClone(state.postResponse ?? review);
    },
    async put(path, data) {
      state.calls.push(`PUT ${path}`);
      state.writes.push({ method: 'PUT', path, data });
      const match = /^\/pulls\/42\/reviews\/(\d+)\/dismissals$/u.exec(path);
      assert.ok(match);
      assert.equal(data.event, 'DISMISS');
      if (state.denyDismissal) throw new Error('Dismissal denied');
      const review = state.reviews.find(({ id }) => id === Number(match[1]));
      review.state = 'DISMISSED';
      state.timeline.push({
        event: 'review_dismissed',
        actor: approvalBot,
        dismissed_review: { review_id: review.id, state: 'approved', dismissal_message: data.message },
      });
      state.afterDismissal?.();
      return structuredClone(review);
    },
  };
  const run = (options = {}) => publishApproval({ github, approver, revision, appSlug, humanOwners: owner.login, runId: '1234', ...options });
  const reconcile = () => reconcileMainApprovals({ github, approver, appSlug, humanOwners: owner.login });
  return { state, run, reconcile };
}

test('publishes one exact APPROVE tied to the reviewed head and links the trusted run', async () => {
  const { state, run } = fakeGitHub();

  assert.equal(await run(), 'approved');
  const [write] = state.writes;
  assert.deepEqual(write, {
    method: 'POST',
    path: reviewPath,
    data: { event: 'APPROVE', commit_id: head, body: write.data.body },
  });
  assert.match(write.data.body, /洛神.*自动/u);
  assert.ok(write.data.body.includes('https://github.test/corp/example/actions/runs/1234'));
  assert.ok(write.data.body.includes(head));
  assert.ok(write.data.body.includes(base));
  assert.ok(write.data.body.includes(Buffer.from(baseRef).toString('base64url')));
  assert.doesNotMatch(write.data.body, /UNTRUSTED PR TEXT/u);
  const postIndex = state.calls.indexOf(`POST ${reviewPath}`);
  assert.deepEqual(state.calls.slice(postIndex - 4, postIndex), [pull, basePath, pull, basePath]);
  assert.ok(state.calls.indexOf(botProfile) < postIndex);
  assert.equal(state.reviews[0].user.login, approvalBot.login);

  assert.equal(await run({ runId: '5678' }), 'skipped-existing');
  assert.equal(state.writes.length, 1);
});

test('an invalid token identity or run link never reaches the approval writes', async () => {
  for (const patch of [{ login: 'another-user' }, { login: 'Luoshen[bot]' }, { id: null }, { type: 'User' }]) {
    const { state, run } = fakeGitHub();
    Object.assign(state.account, patch);
    await assert.rejects(run(), /approver identity/iu);
    assert.deepEqual(state.writes, []);
  }

  const { state, run } = fakeGitHub();
  await assert.rejects(run({ appSlug: 'github-actions' }), /dedicated approval GitHub App/u);
  await assert.rejects(run({ runId: '1)\nmanual approval' }), /run ID/iu);
  state.installation = { total_count: 2, repositories: [{ full_name: repository }, { full_name: 'corp/other' }] };
  await assert.rejects(run(), /not scoped to this repository/u);
  assert.deepEqual(state.writes, []);
});

test('an automatic approval requires a protected human code-owner decision', async () => {
  const { state, run } = fakeGitHub();
  state.protection.required_pull_request_reviews.require_code_owner_reviews = false;
  assert.equal(await run(), 'skipped-protection');
  assert.deepEqual(state.writes, []);
});

test('an existing App approval is withdrawn when a later review cannot verify the human gate', async () => {
  const { state, run } = fakeGitHub();
  assert.equal(await run(), 'approved');
  state.protection.required_pull_request_reviews.require_code_owner_reviews = false;
  assert.equal(await run(), 'dismissed-protection');
  assert.equal(state.reviews[0].state, 'DISMISSED');
  state.protection.required_pull_request_reviews.require_code_owner_reviews = true;
  assert.equal(await run({ runId: '5678' }), 'approved');
});

test('a protection change reconciles existing approvals even at the same PR revision', async () => {
  const { state, reconcile, run } = fakeGitHub();
  assert.equal(await run(), 'approved');
  state.reviews.unshift({ ...state.reviews[0], id: 101, user: owner });
  state.protection.required_pull_request_reviews.require_code_owner_reviews = false;

  assert.equal(await reconcile(), 1);
  assert.deepEqual(state.reviews.map(({ state }) => state), ['APPROVED', 'DISMISSED']);
  assert.match(state.writes.at(-1).data.message, /人工审批要求/u);
  assert.equal(await reconcile(), 0);
});

test('an approval is withdrawn if the independent protection disappears just after publication', async () => {
  const { state, run } = fakeGitHub();
  state.afterPost = () => { state.protection.required_pull_request_reviews.require_code_owner_reviews = false; };

  assert.equal(await run(), 'dismissed-protection');
  assert.equal(state.reviews[0].state, 'DISMISSED');
  assert.match(state.writes.at(-1).data.message, /人工审批要求/u);
});

test('skips self-authored PRs and those with an ineligible or changed revision', async () => {
  const { state, run } = fakeGitHub();
  state.pr.user = { ...approvalBot };
  assert.equal(await run(), 'skipped-self');
  assert.deepEqual(state.writes, []);

  for (const mutate of [
    (next) => { next.pr.draft = true; },
    (next) => { next.pr.state = 'closed'; },
    (next) => { next.pr.head.repo.full_name = 'outside/fork'; },
    (next) => { next.pr.base.repo.full_name = 'outside/fork'; },
    (next) => { next.pr.head.sha = otherSha; },
    (next) => { next.pr.base.ref = 'another-target'; },
    (next) => { next.base = otherSha; },
  ]) {
    const fixture = fakeGitHub();
    mutate(fixture.state);
    assert.equal(await fixture.run(), 'skipped-stale');
    assert.deepEqual(fixture.state.writes, []);
  }
});

test('keeps the human changes request across heads until that human approves', async () => {
  const { state, run } = fakeGitHub();
  state.reviews = [
    { id: 101, user: owner, state: 'APPROVED', commit_id: head },
    { id: 102, user: owner, state: 'CHANGES_REQUESTED', commit_id: otherSha },
    { id: 103, user: owner, state: 'COMMENTED', commit_id: head },
    { id: 104, user: contributor, state: 'APPROVED', commit_id: head },
  ];
  assert.equal(await run(), 'skipped-changes-requested');

  state.reviews.push({ id: 105, user: owner, state: 'APPROVED', commit_id: head });
  assert.equal(await run(), 'approved');

  state.reviews.push({ id: 106, user: owner, state: 'APPROVED', commit_id: otherSha });
  assert.equal(await run(), 'skipped-existing');
  assert.deepEqual(state.writes.map(({ method }) => method), ['POST']);
});

test('finds owner changes requests across paginated reviews', async () => {
  const { state, run } = fakeGitHub();
  state.reviews = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1, user: contributor, state: 'COMMENTED', commit_id: head,
  }));
  state.reviews.push({ id: 101, user: owner, state: 'CHANGES_REQUESTED', commit_id: otherSha });

  assert.equal(await run(), 'skipped-changes-requested');
  assert.ok(state.calls.includes(`${reviewPath}?per_page=100&page=2`));
  assert.deepEqual(state.writes, []);
});

test('honors a dismissal of the exact automated review on a different run', async () => {
  const { state, run } = fakeGitHub();
  assert.equal(await run(), 'approved');
  state.reviews[0].state = 'DISMISSED';
  state.timeline.push({
    event: 'review_dismissed', actor: owner,
    dismissed_review: { review_id: 300, state: 'approved', dismissal_message: 'Requires another human review' },
  });

  assert.equal(await run({ runId: '5678' }), 'skipped-existing');
  assert.equal(state.writes.length, 1);
});

test('a complete same-version review may restore an approval withdrawn by an ineligible review', async () => {
  const { state, run } = fakeGitHub();
  assert.equal(await run(), 'approved');
  assert.equal(await run({ allowApproval: false, runId: '2345' }), 'dismissed-ineligible');
  assert.equal(await run({ runId: '3456' }), 'approved');
  assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED']);
});

test('skips when the PR changes between the final base-ref read and final PR read', async () => {
  const { state, run } = fakeGitHub();
  state.beforeGet = (path) => {
    if (path === basePath) state.pr.head.sha = otherSha;
  };

  assert.equal(await run(), 'skipped-stale');
  assert.deepEqual(state.writes, []);
});

test('dismisses exactly the accepted automatic review when GitHub confirms a rapid revision change', async () => {
  for (const mutate of [
    (state) => { state.pr.head.sha = otherSha; },
    (state) => { state.base = otherSha; },
    (state) => { state.pr.base.ref = 'another-target'; },
  ]) {
    const { state, run } = fakeGitHub();
    const historical = { id: 101, user: owner, state: 'APPROVED', commit_id: otherSha, body: 'manual review' };
    state.reviews.push(historical);
    state.afterPost = () => mutate(state);

    assert.equal(await run(), 'dismissed-stale');
    assert.equal(state.reviews[0].state, 'APPROVED');
    assert.equal(state.reviews[1].state, 'DISMISSED');
    assert.deepEqual(state.writes.map(({ method, path }) => [method, path]), [
      ['POST', reviewPath], ['PUT', `${reviewPath}/300/dismissals`],
    ]);
  }
});

test('keeps the accepted approval when only draft status changes during post-publication checks', async () => {
  const { state, run } = fakeGitHub();
  state.afterPost = () => { state.pr.draft = true; };

  assert.equal(await run(), 'approved');
  assert.equal(state.reviews[0].state, 'APPROVED');
  assert.deepEqual(state.writes.map(({ method }) => method), ['POST']);
  state.pr.draft = false;
  assert.equal(await run(), 'skipped-existing');
});

test('dismisses the approval when the base branch advances during the final PR read', async () => {
  const { state, run } = fakeGitHub();
  state.afterPost = () => {
    let baseRead = false;
    state.beforeGet = (path) => {
      if (path === basePath) baseRead = true;
      if (path === pull && baseRead) state.base = otherSha;
    };
  };

  assert.equal(await run(), 'dismissed-stale');
  assert.equal(state.reviews[0].state, 'DISMISSED');
});

test('an uncertain approval write is reconciled by exact review identity without reposting', async () => {
  const { state, run } = fakeGitHub();
  state.afterPost = () => { throw new Error('Response lost after creation'); };

  assert.equal(await run(), 'approved');
  assert.equal(state.writes.length, 1);

  const failed = fakeGitHub();
  failed.state.failPost = true;
  await assert.rejects(failed.run(), /could not confirm.*approval/iu);
  assert.equal(failed.state.writes.length, 1);
});

test('cleanup withdraws an already accepted approval after a lost write response and history outage', async () => {
  const maintainer = { id: 109, login: 'second-maintainer', type: 'User' };
  for (const reviewer of [owner, maintainer]) {
    const { state, run, reconcile } = fakeGitHub();
    state.permissions.set(maintainer.login, { user: maintainer, permission: 'write' });
    state.afterPost = () => {
      state.reviews.unshift({ id: 101, user: reviewer, state: 'CHANGES_REQUESTED', commit_id: head });
      state.beforeGet = (path) => {
        if (path.startsWith(`${reviewPath}?`)) throw new Error('Review history unavailable');
      };
      throw new Error('Response lost after creation');
    };

    await assert.rejects(run(), /review history unavailable/iu);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['CHANGES_REQUESTED', 'APPROVED']);
    state.afterPost = undefined;
    state.beforeGet = undefined;

    assert.equal(await reconcile(), 1);
    assert.deepEqual(state.reviews.map(({ state }) => state), ['CHANGES_REQUESTED', 'DISMISSED']);
    assert.equal(await reconcile(), 0);
    assert.equal(await run({ runId: '5678' }), 'skipped-changes-requested');
    assert.deepEqual(state.writes.map(({ path }) => path), [reviewPath, `${reviewPath}/300/dismissals`]);
    state.reviews.push({ id: 102, user: reviewer, state: 'APPROVED', commit_id: head });
    assert.equal(await run({ runId: '6789' }), 'approved');
  }
});

test('rejects a response with mismatched state, account, commit or body', async () => {
  for (const patch of [
    { state: 'COMMENTED' },
    { state: 'APPROVED', user: contributor },
    { state: 'APPROVED', commit_id: otherSha },
    { state: 'APPROVED', body: 'manual text' },
  ]) {
    const { state, run } = fakeGitHub();
    state.hideApproval = true;
    state.afterPost = (review) => { state.postResponse = { ...review, ...patch }; };

    await assert.rejects(run(), /could not confirm.*approval/iu);
    assert.deepEqual(state.writes.map(({ method }) => method), ['POST']);
  }
});

test('a failed post-publication revision read withdraws the exact unverified approval', async () => {
  const { state, run } = fakeGitHub();
  state.afterPost = () => {
    state.beforeGet = (path) => {
      if (path === pull) throw new Error('Revision read failed');
    };
  };

  await assert.rejects(run(), /could not verify.*approval 300/iu);
  assert.equal(state.reviews[0].state, 'DISMISSED');
  assert.deepEqual(state.writes.map(({ path }) => path), [reviewPath, `${reviewPath}/300/dismissals`]);
});

test('retries a compensation dismissal on the same revision after GitHub recovers', async () => {
  const { state, run } = fakeGitHub();
  state.afterPost = () => {
    state.beforeGet = (path) => {
      if (path === pull) throw new Error('Revision read failed');
    };
  };
  await assert.rejects(run(), /the approval was dismissed/iu);
  const [dismissal] = state.timeline;
  state.afterPost = undefined;
  state.beforeGet = undefined;

  for (const event of [
    { ...dismissal, actor: contributor },
    { ...dismissal, dismissed_review: { ...dismissal.dismissed_review, review_id: 301 } },
  ]) {
    state.timeline = [event];
    assert.equal(await run({ runId: '5678' }), 'skipped-existing');
  }

  state.timeline = [...Array.from({ length: 100 }, () => ({ event: 'reviewed' })), dismissal];
  assert.equal(await run({ runId: '5678' }), 'approved');
  assert.equal(state.reviews[0].state, 'DISMISSED');
  assert.equal(state.reviews[1].state, 'APPROVED');
  assert.equal(state.writes.length, 3);
});

test('a stale review edited before cleanup is preserved as a manual review', async () => {
  const { state, run } = fakeGitHub();
  state.afterPost = () => {
    state.base = otherSha;
    state.beforeGet = (path) => {
      if (path === `${reviewPath}/300`) state.reviews[0].body = 'maintainer edited the approval';
    };
  };

  await assert.rejects(run(), /could not verify.*approval 300/iu);
  assert.deepEqual(state.writes.map(({ method }) => method), ['POST']);
});

test('recognizes an applied dismissal after response loss and reports a denied one', async () => {
  const applied = fakeGitHub();
  applied.state.afterPost = () => { applied.state.base = otherSha; };
  applied.state.afterDismissal = () => { throw new Error('Dismissal response lost'); };
  assert.equal(await applied.run(), 'dismissed-stale');
  assert.equal(applied.state.writes.length, 2);

  const denied = fakeGitHub();
  denied.state.afterPost = () => { denied.state.base = otherSha; };
  denied.state.denyDismissal = true;
  await assert.rejects(denied.run(), /could not confirm.*dismissal.*300/iu);
  assert.equal(denied.state.writes.length, 2);
});

test('dismisses only the new automatic approval when it raced the owner’s changes request', async () => {
  const { state, run } = fakeGitHub();
  state.afterPost = () => {
    // The owner’s manual review landed after listing reviews and before the automated POST.
    state.reviews.unshift({ id: 101, user: owner, state: 'CHANGES_REQUESTED', commit_id: head });
  };

  assert.equal(await run(), 'dismissed-changes-requested');
  assert.equal(state.reviews[0].state, 'CHANGES_REQUESTED');
  assert.equal(state.reviews[1].state, 'DISMISSED');
  assert.deepEqual(state.writes.map(({ path }) => path), [reviewPath, `${reviewPath}/300/dismissals`]);
});

test('keeps a human changes request that arrived during the pre-publication revision check', async () => {
  const { state, run } = fakeGitHub();
  state.beforeGet = (path) => {
    if (path === basePath && !state.reviews.length) {
      state.reviews.push({ id: 101, user: owner, state: 'CHANGES_REQUESTED', commit_id: head });
    }
  };

  assert.equal(await run(), 'skipped-changes-requested');
  assert.deepEqual(state.writes, []);
});

function priorApproval({ id, author = approvalBot, reviewHead = head, reviewBase = base, target = baseRef, state = 'APPROVED' }) {
  return {
    id,
    user: author,
    commit_id: reviewHead,
    state,
    body: [
      '洛神自动审批。完整审查未发现 P0、P1 或 P2 问题。',
      '[查看 GitHub Actions 审查运行](https://github.test/corp/example/actions/runs/999)',
      `<!-- heluo-forge-pr-agent-approval:v1 42 ${reviewHead} ${reviewBase} ${Buffer.from(target).toString('base64url')} -->`,
    ].join('\n\n'),
  };
}

test('a rejected current verdict withdraws only active Luoshen approvals', async () => {
  const { state, run } = fakeGitHub();
  const ordinary = { id: 101, user: owner, commit_id: head, state: 'APPROVED', body: 'looks good' };
  const markerOnly = { ...priorApproval({ id: 102 }), body: priorApproval({ id: 102 }).body.replace('洛神自动审批。', '人工审批。') };
  state.reviews = [
    ordinary,
    markerOnly,
    priorApproval({ id: 103, author: contributor }),
    priorApproval({ id: 104, author: owner, state: 'CHANGES_REQUESTED' }),
    priorApproval({ id: 105, state: 'DISMISSED' }),
    priorApproval({ id: 106 }),
    priorApproval({ id: 107, reviewHead: otherSha }),
  ];

  assert.equal(await run({ allowApproval: false }), 'dismissed-ineligible');
  assert.deepEqual(state.writes.map(({ path }) => path), [
    `${reviewPath}/106/dismissals`, `${reviewPath}/107/dismissals`,
  ]);
  assert.deepEqual(state.reviews.map(({ state }) => state), [
    'APPROVED', 'APPROVED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'DISMISSED', 'DISMISSED',
  ]);

  assert.equal(await run({ allowApproval: false }), 'skipped-ineligible');
  assert.equal(state.writes.length, 2);
  assert.equal(await run(), 'skipped-changes-requested');
  assert.equal(state.writes.length, 2);
});

test('retries transient history before reconciling an existing approval with a human change request', async () => {
  const { state, run } = fakeGitHub();
  const human = { id: 101, user: owner, state: 'CHANGES_REQUESTED', commit_id: head, body: 'Fix the issue' };
  state.reviews = [human, priorApproval({ id: 102 })];
  let unavailable = true;
  state.beforeGet = (path) => {
    if (!unavailable || !path.startsWith(`${reviewPath}?`)) return;
    unavailable = false;
    throw Object.assign(new Error('Review history unavailable'), { status: 503 });
  };

  assert.equal(await run(), 'dismissed-changes-requested');
  assert.deepEqual(state.reviews.map(({ state }) => state), ['CHANGES_REQUESTED', 'DISMISSED']);
  assert.deepEqual(state.writes.map(({ method, path }) => [method, path]), [['PUT', `${reviewPath}/102/dismissals`]]);
});

test('main advancing withdraws the old App approval without another model review', async () => {
  const { state, reconcile } = fakeGitHub();
  const currentBase = otherSha;
  state.base = currentBase;
  state.reviews = [
    priorApproval({ id: 101 }),
    priorApproval({ id: 102, author: owner }),
    priorApproval({ id: 103, reviewBase: currentBase }),
  ];
  assert.equal(await reconcile(), 1);
  assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED', 'APPROVED']);
  assert.deepEqual(state.writes.map(({ method, path }) => [method, path]), [['PUT', `${reviewPath}/101/dismissals`]]);
  assert.equal(await reconcile(), 0);
});

test('a fresh review can recover a bot withdrawal when a PR returns to the original target revision', async () => {
  const { state, run, reconcile } = fakeGitHub();
  assert.equal(await run(), 'approved');
  state.pr.base.ref = 'release';
  assert.equal(await reconcile(), 1);
  assert.equal(state.reviews[0].state, 'DISMISSED');

  state.pr.base.ref = baseRef;
  const automatic = state.timeline[0];
  state.timeline = [{ ...automatic, actor: owner }];
  assert.equal(await run({ runId: '5678' }), 'skipped-existing');
  state.timeline = [automatic];
  assert.equal(await run({ runId: '5678' }), 'approved');
  assert.deepEqual(state.reviews.map(({ state }) => state), ['DISMISSED', 'APPROVED']);
});

test('main cleanup ignores a draft toggle for an approval of the same revision', async () => {
  const { state, reconcile, run } = fakeGitHub();
  state.reviews = [priorApproval({ id: 101 })];
  state.pr.draft = true;
  assert.equal(await reconcile(), 0);
  assert.deepEqual(state.writes, []);
  state.pr.draft = false;
  assert.equal(await run(), 'skipped-existing');
  assert.equal(state.reviews[0].state, 'APPROVED');
  assert.deepEqual(state.writes, []);
});

test('one unavailable review history does not prevent cleanup for other open PRs', async () => {
  const { state, reconcile } = fakeGitHub();
  state.base = otherSha;
  state.reviews = [priorApproval({ id: 101 })];
  state.beforeGet = (path) => {
    if (path === '/pulls?state=open&per_page=100&page=1') return [{ number: 41 }, { number: 42 }];
    if (path.startsWith('/pulls/41/reviews?')) throw new Error('Review history unavailable');
  };

  await assert.rejects(reconcile(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /#41/u);
    return true;
  });
  assert.equal(state.reviews[0].state, 'DISMISSED');
});

test('an automated approval of the same head on an older base is withdrawn and replaced after checking the current revision', async () => {
  const { state, run } = fakeGitHub();
  state.reviews = [priorApproval({ id: 101, reviewBase: otherSha })];

  assert.equal(await run(), 'approved');
  assert.deepEqual(state.writes.map(({ path }) => path), [`${reviewPath}/101/dismissals`, reviewPath]);
  assert.equal(state.reviews[0].state, 'DISMISSED');
  assert.equal(state.reviews[1].commit_id, head);
  const postIndex = state.calls.indexOf(`POST ${reviewPath}`);
  assert.deepEqual(state.calls.slice(postIndex - 4, postIndex), [pull, basePath, pull, basePath]);
});

test('a target change between dismissal and publication prevents a new approval', async () => {
  const { state, run } = fakeGitHub();
  state.reviews = [priorApproval({ id: 101, target: 'previous-target' })];
  state.afterDismissal = () => { state.base = otherSha; };

  assert.equal(await run(), 'skipped-stale');
  assert.deepEqual(state.writes.map(({ path }) => path), [`${reviewPath}/101/dismissals`]);
});

test('a stale candidate performs no approval or historical dismissal', async () => {
  const { state, run } = fakeGitHub();
  state.reviews = [priorApproval({ id: 101 }), priorApproval({ id: 102, reviewHead: otherSha })];
  state.base = otherSha;

  assert.equal(await run({ allowApproval: false }), 'skipped-stale');
  assert.equal(await run(), 'skipped-stale');
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.reviews.map(({ state }) => state), ['APPROVED', 'APPROVED']);
});

test('only parses a canonical receipt bound to the PR and the reviewed commit', () => {
  const approved = priorApproval({ id: 101, author: contributor });
  assert.deepEqual(readApprovalReceipt(approved, revision.prNumber), revision);
  assert.equal(readApprovalReceipt(approved, 43), undefined);

  for (const review of [
    { ...approved, commit_id: otherSha },
    { ...approved, body: approved.body.replace('洛神自动审批。', '人工审批。') },
    { ...approved, body: `${approved.body}\nfollow-up from maintainer` },
    { ...approved, body: approved.body.replace(base, 'not-a-commit') },
    { ...approved, body: approved.body.replace('v1 42', 'v1 042') },
    { ...approved, body: approved.body.replace(Buffer.from(baseRef).toString('base64url'), '_w') },
    priorApproval({ id: 102, target: '../invalid' }),
  ]) assert.equal(readApprovalReceipt(review, revision.prNumber), undefined);
});

test('a maintainer’s latest active changes request blocks approval across heads', async () => {
  const { state, run } = fakeGitHub();
  const maintainer = { id: 109, login: 'second-maintainer', type: 'User' };
  const changeRequest = { id: 101, user: maintainer, state: 'CHANGES_REQUESTED', commit_id: otherSha };
  state.permissions.set(maintainer.login, { user: maintainer, permission: 'write' });
  state.reviews = [
    changeRequest,
    { ...changeRequest, id: 102, state: 'COMMENTED' },
    { ...changeRequest, id: 103, state: 'DISMISSED' },
    { ...changeRequest, id: 104, user: contributor, state: 'APPROVED' },
  ];

  assert.equal(await run(), 'skipped-changes-requested');
  assert.deepEqual(state.writes, []);

  state.reviews.push({ ...changeRequest, id: 105, state: 'APPROVED', commit_id: head });
  assert.equal(await run(), 'approved');
  assert.deepEqual(state.writes.map(({ method }) => method), ['POST']);
});

test('review state or claimed association without matching collaborator access cannot block approval', async () => {
  for (const permission of ['read', 'none', 'absent', 'other-user']) {
    const { state, run } = fakeGitHub();
    state.reviews = [{ id: 101, user: contributor, state: 'CHANGES_REQUESTED', commit_id: head, author_association: 'OWNER' }];
    if (permission === 'other-user') state.permissions.set(contributor.login, { user: owner, permission: 'admin' });
    else if (permission !== 'absent') state.permissions.set(contributor.login, { user: contributor, permission });

    assert.equal(await run(), 'approved');
  }
});

test('a maintainer changes request during publication withdraws only the new automated review', async () => {
  const { state, run } = fakeGitHub();
  const maintainer = { id: 109, login: 'second-maintainer', type: 'User' };
  state.permissions.set(maintainer.login, { user: maintainer, permission: 'maintain' });
  state.afterPost = () => state.reviews.push({ id: 101, user: maintainer, state: 'CHANGES_REQUESTED', commit_id: head });

  assert.equal(await run(), 'dismissed-changes-requested');
  assert.equal(state.reviews.find(({ id }) => id === 101).state, 'CHANGES_REQUESTED');
  assert.deepEqual(state.writes.map(({ path }) => path), [reviewPath, `${reviewPath}/300/dismissals`]);
});

test('an active bot changes request needs the official author and a valid Luoshen receipt', async () => {
  const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
  const receipt = `<!-- heluo-forge-pr-agent-request-changes:v2 confirmed d2573e09-a94d-4d00-a98a-29cc5f821ef2 P1 ${otherSha} ${base} ${Buffer.from(baseRef).toString('base64url')} 25 -->`;
  const verified = { id: 101, user: bot, state: 'CHANGES_REQUESTED', commit_id: otherSha, body: `审查指令\n\n${receipt}` };
  const stale = { ...verified, body: [
    '**此修改请求已过期。请仓库维护者解除此 GitHub 修改请求。**',
    verified.body.replace('v2 confirmed', 'v2 stale'),
  ].join('\n\n') };
  for (const review of [verified, stale]) {
    const blocked = fakeGitHub();
    blocked.state.reviews = [review];
    assert.equal(await blocked.run(), 'skipped-changes-requested');
    assert.deepEqual(blocked.state.writes, []);
  }

  const raced = fakeGitHub();
  raced.state.afterPost = () => raced.state.reviews.push(verified);
  assert.equal(await raced.run(), 'dismissed-changes-requested');
  assert.deepEqual(raced.state.writes.map(({ path }) => path), [reviewPath, `${reviewPath}/300/dismissals`]);

  const allowed = fakeGitHub();
  allowed.state.reviews = [
    { ...verified, id: 102, state: 'DISMISSED' },
    { ...verified, id: 103, commit_id: head },
    { ...verified, id: 104, user: { ...bot, id: 105 } },
    { ...verified, id: 106, user: { ...bot, type: 'User' } },
    { ...verified, id: 107, body: 'Unrelated bot review' },
  ];
  assert.equal(await allowed.run(), 'approved');
});

test('an unavailable collaborator permission read prevents a verified approval', async () => {
  const changesRequested = { id: 101, user: contributor, state: 'CHANGES_REQUESTED', commit_id: head };
  for (const duringPost of [false, true]) {
    const { state, run } = fakeGitHub();
    state.beforeGet = (path) => {
      if (path === `/collaborators/${contributor.login}/permission`) {
        throw Object.assign(new Error('Permission unavailable'), { status: 403 });
      }
    };
    if (duringPost) state.afterPost = () => state.reviews.push(changesRequested);
    else state.reviews.push(changesRequested);

    await assert.rejects(run(), duringPost ? /approval was dismissed/u : /Permission unavailable/u);
    assert.deepEqual(state.writes.map(({ method }) => method), duringPost ? ['POST', 'PUT'] : []);
  }
});
